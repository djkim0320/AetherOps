import type { ResearchSource } from "./types.js";

export function dedupeSourcesByIdUrlDoi(sources: ResearchSource[]): ResearchSource[] {
  const canonicalByKey = new Map<string, string>();
  const byCanonicalKey = new Map<string, ResearchSource>();
  const keyOrder: string[] = [];
  for (const source of sources) {
    const keys = sourceKeys(source);
    const existingCanonicalKey = keys.map((key) => canonicalByKey.get(key)).find((key): key is string => Boolean(key));
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
  return keyOrder.map((key) => byCanonicalKey.get(key)).filter((source): source is ResearchSource => Boolean(source));
}

function sourceKeys(source: ResearchSource): string[] {
  return [
    source.id ? `id:${source.id}` : undefined,
    normalizedUrl(source.url) ? `url:${normalizedUrl(source.url)}` : undefined,
    readString(source.metadata.url) ? `url:${normalizedUrl(readString(source.metadata.url))}` : undefined,
    readString(source.metadata.sourceUri) ? `url:${normalizedUrl(readString(source.metadata.sourceUri))}` : undefined,
    source.doi ? `doi:${source.doi.trim().toLowerCase()}` : undefined,
    readString(source.metadata.doi) ? `doi:${readString(source.metadata.doi)?.trim().toLowerCase()}` : undefined
  ].filter((key): key is string => Boolean(key));
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
  try {
    const parsed = new URL(value.trim());
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return value.trim().toLowerCase() || undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
