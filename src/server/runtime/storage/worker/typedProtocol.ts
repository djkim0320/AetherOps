import type {
  StorageV2RepositorySet,
  StorageCapabilityAudit,
  StorageCodexCliExecution,
  StorageClaimStartOptions,
  StorageEmbeddingInput,
  StorageJobEventInput,
  StorageJobInput,
  StorageJobControlInput,
  StorageJobStatus,
  StorageLeaseFence,
  StorageLlmInvocation,
  StorageMemoryPayload,
  StorageOntologyConstraintPayload,
  StorageOntologyEntityPayload,
  StorageOntologyRelationPayload,
  StorageOntologyRun,
  StorageNetworkAudit,
  StorageTraceCategory,
  StorageProjectPayload,
  StorageRecordPayload,
  StorageSearchOptions,
  StorageStepDispositionInput,
  StorageToolPostconditionVerifyInput,
  StorageQuarantinedStepInput,
  StorageCanonicalStepCommitInput,
  StorageCanonicalBudgetCommitInput,
  StorageCanonicalRevisionPlanInput,
  StorageCanonicalTerminalTransitionInput,
  StorageCanonicalTerminalVerifyInput,
  StorageTerminalTransitionInput,
  StorageToolAttempt,
  StorageToolDecision,
  StorageToolOutputLink,
  StorageTerminalAttestedReadbackInput,
  StorageTerminalAttestedLeaseReadInput,
  StorageTerminalAttestedLeaseReleaseInput,
  StorageV2OpenOptions
} from "../v2/index.js";
import type { StorageCommitRunStateRevisionInput, StorageRunOwnership, StorageSaveContextPackInput, StorageTaskContractInput } from "../v2/runStateTypes.js";

export const STORAGE_WORKER_REQUEST = "aetherops.storage.v2.request";
export const STORAGE_WORKER_RESPONSE = "aetherops.storage.v2.response";
export const STORAGE_WORKER_READY = "aetherops.storage.v2.ready";

export type StorageWorkerInit = StorageV2OpenOptions;

export type StorageWorkerBaseCommand =
  | { name: "ping" }
  | { name: "close" }
  | { name: "diagnostics.storage" }
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
  | { name: "job.get"; jobId: string }
  | { name: "job.lookupIdempotency"; projectId: string; idempotencyKey: string; requestHash: string }
  | { name: "job.listProject"; projectId: string; status?: StorageJobStatus; cursor?: string; limit?: number }
  | { name: "job.latestProjectExecution"; projectId: string; operation: string }
  | { name: "job.renewLease"; fence: StorageLeaseFence; leaseExpiresAt: string; now?: string }
  | { name: "job.listRunnableProjects"; cursor?: string; limit?: number }
  | { name: "job.queueDiagnostics"; limit?: number }
  | { name: "job.queuePosition"; jobId: string }
  | { name: "event.append"; event: StorageJobEventInput }
  | { name: "event.after"; projectId: string; lastEventId?: string | number; limit?: number }
  | { name: "checkpoint.get"; checkpointId: string }
  | { name: "checkpoint.latestCommittedForJob"; jobId: string }
  | { name: "checkpoint.listForJob"; jobId: string }
  | { name: "checkpoint.listStepAttempts"; jobId: string }
  | { name: "taskContract.get"; projectId: string; contractId: string }
  | { name: "runState.latest"; owner: StorageRunOwnership }
  | { name: "runState.list"; owner: StorageRunOwnership; afterRevision?: number; limit?: number }
  | { name: "contextPack.get"; owner: StorageRunOwnership; contextPackId: string }
  | { name: "contextPack.getResumeBound"; owner: StorageRunOwnership; predecessorJobId: string; contextPackId: string }
  | { name: "contextPack.latest"; owner: StorageRunOwnership }
  | { name: "contextPack.latestForJob"; owner: StorageRunOwnership }
  | { name: "contextPack.listRevision"; owner: StorageRunOwnership; stateRevision: number }
  | { name: "terminal.createAttestedLease"; input: StorageTerminalAttestedReadbackInput }
  | { name: "terminal.readAttestedLease"; input: StorageTerminalAttestedLeaseReadInput }
  | { name: "terminal.releaseAttestedLease"; input: StorageTerminalAttestedLeaseReleaseInput }
  | { name: "capability.record"; audit: StorageCapabilityAudit }
  | { name: "capability.listProject"; projectId: string; limit?: number }
  | { name: "trace.llm.listJob"; jobId: string; limit?: number }
  | { name: "trace.decision.listJob"; jobId: string; limit?: number }
  | { name: "trace.attempt.get"; attemptId: string }
  | { name: "trace.attempt.listJob"; jobId: string; limit?: number }
  | { name: "trace.codex.listJob"; jobId: string; limit?: number }
  | { name: "trace.output.listAttempt"; attemptId: string; limit?: number }
  | { name: "trace.output.listAttempts"; attemptIds: string[]; limit?: number }
  | { name: "trace.network.listJob"; jobId: string; limit?: number }
  | { name: "trace.summaryJob"; jobId: string }
  | { name: "trace.pageJob"; jobId: string; category: StorageTraceCategory; cursor?: string; limit?: number }
  | { name: "ontology.upsertEntities"; entities: StorageOntologyEntityPayload[] }
  | { name: "ontology.upsertRelations"; relations: StorageOntologyRelationPayload[] }
  | { name: "ontology.upsertConstraints"; constraints: StorageOntologyConstraintPayload[] }
  | { name: "ontology.search"; query: string; options?: StorageSearchOptions }
  | { name: "ontology.startRun"; run: StorageOntologyRun }
  | { name: "ontology.finishRun"; runId: string; patch: Parameters<StorageV2RepositorySet["ontology"]["finishRun"]>[1] };

export type StorageFencedWriteCommand =
  | { name: "event.append"; event: StorageJobEventInput }
  | { name: "taskContract.save"; owner: { projectId: string; jobId: string }; contract: StorageTaskContractInput }
  | { name: "trace.llm.save"; invocation: StorageLlmInvocation }
  | { name: "trace.decision.record"; decision: StorageToolDecision }
  | { name: "trace.attempt.save"; attempt: StorageToolAttempt }
  | { name: "trace.codex.save"; execution: StorageCodexCliExecution }
  | { name: "trace.output.record"; link: StorageToolOutputLink }
  | { name: "trace.network.record"; audit: StorageNetworkAudit }
  | { name: "runState.commit"; input: StorageCommitRunStateRevisionInput }
  | { name: "contextPack.save"; input: StorageSaveContextPackInput };

export type StorageWorkerAtomicCommand =
  | { name: "job.enqueue"; job: StorageJobInput; project?: StorageProjectPayload; capabilityAudits?: StorageCapabilityAudit[] }
  | { name: "capability.recordSet"; audits: StorageCapabilityAudit[]; project?: StorageProjectPayload }
  | { name: "job.claimAndStart"; options: StorageClaimStartOptions }
  | { name: "job.requestControl"; input: StorageJobControlInput }
  | { name: "job.markInterruptedExpiredLeases"; now?: string }
  | { name: "job.transitionTerminal"; input: StorageTerminalTransitionInput }
  | { name: "job.commitStep"; input: StorageStepDispositionInput }
  | { name: "job.quarantineStep"; input: StorageQuarantinedStepInput }
  | { name: "canonical.commitStep"; input: StorageCanonicalStepCommitInput }
  | { name: "canonical.commitBudget"; input: StorageCanonicalBudgetCommitInput }
  | { name: "canonical.commitPlan"; input: StorageCanonicalRevisionPlanInput }
  | { name: "canonical.transitionTerminal"; input: StorageCanonicalTerminalTransitionInput }
  | { name: "canonical.verifyTerminal"; input: StorageCanonicalTerminalVerifyInput }
  | { name: "toolPostcondition.verify"; input: StorageToolPostconditionVerifyInput }
  | { name: "fencedTransaction"; fence: StorageLeaseFence; now?: string; commands: StorageFencedWriteCommand[] };

export type StorageWorkerCommand = StorageWorkerBaseCommand | StorageWorkerAtomicCommand;

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
  code?: "IDEMPOTENCY_CONFLICT" | "REVISION_CONFLICT" | "OWNERSHIP_CONFLICT" | "IMMUTABLE_CONFLICT" | "LEASE_LOST";
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
