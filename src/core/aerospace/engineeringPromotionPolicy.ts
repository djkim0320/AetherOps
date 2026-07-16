import { BASELINE_ASPECTS, type AerodynamicReferenceDefinition, type BaselineAspect, type ConfigurationBaseline } from "./configurationBaseline.js";

export const ENGINEERING_RESULT_KINDS = [
  "aerodynamic_coefficient",
  "dimensional_force",
  "dimensional_moment",
  "geometry",
  "polar",
  "performance_metric",
  "simulation_field",
  "engineering_report",
  "generic_scalar"
] as const;

export type EngineeringResultKind = (typeof ENGINEERING_RESULT_KINDS)[number];
export type EngineeringDomainAssessment = "within_declared_domain" | "outside_domain" | "not_assessed";
export type EngineeringConvergence = "converged" | "not_applicable" | "failed";
export type EngineeringPromotionDisposition =
  "quarantined" | "stale" | "outside_domain" | "incomplete_metadata" | "failed_verification" | "lease_lost" | "baseline_mismatch" | "artifact_mismatch";

export interface EngineeringUnitDefinition {
  unit: string;
  dimension: string;
}

export interface EngineeringResultMetadata {
  resultKind: EngineeringResultKind;
  dependencyAspects: readonly BaselineAspect[];
  geometryHash?: string;
  coefficientTypes?: readonly string[];
  unitDefinition?: EngineeringUnitDefinition;
  coordinateFrameId?: string;
  referencePointId?: string;
  modelCardId: string;
  simulationRunReceiptId: string;
  convergence: EngineeringConvergence;
  domainAssessment: EngineeringDomainAssessment;
  sensitivity: "public" | "project" | "private" | "secret";
}

export interface EngineeringContentReceipt {
  sha256: string;
  byteLength: number;
  mediaType: string;
  casLocator: string;
}

export interface EngineeringToolReceipt {
  toolName: string;
  toolVersion: string;
  executionMedia: string;
  postconditionReceiptHash: string;
}

export interface EngineeringPromotionCandidate {
  projectId: string;
  baseline: ConfigurationBaseline;
  baselineDependencyHash: string;
  metadata: EngineeringResultMetadata;
  content: EngineeringContentReceipt;
  tool: EngineeringToolReceipt;
}

/** Durable storage candidate. IDs and hashes are repeated deliberately so the storage worker can
 * verify ownership and optimistic baseline state without trusting caller-side object identity. */
export interface EngineeringResultCandidate {
  schemaVersion: 1;
  projectId: string;
  jobId: string;
  attemptId: string;
  outputLinkId: string;
  outputId: string;
  resultKind: EngineeringResultKind;
  baselineId: string;
  baselineRevision: number;
  baselineContentHash: string;
  baselineDependencyHash: string;
  dependencyAspects: readonly BaselineAspect[];
  geometryHash?: string;
  artifact: EngineeringContentReceipt;
  tool: {
    name: string;
    version: string;
    executionMedia: string;
    receiptHash: string;
  };
  referenceGeometry?: {
    contentHash: string;
  };
  coefficientTypes?: readonly string[];
  unitDefinition?: EngineeringUnitDefinition;
  coordinateFrameId?: string;
  referencePointId?: string;
  modelCardId: string;
  simulationRunReceiptId: string;
  convergence: EngineeringConvergence;
  domainAssessment: "verified" | "not_assessed" | "outside_domain";
  postcondition: "passed" | "not_required" | "failed";
  postconditionReceiptHash?: string;
  sensitivity: "public" | "project" | "private" | "secret";
}

export interface EngineeringPromotionContext {
  projectId: string;
  activeBaseline: ConfigurationBaseline;
  expectedBaselineDependencyHash: string;
  expectedReferenceGeometryHash?: string;
  allowCompatibleBaselineRevision?: boolean;
}

export class EngineeringPromotionPolicyError extends Error {
  readonly name = "EngineeringPromotionPolicyError";

  constructor(
    readonly code: EngineeringPromotionValidationCode,
    readonly disposition: EngineeringPromotionDisposition,
    message: string
  ) {
    super(message);
  }
}

export function assertEngineeringPromotion(candidate: EngineeringResultCandidate, context: EngineeringPromotionContext): void {
  const baselineIdentityMatches =
    candidate.baselineId === context.activeBaseline.id &&
    candidate.baselineRevision === context.activeBaseline.revision &&
    candidate.baselineContentHash === context.activeBaseline.contentHash;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.projectId !== context.projectId ||
    (!baselineIdentityMatches && !context.allowCompatibleBaselineRevision) ||
    candidate.baselineDependencyHash !== context.expectedBaselineDependencyHash
  ) {
    throw new EngineeringPromotionPolicyError(
      "BASELINE_MISMATCH",
      "baseline_mismatch",
      "The engineering result baseline identity is stale or belongs to another project."
    );
  }
  if (candidate.referenceGeometry?.contentHash !== context.expectedReferenceGeometryHash) {
    throw new EngineeringPromotionPolicyError(
      "REFERENCE_GEOMETRY_MISSING",
      "incomplete_metadata",
      "The engineering result reference-geometry receipt does not match the active baseline."
    );
  }
  if (!sha256(candidate.tool.receiptHash)) {
    throw new EngineeringPromotionPolicyError("MODEL_RECEIPT_MISSING", "incomplete_metadata", "The durable tool execution receipt is missing.");
  }
  if (candidate.postcondition !== "passed" || !sha256(candidate.postconditionReceiptHash)) {
    throw new EngineeringPromotionPolicyError("POSTCONDITION_MISSING", "failed_verification", "The durable tool postcondition did not pass.");
  }
  const result = validateEngineeringPromotion({
    projectId: candidate.projectId,
    baseline: context.activeBaseline,
    baselineDependencyHash: candidate.baselineDependencyHash,
    metadata: {
      resultKind: candidate.resultKind,
      dependencyAspects: candidate.dependencyAspects,
      geometryHash: candidate.geometryHash,
      coefficientTypes: candidate.coefficientTypes,
      unitDefinition: candidate.unitDefinition,
      coordinateFrameId: candidate.coordinateFrameId,
      referencePointId: candidate.referencePointId,
      modelCardId: candidate.modelCardId,
      simulationRunReceiptId: candidate.simulationRunReceiptId,
      convergence: candidate.convergence,
      domainAssessment:
        candidate.domainAssessment === "verified"
          ? "within_declared_domain"
          : candidate.domainAssessment === "outside_domain"
            ? "outside_domain"
            : "not_assessed",
      sensitivity: candidate.sensitivity
    },
    content: candidate.artifact,
    tool: {
      toolName: candidate.tool.name,
      toolVersion: candidate.tool.version,
      executionMedia: candidate.tool.executionMedia,
      postconditionReceiptHash: candidate.postconditionReceiptHash as string
    }
  });
  if (!result.ok) throw new EngineeringPromotionPolicyError(result.code, result.disposition, result.diagnostic);
}

export type EngineeringPromotionValidationResult =
  | { ok: true; reference: AerodynamicReferenceDefinition | undefined }
  | {
      ok: false;
      code: EngineeringPromotionValidationCode;
      disposition: EngineeringPromotionDisposition;
      diagnostic: string;
    };

export type EngineeringPromotionValidationCode =
  | "BASELINE_MISSING"
  | "BASELINE_MISMATCH"
  | "ARTIFACT_MISMATCH"
  | "REFERENCE_GEOMETRY_MISSING"
  | "UNIT_DEFINITION_MISSING"
  | "COORDINATE_FRAME_MISSING"
  | "MODEL_RECEIPT_MISSING"
  | "POSTCONDITION_MISSING"
  | "NON_CONVERGED"
  | "OUTSIDE_DOMAIN"
  | "DOMAIN_UNASSESSED"
  | "INVALID_RESULT_METADATA";

export function validateEngineeringPromotion(candidate: EngineeringPromotionCandidate): EngineeringPromotionValidationResult {
  const { baseline, metadata, content, tool } = candidate;
  if (!baseline?.id || baseline.projectId !== candidate.projectId || baseline.status !== "active") {
    return rejected("BASELINE_MISMATCH", "baseline_mismatch", "The result does not reference the active project baseline.");
  }
  if (!sha256(candidate.baselineDependencyHash) || !sha256(baseline.contentHash)) {
    return rejected("BASELINE_MISSING", "incomplete_metadata", "The baseline dependency receipt is incomplete.");
  }
  if (!sha256(content.sha256) || !content.casLocator || !Number.isSafeInteger(content.byteLength) || content.byteLength < 0 || !content.mediaType.trim()) {
    return rejected("ARTIFACT_MISMATCH", "artifact_mismatch", "The promoted content receipt is incomplete or malformed.");
  }
  if (
    !metadata.modelCardId.trim() ||
    !metadata.simulationRunReceiptId.trim() ||
    !tool.toolName.trim() ||
    !tool.toolVersion.trim() ||
    !tool.executionMedia.trim()
  ) {
    return rejected("MODEL_RECEIPT_MISSING", "incomplete_metadata", "The model and tool execution receipts are required.");
  }
  if (!sha256(tool.postconditionReceiptHash)) {
    return rejected("POSTCONDITION_MISSING", "failed_verification", "A verified tool postcondition receipt is required.");
  }
  if (
    !ENGINEERING_RESULT_KINDS.includes(metadata.resultKind) ||
    !["converged", "not_applicable", "failed"].includes(metadata.convergence) ||
    !["within_declared_domain", "outside_domain", "not_assessed"].includes(metadata.domainAssessment) ||
    !["public", "project", "private", "secret"].includes(metadata.sensitivity) ||
    !metadata.dependencyAspects.length ||
    metadata.dependencyAspects.some((aspect) => !BASELINE_ASPECTS.includes(aspect)) ||
    new Set(metadata.dependencyAspects).size !== metadata.dependencyAspects.length
  ) {
    return rejected(
      "INVALID_RESULT_METADATA",
      "incomplete_metadata",
      "Engineering result states and baseline dependencies must be recognized, explicit and unique."
    );
  }
  const requiredAspects = requiredDependencyAspects(metadata.resultKind);
  if (requiredAspects.some((aspect) => !metadata.dependencyAspects.includes(aspect))) {
    return rejected("INVALID_RESULT_METADATA", "incomplete_metadata", "Engineering result baseline dependencies omit a required aspect.");
  }
  if (requiresConvergence(metadata.resultKind) && metadata.convergence !== "converged") {
    return rejected("NON_CONVERGED", "failed_verification", "The engineering result did not demonstrate convergence.");
  }
  if (requiresDomainAssessment(metadata.resultKind)) {
    if (metadata.domainAssessment === "outside_domain") {
      return rejected("OUTSIDE_DOMAIN", "outside_domain", "The engineering result is outside the declared model domain.");
    }
    if (metadata.domainAssessment !== "within_declared_domain") {
      return rejected("DOMAIN_UNASSESSED", "failed_verification", "The engineering result has no verified-domain assessment.");
    }
  }
  if (requiresGeometry(metadata.resultKind)) {
    const expectedGeometryHash = metadata.resultKind === "polar" ? baseline.airfoilGeometryHash : baseline.geometryHash;
    if (!sha256(metadata.geometryHash) || !expectedGeometryHash || metadata.geometryHash !== expectedGeometryHash) {
      return rejected(
        "BASELINE_MISMATCH",
        "baseline_mismatch",
        metadata.resultKind === "polar"
          ? "The polar input geometry hash does not match the active baseline airfoil geometry."
          : "The result geometry hash does not match the active baseline."
      );
    }
  }
  if (requiresUnits(metadata.resultKind) && !validUnitForKind(metadata.resultKind, metadata.unitDefinition)) {
    return rejected("UNIT_DEFINITION_MISSING", "incomplete_metadata", "The result unit or dimension does not match its engineering result kind.");
  }
  if (requiresFrame(metadata.resultKind) && metadata.coordinateFrameId?.trim() !== baseline.coordinateConventionId) {
    return rejected("COORDINATE_FRAME_MISSING", "incomplete_metadata", "The result coordinate frame does not match the active baseline convention.");
  }
  const reference = baseline.aerodynamicReference;
  if (requiresAerodynamicReference(metadata.resultKind)) {
    if (!reference?.area || !(reference.area.valueSI > 0) || !reference.axisConventionId.trim() || !reference.dynamicPressureDefinition.trim()) {
      return rejected("REFERENCE_GEOMETRY_MISSING", "incomplete_metadata", "Aerodynamic coefficients require area, axis and dynamic-pressure references.");
    }
    const coefficients = metadata.coefficientTypes?.map((item) => item.trim().toUpperCase()).filter(Boolean) ?? [];
    if (!coefficients.length) {
      return rejected("REFERENCE_GEOMETRY_MISSING", "incomplete_metadata", "Aerodynamic coefficient types are required.");
    }
    if (coefficients.some((item) => item === "CL" || item === "CD" || item === "CM") && !reference.chord) {
      return rejected("REFERENCE_GEOMETRY_MISSING", "incomplete_metadata", "Section coefficient results require a reference chord.");
    }
    if (coefficients.includes("CM") && !reference.momentReferencePointId?.trim()) {
      return rejected("REFERENCE_GEOMETRY_MISSING", "incomplete_metadata", "Moment coefficients require a moment reference point.");
    }
  }
  if (metadata.resultKind === "dimensional_moment" && !metadata.referencePointId?.trim()) {
    return rejected("REFERENCE_GEOMETRY_MISSING", "incomplete_metadata", "Dimensional moments require a reference point.");
  }
  return { ok: true, reference };
}

function requiresAerodynamicReference(kind: EngineeringResultKind): boolean {
  return kind === "aerodynamic_coefficient" || kind === "polar";
}

function requiresGeometry(kind: EngineeringResultKind): boolean {
  return ["aerodynamic_coefficient", "dimensional_force", "dimensional_moment", "polar", "performance_metric", "simulation_field"].includes(kind);
}

function requiresUnits(kind: EngineeringResultKind): boolean {
  return [
    "aerodynamic_coefficient",
    "polar",
    "dimensional_force",
    "dimensional_moment",
    "geometry",
    "performance_metric",
    "simulation_field",
    "generic_scalar"
  ].includes(kind);
}

function requiresFrame(kind: EngineeringResultKind): boolean {
  return ["dimensional_force", "dimensional_moment", "geometry", "simulation_field"].includes(kind);
}

function requiresConvergence(kind: EngineeringResultKind): boolean {
  return ["aerodynamic_coefficient", "polar", "performance_metric", "simulation_field"].includes(kind);
}

function requiresDomainAssessment(kind: EngineeringResultKind): boolean {
  return ["aerodynamic_coefficient", "polar", "performance_metric", "simulation_field"].includes(kind);
}

function requiredDependencyAspects(kind: EngineeringResultKind): readonly BaselineAspect[] {
  switch (kind) {
    case "aerodynamic_coefficient":
      return ["geometry", "aerodynamic_reference", "atmosphere", "solver", "source_revision", "unit_convention", "coordinate_convention"];
    case "polar":
      return ["geometry", "airfoil_geometry", "aerodynamic_reference", "atmosphere", "solver", "source_revision", "unit_convention", "coordinate_convention"];
    case "dimensional_force":
    case "dimensional_moment":
      return ["geometry", "solver", "unit_convention", "coordinate_convention"];
    case "geometry":
      return ["source_revision", "unit_convention", "coordinate_convention"];
    case "performance_metric":
    case "simulation_field":
      return ["geometry", "atmosphere", "solver", "unit_convention", "coordinate_convention"];
    case "engineering_report":
      return ["solver", "source_revision", "unit_convention", "coordinate_convention"];
    case "generic_scalar":
      return ["source_revision", "unit_convention"];
  }
}

function validUnitForKind(kind: EngineeringResultKind, value: EngineeringUnitDefinition | undefined): boolean {
  if (!value?.unit.trim() || !value.dimension.trim()) return false;
  if (kind === "aerodynamic_coefficient" || kind === "polar") return value.unit === "1" && value.dimension === "dimensionless";
  if (kind === "dimensional_force") return value.dimension === "mass length time^-2";
  if (kind === "dimensional_moment") return value.dimension === "mass length^2 time^-2";
  if (kind === "geometry") return value.dimension === "length";
  return true;
}

function sha256(value: string | undefined): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function rejected(
  code: EngineeringPromotionValidationCode,
  disposition: EngineeringPromotionDisposition,
  diagnostic: string
): EngineeringPromotionValidationResult {
  return { ok: false, code, disposition, diagnostic };
}
