import { randomUUID } from "node:crypto";
import { API_V2_METHODS, ApiV2RpcRequestSchema, type ApiV2RpcRequest } from "../../../contracts/api-v2/rpc.js";
import { RequestIdSchema, RpcRequestV2Schema, type RpcErrorCode } from "../../../contracts/api-v2/common.js";
import type { JobKind } from "../../../contracts/api-v2/jobs.js";
import { authorizeJobCapabilities, defaultJobCapabilityPolicy, type CapabilityPolicy } from "../../../core/application/capabilities/index.js";
import type { StorageCapabilityAudit } from "../../runtime/storage/v2/types.js";
import type { RpcHandlerContext } from "./context.js";
import { PublicUrlPolicy } from "../../runtime/tools/publicUrlPolicy.js";
import {
  computeProjectRevision,
  projectCapabilities,
  toCodexAuthStatusResponse,
  toEngineeringPreflightResponse,
  toLlmStatusResponse,
  toJobDetailResponse,
  toJobResponse,
  toProjectResponse,
  toProjectSummary,
  toSessionResponse,
  toSettingsResponse,
  toSettingsSaveInput,
  toSnapshotResponse,
  toToolDiagnosticsResponse
} from "./common.js";
import { emitProjectSnapshotChanged, emitRunStatusChanged } from "./eventEmitters.js";
import { createServerRequestId, internalErrorMessage } from "../errorBoundary.js";

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
    if (error instanceof RpcValidationError) {
      throw new RpcV2Error(400, parsed.data.requestId, "VALIDATION_ERROR", error.message, error.details, error);
    }
    if (error instanceof RpcV2Error) throw error;
    throw new RpcV2Error(500, parsed.data.requestId, "INTERNAL_ERROR", internalErrorMessage, undefined, error);
  }
}

async function dispatch(request: ApiV2RpcRequest, context: RpcHandlerContext): Promise<unknown> {
  const { orchestrator, settingsStore, jobs, events } = context;
  switch (request.method) {
    case "projects.create":
      return toProjectResponse(
        await orchestrator.createProject({
          ...request.params.input,
          autonomyPolicy: { toolApproval: "suggested", allowAgent: true, allowExternalSearch: false, allowCodeExecution: false, maxLoopIterations: 3 }
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
          allowAgent: request.params.capabilities?.agent ?? current.project.autonomyPolicy.allowAgent ?? true,
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
      await validateSourcePolicy(request.params.toolPolicy.sourceAccess);
      return enqueue(
        context,
        request.params.projectId,
        "research_loop",
        request.params.idempotencyKey,
        { action: "start", requestedCapabilities: request.params.requestedCapabilities, toolPolicy: request.params.toolPolicy },
        request.params.requestedCapabilities
      );
    case "loop.resume":
      await validateSourcePolicy(request.params.toolPolicy.sourceAccess);
      return enqueue(
        context,
        request.params.projectId,
        "research_loop",
        request.params.idempotencyKey,
        { action: "resume", requestedCapabilities: request.params.requestedCapabilities, toolPolicy: request.params.toolPolicy },
        request.params.requestedCapabilities,
        request.params.interruptedJobId,
        request.params.checkpointId
      );
    case "loop.pause": {
      const before = await jobs.get(request.params.jobId);
      await orchestrator.pause(request.params.projectId);
      const job = await jobs.requestPause(request.params.jobId);
      await emitRunStatusChanged(events, job.projectId, job.projectRevision, job.id, job.status, before?.status);
      return toJobResponse(job);
    }
    case "loop.abort": {
      const before = await jobs.get(request.params.jobId);
      await orchestrator.abort(request.params.projectId);
      const job = await jobs.requestAbort(request.params.jobId);
      await emitRunStatusChanged(events, job.projectId, job.projectRevision, job.id, job.status, before?.status);
      return toJobResponse(job);
    }
    case "jobs.get": {
      const job = await jobs.getDetail(request.params.jobId);
      if (!job || job.projectId !== request.params.projectId) throw new RpcNotFoundError("Job not found.");
      return toJobDetailResponse(job);
    }
    case "jobs.list": {
      const result = await jobs.list(request.params.projectId, request.params);
      return { jobs: result.jobs.map(toJobResponse) };
    }
    case "engineering.preflight": {
      await assertRequestedCapabilities(context, request.params.projectId, "engineering_run", request.params.requestedCapabilities);
      const codexStatus = request.params.targets.includes("codex") && context.llm ? await context.llm.getStatus() : undefined;
      return toEngineeringPreflightResponse(request.params.projectId, request.params.targets, await settingsStore.getRuntimeSettings(), codexStatus?.sandbox);
    }
    case "engineering.enqueue": {
      const runtimeSettings = await settingsStore.getRuntimeSettings();
      const preflight = toEngineeringPreflightResponse(
        request.params.projectId,
        request.params.requests.map((item) => item.target),
        runtimeSettings,
        request.params.requests.some((item) => item.target === "codex") && context.llm ? (await context.llm.getStatus()).sandbox : undefined
      );
      if (!preflight.ready) throw new RpcNotReadyError("One or more engineering adapters are not ready.", { targets: preflight.targets });
      return enqueue(
        context,
        request.params.projectId,
        "engineering_run",
        request.params.idempotencyKey,
        { requests: request.params.requests, requestedCapabilities: request.params.requestedCapabilities },
        request.params.requestedCapabilities
      );
    }
    case "snapshots.get":
      return durableSnapshotResponse(context, await orchestrator.getSnapshot(request.params.projectId));
    case "settings.get":
      return toSettingsResponse(await settingsStore.getRuntimeSettings());
    case "settings.save": {
      const current = await settingsStore.getRuntimeSettings();
      return toSettingsResponse(await settingsStore.saveSettings(toSettingsSaveInput(request.params, current)));
    }
    case "tools.diagnostics": {
      const codexStatus = context.llm ? await context.llm.getStatus() : undefined;
      return toToolDiagnosticsResponse(await settingsStore.getRuntimeSettings(), codexStatus);
    }
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

async function durableSnapshotResponse(context: RpcHandlerContext, snapshot: Awaited<ReturnType<RpcHandlerContext["orchestrator"]["getSnapshot"]>>) {
  const listed = await context.jobs.list(snapshot.project.id, { limit: 200 });
  const job = listed.jobs
    .filter((candidate) => candidate.kind === "research_loop")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];
  if (!job) return toSnapshotResponse(snapshot);
  const checkpoint = await context.jobs.latestCommittedCheckpoint(job.id);
  return toSnapshotResponse(snapshot, {
    status: job.status,
    activeJobId: job.id,
    ...(checkpoint ? { lastCheckpointId: checkpoint.id, currentStep: checkpoint.step as typeof snapshot.project.currentStep } : {}),
    revision: job.projectRevision
  });
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
  const defaultCapabilities = defaultJobCapabilityPolicy(kind);
  const requestedPolicy = {
    agent: requestedCapabilities?.agent ?? defaultCapabilities.agent,
    engineering: requestedCapabilities?.engineering ?? defaultCapabilities.engineering,
    search: requestedCapabilities?.search ?? defaultCapabilities.search
  };
  const authorization = authorizeJobCapabilities({
    app: { agent: settings.allowAgent, engineering: Boolean(settings.allowCodeExecution), search: Boolean(settings.allowExternalSearch) },
    project: projectCapabilities(snapshot.project),
    jobKind: kind,
    job: requestedPolicy,
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
    requestedCapabilities: requestedPolicy,
    effectiveCapabilities: {
      agent: authorization.decisions.agent.allowed,
      engineering: authorization.decisions.engineering.allowed,
      search: authorization.decisions.search.allowed
    },
    ...(kind === "research_loop" && payload && typeof payload === "object" && "toolPolicy" in payload
      ? { toolPolicy: (payload as { toolPolicy: NonNullable<Parameters<typeof context.jobs.enqueue>[0]["toolPolicy"]> }).toolPolicy }
      : {}),
    resumesJobId,
    resumeCheckpointId,
    payload
  });
  await context.jobs.recordCapabilityAudits(toStorageAudits(authorization.audits, receipt.jobId));
  return receipt;
}

async function assertRequestedCapabilities(
  context: RpcHandlerContext,
  projectId: string,
  kind: JobKind,
  requestedCapabilities: CapabilityPolicy
): Promise<void> {
  const snapshot = await context.orchestrator.getSnapshot(projectId);
  const settings = await context.settingsStore.getRuntimeSettings();
  const authorization = authorizeJobCapabilities({
    app: { agent: settings.allowAgent, engineering: settings.allowCodeExecution, search: settings.allowExternalSearch },
    project: projectCapabilities(snapshot.project),
    jobKind: kind,
    job: requestedCapabilities,
    projectId,
    recordedAt: new Date().toISOString()
  });
  await context.jobs.recordCapabilityAudits(toStorageAudits(authorization.audits));
  if (!authorization.allowed) {
    const denied = authorization.requiredCapabilityKinds.filter((capability) => !authorization.decisions[capability].allowed);
    throw new RpcCapabilityDeniedError(`Required capabilities are denied: ${denied.join(", ")}.`, { denied });
  }
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
export class RpcValidationError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

async function validateSourcePolicy(policy: { mode: string; urls?: string[] }): Promise<void> {
  if (policy.mode !== "allowlist") return;
  const validator = new PublicUrlPolicy();
  for (const [urlIndex, url] of (policy.urls ?? []).entries()) {
    try {
      await validator.assertPublicHttpUrl(url);
    } catch (error) {
      throw new RpcValidationError("A source allowlist URL is not publicly reachable.", {
        urlIndex,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
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
    const parsed = RequestIdSchema.safeParse(requestId);
    if (parsed.success) return parsed.data;
  }
  return createServerRequestId();
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
