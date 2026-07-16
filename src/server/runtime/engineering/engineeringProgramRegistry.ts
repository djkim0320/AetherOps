import { createId, nowIso } from "../../../core/shared/ids.js";
import { runSu2Case } from "./engineeringProgramSu2Adapter.js";
import { runXfoilPolar } from "./engineeringProgramXfoilAdapter.js";
import { hasConfiguredXfoilWasm, runXfoilWasmPolar } from "./engineeringProgramWebXfoilAdapter.js";
import {
  meshSummaryArtifact,
  scriptedCfdRunArtifact,
  scriptedCfdRunEvidence,
  su2CaseRunArtifact,
  su2CaseRunEvidence,
  xfoilPolarArtifact,
  xfoilPolarEvidence,
  xfoilWasmPolarArtifact,
  xfoilWasmPolarEvidence
} from "./engineeringProgramObservationMappers.js";
import { inspectMeshArtifact } from "./engineeringProgramMeshAdapter.js";
import {
  normalizeEngineeringProgramRequests,
  normalizeEngineeringProgramTarget,
  supportedEngineeringProgramKinds
} from "./engineeringProgramRequestValidator.js";
import { runScriptedCfdAnalysis } from "./engineeringProgramScriptedCfdAdapter.js";
import type {
  AppSettings,
  EngineeringProgramPreflightResult,
  EngineeringProgramTarget,
  EvidenceItem,
  ResearchToolInput,
  ResearchArtifact,
  ToolRun
} from "../../../core/shared/types.js";
import { ResearchLoopStep } from "../../../core/shared/types.js";
import type { ResearchToolExecutionContext, ResearchToolResult } from "../../../core/tools/researchToolTypes.js";
import { engineeringProgramPromotionTarget } from "../../../core/tools/engineeringProgramTool.js";
import { RuntimeRequirementError } from "../../../core/tools/runtimeRequirements.js";
import { bindFetchedAirfoilCoordinates } from "./airfoilCoordinateBinder.js";
import { BUNDLED_WEBXFOIL_RUNTIME, BUNDLED_WEBXFOIL_VERSION } from "./engineeringRuntimeVersions.js";
import { engineeringPromotionRuntimeReceiptSupport } from "../../../core/aerospace/engineeringBaselineCompatibility.js";

export async function runEngineeringProgram(
  input: ResearchToolInput,
  settings: AppSettings,
  context?: Pick<ResearchToolExecutionContext, "signal">
): Promise<ResearchToolResult> {
  const signal = context?.signal;
  signal?.throwIfAborted();
  const startedAt = nowIso();
  let requests = normalizeEngineeringProgramRequests(input.researchPlan?.programRequests);
  const completedAt = nowIso();
  if (!requests.length) {
    return {
      toolRun: failedToolRun(
        input,
        "EngineeringProgramTool",
        startedAt,
        completedAt,
        { requestCount: 0 },
        { supportedKinds: supportedEngineeringProgramKinds() },
        "EngineeringProgramTool requires ResearchPlan.programRequests."
      ),
      evidence: [],
      artifacts: [],
      sources: []
    };
  }
  const unsupported = requests.find((request) => !engineeringPromotionRuntimeReceiptSupport(engineeringProgramPromotionTarget(request)).supported);
  if (unsupported) {
    const target = engineeringProgramPromotionTarget(unsupported);
    const message = engineeringPromotionRuntimeReceiptSupport(target).reason ?? `${target} has no durable promotion runtime receipt.`;
    throw new RuntimeRequirementError(ResearchLoopStep.ExecuteTools, [
      {
        key: `engineering.runtimeReceipt.${target}`,
        label: `${target} durable runtime receipt`,
        requiredForSteps: [ResearchLoopStep.ExecuteTools],
        isSatisfied: false,
        message
      }
    ]);
  }
  input = bindFetchedAirfoilCoordinates(input);
  requests = normalizeEngineeringProgramRequests(input.researchPlan?.programRequests);

  const outputs: unknown[] = [];
  const artifacts: ResearchArtifact[] = [];
  const evidence: EvidenceItem[] = [];
  try {
    for (const request of requests.slice(0, 4)) {
      signal?.throwIfAborted();
      if (request.kind === "toolchain-check") {
        outputs.push(await runToolchainCheck(request.target ?? "all", settings, signal));
        continue;
      }
      if (request.kind === "mesh-inspect") {
        const summary = inspectMeshArtifact(request, settings);
        outputs.push({ kind: request.kind, target: request.target ?? "modeling", summary });
        artifacts.push(meshSummaryArtifact(input, summary, completedAt));
        continue;
      }
      if (request.kind === "xfoil-polar") {
        const summary = await runXfoilPolar(request, settings, signal);
        outputs.push({ kind: request.kind, target: "xfoil", summary: { ...summary, rows: summary.rows.slice(0, 12) } });
        artifacts.push(xfoilPolarArtifact(input, summary, nowIso()));
        evidence.push(xfoilPolarEvidence(input, summary, nowIso()));
        continue;
      }
      if (request.kind === "xfoil-wasm-polar") {
        const summary = await runXfoilWasmPolar(request, settings, input, signal);
        outputs.push({ kind: request.kind, target: "xfoil-wasm", summary: { ...summary, rows: summary.rows.slice(0, 12) } });
        artifacts.push(xfoilWasmPolarArtifact(input, summary, nowIso()));
        evidence.push(xfoilWasmPolarEvidence(input, summary, nowIso()));
        continue;
      }
      if (request.kind === "su2-case-run") {
        const summary = await runSu2Case(request, settings, signal);
        outputs.push({ kind: request.kind, target: "su2", summary });
        artifacts.push(su2CaseRunArtifact(input, summary, nowIso()));
        evidence.push(su2CaseRunEvidence(input, summary, nowIso()));
        continue;
      }
      if (request.kind === "openvsp-analysis-run") {
        const summary = await runScriptedCfdAnalysis(request, settings, "openvsp", signal);
        outputs.push({ kind: request.kind, target: "openvsp", summary });
        artifacts.push(scriptedCfdRunArtifact(input, summary, nowIso()));
        evidence.push(scriptedCfdRunEvidence(input, summary, nowIso()));
        continue;
      }
      if (request.kind === "xflr5-analysis-run") {
        const summary = await runScriptedCfdAnalysis(request, settings, "xflr5", signal);
        outputs.push({ kind: request.kind, target: "xflr5", summary });
        artifacts.push(scriptedCfdRunArtifact(input, summary, nowIso()));
        evidence.push(scriptedCfdRunEvidence(input, summary, nowIso()));
        continue;
      }
      throw new Error(`Unsupported EngineeringProgramTool request kind: ${request.kind}`);
    }
  } catch (error) {
    signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    return {
      toolRun: failedToolRun(input, "EngineeringProgramTool", startedAt, nowIso(), { requests }, { outputs, failureMessage: message }, message),
      evidence,
      artifacts,
      sources: []
    };
  }

  return {
    toolRun: completedToolRun(input, "EngineeringProgramTool", startedAt, nowIso(), { requests }, { outputs, artifactCount: artifacts.length }),
    evidence,
    artifacts,
    sources: []
  };
}

export async function runEngineeringProgramPreflight(
  settings: AppSettings,
  target: EngineeringProgramTarget = "all"
): Promise<EngineeringProgramPreflightResult> {
  const startedAt = nowIso();
  const normalizedTarget = normalizeEngineeringProgramTarget(target) ?? "all";
  const promotionTarget = engineeringProgramPromotionTarget({ kind: "toolchain-check", target: normalizedTarget });
  const receiptSupport = engineeringPromotionRuntimeReceiptSupport(promotionTarget);
  if (!receiptSupport.supported) {
    return failedPreflight(
      normalizedTarget,
      startedAt,
      receiptSupport.reason ?? `${promotionTarget} is NOT_READY because its exact durable runtime receipt cannot be verified.`
    );
  }
  if (!settings.allowCodeExecution) {
    return failedPreflight(normalizedTarget, startedAt, "Engineering program preflight requires code execution to be enabled in app settings.");
  }

  try {
    const output = await runToolchainCheck(normalizedTarget, settings);
    return {
      target: normalizedTarget,
      status: "completed",
      output,
      startedAt,
      completedAt: nowIso()
    };
  } catch (error) {
    return failedPreflight(normalizedTarget, startedAt, error instanceof Error ? error.message : String(error));
  }
}

export { supportedEngineeringProgramKinds } from "./engineeringProgramRequestValidator.js";

async function runToolchainCheck(target: EngineeringProgramTarget, settings: AppSettings, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  if (target !== "xfoil-wasm") {
    const promotionTarget = engineeringProgramPromotionTarget({ kind: "toolchain-check", target });
    const reason = engineeringPromotionRuntimeReceiptSupport(promotionTarget).reason;
    throw new Error(reason ?? `${promotionTarget} is NOT_READY because its exact durable runtime receipt cannot be verified.`);
  }
  if (!hasConfiguredXfoilWasm(settings)) throw new Error("XFOIL WebAssembly solver is unavailable.");
  return {
    kind: "toolchain-check",
    target,
    checked: ["xfoil-wasm"],
    unavailable: [],
    xfoilWasm: {
      runtime: BUNDLED_WEBXFOIL_RUNTIME,
      version: BUNDLED_WEBXFOIL_VERSION,
      license: "GPL-2.0-or-later",
      bundled: true
    }
  };
}

function failedPreflight(target: EngineeringProgramTarget, startedAt: string, error: string): EngineeringProgramPreflightResult {
  return { target, status: "failed", error, startedAt, completedAt: nowIso() };
}

function failedToolRun(
  input: ResearchToolInput,
  toolName: string,
  startedAt: string,
  completedAt: string,
  toolInput: unknown,
  output: unknown,
  error: string
): ToolRun {
  return {
    id: createId("tool"),
    projectId: input.project.id,
    iteration: input.iteration,
    toolName,
    input: toolInput,
    output,
    status: "failed",
    error,
    startedAt,
    completedAt
  };
}

function completedToolRun(input: ResearchToolInput, toolName: string, startedAt: string, completedAt: string, toolInput: unknown, output: unknown): ToolRun {
  return {
    id: createId("tool"),
    projectId: input.project.id,
    iteration: input.iteration,
    toolName,
    input: toolInput,
    output,
    status: "completed",
    startedAt,
    completedAt
  };
}
