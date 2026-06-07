import type { EmbeddingProvider } from "../providers/embeddingProvider.js";
import { EvidenceNormalizer } from "../evidence/evidenceNormalizer.js";
import { FinalOutputWriter } from "../output/finalOutputWriter.js";
import { HybridRetrievalEngine } from "../retrieval/hybridRetrievalEngine.js";
import { createId, createStableId, nowIso } from "../shared/ids.js";
import { LlmTimeoutError, type LlmProvider } from "../providers/llm.js";
import { deriveResultWithLlm } from "../planning/llmPlanning.js";
import { LoopDecisionEngine } from "../planning/loopDecision.js";
import { MemoryPromotionEngine } from "../memory/memoryPromotion.js";
import { OntologyGraphEngine } from "../retrieval/ontologyGraphEngine.js";
import type { ProjectStorage } from "../storage/projectStorage.js";
import { ProjectContextBuilder } from "../retrieval/projectContextBuilder.js";
import { ReasoningEngine } from "../reasoning/reasoningEngine.js";
import { buildResearchInputPayloadFromBrief, createResearchInput, type ResearchInputPayload } from "../input/researchInput.js";
import { buildResearchReport } from "../output/report.js";
import { ResearchPlanner } from "../planning/researchPlanner.js";
import { buildBenchmarkPlan, buildRunAuditOutput, RunAuditWriter } from "../output/runAuditWriter.js";
import { createDefaultSessions } from "../input/researchSeed.js";
import { dedupeSourcesByIdUrlDoi } from "../evidence/sourceDedupe.js";
import { ResearchSpecificationBuilder } from "../planning/researchSpecification.js";
import { RuntimeRequirementChecker, RuntimeRequirementError } from "../tools/runtimeRequirements.js";
import { normalizeToolName, ToolRunner, ToolRunnerError } from "../tools/toolRunner.js";
import type { ResearchToolResult } from "../tools/toolRegistry.js";
import { ValidationEngine } from "../reasoning/validationEngine.js";
import { VectorIndexEngine } from "../retrieval/vectorIndexEngine.js";
import { ResultSynthesizer } from "../reasoning/resultSynthesizer.js";
import {
  ResearchLoopStep,
  type AppSettings,
  type ContinuationDecision,
  type ResearchProjectInput,
  type EvidenceBasedResult,
  type EvidenceItem,
  type FlowKind,
  type Hypothesis,
  type LoopIteration,
  type OpenCodeAdapter,
  type OpenCodeRunInput,
  type OpenCodeRunOutput,
  type OpenCodeRun,
  type RagContext,
  type RagEngine,
  type ResearchArtifact,
  type ResearchChunk,
  type ResearchDatabase,
  type ResearchInput,
  type ResearchPlan,
  type ResearchProject,
  type ResearchQuestion,
  type ResearchSession,
  type ResearchSnapshot,
  type ResearchSource,
  type ResearchSpecification,
  type ResearchStore,
  type RuntimeRequirement,
  type RuntimeBlocker,
  type StepError,
  type ToolRun
} from "../shared/types.js";

type SettingsGetter = () => AppSettings | Promise<AppSettings>;

interface ChatReplyResponse {
  answer?: string;
  citations?: string[];
  limitations?: string[];
  nextActions?: string[];
}

const defaultSettings: AppSettings = {
  openCodeLlm: { source: "codex-oauth", model: "gpt-5.5" },
  openCode: { enabled: false, command: "opencode", provider: "openai", model: "gpt-5.5", timeoutMs: 180_000 },
  webSearch: { provider: "disabled" },
  embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
  browserUse: { enabled: false, mode: "background", maxPages: 2, timeoutMs: 30_000, captureScreenshots: false },
  researchMetadata: { enabled: true, provider: "openalex", maxResults: 5, timeoutMs: 15_000 },
  engineeringTools: {
    enabled: false,
    xfoil: { enabled: false, command: "", timeoutMs: 30_000 },
    modeling: { enabled: false, artifactRoot: "", maxMeshBytes: 20 * 1024 * 1024 },
    openFoam: { enabled: false, command: "", caseRoot: "", workingDirectory: "", probeArgs: ["-help"], runArgsTemplate: ["-case", "{case}"], timeoutMs: 30 * 60_000 },
    su2: { enabled: false, command: "", caseRoot: "", configFile: "", workingDirectory: "", probeArgs: ["--help"], runArgsTemplate: ["{config}"], timeoutMs: 30 * 60_000 },
    freeCad: { enabled: false, command: "", scriptPath: "", workingDirectory: "", probeArgs: ["--version"], runArgsTemplate: ["{script}", "--output", "{output}"], timeoutMs: 30 * 60_000 },
    openVsp: { enabled: false, command: "", scriptPath: "", workingDirectory: "", probeArgs: ["-help"], runArgsTemplate: ["-script", "{script}", "-output", "{output}"], timeoutMs: 30 * 60_000 },
    commercialCfd: {
      flightStreamConfigured: false,
      starCcmConfigured: false,
      flightStreamCommand: "",
      flightStreamWorkingDirectory: "",
      flightStreamProbeArgs: ["--version"],
      flightStreamRunArgsTemplate: [],
      flightStreamTimeoutMs: 120_000,
      starCcmCommand: "",
      starCcmWorkingDirectory: "",
      starCcmProbeArgs: ["-version"],
      starCcmRunArgsTemplate: [],
      starCcmTimeoutMs: 120_000,
      notes: ""
    }
  },
  allowExternalSearch: false,
  allowCodeExecution: false,
  ontologyExtractionMode: "rule_based",
  finalOutputExport: { markdown: true, json: true, ontologyGraph: true, artifactPackage: true },
  updatedAt: nowIso()
};

const INTERNAL_LOOP_SAFETY_CAP = 8;
const ignoredChatProgressMessages = ["사용자 메시지", "LLM 응답", "세션이 생성", "세션을 삭제", "연구 프로젝트가 생성"];
const reportableChatSteps = new Set<ResearchLoopStep>([
  ResearchLoopStep.CreateResearchDb,
  ResearchLoopStep.InputResearchQuestionHypothesis,
  ResearchLoopStep.BuildResearchSpecification,
  ResearchLoopStep.PlanResearch,
  ResearchLoopStep.ExecuteTools,
  ResearchLoopStep.NormalizeData,
  ResearchLoopStep.BuildVectorIndex,
  ResearchLoopStep.BuildOntologyGraph,
  ResearchLoopStep.ReasonAndValidate,
  ResearchLoopStep.SynthesizeAndEvaluate,
  ResearchLoopStep.DecideContinuation,
  ResearchLoopStep.FinalizeOutputs
]);

export class AetherOpsOrchestrator {
  private readonly specificationBuilder: ResearchSpecificationBuilder;
  private readonly planner: ResearchPlanner;
  private readonly normalizer = new EvidenceNormalizer();
  private readonly ontologyGraph = new OntologyGraphEngine();
  private readonly reasoning = new ReasoningEngine();
  private readonly validation = new ValidationEngine();
  private readonly projectContextBuilder = new ProjectContextBuilder();
  private readonly resultSynthesizer = new ResultSynthesizer();
  private readonly memoryPromotion = new MemoryPromotionEngine();
  private readonly loopDecision = new LoopDecisionEngine();
  private readonly requirements = new RuntimeRequirementChecker();

  constructor(
    private readonly store: ResearchStore,
    private readonly openCode: OpenCodeAdapter,
    private readonly ragEngine: RagEngine,
    private readonly projectRootBase = ".aetherops/projects",
    private readonly llm: LlmProvider | undefined,
    private readonly projectStorage: ProjectStorage,
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly getSettings: SettingsGetter = () => defaultSettings,
    private readonly toolRunner?: ToolRunner
  ) {
    this.specificationBuilder = new ResearchSpecificationBuilder(llm);
    this.planner = new ResearchPlanner(llm, async (projectId, error, retryAttempt) => {
      await this.saveStepError(projectId, ResearchLoopStep.PlanResearch, error.message, "llm_timeout", {
        ...error.metadata,
        retryAttempt
      });
    });
  }

  async listProjects(): Promise<ResearchProject[]> {
    return this.store.listProjects();
  }

  async getSnapshot(projectId: string): Promise<ResearchSnapshot> {
    return this.store.getSnapshot(projectId);
  }

  async updateProjectInput(projectId: string, input: ResearchProjectInput): Promise<ResearchSnapshot> {
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const updated: ResearchProject = {
      ...snapshot.project,
      goal: input.goal,
      topic: input.topic,
      scope: input.scope,
      budget: input.budget,
      autonomyPolicy: {
        ...snapshot.project.autonomyPolicy,
        ...input.autonomyPolicy
      },
      updatedAt: nowIso()
    };
    await this.store.updateProject(updated);
    await this.record(projectId, snapshot.project.currentStep, "Main Flow", "프로젝트 연구 메타데이터가 최신 입력으로 저장되었습니다.");
    return this.store.getSnapshot(projectId);
  }

  async getLlmStatus(): Promise<{ provider: string; available: boolean }> {
    return {
      provider: this.llm?.name ?? "unconfigured",
      available: this.llm ? await this.llm.isAvailable() : false
    };
  }

  async createProject(input: ResearchProjectInput): Promise<ResearchSnapshot> {
    const createdAt = nowIso();
    const project: ResearchProject = {
      ...input,
      id: createId("project"),
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.CreateResearchDb,
      status: "idle",
      projectRoot: `${this.projectRootBase}/${slugify(input.topic)}-${createdAt.slice(0, 10)}`
    };
    await this.store.saveProject(project);
    await this.record(project.id, ResearchLoopStep.CreateResearchDb, "Main Flow", "연구 프로젝트가 생성되었고 연구 DB 생성을 기다립니다.");
    return this.store.getSnapshot(project.id);
  }

  async createSubSessions(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    if (!snapshot.sessions.length) {
      await this.store.saveSessions(createDefaultSessions(snapshot.project));
      await this.record(projectId, snapshot.project.currentStep, "Main Flow", "기본 채팅 세션이 생성되었습니다.");
    }
    return this.store.getSnapshot(projectId);
  }

  async createChatSession(projectId: string, title?: string, focus?: string): Promise<ResearchSnapshot> {
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const createdAt = nowIso();
    const chatCount = countChatSessions(snapshot.sessions) + 1;
    const session: ResearchSession = {
      id: createId("session"),
      projectId,
      title: title?.trim() || `채팅 세션 ${chatCount}`,
      focus: focus?.trim() || `${snapshot.project.topic} 관련 연구 대화 세션입니다.`,
      createdAt
    };
    await this.store.saveSessions([session]);
    await this.record(projectId, snapshot.project.currentStep, "Main Flow", `${session.title} 세션이 생성되었습니다.`);
    return this.store.getSnapshot(projectId);
  }

  async deleteChatSession(projectId: string, sessionId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const session = snapshot.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return snapshot;
    }
    await this.store.deleteSession(projectId, sessionId);
    await this.record(projectId, snapshot.project.currentStep, "Main Flow", `${session.title} 세션을 삭제했습니다.`);
    return this.store.getSnapshot(projectId);
  }

  async sendChatMessage(projectId: string, sessionId: string, content: string): Promise<ResearchSnapshot> {
    const message = content.trim();
    if (!message) {
      throw new Error("메시지가 비어 있습니다.");
    }

    const snapshot = await this.store.getSnapshot(projectId);
    const session = snapshot.sessions.find((item) => item.id === sessionId);
    if (!session) {
      throw new Error("선택한 채팅 세션을 찾을 수 없습니다.");
    }

    const database = await this.requireDatabase(projectId);
    const iteration = Math.max(snapshot.openCodeRuns.length, 1);
    const userArtifact: ResearchArtifact = {
      id: createId("artifact"),
      projectId,
      category: "conversation_memo",
      title: `${session.title} 사용자 메시지`,
      relativePath: `artifacts/chat/${session.id}-${Date.now()}-user.md`,
      mimeType: "text/markdown",
      summary: message,
      content: message,
      createdAt: nowIso()
    };
    const [writtenUserArtifact] = await this.projectStorage.writeArtifacts(snapshot.project, database, iteration, [userArtifact]);
    await this.store.saveArtifacts([writtenUserArtifact]);
    await this.record(projectId, snapshot.project.currentStep, "Main Flow", `${session.title} 사용자 메시지가 저장되었습니다.`);

    if (!this.llm || !(await this.llm.isAvailable())) {
      throw new Error("현재 선택한 LLM을 사용할 수 없습니다. 모델 선택 또는 OAuth/API 설정을 확인해 주세요.");
    }

    const latest = await this.store.getSnapshot(projectId);
    const reply = await this.completeChatReply(latest, session, message);
    const assistantArtifact: ResearchArtifact = {
      id: createId("artifact"),
      projectId,
      category: "conversation_memo",
      title: `${session.title} 응답`,
      relativePath: `artifacts/chat/${session.id}-${Date.now()}-assistant.md`,
      mimeType: "text/markdown",
      summary: summarize(reply),
      content: reply,
      createdAt: nowIso()
    };
    const [writtenAssistantArtifact] = await this.projectStorage.writeArtifacts(snapshot.project, database, iteration, [assistantArtifact]);
    await this.store.saveArtifacts([writtenAssistantArtifact]);
    await this.record(projectId, snapshot.project.currentStep, "Agent Control", `${session.title} LLM 응답이 저장되었습니다.`);
    return this.store.getSnapshot(projectId);
  }

  async createResearchDb(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const database = await this.projectStorage.ensureResearchDb(snapshot.project);
    await this.store.saveDatabase(database);
    await this.moveProject(projectId, ResearchLoopStep.CreateResearchDb);
    await this.record(projectId, ResearchLoopStep.CreateResearchDb, "Storage Flow", "프로젝트별 research/vector/ontology DB와 파일 저장소가 생성되었습니다.");
    return this.store.getSnapshot(projectId);
  }

  async inputResearchQuestionHypothesis(projectId: string, payload?: ResearchInputPayload): Promise<ResearchSnapshot> {
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const resolvedPayload = buildResearchInputPayloadFromBrief(snapshot.project, payload ?? {});
    const activeContext = activeResearchContext(snapshot);
    if (!activeContext.input || !researchInputMatchesPayload(activeContext.input, resolvedPayload) || !activeContext.questions.length || !activeContext.hypotheses.length) {
      const created = createResearchInput(snapshot.project, resolvedPayload);
      await this.store.saveResearchInput(created.input);
      await this.store.saveQuestions(created.questions);
      await this.store.saveHypotheses(created.hypotheses);
    }
    try {
      await this.assertStepReady(projectId, ResearchLoopStep.InputResearchQuestionHypothesis);
    } catch (error) {
      if (error instanceof RuntimeRequirementError) {
        return this.blockProject(projectId, error);
      }
      throw error;
    }
    await this.moveProject(projectId, ResearchLoopStep.InputResearchQuestionHypothesis, snapshot.project.status === "blocked" ? "idle" : undefined);
    await this.record(projectId, ResearchLoopStep.InputResearchQuestionHypothesis, "Main Flow", "명시적인 연구 질문과 초기 가설이 입력되었습니다.");
    return this.store.getSnapshot(projectId);
  }

  async buildResearchSpecification(projectId: string): Promise<ResearchSnapshot> {
    await this.assertStepReady(projectId, ResearchLoopStep.BuildResearchSpecification);
    await this.moveProject(projectId, ResearchLoopStep.BuildResearchSpecification);
    const activeSnapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const activeInput = activeSnapshot.researchInputs.at(-1);
    const specification = await this.specificationBuilder.build({
      project: activeSnapshot.project,
      questions: activeSnapshot.questions,
      hypotheses: activeSnapshot.hypotheses,
      evidence: activeSnapshot.evidence
    });
    await this.store.saveResearchSpecification({
      ...specification,
      sourceResearchInputId: activeInput?.id,
      sourceQuestionIds: activeSnapshot.questions.map((question) => question.id),
      sourceHypothesisIds: activeSnapshot.hypotheses.map((hypothesis) => hypothesis.id)
    });
    await this.record(projectId, ResearchLoopStep.BuildResearchSpecification, "Agent Control", "연구 명세와 가설 검증 전략이 생성되었습니다.");
    return this.store.getSnapshot(projectId);
  }

  async planResearch(projectId: string, iteration?: number, decision?: ContinuationDecision): Promise<ResearchSnapshot> {
    try {
      await this.assertStepReady(projectId, ResearchLoopStep.PlanResearch);
      const snapshot = await this.store.getSnapshot(projectId);
      const specification = await this.ensureSpecification(projectId);
      const settings = await this.getSettings();
      const activeSnapshot = activeResearchSnapshot(snapshot);
      const executableTools = this.executableToolNames(activeSnapshot, settings);
      await this.moveProject(projectId, ResearchLoopStep.PlanResearch);
      const plan = await this.planner.plan({
        snapshot: activeResearchSnapshot(await this.store.getSnapshot(projectId)),
        specification,
        iteration: iteration ?? nextIteration(activeSnapshot),
        settings,
        availableTools: executableTools,
        continuationDecision: decision ?? activeSnapshot.continuationDecisions.at(-1)
      });
      this.assertPlanToolsAllowed(plan, executableTools);
      await this.store.saveResearchPlan({
        ...plan,
        sourceResearchInputId: activeSnapshot.researchInputs.at(-1)?.id,
        sourceSpecificationId: specification.id
      });
      await this.moveProject(projectId, ResearchLoopStep.PlanResearch);
      await this.record(projectId, ResearchLoopStep.PlanResearch, "Agent Control", `Iteration ${plan.iteration} 연구 계획이 수립되었습니다.`);
      return this.store.getSnapshot(projectId);
    } catch (error) {
      if (error instanceof RuntimeRequirementError) {
        return this.blockProject(projectId, error);
      }
      await this.failProject(projectId, ResearchLoopStep.PlanResearch, error);
      return this.store.getSnapshot(projectId);
    }
  }

  async seedQuestions(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.inputResearchQuestionHypothesis(projectId);
    if (snapshot.project.status === "blocked") {
      return snapshot;
    }
    return this.buildResearchSpecification(projectId);
  }

  async startLoop(projectId: string): Promise<ResearchSnapshot> {
    try {
      const startingSnapshot = await this.store.getSnapshot(projectId);
      if (startingSnapshot.project.status === "blocked" || startingSnapshot.project.status === "failed") {
        await this.setStatus(projectId, "idle");
      }
      await this.ensureResearchDb(projectId);
      const inputSnapshot = await this.ensureResearchInput(projectId);
      if (inputSnapshot.project.status === "blocked") return inputSnapshot;
      const specificationSnapshot = await this.ensureResearchSpecification(projectId);
      if (specificationSnapshot.project.status === "blocked" || specificationSnapshot.project.status === "failed") return specificationSnapshot;
      await this.setStatus(projectId, "running");
      const initialSnapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
      const safetyCapIterations = resolveSafetyCapIterations(initialSnapshot.project.autonomyPolicy.maxLoopIterations);
      const firstIteration = nextExecutionIteration(initialSnapshot);
      for (let iteration = firstIteration; iteration <= safetyCapIterations; iteration += 1) {
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        const beforeCounts = counts(activeResearchSnapshot(await this.store.getSnapshot(projectId)));

        await this.ensureResearchPlan(projectId, iteration);
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        await this.executeTools(projectId, iteration);
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        await this.normalizeData(projectId, iteration);
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        await this.buildVectorIndex(projectId);
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        await this.buildOntologyGraph(projectId);
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        await this.reasonAndValidate(projectId, iteration);
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        const result = await this.synthesizeAndEvaluate(projectId, iteration, iteration >= safetyCapIterations);
        const decision = await this.decideContinuation(projectId, result, beforeCounts, iteration, safetyCapIterations);
        if (!decision.shouldContinue) {
          break;
        }
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        await this.planResearch(projectId, iteration + 1, decision);
      }

      if ((await this.checkAbortOrPause(projectId)) !== "running") {
        return this.store.getSnapshot(projectId);
      }
      return this.finalizeOutputs(projectId);
    } catch (error) {
      if (error instanceof RuntimeRequirementError) {
        return this.blockProject(projectId, error);
      }
      const failedStep = (await this.store.getSnapshot(projectId)).project.currentStep;
      await this.failProject(projectId, failedStep, error);
      return this.store.getSnapshot(projectId);
    }
  }

  async pause(projectId: string): Promise<ResearchSnapshot> {
    await this.setStatus(projectId, "paused");
    await this.record(projectId, (await this.store.getSnapshot(projectId)).project.currentStep, "Agent Control", "연구 루프가 일시정지되었습니다.");
    return this.store.getSnapshot(projectId);
  }

  async resume(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    if (snapshot.project.status !== "paused") {
      return snapshot;
    }
    await this.setStatus(projectId, "running");
    await this.record(projectId, snapshot.project.currentStep, "Agent Control", "연구 루프를 재개합니다.");
    return this.startLoop(projectId);
  }

  async abort(projectId: string): Promise<ResearchSnapshot> {
    await this.setStatus(projectId, "aborted");
    await this.record(projectId, (await this.store.getSnapshot(projectId)).project.currentStep, "Agent Control", "연구 루프가 중단되었습니다.");
    return this.store.getSnapshot(projectId);
  }

  async executeTools(projectId: string, iteration?: number): Promise<ResearchSnapshot> {
    await this.assertStepReady(projectId, ResearchLoopStep.ExecuteTools, { checkOpenCodePreflight: true });
    const storedSnapshot = await this.store.getSnapshot(projectId);
    const snapshot = activeResearchSnapshot(storedSnapshot);
    const activeIteration = iteration ?? nextExecutionIteration(snapshot);
    await this.moveProject(projectId, ResearchLoopStep.ExecuteTools);
    await this.record(projectId, ResearchLoopStep.ExecuteTools, "Agent Control", `Iteration ${activeIteration} 도구 실행 및 연구 수행을 시작합니다.`);
    const researchPlan = snapshot.researchPlans.at(-1);
    const projectContextSnapshot = snapshot.projectContextSnapshots.at(-1);
    const continuationSources = sourceCandidatesFromPlan(projectId, activeIteration, researchPlan, projectContextSnapshot);
    const runInput: OpenCodeRunInput = {
      project: snapshot.project,
      questions: snapshot.questions,
      hypotheses: snapshot.hypotheses,
      evidence: snapshot.evidence,
      artifacts: snapshot.artifacts,
      sources: dedupeSourcesByIdUrlDoi([...snapshot.sources, ...continuationSources]),
      ragContext: snapshot.ragContexts.at(-1),
      hybridContext: snapshot.hybridContexts.at(-1),
      specification: snapshot.specifications.at(-1),
      researchPlan,
      projectContextSnapshot,
      normalizedRecords: snapshot.normalizedRecords,
      validationResults: snapshot.validationResults,
      projectContextSnapshots: snapshot.projectContextSnapshots,
      results: snapshot.results,
      iteration: activeIteration
    };
    try {
      const database = await this.requireDatabase(projectId);
      const settings = await this.getSettings();
      const acquisitionTools = preOpenCodeToolNames(researchPlan);
      let preToolResults: ResearchToolResult[] = [];
      let openCodeInput = runInput;
      if (this.toolRunner && acquisitionTools.length) {
        try {
          preToolResults = await this.toolRunner.runAll(runInput, settings, { includeTools: acquisitionTools });
          openCodeInput = applyToolResultsToOpenCodeInput(runInput, preToolResults);
        } catch (toolError) {
          if (toolError instanceof ToolRunnerError) {
            const resultsToPersist = [
              ...toolError.partialResults,
              ...(toolError.failedResult ? [toolError.failedResult] : [])
            ];
            await this.persistToolResults(snapshot.project, database, activeIteration, resultsToPersist);
          }
          throw toolError;
        }
      }
      const openCodeRunId = createId("opencode");
      const executionBundleId = buildExecutionBundleId(snapshot.project.id, activeIteration, openCodeRunId);
      const openCodeAttemptInput: OpenCodeRunInput = {
        ...openCodeInput,
        openCodeRunId,
        executionBundleId
      };
      const runAttempt = await this.createOpenCodeRunAttempt(openCodeAttemptInput, executionBundleId);
      await this.store.saveOpenCodeRun(runAttempt);
      if (preToolResults.length) {
        await this.persistToolResults(snapshot.project, database, activeIteration, preToolResults, executionBundleId);
      }
      let output: OpenCodeRunOutput;
      try {
        output = await this.openCode.run(openCodeAttemptInput);
      } catch (openCodeError) {
        await this.store.saveOpenCodeRun(failedOpenCodeRun(runAttempt, openCodeError, executionBundleId));
        throw openCodeError;
      }
      output = {
        ...output,
        run: {
          ...output.run,
          id: openCodeRunId,
          metadata: {
            ...(runAttempt.metadata ?? {}),
            ...(output.run.metadata ?? {}),
            executionBundleId
          }
        }
      };
      if (output.fatalError || output.run.status === "failed") {
        const reason = output.fatalError ?? output.run.logs.at(-1) ?? "OpenCode execution failed.";
        await this.record(projectId, ResearchLoopStep.ExecuteTools, "Agent Control", `OpenCode 도구 실패: ${reason}`);
        await this.persistExecutionOutputs(snapshot.project, database, activeIteration, output, preToolResults);
        throw new Error(reason);
      }
      const outputSourceCandidates = output.sourceCandidates ?? [];
      const toolInput = {
        ...openCodeInput,
        evidence: [...(openCodeInput.evidence ?? []), ...output.evidence],
        artifacts: [...(openCodeInput.artifacts ?? []), ...output.artifacts],
        sources: dedupeSourcesByIdUrlDoi([...(openCodeInput.sources ?? []), ...(output.sources ?? []), ...outputSourceCandidates]),
        sourceCandidates: dedupeSourcesByIdUrlDoi(outputSourceCandidates),
        claims: output.claims ?? [],
        observations: output.observations ?? [],
        toolRuns: [...(openCodeInput.toolRuns ?? []), ...(output.toolRuns ?? [])],
        normalizedRecords: snapshot.normalizedRecords,
        validationResults: snapshot.validationResults,
        projectContextSnapshots: snapshot.projectContextSnapshots,
        results: snapshot.results
      };
      let postToolResults: ResearchToolResult[] = [];
      try {
        postToolResults = this.toolRunner ? await this.toolRunner.runAll(toolInput, settings, { excludeTools: acquisitionTools }) : [];
      } catch (toolError) {
        if (toolError instanceof ToolRunnerError) {
          const resultsToPersist = [
            ...preToolResults,
            ...toolError.partialResults,
            ...(toolError.failedResult ? [toolError.failedResult] : [])
          ];
          await this.persistExecutionOutputs(snapshot.project, database, activeIteration, output, resultsToPersist);
        }
        throw toolError;
      }
      const toolResults = [...preToolResults, ...postToolResults];
      await this.persistExecutionOutputs(snapshot.project, database, activeIteration, output, toolResults);
      await this.ingestSources(projectId);
      await this.record(projectId, ResearchLoopStep.ExecuteTools, "Agent Control", "도구 실행 및 연구 수행 단계가 완료되었습니다.");
    } catch (error) {
      await this.failProject(projectId, ResearchLoopStep.ExecuteTools, error);
      return this.store.getSnapshot(projectId);
    }
    return this.store.getSnapshot(projectId);
  }

  private async persistExecutionOutputs(
    project: ResearchProject,
    database: ResearchDatabase,
    iteration: number,
    output: OpenCodeRunOutput,
    toolResults: ResearchToolResult[] = []
  ): Promise<void> {
    const executionBundleId = String(output.run.metadata?.executionBundleId ?? buildExecutionBundleId(project.id, iteration, output.run.id));
    const bundledOutput: OpenCodeRunOutput = {
      ...output,
      run: withOpenCodeRunBundle(output.run, executionBundleId),
      artifacts: bundleArtifacts(output.artifacts, executionBundleId),
      evidence: bundleEvidence(output.evidence, executionBundleId),
      sources: output.sources ? bundleSources(output.sources, executionBundleId) : undefined,
      sourceCandidates: output.sourceCandidates ? bundleSources(output.sourceCandidates, executionBundleId) : undefined,
      claims: output.claims ? bundleOpenCodeStructured(output.claims, executionBundleId) : undefined,
      observations: output.observations ? bundleOpenCodeStructured(output.observations, executionBundleId) : undefined,
      toolRuns: output.toolRuns ? bundleToolRuns(output.toolRuns, executionBundleId) : undefined
    };
    const toolResultArtifacts: ResearchArtifact[] = [];
    const toolResultEvidence: EvidenceItem[] = [];
    const toolResultSources: ResearchSource[] = [];
    const toolRuns = copyItems(bundledOutput.toolRuns ?? []);
    for (const result of toolResults) {
      toolRuns.push(withToolRunBundle(result.toolRun, executionBundleId));
      for (const artifact of result.artifacts) {
        toolResultArtifacts.push(withArtifactBundle(artifact, executionBundleId));
      }
      for (const evidence of result.evidence) {
        toolResultEvidence.push(withEvidenceBundle(evidence, executionBundleId));
      }
      for (const source of result.sources) {
        toolResultSources.push(withSourceBundle(source, executionBundleId));
      }
    }
    const artifacts = await this.projectStorage.writeArtifacts(project, database, iteration, concatItems(bundledOutput.artifacts, toolResultArtifacts));
    const logSource = await this.projectStorage.writeRunLog(project, database, iteration, bundledOutput.run, toolRuns);

    await this.store.saveOpenCodeRun(bundledOutput.run);
    await this.store.saveArtifacts(artifacts);
    await this.store.saveEvidence(concatItems(bundledOutput.evidence, toolResultEvidence));
    const sources = dedupeSourcesByIdUrlDoi(concatSourceGroups(bundledOutput.sources, bundledOutput.sourceCandidates, toolResultSources));
    if (sources.length) {
      await this.store.saveSources(await this.projectStorage.writeSources(project, database, sources));
    }
    if (logSource) await this.store.saveSources([withSourceBundle(logSource, executionBundleId)]);
    if (toolRuns.length) await this.store.saveToolRuns(toolRuns);
    if (bundledOutput.agentPlan) await this.store.saveResearchPlan(bundledOutput.agentPlan);
    if (bundledOutput.chunks?.length) {
      await this.projectStorage.writeChunks(project, database, bundledOutput.chunks);
      await this.store.saveChunks(bundledOutput.chunks);
    }
  }

  private async persistToolResults(
    project: ResearchProject,
    database: ResearchDatabase,
    iteration: number,
    toolResults: ResearchToolResult[],
    executionBundleId = `tool-bundle:${project.id}:${iteration}:${createId("toolbundle")}`
  ): Promise<void> {
    if (!toolResults.length) return;
    const toolResultArtifacts: ResearchArtifact[] = [];
    const toolResultEvidence: EvidenceItem[] = [];
    const toolResultSources: ResearchSource[] = [];
    const toolRuns: ToolRun[] = [];
    for (const result of toolResults) {
      toolRuns.push(withToolRunBundle(result.toolRun, executionBundleId));
      for (const artifact of result.artifacts) {
        toolResultArtifacts.push(withArtifactBundle(artifact, executionBundleId));
      }
      for (const evidence of result.evidence) {
        toolResultEvidence.push(withEvidenceBundle(evidence, executionBundleId));
      }
      for (const source of result.sources) {
        toolResultSources.push(withSourceBundle(source, executionBundleId));
      }
    }

    if (toolResultArtifacts.length) {
      const artifacts = await this.projectStorage.writeArtifacts(project, database, iteration, toolResultArtifacts);
      await this.store.saveArtifacts(artifacts);
    }
    if (toolResultEvidence.length) await this.store.saveEvidence(toolResultEvidence);
    if (toolResultSources.length) {
      await this.store.saveSources(await this.projectStorage.writeSources(project, database, dedupeSourcesByIdUrlDoi(toolResultSources)));
    }
    if (toolRuns.length) await this.store.saveToolRuns(toolRuns);
  }

  private async createOpenCodeRunAttempt(input: OpenCodeRunInput, executionBundleId: string): Promise<OpenCodeRun> {
    const run = this.openCode.createRunAttempt
      ? await this.openCode.createRunAttempt(input)
      : genericOpenCodeRunAttempt(input, executionBundleId);
    return withOpenCodeRunBundle(
      {
        ...run,
        id: input.openCodeRunId ?? run.id,
        metadata: {
          ...(run.metadata ?? {}),
          executionBundleId
        }
      },
      executionBundleId
    );
  }

  private async preflightExecutionEngine(projectId: string): Promise<void> {
    if (!this.openCode.preflight) {
      return;
    }
    try {
      await this.openCode.preflight();
    } catch (error) {
      await this.moveProject(projectId, ResearchLoopStep.ExecuteTools);
      throw new Error(`OpenCode preflight failed: ${formatError(error)}`);
    }
  }

  async runOpenCode(projectId: string): Promise<ResearchSnapshot> {
    return this.executeTools(projectId);
  }

  async normalizeData(projectId: string, iteration?: number): Promise<ResearchSnapshot> {
    await this.moveProject(projectId, ResearchLoopStep.NormalizeData);
    await this.record(projectId, ResearchLoopStep.NormalizeData, "Storage Flow", "데이터 수집 및 정규화 단계를 시작합니다.");
    await this.ingestSources(projectId);
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const records = this.normalizer.normalize(snapshot, iteration ?? nextIteration(snapshot));
    await this.store.saveNormalizedRecords(records);
    await this.record(projectId, ResearchLoopStep.NormalizeData, "Storage Flow", `정규화 레코드 ${records.length}개가 Main Research Memory에 저장되고 프로젝트에는 링크되었습니다.`);
    return this.store.getSnapshot(projectId);
  }

  async storeResults(projectId: string): Promise<ResearchSnapshot> {
    return this.normalizeData(projectId);
  }

  async buildVectorIndex(projectId: string): Promise<ResearchSnapshot> {
    await this.assertStepReady(projectId, ResearchLoopStep.BuildVectorIndex);
    await this.moveProject(projectId, ResearchLoopStep.BuildVectorIndex);
    await this.record(projectId, ResearchLoopStep.BuildVectorIndex, "Knowledge Flow", "Main Vector Index 갱신을 시작합니다.");
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const database = await this.requireDatabase(projectId);
    const settings = await this.getSettings();
    const chunks = await new VectorIndexEngine(this.embeddingProvider).buildIndex({
      snapshot,
      records: snapshot.normalizedRecords,
      settings
    });
    if (chunks.length) {
      await this.projectStorage.writeChunks(snapshot.project, database, chunks);
      await this.store.saveChunks(chunks);
      const indexedRecordIds = new Set<string>();
      for (const chunk of chunks) {
        if (chunk.recordId) indexedRecordIds.add(chunk.recordId);
      }
      const indexedRecords: ResearchSnapshot["normalizedRecords"] = [];
      for (const record of snapshot.normalizedRecords) {
        if (!indexedRecordIds.has(record.id)) continue;
        indexedRecords.push({ ...record, validationStatus: record.validationStatus === "normalized" ? "indexed" : record.validationStatus });
      }
      await this.store.saveNormalizedRecords(indexedRecords);
    }
    const ragContext = await this.ragEngine.buildContext(activeResearchSnapshot(await this.store.getSnapshot(projectId)));
    await this.store.saveRagContext(ragContext);
    await this.record(projectId, ResearchLoopStep.BuildVectorIndex, "Knowledge Flow", `Main Vector Index가 갱신되었습니다. 새 chunk=${chunks.length}.`);
    return this.store.getSnapshot(projectId);
  }

  async buildRagContext(projectId: string): Promise<RagContext> {
    await this.buildVectorIndex(projectId);
    return (await this.store.getSnapshot(projectId)).ragContexts.at(-1) as RagContext;
  }

  async buildOntologyGraph(projectId: string): Promise<ResearchSnapshot> {
    await this.assertStepReady(projectId, ResearchLoopStep.BuildOntologyGraph);
    await this.moveProject(projectId, ResearchLoopStep.BuildOntologyGraph);
    await this.record(projectId, ResearchLoopStep.BuildOntologyGraph, "Knowledge Flow", "Main Ontology Graph 생성을 시작합니다.");
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const database = await this.requireDatabase(projectId);
    const graph = this.ontologyGraph.build({
      snapshot,
      records: snapshot.normalizedRecords,
      specification: snapshot.specifications.at(-1)
    });
    await this.store.saveOntologyEntities(graph.entities);
    await this.store.saveOntologyRelations(graph.relations);
    await this.store.saveOntologyConstraints(graph.constraints);
    await this.projectStorage.writeOntologyGraph(snapshot.project, database, { ...graph, exportedAt: nowIso() });
    const graphRecordIds = new Set<string>();
    for (const entity of graph.entities) {
      if (entity.sourceRecordId) graphRecordIds.add(entity.sourceRecordId);
    }
    for (const relation of graph.relations) {
      if (relation.sourceRecordId) graphRecordIds.add(relation.sourceRecordId);
    }
    for (const constraint of graph.constraints) {
      if (constraint.sourceRecordId) graphRecordIds.add(constraint.sourceRecordId);
    }
    if (graphRecordIds.size) {
      const graphLinkedRecords: ResearchSnapshot["normalizedRecords"] = [];
      for (const record of snapshot.normalizedRecords) {
        if (!graphRecordIds.has(record.id)) continue;
        graphLinkedRecords.push({ ...record, validationStatus: record.validationStatus === "normalized" || record.validationStatus === "indexed" ? "graph_linked" : record.validationStatus });
      }
      await this.store.saveNormalizedRecords(graphLinkedRecords);
    }
    await this.record(projectId, ResearchLoopStep.BuildOntologyGraph, "Knowledge Flow", `Main Ontology Graph가 생성되었습니다. entities=${graph.entities.length}, relations=${graph.relations.length}.`);
    return this.store.getSnapshot(projectId);
  }

  async reasonAndValidate(projectId: string, iteration?: number): Promise<ResearchSnapshot> {
    await this.moveProject(projectId, ResearchLoopStep.ReasonAndValidate);
    await this.record(projectId, ResearchLoopStep.ReasonAndValidate, "Agent Control", "ProjectContextSnapshot 선택과 추론/검증을 시작합니다.");
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const activeIteration = iteration ?? nextIteration(snapshot);
    const contextSnapshot = await this.projectContextBuilder.buildFromMainMemory({
      snapshot,
      iteration: activeIteration,
      store: activeMemorySearchStore(this.store, snapshot)
    });
    if (!contextSnapshot.selectedRecordIds.length && !contextSnapshot.selectedChunkIds.length && !contextSnapshot.selectedEntityIds.length && !contextSnapshot.selectedRelationIds.length) {
      throw new Error("ProjectContextSnapshot could not select any Main Research Memory context for validation.");
    }
    await this.store.saveProjectContextSnapshot(contextSnapshot);
    const afterContext = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const hybridContext = await new HybridRetrievalEngine(this.embeddingProvider).buildContextFromProjectContext(afterContext, contextSnapshot, activeIteration);
    await this.store.saveHybridContext(hybridContext);
    const contextAwareSnapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const reasoning = this.reasoning.reason(contextAwareSnapshot, hybridContext);
    const validations = this.validation.validate(contextAwareSnapshot, hybridContext, reasoning);
    await this.store.saveValidationResults(validations);
    const validatedEvidenceIds = new Set<string>();
    for (const validation of validations) {
      for (const evidenceId of validation.supportingEvidenceIds) validatedEvidenceIds.add(evidenceId);
      for (const evidenceId of validation.contradictingEvidenceIds) validatedEvidenceIds.add(evidenceId);
    }
    if (validatedEvidenceIds.size) {
      const validatedRecords: ResearchSnapshot["normalizedRecords"] = [];
      for (const record of contextAwareSnapshot.normalizedRecords) {
        if (!record.evidenceId || !validatedEvidenceIds.has(record.evidenceId) || record.kind !== "evidence") continue;
        validatedRecords.push({ ...record, validationStatus: "validated" as const });
      }
      await this.store.saveNormalizedRecords(validatedRecords);
    }
    await this.record(projectId, ResearchLoopStep.ReasonAndValidate, "Agent Control", `Hybrid retrieval 기반 검증 결과 ${validations.length}개가 생성되었습니다.`);
    return this.store.getSnapshot(projectId);
  }

  async synthesizeAndEvaluate(projectId: string, iteration?: number, forceStop = false): Promise<EvidenceBasedResult> {
    await this.assertStepReady(projectId, ResearchLoopStep.SynthesizeAndEvaluate);
    await this.moveProject(projectId, ResearchLoopStep.SynthesizeAndEvaluate);
    await this.record(projectId, ResearchLoopStep.SynthesizeAndEvaluate, "Agent Control", "ProjectContextSnapshot 기반 결과 합성을 시작합니다.");
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const activeIteration = iteration ?? nextIteration(snapshot);
    const contextSnapshot = findLastByIteration(snapshot.projectContextSnapshots, activeIteration);
    if (!contextSnapshot) {
      throw new Error(`ProjectContextSnapshot is required before synthesis for iteration ${activeIteration}.`);
    }
    const hybridContext = findLastByIteration(snapshot.hybridContexts, activeIteration);
    if (!hybridContext) {
      throw new Error(`HybridContext is required before synthesis for iteration ${activeIteration}.`);
    }
    const latestValidations: ResearchSnapshot["validationResults"] = [];
    for (const result of snapshot.validationResults) {
      if (result.iteration === activeIteration) latestValidations.push(result);
    }
    if (!latestValidations.length) {
      throw new Error(`ValidationResult is required before synthesis for iteration ${activeIteration}.`);
    }
    const draft = this.resultSynthesizer.synthesize({ snapshot, hybridContext, validationResults: latestValidations, forceStop });
    const llmResult = await this.tryLlmResult({ ...snapshot, hybridContexts: [...snapshot.hybridContexts, hybridContext], validationResults: latestValidations }, activeIteration, forceStop);
    const result = {
      ...draft,
      ...llmResult,
      id: llmResult.id,
      validationResultIds: idsOf(latestValidations),
      hybridContextId: hybridContext.id,
      hypothesisUpdates: llmResult.hypothesisUpdates.length ? llmResult.hypothesisUpdates : draft.hypothesisUpdates,
      quantitativeResults: llmResult.quantitativeResults.length ? llmResult.quantitativeResults : draft.quantitativeResults,
      qualitativeResults: withCitationPreservationLine(
        llmResult.qualitativeResults.length ? llmResult.qualitativeResults : draft.qualitativeResults,
        hybridContext.citations
      )
    };
    assertCitationPreservingResult(result, hybridContext);
    await this.store.saveResult(result);
    await this.applyHypothesisUpdates(projectId, result);
    await this.record(projectId, ResearchLoopStep.SynthesizeAndEvaluate, "Agent Control", "결과 합성 및 가설 평가가 완료되었습니다.");
    return result;
  }

  async deriveResult(projectId: string, forceStop = false): Promise<EvidenceBasedResult> {
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    return this.synthesizeAndEvaluate(projectId, nextIteration(snapshot), forceStop);
  }

  async decideContinuation(
    projectId: string,
    result: EvidenceBasedResult,
    beforeCounts?: { evidence: number; artifacts: number; chunks: number; entities: number; relations: number },
    iteration = result.iteration,
    safetyCapIterations = INTERNAL_LOOP_SAFETY_CAP
  ): Promise<ContinuationDecision> {
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const decision = this.loopDecision.decide({
      snapshot,
      result,
      iteration,
      safetyCapIterations,
      beforeCounts: beforeCounts ?? counts(snapshot)
    });
    await this.store.saveContinuationDecision(decision);
    await this.moveProject(projectId, ResearchLoopStep.DecideContinuation);
    await this.record(
      projectId,
      ResearchLoopStep.DecideContinuation,
      decision.shouldContinue ? "Loop Back" : "Output Flow",
      decision.shouldContinue ? "계속 연구가 필요하여 다음 iteration은 연구 계획 수립 단계로 돌아갑니다." : "계속 연구가 필요하지 않아 최종 산출 단계로 이동합니다."
    );
    return decision;
  }

  async finalizeOutputs(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    if (snapshot.project.status === "paused" || snapshot.project.status === "aborted" || snapshot.project.status === "failed" || snapshot.project.status === "blocked") {
      return snapshot;
    }
    await this.assertStepReady(projectId, ResearchLoopStep.FinalizeOutputs);
    await this.moveProject(projectId, ResearchLoopStep.FinalizeOutputs);
    await this.record(projectId, ResearchLoopStep.FinalizeOutputs, "Output Flow", "최종 결과 산출과 Main Research Memory 승격을 시작합니다.");
    const database = await this.requireDatabase(projectId);
    const output = await new FinalOutputWriter(this.projectStorage).write(snapshot, database);
    const report = buildResearchReport(snapshot);
    await this.store.saveReport({ ...report, reportPath: output.reportPath, knowledgePath: `${snapshot.project.projectRoot}/knowledge/reusable-knowledge.md` });
    await this.store.saveFinalResearchOutput(output);
    const promotionSnapshot = await this.store.getSnapshot(projectId);
    const promoted = this.memoryPromotion.promote(promotionSnapshot);
    if (promoted.length) await this.store.saveGlobalMemoryItems(promoted);
    await this.store.saveBenchmarkPlan(buildBenchmarkPlan(promotionSnapshot));
    await this.moveProject(projectId, ResearchLoopStep.FinalizeOutputs, "completed");
    await this.record(projectId, ResearchLoopStep.FinalizeOutputs, "Output Flow", `최종 보고서, 지식 자산, 그래프 export, artifact package가 생성되었습니다. 승격된 memory item=${promoted.length}.`);
    return this.store.getSnapshot(projectId);
  }

  async finalizeReport(projectId: string): Promise<ResearchSnapshot> {
    return this.finalizeOutputs(projectId);
  }

  async storeArtifact(projectId: string, artifact: Partial<ResearchArtifact>): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const iteration = Math.max(snapshot.openCodeRuns.length, 1);
    const savedArtifact: ResearchArtifact = {
      id: artifact.id ?? createId("artifact"),
      projectId,
      category: artifact.category ?? "generated_artifact",
      title: artifact.title ?? "Manual research artifact",
      relativePath: artifact.relativePath ?? `artifacts/iteration-${iteration}/manual-artifact.md`,
      mimeType: artifact.mimeType ?? "text/markdown",
      summary: artifact.summary ?? "User-added research artifact.",
      content: artifact.content ?? artifact.summary ?? "User-added research artifact.",
      createdAt: artifact.createdAt ?? nowIso()
    };
    const database = await this.requireDatabase(projectId);
    const [written] = await this.projectStorage.writeArtifacts(snapshot.project, database, iteration, [savedArtifact]);
    await this.store.saveArtifacts([written]);
    await this.record(projectId, ResearchLoopStep.NormalizeData, "Storage Flow", `${written.title} 산출물이 저장되었습니다.`);
    return this.store.getSnapshot(projectId);
  }

  private async ensureResearchDb(projectId: string): Promise<ResearchSnapshot> {
    let snapshot = await this.store.getSnapshot(projectId);
    if (!snapshot.database) snapshot = await this.createResearchDb(projectId);
    if (!snapshot.sessions.length) snapshot = await this.createSubSessions(projectId);
    return snapshot;
  }

  private async ensureResearchInput(projectId: string): Promise<ResearchSnapshot> {
    let snapshot = await this.store.getSnapshot(projectId);
    const activeContext = activeResearchContext(snapshot);
    if (!activeContext.questions.length || !activeContext.hypotheses.length) snapshot = await this.inputResearchQuestionHypothesis(projectId);
    return snapshot;
  }

  private async ensureResearchSpecification(projectId: string): Promise<ResearchSnapshot> {
    let snapshot = await this.store.getSnapshot(projectId);
    if (!activeResearchSpecification(snapshot)) snapshot = await this.buildResearchSpecification(projectId);
    return snapshot;
  }

  private async ensureResearchPlan(projectId: string, iteration?: number): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const activeSnapshot = activeResearchSnapshot(snapshot);
    const activeIteration = iteration ?? nextExecutionIteration(activeSnapshot);
    const specification = activeResearchSpecification(snapshot);
    const plan = activeSnapshot.researchPlans.find((item) => item.iteration === activeIteration && isPlanCurrentForActiveResearch(item, activeSnapshot, specification));
    return plan ? snapshot : this.planResearch(projectId, activeIteration);
  }

  private async ensureSpecification(projectId: string): Promise<ResearchSpecification> {
    let snapshot = await this.store.getSnapshot(projectId);
    if (!activeResearchSpecification(snapshot)) {
      snapshot = await this.buildResearchSpecification(projectId);
    }
    const specification = activeResearchSpecification(snapshot);
    if (!specification) {
      throw new Error("Research specification was not created.");
    }
    return specification;
  }

  private async ingestSources(projectId: string): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    const database = await this.requireDatabase(projectId);
    const existingSourceIds = idSet(snapshot.sources);
    const sources: ResearchSource[] = [];
    const evidenceUpdates: EvidenceItem[] = [];

    for (const evidence of snapshot.evidence) {
      const sourceId = evidence.sourceId ?? `source_${evidence.id}`;
      if (!evidence.sourceId) evidenceUpdates.push({ ...evidence, sourceId });
      if (!existingSourceIds.has(sourceId)) sources.push(sourceFromEvidence(evidence, sourceId));
    }
    for (const artifact of snapshot.artifacts) {
      const sourceId = `source_${artifact.id}`;
      if (!existingSourceIds.has(sourceId)) {
        sources.push({
          id: sourceId,
          projectId,
          kind: "artifact",
          title: artifact.title,
          url: artifact.relativePath,
          retrievedAt: artifact.createdAt,
          rawPath: artifact.rawPath,
          metadata: { artifactId: artifact.id, mimeType: artifact.mimeType, summary: artifact.summary },
          createdAt: artifact.createdAt
        });
      }
    }
    for (const toolRun of snapshot.toolRuns) {
      const sourceId = `source_${toolRun.id}`;
      if (!existingSourceIds.has(sourceId)) {
        sources.push({
          id: sourceId,
          projectId,
          kind: "log",
          title: `${toolRun.toolName} ${toolRun.status}`,
          retrievedAt: toolRun.completedAt,
          metadata: { toolRunId: toolRun.id, input: toolRun.input, output: toolRun.output, error: toolRun.error },
          createdAt: toolRun.completedAt
        });
      }
    }
    if (evidenceUpdates.length) await this.store.saveEvidence(evidenceUpdates);
    if (sources.length) await this.store.saveSources(await this.projectStorage.writeSources(snapshot.project, database, sources));
  }

  private async checkAbortOrPause(projectId: string): Promise<"running" | "paused" | "aborted" | "failed" | "blocked"> {
    const status = (await this.store.getSnapshot(projectId)).project.status;
    if (status === "paused" || status === "aborted" || status === "failed" || status === "blocked") return status;
    return "running";
  }

  private async requireDatabase(projectId: string): Promise<ResearchDatabase> {
    const snapshot = await this.store.getSnapshot(projectId);
    if (snapshot.database) return snapshot.database;
    const next = await this.createResearchDb(projectId);
    if (!next.database) throw new Error("Research database was not created.");
    return next.database;
  }

  private async assertStepReady(
    projectId: string,
    step: ResearchLoopStep,
    options: { checkOpenCodePreflight?: boolean; storageWritable?: boolean } = {}
  ): Promise<void> {
    let openCodeReady: boolean | undefined;
    if (options.checkOpenCodePreflight) {
      try {
        await this.preflightExecutionEngine(projectId);
        openCodeReady = true;
      } catch {
        openCodeReady = false;
      }
    }
    this.requirements.assertStepReady(step, {
      snapshot: await this.store.getSnapshot(projectId),
      settings: await this.getSettings(),
      llmAvailable: this.llm ? await this.llm.isAvailable() : false,
      openCodeReady,
      storageWritable: options.storageWritable,
      registeredToolNames: this.registeredToolNames()
    });
  }

  private registeredToolNames(): string[] {
    return this.toolRunner?.listRegisteredToolNames?.() ?? this.toolRunner?.listToolNames() ?? [];
  }

  private executableToolNames(snapshot: ResearchSnapshot, settings: AppSettings): string[] {
    const tools = this.toolRunner?.listExecutableToolNames?.({ snapshot, settings }) ?? this.registeredToolNames();
    return collectExecutableToolNames(tools, settings.openCode.enabled && Boolean(settings.openCode.command?.trim()));
  }

  private assertPlanToolsAllowed(plan: ResearchPlan, allowedTools: string[]): void {
    const allowed = normalizedToolNameSet(allowedTools);
    const registered = normalizedToolNameSet(this.registeredToolNames());
    const unmet = collectPlanToolRequirements(plan.requiredTools, registered, allowed);
    if (unmet.length) {
      throw new RuntimeRequirementError(ResearchLoopStep.PlanResearch, unmet);
    }
  }

  private async blockProject(projectId: string, error: RuntimeRequirementError): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    await this.moveProject(projectId, error.step, "blocked");
    for (const requirement of error.unmetRequirements) {
      const blocker: RuntimeBlocker = {
        id: createId("blocker"),
        projectId,
        step: error.step,
        requirementKey: requirement.key,
        message: requirement.message ?? `${requirement.label} is required.`,
        createdAt: nowIso()
      };
      await this.store.saveRuntimeBlocker(blocker);
      if (this.projectStorage.writeRuntimeBlocker) await this.projectStorage.writeRuntimeBlocker(snapshot.project, blocker);
    }
    await this.saveStepError(projectId, error.step, error.message, "runtime_requirement", {
      unmetRequirements: error.unmetRequirements
    });
    await this.record(projectId, error.step, "Error Flow", `필수 설정이 부족해 연구가 blocked 상태로 멈췄습니다: ${error.message}`);
    await this.writeRunAudit(projectId, error.step, error.message);
    return this.store.getSnapshot(projectId);
  }

  private async failProject(projectId: string, step: ResearchLoopStep, error: unknown): Promise<void> {
    await this.moveProject(projectId, step, "failed");
    await this.saveStepError(projectId, step, formatError(error), "step_failed", errorMetadata(error, step));
    await this.record(projectId, step, "Error Flow", `연구 단계 실패: ${formatError(error)}`);
    await this.writeRunAudit(projectId, step, formatError(error));
  }

  private async writeRunAudit(projectId: string, step: ResearchLoopStep, reason: string): Promise<void> {
    try {
      const snapshot = await this.store.getSnapshot(projectId);
      const output = snapshot.database
        ? await new RunAuditWriter(this.projectStorage).write(snapshot, snapshot.database, { step, reason })
        : buildRunAuditOutput(snapshot, { step, reason });
      await this.store.saveRunAuditOutput(output);
      await this.store.saveBenchmarkPlan(buildBenchmarkPlan(snapshot));
    } catch {
      // A failed audit must not mask the original failed research step.
    }
  }

  private async saveStepError(
    projectId: string,
    step: ResearchLoopStep,
    message: string,
    cause: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    const stepError: StepError = {
      id: createId("error"),
      projectId,
      step,
      message,
      cause,
      metadata,
      createdAt: nowIso()
    };
    await this.store.saveStepError(stepError);
    if (this.projectStorage.writeStepError) await this.projectStorage.writeStepError(snapshot.project, stepError);
  }

  private async tryLlmResult(snapshot: ResearchSnapshot, iteration: number, forceStop: boolean): Promise<EvidenceBasedResult> {
    if (!this.llm || !(await this.llm.isAvailable())) {
      throw new Error("LLM provider is required to synthesize and evaluate results.");
    }
    const result = await deriveResultWithLlm(this.llm, snapshot, iteration, forceStop);
    if (!result?.answer) {
      throw new Error("LLM result synthesis did not return an answer.");
    }
    return result;
  }

  private async applyHypothesisUpdates(projectId: string, result: EvidenceBasedResult): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    const updates = hypothesisUpdateMap(result.hypothesisUpdates);
    await this.store.saveHypotheses(mergeHypothesisUpdates(snapshot.hypotheses, updates));
  }

  private async setStatus(projectId: string, status: ResearchProject["status"]): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    await this.store.updateProject({ ...snapshot.project, status, updatedAt: nowIso() });
    await this.syncProjectState(projectId);
  }

  private async moveProject(projectId: string, currentStep: ResearchLoopStep, status?: ResearchProject["status"]): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    await this.store.updateProject({
      ...snapshot.project,
      currentStep,
      status: status ?? snapshot.project.status,
      updatedAt: nowIso()
    });
    await this.syncProjectState(projectId);
  }

  private async record(projectId: string, step: ResearchLoopStep, flowKind: FlowKind, message: string): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    const iteration: LoopIteration = {
      id: createId("iteration"),
      projectId,
      iteration: Math.max(snapshot.openCodeRuns.length, snapshot.researchPlans.at(-1)?.iteration ?? 0),
      step,
      flowKind,
      message,
      createdAt: nowIso()
    };
    await this.store.saveIteration(iteration);
    await this.reportIterationToChat(iteration);
    await this.syncProjectState(projectId);
  }

  private async reportIterationToChat(iteration: LoopIteration): Promise<void> {
    if (!shouldReportIterationToChat(iteration)) {
      return;
    }

    try {
      const snapshot = await this.store.getSnapshot(iteration.projectId);
      const session = selectDefaultChatSession(snapshot);
      if (!snapshot.database || !session) {
        return;
      }

      const content = buildLoopProgressReport(snapshot, iteration);
      const artifact: ResearchArtifact = {
        id: createId("artifact"),
        projectId: iteration.projectId,
        category: "conversation_memo",
        title: `${session.title} 루프 보고`,
        relativePath: `artifacts/chat/${session.id}-${Date.now()}-${iteration.id}-assistant.md`,
        mimeType: "text/markdown",
        summary: summarize(content),
        content,
        createdAt: iteration.createdAt
      };
      const [written] = await this.projectStorage.writeArtifacts(
        snapshot.project,
        snapshot.database,
        Math.max(iteration.iteration, 1),
        [artifact]
      );
      await this.store.saveArtifacts([written]);
    } catch (error) {
      console.warn(`Loop chat report failed: ${formatError(error)}`);
    }
  }

  private async syncProjectState(projectId: string): Promise<void> {
    try {
      await this.projectStorage.writeProjectState(await this.store.getSnapshot(projectId));
    } catch (error) {
      console.warn(`Project state file sync failed: ${formatError(error)}`);
    }
  }

  private async completeChatReply(snapshot: ResearchSnapshot, session: ResearchSession, message: string): Promise<string> {
    const latestContext = snapshot.hybridContexts.at(-1)?.contextText ?? snapshot.ragContexts.at(-1)?.contextText ?? snapshot.ragContexts.at(-1)?.summary;
    if (!this.llm) {
      throw new Error("LLM provider is not configured.");
    }
    const response = await this.llm.completeJson<ChatReplyResponse>({
      schemaName: "AetherOpsChatReply",
      system: [
        "You are the AetherOps research chat agent inside a project-based research workspace.",
        "Answer in Korean. Use stored evidence, artifacts, hybrid context, and limitations when relevant.",
        "Do not invent paper citations, URLs, DOI values, or experimental results.",
        "Return only JSON: {\"answer\": string, \"citations\": string[], \"limitations\": string[], \"nextActions\": string[]}."
      ].join("\n"),
      user: [
        `Project topic: ${snapshot.project.topic}`,
        `Project goal: ${snapshot.project.goal}`,
        `Chat session: ${session.title} - ${session.focus}`,
        `Recent chat transcript:\n${buildChatTranscript(snapshot, session.id)}`,
        `Latest context:\n${latestContext ?? "No context yet."}`,
        `User message: ${message}`
      ].join("\n\n"),
      timeoutMs: 180_000
    });
    const answer = cleanText(response.answer);
    if (!answer) throw new Error("LLM 응답에 answer 필드가 없습니다.");
    const citations = cleanStringArray(response.citations);
    const limitations = cleanStringArray(response.limitations);
    const nextActions = cleanStringArray(response.nextActions);
    let output = answer;
    output = appendBulletSection(output, "근거/출처", citations);
    output = appendBulletSection(output, "한계", limitations);
    output = appendBulletSection(output, "다음 작업", nextActions);
    return output;
  }
}

function sourceFromEvidence(evidence: EvidenceItem, sourceId: string): ResearchSource {
  return {
    id: sourceId,
    projectId: evidence.projectId,
    kind: kindFromEvidence(evidence),
    title: evidence.title,
    url: evidence.sourceUri,
    doi: evidence.doi,
    retrievedAt: evidence.createdAt,
    metadata: {
      evidenceId: evidence.id,
      category: evidence.category,
      citation: evidence.citation,
      quote: evidence.quote,
      reliabilityScore: evidence.reliabilityScore,
      relevanceScore: evidence.relevanceScore,
      evidenceStrength: evidence.evidenceStrength,
      limitations: evidence.limitations
    },
    createdAt: evidence.createdAt
  };
}

interface ActiveResearchContext {
  input?: ResearchInput;
  questions: ResearchQuestion[];
  hypotheses: Hypothesis[];
}

function activeResearchSnapshot(snapshot: ResearchSnapshot): ResearchSnapshot {
  const context = activeResearchContext(snapshot);
  if (!context.input) return snapshot;
  const baseline = context.input.createdAt;
  const specifications = snapshot.specifications.filter((specification) => specification.sourceResearchInputId === context.input?.id);
  const activeSpecification = latestByCreatedAt(specifications);
  const researchPlans = snapshot.researchPlans.filter((plan) =>
    plan.sourceResearchInputId === context.input?.id &&
    (!activeSpecification?.id || !plan.sourceSpecificationId || plan.sourceSpecificationId === activeSpecification.id)
  );
  return {
    ...snapshot,
    researchInputs: [context.input],
    questions: context.questions,
    hypotheses: context.hypotheses,
    evidence: itemsAtOrAfter(snapshot.evidence, baseline),
    artifacts: itemsAtOrAfter(snapshot.artifacts, baseline),
    sources: sourcesAtOrAfter(snapshot.sources, baseline),
    chunks: itemsAtOrAfter(snapshot.chunks, baseline),
    toolRuns: toolRunsAtOrAfter(snapshot.toolRuns, baseline),
    agentPlans: researchPlans,
    researchPlans,
    specifications,
    normalizedRecords: itemsAtOrAfter(snapshot.normalizedRecords, baseline),
    ontologyEntities: itemsAtOrAfter(snapshot.ontologyEntities, baseline),
    ontologyRelations: itemsAtOrAfter(snapshot.ontologyRelations, baseline),
    ontologyConstraints: itemsAtOrAfter(snapshot.ontologyConstraints, baseline),
    projectContextSnapshots: itemsAtOrAfter(snapshot.projectContextSnapshots, baseline),
    hybridContexts: itemsAtOrAfter(snapshot.hybridContexts, baseline),
    validationResults: itemsAtOrAfter(snapshot.validationResults, baseline),
    continuationDecisions: itemsAtOrAfter(snapshot.continuationDecisions, baseline),
    finalOutputs: itemsAtOrAfter(snapshot.finalOutputs, baseline),
    runAuditOutputs: itemsAtOrAfter(snapshot.runAuditOutputs, baseline),
    benchmarkPlans: itemsAtOrAfter(snapshot.benchmarkPlans, baseline),
    runtimeBlockers: itemsAtOrAfter(snapshot.runtimeBlockers, baseline),
    stepErrors: itemsAtOrAfter(snapshot.stepErrors, baseline),
    openCodeRuns: openCodeRunsAtOrAfter(snapshot.openCodeRuns, baseline),
    ragContexts: itemsAtOrAfter(snapshot.ragContexts, baseline),
    results: itemsAtOrAfter(snapshot.results, baseline),
    iterations: itemsAtOrAfter(snapshot.iterations, baseline),
    report: snapshot.report && isTimestampAtOrAfter(snapshot.report.createdAt, baseline) ? snapshot.report : undefined
  };
}

function activeResearchContext(snapshot: ResearchSnapshot): ActiveResearchContext {
  const input = latestByCreatedAt(snapshot.researchInputs);
  if (!input) {
    return { questions: snapshot.questions, hypotheses: snapshot.hypotheses };
  }
  const questions = snapshot.questions.filter((question) => question.researchInputId === input.id);
  const questionIds = new Set(questions.map((question) => question.id));
  const hypotheses = snapshot.hypotheses.filter((hypothesis) => hypothesis.researchInputId === input.id && questionIds.has(hypothesis.questionId));
  return { input, questions, hypotheses };
}

function activeResearchSpecification(snapshot: ResearchSnapshot): ResearchSpecification | undefined {
  const input = latestByCreatedAt(snapshot.researchInputs);
  if (input) {
    return latestByCreatedAt(snapshot.specifications.filter((specification) => specification.sourceResearchInputId === input.id));
  }
  return latestByCreatedAt(snapshot.specifications);
}

function researchInputMatchesPayload(input: ResearchInput, payload: Required<ResearchInputPayload>): boolean {
  return input.researchQuestion === payload.researchQuestion &&
    sameStringArray(input.initialHypotheses, payload.initialHypotheses) &&
    sameStringArray(input.constraints, payload.constraints) &&
    sameStringArray(input.expectedOutputs, payload.expectedOutputs);
}

function isPlanCurrentForActiveResearch(
  plan: ResearchPlan,
  snapshot: ResearchSnapshot,
  specification: ResearchSpecification | undefined
): boolean {
  const input = latestByCreatedAt(snapshot.researchInputs);
  if (!input) return true;
  return plan.sourceResearchInputId === input.id && (!specification?.id || plan.sourceSpecificationId === specification.id);
}

function activeMemorySearchStore(store: Pick<ResearchStore, "searchGlobalRecords" | "searchGlobalChunks" | "searchGlobalGraph">, snapshot: ResearchSnapshot): Pick<ResearchStore, "searchGlobalRecords" | "searchGlobalChunks" | "searchGlobalGraph"> {
  const baseline = latestByCreatedAt(snapshot.researchInputs)?.createdAt;
  return {
    searchGlobalRecords: async (query, options) => filterSameProjectItemsAtOrAfter(await store.searchGlobalRecords(query, options), snapshot.project.id, baseline),
    searchGlobalChunks: async (query, options) => filterSameProjectItemsAtOrAfter(await store.searchGlobalChunks(query, options), snapshot.project.id, baseline),
    searchGlobalGraph: async (query, options) => {
      const graph = await store.searchGlobalGraph(query, options);
      return {
        entities: filterSameProjectItemsAtOrAfter(graph.entities, snapshot.project.id, baseline),
        relations: filterSameProjectItemsAtOrAfter(graph.relations, snapshot.project.id, baseline),
        constraints: filterSameProjectItemsAtOrAfter(graph.constraints, snapshot.project.id, baseline)
      };
    }
  };
}

function filterSameProjectItemsAtOrAfter<T extends { projectId: string; createdAt?: string; retrievedAt?: string }>(items: T[], projectId: string, baseline: string | undefined): T[] {
  if (!baseline) return items;
  return items.filter((item) => item.projectId !== projectId || isTimestampAtOrAfter(timestampOf(item), baseline));
}

function itemsAtOrAfter<T extends { createdAt: string }>(items: T[], baseline: string): T[] {
  return items.filter((item) => isTimestampAtOrAfter(item.createdAt, baseline));
}

function sourcesAtOrAfter(sources: ResearchSource[], baseline: string): ResearchSource[] {
  return sources.filter((source) => isTimestampAtOrAfter(source.createdAt ?? source.retrievedAt, baseline));
}

function toolRunsAtOrAfter(toolRuns: ToolRun[], baseline: string): ToolRun[] {
  return toolRuns.filter((toolRun) => isTimestampAtOrAfter(toolRun.completedAt || toolRun.startedAt, baseline));
}

function openCodeRunsAtOrAfter(openCodeRuns: ResearchSnapshot["openCodeRuns"], baseline: string): ResearchSnapshot["openCodeRuns"] {
  return openCodeRuns.filter((run) => isTimestampAtOrAfter(run.completedAt ?? run.startedAt, baseline));
}

function latestByCreatedAt<T extends { createdAt: string }>(items: T[]): T | undefined {
  let latest: T | undefined;
  for (const item of items) {
    if (!latest || item.createdAt >= latest.createdAt) latest = item;
  }
  return latest;
}

function timestampOf(item: { createdAt?: string; retrievedAt?: string }): string | undefined {
  return item.createdAt ?? item.retrievedAt;
}

function isTimestampAtOrAfter(value: string | undefined, baseline: string): boolean {
  return Boolean(value && value >= baseline);
}

function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

const preOpenCodeToolOrder = [
  "websearchtool",
  "backgroundbrowsertool",
  "researchmetadatatool",
  "papermetadatatool",
  "pdfingestiontool",
  "engineeringprogramtool"
];

const preOpenCodeToolSet = new Set(preOpenCodeToolOrder);

function preOpenCodeToolNames(plan: ResearchPlan | undefined): string[] {
  if (!plan?.requiredTools.length) return [];
  const requested = new Set<string>();
  for (const tool of plan.requiredTools) {
    const normalized = normalizeToolName(tool);
    if (preOpenCodeToolSet.has(normalized)) requested.add(normalized);
  }
  const output: string[] = [];
  for (const tool of preOpenCodeToolOrder) {
    if (requested.has(tool)) output.push(tool);
  }
  return output;
}

function applyToolResultsToOpenCodeInput(input: OpenCodeRunInput, results: ResearchToolResult[]): OpenCodeRunInput {
  if (!results.length) return input;
  let evidence = copyItems(input.evidence ?? []);
  let artifacts = copyItems(input.artifacts ?? []);
  let sources = copyItems(input.sources ?? []);
  let toolRuns = copyItems(input.toolRuns ?? []);
  for (const result of results) {
    evidence = concatItems(evidence, result.evidence);
    artifacts = concatItems(artifacts, result.artifacts);
    sources = concatItems(sources, result.sources);
    toolRuns = concatItems(toolRuns, [result.toolRun]);
  }
  return {
    ...input,
    evidence,
    artifacts,
    sources: dedupeSourcesByIdUrlDoi(sources),
    toolRuns
  };
}

function withToolRunBundle(toolRun: ToolRun, executionBundleId: string): ToolRun {
  return {
    ...toolRun,
    input: appendBundleToUnknown(toolRun.input, executionBundleId),
    output: appendBundleToUnknown(toolRun.output, executionBundleId)
  };
}

function withOpenCodeRunBundle(run: OpenCodeRunOutput["run"], executionBundleId: string): OpenCodeRunOutput["run"] {
  const logs = run.logs.some((line) => line.includes(executionBundleId))
    ? run.logs
    : concatItems(run.logs, [`executionBundleId: ${executionBundleId}`]);
  return {
    ...run,
    metadata: { ...(run.metadata ?? {}), executionBundleId },
    logs
  };
}

function buildExecutionBundleId(projectId: string, iteration: number, openCodeRunId: string): string {
  return `execution-bundle:${projectId}:${iteration}:${openCodeRunId}`;
}

function genericOpenCodeRunAttempt(input: OpenCodeRunInput, executionBundleId: string): OpenCodeRun {
  const startedAt = nowIso();
  const prompt = [
    "OpenCode adapter run input",
    `Project: ${JSON.stringify(input.project)}`,
    `Questions: ${JSON.stringify(input.questions)}`,
    `Hypotheses: ${JSON.stringify(input.hypotheses)}`,
    `ResearchPlan: ${JSON.stringify(input.researchPlan)}`,
    `Iteration: ${input.iteration}`
  ].join("\n");
  return {
    id: input.openCodeRunId ?? createId("opencode"),
    projectId: input.project.id,
    iteration: input.iteration,
    prompt,
    toolPlan: ["OpenCodeTool"],
    status: "running",
    logs: ["OpenCode adapter attempt started."],
    artifactIds: [],
    evidenceIds: [],
    metadata: { executionBundleId },
    startedAt
  };
}

function failedOpenCodeRun(run: OpenCodeRun, error: unknown, executionBundleId: string): OpenCodeRun {
  const message = formatError(error);
  return withOpenCodeRunBundle(
    {
      ...run,
      status: "failed",
      logs: concatItems(run.logs, [`OpenCode execution failed: ${message}`]),
      metadata: {
        ...(run.metadata ?? {}),
        ...executionErrorMetadata(error),
        executionBundleId,
        error: message
      },
      completedAt: nowIso()
    },
    executionBundleId
  );
}

function executionErrorMetadata(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return {};
  const metadata = (error as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return metadata as Record<string, unknown>;
}

function bundleToolRuns(toolRuns: ToolRun[], executionBundleId: string): ToolRun[] {
  const bundled: ToolRun[] = [];
  for (const toolRun of toolRuns) bundled.push(withToolRunBundle(toolRun, executionBundleId));
  return bundled;
}

function withSourceBundle(source: ResearchSource, executionBundleId: string): ResearchSource {
  return {
    ...source,
    metadata: { ...source.metadata, executionBundleId }
  };
}

function bundleSources(sources: ResearchSource[], executionBundleId: string): ResearchSource[] {
  const bundled: ResearchSource[] = [];
  for (const source of sources) bundled.push(withSourceBundle(source, executionBundleId));
  return bundled;
}

function withEvidenceBundle(evidence: EvidenceItem, executionBundleId: string): EvidenceItem {
  return {
    ...evidence,
    metadata: { ...(evidence.metadata ?? {}), executionBundleId }
  };
}

function bundleEvidence(evidence: EvidenceItem[], executionBundleId: string): EvidenceItem[] {
  const bundled: EvidenceItem[] = [];
  for (const item of evidence) bundled.push(withEvidenceBundle(item, executionBundleId));
  return bundled;
}

function withArtifactBundle(artifact: ResearchArtifact, executionBundleId: string): ResearchArtifact {
  return {
    ...artifact,
    metadata: { ...(artifact.metadata ?? {}), executionBundleId }
  };
}

function bundleArtifacts(artifacts: ResearchArtifact[], executionBundleId: string): ResearchArtifact[] {
  const bundled: ResearchArtifact[] = [];
  for (const artifact of artifacts) bundled.push(withArtifactBundle(artifact, executionBundleId));
  return bundled;
}

function withOpenCodeStructuredBundle<T extends { metadata?: Record<string, unknown> }>(value: T, executionBundleId: string): T {
  return {
    ...value,
    metadata: { ...(value.metadata ?? {}), executionBundleId }
  };
}

function bundleOpenCodeStructured<T extends { metadata?: Record<string, unknown> }>(values: T[], executionBundleId: string): T[] {
  const bundled: T[] = [];
  for (const value of values) bundled.push(withOpenCodeStructuredBundle(value, executionBundleId));
  return bundled;
}

function copyItems<T>(items: T[]): T[] {
  const copy: T[] = [];
  for (const item of items) copy.push(item);
  return copy;
}

function concatItems<T>(first: T[], second: T[]): T[] {
  const output: T[] = [];
  for (const item of first) output.push(item);
  for (const item of second) output.push(item);
  return output;
}

function concatSourceGroups(
  first: ResearchSource[] | undefined,
  second: ResearchSource[] | undefined,
  third: ResearchSource[]
): ResearchSource[] {
  const output: ResearchSource[] = [];
  for (const source of first ?? []) output.push(source);
  for (const source of second ?? []) output.push(source);
  for (const source of third) output.push(source);
  return output;
}

function appendBundleToUnknown(value: unknown, executionBundleId: string): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>), executionBundleId };
  }
  return { value, executionBundleId };
}

function kindFromEvidence(evidence: EvidenceItem): ResearchSource["kind"] {
  if (evidence.category === "web_source") return "web";
  if (evidence.category === "paper_reference") return "paper";
  if (evidence.category === "generated_artifact") return "artifact";
  if (evidence.category === "conversation_memo") return "conversation";
  return "log";
}

function findLastByIteration<T extends { iteration: number }>(items: T[], iteration: number): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.iteration === iteration) return item;
  }
  return undefined;
}

function idsOf<T extends { id: string }>(items: T[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    ids.push(item.id);
  }
  return ids;
}

function idSet<T extends { id: string }>(items: T[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) ids.add(item.id);
  return ids;
}

function countChatSessions(sessions: ResearchSession[]): number {
  let count = 0;
  for (const session of sessions) {
    if (!isLegacyStructuredSession(session.title)) count += 1;
  }
  return count;
}

function collectExecutableToolNames(tools: string[], includeOpenCode: boolean): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  if (includeOpenCode) pushUniqueToolName(output, seen, "OpenCodeTool");
  for (const tool of tools) pushUniqueToolName(output, seen, tool);
  return output;
}

function pushUniqueToolName(output: string[], seen: Set<string>, tool: string): void {
  if (seen.has(tool)) return;
  seen.add(tool);
  output.push(tool);
}

function normalizedToolNameSet(tools: string[]): Set<string> {
  const normalized = new Set<string>();
  for (const tool of tools) normalized.add(normalizeToolNameForPlan(tool));
  return normalized;
}

function collectPlanToolRequirements(
  requiredTools: string[],
  registered: Set<string>,
  allowed: Set<string>
): RuntimeRequirement[] {
  const missing: RuntimeRequirement[] = [];
  const unavailable: RuntimeRequirement[] = [];
  for (const tool of requiredTools) {
    const normalized = normalizeToolNameForPlan(tool);
    if (normalized === "opencodetool") continue;
    if (!registered.has(normalized)) {
      missing.push({
        key: "tool.registered",
        label: "Registered research tool",
        requiredForSteps: [ResearchLoopStep.PlanResearch],
        isSatisfied: false,
        message: `Research plan requires an unregistered tool: ${tool}`
      });
    }
    if (!allowed.has(normalized)) {
      unavailable.push({
        key: "tool.available",
        label: "Executable research tool",
        requiredForSteps: [ResearchLoopStep.PlanResearch],
        isSatisfied: false,
        message: `Research plan requires a tool that is not executable in the current settings/state: ${tool}`
      });
    }
  }
  return concatItems(missing, unavailable);
}

function hypothesisUpdateMap(updates: EvidenceBasedResult["hypothesisUpdates"]): Map<string, EvidenceBasedResult["hypothesisUpdates"][number]> {
  const byHypothesisId = new Map<string, EvidenceBasedResult["hypothesisUpdates"][number]>();
  for (const update of updates) byHypothesisId.set(update.hypothesisId, update);
  return byHypothesisId;
}

function mergeHypothesisUpdates(
  hypotheses: ResearchSnapshot["hypotheses"],
  updates: Map<string, EvidenceBasedResult["hypothesisUpdates"][number]>
): ResearchSnapshot["hypotheses"] {
  const merged: ResearchSnapshot["hypotheses"] = [];
  for (const hypothesis of hypotheses) {
    const update = updates.get(hypothesis.id);
    merged.push(update ? { ...hypothesis, status: update.status, confidence: update.confidence } : hypothesis);
  }
  return merged;
}

function withCitationPreservationLine(qualitativeResults: string[], citations: string[]): string[] {
  const output = copyItems(qualitativeResults);
  if (!citations.length) return output;
  const preserved: string[] = [];
  const count = Math.min(citations.length, 5);
  for (let index = 0; index < count; index += 1) {
    preserved.push(citations[index]);
  }
  output.push(`Citations preserved: ${preserved.join("; ")}`);
  return output;
}

function nextIteration(snapshot: ResearchSnapshot): number {
  return Math.max(snapshot.results.length, snapshot.openCodeRuns.length, snapshot.researchPlans.length) + 1;
}

function nextExecutionIteration(snapshot: ResearchSnapshot): number {
  return Math.max(snapshot.results.length, latestCompletedOpenCodeIteration(snapshot.openCodeRuns)) + 1;
}

function latestCompletedOpenCodeIteration(openCodeRuns: ResearchSnapshot["openCodeRuns"]): number {
  let latest = 0;
  for (const run of openCodeRuns) {
    if (run.status === "completed" && run.iteration > latest) latest = run.iteration;
  }
  return latest;
}

function counts(snapshot: ResearchSnapshot): { evidence: number; artifacts: number; chunks: number; entities: number; relations: number } {
  return {
    evidence: snapshot.evidence.length,
    artifacts: snapshot.artifacts.length,
    chunks: snapshot.chunks.length,
    entities: snapshot.ontologyEntities.length,
    relations: snapshot.ontologyRelations.length
  };
}

function assertCitationPreservingResult(result: EvidenceBasedResult, hybridContext: import("../shared/types.js").HybridContext): void {
  if (!result.validationResultIds?.length) {
    throw new Error("Result synthesis omitted validationResultIds.");
  }
  if (result.hybridContextId !== hybridContext.id) {
    throw new Error("Result synthesis omitted the active HybridContext reference.");
  }
  if (!hybridContext.citations.length) {
    return;
  }
  const resultText = resultCitationText(result);
  const citesKnownContext = citesAnyKnownContext(resultText, hybridContext.citations);
  if (!citesKnownContext && result.needsMoreEvidence === false) {
    throw new Error("LLM synthesis did not preserve any ProjectContextSnapshot citation.");
  }
}

function resultCitationText(result: EvidenceBasedResult): string {
  const lines = [result.answer];
  for (const item of result.quantitativeResults) lines.push(item);
  for (const item of result.qualitativeResults) lines.push(item);
  for (const update of result.hypothesisUpdates) lines.push(update.rationale);
  return lines.join("\n");
}

function citesAnyKnownContext(resultText: string, citations: string[]): boolean {
  for (const citation of citations) {
    if (resultText.includes(citation) || resultText.includes(citation.slice(0, 40))) return true;
  }
  return false;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 70);
  return slug || createStableId("project", value);
}

function isLegacyStructuredSession(title: string): boolean {
  return ["질문/가설 세션", "근거/RAG 세션", "실행/분석 세션"].includes(title);
}

function buildChatTranscript(snapshot: ResearchSnapshot, sessionId: string): string {
  const messages = chatMessagesForSession(snapshot.artifacts, sessionId);
  if (!messages.length) return "No stored chat messages yet.";
  const lines: string[] = [];
  const start = Math.max(0, messages.length - 12);
  for (let index = start; index < messages.length; index += 1) {
    const artifact = messages[index];
    lines.push(`${artifact.relativePath.endsWith("-assistant.md") ? "assistant" : "user"}: ${artifact.content ?? artifact.summary}`);
  }
  return lines.join("\n\n");
}

function chatMessagesForSession(artifacts: ResearchArtifact[], sessionId: string): ResearchArtifact[] {
  const messages: ResearchArtifact[] = [];
  const needle = `/chat/${sessionId}-`;
  for (const artifact of artifacts) {
    if (artifact.category !== "conversation_memo") continue;
    if (!artifact.relativePath.replace(/\\/g, "/").includes(needle)) continue;
    messages.push(artifact);
  }
  messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return messages;
}

function selectDefaultChatSession(snapshot: ResearchSnapshot): ResearchSession | undefined {
  return snapshot.sessions.find((session) => !isLegacyStructuredSession(session.title)) ?? snapshot.sessions[0];
}

function shouldReportIterationToChat(iteration: LoopIteration): boolean {
  if (isIgnoredChatProgressMessage(iteration.message)) {
    return false;
  }
  return reportableChatSteps.has(iteration.step);
}

function isIgnoredChatProgressMessage(message: string): boolean {
  for (const ignored of ignoredChatProgressMessages) {
    if (message.includes(ignored)) return true;
  }
  return false;
}

function countNonConversationArtifacts(artifacts: ResearchArtifact[]): number {
  let count = 0;
  for (const artifact of artifacts) {
    if (artifact.category !== "conversation_memo") count += 1;
  }
  return count;
}

function buildLoopProgressReport(snapshot: ResearchSnapshot, iteration: LoopIteration): string {
  const label = stepReportLabel(iteration.step);
  const lines = [
    `### ${label}`,
    iteration.message,
    "",
    `- 반복: ${iteration.iteration || 0}`,
    `- 흐름: ${iteration.flowKind}`,
    `- 프로젝트 상태: ${snapshot.project.status}`,
    `- 누적 근거: ${snapshot.evidence.length}`,
    `- 누적 산출물: ${countNonConversationArtifacts(snapshot.artifacts)}`,
    `- 정규화 레코드: ${snapshot.normalizedRecords.length}`,
    `- Vector chunk: ${snapshot.chunks.length}`,
    `- Ontology graph: entity ${snapshot.ontologyEntities.length}, relation ${snapshot.ontologyRelations.length}`
  ];

  if (iteration.step === ResearchLoopStep.DecideContinuation) {
    const decision = snapshot.continuationDecisions.at(-1);
    if (decision) {
      lines.push("", `계속 연구 판단: ${decision.shouldContinue ? "계속" : "최종 산출로 이동"}`, `이유: ${decision.reason}`);
      if (decision.nextObjective) lines.push(`다음 목표: ${decision.nextObjective}`);
      if (decision.evidenceGaps.length) lines.push(`Evidence gap: ${decision.evidenceGaps.join(", ")}`);
    }
  }

  if (iteration.step === ResearchLoopStep.FinalizeOutputs) {
    const output = snapshot.finalOutputs.at(-1);
    const reportPath = output?.reportPath ?? snapshot.report?.reportPath;
    if (output?.finalAnswer) {
      lines.push("", "최종 답변", output.finalAnswer);
    }
    if (reportPath) {
      lines.push("", `보고서 파일: ${reportPath}`);
    }
  }

  return lines.join("\n");
}

function stepReportLabel(step: ResearchLoopStep): string {
  const labels: Record<ResearchLoopStep, string> = {
    [ResearchLoopStep.CreateResearchDb]: "1. 연구 DB 생성",
    [ResearchLoopStep.InputResearchQuestionHypothesis]: "2. 연구 질문/가설 입력",
    [ResearchLoopStep.BuildResearchSpecification]: "3. 연구 명세 수립",
    [ResearchLoopStep.PlanResearch]: "4. 연구 계획 수립",
    [ResearchLoopStep.ExecuteTools]: "5. 도구 실행 및 연구 수행",
    [ResearchLoopStep.NormalizeData]: "6. 데이터 수집 및 정규화",
    [ResearchLoopStep.BuildVectorIndex]: "7. 임베딩 및 벡터 구조화",
    [ResearchLoopStep.BuildOntologyGraph]: "8. 온톨로지 기반 구조화",
    [ResearchLoopStep.ReasonAndValidate]: "9. 추론 및 검증",
    [ResearchLoopStep.SynthesizeAndEvaluate]: "10. 결과 합성 및 가설 평가",
    [ResearchLoopStep.DecideContinuation]: "11. 계속 연구 판단",
    [ResearchLoopStep.FinalizeOutputs]: "12. 최종 결과 도출"
  };
  return labels[step];
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  for (const item of value) {
    const text = cleanText(item);
    if (!text) continue;
    output.push(text);
    if (output.length >= 8) break;
  }
  return output;
}

function appendBulletSection(output: string, heading: string, items: string[]): string {
  if (!items.length) return output;
  let next = `${output}\n\n${heading}`;
  for (const item of items) {
    next += `\n- ${item}`;
  }
  return next;
}

function summarize(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
}

function resolveSafetyCapIterations(maxLoopIterations: number | undefined): number {
  if (typeof maxLoopIterations === "number" && Number.isFinite(maxLoopIterations) && maxLoopIterations > 0) {
    return Math.max(1, Math.floor(maxLoopIterations));
  }
  return INTERNAL_LOOP_SAFETY_CAP;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorMetadata(error: unknown, step: ResearchLoopStep): Record<string, unknown> {
  if (error instanceof LlmTimeoutError) {
    return {
      ...error.metadata,
      step,
      timeout: true
    };
  }
  return {};
}

function sourceCandidatesFromPlan(
  projectId: string,
  iteration: number,
  plan: ResearchPlan | undefined,
  context: ResearchSnapshot["projectContextSnapshots"][number] | undefined
): ResearchSource[] {
  const urls = new Map<string, string>();
  for (const url of plan?.fetchCandidateUrls ?? []) {
    const normalized = normalizePublicHttpUrl(url);
    if (normalized) urls.set(normalized, normalized);
  }
  const sources: ResearchSource[] = [];
  let index = 0;
  for (const url of urls.values()) {
    sources.push({
      id: createStableId("source", `${projectId}:${iteration}:fetch-candidate:${url}`),
      projectId,
      kind: "web",
      title: `Continuation fetch candidate ${index + 1}`,
      url,
      retrievedAt: nowIso(),
      metadata: {
        fromContinuationDecision: true,
        fromResearchPlan: plan?.id,
        fromProjectContextSnapshotId: context?.id,
        memoryScope: "project_only",
        sourceCandidateOnly: true,
        canSupportHypothesis: false
      },
      createdAt: nowIso()
    });
    index += 1;
  }
  return sources;
}

function normalizePublicHttpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizeToolNameForPlan(value: string): string {
  return value.replace(/\(.*?\)/g, "").replace(/\s+/g, "").trim().toLowerCase();
}
