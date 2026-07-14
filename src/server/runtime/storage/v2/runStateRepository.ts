import type { DatabaseSync } from "node:sqlite";
import { runAtomically, type Row } from "./repositorySupport.js";
import { StorageOwnershipConflictError, StorageRevisionConflictError } from "./runStateErrors.js";
import { RunStateLineage } from "./runStateLineage.js";
import {
  assertScope,
  encode,
  exactOrConflict,
  numberField,
  required,
  rowToContextPack,
  rowToRevision,
  rowToTaskContract,
  stringField,
  validateContextPack,
  validateRevision,
  validateTaskContract
} from "./runStateRecordCodec.js";
import type {
  StorageCommitRunStateRevisionInput,
  StorageContextPack,
  StorageRunOwnership,
  StorageRunStateRevision,
  StorageSaveContextPackInput,
  StorageTaskContract,
  StorageTaskContractInput
} from "./runStateTypes.js";

export class RunStateRepository {
  private readonly lineage: RunStateLineage;

  constructor(private readonly db: DatabaseSync) {
    this.lineage = new RunStateLineage(db);
  }

  saveTaskContract(input: StorageTaskContractInput): StorageTaskContract {
    validateTaskContract(input);
    return runAtomically(this.db, () => {
      this.lineage.assertProject(input.projectId);
      const existing = this.taskContractRow(input.id);
      if (existing) return exactOrConflict(rowToTaskContract(existing), input);
      this.db
        .prepare(
          `insert into task_contracts (id,project_id,schema_version,content_hash,created_at,data)
           values (?,?,?,?,?,?)`
        )
        .run(input.id, input.projectId, input.schemaVersion, input.contentHash, input.createdAt, encode(input.data));
      return required(this.getTaskContract(input.projectId, input.id));
    });
  }

  getTaskContract(projectId: string, contractId: string): StorageTaskContract | undefined {
    const row = this.taskContractRow(contractId);
    if (!row) return undefined;
    if (row.project_id !== projectId) throw new StorageOwnershipConflictError();
    return rowToTaskContract(row);
  }

  commitRevision(input: StorageCommitRunStateRevisionInput): StorageRunStateRevision {
    validateRevision(input);
    return runAtomically(this.db, () => this.commitRevisionAtomically(input));
  }

  latestRevision(owner: StorageRunOwnership): StorageRunStateRevision | undefined {
    const row = this.latestRevisionRow(owner.runId);
    if (!row) return undefined;
    assertScope(row, owner);
    this.lineage.assertReadAccess(owner);
    return rowToRevision(row);
  }

  listRevisions(owner: StorageRunOwnership, afterRevision = -1, limit = 100): StorageRunStateRevision[] {
    this.assertRunScopeIfPresent(owner);
    this.lineage.assertReadAccess(owner);
    const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `select * from run_state_revisions
         where project_id=? and run_id=? and revision>?
         order by revision asc limit ?`
      )
      .all(owner.projectId, owner.runId, afterRevision, boundedLimit) as Row[];
    return rows.map(rowToRevision);
  }

  saveContextPack(input: StorageSaveContextPackInput): StorageContextPack {
    validateContextPack(input);
    return runAtomically(this.db, () => {
      const existing = this.contextPackRow(input.contextPack.id);
      if (existing) return exactOrConflict(rowToContextPack(existing), input.contextPack);
      const latest = this.latestRevisionRow(input.contextPack.runId);
      if (!latest) throw new StorageRevisionConflictError(input.expectedRevision, null);
      assertScope(latest, input.contextPack);
      const actual = numberField(latest.revision, "run_state_revisions.revision");
      this.lineage.assertWriteEligibility(input.contextPack);
      if (actual !== input.expectedRevision) throw new StorageRevisionConflictError(input.expectedRevision, actual);
      if (input.contextPack.stateRevision !== actual) throw new StorageRevisionConflictError(input.contextPack.stateRevision, actual);
      const taskContract = this.assertTaskContractOwner(input.contextPack.projectId, input.contextPack.taskContractId);
      if (taskContract.content_hash !== input.contextPack.taskContractHash) throw new StorageOwnershipConflictError();
      if (latest.task_contract_id !== input.contextPack.taskContractId) throw new StorageOwnershipConflictError();
      this.insertContextPack(input.contextPack);
      return required(this.getContextPack(input.contextPack, input.contextPack.id));
    });
  }

  getContextPack(owner: StorageRunOwnership, contextPackId: string): StorageContextPack | undefined {
    const row = this.contextPackRow(contextPackId);
    if (!row) return undefined;
    assertScope(row, owner);
    this.lineage.assertReadAccess(owner);
    return rowToContextPack(row);
  }

  getResumeBoundContextPack(owner: StorageRunOwnership, predecessorJobId: string, contextPackId: string): StorageContextPack | undefined {
    const row = this.contextPackRow(contextPackId);
    if (!row) return undefined;
    if (row.project_id !== owner.projectId || row.run_id !== owner.runId || row.job_id !== predecessorJobId) {
      throw new StorageOwnershipConflictError();
    }
    this.lineage.assertReadAccess(owner);
    this.lineage.assertLinkedJob(owner.projectId, owner.runId, predecessorJobId);
    const activeJob = this.db.prepare("select payload from jobs where id=? and project_id=?").get(owner.jobId, owner.projectId) as Row | undefined;
    const payload = parseJsonObject(activeJob?.payload);
    if (payload.resumesJobId !== predecessorJobId || typeof payload.resumeCheckpointId !== "string") {
      throw new StorageOwnershipConflictError();
    }
    const checkpoint = this.db.prepare("select * from checkpoints where id=?").get(payload.resumeCheckpointId) as Row | undefined;
    const checkpointData = parseJsonObject(checkpoint?.data);
    const latest = this.db
      .prepare(
        `select id from checkpoints where job_id=? and status='committed'
         order by committed_at desc,created_at desc,id desc limit 1`
      )
      .get(predecessorJobId) as Row | undefined;
    if (
      !checkpoint ||
      checkpoint.project_id !== owner.projectId ||
      checkpoint.job_id !== predecessorJobId ||
      checkpoint.status !== "committed" ||
      latest?.id !== checkpoint.id ||
      checkpointData.canonicalContextPackId !== contextPackId
    ) {
      throw new StorageOwnershipConflictError();
    }
    return rowToContextPack(row);
  }

  latestContextPack(owner: StorageRunOwnership): StorageContextPack | undefined {
    this.assertRunScopeIfPresent(owner);
    this.lineage.assertReadAccess(owner);
    const row = this.db
      .prepare(
        `select * from context_packs where project_id=? and run_id=?
         order by state_revision desc,rowid desc limit 1`
      )
      .get(owner.projectId, owner.runId) as Row | undefined;
    return row ? rowToContextPack(row) : undefined;
  }

  latestContextPackForJob(owner: StorageRunOwnership): StorageContextPack | undefined {
    this.assertRunScopeIfPresent(owner);
    this.lineage.assertReadAccess(owner);
    const row = this.db
      .prepare(
        `select * from context_packs
         where project_id=? and run_id=? and job_id=?
         order by state_revision desc,rowid desc limit 1`
      )
      .get(owner.projectId, owner.runId, owner.jobId) as Row | undefined;
    return row ? rowToContextPack(row) : undefined;
  }

  listContextPacks(owner: StorageRunOwnership, stateRevision: number): StorageContextPack[] {
    this.assertRunScopeIfPresent(owner);
    this.lineage.assertReadAccess(owner);
    const rows = this.db
      .prepare(
        `select * from context_packs where project_id=? and run_id=? and state_revision=?
         order by created_at asc,id asc`
      )
      .all(owner.projectId, owner.runId, stateRevision) as Row[];
    return rows.map(rowToContextPack);
  }

  private commitRevisionAtomically(input: StorageCommitRunStateRevisionInput): StorageRunStateRevision {
    const revision = input.revision;
    const taskContract = this.assertTaskContractOwner(revision.projectId, revision.taskContractId);
    if (taskContract.content_hash !== revision.taskContractHash) throw new StorageOwnershipConflictError();
    const byId = this.revisionRow(revision.id);
    if (byId) return exactOrConflict(rowToRevision(byId), revision);
    const sameRevision = this.revisionAt(revision.runId, revision.revision);
    if (sameRevision) return exactOrConflict(rowToRevision(sameRevision), revision);
    const latest = this.latestRevisionRow(revision.runId);
    if (latest) {
      assertScope(latest, revision);
      if (latest.task_contract_id !== revision.taskContractId || latest.task_contract_hash !== revision.taskContractHash) {
        throw new StorageOwnershipConflictError();
      }
    }
    const actual = latest ? numberField(latest.revision, "run_state_revisions.revision") : null;
    this.lineage.ensureWriter(revision, actual ?? 0, revision.recordedAt);
    if (input.expectedRevision !== actual) throw new StorageRevisionConflictError(input.expectedRevision, actual);
    const next = actual === null ? 0 : actual + 1;
    if (revision.revision !== next || revision.previousRevision !== actual) throw new StorageRevisionConflictError(revision.previousRevision, actual);
    const parentHash = latest ? stringField(latest.state_hash, "run_state_revisions.state_hash") : null;
    if (revision.parentRevisionHash !== parentHash) throw new StorageRevisionConflictError(revision.previousRevision, actual);
    if (revision.contextPackId) this.assertContextPackLink(revision);
    this.insertRevision(revision);
    return required(this.latestRevision(revision));
  }

  private assertContextPackLink(revision: StorageRunStateRevision): void {
    const contextPack = this.contextPackRow(required(revision.contextPackId));
    if (!contextPack) throw new StorageOwnershipConflictError();
    assertScope(contextPack, revision);
    this.lineage.assertLinkedJob(revision.projectId, revision.runId, String(contextPack.job_id));
    if (
      contextPack.job_id !== revision.jobId ||
      contextPack.task_contract_id !== revision.taskContractId ||
      contextPack.task_contract_hash !== revision.taskContractHash ||
      numberField(contextPack.state_revision, "context_packs.state_revision") > revision.revision
    ) {
      throw new StorageOwnershipConflictError();
    }
  }

  private assertTaskContractOwner(projectId: string, contractId: string): Row {
    const row = this.taskContractRow(contractId);
    if (!row || row.project_id !== projectId) throw new StorageOwnershipConflictError();
    return row;
  }

  private assertRunScopeIfPresent(owner: StorageRunOwnership): void {
    const row = this.latestRevisionRow(owner.runId);
    if (row) assertScope(row, owner);
  }

  private insertRevision(input: StorageRunStateRevision): void {
    this.db
      .prepare(
        `insert into run_state_revisions
         (id,project_id,run_id,job_id,schema_version,revision,previous_revision,parent_revision_hash,state_hash,
          task_contract_id,task_contract_hash,context_pack_id,created_at,data)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        input.id,
        input.projectId,
        input.runId,
        input.jobId,
        input.schemaVersion,
        input.revision,
        input.previousRevision,
        input.parentRevisionHash,
        input.stateHash,
        input.taskContractId,
        input.taskContractHash,
        input.contextPackId ?? null,
        input.recordedAt,
        encode(input.data)
      );
  }

  private insertContextPack(input: StorageContextPack): void {
    this.db
      .prepare(
        `insert into context_packs
         (id,project_id,run_id,job_id,schema_version,state_revision,task_contract_id,task_contract_hash,content_hash,created_at,data)
         values (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        input.id,
        input.projectId,
        input.runId,
        input.jobId,
        input.schemaVersion,
        input.stateRevision,
        input.taskContractId,
        input.taskContractHash,
        input.contentHash,
        input.recordedAt,
        encode(input.data)
      );
  }

  private taskContractRow(id: string): Row | undefined {
    return this.db.prepare("select * from task_contracts where id=?").get(id) as Row | undefined;
  }
  private revisionRow(id: string): Row | undefined {
    return this.db.prepare("select * from run_state_revisions where id=?").get(id) as Row | undefined;
  }
  private revisionAt(runId: string, revision: number): Row | undefined {
    return this.db.prepare("select * from run_state_revisions where run_id=? and revision=?").get(runId, revision) as Row | undefined;
  }
  private latestRevisionRow(runId: string): Row | undefined {
    return this.db.prepare("select * from run_state_revisions where run_id=? order by revision desc limit 1").get(runId) as Row | undefined;
  }
  private contextPackRow(id: string): Row | undefined {
    return this.db.prepare("select * from context_packs where id=?").get(id) as Row | undefined;
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new StorageOwnershipConflictError();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new StorageOwnershipConflictError();
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof StorageOwnershipConflictError) throw error;
    throw new StorageOwnershipConflictError();
  }
}
