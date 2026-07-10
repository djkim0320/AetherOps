import { createId } from "../shared/ids.js";
import { dedupeSourcesByIdUrlDoi } from "../evidence/sourceDedupe.js";
import { ToolRunnerError } from "../tools/toolRunner.js";
import type { ResearchToolResult } from "../tools/researchToolTypes.js";
import {
  applyToolResultsToOpenCodeInput,
  buildExecutionBundleId,
  bundleArtifacts,
  bundleEvidence,
  bundleOpenCodeStructured,
  bundleSources,
  bundleToolRuns,
  concatItems,
  concatSourceGroups,
  copyItems,
  failedOpenCodeRun,
  genericOpenCodeRunAttempt,
  withArtifactBundle,
  withEvidenceBundle,
  withOpenCodeRunBundle,
  withSourceBundle,
  withToolRunBundle
} from "./executionBundles.js";
import { activeResearchSnapshot } from "./researchState.js";
import { nextExecutionIteration } from "./loopStateMachine.js";
import { planForExecution, planRequiresTool, preOpenCodeToolNames, sourceCandidatesFromPlan } from "./toolExecutionPlan.js";
import {
  ResearchLoopStep,
  type EvidenceItem,
  type OpenCodeRunInput,
  type OpenCodeRunOutput,
  type OpenCodeRun,
  type ResearchArtifact,
  type ResearchDatabase,
  type ResearchProject,
  type ResearchSnapshot,
  type ResearchSource,
  type ToolRun
} from "../shared/types.js";
import { LoopControlOrchestrator } from "./loopControlOrchestrator.js";
import { formatError } from "./orchestratorResultHelpers.js";
export abstract class ExecutionOrchestrator extends LoopControlOrchestrator {
  async executeTools(projectId: string, iteration?: number): Promise<ResearchSnapshot> {
    await this.assertStepReady(projectId, ResearchLoopStep.ExecuteTools, { checkOpenCodePreflight: true });
    const storedSnapshot = await this.store.getSnapshot(projectId);
    const snapshot = activeResearchSnapshot(storedSnapshot);
    const activeIteration = iteration ?? nextExecutionIteration(snapshot);
    await this.moveProject(projectId, ResearchLoopStep.ExecuteTools);
    await this.record(projectId, ResearchLoopStep.ExecuteTools, "Agent Control", `Iteration ${activeIteration} 도구 실행을 시작합니다.`);
    const storedResearchPlan = snapshot.researchPlans.at(-1);
    const researchPlan = planForExecution(storedResearchPlan, snapshot);
    if (storedResearchPlan && researchPlan && researchPlan !== storedResearchPlan) {
      await this.store.saveResearchPlan(researchPlan);
      await this.record(
        projectId,
        ResearchLoopStep.ExecuteTools,
        "Agent Control",
        "Execution plan refreshed to avoid scholarly metadata collection blocking non-literature engineering tool execution."
      );
    }
    const projectContextSnapshot = snapshot.projectContextSnapshots.at(-1);
    const continuationSources = sourceCandidatesFromPlan(projectId, activeIteration, researchPlan, projectContextSnapshot);
    const shouldRunOpenCode = planRequiresTool(researchPlan, "OpenCodeTool");
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
      if (!shouldRunOpenCode) {
        if (!this.toolRunner) {
          throw new Error("Autonomous tool execution requires a configured ToolRunner.");
        }
        let toolResults: ResearchToolResult[] = [];
        try {
          toolResults = await this.toolRunner.runAll(runInput, settings);
        } catch (toolError) {
          if (toolError instanceof ToolRunnerError) {
            const resultsToPersist = [...toolError.partialResults, ...(toolError.failedResult ? [toolError.failedResult] : [])];
            await this.persistToolResults(snapshot.project, database, activeIteration, resultsToPersist);
          }
          throw toolError;
        }
        await this.persistToolResults(snapshot.project, database, activeIteration, toolResults);
        await this.ingestSources(projectId);
        await this.record(
          projectId,
          ResearchLoopStep.ExecuteTools,
          "Agent Control",
          "Autonomous registered research tools completed without a manual workbench or OpenCodeTool step."
        );
        return this.store.getSnapshot(projectId);
      }
      const acquisitionTools = preOpenCodeToolNames(researchPlan);
      let preToolResults: ResearchToolResult[] = [];
      let openCodeInput = runInput;
      if (this.toolRunner && acquisitionTools.length) {
        try {
          preToolResults = await this.toolRunner.runAll(runInput, settings, { includeTools: acquisitionTools });
          openCodeInput = applyToolResultsToOpenCodeInput(runInput, preToolResults);
        } catch (toolError) {
          if (toolError instanceof ToolRunnerError) {
            const resultsToPersist = [...toolError.partialResults, ...(toolError.failedResult ? [toolError.failedResult] : [])];
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
        await this.record(projectId, ResearchLoopStep.ExecuteTools, "Agent Control", `OpenCode 실행 실패: ${reason}`);
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
          const resultsToPersist = [...preToolResults, ...toolError.partialResults, ...(toolError.failedResult ? [toolError.failedResult] : [])];
          await this.persistExecutionOutputs(snapshot.project, database, activeIteration, output, resultsToPersist);
        }
        throw toolError;
      }
      const toolResults = [...preToolResults, ...postToolResults];
      await this.persistExecutionOutputs(snapshot.project, database, activeIteration, output, toolResults);
      await this.ingestSources(projectId);
      await this.record(projectId, ResearchLoopStep.ExecuteTools, "Agent Control", "도구 실행 결과를 프로젝트 저장소에 기록했습니다.");
    } catch (error) {
      await this.failProject(projectId, ResearchLoopStep.ExecuteTools, error);
      return this.store.getSnapshot(projectId);
    }
    return this.store.getSnapshot(projectId);
  }

  protected async persistExecutionOutputs(
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

  protected async createOpenCodeRunAttempt(input: OpenCodeRunInput, executionBundleId: string): Promise<OpenCodeRun> {
    const run = this.openCode.createRunAttempt ? await this.openCode.createRunAttempt(input) : genericOpenCodeRunAttempt(input, executionBundleId);
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

  protected async preflightExecutionEngine(projectId: string): Promise<void> {
    if (!this.openCode.preflight) {
      return;
    }
    try {
      await this.openCode.preflight();
    } catch (error) {
      await this.moveProject(projectId, ResearchLoopStep.ExecuteTools);
      throw new Error(`OpenCode preflight failed: ${formatError(error)}`, { cause: error });
    }
  }
}
