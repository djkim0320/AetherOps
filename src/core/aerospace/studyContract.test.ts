import { describe, expect, it } from "vitest";
import { normalizeStudyContract, reviseStudyContract, validateStudyContract, type EngineeringStudyDraft } from "./studyContract.js";

describe("EngineeringStudyContract", () => {
  it("returns explicit open questions instead of guessing physical conventions", () => {
    const result = normalizeStudyContract(baseDraft());
    expect(result.contract).toBeUndefined();
    expect(result.openQuestions.map((item) => item.field)).toEqual([
      "vehicleProfile.domain",
      "vehicleProfile.operationContext",
      "physicalConventions.requiredFrames",
      "physicalConventions.defaultAngleUnit",
      "physicalConventions.atmosphereModel",
      "vehicleProfile.configurationBaselineId"
    ]);
    expect(result.proposedAssuranceProfile).toBe("engineering_decision_support");
  });

  it("normalizes a complete research-only fixed-wing draft", () => {
    const result = normalizeStudyContract(completeDraft());
    expect(result.openQuestions).toEqual([]);
    expect(result.contract).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      vehicleProfile: { domain: "fixed_wing", configurationBaselineId: "baseline-1" },
      assuranceProfile: "exploratory_research",
      physicalConventions: { canonicalUnitSystem: "SI", defaultAngleUnit: "deg", atmosphereModel: "isa-1976" }
    });
    expect(result.contract?.safetyRestrictions).toHaveLength(2);
  });

  it("does not lower an explicitly requested safety profile", () => {
    const result = normalizeStudyContract({ ...completeDraft(), assuranceProfile: "safety_relevant_support" });
    expect(result.contract?.assuranceProfile).toBe("safety_relevant_support");
    expect(result.contract?.sourcePolicy.allowGeneralWeb).toBe(false);
  });

  it("requires positive compute budgets and a human-review restriction", () => {
    const contract = normalizeStudyContract(completeDraft()).contract!;
    expect(() => validateStudyContract({ ...contract, computeBudget: { cpuSeconds: 0 } })).toThrow(/positive/i);
    expect(() => validateStudyContract({ ...contract, safetyRestrictions: [] })).toThrow(/human-review/i);
  });

  it("revises only against the exact predecessor revision", () => {
    const contract = normalizeStudyContract(completeDraft()).contract!;
    expect(() =>
      reviseStudyContract(contract, { objective: "new objective" }, { actor: "user", sourceId: "change", occurredAt: "2026-07-15T00:00:00Z" })
    ).toThrow(/exact previous/i);
    const revised = reviseStudyContract(
      contract,
      { objective: "new objective" },
      {
        actor: "user",
        sourceId: "change",
        occurredAt: "2026-07-15T00:00:00Z",
        supersedesRevision: 1
      }
    );
    expect(revised).toMatchObject({ revision: 2, objective: "new objective" });
  });
});

function baseDraft(): EngineeringStudyDraft {
  return {
    id: "study-1",
    projectId: "project-1",
    objective: "Evaluate a public subsonic concept.",
    provenance: { actor: "user", sourceId: "request-1", occurredAt: "2026-07-15T00:00:00Z" }
  };
}

function completeDraft(): EngineeringStudyDraft {
  return {
    ...baseDraft(),
    vehicleDomain: "fixed_wing",
    operationContext: "Subsonic civil conceptual-design research",
    crewed: true,
    lifecyclePhase: "concept",
    assuranceProfile: "exploratory_research",
    requiredFrames: ["body", "wind", "ned"],
    defaultAngleUnit: "deg",
    atmosphereModel: "isa-1976",
    configurationBaselineId: "baseline-1"
  };
}
