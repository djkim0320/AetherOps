import { describe, expect, it } from "vitest";
import { STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT } from "../../core/context/public.js";
import type { ResearchSnapshot } from "../../core/shared/evaluationTypes.js";
import { ResearchLoopStep } from "../../core/shared/researchTypes.js";
import type { PlannerContextCompilationInput } from "../../core/tools/researchToolTypes.js";
import { defaultSettings } from "../runtime/storage/settingsStore.js";
import type {
  StorageCommitRunStateRevisionInput,
  StorageContextPack,
  StorageRunOwnership,
  StorageRunStateRevision,
  StorageSaveContextPackInput,
  StorageTaskContract,
  StorageTaskContractInput
} from "../runtime/storage/v2/runStateTypes.js";
import type { StorageToolAttempt, StorageToolAttemptStatus } from "../runtime/storage/v2/traceTypes.js";
import type { StorageCheckpoint } from "../runtime/storage/v2/types.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";
import { createCanonicalInitializationAnchor } from "./canonicalInitializationAnchor.js";
import { DEFAULT_CANONICAL_TASK_LIMITS, DurableCanonicalResearchSession } from "./durableCanonicalResearchSession.js";
import { DurableCanonicalRunGateway, storageCanonicalRevisionPlan } from "./durableCanonicalRunGateway.js";
import type { DurableJobRecord } from "./durableJobTypes.js";
import { CanonicalRunRuntime } from "./canonicalRunRuntime.js";
import { CanonicalRunRuntimeError } from "./canonicalRunTypes.js";
import { artifact, evidence, snapshotFixture, specificationFixture } from "./test/durableCanonicalResearchSessionFixtures.js";

const T0 = "2026-07-14T00:00:00.000Z";
const T1 = "2026-07-14T00:01:00.000Z";
const T2 = "2026-07-14T00:02:00.000Z";
const T3 = "2026-07-14T00:03:00.000Z";
const PROJECT_ID = "project-session";
const hasher = { sha256Canonical: durableJobRequestHash };

describe("DurableCanonicalResearchSession", () => {
  it("keeps root lineage stable and replays receipt-bound checkpoint revisions exactly once", async () => {
    const fixture = runtimeFixture();
    const root = job("job-root");
    fixture.jobs.add(root);
    const rootSession = await fixture.session(root);
    const prepared = await rootSession.prepare(snapshotFixture());
    const rootPack = await rootSession.compilePlannerContext(plannerInput(snapshotFixture()));
    const predecessorCheckpoint = checkpoint("checkpoint-root", root.id, T1, { canonicalContextPackId: rootPack.id });
    await commitSessionCheckpoint(rootSession, predecessorCheckpoint, fixture.storage);
    await commitSessionCheckpoint(rootSession, predecessorCheckpoint, fixture.storage);
    fixture.jobs.setLatestCheckpoint(predecessorCheckpoint);
    root.status = "paused";
    root.updatedAt = T1;
    const resumed = job("job-resume", { resumesJobId: root.id, resumeCheckpointId: predecessorCheckpoint.id, createdAt: T2, updatedAt: T2 });
    fixture.jobs.add(resumed);
    const resumedSession = await fixture.session(resumed);
    const replayed = await resumedSession.prepare(snapshotFixture());
    const resumePlan = await resumedSession.prepareResumeRevision(predecessorCheckpoint);
    for (const revision of storageCanonicalRevisionPlan(resumedSession.owner, resumePlan)) {
      await fixture.storage.commitCanonicalRunState(revision);
    }
    const resumedCheckpoint = checkpoint("checkpoint-resume", resumed.id, T3);
    fixture.jobs.setLatestCheckpoint(resumedCheckpoint);
    await commitSessionCheckpoint(resumedSession, resumedCheckpoint, fixture.storage);
    await commitSessionCheckpoint(resumedSession, resumedCheckpoint, fixture.storage);
    const pack = await resumedSession.compilePlannerContext(plannerInput(snapshotFixture()));
    expect(prepared.state.revision).toBe(1);
    expect(replayed.taskContract.contentHash).toBe(prepared.taskContract.contentHash);
    expect(pack.runId).toBe(`run:${root.id}`);
    expect(pack.stateRevision).toBe(4);
    expect(pack.runState.checkpointId).toBe(resumedCheckpoint.id);
    expect(fixture.storage.revisionWrites.map((write) => [write.revision.revision, write.revision.jobId])).toEqual([
      [0, root.id],
      [1, root.id],
      [2, root.id],
      [3, resumed.id],
      [4, resumed.id]
    ]);
    expect(fixture.storage.contextWrites.at(-1)?.contextPack).toMatchObject({
      runId: `run:${root.id}`,
      jobId: resumed.id,
      stateRevision: 4,
      contentHash: pack.canonicalHash
    });
  });

  it("rejects mutable snapshot candidates that differ from the checkpoint-bound ContextPack", async () => {
    const fixture = runtimeFixture();
    const root = job("job-binding-root");
    fixture.jobs.add(root);
    const base = snapshotFixture({ artifacts: [artifact("artifact-bound", { sha256: "a".repeat(64) })] });
    const rootSession = await fixture.session(root);
    await rootSession.prepare(base);
    const rootPack = await rootSession.compilePlannerContext(plannerInput(base));
    const predecessorCheckpoint = checkpoint("checkpoint-binding", root.id, T1, { canonicalContextPackId: rootPack.id });
    await commitSessionCheckpoint(rootSession, predecessorCheckpoint, fixture.storage);
    fixture.jobs.setLatestCheckpoint(predecessorCheckpoint);
    root.status = "paused";
    const resumed = job("job-binding-resume", {
      resumesJobId: root.id,
      resumeCheckpointId: predecessorCheckpoint.id,
      createdAt: T2,
      updatedAt: T2
    });
    fixture.jobs.add(resumed);
    const session = await fixture.session(resumed);
    await session.prepare(base);
    const plan = await session.prepareResumeRevision(predecessorCheckpoint);
    for (const revision of storageCanonicalRevisionPlan(session.owner, plan)) await fixture.storage.commitCanonicalRunState(revision);

    const changed = snapshotFixture({ artifacts: [artifact("artifact-bound", { sha256: "b".repeat(64) })] });
    await expect(session.compilePlannerContext(plannerInput(changed))).rejects.toMatchObject<Partial<CanonicalRunRuntimeError>>({
      code: "CANONICAL_RESUME_CONFLICT"
    });
    expect(fixture.storage.contextWrites).toHaveLength(1);
  });

  it("compiles only validation-receipted evidence and non-quarantined hash-bearing artifacts", async () => {
    const fixture = runtimeFixture();
    const root = job("job-selection");
    fixture.jobs.add(root);
    const session = await fixture.session(root);
    const snapshot = snapshotFixture({
      evidence: [
        evidence("evidence-verified", "Verified observation", {
          sourceId: "source-verified",
          metadata: { verificationReceiptId: "receipt:verified" }
        }),
        evidence("evidence-unverified", "Unverified observation"),
        evidence("evidence-quarantined", "Quarantined observation", {
          metadata: { quarantined: true, verificationReceiptId: "receipt:quarantined" }
        })
      ],
      artifacts: [
        artifact("artifact-promoted", { sha256: "B".repeat(64) }),
        { ...artifact("artifact-chat", { sha256: "e".repeat(64) }), category: "conversation_memo", content: "RAW_CONVERSATION_BODY_MUST_NOT_BE_EMBEDDED" },
        artifact("artifact-quarantined", { sha256: "c".repeat(64), quarantined: true }),
        artifact("artifact-unhashed", {})
      ],
      validationResults: [
        {
          id: "validation-receipt",
          projectId: PROJECT_ID,
          iteration: 1,
          status: "supported",
          confidence: 0.9,
          supportingEvidenceIds: ["evidence-verified", "evidence-quarantined"],
          contradictingEvidenceIds: [],
          relatedEntityIds: [],
          relatedRelationIds: [],
          reasoningSummary: "The deterministic receipt binds the verified observation.",
          limitations: [],
          evidenceGaps: [],
          createdAt: T1
        }
      ],
      globalMemoryItems: [
        {
          id: "memory-canonical-session",
          projectId: PROJECT_ID,
          sourceProjectId: PROJECT_ID,
          memoryScope: "global",
          title: "Canonical session receipt",
          content: "Canonical session restarts require receipt-bound state.",
          validationResultId: "validation-receipt",
          supportingRecordIds: ["record-memory-session"],
          supportingEvidenceIds: ["evidence-verified"],
          citations: [],
          promotionReason: "Validated for the active project.",
          validationStatus: "validated",
          createdAt: T1
        },
        {
          id: "memory-foreign-session",
          projectId: "project-foreign",
          sourceProjectId: "project-foreign",
          memoryScope: "global",
          title: "Canonical session foreign memory",
          content: "This cross-project memory must not be selected.",
          validationResultId: "validation-receipt",
          supportingRecordIds: ["record-memory-foreign"],
          supportingEvidenceIds: ["evidence-verified"],
          citations: [],
          promotionReason: "Foreign fixture.",
          validationStatus: "validated",
          createdAt: T1
        }
      ]
    });
    await session.prepare(snapshot);
    const pack = await session.compilePlannerContext(plannerInput(snapshot));
    expect(pack.evidenceIds).toEqual(["evidence-verified"]);
    expect(pack.artifactIds).toEqual(["artifact-chat", "artifact-promoted"]);
    expect(pack.artifactHandles).toEqual([
      { artifactId: "artifact-chat", kind: "conversation_memo", sha256: "e".repeat(64) },
      { artifactId: "artifact-promoted", kind: "generated_artifact", sha256: "b".repeat(64) }
    ]);
    expect(pack.selectedMemoryIds).toEqual(["memory-canonical-session"]);
    expect(pack.receipts.candidateSelections).toMatchObject({
      memory: { status: "selected", selectedIds: ["memory-canonical-session"] },
      priorOutputs: { status: "selected", selectedIds: ["prior:artifact-chat"] }
    });
    expect(pack.sections.find((section) => section.kind === "evidence")?.entries[0]).toMatchObject({
      id: "evidence-verified",
      trust: "verified",
      sourceRefs: ["receipt:verified", "source-verified", "validation-receipt"]
    });
    expect(pack.providerInput).not.toContain("Unverified observation");
    expect(pack.providerInput).not.toContain("Quarantined observation");
    expect(pack.providerInput).not.toContain("RAW_CONVERSATION_BODY_MUST_NOT_BE_EMBEDDED");
    expect(pack.providerInput).not.toContain("memory-foreign-session");
    expect(pack.selectedToolSpecVersions).toEqual([
      {
        name: "DataAnalysisTool",
        version: "2",
        inputContractHash: durableJobRequestHash("strict-data-analysis-input-v2")
      }
    ]);
  });

  it("rejects capability or tool-policy changes anywhere in a resume lineage", async () => {
    const fixture = runtimeFixture();
    const root = job("job-policy-root");
    const changed = job("job-policy-resume", {
      resumesJobId: root.id,
      resumeCheckpointId: "checkpoint-policy",
      effectiveCapabilities: { agent: true, engineering: true, search: false }
    });
    fixture.jobs.add(root);
    fixture.jobs.add(changed);
    await expect(fixture.session(changed)).rejects.toMatchObject<Partial<CanonicalRunRuntimeError>>({ code: "CANONICAL_TASK_MISMATCH" });
    expect(fixture.storage.revisionWrites).toHaveLength(0);
  });

  it("fails closed before canonical persistence while any lineage attempt remains nonterminal", async () => {
    const fixture = runtimeFixture();
    const root = job("job-pending");
    fixture.jobs.add(root);
    fixture.jobs.setAttempts(root.id, [toolAttempt("attempt-running", root.id, "running")]);
    const session = await fixture.session(root);

    await expect(session.prepare(snapshotFixture())).rejects.toMatchObject<Partial<CanonicalRunRuntimeError>>({
      code: "PENDING_EXTERNAL_SIDE_EFFECT"
    });
    expect(fixture.storage.taskWrites).toHaveLength(0);
    expect(fixture.storage.revisionWrites).toHaveLength(0);
  });

  it("fails closed on an ambiguous completed filesystem attempt anywhere in the resume lineage", async () => {
    const fixture = runtimeFixture();
    const root = job("job-ambiguous-root", { status: "interrupted", updatedAt: T1 });
    const resumed = job("job-ambiguous-resume", {
      resumesJobId: root.id,
      resumeCheckpointId: "checkpoint-ambiguous",
      createdAt: T2,
      updatedAt: T2
    });
    fixture.jobs.add(root);
    fixture.jobs.add(resumed);
    fixture.jobs.setAttempts(root.id, [
      {
        ...toolAttempt("attempt-ambiguous", root.id, "completed"),
        traceVersion: 1,
        traceAvailability: "vnext",
        descriptorVersion: "1",
        descriptorSideEffects: ["filesystem"],
        sideEffectKey: "side-effect-ambiguous",
        idempotencyKey: "idempotency-ambiguous"
      }
    ]);
    const session = await fixture.session(resumed);

    await expect(session.prepare(snapshotFixture())).rejects.toMatchObject<Partial<CanonicalRunRuntimeError>>({ code: "PENDING_EXTERNAL_SIDE_EFFECT" });
    expect(fixture.storage.taskWrites).toHaveLength(0);
    expect(fixture.storage.revisionWrites).toHaveLength(0);
  });

  it("accepts only the exact committed checkpoint selected by the resume job", async () => {
    const fixture = runtimeFixture();
    const root = job("job-checkpoint-root");
    fixture.jobs.add(root);
    const rootSession = await fixture.session(root);
    await rootSession.prepare(snapshotFixture());
    root.status = "paused";
    const resumed = job("job-checkpoint-resume", {
      resumesJobId: root.id,
      resumeCheckpointId: "checkpoint-selected",
      createdAt: T2,
      updatedAt: T2
    });
    fixture.jobs.add(resumed);
    const resumedSession = await fixture.session(resumed);
    await expect(resumedSession.prepareResumeRevision(checkpoint("checkpoint-other", root.id, T1))).rejects.toMatchObject<Partial<CanonicalRunRuntimeError>>({
      code: "CANONICAL_RUN_OWNERSHIP_MISMATCH"
    });
    expect(fixture.storage.revisionWrites).toHaveLength(2);
  });

  it("initializes rev0 from the immutable root anchor after a pre-revision crash", async () => {
    const fixture = runtimeFixture();
    const anchoredSnapshot = snapshotFixture();
    const anchor = createCanonicalInitializationAnchor(
      {
        snapshot: anchoredSnapshot,
        specification: specificationFixture(),
        policy: {
          requestedCapabilities: { agent: true, engineering: false, search: false },
          effectiveCapabilities: { agent: true, engineering: false, search: false },
          toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } },
          externalSideEffects: []
        },
        taskLimits: DEFAULT_CANONICAL_TASK_LIMITS
      },
      hasher
    );
    const root = job("job-crashed-before-rev0", { status: "interrupted", canonicalInitializationAnchor: anchor });
    const resumed = job("job-bootstrap-resume", {
      resumesJobId: root.id,
      createdAt: T2,
      updatedAt: T2
    });
    fixture.jobs.add(root);
    fixture.jobs.add(resumed);
    const session = await fixture.session(resumed);
    const changedSnapshot = snapshotFixture({ project: { ...anchoredSnapshot.project, goal: "A later mutable project goal." } });

    const prepared = await session.prepare(changedSnapshot);
    const replay = await session.prepare(changedSnapshot);

    expect(session.isBootstrapResume).toBe(true);
    expect(prepared.taskContract.goal).toBe(anchoredSnapshot.project.goal);
    expect(replay).toEqual(prepared);
    expect(fixture.storage.revisionWrites.map((write) => [write.revision.revision, write.revision.jobId])).toEqual([
      [0, resumed.id],
      [1, resumed.id]
    ]);
  });

  it("fails closed when a checkpoint-free bootstrap anchor is missing or mutated", async () => {
    const missingFixture = runtimeFixture();
    const missingRoot = job("job-anchor-missing", { status: "interrupted" });
    const missingResume = job("job-anchor-missing-resume", { resumesJobId: missingRoot.id, createdAt: T2, updatedAt: T2 });
    missingFixture.jobs.add(missingRoot);
    missingFixture.jobs.add(missingResume);
    await expect(missingFixture.session(missingResume)).rejects.toMatchObject<Partial<CanonicalRunRuntimeError>>({ code: "CANONICAL_RUN_NOT_READY" });

    const mutatedFixture = runtimeFixture();
    const valid = createCanonicalInitializationAnchor(
      {
        snapshot: snapshotFixture(),
        specification: specificationFixture(),
        policy: canonicalPolicyFixture(),
        taskLimits: DEFAULT_CANONICAL_TASK_LIMITS
      },
      hasher
    );
    const mutated = { ...valid, taskSource: { ...valid.taskSource, project: { ...valid.taskSource.project, goal: "Mutated after enqueue." } } };
    const mutatedRoot = job("job-anchor-mutated", { status: "interrupted", canonicalInitializationAnchor: mutated });
    const mutatedResume = job("job-anchor-mutated-resume", { resumesJobId: mutatedRoot.id, createdAt: T2, updatedAt: T2 });
    mutatedFixture.jobs.add(mutatedRoot);
    mutatedFixture.jobs.add(mutatedResume);
    const session = await mutatedFixture.session(mutatedResume);
    await expect(session.prepare(snapshotFixture())).rejects.toMatchObject<Partial<CanonicalRunRuntimeError>>({ code: "CANONICAL_TASK_MISMATCH" });
    expect(mutatedFixture.storage.revisionWrites).toHaveLength(0);
  });

  it("rejects root anchors with cross-project ownership or a changed durable policy", async () => {
    const base = snapshotFixture();
    const foreignSnapshot = snapshotFixture({
      project: { ...base.project, id: "project-foreign", projectRoot: "project-foreign" },
      researchInputs: base.researchInputs.map((item) => ({ ...item, projectId: "project-foreign" })),
      specifications: base.specifications.map((item) => ({ ...item, projectId: "project-foreign" }))
    });
    const foreignSpecification = { ...specificationFixture(), projectId: "project-foreign" };
    const foreignAnchor = createCanonicalInitializationAnchor(
      {
        snapshot: foreignSnapshot,
        specification: foreignSpecification,
        policy: canonicalPolicyFixture(),
        taskLimits: DEFAULT_CANONICAL_TASK_LIMITS
      },
      hasher
    );
    const foreignFixture = runtimeFixture();
    const foreignRoot = job("job-foreign-anchor", { canonicalInitializationAnchor: foreignAnchor });
    foreignFixture.jobs.add(foreignRoot);
    await expect((await foreignFixture.session(foreignRoot)).prepare(base)).rejects.toMatchObject<Partial<CanonicalRunRuntimeError>>({
      code: "CANONICAL_RUN_OWNERSHIP_MISMATCH"
    });

    const changedPolicyFixture = runtimeFixture();
    const anchor = createCanonicalInitializationAnchor(
      { snapshot: base, specification: specificationFixture(), policy: canonicalPolicyFixture(), taskLimits: DEFAULT_CANONICAL_TASK_LIMITS },
      hasher
    );
    const changedPolicy = { allowCodexCli: true, sourceAccess: { mode: "offline" as const } };
    const changedRoot = job("job-policy-anchor", { toolPolicy: changedPolicy, canonicalInitializationAnchor: anchor });
    const changedResume = job("job-policy-anchor-resume", { resumesJobId: changedRoot.id, toolPolicy: changedPolicy, resumeCheckpointId: "checkpoint-policy" });
    changedPolicyFixture.jobs.add(changedRoot);
    changedPolicyFixture.jobs.add(changedResume);
    const changedSession = await changedPolicyFixture.session(changedResume);
    await expect(changedSession.prepare(base)).rejects.toMatchObject<Partial<CanonicalRunRuntimeError>>({ code: "CANONICAL_TASK_MISMATCH" });
  });
});

function runtimeFixture() {
  const storage = new DeterministicEnvelopeStorage();
  const gateway = new DurableCanonicalRunGateway(storage);
  const runtime = new CanonicalRunRuntime({ gateway, hasher });
  const jobs = new DeterministicResearchJobPort();
  const settingsStore = {
    getRuntimeSettings: async () => ({ ...defaultSettings, codex: { ...defaultSettings.codex, model: "gpt-5.6-sol" as const } })
  };
  return {
    storage,
    jobs,
    session: (activeJob: DurableJobRecord) => DurableCanonicalResearchSession.create({ jobs, settingsStore, runtime, hasher }, activeJob)
  };
}

async function commitSessionCheckpoint(
  session: DurableCanonicalResearchSession,
  checkpointValue: StorageCheckpoint,
  storage: DeterministicEnvelopeStorage
): Promise<void> {
  const plan = await session.prepareCheckpointRevision({
    checkpointId: checkpointValue.id,
    recordedAt: checkpointValue.committedAt ?? checkpointValue.createdAt
  });
  for (const revision of storageCanonicalRevisionPlan(session.owner, plan)) await storage.commitCanonicalRunState(revision);
}

class DeterministicResearchJobPort {
  private readonly records = new Map<string, DurableJobRecord>();
  private readonly attempts = new Map<string, StorageToolAttempt[]>();
  private readonly checkpoints = new Map<string, StorageCheckpoint>();

  add(record: DurableJobRecord): void {
    this.records.set(record.id, record);
  }
  setAttempts(jobId: string, attempts: StorageToolAttempt[]): void {
    this.attempts.set(jobId, attempts);
  }
  setLatestCheckpoint(value: StorageCheckpoint): void {
    this.checkpoints.set(value.jobId, value);
  }
  async get(jobId: string): Promise<DurableJobRecord | undefined> {
    return this.records.get(jobId);
  }
  async listCanonicalToolAttempts(jobId: string): Promise<StorageToolAttempt[]> {
    return [...(this.attempts.get(jobId) ?? [])];
  }
  async latestCommittedCheckpoint(jobId: string): Promise<StorageCheckpoint | undefined> {
    return this.checkpoints.get(jobId);
  }
  async getCheckpoint(checkpointId: string): Promise<StorageCheckpoint | undefined> {
    return [...this.checkpoints.values()].find((value) => value.id === checkpointId);
  }
}

class DeterministicEnvelopeStorage {
  readonly taskWrites: StorageTaskContractInput[] = [];
  readonly revisionWrites: StorageCommitRunStateRevisionInput[] = [];
  readonly contextWrites: StorageSaveContextPackInput[] = [];
  private readonly contracts = new Map<string, StorageTaskContract>();
  private readonly revisions = new Map<string, StorageRunStateRevision[]>();
  private readonly contextPacks = new Map<string, StorageContextPack>();

  async saveCanonicalTaskContract(_owner: StorageRunOwnership, input: StorageTaskContractInput): Promise<StorageTaskContract> {
    const existing = this.contracts.get(input.id);
    if (existing && existing.contentHash !== input.contentHash) throw new Error("immutable task conflict");
    this.contracts.set(input.id, existing ?? input);
    if (!existing) this.taskWrites.push(input);
    return this.contracts.get(input.id)!;
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
    const existing = values.find((value) => value.revision === input.revision.revision);
    if (existing) {
      if (existing.stateHash !== input.revision.stateHash) throw new Error("immutable revision conflict");
      return existing;
    }
    const actual = values.at(-1)?.revision ?? null;
    if (actual !== input.expectedRevision) throw new Error(`stale revision ${String(input.expectedRevision)} != ${String(actual)}`);
    values.push(input.revision);
    this.revisions.set(input.revision.runId, values);
    this.revisionWrites.push(input);
    return input.revision;
  }
  async saveCanonicalContextPack(input: StorageSaveContextPackInput): Promise<StorageContextPack> {
    const latest = this.revisions.get(input.contextPack.runId)?.at(-1);
    if (latest?.revision !== input.expectedRevision) throw new Error("stale context revision");
    this.contextWrites.push(input);
    this.contextPacks.set(input.contextPack.id, input.contextPack);
    return input.contextPack;
  }
  async getCanonicalResumeContextPack(owner: StorageRunOwnership, predecessorJobId: string, contextPackId: string): Promise<StorageContextPack | undefined> {
    const value = this.contextPacks.get(contextPackId);
    return value?.projectId === owner.projectId && value.runId === owner.runId && value.jobId === predecessorJobId ? value : undefined;
  }
}

function job(id: string, overrides: Partial<DurableJobRecord> = {}): DurableJobRecord {
  return {
    id,
    projectId: PROJECT_ID,
    kind: "research_loop",
    status: "running",
    projectRevision: 1,
    idempotencyKey: id,
    requestedCapabilities: { agent: true, engineering: false, search: false },
    effectiveCapabilities: { agent: true, engineering: false, search: false },
    toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } },
    createdAt: T0,
    updatedAt: T0,
    ...overrides
  };
}

function checkpoint(id: string, jobId: string, committedAt: string, data?: Record<string, unknown>): StorageCheckpoint {
  return {
    id,
    projectId: PROJECT_ID,
    jobId,
    step: ResearchLoopStep.PlanResearch,
    checkpointKey: `${jobId}:${id}`,
    status: "committed",
    createdAt: committedAt,
    committedAt,
    ...(data ? { data } : {})
  };
}

function toolAttempt(id: string, jobId: string, status: StorageToolAttemptStatus): StorageToolAttempt {
  return {
    id,
    projectId: PROJECT_ID,
    jobId,
    decisionId: `decision:${id}`,
    ordinal: 0,
    status,
    inputHash: "d".repeat(64),
    dependsOnAttemptIds: [],
    queuedAt: T0
  };
}

function canonicalPolicyFixture() {
  return {
    requestedCapabilities: { agent: true, engineering: false, search: false },
    effectiveCapabilities: { agent: true, engineering: false, search: false },
    toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" as const } },
    externalSideEffects: []
  };
}

function plannerInput(snapshot: ResearchSnapshot): PlannerContextCompilationInput {
  return {
    snapshot,
    specification: specificationFixture(),
    iteration: 1,
    provider: {
      providerId: "deterministic-session",
      modelId: "offline-session",
      capabilityReceipt: STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT
    },
    tools: [
      {
        name: "DataAnalysisTool",
        version: "2",
        summary: "Perform deterministic receipt checks.",
        inputContract: "strict-data-analysis-input-v2",
        requiredCapabilities: [],
        sideEffects: []
      }
    ],
    runtimeToolDiagnostics: {
      executableTools: ["DataAnalysisTool"],
      researchMetadata: {
        provider: "openalex",
        ready: false,
        maxResults: 5,
        requiredFields: [],
        optionalFields: [],
        description: "Not needed by the local deterministic test."
      },
      engineeringPrograms: [],
      engineeringArtifactCandidates: [],
      engineeringProgramRequestTemplates: [],
      blockers: [],
      generatedAt: T0
    }
  };
}
