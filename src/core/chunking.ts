import { createStableId, nowIso } from "./ids.js";
import type { ResearchChunk, ResearchSnapshot, ResearchSource } from "./types.js";

const maxChunkChars = 1200;
const overlapChars = 160;

export function buildSourceText(source: ResearchSource, snapshot: ResearchSnapshot): string {
  const evidence = snapshot.evidence.find((item) => `source_${item.id}` === source.id || item.sourceId === source.id);
  if (evidence) {
    return [evidence.title, evidence.summary, evidence.quote, evidence.citation, evidence.sourceUri].filter(Boolean).join("\n");
  }

  const artifact = snapshot.artifacts.find((item) => `source_${item.id}` === source.id);
  if (artifact) {
    return [artifact.title, artifact.summary, artifact.content, artifact.relativePath].filter(Boolean).join("\n");
  }

  const openCodeRun = snapshot.openCodeRuns.find((item) => `source_${item.id}` === source.id);
  if (openCodeRun) {
    return [openCodeRun.prompt, ...openCodeRun.logs, openCodeRun.toolPlan.join(", ")].join("\n");
  }

  const toolRun = snapshot.toolRuns.find((item) => `source_${item.id}` === source.id);
  if (toolRun) {
    return [
      toolRun.toolName,
      JSON.stringify(toolRun.input),
      JSON.stringify(toolRun.output),
      toolRun.error
    ].filter(Boolean).join("\n");
  }

  return [source.title, source.url, source.doi, JSON.stringify(source.metadata)].filter(Boolean).join("\n");
}

export function chunkResearchSource(source: ResearchSource, text: string): ResearchChunk[] {
  const normalized = text.replace(/\s+/g, " ").trim();
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
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token);
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}
