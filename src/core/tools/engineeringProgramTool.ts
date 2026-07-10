import { nowIso } from "../shared/ids.js";
import type {
  AppSettings,
  EngineeringProgramCapability,
  EngineeringProgramPreflightResult,
  EngineeringProgramTarget,
  OpenCodeRunInput
} from "../shared/types.js";
import type { ResearchTool, ResearchToolResult } from "./researchToolTypes.js";
export type { MeshSummary } from "./engineeringProgramTypes.js";

export type EngineeringProgramExecutor = (input: OpenCodeRunInput, settings: AppSettings) => Promise<ResearchToolResult>;

export class EngineeringProgramTool implements ResearchTool {
  readonly name = "EngineeringProgramTool";
  constructor(private readonly execute?: EngineeringProgramExecutor) {}
  async run(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult> {
    if (!input.project.autonomyPolicy.allowCodeExecution || !settings.allowCodeExecution) {
      throw new Error("EngineeringProgramTool requires engineering permission from project and app settings.");
    }
    if (!this.execute) throw new Error("EngineeringProgramTool runtime adapter is not configured.");
    return this.execute(input, settings);
  }
}

export function hasExecutableEngineeringTool(settings: AppSettings): boolean {
  const tools = settings.engineeringTools;
  if (!tools.enabled) return false;
  return Boolean(
    (tools.xfoil.enabled && tools.xfoil.command?.trim()) ||
    (tools.modeling.enabled && tools.modeling.artifactRoot?.trim()) ||
    (tools.su2.enabled && tools.su2.command?.trim()) ||
    (tools.openVsp.enabled && tools.openVsp.command?.trim()) ||
    (tools.xflr5.enabled && tools.xflr5.command?.trim())
  );
}

export function describeEngineeringProgramCapabilities(settings: AppSettings): EngineeringProgramCapability[] {
  const targets: Array<[EngineeringProgramCapability["kind"], EngineeringProgramTarget, boolean]> = [
    ["xfoil-polar", "xfoil", Boolean(settings.engineeringTools.xfoil.enabled && settings.engineeringTools.xfoil.command?.trim())],
    ["mesh-inspect", "modeling", Boolean(settings.engineeringTools.modeling.enabled && settings.engineeringTools.modeling.artifactRoot?.trim())],
    ["su2-case-run", "su2", Boolean(settings.engineeringTools.su2.enabled && settings.engineeringTools.su2.command?.trim())],
    ["openvsp-analysis-run", "openvsp", Boolean(settings.engineeringTools.openVsp.enabled && settings.engineeringTools.openVsp.command?.trim())],
    ["xflr5-analysis-run", "xflr5", Boolean(settings.engineeringTools.xflr5.enabled && settings.engineeringTools.xflr5.command?.trim())]
  ];
  return targets.map(([kind, target, configured]) => ({
    kind,
    target,
    ready: settings.engineeringTools.enabled && configured,
    requiredFields: [],
    optionalFields: [],
    description: `${target} runtime adapter capability.`,
    blockedReason: settings.engineeringTools.enabled && configured ? undefined : `${target} runtime is not configured.`
  }));
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
