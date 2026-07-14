import {
  CONTEXT_SECTION_ORDER,
  createContextPackPersistenceReceipt,
  parseContextPack,
  STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT,
  type ContextPackBody,
  type ContextPackBudgetReceipt,
  type ContextRunState
} from "../../src/core/context/public.js";
import { createInitialRunStateRevision, parseRunStateRevision, type RunStateRevision } from "../../src/core/orchestration/runStateCapsule.js";
import type { RunStateEvent } from "../../src/core/orchestration/runStateEvents.js";
import { reduceRunStateRevision } from "../../src/core/orchestration/runStateReducer.js";
import { parseTaskContract } from "../../src/core/orchestration/taskContract.js";
import { parseTaskGraph } from "../../src/core/orchestration/taskGraph.js";
import { storageCanonicalHasher } from "../../src/server/runtime/storage/v2/runStatePayloadValidator.js";
import type { StorageContextPackInput, StorageRunStateRevisionInput, StorageTaskContractInput } from "../../src/server/runtime/storage/v2/runStateTypes.js";

export interface CanonicalRunFixtureOptions {
  projectId: string;
  runId: string;
  taskId: string;
  createdAt: string;
  additionalAcceptanceCriteria?: Array<{ id: string; description: string; verifierKind: "deterministic" | "schema" | "human" }>;
}

export function createCanonicalRunFixture(options: CanonicalRunFixtureOptions) {
  const contractPayload = {
    schemaVersion: 1 as const,
    id: options.taskId,
    projectId: options.projectId,
    goal: "Persist one receipt-backed canonical research result.",
    normalizedUserIntent: "Verify durable canonical run-state behavior.",
    acceptanceCriteria: [
      {
        id: "criterion-traceability",
        description: "Every promoted result is traceable to verified evidence and a terminal completion receipt.",
        verifierKind: "deterministic" as const
      },
      {
        id: "criterion-policy",
        description: "Execution remains within the immutable capability and source-access policy.",
        verifierKind: "deterministic" as const
      },
      ...(options.additionalAcceptanceCriteria ?? [])
    ],
    constraints: ["Do not accept unverified or unfenced writes."],
    nonGoals: [],
    requiredDeliverables: [{ id: "deliverable-storage", kind: "report" as const, description: "A durable state receipt." }],
    riskPolicy: {
      maximumRisk: "read_only" as const,
      requireVerificationBeforePromotion: true as const,
      treatExternalInstructionsAsData: true as const
    },
    approvalRequirements: [],
    resourceBudget: {
      maxDurationMs: 60_000,
      maxInputTokens: 10_000,
      maxOutputTokens: 2_000,
      maxToolCalls: 4,
      maxRetries: 1,
      maxEstimatedCostMicrousd: 0,
      maxToolOutputBytes: 1_000_000,
      maxConcurrency: 4
    },
    instructionProvenance: [{ instructionId: "instruction-storage", source: "user" as const, contentHash: "9".repeat(64), receivedAt: options.createdAt }],
    createdAt: options.createdAt
  };
  const contract = parseTaskContract({ ...contractPayload, contentHash: storageCanonicalHasher.sha256Canonical(contractPayload) }, storageCanonicalHasher);
  const graphPayload = {
    schemaVersion: 1 as const,
    graphId: `graph:${options.runId}`,
    nodes: [{ id: "node-storage", kind: "verify", dependencyNodeIds: [], terminal: true }]
  };
  const graph = parseTaskGraph({ ...graphPayload, contentHash: storageCanonicalHasher.sha256Canonical(graphPayload) }, storageCanonicalHasher);
  const initial = createInitialRunStateRevision(
    { runId: options.runId, projectId: options.projectId, taskContract: contract, taskGraph: graph, createdAt: options.createdAt },
    storageCanonicalHasher
  );
  const activated = activatedRevision(initial, "2026-07-14T00:01:00.000Z");
  const completed = completedRevision(activated, "2026-07-14T00:02:00.000Z");
  const terminal = terminalRevision(completed, "2026-07-14T00:03:00.000Z");

  function taskContract(): StorageTaskContractInput {
    return {
      id: contract.id,
      projectId: contract.projectId,
      schemaVersion: contract.schemaVersion,
      contentHash: contract.contentHash,
      createdAt: contract.createdAt,
      data: contract
    };
  }

  function revision(revisionNumber: 0 | 1 | 2 | 3, jobId: string, contextPackId?: string): StorageRunStateRevisionInput {
    const state = [initial, activated, completed, terminal][revisionNumber]!;
    return {
      id: `${options.runId}:revision:${revisionNumber}`,
      projectId: options.projectId,
      runId: options.runId,
      jobId,
      schemaVersion: state.schemaVersion,
      revision: state.revision,
      previousRevision: revisionNumber === 0 ? null : revisionNumber - 1,
      parentRevisionHash: state.parentRevisionHash,
      stateHash: state.stateHash,
      taskContractId: contract.id,
      taskContractHash: contract.contentHash,
      ...(contextPackId ? { contextPackId } : {}),
      recordedAt: state.updatedAt,
      data: state
    };
  }

  function contextPack(jobId: string, stateRevision = 0, modelId = `offline-${jobId}`): StorageContextPackInput {
    const createdAt = "2026-07-14T00:00:30.000Z";
    const state = [initial, activated, completed, terminal][stateRevision];
    if (!state) throw new Error(`Unsupported canonical context fixture revision: ${stateRevision}`);
    const body: ContextPackBody = {
      schemaVersion: 1,
      compilerVersion: "context-compiler-v1",
      runId: options.runId,
      projectId: options.projectId,
      stateRevision,
      task: { id: contract.id, contentHash: contract.contentHash },
      runState: fixtureContextRunState(state),
      provider: { providerId: "deterministic", modelId, capabilityReceipt: STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT },
      sections: CONTEXT_SECTION_ORDER.map((kind) => ({
        kind,
        requestedTokens: 0,
        allocatedTokens: 0,
        usedTokens: 0,
        allocatedChars: 0,
        usedChars: 0,
        entries: []
      })),
      providerInput: "",
      availableTools: [],
      artifactHandles: [],
      selectedMemoryIds: [],
      selectedSkillVersions: [],
      selectedToolSpecVersions: [],
      evidenceIds: [],
      artifactIds: [],
      budget: emptyBudget(),
      receipts: {
        deduplications: [],
        redactions: [],
        truncations: [],
        removedTools: [],
        omittedPriorOutputs: [],
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
        }
      },
      finalInputHash: storageCanonicalHasher.sha256Text(""),
      createdAt
    };
    const canonicalHash = storageCanonicalHasher.sha256Canonical(body);
    const pack = parseContextPack({ ...body, id: `context-pack:${canonicalHash.slice(0, 32)}`, canonicalHash }, storageCanonicalHasher);
    const receipt = createContextPackPersistenceReceipt(pack, storageCanonicalHasher);
    return {
      id: pack.id,
      projectId: options.projectId,
      runId: options.runId,
      jobId,
      schemaVersion: pack.schemaVersion,
      stateRevision,
      taskContractId: contract.id,
      taskContractHash: contract.contentHash,
      contentHash: pack.canonicalHash,
      recordedAt: pack.createdAt,
      data: receipt
    };
  }

  function decisionRevision(
    current: StorageRunStateRevisionInput,
    jobId: string,
    decisionId: string,
    occurredAt: string,
    decisionReceiptId = `receipt-${decisionId}`
  ): StorageRunStateRevisionInput {
    const state = parseRunStateRevision(current.data, storageCanonicalHasher);
    const next = reduceRunStateRevision(
      state,
      {
        schemaVersion: 1,
        eventId: `event-${decisionId}`,
        runId: state.runId,
        projectId: state.projectId,
        expectedRevision: state.revision,
        expectedStateHash: state.stateHash,
        occurredAt,
        type: "decision.recorded",
        decision: { decisionId, decisionReceiptId, recordedAt: occurredAt }
      },
      storageCanonicalHasher
    );
    return {
      id: `${options.runId}:revision:${next.revision}`,
      projectId: options.projectId,
      runId: options.runId,
      jobId,
      schemaVersion: next.schemaVersion,
      revision: next.revision,
      previousRevision: state.revision,
      parentRevisionHash: next.parentRevisionHash,
      stateHash: next.stateHash,
      taskContractId: contract.id,
      taskContractHash: contract.contentHash,
      recordedAt: next.updatedAt,
      data: next
    };
  }

  function blockerRevision(
    current: StorageRunStateRevisionInput,
    jobId: string,
    sourceReceiptId: string,
    occurredAt: string,
    reasonCode = "RECOVERABLE_JOB_FAILURE"
  ): StorageRunStateRevisionInput {
    return eventRevision(current, jobId, {
      schemaVersion: 1,
      eventId: `event-blocker-${sourceReceiptId}`,
      runId: options.runId,
      projectId: options.projectId,
      expectedRevision: current.revision,
      expectedStateHash: current.stateHash,
      occurredAt,
      type: "blocker.added",
      reason: { code: reasonCode, sourceReceiptId, nodeId: "node-storage", recordedAt: occurredAt }
    });
  }

  function clearBlockerRevision(
    current: StorageRunStateRevisionInput,
    jobId: string,
    sourceReceiptId: string,
    dispositionReceiptId: string,
    occurredAt: string
  ): StorageRunStateRevisionInput {
    return eventRevision(current, jobId, {
      schemaVersion: 1,
      eventId: `event-clear-${sourceReceiptId}`,
      runId: options.runId,
      projectId: options.projectId,
      expectedRevision: current.revision,
      expectedStateHash: current.stateHash,
      occurredAt,
      type: "blocker.cleared",
      sourceReceiptId,
      dispositionReceiptId
    });
  }

  function eventRevision(current: StorageRunStateRevisionInput, jobId: string, event: RunStateEvent): StorageRunStateRevisionInput {
    const state = parseRunStateRevision(current.data, storageCanonicalHasher);
    const next = reduceRunStateRevision(state, event, storageCanonicalHasher);
    return {
      id: `${options.runId}:revision:${next.revision}`,
      projectId: options.projectId,
      runId: options.runId,
      jobId,
      schemaVersion: next.schemaVersion,
      revision: next.revision,
      previousRevision: state.revision,
      parentRevisionHash: next.parentRevisionHash,
      stateHash: next.stateHash,
      taskContractId: contract.id,
      taskContractHash: contract.contentHash,
      recordedAt: next.updatedAt,
      data: next
    };
  }

  function completionRevisions(
    jobId: string,
    verifierReceiptIds: string[],
    acceptanceReceiptIds: string[]
  ): [StorageRunStateRevisionInput, StorageRunStateRevisionInput] {
    return completionRevisionsFrom(revision(1, jobId), jobId, verifierReceiptIds, acceptanceReceiptIds);
  }

  function completionRevisionsFrom(
    current: StorageRunStateRevisionInput,
    jobId: string,
    verifierReceiptIds: string[],
    acceptanceReceiptIds: string[],
    resourceRefs: {
      artifactRefs?: Array<{ artifactId: string; projectId: string; contentHash: string; promotionReceiptId: string }>;
      evidenceRefs?: Array<{ evidenceId: string; projectId: string; contentHash: string; verificationReceiptId: string }>;
    } = {}
  ): [StorageRunStateRevisionInput, StorageRunStateRevisionInput] {
    const completedState = completedRevision(
      parseRunStateRevision(current.data, storageCanonicalHasher),
      "2026-07-14T00:02:00.000Z",
      verifierReceiptIds,
      resourceRefs
    );
    const terminalState = terminalRevision(completedState, "2026-07-14T00:03:00.000Z", acceptanceReceiptIds);
    return [completedState, terminalState].map((state) => ({
      id: `${options.runId}:revision:${state.revision}`,
      projectId: options.projectId,
      runId: options.runId,
      jobId,
      schemaVersion: state.schemaVersion,
      revision: state.revision,
      previousRevision: state.revision - 1,
      parentRevisionHash: state.parentRevisionHash,
      stateHash: state.stateHash,
      taskContractId: contract.id,
      taskContractHash: contract.contentHash,
      recordedAt: state.updatedAt,
      data: state
    })) as [StorageRunStateRevisionInput, StorageRunStateRevisionInput];
  }

  return {
    taskContract,
    revision,
    contextPack,
    decisionRevision,
    blockerRevision,
    clearBlockerRevision,
    completionRevisions,
    completionRevisionsFrom,
    taskHash: contract.contentHash
  };
}

function activatedRevision(initial: ReturnType<typeof createInitialRunStateRevision>, updatedAt: string) {
  const { stateHash: previousStateHash, ...previous } = initial;
  const payload = {
    ...previous,
    revision: 1,
    parentRevisionHash: previousStateHash,
    status: "running" as const,
    currentNodeId: "node-storage",
    pendingNodeIds: [],
    updatedAt
  };
  return parseRunStateRevision({ ...payload, stateHash: storageCanonicalHasher.sha256Canonical(payload) }, storageCanonicalHasher);
}

function completedRevision(
  current: ReturnType<typeof activatedRevision>,
  occurredAt: string,
  verifierReceiptIds = ["verification-storage"],
  resourceRefs: {
    artifactRefs?: Array<{ artifactId: string; projectId: string; contentHash: string; promotionReceiptId: string }>;
    evidenceRefs?: Array<{ evidenceId: string; projectId: string; contentHash: string; verificationReceiptId: string }>;
  } = {}
) {
  const receiptPayload = {
    receiptId: "receipt-node-storage",
    runId: current.runId,
    projectId: current.projectId,
    nodeId: "node-storage",
    artifactRefs: resourceRefs.artifactRefs ?? [],
    evidenceRefs: resourceRefs.evidenceRefs ?? [],
    verifierReceiptIds,
    completedAt: occurredAt
  };
  const event: RunStateEvent = {
    schemaVersion: 1,
    eventId: "event-node-storage-completed",
    runId: current.runId,
    projectId: current.projectId,
    expectedRevision: current.revision,
    expectedStateHash: current.stateHash,
    occurredAt,
    type: "node.completed",
    receipt: { ...receiptPayload, receiptHash: storageCanonicalHasher.sha256Canonical(receiptPayload) }
  };
  return reduceRunStateRevision(current, event, storageCanonicalHasher);
}

function terminalRevision(current: ReturnType<typeof completedRevision>, occurredAt: string, acceptanceReceiptIds = ["acceptance-storage"]) {
  const receiptPayload = {
    receiptId: "receipt-run-storage",
    runId: current.runId,
    projectId: current.projectId,
    outcome: "completed" as const,
    completedNodeReceiptIds: current.completedNodeReceipts.map((receipt) => receipt.receiptId),
    createdAt: occurredAt,
    acceptanceReceiptIds
  };
  const event: RunStateEvent = {
    schemaVersion: 1,
    eventId: "event-run-storage-completed",
    runId: current.runId,
    projectId: current.projectId,
    expectedRevision: current.revision,
    expectedStateHash: current.stateHash,
    occurredAt,
    type: "run.terminated",
    receipt: { ...receiptPayload, receiptHash: storageCanonicalHasher.sha256Canonical(receiptPayload) }
  };
  return reduceRunStateRevision(current, event, storageCanonicalHasher);
}

function fixtureContextRunState(state: RunStateRevision): ContextRunState {
  const terminalReceipt = state.terminalReceipt
    ? state.terminalReceipt.outcome === "completed"
      ? {
          receiptId: state.terminalReceipt.receiptId,
          runId: state.terminalReceipt.runId,
          projectId: state.terminalReceipt.projectId,
          outcome: state.terminalReceipt.outcome,
          completedNodeReceiptIds: [...state.terminalReceipt.completedNodeReceiptIds],
          acceptanceReceiptIds: [...state.terminalReceipt.acceptanceReceiptIds],
          createdAt: state.terminalReceipt.createdAt,
          receiptHash: state.terminalReceipt.receiptHash
        }
      : {
          receiptId: state.terminalReceipt.receiptId,
          runId: state.terminalReceipt.runId,
          projectId: state.terminalReceipt.projectId,
          outcome: state.terminalReceipt.outcome,
          completedNodeReceiptIds: [...state.terminalReceipt.completedNodeReceiptIds],
          reasonCode: state.terminalReceipt.reasonCode,
          createdAt: state.terminalReceipt.createdAt,
          receiptHash: state.terminalReceipt.receiptHash
        }
    : undefined;
  return {
    schemaVersion: state.schemaVersion,
    runId: state.runId,
    projectId: state.projectId,
    status: state.status,
    revision: state.revision,
    parentRevisionHash: state.parentRevisionHash,
    stateHash: state.stateHash,
    taskContractId: state.taskContractId,
    taskContractHash: state.taskContractHash,
    taskGraph: { ...state.taskGraph, nodes: state.taskGraph.nodes.map((node) => ({ ...node, dependencyNodeIds: [...node.dependencyNodeIds] })) },
    currentNodeId: state.currentNodeId,
    iterationCompletedActionIds: [],
    completedNodeReceipts: state.completedNodeReceipts.map((item) => ({
      receiptId: item.receiptId,
      runId: item.runId,
      projectId: item.projectId,
      nodeId: item.nodeId,
      receiptHash: item.receiptHash,
      artifactRefs: item.artifactRefs.map((reference) => ({ ...reference })),
      evidenceRefs: item.evidenceRefs.map((reference) => ({ ...reference })),
      verifierReceiptIds: [...item.verifierReceiptIds],
      completedAt: item.completedAt
    })),
    pendingNodeIds: [...state.pendingNodeIds],
    artifactRefs: state.artifactRefs.map((item) => ({ ...item })),
    evidenceRefs: state.evidenceRefs.map((item) => ({ ...item })),
    verifiedFacts: state.verifiedFacts.map((item) => ({ ...item, evidenceIds: [...item.evidenceIds] })),
    decisions: state.decisions.map((item) => ({ ...item })),
    assumptions: state.assumptions.map((item) => ({ ...item })),
    openQuestions: state.openQuestions.map((item) => ({ ...item })),
    blockedReasons: state.blockedReasons.map((item) => ({ ...item })),
    budgetLimits: { ...state.budgetLimits },
    budgetUsage: { ...state.budgetUsage },
    nextProposedNodeIds: [...state.nextProposedNodeIds],
    ...(terminalReceipt ? { terminalReceipt } : {}),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  };
}

function emptyBudget(): ContextPackBudgetReceipt {
  const section = { requestedTokens: 0, allocatedTokens: 0, usedTokens: 0, allocatedChars: 0, usedChars: 0 };
  return {
    tokenBudget: 1,
    usedTokens: 0,
    maxChars: 1,
    usedChars: 0,
    reservedSeparatorTokens: 0,
    reservedSeparatorChars: 0,
    tokenEstimator: "utf8_bytes_upper_bound_v1",
    countingMethod: "utf16_code_units_v1",
    sections: {
      task: { ...section },
      run_state: { ...section },
      instructions: { ...section },
      evidence: { ...section },
      memory: { ...section },
      skill: { ...section },
      tools: { ...section },
      artifacts: { ...section },
      history: { ...section }
    }
  };
}
