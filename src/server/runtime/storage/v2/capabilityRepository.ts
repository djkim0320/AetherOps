import { DatabaseSync } from "node:sqlite";
import type { StorageCapabilityAudit } from "./types.js";
import { boolInt, json, normalizeLimit, requiredCapabilityAudit, rowToCapabilityAudit, type Row } from "./repositorySupport.js";

export class CapabilityAuditRepository {
  constructor(private readonly db: DatabaseSync) {}
  record(value: StorageCapabilityAudit): StorageCapabilityAudit {
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
}
