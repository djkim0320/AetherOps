import type { ResearchSource } from "../shared/types.js";

export function dedupeSourcesByIdUrlDoi(sources: ResearchSource[]): ResearchSource[] {
  if (!sources.length) return [];
  if (sources.length === 1) return [sources[0] as ResearchSource];
  const canonicalByKey = new Map<string, string>();
  const byCanonicalKey = new Map<string, ResearchSource>();
  const keyOrder: string[] = [];
  for (const source of sources) {
    const keys = sourceKeys(source);
    const existingCanonicalKey = findCanonicalKey(keys, canonicalByKey);
    if (!existingCanonicalKey) {
      const canonicalKey = keys[0] ?? `source:${source.id}`;
      for (const key of keys) canonicalByKey.set(key, canonicalKey);
      byCanonicalKey.set(canonicalKey, source);
      keyOrder.push(canonicalKey);
      continue;
    }
    for (const key of keys) canonicalByKey.set(key, existingCanonicalKey);
    const existing = byCanonicalKey.get(existingCanonicalKey)!;
    byCanonicalKey.set(existingCanonicalKey, mergeSource(existing, source));
  }
  const deduped: ResearchSource[] = [];
  for (const key of keyOrder) {
    const source = byCanonicalKey.get(key);
    if (source) deduped.push(source);
  }
  return deduped;
}

function findCanonicalKey(keys: string[], canonicalByKey: Map<string, string>): string | undefined {
  for (const key of keys) {
    const canonicalKey = canonicalByKey.get(key);
    if (canonicalKey) return canonicalKey;
  }
  return undefined;
}

function sourceKeys(source: ResearchSource): string[] {
  const keys: string[] = [];
  if (source.id) keys.push(`id:${source.id}`);
  pushUrlKey(keys, source.url);
  pushUrlKey(keys, readString(source.metadata.url));
  pushUrlKey(keys, readString(source.metadata.sourceUri));
  pushDoiKey(keys, source.doi);
  pushDoiKey(keys, readString(source.metadata.doi));
  return keys;
}

function mergeSource(first: ResearchSource, duplicate: ResearchSource): ResearchSource {
  const sourceCandidateOnly = Boolean(first.metadata.sourceCandidateOnly || duplicate.metadata.sourceCandidateOnly);
  return {
    ...first,
    url: first.url ?? duplicate.url,
    doi: first.doi ?? duplicate.doi,
    rawPath: first.rawPath ?? duplicate.rawPath,
    metadata: {
      ...duplicate.metadata,
      ...first.metadata,
      ...(sourceCandidateOnly ? { sourceCandidateOnly } : {})
    }
  };
}

function normalizedUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return trimmed.toLowerCase();
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pushUrlKey(keys: string[], value: string | undefined): void {
  const normalized = normalizedUrl(value);
  if (normalized) keys.push(`url:${normalized}`);
}

function pushDoiKey(keys: string[], value: string | undefined): void {
  const normalized = value?.trim().toLowerCase();
  if (normalized) keys.push(`doi:${normalized}`);
}
