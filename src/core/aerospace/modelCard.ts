import { dimensionsEqual, type DimensionVector } from "./dimensions.js";
import type { EngineeringQuantity } from "./quantity.js";

export type AerospaceDiscipline =
  "systems" | "aerodynamics" | "propulsion" | "performance" | "flight_dynamics" | "controls" | "structures" | "thermal" | "safety" | "uncertainty";
export type ModelUseStatus =
  "accepted_use" | "accepted_with_limits" | "outside_verified_domain" | "outside_validated_domain" | "prohibited_use" | "insufficient_evidence";

export interface ApplicabilityConstraint {
  variableId: string;
  dimension: DimensionVector;
  minimumSI?: number;
  maximumSI?: number;
  configurationBaselineIds?: readonly string[];
}

export interface AerospaceModelCard {
  id: string;
  version: string;
  name: string;
  discipline: AerospaceDiscipline;
  intendedUses: readonly string[];
  permissibleUses: readonly string[];
  prohibitedUses: readonly string[];
  physicalPhenomena: readonly string[];
  abstractions: readonly string[];
  assumptions: readonly string[];
  excludedEffects: readonly string[];
  governingEquationIds: readonly string[];
  tool: { id: string; version: string; sourceCodeHash?: string; environmentHash?: string; numericalMethods: readonly string[] };
  verificationDomain: readonly ApplicabilityConstraint[];
  validationDomain: readonly ApplicabilityConstraint[];
  verificationEvidenceIds: readonly string[];
  validationEvidenceIds: readonly string[];
  dataPedigreeIds: readonly string[];
  knownDefects: readonly string[];
  uncertaintyModelId?: string;
  sensitivityEvidenceIds: readonly string[];
  reviewStatus: "draft" | "technical_review" | "human_accepted" | "rejected";
}

export interface ModelUseAssessment {
  modelCardId: string;
  modelVersion: string;
  proposedUse: string;
  configurationBaselineId: string;
  status: ModelUseStatus;
  violatedLimits: readonly string[];
  placard?: {
    missingEvidence: readonly string[];
    expectedImpact: string;
    prohibitedDecisions: readonly string[];
    requiredAdditionalVerification: readonly string[];
  };
}

export function assessModelUse(input: {
  card: AerospaceModelCard;
  proposedUse: string;
  configurationBaselineId: string;
  variables: Readonly<Record<string, EngineeringQuantity>>;
}): ModelUseAssessment {
  validateModelCard(input.card);
  const normalizedUse = input.proposedUse.trim();
  if (!normalizedUse) throw new Error("Proposed model use is required.");
  if (input.card.prohibitedUses.includes(normalizedUse)) return assessment(input, "prohibited_use", ["proposed use is prohibited"]);
  if (!input.card.permissibleUses.includes(normalizedUse)) return assessment(input, "insufficient_evidence", ["proposed use is not permissible"]);
  const verification = domainViolations(input.card.verificationDomain, input.variables, input.configurationBaselineId);
  const validation = domainViolations(input.card.validationDomain, input.variables, input.configurationBaselineId);
  if (verification.length) return assessment(input, "outside_verified_domain", verification);
  if (validation.length) return assessment(input, "outside_validated_domain", validation);
  if (!input.card.validationEvidenceIds.length) return assessment(input, "accepted_with_limits", ["validation evidence is unavailable"]);
  return assessment(input, "accepted_use", []);
}

export function assertModelResultPromotable(assessmentValue: ModelUseAssessment): void {
  if (assessmentValue.status !== "accepted_use" && assessmentValue.status !== "accepted_with_limits") {
    throw new Error(`Model result cannot be promoted: ${assessmentValue.status}.`);
  }
  if (assessmentValue.status === "accepted_with_limits" && !assessmentValue.placard) throw new Error("Limited model use requires a domain placard.");
}

export function validateModelCard(card: AerospaceModelCard): void {
  if (!card.id || !card.version || !card.name.trim() || !card.tool.id || !card.tool.version)
    throw new Error("Model card identity and implementation are required.");
  if (!card.intendedUses.length || !card.permissibleUses.length) throw new Error("Model card intended and permissible uses are required.");
  if (!card.verificationDomain.length) throw new Error("Model card verification domain is required.");
  if (!card.verificationEvidenceIds.length) throw new Error("Model card verification evidence is required.");
}

function domainViolations(
  constraints: readonly ApplicabilityConstraint[],
  variables: Readonly<Record<string, EngineeringQuantity>>,
  configurationBaselineId: string
): string[] {
  const violations: string[] = [];
  for (const constraint of constraints) {
    const value = variables[constraint.variableId];
    if (!value) {
      violations.push(`${constraint.variableId}: input missing`);
      continue;
    }
    if (!dimensionsEqual(value.dimension, constraint.dimension)) {
      violations.push(`${constraint.variableId}: dimension mismatch`);
      continue;
    }
    if (constraint.minimumSI !== undefined && value.valueSI < constraint.minimumSI)
      violations.push(`${constraint.variableId}: below ${constraint.minimumSI} SI`);
    if (constraint.maximumSI !== undefined && value.valueSI > constraint.maximumSI)
      violations.push(`${constraint.variableId}: above ${constraint.maximumSI} SI`);
    if (constraint.configurationBaselineIds && !constraint.configurationBaselineIds.includes(configurationBaselineId)) {
      violations.push(`${constraint.variableId}: configuration baseline outside domain`);
    }
  }
  return violations;
}

function assessment(
  input: { card: AerospaceModelCard; proposedUse: string; configurationBaselineId: string },
  status: ModelUseStatus,
  violations: string[]
): ModelUseAssessment {
  const needsPlacard = status !== "accepted_use";
  return Object.freeze({
    modelCardId: input.card.id,
    modelVersion: input.card.version,
    proposedUse: input.proposedUse,
    configurationBaselineId: input.configurationBaselineId,
    status,
    violatedLimits: Object.freeze([...violations]),
    ...(needsPlacard
      ? {
          placard: Object.freeze({
            missingEvidence: Object.freeze([...violations]),
            expectedImpact: "Result credibility or applicability may be reduced outside the documented model domain.",
            prohibitedDecisions: Object.freeze(["certification finding", "unreviewed safety decision", "direct hardware action"]),
            requiredAdditionalVerification: Object.freeze(["independent calculation", "domain-specific validation evidence", "human technical review"])
          })
        }
      : {})
  });
}
