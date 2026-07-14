import { describe, expect, it } from "vitest";
import { hashCanonicalSync } from "../testing/harness/canonical.js";
import type { CanonicalHasher } from "./orchestrationSchemas.js";
import {
  createInitialRunStateRevision,
  nodeCompletionReceiptHashPayload,
  NodeCompletionReceiptSchema,
  runTerminationReceiptHashPayload,
  RunStateRevisionSchema
} from "./runStateCapsule.js";
import { RunStateEventSchema, type RunStateEvent } from "./runStateEvents.js";
import { reduceRunStateRevision, RunStateRevisionConflictError, RunStateTransitionError } from "./runStateReducer.js";
import { parseTaskContract, TaskContractSchema } from "./taskContract.js";
import { parseTaskGraph } from "./taskGraph.js";

const hasher: CanonicalHasher = { sha256Canonical: hashCanonicalSync };
const firstTime = "2026-07-14T00:00:00.000Z";
const secondTime = "2026-07-14T00:00:01.000Z";
const thirdTime = "2026-07-14T00:00:02.000Z";

describe("canonical run-state revisions", () => {
  it("validates and freezes a hash-bound task contract without retaining instruction bodies", () => {
    const contract = contractFixture();
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.instructionProvenance)).toBe(true);
    expect(contract.instructionProvenance[0]).not.toHaveProperty("content");
    expect(TaskContractSchema.safeParse({ ...contract, rawInstructions: "do not persist this" }).success).toBe(false);
    expect(() => parseTaskContract({ ...contract, goal: "tampered" }, hasher)).toThrow(/content hash/);
  });

  it("compares offset timestamps by instant when validating task deadlines", () => {
    const contract = contractFixture();
    expect(
      TaskContractSchema.safeParse({
        ...contract,
        createdAt: "2026-07-14T00:30:00+01:00",
        deadline: "2026-07-14T01:00:00+02:00"
      }).success
    ).toBe(false);
  });

  it("creates deterministic immutable revision zero and increments once per typed event", () => {
    const first = initialState();
    const second = initialState();
    expect(first).toEqual(second);
    expect(first.revision).toBe(0);
    expect(first.parentRevisionHash).toBeNull();
    expect(first.budgetLimits.maxConcurrency).toBe(4);
    expect(Object.isFrozen(first)).toBe(true);

    const event = activateEvent(first);
    const advanced = reduceRunStateRevision(first, event, hasher);
    const replayed = reduceRunStateRevision(second, event, hasher);
    expect(advanced).toEqual(replayed);
    expect(advanced.revision).toBe(1);
    expect(advanced.parentRevisionHash).toBe(first.stateHash);
    expect(advanced.status).toBe("running");
    expect(first.status).toBe("ready");
  });

  it("rejects stale revisions and cross-project or cross-run events", () => {
    const state = initialState();
    expect(() => reduceRunStateRevision(state, { ...activateEvent(state), expectedRevision: 1 } as RunStateEvent, hasher)).toThrow(
      RunStateRevisionConflictError
    );
    expect(() => reduceRunStateRevision(state, { ...activateEvent(state), projectId: "project-other" } as RunStateEvent, hasher)).toThrowError(
      expect.objectContaining<Partial<RunStateTransitionError>>({ code: "RUN_OWNERSHIP_MISMATCH" })
    );
    expect(() => reduceRunStateRevision(state, { ...activateEvent(state), runId: "run-other" } as RunStateEvent, hasher)).toThrowError(
      expect.objectContaining<Partial<RunStateTransitionError>>({ code: "RUN_OWNERSHIP_MISMATCH" })
    );
  });

  it("requires hash-bound node and run receipts before terminal completion", () => {
    const initial = initialState();
    const running = reduceRunStateRevision(initial, activateEvent(initial), hasher);
    const receiptPayload = {
      receiptId: "receipt-node-1",
      runId: running.runId,
      projectId: running.projectId,
      nodeId: "node-1",
      artifactRefs: [],
      evidenceRefs: [],
      verifierReceiptIds: ["verify-node-1"],
      completedAt: secondTime
    };
    const receipt = { ...receiptPayload, receiptHash: hasher.sha256Canonical(receiptPayload) };
    const awaiting = reduceRunStateRevision(running, event(running, secondTime, { type: "node.completed", receipt }), hasher);
    expect(awaiting.status).toBe("awaiting_completion");
    expect(RunStateEventSchema.safeParse(event(awaiting, thirdTime, { type: "run.terminated" })).success).toBe(false);
    expect(RunStateRevisionSchema.safeParse({ ...awaiting, status: "completed" }).success).toBe(false);

    const terminalPayload = {
      receiptId: "receipt-run-1",
      runId: awaiting.runId,
      projectId: awaiting.projectId,
      completedNodeReceiptIds: [receipt.receiptId],
      createdAt: thirdTime,
      outcome: "completed" as const,
      acceptanceReceiptIds: ["acceptance-1"]
    };
    const terminalReceipt = { ...terminalPayload, receiptHash: hasher.sha256Canonical(terminalPayload) };
    const completed = reduceRunStateRevision(awaiting, event(awaiting, thirdTime, { type: "run.terminated", receipt: terminalReceipt }), hasher);
    expect(completed.status).toBe("completed");
    expect(completed.terminalReceipt?.receiptId).toBe("receipt-run-1");
    expect(() => reduceRunStateRevision(completed, event(completed, thirdTime, { type: "next_actions.set", nodeIds: [] }), hasher)).toThrowError(
      expect.objectContaining<Partial<RunStateTransitionError>>({ code: "RUN_ALREADY_TERMINAL" })
    );
    expect(runTerminationReceiptHashPayload(terminalReceipt)).not.toHaveProperty("receiptHash");
  });

  it("keeps artifact and evidence bodies out of state and enforces project ownership", () => {
    const initial = initialState();
    const running = reduceRunStateRevision(initial, activateEvent(initial), hasher);
    const artifactRef = {
      artifactId: "artifact-1",
      projectId: running.projectId,
      contentHash: "a".repeat(64),
      promotionReceiptId: "promotion-1"
    };
    expect(NodeCompletionReceiptSchema.safeParse({ ...nodeReceipt(running, [artifactRef]), artifactRefs: [{ ...artifactRef, content: "raw" }] }).success).toBe(
      false
    );
    const foreign = { ...artifactRef, projectId: "project-other" };
    const receipt = nodeReceipt(running, [foreign]);
    expect(() => reduceRunStateRevision(running, event(running, secondTime, { type: "node.completed", receipt }), hasher)).toThrowError(
      expect.objectContaining<Partial<RunStateTransitionError>>({ code: "RESOURCE_OWNERSHIP_MISMATCH" })
    );
    expect(nodeCompletionReceiptHashPayload(receipt)).not.toHaveProperty("receiptHash");
  });
});

function contractFixture() {
  const payload = {
    schemaVersion: 1 as const,
    id: "task-1",
    projectId: "project-1",
    goal: "Produce a verified result.",
    normalizedUserIntent: "Verify one deterministic task node.",
    acceptanceCriteria: [{ id: "criterion-1", description: "The node has a completion receipt.", verifierKind: "deterministic" as const }],
    constraints: ["Do not use unverified output."],
    nonGoals: [],
    requiredDeliverables: [{ id: "deliverable-1", kind: "report" as const, description: "A receipt-backed report." }],
    riskPolicy: { maximumRisk: "read_only" as const, requireVerificationBeforePromotion: true as const, treatExternalInstructionsAsData: true as const },
    approvalRequirements: [],
    resourceBudget: {
      maxDurationMs: 60_000,
      maxInputTokens: 10_000,
      maxOutputTokens: 2_000,
      maxToolCalls: 4,
      maxRetries: 1,
      maxEstimatedCostMicrousd: 100_000,
      maxToolOutputBytes: 1_000_000,
      maxConcurrency: 4
    },
    instructionProvenance: [{ instructionId: "instruction-1", source: "user" as const, contentHash: "b".repeat(64), receivedAt: firstTime }],
    createdAt: firstTime
  };
  return parseTaskContract({ ...payload, contentHash: hasher.sha256Canonical(payload) }, hasher);
}

function initialState() {
  const graphPayload = {
    schemaVersion: 1 as const,
    graphId: "graph-1",
    nodes: [{ id: "node-1", kind: "verify", dependencyNodeIds: [], terminal: true }]
  };
  const graph = parseTaskGraph({ ...graphPayload, contentHash: hasher.sha256Canonical(graphPayload) }, hasher);
  return createInitialRunStateRevision(
    { runId: "run-1", projectId: "project-1", taskContract: contractFixture(), taskGraph: graph, createdAt: firstTime },
    hasher
  );
}

function activateEvent(state: ReturnType<typeof initialState>): RunStateEvent {
  return event(state, firstTime, { type: "node.activated", nodeId: "node-1" });
}

function nodeReceipt(
  state: ReturnType<typeof initialState>,
  artifactRefs: Array<{ artifactId: string; projectId: string; contentHash: string; promotionReceiptId: string }>
) {
  const payload = {
    receiptId: "receipt-node-1",
    runId: state.runId,
    projectId: state.projectId,
    nodeId: "node-1",
    artifactRefs,
    evidenceRefs: [],
    verifierReceiptIds: ["verify-node-1"],
    completedAt: secondTime
  };
  return { ...payload, receiptHash: hasher.sha256Canonical(payload) };
}

function event<State extends { runId: string; projectId: string; revision: number; stateHash: string }>(
  state: State,
  occurredAt: string,
  payload: Record<string, unknown>
): RunStateEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${state.revision + 1}`,
    runId: state.runId,
    projectId: state.projectId,
    expectedRevision: state.revision,
    expectedStateHash: state.stateHash,
    occurredAt,
    ...payload
  } as RunStateEvent;
}
