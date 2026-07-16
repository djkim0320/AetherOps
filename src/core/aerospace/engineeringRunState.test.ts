import { describe, expect, it } from "vitest";
import { analyzeBaselineChange, validateConfigurationBaseline, type ConfigurationBaseline } from "./configurationBaseline.js";
import { assertArtifactCurrent, createEngineeringRunState, reduceEngineeringRunState } from "./engineeringRunState.js";

describe("EngineeringRunState", () => {
  it("advances only through immutable revision-checked events", () => {
    const initial = state();
    const advanced = reduceEngineeringRunState(initial, { type: "phase_advanced", expectedRevision: 0, phase: "requirements" });
    expect(advanced).toMatchObject({ revision: 1, currentPhase: "requirements" });
    expect(initial).toMatchObject({ revision: 0, currentPhase: "contract" });
    expect(() => reduceEngineeringRunState(advanced, { type: "phase_advanced", expectedRevision: 0, phase: "analysis" })).toThrow(/revision conflict/i);
  });

  it("enforces bounded budgets", () => {
    const next = reduceEngineeringRunState(state(), { type: "budget_consumed", expectedRevision: 0, consumed: { toolCalls: 2, cpuSeconds: 10 } });
    expect(next.budgets).toEqual({ toolCalls: 8, cpuSeconds: 90 });
    expect(() => reduceEngineeringRunState(next, { type: "budget_consumed", expectedRevision: 1, consumed: { toolCalls: 9 } })).toThrow(/budget exceeded/i);
  });

  it("resolves open questions without rewriting the state", () => {
    const next = reduceEngineeringRunState(state(), {
      type: "question_resolved",
      expectedRevision: 0,
      questionId: "question-atmosphere",
      assumption: { id: "assumption-atmosphere", statement: "Use ISA 1976 within its declared range.", approvalStatus: "candidate" }
    });
    expect(next.openQuestions).toEqual([]);
    expect(next.assumptions).toHaveLength(1);
  });

  it.each([
    ["geometryHash", "geometry"],
    ["massPropertiesHash", "mass_properties"],
    ["atmosphereModelId", "atmosphere"],
    ["solverVersions", "solver"],
    ["sourceRevisionIds", "source_revision"]
  ] as const)("propagates %s baseline changes to stale artifacts", (field, expectedAspect) => {
    const previous = baseline();
    const next = { ...baseline("baseline-2", 2), [field]: changedValue(field) } as ConfigurationBaseline;
    const impact = analyzeBaselineChange(previous, next, [
      { artifactId: "artifact-aero", baselineId: previous.id, aspects: [expectedAspect] },
      { artifactId: "artifact-other", baselineId: previous.id, aspects: ["material"] }
    ]);
    expect(impact.changedAspects).toContain(expectedAspect);
    expect(impact.staleArtifactIds).toEqual(["artifact-aero"]);
    const revised = reduceEngineeringRunState(state(), { type: "baseline_changed", expectedRevision: 0, nextBaselineId: next.id, impact });
    expect(() => assertArtifactCurrent(revised, "artifact-aero")).toThrow(/stale/i);
    expect(() => assertArtifactCurrent(revised, "artifact-other")).not.toThrow();
  });

  it("treats changed provenance content under a stable source ID as a source revision change", () => {
    const previous = baseline();
    const next = { ...baseline("baseline-2", 2), provenance: [{ id: "baseline-source", contentHash: "f".repeat(64) }] };
    const impact = analyzeBaselineChange(previous, next, [{ artifactId: "artifact-source", baselineId: previous.id, aspects: ["source_revision"] }]);
    expect(impact.changedAspects).toContain("source_revision");
    expect(impact.staleArtifactIds).toEqual(["artifact-source"]);
  });

  it("rejects ambiguous duplicate source and provenance identities", () => {
    expect(() => validateConfigurationBaseline({ ...baseline(), sourceRevisionIds: ["source-1", "source-1"] })).toThrow(/unique/i);
    expect(() => validateConfigurationBaseline({ ...baseline(), provenance: [{ id: "source" }, { id: "source", contentHash: "a".repeat(64) }] })).toThrow(
      /provenance/i
    );
  });

  it("rejects task nodes outside the canonical graph", () => {
    expect(() => reduceEngineeringRunState(state(), { type: "task_progressed", expectedRevision: 0, completedNodeId: "unknown" })).toThrow(
      /not in the engineering graph/i
    );
    const next = reduceEngineeringRunState(state(), { type: "task_progressed", expectedRevision: 0, completedNodeId: "contract", nextNodeId: "requirements" });
    expect(next.taskGraph).toMatchObject({ completedNodeIds: ["contract"], activeNodeId: "requirements" });
  });
});

function state() {
  return createEngineeringRunState({
    runId: "run-1",
    projectId: "project-1",
    studyContractId: "study-1",
    studyContractRevision: 1,
    configurationBaselineId: "baseline-1",
    currentPhase: "contract",
    requirementIds: [],
    claimIds: [],
    evidenceIds: [],
    equationIds: [],
    modelCardIds: [],
    datasetCardIds: [],
    analysisCaseIds: [],
    simulationRunIds: [],
    decisionRecordIds: [],
    riskIds: [],
    taskGraph: { nodeIds: ["contract", "requirements", "analysis"], completedNodeIds: [], activeNodeId: "contract" },
    openQuestions: [{ id: "question-atmosphere", question: "Which atmosphere model applies?", safetyRelevant: true }],
    assumptions: [],
    unresolvedContradictions: [],
    budgets: { toolCalls: 10, cpuSeconds: 100 },
    nextActions: []
  });
}

function baseline(id = "baseline-1", revision = 1): ConfigurationBaseline {
  return {
    id,
    projectId: "project-1",
    revision,
    status: "active",
    geometryHash: "a".repeat(64),
    massPropertiesHash: "b".repeat(64),
    atmosphereModelId: "isa-1976-v1",
    unitConventionId: "si-v1",
    coordinateConventionId: "aircraft-body-v1",
    solverVersions: { webxfoil: "0.1.1" },
    materialRevisionIds: ["material-1"],
    sourceRevisionIds: ["source-1-r1"],
    equationVersionIds: ["equation-1-v1"],
    contentHash: "e".repeat(64),
    createdAt: "2026-07-15T00:00:00Z",
    createdBy: "test",
    provenance: [{ id: "baseline-source" }]
  };
}

function changedValue(field: string): unknown {
  if (field === "geometryHash") return "c".repeat(64);
  if (field === "massPropertiesHash") return "d".repeat(64);
  if (field === "atmosphereModelId") return "isa-1976-v2";
  if (field === "solverVersions") return { webxfoil: "0.2.0" };
  return ["source-1-r2"];
}
