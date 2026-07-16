import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { StorageV2Database, type StorageV2RepositorySet } from "../v2/index.js";
import * as JobAtomic from "../v2/jobAtomicOperations.js";
import { commitCanonicalBudget, commitCanonicalRevisionPlan, commitCanonicalStep, transitionCanonicalTerminal } from "../v2/runStateAtomicOperations.js";
import { verifyToolPostcondition } from "../v2/toolPostconditionVerifier.js";
import { verifyCanonicalTerminal } from "../v2/terminalReceiptVerifier.js";
import { recordCapabilityAuditSet } from "../v2/capabilityAuditAtomic.js";
import {
  STORAGE_WORKER_READY,
  STORAGE_WORKER_RESPONSE,
  type StorageWorkerBaseCommand,
  type StorageWorkerCommand,
  type StorageWorkerInit,
  type StorageWorkerReady,
  type StorageWorkerResponse
} from "./typedProtocol.js";
import { assertFencedWriteScope } from "./fencedWriteScope.js";
import { executeFencedWrite } from "./fencedWriteDispatch.js";
import { isStorageWorkerRequest, serializeWorkerError } from "./workerMessageSupport.js";
import { isTraceReadCommand, StorageRuntimeDiagnostics, traceReadResultRows, type StorageRuntimeDiagnosticsOptions } from "./storageRuntimeDiagnostics.js";
import type { StorageTerminalTransitionResult } from "../v2/jobAtomicTypes.js";
import { TerminalCasFinalizeError, type StorageTerminalCasObject } from "../v2/terminalCasStore.js";
import { storageTerminalCasPromotionReceipts } from "../v2/terminalCasPromotionReceipts.js";
import { commitProjectSnapshot } from "../v2/projectSnapshotAtomic.js";
import { lookupEnqueueReceipt } from "../v2/jobEnqueueAtomic.js";
import { activateEngineeringBaselineAtomically } from "../v2/engineeringBaselineActivationAtomic.js";
import { withTerminalCasPostCommitWarning } from "./terminalCasPostCommitWarning.js";
import { dispatchProjectMutationCommand, isProjectMutationCommand } from "./projectMutationDispatch.js";
export * from "./typedProtocol.js";
export { createStorageWorkerClient, StorageWorkerClient, type StorageWorkerClientOptions } from "./typedClient.js";
export type StorageWorkerRuntimeOptions = StorageRuntimeDiagnosticsOptions & { leaseClock?: () => number };
export class StorageWorkerRuntime {
  private readonly storage: StorageV2Database;
  private readonly diagnostics: StorageRuntimeDiagnostics;
  private closed = false;
  constructor(init: StorageWorkerInit, options: StorageWorkerRuntimeOptions = {}) {
    this.storage = new StorageV2Database(init, options.leaseClock ? { leaseClock: options.leaseClock } : {});
    this.diagnostics = new StorageRuntimeDiagnostics(options);
  }

  handle(command: StorageWorkerCommand): unknown {
    if (this.closed && command.name !== "close") throw new Error("Storage worker runtime is closed.");
    if (isProjectMutationCommand(command)) return this.transaction((repositories) => dispatchProjectMutationCommand(command, repositories));
    switch (command.name) {
      case "fencedTransaction":
        return this.transaction((repositories) => {
          const job = repositories.jobs.assertFence(command.fence);
          return command.commands.map((entry) => {
            assertFencedWriteScope(entry, job, repositories);
            return executeFencedWrite(entry, repositories);
          });
        });
      case "job.enqueue":
        return this.transaction((repositories) => JobAtomic.enqueueJob(repositories, command.job, command.project, command.capabilityAudits));
      case "project.snapshot.commit":
        return this.transaction((repositories) => commitProjectSnapshot(repositories, command.input));
      case "engineering.baseline.activate":
        return this.transaction((repositories) => activateEngineeringBaselineAtomically(repositories, command));
      case "engineering.artifact.read":
        return this.transaction((repositories) => repositories.engineering.readArtifact(command.input));
      case "engineering.cas.abort":
        return this.transaction((repositories) => {
          const job = repositories.jobs.assertFence(command.fence);
          for (const claim of command.claims) {
            if (claim.owner.jobId !== job.id || claim.owner.projectId !== job.projectId) {
              throw new Error("Engineering CAS claim owner does not match the active fenced job.");
            }
          }
          return repositories.engineering.abortCasClaims(command.claims);
        });
      case "capability.recordSet":
        return this.transaction((repositories) => recordCapabilityAuditSet(repositories, command.audits, command.project));
      case "job.claimAndStart":
        return this.transaction((repositories) => JobAtomic.claimAndStart(repositories, command.options));
      case "job.requestControl":
        return this.transaction((repositories) => JobAtomic.requestControl(repositories, command.input));
      case "job.markInterruptedExpiredLeases":
        return this.transaction((repositories) => JobAtomic.interruptExpiredLeases(repositories, command.now));
      case "job.transitionTerminal":
        return this.transitionTerminal(command.input);
      case "job.commitStep":
        return this.transaction((repositories) => JobAtomic.commitStep(repositories, command.input));
      case "job.quarantineStep":
        return this.transaction((repositories) => JobAtomic.quarantineStep(repositories, command.input));
      case "canonical.commitStep":
        return this.transaction((repositories) => commitCanonicalStep(repositories, command.input));
      case "canonical.commitBudget":
        return this.transaction((repositories) => commitCanonicalBudget(repositories, command.input));
      case "canonical.commitPlan":
        return this.transaction((repositories) => commitCanonicalRevisionPlan(repositories, command.input));
      case "canonical.transitionTerminal":
        return this.transitionCanonicalTerminal(command.input);
      case "canonical.verifyTerminal":
        return this.verifyCanonicalTerminal(command.input);
      case "toolPostcondition.verify":
        return this.transaction((repositories) => verifyToolPostcondition(repositories, command.input, this.storage.dataRoot));
      default:
        return this.handleBase(command, this.storage.repositories);
    }
  }

  close(): void {
    if (this.closed) return;
    this.storage.close();
    this.closed = true;
  }

  private verifyCanonicalTerminal(input: Parameters<typeof verifyCanonicalTerminal>[1]): ReturnType<typeof verifyCanonicalTerminal> {
    const result = this.transaction((repositories) => verifyCanonicalTerminal(repositories, input));
    this.storage.repositories.terminalAttestations.finalize(result.attestations);
    return result;
  }

  private transitionTerminal(input: Parameters<typeof JobAtomic.transitionTerminal>[1]): ReturnType<typeof JobAtomic.transitionTerminal> {
    const receipts = storageTerminalCasPromotionReceipts(input.promotions);
    this.storage.repositories.engineering.verifyCasObjects(receipts.legacy);
    if (!receipts.claims.length) {
      const result = this.transaction((repositories) => JobAtomic.transitionTerminal(repositories, input));
      return this.finalizeLegacyPromotions(result, receipts.legacy);
    }
    const durableReplay =
      this.storage.repositories.jobs.get(input.fence.jobId)?.status === input.status
        ? this.transaction((repositories) => JobAtomic.transitionTerminal(repositories, input))
        : undefined;
    const committed = this.storage.repositories.engineering.commitCasClaims(
      receipts.claims,
      () => {
        const result = durableReplay ?? this.transaction((repositories) => JobAtomic.transitionTerminal(repositories, input));
        return { result, disposition: result.job.status === "completed" ? ("finalize" as const) : ("abort" as const) };
      },
      Boolean(durableReplay)
    );
    const result = this.finalizeLegacyPromotions(committed.result, receipts.legacy);
    return committed.postCommitError
      ? withTerminalCasPostCommitWarning(
          result,
          committed.postCommitError,
          committed.result.job.status === "completed" ? "finalize" : "abort",
          receipts.claims.length
        )
      : result;
  }

  private transitionCanonicalTerminal(input: Parameters<typeof transitionCanonicalTerminal>[1]): ReturnType<typeof transitionCanonicalTerminal> {
    const receipts = storageTerminalCasPromotionReceipts(input.terminal.promotions);
    this.storage.repositories.engineering.verifyCasObjects(receipts.legacy);
    if (!receipts.claims.length) {
      const result = this.transaction((repositories) => transitionCanonicalTerminal(repositories, input));
      const terminal = this.finalizeLegacyPromotions(result.terminal, receipts.legacy);
      return terminal === result.terminal ? result : { ...result, terminal };
    }
    const durableReplay =
      this.storage.repositories.jobs.get(input.terminal.fence.jobId)?.status === input.terminal.status
        ? this.transaction((repositories) => transitionCanonicalTerminal(repositories, input))
        : undefined;
    const committed = this.storage.repositories.engineering.commitCasClaims(
      receipts.claims,
      () => {
        const result = durableReplay ?? this.transaction((repositories) => transitionCanonicalTerminal(repositories, input));
        return { result, disposition: result.terminal.job.status === "completed" ? ("finalize" as const) : ("abort" as const) };
      },
      Boolean(durableReplay)
    );
    let terminal = this.finalizeLegacyPromotions(committed.result.terminal, receipts.legacy);
    if (committed.postCommitError) {
      terminal = withTerminalCasPostCommitWarning(
        terminal,
        committed.postCommitError,
        committed.result.terminal.job.status === "completed" ? "finalize" : "abort",
        receipts.claims.length
      );
    }
    return terminal === committed.result.terminal ? committed.result : { ...committed.result, terminal };
  }

  private finalizeLegacyPromotions(result: StorageTerminalTransitionResult, objects: readonly StorageTerminalCasObject[]): StorageTerminalTransitionResult {
    if (!objects.length) return result;
    try {
      this.storage.repositories.engineering.finalizeCasObjects(objects);
      return result;
    } catch (error) {
      const failure = error instanceof TerminalCasFinalizeError ? error : new TerminalCasFinalizeError("integrity", error);
      return withTerminalCasPostCommitWarning(result, failure, "finalize", objects.length);
    }
  }

  private handleBase(command: StorageWorkerBaseCommand, repositories: StorageV2RepositorySet): unknown {
    if (isTraceReadCommand(command.name)) {
      return this.diagnostics.measureTraceQuery(
        () => this.dispatchBase(command, repositories),
        (result) => traceReadResultRows(command.name, result)
      );
    }
    return this.dispatchBase(command, repositories);
  }

  private dispatchBase(command: StorageWorkerBaseCommand, repositories: StorageV2RepositorySet): unknown {
    switch (command.name) {
      case "ping":
        return { ok: true };
      case "close":
        this.close();
        return { closed: true };
      case "diagnostics.storage":
        return this.diagnostics.snapshot();
      case "project.upsert":
        return repositories.projects.upsert(command.project);
      case "project.get":
        return repositories.projects.get(command.projectId);
      case "project.list":
        return repositories.projects.list();
      case "project.revision.get":
        return repositories.projectRevisions.current(command.projectId);
      case "record.upsert":
        return repositories.records.upsert(command.record, command.embedding);
      case "record.get":
        return repositories.records.get(command.recordId);
      case "record.listByProject":
        return repositories.records.listByProject(command.projectId, command.options);
      case "record.search":
        return repositories.records.search(command.query, command.options);
      case "memory.upsertItem":
        return repositories.memory.upsertItem(command.item);
      case "memory.upsertChunk":
        return repositories.memory.upsertChunk(command.chunk);
      case "memory.get":
        return repositories.memory.get(command.memoryId);
      case "memory.search":
        return repositories.memory.search(command.query, command.options);
      case "embedding.getByOwner":
        return repositories.embeddings.getByOwner(command.ownerTable, command.ownerId);
      case "engineering.baseline.get":
        return repositories.engineering.get(command.projectId, command.baselineId);
      case "engineering.baseline.active":
        return repositories.engineering.getActive(command.projectId);
      case "engineering.baseline.list":
        return repositories.engineering.list(command.projectId, command.limit);
      case "engineering.promotion.get":
        return repositories.engineering.getPromotion(command.projectId, command.promotionId);
      case "engineering.promotion.listJob":
        return repositories.engineering.listPromotionsForJob(command.jobId, command.limit);
      case "job.get":
        return repositories.jobs.get(command.jobId);
      case "job.lookupIdempotency":
        return repositories.jobs.getByIdempotencyRequest(command.projectId, command.idempotencyKey, command.requestHash);
      case "job.lookupEnqueueReceipt":
        return lookupEnqueueReceipt(repositories, command.projectId, command.idempotencyKey, command.requestHash);
      case "job.listProject":
        return repositories.jobs.listProject(command.projectId, { status: command.status, cursor: command.cursor, limit: command.limit });
      case "job.latestProjectExecution": {
        const job = repositories.jobs.latestProjectOperation(command.projectId, command.operation);
        return job ? { job, checkpoint: repositories.checkpoints.latestCommittedForJob(job.id) } : {};
      }
      case "job.renewLease":
        return repositories.jobs.renewLease(command.fence, command.leaseExpiresAt, command.now);
      case "job.listRunnableProjects":
        return repositories.jobs.listRunnableProjects(command.cursor, command.limit);
      case "job.queueDiagnostics":
        return repositories.jobs.queueDiagnostics(command.limit);
      case "job.queuePosition":
        return repositories.jobs.queuePosition(command.jobId);
      case "event.append":
        if (command.event.jobId) throw new Error("Job events require an active fenced transaction.");
        return this.transaction((transactionRepositories) => transactionRepositories.events.append(command.event));
      case "event.get":
        return repositories.events.get(command.eventId);
      case "event.after":
        return repositories.events.after(command.projectId, command.lastEventId, command.limit);
      case "checkpoint.get":
        return repositories.checkpoints.get(command.checkpointId);
      case "checkpoint.latestCommittedForJob":
        return repositories.checkpoints.latestCommittedForJob(command.jobId);
      case "checkpoint.listForJob":
        return repositories.checkpoints.listForJob(command.jobId);
      case "checkpoint.listStepAttempts":
        return repositories.checkpoints.listStepAttempts(command.jobId);
      case "taskContract.get":
        return repositories.runState.getTaskContract(command.projectId, command.contractId);
      case "runState.latest":
        return repositories.runState.latestRevision(command.owner);
      case "runState.list":
        return repositories.runState.listRevisions(command.owner, command.afterRevision, command.limit);
      case "contextPack.get":
        return repositories.runState.getContextPack(command.owner, command.contextPackId);
      case "contextPack.getResumeBound":
        return repositories.runState.getResumeBoundContextPack(command.owner, command.predecessorJobId, command.contextPackId);
      case "contextPack.latest":
        return repositories.runState.latestContextPack(command.owner);
      case "contextPack.latestForJob":
        return repositories.runState.latestContextPackForJob(command.owner);
      case "contextPack.listRevision":
        return repositories.runState.listContextPacks(command.owner, command.stateRevision);
      case "terminal.createAttestedLease":
        return repositories.terminalAttestedReadback.createLease(command.input);
      case "terminal.readAttestedLease":
        return repositories.terminalAttestedReadback.readLease(command.input);
      case "terminal.releaseAttestedLease":
        return repositories.terminalAttestedReadback.releaseLease(command.input);
      case "capability.record":
        return repositories.capabilities.record(command.audit);
      case "capability.listProject":
        return repositories.capabilities.listProject(command.projectId, command.limit);
      case "trace.llm.listJob":
        return repositories.trace.listLlmInvocations(command.jobId, command.limit);
      case "trace.decision.listJob":
        return repositories.trace.listToolDecisions(command.jobId, command.limit);
      case "trace.attempt.get":
        return repositories.trace.getToolAttempt(command.attemptId);
      case "trace.attempt.listJob":
        return repositories.trace.listToolAttempts(command.jobId, command.limit);
      case "trace.sideEffect.get":
        return repositories.toolSideEffects.get(command.projectId, command.sideEffectKey);
      case "trace.sideEffect.getAttempt":
        return repositories.toolSideEffects.getByAttempt(command.attemptId);
      case "trace.codex.listJob":
        return repositories.trace.listCodexCliExecutions(command.jobId, command.limit);
      case "trace.output.listAttempt":
        return repositories.trace.listOutputLinks(command.attemptId, command.limit);
      case "trace.output.listAttempts":
        return repositories.trace.listOutputLinksForAttempts(command.attemptIds, command.limit);
      case "trace.network.listJob":
        return repositories.trace.listNetworkAudits(command.jobId, command.limit);
      case "trace.summaryJob":
        return repositories.trace.summaryJob(command.jobId);
      case "trace.pageJob":
        return repositories.trace.pageJob(command.jobId, command.category, command.cursor, command.limit);
      case "ontology.upsertEntities":
        return repositories.ontology.upsertEntities(command.entities);
      case "ontology.upsertRelations":
        return repositories.ontology.upsertRelations(command.relations);
      case "ontology.upsertConstraints":
        return repositories.ontology.upsertConstraints(command.constraints);
      case "ontology.search":
        return repositories.ontology.search(command.query, command.options);
      case "ontology.startRun":
        return repositories.ontology.startRun(command.run);
      case "ontology.finishRun":
        return repositories.ontology.finishRun(command.runId, command.patch);
      default:
        return assertNever(command);
    }
  }

  private transaction<T>(work: (repositories: StorageV2RepositorySet) => T): T {
    return this.diagnostics.measureTransaction(() => this.storage.transaction(work));
  }
}

if (!isMainThread && parentPort) {
  startStorageWorker(parentPort, workerData as StorageWorkerInit);
}

function startStorageWorker(port: MessagePort, init: StorageWorkerInit): void {
  let runtime: StorageWorkerRuntime;
  try {
    runtime = new StorageWorkerRuntime(init);
    port.postMessage({ type: STORAGE_WORKER_READY, ok: true } satisfies StorageWorkerReady);
  } catch (error) {
    port.postMessage({ type: STORAGE_WORKER_READY, ok: false, error: serializeWorkerError(error) } satisfies StorageWorkerReady);
    port.close();
    return;
  }

  port.on("message", (message: unknown) => {
    if (!isStorageWorkerRequest(message)) return;
    try {
      const result = runtime.handle(message.command);
      const response: StorageWorkerResponse = {
        type: STORAGE_WORKER_RESPONSE,
        requestId: message.requestId,
        clientRequestId: message.clientRequestId,
        ok: true,
        result
      };
      port.postMessage(response);
      if (message.command.name === "close") {
        port.close();
      }
    } catch (error) {
      const response: StorageWorkerResponse = {
        type: STORAGE_WORKER_RESPONSE,
        requestId: message.requestId,
        clientRequestId: message.clientRequestId,
        ok: false,
        error: serializeWorkerError(error)
      };
      port.postMessage(response);
    }
  });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled storage worker command: ${JSON.stringify(value)}`);
}
