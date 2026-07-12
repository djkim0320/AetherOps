import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nowIso } from "../../../core/shared/ids.js";
import {
  createInputProject,
  createStrictTestOrchestrator,
  DeterministicCodexCliAdapter,
  DeterministicLlmProvider,
  strictTestSettings
} from "../../../core/testing/orchestratorTestHarness.js";
import type { LlmJsonRequest } from "../../../core/providers/llm.js";
import { ToolRunner } from "../../../core/tools/toolRunner.js";
import type { ResearchTool, ResearchToolResult, ToolExecutionContext } from "../../../core/tools/researchToolTypes.js";
import { InMemoryResearchStore } from "../../../core/memory/memoryStore.js";
import { ValidationEngine } from "../../../core/reasoning/validationEngine.js";
import { ResearchLoopStep, type CodexCliAdapterRequest, type CodexCliTaskResult, type ResearchProjectInput } from "../../../core/shared/types.js";
import { NodeProjectStorage } from "../storage/projectResearchStore.js";
import { failingAdapter, UnregisteredToolPlanner } from "../../../../tests/contract/server/strictExecutionTestDoubles.js";
import {
  finalClaimEvidence,
  finalClaimHybridContext,
  finalClaimProjectContext,
  finalClaimRecord,
  finalClaimRelation
} from "./orchestratorStrictExecutionFixtures.js";

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

class CapturingCodexCliAdapter extends DeterministicCodexCliAdapter {
  readonly requests: CodexCliAdapterRequest[] = [];

  override async run(request: CodexCliAdapterRequest): Promise<CodexCliTaskResult> {
    this.requests.push(request);
    return super.run(request);
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
        objective: "Collect OpenAlex metadata before Codex CLI analysis.",
        targetQuestions: ["q1"],
        targetHypotheses: ["h1"],
        toolRequests: [
          {
            intentId: "collect-metadata",
            toolName: "ResearchMetadataTool",
            purpose: "Collect traceable scholarly metadata before engineering analysis.",
            expectedOutcome: "OpenAlex sources and evidence are available to the next action.",
            inputs: { query: "Pomodoro study break metadata" }
          },
          {
            intentId: "analyze-with-codex-cli",
            toolName: "CodexCliTool",
            purpose: "Analyze the acquired metadata with the explicitly authorized engineering agent.",
            expectedOutcome: "A Codex CLI artifact based on the acquired metadata.",
            inputs: { task: "Analyze the acquired Pomodoro metadata.", inputArtifactIds: [], outputs: [{ relativePath: "analysis.md", kind: "report" }] }
          }
        ],
        expectedSources: ["OpenAlex paper metadata"],
        expectedArtifacts: ["metadata-aware analysis"],
        executionSteps: ["Run ResearchMetadataTool", "Run Codex CLI with acquired metadata"],
        stopCriteria: ["Codex CLI reaches a terminal state"],
        fetchCandidateUrls: []
      } as T;
    }
    return super.completeJson(request);
  }
}

class CodexCliOnlyPlanner extends DeterministicLlmProvider {
  override async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    if (request.schemaName === "AetherOpsResearchPlan") {
      return {
        objective: "Run one explicitly authorized Codex CLI analysis.",
        targetQuestions: ["q1"],
        targetHypotheses: ["h1"],
        toolRequests: [
          {
            intentId: "authorized-codex-cli",
            toolName: "CodexCliTool",
            purpose: "Run the explicitly authorized engineering analysis.",
            expectedOutcome: "A traceable Codex CLI artifact.",
            inputs: { task: "Analyze the active research brief.", inputArtifactIds: [], outputs: [{ relativePath: "analysis.md", kind: "report" }] }
          }
        ],
        expectedSources: [],
        expectedArtifacts: ["Codex CLI analysis artifact"],
        executionSteps: ["Run the authorized Codex CLI action."],
        stopCriteria: ["The Codex CLI action reaches a terminal state."],
        fetchCandidateUrls: []
      } as T;
    }
    return super.completeJson(request);
  }
}

function explicitCodexCliExecution(sourceAccess: ToolExecutionContext["toolPolicy"]["sourceAccess"] = { mode: "offline" }): ToolExecutionContext {
  return {
    allowCodexCli: true,
    toolPolicy: { allowCodexCli: true, sourceAccess }
  };
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
  run: async (input: ResearchToolInput): Promise<ResearchToolResult> => {
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

  it("runs research metadata before the authorized Codex CLI action", async () => {
    const codexCli = new CapturingCodexCliAdapter();
    const orchestrator = createStrictTestOrchestrator({
      codexCli,
      llm: new MetadataFirstPlanner(),
      toolRunner: new ToolRunner([metadataAcquisitionTool]),
      settings: {
        ...strictTestSettings,
        allowCodeExecution: true,
        allowExternalSearch: true,
        allowCodeExecution: true,
        researchMetadata: { ...strictTestSettings.researchMetadata, enabled: true }
      }
    });

    let snapshot = await createInputProject(orchestrator, {
      ...input,
      autonomyPolicy: {
        ...input.autonomyPolicy,
        allowCodeExecution: true,
        allowExternalSearch: true,
        allowCodeExecution: true,
        maxLoopIterations: 1
      }
    });
    snapshot = await orchestrator.startLoop(snapshot.project.id, explicitCodexCliExecution({ mode: "discovery", allowedDomains: ["openalex.org"] }));

    expect(snapshot.project.status).toBe("completed");
    expect(codexCli.requests).toHaveLength(1);
    expect(snapshot.sources.some((source) => source.id === "source-openalex-test")).toBe(true);
    expect(snapshot.evidence.some((evidence) => evidence.id === "evidence-openalex-test")).toBe(true);
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
    const codexCli = new CapturingCodexCliAdapter();
    const orchestrator = createStrictTestOrchestrator({
      codexCli,
      llm: new CodexCliOnlyPlanner(),
      settings: {
        ...strictTestSettings,
        allowCodeExecution: true,
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
        allowCodeExecution: true,
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
    snapshot = await orchestrator.startLoop(snapshot.project.id, explicitCodexCliExecution());

    expect(snapshot.project.status).toBe("completed");
    expect(activeInputId).toBeDefined();
    expect(activeInputId).not.toBe(staleInputId);
    expect(codexCli.requests).toHaveLength(1);
    expect(codexCli.requests[0]?.input.task).toBe("Analyze the active research brief.");
    expect(snapshot.specifications.at(-1)?.sourceResearchInputId).toBe(activeInputId);
    expect(snapshot.researchPlans.at(-1)?.sourceResearchInputId).toBe(activeInputId);
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

  it("does not implicitly select Codex CLI when the job policy does not allow it", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-loop-"));
    const orchestrator = createStrictTestOrchestrator({
      storage: new NodeProjectStorage(),
      projectRootBase: join(tempDir, "projects"),
      settings: strictTestSettings
    });

    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.FinalizeOutputs);
    expect(snapshot.project.status).toBe("completed");
    expect(snapshot.runtimeBlockers).toHaveLength(0);
    expect(snapshot.stepErrors).toHaveLength(0);
    expect(snapshot.legacyAgentRuns).toHaveLength(0);
    expect(snapshot.toolRuns.map((run) => run.toolName)).toEqual(expect.arrayContaining(["DataAnalysisTool", "ArtifactWriterTool"]));
    expect(snapshot.report).toBeDefined();
    expect(snapshot.finalOutputs).toHaveLength(1);
    expect(existsSync(join(snapshot.project.projectRoot, "reports", "final-report.pdf"))).toBe(true);
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
    expect(snapshot.legacyAgentRuns).toHaveLength(0);
    expect(snapshot.toolRuns.map((run) => run.toolName)).toEqual(expect.arrayContaining(["DataAnalysisTool", "ArtifactWriterTool"]));
    expect(snapshot.sources.length).toBeGreaterThan(0);
    expect(snapshot.artifacts.length).toBeGreaterThan(0);
    expect(snapshot.normalizedRecords.length).toBeGreaterThan(0);
    expect(snapshot.evidence.some((item) => !item.sourceUri && !item.citation && !item.quote)).toBe(false);
    expect(existsSync(join(snapshot.project.projectRoot, "reports", "run-audit.md"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "exports", "run-audit.json"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "reports", "final-report.pdf"))).toBe(false);
  });

  it("fails validation at PlanResearch when the LLM requests an unregistered tool", async () => {
    const orchestrator = createStrictTestOrchestrator({ llm: new UnregisteredToolPlanner() });
    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.PlanResearch);
    expect(snapshot.project.status).toBe("failed");
    expect(snapshot.runtimeBlockers).toHaveLength(0);
    expect(snapshot.stepErrors.at(-1)).toMatchObject({ step: ResearchLoopStep.PlanResearch, cause: "step_failed" });
    expect(snapshot.legacyAgentRuns).toHaveLength(0);
    expect(snapshot.finalOutputs).toHaveLength(0);
  });

  it("records ExecuteTools as the failed step when a configured execution tool fails", async () => {
    const orchestrator = createStrictTestOrchestrator({
      codexCli: failingAdapter(),
      llm: new CodexCliOnlyPlanner(),
      settings: { ...strictTestSettings, allowCodeExecution: true }
    });
    let snapshot = await createInputProject(orchestrator, {
      ...input,
      autonomyPolicy: { ...input.autonomyPolicy, allowCodeExecution: true }
    });
    snapshot = await orchestrator.startLoop(snapshot.project.id, explicitCodexCliExecution());

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.ExecuteTools);
    expect(snapshot.project.status).toBe("failed");
    expect(snapshot.stepErrors.at(-1)?.step).toBe(ResearchLoopStep.ExecuteTools);
    expect(snapshot.legacyAgentRuns).toHaveLength(0);
    expect(snapshot.toolRuns).toHaveLength(0);
    expect(snapshot.finalOutputs).toHaveLength(0);
  });

  it("quarantines acquisition outputs when the Codex CLI attempt fails", async () => {
    const orchestrator = createStrictTestOrchestrator({
      codexCli: failingAdapter(),
      llm: new MetadataFirstPlanner(),
      toolRunner: new ToolRunner([metadataAcquisitionTool]),
      settings: {
        ...strictTestSettings,
        allowExternalSearch: true,
        allowCodeExecution: true
      }
    });
    let snapshot = await createInputProject(orchestrator, {
      ...input,
      autonomyPolicy: {
        ...input.autonomyPolicy,
        allowExternalSearch: true,
        allowCodeExecution: true
      }
    });
    snapshot = await orchestrator.startLoop(snapshot.project.id, explicitCodexCliExecution({ mode: "discovery", allowedDomains: ["openalex.org"] }));

    expect(snapshot.project.status).toBe("failed");
    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.ExecuteTools);
    expect(snapshot.legacyAgentRuns).toHaveLength(0);
    expect(snapshot.toolRuns.some((toolRun) => toolRun.id === "tool-openalex-test")).toBe(false);
    expect(snapshot.sources.some((source) => source.id === "source-openalex-test")).toBe(false);
    expect(snapshot.evidence.some((evidence) => evidence.id === "evidence-openalex-test")).toBe(false);
  });
});
