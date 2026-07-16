import type { DatabaseSync } from "node:sqlite";
import { IdempotencyConflictError } from "./jobErrors.js";
import { normalizeLimit, optionalString, parseJson, requiredNumber, requiredString, type Row } from "./repositorySupport.js";
import type {
  StorageProjectMutationIdentity,
  StorageProjectMutationJournal,
  StorageProjectMutationPendingPage,
  StorageProjectMutationState
} from "./projectMutationTypes.js";

export interface StoragePreparedProjectMutationRow {
  operationId: string;
  method: string;
  requestId: string;
  requestHash: string;
  projectId: string;
  expectedProjectRevision: number;
  commandJson: string;
  commandHash: string;
  legacyBeforeHash: string;
  preparedAt: string;
}

export class ProjectMutationRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(operationId: string): StorageProjectMutationJournal | undefined {
    const row = this.db.prepare("select * from project_mutation_journal where operation_id=?").get(operationId) as Row | undefined;
    return row ? rowToProjectMutation(row) : undefined;
  }

  lookup(identity: StorageProjectMutationIdentity, requestHash?: string): StorageProjectMutationJournal | undefined {
    const row = this.db.prepare("select * from project_mutation_journal where method=? and request_id=?").get(identity.method, identity.requestId) as
      Row | undefined;
    const journal = row ? rowToProjectMutation(row) : undefined;
    if (journal && requestHash !== undefined && journal.requestHash !== requestHash) throw new IdempotencyConflictError();
    return journal;
  }

  insertPrepared(value: StoragePreparedProjectMutationRow): StorageProjectMutationJournal {
    this.db
      .prepare(
        `insert into project_mutation_journal
      (operation_id,schema_version,method,request_id,request_hash,project_id,expected_revision,command_json,command_hash,
       legacy_before_hash,state,prepared_at,updated_at)
      values (?,1,?,?,?,?,?,?,?,?, 'prepared',?,?)`
      )
      .run(
        value.operationId,
        value.method,
        value.requestId,
        value.requestHash,
        value.projectId,
        value.expectedProjectRevision,
        value.commandJson,
        value.commandHash,
        value.legacyBeforeHash,
        value.preparedAt,
        value.preparedAt
      );
    return requiredMutation(this.get(value.operationId), value.operationId);
  }

  markLegacyApplied(operationId: string, receiptHash: string, snapshotHash: string, appliedAt: string): StorageProjectMutationJournal {
    const result = this.db
      .prepare(
        `update project_mutation_journal set state='legacy_applied',legacy_receipt_hash=?,legacy_snapshot_hash=?,
      legacy_applied_at=?,updated_at=? where operation_id=? and state='prepared'`
      )
      .run(receiptHash, snapshotHash, appliedAt, appliedAt, operationId);
    if (Number(result.changes) !== 1) throw new Error("Project mutation was not in the prepared state.");
    return requiredMutation(this.get(operationId), operationId);
  }

  beginFinalize(operationId: string, finalizeRequestHash: string, occurredAt: string): StorageProjectMutationJournal {
    const result = this.db
      .prepare(
        `update project_mutation_journal set state='finalizing',finalize_request_hash=?,updated_at=?
      where operation_id=? and state='legacy_applied'`
      )
      .run(finalizeRequestHash, occurredAt, operationId);
    if (Number(result.changes) !== 1) throw new Error("Project mutation was not ready for finalization.");
    return requiredMutation(this.get(operationId), operationId);
  }

  completeFinalize(
    operationId: string,
    eventId: string,
    projectRevision: number,
    publicResultJson: string,
    publicResultHash: string,
    finalizedAt: string
  ): StorageProjectMutationJournal {
    const result = this.db
      .prepare(
        `update project_mutation_journal set state='finalized',event_id=?,committed_revision=?,
      public_result_json=?,public_result_hash=?,finalized_at=?,updated_at=? where operation_id=? and state='finalizing'`
      )
      .run(eventId, projectRevision, publicResultJson, publicResultHash, finalizedAt, finalizedAt, operationId);
    if (Number(result.changes) !== 1) throw new Error("Project mutation finalization did not commit exactly once.");
    return requiredMutation(this.get(operationId), operationId);
  }

  activeReservation(projectId: string): StorageProjectMutationJournal | undefined {
    const row = this.db
      .prepare(
        `select * from project_mutation_journal where project_id=?
      and state in ('prepared','legacy_applied','finalizing') limit 1`
      )
      .get(projectId) as Row | undefined;
    return row ? rowToProjectMutation(row) : undefined;
  }

  hasQueuedOrActiveJob(projectId: string): boolean {
    return Boolean(
      this.db.prepare("select 1 from jobs where project_id=? and status in ('queued','running','pause_requested','cancel_requested') limit 1").get(projectId)
    );
  }

  listPending(cursor?: string, limit?: number): StorageProjectMutationPendingPage {
    const pageSize = Math.min(normalizeLimit(limit), 500);
    let rows: Row[];
    if (cursor) {
      const anchor = this.db.prepare("select prepared_at from project_mutation_journal where operation_id=?").get(cursor) as
        { prepared_at?: unknown } | undefined;
      if (typeof anchor?.prepared_at !== "string") throw new Error("Project mutation pending cursor is invalid.");
      rows = this.db
        .prepare(
          `select * from project_mutation_journal where state in ('prepared','legacy_applied')
        and (prepared_at>? or (prepared_at=? and operation_id>?)) order by prepared_at,operation_id limit ?`
        )
        .all(anchor.prepared_at, anchor.prepared_at, cursor, pageSize + 1) as Row[];
    } else {
      rows = this.db
        .prepare(
          `select * from project_mutation_journal where state in ('prepared','legacy_applied')
        order by prepared_at,operation_id limit ?`
        )
        .all(pageSize + 1) as Row[];
    }
    const hasMore = rows.length > pageSize;
    const mutations = rows.slice(0, pageSize).map(rowToProjectMutation);
    return { mutations, ...(hasMore ? { nextCursor: mutations.at(-1)?.operationId } : {}) };
  }
}

function rowToProjectMutation(row: Row): StorageProjectMutationJournal {
  const method = requiredString(row.method, "project_mutation.method") as StorageProjectMutationJournal["method"];
  const state = requiredString(row.state, "project_mutation.state") as StorageProjectMutationState;
  const commandJson = requiredString(row.command_json, "project_mutation.command_json");
  parseJson(commandJson);
  const publicResultJson = optionalString(row.public_result_json);
  if (publicResultJson) parseJson(publicResultJson);
  const committed = row.committed_revision === null ? undefined : requiredNumber(row.committed_revision, "project_mutation.committed_revision");
  return {
    operationId: requiredString(row.operation_id, "project_mutation.operation_id"),
    method,
    requestId: requiredString(row.request_id, "project_mutation.request_id"),
    requestHash: requiredString(row.request_hash, "project_mutation.request_hash"),
    projectId: requiredString(row.project_id, "project_mutation.project_id"),
    expectedProjectRevision: requiredNumber(row.expected_revision, "project_mutation.expected_revision"),
    commandJson,
    commandHash: requiredString(row.command_hash, "project_mutation.command_hash"),
    legacyBeforeHash: requiredString(row.legacy_before_hash, "project_mutation.legacy_before_hash"),
    state,
    legacyReceiptHash: optionalString(row.legacy_receipt_hash),
    legacySnapshotHash: optionalString(row.legacy_snapshot_hash),
    legacyAppliedAt: optionalString(row.legacy_applied_at),
    finalizeRequestHash: optionalString(row.finalize_request_hash),
    eventId: optionalString(row.event_id),
    committedProjectRevision: committed,
    publicResultJson,
    publicResultHash: optionalString(row.public_result_hash),
    preparedAt: requiredString(row.prepared_at, "project_mutation.prepared_at"),
    updatedAt: requiredString(row.updated_at, "project_mutation.updated_at"),
    finalizedAt: optionalString(row.finalized_at)
  };
}

function requiredMutation(value: StorageProjectMutationJournal | undefined, operationId: string): StorageProjectMutationJournal {
  if (!value) throw new Error(`Project mutation journal entry is unavailable: ${operationId}.`);
  return value;
}
