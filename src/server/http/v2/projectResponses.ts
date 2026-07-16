import { z } from "zod";
import { ChatMessageSchema, type ChatMessage } from "../../../contracts/api-v2/jobs.js";
import { ProjectSchema, ProjectSummarySchema, SessionSchema } from "../../../contracts/api-v2/projects.js";
import { ProjectSnapshotSchema } from "../../../contracts/api-v2/snapshots.js";
import { CapabilityGrantSchema } from "../../../contracts/api-v2/settings.js";
import type { ResearchProject, ResearchSession, ResearchSnapshot } from "../../../core/shared/types.js";

export function projectCapabilities(project: ResearchProject): z.infer<typeof CapabilityGrantSchema> {
  return {
    agent: project.autonomyPolicy.allowAgent ?? true,
    engineering: Boolean(project.autonomyPolicy.allowCodeExecution),
    search: Boolean(project.autonomyPolicy.allowExternalSearch)
  };
}

export function toProjectSummary(snapshot: ResearchSnapshot, projectRevision: number): z.infer<typeof ProjectSummarySchema> {
  return ProjectSummarySchema.parse({
    id: snapshot.project.id,
    input: {
      goal: snapshot.project.goal,
      topic: snapshot.project.topic,
      scope: snapshot.project.scope,
      budget: snapshot.project.budget
    },
    capabilities: projectCapabilities(snapshot.project),
    execution: {
      status: snapshot.project.status,
      currentStep: snapshot.project.currentStep,
      revision: projectRevision
    },
    createdAt: snapshot.project.createdAt,
    updatedAt: snapshot.project.updatedAt
  });
}

export function toProjectResponse(snapshot: ResearchSnapshot, projectRevision: number): z.infer<typeof ProjectSchema> {
  return ProjectSchema.parse(toProjectSummary(snapshot, projectRevision));
}

export function toSessionResponse(session: ResearchSession): z.infer<typeof SessionSchema> {
  return SessionSchema.parse({
    id: session.id,
    projectId: session.projectId,
    title: session.title,
    focus: session.focus,
    createdAt: session.createdAt,
    updatedAt: session.createdAt
  });
}

export function toSnapshotResponse(
  snapshot: ResearchSnapshot,
  projectRevision: number,
  executionPatch: Partial<Omit<z.input<typeof ProjectSnapshotSchema>["execution"], "revision">> = {}
): z.infer<typeof ProjectSnapshotSchema> {
  const data = {
    ...snapshot,
    messages: chatMessagesFromSnapshot(snapshot)
  } as unknown as Record<string, unknown>;
  return ProjectSnapshotSchema.parse({
    projectId: snapshot.project.id,
    revision: projectRevision,
    execution: {
      status: snapshot.project.status,
      currentStep: snapshot.project.currentStep,
      ...executionPatch,
      revision: projectRevision
    },
    updatedAt: snapshot.project.updatedAt,
    data
  });
}

export function chatMessagesFromSnapshot(snapshot: Pick<ResearchSnapshot, "artifacts" | "sessions">): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const artifact of snapshot.artifacts) {
    if (artifact.category !== "conversation_memo") continue;
    const path = artifact.relativePath.replace(/\\/g, "/");
    const session = snapshot.sessions.find((candidate) => path.includes(`/chat/${candidate.id}-`));
    if (!session) continue;
    const content = artifact.content?.trim() || artifact.summary.trim();
    if (!content) continue;
    messages.push(
      ChatMessageSchema.parse({
        id: artifact.id,
        projectId: artifact.projectId,
        sessionId: session.id,
        role: path.endsWith("-assistant.md") ? "assistant" : "user",
        content,
        createdAt: artifact.createdAt
      })
    );
  }
  return messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}
