import { describe, expect, it } from "vitest";
import {
  analyzeTraceability,
  transitionRequirementStatus,
  validateSourceDocument,
  type EngineeringRequirement,
  type EvidenceClaim,
  type SourceDocument
} from "./traceability.js";

describe("aerospace requirements and evidence traceability", () => {
  it("builds bidirectional coverage and detects orphan/unverified requirements", () => {
    const result = analyzeTraceability({
      sources: [source()],
      requirements: [requirement("req-parent", "performance"), requirement("req-derived", "derived", []), requirement("req-unverified", "constraint")],
      claims: [claim("claim-1", ["req-parent"])]
    });
    expect(result.orphanRequirementIds).toEqual(["req-derived"]);
    expect(result.unverifiedRequirementIds).toEqual(["req-derived", "req-unverified"]);
    expect(result.requirementCoverage["req-parent"]).toEqual(["claim-1"]);
    expect(result.reverseEvidenceCoverage["source-1"]).toEqual(["req-parent"]);
  });

  it("rejects cross-project trace graphs", () => {
    expect(() =>
      analyzeTraceability({ sources: [source()], requirements: [{ ...requirement("req-2", "constraint"), projectId: "project-2" }], claims: [] })
    ).toThrow(/cross-project/i);
  });

  it("requires jurisdiction for regulatory primary sources and content hashes", () => {
    expect(() => validateSourceDocument({ ...source(), authority: "regulatory_primary", jurisdiction: undefined })).toThrow(/jurisdiction/i);
    expect(() => validateSourceDocument({ ...source(), contentHash: "not-a-hash" })).toThrow(/SHA-256/i);
  });

  it("prevents an agent from setting human accepted", () => {
    expect(() => transitionRequirementStatus(requirement("req-1", "constraint"), "human_accepted", "agent")).toThrow(/human reviewer/i);
    expect(transitionRequirementStatus(requirement("req-1", "constraint"), "human_accepted", "human")).toMatchObject({ revision: 2, status: "human_accepted" });
  });

  it("rejects evidence-available state without evidence", () => {
    expect(() => transitionRequirementStatus(requirement("req-1", "constraint"), "evidence_available", "agent")).toThrow(/requires evidence/i);
  });

  it("rejects missing source and claim relations", () => {
    expect(() =>
      analyzeTraceability({
        sources: [source()],
        requirements: [requirement("req-1", "constraint")],
        claims: [{ ...claim("claim-1", ["req-1"]), sourceEvidenceIds: ["missing"] }]
      })
    ).toThrow(/claim source is missing/i);
  });
});

function source(): SourceDocument {
  return {
    id: "source-1",
    projectId: "project-1",
    organization: "NASA",
    title: "Public engineering reference",
    revision: "1",
    documentType: "technical_report",
    authority: "official_agency_technical",
    applicability: "Public research fixture only",
    accessDate: "2026-07-15T00:00:00Z",
    contentHash: "a".repeat(64),
    licenseStatus: "public",
    supersessionStatus: "current",
    dataClassification: "public"
  };
}

function requirement(id: string, type: EngineeringRequirement["type"], parentRequirementIds: readonly string[] = []): EngineeringRequirement {
  return {
    id,
    projectId: "project-1",
    revision: 1,
    text: `${id} shall be verified.`,
    type,
    sourceIds: ["source-1"],
    rationale: "Fixture rationale",
    parentRequirementIds,
    configurationBaselineId: "baseline-1",
    verificationMethod: "analysis",
    verificationLevel: "concept",
    acceptanceCriteria: "Evidence is linked.",
    safetyRelevant: false,
    status: "candidate_mapping",
    evidenceIds: []
  };
}

function claim(id: string, requirementIds: readonly string[]): EvidenceClaim {
  return {
    id,
    projectId: "project-1",
    text: "Fixture claim",
    claimType: "engineering",
    sourceEvidenceIds: ["source-1"],
    computedEvidenceIds: [],
    supportingClaimIds: [],
    contradictoryClaimIds: [],
    assumptionIds: [],
    requirementIds,
    status: "supported",
    confidence: "medium",
    applicability: "Fixture configuration only",
    responsibleVerifier: "fixture-verifier"
  };
}
