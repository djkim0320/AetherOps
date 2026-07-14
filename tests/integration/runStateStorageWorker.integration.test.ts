import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createCanonicalRunFixture } from "../fixtures/canonicalRunState.js";
import { prepareCanonicalResumePlan } from "../../src/server/composition/canonicalResumePlan.js";
import { storageCanonicalRevisionPlan } from "../../src/server/composition/durableCanonicalRunGateway.js";
import { parseStoredRunStateRevision, storageCanonicalHasher } from "../../src/server/runtime/storage/v2/runStatePayloadValidator.js";
import type { StorageRunStateRevisionInput } from "../../src/server/runtime/storage/v2/runStateTypes.js";
import {
  NOW,
  PROJECT_ID,
  RUN_ID,
  bootstrapPolicy,
  canonical,
  canonicalInitializationAnchor,
  claim,
  cleanupRunStateStorageWorkerFixture,
  contextPack,
  countRows,
  createDatabasePath,
  enqueueJob,
  expireLease,
  fencedWrite,
  interruptJob,
  interruptWithCheckpoint,
  jobInput,
  removeClient,
  saveTaskContract,
  stateRevision,
  taskContract,
  worker
} from "./runStateStorageWorker.fixture.js";

afterEach(cleanupRunStateStorageWorkerFixture);

describe("canonical run-state real storage worker lifecycle", () => {
  it("restarts and resumes through a new linked job without losing canonical state", async () => {
    const path = createDatabasePath("worker-lifecycle");
    const first = worker(path);
    await enqueueJob(first, jobInput("job-worker-initial"));
    const initialClaim = await claim(first, "job-worker-initial", "worker-initial", "2026-07-14T00:00:01.000Z");
    await saveTaskContract(first, initialClaim.fence);
    const revision0 = stateRevision(0, "job-worker-initial");
    await expect(fencedWrite(first, initialClaim.fence, { name: "runState.commit", input: { expectedRevision: null, revision: revision0 } })).resolves.toEqual(
      revision0
    );
    await first.close();
    removeClient(first);

    interruptWithCheckpoint(path, "job-worker-initial", "checkpoint-worker");
    const resumed = worker(path);
    await enqueueJob(resumed, jobInput("job-worker-resumed", "job-worker-initial", "checkpoint-worker"));
    const resumeClaim = await claim(resumed, "job-worker-resumed", "worker-resumed", "2026-07-14T00:01:01.000Z");
    const resumedOwner = { projectId: PROJECT_ID, runId: RUN_ID, jobId: "job-worker-resumed" };
    await expect(resumed.request({ name: "runState.latest", owner: resumedOwner })).resolves.toEqual(revision0);
    const pack = contextPack("job-worker-resumed");
    await fencedWrite(resumed, resumeClaim.fence, { name: "contextPack.save", input: { expectedRevision: 0, contextPack: pack } });
    await resumed.close();
    removeClient(resumed);

    const beforeRevision = new DatabaseSync(path, { readOnly: true });
    try {
      expect(beforeRevision.prepare("select job_id,lineage_sequence from run_job_links order by lineage_sequence").all()).toEqual([
        { job_id: "job-worker-initial", lineage_sequence: 1 }
      ]);
    } finally {
      beforeRevision.close();
    }

    const continuing = worker(path);
    const revision1 = stateRevision(1, "job-worker-resumed", pack.id);
    await fencedWrite(continuing, resumeClaim.fence, { name: "runState.commit", input: { expectedRevision: 0, revision: revision1 } });
    await continuing.close();
    removeClient(continuing);

    const readback = worker(path);
    await expect(readback.request({ name: "runState.latest", owner: resumedOwner })).resolves.toEqual(revision1);
    await expect(readback.request({ name: "runState.list", owner: resumedOwner })).resolves.toEqual([revision0, revision1]);
    await expect(readback.request({ name: "contextPack.get", owner: resumedOwner, contextPackId: pack.id })).resolves.toEqual(pack);

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("pragma integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(db.prepare("pragma foreign_key_check").all()).toEqual([]);
      expect(db.prepare("select job_id,predecessor_job_id,resume_checkpoint_id,lineage_sequence from run_job_links order by lineage_sequence").all()).toEqual([
        { job_id: "job-worker-initial", predecessor_job_id: null, resume_checkpoint_id: null, lineage_sequence: 1 },
        {
          job_id: "job-worker-resumed",
          predecessor_job_id: "job-worker-initial",
          resume_checkpoint_id: "checkpoint-worker",
          lineage_sequence: 2
        }
      ]);
    } finally {
      db.close();
    }
  });

  it("rejects expired and terminal job fences before canonical context or state can change", async () => {
    const expiredPath = createDatabasePath("expired");
    const expired = worker(expiredPath);
    await enqueueJob(expired, jobInput("job-worker-expired"));
    const expiredClaim = await claim(expired, "job-worker-expired", "worker-expired", "2026-07-14T00:00:01.000Z");
    await saveTaskContract(expired, expiredClaim.fence);
    const expiredRevision = stateRevision(0, "job-worker-expired");
    await fencedWrite(expired, expiredClaim.fence, { name: "runState.commit", input: { expectedRevision: null, revision: expiredRevision } });
    expireLease(expiredPath, "job-worker-expired");
    await expect(
      fencedWrite(
        expired,
        expiredClaim.fence,
        { name: "contextPack.save", input: { expectedRevision: 0, contextPack: contextPack("job-worker-expired") } },
        "2026-07-14T00:10:01.000Z"
      )
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
    await expect(
      fencedWrite(
        expired,
        expiredClaim.fence,
        {
          name: "taskContract.save",
          owner: { projectId: PROJECT_ID, jobId: expiredClaim.fence.jobId },
          contract: taskContract()
        },
        "2026-07-14T00:10:01.000Z"
      )
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
    expect(countRows(expiredPath, "context_packs")).toBe(0);
    expect(countRows(expiredPath, "task_contracts")).toBe(1);

    const terminalPath = createDatabasePath("terminal");
    const terminal = worker(terminalPath);
    await enqueueJob(terminal, jobInput("job-worker-terminal"));
    const terminalClaim = await claim(terminal, "job-worker-terminal", "worker-terminal", "2026-07-14T00:00:01.000Z");
    await saveTaskContract(terminal, terminalClaim.fence);
    const terminalRevision = stateRevision(0, "job-worker-terminal");
    await fencedWrite(terminal, terminalClaim.fence, { name: "runState.commit", input: { expectedRevision: null, revision: terminalRevision } });
    await terminal.request({
      name: "job.transitionTerminal",
      input: {
        fence: terminalClaim.fence,
        status: "failed",
        projectRevision: 1,
        reason: "terminal fence test",
        occurredAt: "2026-07-14T00:00:03.000Z"
      }
    });
    await expect(
      fencedWrite(terminal, terminalClaim.fence, {
        name: "contextPack.save",
        input: { expectedRevision: 0, contextPack: contextPack("job-worker-terminal") }
      })
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
    await expect(
      fencedWrite(terminal, terminalClaim.fence, {
        name: "taskContract.save",
        owner: { projectId: PROJECT_ID, jobId: terminalClaim.fence.jobId },
        contract: taskContract()
      })
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
    expect(countRows(terminalPath, "context_packs")).toBe(0);
  });

  it("rejects authority-bearing progress and terminal revisions outside verified canonical transitions", async () => {
    const path = createDatabasePath("terminal-authority");
    const client = worker(path);
    const jobId = "job-worker-terminal-authority";
    await enqueueJob(client, jobInput(jobId));
    const claimed = await claim(client, jobId, "worker-terminal-authority", "2026-07-14T00:00:01.000Z");
    await saveTaskContract(client, claimed.fence);
    const revision0 = stateRevision(0, jobId);
    const revision1 = stateRevision(1, jobId);
    await fencedWrite(client, claimed.fence, { name: "runState.commit", input: { expectedRevision: null, revision: revision0 } });
    await fencedWrite(client, claimed.fence, { name: "runState.commit", input: { expectedRevision: 0, revision: revision1 } });
    const forgedResources = authorityBearingRevision(revision1, jobId);
    await expect(fencedWrite(client, claimed.fence, { name: "runState.commit", input: { expectedRevision: 1, revision: forgedResources } })).rejects.toThrow(
      /authority-bearing canonical progress/i
    );
    expect(countRows(path, "run_state_revisions")).toBe(2);

    const safeDecision = canonical.decisionRevision(revision1, jobId, "non-authoritative-decision", "2026-07-14T00:02:00.000Z");
    const [awaitingCompletion, terminal] = canonical.completionRevisionsFrom(safeDecision, jobId, ["unverified-receipt"], ["unverified-acceptance"]);

    await expect(
      client.request({
        name: "fencedTransaction",
        fence: claimed.fence,
        now: "2026-07-14T00:03:00.000Z",
        commands: [
          { name: "runState.commit", input: { expectedRevision: 1, revision: safeDecision } },
          { name: "runState.commit", input: { expectedRevision: 2, revision: awaitingCompletion } }
        ]
      })
    ).rejects.toThrow(/authority-bearing canonical progress/i);

    expect(countRows(path, "run_state_revisions")).toBe(2);
    await expect(
      fencedWrite(client, claimed.fence, {
        name: "runState.commit",
        input: { expectedRevision: awaitingCompletion.revision, revision: terminal }
      })
    ).rejects.toThrow(/canonical\.transitionTerminal authority/i);
    await expect(client.request({ name: "runState.latest", owner: { projectId: PROJECT_ID, runId: RUN_ID, jobId } })).resolves.toMatchObject({
      revision: 1,
      data: { status: "running" }
    });
    await expect(client.request({ name: "job.get", jobId })).resolves.toMatchObject({ status: "running" });
  });
});

function authorityBearingRevision(current: StorageRunStateRevisionInput, jobId: string): StorageRunStateRevisionInput {
  const state = parseStoredRunStateRevision(current.data);
  const { stateHash: ignored, ...previous } = state;
  void ignored;
  const recordedAt = "2026-07-14T00:01:30.000Z";
  const evidenceId = "evidence-worker-authority";
  const payload = {
    ...previous,
    revision: state.revision + 1,
    parentRevisionHash: state.stateHash,
    artifactRefs: [
      ...state.artifactRefs,
      {
        artifactId: "artifact-worker-authority",
        projectId: PROJECT_ID,
        contentHash: "a".repeat(64),
        promotionReceiptId: "forged-promotion-receipt"
      }
    ],
    evidenceRefs: [
      ...state.evidenceRefs,
      {
        evidenceId,
        projectId: PROJECT_ID,
        contentHash: "b".repeat(64),
        verificationReceiptId: "forged-verification-receipt"
      }
    ],
    verifiedFacts: [
      ...state.verifiedFacts,
      { factId: "fact-worker-authority", evidenceIds: [evidenceId], verificationReceiptId: "forged-fact-receipt", recordedAt }
    ],
    updatedAt: recordedAt
  };
  const stateHash = storageCanonicalHasher.sha256Canonical(payload);
  return {
    ...current,
    id: `${RUN_ID}:revision:${payload.revision}`,
    jobId,
    revision: payload.revision,
    previousRevision: state.revision,
    parentRevisionHash: state.stateHash,
    stateHash,
    recordedAt,
    data: { ...payload, stateHash }
  };
}

describe("checkpoint-free canonical bootstrap on a real storage worker", () => {
  it("lets a direct interrupted root successor commit rev0 and rev1 under the root run id", async () => {
    const path = createDatabasePath("bootstrap-success");
    const rootJobId = "job-worker-bootstrap-root";
    const successorJobId = "job-worker-bootstrap-successor";
    const runId = `run:${rootJobId}`;
    const fixture = createCanonicalRunFixture({ projectId: PROJECT_ID, runId, taskId: "task-worker-bootstrap", createdAt: NOW });
    const policy = bootstrapPolicy();
    const root = worker(path);
    await enqueueJob(
      root,
      jobInput(rootJobId, undefined, undefined, {
        ...policy,
        request: { action: "start", canonicalInitializationAnchor: canonicalInitializationAnchor() }
      })
    );
    interruptJob(path, rootJobId);
    await enqueueJob(root, jobInput(successorJobId, rootJobId, undefined, policy));
    const claimed = await claim(root, successorJobId, "worker-bootstrap-successor", "2026-07-14T00:01:00.000Z");
    await saveTaskContract(root, claimed.fence, fixture.taskContract());
    const revision0 = fixture.revision(0, successorJobId);
    const revision1 = fixture.revision(1, successorJobId);

    await expect(fencedWrite(root, claimed.fence, { name: "runState.commit", input: { expectedRevision: null, revision: revision0 } })).resolves.toEqual(
      revision0
    );
    await expect(fencedWrite(root, claimed.fence, { name: "runState.commit", input: { expectedRevision: 0, revision: revision1 } })).resolves.toEqual(
      revision1
    );
    const owner = { projectId: PROJECT_ID, runId, jobId: successorJobId };
    await expect(root.request({ name: "runState.list", owner })).resolves.toEqual([revision0, revision1]);

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("select run_id,job_id,predecessor_job_id,resume_checkpoint_id,lineage_sequence,link_kind from run_job_links").all()).toEqual([
        { run_id: runId, job_id: successorJobId, predecessor_job_id: rootJobId, resume_checkpoint_id: null, lineage_sequence: 1, link_kind: "bootstrap" }
      ]);
    } finally {
      db.close();
    }
  });

  it("rejects an immutable root anchor whose body was changed without updating its hash", async () => {
    const path = createDatabasePath("bootstrap-tamper");
    const rootJobId = "job-worker-bootstrap-tampered-root";
    const policy = bootstrapPolicy();
    const valid = canonicalInitializationAnchor();
    const tampered = {
      ...valid,
      taskSource: { ...valid.taskSource, project: { ...valid.taskSource.project, goal: "Changed after the immutable hash was recorded." } }
    };
    const client = worker(path);
    await expect(
      enqueueJob(client, jobInput(rootJobId, undefined, undefined, { ...policy, request: { action: "start", canonicalInitializationAnchor: tampered } }))
    ).rejects.toThrow("Job tool policy is unsafe for operational storage.");
    expect(countRows(path, "jobs")).toBe(0);
    expect(countRows(path, "run_state_revisions")).toBe(0);
    expect(countRows(path, "run_job_links")).toBe(0);
  });

  it.each([0, 1] as const)("authorizes checkpoint-free takeover after root revision %i without replaying work", async (crashRevision) => {
    const path = createDatabasePath(`bootstrap-existing-state-${crashRevision}`);
    const rootJobId = `job-worker-bootstrap-existing-root-${crashRevision}`;
    const successorJobId = `job-worker-bootstrap-existing-successor-${crashRevision}`;
    const runId = `run:${rootJobId}`;
    const policy = bootstrapPolicy();
    const fixture = createCanonicalRunFixture({ projectId: PROJECT_ID, runId, taskId: "task-worker-existing", createdAt: NOW });
    const client = worker(path);
    await enqueueJob(
      client,
      jobInput(rootJobId, undefined, undefined, {
        ...policy,
        request: { action: "start", canonicalInitializationAnchor: canonicalInitializationAnchor() }
      })
    );
    const rootClaim = await claim(client, rootJobId, "worker-bootstrap-existing-root", "2026-07-14T00:00:01.000Z");
    await saveTaskContract(client, rootClaim.fence, fixture.taskContract());
    const revision0 = fixture.revision(0, rootJobId);
    await fencedWrite(client, rootClaim.fence, { name: "runState.commit", input: { expectedRevision: null, revision: revision0 } });
    const rootRevision1 = fixture.revision(1, rootJobId);
    if (crashRevision === 1) {
      await fencedWrite(client, rootClaim.fence, { name: "runState.commit", input: { expectedRevision: 0, revision: rootRevision1 } });
    }
    interruptJob(path, rootJobId);
    await enqueueJob(client, jobInput(successorJobId, rootJobId, undefined, policy));
    const successorClaim = await claim(client, successorJobId, "worker-bootstrap-existing-successor", "2026-07-14T00:01:00.000Z");
    const activeRevision = crashRevision === 0 ? fixture.revision(1, successorJobId) : rootRevision1;
    if (crashRevision === 0) {
      await fencedWrite(client, successorClaim.fence, {
        name: "runState.commit",
        input: { expectedRevision: 0, revision: activeRevision }
      });
    }
    const state = activeRevision.data;
    const owner = { projectId: PROJECT_ID, runId, jobId: successorJobId };
    const plan = prepareCanonicalResumePlan(
      {
        mode: "bootstrap",
        owner,
        expectedState: { revision: state.revision, stateHash: state.stateHash },
        resumeAuthorizationReceiptId: successorJobId,
        blockerClearances: [],
        recordedAt: state.updatedAt
      },
      state,
      storageCanonicalHasher
    );
    await expect(
      client.request({
        name: "canonical.commitPlan",
        input: {
          fence: successorClaim.fence,
          owner,
          finalState: { revision: plan.finalState.revision, stateHash: plan.finalState.stateHash },
          exactReplay: plan.exactReplay,
          revisions: storageCanonicalRevisionPlan(owner, plan)
        }
      })
    ).resolves.toMatchObject({ finalRevision: { revision: 2, jobId: successorJobId } });
    expect(countRows(path, "run_state_revisions")).toBe(3);
    expect(countRows(path, "run_job_links")).toBe(2);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("select job_id,link_kind from run_job_links order by lineage_sequence").all()).toEqual([
        { job_id: rootJobId, link_kind: "root" },
        { job_id: successorJobId, link_kind: "bootstrap" }
      ]);
    } finally {
      db.close();
    }
  });
});
