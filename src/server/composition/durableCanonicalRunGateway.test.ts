import { describe, expect, it } from "vitest";
import { createContextPackPersistenceReceipt, STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT } from "../../core/context/public.js";
import type { ResearchSnapshot } from "../../core/shared/evaluationTypes.js";
import { ResearchLoopStep, type ResearchSpecification } from "../../core/shared/researchTypes.js";
import type {
  StorageCommitRunStateRevisionInput,
  StorageContextPack,
  StorageRunOwnership,
  StorageRunStateRevision,
  StorageSaveContextPackInput,
  StorageTaskContract,
  StorageTaskContractInput
} from "../runtime/storage/v2/runStateTypes.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";
import { CanonicalRunRuntime } from "./canonicalRunRuntime.js";
import type { CanonicalRunOwner, CanonicalRunPolicy } from "./canonicalRunTypes.js";
import { DurableCanonicalRunGateway } from "./durableCanonicalRunGateway.js";

const T0 = "2026-07-14T00:00:00.000Z";
const T1 = "2026-07-14T00:01:00.000Z";
const OWNER = { projectId: "project-gateway", runId: "run:job-root", jobId: "job-root" } satisfies CanonicalRunOwner;
const hasher = { sha256Canonical: durableJobRequestHash };

describe("DurableCanonicalRunGateway", () => {
  it("maps parser-validated contracts, reducer revisions, and compiled context into exact storage envelopes", async () => {
    const storage = new DeterministicEnvelopeStorage();
    const runtime = new CanonicalRunRuntime({ gateway: new DurableCanonicalRunGateway(storage), hasher });

    const prepared = await runtime.prepareInitialRun({
      owner: OWNER,
      rootJobId: OWNER.jobId,
      rootJobCreatedAt: T0,
      snapshot: snapshotFixture(),
      specification: specificationFixture(),
      policy: policyFixture(),
      taskLimits: {
        maxDurationMs: 60_000,
        maxInputTokens: 24_000,
        maxOutputTokens: 4_000,
        maxToolCalls: 8,
        maxRetries: 1,
        maxEstimatedCostMicrousd: 100_000,
        maxToolOutputBytes: 1_000_000,
        maxConcurrency: 4
      },
      preparedAt: T0
    });
    const pack = await runtime.compilePlanningContext({
      owner: OWNER,
      snapshot: snapshotFixture(),
      specification: specificationFixture(),
      iteration: 1,
      provider: { providerId: "codex-oauth", modelId: "gpt-5.6-sol", capabilityReceipt: STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT },
      selectedTools: [
        {
          name: "DataAnalysisTool",
          version: "1",
          summary: "Validate a receipt-backed local result.",
          inputContractHash: "a".repeat(64),
          requiredCapabilities: [],
          sideEffects: [],
          priority: 900
        }
      ],
      policyInstructions: [],
      evidence: [],
      artifactHandles: [],
      memories: [],
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
      budget: { tokenBudget: 16_000, maxChars: 64_000 },
      expectedState: { revision: prepared.state.revision, stateHash: prepared.state.stateHash },
      compiledAt: T1,
      policy: policyFixture()
    });

    expect(storage.taskWrites).toEqual([
      {
        id: prepared.taskContract.id,
        projectId: OWNER.projectId,
        schemaVersion: prepared.taskContract.schemaVersion,
        contentHash: prepared.taskContract.contentHash,
        createdAt: prepared.taskContract.createdAt,
        data: prepared.taskContract
      }
    ]);
    expect(storage.taskOwners).toEqual([OWNER]);
    expect(storage.revisionWrites.map((write) => write.expectedRevision)).toEqual([null, 0]);
    expect(storage.revisionWrites.map((write) => write.revision)).toEqual([
      expect.objectContaining({
        id: `${OWNER.runId}:revision:0`,
        ...OWNER,
        revision: 0,
        previousRevision: null,
        parentRevisionHash: null,
        data: expect.objectContaining({ revision: 0 })
      }),
      expect.objectContaining({
        id: `${OWNER.runId}:revision:1`,
        ...OWNER,
        revision: 1,
        previousRevision: 0,
        parentRevisionHash: storage.revisionWrites[0]?.revision.stateHash,
        data: prepared.state
      })
    ]);
    expect(storage.contextWrites).toEqual([
      {
        expectedRevision: 1,
        contextPack: {
          id: pack.id,
          ...OWNER,
          schemaVersion: pack.schemaVersion,
          stateRevision: 1,
          taskContractId: prepared.taskContract.id,
          taskContractHash: prepared.taskContract.contentHash,
          contentHash: pack.canonicalHash,
          recordedAt: pack.createdAt,
          data: createContextPackPersistenceReceipt(pack, { sha256Canonical: durableJobRequestHash })
        }
      }
    ]);
    expect(JSON.stringify(storage.contextWrites)).not.toContain(pack.providerInput);
  });
});

class DeterministicEnvelopeStorage {
  readonly taskOwners: StorageRunOwnership[] = [];
  readonly taskWrites: StorageTaskContractInput[] = [];
  readonly revisionWrites: StorageCommitRunStateRevisionInput[] = [];
  readonly contextWrites: StorageSaveContextPackInput[] = [];
  private readonly contracts = new Map<string, StorageTaskContract>();
  private readonly revisions = new Map<string, StorageRunStateRevision[]>();
  private readonly packs = new Map<string, StorageContextPack>();

  async saveCanonicalTaskContract(owner: StorageRunOwnership, input: StorageTaskContractInput): Promise<StorageTaskContract> {
    this.taskOwners.push(owner);
    this.taskWrites.push(input);
    this.contracts.set(input.id, input);
    return input;
  }

  async getCanonicalTaskContract(projectId: string, contractId: string): Promise<StorageTaskContract | undefined> {
    const value = this.contracts.get(contractId);
    return value?.projectId === projectId ? value : undefined;
  }

  async latestCanonicalRunState(owner: StorageRunOwnership): Promise<StorageRunStateRevision | undefined> {
    const value = this.revisions.get(owner.runId)?.at(-1);
    return value?.projectId === owner.projectId ? value : undefined;
  }

  async commitCanonicalRunState(input: StorageCommitRunStateRevisionInput): Promise<StorageRunStateRevision> {
    const values = this.revisions.get(input.revision.runId) ?? [];
    const actual = values.at(-1)?.revision ?? null;
    if (actual !== input.expectedRevision) throw new Error(`stale revision ${String(input.expectedRevision)} != ${String(actual)}`);
    values.push(input.revision);
    this.revisions.set(input.revision.runId, values);
    this.revisionWrites.push(input);
    return input.revision;
  }

  async saveCanonicalContextPack(input: StorageSaveContextPackInput): Promise<StorageContextPack> {
    const latest = this.revisions.get(input.contextPack.runId)?.at(-1);
    if (latest?.revision !== input.expectedRevision || input.contextPack.stateRevision !== input.expectedRevision) {
      throw new Error("stale context pack");
    }
    this.packs.set(input.contextPack.id, input.contextPack);
    this.contextWrites.push(input);
    return input.contextPack;
  }

  async getCanonicalResumeContextPack(owner: StorageRunOwnership, predecessorJobId: string, contextPackId: string): Promise<StorageContextPack | undefined> {
    const value = this.packs.get(contextPackId);
    return value?.projectId === owner.projectId && value.runId === owner.runId && value.jobId === predecessorJobId ? value : undefined;
  }
}

function policyFixture(): CanonicalRunPolicy {
  return {
    requestedCapabilities: { agent: true, engineering: false, search: false },
    effectiveCapabilities: { agent: true, engineering: false, search: false },
    toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } },
    externalSideEffects: []
  };
}

function specificationFixture(): ResearchSpecification {
  return {
    id: "specification-gateway",
    projectId: OWNER.projectId,
    sourceResearchInputId: "input-gateway",
    researchQuestions: ["Does the canonical gateway preserve every envelope field?"],
    initialHypotheses: ["It does."],
    refinedHypotheses: ["Parser and reducer hashes survive storage mapping."],
    scope: "Deterministic local gateway verification.",
    assumptions: [],
    constraints: ["Do not access the network."],
    successCriteria: ["Every storage envelope matches the parsed core value."],
    requiredEvidenceTypes: ["deterministic receipt"],
    competencyQuestions: [],
    evaluationMetrics: ["hash equality"],
    createdAt: T0
  };
}

function snapshotFixture(): ResearchSnapshot {
  return {
    project: {
      id: OWNER.projectId,
      goal: "Verify the durable canonical storage boundary.",
      topic: "Canonical gateway",
      scope: "One local run.",
      budget: "Bounded fixture budget.",
      autonomyPolicy: { toolApproval: "automatic", allowAgent: true, allowExternalSearch: false, allowCodeExecution: false },
      createdAt: T0,
      updatedAt: T0,
      currentStep: ResearchLoopStep.PlanResearch,
      status: "running",
      projectRoot: OWNER.projectId
    },
    sessions: [],
    researchInputs: [
      {
        id: "input-gateway",
        projectId: OWNER.projectId,
        researchQuestion: "Does the gateway preserve canonical envelopes?",
        initialHypotheses: ["Yes."],
        constraints: ["Use actual core parsing and reduction."],
        expectedOutputs: ["A receipt-backed envelope assertion."],
        createdAt: T0
      }
    ],
    questions: [],
    hypotheses: [],
    evidence: [],
    artifacts: [],
    sources: [],
    chunks: [],
    toolRuns: [],
    agentPlans: [],
    researchPlans: [],
    specifications: [specificationFixture()],
    normalizedRecords: [],
    ontologyEntities: [],
    ontologyRelations: [],
    ontologyConstraints: [],
    projectContextSnapshots: [],
    hybridContexts: [],
    validationResults: [],
    continuationDecisions: [],
    finalOutputs: [],
    runAuditOutputs: [],
    benchmarkPlans: [],
    runtimeBlockers: [],
    stepErrors: [],
    legacyAgentRuns: [],
    ragContexts: [],
    results: [],
    iterations: []
  };
}
