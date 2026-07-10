import { z } from "zod";
import { ChatMessageSchema, JobReceiptSchema, JobSchema, type ChatMessage, type JobStatus } from "../../../contracts/api-v2/jobs.js";
import { ProjectSchema, ProjectSummarySchema, SessionSchema } from "../../../contracts/api-v2/projects.js";
import { ProjectSnapshotSchema } from "../../../contracts/api-v2/snapshots.js";
import { CapabilityGrantSchema, SettingsResponseSchema, SettingsSaveParamsSchema } from "../../../contracts/api-v2/settings.js";
import {
  CodexAuthStatusResponseSchema,
  LlmStatusResponseSchema,
  ToolsDiagnosticsResponseSchema,
  ToolDiagnosticSchema
} from "../../../contracts/api-v2/diagnostics.js";
import { EngineeringPreflightResponseSchema, EngineeringTargetSchema } from "../../../contracts/api-v2/engineering.js";
import { nowIso } from "../../../core/shared/ids.js";
import type { AetherOpsOrchestrator } from "../../../core/orchestration/orchestrator.js";
import type { AppSettings, EngineeringProgramTarget, ResearchProject, ResearchSession, ResearchSnapshot } from "../../../core/shared/types.js";
import { buildServerRuntimeToolDiagnostics as buildRuntimeToolDiagnostics } from "../../runtime/engineering/runtimeEngineeringDiagnostics.js";
import { defaultSettings as runtimeDefaultSettings, type AppSettingsStore } from "../../runtime/storage/settingsStore.js";
import type { DurableJobRuntime } from "../../composition/durableJobRuntime.js";
import type { DurableJobReceipt, DurableJobRecord } from "../../composition/durableJobTypes.js";

export {
  CapabilityGrantSchema,
  SettingsResponseSchema,
  SettingsSaveParamsSchema,
  ProjectSchema,
  ProjectSummarySchema,
  SessionSchema,
  ProjectSnapshotSchema,
  JobReceiptSchema,
  JobSchema,
  ToolsDiagnosticsResponseSchema,
  ToolDiagnosticSchema,
  CodexAuthStatusResponseSchema,
  LlmStatusResponseSchema,
  EngineeringPreflightResponseSchema,
  EngineeringTargetSchema
};

export interface RpcHandlerContext {
  appRoot: string;
  dataRoot: string;
  host: string;
  port: number;
  startedAt: string;
  version: string;
  env: NodeJS.ProcessEnv;
  llm:
    | {
        name: string;
        isAvailable(): Promise<boolean>;
        getStatus(): Promise<{
          authenticated: boolean;
          cliAvailable: boolean;
          catalog: "supported" | "unsupported";
          access: "not_checked" | "available" | "unavailable";
          message?: string;
        }>;
      }
    | undefined;
  orchestrator: AetherOpsOrchestrator;
  settingsStore: AppSettingsStore;
  events: DurableJobRuntime;
  jobs: DurableJobRuntime;
}

export function computeProjectRevision(snapshot: ResearchSnapshot): number {
  return Math.max(1, snapshot.iterations.length);
}

export function projectCapabilities(project: ResearchProject): z.infer<typeof CapabilityGrantSchema> {
  return {
    agent: true,
    engineering: Boolean(project.autonomyPolicy.allowCodeExecution),
    search: Boolean(project.autonomyPolicy.allowExternalSearch)
  };
}

export function toProjectSummary(snapshot: ResearchSnapshot): z.infer<typeof ProjectSummarySchema> {
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
      revision: computeProjectRevision(snapshot)
    },
    createdAt: snapshot.project.createdAt,
    updatedAt: snapshot.project.updatedAt
  });
}

export function toProjectResponse(snapshot: ResearchSnapshot): z.infer<typeof ProjectSchema> {
  return ProjectSchema.parse(toProjectSummary(snapshot));
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

export function toSnapshotResponse(snapshot: ResearchSnapshot): z.infer<typeof ProjectSnapshotSchema> {
  const data = {
    ...snapshot,
    messages: chatMessagesFromSnapshot(snapshot)
  } as unknown as Record<string, unknown>;
  return ProjectSnapshotSchema.parse({
    projectId: snapshot.project.id,
    revision: computeProjectRevision(snapshot),
    execution: {
      status: snapshot.project.status,
      currentStep: snapshot.project.currentStep,
      revision: computeProjectRevision(snapshot)
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

export function toSettingsResponse(settings: AppSettings): z.infer<typeof SettingsResponseSchema> {
  return SettingsResponseSchema.parse({
    codex: {
      model: settings.openCodeLlm.model,
      reasoningEffort: settings.openCodeLlm.reasoningEffort,
      timeoutMs: settings.openCodeLlm.timeoutMs
    },
    embedding: {
      provider: settings.embedding.provider,
      model: settings.embedding.model,
      baseUrl: settings.embedding.baseUrl,
      dimensions: settings.embedding.dimensions,
      apiKeyConfigured: Boolean(settings.embedding.apiKey || settings.embedding.apiKeyConfigured)
    },
    search: {
      provider: settings.webSearch.provider,
      endpoint: settings.webSearch.endpoint,
      timeoutMs: settings.webSearch.timeoutMs ?? runtimeDefaultSettings.webSearch.timeoutMs ?? 10_000,
      apiKeyConfigured: Boolean(settings.webSearch.apiKey || settings.webSearch.apiKeyConfigured)
    },
    capabilities: {
      agent: Boolean(settings.openCode.enabled),
      engineering: Boolean(settings.allowCodeExecution),
      search: Boolean(settings.allowExternalSearch)
    },
    updatedAt: settings.updatedAt
  });
}

export function toSettingsSaveInput(params: z.input<typeof SettingsSaveParamsSchema>, current: AppSettings): AppSettings {
  const parsed = SettingsSaveParamsSchema.parse(params);
  return {
    ...current,
    openCodeLlm: {
      source: "codex-oauth",
      model: parsed.codex.model,
      reasoningEffort: parsed.codex.reasoningEffort,
      timeoutMs: parsed.codex.timeoutMs
    },
    openCode: {
      ...current.openCode,
      enabled: parsed.capabilities.agent
    },
    webSearch: {
      ...current.webSearch,
      provider: parsed.search.provider,
      endpoint: parsed.search.endpoint,
      timeoutMs: parsed.search.timeoutMs,
      apiKey: parsed.search.apiKey ?? undefined
    },
    embedding: {
      ...current.embedding,
      provider: parsed.embedding.provider,
      model: parsed.embedding.model,
      baseUrl: parsed.embedding.baseUrl,
      dimensions: parsed.embedding.dimensions,
      apiKey: parsed.embedding.apiKey ?? undefined
    },
    engineeringTools: {
      ...current.engineeringTools,
      enabled: parsed.capabilities.engineering
    },
    allowExternalSearch: parsed.capabilities.search,
    allowCodeExecution: parsed.capabilities.engineering,
    updatedAt: nowIso()
  };
}

export function toToolDiagnosticsResponse(settings: AppSettings): z.infer<typeof ToolsDiagnosticsResponseSchema> {
  const diagnostics = buildRuntimeToolDiagnostics(settings);
  const tools = [
    {
      name: "SettingsStore",
      category: "storage",
      status: "ready" as const
    },
    {
      name: "ResearchSnapshotStore",
      category: "storage",
      status: "ready" as const
    },
    ...diagnostics.executableTools.slice(0, 8).map((name) => ({
      name,
      category: classifyTool(name),
      status: "ready" as const
    })),
    ...diagnostics.blockers.slice(0, 8).map((blocker) => ({
      name: blocker.key,
      category: classifyBlocker(blocker.key),
      status: "blocked" as const,
      reason: blocker.message
    }))
  ];
  return ToolsDiagnosticsResponseSchema.parse({
    capabilities: {
      agent: Boolean(settings.openCode.enabled),
      engineering: Boolean(settings.allowCodeExecution),
      search: Boolean(settings.allowExternalSearch)
    },
    tools,
    generatedAt: diagnostics.generatedAt
  });
}

export function toLlmStatusResponse(
  settings: AppSettings,
  providerStatus: {
    authenticated: boolean;
    cliAvailable: boolean;
    catalog: "supported" | "unsupported";
    access: "not_checked" | "available" | "unavailable";
    message?: string;
  }
): z.infer<typeof LlmStatusResponseSchema> {
  const locallyReady = providerStatus.authenticated && providerStatus.cliAvailable;
  const blocked = providerStatus.catalog === "unsupported" || providerStatus.access === "unavailable";
  return LlmStatusResponseSchema.parse({
    provider: "codex-oauth",
    model: settings.openCodeLlm.model,
    reasoningEffort: settings.openCodeLlm.reasoningEffort,
    catalog: providerStatus.catalog,
    access: providerStatus.access,
    status: blocked ? "blocked" : locallyReady ? "ready" : "not_authenticated",
    available: !blocked && locallyReady,
    message: providerStatus.message
  });
}

export function toCodexAuthStatusResponse(available: boolean, message?: string): z.infer<typeof CodexAuthStatusResponseSchema> {
  return CodexAuthStatusResponseSchema.parse({
    provider: "codex-oauth",
    status: available ? "authenticated" : "unauthenticated",
    authenticated: available,
    message
  });
}

export function toEngineeringPreflightResponse(
  projectId: string,
  targets: Array<z.input<typeof EngineeringTargetSchema>>,
  settings: AppSettings
): z.infer<typeof EngineeringPreflightResponseSchema> {
  const diagnostics = buildRuntimeToolDiagnostics(settings);
  const capabilityByTarget = new Map(diagnostics.engineeringPrograms.map((item) => [item.target, item]));
  const resolvedTargets = targets.map((target) => {
    const runtimeTarget: EngineeringProgramTarget = target === "webxfoil" ? "xfoil-wasm" : target === "mesh" ? "modeling" : target;
    const capability = capabilityByTarget.get(runtimeTarget);
    return {
      target,
      ready: Boolean(capability?.ready),
      reason: capability?.blockedReason
    };
  });
  return EngineeringPreflightResponseSchema.parse({
    projectId,
    ready: resolvedTargets.every((target) => target.ready),
    capabilities: {
      agent: Boolean(settings.openCode.enabled),
      engineering: Boolean(settings.allowCodeExecution),
      search: Boolean(settings.allowExternalSearch)
    },
    targets: resolvedTargets,
    checkedAt: diagnostics.generatedAt
  });
}

export function mapJobStatusFromProjectStatus(status: ResearchSnapshot["project"]["status"] | string): JobStatus {
  if (status === "paused") return "paused";
  if (status === "aborted") return "aborted";
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "completed") return "completed";
  if (status === "running") return "running";
  return "queued";
}

export function toJobReceipt(job: DurableJobRecord, queuePosition = 0): DurableJobReceipt {
  return JobReceiptSchema.parse({
    jobId: job.id,
    projectId: job.projectId,
    kind: job.kind,
    status: "queued",
    queuePosition,
    acceptedAt: job.createdAt,
    projectRevision: job.projectRevision
  });
}

function classifyTool(name: string): "agent" | "engineering" | "search" | "storage" {
  if (/search|browser|fetch|research/i.test(name)) return "search";
  if (/engineer|cfd|xfoil|openvsp|xflr5|su2/i.test(name)) return "engineering";
  if (/store|snapshot|artifact|settings/i.test(name)) return "storage";
  return "agent";
}

function classifyBlocker(key: string): "agent" | "engineering" | "search" | "storage" {
  return classifyTool(key);
}
