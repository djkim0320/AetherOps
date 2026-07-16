import { validateConfigurationBaseline, type BaselineAspect, type ConfigurationBaseline } from "./configurationBaseline.js";

export const ENGINEERING_BASELINE_TARGETS = ["codex", "webxfoil", "xfoil", "su2", "openvsp", "xflr5", "mesh"] as const;

export type EngineeringBaselineTarget = (typeof ENGINEERING_BASELINE_TARGETS)[number];

export type EngineeringBaselineCompatibilityIssueCode =
  | "INVALID_BASELINE"
  | "BASELINE_NOT_ACTIVE"
  | "MISSING_BASELINE_ASPECT"
  | "MISSING_SOLVER_VERSION"
  | "AMBIGUOUS_SOLVER_VERSION"
  | "UNSUPPORTED_TARGET"
  | "RUNTIME_RECEIPT_UNSUPPORTED"
  | "RUNTIME_VERSION_UNVERIFIED"
  | "RUNTIME_VERSION_MISMATCH";

export interface EngineeringBaselineCompatibilityIssue {
  code: EngineeringBaselineCompatibilityIssueCode;
  message: string;
  aspect?: BaselineAspect;
}

export interface EngineeringBaselineCompatibilityResult {
  target: string;
  baselineId: string;
  ready: boolean;
  requiredAspects: readonly BaselineAspect[];
  missingAspects: readonly BaselineAspect[];
  solverVersion?: Readonly<{ key: string; version: string }>;
  issues: readonly EngineeringBaselineCompatibilityIssue[];
  reason?: string;
}

interface TargetRequirement {
  requiredAspects: readonly BaselineAspect[];
  solverVersionKeys: readonly string[];
}

const POLAR_ASPECTS = [
  "geometry",
  "airfoil_geometry",
  "aerodynamic_reference",
  "atmosphere",
  "solver",
  "source_revision",
  "unit_convention",
  "coordinate_convention"
] as const satisfies readonly BaselineAspect[];

const REPORT_ASPECTS = [
  "geometry",
  "mass_properties",
  "atmosphere",
  "solver",
  "source_revision",
  "unit_convention",
  "coordinate_convention"
] as const satisfies readonly BaselineAspect[];

const REQUIREMENTS: Readonly<Record<EngineeringBaselineTarget, TargetRequirement>> = Object.freeze({
  codex: requirement(["solver", "source_revision", "unit_convention", "coordinate_convention"], ["codex"]),
  webxfoil: requirement(POLAR_ASPECTS, ["xfoil-wasm", "webxfoil"]),
  xfoil: requirement(POLAR_ASPECTS, ["xfoil"]),
  su2: requirement(REPORT_ASPECTS, ["su2"]),
  openvsp: requirement(REPORT_ASPECTS, ["openvsp"]),
  xflr5: requirement(REPORT_ASPECTS, ["xflr5"]),
  mesh: requirement(["geometry", "material", "solver", "source_revision", "unit_convention", "coordinate_convention"], ["modeling"])
});

export function engineeringBaselineRequirement(target: EngineeringBaselineTarget): TargetRequirement {
  return REQUIREMENTS[target];
}

export function validateEngineeringBaselineCompatibility(
  target: EngineeringBaselineTarget,
  baseline: ConfigurationBaseline
): EngineeringBaselineCompatibilityResult {
  const requirement = REQUIREMENTS[target];
  if (!requirement) {
    return result(
      String(target),
      baseline.id,
      [],
      [],
      [{ code: "UNSUPPORTED_TARGET", message: `Engineering target ${String(target)} has no configuration baseline policy.` }]
    );
  }

  try {
    validateConfigurationBaseline(baseline);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return result(
      target,
      baseline.id,
      requirement.requiredAspects,
      [],
      [{ code: "INVALID_BASELINE", message: `Configuration baseline ${baseline.id || "<unknown>"} is invalid: ${detail}` }]
    );
  }

  const issues: EngineeringBaselineCompatibilityIssue[] = [];
  if (baseline.status !== "active") {
    issues.push({ code: "BASELINE_NOT_ACTIVE", message: `Configuration baseline ${baseline.id} is ${baseline.status}, not active.` });
  }

  const solver = resolveSolverVersion(baseline, requirement.solverVersionKeys, issues);
  const missingAspects = requirement.requiredAspects.filter((aspect) => !aspectAvailable(baseline, aspect, solver));
  for (const aspect of missingAspects) {
    if (aspect === "solver") continue;
    issues.push({ code: "MISSING_BASELINE_ASPECT", aspect, message: `Configuration baseline ${baseline.id} is missing required aspect ${aspect}.` });
  }

  return result(target, baseline.id, requirement.requiredAspects, missingAspects, issues, solver);
}

export function engineeringPromotionRuntimeReceiptSupport(target: string): { supported: boolean; reason?: string } {
  if (target === "codex" || target === "webxfoil") return { supported: true };
  return {
    supported: false,
    reason: `${target} is NOT_READY because AetherOps cannot yet verify its exact runtime-version receipt for durable promotion.`
  };
}

export function validateEngineeringPromotionReadiness(
  target: EngineeringBaselineTarget,
  baseline: ConfigurationBaseline,
  expectedRuntimeVersion?: string
): EngineeringBaselineCompatibilityResult {
  const compatibility = validateEngineeringBaselineCompatibility(target, baseline);
  const issues = [...compatibility.issues];
  const support = engineeringPromotionRuntimeReceiptSupport(target);
  if (!support.supported) {
    issues.push({ code: "RUNTIME_RECEIPT_UNSUPPORTED", message: support.reason! });
  } else if (!expectedRuntimeVersion?.trim()) {
    issues.push({
      code: "RUNTIME_VERSION_UNVERIFIED",
      aspect: "solver",
      message: `${target} is NOT_READY because its pinned runtime version was not supplied for verification.`
    });
  } else if (compatibility.solverVersion && compatibility.solverVersion.version !== expectedRuntimeVersion.trim()) {
    issues.push({
      code: "RUNTIME_VERSION_MISMATCH",
      aspect: "solver",
      message: `Configuration baseline ${baseline.id} declares ${target} ${compatibility.solverVersion.version}, but the pinned runtime is ${expectedRuntimeVersion.trim()}.`
    });
  }
  return result(
    compatibility.target,
    compatibility.baselineId,
    compatibility.requiredAspects,
    compatibility.missingAspects,
    issues,
    compatibility.solverVersion
  );
}

function resolveSolverVersion(
  baseline: ConfigurationBaseline,
  keys: readonly string[],
  issues: EngineeringBaselineCompatibilityIssue[]
): Readonly<{ key: string; version: string }> | undefined {
  const available = keys.flatMap((key) => {
    const version = baseline.solverVersions[key]?.trim();
    return version ? [{ key, version }] : [];
  });
  if (!available.length) {
    issues.push({
      code: "MISSING_SOLVER_VERSION",
      aspect: "solver",
      message: `Configuration baseline ${baseline.id} is missing solver version ${keys.join(" or ")}.`
    });
    return undefined;
  }
  if (new Set(available.map((entry) => entry.version)).size > 1) {
    issues.push({
      code: "AMBIGUOUS_SOLVER_VERSION",
      aspect: "solver",
      message: `Configuration baseline ${baseline.id} has conflicting solver versions for ${keys.join(" and ")}.`
    });
    return undefined;
  }
  return Object.freeze(available[0]!);
}

function aspectAvailable(baseline: ConfigurationBaseline, aspect: BaselineAspect, solver: Readonly<{ key: string; version: string }> | undefined): boolean {
  switch (aspect) {
    case "geometry":
      return Boolean(baseline.geometryHash);
    case "airfoil_geometry":
      return Boolean(baseline.airfoilGeometryHash);
    case "aerodynamic_reference":
      return Boolean(baseline.aerodynamicReference);
    case "mass_properties":
      return Boolean(baseline.massProperties || baseline.massPropertiesHash);
    case "atmosphere":
      return Boolean(baseline.atmosphereModelId?.trim());
    case "propulsion":
      return Boolean(baseline.propulsionModelId?.trim());
    case "unit_convention":
      return Boolean(baseline.unitConventionId.trim());
    case "coordinate_convention":
      return Boolean(baseline.coordinateConventionId.trim());
    case "solver":
      return Boolean(solver);
    case "material":
      return baseline.materialRevisionIds.length > 0;
    case "source_revision":
      return baseline.sourceRevisionIds.length > 0 && baseline.provenance.length > 0;
    case "equation":
      return baseline.equationVersionIds.length > 0;
  }
}

function requirement(requiredAspects: readonly BaselineAspect[], solverVersionKeys: readonly string[]): TargetRequirement {
  return Object.freeze({ requiredAspects: Object.freeze([...requiredAspects]), solverVersionKeys: Object.freeze([...solverVersionKeys]) });
}

function result(
  target: string,
  baselineId: string,
  requiredAspects: readonly BaselineAspect[],
  missingAspects: readonly BaselineAspect[],
  issues: readonly EngineeringBaselineCompatibilityIssue[],
  solverVersion?: Readonly<{ key: string; version: string }>
): EngineeringBaselineCompatibilityResult {
  const frozenIssues = Object.freeze([...issues]);
  return Object.freeze({
    target,
    baselineId,
    ready: frozenIssues.length === 0,
    requiredAspects: Object.freeze([...requiredAspects]),
    missingAspects: Object.freeze([...missingAspects]),
    ...(solverVersion ? { solverVersion } : {}),
    issues: frozenIssues,
    ...(frozenIssues.length ? { reason: frozenIssues.map((issue) => issue.message).join(" ") } : {})
  });
}
