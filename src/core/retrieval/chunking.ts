import { createStableId, nowIso } from "../shared/ids.js";
import type { ResearchChunk, ResearchSnapshot, ResearchSource } from "../shared/types.js";

const maxChunkChars = 1200;
const overlapChars = 160;
const whitespacePattern = /\s+/g;
const nonKeywordTokenPattern = /[^\p{L}\p{N}\s-]/gu;
const tokenPattern = /\S+/g;

export function buildSourceText(source: ResearchSource, snapshot: ResearchSnapshot): string {
  const evidence = snapshot.evidence.find((item) => `source_${item.id}` === source.id || item.sourceId === source.id);
  if (evidence) {
    return joinPresent("\n", evidence.title, evidence.summary, evidence.quote, evidence.citation, evidence.sourceUri);
  }

  const artifact = snapshot.artifacts.find((item) => `source_${item.id}` === source.id);
  if (artifact) {
    return joinPresent("\n", artifact.title, artifact.summary, artifact.content, artifact.relativePath);
  }

  const legacyAgentRun = snapshot.legacyAgentRuns.find((item) => `source_${item.id}` === source.id);
  if (legacyAgentRun) {
    return [legacyAgentRun.prompt, ...legacyAgentRun.logs, legacyAgentRun.toolPlan.join(", ")].join("\n");
  }

  const toolRun = snapshot.toolRuns.find((item) => `source_${item.id}` === source.id);
  if (toolRun) {
    return joinPresent("\n", toolRun.toolName, JSON.stringify(toolRun.input), JSON.stringify(toolRun.output), toolRun.error);
  }

  return joinPresent("\n", source.title, source.url, source.doi, JSON.stringify(source.metadata));
}

export function chunkResearchSource(source: ResearchSource, text: string): ResearchChunk[] {
  const normalized = text.replace(whitespacePattern, " ").trim();
  if (!normalized) {
    return [];
  }

  const chunks: ResearchChunk[] = [];
  let start = 0;
  let chunkIndex = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + maxChunkChars);
    const chunkText = normalized.slice(start, end).trim();
    if (chunkText) {
      chunks.push({
        id: createStableId("chunk", `${source.id}:${chunkIndex}:${chunkText}`),
        projectId: source.projectId,
        sourceId: source.id,
        text: chunkText,
        chunkIndex,
        keywords: extractKeywords(chunkText),
        createdAt: nowIso()
      });
      chunkIndex += 1;
    }
    if (end >= normalized.length) {
      break;
    }
    start = Math.max(0, end - overlapChars);
  }
  return chunks;
}

export function extractKeywords(text: string, limit = 12): string[] {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    if (token.length < 2) {
      continue;
    }
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const ranked: Array<[string, number]> = [];
  for (const entry of counts.entries()) {
    insertTopKeyword(ranked, entry, limit);
  }
  const keywords: string[] = [];
  for (let index = 0; index < ranked.length && index < limit; index += 1) {
    const entry = ranked[index];
    if (entry) keywords.push(entry[0]);
  }
  return keywords;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(nonKeywordTokenPattern, " ").match(tokenPattern) ?? [];
}

function insertTopKeyword(ranked: Array<[string, number]>, entry: [string, number], limit: number): void {
  if (limit <= 0) return;
  let insertAt = ranked.length;
  for (let index = 0; index < ranked.length; index += 1) {
    const current = ranked[index];
    if (!current) continue;
    if (entry[1] > current[1] || (entry[1] === current[1] && entry[0].localeCompare(current[0]) < 0)) {
      insertAt = index;
      break;
    }
  }
  if (insertAt >= limit) return;
  ranked.splice(insertAt, 0, entry);
  if (ranked.length > limit) ranked.pop();
}

function joinPresent(separator: string, ...values: unknown[]): string {
  const parts: string[] = [];
  for (const value of values) {
    if (value) parts.push(String(value));
  }
  return parts.join(separator);
}
