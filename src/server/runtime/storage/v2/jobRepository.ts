import { DatabaseSync } from "node:sqlite";
import { IdempotencyConflictError } from "./jobErrors.js";
import { readJobQueueDiagnostics } from "./jobQueueDiagnostics.js";
import { assertPersistableJobInputPolicies } from "./jobToolPolicyValidation.js";
import { LeaseLostError } from "./leaseFence.js";
import type {
  StorageJob,
  StorageJobClaimOptions,
  StorageJobInput,
  StorageJobQueueDiagnostics,
  StorageJobStatusPatch,
  StorageLeaseFence,
  StorageProjectJobListOptions,
  StorageProjectJobPage,
  StorageRunnableProjectPage
} from "./types.js";
import {
  activeLaneStatuses,
  assertJobTransition,
  json,
  normalizeLimit,
  nowIso,
  requiredJob,
  rowToJob,
  runAtomically,
  terminalJobStatus,
  type Row
} from "./repositorySupport.js";

const activeStatuses = new Set<StorageJob["status"]>(["running", "pause_requested", "cancel_requested"]);
export { JOB_QUEUE_DIAGNOSTICS_SQL } from "./jobQueueDiagnostics.js";

export class JobRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly leaseClock: () => number = Date.now
  ) {}

  enqueue(input: StorageJobInput): StorageJob {
    assertPersistableJobInputPolicies(input);
    return runAtomically(this.db, () => {
      if (input.idempotencyKey) {
        const existing = this.getByIdempotencyRequest(input.projectId, input.idempotencyKey, input.requestHash);
        if (existing) return existing;
      }
      const createdAt = input.createdAt ?? nowIso();
      this.db
        .prepare(
          `insert into jobs (id, project_id, operation, status, priority, attempt, lease_generation, idempotency_key, request_hash,
          requested_capabilities, effective_capabilities, tool_policy, requested_by, queued_at, created_at, updated_at, payload)
          values (?, ?, ?, 'queued', ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.id,
          input.projectId,
          input.operation,
          input.priority ?? 0,
          input.idempotencyKey ?? null,
          input.requestHash ?? null,
          input.requestedCapabilities ? json(input.requestedCapabilities) : null,
          input.effectiveCapabilities ? json(input.effectiveCapabilities) : null,
          input.toolPolicy ? json(input.toolPolicy) : null,
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
    const row = this.db.prepare("select * from jobs where id=?").get(jobId) as Row | undefined;
    return row ? rowToJob(row) : undefined;
  }

  getByIdempotencyKey(projectId: string, key: string): StorageJob | undefined {
    const row = this.db.prepare("select * from jobs where project_id=? and idempotency_key=?").get(projectId, key) as Row | undefined;
    return row ? rowToJob(row) : undefined;
  }

  getByIdempotencyRequest(projectId: string, key: string, requestHash: string | undefined): StorageJob | undefined {
    const existing = this.getByIdempotencyKey(projectId, key);
    if (existing && existing.requestHash !== requestHash) throw new IdempotencyConflictError();
    return existing;
  }

  latestProjectOperation(projectId: string, operation: string): StorageJob | undefined {
    const row = this.db.prepare("select * from jobs where project_id=? and operation=? order by updated_at desc,id desc limit 1").get(projectId, operation) as
      Row | undefined;
    return row ? rowToJob(row) : undefined;
  }

  listProject(projectId: string, options: StorageProjectJobListOptions = {}): StorageProjectJobPage {
    const pageSize = normalizeLimit(options.limit);
    const cursor = options.cursor ? this.projectCursor(projectId, options.cursor) : undefined;
    const rows = this.db
      .prepare(
        `select * from jobs where project_id=? and (? is null or status=?)
         and (? is null or queued_at > ? or (queued_at = ? and id > ?))
         order by queued_at,id limit ?`
      )
      .all(
        projectId,
        options.status ?? null,
        options.status ?? null,
        cursor?.queuedAt ?? null,
        cursor?.queuedAt ?? null,
        cursor?.queuedAt ?? null,
        cursor?.id ?? null,
        pageSize + 1
      ) as Row[];
    const jobs = rows.slice(0, pageSize).map(rowToJob);
    return rows.length > pageSize ? { jobs, nextCursor: jobs.at(-1)?.id } : { jobs };
  }

  listRunnableProjects(cursor: string | undefined, limit = 100): StorageRunnableProjectPage {
    const pageSize = normalizeLimit(limit);
    const rows = this.db
      .prepare(
        `select candidate.project_id from jobs candidate
         where candidate.status='queued' and candidate.project_id > ?
         and not exists (
           select 1 from jobs active where active.project_id=candidate.project_id and active.status in (${activeLaneStatuses})
         )
         group by candidate.project_id order by candidate.project_id limit ?`
      )
      .all(cursor ?? "", pageSize + 1) as Array<{ project_id: string }>;
    const projectIds = rows.slice(0, pageSize).map((row) => row.project_id);
    return rows.length > pageSize ? { projectIds, nextCursor: projectIds.at(-1) } : { projectIds };
  }

  queueDiagnostics(limit?: number): StorageJobQueueDiagnostics {
    return readJobQueueDiagnostics(this.db, limit);
  }

  queuePosition(jobId: string): number | undefined {
    const target = this.get(jobId);
    if (!target || target.status !== "queued") return undefined;
    const row = this.db
      .prepare(
        `select count(*) as count from jobs
         where project_id=? and status='queued' and (queued_at < ? or (queued_at = ? and id < ?))`
      )
      .get(target.projectId, target.queuedAt, target.queuedAt, target.id) as { count: number };
    return Number(row.count);
  }

  private projectCursor(projectId: string, jobId: string): { queuedAt: string; id: string } {
    const row = this.db.prepare("select queued_at,id from jobs where project_id=? and id=?").get(projectId, jobId) as
      { queued_at: string; id: string } | undefined;
    if (!row) throw new Error(`Project job cursor does not exist: ${jobId}`);
    return { queuedAt: row.queued_at, id: row.id };
  }

  claimNext(options: StorageJobClaimOptions): StorageJob | undefined {
    return runAtomically(this.db, () => {
      const leaseCheckedAt = this.leaseNowIso();
      const occurredAt = options.now ?? leaseCheckedAt;
      assertFutureLease(options.leaseExpiresAt, leaseCheckedAt);
      const row = this.db
        .prepare(
          `select * from jobs candidate where candidate.status='queued'
           and (? is null or candidate.project_id=?)
           and not exists (
             select 1 from jobs active where active.project_id=candidate.project_id and active.status in (${activeLaneStatuses})
           )
           order by candidate.queued_at,candidate.id limit 1`
        )
        .get(options.projectId ?? null, options.projectId ?? null) as Row | undefined;
      if (!row) return undefined;
      const job = rowToJob(row);
      const changed = this.db
        .prepare(
          `update jobs set status='running',attempt=attempt+1,lease_generation=lease_generation+1,
           lease_owner=?,lease_expires_at=?,started_at=coalesce(started_at,?),completed_at=null,updated_at=?
           where id=? and status='queued'`
        )
        .run(options.leaseOwner, options.leaseExpiresAt, occurredAt, occurredAt, job.id);
      return Number(changed.changes) === 1 ? this.get(job.id) : undefined;
    });
  }

  assertFence(fence: StorageLeaseFence, allowedStatuses: readonly StorageJob["status"][] = [...activeStatuses]): StorageJob {
    return this.assertFenceAt(fence, this.leaseNowIso(), allowedStatuses);
  }

  private assertFenceAt(fence: StorageLeaseFence, leaseCheckedAt: string, allowedStatuses: readonly StorageJob["status"][]): StorageJob {
    const job = this.get(fence.jobId);
    if (
      !job ||
      job.attempt !== fence.attempt ||
      job.leaseGeneration !== fence.leaseGeneration ||
      job.leaseOwner !== fence.leaseOwner ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= leaseCheckedAt ||
      !allowedStatuses.includes(job.status)
    ) {
      throw new LeaseLostError(fence.jobId);
    }
    return job;
  }

  transitionFenced(fence: StorageLeaseFence, patch: StorageJobStatusPatch): StorageJob {
    const leaseCheckedAt = this.leaseNowIso();
    const current = this.assertFenceAt(fence, leaseCheckedAt, [
      "running",
      "pause_requested",
      "cancel_requested",
      "paused",
      "aborted",
      "blocked",
      "failed",
      "completed"
    ]);
    if (current.status === patch.status) return current;
    assertJobTransition(current, patch.status);
    return this.writeStatus(current, patch, fence, patch.updatedAt ?? nowIso(), leaseCheckedAt);
  }

  updateStatus(jobId: string, patch: StorageJobStatusPatch): StorageJob {
    const current = requiredJob(this.get(jobId), jobId);
    assertJobTransition(current, patch.status);
    return this.writeStatus(current, patch, undefined, patch.updatedAt ?? nowIso());
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
    return runAtomically(this.db, () => {
      const leaseCheckedAt = this.leaseNowIso();
      const rows = this.db
        .prepare(
          `select * from jobs where status in (${activeLaneStatuses})
           and lease_expires_at is not null and lease_expires_at <= ? order by project_id,id`
        )
        .all(leaseCheckedAt) as Row[];
      const interrupted: StorageJob[] = [];
      for (const row of rows) {
        const job = rowToJob(row);
        const changed = this.db
          .prepare(
            `update jobs set status='interrupted',error='Worker lease expired.',failure_reason='Worker lease expired.',
             completed_at=?,updated_at=? where id=? and status in (${activeLaneStatuses})
             and attempt=? and lease_generation=? and lease_owner is ? and lease_expires_at <= ?`
          )
          .run(now, now, job.id, job.attempt, job.leaseGeneration, job.leaseOwner ?? null, leaseCheckedAt);
        if (Number(changed.changes) === 1) interrupted.push(requiredJob(this.get(job.id), job.id));
      }
      return interrupted;
    });
  }

  renewLease(fence: StorageLeaseFence, leaseExpiresAt: string, occurredAt = nowIso()): StorageJob {
    const leaseCheckedAt = this.leaseNowIso();
    assertFutureLease(leaseExpiresAt, leaseCheckedAt);
    const current = this.assertFenceAt(fence, leaseCheckedAt, [...activeStatuses]);
    const changed = this.db
      .prepare(
        `update jobs set lease_expires_at=?,updated_at=? where id=? and attempt=? and lease_generation=? and lease_owner=?
         and status in (${activeLaneStatuses}) and lease_expires_at>?`
      )
      .run(leaseExpiresAt, occurredAt, fence.jobId, fence.attempt, fence.leaseGeneration, fence.leaseOwner, leaseCheckedAt);
    if (Number(changed.changes) !== 1) throw new LeaseLostError(fence.jobId);
    return requiredJob(this.get(current.id), current.id);
  }

  private writeStatus(
    current: StorageJob,
    patch: StorageJobStatusPatch,
    fence: StorageLeaseFence | undefined,
    updatedAt: string,
    leaseCheckedAt?: string
  ): StorageJob {
    const completedAt = patch.completedAt ?? (terminalJobStatus(patch.status) ? updatedAt : current.completedAt);
    const startedAt = patch.startedAt ?? (patch.status === "running" ? (current.startedAt ?? updatedAt) : current.startedAt);
    const blockedReason = patch.blockedReason ?? (patch.status === "blocked" ? patch.error : undefined) ?? current.blockedReason;
    const failureReason = patch.failureReason ?? (patch.status === "failed" ? patch.error : undefined) ?? current.failureReason;
    if (patch.status === "blocked" && !blockedReason) throw new Error("A blocked job requires blockedReason.");
    if (patch.status === "failed" && !failureReason) throw new Error("A failed job requires failureReason.");
    const sql = `update jobs set status=?,result=?,error=?,blocked_reason=?,failure_reason=?,lease_owner=?,lease_expires_at=?,
      started_at=?,completed_at=?,updated_at=? where id=? and status=?${fence ? " and attempt=? and lease_generation=? and lease_owner=? and lease_expires_at>?" : ""}`;
    const values: unknown[] = [
      patch.status,
      patch.result === undefined ? (current.result === undefined ? null : json(current.result)) : json(patch.result),
      patch.error ?? current.error ?? null,
      blockedReason ?? null,
      failureReason ?? null,
      patch.leaseOwner ?? current.leaseOwner ?? null,
      patch.leaseExpiresAt ?? current.leaseExpiresAt ?? null,
      startedAt ?? null,
      completedAt ?? null,
      updatedAt,
      current.id,
      current.status
    ];
    if (fence) {
      if (!leaseCheckedAt) throw new LeaseLostError(current.id);
      values.push(fence.attempt, fence.leaseGeneration, fence.leaseOwner, leaseCheckedAt);
    }
    const changed = this.db.prepare(sql).run(...(values as import("node:sqlite").SQLInputValue[]));
    if (Number(changed.changes) !== 1) {
      if (fence) throw new LeaseLostError(current.id);
      throw new Error(`Durable job transition raced for ${current.id}.`);
    }
    return requiredJob(this.get(current.id), current.id);
  }

  private leaseNowIso(): string {
    const value = this.leaseClock();
    if (!Number.isFinite(value)) throw new Error("Storage lease clock returned a non-finite timestamp.");
    return new Date(value).toISOString();
  }
}

function assertFutureLease(leaseExpiresAt: string, now: string): void {
  const expiresAtMs = Date.parse(leaseExpiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs) || expiresAtMs <= nowMs) {
    throw new Error("A durable lease must expire after its claim or renewal time.");
  }
}
