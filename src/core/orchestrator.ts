import { buildSourceText, chunkResearchSource } from "./chunking.js";
import type { EmbeddingProvider } from "./embeddingProvider.js";
import { EvidenceNormalizer } from "./evidenceNormalizer.js";
import { FinalOutputWriter } from "./finalOutputWriter.js";
import { HybridRetrievalEngine } from "./hybridRetrievalEngine.js";
import { createId, createStableId, nowIso } from "./ids.js";
import type { LlmProvider } from "./llm.js";
import { deriveResultWithLlm } from "./llmPlanning.js";
import { LoopDecisionEngine } from "./loopDecision.js";
import { MemoryPromotionEngine } from "./memoryPromotion.js";
import { OntologyGraphEngine } from "./ontologyGraphEngine.js";
import type { ProjectStorage } from "./projectStorage.js";
import { ProjectContextBuilder } from "./projectContextBuilder.js";
import { ReasoningEngine } from "./reasoningEngine.js";
import { createResearchInput, type ResearchInputPayload } from "./researchInput.js";
import { buildResearchReport } from "./report.js";
import { ResearchPlanner } from "./researchPlanner.js";
import { createDefaultSessions } from "./researchSeed.js";
import { ResearchSpecificationBuilder } from "./researchSpecification.js";
import { RuntimeRequirementChecker, RuntimeRequirementError } from "./runtimeRequirements.js";
import { ToolRunner, ToolRunnerError } from "./toolRunner.js";
import type { ResearchToolResult } from "./toolRegistry.js";
import { ValidationEngine } from "./validationEngine.js";
import { VectorIndexEngine } from "./vectorIndexEngine.js";
import { ResultSynthesizer } from "./resultSynthesizer.js";
import {
  ResearchLoopStep,
  type AppSettings,
  type ContinuationDecision,
  type ResearchProjectInput,
  type EvidenceBasedResult,
  type EvidenceItem,
  type FlowKind,
  type LoopIteration,
  type OpenCodeAdapter,
  type OpenCodeRunOutput,
  type RagContext,
  type RagEngine,
  type ResearchArtifact,
  type ResearchChunk,
  type ResearchDatabase,
  type ResearchPlan,
  type ResearchProject,
  type ResearchSession,
  type ResearchSnapshot,
  type ResearchSource,
  type ResearchSpecification,
  type ResearchStore,
  type RuntimeBlocker,
  type StepError,
  type ToolRun
} from "./types.js";

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
  allowExternalSearch: false,
  allowCodeExecution: false,
  ontologyExtractionMode: "rule_based",
  finalOutputExport: { markdown: true, json: true, ontologyGraph: true, artifactPackage: true },
  updatedAt: nowIso()
};

const INTERNAL_LOOP_SAFETY_CAP = 8;

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
    this.planner = new ResearchPlanner(llm);
  }

  async listProjects(): Promise<ResearchProject[]> {
    return this.store.listProjects();
  }

  async getSnapshot(projectId: string): Promise<ResearchSnapshot> {
    return this.store.getSnapshot(projectId);
  }

  async updateProjectInput(projectId: string, input: ResearchProjectInput): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
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
    const snapshot = await this.store.getSnapshot(projectId);
    const createdAt = nowIso();
    const chatCount = snapshot.sessions.filter((session) => !isLegacyStructuredSession(session.title)).length + 1;
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
    const snapshot = await this.store.getSnapshot(projectId);
    if (payload) {
      const created = createResearchInput(snapshot.project, payload);
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
    const snapshot = await this.store.getSnapshot(projectId);
    const specification = await this.specificationBuilder.build({
      project: snapshot.project,
      questions: snapshot.questions,
      hypotheses: snapshot.hypotheses,
      evidence: snapshot.evidence
    });
    await this.store.saveResearchSpecification(specification);
    await this.moveProject(projectId, ResearchLoopStep.BuildResearchSpecification);
    await this.record(projectId, ResearchLoopStep.BuildResearchSpecification, "Agent Control", "연구 명세와 가설 검증 전략이 생성되었습니다.");
    return this.store.getSnapshot(projectId);
  }

  async planResearch(projectId: string, iteration?: number, decision?: ContinuationDecision): Promise<ResearchSnapshot> {
    try {
      await this.assertStepReady(projectId, ResearchLoopStep.PlanResearch);
      const snapshot = await this.store.getSnapshot(projectId);
      const specification = await this.ensureSpecification(projectId);
      const settings = await this.getSettings();
      const executableTools = this.executableToolNames(snapshot, settings);
      await this.moveProject(projectId, ResearchLoopStep.PlanResearch);
      const plan = await this.planner.plan({
        snapshot: await this.store.getSnapshot(projectId),
        specification,
        iteration: iteration ?? nextIteration(snapshot),
        settings,
        availableTools: executableTools,
        continuationDecision: decision ?? snapshot.continuationDecisions.at(-1)
      });
      this.assertPlanToolsAllowed(plan, executableTools);
      await this.store.saveResearchPlan(plan);
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
      const planSnapshot = await this.ensureResearchPlan(projectId);
      if (planSnapshot.project.status === "blocked" || planSnapshot.project.status === "failed") return planSnapshot;
      await this.setStatus(projectId, "running");
      const initialSnapshot = await this.store.getSnapshot(projectId);
      const safetyCapIterations = resolveSafetyCapIterations(initialSnapshot.project.autonomyPolicy.maxLoopIterations);
      const firstIteration = Math.max(initialSnapshot.results.length, initialSnapshot.openCodeRuns.length) + 1;
      for (let iteration = firstIteration; iteration <= safetyCapIterations; iteration += 1) {
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        const beforeCounts = counts(await this.store.getSnapshot(projectId));

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
    const snapshot = await this.store.getSnapshot(projectId);
    const activeIteration = iteration ?? nextIteration(snapshot);
    await this.moveProject(projectId, ResearchLoopStep.ExecuteTools);
    await this.record(projectId, ResearchLoopStep.ExecuteTools, "Agent Control", `Iteration ${activeIteration} 도구 실행 및 연구 수행을 시작합니다.`);
    const runInput = {
      project: snapshot.project,
      questions: snapshot.questions,
      hypotheses: snapshot.hypotheses,
      evidence: snapshot.evidence,
      artifacts: snapshot.artifacts,
      sources: snapshot.sources,
      ragContext: snapshot.ragContexts.at(-1),
      hybridContext: snapshot.hybridContexts.at(-1),
      specification: snapshot.specifications.at(-1),
      researchPlan: snapshot.researchPlans.at(-1),
      iteration: activeIteration
    };
    try {
      const output = await this.openCode.run(runInput);
      const database = await this.requireDatabase(projectId);
      await this.store.saveOpenCodeRun(output.run);
      if (output.fatalError || output.run.status === "failed") {
        const reason = output.fatalError ?? output.run.logs.at(-1) ?? "OpenCode execution failed.";
        await this.record(projectId, ResearchLoopStep.ExecuteTools, "Agent Control", `OpenCode 도구 실패: ${reason}`);
        await this.persistExecutionOutputs(snapshot.project, database, activeIteration, output);
        throw new Error(reason);
      }
      const settings = await this.getSettings();
      const toolInput = {
        ...runInput,
        evidence: [...(runInput.evidence ?? []), ...output.evidence],
        artifacts: [...(runInput.artifacts ?? []), ...output.artifacts],
        sources: [...(runInput.sources ?? []), ...(output.sources ?? [])],
        toolRuns: [...(output.toolRuns ?? [])]
      };
      let toolResults: ResearchToolResult[] = [];
      try {
        toolResults = this.toolRunner ? await this.toolRunner.runAll(toolInput, settings) : [];
      } catch (toolError) {
        if (toolError instanceof ToolRunnerError) {
          const resultsToPersist = [
            ...toolError.partialResults,
            ...(toolError.failedResult ? [toolError.failedResult] : [])
          ];
          await this.persistExecutionOutputs(snapshot.project, database, activeIteration, output, resultsToPersist);
        }
        throw toolError;
      }
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
    const executionBundleId = `execution-bundle:${project.id}:${iteration}:${output.run.id}`;
    const bundledOutput: OpenCodeRunOutput = {
      ...output,
      run: {
        ...output.run,
        metadata: { ...(output.run.metadata ?? {}), executionBundleId },
        logs: output.run.logs.some((line) => line.includes(executionBundleId))
          ? output.run.logs
          : [...output.run.logs, `executionBundleId: ${executionBundleId}`]
      },
      artifacts: output.artifacts.map((artifact) => withArtifactBundle(artifact, executionBundleId)),
      evidence: output.evidence.map((evidence) => withEvidenceBundle(evidence, executionBundleId)),
      sources: output.sources?.map((source) => withSourceBundle(source, executionBundleId)),
      toolRuns: output.toolRuns?.map((run) => withToolRunBundle(run, executionBundleId))
    };
    const bundledToolResults = toolResults.map((result) => ({
      ...result,
      toolRun: withToolRunBundle(result.toolRun, executionBundleId),
      artifacts: result.artifacts.map((artifact) => withArtifactBundle(artifact, executionBundleId)),
      evidence: result.evidence.map((evidence) => withEvidenceBundle(evidence, executionBundleId)),
      sources: result.sources.map((source) => withSourceBundle(source, executionBundleId))
    }));
    const toolResultArtifacts = bundledToolResults.flatMap((result) => result.artifacts);
    const toolResultEvidence = bundledToolResults.flatMap((result) => result.evidence);
    const toolResultSources = bundledToolResults.flatMap((result) => result.sources);
    const artifacts = await this.projectStorage.writeArtifacts(project, database, iteration, [
      ...bundledOutput.artifacts,
      ...toolResultArtifacts
    ]);
    const toolRuns = [...(bundledOutput.toolRuns ?? []), ...bundledToolResults.map((result) => result.toolRun)];
    const logSource = await this.projectStorage.writeRunLog(project, database, iteration, bundledOutput.run, toolRuns);

    await this.store.saveOpenCodeRun(bundledOutput.run);
    await this.store.saveArtifacts(artifacts);
    await this.store.saveEvidence([...bundledOutput.evidence, ...toolResultEvidence]);
    const sources = [...(bundledOutput.sources ?? []), ...toolResultSources];
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
    const snapshot = await this.store.getSnapshot(projectId);
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
    const snapshot = await this.store.getSnapshot(projectId);
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
      const indexedRecordIds = new Set(chunks.map((chunk) => chunk.recordId).filter(Boolean));
      await this.store.saveNormalizedRecords(snapshot.normalizedRecords
        .filter((record) => indexedRecordIds.has(record.id))
        .map((record) => ({ ...record, validationStatus: record.validationStatus === "normalized" ? "indexed" : record.validationStatus })));
    }
    const ragContext = await this.ragEngine.buildContext(await this.store.getSnapshot(projectId));
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
    const snapshot = await this.store.getSnapshot(projectId);
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
    const graphRecordIds = new Set([
      ...graph.entities.map((entity) => entity.sourceRecordId),
      ...graph.relations.map((relation) => relation.sourceRecordId),
      ...graph.constraints.map((constraint) => constraint.sourceRecordId)
    ].filter(Boolean));
    if (graphRecordIds.size) {
      await this.store.saveNormalizedRecords(snapshot.normalizedRecords
        .filter((record) => graphRecordIds.has(record.id))
        .map((record) => ({ ...record, validationStatus: record.validationStatus === "normalized" || record.validationStatus === "indexed" ? "graph_linked" : record.validationStatus })));
    }
    await this.record(projectId, ResearchLoopStep.BuildOntologyGraph, "Knowledge Flow", `Main Ontology Graph가 생성되었습니다. entities=${graph.entities.length}, relations=${graph.relations.length}.`);
    return this.store.getSnapshot(projectId);
  }

  async reasonAndValidate(projectId: string, iteration?: number): Promise<ResearchSnapshot> {
    await this.moveProject(projectId, ResearchLoopStep.ReasonAndValidate);
    await this.record(projectId, ResearchLoopStep.ReasonAndValidate, "Agent Control", "ProjectContextSnapshot 선택과 추론/검증을 시작합니다.");
    const snapshot = await this.store.getSnapshot(projectId);
    const activeIteration = iteration ?? nextIteration(snapshot);
    const contextSnapshot = await this.projectContextBuilder.buildFromMainMemory({
      snapshot,
      iteration: activeIteration,
      store: this.store
    });
    if (!contextSnapshot.selectedRecordIds.length) {
      throw new Error("ProjectContextSnapshot could not select any Main Research Memory records for validation.");
    }
    await this.store.saveProjectContextSnapshot(contextSnapshot);
    const afterContext = await this.store.getSnapshot(projectId);
    const hybridContext = await new HybridRetrievalEngine(this.embeddingProvider).buildContextFromProjectContext(afterContext, contextSnapshot, activeIteration);
    await this.store.saveHybridContext(hybridContext);
    const contextAwareSnapshot = await this.store.getSnapshot(projectId);
    const reasoning = this.reasoning.reason(contextAwareSnapshot, hybridContext);
    const validations = this.validation.validate(contextAwareSnapshot, hybridContext, reasoning);
    await this.store.saveValidationResults(validations);
    const validatedEvidenceIds = new Set(validations.flatMap((validation) => [...validation.supportingEvidenceIds, ...validation.contradictingEvidenceIds]));
    if (validatedEvidenceIds.size) {
      await this.store.saveNormalizedRecords(contextAwareSnapshot.normalizedRecords
        .filter((record) => record.evidenceId && validatedEvidenceIds.has(record.evidenceId) && record.kind === "evidence")
        .map((record) => ({ ...record, validationStatus: "validated" })));
    }
    await this.record(projectId, ResearchLoopStep.ReasonAndValidate, "Agent Control", `Hybrid retrieval 기반 검증 결과 ${validations.length}개가 생성되었습니다.`);
    return this.store.getSnapshot(projectId);
  }

  async synthesizeAndEvaluate(projectId: string, iteration?: number, forceStop = false): Promise<EvidenceBasedResult> {
    await this.assertStepReady(projectId, ResearchLoopStep.SynthesizeAndEvaluate);
    await this.moveProject(projectId, ResearchLoopStep.SynthesizeAndEvaluate);
    await this.record(projectId, ResearchLoopStep.SynthesizeAndEvaluate, "Agent Control", "ProjectContextSnapshot 기반 결과 합성을 시작합니다.");
    const snapshot = await this.store.getSnapshot(projectId);
    const activeIteration = iteration ?? nextIteration(snapshot);
    const contextSnapshot = snapshot.projectContextSnapshots.filter((context) => context.iteration === activeIteration).at(-1);
    if (!contextSnapshot) {
      throw new Error(`ProjectContextSnapshot is required before synthesis for iteration ${activeIteration}.`);
    }
    const hybridContext = snapshot.hybridContexts.filter((context) => context.iteration === activeIteration).at(-1);
    if (!hybridContext) {
      throw new Error(`HybridContext is required before synthesis for iteration ${activeIteration}.`);
    }
    const latestValidations = snapshot.validationResults.filter((result) => result.iteration === activeIteration);
    if (!latestValidations.length) {
      throw new Error(`ValidationResult is required before synthesis for iteration ${activeIteration}.`);
    }
    const draft = this.resultSynthesizer.synthesize({ snapshot, hybridContext, validationResults: latestValidations, forceStop });
    const llmResult = await this.tryLlmResult({ ...snapshot, hybridContexts: [...snapshot.hybridContexts, hybridContext], validationResults: latestValidations }, activeIteration, forceStop);
    const result = {
      ...draft,
      ...llmResult,
      id: llmResult.id,
      validationResultIds: latestValidations.map((validation) => validation.id),
      hybridContextId: hybridContext.id,
      hypothesisUpdates: llmResult.hypothesisUpdates.length ? llmResult.hypothesisUpdates : draft.hypothesisUpdates,
      quantitativeResults: llmResult.quantitativeResults.length ? llmResult.quantitativeResults : draft.quantitativeResults,
      qualitativeResults: [
        ...(llmResult.qualitativeResults.length ? llmResult.qualitativeResults : draft.qualitativeResults),
        ...(hybridContext.citations.length ? [`Citations preserved: ${hybridContext.citations.slice(0, 5).join("; ")}`] : [])
      ]
    };
    assertCitationPreservingResult(result, hybridContext);
    await this.store.saveResult(result);
    await this.applyHypothesisUpdates(projectId, result);
    await this.record(projectId, ResearchLoopStep.SynthesizeAndEvaluate, "Agent Control", "결과 합성 및 가설 평가가 완료되었습니다.");
    return result;
  }

  async deriveResult(projectId: string, forceStop = false): Promise<EvidenceBasedResult> {
    const snapshot = await this.store.getSnapshot(projectId);
    return this.synthesizeAndEvaluate(projectId, nextIteration(snapshot), forceStop);
  }

  async decideContinuation(
    projectId: string,
    result: EvidenceBasedResult,
    beforeCounts?: { evidence: number; artifacts: number; chunks: number; entities: number; relations: number },
    iteration = result.iteration,
    safetyCapIterations = INTERNAL_LOOP_SAFETY_CAP
  ): Promise<ContinuationDecision> {
    const snapshot = await this.store.getSnapshot(projectId);
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
    const snapshot = await this.store.getSnapshot(projectId);
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
    if (!snapshot.questions.length || !snapshot.hypotheses.length) snapshot = await this.inputResearchQuestionHypothesis(projectId);
    return snapshot;
  }

  private async ensureResearchSpecification(projectId: string): Promise<ResearchSnapshot> {
    let snapshot = await this.store.getSnapshot(projectId);
    if (!snapshot.specifications.length) snapshot = await this.buildResearchSpecification(projectId);
    return snapshot;
  }

  private async ensureResearchPlan(projectId: string, iteration?: number): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const activeIteration = iteration ?? nextIteration(snapshot);
    const plan = snapshot.researchPlans.find((item) => item.iteration === activeIteration);
    return plan ? snapshot : this.planResearch(projectId, activeIteration);
  }

  private async ensureSpecification(projectId: string): Promise<ResearchSpecification> {
    let snapshot = await this.store.getSnapshot(projectId);
    if (!snapshot.specifications.length) {
      snapshot = await this.buildResearchSpecification(projectId);
    }
    const specification = snapshot.specifications.at(-1);
    if (!specification) {
      throw new Error("Research specification was not created.");
    }
    return specification;
  }

  private async ingestSources(projectId: string): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    const database = await this.requireDatabase(projectId);
    const existingSourceIds = new Set(snapshot.sources.map((item) => item.id));
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
    const withOpenCode = settings.openCode.enabled && Boolean(settings.openCode.command?.trim()) ? ["OpenCodeTool", ...tools] : tools;
    return [...new Set(withOpenCode)];
  }

  private assertPlanToolsAllowed(plan: ResearchPlan, allowedTools: string[]): void {
    const allowed = new Set(allowedTools.map(normalizeToolNameForPlan));
    const registered = new Set(this.registeredToolNames().map(normalizeToolNameForPlan));
    const missing = plan.requiredTools.filter((tool) => normalizeToolNameForPlan(tool) !== "opencodetool" && !registered.has(normalizeToolNameForPlan(tool)));
    const unavailable = plan.requiredTools.filter((tool) => normalizeToolNameForPlan(tool) !== "opencodetool" && !allowed.has(normalizeToolNameForPlan(tool)));
    const unmet = [
      ...missing.map((tool) => ({
      key: "tool.registered",
      label: "Registered research tool",
      requiredForSteps: [ResearchLoopStep.PlanResearch],
      isSatisfied: false,
      message: `Research plan requires an unregistered tool: ${tool}`
      })),
      ...unavailable.map((tool) => ({
        key: "tool.available",
        label: "Executable research tool",
        requiredForSteps: [ResearchLoopStep.PlanResearch],
        isSatisfied: false,
        message: `Research plan requires a tool that is not executable in the current settings/state: ${tool}`
      }))
    ];
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
    return this.store.getSnapshot(projectId);
  }

  private async failProject(projectId: string, step: ResearchLoopStep, error: unknown): Promise<void> {
    await this.moveProject(projectId, step, "failed");
    await this.saveStepError(projectId, step, formatError(error), "step_failed", {});
    await this.record(projectId, step, "Error Flow", `연구 단계 실패: ${formatError(error)}`);
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
    const updates = new Map(result.hypothesisUpdates.map((item) => [item.hypothesisId, item]));
    await this.store.saveHypotheses(
      snapshot.hypotheses.map((hypothesis) => {
        const update = updates.get(hypothesis.id);
        return update ? { ...hypothesis, status: update.status, confidence: update.confidence } : hypothesis;
      })
    );
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
    return [
      answer,
      citations.length ? `\n근거/출처\n${citations.map((item) => `- ${item}`).join("\n")}` : "",
      limitations.length ? `\n한계\n${limitations.map((item) => `- ${item}`).join("\n")}` : "",
      nextActions.length ? `\n다음 작업\n${nextActions.map((item) => `- ${item}`).join("\n")}` : ""
    ].filter(Boolean).join("\n");
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

function withToolRunBundle(toolRun: ToolRun, executionBundleId: string): ToolRun {
  return {
    ...toolRun,
    input: appendBundleToUnknown(toolRun.input, executionBundleId),
    output: appendBundleToUnknown(toolRun.output, executionBundleId)
  };
}

function withSourceBundle(source: ResearchSource, executionBundleId: string): ResearchSource {
  return {
    ...source,
    metadata: { ...source.metadata, executionBundleId }
  };
}

function withEvidenceBundle(evidence: EvidenceItem, executionBundleId: string): EvidenceItem {
  return {
    ...evidence,
    metadata: { ...(evidence.metadata ?? {}), executionBundleId }
  };
}

function withArtifactBundle(artifact: ResearchArtifact, executionBundleId: string): ResearchArtifact {
  return {
    ...artifact,
    metadata: { ...(artifact.metadata ?? {}), executionBundleId }
  };
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

function nextIteration(snapshot: ResearchSnapshot): number {
  return Math.max(snapshot.results.length, snapshot.openCodeRuns.length, snapshot.researchPlans.length) + 1;
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

function assertCitationPreservingResult(result: EvidenceBasedResult, hybridContext: import("./types.js").HybridContext): void {
  if (!result.validationResultIds?.length) {
    throw new Error("Result synthesis omitted validationResultIds.");
  }
  if (result.hybridContextId !== hybridContext.id) {
    throw new Error("Result synthesis omitted the active HybridContext reference.");
  }
  if (!hybridContext.citations.length) {
    return;
  }
  const resultText = [
    result.answer,
    ...result.quantitativeResults,
    ...result.qualitativeResults,
    ...result.hypothesisUpdates.map((update) => update.rationale)
  ].join("\n");
  const citesKnownContext = hybridContext.citations.some((citation) => resultText.includes(citation) || resultText.includes(citation.slice(0, 40)));
  if (!citesKnownContext && result.needsMoreEvidence === false) {
    throw new Error("LLM synthesis did not preserve any ProjectContextSnapshot citation.");
  }
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 70);
  return slug || createStableId("project", value);
}

function isLegacyStructuredSession(title: string): boolean {
  return ["질문/가설 세션", "근거/RAG 세션", "실행/분석 세션"].includes(title);
}

function buildChatTranscript(snapshot: ResearchSnapshot, sessionId: string): string {
  const messages = snapshot.artifacts
    .filter((artifact) => artifact.category === "conversation_memo" && artifact.relativePath.replace(/\\/g, "/").includes(`/chat/${sessionId}-`))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-12);
  return messages.length
    ? messages.map((artifact) => `${artifact.relativePath.endsWith("-assistant.md") ? "assistant" : "user"}: ${artifact.content ?? artifact.summary}`).join("\n\n")
    : "No stored chat messages yet.";
}

function selectDefaultChatSession(snapshot: ResearchSnapshot): ResearchSession | undefined {
  return snapshot.sessions.find((session) => !isLegacyStructuredSession(session.title)) ?? snapshot.sessions[0];
}

function shouldReportIterationToChat(iteration: LoopIteration): boolean {
  const ignoredMessages = ["사용자 메시지", "LLM 응답", "세션이 생성", "세션을 삭제", "연구 프로젝트가 생성"];
  if (ignoredMessages.some((message) => iteration.message.includes(message))) {
    return false;
  }
  return new Set<ResearchLoopStep>([
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
  ]).has(iteration.step);
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
    `- 누적 산출물: ${snapshot.artifacts.filter((artifact) => artifact.category !== "conversation_memo").length}`,
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
  return Array.isArray(value) ? value.map(cleanText).filter(Boolean).slice(0, 8) : [];
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

function normalizeToolNameForPlan(value: string): string {
  return value.replace(/\(.*?\)/g, "").replace(/\s+/g, "").trim().toLowerCase();
}
