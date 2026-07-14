import { createHash } from "node:crypto";
import type { StorageToolAttempt, StorageToolPostconditionDisposition, StorageToolPostconditionReceipt, StorageToolSideEffect } from "./traceTypes.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TERMINAL_STATUSES = new Set<StorageToolAttempt["status"]>(["completed", "blocked", "failed", "interrupted", "quarantined"]);
const SIDE_EFFECTS = new Set<StorageToolSideEffect>(["network", "filesystem", "process"]);

export interface ToolPostconditionReceiptHashInput {
  attemptId: string;
  descriptorVersion?: string;
  idempotencyKey: string;
  sideEffectKey: string;
  disposition: StorageToolPostconditionDisposition;
  receiptId: string;
  evidenceHash: string;
  verifier: string;
  verifiedAt: string;
}

export function computeToolPostconditionReceiptHash(input: ToolPostconditionReceiptHashInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "aetherops.tool-postcondition-receipt.v1",
        input.attemptId,
        input.descriptorVersion ?? null,
        input.idempotencyKey,
        input.sideEffectKey,
        input.disposition,
        input.receiptId,
        input.evidenceHash,
        input.verifier,
        input.verifiedAt
      ])
    )
    .digest("hex");
}

export function assertStorageToolAttemptTrace(attempt: StorageToolAttempt): void {
  if (attempt.traceVersion === undefined) {
    assertLegacyAttemptHasNoVnextFields(attempt);
    return;
  }
  if (attempt.traceVersion !== 1) throw new Error(`Unsupported tool attempt trace version: ${String(attempt.traceVersion)}.`);
  if (attempt.traceAvailability && attempt.traceAvailability !== "vnext") throw new Error("Vnext tool attempt has an invalid trace availability marker.");
  assertNonEmpty(attempt.idempotencyKey, "Tool attempt idempotency key");
  assertDescriptorMetadata(attempt);
  if (attempt.sideEffectKey !== undefined) assertNonEmpty(attempt.sideEffectKey, "Tool attempt side-effect key");
  if (hasMutatingDescriptorEffect(attempt) && !attempt.sideEffectKey) {
    throw new Error("Filesystem or process tool attempts require an explicit side-effect key.");
  }
  assertPostconditionPair(attempt);
}

export function toolAttemptRequiresVerifiedPostcondition(attempt: StorageToolAttempt): boolean {
  return Boolean(attempt.sideEffectKey) || hasMutatingDescriptorEffect(attempt);
}

export function hasVerifiedToolPostcondition(attempt: StorageToolAttempt): boolean {
  try {
    assertVerifiedToolPostcondition(attempt);
    return true;
  } catch {
    return false;
  }
}

export function assertVerifiedToolPostcondition(attempt: StorageToolAttempt): void {
  const disposition = attempt.postconditionDisposition;
  const receipt = attempt.postconditionReceipt;
  if (!disposition || !receipt || !attempt.sideEffectKey || !attempt.idempotencyKey) {
    throw new Error("Tool attempt has no complete verified postcondition receipt.");
  }
  assertReceiptFields(receipt);
  const expected = computeToolPostconditionReceiptHash({
    attemptId: attempt.id,
    descriptorVersion: attempt.descriptorVersion,
    idempotencyKey: attempt.idempotencyKey,
    sideEffectKey: attempt.sideEffectKey,
    disposition,
    receiptId: receipt.receiptId,
    evidenceHash: receipt.evidenceHash,
    verifier: receipt.verifier,
    verifiedAt: receipt.verifiedAt
  });
  if (receipt.receiptHash !== expected) throw new Error("Tool postcondition receipt hash verification failed.");
}

export function assertToolAttemptOutputPromotionAllowed(attempt: StorageToolAttempt): void {
  if (attempt.status !== "completed") throw new Error(`Only completed tool attempts may promote outputs: ${attempt.id}.`);
  if (attempt.traceVersion === undefined) return;
  if (!attempt.descriptorVersion || attempt.descriptorSideEffects === undefined) {
    throw new Error(`Tool attempt descriptor trace is unavailable; output promotion is ambiguous: ${attempt.id}.`);
  }
  if (!toolAttemptRequiresVerifiedPostcondition(attempt)) return;
  assertVerifiedToolPostcondition(attempt);
  if (attempt.postconditionDisposition !== "applied") {
    throw new Error(`Tool attempt postcondition does not confirm that outputs were applied: ${attempt.id}.`);
  }
}

function assertLegacyAttemptHasNoVnextFields(attempt: StorageToolAttempt): void {
  if (attempt.traceAvailability && attempt.traceAvailability !== "legacy_unavailable") {
    throw new Error("Legacy tool attempt has an invalid trace availability marker.");
  }
  const fields = [
    attempt.descriptorVersion,
    attempt.descriptorSideEffects,
    attempt.sideEffectKey,
    attempt.idempotencyKey,
    attempt.postconditionDisposition,
    attempt.postconditionReceipt
  ];
  if (fields.some((value) => value !== undefined)) throw new Error("Legacy tool attempt cannot contain partial vnext side-effect trace fields.");
}

function assertDescriptorMetadata(attempt: StorageToolAttempt): void {
  const hasVersion = attempt.descriptorVersion !== undefined;
  const hasEffects = attempt.descriptorSideEffects !== undefined;
  if (hasVersion !== hasEffects) throw new Error("Tool attempt descriptor version and side effects must be recorded together.");
  if (!hasVersion) return;
  assertNonEmpty(attempt.descriptorVersion, "Tool descriptor version");
  const effects = attempt.descriptorSideEffects ?? [];
  if (!Array.isArray(effects)) throw new Error("Tool attempt descriptor side effects must be an array.");
  if (effects.some((effect) => !SIDE_EFFECTS.has(effect))) throw new Error("Tool attempt contains an unsupported descriptor side effect.");
  if (new Set(effects).size !== effects.length) throw new Error("Tool attempt descriptor side effects must be unique.");
}

function assertPostconditionPair(attempt: StorageToolAttempt): void {
  const hasDisposition = attempt.postconditionDisposition !== undefined;
  const hasReceipt = attempt.postconditionReceipt !== undefined;
  if (hasDisposition !== hasReceipt) throw new Error("Tool postcondition disposition and receipt must be recorded together.");
  if (!hasDisposition) return;
  if (!TERMINAL_STATUSES.has(attempt.status) || attempt.status === "blocked") {
    throw new Error("Tool postcondition receipts are valid only for executed terminal attempts.");
  }
  if (!toolAttemptRequiresVerifiedPostcondition(attempt)) {
    throw new Error("A tool postcondition receipt requires an explicit mutating side-effect identity.");
  }
  assertVerifiedToolPostcondition(attempt);
}

function assertReceiptFields(receipt: StorageToolPostconditionReceipt): void {
  assertNonEmpty(receipt.receiptId, "Tool postcondition receipt id");
  assertNonEmpty(receipt.verifier, "Tool postcondition verifier");
  if (!SHA256_PATTERN.test(receipt.evidenceHash)) throw new Error("Tool postcondition evidence hash must be a lowercase SHA-256 value.");
  if (!SHA256_PATTERN.test(receipt.receiptHash)) throw new Error("Tool postcondition receipt hash must be a lowercase SHA-256 value.");
  if (!Number.isFinite(Date.parse(receipt.verifiedAt))) throw new Error("Tool postcondition verifiedAt must be a valid timestamp.");
}

function hasMutatingDescriptorEffect(attempt: StorageToolAttempt): boolean {
  return attempt.descriptorSideEffects?.some((effect) => effect === "filesystem" || effect === "process") === true;
}

function assertNonEmpty(value: string | undefined, label: string): asserts value is string {
  if (!value?.trim()) throw new Error(`${label} is required.`);
}
