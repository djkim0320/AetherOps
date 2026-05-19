import { chunkResearchSource, buildSourceText } from "./chunking.js";
import { LocalHashEmbeddingProvider, type EmbeddingProvider } from "./embeddingProvider.js";
import { createId, createStableId, nowIso } from "./ids.js";
import { NoopLlmProvider, type LlmProvider } from "./llm.js";
import { deriveResultWithLlm, generateSeedPlanWithLlm } from "./llmPlanning.js";
import { MockOpenCodeAdapter } from "./mockOpenCodeAdapter.js";
import { NoopProjectStorage, type ProjectStorage } from "./projectStorage.js";
import { buildResearchReport } from "./report.js";
import { createDefaultSessions, seedResearchPlan } from "./researchSeed.js";
import { VectorRagEngine } from "./vectorRagEngine.js";
import {
  ResearchLoopStep,
  type CreateProjectInput,
  type EvidenceBasedResult,
  type EvidenceItem,
  type FlowKind,
  type LoopIteration,
  type OpenCodeAdapter,
  type RagContext,
  type RagEngine,
  type ResearchArtifact,
  type ResearchChunk,
  type ResearchDatabase,
  type ResearchProject,
  type ResearchSession,
  type ResearchSnapshot,
  type ResearchSource,
  type ResearchStore,
  type ToolRun
} from "./types.js";

type SeedPlan = ReturnType<typeof seedResearchPlan>;

interface ChatReplyResponse {
  answer?: string;
  citations?: string[];
  limitations?: string[];
  nextActions?: string[];
}

export class AetherOpsOrchestrator {
  constructor(
    private readonly store: ResearchStore,
    private readonly openCode: OpenCodeAdapter = new MockOpenCodeAdapter(),
    private readonly ragEngine: RagEngine = new VectorRagEngine(),
    private readonly projectRootBase = ".aetherops/projects",
    private readonly llm: LlmProvider = new NoopLlmProvider(),
    private readonly projectStorage: ProjectStorage = new NoopProjectStorage(),
    private readonly embeddingProvider: EmbeddingProvider = new LocalHashEmbeddingProvider()
  ) {}

  async listProjects(): Promise<ResearchProject[]> {
    return this.store.listProjects();
  }

  async getSnapshot(projectId: string): Promise<ResearchSnapshot> {
    return this.store.getSnapshot(projectId);
  }

  async getLlmStatus(): Promise<{ provider: string; available: boolean }> {
    return {
      provider: this.llm.name,
      available: await this.llm.isAvailable()
    };
  }

  async createProject(input: CreateProjectInput): Promise<ResearchSnapshot> {
    const createdAt = nowIso();
    const project: ResearchProject = {
      ...input,
      id: createId("project"),
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.CreateProject,
      status: "idle",
      projectRoot: `${this.projectRootBase}/${slugify(input.topic)}-${createdAt.slice(0, 10)}`
    };
    await this.store.saveProject(project);
    await this.record(project.id, ResearchLoopStep.CreateProject, "Main Flow", "연구 프로젝트가 생성되었습니다.");
    return this.store.getSnapshot(project.id);
  }

  async createSubSessions(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const sessions = createDefaultSessions(snapshot.project);
    await this.store.saveSessions(sessions);
    await this.moveProject(projectId, ResearchLoopStep.CreateSubSessions);
    await this.record(projectId, ResearchLoopStep.CreateSubSessions, "Main Flow", "기본 채팅 세션이 생성되었습니다.");
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
      focus: focus?.trim() || `${snapshot.project.topic} 관련 대화형 연구 세션입니다.`,
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
    await this.record(projectId, snapshot.project.currentStep, "Main Flow", `${session.title} 세션이 삭제되었습니다.`);
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
    await this.ingestSourcesAndArtifacts(projectId);

    if (!(await this.llm.isAvailable())) {
      throw new Error("현재 선택한 LLM을 사용할 수 없습니다. 모델 선택 또는 설정에서 OAuth/API 연결 상태를 확인해 주세요.");
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
    await this.ingestSourcesAndArtifacts(projectId);
    return this.store.getSnapshot(projectId);
  }

  async createResearchDb(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const database = await this.projectStorage.ensureResearchDb(snapshot.project);
    await this.store.saveDatabase(database);
    await this.moveProject(projectId, ResearchLoopStep.CreateResearchDb);
    await this.record(projectId, ResearchLoopStep.CreateResearchDb, "Data Flow", "프로젝트별 독립 연구 DB와 파일 저장소가 생성되었습니다.");
    return this.store.getSnapshot(projectId);
  }

  async seedQuestions(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const plan = (await this.tryLlmSeed(snapshot.project)) ?? seedResearchPlan(snapshot.project);
    await this.store.saveQuestions(plan.questions);
    await this.store.saveHypotheses(plan.hypotheses);
    await this.store.saveEvidence(plan.evidence);
    await this.moveProject(projectId, ResearchLoopStep.GenerateQuestionsHypothesesEvidence);
    await this.record(
      projectId,
      ResearchLoopStep.GenerateQuestionsHypothesesEvidence,
      "Agent Control",
      this.llm.name === "noop"
        ? "초기 질문, 검증 가능한 가설, seed evidence가 생성되었습니다."
        : `${this.llm.name}로 초기 연구 계획이 생성되었습니다.`
    );
    await this.ingestSourcesAndArtifacts(projectId);
    return this.store.getSnapshot(projectId);
  }

  async startLoop(projectId: string): Promise<ResearchSnapshot> {
    await this.ensureInitialized(projectId);
    await this.setStatus(projectId, "running");

    try {
      let snapshot = await this.store.getSnapshot(projectId);
      const maxIterations = Math.max(1, snapshot.project.autonomyPolicy.maxLoopIterations);
      for (let iteration = snapshot.openCodeRuns.length + 1; iteration <= maxIterations; iteration += 1) {
        const before = await this.checkAbortOrPause(projectId);
        if (before !== "running") {
          return this.store.getSnapshot(projectId);
        }

        const beforeCounts = {
          evidence: snapshot.evidence.length,
          artifacts: snapshot.artifacts.length
        };

        snapshot = await this.runOpenCode(projectId);
        if ((await this.checkAbortOrPause(projectId)) !== "running") {
          return this.store.getSnapshot(projectId);
        }
        snapshot = await this.storeResults(projectId);
        await this.ingestSourcesAndArtifacts(projectId);
        if ((await this.checkAbortOrPause(projectId)) !== "running") {
          return this.store.getSnapshot(projectId);
        }
        await this.buildRagContext(projectId);
        const result = await this.deriveResult(projectId, iteration >= maxIterations);
        snapshot = await this.store.getSnapshot(projectId);

        if (this.shouldStop(snapshot, result, beforeCounts, iteration, maxIterations)) {
          break;
        }
      }

      if ((await this.checkAbortOrPause(projectId)) !== "running") {
        return this.store.getSnapshot(projectId);
      }
      return this.finalizeReport(projectId);
    } catch (error) {
      await this.record(projectId, ResearchLoopStep.DeriveEvidenceBasedResult, "Agent Control", `루프 실패: ${formatError(error)}`);
      await this.setStatus(projectId, "failed");
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

  async runOpenCode(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const iteration = snapshot.openCodeRuns.length + 1;
    const output = await this.openCode.run({
      project: snapshot.project,
      questions: snapshot.questions,
      hypotheses: snapshot.hypotheses,
      evidence: snapshot.evidence,
      artifacts: snapshot.artifacts,
      ragContext: snapshot.ragContexts.at(-1),
      iteration
    });

    const database = await this.requireDatabase(projectId);
    const artifacts = await this.projectStorage.writeArtifacts(snapshot.project, database, iteration, output.artifacts);
    const toolRuns = output.toolRuns ?? [];
    const logSource = await this.projectStorage.writeRunLog(snapshot.project, database, iteration, output.run, toolRuns);

    await this.store.saveOpenCodeRun(output.run);
    await this.store.saveArtifacts(artifacts);
    await this.store.saveEvidence(output.evidence);
    if (output.sources?.length) {
      await this.store.saveSources(await this.projectStorage.writeSources(snapshot.project, database, output.sources));
    }
    if (logSource) {
      await this.store.saveSources([logSource]);
    }
    if (toolRuns.length) {
      await this.store.saveToolRuns(toolRuns);
    }
    if (output.agentPlan) {
      await this.store.saveAgentPlan(output.agentPlan);
    }
    if (output.chunks?.length) {
      await this.projectStorage.writeChunks(snapshot.project, database, output.chunks);
      await this.store.saveChunks(output.chunks);
    }
    await this.moveProject(projectId, ResearchLoopStep.RunOpenCode);
    await this.record(projectId, ResearchLoopStep.RunOpenCode, "Agent Control", "OpenCode 또는 fallback 실행 어댑터가 연구 실행을 완료했습니다.");
    return this.store.getSnapshot(projectId);
  }

  async storeResults(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    await this.moveProject(projectId, ResearchLoopStep.StoreResults);
    await this.record(
      projectId,
      ResearchLoopStep.StoreResults,
      "Data Flow",
      `결과 저장 완료: 근거 ${snapshot.evidence.length}개, 산출물 ${snapshot.artifacts.length}개, 도구 로그 ${snapshot.toolRuns.length}개.`
    );
    return this.store.getSnapshot(projectId);
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
    await this.record(projectId, ResearchLoopStep.StoreResults, "Data Flow", `${written.title} 산출물이 저장되었습니다.`);
    await this.ingestSourcesAndArtifacts(projectId);
    return this.store.getSnapshot(projectId);
  }

  async buildRagContext(projectId: string): Promise<RagContext> {
    await this.ingestSourcesAndArtifacts(projectId);
    const snapshot = await this.store.getSnapshot(projectId);
    const context = await this.ragEngine.buildContext(snapshot);
    await this.store.saveRagContext(context);
    await this.moveProject(projectId, ResearchLoopStep.BuildRagContext);
    await this.record(projectId, ResearchLoopStep.BuildRagContext, "Data Flow", "Vector RAG context가 저장된 chunk와 citation으로 구성되었습니다.");
    return context;
  }

  async deriveResult(projectId: string, forceStop = false): Promise<EvidenceBasedResult> {
    const snapshot = await this.store.getSnapshot(projectId);
    const iteration = Math.max(snapshot.openCodeRuns.length, 1);
    const result =
      (await this.tryLlmResult(snapshot, iteration, forceStop)) ??
      this.buildFallbackResult(snapshot, iteration, forceStop);

    await this.store.saveResult(result);
    await this.applyHypothesisUpdates(projectId, result);
    await this.moveProject(projectId, ResearchLoopStep.DeriveEvidenceBasedResult);
    await this.record(
      projectId,
      ResearchLoopStep.DeriveEvidenceBasedResult,
      "Agent Control",
      this.llm.name === "noop"
        ? "RAG 근거와 citation을 기준으로 결과와 다음 루프 필요성을 평가했습니다."
        : `${this.llm.name}로 근거 기반 결과가 도출되었습니다.`
    );
    return result;
  }

  async finalizeReport(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    if (snapshot.project.status === "paused" || snapshot.project.status === "aborted") {
      return snapshot;
    }
    const database = await this.requireDatabase(projectId);
    const report = buildResearchReport(snapshot);
    const files = await this.projectStorage.writeReportFiles(
      snapshot.project,
      database,
      report,
      report.markdown ?? report.comprehensiveReport,
      report.reusableKnowledgeAsset
    );
    await this.store.saveReport({ ...report, ...files });
    await this.moveProject(projectId, ResearchLoopStep.FinalizeResearchOutputs, "completed");
    await this.record(projectId, ResearchLoopStep.FinalizeResearchOutputs, "Main Flow", "최종 연구 보고서와 재사용 가능한 지식 자산이 생성되었습니다.");
    return this.store.getSnapshot(projectId);
  }

  private async completeChatReply(
    snapshot: ResearchSnapshot,
    session: ResearchSession,
    message: string
  ): Promise<string> {
    const latestContext = snapshot.ragContexts.at(-1);
    const response = await this.llm.completeJson<ChatReplyResponse>({
      schemaName: "AetherOpsChatReply",
      system: [
        "You are the AetherOps research chat agent inside a project-based research workspace.",
        "Answer the user's chat message directly and helpfully in Korean.",
        "Use the project goal, stored conversation, evidence, artifacts, and RAG context when they are relevant.",
        "Do not invent paper citations, URLs, DOI values, or experimental results.",
        "If evidence is weak or unavailable, say that plainly and suggest the next concrete research action.",
        "Return only JSON matching: {\"answer\": string, \"citations\": string[], \"limitations\": string[], \"nextActions\": string[]}."
      ].join("\n"),
      user: [
        `Project topic: ${snapshot.project.topic}`,
        `Project goal: ${snapshot.project.goal}`,
        `Project scope: ${snapshot.project.scope}`,
        `Chat session: ${session.title} - ${session.focus}`,
        `Recent chat transcript:\n${buildChatTranscript(snapshot, session.id)}`,
        `Latest RAG context:\n${latestContext?.contextText ?? latestContext?.summary ?? "No RAG context yet."}`,
        `Evidence summary: ${JSON.stringify(snapshot.evidence.slice(-8).map((item) => ({
          title: item.title,
          summary: item.summary,
          citation: item.citation,
          sourceUri: item.sourceUri,
          reliabilityScore: item.reliabilityScore,
          limitations: item.limitations
        })))}`,
        `User message: ${message}`
      ].join("\n\n"),
      timeoutMs: 180_000
    });

    const answer = cleanText(response.answer);
    if (!answer) {
      throw new Error("LLM 응답에 answer 필드가 없습니다.");
    }

    const citations = cleanStringArray(response.citations);
    const limitations = cleanStringArray(response.limitations);
    const nextActions = cleanStringArray(response.nextActions);
    return [
      answer,
      citations.length ? `\n근거/출처\n${citations.map((item) => `- ${item}`).join("\n")}` : "",
      limitations.length ? `\n한계\n${limitations.map((item) => `- ${item}`).join("\n")}` : "",
      nextActions.length ? `\n다음 작업\n${nextActions.map((item) => `- ${item}`).join("\n")}` : ""
    ]
      .filter(Boolean)
      .join("\n");
  }

  private buildFallbackResult(
    snapshot: ResearchSnapshot,
    iteration: number,
    forceStop: boolean
  ): EvidenceBasedResult {
    const ragContext = snapshot.ragContexts.at(-1);
    const evidenceWithCitations = snapshot.evidence.filter((item) => item.citation || item.sourceUri || item.sourceId);
    const hasGaps = snapshot.evidence.some((item) => item.keywords.includes("evidence_gap") || item.keywords.includes("tool_unavailable"));
    const shouldContinue =
      !forceStop &&
      iteration < snapshot.project.autonomyPolicy.maxLoopIterations &&
      (hasGaps || snapshot.hypotheses.some((hypothesis) => hypothesis.status !== "supported"));

    return {
      id: createId("result"),
      projectId: snapshot.project.id,
      iteration,
      answer: [
        `${snapshot.project.topic} iteration ${iteration} 결과입니다.`,
        `현재 근거 ${snapshot.evidence.length}개 중 citation/source 추적 가능한 항목은 ${evidenceWithCitations.length}개입니다.`,
        ragContext?.contextText ? "최신 RAG context를 기준으로 가설 검증을 업데이트했습니다." : "RAG context가 부족해 결론 신뢰도는 제한적입니다.",
        hasGaps ? "도구 또는 외부 근거 공백이 있어 결론은 제한적으로 해석해야 합니다." : "명시된 근거 범위 안에서는 추가 분석 필요성이 낮아졌습니다."
      ].join(" "),
      hypothesisUpdates: snapshot.hypotheses.map((hypothesis) => ({
        hypothesisId: hypothesis.id,
        status: shouldContinue ? "needs_more_evidence" : evidenceWithCitations.length ? "supported" : "needs_more_evidence",
        confidence: shouldContinue ? Math.min(hypothesis.confidence + 0.1, 0.7) : evidenceWithCitations.length ? 0.75 : 0.45,
        rationale: shouldContinue
          ? "RAG context 또는 외부 근거 공백이 남아 추가 루프가 필요합니다."
          : "최종 허용 반복 안에서 확보된 evidence와 artifact를 기준으로 제한적 판단을 내렸습니다."
      })),
      quantitativeResults: [
        `Evidence items: ${snapshot.evidence.length}`,
        `Traceable evidence: ${evidenceWithCitations.length}`,
        `Artifacts: ${snapshot.artifacts.length}`,
        `RAG chunks: ${snapshot.chunks.length}`,
        `Tool runs: ${snapshot.toolRuns.length}`
      ],
      qualitativeResults: [
        ragContext?.summary ?? "RAG context summary is unavailable.",
        hasGaps ? "검색/API/OpenCode 사용 불가 항목은 evidence_gap으로 보존되었습니다." : "도구 실행 결과가 근거와 산출물로 연결되었습니다."
      ],
      nextQuestions: shouldContinue
        ? [
            "citation/sourceUri가 있는 외부 근거를 추가로 확보할 수 있는가?",
            "가설별로 어떤 측정 지표나 산출물이 결론 신뢰도를 높이는가?"
          ]
        : [],
      needsMoreEvidence: shouldContinue,
      needsMoreAnalysis: shouldContinue,
      createdAt: nowIso()
    };
  }

  private async ensureInitialized(projectId: string): Promise<void> {
    let snapshot = await this.store.getSnapshot(projectId);
    if (!snapshot.sessions.length) {
      snapshot = await this.createSubSessions(projectId);
    }
    if (!snapshot.database) {
      snapshot = await this.createResearchDb(projectId);
    }
    if (!snapshot.questions.length || !snapshot.hypotheses.length) {
      await this.seedQuestions(projectId);
    }
  }

  private async ingestSourcesAndArtifacts(projectId: string): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    const database = await this.requireDatabase(projectId);
    const existingSourceIds = new Set(snapshot.sources.map((item) => item.id));
    const sources: ResearchSource[] = [];
    const evidenceUpdates: EvidenceItem[] = [];

    for (const evidence of snapshot.evidence) {
      const sourceId = evidence.sourceId ?? `source_${evidence.id}`;
      if (!evidence.sourceId) {
        evidenceUpdates.push({ ...evidence, sourceId });
      }
      if (!existingSourceIds.has(sourceId)) {
        sources.push(sourceFromEvidence(evidence, sourceId));
      }
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

    if (evidenceUpdates.length) {
      await this.store.saveEvidence(evidenceUpdates);
    }

    const savedSources = sources.length ? await this.projectStorage.writeSources(snapshot.project, database, sources) : [];
    if (savedSources.length) {
      await this.store.saveSources(savedSources);
    }

    const latest = await this.store.getSnapshot(projectId);
    const existingChunkIds = new Set(latest.chunks.map((item) => item.id));
    const chunks: ResearchChunk[] = [];
    for (const source of latest.sources) {
      for (const chunk of chunkResearchSource(source, buildSourceText(source, latest))) {
        if (!existingChunkIds.has(chunk.id)) {
          chunks.push({
            ...chunk,
            embedding: await this.embeddingProvider.embed(chunk.text)
          });
        }
      }
    }

    if (chunks.length) {
      await this.projectStorage.writeChunks(latest.project, database, chunks);
      await this.store.saveChunks(chunks);
      await this.record(projectId, ResearchLoopStep.StoreResults, "Data Flow", `자료 ${savedSources.length}개와 RAG chunk ${chunks.length}개가 ingest되었습니다.`);
    }
  }

  private shouldStop(
    snapshot: ResearchSnapshot,
    result: EvidenceBasedResult,
    beforeCounts: { evidence: number; artifacts: number },
    iteration: number,
    maxIterations: number
  ): boolean {
    if (snapshot.project.status === "aborted") {
      return true;
    }
    if (iteration >= maxIterations) {
      return true;
    }
    if (!result.needsMoreEvidence && !result.needsMoreAnalysis && result.nextQuestions.length === 0) {
      return true;
    }
    const newEvidence = snapshot.evidence.length - beforeCounts.evidence;
    const newArtifacts = snapshot.artifacts.length - beforeCounts.artifacts;
    return iteration > 1 && newEvidence <= 0 && newArtifacts <= 0;
  }

  private async checkAbortOrPause(projectId: string): Promise<"running" | "paused" | "aborted" | "failed"> {
    const status = (await this.store.getSnapshot(projectId)).project.status;
    if (status === "paused" || status === "aborted" || status === "failed") {
      return status;
    }
    return "running";
  }

  private async requireDatabase(projectId: string): Promise<ResearchDatabase> {
    const snapshot = await this.store.getSnapshot(projectId);
    if (snapshot.database) {
      return snapshot.database;
    }
    const next = await this.createResearchDb(projectId);
    if (!next.database) {
      throw new Error("Research database was not created.");
    }
    return next.database;
  }

  private async tryLlmSeed(project: ResearchProject): Promise<SeedPlan | undefined> {
    try {
      const plan = await generateSeedPlanWithLlm(this.llm, project);
      if (plan?.questions.length && plan.hypotheses.length) {
        return plan;
      }
      return undefined;
    } catch (error) {
      console.warn(`LLM seed generation failed, falling back: ${formatError(error)}`);
      return undefined;
    }
  }

  private async tryLlmResult(
    snapshot: ResearchSnapshot,
    iteration: number,
    forceStop: boolean
  ): Promise<EvidenceBasedResult | undefined> {
    try {
      const result = await deriveResultWithLlm(this.llm, snapshot, iteration, forceStop);
      if (result?.answer) {
        return result;
      }
      return undefined;
    } catch (error) {
      console.warn(`LLM result derivation failed, falling back: ${formatError(error)}`);
      return undefined;
    }
  }

  private async applyHypothesisUpdates(projectId: string, result: EvidenceBasedResult): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    const updates = new Map(result.hypothesisUpdates.map((item) => [item.hypothesisId, item]));
    await this.store.saveHypotheses(
      snapshot.hypotheses.map((hypothesis) => {
        const update = updates.get(hypothesis.id);
        return update
          ? {
              ...hypothesis,
              status: update.status,
              confidence: update.confidence
            }
          : hypothesis;
      })
    );
  }

  private async setStatus(projectId: string, status: ResearchProject["status"]): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    await this.store.updateProject({ ...snapshot.project, status, updatedAt: nowIso() });
    await this.syncProjectState(projectId);
  }

  private async moveProject(
    projectId: string,
    currentStep: ResearchLoopStep,
    status?: ResearchProject["status"]
  ): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    await this.store.updateProject({
      ...snapshot.project,
      currentStep,
      status: status ?? snapshot.project.status,
      updatedAt: nowIso()
    });
    await this.syncProjectState(projectId);
  }

  private async record(
    projectId: string,
    step: ResearchLoopStep,
    flowKind: FlowKind,
    message: string
  ): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    const iteration: LoopIteration = {
      id: createId("iteration"),
      projectId,
      iteration: Math.max(snapshot.openCodeRuns.length, 0),
      step,
      flowKind,
      message,
      createdAt: nowIso()
    };
    await this.store.saveIteration(iteration);
    await this.syncProjectState(projectId);
  }

  private async syncProjectState(projectId: string): Promise<void> {
    try {
      await this.projectStorage.writeProjectState(await this.store.getSnapshot(projectId));
    } catch (error) {
      console.warn(`Project state file sync failed: ${formatError(error)}`);
    }
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
  if (evidence.category === "web_source") {
    return "web";
  }
  if (evidence.category === "paper_reference") {
    return "paper";
  }
  if (evidence.category === "generated_artifact") {
    return "artifact";
  }
  if (evidence.category === "conversation_memo") {
    return "conversation";
  }
  return "log";
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
    .filter((artifact) => artifact.category === "conversation_memo" && isChatArtifactForSession(artifact, sessionId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-12);
  if (!messages.length) {
    return "No stored chat messages yet.";
  }
  return messages
    .map((artifact) => {
      const role = artifact.relativePath.endsWith("-assistant.md") || artifact.title.endsWith("응답") ? "assistant" : "user";
      return `${role}: ${artifact.content ?? artifact.summary}`;
    })
    .join("\n\n");
}

function isChatArtifactForSession(artifact: ResearchArtifact, sessionId: string): boolean {
  return artifact.relativePath.replace(/\\/g, "/").includes(`/chat/${sessionId}-`);
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
