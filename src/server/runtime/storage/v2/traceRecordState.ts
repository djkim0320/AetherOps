import { isDeepStrictEqual } from "node:util";
import type { StorageCodexCliExecution, StorageToolDecision } from "./traceTypes.js";

export function assertToolDecisionUpdate(existing: StorageToolDecision | undefined, next: StorageToolDecision): void {
  if (!existing || isDeepStrictEqual(comparableDecision(existing), comparableDecision(next))) return;
  if (existing.policyStatus !== "accepted" || next.policyStatus !== "rejected" || !next.policyReason) {
    throw new Error("Tool decision retry conflicts with an immutable receipt.");
  }
  if (!isDeepStrictEqual(decisionIdentity(existing), decisionIdentity(next))) {
    throw new Error("Tool decision policy transition conflicts with its immutable identity.");
  }
}

export function assertCodexExecutionUpdate(existing: StorageCodexCliExecution | undefined, next: StorageCodexCliExecution): void {
  if (existing && !isDeepStrictEqual(comparableCodexExecution(existing), comparableCodexExecution(next))) {
    throw new Error("Codex execution retry conflicts with an immutable receipt.");
  }
}

function decisionIdentity(value: StorageToolDecision): Record<string, unknown> {
  return {
    ...comparableDecision(value),
    policyStatus: "accepted",
    policyReason: null,
    createdAt: null
  };
}

function comparableDecision(value: StorageToolDecision): Record<string, unknown> {
  return {
    ...value,
    invocationId: value.invocationId ?? null,
    policyReason: value.policyReason ?? null,
    compiledAction: value.compiledAction ?? null,
    data: value.data ?? null
  };
}

function comparableCodexExecution(value: StorageCodexCliExecution): Record<string, unknown> {
  return {
    ...value,
    durationMs: value.durationMs ?? null,
    exitCode: value.exitCode ?? null,
    terminationReason: value.terminationReason ?? null,
    workspaceManifestHash: value.workspaceManifestHash ?? null,
    outputManifestHash: value.outputManifestHash ?? null,
    completedAt: value.completedAt ?? null,
    data: value.data ?? null
  };
}
