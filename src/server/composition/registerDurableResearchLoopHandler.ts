import { randomUUID } from "node:crypto";
import type { CanonicalHasher } from "../../core/orchestration/orchestrationSchemas.js";
import type { AetherOpsOrchestrator } from "../../core/orchestration/orchestrator.js";
import type { LlmInvocationMetadata, LlmInvocationRunningMetadata } from "../../core/providers/llm.js";
import { ResearchLoopStep } from "../../core/shared/types.js";
import type { ToolExecutionContext } from "../../core/tools/researchToolTypes.js";
import type { AppSettingsStore } from "../runtime/storage/settingsStore.js";
import type { StorageLlmInvocation } from "../runtime/storage/v2/traceTypes.js";
import type { CanonicalRunRuntime } from "./canonicalRunRuntime.js";
import { DurableCanonicalResearchSession } from "./durableCanonicalResearchSession.js";
import { canonicalResearchTerminalTransition } from "./durableCanonicalResearchTerminal.js";
import type { DurableCanonicalTerminalTransition } from "./durableCanonicalTerminalTransition.js";
import type { DurableJobRuntime } from "./durableJobRuntime.js";
import type { DurableJobRecord } from "./durableJobTypes.js";
import { DurableToolExecutionAdapter } from "./durableToolExecutionAdapter.js";
import { buildDurableEngineeringPromotionDrafts, DurableEngineeringPromotionMaterializationError } from "./durableEngineeringPromotionDrafts.js";
import type { ResearchToolResult } from "../../core/tools/researchToolTypes.js";
import { RuntimeRequirementError } from "../../core/tools/runtimeRequirements.js";
import { assertBoundEngineeringBaseline } from "./engineeringBaselineBinding.js";
import type { ConfigurationBaseline } from "../../core/aerospace/configurationBaseline.js";
import { engineeringPromotionRuntimeReceiptSupport, validateEngineeringPromotionReadiness } from "../../core/aerospace/engineeringBaselineCompatibility.js";
import { engineeringProgramPromotionTarget } from "../../core/tools/engineeringProgramTool.js";
import { REQUIRED_CODEX_CLI_VERSION } from "../runtime/codex/bundledCodexCli.js";
import { normalizeEngineeringProgramRequests } from "../runtime/engineering/engineeringProgramRequestValidator.js";
import { BUNDLED_WEBXFOIL_VERSION } from "../runtime/engineering/engineeringRuntimeVersions.js";
import { requireDurableProjectRevision } from "./durableProjectRevision.js";

interface DurableResearchLoopHandlerDependencies {
  dataRoot: string;
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
    const executionId = `research-execution-${job.id}`;
    const readEngineeringBaseline = async () => {
      const active = await deps.jobs.engineering.activeBaseline(job.projectId);
      return assertBoundEngineeringBaseline(job.engineeringBaseline, active);
    };
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
    const trace = new DurableToolExecutionAdapter(job, deps.jobs, () => requireDurableProjectRevision(deps.jobs, job.projectId));
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
      executionId,
      idempotencyKey: job.idempotencyKey,
      allowCodexCli: job.toolPolicy?.allowCodexCli === true,
      ...(job.effectiveCapabilities ? { effectiveCapabilities: job.effectiveCapabilities } : {}),
      authorizeAction: async (action) => {
        if (action.name === "EngineeringProgramTool" || action.name === "CodexCliTool") {
          const baseline = await readEngineeringBaseline();
          assertPromotionReadyForAction(action.name, action.inputs, baseline);
        }
        return createActionAuthorizer(job)(action);
      },
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
        const projectRevision = await requireDurableProjectRevision(deps.jobs, job.projectId);
        await deps.jobs.commitCanonicalBudget(canonicalSession.owner, (recordedAt) => canonicalSession.prepareBudgetRevision(recordedAt));
        await deps.jobs.commitCanonicalCheckpoint({
          owner: canonicalSession.owner,
          step,
          projectRevision,
          requireContextPack: true,
          checkpointData: { engineeringBaseline: job.engineeringBaseline ?? null },
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
    const revision = await requireDurableProjectRevision(deps.jobs, job.projectId);
    if (["paused", "aborted", "blocked", "failed"].includes(snapshot.project.status)) {
      const status = snapshot.project.status as "paused" | "aborted" | "blocked" | "failed";
      await deps.jobs.settle(job.id, status, revision, terminalReason(status), undefined, canonicalTransition, snapshotChange(revision));
    } else if (snapshot.project.status === "completed") {
      const results = engineeringResults(snapshot, executionId);
      const promotedAt = new Date().toISOString();
      let drafts: ReturnType<typeof buildDurableEngineeringPromotionDrafts>["drafts"] = new Map();
      let claims: ReturnType<typeof buildDurableEngineeringPromotionDrafts>["claims"] = new Map();
      let casClaims: ReturnType<typeof buildDurableEngineeringPromotionDrafts>["casClaims"] = [];
      if (results.length) {
        try {
          const prepared = buildDurableEngineeringPromotionDrafts({
            results,
            baseline: await readEngineeringBaseline(),
            dataRoot: deps.dataRoot,
            jobId: job.id,
            executionId,
            claimOwners: trace.completedOutputClaimOwners()
          });
          drafts = prepared.drafts;
          claims = prepared.claims;
          casClaims = prepared.casClaims;
        } catch (error) {
          const pending = error instanceof DurableEngineeringPromotionMaterializationError ? error.casClaims : casClaims;
          if (pending.length) await deps.jobs.engineering.abortCasClaims(job.id, pending);
          if (!(error instanceof RuntimeRequirementError)) throw error;
          await deps.jobs.settle(job.id, "blocked", revision, error.message, undefined, canonicalTransition, snapshotChange(revision));
          return;
        }
      }
      try {
        terminalPromotions = trace.completedOutputPromotions(promotedAt, drafts, claims);
      } catch (error) {
        if (casClaims.length) await deps.jobs.engineering.abortCasClaims(job.id, casClaims);
        throw error;
      }
      await deps.jobs.finish(job.id, revision, terminalPromotions, canonicalTransition, snapshotChange(revision));
    } else {
      throw new Error(`Research loop handler returned a non-terminal project status: ${snapshot.project.status}`);
    }
  });
}

export function assertPromotionReadyForAction(name: string, inputs: Record<string, unknown>, baseline: ConfigurationBaseline): void {
  const targets = name === "CodexCliTool" ? ["codex"] : normalizeEngineeringProgramRequests(inputs.programRequests).map(engineeringProgramPromotionTarget);
  for (const target of targets) {
    const support = engineeringPromotionRuntimeReceiptSupport(target);
    if (!support.supported || (target !== "codex" && target !== "webxfoil")) {
      throw promotionRuntimeRequirement(target, support.reason ?? `${target} runtime receipt is NOT_READY.`);
    }
    const expectedVersion = target === "codex" ? REQUIRED_CODEX_CLI_VERSION : BUNDLED_WEBXFOIL_VERSION;
    const assessment = validateEngineeringPromotionReadiness(target, baseline, expectedVersion);
    if (!assessment.ready) throw promotionRuntimeRequirement(target, assessment.reason ?? `${target} runtime receipt is NOT_READY.`);
  }
}

function promotionRuntimeRequirement(target: string, message: string): RuntimeRequirementError {
  return new RuntimeRequirementError(ResearchLoopStep.ExecuteTools, [
    {
      key: `engineering.runtimeReceipt.${target}`,
      label: `${target} durable runtime receipt`,
      requiredForSteps: [ResearchLoopStep.ExecuteTools],
      isSatisfied: false,
      message
    }
  ]);
}

function snapshotChange(projectRevision: number) {
  return { snapshotVersion: projectRevision, reason: "job_changed" as const };
}

function engineeringResults(snapshot: Awaited<ReturnType<AetherOpsOrchestrator["getSnapshot"]>>, executionId: string): ResearchToolResult[] {
  return snapshot.toolRuns
    .filter((run) => (run.toolName === "EngineeringProgramTool" || run.toolName === "CodexCliTool") && run.originAttemptId?.startsWith(`${executionId}:`))
    .map((toolRun) => ({
      toolRun,
      sources: snapshot.sources.filter((item) => item.metadata.originToolAttemptId === toolRun.originAttemptId),
      evidence: snapshot.evidence.filter((item) => item.metadata?.originToolAttemptId === toolRun.originAttemptId),
      artifacts: snapshot.artifacts.filter((item) => item.metadata?.originToolAttemptId === toolRun.originAttemptId)
    }));
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
