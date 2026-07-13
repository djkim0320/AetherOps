import { DatabaseSync } from "node:sqlite";
import { IdempotencyConflictError } from "./jobErrors.js";
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
  requiredNumber,
  requiredString,
  rowToJob,
  runAtomically,
  terminalJobStatus,
  type Row
} from "./repositorySupport.js";

const activeStatuses = new Set<StorageJob["status"]>(["running", "pause_requested", "cancel_requested"]);
const DEFAULT_QUEUE_DIAGNOSTIC_LIMIT = 100;
const MAX_QUEUE_DIAGNOSTIC_LIMIT = 500;

export const JOB_QUEUE_DIAGNOSTICS_SQL = `with queued_by_project as (
  select project_id, count(*) as depth, min(queued_at) as oldest_queued_at
  from jobs indexed by idx_jobs_ready where status='queued' group by project_id
), queue_totals as (
  select project_id, depth, oldest_queued_at,
    sum(depth) over () as total_depth,
    min(oldest_queued_at) over () as global_oldest_queued_at,
    count(*) over () as total_projects
  from queued_by_project
)
select project_id, depth, oldest_queued_at, total_depth, global_oldest_queued_at, total_projects
from queue_totals order by project_id limit ?`;

export class JobRepository {
  constructor(private readonly db: DatabaseSync) {}

  enqueue(input: StorageJobInput): StorageJob {
    return runAtomically(this.db, () => {
      if (input.idempotencyKey) {
        const existing = this.getByIdempotencyKey(input.projectId, input.idempotencyKey);
        if (existing) {
          if (input.requestHash !== existing.requestHash) {
            throw new IdempotencyConflictError();
          }
          return existing;
        }
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
    const pageSize = normalizeQueueDiagnosticLimit(limit);
    const rows = this.db.prepare(JOB_QUEUE_DIAGNOSTICS_SQL).all(pageSize) as Row[];
    if (!rows.length) return { projects: [], totalDepth: 0, totalProjects: 0, truncated: false };
    const first = queueDiagnosticRow(rows[0] as Row);
    const projects = rows.map((row) => {
      const parsed = queueDiagnosticRow(row);
      if (parsed.totalDepth !== first.totalDepth || parsed.oldestQueuedAt !== first.oldestQueuedAt || parsed.totalProjects !== first.totalProjects) {
        throw new Error("Inconsistent durable queue diagnostics window result.");
      }
      return { projectId: parsed.projectId, depth: parsed.depth, oldestQueuedAt: parsed.projectOldestQueuedAt };
    });
    return {
      projects,
      totalDepth: first.totalDepth,
      oldestQueuedAt: first.oldestQueuedAt,
      totalProjects: first.totalProjects,
      truncated: projects.length < first.totalProjects
    };
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
      const now = options.now ?? nowIso();
      assertFutureLease(options.leaseExpiresAt, now);
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
        .run(options.leaseOwner, options.leaseExpiresAt, now, now, job.id);
      return Number(changed.changes) === 1 ? this.get(job.id) : undefined;
    });
  }

  assertFence(fence: StorageLeaseFence, now = nowIso(), allowedStatuses: readonly StorageJob["status"][] = [...activeStatuses]): StorageJob {
    const job = this.get(fence.jobId);
    if (
      !job ||
      job.attempt !== fence.attempt ||
      job.leaseGeneration !== fence.leaseGeneration ||
      job.leaseOwner !== fence.leaseOwner ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= now ||
      !allowedStatuses.includes(job.status)
    ) {
      throw new LeaseLostError(fence.jobId);
    }
    return job;
  }

  transitionFenced(fence: StorageLeaseFence, patch: StorageJobStatusPatch, now = patch.updatedAt ?? nowIso()): StorageJob {
    const current = this.assertFence(fence, now, ["running", "pause_requested", "cancel_requested", "paused", "aborted", "blocked", "failed", "completed"]);
    if (current.status === patch.status) return current;
    assertJobTransition(current, patch.status);
    return this.writeStatus(current, patch, fence, now);
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
      const rows = this.db
        .prepare(
          `select * from jobs where status in (${activeLaneStatuses})
           and lease_expires_at is not null and lease_expires_at <= ? order by project_id,id`
        )
        .all(now) as Row[];
      const interrupted: StorageJob[] = [];
      for (const row of rows) {
        const job = rowToJob(row);
        const changed = this.db
          .prepare(
            `update jobs set status='interrupted',error='Worker lease expired.',failure_reason='Worker lease expired.',
             completed_at=?,updated_at=? where id=? and status in (${activeLaneStatuses})
             and attempt=? and lease_generation=? and lease_owner is ? and lease_expires_at <= ?`
          )
          .run(now, now, job.id, job.attempt, job.leaseGeneration, job.leaseOwner ?? null, now);
        if (Number(changed.changes) === 1) interrupted.push(requiredJob(this.get(job.id), job.id));
      }
      return interrupted;
    });
  }

  renewLease(fence: StorageLeaseFence, leaseExpiresAt: string, now = nowIso()): StorageJob {
    assertFutureLease(leaseExpiresAt, now);
    const current = this.assertFence(fence, now);
    const changed = this.db
      .prepare(
        `update jobs set lease_expires_at=?,updated_at=? where id=? and attempt=? and lease_generation=? and lease_owner=?
         and status in (${activeLaneStatuses}) and lease_expires_at>?`
      )
      .run(leaseExpiresAt, now, fence.jobId, fence.attempt, fence.leaseGeneration, fence.leaseOwner, now);
    if (Number(changed.changes) !== 1) throw new LeaseLostError(fence.jobId);
    return requiredJob(this.get(current.id), current.id);
  }

  private writeStatus(current: StorageJob, patch: StorageJobStatusPatch, fence: StorageLeaseFence | undefined, updatedAt: string): StorageJob {
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
    if (fence) values.push(fence.attempt, fence.leaseGeneration, fence.leaseOwner, updatedAt);
    const changed = this.db.prepare(sql).run(...(values as import("node:sqlite").SQLInputValue[]));
    if (Number(changed.changes) !== 1) {
      if (fence) throw new LeaseLostError(current.id);
      throw new Error(`Durable job transition raced for ${current.id}.`);
    }
    return requiredJob(this.get(current.id), current.id);
  }
}

interface QueueDiagnosticRow {
  projectId: string;
  depth: number;
  projectOldestQueuedAt: string;
  totalDepth: number;
  oldestQueuedAt: string;
  totalProjects: number;
}

function queueDiagnosticRow(row: Row): QueueDiagnosticRow {
  return {
    projectId: requiredString(row.project_id, "queue diagnostic project_id"),
    depth: requiredCount(row.depth, "queue diagnostic depth"),
    projectOldestQueuedAt: requiredString(row.oldest_queued_at, "queue diagnostic oldest_queued_at"),
    totalDepth: requiredCount(row.total_depth, "queue diagnostic total_depth"),
    oldestQueuedAt: requiredString(row.global_oldest_queued_at, "queue diagnostic global_oldest_queued_at"),
    totalProjects: requiredCount(row.total_projects, "queue diagnostic total_projects")
  };
}

function requiredCount(value: unknown, label: string): number {
  const count = requiredNumber(value, label);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Expected ${label} to be a non-negative safe integer.`);
  return count;
}

function normalizeQueueDiagnosticLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_QUEUE_DIAGNOSTIC_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Queue diagnostic limit must be a positive safe integer.");
  return Math.min(limit, MAX_QUEUE_DIAGNOSTIC_LIMIT);
}

function assertFutureLease(leaseExpiresAt: string, now: string): void {
  const expiresAtMs = Date.parse(leaseExpiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs) || expiresAtMs <= nowMs) {
    throw new Error("A durable lease must expire after its claim or renewal time.");
  }
}
