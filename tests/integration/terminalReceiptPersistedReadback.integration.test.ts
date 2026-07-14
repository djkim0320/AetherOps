import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CANONICAL_BUDGET_DECISION_PREFIX, CANONICAL_BUDGET_RECEIPT_PREFIX } from "../../src/core/orchestration/budgetAccounting.js";
import { createCanonicalRunFixture } from "../fixtures/canonicalRunState.js";
import { storageStepCheckpointId } from "../../src/server/runtime/storage/v2/jobAtomicOperations.js";
import { storageCanonicalHasher } from "../../src/server/runtime/storage/v2/runStatePayloadValidator.js";
import type { StorageCanonicalTerminalVerifyResult, StorageTerminalResourceCandidate } from "../../src/server/runtime/storage/v2/terminalReceiptTypes.js";
import type { StorageClaimStartResult, StorageCompletedStepInput, StorageToolOutputLink } from "../../src/server/runtime/storage/v2/index.js";
import {
  NOW,
  PROJECT_ID,
  RUN_ID,
  claim,
  cleanupRunStateStorageWorkerFixture,
  createDatabasePath,
  fencedWrite,
  jobInput,
  removeClient,
  saveTaskContract,
  worker
} from "./runStateStorageWorker.fixture.js";
import {
  ACCEPTANCE_DESCRIPTION,
  canonicalEvidenceHash,
  deletePersistedEvidence,
  evidenceRecord,
  insertResearchRow,
  mutatePersistedValidation,
  validationRecord
} from "./terminalPersistedRecords.fixture.js";
const ARTIFACT_ID = "artifact-terminal-authority";
const EVIDENCE_ID = "evidence-terminal-authority";
const VALIDATION_ID = "validation-terminal-authority";
const OTHER_VALIDATION_ID = "validation-terminal-other";
const CROSS_PROJECT_VALIDATION_ID = "validation-terminal-cross-project";
const ARTIFACT_ATTEMPT_ID = "attempt-terminal-artifact";
const EVIDENCE_ATTEMPT_ID = "attempt-terminal-evidence";
const ARTIFACT_LINK_ID = "link-terminal-artifact";
const EVIDENCE_LINK_ID = "link-terminal-evidence";
const ARTIFACT_OUTPUT_HASH = "1".repeat(64);
const EVIDENCE_OUTPUT_HASH = "2".repeat(64);
const INPUT_HASH = "3".repeat(64);
const VERIFIED_AT = "2026-07-14T00:03:00.000Z";
const authorityCanonical = createCanonicalRunFixture({
  projectId: PROJECT_ID,
  runId: RUN_ID,
  taskId: "task-worker-state",
  createdAt: NOW,
  additionalAcceptanceCriteria: [{ id: "criterion-persisted-result", description: ACCEPTANCE_DESCRIPTION, verifierKind: "deterministic" }]
});

afterEach(cleanupRunStateStorageWorkerFixture);

describe("canonical terminal persisted-result authority", () => {
  it("rejects forged resource hashes, validation receipts, and dangling or mismatched output links", async () => {
    const run = await prepareRun("terminal-persisted-adversarial");
    const base = verificationInput(run);

    await expectVerificationFailure(
      run,
      { ...base, resources: replaceResource(base.resources, ARTIFACT_ID, { contentHash: "a".repeat(64) }) },
      /source changed before attestation|resource hash/i
    );
    await expectVerificationFailure(
      run,
      { ...base, resources: replaceResource(base.resources, EVIDENCE_ID, { contentHash: "b".repeat(64) }) },
      /source changed before attestation|resource hash/i
    );
    await expectVerificationFailure(
      run,
      {
        ...base,
        resources: replaceResource(base.resources, EVIDENCE_ID, {
          validationResultId: "validation-does-not-exist",
          validationResultHash: run.validationHash
        })
      },
      /validation_results readback is missing/i
    );
    await expectVerificationFailure(
      run,
      {
        ...base,
        resources: replaceResource(base.resources, EVIDENCE_ID, {
          validationResultId: CROSS_PROJECT_VALIDATION_ID,
          validationResultHash: run.crossProjectValidationHash
        })
      },
      /validation_results readback is missing/i
    );
    await expectVerificationFailure(
      run,
      { ...base, resources: replaceResource(base.resources, EVIDENCE_ID, { validationResultHash: "c".repeat(64) }) },
      /validation candidate hashes disagree|evidence validation does not match persisted readback/i
    );
    await expectVerificationFailure(
      run,
      { ...base, criteria: replaceValidationCriterion(base.criteria, { validationResultHash: "d".repeat(64) }) },
      /validation candidate hashes disagree|acceptance validation does not match persisted readback/i
    );
    await expectVerificationFailure(
      run,
      {
        ...base,
        resources: replaceResource(base.resources, EVIDENCE_ID, {
          validationResultId: OTHER_VALIDATION_ID,
          validationResultHash: run.otherValidationHash
        })
      },
      /validation provenance is not promoted|evidence validation does not match persisted readback/i
    );
    await expectVerificationFailure(
      run,
      { ...base, resources: replaceResource(base.resources, ARTIFACT_ID, { outputLinkId: "link-does-not-exist" }) },
      /lacks an unpromoted persisted origin/i
    );
    await expectVerificationFailure(
      run,
      { ...base, resources: replaceResource(base.resources, ARTIFACT_ID, { attemptId: EVIDENCE_ATTEMPT_ID }) },
      /origin linkage is invalid/i
    );

    const issued = await run.client.request<StorageCanonicalTerminalVerifyResult>({ name: "canonical.verifyTerminal", input: base });
    expect(issued).toMatchObject({ exactReplay: false, receipts: { length: 7 } });
    const artifactAttestation = issued.attestations.find((value) => value.subjectKind === "artifact" && value.subjectId === ARTIFACT_ID)!;
    const evidenceAttestation = issued.attestations.find((value) => value.subjectKind === "evidence" && value.subjectId === EVIDENCE_ID)!;
    expect(issued.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ receiptKind: "artifact", subjectId: artifactAttestation.id, subjectHash: artifactAttestation.attestationHash }),
        expect.objectContaining({ receiptKind: "evidence", subjectId: evidenceAttestation.id, subjectHash: evidenceAttestation.attestationHash })
      ])
    );
  });

  it("uses immutable CAS authority after attestation even when the original artifact mutates", async () => {
    const run = await prepareRun("terminal-persisted-toctou");
    const base = verificationInput(run);
    const verification = await run.client.request<StorageCanonicalTerminalVerifyResult>({ name: "canonical.verifyTerminal", input: base });
    const transition = terminalTransitionInput(run, verification);
    writeFileSync(run.artifactPath, "mutated after verifier receipt", "utf8");

    await expect(run.client.request({ name: "canonical.transitionTerminal", input: transition })).resolves.toMatchObject({
      terminal: { job: { status: "completed" }, links: [{ promoted: true }, { promoted: true }] }
    });

    const db = new DatabaseSync(run.path, { readOnly: true });
    try {
      expect(db.prepare("select status from jobs where id=?").get(run.jobId)).toEqual({ status: "completed" });
      expect(db.prepare("select count(*) count from checkpoints where job_id=?").get(run.jobId)).toEqual({ count: 1 });
      expect(db.prepare("select count(*) count from tool_output_links where job_id=? and promoted=1").get(run.jobId)).toEqual({ count: 2 });
      expect(db.prepare("select count(*) count from canonical_terminal_verifier_receipts where job_id=?").get(run.jobId)).toEqual({ count: 7 });
    } finally {
      db.close();
    }
  });

  it("commits only while artifact, evidence, and acceptance validation readback still matches", async () => {
    const run = await prepareRun("terminal-persisted-success");
    const verification = await run.client.request<StorageCanonicalTerminalVerifyResult>({
      name: "canonical.verifyTerminal",
      input: verificationInput(run)
    });
    await expect(run.client.request({ name: "canonical.transitionTerminal", input: terminalTransitionInput(run, verification) })).resolves.toMatchObject({
      terminal: { job: { status: "completed" }, links: [{ promoted: true }, { promoted: true }] }
    });
  });

  it("replays the exact attestation batch after restart and ignores mutable legacy validation changes", async () => {
    const run = await prepareRun("terminal-persisted-validation-toctou");
    const verification = await run.client.request<StorageCanonicalTerminalVerifyResult>({
      name: "canonical.verifyTerminal",
      input: verificationInput(run)
    });
    mutatePersistedValidation(run.path, VALIDATION_ID);
    deletePersistedEvidence(run.path, EVIDENCE_ID);
    rmSync(run.artifactPath);
    const staleTemporary = join(dirname(run.path), "migration", "v2", "terminal-cas", "tmp", "stale.partial");
    const orphanHash = sha256("orphaned content-addressed object");
    const orphan = join(dirname(run.path), "migration", "v2", "terminal-cas", "sha256", orphanHash.slice(0, 2), orphanHash);
    mkdirSync(dirname(staleTemporary), { recursive: true });
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(staleTemporary, "partial", "utf8");
    writeFileSync(orphan, "orphaned content-addressed object", "utf8");
    await run.client.close();
    removeClient(run.client);
    const restarted = worker(run.path);
    const replay = await restarted.request<StorageCanonicalTerminalVerifyResult>({ name: "canonical.verifyTerminal", input: verificationInput(run) });
    expect(existsSync(staleTemporary)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(replay).toEqual({ ...verification, exactReplay: true });
    const artifactAttestation = replay.attestations.find((value) => value.subjectKind === "artifact")!;
    await expect(
      restarted.request({ name: "terminal.createAttestedLease", input: { owner: run.owner, attestationId: artifactAttestation.id } })
    ).rejects.toThrow(/completed job/i);
    await expect(
      restarted.request({ name: "canonical.transitionTerminal", input: terminalTransitionInput({ ...run, client: restarted }, replay) })
    ).resolves.toMatchObject({
      terminal: { job: { status: "completed" } }
    });
    await expect(
      restarted.request({
        name: "terminal.createAttestedLease",
        input: { owner: { ...run.owner, projectId: "project-outside-terminal-scope" }, attestationId: artifactAttestation.id }
      })
    ).rejects.toThrow(/ownership|completed job/i);
    const lease = await restarted.request<{ leaseId: string }>({
      name: "terminal.createAttestedLease",
      input: { owner: run.owner, attestationId: artifactAttestation.id }
    });
    const chunk = await restarted.request<{ bytes: Uint8Array }>({
      name: "terminal.readAttestedLease",
      input: { owner: run.owner, leaseId: lease.leaseId, offset: 0, maximumBytes: 1024 }
    });
    expect(Buffer.from(chunk.bytes).toString("utf8")).toBe("authoritative artifact bytes");
    const db = new DatabaseSync(run.path, { readOnly: true });
    try {
      expect(db.prepare("select status from jobs where id=?").get(run.jobId)).toEqual({ status: "completed" });
      expect(db.prepare("select count(*) count from tool_output_links where job_id=? and promoted=1").get(run.jobId)).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it("fails closed when an attested CAS object or its immutable batch hash is tampered", async () => {
    const casRun = await prepareRun("terminal-cas-tamper");
    const casVerification = await casRun.client.request<StorageCanonicalTerminalVerifyResult>({
      name: "canonical.verifyTerminal",
      input: verificationInput(casRun)
    });
    const artifactAttestation = casVerification.attestations.find((value) => value.subjectKind === "artifact")!;
    const path = join(dirname(casRun.path), "migration", "v2", ...artifactAttestation.casLocator.split("/"));
    if (process.platform !== "win32") chmodSync(path, 0o644);
    writeFileSync(path, "tampered CAS bytes", "utf8");
    await expect(casRun.client.request({ name: "canonical.transitionTerminal", input: terminalTransitionInput(casRun, casVerification) })).rejects.toThrow(
      /CAS readback/i
    );

    const batchRun = await prepareRun("terminal-batch-tamper");
    const batchVerification = await batchRun.client.request<StorageCanonicalTerminalVerifyResult>({
      name: "canonical.verifyTerminal",
      input: verificationInput(batchRun)
    });
    const db = new DatabaseSync(batchRun.path);
    try {
      db.exec("drop trigger trg_terminal_attestations_no_update");
      db.prepare("update canonical_terminal_result_attestations set batch_hash=? where job_id=?").run("f".repeat(64), batchRun.jobId);
    } finally {
      db.close();
    }
    await expect(
      batchRun.client.request({ name: "canonical.transitionTerminal", input: terminalTransitionInput(batchRun, batchVerification) })
    ).rejects.toThrow(/batch hash is invalid/i);

    const rowRun = await prepareRun("terminal-attestation-row-tamper");
    const rowVerification = await rowRun.client.request<StorageCanonicalTerminalVerifyResult>({
      name: "canonical.verifyTerminal",
      input: verificationInput(rowRun)
    });
    const rowDb = new DatabaseSync(rowRun.path);
    try {
      rowDb.exec("drop trigger trg_terminal_attestations_no_update");
      rowDb.prepare("update canonical_terminal_result_attestations set supporting_evidence_ids='[]' where subject_kind='validation_result'").run();
    } finally {
      rowDb.close();
    }
    await expect(rowRun.client.request({ name: "canonical.transitionTerminal", input: terminalTransitionInput(rowRun, rowVerification) })).rejects.toThrow(
      /attestation integrity|provenance hash/i
    );
  });

  it("fails closed when the Worker has no configured authoritative research data root", async () => {
    const run = await prepareRun("terminal-persisted-no-data-root", false);
    await expect(run.client.request({ name: "canonical.verifyTerminal", input: verificationInput(run) })).rejects.toThrow(
      /storage data root is not configured/i
    );
  });
});

interface PreparedRun {
  path: string;
  client: ReturnType<typeof worker>;
  jobId: string;
  claimed: StorageClaimStartResult;
  owner: { projectId: string; runId: string; jobId: string };
  completedStep: StorageCompletedStepInput;
  artifactHash: string;
  evidenceHash: string;
  validationHash: string;
  otherValidationHash: string;
  crossProjectValidationHash: string;
  artifactPath: string;
  artifactLink: StorageToolOutputLink;
  evidenceLink: StorageToolOutputLink;
}

async function prepareRun(label: string, includeDataRoot = true): Promise<PreparedRun> {
  const path = createDatabasePath(label);
  const persisted = persistResearchReadback(path);
  const client = worker(path, { includeDataRoot });
  const jobId = `job-${label}`;
  await client.request({ name: "job.enqueue", job: jobInput(jobId) });
  const claimed = await claim(client, jobId, `worker-${label}`, "2026-07-14T00:00:01.000Z");
  await saveTaskContract(client, claimed.fence, authorityCanonical.taskContract());
  await fencedWrite(client, claimed.fence, {
    name: "runState.commit",
    input: { expectedRevision: null, revision: authorityCanonical.revision(0, jobId) }
  });
  await fencedWrite(client, claimed.fence, {
    name: "runState.commit",
    input: { expectedRevision: 0, revision: authorityCanonical.revision(1, jobId) }
  });
  const artifactLink = outputLink(jobId, ARTIFACT_ATTEMPT_ID, ARTIFACT_LINK_ID, "artifact", ARTIFACT_ID);
  const evidenceLink = outputLink(jobId, EVIDENCE_ATTEMPT_ID, EVIDENCE_LINK_ID, "evidence", EVIDENCE_ID);
  await client.request({
    name: "fencedTransaction",
    fence: claimed.fence,
    commands: [
      decision(jobId, "decision-terminal-artifact"),
      attempt(jobId, ARTIFACT_ATTEMPT_ID, "decision-terminal-artifact", 0, ARTIFACT_OUTPUT_HASH),
      { name: "trace.output.record", link: artifactLink },
      decision(jobId, "decision-terminal-evidence"),
      attempt(jobId, EVIDENCE_ATTEMPT_ID, "decision-terminal-evidence", 1, EVIDENCE_OUTPUT_HASH),
      { name: "trace.output.record", link: evidenceLink }
    ]
  });
  return {
    path,
    client,
    jobId,
    claimed,
    owner: { projectId: PROJECT_ID, runId: RUN_ID, jobId },
    completedStep: {
      step: "FINALIZE",
      checkpointData: {
        phase: "execute_tools_completed",
        attempts: [
          { id: ARTIFACT_ATTEMPT_ID, inputHash: INPUT_HASH, outputHash: ARTIFACT_OUTPUT_HASH },
          { id: EVIDENCE_ATTEMPT_ID, inputHash: INPUT_HASH, outputHash: EVIDENCE_OUTPUT_HASH }
        ]
      }
    },
    artifactLink,
    evidenceLink,
    ...persisted
  };
}

function persistResearchReadback(path: string) {
  const root = dirname(path);
  const projectRoot = join(root, "project-workspace");
  const artifactPath = join(projectRoot, "artifacts", "terminal-result.txt");
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, "authoritative artifact bytes", "utf8");
  const artifactHash = sha256("authoritative artifact bytes");
  const evidence = evidenceRecord();
  const validation = validationRecord(VALIDATION_ID, [EVIDENCE_ID]);
  const otherValidation = validationRecord(OTHER_VALIDATION_ID, ["other-evidence"]);
  const crossProjectValidation = validationRecord(CROSS_PROJECT_VALIDATION_ID, [EVIDENCE_ID], "project-outside-terminal-scope");
  const evidenceHash = canonicalEvidenceHash(evidence);
  const validationHash = storageCanonicalHasher.sha256Canonical(validation);
  const otherValidationHash = storageCanonicalHasher.sha256Canonical(otherValidation);
  const crossProjectValidationHash = storageCanonicalHasher.sha256Canonical(crossProjectValidation);
  const app = new DatabaseSync(path);
  try {
    app.prepare("update projects_v2 set project_root=?,data=? where id=?").run(projectRoot, JSON.stringify({ id: PROJECT_ID, projectRoot }), PROJECT_ID);
  } finally {
    app.close();
  }
  const legacyPath = join(root, "migration", "v2", "legacy-research.sqlite");
  mkdirSync(dirname(legacyPath), { recursive: true });
  const legacy = new DatabaseSync(legacyPath);
  try {
    for (const table of ["artifacts", "evidence", "validation_results"]) {
      legacy.exec(`create table ${table} (id text primary key, project_id text not null, created_at text not null, data text not null)`);
    }
    insertResearchRow(legacy, "artifacts", {
      id: ARTIFACT_ID,
      projectId: PROJECT_ID,
      category: "artifact",
      title: "Terminal result",
      relativePath: "artifacts/terminal-result.txt",
      mimeType: "text/plain",
      summary: "Persisted result",
      metadata: { sha256: artifactHash, bytes: 28 },
      createdAt: NOW
    });
    insertResearchRow(legacy, "evidence", evidence);
    insertResearchRow(legacy, "validation_results", validation);
    insertResearchRow(legacy, "validation_results", otherValidation);
    insertResearchRow(legacy, "validation_results", crossProjectValidation);
  } finally {
    legacy.close();
  }
  return { artifactPath, artifactHash, evidenceHash, validationHash, otherValidationHash, crossProjectValidationHash };
}

function verificationInput(run: PreparedRun) {
  return {
    fence: run.claimed.fence,
    owner: run.owner,
    checkpointId: storageStepCheckpointId(run.claimed.fence, run.completedStep.step),
    completedStep: run.completedStep,
    resources: [
      {
        outputKind: "artifact" as const,
        outputId: ARTIFACT_ID,
        outputLinkId: ARTIFACT_LINK_ID,
        attemptId: ARTIFACT_ATTEMPT_ID,
        contentHash: run.artifactHash
      },
      {
        outputKind: "evidence" as const,
        outputId: EVIDENCE_ID,
        outputLinkId: EVIDENCE_LINK_ID,
        attemptId: EVIDENCE_ATTEMPT_ID,
        contentHash: run.evidenceHash,
        validationResultId: VALIDATION_ID,
        validationResultHash: run.validationHash
      }
    ],
    criteria: [
      { criterionId: "criterion-traceability", verificationKind: "traceability" as const },
      { criterionId: "criterion-policy", verificationKind: "policy" as const },
      {
        criterionId: "criterion-persisted-result",
        verificationKind: "validation" as const,
        validationResultId: VALIDATION_ID,
        validationResultHash: run.validationHash,
        sourceEvidenceIds: [EVIDENCE_ID]
      }
    ],
    verifiedAt: VERIFIED_AT
  };
}

async function expectVerificationFailure(run: PreparedRun, input: ReturnType<typeof verificationInput>, pattern: RegExp): Promise<void> {
  await expect(run.client.request({ name: "canonical.verifyTerminal", input })).rejects.toThrow(pattern);
  const db = new DatabaseSync(run.path, { readOnly: true });
  try {
    expect(db.prepare("select count(*) count from canonical_terminal_verifier_receipts where job_id=?").get(run.jobId)).toEqual({ count: 0 });
  } finally {
    db.close();
  }
}

function replaceResource(
  resources: StorageTerminalResourceCandidate[],
  outputId: string,
  patch: Partial<StorageTerminalResourceCandidate>
): StorageTerminalResourceCandidate[] {
  return resources.map((resource) => (resource.outputId === outputId ? { ...resource, ...patch } : resource));
}

function replaceValidationCriterion(
  criteria: ReturnType<typeof verificationInput>["criteria"],
  patch: { validationResultId?: string; validationResultHash?: string; sourceEvidenceIds?: string[] }
): ReturnType<typeof verificationInput>["criteria"] {
  return criteria.map((criterion) => (criterion.verificationKind === "validation" ? { ...criterion, ...patch } : criterion));
}

function decision(jobId: string, id: string) {
  return {
    name: "trace.decision.record" as const,
    decision: {
      id,
      projectId: PROJECT_ID,
      jobId,
      toolName: "DataAnalysisTool",
      purpose: "Persist a deterministic terminal resource.",
      expectedOutcome: "A hash-bound output.",
      rawSelection: { inputHash: INPUT_HASH },
      userPinned: false,
      policyStatus: "accepted" as const,
      createdAt: NOW
    }
  };
}

function attempt(jobId: string, id: string, decisionId: string, ordinal: number, outputHash: string) {
  return {
    name: "trace.attempt.save" as const,
    attempt: {
      id,
      projectId: PROJECT_ID,
      jobId,
      decisionId,
      ordinal,
      status: "completed" as const,
      inputHash: INPUT_HASH,
      outputHash,
      dependsOnAttemptIds: [],
      queuedAt: NOW,
      startedAt: NOW,
      completedAt: "2026-07-14T00:01:00.000Z"
    }
  };
}

function outputLink(jobId: string, attemptId: string, id: string, outputKind: "artifact" | "evidence", outputId: string): StorageToolOutputLink {
  return { id, projectId: PROJECT_ID, jobId, attemptId, outputKind, outputId, promoted: false, createdAt: NOW };
}

function onlyReceipt(result: StorageCanonicalTerminalVerifyResult, kind: "artifact" | "evidence", subjectId: string) {
  const attestations = result.attestations.filter((attestation) => attestation.subjectKind === kind && attestation.subjectId === subjectId);
  if (attestations.length !== 1) throw new Error(`Expected one ${kind} attestation.`);
  const attestation = attestations[0]!;
  const matches = result.receipts.filter((receipt) => receipt.receiptKind === kind && receipt.subjectId === attestation.id);
  if (matches.length !== 1) throw new Error(`Expected one ${kind} receipt.`);
  return { receipt: matches[0]!, attestation };
}

function terminalTransitionInput(run: PreparedRun, verification: StorageCanonicalTerminalVerifyResult) {
  const artifactReceipt = onlyReceipt(verification, "artifact", ARTIFACT_ID);
  const evidenceReceipt = onlyReceipt(verification, "evidence", EVIDENCE_ID);
  const acceptanceReceiptIds = verification.receipts.filter((receipt) => receipt.receiptKind === "acceptance").map((receipt) => receipt.id);
  const verifierReceiptIds = verification.receipts.map((receipt) => receipt.id);
  const budgetReceiptHash = "4".repeat(64);
  const budgetRevision = authorityCanonical.decisionRevision(
    authorityCanonical.revision(1, run.jobId),
    run.jobId,
    `${CANONICAL_BUDGET_DECISION_PREFIX}${budgetReceiptHash}`,
    "2026-07-14T00:01:30.000Z",
    `${CANONICAL_BUDGET_RECEIPT_PREFIX}${budgetReceiptHash}`
  );
  const [completedRevision, terminalRevision] = authorityCanonical.completionRevisionsFrom(
    budgetRevision,
    run.jobId,
    verifierReceiptIds,
    acceptanceReceiptIds,
    {
      artifactRefs: [
        {
          artifactId: ARTIFACT_ID,
          projectId: PROJECT_ID,
          contentHash: artifactReceipt.attestation.contentHash,
          attestationId: artifactReceipt.attestation.id,
          attestationHash: artifactReceipt.attestation.attestationHash,
          promotionReceiptId: artifactReceipt.receipt.id
        }
      ],
      evidenceRefs: [
        {
          evidenceId: EVIDENCE_ID,
          projectId: PROJECT_ID,
          contentHash: evidenceReceipt.attestation.contentHash,
          attestationId: evidenceReceipt.attestation.id,
          attestationHash: evidenceReceipt.attestation.attestationHash,
          verificationReceiptId: evidenceReceipt.receipt.id
        }
      ]
    }
  );
  return {
    terminal: {
      fence: run.claimed.fence,
      status: "completed" as const,
      projectRevision: 3,
      occurredAt: VERIFIED_AT,
      completedStep: run.completedStep,
      promotions: [
        { link: { ...run.artifactLink, promoted: true, promotedAt: VERIFIED_AT }, artifact: { name: ARTIFACT_ID, kind: "report" } },
        { link: { ...run.evidenceLink, promoted: true, promotedAt: VERIFIED_AT } }
      ]
    },
    owner: run.owner,
    finalState: { revision: terminalRevision.revision, stateHash: terminalRevision.stateHash },
    exactReplay: false,
    revisions: [
      { expectedRevision: 1, revision: budgetRevision },
      { expectedRevision: budgetRevision.revision, revision: completedRevision },
      { expectedRevision: completedRevision.revision, revision: terminalRevision }
    ],
    budgetPrefix: {
      revisionCount: 1,
      finalState: { revision: budgetRevision.revision, stateHash: budgetRevision.stateHash },
      receiptHash: budgetReceiptHash,
      targetUsage: emptyBudgetUsage()
    }
  };
}

function emptyBudgetUsage() {
  return {
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    retries: 0,
    estimatedCostMicrousd: 0,
    toolOutputBytes: 0
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
