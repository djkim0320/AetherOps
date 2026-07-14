import { RuntimeRequirementError } from "../tools/runtimeRequirements.js";
import { activeResearchSnapshot, counts } from "./researchState.js";
import { nextExecutionIteration, resolveSafetyCapIterations } from "./loopStateMachine.js";
import type { ResearchSnapshot } from "../shared/types.js";
import type { ToolExecutionContext } from "../tools/researchToolTypes.js";
import { ProjectOrchestrator } from "./projectOrchestrator.js";
export abstract class LoopControlOrchestrator extends ProjectOrchestrator {
  async startLoop(projectId: string, execution?: ToolExecutionContext): Promise<ResearchSnapshot> {
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
      let resumeAfterExecuteTools = execution?.resumeCheckpointStep === "EXECUTE_TOOLS";
      for (let iteration = firstIteration; iteration <= safetyCapIterations; iteration += 1) {
        execution?.signal?.throwIfAborted();
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        const beforeCounts = counts(activeResearchSnapshot(await this.store.getSnapshot(projectId)));

        await this.ensureResearchPlan(projectId, iteration, execution);
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        if (resumeAfterExecuteTools) resumeAfterExecuteTools = false;
        else {
          await this.executeTools(projectId, iteration, execution);
          execution?.signal?.throwIfAborted();
        }
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        await this.normalizeData(projectId, iteration);
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        await this.buildVectorIndex(projectId);
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        await this.buildOntologyGraph(projectId);
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        await this.reasonAndValidate(projectId, iteration);
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        const result = await this.synthesizeAndEvaluate(projectId, iteration, iteration >= safetyCapIterations, execution);
        const decision = await this.decideContinuation(projectId, result, beforeCounts, iteration, safetyCapIterations);
        if (!decision.shouldContinue) {
          break;
        }
        if ((await this.checkAbortOrPause(projectId)) !== "running") return this.store.getSnapshot(projectId);
        await this.planResearch(projectId, iteration + 1, decision, execution);
      }

      if ((await this.checkAbortOrPause(projectId)) !== "running") {
        return this.store.getSnapshot(projectId);
      }
      return await this.finalizeOutputs(projectId);
    } catch (error) {
      if (execution?.signal?.aborted) return this.store.getSnapshot(projectId);
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
    await this.record(projectId, (await this.store.getSnapshot(projectId)).project.currentStep, "Agent Control", "연구 루프가 일시 정지되었습니다.");
    return this.store.getSnapshot(projectId);
  }

  async resume(projectId: string, execution?: ToolExecutionContext): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    if (!isResumableProjectStatus(snapshot.project.status)) {
      throw new Error(`Research loop cannot resume from project status: ${snapshot.project.status}`);
    }
    if (snapshot.project.status !== "running") await this.setStatus(projectId, "running");
    await this.record(projectId, snapshot.project.currentStep, "Agent Control", "연구 루프를 재개합니다.");
    return this.startLoop(projectId, execution);
  }

  async abort(projectId: string): Promise<ResearchSnapshot> {
    await this.setStatus(projectId, "aborted");
    await this.record(projectId, (await this.store.getSnapshot(projectId)).project.currentStep, "Agent Control", "연구 루프가 중단되었습니다.");
    return this.store.getSnapshot(projectId);
  }
}

function isResumableProjectStatus(status: ResearchSnapshot["project"]["status"]): boolean {
  return status === "paused" || status === "blocked" || status === "failed" || status === "running";
}
