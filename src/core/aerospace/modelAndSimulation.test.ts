import { describe, expect, it } from "vitest";
import { DIMENSIONLESS } from "./dimensions.js";
import { validateSimulationRunReceipt, type SimulationRunReceipt } from "./analysisEvidence.js";
import { assertModelResultPromotable, assessModelUse, type AerospaceModelCard } from "./modelCard.js";
import { createQuantity } from "./quantity.js";
import { localSensitivity, validateUncertaintyBudget } from "./uncertainty.js";

const provenance = { sourceType: "user" as const, sourceId: "fixture" };

describe("model use and simulation evidence", () => {
  it("separates verification and validation domains", () => {
    const card = modelCard();
    const verifiedOnly = assessModelUse({
      card,
      proposedUse: "conceptual lift estimate",
      configurationBaselineId: "baseline-1",
      variables: { mach: createQuantity({ value: 0.7, unit: "Mach", provenance }) }
    });
    expect(verifiedOnly.status).toBe("outside_validated_domain");
    expect(verifiedOnly.placard?.prohibitedDecisions).toContain("certification finding");
    expect(() => assertModelResultPromotable(verifiedOnly)).toThrow(/cannot be promoted/i);
  });

  it("accepts use only inside both domains and rejects prohibited use", () => {
    const card = modelCard();
    const accepted = assessModelUse({
      card,
      proposedUse: "conceptual lift estimate",
      configurationBaselineId: "baseline-1",
      variables: { mach: createQuantity({ value: 0.4, unit: "Mach", provenance }) }
    });
    expect(accepted.status).toBe("accepted_use");
    expect(() => assertModelResultPromotable(accepted)).not.toThrow();
    expect(
      assessModelUse({
        card,
        proposedUse: "flight control command",
        configurationBaselineId: "baseline-1",
        variables: { mach: createQuantity({ value: 0.4, unit: "Mach", provenance }) }
      }).status
    ).toBe("prohibited_use");
  });

  it("blocks non-converged and outside-domain runs from completed promotion", () => {
    const accepted = assessModelUse({
      card: modelCard(),
      proposedUse: "conceptual lift estimate",
      configurationBaselineId: "baseline-1",
      variables: { mach: createQuantity({ value: 0.4, unit: "Mach", provenance }) }
    });
    expect(() =>
      validateSimulationRunReceipt({
        ...runReceipt(accepted),
        convergenceEvidence: [{ metric: "residual", initialValue: 1, finalValue: 1e-3, tolerance: 1e-4, converged: false, evidenceKind: "iterative" }]
      })
    ).toThrow(/non-converged/i);
    const outside = assessModelUse({
      card: modelCard(),
      proposedUse: "conceptual lift estimate",
      configurationBaselineId: "baseline-1",
      variables: { mach: createQuantity({ value: 1.2, unit: "Mach", provenance }) }
    });
    expect(() => validateSimulationRunReceipt(runReceipt(outside))).toThrow(/outside-domain/i);
  });

  it("creates a reproducibility manifest only from complete run metadata", () => {
    const accepted = assessModelUse({
      card: modelCard(),
      proposedUse: "conceptual lift estimate",
      configurationBaselineId: "baseline-1",
      variables: { mach: createQuantity({ value: 0.4, unit: "Mach", provenance }) }
    });
    expect(validateSimulationRunReceipt(runReceipt(accepted))).toMatchObject({
      tool: "aero.fixture@1",
      convergenceReceiptCount: 2,
      postconditionReceiptCount: 1
    });
  });

  it("requires sourced uncertainty and deterministic sampling metadata", () => {
    expect(() => validateUncertaintyBudget({ id: "uq-1", analysisCaseId: "case-1", items: [], omittedSourceDescriptions: [] })).toThrow(/items are required/i);
    expect(() =>
      validateUncertaintyBudget({
        id: "uq-1",
        analysisCaseId: "case-1",
        items: [
          {
            id: "u-1",
            variableId: "mass",
            type: "epistemic",
            characterization: { kind: "normal", mean: 1000, standardDeviation: 10, sourceJustification: "test data" },
            parameterProvenanceId: "source-1",
            correlatedWithIds: [],
            propagationMethod: "monte_carlo",
            reducible: true
          }
        ],
        omittedSourceDescriptions: []
      })
    ).toThrow(/seed and sample count/i);
  });

  it("computes deterministic central-difference sensitivities and identifies drivers", () => {
    const receipt = localSensitivity({
      baseline: { area: 20, speed: 50 },
      steps: { area: 0.01, speed: 0.01 },
      evaluate: ({ area, speed }) => (area as number) * (speed as number) ** 2
    });
    expect(receipt.derivatives.area).toBeCloseTo(2500, 8);
    expect(receipt.derivatives.speed).toBeCloseTo(2000, 8);
    expect(receipt.keyDriverIds[0]).toBe("speed");
    expect(receipt.evaluationCount).toBe(5);
  });
});

function modelCard(): AerospaceModelCard {
  return {
    id: "model-lift",
    version: "1",
    name: "Fixture lift model",
    discipline: "aerodynamics",
    intendedUses: ["conceptual lift estimate"],
    permissibleUses: ["conceptual lift estimate"],
    prohibitedUses: ["flight control command"],
    physicalPhenomena: ["subsonic lifting flow"],
    abstractions: ["steady flow"],
    assumptions: ["attached flow"],
    excludedEffects: ["transonic shocks"],
    governingEquationIds: ["lift-equation@1"],
    tool: { id: "aero.fixture", version: "1", numericalMethods: ["closed-form"] },
    verificationDomain: [{ variableId: "mach", dimension: DIMENSIONLESS, minimumSI: 0, maximumSI: 0.8, configurationBaselineIds: ["baseline-1"] }],
    validationDomain: [{ variableId: "mach", dimension: DIMENSIONLESS, minimumSI: 0.2, maximumSI: 0.6, configurationBaselineIds: ["baseline-1"] }],
    verificationEvidenceIds: ["verification-1"],
    validationEvidenceIds: ["validation-1"],
    dataPedigreeIds: ["dataset-1"],
    knownDefects: [],
    sensitivityEvidenceIds: ["sensitivity-1"],
    reviewStatus: "technical_review"
  };
}

function runReceipt(modelUseAssessment: ReturnType<typeof assessModelUse>): SimulationRunReceipt {
  return {
    runId: "simulation-1",
    analysisCaseId: "case-1",
    toolId: "aero.fixture",
    toolVersion: "1",
    environmentHash: "a".repeat(64),
    inputArtifactHashes: ["b".repeat(64)],
    configurationHash: "c".repeat(64),
    startTime: "2026-07-15T00:00:00Z",
    durationMs: 10,
    exitStatus: "completed",
    convergenceEvidence: [
      { metric: "residual", initialValue: 1, finalValue: 1e-6, tolerance: 1e-5, converged: true, evidenceKind: "iterative" },
      { metric: "mass-balance", initialValue: 0, finalValue: 1e-8, tolerance: 1e-6, converged: true, evidenceKind: "conservation" }
    ],
    warningMessages: [],
    errorMessages: [],
    outputArtifactIds: ["artifact-result"],
    postconditionResults: [{ id: "output-hash", passed: true, detail: "matched" }],
    modelUseAssessment,
    uncertaintyBudgetId: "uq-1",
    reproducibilityStatus: "reproduced"
  };
}
