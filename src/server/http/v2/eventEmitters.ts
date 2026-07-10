import type { JobStatus } from "../../../contracts/api-v2/jobs.js";
import type { ResearchLoopStep } from "../../../shared/kernel/researchLoop.js";
import type { ResearchSnapshot } from "../../../core/shared/types.js";
import { createId, nowIso } from "../../../core/shared/ids.js";
import type { DurableJobRuntime } from "../../composition/durableJobRuntime.js";

export async function emitProjectSnapshotChanged(
  events: DurableJobRuntime,
  snapshot: ResearchSnapshot,
  reason: "project_updated" | "job_changed" | "resync_required"
): Promise<void> {
  const revision = Math.max(1, snapshot.iterations.length);
  await events.appendEvent({
    projectId: snapshot.project.id,
    projectRevision: revision,
    occurredAt: nowIso(),
    type: "project.snapshot.changed",
    data: { snapshotVersion: revision, reason }
  });
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
  await events.appendEvent({ projectId, projectRevision, occurredAt: nowIso(), type: "run.status.changed", data: { jobId, status, previousStatus, reason } });
}

export async function emitRunStepChanged(
  events: DurableJobRuntime,
  projectId: string,
  projectRevision: number,
  jobId: string,
  step: ResearchLoopStep,
  checkpointId?: string
): Promise<void> {
  await events.appendEvent({ projectId, projectRevision, occurredAt: nowIso(), type: "run.step.changed", data: { jobId, step, checkpointId } });
}

export async function emitChatMessageAppended(
  events: DurableJobRuntime,
  projectId: string,
  projectRevision: number,
  sessionId: string,
  content: string,
  clientMutationId: string
): Promise<void> {
  await events.appendEvent({
    projectId,
    projectRevision,
    occurredAt: nowIso(),
    type: "chat.message.appended",
    data: { sessionId, message: { id: createId("message"), projectId, sessionId, role: "user", content, clientMutationId, createdAt: nowIso() } }
  });
}

export async function emitToolRunChanged(
  events: DurableJobRuntime,
  projectId: string,
  projectRevision: number,
  jobId: string,
  toolRunId: string,
  toolName: string,
  status: "queued" | "running" | "blocked" | "failed" | "completed"
): Promise<void> {
  await events.appendEvent({ projectId, projectRevision, occurredAt: nowIso(), type: "tool.run.changed", data: { jobId, toolRunId, toolName, status } });
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
  await events.appendEvent({ projectId, projectRevision, occurredAt: nowIso(), type: "artifact.created", data: { jobId, artifactId, name, kind } });
}
