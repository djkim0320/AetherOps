import { createId } from "../shared/ids.js";
import { dedupeSourcesByIdUrlDoi } from "../evidence/sourceDedupe.js";
import type { ResearchToolResult } from "../tools/researchToolTypes.js";
import { ToolRunnerError } from "../tools/toolRunner.js";
import { RuntimeRequirementError } from "../tools/runtimeRequirements.js";
import type { ToolExecutionContext } from "../tools/researchToolTypes.js";
import { withArtifactBundle, withEvidenceBundle, withSourceBundle, withToolRunBundle } from "./executionBundles.js";
import { activeResearchSnapshot } from "./researchState.js";
import { nextExecutionIteration } from "./loopStateMachine.js";
import { planRequiresTool } from "./toolExecutionPlan.js";
import {
  ResearchLoopStep,
  type EvidenceItem,
  type ResearchToolInput,
  type ResearchArtifact,
  type ResearchDatabase,
  type ResearchProject,
  type ResearchSnapshot,
  type ResearchSource,
  type ToolRun
} from "../shared/types.js";
import { LoopControlOrchestrator } from "./loopControlOrchestrator.js";
import { formatError } from "./orchestratorResultHelpers.js";
import { settingsWithProjectArtifactRoot } from "./projectArtifactSettings.js";
export abstract class ExecutionOrchestrator extends LoopControlOrchestrator {
  async executeTools(projectId: string, iteration?: number, execution?: ToolExecutionContext): Promise<ResearchSnapshot> {
    await this.assertStepReady(projectId, ResearchLoopStep.ExecuteTools, { checkCodexCliPreflight: true });
    const storedSnapshot = await this.store.getSnapshot(projectId);
    const snapshot = activeResearchSnapshot(storedSnapshot);
    const activeIteration = iteration ?? nextExecutionIteration(snapshot);
    await this.moveProject(projectId, ResearchLoopStep.ExecuteTools);
    await this.record(projectId, ResearchLoopStep.ExecuteTools, "Agent Control", `Iteration ${activeIteration} 도구 실행을 시작합니다.`);
    const researchPlan = snapshot.researchPlans.at(-1);
    const projectContextSnapshot = snapshot.projectContextSnapshots.at(-1);
    const shouldRunCodexCli = planRequiresTool(researchPlan, "CodexCliTool");
    if (shouldRunCodexCli && execution?.allowCodexCli === false) {
      await this.failProject(projectId, ResearchLoopStep.ExecuteTools, new Error("CodexCliTool was selected without explicit job authorization."));
      return this.store.getSnapshot(projectId);
    }
    const runInput: ResearchToolInput = {
      project: snapshot.project,
      questions: snapshot.questions,
      hypotheses: snapshot.hypotheses,
      evidence: snapshot.evidence,
      artifacts: snapshot.artifacts,
      sources: dedupeSourcesByIdUrlDoi(snapshot.sources),
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
      const settings = settingsWithProjectArtifactRoot(await this.getSettings(), snapshot.project);
      if (!this.toolRunner) throw new Error("Autonomous tool execution requires a configured ToolRunner.");
      const toolResults = await this.toolRunner.execute(runInput, settings, {
        execution: executionSegment(execution, "dag")
      });
      await this.persistToolResults(snapshot.project, database, activeIteration, toolResults);
      await this.ingestSources(projectId);
      await this.record(projectId, ResearchLoopStep.ExecuteTools, "Agent Control", "도구 실행 결과를 프로젝트 저장소에 기록했습니다.");
      await execution?.onCheckpoint?.(ResearchLoopStep.ExecuteTools);
    } catch (error) {
      if (execution?.signal?.aborted) return this.store.getSnapshot(projectId);
      const requirementError =
        error instanceof RuntimeRequirementError
          ? error
          : error instanceof ToolRunnerError && error.failure instanceof RuntimeRequirementError
            ? error.failure
            : undefined;
      if (requirementError) return this.blockProject(projectId, requirementError);
      await this.failProject(projectId, ResearchLoopStep.ExecuteTools, error);
      return this.store.getSnapshot(projectId);
    }
    return this.store.getSnapshot(projectId);
  }

  protected async persistToolResults(
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

  protected async preflightExecutionEngine(projectId: string): Promise<void> {
    if (!this.codexCli.preflight) {
      return;
    }
    try {
      await this.codexCli.preflight();
    } catch (error) {
      await this.moveProject(projectId, ResearchLoopStep.ExecuteTools);
      throw new Error(`Codex CLI preflight failed: ${formatError(error)}`, { cause: error });
    }
  }
}

function executionSegment(execution: ToolExecutionContext | undefined, segment: string): ToolExecutionContext | undefined {
  if (!execution) return undefined;
  return {
    ...execution,
    executionId: execution.executionId ? `${execution.executionId}-${segment}` : undefined,
    idempotencyKey: execution.idempotencyKey ? `${execution.idempotencyKey}:${segment}` : undefined
  };
}
