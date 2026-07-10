import { createId, nowIso } from "../shared/ids.js";
import { RuntimeRequirementError } from "../tools/runtimeRequirements.js";
import { activeResearchContext, activeResearchSnapshot, activeResearchSpecification, idSet, isPlanCurrentForActiveResearch } from "./researchState.js";
import { nextExecutionIteration } from "./loopStateMachine.js";
import { collectExecutableToolNames, collectPlanToolRequirements, normalizedToolNameSet, stepRequiresOpenCode } from "./toolExecutionPlan.js";
import {
  ResearchLoopStep,
  type AppSettings,
  type EvidenceItem,
  type ResearchDatabase,
  type ResearchPlan,
  type ResearchSnapshot,
  type ResearchSource,
  type ResearchSpecification,
  type RuntimeBlocker
} from "../shared/types.js";
import { AnalysisOrchestrator } from "./analysisOrchestrator.js";
import { sourceFromEvidence } from "./orchestratorResultHelpers.js";
export abstract class OrchestratorPreconditions extends AnalysisOrchestrator {
  protected async ensureResearchDb(projectId: string): Promise<ResearchSnapshot> {
    let snapshot = await this.store.getSnapshot(projectId);
    if (!snapshot.database) snapshot = await this.createResearchDb(projectId);
    if (!snapshot.sessions.length) snapshot = await this.createSubSessions(projectId);
    return snapshot;
  }

  protected async ensureResearchInput(projectId: string): Promise<ResearchSnapshot> {
    let snapshot = await this.store.getSnapshot(projectId);
    const activeContext = activeResearchContext(snapshot);
    if (!activeContext.questions.length || !activeContext.hypotheses.length) snapshot = await this.inputResearchQuestionHypothesis(projectId);
    return snapshot;
  }

  protected async ensureResearchSpecification(projectId: string): Promise<ResearchSnapshot> {
    let snapshot = await this.store.getSnapshot(projectId);
    if (!activeResearchSpecification(snapshot)) snapshot = await this.buildResearchSpecification(projectId);
    return snapshot;
  }

  protected async ensureResearchPlan(projectId: string, iteration?: number): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const activeSnapshot = activeResearchSnapshot(snapshot);
    const activeIteration = iteration ?? nextExecutionIteration(activeSnapshot);
    const specification = activeResearchSpecification(snapshot);
    const plan = activeSnapshot.researchPlans.find(
      (item) => item.iteration === activeIteration && isPlanCurrentForActiveResearch(item, activeSnapshot, specification)
    );
    return plan ? snapshot : this.planResearch(projectId, activeIteration);
  }

  protected async ensureSpecification(projectId: string): Promise<ResearchSpecification> {
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

  protected async ingestSources(projectId: string): Promise<void> {
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

  protected async checkAbortOrPause(projectId: string): Promise<"running" | "paused" | "aborted" | "failed" | "blocked"> {
    const status = (await this.store.getSnapshot(projectId)).project.status;
    if (status === "paused" || status === "aborted" || status === "failed" || status === "blocked") return status;
    return "running";
  }

  protected async requireDatabase(projectId: string): Promise<ResearchDatabase> {
    const snapshot = await this.store.getSnapshot(projectId);
    if (snapshot.database) return snapshot.database;
    const next = await this.createResearchDb(projectId);
    if (!next.database) throw new Error("Research database was not created.");
    return next.database;
  }

  protected async assertStepReady(
    projectId: string,
    step: ResearchLoopStep,
    options: { checkOpenCodePreflight?: boolean; storageWritable?: boolean } = {}
  ): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    const settings = await this.getSettings();
    let openCodeReady: boolean | undefined;
    if (options.checkOpenCodePreflight && stepRequiresOpenCode(step, snapshot)) {
      try {
        await this.preflightExecutionEngine(projectId);
        openCodeReady = true;
      } catch {
        openCodeReady = false;
      }
    }
    this.requirements.assertStepReady(step, {
      snapshot,
      settings,
      llmAvailable: this.llm ? await this.llm.isAvailable() : false,
      openCodeReady,
      storageWritable: options.storageWritable,
      registeredToolNames: this.registeredToolNames()
    });
  }

  protected registeredToolNames(): string[] {
    return this.toolRunner?.listRegisteredToolNames?.() ?? this.toolRunner?.listToolNames() ?? [];
  }

  protected executableToolNames(snapshot: ResearchSnapshot, settings: AppSettings): string[] {
    const tools = this.toolRunner?.listExecutableToolNames?.({ snapshot, settings }) ?? this.registeredToolNames();
    return collectExecutableToolNames(tools, settings.openCode.enabled && Boolean(settings.openCode.command?.trim()));
  }

  protected assertPlanToolsAllowed(plan: ResearchPlan, allowedTools: string[]): void {
    const allowed = normalizedToolNameSet(allowedTools);
    const registered = normalizedToolNameSet(this.registeredToolNames());
    const unmet = collectPlanToolRequirements(plan.requiredTools, registered, allowed);
    if (unmet.length) {
      throw new RuntimeRequirementError(ResearchLoopStep.PlanResearch, unmet);
    }
  }

  protected async blockProject(projectId: string, error: RuntimeRequirementError): Promise<ResearchSnapshot> {
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
    await this.record(projectId, error.step, "Error Flow", `필수 실행 조건이 충족되지 않아 연구가 blocked 상태로 전환되었습니다. ${error.message}`);
    await this.writeRunAudit(projectId, error.step, error.message);
    return this.store.getSnapshot(projectId);
  }
}
