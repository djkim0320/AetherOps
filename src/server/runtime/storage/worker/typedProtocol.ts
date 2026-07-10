import type {
  StorageV2RepositorySet,
  StorageCapabilityAudit,
  StorageCheckpoint,
  StorageEmbeddingInput,
  StorageJobClaimOptions,
  StorageJobEventInput,
  StorageJobInput,
  StorageJobStatusPatch,
  StorageMemoryPayload,
  StorageOntologyConstraintPayload,
  StorageOntologyEntityPayload,
  StorageOntologyRelationPayload,
  StorageOntologyRun,
  StorageProjectPayload,
  StorageRecordPayload,
  StorageSearchOptions,
  StorageStepAttempt,
  StorageV2OpenOptions
} from "../v2/index.js";

export const STORAGE_WORKER_REQUEST = "aetherops.storage.v2.request";
export const STORAGE_WORKER_RESPONSE = "aetherops.storage.v2.response";
export const STORAGE_WORKER_READY = "aetherops.storage.v2.ready";

export type StorageWorkerInit = StorageV2OpenOptions;

export type StorageWorkerBaseCommand =
  | { name: "ping" }
  | { name: "close" }
  | { name: "project.upsert"; project: StorageProjectPayload }
  | { name: "project.get"; projectId: string }
  | { name: "project.list" }
  | { name: "record.upsert"; record: StorageRecordPayload; embedding?: Omit<StorageEmbeddingInput, "id" | "projectId" | "ownerTable" | "ownerId"> }
  | { name: "record.get"; recordId: string }
  | { name: "record.listByProject"; projectId: string; options?: Pick<StorageSearchOptions, "includeGlobal" | "limit"> }
  | { name: "record.search"; query: string; options?: StorageSearchOptions }
  | { name: "memory.upsertItem"; item: Extract<StorageMemoryPayload, { validationResultId: string }> }
  | { name: "memory.upsertChunk"; chunk: Extract<StorageMemoryPayload, { chunkIndex: number }> }
  | { name: "memory.get"; memoryId: string }
  | { name: "memory.search"; query: string; options?: StorageSearchOptions }
  | { name: "embedding.getByOwner"; ownerTable: string; ownerId: string }
  | { name: "job.enqueue"; job: StorageJobInput }
  | { name: "job.get"; jobId: string }
  | { name: "job.listProject"; projectId: string; limit?: number }
  | { name: "job.listQueued"; limit?: number }
  | { name: "job.claimNext"; options: StorageJobClaimOptions }
  | { name: "job.updateStatus"; jobId: string; patch: StorageJobStatusPatch }
  | { name: "job.requestPause"; jobId: string; updatedAt?: string }
  | { name: "job.requestCancel"; jobId: string; updatedAt?: string }
  | { name: "job.markInterruptedExpiredLeases"; now?: string }
  | { name: "job.renewLease"; jobId: string; leaseOwner: string; leaseExpiresAt: string; updatedAt?: string }
  | { name: "event.append"; event: StorageJobEventInput }
  | { name: "event.after"; projectId: string; lastEventId?: string | number; limit?: number }
  | { name: "checkpoint.save"; checkpoint: StorageCheckpoint }
  | { name: "checkpoint.get"; checkpointId: string }
  | { name: "checkpoint.latestCommittedForJob"; jobId: string }
  | { name: "checkpoint.listForJob"; jobId: string }
  | { name: "checkpoint.recordStepAttempt"; attempt: StorageStepAttempt }
  | { name: "checkpoint.listStepAttempts"; jobId: string }
  | { name: "capability.record"; audit: StorageCapabilityAudit }
  | { name: "capability.listProject"; projectId: string; limit?: number }
  | { name: "ontology.upsertEntities"; entities: StorageOntologyEntityPayload[] }
  | { name: "ontology.upsertRelations"; relations: StorageOntologyRelationPayload[] }
  | { name: "ontology.upsertConstraints"; constraints: StorageOntologyConstraintPayload[] }
  | { name: "ontology.search"; query: string; options?: StorageSearchOptions }
  | { name: "ontology.startRun"; run: StorageOntologyRun }
  | { name: "ontology.finishRun"; runId: string; patch: Parameters<StorageV2RepositorySet["ontology"]["finishRun"]>[1] };

export type StorageWorkerCommand = StorageWorkerBaseCommand | { name: "transaction"; commands: StorageWorkerBaseCommand[] };

export interface StorageWorkerRequest {
  type: typeof STORAGE_WORKER_REQUEST;
  requestId: string;
  clientRequestId?: string;
  command: StorageWorkerCommand;
}

export interface StorageWorkerErrorPayload {
  name: string;
  message: string;
  stack?: string;
}

export type StorageWorkerResponse =
  | {
      type: typeof STORAGE_WORKER_RESPONSE;
      requestId: string;
      clientRequestId?: string;
      ok: true;
      result: unknown;
    }
  | {
      type: typeof STORAGE_WORKER_RESPONSE;
      requestId: string;
      clientRequestId?: string;
      ok: false;
      error: StorageWorkerErrorPayload;
    };

export type StorageWorkerReady =
  { type: typeof STORAGE_WORKER_READY; ok: true } | { type: typeof STORAGE_WORKER_READY; ok: false; error: StorageWorkerErrorPayload };
