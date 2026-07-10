import { randomUUID } from "node:crypto";
import { API_V2_METHODS, ApiV2RpcRequestSchema, type ApiV2RpcRequest } from "../../../contracts/api-v2/rpc.js";
import { RpcRequestV2Schema, type RpcErrorCode } from "../../../contracts/api-v2/common.js";
import type { JobKind } from "../../../contracts/api-v2/jobs.js";
import { authorizeJobCapabilities, defaultJobCapabilityPolicy, type CapabilityPolicy } from "../../../core/application/capabilities/index.js";
import type { StorageCapabilityAudit } from "../../runtime/storage/v2/types.js";
import type { RpcHandlerContext } from "./context.js";
import {
  computeProjectRevision,
  projectCapabilities,
  toCodexAuthStatusResponse,
  toEngineeringPreflightResponse,
  toLlmStatusResponse,
  toProjectResponse,
  toProjectSummary,
  toSessionResponse,
  toSettingsResponse,
  toSettingsSaveInput,
  toSnapshotResponse,
  toToolDiagnosticsResponse
} from "./common.js";
import { emitProjectSnapshotChanged, emitRunStatusChanged } from "./eventEmitters.js";

export async function handleRpcV2(body: unknown, context: RpcHandlerContext): Promise<{ requestId: string; result: unknown }> {
  const envelope = RpcRequestV2Schema.safeParse(body);
  if (envelope.success && !API_V2_METHODS.some((method) => method === envelope.data.method)) {
    throw new RpcV2Error(404, envelope.data.requestId, "METHOD_NOT_FOUND", `RPC method ${envelope.data.method} was not found.`);
  }
  const parsed = ApiV2RpcRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new RpcV2Error(400, requestIdFromBody(body), "VALIDATION_ERROR", "RPC request validation failed.", {
      issues: parsed.error.issues
    });
  }
  try {
    return { requestId: parsed.data.requestId, result: await dispatch(parsed.data, context) };
  } catch (error) {
    if (error instanceof RpcConflictError) {
      throw new RpcV2Error(409, parsed.data.requestId, "CONFLICT", error.message, undefined, error);
    }
    if (error instanceof RpcNotFoundError) {
      throw new RpcV2Error(404, parsed.data.requestId, "NOT_FOUND", error.message, undefined, error);
    }
    if (error instanceof RpcCapabilityDeniedError) {
      throw new RpcV2Error(403, parsed.data.requestId, "CAPABILITY_DENIED", error.message, error.details, error);
    }
    if (error instanceof RpcNotReadyError) {
      throw new RpcV2Error(503, parsed.data.requestId, "NOT_READY", error.message, error.details, error);
    }
    if (error instanceof RpcV2Error) throw error;
    const message = error instanceof Error ? error.message : "The RPC method could not be completed.";
    throw new RpcV2Error(500, parsed.data.requestId, "INTERNAL_ERROR", message, undefined, error);
  }
}

async function dispatch(request: ApiV2RpcRequest, context: RpcHandlerContext): Promise<unknown> {
  const { orchestrator, settingsStore, jobs, events } = context;
  switch (request.method) {
    case "projects.create":
      return toProjectResponse(
        await orchestrator.createProject({
          ...request.params.input,
          autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: false, allowCodeExecution: false, maxLoopIterations: 3 }
        })
      );
    case "projects.get":
      return toProjectResponse(await orchestrator.getSnapshot(request.params.projectId));
    case "projects.list":
      return Promise.all((await orchestrator.listProjects()).map(async (project) => toProjectSummary(await orchestrator.getSnapshot(project.id))));
    case "projects.update": {
      const current = await orchestrator.getSnapshot(request.params.projectId);
      if (computeProjectRevision(current) !== request.params.expectedRevision) throw new RpcConflictError("Project revision changed.");
      const input = {
        goal: current.project.goal,
        topic: current.project.topic,
        scope: current.project.scope,
        budget: current.project.budget,
        autonomyPolicy: {
          ...current.project.autonomyPolicy,
          allowCodeExecution: request.params.capabilities?.engineering ?? current.project.autonomyPolicy.allowCodeExecution,
          allowExternalSearch: request.params.capabilities?.search ?? current.project.autonomyPolicy.allowExternalSearch
        },
        ...request.params.input
      };
      const snapshot = await orchestrator.updateProjectInput(request.params.projectId, input);
      await emitProjectSnapshotChanged(events, snapshot, "project_updated");
      return toProjectResponse(snapshot);
    }
    case "sessions.create": {
      const before = await orchestrator.getSnapshot(request.params.projectId);
      const snapshot = await orchestrator.createChatSession(request.params.projectId, request.params.title, request.params.focus);
      const ids = new Set(before.sessions.map((item) => item.id));
      const session = snapshot.sessions.find((item) => !ids.has(item.id));
      if (!session) throw new Error("Session was not created.");
      return toSessionResponse(session);
    }
    case "sessions.delete": {
      await orchestrator.deleteChatSession(request.params.projectId, request.params.sessionId);
      return { deleted: true };
    }
    case "chat.enqueue":
      return enqueue(context, request.params.projectId, "chat_reply", request.params.idempotencyKey, {
        sessionId: request.params.sessionId,
        content: request.params.content,
        clientMutationId: request.params.clientMutationId
      });
    case "loop.start":
      return enqueue(context, request.params.projectId, "research_loop", request.params.idempotencyKey, { action: "start" });
    case "loop.resume":
      return enqueue(
        context,
        request.params.projectId,
        "research_loop",
        request.params.idempotencyKey,
        { action: "resume" },
        undefined,
        request.params.interruptedJobId,
        request.params.checkpointId
      );
    case "loop.pause": {
      const before = await jobs.get(request.params.jobId);
      await orchestrator.pause(request.params.projectId);
      const job = await jobs.requestPause(request.params.jobId);
      await emitRunStatusChanged(events, job.projectId, job.projectRevision, job.id, job.status, before?.status);
      return job;
    }
    case "loop.abort": {
      const before = await jobs.get(request.params.jobId);
      await orchestrator.abort(request.params.projectId);
      const job = await jobs.requestAbort(request.params.jobId);
      await emitRunStatusChanged(events, job.projectId, job.projectRevision, job.id, job.status, before?.status);
      return job;
    }
    case "jobs.get": {
      const job = await jobs.get(request.params.jobId);
      if (!job || job.projectId !== request.params.projectId) throw new RpcNotFoundError("Job not found.");
      return job;
    }
    case "jobs.list":
      return jobs.list(request.params.projectId, request.params);
    case "engineering.preflight":
      return toEngineeringPreflightResponse(request.params.projectId, request.params.targets, await settingsStore.getRuntimeSettings());
    case "engineering.enqueue": {
      const runtimeSettings = await settingsStore.getRuntimeSettings();
      const preflight = toEngineeringPreflightResponse(
        request.params.projectId,
        request.params.requests.map((item) => item.target),
        runtimeSettings
      );
      if (!preflight.ready) throw new RpcNotReadyError("One or more engineering adapters are not ready.", { targets: preflight.targets });
      return enqueue(
        context,
        request.params.projectId,
        "engineering_run",
        request.params.idempotencyKey,
        { requests: request.params.requests },
        request.params.capabilities
      );
    }
    case "snapshots.get":
      return toSnapshotResponse(await orchestrator.getSnapshot(request.params.projectId));
    case "settings.get":
      return toSettingsResponse(await settingsStore.getRuntimeSettings());
    case "settings.save": {
      const current = await settingsStore.getRuntimeSettings();
      return toSettingsResponse(await settingsStore.saveSettings(toSettingsSaveInput(request.params, current)));
    }
    case "tools.diagnostics":
      return toToolDiagnosticsResponse(await settingsStore.getRuntimeSettings());
    case "auth.codexStatus":
      return toCodexAuthStatusResponse(Boolean(context.llm && (await context.llm.getStatus()).authenticated));
    case "llm.status": {
      const providerStatus = context.llm
        ? await context.llm.getStatus()
        : { authenticated: false, cliAvailable: false, catalog: "supported" as const, access: "not_checked" as const };
      return toLlmStatusResponse(await settingsStore.getRuntimeSettings(), providerStatus);
    }
  }
}

async function enqueue(
  context: RpcHandlerContext,
  projectId: string,
  kind: JobKind,
  idempotencyKey: string,
  payload: unknown,
  requestedCapabilities?: Partial<CapabilityPolicy>,
  resumesJobId?: string,
  resumeCheckpointId?: string
) {
  const snapshot = await context.orchestrator.getSnapshot(projectId);
  const settings = await context.settingsStore.getRuntimeSettings();
  const authorization = authorizeJobCapabilities({
    app: { agent: Boolean(settings.openCode.enabled), engineering: Boolean(settings.allowCodeExecution), search: Boolean(settings.allowExternalSearch) },
    project: projectCapabilities(snapshot.project),
    jobKind: kind,
    job: requestedCapabilities ?? defaultJobCapabilityPolicy(kind),
    projectId,
    recordedAt: new Date().toISOString()
  });
  if (!authorization.allowed) {
    await context.jobs.recordCapabilityAudits(toStorageAudits(authorization.audits));
    const denied = authorization.requiredCapabilityKinds.filter((capability) => !authorization.decisions[capability].allowed);
    throw new RpcCapabilityDeniedError(`Required capabilities are denied: ${denied.join(", ")}.`, { denied });
  }
  const receipt = await context.jobs.enqueue({
    projectId,
    kind,
    projectRevision: computeProjectRevision(snapshot),
    currentStep: snapshot.project.currentStep,
    idempotencyKey,
    resumesJobId,
    resumeCheckpointId,
    payload
  });
  await context.jobs.recordCapabilityAudits(toStorageAudits(authorization.audits, receipt.jobId));
  return receipt;
}

export class RpcConflictError extends Error {}
export class RpcNotFoundError extends Error {}
export class RpcCapabilityDeniedError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}
export class RpcNotReadyError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export class RpcV2Error extends Error {
  constructor(
    readonly status: number,
    readonly requestId: string,
    readonly code: RpcErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RpcV2Error";
  }
}

function requestIdFromBody(body: unknown): string {
  if (body && typeof body === "object" && "requestId" in body) {
    const requestId = (body as { requestId?: unknown }).requestId;
    if (typeof requestId === "string" && requestId.trim()) return requestId.trim().slice(0, 256);
  }
  return "invalid-request";
}

function toStorageAudits(audits: ReturnType<typeof authorizeJobCapabilities>["audits"], jobId?: string): StorageCapabilityAudit[] {
  return audits.map((audit) => ({
    id: randomUUID(),
    projectId: audit.projectId,
    jobId,
    operation: audit.kind,
    capability: audit.kind,
    appAllowed: audit.appAllowed,
    projectAllowed: audit.projectAllowed,
    operationAllowed: audit.jobAllowed,
    allowed: audit.allowed,
    reason: audit.reason,
    data: { jobKind: audit.jobKind, blockedBy: audit.blockedBy },
    auditedAt: audit.recordedAt
  }));
}
