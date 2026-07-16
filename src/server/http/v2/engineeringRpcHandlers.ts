import { randomUUID } from "node:crypto";
import type { ApiV2RpcRequest } from "../../../contracts/api-v2/rpc.js";
import {
  EngineeringArtifactReadResponseSchema,
  EngineeringBaselineActivateResponseSchema,
  EngineeringBaselineListResponseSchema,
  EngineeringConfigurationBaselineSchema,
  EngineeringJobReceiptSchema,
  EngineeringPreflightResponseSchema
} from "../../../contracts/api-v2/engineering.js";
import type { ConfigurationBaseline } from "../../../core/aerospace/configurationBaseline.js";
import { validateEngineeringPromotionReadiness, type EngineeringBaselineTarget } from "../../../core/aerospace/engineeringBaselineCompatibility.js";
import { REQUIRED_CODEX_CLI_VERSION } from "../../runtime/codex/bundledCodexCli.js";
import { BUNDLED_WEBXFOIL_VERSION } from "../../runtime/engineering/engineeringRuntimeVersions.js";
import { configurationBaselineContentHash } from "../../runtime/storage/v2/engineeringBaselineIntegrity.js";
import type { RpcHandlerContext } from "./context.js";
import { toEngineeringPreflightResponse } from "./common.js";
import { RpcCapabilityDeniedError, RpcNotFoundError, RpcNotReadyError } from "./rpcErrors.js";
import { assertRequestedCapabilities, authorizeRequestedCapabilities, enqueueRpcJob, idempotentRpcEnqueue } from "./rpcJobOperations.js";

type EngineeringRpcRequest = Extract<ApiV2RpcRequest, { method: `engineering.${string}` }>;

export async function handleEngineeringRpc(request: EngineeringRpcRequest, context: RpcHandlerContext): Promise<unknown> {
  const { jobs, orchestrator, settingsStore } = context;
  switch (request.method) {
    case "engineering.baseline.activate": {
      return context.capabilityMutations.runExclusive(async () => {
        const authorization = await authorizeRequestedCapabilities(context, request.params.projectId, "engineering_run", {
          agent: true,
          engineering: true,
          search: false
        });
        if (!authorization.allowed) {
          await jobs.recordCapabilityAudits(authorization.audits, authorization.project);
          throw new RpcCapabilityDeniedError(`Required capabilities are denied: ${authorization.denied.join(", ")}.`, {
            denied: authorization.denied
          });
        }
        const createdAt = new Date().toISOString();
        const unhashed: ConfigurationBaseline = {
          ...request.params.baseline,
          id: randomUUID(),
          projectId: request.params.projectId,
          revision: request.params.expectedRevision + 1,
          status: "active",
          contentHash: "0".repeat(64),
          createdAt
        };
        const baseline = { ...unhashed, contentHash: configurationBaselineContentHash(unhashed) };
        return EngineeringBaselineActivateResponseSchema.parse(
          await jobs.engineering.activateBaseline(
            {
              baseline,
              expectedRevision: request.params.expectedRevision,
              changeReason: request.params.changeReason
            },
            {
              projectRevision: authorization.projectRevision,
              snapshotVersion: authorization.projectRevision,
              capabilityAudits: authorization.audits
            }
          )
        );
      });
    }
    case "engineering.baseline.get": {
      context.projectMutations.assertReadable(request.params.projectId);
      await orchestrator.getSnapshot(request.params.projectId);
      const baseline = request.params.baselineId
        ? await jobs.engineering.getBaseline(request.params.projectId, request.params.baselineId)
        : await jobs.engineering.activeBaseline(request.params.projectId);
      if (!baseline) throw new RpcNotFoundError("Engineering configuration baseline not found.");
      return EngineeringConfigurationBaselineSchema.parse(baseline);
    }
    case "engineering.baseline.list":
      context.projectMutations.assertReadable(request.params.projectId);
      await orchestrator.getSnapshot(request.params.projectId);
      return EngineeringBaselineListResponseSchema.parse({
        baselines: await jobs.engineering.listBaselines(request.params.projectId, request.params.limit)
      });
    case "engineering.artifact.read": {
      context.projectMutations.assertReadable(request.params.projectId);
      await orchestrator.getSnapshot(request.params.projectId);
      const readback = await jobs.engineering.readArtifact(request.params);
      return EngineeringArtifactReadResponseSchema.parse({
        promotionId: readback.promotion.id,
        artifactUri: readback.artifactUri,
        sha256: readback.promotion.artifact.sha256,
        byteLength: readback.promotion.artifact.byteLength,
        mediaType: readback.promotion.artifact.mediaType,
        excerptBase64: readback.excerptBase64,
        excerptBytes: readback.excerptBytes,
        complete: readback.complete,
        readAt: readback.readAt,
        readReceiptHash: readback.readReceiptHash,
        baselineId: readback.promotion.baselineId,
        baselineRevision: readback.promotion.baselineRevision
      });
    }
    case "engineering.preflight": {
      await assertRequestedCapabilities(context, request.params.projectId, "engineering_run", request.params.requestedCapabilities);
      const baseline = await jobs.engineering.activeBaseline(request.params.projectId);
      const codexBaselineReady = baseline && validateEngineeringPromotionReadiness("codex", baseline, pinnedRuntimeVersion("codex")).ready;
      const codexStatus = request.params.targets.includes("codex") && codexBaselineReady && context.llm ? await context.llm.getStatus() : undefined;
      const response = toEngineeringPreflightResponse(
        request.params.projectId,
        request.params.targets,
        await settingsStore.getRuntimeSettings(),
        codexStatus?.sandbox
      );
      return EngineeringPreflightResponseSchema.parse(withBaselinePreflight(response, baseline));
    }
    case "engineering.enqueue": {
      const receipt = await idempotentRpcEnqueue(context, request, async (requestHash) => {
        context.projectMutations.assertReadable(request.params.projectId);
        const baseline = await jobs.engineering.activeBaseline(request.params.projectId);
        if (!baseline) throw new RpcNotReadyError("Engineering execution requires an active persisted configuration baseline.");
        const baselineAssessments = request.params.requests.map((item) =>
          validateEngineeringPromotionReadiness(item.target, baseline, pinnedRuntimeVersion(item.target))
        );
        const incompatible = baselineAssessments.filter((item) => !item.ready);
        if (incompatible.length) {
          throw new RpcNotReadyError("The active configuration baseline is incomplete for one or more requested targets.", {
            targets: incompatible.map((item) => ({ target: item.target, reason: item.reason, missingAspects: item.missingAspects }))
          });
        }
        const runtimeSettings = await settingsStore.getRuntimeSettings();
        const preflight = toEngineeringPreflightResponse(
          request.params.projectId,
          request.params.requests.map((item) => item.target),
          runtimeSettings,
          request.params.requests.some((item) => item.target === "codex") && context.llm ? (await context.llm.getStatus()).sandbox : undefined
        );
        if (!preflight.ready) throw new RpcNotReadyError("One or more engineering adapters are not ready.", { targets: preflight.targets });
        return enqueueRpcJob(
          context,
          request.params.projectId,
          "engineering_run",
          request.params.idempotencyKey,
          requestHash,
          {
            requests: request.params.requests,
            requestedCapabilities: request.params.requestedCapabilities,
            configurationBaseline: { id: baseline.id, revision: baseline.revision, contentHash: baseline.contentHash }
          },
          request.params.requestedCapabilities
        );
      });
      return EngineeringJobReceiptSchema.parse(receipt);
    }
  }
}

function withBaselinePreflight(
  response: ReturnType<typeof toEngineeringPreflightResponse>,
  baseline: ConfigurationBaseline | undefined
): ReturnType<typeof toEngineeringPreflightResponse> {
  const targets = response.targets.map((target) => {
    if (!baseline) return { ...target, ready: false, reason: "An active persisted configuration baseline is required." };
    const assessment = validateEngineeringPromotionReadiness(target.target, baseline, pinnedRuntimeVersion(target.target));
    if (!assessment.ready) return { ...target, ready: false, reason: assessment.reason };
    return target;
  });
  return { ...response, ready: targets.every((target) => target.ready), targets };
}

function pinnedRuntimeVersion(target: EngineeringBaselineTarget): string | undefined {
  if (target === "webxfoil") return BUNDLED_WEBXFOIL_VERSION;
  if (target === "codex") return REQUIRED_CODEX_CLI_VERSION;
  return undefined;
}
