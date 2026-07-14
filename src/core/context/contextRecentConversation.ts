import { hashContextText } from "./contextCanonical.js";
import { ContextCompilerError, type ContextRecentConversationWindow } from "./contextTypes.js";

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ENTRIES = 16;
const MAX_CHARS = 32_000;

export function validateRecentConversationWindow(window: ContextRecentConversationWindow | undefined): void {
  if (!window) return;
  if (window.schemaVersion !== 1 || window.source !== "bounded_derived_cache" || window.canonicalStateAuthority !== false) {
    invalid("Recent conversation input must be an explicitly non-canonical bounded derived cache.");
  }
  assertStableId(window.cacheVersion, "recent conversation cache version");
  if (!Array.isArray(window.entries) || window.entries.length > MAX_ENTRIES) {
    invalid(`Recent conversation cache may contain at most ${MAX_ENTRIES} entries.`);
  }
  if (window.entries.reduce((sum, entry) => sum + (typeof entry.text === "string" ? entry.text.length : 0), 0) > MAX_CHARS) {
    invalid(`Recent conversation cache may contain at most ${MAX_CHARS} UTF-16 code units.`);
  }
  const seen = new Set<string>();
  for (const entry of window.entries) {
    assertStableId(entry.id, "recent conversation entry id");
    if (seen.has(entry.id)) invalid(`Recent conversation cache contains a duplicate entry: ${entry.id}`);
    seen.add(entry.id);
    if (!SHA256.test(entry.contentHash)) invalid(`Recent conversation entry ${entry.id} must have a lowercase SHA-256 hash.`);
    if (!Number.isSafeInteger(entry.priority) || entry.priority < 0 || entry.priority > 1_000) {
      invalid(`Context priority must be an integer from 0 to 1000: ${entry.id}`);
    }
    for (const sourceRef of entry.sourceRefs ?? []) assertStableId(sourceRef, `source refs for recent conversation entry ${entry.id}`);
  }
}

export async function verifyRecentConversationWindowHashes(window: ContextRecentConversationWindow | undefined): Promise<void> {
  for (const entry of window?.entries ?? []) {
    if ((await hashContextText(entry.text)) !== entry.contentHash) invalid(`Recent conversation cache content hash verification failed: ${entry.id}`);
  }
}

function assertStableId(value: string, label: string): void {
  if (typeof value !== "string" || !STABLE_ID.test(value)) invalid(`${label} must be a stable identifier.`);
}

function invalid(message: string): never {
  throw new ContextCompilerError("INVALID_CONTEXT_INPUT", message);
}
