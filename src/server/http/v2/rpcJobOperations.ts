import { randomUUID } from "node:crypto";
import type { ApiV2RpcRequest } from "../../../contracts/api-v2/rpc.js";
import type { JobKind } from "../../../contracts/api-v2/jobs.js";
import { authorizeJobCapabilities, defaultJobCapabilityPolicy, type CapabilityPolicy } from "../../../core/application/capabilities/index.js";
import { ResearchLoopStep } from "../../../core/shared/types.js";
import type { ResearchProject } from "../../../core/shared/types.js";
import type { StorageCapabilityAudit } from "../../runtime/storage/v2/types.js";
import { canonicalResearchStartPayload } from "../../composition/canonicalResearchEnqueue.js";
import { durablePublicJobRequestHash } from "../../composition/durableJobRequestHash.js";
import type { DurableJobReceipt } from "../../composition/durableJobTypes.js";
import type { RpcHandlerContext } from "./context.js";
import { projectCapabilities } from "./projectResponses.js";
import { requireStoredProjectRevision } from "./projectRevision.js";
import { RpcCapabilityDeniedError, RpcConflictError, RpcNotReadyError } from "./rpcErrors.js";

export async function enqueueRpcJob(
  context: RpcHandlerContext,
  projectId: string,
  kind: JobKind,
  idempotencyKey: string,
  requestHash: string,
  payload: unknown,
  requestedCapabilities?: Partial<CapabilityPolicy>,
  resumesJobId?: string,
  resumeCheckpointId?: string,
  expectedProjectRevision?: number
) {
  context.projectMutations.assertReadable(projectId);
  const [snapshot, settings, projectRevision] = await Promise.all([
    context.orchestrator.getSnapshot(projectId),
    context.settingsStore.getRuntimeSettings(),
    requireStoredProjectRevision(context.jobs, projectId)
  ]);
  if (expectedProjectRevision !== undefined && projectRevision !== expectedProjectRevision) {
    throw new RpcConflictError("Project revision changed.");
  }
  const defaultCapabilities = defaultJobCapabilityPolicy(kind);
  const requestedPolicy = {
    agent: requestedCapabilities?.agent ?? defaultCapabilities.agent,
    engineering: requestedCapabilities?.engineering ?? defaultCapabilities.engineering,
    search: requestedCapabilities?.search ?? defaultCapabilities.search
  };
  const authorization = authorizeJobCapabilities({
    app: { agent: settings.allowAgent, engineering: Boolean(settings.allowCodeExecution), search: Boolean(settings.allowExternalSearch) },
    project: projectCapabilities(snapshot.project),
    jobKind: kind,
    job: requestedPolicy,
    projectId,
    recordedAt: new Date().toISOString()
  });
  if (!authorization.allowed) {
    await context.jobs.recordCapabilityAudits(toStorageAudits(authorization.audits), snapshot.project);
    const denied = authorization.requiredCapabilityKinds.filter((capability) => !authorization.decisions[capability].allowed);
    throw new RpcCapabilityDeniedError(`Required capabilities are denied: ${denied.join(", ")}.`, { denied });
  }
  const effectiveCapabilities = {
    agent: authorization.decisions.agent.allowed,
    engineering: authorization.decisions.engineering.allowed,
    search: authorization.decisions.search.allowed
  };
  const toolPolicy =
    kind === "research_loop" && payload && typeof payload === "object" && "toolPolicy" in payload
      ? (payload as { toolPolicy: NonNullable<Parameters<typeof context.jobs.enqueue>[0]["toolPolicy"]> }).toolPolicy
      : undefined;
  const canonicalPayload =
    kind === "research_loop" && payload && typeof payload === "object" && (payload as { action?: unknown }).action === "start" && toolPolicy
      ? canonicalResearchStartPayload({
          snapshot,
          payload: payload as Record<string, unknown>,
          requestedCapabilities: requestedPolicy,
          effectiveCapabilities,
          toolPolicy
        })
      : payload;
  const persistedPayload =
    kind === "research_loop" && canonicalPayload && typeof canonicalPayload === "object" && !Array.isArray(canonicalPayload)
      ? {
          ...(canonicalPayload as Record<string, unknown>),
          engineeringBaseline: await researchEngineeringBaselineBinding(context, projectId, resumesJobId)
        }
      : canonicalPayload;
  const jobId = randomUUID();
  const capabilityAudits = toStorageAudits(authorization.audits, jobId);
  return context.jobs.enqueue({
    jobId,
    projectId,
    project: snapshot.project,
    kind,
    projectRevision,
    currentStep: kind === "engineering_run" ? ResearchLoopStep.ExecuteTools : snapshot.project.currentStep,
    idempotencyKey,
    requestHash,
    requestedCapabilities: requestedPolicy,
    effectiveCapabilities,
    capabilityAudits,
    ...(toolPolicy ? { toolPolicy } : {}),
    resumesJobId,
    resumeCheckpointId,
    payload: persistedPayload
  });
}

async function researchEngineeringBaselineBinding(
  context: RpcHandlerContext,
  projectId: string,
  resumesJobId: string | undefined
): Promise<{ id: string; revision: number; contentHash: string } | null> {
  if (resumesJobId) {
    const predecessor = await context.jobs.get(resumesJobId);
    if (!predecessor || predecessor.projectId !== projectId) throw new RpcNotReadyError("Research resume predecessor is unavailable.");
    if (predecessor.engineeringBaseline === undefined) {
      throw new RpcNotReadyError("Legacy research jobs without a frozen engineering baseline require a new research start.");
    }
    return predecessor.engineeringBaseline;
  }
  const baseline = await context.jobs.engineering.activeBaseline(projectId);
  return baseline ? { id: baseline.id, revision: baseline.revision, contentHash: baseline.contentHash } : null;
}

type EnqueueRpcRequest = Extract<ApiV2RpcRequest, { method: "chat.enqueue" | "loop.start" | "loop.resume" | "engineering.enqueue" }>;

export async function idempotentRpcEnqueue(
  context: RpcHandlerContext,
  request: EnqueueRpcRequest,
  create: (requestHash: string) => Promise<DurableJobReceipt>
): Promise<DurableJobReceipt> {
  const requestHash = durablePublicJobRequestHash(request);
  const existing = await context.jobs.findIdempotentReceipt(request.params.projectId, request.params.idempotencyKey, requestHash);
  return existing ?? create(requestHash);
}

export async function assertRequestedCapabilities(
  context: RpcHandlerContext,
  projectId: string,
  kind: JobKind,
  requestedCapabilities: CapabilityPolicy
): Promise<void> {
  const authorization = await authorizeRequestedCapabilities(context, projectId, kind, requestedCapabilities);
  await context.jobs.recordCapabilityAudits(authorization.audits, authorization.project);
  if (!authorization.allowed) {
    throw new RpcCapabilityDeniedError(`Required capabilities are denied: ${authorization.denied.join(", ")}.`, {
      denied: authorization.denied
    });
  }
}

export interface RequestedCapabilityAuthorization {
  project: ResearchProject;
  projectRevision: number;
  audits: StorageCapabilityAudit[];
  allowed: boolean;
  denied: string[];
}

export async function authorizeRequestedCapabilities(
  context: RpcHandlerContext,
  projectId: string,
  kind: JobKind,
  requestedCapabilities: CapabilityPolicy
): Promise<RequestedCapabilityAuthorization> {
  const [{ snapshot, projectRevision }, settings] = await Promise.all([
    context.projectMutations.readSnapshot(projectId),
    context.settingsStore.getRuntimeSettings()
  ]);
  const authorization = authorizeJobCapabilities({
    app: { agent: settings.allowAgent, engineering: settings.allowCodeExecution, search: settings.allowExternalSearch },
    project: projectCapabilities(snapshot.project),
    jobKind: kind,
    job: requestedCapabilities,
    projectId,
    recordedAt: new Date().toISOString()
  });
  const denied = authorization.requiredCapabilityKinds.filter((capability) => !authorization.decisions[capability].allowed);
  return {
    project: snapshot.project,
    projectRevision,
    audits: toStorageAudits(authorization.audits, undefined, projectRevision),
    allowed: authorization.allowed,
    denied
  };
}

function toStorageAudits(audits: ReturnType<typeof authorizeJobCapabilities>["audits"], jobId?: string, projectRevision?: number): StorageCapabilityAudit[] {
  return audits.map((audit) => ({
    id: randomUUID(),
    projectId: audit.projectId,
    jobId,
    operation: audit.kind,
    capability: audit.kind,
    appAllowed: audit.appAllowed,
    projectAllowed: audit.projectAllowed,
    operationAllowed: audit.jobAllowed,
    allowed: audit.allowed,
    reason: audit.reason,
    data: { jobKind: audit.jobKind, blockedBy: audit.blockedBy, ...(projectRevision === undefined ? {} : { projectRevision }) },
    auditedAt: audit.recordedAt
  }));
}
