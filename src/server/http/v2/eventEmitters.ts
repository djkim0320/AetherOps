import type { JobStatus } from "../../../contracts/api-v2/jobs.js";
import type { SseEvent } from "../../../contracts/api-v2/events.js";
import type { ResearchLoopStep } from "../../../shared/kernel/researchLoop.js";
import type { ResearchSnapshot } from "../../../core/shared/types.js";
import { nowIso } from "../../../core/shared/ids.js";
import type { DurableJobRuntime } from "../../composition/durableJobRuntime.js";
import { durableJobRequestHash } from "../../composition/durableJobRequestHash.js";
import {
  durableArtifactCreatedEventId,
  durableChatMessageEventId,
  durableChatMessageId,
  durableProjectSnapshotEventId,
  durableRunStatusEventId,
  durableRunStepEventId,
  durableToolRunEventId
} from "../../composition/durableSseEventIdentity.js";
import { RpcNotReadyError } from "./rpcErrors.js";

export async function emitProjectSnapshotChanged(
  events: DurableJobRuntime,
  snapshot: ResearchSnapshot,
  reason: "project_updated" | "job_changed" | "resync_required",
  callerMutationId?: string,
  expectedProjectRevision?: number
): Promise<SseEvent> {
  const projectId = snapshot.project.id;
  const snapshotContentHash = durableJobRequestHash(snapshot);
  const storedRevision = expectedProjectRevision ?? (await events.getProjectRevision(projectId));
  if (!Number.isInteger(storedRevision) || Number(storedRevision) < 0) {
    throw new RpcNotReadyError("The durable project revision is unavailable.", { projectId, reason: "PROJECT_REVISION_UNAVAILABLE" });
  }
  const committed = await events.commitProjectSnapshot({
    project: snapshot.project,
    expectedProjectRevision: Number(storedRevision),
    eventId: durableProjectSnapshotEventId({
      projectId,
      reason,
      snapshotContentHash,
      snapshotUpdatedAt: snapshot.project.updatedAt,
      callerMutationId
    }),
    snapshotHash: snapshotContentHash,
    occurredAt: nowIso(),
    reason
  });
  return committed.event;
}

export async function emitRunStatusChanged(
  events: DurableJobRuntime,
  projectId: string,
  projectRevision: number,
  jobId: string,
  status: JobStatus,
  previousStatus?: JobStatus,
  reason?: string
): Promise<void> {
  await events.appendEvent(
    { projectId, projectRevision, occurredAt: nowIso(), type: "run.status.changed", data: { jobId, status, previousStatus, reason } },
    durableRunStatusEventId({ projectId, jobId, status })
  );
}

export async function emitRunStepChanged(
  events: DurableJobRuntime,
  projectId: string,
  projectRevision: number,
  jobId: string,
  step: ResearchLoopStep,
  checkpointId?: string
): Promise<void> {
  await events.appendEvent(
    { projectId, projectRevision, occurredAt: nowIso(), type: "run.step.changed", data: { jobId, step, checkpointId } },
    durableRunStepEventId({ projectId, jobId, step, checkpointId })
  );
}

export async function emitChatMessageAppended(
  events: DurableJobRuntime,
  projectId: string,
  projectRevision: number,
  sessionId: string,
  content: string,
  clientMutationId: string,
  mutationOccurredAt: string
): Promise<void> {
  const identity = { projectId, sessionId, clientMutationId };
  await events.appendEvent(
    {
      projectId,
      projectRevision,
      occurredAt: nowIso(),
      type: "chat.message.appended",
      data: {
        sessionId,
        message: { id: durableChatMessageId(identity), projectId, sessionId, role: "user", content, clientMutationId, createdAt: mutationOccurredAt }
      }
    },
    durableChatMessageEventId(identity)
  );
}

export async function emitToolRunChanged(
  events: DurableJobRuntime,
  projectId: string,
  projectRevision: number,
  jobId: string,
  decisionId: string,
  attemptId: string,
  ordinal: number,
  toolName: string,
  status: "queued" | "running" | "blocked" | "failed" | "completed" | "interrupted" | "quarantined"
): Promise<void> {
  await events.appendEvent(
    {
      projectId,
      projectRevision,
      occurredAt: nowIso(),
      type: "tool.run.changed",
      data: { jobId, decisionId, attemptId, ordinal, toolName, status }
    },
    durableToolRunEventId({ projectId, attemptId, status })
  );
}

export async function emitArtifactCreated(
  events: DurableJobRuntime,
  projectId: string,
  projectRevision: number,
  jobId: string,
  artifactId: string,
  name: string,
  kind: string
): Promise<void> {
  await events.appendEvent(
    { projectId, projectRevision, occurredAt: nowIso(), type: "artifact.created", data: { jobId, artifactId, name, kind } },
    durableArtifactCreatedEventId({ projectId, artifactId })
  );
}
