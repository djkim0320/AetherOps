import { z } from "zod";
import { hashCanonical, hashCanonicalSync } from "./canonical.js";
import { DeterministicClock, DeterministicIdGenerator } from "./deterministicPrimitives.js";
import {
  EvalExecutionCaseSchema,
  EvalOracleSchema,
  EvalRunSchema,
  type EvalCase,
  type EvalExecutionCase,
  type EvalOracle,
  type EvalRun,
  type HarnessCapability
} from "./evalSchemas.js";
import { HarnessCapabilityError, HarnessError } from "./errors.js";
import { assembleEvalCase, assertOracleFreeExecutionPayload } from "./executionBoundary.js";
import { DeterministicFaultInjector } from "./faultInjection.js";
import {
  DETERMINISTIC_GRADER_HASH,
  DETERMINISTIC_GRADER_DESCRIPTOR,
  gradeDeterministicCase,
  gradeDeterministicTracePrefix,
  type DeterministicGradeMetrics
} from "./graders.js";
import {
  DeterministicCasePlanSchema,
  DeterministicTestProvider,
  DeterministicToolProvider,
  type DeterministicCasePlan,
  type DeterministicToolResult,
  type TestToolDefinition
} from "./testProviders.js";
import { DeterministicTraceRecorder } from "./traceRecorder.js";
import { replayTrace } from "./traceReplay.js";
import type { TraceEvent } from "./traceSchemas.js";
import {
  createToolExecutionMetrics,
  emitAcceptance,
  emitMemory,
  emitSkillsAndWorkOrders,
  gradeMetrics,
  metricEnvelope,
  restartRecoveredFromReplay,
  structuredRedactionReceipt,
  type ToolExecutionMetrics
} from "./runtimeSupport.js";

export interface HarnessSubject {
  baseSha: string;
  headSha: string;
  dirtyDiffHash: string;
}

export const HarnessSubjectSchema = z
  .object({
    baseSha: z.string().regex(/^[a-f0-9]{40}$/),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    dirtyDiffHash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

export interface DeterministicHarnessRuntimeOptions {
  plan: DeterministicCasePlan;
  tools: readonly TestToolDefinition[];
  capabilities: readonly HarnessCapability[];
  harnessVersion: string;
  evaluatorVersion: string;
  providerAdapter: string;
  modelIdentifier: string;
  subject: HarnessSubject;
}

export interface DeterministicCaseExecution {
  run: EvalRun;
  events: TraceEvent[];
}

export class DeterministicHarnessRuntime {
  constructor(private readonly options: DeterministicHarnessRuntimeOptions) {}

  async run(executionInput: EvalExecutionCase, oracleInput: EvalOracle): Promise<DeterministicCaseExecution> {
    const subjectResult = HarnessSubjectSchema.safeParse(this.options.subject);
    if (!subjectResult.success) throw new HarnessError("TOOL_INVOCATION_INVALID", "Deterministic harness requires explicit valid subject provenance.");
    const execution = this.validateExecution(executionInput);
    const evalCase = this.validateOracle(execution, oracleInput);
    const plan = DeterministicCasePlanSchema.parse(this.options.plan);
    if (plan.caseId !== execution.id) throw new HarnessError("UNSUPPORTED_EVAL_CASE", `Plan/case mismatch: ${plan.caseId} != ${execution.id}`);
    const clock = new DeterministicClock("2026-01-01T00:00:00.000Z", 1);
    const ids = new DeterministicIdGenerator(execution.seed);
    const runId = ids.nextUuid();
    const recorder = new DeterministicTraceRecorder(runId, execution.id, "project-aetherbench", `job-${execution.id}`, clock, ids);
    const modelProvider = new DeterministicTestProvider([plan]);
    const faults = new DeterministicFaultInjector(plan.faults);
    const toolProvider = new DeterministicToolProvider(this.options.tools, clock, ids, faults);
    const selectedPlan = modelProvider.plan(
      execution,
      toolProvider.list().map((tool) => tool.name)
    );
    const startedAt = clock.peekIso();
    await this.emitPrelude(execution, selectedPlan, toolProvider, recorder);
    const toolMetrics = await this.executeCalls(execution, selectedPlan, toolProvider, recorder);
    await emitMemory(selectedPlan, recorder);
    await emitSkillsAndWorkOrders(selectedPlan, recorder);
    const resumedCheckpoint =
      toolMetrics.retries > 0 && selectedPlan.calls.some((call) => call.toolName === "state.checkpoint" && toolMetrics.completedCallIds.includes(call.callId));
    await recorder.emit("run_state.revised", {
      revision: 1,
      previousRevision: 0,
      stateHash: await hashCanonical({ runId, revision: 1, completedCalls: toolMetrics.completedCallIds }),
      reason: resumedCheckpoint ? "resume" : "terminal"
    });
    const metrics = gradeMetrics(selectedPlan, clock.elapsedSince(startedAt), toolMetrics);
    const prefixGrade = await gradeDeterministicTracePrefix(evalCase, recorder.events(), metrics);
    await emitAcceptance(prefixGrade.acceptanceResults, recorder);
    await recorder.emit("eval.completed", {
      result: prefixGrade.passed ? "passed" : "failed",
      acceptancePassed: prefixGrade.acceptanceResults.filter((result) => result.passed).length,
      acceptanceTotal: prefixGrade.acceptanceResults.length
    });
    const events = recorder.events();
    const replay = await replayTrace(events);
    const sealedGrade = await gradeDeterministicCase(evalCase, events, metrics);
    if (hashCanonicalSync(prefixGrade.acceptanceResults) !== hashCanonicalSync(sealedGrade.acceptanceResults)) {
      throw new HarnessError("TRACE_INVALID", "Sealed deterministic grading differs from the validated trace-prefix grade.");
    }
    modelProvider.assertFullyConsumed();
    toolProvider.assertFaultsConsumed();
    return {
      events,
      run: EvalRunSchema.parse(this.createEvalRun(evalCase, selectedPlan, toolProvider, runId, replay, sealedGrade.acceptanceResults, metrics, toolMetrics))
    };
  }

  private validateExecution(input: EvalExecutionCase): EvalExecutionCase {
    const execution = assertOracleFreeExecutionPayload(EvalExecutionCaseSchema.parse(input));
    const missing = execution.environmentCapabilities.filter((capability) => !this.options.capabilities.includes(capability));
    if (missing.length) throw new HarnessCapabilityError(missing);
    return execution;
  }

  private validateOracle(execution: EvalExecutionCase, input: EvalOracle): EvalCase {
    const oracle = EvalOracleSchema.parse(input);
    const evalCase = assembleEvalCase(execution, oracle);
    if (evalCase.modelGraderRubric)
      throw new HarnessError("MODEL_GRADER_UNAVAILABLE", `Deterministic runtime cannot consume model grader rubric: ${evalCase.id}`);
    if (hashCanonicalSync(evalCase.taskContract) !== evalCase.taskContractHash)
      throw new HarnessError("TRACE_INVALID", `Task contract hash mismatch: ${evalCase.id}`);
    if (hashCanonicalSync(evalCase.deterministicAcceptanceCriteria) !== evalCase.acceptanceCriteriaHash)
      throw new HarnessError("TRACE_INVALID", `Acceptance criteria hash mismatch: ${evalCase.id}`);
    if (
      evalCase.deterministicGrader.version !== DETERMINISTIC_GRADER_DESCRIPTOR.version ||
      evalCase.deterministicGrader.contentHash !== DETERMINISTIC_GRADER_HASH
    ) {
      throw new HarnessError("MODEL_GRADER_UNAVAILABLE", `Unsupported deterministic grader: ${evalCase.deterministicGrader.version}`);
    }
    return evalCase;
  }

  private async emitPrelude(
    evalCase: EvalExecutionCase,
    plan: DeterministicCasePlan,
    toolProvider: DeterministicToolProvider,
    recorder: DeterministicTraceRecorder
  ): Promise<void> {
    await recorder.emit("task.created", {
      taskId: evalCase.taskContract.id,
      taskContractHash: evalCase.taskContract.contentHash,
      objectiveHash: await hashCanonical(evalCase.objective)
    });
    await recorder.emit("run_state.revised", {
      revision: 0,
      previousRevision: null,
      stateHash: await hashCanonical({ runId: recorder.runId, revision: 0, caseId: evalCase.id }),
      reason: "created"
    });
    const selectedToolSpecs = plan.candidates.map((name) => {
      const definition = toolProvider.describe(name);
      return { name: definition.name, version: definition.version };
    });
    await recorder.emit("context.compiled", {
      contextPackHash: await hashCanonical({ caseId: evalCase.id, fixtures: evalCase.inputFixtures.map((fixture) => fixture.sha256), selectedToolSpecs }),
      inputTokens: plan.contextTokens,
      loadedToolSchemaBytes: plan.loadedToolSchemaBytes,
      selectedToolSpecs
    });
    await recorder.emit("tool.candidates.retrieved", {
      queryHash: await hashCanonical({ objective: evalCase.objective, capabilities: evalCase.environmentCapabilities }),
      candidateNames: plan.candidates,
      topK: plan.candidates.length
    });
    for (const rejection of plan.rejections) await recorder.emit("tool.call.rejected", rejection);
  }

  private async executeCalls(
    evalCase: EvalExecutionCase,
    plan: DeterministicCasePlan,
    toolProvider: DeterministicToolProvider,
    recorder: DeterministicTraceRecorder
  ): Promise<ToolExecutionMetrics> {
    const metrics = createToolExecutionMetrics();
    const fixtureIds = new Set(evalCase.inputFixtures.map((fixture) => fixture.id));
    for (const call of plan.calls) {
      for (const fixtureId of call.inputFixtureIds)
        if (!fixtureIds.has(fixtureId)) throw new HarnessError("TOOL_INVOCATION_INVALID", `Call references an undeclared fixture: ${fixtureId}`);
      const failedDependency = call.dependencyCallIds.find((dependency) => metrics.failedCallIds.has(dependency));
      if (failedDependency) {
        await recorder.emit("tool.call.rejected", {
          callId: call.callId,
          toolName: call.toolName,
          reasonCode: "precondition_failed",
          reason: `Dependency did not verify: ${failedDependency}`
        });
        metrics.failedCallIds.add(call.callId);
        continue;
      }
      const definition = toolProvider.describe(call.toolName);
      const selectionId = `selection:${call.callId}`;
      await recorder.emit("tool.selected", {
        selectionId,
        toolName: call.toolName,
        rank: plan.candidates.indexOf(call.toolName) + 1,
        decisionReason: "The structured test plan selected a declared candidate."
      });
      const inputHash = await hashCanonical({ caseId: evalCase.id, fixtureIds: call.inputFixtureIds, toolName: call.toolName });
      await recorder.emit("tool.call.proposed", {
        callId: call.callId,
        selectionId,
        toolName: call.toolName,
        toolVersion: definition.version,
        inputHash,
        mutating: definition.mutating,
        ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
        dependencyCallIds: call.dependencyCallIds
      });
      const finalResult = await this.executeAttempts(evalCase, call, definition.version, inputHash, toolProvider, recorder, metrics);
      if (!finalResult || finalResult.outcome === "transient_failure" || finalResult.outcome === "permanent_failure") {
        metrics.failedCallIds.add(call.callId);
        continue;
      }
      const passed = finalResult.outcome === "success";
      await recorder.emit("tool.call.verified", {
        callId: call.callId,
        verifier: call.verifier,
        passed,
        checks: call.verifierChecks,
        promotedArtifactIds: passed ? finalResult.outputArtifactIds : []
      });
      if (passed) metrics.completedCallIds.push(call.callId);
      else metrics.failedCallIds.add(call.callId);
    }
    return metrics;
  }

  private async executeAttempts(
    evalCase: EvalExecutionCase,
    call: DeterministicCasePlan["calls"][number],
    _toolVersion: string,
    inputHash: string,
    toolProvider: DeterministicToolProvider,
    recorder: DeterministicTraceRecorder,
    metrics: ToolExecutionMetrics
  ): Promise<DeterministicToolResult | undefined> {
    let finalResult: DeterministicToolResult | undefined;
    for (let attempt = 1; attempt <= call.maxAttempts; attempt += 1) {
      await recorder.emit("tool.call.started", { callId: call.callId, attempt, inputHash });
      metrics.attempts += 1;
      const result = await toolProvider.invoke({
        runId: recorder.runId,
        target: call.callId,
        toolName: call.toolName,
        inputHash,
        ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
        capabilities: this.options.capabilities,
        allowedTools: evalCase.allowedTools
      });
      metrics.outputBytes += result.outputBytes;
      await recorder.emit("tool.call.completed", { callId: call.callId, attempt, ...result });
      finalResult = result;
      if (result.outcome !== "transient_failure" || attempt === call.maxAttempts) break;
      metrics.retries += 1;
      await recorder.emit("recovery.selected", {
        failedCallId: call.callId,
        strategy: "retry",
        retryCallId: call.callId,
        reason: "A declared transient fault permits one bounded retry."
      });
    }
    return finalResult;
  }

  private createEvalRun(
    evalCase: EvalCase,
    plan: DeterministicCasePlan,
    toolProvider: DeterministicToolProvider,
    runId: string,
    replay: Awaited<ReturnType<typeof replayTrace>>,
    acceptanceResults: EvalRun["acceptanceResults"],
    metrics: DeterministicGradeMetrics,
    toolMetrics: ToolExecutionMetrics
  ): unknown {
    const faults = toolProvider.faultReceipts();
    const result = acceptanceResults.every((item) => item.passed) ? "passed" : "failed";
    return {
      schemaVersion: 1,
      id: runId,
      caseId: evalCase.id,
      suite: evalCase.suite,
      evidenceClass: "deterministic_test_runtime",
      productionSuccessEligible: false,
      productOutcome: "not_evaluated",
      subject: this.options.subject,
      harnessVersion: this.options.harnessVersion,
      evaluatorVersion: this.options.evaluatorVersion,
      evaluatorHash: DETERMINISTIC_GRADER_HASH,
      providerAdapter: this.options.providerAdapter,
      modelIdentifier: this.options.modelIdentifier,
      seed: evalCase.seed,
      taskContractHash: evalCase.taskContractHash,
      contextPackHashes: replay.canonicalState.contextPackHashes,
      toolSpecVersions: Object.fromEntries(plan.candidates.map((name) => [name, toolProvider.describe(name).version])),
      memorySnapshotVersion: plan.memorySnapshotVersion,
      skillVersions: Object.fromEntries(plan.skills.map((skill) => [skill.skillId, skill.version])),
      expectedOutcome: evalCase.expectedOutcome,
      ...(evalCase.heldOutPartition ? { heldOutPartition: evalCase.heldOutPartition } : {}),
      result,
      metrics: metricEnvelope(
        plan,
        metrics,
        toolMetrics,
        replay.duplicateSideEffects,
        restartRecoveredFromReplay(replay),
        replay.events.some((event) => event.type === "tool.call.completed" && Boolean(event.data.sideEffectReceipt))
      ),
      acceptanceResults,
      trace: {
        eventCount: replay.events.length,
        rootHash: replay.rootHash,
        canonicalStateHash: replay.canonicalStateHash,
        canonicalTraceHash: replay.canonicalTraceHash,
        normalizedDuplicateDeliveries: 0,
        redactionReceipt: structuredRedactionReceipt(replay.canonicalTraceHash)
      },
      faults
    };
  }
}
