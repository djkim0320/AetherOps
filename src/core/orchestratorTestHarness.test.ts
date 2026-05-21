import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "./embeddingProvider.js";
import type { LlmJsonRequest, LlmProvider } from "./llm.js";
import { InMemoryResearchStore } from "./memoryStore.js";
import { AetherOpsOrchestrator } from "./orchestrator.js";
import { ToolRunner } from "./toolRunner.js";
import { createId, nowIso } from "./ids.js";
import type { ProjectStorage } from "./projectStorage.js";
import { VectorRagEngine } from "./vectorRagEngine.js";
import type {
  AppSettings,
  OpenCodeAdapter,
  OpenCodeRunInput,
  OpenCodeRunOutput,
  RagEngine,
  ResearchArtifact,
  ResearchDatabase,
  ResearchInput,
  ResearchProject,
  ResearchProjectInput,
  ResearchSource,
  ResearchStore
} from "./types.js";

export const strictTestSettings: AppSettings = {
  openCodeLlm: { source: "codex-oauth", model: "gpt-5.5" },
  openCode: { enabled: true, command: "opencode", provider: "openai", model: "gpt-5.5", timeoutMs: 180_000 },
  webSearch: { provider: "disabled" },
  embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 64, apiKey: "test-key", apiKeyConfigured: true },
  browserUse: { enabled: false, mode: "background", maxPages: 2, timeoutMs: 30_000, captureScreenshots: false },
  allowExternalSearch: false,
  allowCodeExecution: false,
  maxLoopIterations: 2,
  ontologyExtractionMode: "rule_based",
  finalOutputExport: { markdown: true, json: true, ontologyGraph: true, artifactPackage: true },
  updatedAt: "2026-05-20T00:00:00.000Z"
};

export const strictResearchInput = {
  researchQuestion: "AetherOps가 12단계 연구 검증 루프를 올바른 순서로 수행하는가?",
  initialHypotheses: [
    "명시적 연구 입력과 설정이 있으면 12단계 루프가 완료될 수 있다.",
    "계속 연구가 필요하면 11번 판단 뒤 4번 연구 계획으로 복귀해야 한다."
  ],
  constraints: ["테스트 더블은 테스트 파일에서만 사용한다."],
  expectedOutputs: ["final-report.md", "reusable-knowledge.md"]
};

export function createStrictTestOrchestrator(options: {
  store?: ResearchStore;
  openCode?: OpenCodeAdapter;
  ragEngine?: RagEngine;
  llm?: LlmProvider;
  embeddingProvider?: EmbeddingProvider;
  settings?: AppSettings;
  storage?: ProjectStorage;
  projectRootBase?: string;
  toolRunner?: ToolRunner;
} = {}): AetherOpsOrchestrator {
  const embeddingProvider = options.embeddingProvider ?? new DeterministicEmbeddingProvider(strictTestSettings.embedding.dimensions ?? 64);
  return new AetherOpsOrchestrator(
    options.store ?? new InMemoryResearchStore(),
    options.openCode ?? new DeterministicOpenCodeAdapter(),
    options.ragEngine ?? new VectorRagEngine(embeddingProvider),
    options.projectRootBase ?? ".aetherops/test-projects",
    options.llm ?? new DeterministicLlmProvider(),
    options.storage ?? new TestProjectStorage(),
    embeddingProvider,
    () => options.settings ?? strictTestSettings,
    options.toolRunner ?? new ToolRunner()
  );
}

export async function createInputProject(orchestrator: AetherOpsOrchestrator, input: ResearchProjectInput) {
  let snapshot = await orchestrator.createProject(input);
  snapshot = await orchestrator.inputResearchQuestionHypothesis(snapshot.project.id, strictResearchInput);
  return snapshot;
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly dimensions = 64) {}

  async embed(text: string): Promise<number[]> {
    const vector = new Array(this.dimensions).fill(0);
    for (const token of text.toLowerCase().split(/[^a-z0-9가-힣]+/).filter(Boolean)) {
      const index = Math.abs(hash(token)) % this.dimensions;
      vector[index] += 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => Number((value / norm).toFixed(8)));
  }
}

export class DeterministicLlmProvider implements LlmProvider {
  readonly name = "deterministic-test-llm";

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    if (request.schemaName === "AetherOpsResearchSpecification") {
      return {
        researchQuestions: [
          "AetherOps가 12단계를 순서대로 실행하는가?",
          "Vector Index와 Ontology Graph가 정규화 데이터에서 생성되는가?",
          "계속 연구 판단은 연구 계획 단계로 복귀하는가?"
        ],
        refinedHypotheses: [
          "strict 설정이 충족되면 루프는 최종 산출까지 진행된다.",
          "근거가 부족한 첫 iteration은 PlanResearch 복귀를 유도한다."
        ],
        assumptions: ["테스트 입력은 실제 외부 연구 근거가 아니라 흐름 검증 입력이다."],
        constraints: ["실제 URL/DOI를 만들지 않는다."],
        successCriteria: ["12단계 기록", "최종 산출 저장"],
        requiredEvidenceTypes: ["tool log", "artifact", "citation"],
        competencyQuestions: ["어떤 단계가 어떤 산출물을 만드는가?", "shouldContinue=true 이후 어디로 복귀하는가?"],
        evaluationMetrics: ["step coverage", "citation coverage"]
      } as T;
    }
    if (request.schemaName === "AetherOpsResearchPlan") {
      const secondIteration = request.user.includes("iteration\":2") || request.user.includes("Iteration 2");
      return {
        objective: secondIteration ? "Iteration 2: resolve remaining validation gaps." : "Iteration 1: gather traceable execution evidence.",
        targetQuestions: ["q1"],
        targetHypotheses: ["h1"],
        requiredTools: ["OpenCodeTool", "ArtifactWriterTool", "DataAnalysisTool"],
        expectedSources: ["tool log", "artifact"],
        expectedArtifacts: ["research-note.md"],
        executionSteps: ["Run OpenCodeTool", "Normalize outputs", "Validate hypotheses"],
        stopCriteria: ["Enough cited evidence exists", "maxLoopIterations reached"]
      } as T;
    }
    if (request.schemaName === "AetherOpsEvidenceBasedResult") {
      const forceStop = request.user.includes("final allowed iteration");
      return {
        answer: forceStop ? "AetherOps loop completed with traceable test evidence." : "AetherOps loop needs one more planned iteration.",
        hypothesisUpdates: [
          {
            hypothesisIndex: 0,
            status: forceStop ? "supported" : "needs_more_evidence",
            confidence: forceStop ? 0.75 : 0.45,
            rationale: "Based on deterministic test execution artifacts and citations."
          },
          {
            hypothesisIndex: 1,
            status: forceStop ? "supported" : "needs_more_evidence",
            confidence: forceStop ? 0.72 : 0.4,
            rationale: "First iteration keeps an evidence gap so the loop must return to planning."
          }
        ],
        quantitativeResults: ["step coverage tracked"],
        qualitativeResults: ["strict loop ordering preserved"],
        nextQuestions: forceStop ? [] : ["Which validation gap remains?"],
        needsMoreEvidence: !forceStop,
        needsMoreAnalysis: !forceStop
      } as T;
    }
    return {
      answer: "Deterministic test answer.",
      citations: [],
      limitations: ["Test-only response."],
      nextActions: []
    } as T;
  }
}

export class DeterministicOpenCodeAdapter implements OpenCodeAdapter {
  async run(input: OpenCodeRunInput): Promise<OpenCodeRunOutput> {
    const createdAt = "2026-05-20T00:00:00.000Z";
    const artifact = {
      id: `artifact-${input.iteration}`,
      projectId: input.project.id,
      category: "generated_artifact" as const,
      title: `Deterministic analysis ${input.iteration}`,
      relativePath: `artifacts/iteration-${input.iteration}/analysis.md`,
      mimeType: "text/markdown",
      summary: `Analysis artifact for ${input.project.topic}`,
      content: `Iteration ${input.iteration} analysis for ${input.project.topic}.`,
      createdAt
    };
    const evidence = {
      id: `evidence-${input.iteration}`,
      projectId: input.project.id,
      category: "experiment_log" as const,
      title: `Deterministic evidence ${input.iteration}`,
      summary: `Execution evidence for ${input.project.topic}.`,
      sourceUri: artifact.relativePath,
      citation: `${artifact.relativePath}#iteration-${input.iteration}`,
      keywords: ["analysis", `iteration-${input.iteration}`],
      linkedHypothesisIds: input.hypotheses.map((item) => item.id),
      reliabilityScore: 0.65,
      relevanceScore: 0.7,
      evidenceStrength: "medium" as const,
      limitations: ["Test-only evidence, not a real external source."],
      createdAt
    };
    return {
      run: {
        id: `opencode-${input.iteration}`,
        projectId: input.project.id,
        iteration: input.iteration,
        prompt: `deterministic test run ${input.iteration}`,
        toolPlan: ["OpenCodeTool"],
        status: "completed",
        logs: [`deterministic run ${input.iteration}`],
        artifactIds: [artifact.id],
        evidenceIds: [evidence.id],
        startedAt: createdAt,
        completedAt: createdAt
      },
      artifacts: [artifact],
      evidence: [evidence]
    };
  }
}

export class TestProjectStorage implements ProjectStorage {
  async ensureResearchDb(project: ResearchProject): Promise<ResearchDatabase> {
    return {
      id: createId("db"),
      projectId: project.id,
      sqlitePath: `${project.projectRoot}/research.sqlite`,
      vectorPath: `${project.projectRoot}/vector.sqlite`,
      ontologyPath: `${project.projectRoot}/ontology.sqlite`,
      artifactRoot: `${project.projectRoot}/artifacts`,
      sourceRoot: `${project.projectRoot}/sources`,
      logRoot: `${project.projectRoot}/logs`,
      reportRoot: `${project.projectRoot}/reports`,
      knowledgeRoot: `${project.projectRoot}/knowledge`,
      ontologyRoot: `${project.projectRoot}/ontology`,
      exportsRoot: `${project.projectRoot}/exports`,
      errorsRoot: `${project.projectRoot}/errors`,
      statePath: `${project.projectRoot}/state.json`,
      createdAt: nowIso()
    };
  }

  async writeArtifacts(
    _project: ResearchProject,
    _database: ResearchDatabase,
    _iteration: number,
    artifacts: ResearchArtifact[]
  ): Promise<ResearchArtifact[]> {
    return artifacts;
  }

  async writeRunLog(
    project: ResearchProject,
    _database: ResearchDatabase,
    iteration: number,
    run: { id: string }
  ): Promise<ResearchSource> {
    const createdAt = nowIso();
    return {
      id: `source_${run.id}`,
      projectId: project.id,
      kind: "log",
      title: `Iteration ${iteration} execution log`,
      retrievedAt: createdAt,
      metadata: { runId: run.id, iteration },
      createdAt
    };
  }

  async writeSources(
    _project: ResearchProject,
    _database: ResearchDatabase,
    sources: ResearchSource[]
  ): Promise<ResearchSource[]> {
    return sources;
  }

  async writeChunks(): Promise<void> {}

  async writeOntologyGraph(): Promise<{ ontologyExportPath: string; ontologyNtPath: string }> {
    return { ontologyExportPath: "", ontologyNtPath: "" };
  }

  async writeReportFiles(): Promise<{ reportPath: string; knowledgePath: string }> {
    return { reportPath: "", knowledgePath: "" };
  }

  async writeFinalOutputFiles(): Promise<{ reportPath: string; knowledgePath: string; ontologyExportPath: string; artifactPackagePath: string }> {
    return { reportPath: "", knowledgePath: "", ontologyExportPath: "", artifactPackagePath: "" };
  }

  async writeProjectState(): Promise<void> {}
}

export function researchInputForProject(project: ResearchProject): ResearchInput {
  return {
    id: `input-${project.id}`,
    projectId: project.id,
    researchQuestion: strictResearchInput.researchQuestion,
    initialHypotheses: strictResearchInput.initialHypotheses,
    constraints: strictResearchInput.constraints,
    expectedOutputs: strictResearchInput.expectedOutputs,
    createdAt: project.createdAt
  };
}

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  }
  return result;
}

describe("orchestrator test harness", () => {
  it("provides explicit strict test doubles", () => {
    expect(strictTestSettings.embedding.provider).toBe("openai");
    expect(strictResearchInput.initialHypotheses.length).toBeGreaterThan(0);
  });
});
