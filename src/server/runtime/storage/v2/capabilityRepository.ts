import { DatabaseSync } from "node:sqlite";
import { JOB_KINDS } from "../../../../shared/kernel/job.js";
import { redactTraceText } from "../../security/traceSanitizer.js";
import type { StorageCapabilityAudit } from "./types.js";
import { boolInt, json, normalizeLimit, requiredCapabilityAudit, rowToCapabilityAudit, type Row } from "./repositorySupport.js";

export class CapabilityAuditRepository {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string): StorageCapabilityAudit | undefined {
    const row = this.db.prepare("select * from capability_audits where id=?").get(id) as Row | undefined;
    return row ? rowToCapabilityAudit(row) : undefined;
  }
  record(value: StorageCapabilityAudit): StorageCapabilityAudit {
    assertCapabilityAuditBoundary(value);
    if (value.jobId) {
      const owner = this.db.prepare("select project_id from jobs where id=?").get(value.jobId) as { project_id?: unknown } | undefined;
      if (owner?.project_id !== value.projectId) throw new Error("Capability audit job ownership is unavailable or inconsistent.");
    } else {
      const project = this.db.prepare("select id from projects_v2 where id=?").get(value.projectId) as { id?: unknown } | undefined;
      if (project?.id !== value.projectId) throw new Error("Capability audit project ownership is unavailable.");
    }
    this.db
      .prepare(
        `insert into capability_audits (id, project_id, job_id, operation, capability, app_allowed,
      project_allowed, operation_allowed, allowed, reason, audited_at, data) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        value.id,
        value.projectId,
        value.jobId ?? null,
        value.operation,
        value.capability,
        boolInt(value.appAllowed),
        boolInt(value.projectAllowed),
        boolInt(value.operationAllowed),
        boolInt(value.allowed),
        value.reason ?? null,
        value.auditedAt,
        value.data === undefined ? null : json(value.data)
      );
    const row = this.db.prepare("select * from capability_audits where id=?").get(value.id) as Row | undefined;
    return requiredCapabilityAudit(row ? rowToCapabilityAudit(row) : undefined, value.id);
  }
  listProject(projectId: string, limit = 100): StorageCapabilityAudit[] {
    return (
      this.db.prepare("select * from capability_audits where project_id=? order by audited_at desc limit ?").all(projectId, normalizeLimit(limit)) as Row[]
    ).map(rowToCapabilityAudit);
  }
  listJob(jobId: string, limit = 1_000): StorageCapabilityAudit[] {
    return (this.db.prepare("select * from capability_audits where job_id=? order by audited_at,id limit ?").all(jobId, normalizeLimit(limit)) as Row[]).map(
      rowToCapabilityAudit
    );
  }
  countJob(jobId: string): number {
    const row = this.db.prepare("select count(*) count from capability_audits where job_id=?").get(jobId) as { count?: unknown } | undefined;
    const count = Number(row?.count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Capability audit count readback is invalid.");
    return count;
  }
}

function assertCapabilityAuditBoundary(value: StorageCapabilityAudit): void {
  if (value.capability !== value.operation || !["agent", "engineering", "search"].includes(value.capability)) {
    throw new Error("Capability audit kind is invalid.");
  }
  const allowed = value.appAllowed && value.projectAllowed && value.operationAllowed;
  if (value.allowed !== allowed) throw new Error("Capability audit decision is inconsistent.");
  if (value.reason !== undefined) assertSafeText(value.reason, 1_000);
  const data = value.data;
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.getPrototypeOf(data) !== Object.prototype) {
    throw new Error("Capability audit metadata is invalid.");
  }
  if (Object.keys(data).some((key) => !["jobKind", "blockedBy", "projectRevision"].includes(key)) || !JOB_KINDS.includes(data.jobKind)) {
    throw new Error("Capability audit metadata contains an unsupported value.");
  }
  if (data.projectRevision !== undefined && (!Number.isSafeInteger(data.projectRevision) || data.projectRevision < 0)) {
    throw new Error("Capability audit project revision is invalid.");
  }
  const expectedBlockedBy = allowed ? undefined : !value.appAllowed ? "app" : !value.projectAllowed ? "project" : "job";
  if (data.blockedBy !== expectedBlockedBy) throw new Error("Capability audit blocker is inconsistent.");
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 256) throw new Error("Capability audit metadata exceeds its byte bound.");
}

function assertSafeText(value: string, maxLength: number): void {
  const sanitized = redactTraceText(value)
    ?.replace(/[\r\n]+/g, " ")
    .trim();
  if (!value || value.length > maxLength || sanitized !== value) throw new Error("Capability audit reason is not bounded and sanitized.");
}
