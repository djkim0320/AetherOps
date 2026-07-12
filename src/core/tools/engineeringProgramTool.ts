import { nowIso } from "../shared/ids.js";
import type {
  AppSettings,
  EngineeringProgramCapability,
  EngineeringProgramPreflightResult,
  EngineeringProgramTarget,
  ResearchToolInput
} from "../shared/types.js";
import type { ResearchTool, ResearchToolResult } from "./researchToolTypes.js";
export type { MeshSummary } from "./engineeringProgramTypes.js";

export type EngineeringProgramExecutor = (input: ResearchToolInput, settings: AppSettings) => Promise<ResearchToolResult>;

export class EngineeringProgramTool implements ResearchTool {
  readonly name = "EngineeringProgramTool";
  constructor(private readonly execute?: EngineeringProgramExecutor) {}
  async run(input: ResearchToolInput, settings: AppSettings): Promise<ResearchToolResult> {
    if (!input.project.autonomyPolicy.allowCodeExecution || !settings.allowCodeExecution) {
      throw new Error("EngineeringProgramTool requires engineering permission from project and app settings.");
    }
    if (!this.execute) throw new Error("EngineeringProgramTool runtime adapter is not configured.");
    return this.execute(input, settings);
  }
}

export function hasExecutableEngineeringTool(settings: AppSettings): boolean {
  return settings.allowCodeExecution;
}

export function describeEngineeringProgramCapabilities(settings: AppSettings): EngineeringProgramCapability[] {
  const tools = settings.engineeringTools;
  const enabled = tools.enabled;
  const ready = {
    xfoil: enabled && Boolean(tools.xfoil.enabled && tools.xfoil.command?.trim()),
    xfoilWasm: settings.allowCodeExecution,
    modeling: enabled && Boolean(tools.modeling.enabled && tools.modeling.artifactRoot?.trim()),
    su2: enabled && Boolean(tools.su2.enabled && tools.su2.command?.trim() && tools.su2.caseRoot?.trim() && tools.su2.configFile?.trim()),
    openVsp: enabled && Boolean(tools.openVsp.enabled && tools.openVsp.command?.trim()),
    xflr5: enabled && Boolean(tools.xflr5.enabled && tools.xflr5.command?.trim())
  };
  const capabilities: EngineeringProgramCapability[] = [
    capability(
      "toolchain-check",
      "all",
      Object.values(ready).some(Boolean),
      ["kind"],
      ["target", "reason"],
      "Probe configured engineering targets.",
      "No engineering target is configured."
    ),
    capability(
      "mesh-inspect",
      "modeling",
      ready.modeling,
      ["kind", "artifactPath"],
      ["reason"],
      "Inspect a validated project mesh artifact.",
      "Modeling artifact root is not configured."
    ),
    capability(
      "xfoil-polar",
      "xfoil",
      ready.xfoil,
      ["kind", "naca or artifactPath"],
      ["reynolds", "mach", "alphaStart", "alphaEnd", "alphaStep", "reason"],
      "Run the embedded native XFOIL executable.",
      "Embedded XFOIL is not configured."
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
      "SU2 is not configured."
    ),
    capability(
      "openvsp-analysis-run",
      "openvsp",
      ready.openVsp,
      ["kind", "target", "cfdRunSpec"],
      ["outputFileName", "reason"],
      "Run a validated OpenVSP analysis.",
      "OpenVSP is not configured."
    ),
    capability(
      "xflr5-analysis-run",
      "xflr5",
      ready.xflr5,
      ["kind", "target", "cfdRunSpec"],
      ["outputFileName", "reason"],
      "Run a validated XFLR5 analysis.",
      "XFLR5 is not configured."
    )
  ];
  return capabilities.map((item) => (item.ready ? { ...item, blockedReason: undefined } : item));
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
