import { DatabaseSync } from "node:sqlite";
import type { StorageJob, StorageJobClaimOptions, StorageJobInput, StorageJobStatusPatch } from "./types.js";
import { activeLaneStatuses, json, normalizeLimit, nowIso, requiredJob, rowToJob, runAtomically, terminalJobStatus, type Row } from "./repositorySupport.js";

export class JobRepository {
  constructor(private readonly db: DatabaseSync) {}
  enqueue(input: StorageJobInput): StorageJob {
    return runAtomically(this.db, () => {
      if (input.idempotencyKey) {
        const existing = this.getByIdempotencyKey(input.projectId, input.idempotencyKey);
        if (existing) return existing;
      }
      const createdAt = input.createdAt ?? nowIso();
      this.db
        .prepare(
          `insert into jobs (id, project_id, operation, status, priority, attempt, idempotency_key, requested_by, queued_at, created_at, updated_at, payload)
        values (?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.id,
          input.projectId,
          input.operation,
          input.priority ?? 0,
          input.idempotencyKey ?? null,
          input.requestedBy ?? null,
          input.queuedAt ?? createdAt,
          createdAt,
          createdAt,
          json(input.payload ?? null)
        );
      return requiredJob(this.get(input.id), input.id);
    });
  }
  get(jobId: string): StorageJob | undefined {
    const row = this.db.prepare("select * from jobs where id = ?").get(jobId) as Row | undefined;
    return row ? rowToJob(row) : undefined;
  }
  getByIdempotencyKey(projectId: string, key: string): StorageJob | undefined {
    const row = this.db.prepare("select * from jobs where project_id = ? and idempotency_key = ?").get(projectId, key) as Row | undefined;
    return row ? rowToJob(row) : undefined;
  }
  listProject(projectId: string, limit = 100): StorageJob[] {
    return (
      this.db.prepare("select * from jobs where project_id = ? order by queued_at, created_at limit ?").all(projectId, normalizeLimit(limit)) as Row[]
    ).map(rowToJob);
  }
  listQueued(limit = 1_000): StorageJob[] {
    return (
      this.db.prepare("select * from jobs where status = 'queued' order by priority desc, queued_at, created_at limit ?").all(normalizeLimit(limit)) as Row[]
    ).map(rowToJob);
  }
  claimNext(options: StorageJobClaimOptions): StorageJob | undefined {
    return runAtomically(this.db, () => {
      const now = options.now ?? nowIso();
      const row = this.db
        .prepare(
          `select * from jobs candidate where candidate.status = 'queued'
        and (? is null or candidate.project_id = ?)
        and not exists (select 1 from jobs active where active.project_id = candidate.project_id and active.status in (${activeLaneStatuses}))
        order by candidate.priority desc, candidate.queued_at, candidate.created_at limit 1`
        )
        .get(options.projectId ?? null, options.projectId ?? null) as Row | undefined;
      if (!row) return undefined;
      const job = rowToJob(row);
      const changed = this.db
        .prepare(
          `update jobs set status='running', attempt=attempt+1, lease_owner=?, lease_expires_at=?,
        started_at=coalesce(started_at, ?), updated_at=? where id=? and status='queued'`
        )
        .run(options.leaseOwner, options.leaseExpiresAt ?? null, now, now, job.id);
      return Number(changed.changes) === 1 ? this.get(job.id) : undefined;
    });
  }
  updateStatus(jobId: string, patch: StorageJobStatusPatch): StorageJob {
    const current = requiredJob(this.get(jobId), jobId);
    const updatedAt = patch.updatedAt ?? nowIso();
    const completedAt = patch.completedAt ?? (terminalJobStatus(patch.status) ? updatedAt : current.completedAt);
    const startedAt = patch.startedAt ?? (patch.status === "running" ? (current.startedAt ?? updatedAt) : current.startedAt);
    this.db
      .prepare(`update jobs set status=?, result=?, error=?, lease_owner=?, lease_expires_at=?, started_at=?, completed_at=?, updated_at=? where id=?`)
      .run(
        patch.status,
        patch.result === undefined ? (current.result === undefined ? null : json(current.result)) : json(patch.result),
        patch.error ?? current.error ?? null,
        patch.leaseOwner ?? current.leaseOwner ?? null,
        patch.leaseExpiresAt ?? current.leaseExpiresAt ?? null,
        startedAt ?? null,
        completedAt ?? null,
        updatedAt,
        jobId
      );
    return requiredJob(this.get(jobId), jobId);
  }
  requestPause(jobId: string, updatedAt = nowIso()): StorageJob {
    const current = requiredJob(this.get(jobId), jobId);
    if (current.status !== "running") throw new Error(`Only running jobs can request pause: ${jobId}`);
    return this.updateStatus(jobId, { status: "pause_requested", updatedAt });
  }
  requestCancel(jobId: string, updatedAt = nowIso()): StorageJob {
    const current = requiredJob(this.get(jobId), jobId);
    if (!["queued", "running", "pause_requested"].includes(current.status)) throw new Error(`Job cannot be cancelled from ${current.status}: ${jobId}`);
    return current.status === "queued"
      ? this.updateStatus(jobId, { status: "aborted", updatedAt, completedAt: updatedAt })
      : this.updateStatus(jobId, { status: "cancel_requested", updatedAt });
  }
  markInterruptedExpiredLeases(now = nowIso()): StorageJob[] {
    const rows = this.db
      .prepare(
        `select * from jobs where status in ('running','pause_requested','cancel_requested')
      and lease_expires_at is not null and lease_expires_at < ?`
      )
      .all(now) as Row[];
    return rows
      .map(rowToJob)
      .map((job) => this.updateStatus(job.id, { status: "interrupted", error: "Worker lease expired.", completedAt: now, updatedAt: now }));
  }
  renewLease(jobId: string, leaseOwner: string, leaseExpiresAt: string, updatedAt = nowIso()): StorageJob | undefined {
    const changed = this.db
      .prepare(
        `update jobs set lease_expires_at=?, updated_at=?
      where id=? and lease_owner=? and status in ('running','pause_requested','cancel_requested')`
      )
      .run(leaseExpiresAt, updatedAt, jobId, leaseOwner);
    return Number(changed.changes) === 1 ? this.get(jobId) : undefined;
  }
}
