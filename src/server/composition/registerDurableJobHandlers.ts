import { randomUUID } from "node:crypto";
import type { EngineeringRequest } from "../../contracts/api-v2/engineering.js";
import { authorizeJobCapabilities } from "../../core/application/capabilities/index.js";
import type { CapabilityKind, CapabilityPolicy } from "../../core/domain/capabilities/types.js";
import { ResearchLoopStep } from "../../core/shared/types.js";
import { nowIso } from "../../core/shared/ids.js";
import type { CodexCliAdapter } from "../../core/shared/types.js";
import type { AetherOpsOrchestrator } from "../../core/orchestration/orchestrator.js";
import { LlmAccessUnavailableError } from "../../core/providers/llm.js";
import type { ToolExecutionContext } from "../../core/tools/researchToolTypes.js";
import { RuntimeRequirementError } from "../../core/tools/runtimeRequirements.js";
import { emitChatMessageAppended } from "../http/v2/eventEmitters.js";
import type { AppSettingsStore } from "../runtime/storage/settingsStore.js";
import { CanonicalRunRuntime } from "./canonicalRunRuntime.js";
import { DurableCanonicalRunGateway } from "./durableCanonicalRunGateway.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";
import { executeDurableEngineeringJob } from "./durableEngineeringJobHandler.js";
import type { DurableJobRuntime } from "./durableJobRuntime.js";
import type { DurableJobRecord } from "./durableJobTypes.js";
import { createDurableLlmExecution, registerDurableResearchLoopHandler } from "./registerDurableResearchLoopHandler.js";
import { requireDurableProjectRevision } from "./durableProjectRevision.js";

export { toStorageLlmInvocation, toStorageRunningLlmInvocation } from "./registerDurableResearchLoopHandler.js";
export { toProgramRequest } from "./durableEngineeringJobHandler.js";

interface HandlerDependencies {
  dataRoot: string;
  orchestrator: AetherOpsOrchestrator;
  settingsStore: AppSettingsStore;
  jobs: DurableJobRuntime;
  events: DurableJobRuntime;
  codexCli: CodexCliAdapter;
  canonicalRuntime?: CanonicalRunRuntime;
}

export function registerDurableJobHandlers(deps: HandlerDependencies): void {
  const canonicalHasher = { sha256Canonical: durableJobRequestHash };
  const canonicalRuntime = deps.canonicalRuntime ?? new CanonicalRunRuntime({ gateway: new DurableCanonicalRunGateway(deps.jobs), hasher: canonicalHasher });

  deps.jobs.registerHandler("chat_reply", async (job, request) => {
    const input = request as { sessionId: string; content: string; clientMutationId: string };
    try {
      await deps.orchestrator.sendChatMessage(job.projectId, input.sessionId, input.content, createDurableLlmExecution(job, deps.jobs));
      await emitChatMessageAppended(
        deps.events,
        job.projectId,
        await requireDurableProjectRevision(deps.jobs, job.projectId),
        input.sessionId,
        input.content,
        input.clientMutationId,
        job.createdAt
      );
      await deps.jobs.finish(job.id, await requireDurableProjectRevision(deps.jobs, job.projectId));
    } catch (error) {
      if (error instanceof LlmAccessUnavailableError) {
        const revision = await requireDurableProjectRevision(deps.jobs, job.projectId);
        await deps.jobs.settle(job.id, "blocked", revision, error.message);
        return;
      }
      throw error;
    }
  });

  registerDurableResearchLoopHandler(deps, canonicalRuntime, canonicalHasher, (job) => createActionAuthorizer(deps, job));

  deps.jobs.registerHandler("engineering_run", async (job, request, context) => {
    const input = request as {
      requests: EngineeringRequest[];
      configurationBaseline: { id: string; revision: number; contentHash: string };
    };
    try {
      const completed = await executeDurableEngineeringJob(job, input.requests, input.configurationBaseline, context, {
        dataRoot: deps.dataRoot,
        orchestrator: deps.orchestrator,
        settingsStore: deps.settingsStore,
        jobs: deps.jobs,
        codexCli: deps.codexCli,
        authorizeAction: createActionAuthorizer(deps, job)
      });
      await deps.jobs.finish(job.id, completed.projectRevision, completed.promotions);
      return;
    } catch (error) {
      context.signal.throwIfAborted();
      const reason = engineeringBlockedReason(error);
      if (!reason) throw error;
      const revision = await requireDurableProjectRevision(deps.jobs, job.projectId);
      await deps.jobs.settle(job.id, "blocked", revision, reason);
    }
  });
}

function createActionAuthorizer(deps: HandlerDependencies, job: DurableJobRecord): NonNullable<ToolExecutionContext["authorizeAction"]> {
  return async (action): Promise<CapabilityPolicy> => {
    const [settings, snapshot] = await Promise.all([deps.settingsStore.getRuntimeSettings(), deps.orchestrator.getSnapshot(job.projectId)]);
    const requested = job.requestedCapabilities ?? job.effectiveCapabilities ?? { agent: false, engineering: false, search: false };
    const authorization = authorizeJobCapabilities({
      app: { agent: settings.allowAgent, engineering: settings.allowCodeExecution, search: settings.allowExternalSearch },
      project: {
        agent: snapshot.project.autonomyPolicy.allowAgent ?? true,
        engineering: snapshot.project.autonomyPolicy.allowCodeExecution,
        search: snapshot.project.autonomyPolicy.allowExternalSearch
      },
      job: requested,
      jobKind: job.kind,
      projectId: job.projectId,
      jobId: job.id,
      recordedAt: nowIso()
    });
    await deps.jobs.recordCapabilityAudits(
      authorization.audits.map((audit) => ({
        id: randomUUID(),
        projectId: audit.projectId,
        jobId: job.id,
        operation: audit.kind,
        capability: audit.kind,
        appAllowed: audit.appAllowed,
        projectAllowed: audit.projectAllowed,
        operationAllowed: audit.jobAllowed,
        allowed: audit.allowed,
        reason: audit.reason,
        data: { jobKind: audit.jobKind, blockedBy: audit.blockedBy },
        auditedAt: audit.recordedAt
      }))
    );
    const denied = action.requiredCapabilities.filter((capability: CapabilityKind) => !authorization.decisions[capability].allowed);
    if (denied.length) {
      const step = action.name === "research-planner" ? ResearchLoopStep.PlanResearch : ResearchLoopStep.ExecuteTools;
      throw new RuntimeRequirementError(
        step,
        denied.map((capability) => ({
          key: `capability.${capability}`,
          label: `${capability} capability`,
          requiredForSteps: [step],
          isSatisfied: false,
          message: `${action.name} is blocked because ${capability} capability was denied after enqueue.`
        }))
      );
    }
    return {
      agent: authorization.decisions.agent.allowed,
      engineering: authorization.decisions.engineering.allowed,
      search: authorization.decisions.search.allowed
    };
  };
}

function engineeringBlockedReason(error: unknown): string | undefined {
  const failure = error && typeof error === "object" && "failure" in error ? (error as { failure?: unknown }).failure : error;
  if (failure instanceof RuntimeRequirementError) return failure.message;
  const message = failure instanceof Error ? failure.message : String(failure);
  return /blocked|denied|disabled|not configured|not available|not enforceable|not ready|does not exist|requires/i.test(message) ? message : undefined;
}
