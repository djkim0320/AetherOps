import { describe, expect, it } from "vitest";
import { DIMENSIONLESS } from "./dimensions.js";
import { runFixedWingConceptStudy, type FixedWingConceptInput } from "./fixedWingConceptStudy.js";
import { createQuantity } from "./quantity.js";
import { deterministicTestDigest, deterministicTestHasher } from "../testing/deterministicTestHasher.js";

const hasher = deterministicTestHasher;
const sha = deterministicTestDigest;

describe("fixed-wing conceptual research vertical slice", () => {
  it("produces a fully traceable research dossier without certification claims", () => {
    const first = runFixedWingConceptStudy(input());
    const second = runFixedWingConceptStudy(input());

    expect(first.status).toBe("research_complete_with_gaps");
    expect(first.certificationStatus).toBe("not_assessed");
    expect(first.outputs.cruiseDrag.valueSI).toBeGreaterThan(0);
    expect(first.outputs.staticMargin.valueSI).toBeCloseTo(0.1, 12);
    expect(first.equationEvidence).toHaveLength(11);
    expect(first.traceability.unverifiedRequirementIds).toEqual([]);
    expect(first.traceability.unsupportedImportantClaimIds).toEqual([]);
    expect(first.reproducibilityManifest.outputHash).toBe(second.reproducibilityManifest.outputHash);
    expect(first.unresolvedGaps).toContain("No certification basis, means of compliance, or compliance finding has been established.");
    expect(first.decisionRecord.prohibitedUses).toContain("flight release");
    expect(first.sensitivity.keyDriverIds[0]).toBeDefined();
  });

  it("rejects a study that is not pinned to the exact configuration baseline", () => {
    const invalid = input();
    invalid.studyContract = {
      ...invalid.studyContract,
      vehicleProfile: { ...invalid.studyContract.vehicleProfile, configurationBaselineId: "baseline:other" }
    };
    expect(() => runFixedWingConceptStudy(invalid)).toThrow(/pin the exact configuration baseline/);
  });

  it("rejects impossible mass fractions but reports negative static margin as an engineering gap", () => {
    const impossible = input();
    impossible.mission.payloadMass = q(1_300, "kg", "fixture:payload");
    expect(() => runFixedWingConceptStudy(impossible)).toThrow(/Takeoff mass must exceed payload mass/);

    const unstable = input();
    unstable.design.neutralPointFromLeadingEdge = q(0.3, "m", "fixture:neutral-point");
    const dossier = runFixedWingConceptStudy(unstable);
    expect(dossier.outputs.staticMargin.valueSI).toBeLessThan(0);
    expect(dossier.unresolvedGaps.join(" ")).toContain("rough static-margin criterion is not met");
  });
});

function input(): FixedWingConceptInput {
  const projectId = "project:aero-bench";
  const baselineId = "baseline:concept:1";
  const modelUse = "subsonic fixed-wing conceptual design trade study";
  return {
    studyContract: {
      id: "study:concept:1",
      schemaVersion: 1,
      revision: 1,
      projectId,
      objective: "Evaluate a public, research-only subsonic fixed-wing concept.",
      researchQuestions: ["What point-performance and traceability gaps remain?"],
      deliverables: [{ id: "dossier", description: "Research dossier", format: "json" }],
      acceptanceCriteria: [
        { id: "trace", statement: "Every reported result has a receipt.", verificationMethod: "automated trace audit", safetyRelevant: false }
      ],
      vehicleProfile: { domain: "fixed_wing", operationContext: "uncrewed research concept", crewed: false, configurationBaselineId: baselineId },
      lifecyclePhase: "research_only",
      assuranceProfile: "engineering_decision_support",
      physicalConventions: { canonicalUnitSystem: "SI", defaultAngleUnit: "deg", atmosphereModel: "isa-1976-troposphere", requiredFrames: ["frame:wind"] },
      sourcePolicy: {
        minimumAuthorityByClaimType: { engineering: "official_agency_technical" },
        allowPreprints: false,
        allowGeneralWeb: false,
        requirePrimarySourcesForStandards: true,
        requireRevisionCheck: true
      },
      computeBudget: { toolCalls: 20, cpuSeconds: 30 },
      constraints: [],
      nonGoals: ["certification finding", "flight release"],
      assumptionsRequiringApproval: [],
      safetyRestrictions: [{ id: "human-review", statement: "Safety decisions require human review.", humanReviewRequired: true }],
      provenance: { actor: "user", sourceId: "fixture:concept-study", occurredAt: "2026-07-15T00:00:00.000Z" }
    },
    configurationBaseline: {
      id: baselineId,
      projectId,
      revision: 1,
      geometryHash: sha("concept-geometry-v1"),
      massPropertiesHash: sha("concept-mass-v1"),
      atmosphereModelId: "isa-1976-troposphere",
      solverVersions: { analytical: "1.0.0" },
      materialRevisionIds: [],
      sourceRevisionIds: ["source:fixture"],
      equationVersionIds: ["concept-equations@1.0.0"],
      createdAt: "2026-07-15T00:00:00.000Z",
      provenanceId: "fixture:concept-baseline"
    },
    sources: [
      {
        id: "source:fixture",
        projectId,
        organization: "AetherOps",
        title: "Research-only conceptual design input fixture",
        revision: "1",
        documentType: "immutable benchmark input",
        authority: "model_inference",
        applicability: "Only the explicit fixture values and analytical equations.",
        stableIdentifier: "aether-aero-bench:concept:v1",
        accessDate: "2026-07-15T00:00:00.000Z",
        contentHash: sha("concept-source-v1"),
        licenseStatus: "public",
        supersessionStatus: "current",
        dataClassification: "public"
      }
    ],
    mission: {
      payloadMass: q(180, "kg", "fixture:payload"),
      targetRange: q(550, "nmi", "fixture:range"),
      cruiseAltitude: q(3_000, "m", "fixture:altitude"),
      cruiseSpeed: q(70, "m/s", "fixture:speed"),
      reserveFraction: q(0.2, "coef", "fixture:reserve")
    },
    design: {
      takeoffMass: q(1_200, "kg", "fixture:mass"),
      wingArea: q(16.2, "m^2", "fixture:wing-area"),
      aspectRatio: q(8.5, "coef", "fixture:aspect-ratio"),
      zeroLiftDragCoefficient: q(0.03, "coef", "fixture:cd0"),
      oswaldEfficiency: q(0.8, "coef", "fixture:oswald"),
      propulsiveEfficiency: q(0.78, "coef", "fixture:propulsive-efficiency"),
      meanAerodynamicChord: q(1.45, "m", "fixture:mac"),
      cgFromLeadingEdge: q(0.42, "m", "fixture:cg"),
      neutralPointFromLeadingEdge: q(0.565, "m", "fixture:neutral-point")
    },
    dynamicViscosity: q(0.0000175, "Pa*s", "fixture:viscosity"),
    modelCard: {
      id: "model:concept-analytical",
      version: "1.0.0",
      name: "Subsonic conceptual point-performance model",
      discipline: "performance",
      intendedUses: [modelUse],
      permissibleUses: [modelUse],
      prohibitedUses: ["certification finding", "flight release"],
      physicalPhenomena: ["steady lift", "parabolic drag polar", "point energy demand"],
      abstractions: ["point mass", "steady level flight"],
      assumptions: ["constant propulsive efficiency"],
      excludedEffects: ["stall", "compressibility corrections", "propulsion map", "structural flexibility"],
      governingEquationIds: ["weight", "lift-coefficient", "drag-polar", "mission-energy"],
      tool: { id: "aetherops-concept-analytical", version: "1.0.0", numericalMethods: ["closed-form"] },
      verificationDomain: [{ variableId: "mach", dimension: DIMENSIONLESS, minimumSI: 0, maximumSI: 0.3, configurationBaselineIds: [baselineId] }],
      validationDomain: [
        { variableId: "mach", dimension: DIMENSIONLESS, minimumSI: 0, maximumSI: 0.3, configurationBaselineIds: [baselineId] },
        { variableId: "liftCoefficient", dimension: DIMENSIONLESS, minimumSI: 0.1, maximumSI: 1.0 }
      ],
      verificationEvidenceIds: ["test:fixed-wing-concept"],
      validationEvidenceIds: ["source:fixture"],
      dataPedigreeIds: ["source:fixture"],
      knownDefects: [],
      sensitivityEvidenceIds: ["sensitivity:local"],
      reviewStatus: "technical_review"
    },
    hasher
  };
}

function q(value: number, unit: string, sourceId: string) {
  return createQuantity({ value, unit, provenance: { sourceType: "user", sourceId } });
}
