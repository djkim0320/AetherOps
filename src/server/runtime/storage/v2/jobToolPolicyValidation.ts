import { isDeepStrictEqual } from "node:util";
import { isPersistableSourceAllowlistUrl, normalizePublicSourceDomain } from "../../../../shared/kernel/sourceAccessPolicy.js";
import { storageCanonicalHasher } from "./runStatePayloadValidator.js";
import type { StorageCapabilitySet, StorageJobInput, StorageJobToolPolicy } from "./types.js";

const MAX_SOURCE_POLICY_ENTRIES = 32;
const MAX_SOURCE_URL_LENGTH = 4_096;
const MAX_SOURCE_DOMAIN_LENGTH = 253;

export function assertPersistableJobInputPolicies(input: StorageJobInput): void {
  assertPersistableJobToolPolicy(input.toolPolicy);
  if (input.operation !== "research_loop" || !input.toolPolicy) return;
  const payload = optionalRecord(input.payload);
  const request = optionalRecord(payload?.request);
  if (!request) return;
  if (request.toolPolicy !== undefined) {
    assertPersistableJobToolPolicy(request.toolPolicy);
    if (!isDeepStrictEqual(request.toolPolicy, input.toolPolicy)) invalid();
  }
  if (request.action === "start") assertInitializationAnchor(request.canonicalInitializationAnchor, input);
}

export function assertPersistableJobToolPolicy(policy: unknown): asserts policy is StorageJobToolPolicy {
  if (policy === undefined) return;
  if (!isPlainRecord(policy) || !hasExactKeys(policy, ["allowCodexCli", "sourceAccess"]) || typeof policy.allowCodexCli !== "boolean") invalid();
  const sourceAccess = policy.sourceAccess;
  if (!isPlainRecord(sourceAccess) || typeof sourceAccess.mode !== "string") invalid();
  if (sourceAccess.mode === "offline") {
    if (!hasExactKeys(sourceAccess, ["mode"])) invalid();
    return;
  }
  if (sourceAccess.mode === "allowlist") {
    if (!hasExactKeys(sourceAccess, ["mode", "urls"]) || !boundedStrings(sourceAccess.urls, 1, MAX_SOURCE_POLICY_ENTRIES, MAX_SOURCE_URL_LENGTH)) invalid();
    for (const value of sourceAccess.urls) {
      if (!isPersistableSourceAllowlistUrl(value) || hasFragment(value) || new URL(value).toString() !== value) invalid();
    }
    return;
  }
  if (sourceAccess.mode === "discovery") {
    if (
      !hasExactKeys(sourceAccess, ["mode", "allowedDomains"]) ||
      !boundedStrings(sourceAccess.allowedDomains, 0, MAX_SOURCE_POLICY_ENTRIES, MAX_SOURCE_DOMAIN_LENGTH)
    ) {
      invalid();
    }
    for (const value of sourceAccess.allowedDomains) {
      if (normalizePublicSourceDomain(value) !== value) invalid();
    }
    return;
  }
  invalid();
}

function assertInitializationAnchor(value: unknown, input: StorageJobInput): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["schemaVersion", "projectId", "taskSource", "immutablePolicy", "taskLimits", "contentHash"])) invalid();
  if (value.schemaVersion !== 1 || value.projectId !== input.projectId || typeof value.contentHash !== "string") invalid();
  const immutablePolicy = optionalRecord(value.immutablePolicy);
  if (!immutablePolicy || !hasExactKeys(immutablePolicy, ["requestedCapabilities", "effectiveCapabilities", "toolPolicy"])) invalid();
  assertCapabilitySet(immutablePolicy.requestedCapabilities, input.requestedCapabilities);
  assertCapabilitySet(immutablePolicy.effectiveCapabilities, input.effectiveCapabilities);
  assertPersistableJobToolPolicy(immutablePolicy.toolPolicy);
  if (!isDeepStrictEqual(immutablePolicy.toolPolicy, canonicalToolPolicy(input.toolPolicy!))) invalid();
  const body = {
    schemaVersion: value.schemaVersion,
    projectId: value.projectId,
    taskSource: value.taskSource,
    immutablePolicy: value.immutablePolicy,
    taskLimits: value.taskLimits
  };
  if (value.contentHash !== storageCanonicalHasher.sha256Canonical(body)) invalid();
}

function assertCapabilitySet(value: unknown, expected: StorageCapabilitySet | undefined): void {
  if (!expected || !isPlainRecord(value) || !hasExactKeys(value, ["agent", "engineering", "search"])) invalid();
  if (![value.agent, value.engineering, value.search].every((entry) => typeof entry === "boolean") || !isDeepStrictEqual(value, expected)) invalid();
}

function canonicalToolPolicy(policy: StorageJobToolPolicy): StorageJobToolPolicy {
  if (policy.sourceAccess.mode === "allowlist") {
    return { allowCodexCli: policy.allowCodexCli, sourceAccess: { mode: "allowlist", urls: [...new Set(policy.sourceAccess.urls)].sort() } };
  }
  if (policy.sourceAccess.mode === "discovery") {
    return {
      allowCodexCli: policy.allowCodexCli,
      sourceAccess: { mode: "discovery", allowedDomains: [...new Set(policy.sourceAccess.allowedDomains)].sort() }
    };
  }
  return { allowCodexCli: policy.allowCodexCli, sourceAccess: { mode: "offline" } };
}

function hasFragment(value: string): boolean {
  try {
    return Boolean(new URL(value).hash);
  } catch {
    return true;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function boundedStrings(value: unknown, minimum: number, maximum: number, maximumLength: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= maximumLength)
  );
}

function invalid(): never {
  throw new Error("Job tool policy is unsafe for operational storage.");
}
