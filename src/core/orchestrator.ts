import { createId, nowIso } from "./ids.js";
import { NoopLlmProvider, type LlmProvider } from "./llm.js";
import { deriveResultWithLlm, generateSeedPlanWithLlm } from "./llmPlanning.js";
import { MockOpenCodeAdapter } from "./mockOpenCodeAdapter.js";
import { buildResearchReport } from "./report.js";
import { createDefaultSessions, seedResearchPlan } from "./researchSeed.js";
import { SimpleRagEngine } from "./simpleRagEngine.js";
import { nextResearchLoopStep } from "./stateMachine.js";
import {
  ResearchLoopStep,
  type CreateProjectInput,
  type EvidenceBasedResult,
  type FlowKind,
  type LoopIteration,
  type OpenCodeAdapter,
  type RagContext,
  type RagEngine,
  type ResearchArtifact,
  type ResearchDatabase,
  type ResearchProject,
  type ResearchSnapshot,
  type ResearchStore
} from "./types.js";

type SeedPlan = ReturnType<typeof seedResearchPlan>;

export class AetherOpsOrchestrator {
  constructor(
    private readonly store: ResearchStore,
    private readonly openCode: OpenCodeAdapter = new MockOpenCodeAdapter(),
    private readonly ragEngine: RagEngine = new SimpleRagEngine(),
    private readonly projectRootBase = ".aetherops/projects",
    private readonly llm: LlmProvider = new NoopLlmProvider()
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
      projectRoot: `${this.projectRootBase}/${input.topic.replace(/\W+/g, "-").toLowerCase()}-${createdAt.slice(0, 10)}`
    };
    await this.store.saveProject(project);
    await this.record(project.id, ResearchLoopStep.CreateProject, "Main Flow", "Research project created.");
    return this.store.getSnapshot(project.id);
  }

  async createSubSessions(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const sessions = createDefaultSessions(snapshot.project);
    await this.store.saveSessions(sessions);
    await this.moveProject(projectId, ResearchLoopStep.CreateSubSessions);
    await this.record(projectId, ResearchLoopStep.CreateSubSessions, "Main Flow", "Topic-specific sub sessions created.");
    return this.store.getSnapshot(projectId);
  }

  async createResearchDb(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const database: ResearchDatabase = {
      id: createId("db"),
      projectId,
      sqlitePath: `${snapshot.project.projectRoot}/research.sqlite`,
      vectorPath: `${snapshot.project.projectRoot}/vector`,
      artifactRoot: `${snapshot.project.projectRoot}/artifacts`,
      createdAt: nowIso()
    };
    await this.store.saveDatabase(database);
    await this.moveProject(projectId, ResearchLoopStep.CreateResearchDb);
    await this.record(projectId, ResearchLoopStep.CreateResearchDb, "Data Flow", "Project-isolated research DB created.");
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
        ? "Initial questions, hypotheses, and seed evidence created."
        : `Initial research plan generated through ${this.llm.name}.`
    );
    return this.store.getSnapshot(projectId);
  }

  async startLoop(projectId: string): Promise<ResearchSnapshot> {
    await this.setStatus(projectId, "running");
    await this.ensureInitialized(projectId);

    let snapshot = await this.store.getSnapshot(projectId);
    const maxIterations = snapshot.project.autonomyPolicy.maxLoopIterations;
    for (let iteration = snapshot.openCodeRuns.length + 1; iteration <= maxIterations; iteration += 1) {
      snapshot = await this.runOpenCode(projectId);
      await this.storeResults(projectId);
      await this.buildRagContext(projectId);
      const result = await this.deriveResult(projectId);
      const shouldContinue = result.needsMoreAnalysis || result.needsMoreEvidence || result.nextQuestions.length > 0;
      const nextStep = nextResearchLoopStep(ResearchLoopStep.DeriveEvidenceBasedResult, shouldContinue);
      if (nextStep === ResearchLoopStep.FinalizeResearchOutputs) {
        break;
      }
    }

    return this.finalizeReport(projectId);
  }

  async pause(projectId: string): Promise<ResearchSnapshot> {
    await this.setStatus(projectId, "paused");
    return this.store.getSnapshot(projectId);
  }

  async resume(projectId: string): Promise<ResearchSnapshot> {
    await this.setStatus(projectId, "running");
    return this.store.getSnapshot(projectId);
  }

  async abort(projectId: string): Promise<ResearchSnapshot> {
    await this.setStatus(projectId, "aborted");
    return this.store.getSnapshot(projectId);
  }

  async runOpenCode(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const iteration = snapshot.openCodeRuns.length + 1;
    const output = await this.openCode.run({
      project: snapshot.project,
      questions: snapshot.questions,
      hypotheses: snapshot.hypotheses,
      ragContext: snapshot.ragContexts.at(-1),
      iteration
    });
    await this.store.saveOpenCodeRun(output.run);
    await this.store.saveArtifacts(output.artifacts);
    await this.store.saveEvidence(output.evidence);
    await this.moveProject(projectId, ResearchLoopStep.RunOpenCode);
    await this.record(projectId, ResearchLoopStep.RunOpenCode, "Agent Control", "OpenCode execution completed.");
    return this.store.getSnapshot(projectId);
  }

  async storeResults(projectId: string): Promise<ResearchSnapshot> {
    await this.moveProject(projectId, ResearchLoopStep.StoreResults);
    await this.record(projectId, ResearchLoopStep.StoreResults, "Data Flow", "Run outputs, logs, and evidence stored.");
    return this.store.getSnapshot(projectId);
  }

  async storeArtifact(projectId: string, artifact: Partial<ResearchArtifact>): Promise<ResearchSnapshot> {
    const savedArtifact: ResearchArtifact = {
      id: artifact.id ?? createId("artifact"),
      projectId,
      category: artifact.category ?? "generated_artifact",
      title: artifact.title ?? "Manual research artifact",
      relativePath: artifact.relativePath ?? "artifacts/manual-artifact.txt",
      mimeType: artifact.mimeType ?? "text/plain",
      summary: artifact.summary ?? "User-added research artifact.",
      createdAt: artifact.createdAt ?? nowIso()
    };
    await this.store.saveArtifacts([savedArtifact]);
    await this.record(projectId, ResearchLoopStep.StoreResults, "Data Flow", `${savedArtifact.title} stored.`);
    return this.store.getSnapshot(projectId);
  }

  async buildRagContext(projectId: string): Promise<RagContext> {
    const snapshot = await this.store.getSnapshot(projectId);
    const context = await this.ragEngine.buildContext(snapshot);
    await this.store.saveRagContext(context);
    await this.moveProject(projectId, ResearchLoopStep.BuildRagContext);
    await this.record(projectId, ResearchLoopStep.BuildRagContext, "Data Flow", "RAG context built from stored evidence.");
    return context;
  }

  async deriveResult(projectId: string): Promise<EvidenceBasedResult> {
    const snapshot = await this.store.getSnapshot(projectId);
    const iteration = Math.max(snapshot.openCodeRuns.length, 1);
    const maxIterations = snapshot.project.autonomyPolicy.maxLoopIterations;
    const shouldContinue = iteration < Math.min(maxIterations, 2);
    const result =
      (await this.tryLlmResult(snapshot, iteration, iteration >= maxIterations)) ??
      this.buildFallbackResult(snapshot, iteration, shouldContinue);

    await this.store.saveResult(result);
    await this.applyHypothesisUpdates(projectId, result);
    await this.moveProject(projectId, ResearchLoopStep.DeriveEvidenceBasedResult);
    await this.record(
      projectId,
      ResearchLoopStep.DeriveEvidenceBasedResult,
      "Agent Control",
      this.llm.name === "noop"
        ? "Evidence-based result derived and next-loop condition evaluated."
        : `Evidence-based result derived through ${this.llm.name}.`
    );
    return result;
  }

  async finalizeReport(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const report = buildResearchReport(snapshot);
    await this.store.saveReport(report);
    await this.moveProject(projectId, ResearchLoopStep.FinalizeResearchOutputs, "completed");
    await this.record(projectId, ResearchLoopStep.FinalizeResearchOutputs, "Main Flow", "Final research outputs created.");
    return this.store.getSnapshot(projectId);
  }

  private buildFallbackResult(
    snapshot: ResearchSnapshot,
    iteration: number,
    shouldContinue: boolean
  ): EvidenceBasedResult {
    return {
      id: createId("result"),
      projectId: snapshot.project.id,
      iteration,
      answer: `${snapshot.project.topic} iteration ${iteration} derived an interim result from ${snapshot.evidence.length} evidence items and ${snapshot.artifacts.length} artifacts.`,
      hypothesisUpdates: snapshot.hypotheses.map((hypothesis) => ({
        hypothesisId: hypothesis.id,
        status: shouldContinue ? "needs_more_evidence" : "supported",
        confidence: shouldContinue ? Math.min(hypothesis.confidence + 0.2, 0.75) : 0.86,
        rationale: shouldContinue
          ? "More OpenCode execution and RAG retrieval are required."
          : "Accumulated evidence and execution logs support this hypothesis."
      })),
      quantitativeResults: [
        `Evidence items: ${snapshot.evidence.length}`,
        `Artifacts: ${snapshot.artifacts.length}`,
        `OpenCode runs: ${snapshot.openCodeRuns.length}`
      ],
      qualitativeResults: [
        "AetherOps linked execution logs with RAG context.",
        "The loop produced a reusable evidence bundle for future research."
      ],
      nextQuestions: shouldContinue
        ? [`What additional analysis would strengthen the evidence for ${snapshot.project.topic}?`]
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
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
