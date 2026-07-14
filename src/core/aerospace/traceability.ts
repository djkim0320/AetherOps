import type { SourceAuthority } from "./studyContract.js";

export type ClaimStatus = "candidate" | "supported" | "contradicted" | "conditionally_supported" | "superseded" | "unverifiable" | "rejected";
export type RequirementStatus =
  "not_assessed" | "candidate_mapping" | "evidence_gap" | "evidence_available" | "human_review_required" | "not_applicable" | "human_accepted";

export interface SourceDocument {
  id: string;
  projectId: string;
  organization: string;
  title: string;
  documentNumber?: string;
  revision: string;
  publicationOrEffectiveDate?: string;
  jurisdiction?: string;
  documentType: string;
  authority: SourceAuthority;
  applicability: string;
  section?: string;
  page?: string;
  stableIdentifier?: string;
  accessDate: string;
  contentHash: string;
  licenseStatus: "public" | "user_supplied_licensed" | "metadata_only" | "restricted" | "unknown";
  supersessionStatus: "current" | "superseded" | "unknown";
  dataClassification: "public" | "proprietary" | "export_controlled" | "unknown";
}

export interface EngineeringRequirement {
  id: string;
  projectId: string;
  revision: number;
  text: string;
  type:
    | "stakeholder"
    | "mission"
    | "functional"
    | "performance"
    | "interface"
    | "environmental"
    | "operational"
    | "safety"
    | "reliability"
    | "maintainability"
    | "software"
    | "hardware"
    | "derived"
    | "constraint";
  sourceIds: readonly string[];
  rationale: string;
  parentRequirementIds: readonly string[];
  allocatedTo?: string;
  configurationBaselineId: string;
  verificationMethod: string;
  verificationLevel: string;
  acceptanceCriteria: string;
  safetyRelevant: boolean;
  status: RequirementStatus;
  evidenceIds: readonly string[];
}

export interface EvidenceClaim {
  id: string;
  projectId: string;
  text: string;
  claimType: string;
  sourceEvidenceIds: readonly string[];
  computedEvidenceIds: readonly string[];
  supportingClaimIds: readonly string[];
  contradictoryClaimIds: readonly string[];
  assumptionIds: readonly string[];
  requirementIds: readonly string[];
  status: ClaimStatus;
  confidence: "low" | "medium" | "high";
  applicability: string;
  responsibleVerifier?: string;
}

export interface TraceabilityAnalysis {
  orphanRequirementIds: readonly string[];
  unverifiedRequirementIds: readonly string[];
  evidenceWithoutRequirementIds: readonly string[];
  unsupportedImportantClaimIds: readonly string[];
  requirementCoverage: Readonly<Record<string, readonly string[]>>;
  reverseEvidenceCoverage: Readonly<Record<string, readonly string[]>>;
}

export function analyzeTraceability(input: {
  requirements: readonly EngineeringRequirement[];
  claims: readonly EvidenceClaim[];
  sources: readonly SourceDocument[];
}): TraceabilityAnalysis {
  assertProjectIsolation(input.requirements, input.claims, input.sources);
  const requirementIds = new Set(input.requirements.map((item) => item.id));
  const claimIds = new Set(input.claims.map((item) => item.id));
  const sourceIds = new Set(input.sources.map((item) => item.id));
  for (const requirement of input.requirements) validateRequirement(requirement, requirementIds, sourceIds);
  for (const claim of input.claims) validateClaim(claim, requirementIds, claimIds, sourceIds);
  const coverage: Record<string, string[]> = Object.fromEntries(input.requirements.map((requirement) => [requirement.id, []]));
  const reverse: Record<string, string[]> = {};
  for (const claim of input.claims) {
    for (const requirementId of claim.requirementIds) coverage[requirementId]?.push(claim.id);
    for (const evidenceId of [...claim.sourceEvidenceIds, ...claim.computedEvidenceIds]) {
      (reverse[evidenceId] ??= []).push(...claim.requirementIds);
    }
  }
  const evidenceWithoutRequirementIds = Object.entries(reverse)
    .filter(([, ids]) => ids.length === 0)
    .map(([id]) => id);
  return Object.freeze({
    orphanRequirementIds: sorted(input.requirements.filter((item) => item.type === "derived" && item.parentRequirementIds.length === 0).map((item) => item.id)),
    unverifiedRequirementIds: sorted(
      input.requirements
        .filter((item) => item.status !== "not_applicable" && item.status !== "human_accepted" && coverage[item.id]?.length === 0)
        .map((item) => item.id)
    ),
    evidenceWithoutRequirementIds: sorted(evidenceWithoutRequirementIds),
    unsupportedImportantClaimIds: sorted(
      input.claims.filter((item) => item.status === "supported" && item.sourceEvidenceIds.length + item.computedEvidenceIds.length === 0).map((item) => item.id)
    ),
    requirementCoverage: freezeRecord(coverage),
    reverseEvidenceCoverage: freezeRecord(reverse)
  });
}

export function transitionRequirementStatus(requirement: EngineeringRequirement, status: RequirementStatus, actor: "agent" | "human"): EngineeringRequirement {
  if (status === "human_accepted" && actor !== "human") throw new Error("Only a human reviewer can accept an engineering requirement.");
  if (status === "evidence_available" && requirement.evidenceIds.length === 0) throw new Error("Evidence-available status requires evidence IDs.");
  return Object.freeze({ ...requirement, revision: requirement.revision + 1, status });
}

export function validateSourceDocument(source: SourceDocument): void {
  for (const [label, value] of [
    ["source id", source.id],
    ["project id", source.projectId],
    ["organization", source.organization],
    ["title", source.title],
    ["revision", source.revision],
    ["applicability", source.applicability]
  ] as const) {
    if (!value.trim()) throw new Error(`Engineering ${label} is required.`);
  }
  if (!/^[a-f0-9]{64}$/i.test(source.contentHash)) throw new Error("Source content hash must be SHA-256.");
  if (!Number.isFinite(Date.parse(source.accessDate))) throw new Error("Source access date is invalid.");
  if (source.authority === "regulatory_primary" && !source.jurisdiction) throw new Error("Regulatory primary sources require jurisdiction metadata.");
}

function validateRequirement(requirement: EngineeringRequirement, ids: Set<string>, sourceIds: Set<string>): void {
  if (!requirement.id || !requirement.projectId || !requirement.text.trim() || !requirement.rationale.trim() || !requirement.verificationMethod.trim()) {
    throw new Error(`Requirement ${requirement.id || "<unknown>"} is missing required traceability fields.`);
  }
  if (!Number.isSafeInteger(requirement.revision) || requirement.revision < 1) throw new Error(`Requirement revision is invalid: ${requirement.id}.`);
  if (requirement.type === "derived" && !requirement.parentRequirementIds.length) return;
  for (const parent of requirement.parentRequirementIds) {
    if (!ids.has(parent) || parent === requirement.id) throw new Error(`Requirement parent is invalid: ${requirement.id} -> ${parent}.`);
  }
  for (const source of requirement.sourceIds) if (!sourceIds.has(source)) throw new Error(`Requirement source is missing: ${source}.`);
}

function validateClaim(claim: EvidenceClaim, requirementIds: Set<string>, claimIds: Set<string>, sourceIds: Set<string>): void {
  if (!claim.id || !claim.projectId || !claim.text.trim() || !claim.applicability.trim()) throw new Error("Claim traceability fields are required.");
  for (const requirement of claim.requirementIds) if (!requirementIds.has(requirement)) throw new Error(`Claim requirement is missing: ${requirement}.`);
  for (const source of claim.sourceEvidenceIds) if (!sourceIds.has(source)) throw new Error(`Claim source is missing: ${source}.`);
  for (const related of [...claim.supportingClaimIds, ...claim.contradictoryClaimIds]) {
    if (!claimIds.has(related) || related === claim.id) throw new Error(`Claim relation is invalid: ${claim.id} -> ${related}.`);
  }
}

function assertProjectIsolation(requirements: readonly EngineeringRequirement[], claims: readonly EvidenceClaim[], sources: readonly SourceDocument[]): void {
  const projects = new Set([...requirements.map((item) => item.projectId), ...claims.map((item) => item.projectId), ...sources.map((item) => item.projectId)]);
  if (projects.size > 1) throw new Error("Cross-project aerospace trace graphs are prohibited.");
  for (const source of sources) validateSourceDocument(source);
}

function freezeRecord(value: Record<string, string[]>): Readonly<Record<string, readonly string[]>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, ids]) => [key, Object.freeze([...new Set(ids)].sort())])));
}

function sorted(values: string[]): readonly string[] {
  return Object.freeze([...values].sort());
}
