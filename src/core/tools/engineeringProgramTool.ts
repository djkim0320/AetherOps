import { nowIso } from "../shared/ids.js";
import { engineeringPromotionRuntimeReceiptSupport, type EngineeringBaselineTarget } from "../aerospace/engineeringBaselineCompatibility.js";
import type {
  AppSettings,
  EngineeringProgramRequest,
  EngineeringProgramCapability,
  EngineeringProgramPreflightResult,
  EngineeringProgramTarget,
  ResearchToolInput
} from "../shared/types.js";
import type { ResearchTool, ResearchToolExecutionContext, ResearchToolResult } from "./researchToolTypes.js";
export type { MeshSummary } from "./engineeringProgramTypes.js";

export function engineeringProgramPromotionTarget(request: EngineeringProgramRequest): EngineeringBaselineTarget | "all" {
  switch (request.kind) {
    case "xfoil-wasm-polar":
      return "webxfoil";
    case "xfoil-polar":
      return "xfoil";
    case "su2-case-run":
      return "su2";
    case "openvsp-analysis-run":
      return "openvsp";
    case "xflr5-analysis-run":
      return "xflr5";
    case "mesh-inspect":
      return "mesh";
    case "toolchain-check":
      return request.target === "xfoil-wasm" ? "webxfoil" : request.target === "modeling" ? "mesh" : (request.target ?? "all");
  }
}

export type EngineeringProgramExecutor = (
  input: ResearchToolInput,
  settings: AppSettings,
  context?: Pick<ResearchToolExecutionContext, "signal">
) => Promise<ResearchToolResult>;

export class EngineeringProgramTool implements ResearchTool {
  readonly name = "EngineeringProgramTool";
  constructor(private readonly execute?: EngineeringProgramExecutor) {}
  async run(input: ResearchToolInput, settings: AppSettings, context?: Pick<ResearchToolExecutionContext, "signal">): Promise<ResearchToolResult> {
    if (!input.project.autonomyPolicy.allowCodeExecution || !settings.allowCodeExecution) {
      throw new Error("EngineeringProgramTool requires engineering permission from project and app settings.");
    }
    if (!this.execute) throw new Error("EngineeringProgramTool runtime adapter is not configured.");
    return this.execute(input, settings, context);
  }
}

export function hasExecutableEngineeringTool(settings: AppSettings): boolean {
  return settings.allowCodeExecution;
}

export function describeEngineeringProgramCapabilities(settings: AppSettings): EngineeringProgramCapability[] {
  const tools = settings.engineeringTools;
  const enabled = tools.enabled;
  const runtimeReady = {
    xfoil: enabled && Boolean(tools.xfoil.enabled && tools.xfoil.command?.trim()),
    xfoilWasm: settings.allowCodeExecution,
    modeling: enabled && Boolean(tools.modeling.enabled && tools.modeling.artifactRoot?.trim()),
    su2: enabled && Boolean(tools.su2.enabled && tools.su2.command?.trim() && tools.su2.caseRoot?.trim() && tools.su2.configFile?.trim()),
    openVsp: enabled && Boolean(tools.openVsp.enabled && tools.openVsp.command?.trim()),
    xflr5: enabled && Boolean(tools.xflr5.enabled && tools.xflr5.command?.trim())
  };
  const ready = {
    xfoil: runtimeReady.xfoil && promotionSupported("xfoil"),
    xfoilWasm: runtimeReady.xfoilWasm,
    modeling: runtimeReady.modeling && promotionSupported("mesh"),
    su2: runtimeReady.su2 && promotionSupported("su2"),
    openVsp: runtimeReady.openVsp && promotionSupported("openvsp"),
    xflr5: runtimeReady.xflr5 && promotionSupported("xflr5")
  };
  const capabilities: EngineeringProgramCapability[] = [
    capability(
      "toolchain-check",
      "all",
      false,
      ["kind"],
      ["target", "reason"],
      "Probe configured engineering targets.",
      engineeringPromotionRuntimeReceiptSupport("all").reason ?? "All-target engineering probes are NOT_READY."
    ),
    capability(
      "mesh-inspect",
      "modeling",
      ready.modeling,
      ["kind", "artifactPath"],
      ["reason"],
      "Inspect a validated project mesh artifact.",
      promotionBlockedReason("mesh", runtimeReady.modeling, "Modeling artifact root is not configured.")
    ),
    capability(
      "xfoil-polar",
      "xfoil",
      ready.xfoil,
      ["kind", "naca or artifactPath"],
      ["reynolds", "mach", "alphaStart", "alphaEnd", "alphaStep", "transition", "reason"],
      "Run the embedded native XFOIL executable.",
      promotionBlockedReason("xfoil", runtimeReady.xfoil, "Embedded XFOIL is not configured.")
    ),
    capability(
      "xfoil-wasm-polar",
      "xfoil-wasm",
      ready.xfoilWasm,
      ["kind", "naca or artifactPath or sourceUrl"],
      ["reynolds", "mach", "alphaStart", "alphaEnd", "alphaStep", "reason"],
      "Run the bundled WebXFOIL WebAssembly solver without substituting another solver.",
      "WebXFOIL is unavailable because engineering tools are disabled."
    ),
    capability(
      "su2-case-run",
      "su2",
      ready.su2,
      ["kind", "target", "cfdRunSpec"],
      ["outputFileName", "reason"],
      "Run a validated SU2 case.",
      promotionBlockedReason("su2", runtimeReady.su2, "SU2 is not configured.")
    ),
    capability(
      "openvsp-analysis-run",
      "openvsp",
      ready.openVsp,
      ["kind", "target", "cfdRunSpec"],
      ["outputFileName", "reason"],
      "Run a validated OpenVSP analysis.",
      promotionBlockedReason("openvsp", runtimeReady.openVsp, "OpenVSP is not configured.")
    ),
    capability(
      "xflr5-analysis-run",
      "xflr5",
      ready.xflr5,
      ["kind", "target", "cfdRunSpec"],
      ["outputFileName", "reason"],
      "Run a validated XFLR5 analysis.",
      promotionBlockedReason("xflr5", runtimeReady.xflr5, "XFLR5 is not configured.")
    )
  ];
  return capabilities.map((item) => (item.ready ? { ...item, blockedReason: undefined } : item));
}

function promotionBlockedReason(target: EngineeringBaselineTarget, runtimeReady: boolean, unavailableReason: string): string {
  return runtimeReady ? (engineeringPromotionRuntimeReceiptSupport(target).reason ?? unavailableReason) : unavailableReason;
}

function promotionSupported(target: EngineeringBaselineTarget): boolean {
  return engineeringPromotionRuntimeReceiptSupport(target).supported;
}

function capability(
  kind: EngineeringProgramCapability["kind"],
  target: EngineeringProgramCapability["target"],
  ready: boolean,
  requiredFields: string[],
  optionalFields: string[],
  description: string,
  blockedReason: string
): EngineeringProgramCapability {
  return { kind, target, ready, requiredFields, optionalFields, description, blockedReason };
}

export async function runEngineeringProgramPreflight(settings: AppSettings, target?: EngineeringProgramTarget): Promise<EngineeringProgramPreflightResult> {
  const startedAt = nowIso();
  const capability = describeEngineeringProgramCapabilities(settings).find((item) => !target || item.target === target);
  const completedAt = nowIso();
  if (!capability?.ready)
    return {
      target: target ?? capability?.target ?? "xfoil",
      status: "failed",
      error: capability?.blockedReason ?? "No engineering runtime is configured.",
      startedAt,
      completedAt
    };
  return { target: capability.target, status: "completed", output: { ready: true }, startedAt, completedAt };
}

export function validateAirfoilCoordinateText(text: string): void {
  const points = text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((parts) => parts.length >= 2 && parts.every(Number.isFinite));
  if (points.length < 8) throw new Error("Airfoil coordinate text does not contain enough numeric points.");
}

export function inspectConfiguredMeshArtifact(): never {
  throw new Error("Mesh inspection requires the server runtime adapter.");
}

export type ValidateArtifactCandidateResult = { ready: boolean; validated: boolean; blockedReason?: string };
export function validateArtifactCandidate(
  settings: AppSettings,
  relativePath: string,
  byteLength: number,
  format: "obj" | "stl" | "vsp3" | "airfoil-coordinate"
): ValidateArtifactCandidateResult {
  if (byteLength > settings.engineeringTools.modeling.maxMeshBytes) return { ready: false, validated: false, blockedReason: "Artifact exceeds maxMeshBytes." };
  if (format === "vsp3" && !relativePath.toLowerCase().endsWith(".vsp3"))
    return { ready: false, validated: false, blockedReason: "OpenVSP artifacts must use .vsp3 extension." };
  return { ready: false, validated: false, blockedReason: "Artifact content validation requires the server runtime adapter." };
}
