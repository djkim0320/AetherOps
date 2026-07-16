import type { EngineeringRequest } from "../../contracts/api-v2/engineering.js";
import type { AetherOpsOrchestrator } from "../../core/orchestration/orchestrator.js";
import { nowIso } from "../../core/shared/ids.js";
import { ResearchLoopStep } from "../../core/shared/types.js";
import type { AppSettings, CodexCliAdapter, EngineeringProgramRequest, ResearchPlan, ResearchToolInput } from "../../core/shared/types.js";
import { CodexCliTool } from "../../core/tools/codexCliTool.js";
import { EngineeringProgramTool } from "../../core/tools/engineeringProgramTool.js";
import type { ToolExecutionContext } from "../../core/tools/researchToolTypes.js";
import { ToolRunner } from "../../core/tools/toolRunner.js";
import { runEngineeringProgram } from "../runtime/engineering/engineeringProgramRegistry.js";
import type { AppSettingsStore } from "../runtime/storage/settingsStore.js";
import { FileToolExecutionWorkspace } from "../runtime/tools/toolExecutionWorkspace.js";
import type { DurableJobRuntime } from "./durableJobRuntime.js";
import type { DurableJobHandlerContext, DurableJobRecord } from "./durableJobTypes.js";
import { DurableToolExecutionAdapter } from "./durableToolExecutionAdapter.js";
import { buildDurableEngineeringPromotionDrafts, DurableEngineeringPromotionMaterializationError } from "./durableEngineeringPromotionDrafts.js";
import { assertBoundEngineeringBaseline } from "./engineeringBaselineBinding.js";
import { validateEngineeringPromotionReadiness, type EngineeringBaselineTarget } from "../../core/aerospace/engineeringBaselineCompatibility.js";
import { RuntimeRequirementError } from "../../core/tools/runtimeRequirements.js";
import { REQUIRED_CODEX_CLI_VERSION } from "../runtime/codex/bundledCodexCli.js";
import { BUNDLED_WEBXFOIL_VERSION } from "../runtime/engineering/engineeringRuntimeVersions.js";
import { requireDurableProjectRevision } from "./durableProjectRevision.js";

interface DurableEngineeringJobDependencies {
  dataRoot: string;
  orchestrator: AetherOpsOrchestrator;
  settingsStore: AppSettingsStore;
  jobs: DurableJobRuntime;
  codexCli: CodexCliAdapter;
  authorizeAction: NonNullable<ToolExecutionContext["authorizeAction"]>;
}

export async function executeDurableEngineeringJob(
  job: DurableJobRecord,
  requests: EngineeringRequest[],
  expectedBaseline: { id: string; revision: number; contentHash: string },
  context: DurableJobHandlerContext,
  deps: DurableEngineeringJobDependencies
): Promise<{
  projectRevision: number;
  promotions: ReturnType<DurableToolExecutionAdapter["completedOutputPromotions"]>;
}> {
  context.signal.throwIfAborted();
  const [snapshot, settings, baseline] = await Promise.all([
    deps.orchestrator.getSnapshot(job.projectId),
    deps.settingsStore.getRuntimeSettings(),
    deps.jobs.engineering.activeBaseline(job.projectId)
  ]);
  const verifiedBaseline = assertBoundEngineeringBaseline(expectedBaseline, baseline);
  const incompatible = requests
    .map((request) => validateEngineeringPromotionReadiness(request.target, verifiedBaseline, pinnedRuntimeVersion(request.target)))
    .filter((item) => !item.ready);
  if (incompatible.length) {
    throw new RuntimeRequirementError(
      ResearchLoopStep.ExecuteTools,
      incompatible.map((item) => ({
        key: `engineering.configurationBaseline.${item.target}`,
        label: `${item.target} configuration baseline`,
        requiredForSteps: [ResearchLoopStep.ExecuteTools],
        isSatisfied: false,
        message: item.reason ?? `The active configuration baseline is not compatible with ${item.target}.`
      }))
    );
  }
  const plan = engineeringExecutionPlan(job, requests);
  const includesCodex = plan.requiredTools.includes("CodexCliTool");
  const tools = [
    ...(includesCodex ? [new CodexCliTool(deps.codexCli)] : []),
    ...(plan.requiredTools.includes("EngineeringProgramTool") ? [new EngineeringProgramTool(runEngineeringProgram)] : [])
  ];
  const trace = new DurableToolExecutionAdapter(job, deps.jobs, () => requireDurableProjectRevision(deps.jobs, job.projectId));
  const executionSettings: AppSettings = {
    ...settings,
    allowCodeExecution: Boolean(settings.allowCodeExecution && snapshot.project.autonomyPolicy.allowCodeExecution),
    allowExternalSearch: false
  };
  const input: ResearchToolInput = {
    project: { ...snapshot.project, currentStep: ResearchLoopStep.ExecuteTools, status: "running" },
    questions: snapshot.questions,
    hypotheses: snapshot.hypotheses,
    evidence: [],
    artifacts: snapshot.artifacts,
    sources: [],
    researchPlan: plan,
    iteration: Math.max(snapshot.researchPlans.length + 1, 1)
  };
  const execution: ToolExecutionContext = {
    jobId: job.id,
    executionId: `engineering-execution-${job.id}`,
    idempotencyKey: job.idempotencyKey,
    allowCodexCli: includesCodex,
    ...(job.effectiveCapabilities ? { effectiveCapabilities: job.effectiveCapabilities } : {}),
    authorizeAction: deps.authorizeAction,
    toolPolicy: { allowCodexCli: includesCodex, sourceAccess: { mode: "offline" } },
    signal: context.signal,
    onStatus: trace.onStatus
  };
  const runner = new ToolRunner(tools, new FileToolExecutionWorkspace(deps.dataRoot));
  const results = await runner.execute(input, executionSettings, { execution });
  context.signal.throwIfAborted();
  const promotedAt = nowIso();
  let casClaims: ReturnType<typeof buildDurableEngineeringPromotionDrafts>["casClaims"] = [];
  try {
    const prepared = buildDurableEngineeringPromotionDrafts({
      results,
      baseline: verifiedBaseline,
      dataRoot: deps.dataRoot,
      jobId: job.id,
      executionId: execution.executionId as string,
      claimOwners: trace.completedOutputClaimOwners()
    });
    casClaims = prepared.casClaims;
    return {
      projectRevision: await requireDurableProjectRevision(deps.jobs, job.projectId),
      promotions: trace.completedOutputPromotions(promotedAt, prepared.drafts, prepared.claims)
    };
  } catch (error) {
    const pending = error instanceof DurableEngineeringPromotionMaterializationError ? error.casClaims : casClaims;
    if (pending.length) await abortMaterializedEngineeringOutputs(deps.jobs, job.id, pending, error);
    throw error;
  }
}

function pinnedRuntimeVersion(target: EngineeringBaselineTarget): string | undefined {
  if (target === "webxfoil") return BUNDLED_WEBXFOIL_VERSION;
  if (target === "codex") return REQUIRED_CODEX_CLI_VERSION;
  return undefined;
}

async function abortMaterializedEngineeringOutputs(
  jobs: DurableJobRuntime,
  jobId: string,
  claims: ReturnType<typeof buildDurableEngineeringPromotionDrafts>["casClaims"],
  original: unknown
): Promise<void> {
  try {
    await jobs.engineering.abortCasClaims(jobId, claims);
  } catch (cleanupError) {
    throw new AggregateError([original, cleanupError], "Engineering promotion failed and its pending CAS claims could not be aborted.", {
      cause: cleanupError
    });
  }
}

export function toProgramRequest(request: EngineeringRequest): EngineeringProgramRequest {
  if (request.target === "codex") throw new Error("Codex requests must use the explicit Codex CLI handler.");
  const target = request.target === "webxfoil" ? "xfoil-wasm" : request.target === "mesh" ? "modeling" : request.target;
  const kind =
    request.target === "webxfoil"
      ? "xfoil-wasm-polar"
      : request.target === "xfoil"
        ? "xfoil-polar"
        : request.target === "su2"
          ? "su2-case-run"
          : request.target === "openvsp"
            ? "openvsp-analysis-run"
            : request.target === "xflr5"
              ? "xflr5-analysis-run"
              : request.target === "mesh"
                ? "mesh-inspect"
                : unsupportedEngineeringTarget(request.target);
  return { ...request.inputs, kind, target, reason: request.objective } as EngineeringProgramRequest;
}

function engineeringExecutionPlan(job: DurableJobRecord, requests: EngineeringRequest[]): ResearchPlan {
  const createdAt = nowIso();
  const toolRequests = requests.map((request, index) => {
    const toolName = request.target === "codex" ? "CodexCliTool" : "EngineeringProgramTool";
    if (request.target === "codex" && (containsRemoteUrl(request.objective) || containsRemoteUrl(request.inputs))) {
      throw new Error("Codex CLI network access is disabled; acquire remote inputs as validated artifacts first.");
    }
    return {
      intentId: `engineering-${job.id}-${String(index).padStart(2, "0")}`,
      toolName,
      purpose: request.objective,
      expectedOutcome: `${request.target} returns a validated terminal receipt or an explicit failure.`,
      inputs: request.target === "codex" ? { ...request.inputs, task: request.objective } : { programRequests: [toProgramRequest(request)] }
    };
  });
  const requiredTools = [...new Set(toolRequests.map((request) => request.toolName))];
  return {
    id: `engineering-plan-${job.id}`,
    projectId: job.projectId,
    iteration: 1,
    objective: "Execute the explicitly requested engineering actions without tool substitution.",
    targetQuestions: [],
    targetHypotheses: [],
    requiredTools,
    toolRequests,
    expectedSources: [],
    expectedArtifacts: requests.map((request) => `${request.target} validated output`),
    executionSteps: toolRequests.map((request) => `Execute ${request.toolName}: ${request.intentId}.`),
    stopCriteria: ["Every action is terminal and every promoted output has a verified origin receipt."],
    createdAt
  };
}

function unsupportedEngineeringTarget(target: never): never {
  throw new Error(`Unsupported engineering target: ${String(target)}`);
}

function containsRemoteUrl(value: unknown): boolean {
  if (typeof value === "string") return /https?:\/\//i.test(value);
  if (Array.isArray(value)) return value.some(containsRemoteUrl);
  return Boolean(value && typeof value === "object" && Object.values(value as Record<string, unknown>).some(containsRemoteUrl));
}
