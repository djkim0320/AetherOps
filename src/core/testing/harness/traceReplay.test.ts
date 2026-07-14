import { beforeAll, describe, expect, it } from "vitest";
import {
  AETHERBENCH_A0727F2_FIXTURE_SUBJECT,
  TraceEventSchema,
  computeTraceEventHash,
  createDefaultEvalCases,
  gradeDeterministicCase,
  hashCanonical,
  normalizeAtLeastOnceTraceDelivery,
  replayTrace,
  runDeterministicAetherBench,
  type AetherBenchReport,
  type MemoryCandidateCreatedTraceEvent,
  type MemoryRetrievedTraceEvent,
  type ToolCallCompletedTraceEvent,
  type ToolCallVerifiedTraceEvent,
  type TraceEvent
} from "./public.js";

describe("trace replay integrity", () => {
  let report: AetherBenchReport;

  beforeAll(async () => {
    report = await runDeterministicAetherBench({ subject: AETHERBENCH_A0727F2_FIXTURE_SUBJECT });
  });

  it("rejects payload tampering, sequence gaps, and unknown dependencies", async () => {
    const original = traceFor(report, "tool-discovery");
    const tampered = structuredClone(original);
    const selected = tampered.find((event) => event.type === "tool.selected");
    expect(selected?.type).toBe("tool.selected");
    if (selected?.type === "tool.selected") selected.data.decisionReason = "tampered decision";
    await expectInvalid(tampered);

    const gap = structuredClone(original);
    gap[2]!.sequence += 1;
    await expectInvalid(gap);

    const unknownDependency = structuredClone(original);
    unknownDependency[2]!.dependsOn = ["00000000-0000-4000-8000-000000000000"];
    await expectInvalid(unknownDependency);
  });

  it("normalizes delayed exact at-least-once duplicates but rejects changed duplicates", async () => {
    const original = traceFor(report, "tool-discovery");
    const delivery = [original[0]!, original[1]!, original[0]!, ...original.slice(2)];
    const normalized = normalizeAtLeastOnceTraceDelivery(delivery);
    expect(normalized.duplicateDeliveries).toBe(1);
    expect(normalized.events).toEqual(original);
    await expect(replayTrace(normalized.events)).resolves.toMatchObject({ rootHash: original.at(-1)!.eventHash });

    const changedDuplicate = structuredClone(original[0]!);
    if (changedDuplicate.type === "task.created") changedDuplicate.data.objectiveHash = "f".repeat(64);
    expect(() => normalizeAtLeastOnceTraceDelivery([original[0]!, original[1]!, changedDuplicate, ...original.slice(2)])).toThrow(/changed duplicate/);
  });

  it("rejects arbitrary promotion and a partial result reported as verified", async () => {
    const arbitrary = structuredClone(traceFor(report, "tool-discovery"));
    const arbitraryVerifier = requireEvent(arbitrary, "tool.call.verified") as ToolCallVerifiedTraceEvent;
    arbitraryVerifier.data.promotedArtifactIds = ["forged-artifact"];
    await expectInvalid(await rehashTrace(arbitrary));

    const partial = structuredClone(traceFor(report, "tool-discovery"));
    const partialCompletion = requireEvent(partial, "tool.call.completed") as ToolCallCompletedTraceEvent;
    partialCompletion.data.outcome = "partial";
    await expectInvalid(await rehashTrace(partial));
  });

  it("rejects accepted memory sourced from an unverified artifact", async () => {
    const events = structuredClone(traceFor(report, "tool-output-injection"));
    const candidate = requireEvent(events, "memory.candidate.created") as MemoryCandidateCreatedTraceEvent;
    candidate.data.sourceArtifactIds = ["forged-source"];
    candidate.data.contentHash = await hashCanonical({ candidateId: candidate.data.candidateId, sourceArtifactIds: candidate.data.sourceArtifactIds });
    const disposition = requireEvent(events, "memory.candidate.dispositioned");
    if (disposition.type === "memory.candidate.dispositioned") disposition.data.disposition = "accepted";
    await expectInvalid(await rehashTrace(events));
  });

  it("rejects unrelated write-scope conflicts and does not grade an unrelated blocker as conflict evidence", async () => {
    const unrelatedScope = structuredClone(traceFor(report, "multi-agent-conflict"));
    const overlapCreation = unrelatedScope.find((event) => event.type === "work_order.created" && event.data.workOrderId === "work-overlap");
    expect(overlapCreation?.type).toBe("work_order.created");
    if (overlapCreation?.type === "work_order.created") overlapCreation.data.scopeKeys = ["file-unrelated"];
    await expectInvalid(await rehashTrace(unrelatedScope));

    const unrelatedReason = structuredClone(traceFor(report, "multi-agent-conflict"));
    const blocked = unrelatedReason.find((event) => event.type === "work_order.completed" && event.data.workOrderId === "work-overlap");
    expect(blocked?.type).toBe("work_order.completed");
    if (blocked?.type === "work_order.completed") {
      blocked.data.reasonCode = "UNRELATED_BLOCKER";
      delete blocked.data.conflictingWorkOrderId;
    }
    const rehashed = await rehashTrace(unrelatedReason);
    await expect(replayTrace(rehashed)).resolves.toBeDefined();
    const evalCase = createDefaultEvalCases().find((candidate) => candidate.suite === "multi-agent-conflict")!;
    const grade = await gradeDeterministicCase(evalCase, rehashed, {
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      retries: 0,
      estimatedCostUsd: 0
    });
    expect(grade.acceptanceResults.find((result) => result.criterionId === "block-overlapping-write")?.passed).toBe(false);
  });

  it("rejects retry without recovery and retry after a permanent failure", async () => {
    const original = traceFor(report, "idempotent-side-effects");
    const withoutRecovery = original.filter((event) => event.type !== "recovery.selected");
    await expectInvalid(await rehashTrace(withoutRecovery));

    const permanent = structuredClone(original);
    const firstCompletion = permanent.find((event): event is ToolCallCompletedTraceEvent => event.type === "tool.call.completed" && event.data.attempt === 1);
    expect(firstCompletion).toBeDefined();
    firstCompletion!.data.outcome = "permanent_failure";
    firstCompletion!.data.failureCode = "PERMANENT_FAILURE";
    await expectInvalid(await rehashTrace(permanent));
  });

  it("rejects conflicting side-effect receipts", async () => {
    const events = structuredClone(traceFor(report, "idempotent-side-effects"));
    const secondCompletion = events.find((event): event is ToolCallCompletedTraceEvent => event.type === "tool.call.completed" && event.data.attempt === 2);
    expect(secondCompletion?.data.sideEffectReceipt).toBeDefined();
    secondCompletion!.data.sideEffectReceipt!.receiptId = "conflicting-receipt";
    await expectInvalid(await rehashTrace(events));
  });

  it("rejects cross-project memory even when the event hash chain is recomputed", async () => {
    const events = structuredClone(traceFor(report, "memory-scope"));
    const retrieval = requireEvent(events, "memory.retrieved") as MemoryRetrievedTraceEvent;
    retrieval.data.records[0]!.owningProjectId = "other-project";
    await expectInvalid(await rehashTrace(events));
  });

  it("rejects fake terminal PASS counts and unverified successful calls", async () => {
    const fakePass = structuredClone(traceFor(report, "tool-discovery"));
    const acceptance = fakePass.find((event) => event.type === "acceptance.checked");
    const terminal = fakePass.find((event) => event.type === "eval.completed");
    expect(acceptance?.type).toBe("acceptance.checked");
    expect(terminal?.type).toBe("eval.completed");
    if (acceptance?.type === "acceptance.checked" && terminal?.type === "eval.completed") {
      acceptance.data.passed = false;
      terminal.data.acceptancePassed -= 1;
    }
    await expectInvalid(await rehashTrace(fakePass));

    const original = traceFor(report, "tool-discovery");
    const verifierId = requireEvent(original, "tool.call.verified").eventId;
    const withoutVerifier = original.filter((event) => event.eventId !== verifierId);
    await expectInvalid(await rehashTrace(withoutVerifier));
  });

  it("rejects failed calls later forged as verifier PASS and secret-bearing keys", async () => {
    const events = structuredClone(traceFor(report, "tool-discovery"));
    const completion = requireEvent(events, "tool.call.completed") as ToolCallCompletedTraceEvent;
    completion.data.outcome = "permanent_failure";
    completion.data.outputArtifactIds = [];
    completion.data.outputBytes = 0;
    completion.data.failureCode = "FORGED_FAILURE";
    await expectInvalid(await rehashTrace(events));

    const raw = structuredClone(events[0]!) as unknown as { data: Record<string, unknown> };
    raw.data.secret = "must-not-parse";
    expect(TraceEventSchema.safeParse(raw).success).toBe(false);
  });
});

function traceFor(report: AetherBenchReport, suite: AetherBenchReport["runs"][number]["suite"]): TraceEvent[] {
  const run = report.runs.find((candidate) => candidate.suite === suite);
  const trace = report.traces.find((candidate) => candidate.runId === run?.id);
  if (!trace) throw new Error(`Missing deterministic trace fixture for suite: ${suite}`);
  return trace.events;
}

function requireEvent(events: TraceEvent[], type: TraceEvent["type"]): TraceEvent {
  const event = events.find((candidate) => candidate.type === type);
  if (!event) throw new Error(`Missing trace event: ${type}`);
  return event;
}

async function rehashTrace(input: readonly TraceEvent[]): Promise<TraceEvent[]> {
  const events = structuredClone(input);
  const retainedIds = new Set(events.map((event) => event.eventId));
  let previousEventHash: string | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    event.sequence = index + 1;
    event.dependsOn = event.dependsOn.filter((eventId) => retainedIds.has(eventId));
    if (event.type === "acceptance.checked") {
      event.data.evidenceEventIds = event.data.evidenceEventIds.filter((eventId) => retainedIds.has(eventId));
    }
    event.previousEventHash = previousEventHash;
    const { eventHash, ...hashInput } = event;
    if (!eventHash) throw new Error("Trace fixture has no event hash.");
    event.eventHash = await computeTraceEventHash(hashInput);
    previousEventHash = event.eventHash;
  }
  return events.map((event) => TraceEventSchema.parse(event));
}

async function expectInvalid(events: readonly TraceEvent[]): Promise<void> {
  await expect(replayTrace(events)).rejects.toMatchObject({ code: "TRACE_INVALID" });
}
