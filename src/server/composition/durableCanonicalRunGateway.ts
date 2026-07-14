import { createContextPackPersistenceReceipt, type ContextPack } from "../../core/context/public.js";
import type { RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import type { TaskContract } from "../../core/orchestration/taskContract.js";
import type {
  StorageCommitRunStateRevisionInput,
  StorageContextPack,
  StorageRunOwnership,
  StorageRunStateRevision,
  StorageRunStateRevisionInput,
  StorageSaveContextPackInput,
  StorageTaskContract,
  StorageTaskContractInput
} from "../runtime/storage/v2/runStateTypes.js";
import type { CanonicalRevisionPlan, CanonicalRunGateway, CanonicalRunOwner } from "./canonicalRunTypes.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";

interface CanonicalStoragePort {
  saveCanonicalTaskContract(owner: StorageRunOwnership, contract: StorageTaskContractInput): Promise<StorageTaskContract>;
  getCanonicalTaskContract(projectId: string, contractId: string): Promise<StorageTaskContract | undefined>;
  latestCanonicalRunState(owner: StorageRunOwnership): Promise<StorageRunStateRevision | undefined>;
  commitCanonicalRunState(input: StorageCommitRunStateRevisionInput): Promise<StorageRunStateRevision>;
  saveCanonicalContextPack(input: StorageSaveContextPackInput): Promise<StorageContextPack>;
  getCanonicalResumeContextPack(owner: StorageRunOwnership, predecessorJobId: string, contextPackId: string): Promise<StorageContextPack | undefined>;
}

/**
 * Maps the provider-neutral canonical runtime onto the narrow typed storage-worker API.
 * Storage envelopes stay at this boundary; core contracts are persisted as immutable data.
 */
export class DurableCanonicalRunGateway implements CanonicalRunGateway {
  constructor(private readonly storage: CanonicalStoragePort) {}

  async saveTaskContract(owner: CanonicalRunOwner, contract: TaskContract): Promise<unknown> {
    const stored = await this.storage.saveCanonicalTaskContract(owner, {
      id: contract.id,
      projectId: contract.projectId,
      schemaVersion: contract.schemaVersion,
      contentHash: contract.contentHash,
      createdAt: contract.createdAt,
      data: contract
    });
    return stored.data;
  }

  async getTaskContract(projectId: string, taskContractId: string): Promise<unknown | undefined> {
    return (await this.storage.getCanonicalTaskContract(projectId, taskContractId))?.data;
  }

  async latestRunState(owner: CanonicalRunOwner): Promise<unknown | undefined> {
    return (await this.storage.latestCanonicalRunState(owner))?.data;
  }

  async commitRunState(owner: CanonicalRunOwner, expectedRevision: number | null, revision: RunStateRevision): Promise<unknown> {
    const stored = await this.storage.commitCanonicalRunState({
      expectedRevision,
      revision: storageRunStateRevision(owner, revision)
    });
    return stored.data;
  }

  async saveContextPack(owner: CanonicalRunOwner, expectedRevision: number, pack: ContextPack): Promise<unknown> {
    const receipt = createContextPackPersistenceReceipt(pack, { sha256Canonical: durableJobRequestHash });
    const stored = await this.storage.saveCanonicalContextPack({
      expectedRevision,
      contextPack: {
        id: pack.id,
        projectId: owner.projectId,
        runId: owner.runId,
        jobId: owner.jobId,
        schemaVersion: pack.schemaVersion,
        stateRevision: pack.stateRevision,
        taskContractId: pack.task.id,
        taskContractHash: pack.task.contentHash,
        contentHash: pack.canonicalHash,
        recordedAt: pack.createdAt,
        data: receipt
      }
    });
    return stored.data;
  }

  async getResumeContextPack(owner: CanonicalRunOwner, predecessorJobId: string, contextPackId: string): Promise<unknown | undefined> {
    return (await this.storage.getCanonicalResumeContextPack(owner, predecessorJobId, contextPackId))?.data;
  }
}

export function storageCanonicalRevisionPlan(
  owner: CanonicalRunOwner,
  plan: CanonicalRevisionPlan,
  contextPackId?: string
): StorageCommitRunStateRevisionInput[] {
  let expectedRevision = plan.expectedRevision;
  return plan.revisions.map((revision) => {
    const input = { expectedRevision, revision: storageRunStateRevision(owner, revision, contextPackId) };
    expectedRevision = revision.revision;
    return input;
  });
}

function storageRunStateRevision(owner: CanonicalRunOwner, revision: RunStateRevision, contextPackId?: string): StorageRunStateRevisionInput {
  return {
    id: revisionStorageId(owner.runId, revision.revision),
    projectId: owner.projectId,
    runId: owner.runId,
    jobId: owner.jobId,
    schemaVersion: revision.schemaVersion,
    revision: revision.revision,
    previousRevision: revision.revision === 0 ? null : revision.revision - 1,
    parentRevisionHash: revision.parentRevisionHash,
    stateHash: revision.stateHash,
    taskContractId: revision.taskContractId,
    taskContractHash: revision.taskContractHash,
    ...(contextPackId ? { contextPackId } : {}),
    recordedAt: revision.updatedAt,
    data: revision
  };
}

function revisionStorageId(runId: string, revision: number): string {
  return `${runId}:revision:${revision}`;
}
