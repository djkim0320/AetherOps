import { API_V2_METHODS, ApiV2RpcRequestSchema, type ApiV2RpcRequest } from "../../../contracts/api-v2/rpc.js";
import { RpcRequestV2Schema } from "../../../contracts/api-v2/common.js";
import type { RpcHandlerContext } from "./context.js";
import {
  toCodexAuthStatusResponse,
  toLlmStatusResponse,
  toJobDetailResponse,
  toJobResponse,
  toSettingsResponse,
  toSettingsSaveInput,
  toToolDiagnosticsResponse
} from "./common.js";
import { toProjectResponse, toProjectSummary, toSnapshotResponse } from "./projectResponses.js";
import { assertStoredProjectRevision } from "./projectRevision.js";
import { mapRpcV2Error, requestIdFromBody, RpcNotFoundError, RpcV2Error, RpcValidationError } from "./rpcErrors.js";
import { validateSourcePolicy } from "./rpcSourcePolicy.js";
import { handleEngineeringRpc } from "./engineeringRpcHandlers.js";
import { enqueueRpcJob, idempotentRpcEnqueue } from "./rpcJobOperations.js";

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
  const { orchestrator, projectMutations, settingsStore, jobs } = context;
  switch (request.method) {
    case "projects.create":
      return projectMutations.create(request.requestId, request.params.input);
    case "projects.get": {
      const { snapshot, projectRevision } = await projectMutations.readSnapshot(request.params.projectId);
      return toProjectResponse(snapshot, projectRevision);
    }
    case "projects.list": {
      projectMutations.assertAllReadable();
      const projects = await orchestrator.listProjects();
      return Promise.all(
        projects.map(async (project) => {
          const { snapshot, projectRevision } = await projectMutations.readSnapshot(project.id);
          return toProjectSummary(snapshot, projectRevision);
        })
      );
    }
    case "projects.update":
      return projectMutations.update(
        request.requestId,
        request.params.projectId,
        request.params.expectedRevision,
        request.params.input,
        request.params.capabilities
      );
    case "sessions.create":
      return projectMutations.createSession(request.requestId, request.params.projectId, request.params.title, request.params.focus);
    case "sessions.delete":
      return projectMutations.deleteSession(request.requestId, request.params.projectId, request.params.sessionId);
    case "chat.enqueue":
      return idempotentRpcEnqueue(context, request, (requestHash) =>
        enqueueRpcJob(context, request.params.projectId, "chat_reply", request.params.idempotencyKey, requestHash, {
          sessionId: request.params.sessionId,
          content: request.params.content,
          clientMutationId: request.params.clientMutationId
        })
      );
    case "loop.start":
      return idempotentRpcEnqueue(context, request, async (requestHash) => {
        const sourceAccess = await validateSourcePolicy(request.params.toolPolicy.sourceAccess);
        const toolPolicy = { ...request.params.toolPolicy, sourceAccess };
        return enqueueRpcJob(
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
      return idempotentRpcEnqueue(context, request, async (requestHash) => {
        const sourceAccess = await validateSourcePolicy(request.params.toolPolicy.sourceAccess);
        const toolPolicy = { ...request.params.toolPolicy, sourceAccess };
        return enqueueRpcJob(
          context,
          request.params.projectId,
          "research_loop",
          request.params.idempotencyKey,
          requestHash,
          { action: "resume", requestedCapabilities: request.params.requestedCapabilities, toolPolicy },
          request.params.requestedCapabilities,
          request.params.interruptedJobId,
          request.params.checkpointId,
          request.params.expectedProjectRevision
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
    case "engineering.baseline.activate":
    case "engineering.baseline.get":
    case "engineering.baseline.list":
    case "engineering.artifact.read":
    case "engineering.preflight":
    case "engineering.enqueue":
      return handleEngineeringRpc(request, context);
    case "snapshots.get": {
      const { snapshot, projectRevision } = await projectMutations.readSnapshot(request.params.projectId);
      return durableSnapshotResponse(context, snapshot, projectRevision);
    }
    case "settings.get":
      return toSettingsResponse(await settingsStore.getRuntimeSettings());
    case "settings.save": {
      return context.capabilityMutations.runExclusive(async () => {
        const current = await settingsStore.getRuntimeSettings();
        return toSettingsResponse(await settingsStore.saveSettings(toSettingsSaveInput(request.params, current)));
      });
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
  await assertStoredProjectRevision(context.jobs, projectId, expectedRevision);
}

async function durableSnapshotResponse(
  context: RpcHandlerContext,
  snapshot: Awaited<ReturnType<RpcHandlerContext["orchestrator"]["getSnapshot"]>>,
  projectRevision: number
) {
  const { job, checkpoint } = await context.jobs.latestProjectExecution(snapshot.project.id, "research_loop");
  await context.projectMutations.assertRevisionUnchanged(snapshot.project.id, projectRevision);
  if (!job) return toSnapshotResponse(snapshot, projectRevision);
  return toSnapshotResponse(snapshot, projectRevision, {
    status: job.status,
    activeJobId: job.id,
    ...(checkpoint ? { lastCheckpointId: checkpoint.id, currentStep: checkpoint.step as typeof snapshot.project.currentStep } : {})
  });
}
