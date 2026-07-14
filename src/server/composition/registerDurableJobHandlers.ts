import { randomUUID } from "node:crypto";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { EngineeringRequest } from "../../contracts/api-v2/engineering.js";
import { authorizeJobCapabilities } from "../../core/application/capabilities/index.js";
import type { CapabilityKind, CapabilityPolicy } from "../../core/domain/capabilities/types.js";
import { ResearchLoopStep } from "../../core/shared/types.js";
import { createId, nowIso } from "../../core/shared/ids.js";
import type { CodexCliAdapter, EngineeringProgramRequest, ResearchArtifact } from "../../core/shared/types.js";
import type { AetherOpsOrchestrator } from "../../core/orchestration/orchestrator.js";
import { LlmAccessUnavailableError } from "../../core/providers/llm.js";
import type { ToolExecutionContext } from "../../core/tools/researchToolTypes.js";
import { RuntimeRequirementError } from "../../core/tools/runtimeRequirements.js";
import { CodexCliError } from "../runtime/codex/codexCliErrors.js";
import { runEngineeringProgramDirect } from "../http/directEngineering.js";
import { computeProjectRevision } from "../http/v2/common.js";
import { emitChatMessageAppended } from "../http/v2/eventEmitters.js";
import type { AppSettingsStore } from "../runtime/storage/settingsStore.js";
import { CanonicalRunRuntime } from "./canonicalRunRuntime.js";
import { DurableCanonicalRunGateway } from "./durableCanonicalRunGateway.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";
import type { DurableJobRuntime } from "./durableJobRuntime.js";
import type { DurableJobRecord } from "./durableJobTypes.js";
import { createDurableLlmExecution, registerDurableResearchLoopHandler } from "./registerDurableResearchLoopHandler.js";

export { toStorageLlmInvocation, toStorageRunningLlmInvocation } from "./registerDurableResearchLoopHandler.js";

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
      const snapshot = await deps.orchestrator.sendChatMessage(job.projectId, input.sessionId, input.content, createDurableLlmExecution(job, deps.jobs));
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

  registerDurableResearchLoopHandler(deps, canonicalRuntime, canonicalHasher, (job) => createActionAuthorizer(deps, job));

  deps.jobs.registerHandler("engineering_run", async (job, request, context) => {
    const input = request as { requests: EngineeringRequest[] };
    const settings = await deps.settingsStore.getRuntimeSettings();
    const codexRequests = input.requests.filter((item) => item.target === "codex");
    const engineeringRequests = input.requests.filter((item) => item.target !== "codex");
    let engineeringError: string | undefined;
    if (engineeringRequests.length) {
      const result = await runEngineeringProgramDirect(
        {
          projectId: job.projectId,
          title: "Engineering job",
          programRequests: engineeringRequests.map(toProgramRequest)
        },
        settings,
        deps.orchestrator
      );
      if (result.status !== "completed") engineeringError = result.error ?? "Engineering adapter failed without an output.";
    }
    for (const codexRequest of codexRequests) {
      try {
        await runExplicitCodexRequest(job, codexRequest, deps, context.signal);
      } catch (error) {
        if (!(error instanceof RuntimeRequirementError) && !(error instanceof CodexCliError && ["NOT_READY", "ENTITLEMENT_UNAVAILABLE"].includes(error.kind)))
          throw error;
        engineeringError = error.message;
        break;
      }
    }
    const revision = computeProjectRevision(await deps.orchestrator.getSnapshot(job.projectId));
    if (!engineeringError) {
      await deps.jobs.finish(job.id, revision);
      return;
    }
    const reason = engineeringError;
    if (/blocked|denied|disabled|not configured|not available|not enforceable|not ready|does not exist|requires/i.test(reason)) {
      await deps.jobs.settle(job.id, "blocked", revision, reason);
      return;
    }
    throw new Error(reason);
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

function unsupportedEngineeringTarget(target: never): never {
  throw new Error(`Unsupported engineering target: ${String(target)}`);
}

async function runExplicitCodexRequest(
  job: import("./durableJobTypes.js").DurableJobRecord,
  request: EngineeringRequest,
  deps: HandlerDependencies,
  signal: AbortSignal
): Promise<void> {
  if (request.target !== "codex") throw new Error("Explicit Codex CLI handler received a non-Codex request.");
  const requiredCapabilities: CapabilityKind[] = ["agent", "engineering"];
  await createActionAuthorizer(deps, job)({ name: "CodexCliTool", requiredCapabilities });
  if (!job.effectiveCapabilities?.agent || !job.effectiveCapabilities.engineering) {
    throw new Error("Codex CLI requires effective Agent and Engineering capabilities for this job.");
  }
  if (containsRemoteUrl(request.objective) || containsRemoteUrl(request.inputs)) {
    throw new Error("Codex CLI network access is disabled; acquire remote inputs as validated artifacts first.");
  }
  const snapshot = await deps.orchestrator.getSnapshot(job.projectId);
  const inputArtifactIds = stringArray(request.inputs.inputArtifactIds, "inputArtifactIds", 32);
  const outputs = outputDeclarations(request.inputs.outputs);
  const inputArtifacts = inputArtifactIds.map((id) => {
    const artifact = snapshot.artifacts.find((item) => item.id === id);
    const hash = artifact?.metadata?.sha256;
    if (!artifact?.rawPath || typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)) {
      throw new Error(`Codex CLI input artifact is unavailable or unverified: ${id}`);
    }
    return { id, sourcePath: artifact.rawPath, sha256: hash.toLowerCase() };
  });
  const executionId = createId("codex-execution");
  const stagingRoot = resolve(deps.dataRoot, "staging", "jobs", job.id, executionId);
  const readyRoot = resolve(deps.dataRoot, "ready", "jobs", job.id, executionId);
  const quarantineRoot = resolve(deps.dataRoot, "quarantine", "jobs", job.id, executionId);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  try {
    const settings = await deps.settingsStore.getRuntimeSettings();
    const output = await deps.codexCli.run({
      actionRoot: stagingRoot,
      input: { task: request.objective, inputArtifactIds, outputs },
      artifacts: inputArtifacts,
      settings: settings.codex,
      signal
    });
    await moveExecutionWorkspace(stagingRoot, readyRoot);
    const artifacts: ResearchArtifact[] = output.outputs.map((item) => ({
      id: createId("artifact"),
      projectId: job.projectId,
      category: "generated_artifact",
      title: item.relativePath.split("/").at(-1) ?? item.relativePath,
      relativePath: item.relativePath,
      rawPath: resolve(readyRoot, "workspace", "outputs", item.relativePath),
      mimeType: item.relativePath.endsWith(".json") ? "application/json" : item.relativePath.endsWith(".md") ? "text/markdown" : "text/plain",
      summary: output.summary,
      metadata: { sha256: item.sha256, bytes: item.bytes, originTool: "CodexCliTool", codexCliTrace: output.trace },
      createdAt: nowIso()
    }));
    try {
      for (const artifact of artifacts) await deps.orchestrator.storeArtifact(job.projectId, artifact);
    } catch (error) {
      await moveExecutionWorkspace(readyRoot, quarantineRoot);
      throw error;
    }
  } catch (error) {
    if (await pathExists(stagingRoot)) await moveExecutionWorkspace(stagingRoot, quarantineRoot);
    throw error;
  }
}

function stringArray(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`Codex CLI ${label} must be an array with at most ${maximum} entries.`);
  const result = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`Codex CLI ${label} entries must be non-empty strings.`);
    return item.trim();
  });
  if (new Set(result).size !== result.length) throw new Error(`Codex CLI ${label} entries must be unique.`);
  return result;
}

function outputDeclarations(value: unknown): Array<{ relativePath: string; kind: "code" | "report" | "data" }> {
  if (!Array.isArray(value) || !value.length || value.length > 16) throw new Error("Codex CLI outputs must contain 1-16 declarations.");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Codex CLI output declaration must be an object.");
    const record = item as Record<string, unknown>;
    if (typeof record.relativePath !== "string" || !record.relativePath.trim()) throw new Error("Codex CLI output relativePath is required.");
    if (record.kind !== "code" && record.kind !== "report" && record.kind !== "data") throw new Error("Codex CLI output kind is invalid.");
    return { relativePath: record.relativePath.trim(), kind: record.kind };
  });
}

async function moveExecutionWorkspace(source: string, target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await mkdir(resolve(target, ".."), { recursive: true });
  await rename(source, target);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function containsRemoteUrl(value: unknown): boolean {
  if (typeof value === "string") return /https?:\/\//i.test(value);
  if (Array.isArray(value)) return value.some(containsRemoteUrl);
  return Boolean(value && typeof value === "object" && Object.values(value as Record<string, unknown>).some(containsRemoteUrl));
}
