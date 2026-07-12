import { createId, nowIso } from "../shared/ids.js";
import type { AppSettings, ResearchToolInput } from "../shared/types.js";
import { createDefaultResearchTools } from "./toolCatalog.js";
import type {
  ResearchTool,
  ResearchToolExecutionContext,
  ResearchToolResult,
  ToolExecutionContext,
  ToolExecutionJournal,
  ToolExecutionStatusEvent
} from "./researchToolTypes.js";
import { buildExecutableToolNames, type ToolExecutableContext } from "./toolAvailability.js";
export type { ToolExecutableContext } from "./toolAvailability.js";
import { buildToolExecutionSchedule, type ScheduledToolAction, type ToolFilterOptions } from "./toolDependencyScheduler.js";
import { normalizeToolName } from "./toolMerger.js";
import { validateResearchToolResult } from "./toolResultGuards.js";
import { assertToolActionAllowed } from "./toolCapabilityGuard.js";
import { accumulateToolResult, cloneRollingInput, type RollingResearchToolInput } from "./toolRollingInput.js";
import { sha256CanonicalValue } from "./toolResultHash.js";
import { ActionGroupFailure, actionError, actionFailures, asActionFailure, type ActionFailure } from "./toolActionFailure.js";
import { codexTraceEvent } from "./toolTraceProjection.js";

type SyntheticFailureKind = "tool_exception" | "malformed_tool_result";

export interface ToolRunnerOptions extends ToolFilterOptions {
  execution?: ToolExecutionContext;
}

export class ToolRunnerError extends Error {
  readonly partialResults: ResearchToolResult[];
  readonly failedResult?: ResearchToolResult;
  readonly rollingInput: ResearchToolInput;
  readonly failure?: Error;
  readonly toolName: string;
  readonly quarantineRef?: string;

  constructor(message: string, result: ToolRunnerResult) {
    super(message);
    this.name = "ToolRunnerError";
    this.partialResults = result.completedResults;
    this.failedResult = result.failedResult;
    this.rollingInput = result.rollingInput;
    this.failure = result.failure;
    this.toolName = result.toolName ?? result.failedResult?.toolRun.toolName ?? "unknown";
    this.quarantineRef = result.quarantineRef;
  }
}

export interface ToolRunnerResult {
  completedResults: ResearchToolResult[];
  failedResult?: ResearchToolResult;
  failure?: Error;
  rollingInput: ResearchToolInput;
  toolName?: string;
  quarantineRef?: string;
}

export class ToolRunner {
  private readonly inFlight = new Map<string, Promise<ResearchToolResult[]>>();

  constructor(
    private readonly tools: ResearchTool[] = createDefaultResearchTools(),
    private readonly journal?: ToolExecutionJournal
  ) {}

  listRegisteredToolNames(): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const tool of this.tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      names.push(tool.name);
    }
    return names;
  }

  listToolNames(): string[] {
    return this.listRegisteredToolNames();
  }

  listExecutableToolNames(context: ToolExecutableContext): string[] {
    return buildExecutableToolNames(this.listRegisteredToolNames(), context);
  }

  hasTool(name: string): boolean {
    const normalized = normalizeToolName(name);
    return this.tools.some((tool) => normalizeToolName(tool.name) === normalized);
  }

  registerTool(tool: ResearchTool): void {
    if (!this.hasTool(tool.name)) this.tools.push(tool);
  }

  async execute(input: ResearchToolInput, settings: AppSettings, options: ToolRunnerOptions = {}): Promise<ResearchToolResult[]> {
    const key = options.execution?.idempotencyKey;
    if (!key) return this.executeSchedule(input, settings, options);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const operation = this.executeSchedule(input, settings, options).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, operation);
    return operation;
  }

  private async executeSchedule(input: ResearchToolInput, settings: AppSettings, options: ToolRunnerOptions): Promise<ResearchToolResult[]> {
    const schedule = buildToolExecutionSchedule(input.researchPlan, options);
    if (!schedule.actions.length) return [];
    const executionId = options.execution?.executionId ?? createId("tool-execution");
    const signal = options.execution?.signal ?? new AbortController().signal;
    const startedAt = nowIso();
    const toolMap = researchToolMap(this.tools);
    await this.journal?.beginExecution({
      executionId,
      projectId: input.project.id,
      jobId: options.execution?.jobId,
      iteration: input.iteration,
      actionCount: schedule.actions.length,
      startedAt
    });
    for (const action of schedule.actions) await this.emit(action, executionId, signal, "queued", options);

    const completed: Array<{ action: ScheduledToolAction; result: ResearchToolResult }> = [];
    let rollingInput = cloneRollingInput(input);
    try {
      for (const group of schedule.phases) {
        throwIfAborted(signal);
        if (group.phase === "acquisition.discovery") {
          const phaseInput = cloneRollingInput(rollingInput);
          const settled = await mapConcurrentSettled(group.actions, 4, (action) =>
            this.runAction(action, phaseInput, settings, toolMap, executionId, signal, options)
          );
          const phaseFailures: ActionFailure[] = [];
          for (const item of settled) {
            if (item.status === "rejected") {
              phaseFailures.push(asActionFailure(item.reason, group.actions[phaseFailures.length] ?? group.actions.at(-1)));
              continue;
            }
            completed.push(item.value);
            rollingInput = accumulateToolResult(rollingInput, item.value.result);
          }
          if (phaseFailures.length) throw new ActionGroupFailure(phaseFailures);
          continue;
        }
        for (const action of group.actions) {
          const item = await this.runAction(action, rollingInput, settings, toolMap, executionId, signal, options);
          completed.push(item);
          rollingInput = accumulateToolResult(rollingInput, item.result);
        }
      }
      await this.journal?.completeExecution(executionId, nowIso());
      return completed.map((item) => item.result);
    } catch (error) {
      const failures = actionFailures(error, schedule.actions[completed.length] ?? schedule.actions.at(-1));
      const actionFailure = failures[0] as ActionFailure;
      const failedActionIds = new Set(failures.map((item) => item.action.actionId));
      const completedActionIds = new Set(completed.map((item) => item.action.actionId));
      const completedAt = nowIso();
      const quarantineRef = this.journal?.prepareQuarantine
        ? await this.journal.prepareQuarantine(executionId, actionFailure.failure.message, completedAt)
        : undefined;
      for (const item of completed)
        await this.emit(
          item.action,
          executionId,
          signal,
          "quarantined",
          options,
          item.result,
          actionFailure.failure,
          quarantineRef,
          undefined,
          "UPSTREAM_FAILURE"
        );
      for (const action of schedule.actions) {
        if (completedActionIds.has(action.actionId) || failedActionIds.has(action.actionId)) continue;
        const interrupted = signal.aborted;
        await this.emit(
          action,
          executionId,
          signal,
          interrupted ? "interrupted" : "blocked",
          options,
          undefined,
          new Error(interrupted ? "Execution was interrupted before this action started." : "A required upstream action failed."),
          quarantineRef,
          undefined,
          interrupted ? "EXECUTION_INTERRUPTED" : "DEPENDENCY_FAILED"
        );
      }
      const committedQuarantine = this.journal?.commitQuarantine
        ? await this.journal.commitQuarantine(executionId)
        : await this.journal?.quarantineExecution(executionId, actionFailure.failure.message, completedAt);
      throw new ToolRunnerError(actionFailure.message ?? `${actionFailure.action.toolName} did not complete successfully: ${actionFailure.failure.message}`, {
        completedResults: completed.map((item) => item.result),
        failedResult: actionFailure.failedResult,
        failure: actionFailure.failure,
        rollingInput: actionFailure.failedResult ? accumulateToolResult(rollingInput, actionFailure.failedResult) : rollingInput,
        toolName: actionFailure.action.toolName,
        quarantineRef: committedQuarantine ?? quarantineRef
      });
    }
  }

  private async runAction(
    action: ScheduledToolAction,
    input: RollingResearchToolInput,
    settings: AppSettings,
    toolMap: Map<string, ResearchTool>,
    executionId: string,
    signal: AbortSignal,
    options: ToolRunnerOptions
  ): Promise<{ action: ScheduledToolAction; result: ResearchToolResult }> {
    throwIfAborted(signal);
    try {
      await assertToolActionAllowed(action, options.execution);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      await this.emit(action, executionId, signal, "blocked", options, undefined, failure, undefined, {
        status: "rejected",
        reason: failure.message
      });
      throw actionError(action, failure);
    }
    const tool = toolMap.get(action.normalizedName);
    if (!tool) throw actionError(action, new Error(`Required research tool is not registered: ${action.toolName}`));
    const currentInput = inputForAction(input, action, options.execution);
    const context = actionContext(action, executionId, signal, options.execution, this.journal?.actionWorkspace?.(executionId, action.actionId));
    await this.emit(action, executionId, signal, "running", options);
    let returned: unknown;
    try {
      returned = await tool.run(currentInput, settings, context);
      throwIfAborted(signal);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const failedResult = withAttemptOrigin(syntheticFailedResult(tool.name, currentInput, failure, "tool_exception"), context);
      await this.emit(action, executionId, signal, signal.aborted ? "interrupted" : "failed", options, failedResult, failure);
      throw actionError(action, failure, failedResult);
    }
    const validation = validateResearchToolResult(returned);
    if (!validation.ok) {
      const failure = new Error(validation.message);
      const failedResult = withAttemptOrigin(syntheticFailedResult(tool.name, currentInput, failure, "malformed_tool_result"), context);
      await this.emit(action, executionId, signal, "failed", options, failedResult, failure);
      throw actionError(action, failure, failedResult, `${tool.name} returned a malformed tool result: ${validation.message}`);
    }
    const result = withAttemptOrigin(validation.result, context);
    if (result.toolRun.status !== "completed") {
      const failure = new Error(result.toolRun.error ?? JSON.stringify(result.toolRun.output));
      await this.emit(action, executionId, signal, "failed", options, result, failure);
      throw actionError(action, failure, result);
    }
    await this.emit(action, executionId, signal, "completed", options, result);
    return { action, result };
  }

  private async emit(
    action: ScheduledToolAction,
    executionId: string,
    signal: AbortSignal,
    status: ToolExecutionStatusEvent["status"],
    options: ToolRunnerOptions,
    result?: ResearchToolResult,
    failure?: Error,
    quarantineRef?: string,
    policy?: { status: "accepted" | "rejected"; reason?: string },
    terminalCause?: string
  ): Promise<void> {
    const context = actionContext(action, executionId, signal, options.execution, this.journal?.actionWorkspace?.(executionId, action.actionId));
    const outputHash = result ? await sha256CanonicalValue(result) : undefined;
    const event: ToolExecutionStatusEvent = {
      ...context,
      toolName: action.toolName,
      status,
      occurredAt: nowIso(),
      ...(failure ? { error: failure.message } : {}),
      ...(policy ? { policyStatus: policy.status, policyReason: policy.reason } : {}),
      ...(result ? { outputHash, outputIds: outputIds(result), outputs: publicOutputs(result) } : {}),
      ...(quarantineRef ? { quarantineRef } : {}),
      ...(terminalCause ? { terminalCause } : {}),
      ...(result ? codexTraceEvent(result) : {})
    };
    await this.journal?.record(event, result);
    await options.execution?.onStatus?.(event);
  }
}

function actionContext(
  action: ScheduledToolAction,
  executionId: string,
  signal: AbortSignal,
  execution?: ToolExecutionContext,
  stagingRef?: string
): ResearchToolExecutionContext {
  const attemptId = `${executionId}:${action.actionId}`;
  return {
    signal,
    jobId: execution?.jobId,
    attemptId,
    decisionId: action.decisionId,
    ordinal: action.ordinal,
    phase: action.descriptor.phase,
    inputs: action.inputs,
    purpose: action.purpose,
    expectedOutcome: action.expectedOutcome,
    dependsOnAttemptIds: action.dependsOnActionIds.map((actionId) => `${executionId}:${actionId}`),
    stagingRef: stagingRef ?? `staging/jobs/${execution?.jobId ?? "standalone"}/${executionId}/actions/${action.actionId}`,
    ...(execution?.onNetworkAudit ? { onNetworkAudit: (audit) => execution.onNetworkAudit?.({ ...audit, attemptId }) } : {})
  };
}

function inputForAction(input: RollingResearchToolInput, action: ScheduledToolAction, execution: ToolExecutionContext | undefined): RollingResearchToolInput {
  const urls = Array.isArray(action.inputs.urls) ? action.inputs.urls.filter((value): value is string => typeof value === "string") : undefined;
  const programRequests = Array.isArray(action.inputs.programRequests) ? action.inputs.programRequests : undefined;
  return {
    ...cloneRollingInput(input),
    ...(execution?.toolPolicy ? { executionContext: { toolPolicy: execution.toolPolicy } } : {}),
    researchPlan: input.researchPlan
      ? {
          ...input.researchPlan,
          ...(urls?.length ? { fetchCandidateUrls: urls } : {}),
          ...(programRequests ? { programRequests: programRequests as NonNullable<typeof input.researchPlan.programRequests> } : {})
        }
      : undefined
  };
}

function withAttemptOrigin(result: ResearchToolResult, context: ResearchToolExecutionContext): ResearchToolResult {
  return {
    ...result,
    sources: result.sources.map((item) => ({ ...item, metadata: { ...item.metadata, originToolAttemptId: context.attemptId } })),
    evidence: result.evidence.map((item) => ({ ...item, metadata: { ...(item.metadata ?? {}), originToolAttemptId: context.attemptId } })),
    artifacts: result.artifacts.map((item) => ({ ...item, metadata: { ...(item.metadata ?? {}), originToolAttemptId: context.attemptId } })),
    toolRun: {
      ...result.toolRun,
      originAttemptId: context.attemptId,
      originDecisionId: context.decisionId,
      executionOrdinal: context.ordinal
    }
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Tool execution was interrupted.");
}

async function mapConcurrentSettled<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index] as T) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function outputIds(result: ResearchToolResult): string[] {
  return [result.toolRun.id, ...result.sources.map((item) => item.id), ...result.evidence.map((item) => item.id), ...result.artifacts.map((item) => item.id)];
}

function publicOutputs(result: ResearchToolResult): NonNullable<ToolExecutionStatusEvent["outputs"]> {
  return [
    ...result.sources.map((item) => ({ id: item.id, kind: "source" as const })),
    ...result.evidence.map((item) => ({ id: item.id, kind: "evidence" as const })),
    ...result.artifacts.map((item) => ({ id: item.id, kind: "artifact" as const, name: item.title, artifactKind: item.category }))
  ];
}

function syntheticFailedResult(toolName: string, input: RollingResearchToolInput, failure: Error, failureKind: SyntheticFailureKind): ResearchToolResult {
  const timestamp = nowIso();
  return {
    toolRun: {
      id: createId("tool"),
      projectId: input.project.id,
      iteration: input.iteration,
      toolName,
      input: { projectId: input.project.id, iteration: input.iteration },
      output: { failureMessage: failure.message, toolName, failureKind, evidenceFailure: true },
      status: "failed",
      error: failure.message,
      startedAt: timestamp,
      completedAt: timestamp
    },
    evidence: [],
    artifacts: [],
    sources: []
  };
}

function researchToolMap(tools: ResearchTool[]): Map<string, ResearchTool> {
  return new Map(tools.map((tool) => [normalizeToolName(tool.name), tool]));
}
