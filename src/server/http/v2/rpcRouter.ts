import { randomUUID } from "node:crypto";
import { API_V2_METHODS, ApiV2RpcRequestSchema, type ApiV2RpcRequest } from "../../../contracts/api-v2/rpc.js";
import { RpcRequestV2Schema } from "../../../contracts/api-v2/common.js";
import type { JobKind } from "../../../contracts/api-v2/jobs.js";
import { authorizeJobCapabilities, defaultJobCapabilityPolicy, type CapabilityPolicy } from "../../../core/application/capabilities/index.js";
import type { StorageCapabilityAudit } from "../../runtime/storage/v2/types.js";
import { canonicalResearchStartPayload } from "../../composition/canonicalResearchEnqueue.js";
import { durablePublicJobRequestHash } from "../../composition/durableJobRequestHash.js";
import type { DurableJobReceipt } from "../../composition/durableJobTypes.js";
import type { RpcHandlerContext } from "./context.js";
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
import { emitProjectSnapshotChanged } from "./eventEmitters.js";
import {
  mapRpcV2Error,
  requestIdFromBody,
  RpcCapabilityDeniedError,
  RpcConflictError,
  RpcNotFoundError,
  RpcNotReadyError,
  RpcV2Error,
  RpcValidationError
} from "./rpcErrors.js";
import { validateSourcePolicy } from "./rpcSourcePolicy.js";

export { RpcCapabilityDeniedError, RpcConflictError, RpcNotFoundError, RpcNotReadyError, RpcV2Error, RpcValidationError } from "./rpcErrors.js";

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
    throw mapRpcV2Error(error, parsed.data.requestId);
  }
}

async function dispatch(request: ApiV2RpcRequest, context: RpcHandlerContext): Promise<unknown> {
  const { orchestrator, settingsStore, jobs, events } = context;
  switch (request.method) {
    case "projects.create": {
      const snapshot = await orchestrator.createProject({
        ...request.params.input,
        autonomyPolicy: { toolApproval: "suggested", allowAgent: true, allowExternalSearch: false, allowCodeExecution: false, maxLoopIterations: 3 }
      });
      await jobs.syncProject(snapshot.project);
      return toProjectResponse(snapshot);
    }
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
      await jobs.syncProject(snapshot.project);
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
      return idempotentEnqueue(context, request, (requestHash) =>
        enqueue(context, request.params.projectId, "chat_reply", request.params.idempotencyKey, requestHash, {
          sessionId: request.params.sessionId,
          content: request.params.content,
          clientMutationId: request.params.clientMutationId
        })
      );
    case "loop.start":
      return idempotentEnqueue(context, request, async (requestHash) => {
        const sourceAccess = await validateSourcePolicy(request.params.toolPolicy.sourceAccess);
        const toolPolicy = { ...request.params.toolPolicy, sourceAccess };
        return enqueue(
          context,
          request.params.projectId,
          "research_loop",
          request.params.idempotencyKey,
          requestHash,
          { action: "start", requestedCapabilities: request.params.requestedCapabilities, toolPolicy },
          request.params.requestedCapabilities
        );
      });
    case "loop.resume":
      return idempotentEnqueue(context, request, async (requestHash) => {
        const sourceAccess = await validateSourcePolicy(request.params.toolPolicy.sourceAccess);
        const toolPolicy = { ...request.params.toolPolicy, sourceAccess };
        return enqueue(
          context,
          request.params.projectId,
          "research_loop",
          request.params.idempotencyKey,
          requestHash,
          { action: "resume", requestedCapabilities: request.params.requestedCapabilities, toolPolicy },
          request.params.requestedCapabilities,
          request.params.interruptedJobId,
          request.params.checkpointId
        );
      });
    case "loop.pause": {
      await assertJobControlTarget(context, request.params.projectId, request.params.jobId, request.params.expectedProjectRevision);
      const job = await jobs.requestPause(request.params.jobId, request.params.expectedProjectRevision);
      await orchestrator.pause(request.params.projectId);
      return toJobResponse(job);
    }
    case "loop.abort": {
      await assertJobControlTarget(context, request.params.projectId, request.params.jobId, request.params.expectedProjectRevision);
      const job = await jobs.requestAbort(request.params.jobId, request.params.expectedProjectRevision);
      await orchestrator.abort(request.params.projectId);
      return toJobResponse(job);
    }
    case "jobs.get": {
      let job;
      try {
        job = await jobs.getDetail(request.params.jobId, request.params.tracePage);
      } catch (error) {
        if (error instanceof Error && error.name === "InvalidTraceCursorError") throw new RpcValidationError("The trace page cursor is invalid.");
        throw error;
      }
      if (!job || job.projectId !== request.params.projectId) throw new RpcNotFoundError("Job not found.");
      return toJobDetailResponse(job);
    }
    case "jobs.list": {
      const result = await jobs.list(request.params.projectId, request.params);
      return {
        jobs: result.jobs.map(toJobResponse),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {})
      };
    }
    case "engineering.preflight": {
      await assertRequestedCapabilities(context, request.params.projectId, "engineering_run", request.params.requestedCapabilities);
      const codexStatus = request.params.targets.includes("codex") && context.llm ? await context.llm.getStatus() : undefined;
      return toEngineeringPreflightResponse(request.params.projectId, request.params.targets, await settingsStore.getRuntimeSettings(), codexStatus?.sandbox);
    }
    case "engineering.enqueue":
      return idempotentEnqueue(context, request, async (requestHash) => {
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
          requestHash,
          { requests: request.params.requests, requestedCapabilities: request.params.requestedCapabilities },
          request.params.requestedCapabilities
        );
      });
    case "snapshots.get":
      return durableSnapshotResponse(context, await orchestrator.getSnapshot(request.params.projectId));
    case "settings.get":
      return toSettingsResponse(await settingsStore.getRuntimeSettings());
    case "settings.save": {
      const current = await settingsStore.getRuntimeSettings();
      return toSettingsResponse(await settingsStore.saveSettings(toSettingsSaveInput(request.params, current)));
    }
    case "tools.diagnostics": {
      const [codexStatus, settings, reliability] = await Promise.all([
        context.llm?.getStatus(),
        settingsStore.getRuntimeSettings(),
        context.jobs.operationalDiagnostics()
      ]);
      return toToolDiagnosticsResponse(settings, codexStatus, reliability);
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

async function assertJobControlTarget(context: RpcHandlerContext, projectId: string, jobId: string, expectedRevision: number): Promise<void> {
  const job = await context.jobs.get(jobId);
  if (!job || job.projectId !== projectId) throw new RpcNotFoundError("Job not found.");
  if (job.projectRevision !== expectedRevision) throw new RpcConflictError("Project revision changed.");
}

async function durableSnapshotResponse(context: RpcHandlerContext, snapshot: Awaited<ReturnType<RpcHandlerContext["orchestrator"]["getSnapshot"]>>) {
  const { job, checkpoint } = await context.jobs.latestProjectExecution(snapshot.project.id, "research_loop");
  if (!job) return toSnapshotResponse(snapshot);
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
  requestHash: string,
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
    await context.jobs.recordCapabilityAudits(toStorageAudits(authorization.audits), snapshot.project);
    const denied = authorization.requiredCapabilityKinds.filter((capability) => !authorization.decisions[capability].allowed);
    throw new RpcCapabilityDeniedError(`Required capabilities are denied: ${denied.join(", ")}.`, { denied });
  }
  const effectiveCapabilities = {
    agent: authorization.decisions.agent.allowed,
    engineering: authorization.decisions.engineering.allowed,
    search: authorization.decisions.search.allowed
  };
  const toolPolicy =
    kind === "research_loop" && payload && typeof payload === "object" && "toolPolicy" in payload
      ? (payload as { toolPolicy: NonNullable<Parameters<typeof context.jobs.enqueue>[0]["toolPolicy"]> }).toolPolicy
      : undefined;
  const persistedPayload =
    kind === "research_loop" && payload && typeof payload === "object" && (payload as { action?: unknown }).action === "start" && toolPolicy
      ? canonicalResearchStartPayload({
          snapshot,
          payload: payload as Record<string, unknown>,
          requestedCapabilities: requestedPolicy,
          effectiveCapabilities,
          toolPolicy
        })
      : payload;
  const jobId = randomUUID();
  const capabilityAudits = toStorageAudits(authorization.audits, jobId);
  const receipt = await context.jobs.enqueue({
    jobId,
    projectId,
    project: snapshot.project,
    kind,
    projectRevision: computeProjectRevision(snapshot),
    currentStep: snapshot.project.currentStep,
    idempotencyKey,
    requestHash,
    requestedCapabilities: requestedPolicy,
    effectiveCapabilities,
    capabilityAudits,
    ...(toolPolicy ? { toolPolicy } : {}),
    resumesJobId,
    resumeCheckpointId,
    payload: persistedPayload
  });
  return receipt;
}

type EnqueueRpcRequest = Extract<ApiV2RpcRequest, { method: "chat.enqueue" | "loop.start" | "loop.resume" | "engineering.enqueue" }>;

async function idempotentEnqueue(
  context: RpcHandlerContext,
  request: EnqueueRpcRequest,
  create: (requestHash: string) => Promise<DurableJobReceipt>
): Promise<DurableJobReceipt> {
  const requestHash = durablePublicJobRequestHash(request);
  const existing = await context.jobs.findIdempotentReceipt(request.params.projectId, request.params.idempotencyKey, requestHash);
  return existing ?? create(requestHash);
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
  await context.jobs.recordCapabilityAudits(toStorageAudits(authorization.audits), snapshot.project);
  if (!authorization.allowed) {
    const denied = authorization.requiredCapabilityKinds.filter((capability) => !authorization.decisions[capability].allowed);
    throw new RpcCapabilityDeniedError(`Required capabilities are denied: ${denied.join(", ")}.`, { denied });
  }
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
