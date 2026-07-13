import { randomUUID } from "node:crypto";
import { Worker, isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { StorageV2Database, type StorageV2RepositorySet } from "../v2/index.js";
import {
  claimAndStart,
  commitStep,
  enqueueJob,
  interruptExpiredLeases,
  quarantineStep,
  requestControl,
  transitionTerminal
} from "../v2/jobAtomicOperations.js";
import {
  STORAGE_WORKER_READY,
  STORAGE_WORKER_REQUEST,
  STORAGE_WORKER_RESPONSE,
  type StorageWorkerBaseCommand,
  type StorageWorkerCommand,
  type StorageWorkerInit,
  type StorageWorkerReady,
  type StorageWorkerRequest,
  type StorageWorkerResponse
} from "./typedProtocol.js";
import { sourceAwareWorkerExecArgv, sourceAwareWorkerUrl } from "./sourceWorkerRuntime.js";
import { assertFencedWriteScope } from "./fencedWriteScope.js";
import { executeFencedWrite } from "./fencedWriteDispatch.js";
import { isStorageWorkerReady, isStorageWorkerRequest, isStorageWorkerResponse, serializeWorkerError, workerError } from "./workerMessageSupport.js";
import { isTraceReadCommand, StorageRuntimeDiagnostics, traceReadResultRows, type StorageRuntimeDiagnosticsOptions } from "./storageRuntimeDiagnostics.js";
export * from "./typedProtocol.js";
export class StorageWorkerRuntime {
  private readonly storage: StorageV2Database;
  private readonly diagnostics: StorageRuntimeDiagnostics;
  private closed = false;

  constructor(init: StorageWorkerInit, diagnosticsOptions: StorageRuntimeDiagnosticsOptions = {}) {
    this.storage = new StorageV2Database(init);
    this.diagnostics = new StorageRuntimeDiagnostics(diagnosticsOptions);
  }

  handle(command: StorageWorkerCommand): unknown {
    if (this.closed && command.name !== "close") {
      throw new Error("Storage worker runtime is closed.");
    }
    switch (command.name) {
      case "fencedTransaction":
        return this.transaction((repositories) => {
          const job = repositories.jobs.assertFence(command.fence, command.now);
          return command.commands.map((entry) => {
            assertFencedWriteScope(entry, job, repositories);
            return executeFencedWrite(entry, repositories);
          });
        });
      case "job.enqueue":
        return this.transaction((repositories) => enqueueJob(repositories, command.job));
      case "job.claimAndStart":
        return this.transaction((repositories) => claimAndStart(repositories, command.options));
      case "job.requestControl":
        return this.transaction((repositories) => requestControl(repositories, command.input));
      case "job.markInterruptedExpiredLeases":
        return this.transaction((repositories) => interruptExpiredLeases(repositories, command.now));
      case "job.transitionTerminal":
        return this.transaction((repositories) => transitionTerminal(repositories, command.input));
      case "job.commitStep":
        return this.transaction((repositories) => commitStep(repositories, command.input));
      case "job.quarantineStep":
        return this.transaction((repositories) => quarantineStep(repositories, command.input));
      default:
        return this.handleBase(command, this.storage.repositories);
    }
  }

  close(): void {
    if (this.closed) return;
    this.storage.close();
    this.closed = true;
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
      case "job.get":
        return repositories.jobs.get(command.jobId);
      case "job.listProject":
        return repositories.jobs.listProject(command.projectId, { status: command.status, cursor: command.cursor, limit: command.limit });
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
        return repositories.events.append(command.event);
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

export interface StorageWorkerClientOptions {
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

export class StorageWorkerClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private closed = false;

  constructor(
    private readonly worker: Worker,
    options: StorageWorkerClientOptions = {}
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.worker.on("message", this.handleMessage);
    this.worker.on("error", this.rejectAllFromError);
    this.worker.on("exit", this.handleExit);
  }

  request<T = unknown>(command: StorageWorkerCommand, clientRequestId?: string): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Storage worker client is closed."));
    }
    const requestId = randomUUID();
    const message: StorageWorkerRequest = {
      type: STORAGE_WORKER_REQUEST,
      requestId,
      clientRequestId,
      command
    };
    return new Promise<T>((resolve, reject) => {
      const timeout =
        this.requestTimeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(requestId);
              reject(new Error(`Storage worker request timed out: ${requestId}`));
            }, this.requestTimeoutMs)
          : undefined;
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timeout });
      this.worker.postMessage(message);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request({ name: "close" });
    } finally {
      this.closed = true;
      this.worker.off("message", this.handleMessage);
      this.worker.off("error", this.rejectAllFromError);
      this.worker.off("exit", this.handleExit);
      await this.worker.terminate();
      this.rejectAll(new Error("Storage worker client closed."));
    }
  }

  private readonly handleMessage = (message: unknown): void => {
    if (isStorageWorkerReady(message)) {
      if (!message.ok) {
        this.closed = true;
        this.rejectAll(workerError(message.error));
      }
      return;
    }
    if (!isStorageWorkerResponse(message)) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (pending.timeout) clearTimeout(pending.timeout);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(workerError(message.error));
    }
  };

  private readonly rejectAllFromError = (error: Error): void => {
    this.rejectAll(error);
  };

  private readonly handleExit = (code: number): void => {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error(`Storage worker exited before shutdown: ${code}`));
  };

  private rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }
}

export function createStorageWorkerClient(
  init: StorageWorkerInit,
  options: StorageWorkerClientOptions = {},
  workerUrl: URL | string = defaultTypedWorkerUrl()
): StorageWorkerClient {
  return new StorageWorkerClient(
    new Worker(workerUrl, {
      workerData: init,
      execArgv: sourceAwareWorkerExecArgv()
    }),
    options
  );
}

function defaultTypedWorkerUrl(): URL {
  return sourceAwareWorkerUrl("typedRuntime");
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
