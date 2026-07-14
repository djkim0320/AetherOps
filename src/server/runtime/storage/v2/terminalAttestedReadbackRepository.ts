import type { DatabaseSync } from "node:sqlite";
import { parseStoredRunStateRevision, storageCanonicalHasher } from "./runStatePayloadValidator.js";
import { assertAttestationIntegrity, TerminalAttestationRepository } from "./terminalAttestationRepository.js";
import { TerminalAttestedLeaseStore, type TerminalAttestedLeaseStoreOptions } from "./terminalAttestedLeaseStore.js";
import { TerminalCasStore } from "./terminalCasStore.js";
import type { StorageTerminalResultAttestation } from "./terminalAttestationTypes.js";
import type {
  StorageTerminalAttestedLease,
  StorageTerminalAttestedLeaseChunk,
  StorageTerminalAttestedLeaseReadInput,
  StorageTerminalAttestedLeaseReleaseInput,
  StorageTerminalAttestedLeaseReleaseResult,
  StorageTerminalAttestedReadbackInput
} from "./terminalAttestedReadbackTypes.js";
import type { StorageRunOwnership } from "./runStateTypes.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_ATTESTATIONS = 512;
const MAX_RUN_STATE_BYTES = 8 * 1024 * 1024;

interface Row {
  [key: string]: unknown;
}

export class TerminalAttestedReadbackRepository {
  private readonly leases: TerminalAttestedLeaseStore;

  constructor(
    private readonly db: DatabaseSync,
    dataRoot: string | undefined,
    private readonly attestations: TerminalAttestationRepository,
    leaseOptions: TerminalAttestedLeaseStoreOptions = {}
  ) {
    const cas = new TerminalCasStore(dataRoot);
    this.leases = new TerminalAttestedLeaseStore(dataRoot, cas, leaseOptions);
  }

  createLease(input: StorageTerminalAttestedReadbackInput): StorageTerminalAttestedLease {
    assertCreateInput(input);
    const job = this.db.prepare("select project_id,status from jobs where id=?").get(input.owner.jobId) as Row | undefined;
    if (job?.project_id !== input.owner.projectId || job.status !== "completed") {
      throw new Error("Canonical terminal consumer requires a completed job with matching ownership.");
    }

    const batch = this.attestations.listByJob(input.owner.jobId);
    if (!batch.length || batch.length > MAX_ATTESTATIONS) throw new Error("Canonical terminal consumer attestation batch is missing or unbounded.");
    const attestation = onlyAttestation(batch, input);
    assertAttestationBatchMetadata(batch);
    const state = this.readCompletedState(input);
    assertStateReference(state, attestation);
    this.assertPromotedOrigin(attestation);
    return this.leases.create(input.owner, { ...attestation, attestationId: attestation.id });
  }

  readLease(input: StorageTerminalAttestedLeaseReadInput): StorageTerminalAttestedLeaseChunk {
    assertReadInput(input);
    return this.leases.read(input);
  }

  releaseLease(input: StorageTerminalAttestedLeaseReleaseInput): StorageTerminalAttestedLeaseReleaseResult {
    assertReleaseInput(input);
    return this.leases.release(input);
  }

  close(): void {
    this.leases.close();
  }

  private readCompletedState(input: StorageTerminalAttestedReadbackInput): ReturnType<typeof parseStoredRunStateRevision> {
    const row = this.db
      .prepare("select project_id,run_id,job_id,state_hash,data from run_state_revisions where project_id=? and run_id=? order by revision desc limit 1")
      .get(input.owner.projectId, input.owner.runId) as Row | undefined;
    if (!row || row.project_id !== input.owner.projectId || row.run_id !== input.owner.runId || row.job_id !== input.owner.jobId) {
      throw new Error("Canonical terminal consumer run-state ownership is unavailable.");
    }
    if (typeof row.data !== "string" || Buffer.byteLength(row.data, "utf8") > MAX_RUN_STATE_BYTES) {
      throw new Error("Canonical terminal consumer run-state readback is invalid or unbounded.");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.data);
    } catch {
      throw new Error("Canonical terminal consumer run-state readback is invalid.");
    }
    const state = parseStoredRunStateRevision(decoded);
    if (
      state.projectId !== input.owner.projectId ||
      state.runId !== input.owner.runId ||
      state.stateHash !== row.state_hash ||
      state.status !== "completed" ||
      state.terminalReceipt?.outcome !== "completed"
    ) {
      throw new Error("Canonical terminal consumer requires a completed authoritative RunState revision.");
    }
    return state;
  }

  private assertPromotedOrigin(attestation: StorageTerminalResultAttestation): void {
    if (!attestation.outputLinkId || !attestation.attemptId) throw new Error("Canonical terminal consumer attestation lacks an origin link.");
    const link = this.db.prepare("select * from tool_output_links where id=?").get(attestation.outputLinkId) as Row | undefined;
    if (
      !link ||
      link.project_id !== attestation.projectId ||
      link.job_id !== attestation.jobId ||
      link.attempt_id !== attestation.attemptId ||
      link.output_kind !== attestation.subjectKind ||
      link.output_id !== attestation.subjectId ||
      Number(link.promoted) !== 1
    ) {
      throw new Error("Canonical terminal consumer requires an exact promoted output link.");
    }
    const attempt = this.db.prepare("select project_id,job_id,status from tool_attempts where id=?").get(attestation.attemptId) as Row | undefined;
    if (attempt?.project_id !== attestation.projectId || attempt.job_id !== attestation.jobId || attempt.status !== "completed") {
      throw new Error("Canonical terminal consumer origin attempt is not completed or ownership-bound.");
    }
  }
}

function onlyAttestation(
  batch: StorageTerminalResultAttestation[],
  input: StorageTerminalAttestedReadbackInput
): StorageTerminalResultAttestation & { subjectKind: "artifact" | "evidence" } {
  const matches = batch.filter((value) => value.id === input.attestationId);
  const value = matches[0];
  if (
    matches.length !== 1 ||
    !value ||
    value.projectId !== input.owner.projectId ||
    value.runId !== input.owner.runId ||
    value.jobId !== input.owner.jobId ||
    (value.subjectKind !== "artifact" && value.subjectKind !== "evidence")
  ) {
    throw new Error("Canonical terminal consumer attestation is missing or crosses an ownership boundary.");
  }
  return value as StorageTerminalResultAttestation & { subjectKind: "artifact" | "evidence" };
}

function assertStateReference(state: ReturnType<typeof parseStoredRunStateRevision>, attestation: StorageTerminalResultAttestation): void {
  const references =
    attestation.subjectKind === "artifact"
      ? state.artifactRefs
          .filter((value) => value.artifactId === attestation.subjectId)
          .map(({ projectId, contentHash, attestationId, attestationHash }) => ({ projectId, contentHash, attestationId, attestationHash }))
      : state.evidenceRefs
          .filter((value) => value.evidenceId === attestation.subjectId)
          .map(({ projectId, contentHash, attestationId, attestationHash }) => ({ projectId, contentHash, attestationId, attestationHash }));
  const completedReferences = state.completedNodeReceipts.flatMap((receipt) =>
    attestation.subjectKind === "artifact"
      ? receipt.artifactRefs
          .filter((value) => value.artifactId === attestation.subjectId)
          .map(({ projectId, contentHash, attestationId, attestationHash }) => ({ projectId, contentHash, attestationId, attestationHash }))
      : receipt.evidenceRefs
          .filter((value) => value.evidenceId === attestation.subjectId)
          .map(({ projectId, contentHash, attestationId, attestationHash }) => ({ projectId, contentHash, attestationId, attestationHash }))
  );
  if (references.length !== 1 || completedReferences.length !== 1) {
    throw new Error("Canonical terminal consumer attestation is absent from completed RunState references.");
  }
  for (const reference of [...references, ...completedReferences]) {
    if (
      reference.projectId !== attestation.projectId ||
      reference.contentHash !== attestation.contentHash ||
      reference.attestationId !== attestation.id ||
      reference.attestationHash !== attestation.attestationHash
    ) {
      throw new Error("Canonical terminal consumer RunState reference does not match its attestation.");
    }
  }
}

function assertAttestationBatchMetadata(batch: StorageTerminalResultAttestation[]): void {
  const batches = new Set(batch.map((value) => value.batchHash));
  const calculated = storageCanonicalHasher.sha256Canonical(batch.map((value) => value.attestationHash).sort());
  if (batches.size !== 1 || batch[0]?.batchHash !== calculated) {
    throw new Error("Canonical terminal consumer attestation batch hash is invalid.");
  }
  for (const attestation of batch) assertAttestationIntegrity(attestation);
}

function assertCreateInput(input: StorageTerminalAttestedReadbackInput): void {
  if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["owner", "attestationId"].includes(key))) {
    throw new Error("Canonical terminal consumer input is malformed.");
  }
  assertOwner(input.owner, input.attestationId);
}

function assertReadInput(input: StorageTerminalAttestedLeaseReadInput): void {
  if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["owner", "leaseId", "offset", "maximumBytes"].includes(key))) {
    throw new Error("Canonical terminal lease read input is malformed.");
  }
  assertOwner(input.owner, input.leaseId);
}

function assertReleaseInput(input: StorageTerminalAttestedLeaseReleaseInput): void {
  if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["owner", "leaseId"].includes(key))) {
    throw new Error("Canonical terminal lease release input is malformed.");
  }
  assertOwner(input.owner, input.leaseId);
}

function assertOwner(owner: StorageRunOwnership, scopedId: string): void {
  if (
    !owner ||
    typeof owner !== "object" ||
    Object.keys(owner).some((key) => !["projectId", "runId", "jobId"].includes(key)) ||
    ![owner.projectId, owner.runId, owner.jobId, scopedId].every((value) => typeof value === "string" && IDENTIFIER.test(value))
  ) {
    throw new Error("Canonical terminal consumer ownership is malformed.");
  }
}
