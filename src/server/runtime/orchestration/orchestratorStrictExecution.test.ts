import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nowIso } from "../../../core/shared/ids.js";
import {
  createInputProject,
  createStrictTestOrchestrator,
  DeterministicOpenCodeAdapter,
  DeterministicLlmProvider,
  strictTestSettings
} from "../../../core/testing/orchestratorTestHarness.js";
import type { LlmJsonRequest } from "../../../core/providers/llm.js";
import { ToolRunner } from "../../../core/tools/toolRunner.js";
import type { ResearchTool, ResearchToolResult } from "../../../core/tools/researchToolTypes.js";
import { InMemoryResearchStore } from "../../../core/memory/memoryStore.js";
import { ValidationEngine } from "../../../core/reasoning/validationEngine.js";
import {
  ResearchLoopStep,
  type EvidenceItem,
  type HybridContext,
  type NormalizedResearchRecord,
  type OntologyRelation,
  type OpenCodeRunInput,
  type OpenCodeRunOutput,
  type ProjectContextSnapshot,
  type ResearchProjectInput
} from "../../../core/shared/types.js";
import { NodeProjectStorage } from "../storage/projectResearchStore.js";
import { failingAdapter, UnregisteredToolPlanner } from "../../../../tests/contract/server/strictExecutionTestDoubles.js";

let tempDir: string | undefined;

const input: ResearchProjectInput = {
  goal: "Compare Pomodoro 25/5 and 50/10 for a two-hour study session.",
  topic: "Pomodoro 25/5 vs 50/10",
  scope: "Use traceable evidence; no code execution.",
  budget: "30 minutes",
  autonomyPolicy: {
    toolApproval: "suggested",
    allowExternalSearch: false,
    allowCodeExecution: false
  }
};

class CapturingOpenCodeAdapter extends DeterministicOpenCodeAdapter {
  readonly inputs: OpenCodeRunInput[] = [];

  override async run(input: OpenCodeRunInput): Promise<OpenCodeRunOutput> {
    this.inputs.push(input);
    return super.run(input);
  }
}

class FailingFinalOutputStorage extends NodeProjectStorage {
  override async writeFinalOutputFiles(): ReturnType<NodeProjectStorage["writeFinalOutputFiles"]> {
    throw new Error("forced final output write failure");
  }
}

class MetadataFirstPlanner extends DeterministicLlmProvider {
  override async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    if (request.schemaName === "AetherOpsResearchPlan") {
      return {
        objective: "Collect OpenAlex metadata before OpenCode analysis.",
        targetQuestions: ["q1"],
        targetHypotheses: ["h1"],
        requiredTools: ["OpenCodeTool", "ResearchMetadataTool"],
        expectedSources: ["OpenAlex paper metadata"],
        expectedArtifacts: ["metadata-aware analysis"],
        executionSteps: ["Run ResearchMetadataTool", "Run OpenCode with acquired metadata"],
        stopCriteria: ["OpenCode input contains metadata sources"]
      } as T;
    }
    return super.completeJson(request);
  }
}

class FinalClaimPlanner extends DeterministicLlmProvider {
  override async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    if (request.schemaName === "AetherOpsEvidenceBasedResult") {
      return {
        answer: "Frequent short breaks reduce fatigue. Productivity gains improve outcomes.",
        hypothesisUpdates: [
          {
            hypothesisIndex: 0,
            status: "supported",
            confidence: 0.8,
            rationale: "The short-break fatigue claim is supported by the selected citation."
          }
        ],
        quantitativeResults: [],
        qualitativeResults: ["Result note"],
        nextQuestions: [],
        needsMoreEvidence: false,
        needsMoreAnalysis: false
      } as T;
    }
    return super.completeJson<T>(request);
  }
}

const metadataAcquisitionTool: ResearchTool = {
  name: "ResearchMetadataTool",
  run: async (input: OpenCodeRunInput): Promise<ResearchToolResult> => {
    const completedAt = nowIso();
    return {
      toolRun: {
        id: "tool-openalex-test",
        projectId: input.project.id,
        iteration: input.iteration,
        toolName: "ResearchMetadataTool",
        input: { projectId: input.project.id, iteration: input.iteration },
        output: { sourceIds: ["source-openalex-test"], evidenceIds: ["evidence-openalex-test"] },
        status: "completed",
        startedAt: completedAt,
        completedAt
      },
      sources: [
        {
          id: "source-openalex-test",
          projectId: input.project.id,
          kind: "paper",
          title: "OpenAlex metadata captured before OpenCode",
          url: "https://openalex.org/W123",
          doi: "https://doi.org/10.1234/openalex-test",
          retrievedAt: completedAt,
          metadata: { provider: "openalex" },
          createdAt: completedAt
        }
      ],
      evidence: [
        {
          id: "evidence-openalex-test",
          projectId: input.project.id,
          category: "paper_reference",
          title: "OpenAlex metadata evidence",
          summary: "Metadata evidence is available before OpenCode runs.",
          sourceUri: "https://openalex.org/W123",
          citation: "OpenAlex metadata captured before OpenCode.",
          keywords: ["openalex", "metadata"],
          linkedHypothesisIds: input.hypotheses.map((item) => item.id),
          reliabilityScore: 0.75,
          relevanceScore: 0.8,
          evidenceStrength: "medium",
          limitations: [],
          metadata: { traceabilityKind: "external_source" },
          createdAt: completedAt
        }
      ],
      artifacts: []
    };
  }
};

function finalClaimEvidence(projectId: string, hypothesisId: string, createdAt: string): EvidenceItem {
  return {
    id: "e-final-claim-support",
    projectId,
    category: "web_source",
    title: "Short-break fatigue study",
    summary: "A controlled study directly supports frequent short breaks reduce fatigue.",
    sourceId: "source-final-claim-support",
    sourceUri: "https://example.edu/final-claim-support",
    citation: "Example citation final-claim-support",
    keywords: ["short", "breaks", "fatigue"],
    linkedHypothesisIds: [hypothesisId],
    reliabilityScore: 0.9,
    relevanceScore: 0.9,
    evidenceStrength: "strong",
    limitations: [],
    createdAt
  };
}

function finalClaimRecord(projectId: string, evidence: EvidenceItem, createdAt: string): NormalizedResearchRecord {
  return {
    id: "record-final-claim-support",
    projectId,
    memoryScope: "global",
    validationStatus: "normalized",
    iteration: 1,
    kind: "evidence",
    title: evidence.title,
    content: evidence.summary,
    sourceId: evidence.sourceId,
    evidenceId: evidence.id,
    citation: evidence.citation,
    sourceUri: evidence.sourceUri,
    metadata: {
      traceabilityKind: "external_source",
      sourceQualityTier: "scholarly",
      canSupportHypothesis: true
    },
    confidence: 0.9,
    createdAt
  };
}

function finalClaimRelation(projectId: string, hypothesisId: string, evidenceId: string, sourceRecordId: string, createdAt: string): OntologyRelation {
  return {
    id: "relation-final-claim-support",
    projectId,
    memoryScope: "global",
    validationStatus: "graph_linked",
    subjectId: "entity-final-claim-support",
    predicate: "supports",
    objectId: hypothesisId,
    sourceRecordId,
    sourceEvidenceId: evidenceId,
    confidence: 0.9,
    createdAt
  };
}

function finalClaimProjectContext(projectId: string, evidenceId: string, recordId: string, relationId: string, createdAt: string): ProjectContextSnapshot {
  return {
    id: "context-final-claim",
    projectId,
    iteration: 1,
    query: "short breaks fatigue",
    selectedRecordIds: [recordId],
    selectedSourceIds: ["source-final-claim-support"],
    selectedEvidenceIds: [evidenceId],
    selectedChunkIds: [],
    selectedEntityIds: [],
    selectedRelationIds: [relationId],
    citations: ["https://example.edu/final-claim-support"],
    selectionReason: "Fixture selected traceable support evidence for final answer scoring.",
    createdAt
  };
}

function finalClaimHybridContext(projectId: string, evidenceId: string, relationId: string, createdAt: string): HybridContext {
  return {
    id: "hybrid-final-claim",
    projectId,
    iteration: 1,
    query: "short breaks fatigue",
    vectorChunkIds: [],
    ontologyEntityIds: [],
    ontologyRelationIds: [relationId],
    evidenceIds: [evidenceId],
    artifactIds: [],
    citations: ["https://example.edu/final-claim-support"],
    vectorSummary: "Frequent short breaks reduce fatigue.",
    graphSummary: "Short-break evidence supports the fatigue hypothesis.",
    contextText: "A controlled study directly supports frequent short breaks reduce fatigue.",
    retrievalScores: { [evidenceId]: 1 },
    createdAt
  };
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("AetherOps strict execution loop", () => {
  it("derives research input from the project brief when separate hypotheses are missing", async () => {
    const orchestrator = createStrictTestOrchestrator();
    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.seedQuestions(snapshot.project.id);

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.BuildResearchSpecification);
    expect(snapshot.project.status).not.toBe("blocked");
    expect(snapshot.runtimeBlockers.some((blocker) => blocker.requirementKey === "research_input")).toBe(false);
    expect(snapshot.researchInputs).toHaveLength(1);
    expect(snapshot.researchInputs[0]?.researchQuestion).toBe(input.goal);
    expect(snapshot.researchInputs[0]?.initialHypotheses.length).toBeGreaterThan(0);
    expect(snapshot.researchInputs[0]?.initialHypotheses[0]).toContain(input.topic);
    expect(snapshot.questions).toHaveLength(1);
    expect(snapshot.hypotheses.length).toBeGreaterThan(0);
    expect(snapshot.finalOutputs).toHaveLength(0);
  });

  it("runs research metadata before OpenCode so the LLM receives real acquired sources", async () => {
    const openCode = new CapturingOpenCodeAdapter();
    const orchestrator = createStrictTestOrchestrator({
      openCode,
      llm: new MetadataFirstPlanner(),
      toolRunner: new ToolRunner([metadataAcquisitionTool]),
      settings: {
        ...strictTestSettings,
        allowExternalSearch: true,
        researchMetadata: { ...strictTestSettings.researchMetadata, enabled: true }
      }
    });

    let snapshot = await createInputProject(orchestrator, {
      ...input,
      autonomyPolicy: {
        ...input.autonomyPolicy,
        allowExternalSearch: true,
        maxLoopIterations: 1
      }
    });
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.status).toBe("completed");
    expect(openCode.inputs).toHaveLength(1);
    expect(openCode.inputs[0]?.sources?.some((source) => source.id === "source-openalex-test")).toBe(true);
    expect(openCode.inputs[0]?.evidence?.some((evidence) => evidence.id === "evidence-openalex-test")).toBe(true);
    expect(snapshot.toolRuns.some((toolRun) => toolRun.toolName === "ResearchMetadataTool")).toBe(true);
  });

  it("scores the merged LLM final answer instead of only the draft validation summaries", async () => {
    const store = new InMemoryResearchStore();
    const orchestrator = createStrictTestOrchestrator({
      store,
      llm: new FinalClaimPlanner()
    });
    let snapshot = await orchestrator.createProject(input);
    const projectId = snapshot.project.id;
    const timestamp = nowIso();
    const question = {
      id: "q-final-claim",
      projectId,
      text: "Do short breaks reduce fatigue?",
      status: "open" as const,
      createdAt: timestamp
    };
    const hypothesis = {
      id: "h-final-claim",
      projectId,
      questionId: question.id,
      statement: "Frequent short breaks reduce fatigue.",
      status: "untested" as const,
      confidence: 0.4,
      createdAt: timestamp
    };
    const support = finalClaimEvidence(projectId, hypothesis.id, timestamp);
    const record = finalClaimRecord(projectId, support, timestamp);
    const relation = finalClaimRelation(projectId, hypothesis.id, support.id, timestamp);
    const contextSnapshot = finalClaimProjectContext(projectId, support.id, record.id, relation.id, timestamp);
    const hybridContext = finalClaimHybridContext(projectId, support.id, relation.id, timestamp);

    await store.saveQuestions([question]);
    await store.saveHypotheses([hypothesis]);
    await store.saveEvidence([support]);
    await store.saveNormalizedRecords([record]);
    await store.saveOntologyRelations([relation]);
    await store.saveProjectContextSnapshot(contextSnapshot);
    await store.saveHybridContext(hybridContext);
    snapshot = await store.getSnapshot(projectId);
    await store.saveValidationResults(
      new ValidationEngine().validate(snapshot, hybridContext, [
        {
          hypothesisId: hypothesis.id,
          claim: hypothesis.statement,
          supportingEvidenceIds: [support.id],
          contradictingEvidenceIds: [],
          evidenceGaps: [],
          summary: "Fixture reasoning supports the short-break fatigue claim."
        }
      ])
    );

    const result = await orchestrator.synthesizeAndEvaluate(projectId, 1, true);

    expect(result.answer).toBe("Frequent short breaks reduce fatigue. Productivity gains improve outcomes.");
    expect(result.evidenceScorecard).toMatchObject({
      claimCount: 2,
      statusCounts: {
        supported: 1,
        missing_evidence: 1,
        contradicted: 0,
        attribution_unfaithful: 0,
        unknown: 0
      }
    });
    expect(result.evidenceScorecard?.claims.find((claim) => claim.claim === "Productivity gains improve outcomes.")).toMatchObject({
      status: "missing_evidence",
      correctness: { status: "insufficient" }
    });
  });

  it("uses the current GUI research brief instead of stale untagged specifications or plans", async () => {
    const openCode = new CapturingOpenCodeAdapter();
    const orchestrator = createStrictTestOrchestrator({
      openCode,
      settings: {
        ...strictTestSettings,
        maxLoopIterations: 1
      }
    });
    const nextInput: ResearchProjectInput = {
      goal: "Evaluate whether citation-aware metadata improves RAG precision for literature review workflows.",
      topic: "citation-aware metadata RAG precision",
      scope: "Use traceable metadata and no synthetic sources.",
      budget: "20 minutes",
      autonomyPolicy: {
        ...input.autonomyPolicy,
        maxLoopIterations: 1
      }
    };
    const nextHypothesis = "Citation-aware metadata improves RAG precision compared with text-only retrieval.";

    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.buildResearchSpecification(snapshot.project.id);
    snapshot = await orchestrator.planResearch(snapshot.project.id, 1);
    const staleInputId = snapshot.researchInputs.at(-1)?.id;

    snapshot = await orchestrator.updateProjectInput(snapshot.project.id, nextInput);
    snapshot = await orchestrator.inputResearchQuestionHypothesis(snapshot.project.id, {
      researchQuestion: nextInput.goal,
      initialHypotheses: [nextHypothesis],
      constraints: [],
      expectedOutputs: []
    });
    const activeInputId = snapshot.researchInputs.at(-1)?.id;
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.status).toBe("completed");
    expect(activeInputId).toBeDefined();
    expect(activeInputId).not.toBe(staleInputId);
    expect(openCode.inputs).toHaveLength(1);
    expect(openCode.inputs[0]?.questions.map((question) => question.text)).toEqual([nextInput.goal]);
    expect(openCode.inputs[0]?.hypotheses.map((hypothesis) => hypothesis.statement)).toEqual([nextHypothesis]);
    expect(openCode.inputs[0]?.specification?.sourceResearchInputId).toBe(activeInputId);
    expect(openCode.inputs[0]?.researchPlan?.sourceResearchInputId).toBe(activeInputId);
    expect(JSON.stringify(openCode.inputs[0])).not.toContain(input.goal);
  });

  it("fails at FinalizeOutputs when the final report cannot be written", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-loop-"));
    const orchestrator = createStrictTestOrchestrator({
      storage: new FailingFinalOutputStorage(),
      projectRootBase: join(tempDir, "projects")
    });

    let snapshot = await createInputProject(orchestrator, {
      ...input,
      autonomyPolicy: {
        ...input.autonomyPolicy,
        maxLoopIterations: 1
      }
    });
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.status).toBe("failed");
    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.FinalizeOutputs);
    expect(snapshot.stepErrors.at(-1)).toMatchObject({
      step: ResearchLoopStep.FinalizeOutputs,
      cause: "step_failed"
    });
    expect(snapshot.stepErrors.at(-1)?.message).toContain("forced final output write failure");
    expect(snapshot.report).toBeUndefined();
    expect(snapshot.finalOutputs).toHaveLength(0);
    expect(snapshot.runAuditOutputs).toHaveLength(1);
    expect(snapshot.runAuditOutputs[0]).toMatchObject({
      finalStatus: "failed",
      failedStep: ResearchLoopStep.FinalizeOutputs
    });
    expect(existsSync(join(snapshot.project.projectRoot, "reports", "final-report.pdf"))).toBe(false);
  });

  it("blocks clearly when the OpenCode execution engine is not configured", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-loop-"));
    const orchestrator = createStrictTestOrchestrator({
      storage: new NodeProjectStorage(),
      projectRootBase: join(tempDir, "projects"),
      settings: {
        ...strictTestSettings,
        openCode: { ...strictTestSettings.openCode, enabled: false, command: "" }
      }
    });

    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.ExecuteTools);
    expect(snapshot.project.status).toBe("blocked");
    expect(snapshot.runtimeBlockers.length).toBeGreaterThan(0);
    expect(snapshot.stepErrors.length).toBeGreaterThan(0);
    expect(snapshot.openCodeRuns).toHaveLength(0);
    expect(snapshot.evidence.some((item) => item.keywords.includes("tool_unavailable") || item.keywords.includes("evidence_gap"))).toBe(false);
    expect(snapshot.report).toBeUndefined();
    expect(snapshot.finalOutputs).toHaveLength(0);
    expect(snapshot.runAuditOutputs).toHaveLength(1);
    expect(snapshot.runAuditOutputs[0]).toMatchObject({
      finalStatus: "blocked",
      failedStep: ResearchLoopStep.ExecuteTools
    });
    expect(snapshot.runAuditOutputs[0]?.markdownReport).toContain("blocked before execution could proceed");
    expect(snapshot.runAuditOutputs[0]?.unmetRequirements?.length).toBeGreaterThan(0);
    expect(existsSync(join(snapshot.project.projectRoot, "reports", "run-audit.md"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "exports", "run-audit.json"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "reports", "final-report.pdf"))).toBe(false);
  });

  it("blocks at BuildVectorIndex when the embedding API key is missing while preserving partial outputs", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-loop-"));
    const orchestrator = createStrictTestOrchestrator({
      storage: new NodeProjectStorage(),
      projectRootBase: join(tempDir, "projects"),
      settings: {
        ...strictTestSettings,
        embedding: {
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 64,
          apiKeyConfigured: false
        }
      }
    });

    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.status).toBe("blocked");
    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.BuildVectorIndex);
    expect(snapshot.runtimeBlockers.some((blocker) => blocker.requirementKey === "embedding.apiKey")).toBe(true);
    expect(snapshot.stepErrors.at(-1)).toMatchObject({
      step: ResearchLoopStep.BuildVectorIndex,
      cause: "runtime_requirement"
    });
    expect(snapshot.runAuditOutputs).toHaveLength(1);
    expect(snapshot.runAuditOutputs[0]).toMatchObject({
      finalStatus: "blocked",
      failedStep: ResearchLoopStep.BuildVectorIndex
    });
    expect(snapshot.runAuditOutputs[0]?.unmetRequirements?.some((item) => item.requirementKey === "embedding.apiKey")).toBe(true);
    expect(snapshot.finalOutputs).toHaveLength(0);
    expect(snapshot.openCodeRuns.length).toBeGreaterThan(0);
    expect(snapshot.sources.length).toBeGreaterThan(0);
    expect(snapshot.artifacts.length).toBeGreaterThan(0);
    expect(snapshot.normalizedRecords.length).toBeGreaterThan(0);
    expect(snapshot.evidence.some((item) => !item.sourceUri && !item.citation && !item.quote)).toBe(false);
    expect(existsSync(join(snapshot.project.projectRoot, "reports", "run-audit.md"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "exports", "run-audit.json"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "reports", "final-report.pdf"))).toBe(false);
  });

  it("blocks at PlanResearch when the LLM requests an unregistered tool", async () => {
    const orchestrator = createStrictTestOrchestrator({ llm: new UnregisteredToolPlanner() });
    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.PlanResearch);
    expect(snapshot.project.status).toBe("blocked");
    expect(snapshot.runtimeBlockers.some((blocker) => blocker.requirementKey === "tool.registered")).toBe(true);
    expect(snapshot.openCodeRuns).toHaveLength(0);
    expect(snapshot.finalOutputs).toHaveLength(0);
  });

  it("records ExecuteTools as the failed step when a configured execution tool fails", async () => {
    const orchestrator = createStrictTestOrchestrator({ openCode: failingAdapter() });
    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.ExecuteTools);
    expect(snapshot.project.status).toBe("failed");
    expect(snapshot.stepErrors.at(-1)?.step).toBe(ResearchLoopStep.ExecuteTools);
    expect(snapshot.openCodeRuns).toHaveLength(1);
    expect(snapshot.openCodeRuns[0]).toMatchObject({
      iteration: 1,
      status: "failed"
    });
    expect(snapshot.openCodeRuns[0]?.prompt).toContain(input.topic);
    expect(snapshot.openCodeRuns[0]?.metadata?.executionBundleId).toBeDefined();
    expect(snapshot.openCodeRuns[0]?.metadata?.error).toBe("configured OpenCode execution failed");
    expect(snapshot.finalOutputs).toHaveLength(0);
  });

  it("preserves pre-OpenCode acquisition outputs when the OpenCode attempt fails", async () => {
    const orchestrator = createStrictTestOrchestrator({
      openCode: failingAdapter(),
      llm: new MetadataFirstPlanner(),
      toolRunner: new ToolRunner([metadataAcquisitionTool]),
      settings: {
        ...strictTestSettings,
        allowExternalSearch: true
      }
    });
    let snapshot = await createInputProject(orchestrator, {
      ...input,
      autonomyPolicy: {
        ...input.autonomyPolicy,
        allowExternalSearch: true
      }
    });
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    const failedRun = snapshot.openCodeRuns[0];
    const bundleId = failedRun?.metadata?.executionBundleId;

    expect(snapshot.project.status).toBe("failed");
    expect(failedRun?.status).toBe("failed");
    expect(bundleId).toBeDefined();
    expect(snapshot.toolRuns.some((toolRun) => toolRun.id === "tool-openalex-test" && toolRun.status === "completed")).toBe(true);
    expect(snapshot.sources.some((source) => source.id === "source-openalex-test" && source.metadata.executionBundleId === bundleId)).toBe(true);
    expect(snapshot.evidence.some((evidence) => evidence.id === "evidence-openalex-test" && evidence.metadata?.executionBundleId === bundleId)).toBe(true);
  });
});
