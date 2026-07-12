import { existsSync } from "node:fs";
import { createId, nowIso } from "../../../core/shared/ids.js";
import { assertCommandSucceeded, probeScriptedCfd, probeSu2, probeXfoil } from "./engineeringProgramCommands.js";
import { hasConfiguredModelingRoot, resolveConfiguredModelingRoot } from "./engineeringProgramMeshAdapter.js";
import {
  hasConfiguredOpenVsp,
  hasConfiguredXflr5,
  scriptedCfdConfig,
  validateOptionalScriptedCfdScriptPath,
  validateBuiltinScriptedCfdAdapterPath
} from "./engineeringProgramScriptedCfdAdapter.js";
import { hasConfiguredSu2, runSu2Case, su2Config, validateSu2CaseConfig } from "./engineeringProgramSu2Adapter.js";
import { hasConfiguredXfoil, resolveXfoilCommand, runXfoilPolar } from "./engineeringProgramXfoilAdapter.js";
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
import type { ResearchToolResult } from "../../../core/tools/researchToolTypes.js";
import { bindFetchedAirfoilCoordinates } from "./airfoilCoordinateBinder.js";

export async function runEngineeringProgram(input: ResearchToolInput, settings: AppSettings): Promise<ResearchToolResult> {
  input = bindFetchedAirfoilCoordinates(input);
  const startedAt = nowIso();
  const requests = normalizeEngineeringProgramRequests(input.researchPlan?.programRequests);
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

  const outputs: unknown[] = [];
  const artifacts: ResearchArtifact[] = [];
  const evidence: EvidenceItem[] = [];
  try {
    for (const request of requests.slice(0, 4)) {
      if (request.kind === "toolchain-check") {
        outputs.push(await runToolchainCheck(request.target ?? "all", settings));
        continue;
      }
      if (request.kind === "mesh-inspect") {
        const summary = inspectMeshArtifact(request, settings);
        outputs.push({ kind: request.kind, target: request.target ?? "modeling", summary });
        artifacts.push(meshSummaryArtifact(input, summary, completedAt));
        continue;
      }
      if (request.kind === "xfoil-polar") {
        const summary = await runXfoilPolar(request, settings);
        outputs.push({ kind: request.kind, target: "xfoil", summary: { ...summary, rows: summary.rows.slice(0, 12) } });
        artifacts.push(xfoilPolarArtifact(input, summary, nowIso()));
        evidence.push(xfoilPolarEvidence(input, summary, nowIso()));
        continue;
      }
      if (request.kind === "xfoil-wasm-polar") {
        const summary = await runXfoilWasmPolar(request, settings, input);
        outputs.push({ kind: request.kind, target: "xfoil-wasm", summary: { ...summary, rows: summary.rows.slice(0, 12) } });
        artifacts.push(xfoilWasmPolarArtifact(input, summary, nowIso()));
        evidence.push(xfoilWasmPolarEvidence(input, summary, nowIso()));
        continue;
      }
      if (request.kind === "su2-case-run") {
        const summary = await runSu2Case(request, settings);
        outputs.push({ kind: request.kind, target: "su2", summary });
        artifacts.push(su2CaseRunArtifact(input, summary, nowIso()));
        evidence.push(su2CaseRunEvidence(input, summary, nowIso()));
        continue;
      }
      if (request.kind === "openvsp-analysis-run") {
        const summary = await runScriptedCfdAnalysis(request, settings, "openvsp");
        outputs.push({ kind: request.kind, target: "openvsp", summary });
        artifacts.push(scriptedCfdRunArtifact(input, summary, nowIso()));
        evidence.push(scriptedCfdRunEvidence(input, summary, nowIso()));
        continue;
      }
      if (request.kind === "xflr5-analysis-run") {
        const summary = await runScriptedCfdAnalysis(request, settings, "xflr5");
        outputs.push({ kind: request.kind, target: "xflr5", summary });
        artifacts.push(scriptedCfdRunArtifact(input, summary, nowIso()));
        evidence.push(scriptedCfdRunEvidence(input, summary, nowIso()));
        continue;
      }
      throw new Error(`Unsupported EngineeringProgramTool request kind: ${request.kind}`);
    }
  } catch (error) {
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
  if (!settings.allowCodeExecution) {
    return {
      target: normalizedTarget,
      status: "failed",
      error: "Engineering program preflight requires code execution to be enabled in app settings.",
      startedAt,
      completedAt: nowIso()
    };
  }
  if (!settings.engineeringTools.enabled && normalizedTarget !== "all" && normalizedTarget !== "xfoil-wasm") {
    return {
      target: normalizedTarget,
      status: "failed",
      error: "Engineering program tools are disabled in app settings.",
      startedAt,
      completedAt: nowIso()
    };
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
    return {
      target: normalizedTarget,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      startedAt,
      completedAt: nowIso()
    };
  }
}

export { supportedEngineeringProgramKinds } from "./engineeringProgramRequestValidator.js";

async function runToolchainCheck(target: EngineeringProgramTarget, settings: AppSettings): Promise<unknown> {
  const wantsXfoil = target === "all" || target === "xfoil";
  const wantsXfoilWasm = target === "all" || target === "xfoil-wasm";
  const wantsModeling = target === "all" || target === "modeling";
  const wantsSu2 = target === "all" || target === "su2";
  const wantsOpenVsp = target === "all" || target === "openvsp";
  const wantsXflr5 = target === "all" || target === "xflr5";
  const checked: string[] = [];
  const unavailable: Array<{ target: string; reason: string }> = [];
  const output: Record<string, unknown> = { kind: "toolchain-check", target, checked, unavailable };

  if (wantsXfoil) {
    if (hasConfiguredXfoil(settings)) {
      checked.push("xfoil");
      output.xfoil = assertCommandSucceeded("XFOIL probe", await probeXfoil(resolveXfoilCommand(settings), settings.engineeringTools.xfoil.timeoutMs));
    } else {
      unavailable.push({ target: "xfoil", reason: "Embedded XFOIL executable is not available under the AetherOps engineering toolchain." });
      if (target === "xfoil") throw new Error("Embedded XFOIL executable is not available.");
    }
  }

  if (wantsXfoilWasm) {
    if (hasConfiguredXfoilWasm(settings)) {
      checked.push("xfoil-wasm");
      output.xfoilWasm = { runtime: "webxfoil-wasm", version: "0.1.1", license: "GPL-2.0-or-later", bundled: true };
    } else {
      unavailable.push({ target: "xfoil-wasm", reason: "XFOIL WebAssembly solver is unavailable because engineering tools are disabled." });
      if (target === "xfoil-wasm") throw new Error("XFOIL WebAssembly solver is unavailable.");
    }
  }

  if (wantsModeling) {
    if (hasConfiguredModelingRoot(settings)) {
      checked.push("modeling");
      const root = resolveConfiguredModelingRoot(settings);
      output.modeling = { artifactRoot: root, exists: existsSync(root), maxMeshBytes: settings.engineeringTools.modeling.maxMeshBytes };
      if (!existsSync(root)) throw new Error(`Configured modeling artifact root does not exist: ${root}`);
    } else {
      unavailable.push({ target: "modeling", reason: "Modeling artifact root is not configured." });
      if (target === "modeling") throw new Error("Modeling artifact root is not configured.");
    }
  }

  if (wantsSu2) {
    if (hasConfiguredSu2(settings)) {
      checked.push("su2");
      const config = su2Config(settings);
      const su2Case = validateSu2CaseConfig(config.caseRoot, config.configFile);
      output.su2 = { caseRoot: su2Case.caseRoot, configPath: su2Case.configPath, probe: assertCommandSucceeded("SU2 probe", await probeSu2(config)) };
    } else {
      unavailable.push({ target: "su2", reason: "SU2 requires an embedded executable and a case root containing the configured .cfg file." });
      if (target === "su2") throw new Error("Embedded SU2 executable or case config is not configured.");
    }
  }

  if (wantsOpenVsp) {
    if (hasConfiguredOpenVsp(settings)) {
      checked.push("openvsp");
      const config = scriptedCfdConfig(settings, "openvsp");
      const customScriptPath = validateOptionalScriptedCfdScriptPath(config);
      output.openVsp = {
        adapterMode: customScriptPath ? "custom" : "builtin",
        scriptPath: customScriptPath,
        builtinAdapterPath: customScriptPath ? undefined : validateBuiltinScriptedCfdAdapterPath("openvsp"),
        probe: await probeScriptedCfd(config)
      };
    } else {
      unavailable.push({
        target: "openvsp",
        reason: "OpenVSP requires an embedded executable and either the built-in adapter or a valid custom script contract."
      });
      if (target === "openvsp") throw new Error("Embedded OpenVSP executable or adapter contract is not configured.");
    }
  }

  if (wantsXflr5) {
    if (hasConfiguredXflr5(settings)) {
      checked.push("xflr5");
      const config = scriptedCfdConfig(settings, "xflr5");
      const customScriptPath = validateOptionalScriptedCfdScriptPath(config);
      output.xflr5 = {
        adapterMode: customScriptPath ? "custom" : "builtin",
        scriptPath: customScriptPath,
        builtinAdapterPath: customScriptPath ? undefined : validateBuiltinScriptedCfdAdapterPath("xflr5"),
        probe: await probeScriptedCfd(config)
      };
    } else {
      unavailable.push({ target: "xflr5", reason: "XFLR5 requires an embedded executable and either the built-in adapter or a valid custom script contract." });
      if (target === "xflr5") throw new Error("Embedded XFLR5 executable or adapter contract is not configured.");
    }
  }

  if (!checked.length) {
    throw new Error("No configured headless engineering target is available for EngineeringProgramTool.");
  }
  return output;
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
