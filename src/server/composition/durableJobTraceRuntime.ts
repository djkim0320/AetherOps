import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { SseEvent } from "../../contracts/api-v2/events.js";
import type { StorageWorkerBaseCommand } from "../runtime/storage/worker/typedProtocol.js";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageJobEvent } from "../runtime/storage/v2/types.js";
import type { StorageCheckpoint } from "../runtime/storage/v2/types.js";
import type {
  StorageCodexCliExecution,
  StorageLlmInvocation,
  StorageNetworkAudit,
  StorageToolAttempt,
  StorageToolDecision,
  StorageToolOutputLink
} from "../runtime/storage/v2/traceTypes.js";
import { eventFromStorage } from "./durableJobMappers.js";

export class DurableJobTraceRuntime {
  private readonly emitter = new EventEmitter();

  constructor(private readonly client: StorageWorkerClient) {
    this.emitter.setMaxListeners(0);
  }

  async appendEvent(event: Omit<SseEvent, "id">): Promise<SseEvent> {
    const stored = await this.client.request<StorageJobEvent>({
      name: "event.append",
      event: {
        projectId: event.projectId,
        jobId: eventJobId(event),
        type: event.type,
        createdAt: event.occurredAt,
        payload: { projectRevision: event.projectRevision, data: event.data }
      }
    });
    return this.publishStoredEvent(stored);
  }

  saveLlmInvocation(invocation: StorageLlmInvocation): Promise<StorageLlmInvocation> {
    return this.client.request({ name: "trace.llm.save", invocation });
  }

  recordToolDecision(decision: StorageToolDecision): Promise<StorageToolDecision> {
    return this.client.request({ name: "trace.decision.record", decision });
  }

  saveCodexCliExecution(execution: StorageCodexCliExecution): Promise<StorageCodexCliExecution> {
    return this.client.request({ name: "trace.codex.save", execution });
  }

  async recordToolAttemptAndEvent(input: { attempt: StorageToolAttempt; projectRevision: number; toolName: string }): Promise<StorageToolAttempt> {
    const occurredAt = new Date().toISOString();
    const [attempt, event] = await this.client.transaction<[StorageToolAttempt, StorageJobEvent]>([
      { name: "trace.attempt.save", attempt: input.attempt },
      {
        name: "event.append",
        event: {
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
    ]);
    this.publishStoredEvent(event);
    return attempt;
  }

  recordToolOutput(link: StorageToolOutputLink): Promise<StorageToolOutputLink> {
    return this.client.request({ name: "trace.output.record", link });
  }

  async recordPromotedArtifactAndEvent(input: {
    link: StorageToolOutputLink;
    projectRevision: number;
    artifact: { name: string; kind: string };
  }): Promise<StorageToolOutputLink> {
    if (!input.link.promoted || input.link.outputKind !== "artifact") throw new Error("Only promoted artifacts may emit artifact.created.");
    const existing = await this.client.request<StorageToolOutputLink[]>({
      name: "trace.output.listAttempt",
      attemptId: input.link.attemptId,
      limit: 1_000
    });
    const promoted = existing.find((item) => item.outputKind === "artifact" && item.outputId === input.link.outputId && item.promoted);
    if (promoted) return promoted;
    const commands: StorageWorkerBaseCommand[] = [
      { name: "trace.output.record", link: input.link },
      {
        name: "event.append",
        event: {
          projectId: input.link.projectId,
          jobId: input.link.jobId,
          type: "artifact.created",
          createdAt: input.link.promotedAt ?? new Date().toISOString(),
          payload: {
            projectRevision: input.projectRevision,
            data: {
              jobId: input.link.jobId,
              artifactId: input.link.outputId,
              name: input.artifact.name,
              kind: input.artifact.kind
            }
          }
        }
      }
    ];
    const [link, event] = await this.client.transaction<[StorageToolOutputLink, StorageJobEvent]>(commands);
    this.publishStoredEvent(event);
    return link;
  }

  recordNetworkAudit(audit: StorageNetworkAudit): Promise<StorageNetworkAudit> {
    return this.client.request({ name: "trace.network.record", audit });
  }

  async commitCheckpoint(input: { projectId: string; jobId: string; step: string; projectRevision: number }): Promise<StorageCheckpoint> {
    const now = new Date().toISOString();
    const checkpointId = randomUUID();
    const attempts = await this.client.request<StorageToolAttempt[]>({ name: "trace.attempt.listJob", jobId: input.jobId, limit: 1_000 });
    const checkpoint: StorageCheckpoint = {
      id: checkpointId,
      projectId: input.projectId,
      jobId: input.jobId,
      step: input.step,
      checkpointKey: `step-${input.step.toLowerCase()}-${checkpointId}`,
      status: "committed",
      data: {
        phase: "execute_tools_completed",
        attempts: attempts
          .filter((attempt) => attempt.status === "completed")
          .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
          .map((attempt) => ({ id: attempt.id, inputHash: attempt.inputHash, outputHash: attempt.outputHash }))
      },
      createdAt: now,
      committedAt: now
    };
    const [stored, event] = await this.client.transaction<[StorageCheckpoint, StorageJobEvent]>([
      { name: "checkpoint.save", checkpoint },
      {
        name: "event.append",
        event: {
          projectId: input.projectId,
          jobId: input.jobId,
          type: "run.step.changed",
          createdAt: now,
          payload: { projectRevision: input.projectRevision, data: { jobId: input.jobId, step: input.step, checkpointId: checkpoint.id } }
        }
      }
    ]);
    this.publishStoredEvent(event);
    return stored;
  }

  async eventsAfter(projectId: string, lastEventId?: string | number, limit = 200): Promise<SseEvent[]> {
    const rows = await this.client.request<StorageJobEvent[]>({ name: "event.after", projectId, lastEventId, limit });
    return rows.map(eventFromStorage);
  }

  subscribe(listener: (event: SseEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  publishStoredEvent(stored: StorageJobEvent): SseEvent {
    const event = eventFromStorage(stored);
    this.emitter.emit("event", event);
    return event;
  }

  close(): void {
    this.emitter.removeAllListeners();
  }
}

function eventJobId(event: Omit<SseEvent, "id">): string | undefined {
  return "jobId" in event.data && typeof event.data.jobId === "string" ? event.data.jobId : undefined;
}
