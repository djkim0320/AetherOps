import { durableJobRequestHash } from "./durableJobRequestHash.js";

const EVENT_ID_VERSION = "durable-sse-mutation-v1";

export function durableProjectSnapshotEventId(input: {
  projectId: string;
  reason: string;
  snapshotContentHash: string;
  snapshotUpdatedAt: string;
  callerMutationId?: string;
}): string {
  const mutation =
    input.callerMutationId === undefined
      ? { reason: input.reason, snapshotContentHash: input.snapshotContentHash, snapshotUpdatedAt: input.snapshotUpdatedAt }
      : { callerMutationId: input.callerMutationId };
  return durableEventId("project.snapshot.changed", input.projectId, mutation);
}

export function durableChatMessageEventId(input: { projectId: string; sessionId: string; clientMutationId: string }): string {
  return durableEventId("chat.message.appended", input.projectId, {
    sessionId: input.sessionId,
    clientMutationId: input.clientMutationId
  });
}

export function durableChatMessageId(input: { projectId: string; sessionId: string; clientMutationId: string }): string {
  return `message_${durableJobRequestHash({ version: "durable-chat-message-v1", ...input })}`;
}

export function durableRunStatusEventId(input: { projectId: string; jobId: string; status: string }): string {
  return durableEventId("run.status.changed", input.projectId, { jobId: input.jobId, status: input.status });
}

export function durableRunStepEventId(input: { projectId: string; jobId: string; step: string; checkpointId?: string }): string {
  return durableEventId("run.step.changed", input.projectId, {
    jobId: input.jobId,
    step: input.step,
    checkpointId: input.checkpointId
  });
}

export function durableToolRunEventId(input: { projectId: string; attemptId: string; status: string }): string {
  return durableEventId("tool.run.changed", input.projectId, { attemptId: input.attemptId, status: input.status });
}

export function durableArtifactCreatedEventId(input: { projectId: string; artifactId: string }): string {
  return durableEventId("artifact.created", input.projectId, { artifactId: input.artifactId });
}

function durableEventId(type: string, projectId: string, mutation: Record<string, unknown>): string {
  return `event:${durableJobRequestHash({ version: EVENT_ID_VERSION, type, projectId, mutation })}`;
}
