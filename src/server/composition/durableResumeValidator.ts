import { getToolDescriptor } from "../../core/tools/toolDescriptors.js";
import { plannerToolInputContract } from "../../core/planning/plannerContextPack.js";
import { budgetUsageDelta, budgetUsageEqual, exhaustedBudgetDimensions, hasBudgetUsage } from "../../core/orchestration/budgetAccounting.js";
import type { RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import { parseStoredContextPack, parseStoredRunStateRevision, storageCanonicalHasher } from "../runtime/storage/v2/runStatePayloadValidator.js";
import type { StorageContextPack, StorageRunOwnership, StorageRunStateRevision } from "../runtime/storage/v2/runStateTypes.js";
import type { StorageCheckpoint, StorageJob } from "../runtime/storage/v2/types.js";
import type { StorageLlmInvocation, StorageToolAttempt, StorageToolDecision } from "../runtime/storage/v2/traceTypes.js";
import { parseCanonicalInitializationAnchor } from "./canonicalInitializationAnchor.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";
import type { EnqueueDurableJob } from "./durableJobTypes.js";
import { assertToolAttemptResumeSafe } from "./durableSideEffectPolicy.js";
import { observeCanonicalBudget, type CanonicalBudgetTracePort } from "./canonicalBudgetAccounting.js";
import type { DurableJobRecord } from "./durableJobTypes.js";

const MAX_TRACE_ATTEMPTS = 1_000;
const MAX_RESUME_LINEAGE = 64;

export type DurableResumeValidationCode = "VALIDATION_ERROR" | "CONFLICT" | "NOT_READY";

export class DurableResumeValidationError extends Error {
  constructor(
    readonly code: DurableResumeValidationCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "DurableResumeValidationError";
  }
}

export async function assertDurableResumeSource(client: StorageWorkerClient, input: EnqueueDurableJob): Promise<void> {
  if (!input.resumesJobId) invalid("Resume requires an explicit predecessor job.");
  if (!input.resumeCheckpointId) return assertCheckpointFreeBootstrap(client, input);
  const [checkpoint, source, latestCheckpoint] = await Promise.all([
    client.request<StorageCheckpoint | undefined>({ name: "checkpoint.get", checkpointId: input.resumeCheckpointId }),
    client.request<StorageJob | undefined>({ name: "job.get", jobId: input.resumesJobId }),
    client.request<StorageCheckpoint | undefined>({ name: "checkpoint.latestCommittedForJob", jobId: input.resumesJobId })
  ]);
  if (
    !checkpoint ||
    checkpoint.id !== latestCheckpoint?.id ||
    checkpoint.status !== "committed" ||
    checkpoint.projectId !== input.projectId ||
    checkpoint.jobId !== source?.id ||
    source.projectId !== input.projectId ||
    source.operation !== input.kind ||
    !["paused", "interrupted", "blocked", "failed"].includes(source.status)
  ) {
    conflict("Resume requires the latest committed checkpoint from a compatible paused, interrupted, blocked, or failed source job.");
  }
  const lineage = await loadResumeLineage(client, source, input);
  const trace = await readLineageTrace(client, lineage);
  assertLlmInvocationSetSafe(trace.llmInvocations);
  assertAttemptSetSafe(trace.attempts);
  assertAttemptCatalogCurrent(trace.attempts, trace.decisions);
  assertCheckpointAttemptHashes(
    checkpoint,
    trace.attempts.filter((attempt) => attempt.jobId === checkpoint.jobId)
  );
  if (input.kind === "research_loop") await assertCanonicalResumeReadiness(client, input, lineage, trace.attempts, checkpoint);
}

async function assertCheckpointFreeBootstrap(client: StorageWorkerClient, input: EnqueueDurableJob): Promise<void> {
  const predecessorJobId = input.resumesJobId as string;
  const owner: StorageRunOwnership = { projectId: input.projectId, runId: `run:${predecessorJobId}`, jobId: predecessorJobId };
  const [source, latestCheckpoint, existingState, contextPack, attempts, llmInvocations] = await Promise.all([
    client.request<StorageJob | undefined>({ name: "job.get", jobId: predecessorJobId }),
    client.request<StorageCheckpoint | undefined>({ name: "checkpoint.latestCommittedForJob", jobId: predecessorJobId }),
    client.request<StorageRunStateRevision | undefined>({
      name: "runState.latest",
      owner
    }),
    client.request<StorageContextPack | undefined>({ name: "contextPack.latest", owner }),
    client.request<StorageToolAttempt[]>({ name: "trace.attempt.listJob", jobId: predecessorJobId, limit: MAX_TRACE_ATTEMPTS }),
    client.request<StorageLlmInvocation[]>({ name: "trace.llm.listJob", jobId: predecessorJobId, limit: MAX_TRACE_ATTEMPTS })
  ]);
  const sourcePayload = record(source?.payload);
  const sourceRequest = record(sourcePayload?.request);
  if (
    input.kind !== "research_loop" ||
    !source ||
    source.projectId !== input.projectId ||
    source.operation !== "research_loop" ||
    source.status !== "interrupted" ||
    sourcePayload?.resumesJobId !== undefined ||
    sourcePayload?.resumeCheckpointId !== undefined ||
    sourceRequest?.action !== "start" ||
    latestCheckpoint ||
    !checkpointFreeStateReady(existingState, input.projectId, predecessorJobId) ||
    !sameCanonical(source.requestedCapabilities, input.requestedCapabilities) ||
    !sameCanonical(source.effectiveCapabilities, input.effectiveCapabilities) ||
    !sameCanonical(source.toolPolicy, input.toolPolicy)
  ) {
    conflict("Checkpoint-free resume requires a directly interrupted root job before its first durable checkpoint.");
  }
  try {
    parseCanonicalInitializationAnchor(sourceRequest.canonicalInitializationAnchor, { sha256Canonical: durableJobRequestHash });
  } catch (error) {
    conflict("Checkpoint-free resume rejected an invalid immutable initialization anchor.", error);
  }
  if (attempts.length) notReady("Checkpoint-free resume is blocked after any tool attempt has started.");
  assertLlmInvocationSetSafe(llmInvocations);
  if (existingState) await assertObservedBudget(client, input, [source], parseStoredRunStateRevision(existingState.data));
  if (contextPack) assertContextPackCurrent(contextPack, input);
}

async function loadResumeLineage(client: StorageWorkerClient, source: StorageJob, input: EnqueueDurableJob): Promise<StorageJob[]> {
  const lineage = [source];
  const seen = new Set([source.id]);
  let cursor = source;
  while (true) {
    const predecessorId = optionalString(record(cursor.payload)?.resumesJobId);
    if (!predecessorId) break;
    if (lineage.length >= MAX_RESUME_LINEAGE || seen.has(predecessorId)) conflict("Resume lineage is cyclic or exceeds its bounded depth.");
    const predecessor = await client.request<StorageJob | undefined>({ name: "job.get", jobId: predecessorId });
    if (!predecessor || predecessor.projectId !== input.projectId || predecessor.operation !== input.kind) {
      conflict("Resume lineage crosses a project or job-kind ownership boundary.");
    }
    lineage.push(predecessor);
    seen.add(predecessor.id);
    cursor = predecessor;
  }
  return lineage.reverse();
}

async function readLineageTrace(
  client: StorageWorkerClient,
  lineage: StorageJob[]
): Promise<{ attempts: StorageToolAttempt[]; decisions: StorageToolDecision[]; llmInvocations: StorageLlmInvocation[] }> {
  const groups = await Promise.all(
    lineage.map(async (job) =>
      Promise.all([
        client.request<StorageToolAttempt[]>({ name: "trace.attempt.listJob", jobId: job.id, limit: MAX_TRACE_ATTEMPTS }),
        client.request<StorageToolDecision[]>({ name: "trace.decision.listJob", jobId: job.id, limit: MAX_TRACE_ATTEMPTS }),
        client.request<StorageLlmInvocation[]>({ name: "trace.llm.listJob", jobId: job.id, limit: MAX_TRACE_ATTEMPTS })
      ])
    )
  );
  const attempts = groups.flatMap(([items]) => items);
  const decisions = groups.flatMap(([, items]) => items);
  const llmInvocations = groups.flatMap(([, , items]) => items);
  if (
    groups.some(
      ([attemptGroup, decisionGroup, llmGroup]) =>
        attemptGroup.length >= MAX_TRACE_ATTEMPTS || decisionGroup.length >= MAX_TRACE_ATTEMPTS || llmGroup.length >= MAX_TRACE_ATTEMPTS
    )
  ) {
    notReady("Resume validation exceeded its bounded trace window.");
  }
  assertUniqueIds(attempts, "tool attempt");
  assertUniqueIds(decisions, "tool decision");
  assertUniqueIds(llmInvocations, "LLM invocation");
  return { attempts, decisions, llmInvocations };
}

async function assertCanonicalResumeReadiness(
  client: StorageWorkerClient,
  input: EnqueueDurableJob,
  lineage: StorageJob[],
  attempts: StorageToolAttempt[],
  checkpoint: StorageCheckpoint
): Promise<void> {
  const root = lineage[0];
  const source = lineage.at(-1);
  if (!root || !source || !sameCanonical(source.requestedCapabilities, input.requestedCapabilities)) {
    conflict("Research resume attempted to change its immutable requested capability policy.");
  }
  if (!sameCanonical(source.effectiveCapabilities, input.effectiveCapabilities) || !sameCanonical(source.toolPolicy, input.toolPolicy)) {
    conflict("Research resume attempted to change its effective capability or tool policy lineage.");
  }
  const owner: StorageRunOwnership = { projectId: input.projectId, runId: `run:${root.id}`, jobId: source.id };
  const contextPackId = optionalString(record(checkpoint.data)?.canonicalContextPackId);
  if (!contextPackId) notReady("Research resume checkpoint is missing its exact canonical ContextPack binding.");
  const [storedState, contextPack] = await Promise.all([
    client.request<StorageRunStateRevision | undefined>({ name: "runState.latest", owner }),
    client.request<StorageContextPack | undefined>({ name: "contextPack.get", owner, contextPackId })
  ]);
  if (!storedState) notReady("Research resume requires a durable canonical run-state revision.");
  const state = parseStoredRunStateRevision(storedState.data);
  if (state.projectId !== input.projectId || state.runId !== owner.runId || storedState.jobId !== source.id) {
    conflict("Research resume canonical state does not belong to the selected project and predecessor lineage.");
  }
  if (storedState.contextPackId && storedState.contextPackId !== contextPackId) {
    conflict("Research resume state and checkpoint disagree about the canonical ContextPack binding.");
  }
  await assertObservedBudget(client, input, lineage, state);
  if (!contextPack) notReady("Research resume checkpoint references a missing canonical ContextPack.");
  if (contextPack.id !== contextPackId) conflict("Research resume loaded a different ContextPack than the checkpoint binding.");
  assertContextPackCurrent(contextPack, input);
}

function assertContextPackCurrent(contextPack: StorageContextPack, input: EnqueueDurableJob): void {
  const pack = parseStoredContextPack(contextPack.data);
  if (pack.projectId !== input.projectId || pack.runId !== contextPack.runId || pack.stateRevision !== contextPack.stateRevision) {
    conflict("Persisted ContextPack ownership or revision changed before resume.");
  }
  const memoryEntries = pack.sections.find((section) => section.kind === "memory")?.entries ?? [];
  const memoryIds = new Set(memoryEntries.map((entry) => entry.id));
  if (pack.selectedMemoryIds.some((id) => !memoryIds.has(id))) conflict("Persisted ContextPack memory selection receipt is incomplete.");
  if (memoryEntries.some((entry) => entry.trust === "stale" || entry.markers.includes("STALE_MEMORY_REVALIDATION_REQUIRED"))) {
    notReady("Resume requires stale selected memory to be revalidated before execution.");
  }
  for (const selected of pack.selectedToolSpecVersions) {
    const descriptor = getToolDescriptor(selected.name);
    if (!descriptor) notReady(`Resume tool ${selected.name} is no longer available in the active catalog.`);
    if (descriptor.version !== selected.version) notReady(`Resume tool ${selected.name} changed schema version and requires replanning.`);
    const activeInputContractHash = durableJobRequestHash(plannerToolInputContract(descriptor.name));
    if (activeInputContractHash !== selected.inputContractHash) {
      notReady(`Resume tool ${selected.name} changed its input contract without a compatible persisted schema receipt.`);
    }
    assertDescriptorCapabilityAvailable(descriptor.name, descriptor.requiredCapabilities, input);
  }
}

function assertAttemptCatalogCurrent(attempts: StorageToolAttempt[], decisions: StorageToolDecision[]): void {
  const decisionsById = new Map(decisions.map((decision) => [decision.id, decision]));
  for (const attempt of attempts) {
    if (attempt.traceAvailability !== "vnext" && attempt.traceVersion === undefined) continue;
    const decision = decisionsById.get(attempt.decisionId);
    if (!decision) conflict(`Resume trace is missing tool decision ${attempt.decisionId}.`);
    const descriptor = getToolDescriptor(decision.toolName);
    if (!descriptor) notReady(`Resume tool ${decision.toolName} is no longer available in the active catalog.`);
    if (attempt.descriptorVersion !== descriptor.version) notReady(`Resume tool ${decision.toolName} changed descriptor version and requires replanning.`);
  }
}

function assertDescriptorCapabilityAvailable(toolName: string, capabilities: readonly string[], input: EnqueueDurableJob): void {
  const effective = input.effectiveCapabilities;
  if (!effective || capabilities.some((kind) => effective[kind as keyof typeof effective] !== true)) {
    notReady(`Resume tool ${toolName} requires a capability unavailable to the resumed job.`);
  }
  if (toolName === "CodexCliTool" && input.toolPolicy?.allowCodexCli !== true) {
    notReady("Resume ContextPack selected CodexCliTool without explicit workspace execution authorization.");
  }
}

function assertCheckpointAttemptHashes(checkpoint: StorageCheckpoint, actual: StorageToolAttempt[]): void {
  if (!checkpoint.data || typeof checkpoint.data !== "object" || (checkpoint.data as { phase?: unknown }).phase !== "execute_tools_completed") return;
  const expected = (checkpoint.data as { attempts?: Array<{ id: string; inputHash: string; outputHash?: string }> }).attempts ?? [];
  if (!expected.length) notReady("Resume checkpoint does not contain verified tool attempts.");
  for (const item of expected) {
    const attempt = actual.find((candidate) => candidate.id === item.id && candidate.status === "completed");
    if (!attempt || attempt.inputHash !== item.inputHash || attempt.outputHash !== item.outputHash) {
      conflict("Resume checkpoint tool output hash verification failed.");
    }
  }
}

function assertAttemptSetSafe(attempts: StorageToolAttempt[]): void {
  if (attempts.length >= MAX_TRACE_ATTEMPTS) notReady("Resume validation exceeded its bounded tool-attempt window.");
  for (const attempt of attempts) {
    try {
      assertToolAttemptResumeSafe(attempt);
    } catch (error) {
      notReady(error instanceof Error ? error.message : `Tool attempt ${attempt.id} is not safe to resume.`, error);
    }
  }
}

function assertLlmInvocationSetSafe(invocations: StorageLlmInvocation[]): void {
  if (invocations.length >= MAX_TRACE_ATTEMPTS) notReady("Resume validation exceeded its bounded LLM-invocation window.");
  const pending = invocations.find((invocation) => invocation.status === "running");
  if (pending) {
    notReady(`PENDING_EXTERNAL_SIDE_EFFECT: LLM invocation ${pending.id} has no durable terminal receipt.`);
  }
}

async function assertObservedBudget(client: StorageWorkerClient, input: EnqueueDurableJob, lineage: StorageJob[], state: RunStateRevision): Promise<void> {
  const root = lineage[0];
  const source = lineage.at(-1);
  if (!root || !source) conflict("Canonical budget accounting requires a complete resume lineage.");
  const observation = await observeCanonicalBudget({
    port: storageBudgetPort(client),
    jobs: lineage.map(toBudgetJob),
    projectId: input.projectId,
    runId: `run:${root.id}`,
    observedAt: source.updatedAt,
    hasher: storageCanonicalHasher
  });
  try {
    budgetUsageDelta(state.budgetUsage, observation.target);
  } catch (error) {
    conflict("Observed durable trace usage regressed below committed canonical budget usage.", error);
  }
  if (exhaustedBudgetDimensions({ budgetLimits: state.budgetLimits, budgetUsage: observation.target }).length) {
    notReady("The canonical resource budget is exhausted by observed durable trace usage or has an unenforceable monetary limit.");
  }
  const latest = [...state.decisions].reverse().find((decision) => decision.decisionId.startsWith("budget-accounting-v1:"));
  if (budgetUsageEqual(state.budgetUsage, observation.target)) {
    if (!hasBudgetUsage(observation.target) && !latest) return;
    if (latest?.decisionId !== observation.decisionId || latest.decisionReceiptId !== observation.receiptId) {
      conflict("Canonical budget usage is not bound to the current durable trace accounting receipt.");
    }
  }
}

function storageBudgetPort(client: StorageWorkerClient): CanonicalBudgetTracePort {
  return {
    listCanonicalLlmInvocations: (jobId, limit) => client.request({ name: "trace.llm.listJob", jobId, limit }),
    listCanonicalToolAttempts: (jobId, limit) => client.request({ name: "trace.attempt.listJob", jobId, limit }),
    latestCommittedCheckpoint: (jobId) => client.request({ name: "checkpoint.latestCommittedForJob", jobId })
  };
}

function toBudgetJob(job: StorageJob): DurableJobRecord {
  if (!(["research_loop", "chat_reply", "engineering_run"] as const).includes(job.operation as DurableJobRecord["kind"])) {
    conflict(`Canonical budget lineage contains unsupported job kind ${job.operation}.`);
  }
  return {
    id: job.id,
    projectId: job.projectId,
    kind: job.operation as DurableJobRecord["kind"],
    status: job.status,
    projectRevision: 0,
    idempotencyKey: job.idempotencyKey ?? job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.completedAt ? { finishedAt: job.completedAt } : {}),
    ...(job.leaseExpiresAt ? { leaseExpiresAt: job.leaseExpiresAt } : {})
  };
}

function assertUniqueIds(values: Array<{ id: string }>, label: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) conflict(`Resume lineage contains duplicate ${label} identity ${value.id}.`);
    ids.add(value.id);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return left !== undefined && right !== undefined && durableJobRequestHash(left) === durableJobRequestHash(right);
}

function checkpointFreeStateReady(state: StorageRunStateRevision | undefined, projectId: string, predecessorJobId: string): boolean {
  if (!state) return true;
  if (state.projectId !== projectId || state.runId !== `run:${predecessorJobId}` || state.jobId !== predecessorJobId || ![0, 1].includes(state.revision)) {
    return false;
  }
  try {
    const parsed = parseStoredRunStateRevision(state.data);
    const empty =
      parsed.completedNodeReceipts.length === 0 && parsed.blockedReasons.length === 0 && parsed.decisions.length === 0 && parsed.terminalReceipt === undefined;
    return (
      empty && ((parsed.revision === 0 && parsed.status === "ready") || (parsed.revision === 1 && parsed.status === "running" && Boolean(parsed.currentNodeId)))
    );
  } catch {
    return false;
  }
}

function invalid(message: string, cause?: unknown): never {
  throw new DurableResumeValidationError("VALIDATION_ERROR", message, cause === undefined ? undefined : { cause });
}

function conflict(message: string, cause?: unknown): never {
  throw new DurableResumeValidationError("CONFLICT", message, cause === undefined ? undefined : { cause });
}

function notReady(message: string, cause?: unknown): never {
  throw new DurableResumeValidationError("NOT_READY", message, cause === undefined ? undefined : { cause });
}
