import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createId, nowIso } from "../shared/ids.js";
import type { ResearchTool, ResearchToolResult } from "./toolRegistry.js";
import type {
  AppSettings,
  EngineeringProgramCapability,
  EngineeringProgramPreflightResult,
  EngineeringProgramRequest,
  EngineeringProgramTarget,
  EvidenceItem,
  OpenCodeRunInput,
  ResearchArtifact,
  ToolRun
} from "../shared/types.js";

export interface MeshSummary {
  fileName: string;
  format: "obj" | "stl-ascii" | "stl-binary";
  byteLength: number;
  vertexCount: number;
  faceCount: number;
  triangleCount: number;
  boundingBox?: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

interface CommandProbeResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

interface XfoilPolarRow {
  alpha: number;
  cl: number;
  cd: number;
  cdp?: number;
  cm?: number;
  topXtr?: number;
  botXtr?: number;
}

interface XfoilPolarSummary {
  airfoil: string;
  reynolds: number;
  mach: number;
  alphaStart: number;
  alphaEnd: number;
  alphaStep: number;
  rowCount: number;
  rows: XfoilPolarRow[];
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

interface XfoilWasmPolarSummary {
  airfoil: string;
  runtime: "webxfoil-wasm";
  runtimeVersion: string;
  runtimeLicense: "GPL-2.0-or-later";
  sourceKind: "artifact" | "source" | "direct-url" | "naca";
  sourceLabel: string;
  sourceUrl?: string;
  sourceArtifactPath?: string;
  coordinateFormat?: string;
  reynolds: number;
  mach: number;
  alphaStart: number;
  alphaEnd: number;
  alphaStep: number;
  rowCount: number;
  rows: XfoilPolarRow[];
  stdoutExcerpt: string;
  stderrExcerpt: string;
  convergence: {
    hasNaN: boolean;
    hasFortranError: boolean;
    hasConvergenceFail: boolean;
  };
}

interface AirfoilCoordinateInput {
  text?: string;
  label: string;
  sourceKind: XfoilWasmPolarSummary["sourceKind"];
  sourceUrl?: string;
  sourceArtifactPath?: string;
}

interface CommercialAdapterConfig {
  target: Extract<EngineeringProgramTarget, "flightstream" | "starccm">;
  label: string;
  command?: string;
  workingDirectory?: string;
  probeArgs: string[];
  runArgsTemplate: string[];
  timeoutMs: number;
}

interface OpenFoamConfig {
  command?: string;
  caseRoot?: string;
  workingDirectory?: string;
  probeArgs: string[];
  runArgsTemplate: string[];
  timeoutMs: number;
}

interface Su2Config {
  command?: string;
  caseRoot?: string;
  configFile?: string;
  workingDirectory?: string;
  probeArgs: string[];
  runArgsTemplate: string[];
  timeoutMs: number;
}

interface FreeCadConfig {
  command?: string;
  scriptPath?: string;
  workingDirectory?: string;
  probeArgs: string[];
  runArgsTemplate: string[];
  timeoutMs: number;
}

interface OpenVspConfig {
  command?: string;
  scriptPath?: string;
  workingDirectory?: string;
  probeArgs: string[];
  runArgsTemplate: string[];
  timeoutMs: number;
}

interface CommercialCfdRunSummary {
  target: Extract<EngineeringProgramTarget, "flightstream" | "starccm">;
  label: string;
  command: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  inputArtifactPath?: string;
  outputFileName: string;
  outputTextExcerpt?: string;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

interface OpenFoamCaseRunSummary {
  target: "openfoam";
  command: string;
  args: string[];
  caseRoot: string;
  workingDirectory?: string;
  outputFileName: string;
  outputTextExcerpt?: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

interface Su2CaseRunSummary {
  target: "su2";
  command: string;
  args: string[];
  caseRoot: string;
  configPath: string;
  workingDirectory?: string;
  outputFileName: string;
  outputTextExcerpt?: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

interface FreeCadScriptRunSummary {
  target: "freecad";
  command: string;
  args: string[];
  scriptPath: string;
  workingDirectory?: string;
  outputFileName: string;
  outputTextExcerpt?: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

interface OpenVspScriptRunSummary {
  target: "openvsp";
  command: string;
  args: string[];
  scriptPath: string;
  workingDirectory?: string;
  outputFileName: string;
  outputTextExcerpt?: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

export class EngineeringProgramTool implements ResearchTool {
  name = "EngineeringProgramTool";

  async run(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    if (!input.project.autonomyPolicy.allowCodeExecution || !settings.allowCodeExecution) {
      throw new Error("EngineeringProgramTool requires code execution permission from both project autonomy and app settings.");
    }
    if (!settings.engineeringTools.enabled) {
      throw new Error("EngineeringProgramTool is disabled in app settings.");
    }

    const requests = normalizeProgramRequests(input.researchPlan?.programRequests);
    const completedAt = nowIso();
    if (!requests.length) {
      return {
        toolRun: failedToolRun(
          input,
          this.name,
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
        if (request.kind === "openfoam-case-run") {
          const summary = await runOpenFoamCase(request, settings);
          outputs.push({ kind: request.kind, target: "openfoam", summary });
          artifacts.push(openFoamCaseRunArtifact(input, summary, nowIso()));
          evidence.push(openFoamCaseRunEvidence(input, summary, nowIso()));
          continue;
        }
        if (request.kind === "su2-case-run") {
          const summary = await runSu2Case(request, settings);
          outputs.push({ kind: request.kind, target: "su2", summary });
          artifacts.push(su2CaseRunArtifact(input, summary, nowIso()));
          evidence.push(su2CaseRunEvidence(input, summary, nowIso()));
          continue;
        }
        if (request.kind === "cad-script-run") {
          const summary = await runFreeCadScript(request, settings);
          outputs.push({ kind: request.kind, target: "freecad", summary });
          artifacts.push(freeCadScriptRunArtifact(input, summary, nowIso()));
          evidence.push(freeCadScriptRunEvidence(input, summary, nowIso()));
          continue;
        }
        if (request.kind === "vsp-script-run") {
          const summary = await runOpenVspScript(request, settings);
          outputs.push({ kind: request.kind, target: "openvsp", summary });
          artifacts.push(openVspScriptRunArtifact(input, summary, nowIso()));
          evidence.push(openVspScriptRunEvidence(input, summary, nowIso()));
          continue;
        }
        if (request.kind === "commercial-cfd-run") {
          const summary = await runCommercialCfdAdapter(request, settings);
          outputs.push({ kind: request.kind, target: summary.target, summary });
          artifacts.push(commercialCfdRunArtifact(input, summary, nowIso()));
          evidence.push(commercialCfdRunEvidence(input, summary, nowIso()));
          continue;
        }
        throw new Error(`Unsupported EngineeringProgramTool request kind: ${request.kind}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        toolRun: failedToolRun(input, this.name, startedAt, nowIso(), { requests }, { outputs, failureMessage: message }, message),
        evidence,
        artifacts,
        sources: []
      };
    }

    return {
      toolRun: completedToolRun(input, this.name, startedAt, nowIso(), { requests }, { outputs, artifactCount: artifacts.length }),
      evidence,
      artifacts,
      sources: []
    };
  }
}

export function hasExecutableEngineeringTool(settings: AppSettings): boolean {
  if (!settings.engineeringTools.enabled) return false;
  return (
    hasConfiguredXfoil(settings) ||
    hasConfiguredXfoilWasm(settings) ||
    hasConfiguredModelingRoot(settings) ||
    hasConfiguredOpenFoam(settings) ||
    hasConfiguredSu2(settings) ||
    hasConfiguredFreeCad(settings) ||
    hasConfiguredOpenVsp(settings) ||
    hasConfiguredCommercialAdapter(settings, "flightstream") ||
    hasConfiguredCommercialAdapter(settings, "starccm")
  );
}

export function describeEngineeringProgramCapabilities(settings: AppSettings): EngineeringProgramCapability[] {
  const toolsEnabled = settings.engineeringTools.enabled;
  const xfoilReady = toolsEnabled && hasConfiguredXfoil(settings);
  const xfoilWasmReady = toolsEnabled && hasConfiguredXfoilWasm(settings);
  const modelingReady = toolsEnabled && hasConfiguredModelingRoot(settings);
  const openFoamReady = toolsEnabled && hasConfiguredOpenFoam(settings);
  const su2Ready = toolsEnabled && hasConfiguredSu2(settings);
  const freeCadReady = toolsEnabled && hasConfiguredFreeCad(settings);
  const openVspReady = toolsEnabled && hasConfiguredOpenVsp(settings);
  const flightStreamReady = toolsEnabled && hasConfiguredCommercialAdapter(settings, "flightstream");
  const starCcmReady = toolsEnabled && hasConfiguredCommercialAdapter(settings, "starccm");
  const capabilities: EngineeringProgramCapability[] = [
    {
      kind: "toolchain-check",
      target: "all",
      ready: toolsEnabled && (xfoilReady || xfoilWasmReady || modelingReady || openFoamReady || su2Ready || freeCadReady || openVspReady || flightStreamReady || starCcmReady),
      requiredFields: ["kind"],
      optionalFields: ["target", "reason"],
      description: "Probe configured engineering programs and report unavailable targets without inventing substitutes.",
      blockedReason: toolsEnabled ? "No engineering target is configured." : "Engineering program tools are disabled."
    },
    {
      kind: "mesh-inspect",
      target: "modeling",
      ready: modelingReady,
      requiredFields: ["kind", "artifactPath"],
      optionalFields: ["reason"],
      description: "Inspect OBJ/STL mesh geometry under the configured modeling artifact root.",
      blockedReason: modelingReady ? undefined : "Modeling artifact root is not configured."
    },
    {
      kind: "xfoil-polar",
      target: "xfoil",
      ready: xfoilReady,
      requiredFields: ["kind", "naca or artifactPath"],
      optionalFields: ["reynolds", "mach", "alphaStart", "alphaEnd", "alphaStep", "reason"],
      description: "Run the configured XFOIL executable to generate a polar table.",
      blockedReason: xfoilReady ? undefined : "XFOIL command is not configured or not available on PATH."
    },
    {
      kind: "xfoil-wasm-polar",
      target: "xfoil-wasm",
      ready: xfoilWasmReady,
      requiredFields: ["kind", "naca or artifactPath or sourceUrl"],
      optionalFields: ["reynolds", "mach", "alphaStart", "alphaEnd", "alphaStep", "reason"],
      description: "Run the bundled WebXFOIL WebAssembly solver to generate a real XFOIL polar without requiring a local xfoil executable.",
      blockedReason: xfoilWasmReady ? undefined : "XFOIL WebAssembly solver is unavailable because engineering program tools are disabled."
    },
    {
      kind: "openfoam-case-run",
      target: "openfoam",
      ready: openFoamReady,
      requiredFields: ["kind", "target"],
      optionalFields: ["outputFileName", "reason"],
      description: "Run a configured OpenFOAM-compatible solver command against the saved case root using its args template.",
      blockedReason: openFoamReady ? undefined : "OpenFOAM command is not available, or parser-visible case root is not configured."
    },
    {
      kind: "su2-case-run",
      target: "su2",
      ready: su2Ready,
      requiredFields: ["kind", "target"],
      optionalFields: ["outputFileName", "reason"],
      description: "Run a configured SU2_CFD-compatible command against the saved case config using its args template.",
      blockedReason: su2Ready ? undefined : "SU2 command is not available, or parser-visible case config is not configured."
    },
    {
      kind: "cad-script-run",
      target: "freecad",
      ready: freeCadReady,
      requiredFields: ["kind", "target"],
      optionalFields: ["outputFileName", "reason"],
      description: "Run the configured FreeCAD-compatible headless command with the saved script and args template.",
      blockedReason: freeCadReady ? undefined : "FreeCAD command is not available, or script path is not configured."
    },
    {
      kind: "vsp-script-run",
      target: "openvsp",
      ready: openVspReady,
      requiredFields: ["kind", "target"],
      optionalFields: ["outputFileName", "reason"],
      description: "Run the configured OpenVSP-compatible headless command with the saved script and args template.",
      blockedReason: openVspReady ? undefined : "OpenVSP command is not available, or script path is not configured."
    },
    {
      kind: "commercial-cfd-run",
      target: "flightstream",
      ready: flightStreamReady,
      requiredFields: ["kind", "target"],
      optionalFields: ["artifactPath", "outputFileName", "reason"],
      description: "Run the configured FlightStream adapter command using its saved args template.",
      blockedReason: flightStreamReady ? undefined : "FlightStream command adapter is not configured or not available on PATH."
    },
    {
      kind: "commercial-cfd-run",
      target: "starccm",
      ready: starCcmReady,
      requiredFields: ["kind", "target"],
      optionalFields: ["artifactPath", "outputFileName", "reason"],
      description: "Run the configured STAR-CCM+ adapter command using its saved args template.",
      blockedReason: starCcmReady ? undefined : "STAR-CCM+ command adapter is not configured or not available on PATH."
    }
  ];
  return capabilities.map((capability) => (capability.ready ? { ...capability, blockedReason: undefined } : capability));
}

export async function runEngineeringProgramPreflight(settings: AppSettings, target: EngineeringProgramTarget = "all"): Promise<EngineeringProgramPreflightResult> {
  const startedAt = nowIso();
  const normalizedTarget = normalizeTarget(target) ?? "all";
  if (!settings.allowCodeExecution) {
    return {
      target: normalizedTarget,
      status: "failed",
      error: "Engineering program preflight requires code execution to be enabled in app settings.",
      startedAt,
      completedAt: nowIso()
    };
  }
  if (!settings.engineeringTools.enabled) {
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

function normalizeProgramRequests(value: unknown): EngineeringProgramRequest[] {
  if (!Array.isArray(value)) return [];
  const requests: EngineeringProgramRequest[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const request = item as Partial<EngineeringProgramRequest>;
    if (
      request.kind !== "toolchain-check" &&
      request.kind !== "mesh-inspect" &&
      request.kind !== "xfoil-polar" &&
      request.kind !== "xfoil-wasm-polar" &&
      request.kind !== "openfoam-case-run" &&
      request.kind !== "su2-case-run" &&
      request.kind !== "cad-script-run" &&
      request.kind !== "vsp-script-run" &&
      request.kind !== "commercial-cfd-run"
    ) continue;
    requests.push({
      kind: request.kind,
      target: normalizeTarget(request.target),
      artifactPath: typeof request.artifactPath === "string" ? request.artifactPath : undefined,
      sourceUrl: typeof request.sourceUrl === "string" ? request.sourceUrl : undefined,
      outputFileName: typeof request.outputFileName === "string" ? request.outputFileName : undefined,
      naca: typeof request.naca === "string" ? request.naca : undefined,
      reynolds: finiteNumber(request.reynolds),
      mach: finiteNumber(request.mach),
      alphaStart: finiteNumber(request.alphaStart),
      alphaEnd: finiteNumber(request.alphaEnd),
      alphaStep: finiteNumber(request.alphaStep),
      reason: typeof request.reason === "string" ? request.reason : undefined
    });
  }
  return requests;
}

function supportedEngineeringProgramKinds(): EngineeringProgramRequest["kind"][] {
  return ["toolchain-check", "mesh-inspect", "xfoil-polar", "xfoil-wasm-polar", "openfoam-case-run", "su2-case-run", "cad-script-run", "vsp-script-run", "commercial-cfd-run"];
}

async function runToolchainCheck(target: EngineeringProgramTarget, settings: AppSettings): Promise<unknown> {
  const wantsXfoil = target === "all" || target === "xfoil";
  const wantsXfoilWasm = target === "all" || target === "xfoil-wasm";
  const wantsModeling = target === "all" || target === "modeling";
  const wantsOpenFoam = target === "all" || target === "openfoam";
  const wantsSu2 = target === "all" || target === "su2";
  const wantsFreeCad = target === "all" || target === "freecad";
  const wantsOpenVsp = target === "all" || target === "openvsp";
  const wantsFlightStream = target === "all" || target === "flightstream";
  const wantsStarCcm = target === "all" || target === "starccm";
  const checked: string[] = [];
  const unavailable: Array<{ target: string; reason: string }> = [];
  const output: Record<string, unknown> = { kind: "toolchain-check", target, checked, unavailable };

  if (wantsXfoil) {
    if (hasConfiguredXfoil(settings)) {
      checked.push("xfoil");
      output.xfoil = await probeXfoil(settings.engineeringTools.xfoil.command as string, settings.engineeringTools.xfoil.timeoutMs);
    } else {
      unavailable.push({ target: "xfoil", reason: "XFOIL command is not configured." });
      if (target === "xfoil") throw new Error("XFOIL command is not configured.");
    }
  }

  if (wantsXfoilWasm) {
    if (hasConfiguredXfoilWasm(settings)) {
      checked.push("xfoil-wasm");
      output.xfoilWasm = {
        runtime: "webxfoil-wasm",
        version: "0.1.1",
        license: "GPL-2.0-or-later",
        bundled: true
      };
    } else {
      unavailable.push({ target: "xfoil-wasm", reason: "XFOIL WebAssembly solver is unavailable because engineering tools are disabled." });
      if (target === "xfoil-wasm") throw new Error("XFOIL WebAssembly solver is unavailable.");
    }
  }

  if (wantsModeling) {
    if (hasConfiguredModelingRoot(settings)) {
      checked.push("modeling");
      const root = resolve(settings.engineeringTools.modeling.artifactRoot as string);
      output.modeling = { artifactRoot: root, exists: existsSync(root), maxMeshBytes: settings.engineeringTools.modeling.maxMeshBytes };
      if (!existsSync(root)) throw new Error(`Configured modeling artifact root does not exist: ${root}`);
    } else {
      unavailable.push({ target: "modeling", reason: "Modeling artifact root is not configured." });
      if (target === "modeling") throw new Error("Modeling artifact root is not configured.");
    }
  }

  if (wantsOpenFoam) {
    if (hasConfiguredOpenFoam(settings)) {
      checked.push("openfoam");
      const config = openFoamConfig(settings);
      output.openFoam = {
        caseRoot: validateOpenFoamCaseRoot(config.caseRoot),
        probe: await probeOpenFoam(config)
      };
    } else {
      unavailable.push({ target: "openfoam", reason: "OpenFOAM requires an enabled command and a case root containing system/controlDict." });
      if (target === "openfoam") throw new Error("OpenFOAM command or case root is not configured.");
    }
  }

  if (wantsSu2) {
    if (hasConfiguredSu2(settings)) {
      checked.push("su2");
      const config = su2Config(settings);
      const su2Case = validateSu2CaseConfig(config.caseRoot, config.configFile);
      output.su2 = {
        caseRoot: su2Case.caseRoot,
        configPath: su2Case.configPath,
        probe: await probeSu2(config)
      };
    } else {
      unavailable.push({ target: "su2", reason: "SU2 requires an enabled command and a case root containing the configured .cfg file." });
      if (target === "su2") throw new Error("SU2 command or case config is not configured.");
    }
  }

  if (wantsFreeCad) {
    if (hasConfiguredFreeCad(settings)) {
      checked.push("freecad");
      const config = freeCadConfig(settings);
      output.freeCad = {
        scriptPath: validateFreeCadScriptPath(config.scriptPath),
        probe: await probeFreeCad(config)
      };
    } else {
      unavailable.push({ target: "freecad", reason: "FreeCAD requires an enabled command and an existing configured script path." });
      if (target === "freecad") throw new Error("FreeCAD command or script path is not configured.");
    }
  }

  if (wantsOpenVsp) {
    if (hasConfiguredOpenVsp(settings)) {
      checked.push("openvsp");
      const config = openVspConfig(settings);
      output.openVsp = {
        scriptPath: validateOpenVspScriptPath(config.scriptPath),
        probe: await probeOpenVsp(config)
      };
    } else {
      unavailable.push({ target: "openvsp", reason: "OpenVSP requires an enabled command and an existing configured script path." });
      if (target === "openvsp") throw new Error("OpenVSP command or script path is not configured.");
    }
  }

  if (wantsFlightStream) {
    if (hasConfiguredCommercialAdapter(settings, "flightstream")) {
      checked.push("flightstream");
      const adapter = commercialAdapterConfig(settings, "flightstream");
      output.flightStream = await probeCommercialAdapter(adapter);
    } else {
      output.flightStream = { configured: settings.engineeringTools.commercialCfd.flightStreamConfigured, executableAdapter: false };
      unavailable.push({ target: "flightstream", reason: "FlightStream requires a configured command and licensed execution adapter before AetherOps can run it." });
      if (target === "flightstream") throw new Error("FlightStream execution adapter is not configured.");
    }
  }

  if (wantsStarCcm) {
    if (hasConfiguredCommercialAdapter(settings, "starccm")) {
      checked.push("starccm");
      const adapter = commercialAdapterConfig(settings, "starccm");
      output.starCcm = await probeCommercialAdapter(adapter);
    } else {
      output.starCcm = { configured: settings.engineeringTools.commercialCfd.starCcmConfigured, executableAdapter: false };
      unavailable.push({ target: "starccm", reason: "STAR-CCM+ requires a configured command and licensed execution adapter before AetherOps can run it." });
      if (target === "starccm") throw new Error("STAR-CCM+ execution adapter is not configured.");
    }
  }

  if (!checked.length) {
    throw new Error("No configured headless engineering target is available for EngineeringProgramTool.");
  }
  return output;
}

function inspectMeshArtifact(request: EngineeringProgramRequest, settings: AppSettings): MeshSummary {
  if (!hasConfiguredModelingRoot(settings)) {
    throw new Error("Mesh inspection requires a configured modeling artifact root.");
  }
  if (!request.artifactPath?.trim()) {
    throw new Error("Mesh inspection requires programRequests[].artifactPath.");
  }
  const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot as string);
  const targetPath = resolveInsideRoot(artifactRoot, request.artifactPath);
  if (!existsSync(targetPath)) {
    throw new Error(`Mesh artifact does not exist under configured root: ${request.artifactPath}`);
  }
  const stats = statSync(targetPath);
  if (!stats.isFile()) {
    throw new Error(`Mesh artifact is not a file: ${request.artifactPath}`);
  }
  const maxBytes = settings.engineeringTools.modeling.maxMeshBytes;
  if (stats.size > maxBytes) {
    throw new Error(`Mesh artifact exceeds maxMeshBytes (${stats.size} > ${maxBytes}).`);
  }
  const buffer = readFileSync(targetPath);
  const extension = extname(targetPath).toLowerCase();
  if (extension === ".obj") return parseObjMesh(buffer, basename(targetPath));
  if (extension === ".stl") return parseStlMesh(buffer, basename(targetPath));
  throw new Error(`Unsupported mesh format for inspection: ${extension || "unknown"}`);
}

export function inspectConfiguredMeshArtifact(settings: AppSettings, artifactPath: string): MeshSummary {
  return inspectMeshArtifact({ kind: "mesh-inspect", target: "modeling", artifactPath }, settings);
}

async function runXfoilPolar(request: EngineeringProgramRequest, settings: AppSettings): Promise<XfoilPolarSummary> {
  if (!hasConfiguredXfoil(settings)) {
    throw new Error("XFOIL polar execution requires a configured XFOIL command.");
  }
  const airfoil = xfoilAirfoilInput(request, settings);
  const reynolds = boundedPositiveNumber(request.reynolds, 1_000, 100_000_000, 1_000_000, "reynolds");
  const mach = boundedPositiveNumber(request.mach, 0, 0.8, 0, "mach");
  const alphaStart = boundedNumber(request.alphaStart, -30, 30, -4, "alphaStart");
  const alphaEnd = boundedNumber(request.alphaEnd, -30, 30, 12, "alphaEnd");
  const alphaStep = boundedPositiveNumber(request.alphaStep, 0.1, 10, 2, "alphaStep");
  if (alphaEnd < alphaStart) {
    throw new Error("XFOIL polar request requires alphaEnd >= alphaStart.");
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-xfoil-"));
  const polarPath = join(tempRoot, "polar.txt");
  const commandInput = [
    airfoil.command,
    "OPER",
    "ITER 100",
    `VISC ${reynolds}`,
    `MACH ${mach}`,
    "PACC",
    polarPath,
    "",
    `ASEQ ${alphaStart} ${alphaEnd} ${alphaStep}`,
    "PACC",
    "",
    "QUIT",
    ""
  ].join("\n");

  try {
    const probe = await runCommandWithInput(settings.engineeringTools.xfoil.command as string, commandInput, settings.engineeringTools.xfoil.timeoutMs);
    if (!existsSync(polarPath)) {
      throw new Error(`XFOIL did not produce a polar file. stdout=${probe.stdoutExcerpt} stderr=${probe.stderrExcerpt}`);
    }
    const polarText = readFileSync(polarPath, "utf8");
    const rows = parseXfoilPolarRows(polarText);
    if (!rows.length) {
      throw new Error(`XFOIL polar file contained no numeric rows. stdout=${probe.stdoutExcerpt} stderr=${probe.stderrExcerpt}`);
    }
    return {
      airfoil: airfoil.label,
      reynolds,
      mach,
      alphaStart,
      alphaEnd,
      alphaStep,
      rowCount: rows.length,
      rows,
      stdoutExcerpt: probe.stdoutExcerpt,
      stderrExcerpt: probe.stderrExcerpt
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runXfoilWasmPolar(request: EngineeringProgramRequest, settings: AppSettings, input: OpenCodeRunInput): Promise<XfoilWasmPolarSummary> {
  if (!hasConfiguredXfoilWasm(settings)) {
    throw new Error("XFOIL WebAssembly polar execution requires engineering program tools to be enabled.");
  }
  const coordinateInput = await resolveWasmAirfoilInput(request, settings, input);
  const reynolds = boundedPositiveNumber(request.reynolds, 1_000, 100_000_000, 1_000_000, "reynolds");
  const mach = boundedPositiveNumber(request.mach, 0, 0.8, 0, "mach");
  const alphaStart = boundedNumber(request.alphaStart, -30, 30, -4, "alphaStart");
  const alphaEnd = boundedNumber(request.alphaEnd, -30, 30, 12, "alphaEnd");
  const alphaStep = boundedPositiveNumber(request.alphaStep, 0.1, 10, 2, "alphaStep");
  if (alphaEnd < alphaStart) {
    throw new Error("XFOIL WebAssembly polar request requires alphaEnd >= alphaStart.");
  }

  const { WebXFOIL } = await import("webxfoil-wasm");
  const xfoil = await WebXFOIL.load();
  try {
    const session = WebXFOIL.input();
    let airfoil = coordinateInput.label;
    let coordinateFormat: string | undefined;
    if (coordinateInput.text) {
      const loaded = session.loadAirfoilText(coordinateInput.text, {
        path: `${safeOutputFileName(coordinateInput.label, "airfoil")}.dat`,
        name: coordinateInput.label
      });
      airfoil = loaded.name || coordinateInput.label;
      coordinateFormat = loaded.format;
    } else {
      const naca = request.naca?.trim();
      if (!naca || !/^\d{4,5}$/.test(naca)) {
        throw new Error("XFOIL WebAssembly NACA request must be a 4 or 5 digit series code.");
      }
      session.naca(naca);
      airfoil = `NACA ${naca}`;
    }

    const polarPath = "xfoil-wasm-polar.txt";
    session
      .add("PANE")
      .oper()
      .add("ITER 160")
      .add(`VISC ${reynolds}`)
      .add(`MACH ${mach}`)
      .add("PACC")
      .add(polarPath)
      .blank()
      .add(`ASEQ ${alphaStart} ${alphaEnd} ${alphaStep}`)
      .add("PACC")
      .blank()
      .quit();

    const result = xfoil.run(session.toString(), { workDir: "/work", files: session.files, scalarKeys: ["CL", "CD", "Cm", "a"] });
    const polarText = String(xfoil.readFile(`/work/${polarPath}`, "utf8"));
    const rows = parseXfoilPolarRows(polarText);
    if (!rows.length) {
      throw new Error(`XFOIL WebAssembly produced no polar rows. stdout=${excerpt(result.raw.stdout)} stderr=${excerpt(result.raw.stderr)}`);
    }
    return {
      airfoil,
      runtime: "webxfoil-wasm",
      runtimeVersion: "0.1.1",
      runtimeLicense: "GPL-2.0-or-later",
      sourceKind: coordinateInput.sourceKind,
      sourceLabel: coordinateInput.label,
      sourceUrl: coordinateInput.sourceUrl,
      sourceArtifactPath: coordinateInput.sourceArtifactPath,
      coordinateFormat,
      reynolds,
      mach,
      alphaStart,
      alphaEnd,
      alphaStep,
      rowCount: rows.length,
      rows,
      stdoutExcerpt: excerpt(result.raw.stdout),
      stderrExcerpt: excerpt(result.raw.stderr),
      convergence: {
        hasNaN: Boolean(result.output.hasNaN),
        hasFortranError: Boolean(result.output.hasFortranError),
        hasConvergenceFail: Boolean(result.output.hasConvergenceFail)
      }
    };
  } finally {
    xfoil.destroy();
  }
}

async function runOpenFoamCase(request: EngineeringProgramRequest, settings: AppSettings): Promise<OpenFoamCaseRunSummary> {
  if (request.target !== "openfoam") {
    throw new Error("openfoam-case-run requires target openfoam.");
  }
  if (!hasConfiguredOpenFoam(settings)) {
    throw new Error("OpenFOAM case execution requires an enabled command and a case root containing system/controlDict.");
  }
  const config = openFoamConfig(settings);
  if (!config.runArgsTemplate.length) {
    throw new Error("OpenFOAM runArgsTemplate is not configured; AetherOps will not invent solver command arguments.");
  }
  const caseRoot = validateOpenFoamCaseRoot(config.caseRoot);
  const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-openfoam-"));
  const outputFileName = safeOutputFileName(request.outputFileName, "openfoam-run-output.txt");
  const outputPath = join(tempRoot, outputFileName);
  const args = renderOpenFoamArgs(config.runArgsTemplate, { caseRoot, outputPath, workingDirectory: config.workingDirectory });
  const cwd = normalizeWorkingDirectory(config.workingDirectory) ?? caseRoot;

  try {
    const result = await runCommandWithArgs(config.command as string, args, config.timeoutMs, cwd);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`OpenFOAM command exited unsuccessfully: exitCode=${result.exitCode}, timedOut=${result.timedOut}, stderr=${result.stderrExcerpt}`);
    }
    const outputTextExcerpt = existsSync(outputPath) ? excerpt(readFileSync(outputPath, "utf8")) : undefined;
    return {
      target: "openfoam",
      command: config.command as string,
      args,
      caseRoot,
      workingDirectory: cwd,
      outputFileName,
      outputTextExcerpt,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdoutExcerpt: result.stdoutExcerpt,
      stderrExcerpt: result.stderrExcerpt
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runSu2Case(request: EngineeringProgramRequest, settings: AppSettings): Promise<Su2CaseRunSummary> {
  if (request.target !== "su2") {
    throw new Error("su2-case-run requires target su2.");
  }
  if (!hasConfiguredSu2(settings)) {
    throw new Error("SU2 case execution requires an enabled command, configured case root, and explicit config file.");
  }
  const config = su2Config(settings);
  if (!config.runArgsTemplate.length) {
    throw new Error("SU2 runArgsTemplate is not configured; AetherOps will not invent solver command arguments.");
  }
  if (!config.runArgsTemplate.some((arg) => arg.includes("{config}"))) {
    throw new Error("SU2 runArgsTemplate must include {config}; AetherOps will not infer an implicit SU2 config file.");
  }
  const su2Case = validateSu2CaseConfig(config.caseRoot, config.configFile);
  const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-su2-"));
  const outputFileName = safeOutputFileName(request.outputFileName, "su2-run-output.txt");
  const outputPath = join(tempRoot, outputFileName);
  const args = renderSu2Args(config.runArgsTemplate, {
    caseRoot: su2Case.caseRoot,
    configPath: su2Case.configPath,
    outputPath,
    workingDirectory: config.workingDirectory
  });
  const cwd = normalizeWorkingDirectory(config.workingDirectory) ?? su2Case.caseRoot;

  try {
    const result = await runCommandWithArgs(config.command as string, args, config.timeoutMs, cwd);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`SU2 command exited unsuccessfully: exitCode=${result.exitCode}, timedOut=${result.timedOut}, stderr=${result.stderrExcerpt}`);
    }
    const outputTextExcerpt = existsSync(outputPath) ? excerpt(readFileSync(outputPath, "utf8")) : undefined;
    return {
      target: "su2",
      command: config.command as string,
      args,
      caseRoot: su2Case.caseRoot,
      configPath: su2Case.configPath,
      workingDirectory: cwd,
      outputFileName,
      outputTextExcerpt,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdoutExcerpt: result.stdoutExcerpt,
      stderrExcerpt: result.stderrExcerpt
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runFreeCadScript(request: EngineeringProgramRequest, settings: AppSettings): Promise<FreeCadScriptRunSummary> {
  if (request.target !== "freecad") {
    throw new Error("cad-script-run requires target freecad.");
  }
  if (!hasConfiguredFreeCad(settings)) {
    throw new Error("FreeCAD script execution requires an enabled command and an existing configured script path.");
  }
  const config = freeCadConfig(settings);
  if (!config.runArgsTemplate.length) {
    throw new Error("FreeCAD runArgsTemplate is not configured; AetherOps will not invent CAD command arguments.");
  }
  if (!config.runArgsTemplate.some((arg) => arg.includes("{script}"))) {
    throw new Error("FreeCAD runArgsTemplate must include {script}; AetherOps will not run an implicit CAD script.");
  }
  const scriptPath = validateFreeCadScriptPath(config.scriptPath);
  const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-freecad-"));
  const outputFileName = safeOutputFileName(request.outputFileName, "freecad-script-output.json");
  const outputPath = join(tempRoot, outputFileName);
  const cwd = normalizeWorkingDirectory(config.workingDirectory);
  const args = renderScriptedToolArgs(config.runArgsTemplate, { scriptPath, outputPath, workingDirectory: cwd });

  try {
    const result = await runCommandWithArgs(config.command as string, args, config.timeoutMs, cwd);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`FreeCAD-compatible command exited unsuccessfully: exitCode=${result.exitCode}, timedOut=${result.timedOut}, stderr=${result.stderrExcerpt}`);
    }
    const outputTextExcerpt = existsSync(outputPath) ? excerpt(readFileSync(outputPath, "utf8")) : undefined;
    return {
      target: "freecad",
      command: config.command as string,
      args,
      scriptPath,
      workingDirectory: cwd,
      outputFileName,
      outputTextExcerpt,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdoutExcerpt: result.stdoutExcerpt,
      stderrExcerpt: result.stderrExcerpt
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runOpenVspScript(request: EngineeringProgramRequest, settings: AppSettings): Promise<OpenVspScriptRunSummary> {
  if (request.target !== "openvsp") {
    throw new Error("vsp-script-run requires target openvsp.");
  }
  if (!hasConfiguredOpenVsp(settings)) {
    throw new Error("OpenVSP script execution requires an enabled command and an existing configured script path.");
  }
  const config = openVspConfig(settings);
  if (!config.runArgsTemplate.length) {
    throw new Error("OpenVSP runArgsTemplate is not configured; AetherOps will not invent OpenVSP command arguments.");
  }
  if (!config.runArgsTemplate.some((arg) => arg.includes("{script}"))) {
    throw new Error("OpenVSP runArgsTemplate must include {script}; AetherOps will not run an implicit OpenVSP script.");
  }
  const scriptPath = validateOpenVspScriptPath(config.scriptPath);
  const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-openvsp-"));
  const outputFileName = safeOutputFileName(request.outputFileName, "openvsp-script-output.json");
  const outputPath = join(tempRoot, outputFileName);
  const cwd = normalizeWorkingDirectory(config.workingDirectory);
  const args = renderScriptedToolArgs(config.runArgsTemplate, { scriptPath, outputPath, workingDirectory: cwd });

  try {
    const result = await runCommandWithArgs(config.command as string, args, config.timeoutMs, cwd);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`OpenVSP-compatible command exited unsuccessfully: exitCode=${result.exitCode}, timedOut=${result.timedOut}, stderr=${result.stderrExcerpt}`);
    }
    const outputTextExcerpt = existsSync(outputPath) ? excerpt(readFileSync(outputPath, "utf8")) : undefined;
    return {
      target: "openvsp",
      command: config.command as string,
      args,
      scriptPath,
      workingDirectory: cwd,
      outputFileName,
      outputTextExcerpt,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdoutExcerpt: result.stdoutExcerpt,
      stderrExcerpt: result.stderrExcerpt
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runCommercialCfdAdapter(request: EngineeringProgramRequest, settings: AppSettings): Promise<CommercialCfdRunSummary> {
  if (request.target !== "flightstream" && request.target !== "starccm") {
    throw new Error("commercial-cfd-run requires target flightstream or starccm.");
  }
  const adapter = commercialAdapterConfig(settings, request.target);
  if (!hasConfiguredCommercialAdapter(settings, request.target)) {
    throw new Error(`${adapter.label} execution adapter requires enabled license flag and command.`);
  }
  if (!adapter.runArgsTemplate.length) {
    throw new Error(`${adapter.label} runArgsTemplate is not configured; AetherOps will not invent commercial CFD command arguments.`);
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-commercial-cfd-"));
  const outputFileName = safeOutputFileName(request.outputFileName, `${request.target}-run-output.txt`);
  const outputPath = join(tempRoot, outputFileName);
  const inputArtifactPath = request.artifactPath ? resolveCommercialInputPath(request.artifactPath, settings) : undefined;
  const args = renderAdapterArgs(adapter.runArgsTemplate, { inputArtifactPath, outputPath, workingDirectory: adapter.workingDirectory });

  try {
    const result = await runCommandWithArgs(adapter.command as string, args, adapter.timeoutMs, adapter.workingDirectory);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`${adapter.label} adapter exited unsuccessfully: exitCode=${result.exitCode}, timedOut=${result.timedOut}, stderr=${result.stderrExcerpt}`);
    }
    const outputTextExcerpt = existsSync(outputPath) ? excerpt(readFileSync(outputPath, "utf8")) : undefined;
    return {
      target: request.target,
      label: adapter.label,
      command: adapter.command as string,
      args,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      inputArtifactPath,
      outputFileName,
      outputTextExcerpt,
      stdoutExcerpt: result.stdoutExcerpt,
      stderrExcerpt: result.stderrExcerpt
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function resolveCommercialInputPath(artifactPath: string, settings: AppSettings): string {
  if (!hasConfiguredModelingRoot(settings)) {
    throw new Error("commercial-cfd-run artifactPath requires a configured modeling artifact root.");
  }
  const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot as string);
  const targetPath = resolveInsideRoot(artifactRoot, artifactPath);
  if (!existsSync(targetPath)) {
    throw new Error(`Commercial CFD input artifact does not exist under configured root: ${artifactPath}`);
  }
  const stats = statSync(targetPath);
  if (!stats.isFile()) {
    throw new Error(`Commercial CFD input artifact is not a file: ${artifactPath}`);
  }
  if (stats.size > settings.engineeringTools.modeling.maxMeshBytes) {
    throw new Error(`Commercial CFD input artifact exceeds maxMeshBytes (${stats.size} > ${settings.engineeringTools.modeling.maxMeshBytes}).`);
  }
  return targetPath;
}

function renderAdapterArgs(
  template: string[],
  values: { inputArtifactPath?: string; outputPath: string; workingDirectory?: string }
): string[] {
  const args: string[] = [];
  for (const arg of template) {
    if (arg.includes("{input}") && !values.inputArtifactPath) {
      throw new Error("Adapter args template requires {input}, but no artifactPath was provided.");
    }
    args.push(
      arg
        .replaceAll("{input}", values.inputArtifactPath ?? "")
        .replaceAll("{output}", values.outputPath)
        .replaceAll("{workdir}", values.workingDirectory ?? "")
    );
  }
  return args;
}

function renderOpenFoamArgs(
  template: string[],
  values: { caseRoot: string; outputPath: string; workingDirectory?: string }
): string[] {
  const args: string[] = [];
  for (const arg of template) {
    args.push(
      arg
        .replaceAll("{case}", values.caseRoot)
        .replaceAll("{output}", values.outputPath)
        .replaceAll("{workdir}", values.workingDirectory ?? "")
    );
  }
  return args;
}

function renderSu2Args(
  template: string[],
  values: { caseRoot: string; configPath: string; outputPath: string; workingDirectory?: string }
): string[] {
  const args: string[] = [];
  for (const arg of template) {
    args.push(
      arg
        .replaceAll("{case}", values.caseRoot)
        .replaceAll("{config}", values.configPath)
        .replaceAll("{output}", values.outputPath)
        .replaceAll("{workdir}", values.workingDirectory ?? "")
    );
  }
  return args;
}

function renderScriptedToolArgs(
  template: string[],
  values: { scriptPath: string; outputPath: string; workingDirectory?: string }
): string[] {
  const args: string[] = [];
  for (const arg of template) {
    args.push(
      arg
        .replaceAll("{script}", values.scriptPath)
        .replaceAll("{output}", values.outputPath)
        .replaceAll("{workdir}", values.workingDirectory ?? "")
    );
  }
  return args;
}

function probeCommercialAdapter(adapter: CommercialAdapterConfig): Promise<CommandProbeResult> {
  return runCommandWithArgs(adapter.command as string, adapter.probeArgs, Math.min(adapter.timeoutMs, 60_000), adapter.workingDirectory);
}

function probeOpenFoam(config: OpenFoamConfig): Promise<CommandProbeResult> {
  return runCommandWithArgs(config.command as string, config.probeArgs, Math.min(config.timeoutMs, 60_000), config.workingDirectory);
}

function probeSu2(config: Su2Config): Promise<CommandProbeResult> {
  return runCommandWithArgs(config.command as string, config.probeArgs, Math.min(config.timeoutMs, 60_000), config.workingDirectory);
}

function probeFreeCad(config: FreeCadConfig): Promise<CommandProbeResult> {
  return runCommandWithArgs(config.command as string, config.probeArgs, Math.min(config.timeoutMs, 60_000), config.workingDirectory);
}

function probeOpenVsp(config: OpenVspConfig): Promise<CommandProbeResult> {
  return runCommandWithArgs(config.command as string, config.probeArgs, Math.min(config.timeoutMs, 60_000), config.workingDirectory);
}

function validateOpenFoamCaseRoot(caseRoot: string | undefined): string {
  if (!caseRoot?.trim()) {
    throw new Error("OpenFOAM case root is not configured.");
  }
  const resolved = resolve(caseRoot);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Configured OpenFOAM case root does not exist: ${resolved}`);
  }
  const controlDict = join(resolved, "system", "controlDict");
  if (!existsSync(controlDict) || !statSync(controlDict).isFile()) {
    throw new Error(`Configured OpenFOAM case root is missing system/controlDict: ${resolved}`);
  }
  return resolved;
}

function validateSu2CaseConfig(caseRoot: string | undefined, configFile: string | undefined): { caseRoot: string; configPath: string } {
  if (!caseRoot?.trim()) {
    throw new Error("SU2 case root is not configured.");
  }
  if (!configFile?.trim()) {
    throw new Error("SU2 case config file is not configured.");
  }
  const resolvedRoot = resolve(caseRoot);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Configured SU2 case root does not exist: ${resolvedRoot}`);
  }
  const configuredFile = configFile.trim();
  const configPath = resolveInsideRoot(resolvedRoot, configuredFile);
  if (!existsSync(configPath) || !statSync(configPath).isFile()) {
    throw new Error(`Configured SU2 case config does not exist under case root: ${configuredFile}`);
  }
  if (extname(configPath).toLowerCase() !== ".cfg") {
    throw new Error(`Configured SU2 case config must be a .cfg file: ${configuredFile}`);
  }
  return { caseRoot: resolvedRoot, configPath };
}

function validateFreeCadScriptPath(scriptPath: string | undefined): string {
  if (!scriptPath?.trim()) {
    throw new Error("FreeCAD script path is not configured.");
  }
  const resolved = resolve(scriptPath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`Configured FreeCAD script path does not exist: ${resolved}`);
  }
  return resolved;
}

function validateOpenVspScriptPath(scriptPath: string | undefined): string {
  if (!scriptPath?.trim()) {
    throw new Error("OpenVSP script path is not configured.");
  }
  const resolved = resolve(scriptPath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`Configured OpenVSP script path does not exist: ${resolved}`);
  }
  return resolved;
}

function xfoilAirfoilInput(request: EngineeringProgramRequest, settings: AppSettings): { command: string; label: string } {
  const naca = request.naca?.trim();
  if (naca) {
    if (!/^\d{4,5}$/.test(naca)) {
      throw new Error("XFOIL NACA request must be a 4 or 5 digit series code.");
    }
    return { command: `NACA ${naca}`, label: `NACA ${naca}` };
  }
  if (!request.artifactPath?.trim()) {
    throw new Error("XFOIL polar execution requires either naca or artifactPath.");
  }
  if (!hasConfiguredModelingRoot(settings)) {
    throw new Error("XFOIL coordinate-file execution requires a configured modeling artifact root.");
  }
  const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot as string);
  const targetPath = resolveInsideRoot(artifactRoot, request.artifactPath);
  if (!existsSync(targetPath)) {
    throw new Error(`XFOIL airfoil coordinate file does not exist under configured root: ${request.artifactPath}`);
  }
  const stats = statSync(targetPath);
  if (!stats.isFile()) {
    throw new Error(`XFOIL airfoil coordinate path is not a file: ${request.artifactPath}`);
  }
  if (stats.size > settings.engineeringTools.modeling.maxMeshBytes) {
    throw new Error(`XFOIL airfoil coordinate file exceeds maxMeshBytes (${stats.size} > ${settings.engineeringTools.modeling.maxMeshBytes}).`);
  }
  return { command: `LOAD ${targetPath}\n${basename(targetPath, extname(targetPath))}\nPANE`, label: basename(targetPath) };
}

async function resolveWasmAirfoilInput(request: EngineeringProgramRequest, settings: AppSettings, input: OpenCodeRunInput): Promise<AirfoilCoordinateInput> {
  if (request.artifactPath?.trim()) {
    if (!hasConfiguredModelingRoot(settings)) {
      throw new Error("XFOIL WebAssembly coordinate-file execution requires a configured modeling artifact root.");
    }
    const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot as string);
    const targetPath = resolveInsideRoot(artifactRoot, request.artifactPath.trim());
    if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
      throw new Error(`XFOIL WebAssembly airfoil coordinate file does not exist under configured root: ${request.artifactPath}`);
    }
    const stats = statSync(targetPath);
    if (stats.size > settings.engineeringTools.modeling.maxMeshBytes) {
      throw new Error(`XFOIL WebAssembly airfoil coordinate file exceeds maxMeshBytes (${stats.size} > ${settings.engineeringTools.modeling.maxMeshBytes}).`);
    }
    const text = readFileSync(targetPath, "utf8");
    validateAirfoilCoordinateText(text);
    return {
      text,
      label: basename(targetPath, extname(targetPath)),
      sourceKind: "artifact",
      sourceArtifactPath: request.artifactPath.trim()
    };
  }

  const sourceUrl = request.sourceUrl?.trim();
  if (sourceUrl) {
    const fetchedSource = findFetchedAirfoilSource(input, sourceUrl);
    if (fetchedSource) return fetchedSource;
    if (!input.project.autonomyPolicy.allowExternalSearch || !settings.allowExternalSearch) {
      throw new Error("XFOIL WebAssembly sourceUrl execution requires WebFetchTool-provided rawText or external search permission for direct coordinate fetch.");
    }
    const text = await fetchAirfoilCoordinateText(sourceUrl);
    validateAirfoilCoordinateText(text);
    return {
      text,
      label: airfoilLabelFromUrl(sourceUrl),
      sourceKind: "direct-url",
      sourceUrl
    };
  }

  const discoveredSource = findFetchedAirfoilSource(input);
  if (discoveredSource) return discoveredSource;

  const naca = request.naca?.trim();
  if (naca) {
    if (!/^\d{4,5}$/.test(naca)) {
      throw new Error("XFOIL WebAssembly NACA request must be a 4 or 5 digit series code.");
    }
    return {
      label: `NACA ${naca}`,
      sourceKind: "naca"
    };
  }

  throw new Error("XFOIL WebAssembly polar execution requires naca, artifactPath, sourceUrl, or a fetched airfoil coordinate source.");
}

function findFetchedAirfoilSource(input: OpenCodeRunInput, sourceUrl?: string): AirfoilCoordinateInput | undefined {
  const requestedUrl = sourceUrl ? normalizeUrlForCompare(sourceUrl) : undefined;
  for (const source of input.sources ?? []) {
    const url = typeof source.url === "string" ? source.url : "";
    if (requestedUrl && normalizeUrlForCompare(url) !== requestedUrl) continue;
    const rawText = source.metadata && typeof source.metadata.rawText === "string" ? source.metadata.rawText : "";
    if (!rawText) continue;
    try {
      validateAirfoilCoordinateText(rawText);
      return {
        text: rawText,
        label: source.title || airfoilLabelFromUrl(url),
        sourceKind: "source",
        sourceUrl: url
      };
    } catch {
      if (requestedUrl) throw new Error(`Fetched source does not contain a valid airfoil coordinate file: ${sourceUrl}`);
    }
  }
  return undefined;
}

export function validateAirfoilCoordinateText(text: string): { pointCount: number; xMin: number; xMax: number; yMin: number; yMax: number } {
  const points: Array<{ x: number; y: number }> = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/[\s,]+/);
    if (parts.length < 2) continue;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Math.abs(x) > 2 || Math.abs(y) > 2) continue;
    points.push({ x, y });
  }
  if (points.length < 10) {
    throw new Error(`Airfoil coordinate file must contain at least 10 finite coordinate pairs; found ${points.length}.`);
  }
  const xValues = points.map((point) => point.x);
  const yValues = points.map((point) => point.y);
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  if (xMax - xMin < 0.01) {
    throw new Error("Airfoil coordinate file does not span a usable chord length.");
  }
  if (yMax - yMin <= 0) {
    throw new Error("Airfoil coordinate file does not contain a usable thickness/camber range.");
  }
  return { pointCount: points.length, xMin, xMax, yMin, yMax };
}

async function fetchAirfoilCoordinateText(sourceUrl: string): Promise<string> {
  assertPublicCoordinateUrl(sourceUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(sourceUrl, { headers: { accept: "text/plain,text/*,*/*" }, signal: controller.signal });
    assertPublicCoordinateUrl(response.url || sourceUrl);
    if (!response.ok) {
      throw new Error(`airfoil coordinate fetch failed for ${sourceUrl}: ${response.status} ${response.statusText}`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
      throw new Error(`airfoil coordinate content-length exceeds 2MB for ${sourceUrl}`);
    }
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) {
      throw new Error(`airfoil coordinate response exceeds 2MB for ${sourceUrl}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function assertPublicCoordinateUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid airfoil coordinate URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported airfoil coordinate URL protocol: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error(`blocked internal airfoil coordinate hostname: ${parsed.hostname}`);
  }
  if (isPrivateIpv4(hostname) || hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80")) {
    throw new Error(`blocked internal airfoil coordinate IP address: ${parsed.hostname}`);
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || !parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
}

function normalizeUrlForCompare(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

function airfoilLabelFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const file = basename(parsed.pathname) || parsed.hostname;
    return file.replace(/\.[A-Za-z0-9]+$/, "") || "airfoil";
  } catch {
    return "airfoil";
  }
}

function parseXfoilPolarRows(text: string): XfoilPolarRow[] {
  const rows: XfoilPolarRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !/^[+-]?(?:\d+\.?\d*|\.\d+)/.test(trimmed)) continue;
    const values = trimmed.split(/\s+/).map(Number);
    if (values.length < 3 || !values.slice(0, 3).every(Number.isFinite)) continue;
    rows.push({
      alpha: values[0] as number,
      cl: values[1] as number,
      cd: values[2] as number,
      cdp: Number.isFinite(values[3]) ? values[3] : undefined,
      cm: Number.isFinite(values[4]) ? values[4] : undefined,
      topXtr: unitIntervalNumber(values[5]),
      botXtr: unitIntervalNumber(values[6])
    });
  }
  return rows;
}

function unitIntervalNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function resolveInsideRoot(root: string, artifactPath: string): string {
  const candidate = isAbsolute(artifactPath) ? resolve(artifactPath) : resolve(root, artifactPath);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Configured path escapes the allowed root.");
  }
  return candidate;
}

function parseObjMesh(buffer: Buffer, fileName: string): MeshSummary {
  const bounds = createBounds();
  let vertexCount = 0;
  let faceCount = 0;
  let triangleCount = 0;
  for (const line of buffer.toString("utf8").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "v" && parts.length >= 4) {
      const point = toPoint(parts[1], parts[2], parts[3]);
      if (point) {
        vertexCount += 1;
        updateBounds(bounds, point);
      }
      continue;
    }
    if (parts[0] === "f" && parts.length >= 4) {
      const vertices = parts.length - 1;
      faceCount += 1;
      triangleCount += Math.max(1, vertices - 2);
    }
  }
  if (!vertexCount) throw new Error("OBJ mesh contains no finite vertices.");
  return {
    fileName,
    format: "obj",
    byteLength: buffer.byteLength,
    vertexCount,
    faceCount,
    triangleCount,
    boundingBox: finalizeBounds(bounds)
  };
}

function parseStlMesh(buffer: Buffer, fileName: string): MeshSummary {
  const textStart = buffer.subarray(0, Math.min(buffer.byteLength, 1024)).toString("utf8");
  if (/^\s*solid\b/i.test(textStart) && /\bfacet\s+normal\b/i.test(buffer.toString("utf8", 0, Math.min(buffer.byteLength, 8192)))) {
    return parseAsciiStl(buffer, fileName);
  }
  return parseBinaryStl(buffer, fileName);
}

function parseAsciiStl(buffer: Buffer, fileName: string): MeshSummary {
  const bounds = createBounds();
  let vertexCount = 0;
  for (const line of buffer.toString("utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^vertex\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i);
    if (!match) continue;
    const point = toPoint(match[1], match[2], match[3]);
    if (!point) continue;
    vertexCount += 1;
    updateBounds(bounds, point);
  }
  if (!vertexCount || vertexCount % 3 !== 0) throw new Error("ASCII STL mesh has no complete finite triangles.");
  const triangleCount = vertexCount / 3;
  return {
    fileName,
    format: "stl-ascii",
    byteLength: buffer.byteLength,
    vertexCount,
    faceCount: triangleCount,
    triangleCount,
    boundingBox: finalizeBounds(bounds)
  };
}

function parseBinaryStl(buffer: Buffer, fileName: string): MeshSummary {
  if (buffer.byteLength < 84) throw new Error("Binary STL is too small to contain a header and triangle count.");
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const triangleCount = view.getUint32(80, true);
  const expectedBytes = 84 + triangleCount * 50;
  if (expectedBytes > buffer.byteLength) {
    throw new Error(`Binary STL triangle table is truncated (${buffer.byteLength} < ${expectedBytes}).`);
  }
  const bounds = createBounds();
  let vertexCount = 0;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const base = 84 + triangle * 50 + 12;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const offset = base + vertex * 12;
      const point: [number, number, number] = [
        view.getFloat32(offset, true),
        view.getFloat32(offset + 4, true),
        view.getFloat32(offset + 8, true)
      ];
      if (!point.every(Number.isFinite)) throw new Error("Binary STL contains non-finite vertex coordinates.");
      vertexCount += 1;
      updateBounds(bounds, point);
    }
  }
  if (!vertexCount) throw new Error("Binary STL contains no triangles.");
  return {
    fileName,
    format: "stl-binary",
    byteLength: buffer.byteLength,
    vertexCount,
    faceCount: triangleCount,
    triangleCount,
    boundingBox: finalizeBounds(bounds)
  };
}

function probeXfoil(command: string, timeoutMs: number): Promise<CommandProbeResult> {
  return runCommandWithInput(command, "quit\n", timeoutMs);
}

function runCommandWithInput(command: string, inputText: string, timeoutMs: number): Promise<CommandProbeResult> {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(command, [], { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill();
      resolveProbe({ command, exitCode: null, timedOut: true, stdoutExcerpt: excerpt(stdout), stderrExcerpt: excerpt(stderr) });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectProbe(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveProbe({ command, exitCode, timedOut: false, stdoutExcerpt: excerpt(stdout), stderrExcerpt: excerpt(stderr) });
    });
    child.stdin.end(inputText);
  });
}

function runCommandWithArgs(command: string, args: string[], timeoutMs: number, workingDirectory?: string): Promise<CommandProbeResult> {
  return new Promise((resolveProbe, rejectProbe) => {
    const cwd = normalizeWorkingDirectory(workingDirectory);
    const child = spawn(command, args, { shell: false, windowsHide: true, cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill();
      resolveProbe({ command, exitCode: null, timedOut: true, stdoutExcerpt: excerpt(stdout), stderrExcerpt: excerpt(stderr) });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectProbe(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveProbe({ command, exitCode, timedOut: false, stdoutExcerpt: excerpt(stdout), stderrExcerpt: excerpt(stderr) });
    });
  });
}

function normalizeWorkingDirectory(workingDirectory: string | undefined): string | undefined {
  if (!workingDirectory?.trim()) return undefined;
  const resolved = resolve(workingDirectory);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Configured adapter working directory does not exist: ${resolved}`);
  }
  return resolved;
}

function safeOutputFileName(value: string | undefined, defaultValue: string): string {
  const candidate = (value?.trim() || defaultValue).replace(/[^A-Za-z0-9._-]+/g, "-");
  if (!candidate || candidate === "." || candidate === "..") return defaultValue;
  return basename(candidate);
}

function meshSummaryArtifact(input: OpenCodeRunInput, summary: MeshSummary, createdAt: string): ResearchArtifact {
  const safeName = summary.fileName.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "generated_artifact",
    title: `Mesh inspection: ${summary.fileName}`,
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/mesh-inspection-${safeName}.json`,
    mimeType: "application/json",
    summary: `Mesh ${summary.fileName}: ${summary.vertexCount} vertices, ${summary.triangleCount} triangles.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      canSupportHypothesis: false
    },
    createdAt
  };
}

function xfoilPolarArtifact(input: OpenCodeRunInput, summary: XfoilPolarSummary, createdAt: string): ResearchArtifact {
  const safeName = summary.airfoil.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `XFOIL polar: ${summary.airfoil}`,
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/xfoil-polar-${safeName}.json`,
    mimeType: "application/json",
    summary: `XFOIL polar for ${summary.airfoil}: ${summary.rowCount} alpha rows at Re=${summary.reynolds}, Mach=${summary.mach}.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "xfoil",
      canSupportHypothesis: true
    },
    createdAt
  };
}

function xfoilPolarEvidence(input: OpenCodeRunInput, summary: XfoilPolarSummary, createdAt: string): EvidenceItem {
  const previewRows = summary.rows.slice(0, 6).map((row) => `alpha=${row.alpha}, CL=${row.cl}, CD=${row.cd}`);
  return {
    id: createId("evidence"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `XFOIL polar observation: ${summary.airfoil}`,
    summary: `Computed ${summary.rowCount} XFOIL polar rows for ${summary.airfoil}. ${previewRows.join("; ")}`,
    quote: previewRows.join("\n"),
    keywords: ["xfoil", "polar", "cfd", "aerodynamics", "tool_observation"],
    linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
    reliabilityScore: 0.72,
    relevanceScore: 0.74,
    evidenceStrength: "medium",
    limitations: [
      "XFOIL is a low-order aerodynamic solver; check convergence, Reynolds/Mach assumptions, and airfoil geometry before using results for final decisions.",
      "AetherOps records the generated polar rows but does not replace engineering review."
    ],
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "xfoil",
      airfoil: summary.airfoil,
      reynolds: summary.reynolds,
      mach: summary.mach,
      rowCount: summary.rowCount,
      canSupportHypothesis: true,
      sourceQualityTier: "tool_observation"
    },
    createdAt
  };
}

function xfoilWasmPolarArtifact(input: OpenCodeRunInput, summary: XfoilWasmPolarSummary, createdAt: string): ResearchArtifact {
  const safeName = summary.airfoil.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `XFOIL-WASM polar: ${summary.airfoil}`,
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/xfoil-wasm-polar-${safeName}.json`,
    mimeType: "application/json",
    summary: `WebXFOIL polar for ${summary.airfoil}: ${summary.rowCount} alpha rows at Re=${summary.reynolds}, Mach=${summary.mach}.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "xfoil-wasm",
      runtimeLicense: summary.runtimeLicense,
      canSupportHypothesis: true
    },
    createdAt
  };
}

function xfoilWasmPolarEvidence(input: OpenCodeRunInput, summary: XfoilWasmPolarSummary, createdAt: string): EvidenceItem {
  const previewRows = summary.rows.slice(0, 6).map((row) => `alpha=${row.alpha}, CL=${row.cl}, CD=${row.cd}`);
  return {
    id: createId("evidence"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `XFOIL-WASM polar observation: ${summary.airfoil}`,
    summary: `Computed ${summary.rowCount} WebXFOIL polar rows for ${summary.airfoil}. ${previewRows.join("; ")}`,
    quote: previewRows.join("\n"),
    keywords: ["xfoil", "wasm", "polar", "cfd", "aerodynamics", "tool_observation"],
    linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
    reliabilityScore: 0.76,
    relevanceScore: 0.8,
    evidenceStrength: "medium",
    limitations: [
      "WebXFOIL runs the open-source XFOIL solver compiled to WebAssembly; results still depend on XFOIL convergence, Reynolds/Mach assumptions, and input airfoil geometry.",
      "This is a 2D airfoil solver, not an OpenFOAM/SU2 Navier-Stokes CFD field solve.",
      `Runtime license recorded by AetherOps: ${summary.runtimeLicense}.`
    ],
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "xfoil-wasm",
      runtime: summary.runtime,
      runtimeVersion: summary.runtimeVersion,
      runtimeLicense: summary.runtimeLicense,
      airfoil: summary.airfoil,
      sourceKind: summary.sourceKind,
      sourceUrl: summary.sourceUrl,
      sourceArtifactPath: summary.sourceArtifactPath,
      reynolds: summary.reynolds,
      mach: summary.mach,
      rowCount: summary.rowCount,
      canSupportHypothesis: true,
      sourceQualityTier: "tool_observation"
    },
    createdAt
  };
}

function commercialCfdRunArtifact(input: OpenCodeRunInput, summary: CommercialCfdRunSummary, createdAt: string): ResearchArtifact {
  const safeName = `${summary.target}-${summary.outputFileName}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `${summary.label} adapter run`,
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/commercial-cfd-${safeName}.json`,
    mimeType: "application/json",
    summary: `${summary.label} adapter completed with exitCode=${summary.exitCode}.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: summary.target,
      canSupportHypothesis: true
    },
    createdAt
  };
}

function openFoamCaseRunArtifact(input: OpenCodeRunInput, summary: OpenFoamCaseRunSummary, createdAt: string): ResearchArtifact {
  const safeName = `openfoam-${summary.outputFileName}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "experiment_log",
    title: "OpenFOAM case run",
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/${safeName}.json`,
    mimeType: "application/json",
    summary: `OpenFOAM-compatible command completed with exitCode=${summary.exitCode}.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "openfoam",
      canSupportHypothesis: true
    },
    createdAt
  };
}

function su2CaseRunArtifact(input: OpenCodeRunInput, summary: Su2CaseRunSummary, createdAt: string): ResearchArtifact {
  const safeName = `su2-${summary.outputFileName}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "experiment_log",
    title: "SU2 case run",
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/${safeName}.json`,
    mimeType: "application/json",
    summary: `SU2-compatible command completed with exitCode=${summary.exitCode}.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "su2",
      canSupportHypothesis: true
    },
    createdAt
  };
}

function freeCadScriptRunArtifact(input: OpenCodeRunInput, summary: FreeCadScriptRunSummary, createdAt: string): ResearchArtifact {
  const safeName = `freecad-${summary.outputFileName}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "experiment_log",
    title: "FreeCAD script run",
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/${safeName}.json`,
    mimeType: "application/json",
    summary: `FreeCAD-compatible headless command completed with exitCode=${summary.exitCode}.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "freecad",
      canSupportHypothesis: true
    },
    createdAt
  };
}

function openVspScriptRunArtifact(input: OpenCodeRunInput, summary: OpenVspScriptRunSummary, createdAt: string): ResearchArtifact {
  const safeName = `openvsp-${summary.outputFileName}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "experiment_log",
    title: "OpenVSP script run",
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/${safeName}.json`,
    mimeType: "application/json",
    summary: `OpenVSP-compatible headless command completed with exitCode=${summary.exitCode}.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "openvsp",
      canSupportHypothesis: true
    },
    createdAt
  };
}

function commercialCfdRunEvidence(input: OpenCodeRunInput, summary: CommercialCfdRunSummary, createdAt: string): EvidenceItem {
  return {
    id: createId("evidence"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `${summary.label} tool observation`,
    summary: summary.outputTextExcerpt || summary.stdoutExcerpt || `${summary.label} adapter completed without captured output text.`,
    quote: summary.outputTextExcerpt || summary.stdoutExcerpt,
    keywords: [summary.target, "commercial_cfd", "adapter_run", "tool_observation"],
    linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
    reliabilityScore: 0.7,
    relevanceScore: 0.72,
    evidenceStrength: "medium",
    limitations: [
      "Commercial CFD adapter output depends on the locally configured licensed program, command template, solver settings, and input artifact.",
      "AetherOps records the adapter run and captured output but does not independently validate solver setup."
    ],
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: summary.target,
      command: summary.command,
      exitCode: summary.exitCode,
      canSupportHypothesis: true,
      sourceQualityTier: "tool_observation"
    },
    createdAt
  };
}

function freeCadScriptRunEvidence(input: OpenCodeRunInput, summary: FreeCadScriptRunSummary, createdAt: string): EvidenceItem {
  return {
    id: createId("evidence"),
    projectId: input.project.id,
    category: "experiment_log",
    title: "FreeCAD tool observation",
    summary: summary.outputTextExcerpt || summary.stdoutExcerpt || "FreeCAD-compatible command completed without captured output text.",
    quote: summary.outputTextExcerpt || summary.stdoutExcerpt,
    keywords: ["freecad", "cad", "modeling", "script_run", "tool_observation"],
    linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
    reliabilityScore: 0.7,
    relevanceScore: 0.72,
    evidenceStrength: "medium",
    limitations: [
      "FreeCAD results depend on the locally configured command, script, workbench availability, geometry units, and script validation.",
      "AetherOps records the run and captured output but does not independently validate CAD model correctness."
    ],
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "freecad",
      command: summary.command,
      scriptPath: summary.scriptPath,
      exitCode: summary.exitCode,
      canSupportHypothesis: true,
      sourceQualityTier: "tool_observation"
    },
    createdAt
  };
}

function openVspScriptRunEvidence(input: OpenCodeRunInput, summary: OpenVspScriptRunSummary, createdAt: string): EvidenceItem {
  return {
    id: createId("evidence"),
    projectId: input.project.id,
    category: "experiment_log",
    title: "OpenVSP tool observation",
    summary: summary.outputTextExcerpt || summary.stdoutExcerpt || "OpenVSP-compatible command completed without captured output text.",
    quote: summary.outputTextExcerpt || summary.stdoutExcerpt,
    keywords: ["openvsp", "cad", "aerodynamics", "script_run", "tool_observation"],
    linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
    reliabilityScore: 0.7,
    relevanceScore: 0.72,
    evidenceStrength: "medium",
    limitations: [
      "OpenVSP results depend on the locally configured command, script, geometry units, analysis setup, and script validation.",
      "AetherOps records the run and captured output but does not independently validate aircraft model correctness."
    ],
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "openvsp",
      command: summary.command,
      scriptPath: summary.scriptPath,
      exitCode: summary.exitCode,
      canSupportHypothesis: true,
      sourceQualityTier: "tool_observation"
    },
    createdAt
  };
}

function openFoamCaseRunEvidence(input: OpenCodeRunInput, summary: OpenFoamCaseRunSummary, createdAt: string): EvidenceItem {
  return {
    id: createId("evidence"),
    projectId: input.project.id,
    category: "experiment_log",
    title: "OpenFOAM tool observation",
    summary: summary.outputTextExcerpt || summary.stdoutExcerpt || "OpenFOAM-compatible command completed without captured output text.",
    quote: summary.outputTextExcerpt || summary.stdoutExcerpt,
    keywords: ["openfoam", "cfd", "case_run", "tool_observation"],
    linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
    reliabilityScore: 0.7,
    relevanceScore: 0.72,
    evidenceStrength: "medium",
    limitations: [
      "OpenFOAM results depend on the locally configured solver command, case setup, mesh, numerical settings, and convergence behavior.",
      "AetherOps records the run and captured output but does not independently validate CFD convergence."
    ],
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "openfoam",
      command: summary.command,
      caseRoot: summary.caseRoot,
      exitCode: summary.exitCode,
      canSupportHypothesis: true,
      sourceQualityTier: "tool_observation"
    },
    createdAt
  };
}

function su2CaseRunEvidence(input: OpenCodeRunInput, summary: Su2CaseRunSummary, createdAt: string): EvidenceItem {
  return {
    id: createId("evidence"),
    projectId: input.project.id,
    category: "experiment_log",
    title: "SU2 tool observation",
    summary: summary.outputTextExcerpt || summary.stdoutExcerpt || "SU2-compatible command completed without captured output text.",
    quote: summary.outputTextExcerpt || summary.stdoutExcerpt,
    keywords: ["su2", "cfd", "case_run", "tool_observation"],
    linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
    reliabilityScore: 0.7,
    relevanceScore: 0.72,
    evidenceStrength: "medium",
    limitations: [
      "SU2 results depend on the locally configured solver command, case config, mesh, numerical settings, and convergence behavior.",
      "AetherOps records the run and captured output but does not independently validate CFD convergence."
    ],
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "su2",
      command: summary.command,
      caseRoot: summary.caseRoot,
      configPath: summary.configPath,
      exitCode: summary.exitCode,
      canSupportHypothesis: true,
      sourceQualityTier: "tool_observation"
    },
    createdAt
  };
}

function hasConfiguredXfoil(settings: AppSettings): boolean {
  return settings.engineeringTools.xfoil.enabled && hasAvailableCommand(settings.engineeringTools.xfoil.command);
}

function hasConfiguredXfoilWasm(settings: AppSettings): boolean {
  return settings.engineeringTools.enabled;
}

function hasConfiguredModelingRoot(settings: AppSettings): boolean {
  if (!settings.engineeringTools.modeling.enabled || !settings.engineeringTools.modeling.artifactRoot?.trim()) return false;
  try {
    const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot);
    return existsSync(artifactRoot) && statSync(artifactRoot).isDirectory();
  } catch {
    return false;
  }
}

function hasConfiguredOpenFoam(settings: AppSettings): boolean {
  if (!settings.engineeringTools.openFoam.enabled || !hasAvailableCommand(settings.engineeringTools.openFoam.command)) return false;
  try {
    validateOpenFoamCaseRoot(settings.engineeringTools.openFoam.caseRoot);
    return true;
  } catch {
    return false;
  }
}

function hasConfiguredSu2(settings: AppSettings): boolean {
  if (!settings.engineeringTools.su2.enabled || !hasAvailableCommand(settings.engineeringTools.su2.command)) return false;
  try {
    validateSu2CaseConfig(settings.engineeringTools.su2.caseRoot, settings.engineeringTools.su2.configFile);
    return true;
  } catch {
    return false;
  }
}

function hasConfiguredFreeCad(settings: AppSettings): boolean {
  if (!settings.engineeringTools.freeCad.enabled || !hasAvailableCommand(settings.engineeringTools.freeCad.command)) return false;
  try {
    validateFreeCadScriptPath(settings.engineeringTools.freeCad.scriptPath);
    return true;
  } catch {
    return false;
  }
}

function hasConfiguredOpenVsp(settings: AppSettings): boolean {
  if (!settings.engineeringTools.openVsp.enabled || !hasAvailableCommand(settings.engineeringTools.openVsp.command)) return false;
  try {
    validateOpenVspScriptPath(settings.engineeringTools.openVsp.scriptPath);
    return true;
  } catch {
    return false;
  }
}

function hasConfiguredCommercialAdapter(settings: AppSettings, target: Extract<EngineeringProgramTarget, "flightstream" | "starccm">): boolean {
  const adapter = commercialAdapterConfig(settings, target);
  const flag = target === "flightstream" ? settings.engineeringTools.commercialCfd.flightStreamConfigured : settings.engineeringTools.commercialCfd.starCcmConfigured;
  return flag && hasAvailableCommand(adapter.command);
}

function hasAvailableCommand(command: string | undefined): boolean {
  const trimmed = command?.trim();
  if (!trimmed) return false;
  const candidate = unquoteCommand(trimmed);
  if (!candidate) return false;

  if (isAbsolute(candidate) || candidate.includes("/") || candidate.includes("\\")) {
    return isExistingFile(resolve(candidate));
  }

  const names = commandLookupNames(candidate);
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    for (const name of names) {
      if (isExistingFile(resolve(entry, name))) return true;
    }
  }
  return false;
}

function commandLookupNames(command: string): string[] {
  if (extname(command)) return [command];
  if (process.platform !== "win32") return [command];
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.startsWith(".") ? extension : `.${extension}`}`)];
}

function unquoteCommand(command: string): string {
  return command.replace(/^["']|["']$/g, "").trim();
}

function isExistingFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function openFoamConfig(settings: AppSettings): OpenFoamConfig {
  return settings.engineeringTools.openFoam;
}

function su2Config(settings: AppSettings): Su2Config {
  return settings.engineeringTools.su2;
}

function freeCadConfig(settings: AppSettings): FreeCadConfig {
  return settings.engineeringTools.freeCad;
}

function openVspConfig(settings: AppSettings): OpenVspConfig {
  return settings.engineeringTools.openVsp;
}

function commercialAdapterConfig(settings: AppSettings, target: Extract<EngineeringProgramTarget, "flightstream" | "starccm">): CommercialAdapterConfig {
  const config = settings.engineeringTools.commercialCfd;
  if (target === "flightstream") {
    return {
      target,
      label: "FlightStream",
      command: config.flightStreamCommand,
      workingDirectory: config.flightStreamWorkingDirectory,
      probeArgs: config.flightStreamProbeArgs,
      runArgsTemplate: config.flightStreamRunArgsTemplate,
      timeoutMs: config.flightStreamTimeoutMs
    };
  }
  return {
    target,
    label: "STAR-CCM+",
    command: config.starCcmCommand,
    workingDirectory: config.starCcmWorkingDirectory,
    probeArgs: config.starCcmProbeArgs,
    runArgsTemplate: config.starCcmRunArgsTemplate,
    timeoutMs: config.starCcmTimeoutMs
  };
}

function normalizeTarget(value: unknown): EngineeringProgramTarget | undefined {
  if (
    value === "all" ||
    value === "xfoil" ||
    value === "xfoil-wasm" ||
    value === "modeling" ||
    value === "openfoam" ||
    value === "su2" ||
    value === "freecad" ||
    value === "openvsp" ||
    value === "flightstream" ||
    value === "starccm"
  ) return value;
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedNumber(value: number | undefined, min: number, max: number, defaultValue: number, label: string): number {
  const resolved = value ?? defaultValue;
  if (!Number.isFinite(resolved) || resolved < min || resolved > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return resolved;
}

function boundedPositiveNumber(value: number | undefined, min: number, max: number, defaultValue: number, label: string): number {
  const resolved = boundedNumber(value, min, max, defaultValue, label);
  if (resolved <= 0 && min > 0) {
    throw new Error(`${label} must be positive.`);
  }
  return resolved;
}

function createBounds(): { min: [number, number, number]; max: [number, number, number] } {
  return {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  };
}

function updateBounds(bounds: { min: [number, number, number]; max: [number, number, number] }, point: [number, number, number]): void {
  for (let index = 0; index < 3; index += 1) {
    bounds.min[index] = Math.min(bounds.min[index], point[index]);
    bounds.max[index] = Math.max(bounds.max[index], point[index]);
  }
}

function finalizeBounds(bounds: { min: [number, number, number]; max: [number, number, number] }): MeshSummary["boundingBox"] {
  if (!bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite)) return undefined;
  return { min: bounds.min, max: bounds.max };
}

function toPoint(x: string | undefined, y: string | undefined, z: string | undefined): [number, number, number] | undefined {
  const point: [number, number, number] = [Number(x), Number(y), Number(z)];
  return point.every(Number.isFinite) ? point : undefined;
}

function excerpt(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 1200);
}

function completedToolRun(input: OpenCodeRunInput, toolName: string, startedAt: string, completedAt: string, toolInput: unknown, output: unknown): ToolRun {
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

function failedToolRun(input: OpenCodeRunInput, toolName: string, startedAt: string, completedAt: string, toolInput: unknown, output: unknown, error: string): ToolRun {
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
