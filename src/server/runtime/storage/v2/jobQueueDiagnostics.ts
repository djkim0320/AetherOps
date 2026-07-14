import type { DatabaseSync } from "node:sqlite";
import type { StorageJobQueueDiagnostics } from "./types.js";
import { requiredNumber, requiredString, type Row } from "./repositorySupport.js";

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

export function readJobQueueDiagnostics(db: DatabaseSync, limit?: number): StorageJobQueueDiagnostics {
  const pageSize = normalizeQueueDiagnosticLimit(limit);
  const rows = db.prepare(JOB_QUEUE_DIAGNOSTICS_SQL).all(pageSize) as Row[];
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
