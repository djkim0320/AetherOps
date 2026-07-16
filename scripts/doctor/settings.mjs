import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readPersistedSettings(dataRoot) {
  const path = join(dataRoot, "settings.json");
  if (!existsSync(path)) return { path, present: false, value: {} };
  const value = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  return { path, present: true, value };
}

export function hasEncryptedSecret(value) {
  return typeof value === "string" && value.trim().length > 0 && value !== "keep";
}

export function codexSettings(settings) {
  const root = record(settings);
  if (!root) return undefined;
  if (Object.hasOwn(root, "codex")) return root.codex;
  if (Object.hasOwn(root, "openCodeLlm")) return root.openCodeLlm;
  return undefined;
}

export function normalizedCodexSettings(settings) {
  const root = record(settings);
  const persisted = codexSettings(settings);
  const configured = Boolean(root && (Object.hasOwn(root, "codex") || Object.hasOwn(root, "openCodeLlm")));
  const source = root && Object.hasOwn(root, "codex") ? "codex" : root && Object.hasOwn(root, "openCodeLlm") ? "legacy" : "default";
  const value = record(persisted);
  const structurallyValid = Boolean(root) && (!configured || Boolean(value));
  const defaultsApplied = {
    model: structurallyValid && value?.model === undefined,
    reasoningEffort: structurallyValid && value?.reasoningEffort === undefined,
    timeoutMs: structurallyValid && value?.timeoutMs === undefined,
    taskTimeoutMs: structurallyValid && value?.taskTimeoutMs === undefined
  };
  const legacyTaskTimeout = source === "legacy" ? validTimeout(record(root?.openCode)?.timeoutMs) : undefined;
  return {
    ...(value ?? {}),
    model: defaultOnlyWhenMissing(value?.model, "gpt-5.6"),
    reasoningEffort: defaultOnlyWhenMissing(value?.reasoningEffort, "xhigh"),
    timeoutMs: defaultOnlyWhenMissing(value?.timeoutMs, 180_000),
    taskTimeoutMs: defaultOnlyWhenMissing(value?.taskTimeoutMs, Math.max(600_000, legacyTaskTimeout ?? 0)),
    configured,
    configurationSource: source,
    structurallyValid,
    defaultsApplied
  };
}

function defaultOnlyWhenMissing(value, fallback) {
  return value === undefined ? fallback : value;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function validTimeout(value) {
  return Number.isInteger(value) && value >= 1_000 && value <= 900_000 ? value : undefined;
}

export function capabilitySettings(settings) {
  if (settings.capabilities) return settings.capabilities;
  return {
    agent: settings.allowAgent ?? true,
    engineering: Boolean(settings.allowCodeExecution),
    search: Boolean(settings.allowExternalSearch)
  };
}
