import type { EngineeringRequest } from "../../contracts/api-v2/engineering.js";
import type { EngineeringProgramRequest } from "../../core/shared/types.js";
import type { AetherOpsOrchestrator } from "../../core/orchestration/orchestrator.js";
import { LlmAccessUnavailableError } from "../../core/providers/llm.js";
import { runEngineeringProgramDirect } from "../http/directEngineering.js";
import { computeProjectRevision } from "../http/v2/common.js";
import { emitChatMessageAppended, emitProjectSnapshotChanged } from "../http/v2/eventEmitters.js";
import type { AppSettingsStore } from "../runtime/storage/settingsStore.js";
import type { DurableJobRuntime } from "./durableJobRuntime.js";

interface HandlerDependencies {
  orchestrator: AetherOpsOrchestrator;
  settingsStore: AppSettingsStore;
  jobs: DurableJobRuntime;
  events: DurableJobRuntime;
}

export function registerDurableJobHandlers(deps: HandlerDependencies): void {
  deps.jobs.registerHandler("chat_reply", async (job, request) => {
    const input = request as { sessionId: string; content: string; clientMutationId: string };
    try {
      const snapshot = await deps.orchestrator.sendChatMessage(job.projectId, input.sessionId, input.content);
      await emitChatMessageAppended(deps.events, job.projectId, computeProjectRevision(snapshot), input.sessionId, input.content, input.clientMutationId);
      await deps.jobs.finish(job.id, computeProjectRevision(snapshot));
    } catch (error) {
      if (error instanceof LlmAccessUnavailableError) {
        const revision = computeProjectRevision(await deps.orchestrator.getSnapshot(job.projectId));
        await deps.jobs.settle(job.id, "blocked", revision, error.message);
        return;
      }
      throw error;
    }
  });

  deps.jobs.registerHandler("research_loop", async (job, request) => {
    const action = (request as { action?: string } | undefined)?.action;
    const snapshot = action === "resume" ? await deps.orchestrator.resume(job.projectId) : await deps.orchestrator.startLoop(job.projectId);
    const revision = computeProjectRevision(snapshot);
    if (["paused", "aborted", "blocked", "failed"].includes(snapshot.project.status)) {
      await deps.jobs.settle(job.id, snapshot.project.status as "paused" | "aborted" | "blocked" | "failed", revision);
    } else {
      await deps.jobs.finish(job.id, revision);
    }
    await emitProjectSnapshotChanged(deps.events, snapshot, "job_changed");
  });

  deps.jobs.registerHandler("engineering_run", async (job, request) => {
    const input = request as { requests: EngineeringRequest[] };
    const settings = await deps.settingsStore.getRuntimeSettings();
    const result = await runEngineeringProgramDirect(
      {
        projectId: job.projectId,
        title: "Engineering job",
        programRequests: input.requests.map(toProgramRequest)
      },
      settings,
      deps.orchestrator
    );
    const revision = computeProjectRevision(await deps.orchestrator.getSnapshot(job.projectId));
    if (result.status === "completed") {
      await deps.jobs.finish(job.id, revision);
      return;
    }
    const reason = result.error ?? "Engineering adapter failed without an output.";
    if (/disabled|not configured|not available|does not exist|requires/i.test(reason)) {
      await deps.jobs.settle(job.id, "blocked", revision, reason);
      return;
    }
    throw new Error(reason);
  });
}

function toProgramRequest(request: EngineeringRequest): EngineeringProgramRequest {
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
              : "mesh-inspect";
  return { ...request.inputs, kind, target, reason: request.objective } as EngineeringProgramRequest;
}
