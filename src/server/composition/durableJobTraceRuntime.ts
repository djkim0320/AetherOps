import { EventEmitter } from "node:events";
import type { SseEvent } from "../../contracts/api-v2/events.js";
import type { StorageFencedWriteCommand } from "../runtime/storage/worker/typedProtocol.js";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageToolPostconditionVerifyResult } from "../runtime/storage/v2/jobAtomicTypes.js";
import type { StorageProjectRevisionHead } from "../runtime/storage/v2/projectRevisionRepository.js";
import type { StorageProjectSnapshotCommitInput, StorageProjectSnapshotCommitResult } from "../runtime/storage/v2/projectSnapshotAtomic.js";
import type {
  StorageCheckpoint,
  StorageCompletedStepInput,
  StorageJobEvent,
  StorageLeaseFence,
  StorageStepDispositionResult
} from "../runtime/storage/v2/types.js";
import type {
  StorageCodexCliExecution,
  StorageLlmInvocation,
  StorageNetworkAudit,
  StorageToolAttempt,
  StorageToolDecision,
  StorageToolOutputLink
} from "../runtime/storage/v2/traceTypes.js";
import { eventFromStorage } from "./durableJobMappers.js";
import { durableFailureFrom } from "./durableFailure.js";
import { durableToolRunEventId } from "./durableSseEventIdentity.js";
import {
  sanitizeCodexCliExecution,
  sanitizeLlmInvocation,
  sanitizeNetworkAudit,
  sanitizeToolAttempt,
  sanitizeToolDecision,
  sanitizeToolOutput
} from "./durableTraceSanitizer.js";

type PublishFailureHandler = (error: unknown, event: SseEvent) => void;
type FenceProvider = () => StorageLeaseFence | undefined;
export type DurableProjectSnapshotCommitResult = Omit<StorageProjectSnapshotCommitResult, "event"> & { event: SseEvent };

export class DurableJobTraceRuntime {
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly client: StorageWorkerClient,
    private readonly onPublishFailure: PublishFailureHandler = logPublishFailure,
    private readonly fenceProvider: FenceProvider = () => undefined,
    private readonly dataRoot?: string
  ) {
    this.emitter.setMaxListeners(0);
  }

  async appendEvent(event: Omit<SseEvent, "id">, internalEventId?: string, internalMutationHash?: string): Promise<SseEvent> {
    const fence = this.fenceProvider();
    const command = {
      name: "event.append",
      event: {
        ...(internalEventId === undefined ? {} : { eventId: internalEventId }),
        projectId: event.projectId,
        jobId: eventJobId(event) ?? fence?.jobId,
        type: event.type,
        createdAt: event.occurredAt,
        payload: {
          projectRevision: event.projectRevision,
          data: event.data,
          ...(internalMutationHash === undefined ? {} : { mutationHash: internalMutationHash })
        }
      }
    } as const;
    const stored = fence ? await this.fencedWrite<StorageJobEvent>(fence, command) : await this.client.request<StorageJobEvent>(command);
    return this.publishStoredEvent(stored);
  }

  async getProjectRevision(projectId: string): Promise<number | undefined> {
    const head = await this.getProjectRevisionHead(projectId);
    return head?.revision;
  }

  getProjectRevisionHead(projectId: string): Promise<StorageProjectRevisionHead | undefined> {
    return this.client.request({ name: "project.revision.get", projectId });
  }

  async commitProjectSnapshot(input: StorageProjectSnapshotCommitInput): Promise<DurableProjectSnapshotCommitResult> {
    const stored = await this.client.request<StorageProjectSnapshotCommitResult>({ name: "project.snapshot.commit", input });
    return { ...stored, event: this.publishStoredEvent(stored.event) };
  }

  saveLlmInvocation(invocation: StorageLlmInvocation): Promise<StorageLlmInvocation> {
    return this.requiredFencedWrite(invocation.jobId, { name: "trace.llm.save", invocation: sanitizeLlmInvocation(invocation) });
  }

  recordToolDecision(decision: StorageToolDecision): Promise<StorageToolDecision> {
    return this.requiredFencedWrite(decision.jobId, { name: "trace.decision.record", decision: sanitizeToolDecision(decision) });
  }

  saveCodexCliExecution(execution: StorageCodexCliExecution): Promise<StorageCodexCliExecution> {
    return this.requiredFencedWrite(execution.jobId, { name: "trace.codex.save", execution: sanitizeCodexCliExecution(execution) });
  }

  async recordToolAttemptAndEvent(input: { attempt: StorageToolAttempt; projectRevision: number; toolName: string }): Promise<StorageToolAttempt> {
    const occurredAt = new Date().toISOString();
    const fence = this.requireFence(input.attempt.jobId);
    const [attempt, event] = await this.client.request<[StorageToolAttempt, StorageJobEvent]>({
      name: "fencedTransaction",
      fence,
      commands: [
        { name: "trace.attempt.save", attempt: sanitizeToolAttempt(input.attempt, this.dataRoot) },
        {
          name: "event.append",
          event: {
            eventId: durableToolRunEventId({
              projectId: input.attempt.projectId,
              attemptId: input.attempt.id,
              status: input.attempt.status
            }),
            projectId: input.attempt.projectId,
            jobId: input.attempt.jobId,
            type: "tool.run.changed",
            createdAt: occurredAt,
            payload: {
              projectRevision: input.projectRevision,
              data: {
                jobId: input.attempt.jobId,
                decisionId: input.attempt.decisionId,
                attemptId: input.attempt.id,
                ordinal: input.attempt.ordinal,
                toolName: input.toolName,
                status: input.attempt.status
              }
            }
          }
        }
      ]
    });
    this.publishStoredEvent(event);
    return attempt;
  }

  async verifyToolPostcondition(input: { jobId: string; attemptId: string; projectRevision: number; verifiedAt: string }): Promise<StorageToolAttempt> {
    const result = await this.client.request<StorageToolPostconditionVerifyResult>({
      name: "toolPostcondition.verify",
      input: {
        fence: this.requireFence(input.jobId),
        attemptId: input.attemptId,
        projectRevision: input.projectRevision,
        verifiedAt: input.verifiedAt
      }
    });
    if (result.event) this.publishStoredEvent(result.event);
    return result.attempt;
  }

  recordToolOutput(link: StorageToolOutputLink): Promise<StorageToolOutputLink> {
    return this.requiredFencedWrite(link.jobId, { name: "trace.output.record", link: sanitizeToolOutput(link) });
  }

  recordNetworkAudit(audit: StorageNetworkAudit): Promise<StorageNetworkAudit> {
    return this.requiredFencedWrite(audit.jobId, { name: "trace.network.record", audit: sanitizeNetworkAudit(audit) });
  }

  async commitCheckpoint(input: { projectId: string; jobId: string; step: string; projectRevision: number }): Promise<StorageCheckpoint> {
    const now = new Date().toISOString();
    const completedStep = await this.completedStep(input.jobId, input.step);
    const result = await this.client.request<StorageStepDispositionResult>({
      name: "job.commitStep",
      input: {
        fence: this.requireFence(input.jobId),
        ...completedStep,
        projectRevision: input.projectRevision,
        occurredAt: now
      }
    });
    this.publishStoredEvent(result.event);
    return result.checkpoint;
  }

  async completedStep(jobId: string, step: string): Promise<StorageCompletedStepInput> {
    const attempts = await this.client.request<StorageToolAttempt[]>({ name: "trace.attempt.listJob", jobId, limit: 1_000 });
    return {
      step,
      checkpointData: {
        phase: "execute_tools_completed",
        attempts: attempts
          .filter((attempt) => attempt.status === "completed")
          .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
          .map((attempt) => ({ id: attempt.id, inputHash: attempt.inputHash, outputHash: attempt.outputHash }))
      }
    };
  }

  async eventsAfter(projectId: string, lastEventId?: string | number, limit = 200, signal?: AbortSignal): Promise<SseEvent[]> {
    signal?.throwIfAborted();
    const rows = await this.client.request<StorageJobEvent[]>({ name: "event.after", projectId, lastEventId, limit });
    signal?.throwIfAborted();
    return rows.map(eventFromStorage);
  }

  subscribe(listener: (event: SseEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  publishStoredEvent(stored: StorageJobEvent): SseEvent {
    const event = eventFromStorage(stored);
    for (const listener of this.emitter.listeners("event")) {
      try {
        (listener as (value: SseEvent) => void)(event);
      } catch (error) {
        this.onPublishFailure(error, event);
      }
    }
    return event;
  }

  publishStoredEvents(events: StorageJobEvent[]): void {
    const seen = new Set<number>();
    for (const event of events)
      if (!seen.has(event.sequence)) {
        seen.add(event.sequence);
        this.publishStoredEvent(event);
      }
  }

  close(): void {
    this.emitter.removeAllListeners();
  }

  private requireFence(jobId: string): StorageLeaseFence {
    const fence = this.fenceProvider();
    if (!fence || fence.jobId !== jobId) throw new Error(`Durable trace write for ${jobId} requires its active lease fence.`);
    return fence;
  }

  private async requiredFencedWrite<T>(jobId: string, command: StorageFencedWriteCommand): Promise<T> {
    return this.fencedWrite(this.requireFence(jobId), command);
  }

  private async fencedWrite<T>(fence: StorageLeaseFence, command: StorageFencedWriteCommand): Promise<T> {
    const [result] = await this.client.request<[T]>({ name: "fencedTransaction", fence, commands: [command] });
    return result;
  }
}

function logPublishFailure(error: unknown, event: SseEvent): void {
  const failure = durableFailureFrom(error);
  console.error(
    JSON.stringify({
      level: "error",
      operation: "durable_event_publish",
      diagnosticId: failure.internalDiagnosticId,
      projectId: event.projectId,
      eventId: event.id,
      errorCode: failure.code
    })
  );
}

function eventJobId(event: Omit<SseEvent, "id">): string | undefined {
  return "jobId" in event.data && typeof event.data.jobId === "string" ? event.data.jobId : undefined;
}
