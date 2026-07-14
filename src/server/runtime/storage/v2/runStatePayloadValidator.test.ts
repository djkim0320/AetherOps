import { describe, expect, it } from "vitest";
import {
  ContextCompiler,
  createContextPackPersistenceReceipt,
  hashContextCanonical,
  hashContextText,
  STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT,
  type ContextCompilerInput
} from "../../../../core/context/public.js";
import { parseStoredContextPack, storageCanonicalHasher } from "./runStatePayloadValidator.js";

describe("canonical storage payload validator", () => {
  it("accepts only a content-free persistence receipt and matches the core canonical hashes", async () => {
    const pack = await new ContextCompiler().compile(contextInput());
    const receipt = createContextPackPersistenceReceipt(pack, storageCanonicalHasher);
    const { id: _id, canonicalHash: _canonicalHash, ...body } = pack;
    void _id;
    void _canonicalHash;

    expect(parseStoredContextPack(receipt)).toEqual(receipt);
    expect(Object.isFrozen(parseStoredContextPack(receipt))).toBe(true);
    expect(() => parseStoredContextPack(pack)).toThrow();
    expect(storageCanonicalHasher.sha256Canonical(body)).toBe(await hashContextCanonical(body));
    expect(storageCanonicalHasher.sha256Text(pack.providerInput)).toBe(await hashContextText(pack.providerInput));
  });

  it("rejects full packs, altered receipts, oversized arrays, and oversized serialized receipts", async () => {
    const pack = await new ContextCompiler().compile(contextInput());
    const receipt = createContextPackPersistenceReceipt(pack, storageCanonicalHasher);
    expect(() => parseStoredContextPack({ ...receipt, finalInputHash: "0".repeat(64) })).toThrow(/receipt hash/i);
    expect(() => parseStoredContextPack({ ...receipt, selectedMemoryIds: Array.from({ length: 513 }, (_, index) => `memory-${index}`) })).toThrow(
      /too big|512/i
    );
    expect(() => parseStoredContextPack({ ...receipt, provider: { ...receipt.provider, modelId: "x".repeat(1024 * 1024) } })).toThrow(/serialized byte limit/i);
  });
});

function contextInput(): ContextCompilerInput {
  return {
    runId: "run-clark-y",
    projectId: "project-clark-y",
    createdAt: "2026-07-14T00:00:00.000Z",
    taskContract: {
      id: "task-clark-y",
      projectId: "project-clark-y",
      contentHash: "a".repeat(64),
      goal: "Evaluate Clark-Y with source-bound engineering evidence.",
      normalizedUserIntent: "Evaluate Clark-Y with the pinned geometry and solver.",
      acceptanceCriteria: [{ id: "criterion-polar", description: "Produce a verified polar.", verifierKind: "deterministic" }],
      constraints: ["Do not substitute geometry or solver."],
      nonGoals: [],
      requiredDeliverables: [{ id: "deliverable-polar", kind: "dataset", description: "Verified polar data." }],
      riskPolicy: { maximumRisk: "read_only", requireVerificationBeforePromotion: true, treatExternalInstructionsAsData: true },
      approvalRequirements: [],
      resourceBudget: {
        maxDurationMs: 60_000,
        maxInputTokens: 8_000,
        maxOutputTokens: 2_000,
        maxToolCalls: 8,
        maxRetries: 1,
        maxEstimatedCostMicrousd: 0,
        maxToolOutputBytes: 1_000_000,
        maxConcurrency: 2
      },
      instructionProvenance: []
    },
    runState: {
      schemaVersion: 1,
      runId: "run-clark-y",
      projectId: "project-clark-y",
      status: "running",
      revision: 7,
      parentRevisionHash: "b".repeat(64),
      stateHash: "c".repeat(64),
      taskContractId: "task-clark-y",
      taskContractHash: "a".repeat(64),
      taskGraph: {
        schemaVersion: 1,
        graphId: "graph-clark-y",
        contentHash: "d".repeat(64),
        nodes: [{ id: "node-execute", kind: "execute_tools", dependencyNodeIds: [], terminal: true }]
      },
      currentNodeId: "node-execute",
      checkpointId: "checkpoint-6",
      iterationCompletedActionIds: ["fetch-coordinates"],
      completedNodeReceipts: [],
      pendingNodeIds: [],
      artifactRefs: [],
      evidenceRefs: [],
      verifiedFacts: [],
      decisions: [],
      assumptions: [],
      openQuestions: [],
      blockedReasons: [],
      budgetLimits: {
        maxDurationMs: 60_000,
        maxInputTokens: 8_000,
        maxOutputTokens: 2_000,
        maxToolCalls: 8,
        maxRetries: 1,
        maxEstimatedCostMicrousd: 0,
        maxToolOutputBytes: 1_000_000,
        maxConcurrency: 2
      },
      budgetUsage: { durationMs: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, retries: 0, estimatedCostMicrousd: 0, toolOutputBytes: 0 },
      nextProposedNodeIds: [],
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z"
    },
    provider: { providerId: "provider-one", modelId: "model-one", capabilityReceipt: STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT },
    instructions: [],
    evidence: [],
    memories: [],
    tools: [],
    artifacts: [],
    priorOutputs: [],
    candidateSelections: {
      memory: {
        source: "snapshot.global_memory_items",
        status: "empty",
        candidateCount: 0,
        selectedIds: [],
        omittedCount: 0,
        emptyReason: "no_project_validated_candidates"
      },
      priorOutputs: {
        source: "snapshot.conversation_artifacts",
        status: "empty",
        candidateCount: 0,
        selectedIds: [],
        omittedCount: 0,
        emptyReason: "no_hash_bearing_conversation_artifacts"
      }
    },
    budget: { tokenBudget: 8_000, maxChars: 12_000 }
  };
}
