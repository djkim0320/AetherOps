import { randomUUID } from "node:crypto";
import type { CanonicalHasher } from "../../core/orchestration/orchestrationSchemas.js";
import type { AetherOpsOrchestrator } from "../../core/orchestration/orchestrator.js";
import type { LlmInvocationMetadata, LlmInvocationRunningMetadata } from "../../core/providers/llm.js";
import { ResearchLoopStep } from "../../core/shared/types.js";
import type { ToolExecutionContext } from "../../core/tools/researchToolTypes.js";
import { computeProjectRevision } from "../http/v2/common.js";
import { emitProjectSnapshotChanged } from "../http/v2/eventEmitters.js";
import type { AppSettingsStore } from "../runtime/storage/settingsStore.js";
import type { StorageLlmInvocation } from "../runtime/storage/v2/traceTypes.js";
import type { CanonicalRunRuntime } from "./canonicalRunRuntime.js";
import { DurableCanonicalResearchSession } from "./durableCanonicalResearchSession.js";
import { canonicalResearchTerminalTransition } from "./durableCanonicalResearchTerminal.js";
import type { DurableCanonicalTerminalTransition } from "./durableCanonicalTerminalTransition.js";
import type { DurableJobRuntime } from "./durableJobRuntime.js";
import type { DurableJobRecord } from "./durableJobTypes.js";
import { DurableToolExecutionAdapter } from "./durableToolExecutionAdapter.js";

interface DurableResearchLoopHandlerDependencies {
  orchestrator: AetherOpsOrchestrator;
  settingsStore: AppSettingsStore;
  jobs: DurableJobRuntime;
  events: DurableJobRuntime;
}

type ActionAuthorizerFactory = (job: DurableJobRecord) => NonNullable<ToolExecutionContext["authorizeAction"]>;

export function registerDurableResearchLoopHandler(
  deps: DurableResearchLoopHandlerDependencies,
  canonicalRuntime: CanonicalRunRuntime,
  canonicalHasher: CanonicalHasher,
  createActionAuthorizer: ActionAuthorizerFactory
): void {
  deps.jobs.registerHandler("research_loop", async (job, request, context) => {
    const action = (request as { action?: string } | undefined)?.action;
    const resumeCheckpoint = action === "resume" && job.resumeCheckpointId ? await deps.jobs.getCheckpoint(job.resumeCheckpointId) : undefined;
    const canonicalSession = await DurableCanonicalResearchSession.create(
      { jobs: deps.jobs, settingsStore: deps.settingsStore, runtime: canonicalRuntime, hasher: canonicalHasher },
      job
    );
    if (action === "resume" && !resumeCheckpoint && !canonicalSession.isBootstrapResume) {
      throw new Error("Research resume requires its latest committed checkpoint.");
    }
    await canonicalSession.prepare(await deps.orchestrator.getSnapshot(job.projectId));
    if (resumeCheckpoint) {
      await deps.jobs.commitCanonicalRevisionPlan(canonicalSession.owner, () => canonicalSession.prepareResumeRevision(resumeCheckpoint));
    } else if (canonicalSession.isBootstrapResume) {
      await deps.jobs.commitCanonicalRevisionPlan(canonicalSession.owner, () => canonicalSession.prepareBootstrapResumeRevision());
    }
    await deps.jobs.commitCanonicalBudget(canonicalSession.owner, (recordedAt) => canonicalSession.prepareBudgetRevision(recordedAt));
    const trace = new DurableToolExecutionAdapter(job, deps.jobs, async () => computeProjectRevision(await deps.orchestrator.getSnapshot(job.projectId)));
    let terminalPromotions: ReturnType<DurableToolExecutionAdapter["completedOutputPromotions"]> = [];
    const canonicalTransition: DurableCanonicalTerminalTransition = {
      owner: canonicalSession.owner,
      prepareRevision: async (terminal) => {
        const precedingPlan = await canonicalSession.prepareBudgetRevision(terminal.recordedAt);
        return canonicalResearchTerminalTransition({
          runtime: canonicalRuntime,
          owner: canonicalSession.owner,
          job,
          snapshot: await deps.orchestrator.getSnapshot(job.projectId),
          promotions: terminal.status === "completed" ? terminalPromotions : [],
          hasher: canonicalHasher,
          precedingPlan,
          verifyTerminal: (input) => deps.jobs.verifyCanonicalTerminal(input)
        }).prepareRevision(terminal);
      }
    };
    deps.jobs.bindCanonicalTransition(job.id, canonicalTransition);
    const llmExecution = createDurableLlmExecution(job, deps.jobs);
    const execution: ToolExecutionContext = {
      jobId: job.id,
      idempotencyKey: job.idempotencyKey,
      allowCodexCli: job.toolPolicy?.allowCodexCli === true,
      ...(job.effectiveCapabilities ? { effectiveCapabilities: job.effectiveCapabilities } : {}),
      authorizeAction: createActionAuthorizer(job),
      ...(resumeCheckpoint?.step ? { resumeCheckpointStep: resumeCheckpoint.step as ResearchLoopStep } : {}),
      ...(job.toolPolicy ? { toolPolicy: job.toolPolicy } : {}),
      signal: context.signal,
      onStatus: trace.onStatus,
      ...llmExecution,
      onNetworkAudit: async (audit) => {
        await deps.jobs.recordNetworkAudit({
          id: randomUUID(),
          projectId: job.projectId,
          jobId: job.id,
          attemptId: audit.attemptId,
          url: audit.url,
          redirectChain: audit.redirectChain,
          sourcePolicy: audit.sourcePolicy,
          policyDecision: audit.policyDecision,
          reason: audit.reason,
          auditedAt: audit.auditedAt
        });
      },
      onCheckpoint: async (step) => {
        const projectRevision = computeProjectRevision(await deps.orchestrator.getSnapshot(job.projectId));
        await deps.jobs.commitCanonicalBudget(canonicalSession.owner, (recordedAt) => canonicalSession.prepareBudgetRevision(recordedAt));
        await deps.jobs.commitCanonicalCheckpoint({
          owner: canonicalSession.owner,
          step,
          projectRevision,
          requireContextPack: true,
          prepareRevision: (input) => canonicalSession.prepareCheckpointRevision(input)
        });
      }
    };
    execution.compilePlannerContext = (input) => canonicalSession.compilePlannerContext(input);
    let snapshot =
      action === "resume" && !canonicalSession.isBootstrapResume
        ? await deps.orchestrator.resume(job.projectId, execution)
        : await deps.orchestrator.startLoop(job.projectId, execution);
    const requestedControl = context.requestedControl();
    if (requestedControl) {
      snapshot = requestedControl === "pause" ? await deps.orchestrator.pause(job.projectId) : await deps.orchestrator.abort(job.projectId);
    }
    const revision = computeProjectRevision(snapshot);
    if (["paused", "aborted", "blocked", "failed"].includes(snapshot.project.status)) {
      const status = snapshot.project.status as "paused" | "aborted" | "blocked" | "failed";
      await deps.jobs.settle(job.id, status, revision, terminalReason(status), undefined, canonicalTransition);
    } else if (snapshot.project.status === "completed") {
      terminalPromotions = trace.completedOutputPromotions();
      await deps.jobs.finish(job.id, revision, terminalPromotions, canonicalTransition);
    } else {
      throw new Error(`Research loop handler returned a non-terminal project status: ${snapshot.project.status}`);
    }
    await emitProjectSnapshotChanged(deps.events, snapshot, "job_changed");
  });
}

export function createDurableLlmExecution(
  job: Pick<DurableJobRecord, "id" | "projectId">,
  jobs: Pick<DurableJobRuntime, "saveLlmInvocation">
): Pick<ToolExecutionContext, "onLlmInvocationRunning" | "onLlmInvocation"> {
  return {
    onLlmInvocationRunning: async (metadata) => {
      await jobs.saveLlmInvocation(toStorageRunningLlmInvocation(job, metadata));
    },
    onLlmInvocation: async (metadata) => {
      if (!metadata.invocationId) throw new Error("Durable LLM terminal receipt is missing its stable invocation identity.");
      await jobs.saveLlmInvocation(toStorageLlmInvocation(job, metadata, metadata.invocationId));
    }
  };
}

export function toStorageRunningLlmInvocation(job: Pick<DurableJobRecord, "id" | "projectId">, metadata: LlmInvocationRunningMetadata): StorageLlmInvocation {
  return {
    id: metadata.invocationId,
    projectId: job.projectId,
    jobId: job.id,
    model: metadata.model ?? metadata.provider,
    reasoningEffort: metadata.reasoningEffort ?? "unspecified",
    promptVersion: metadata.promptVersion,
    schemaVersion: metadata.schemaVersion,
    promptHash: metadata.promptHash,
    repairCount: 0,
    status: "running",
    startedAt: metadata.startedAt,
    data: {
      provider: metadata.provider,
      schemaName: metadata.schemaName
    }
  };
}

export function toStorageLlmInvocation(
  job: Pick<DurableJobRecord, "id" | "projectId">,
  metadata: LlmInvocationMetadata,
  invocationId: string
): StorageLlmInvocation {
  return {
    id: invocationId,
    projectId: job.projectId,
    jobId: job.id,
    model: metadata.model ?? metadata.provider,
    reasoningEffort: metadata.reasoningEffort ?? "unspecified",
    promptVersion: metadata.promptVersion,
    schemaVersion: metadata.schemaVersion,
    promptHash: metadata.promptHash ?? "unavailable",
    ...(metadata.responseHash ? { responseHash: metadata.responseHash } : {}),
    latencyMs: metadata.durationMs,
    repairCount: metadata.repairCount,
    status: metadata.status ?? "completed",
    ...(metadata.status === "failed" ? { error: metadata.validationErrors?.join("; ") || "provider_invocation_failed" } : {}),
    startedAt: metadata.startedAt,
    completedAt: metadata.completedAt,
    data: {
      accounting: {
        version: 1,
        inputUnits: metadata.inputTokenEstimate,
        outputUnits: metadata.outputTokenEstimate,
        unit: "estimated_token",
        estimator: metadata.tokenEstimator,
        monetaryCost: { availability: metadata.monetaryCostAvailability, policy: "unmetered_codex_oauth_v1" }
      },
      provider: metadata.provider,
      schemaName: metadata.schemaName,
      ...(metadata.validationErrors?.length ? { validationErrors: metadata.validationErrors } : {}),
      ...(metadata.contextPackId ? { contextPackId: metadata.contextPackId } : {}),
      ...(metadata.canonicalHash ? { canonicalHash: metadata.canonicalHash } : {}),
      ...(metadata.finalInputHash ? { finalInputHash: metadata.finalInputHash } : {})
    }
  };
}

function terminalReason(status: "paused" | "aborted" | "blocked" | "failed") {
  if (status === "blocked") {
    return "RESEARCH_EXECUTION_BLOCKED";
  }
  if (status === "failed") {
    return "RESEARCH_EXECUTION_FAILED";
  }
  return undefined;
}
