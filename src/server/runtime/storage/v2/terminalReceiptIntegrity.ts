import type { StorageCompletedStepInput, StorageJob } from "./types.js";
import type { StorageToolAttempt } from "./traceTypes.js";
import { storageCanonicalHasher } from "./runStatePayloadValidator.js";
import type { StorageCanonicalTerminalVerifierReceipt } from "./terminalReceiptTypes.js";

const SHA256 = /^[a-f0-9]{64}$/;

export function terminalReceiptHash(receipt: Omit<StorageCanonicalTerminalVerifierReceipt, "receiptHash">): string {
  return storageCanonicalHasher.sha256Canonical(receipt);
}

export function assertTerminalReceiptIntegrity(receipt: StorageCanonicalTerminalVerifierReceipt): void {
  assertHash(receipt.requestHash, "terminal verification request");
  assertHash(receipt.subjectHash, "terminal verifier subject");
  assertHash(receipt.outputHash, "terminal verifier output");
  assertHash(receipt.receiptHash, "terminal verifier receipt");
  if (receipt.verifierVersion !== "storage-worker-terminal-verifier-v1") throw new Error("Canonical terminal verifier version is unsupported.");
  if (terminalReceiptHash(withoutReceiptHash(receipt)) !== receipt.receiptHash) throw new Error("Canonical terminal verifier receipt hash is invalid.");
  assertUnique(receipt.sourceReceiptIds, "terminal verifier source receipt");
  for (const value of [receipt.id, receipt.projectId, receipt.runId, receipt.jobId, receipt.criterionId, receipt.subjectKind, receipt.subjectId]) {
    if (!value || value.length > 320) throw new Error("Canonical terminal verifier receipt identity is malformed.");
  }
  if (!Number.isFinite(Date.parse(receipt.verifiedAt))) throw new Error("Canonical terminal verifier timestamp is invalid.");
}

export function terminalCheckpointOutputHash(input: StorageCompletedStepInput): string {
  return storageCanonicalHasher.sha256Canonical({
    step: input.step,
    checkpointData: input.checkpointData ?? null,
    outputRef: input.outputRef ?? null,
    outputHash: input.outputHash ?? null
  });
}

export function terminalPolicyOutputHash(job: StorageJob): string {
  return storageCanonicalHasher.sha256Canonical({
    requestHash: job.requestHash ?? null,
    requestedCapabilities: job.requestedCapabilities ?? null,
    effectiveCapabilities: job.effectiveCapabilities ?? null,
    toolPolicy: job.toolPolicy ?? null
  });
}

export function terminalAttemptSourceReceiptIds(attempt: StorageToolAttempt, outputLinkId: string): string[] {
  return [attempt.id, outputLinkId, ...(attempt.postconditionReceipt ? [attempt.postconditionReceipt.receiptId] : [])].sort();
}

export function assertHash(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} hash must be a lowercase SHA-256 digest.`);
}

export function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Canonical ${label} identifiers must be unique.`);
}

function withoutReceiptHash(receipt: StorageCanonicalTerminalVerifierReceipt): Omit<StorageCanonicalTerminalVerifierReceipt, "receiptHash"> {
  const { receiptHash, ...value } = receipt;
  void receiptHash;
  return value;
}
