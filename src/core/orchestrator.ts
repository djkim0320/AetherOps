import { buildSourceText, chunkResearchSource } from "./chunking.js";
import type { EmbeddingProvider } from "./embeddingProvider.js";
import { EvidenceNormalizer } from "./evidenceNormalizer.js";
import { FinalOutputWriter } from "./finalOutputWriter.js";
import { HybridRetrievalEngine } from "./hybridRetrievalEngine.js";
import { createId, createStableId, nowIso } from "./ids.js";
import type { LlmProvider } from "./llm.js";
import { deriveResultWithLlm } from "./llmPlanning.js";
import { LoopDecisionEngine } from "./loopDecision.js";
import { OntologyGraphEngine } from "./ontologyGraphEngine.js";
import type { ProjectStorage } from "./projectStorage.js";
import { ReasoningEngine } from "./reasoningEngine.js";
import { createResearchInput, type ResearchInputPayload } from "./researchInput.js";
import { buildResearchReport } from "./report.js";
import { ResearchPlanner } from "./researchPlanner.js";
import { createDefaultSessions } from "./researchSeed.js";
import { ResearchSpecificationBuilder } from "./researchSpecification.js";
import { RuntimeRequirementChecker, RuntimeRequirementError } from "./runtimeRequirements.js";
import { ToolRunner } from "./toolRunner.js";
import { ValidationEngine } from "./validationEngine.js";
import { VectorIndexEngine } from "./vectorIndexEngine.js";
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
  maxLoopIterations: 2,
  ontologyExtractionMode: "rule_based",
  finalOutputExport: { markdown: true, json: true, ontologyGraph: true, artifactPackage: true },
  updatedAt: nowIso()
};

export class AetherOpsOrchestrator {
  private readonly specificationBuilder: ResearchSpecificationBuilder;
  private readonly planner: ResearchPlanner;
  private readonly normalizer = new EvidenceNormalizer();
  private readonly ontologyGraph = new OntologyGraphEngine();
  private readonly reasoning = new ReasoningEngine();
  private readonly validation = new ValidationEngine();
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
    await this.moveProject(projectId, ResearchLoopStep.InputResearchQuestionHypothesis);
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
      const plan = await this.planner.plan({
        snapshot: await this.store.getSnapshot(projectId),
        specification,
        iteration: iteration ?? nextIteration(snapshot),
        settings,
        availableTools: this.registeredToolNames(),
        continuationDecision: decision ?? snapshot.continuationDecisions.at(-1)
      });
      this.assertPlanToolsRegistered(plan);
      await this.store.saveResearchPlan(plan);
      await this.moveProject(projectId, ResearchLoopStep.PlanResearch);
      await this.record(projectId, ResearchLoopStep.PlanResearch, "Agent Control", `Iteration ${plan.iteration} 연구 계획이 수립되었습니다.`);
      return this.store.getSnapshot(projectId);
    } catch (error) {
      if (error instanceof RuntimeRequirementError) {
        return this.blockProject(projectId, error);
      }
      throw error;
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
      await this.ensureResearchDb(projectId);
      const inputSnapshot = await this.ensureResearchInput(projectId);
      if (inputSnapshot.project.status === "blocked") return inputSnapshot;
      const specificationSnapshot = await this.ensureResearchSpecification(projectId);
      if (specificationSnapshot.project.status === "blocked" || specificationSnapshot.project.status === "failed") return specificationSnapshot;
      const planSnapshot = await this.ensureResearchPlan(projectId);
      if (planSnapshot.project.status === "blocked" || planSnapshot.project.status === "failed") return planSnapshot;
      await this.setStatus(projectId, "running");
      const settings = await this.getSettings();
      const initialSnapshot = await this.store.getSnapshot(projectId);
      const maxIterations = Math.max(1, initialSnapshot.project.autonomyPolicy.maxLoopIterations || settings.maxLoopIterations || 1);
      const firstIteration = Math.max(initialSnapshot.results.length, initialSnapshot.openCodeRuns.length) + 1;
      for (let iteration = firstIteration; iteration <= maxIterations; iteration += 1) {
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
        const result = await this.synthesizeAndEvaluate(projectId, iteration, iteration >= maxIterations);
        const decision = await this.decideContinuation(projectId, result, beforeCounts, iteration, maxIterations);
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
      ragContext: snapshot.ragContexts.at(-1),
      hybridContext: snapshot.hybridContexts.at(-1),
      specification: snapshot.specifications.at(-1),
      researchPlan: snapshot.researchPlans.at(-1),
      iteration: activeIteration
    };
    try {
      const output = await this.openCode.run(runInput);
      if (output.fatalError || output.run.status === "failed") {
        const reason = output.fatalError ?? output.run.logs.at(-1) ?? "OpenCode execution failed.";
        await this.record(projectId, ResearchLoopStep.ExecuteTools, "Agent Control", `OpenCode 도구 실패: ${reason}`);
        throw new Error(reason);
      }
      const settings = await this.getSettings();
      const toolResults = this.toolRunner ? await this.toolRunner.runAll(runInput, settings) : [];
      const toolResultArtifacts = toolResults.flatMap((result) => result.artifacts);
      const toolResultEvidence = toolResults.flatMap((result) => result.evidence);
      const toolResultSources = toolResults.flatMap((result) => result.sources);

      const database = await this.requireDatabase(projectId);
      const artifacts = await this.projectStorage.writeArtifacts(snapshot.project, database, activeIteration, [
        ...output.artifacts,
        ...toolResultArtifacts
      ]);
      const toolRuns = [...(output.toolRuns ?? []), ...toolResults.map((result) => result.toolRun)];
      const logSource = await this.projectStorage.writeRunLog(snapshot.project, database, activeIteration, output.run, toolRuns);

      await this.store.saveOpenCodeRun(output.run);
      await this.store.saveArtifacts(artifacts);
      await this.store.saveEvidence([...output.evidence, ...toolResultEvidence]);
      const sources = [...(output.sources ?? []), ...toolResultSources];
      if (sources.length) {
        await this.store.saveSources(await this.projectStorage.writeSources(snapshot.project, database, sources));
      }
      if (logSource) await this.store.saveSources([logSource]);
      if (toolRuns.length) await this.store.saveToolRuns(toolRuns);
      if (output.agentPlan) await this.store.saveResearchPlan(output.agentPlan);
      if (output.chunks?.length) {
        await this.projectStorage.writeChunks(snapshot.project, database, output.chunks);
        await this.store.saveChunks(output.chunks);
      }
      await this.ingestSources(projectId);
      await this.record(projectId, ResearchLoopStep.ExecuteTools, "Agent Control", "도구 실행 및 연구 수행 단계가 완료되었습니다.");
    } catch (error) {
      await this.failProject(projectId, ResearchLoopStep.ExecuteTools, error);
      return this.store.getSnapshot(projectId);
    }
    return this.store.getSnapshot(projectId);
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
    await this.ingestSources(projectId);
    const snapshot = await this.store.getSnapshot(projectId);
    const records = this.normalizer.normalize(snapshot, iteration ?? nextIteration(snapshot));
    await this.store.saveNormalizedRecords(records);
    await this.moveProject(projectId, ResearchLoopStep.NormalizeData);
    await this.record(projectId, ResearchLoopStep.NormalizeData, "Storage Flow", `정규화 레코드 ${records.length}개가 Source/Artifact/Claim/Evidence/Observation/Citation 단위로 저장되었습니다.`);
    return this.store.getSnapshot(projectId);
  }

  async storeResults(projectId: string): Promise<ResearchSnapshot> {
    return this.normalizeData(projectId);
  }

  async buildVectorIndex(projectId: string): Promise<ResearchSnapshot> {
    await this.assertStepReady(projectId, ResearchLoopStep.BuildVectorIndex);
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
    }
    const ragContext = await this.ragEngine.buildContext(await this.store.getSnapshot(projectId));
    await this.store.saveRagContext(ragContext);
    await this.moveProject(projectId, ResearchLoopStep.BuildVectorIndex);
    await this.record(projectId, ResearchLoopStep.BuildVectorIndex, "Knowledge Flow", `Vector index가 갱신되었습니다. 새 chunk=${chunks.length}.`);
    return this.store.getSnapshot(projectId);
  }

  async buildRagContext(projectId: string): Promise<RagContext> {
    await this.buildVectorIndex(projectId);
    return (await this.store.getSnapshot(projectId)).ragContexts.at(-1) as RagContext;
  }

  async buildOntologyGraph(projectId: string): Promise<ResearchSnapshot> {
    await this.assertStepReady(projectId, ResearchLoopStep.BuildOntologyGraph);
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
    await this.moveProject(projectId, ResearchLoopStep.BuildOntologyGraph);
    await this.record(projectId, ResearchLoopStep.BuildOntologyGraph, "Knowledge Flow", `Ontology graph가 생성되었습니다. entities=${graph.entities.length}, relations=${graph.relations.length}.`);
    return this.store.getSnapshot(projectId);
  }

  async reasonAndValidate(projectId: string, iteration?: number): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const activeIteration = iteration ?? nextIteration(snapshot);
    const hybridContext = await new HybridRetrievalEngine(this.embeddingProvider).buildContext(snapshot, undefined, activeIteration);
    await this.store.saveHybridContext(hybridContext);
    const reasoning = this.reasoning.reason(snapshot, hybridContext);
    const validations = this.validation.validate(snapshot, hybridContext, reasoning);
    await this.store.saveValidationResults(validations);
    await this.moveProject(projectId, ResearchLoopStep.ReasonAndValidate);
    await this.record(projectId, ResearchLoopStep.ReasonAndValidate, "Agent Control", `Hybrid retrieval 기반 검증 결과 ${validations.length}개가 생성되었습니다.`);
    return this.store.getSnapshot(projectId);
  }

  async synthesizeAndEvaluate(projectId: string, iteration?: number, forceStop = false): Promise<EvidenceBasedResult> {
    await this.assertStepReady(projectId, ResearchLoopStep.SynthesizeAndEvaluate);
    const snapshot = await this.store.getSnapshot(projectId);
    const activeIteration = iteration ?? nextIteration(snapshot);
    const hybridContext = snapshot.hybridContexts.at(-1) ?? await new HybridRetrievalEngine(this.embeddingProvider).buildContext(snapshot, undefined, activeIteration);
    const latestValidations = snapshot.validationResults.filter((result) => result.iteration === activeIteration);
    const result = await this.tryLlmResult(snapshot, activeIteration, forceStop);
    await this.store.saveResult(result);
    await this.applyHypothesisUpdates(projectId, result);
    await this.moveProject(projectId, ResearchLoopStep.SynthesizeAndEvaluate);
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
    maxLoopIterations?: number
  ): Promise<ContinuationDecision> {
    const snapshot = await this.store.getSnapshot(projectId);
    const settings = await this.getSettings();
    const decision = this.loopDecision.decide({
      snapshot,
      result,
      iteration,
      maxLoopIterations: maxLoopIterations ?? settings.maxLoopIterations,
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
    const database = await this.requireDatabase(projectId);
    const output = await new FinalOutputWriter(this.projectStorage).write(snapshot, database);
    const report = buildResearchReport(snapshot);
    await this.store.saveReport({ ...report, reportPath: output.reportPath, knowledgePath: `${snapshot.project.projectRoot}/knowledge/reusable-knowledge.md` });
    await this.store.saveFinalResearchOutput(output);
    await this.moveProject(projectId, ResearchLoopStep.FinalizeOutputs, "completed");
    await this.record(projectId, ResearchLoopStep.FinalizeOutputs, "Output Flow", "최종 보고서, 지식 자산, 그래프 export, artifact package가 생성되었습니다.");
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
    return this.toolRunner?.listToolNames() ?? [];
  }

  private assertPlanToolsRegistered(plan: ResearchPlan): void {
    const registered = new Set(this.registeredToolNames().map(normalizeToolNameForPlan));
    const missing = plan.requiredTools.filter((tool) => normalizeToolNameForPlan(tool) !== "opencodetool" && !registered.has(normalizeToolNameForPlan(tool)));
    if (!missing.length) {
      return;
    }
    throw new RuntimeRequirementError(ResearchLoopStep.PlanResearch, missing.map((tool) => ({
      key: "tool.registered",
      label: "Registered research tool",
      requiredForSteps: [ResearchLoopStep.PlanResearch],
      isSatisfied: false,
      message: `Research plan requires an unregistered tool: ${tool}`
    })));
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeToolNameForPlan(value: string): string {
  return value.replace(/\(.*?\)/g, "").replace(/\s+/g, "").trim().toLowerCase();
}
