import { describe, expect, it } from "vitest";
import { ContextCompressionEngine, isContextCompressionRecord } from "./contextCompression.js";
import { ProjectContextBuilder } from "../retrieval/projectContextBuilder.js";
import { VectorIndexEngine } from "../retrieval/vectorIndexEngine.js";
import { DeterministicEmbeddingProvider, strictTestSettings } from "../testing/orchestratorTestHarness.js";
import { ResearchLoopStep, type NormalizedResearchRecord, type ResearchSnapshot } from "../shared/types.js";

const createdAt = "2026-06-09T00:00:00.000Z";

describe("ContextCompressionEngine", () => {
  it("creates a bounded source-backed memory record for long project context", () => {
    const snapshot = snapshotWithRecords(30);
    const [record] = new ContextCompressionEngine().build(snapshot, 2);

    expect(record).toBeDefined();
    expect(isContextCompressionRecord(record)).toBe(true);
    expect(record.memoryScope).toBe("project_only");
    expect(record.metadata).toMatchObject({
      traceabilityKind: "project_provenance",
      canSupportHypothesis: false,
      sourceKind: "context_compression",
      contextCompression: true,
      compressionKind: "codex_like_project_context",
      compressedIteration: 2
    });
    expect(record.content).toContain("Project Context Compression");
    expect(record.content).toContain("Clark-Y long-memory analysis");
    expect(record.content.length).toBeLessThanOrEqual(6_100);
    expect((record.metadata.sourceRecordIds as string[]).length).toBeGreaterThan(0);
    expect(record.metadata.originalCharEstimate as number).toBeGreaterThan(record.content.length);
  });

  it("lets project context selection and vector memory use compressed project context without treating it as evidence", async () => {
    const base = snapshotWithRecords(30);
    const [compression] = new ContextCompressionEngine().build(base, 2);
    const withCompression = { ...base, normalizedRecords: [...base.normalizedRecords, compression] };
    const chunks = await new VectorIndexEngine(new DeterministicEmbeddingProvider(64)).buildIndex({
      snapshot: withCompression,
      records: withCompression.normalizedRecords,
      settings: strictTestSettings
    });
    const compressionChunks = chunks.filter((chunk) => chunk.recordId === compression.id);

    expect(compressionChunks.length).toBeGreaterThan(0);

    const context = new ProjectContextBuilder().build({ ...withCompression, chunks }, 2);

    expect(context.selectedRecordIds).toContain(compression.id);
    expect(context.selectionReason).toContain("compressed=1");
    expect(context.selectedEvidenceIds).not.toContain("missing-compression-evidence");
    expect(context.citations.some((citation) => citation.startsWith("project://context-compression"))).toBe(false);
  });
});

function snapshotWithRecords(recordCount: number): ResearchSnapshot {
  const records: NormalizedResearchRecord[] = [];
  for (let index = 0; index < recordCount; index += 1) {
    records.push({
      id: `record-${index}`,
      projectId: "project-1",
      memoryScope: "project_only",
      validationStatus: "normalized",
      iteration: 1,
      kind: "observation",
      title: `Clark-Y analysis note ${index}`,
      content: [
        "Clark-Y long-memory analysis requires preserving the UIUC coordinate source, WebXFOIL run parameters, tool outcomes, and unresolved validation gaps.",
        `Iteration note ${index}: Re=1000000 Mach=0 alpha=-4..12 step 2 with no substitute geometry.`,
        "The compressed memory must help future autonomous planning recover prior decisions without replaying every raw tool log."
      ].join(" "),
      sourceUri: `project://record/${index}`,
      metadata: {
        traceabilityKind: "tool_observation",
        canSupportHypothesis: false,
        sourceKind: "log"
      },
      confidence: 0.55,
      createdAt
    });
  }

  return {
    project: {
      id: "project-1",
      goal: "Preserve Clark-Y autonomous research context through Codex-like compression.",
      topic: "Clark-Y long-memory analysis",
      scope: "Context compression for long-running AetherOps sessions.",
      budget: "test",
      autonomyPolicy: { toolApproval: "automatic", allowExternalSearch: true, allowCodeExecution: true, maxLoopIterations: 2 },
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.NormalizeData,
      status: "running",
      projectRoot: ".aetherops/test-project"
    },
    sessions: [],
    researchInputs: [
      {
        id: "input-1",
        projectId: "project-1",
        researchQuestion: "Can compressed context preserve Clark-Y tool decisions?",
        initialHypotheses: ["Compression preserves source-backed state."],
        constraints: ["No substitute geometry."],
        expectedOutputs: ["context compression memory"],
        createdAt
      }
    ],
    questions: [
      {
        id: "q1",
        projectId: "project-1",
        researchInputId: "input-1",
        text: "Can compressed context preserve Clark-Y tool decisions?",
        status: "open",
        createdAt
      }
    ],
    hypotheses: [
      {
        id: "h1",
        projectId: "project-1",
        researchInputId: "input-1",
        questionId: "q1",
        statement: "Compression preserves source-backed state.",
        status: "untested",
        confidence: 0.3,
        createdAt
      }
    ],
    evidence: [],
    artifacts: [],
    sources: [],
    chunks: [],
    toolRuns: [
      {
        id: "tool-1",
        projectId: "project-1",
        iteration: 1,
        toolName: "EngineeringProgramTool",
        input: { kind: "xfoil-wasm-polar", sourceUrl: "https://m-selig.ae.illinois.edu/ads/coord/clarky.dat" },
        output: { rowCount: 9, airfoil: "CLARK Y AIRFOIL" },
        status: "completed",
        startedAt: createdAt,
        completedAt: createdAt
      }
    ],
    agentPlans: [],
    researchPlans: [
      {
        id: "plan-1",
        projectId: "project-1",
        iteration: 1,
        objective: "Run Clark-Y WebXFOIL and preserve long-memory context.",
        targetQuestions: ["q1"],
        targetHypotheses: ["h1"],
        requiredTools: ["WebFetchTool", "EngineeringProgramTool"],
        expectedSources: ["UIUC Clark-Y coordinate file"],
        expectedArtifacts: ["polar report"],
        executionSteps: ["Fetch source", "Run solver", "Compress context"],
        stopCriteria: ["Context is reusable"],
        programRequests: [{ kind: "xfoil-wasm-polar", target: "xfoil-wasm", sourceUrl: "https://m-selig.ae.illinois.edu/ads/coord/clarky.dat" }],
        createdAt
      }
    ],
    specifications: [],
    normalizedRecords: records,
    ontologyEntities: [],
    ontologyRelations: [],
    ontologyConstraints: [],
    projectContextSnapshots: [],
    hybridContexts: [],
    validationResults: [],
    continuationDecisions: [],
    finalOutputs: [],
    runAuditOutputs: [],
    benchmarkPlans: [],
    runtimeBlockers: [],
    stepErrors: [],
    openCodeRuns: [],
    ragContexts: [],
    results: [],
    iterations: []
  };
}
