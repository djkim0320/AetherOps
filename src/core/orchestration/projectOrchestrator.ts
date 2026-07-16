import { createId, nowIso } from "../shared/ids.js";
import { buildResearchInputPayloadFromBrief, createResearchInput, type ResearchInputPayload } from "../input/researchInput.js";
import { createDefaultSessions } from "../input/researchSeed.js";
import { RuntimeRequirementError } from "../tools/runtimeRequirements.js";
import type { ToolExecutionContext } from "../tools/researchToolTypes.js";
import { countChatSessions, summarize } from "./chatProgress.js";
import { activeResearchContext, activeResearchSnapshot, researchInputMatchesPayload } from "./researchState.js";
import { nextIteration } from "./loopStateMachine.js";
import {
  ResearchLoopStep,
  type ContinuationDecision,
  type ResearchProjectInput,
  type ResearchArtifact,
  type ResearchProject,
  type ResearchSession,
  type ResearchSnapshot
} from "../shared/types.js";
import { OrchestratorRuntime } from "./orchestratorRuntime.js";
import { slugify } from "./orchestratorResultHelpers.js";
import { settingsWithProjectArtifactRoot } from "./projectArtifactSettings.js";
export abstract class ProjectOrchestrator extends OrchestratorRuntime {
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
    await this.record(projectId, snapshot.project.currentStep, "Main Flow", "프로젝트 연구 메타데이터를 최신 입력으로 저장했습니다.");
    return this.store.getSnapshot(projectId);
  }

  async createProject(input: ResearchProjectInput): Promise<ResearchSnapshot> {
    const createdAt = nowIso();
    const projectId = createId("project");
    const shortProjectId = projectId
      .replace(/^project[_-]/, "")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 12);
    const project: ResearchProject = {
      ...input,
      id: projectId,
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.CreateResearchDb,
      status: "idle",
      projectRoot: `${this.projectRootBase}/${slugify(input.topic)}-${createdAt.slice(0, 10)}-${shortProjectId}`
    };
    await this.store.saveProject(project);
    await this.record(project.id, ResearchLoopStep.CreateResearchDb, "Main Flow", "연구 프로젝트가 생성되었고 연구 DB 생성을 기다립니다.");
    return this.store.getSnapshot(project.id);
  }

  async createSubSessions(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    if (!snapshot.sessions.length) {
      await this.store.saveSessions(createDefaultSessions(snapshot.project));
      await this.record(projectId, snapshot.project.currentStep, "Main Flow", "기본 채팅 세션을 생성했습니다.");
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
    await this.record(projectId, snapshot.project.currentStep, "Main Flow", `${session.title} 세션을 생성했습니다.`);
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

  async sendChatMessage(projectId: string, sessionId: string, content: string, execution?: ToolExecutionContext): Promise<ResearchSnapshot> {
    const message = content.trim();
    if (!message) {
      throw new Error("메시지가 비어 있습니다.");
    }

    const snapshot = await this.store.getSnapshot(projectId);
    const session = snapshot.sessions.find((item) => item.id === sessionId);
    if (!session) {
      throw new Error("채팅 세션을 찾을 수 없습니다.");
    }

    const database = await this.requireDatabase(projectId);
    const iteration = Math.max(snapshot.legacyAgentRuns.length, 1);
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
    await this.record(projectId, snapshot.project.currentStep, "Main Flow", `${session.title} 사용자 메시지를 저장했습니다.`);

    if (!this.llm || !(await this.llm.isAvailable())) {
      throw new Error("활성 채팅 LLM을 사용할 수 없습니다. 설정에서 Codex OAuth 연결을 확인하세요.");
    }

    const latest = await this.store.getSnapshot(projectId);
    const reply = await this.completeChatReply(latest, session, message, execution);
    const assistantArtifact: ResearchArtifact = {
      id: createId("artifact"),
      projectId,
      category: "conversation_memo",
      title: `${session.title} LLM 응답`,
      relativePath: `artifacts/chat/${session.id}-${Date.now()}-assistant.md`,
      mimeType: "text/markdown",
      summary: summarize(reply),
      content: reply,
      createdAt: nowIso()
    };
    const [writtenAssistantArtifact] = await this.projectStorage.writeArtifacts(snapshot.project, database, iteration, [assistantArtifact]);
    await this.store.saveArtifacts([writtenAssistantArtifact]);
    await this.record(projectId, snapshot.project.currentStep, "Agent Control", `${session.title} LLM 응답을 저장했습니다.`);
    return this.store.getSnapshot(projectId);
  }

  async createResearchDb(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const database = await this.projectStorage.ensureResearchDb(snapshot.project);
    await this.store.saveDatabase(database);
    await this.moveProject(projectId, ResearchLoopStep.CreateResearchDb);
    await this.record(projectId, ResearchLoopStep.CreateResearchDb, "Storage Flow", "프로젝트 research/vector/ontology DB와 디렉터리 경계를 생성했습니다.");
    return this.store.getSnapshot(projectId);
  }

  async inputResearchQuestionHypothesis(projectId: string, payload?: ResearchInputPayload): Promise<ResearchSnapshot> {
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const resolvedPayload = buildResearchInputPayloadFromBrief(snapshot.project, payload ?? {});
    const activeContext = activeResearchContext(snapshot);
    if (
      !activeContext.input ||
      !researchInputMatchesPayload(activeContext.input, resolvedPayload) ||
      !activeContext.questions.length ||
      !activeContext.hypotheses.length
    ) {
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
    await this.record(projectId, ResearchLoopStep.InputResearchQuestionHypothesis, "Main Flow", "연구 질문과 가설 입력을 저장했습니다.");
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
    await this.record(projectId, ResearchLoopStep.BuildResearchSpecification, "Agent Control", "연구 명세와 평가 기준을 생성했습니다.");
    return this.store.getSnapshot(projectId);
  }

  async planResearch(projectId: string, iteration?: number, decision?: ContinuationDecision, execution?: ToolExecutionContext): Promise<ResearchSnapshot> {
    try {
      await this.assertStepReady(projectId, ResearchLoopStep.PlanResearch);
      const snapshot = await this.store.getSnapshot(projectId);
      const specification = await this.ensureSpecification(projectId);
      const activeSnapshot = activeResearchSnapshot(snapshot);
      const settings = settingsWithProjectArtifactRoot(await this.getSettings(), activeSnapshot.project);
      const executableTools = this.executableToolNames(activeSnapshot, settings, execution?.toolPolicy);
      const effectiveCapabilities = execution?.authorizeAction
        ? await execution.authorizeAction({ name: "research-planner", requiredCapabilities: ["agent"], inputs: {} })
        : execution?.effectiveCapabilities;
      await this.moveProject(projectId, ResearchLoopStep.PlanResearch);
      const plan = await this.planner.plan({
        snapshot: activeResearchSnapshot(await this.store.getSnapshot(projectId)),
        specification,
        iteration: iteration ?? nextIteration(activeSnapshot),
        settings,
        availableTools: executableTools,
        continuationDecision: decision ?? activeSnapshot.continuationDecisions.at(-1),
        toolPolicy: execution?.toolPolicy,
        effectiveCapabilities,
        runtimeToolDiagnostics: this.runtimeDiagnostics(settings, activeSnapshot.project),
        onLlmInvocationRunning: execution?.onLlmInvocationRunning,
        onLlmInvocation: execution?.onLlmInvocation,
        compilePlannerContext: execution?.compilePlannerContext
      });
      this.assertPlanToolsAllowed(plan, executableTools);
      await this.store.saveResearchPlan({
        ...plan,
        sourceResearchInputId: activeSnapshot.researchInputs.at(-1)?.id,
        sourceSpecificationId: specification.id
      });
      await this.moveProject(projectId, ResearchLoopStep.PlanResearch);
      await this.record(projectId, ResearchLoopStep.PlanResearch, "Agent Control", `Iteration ${plan.iteration} 연구 계획을 생성했습니다.`);
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
}
