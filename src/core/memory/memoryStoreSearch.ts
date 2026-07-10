import type { MainMemorySearchOptions, MemoryScope } from "../shared/types.js";
import { normalizeMemoryScope } from "./researchMemory.js";

type ScopedProjectItem = { projectId: string; workspaceProjectId?: string; memoryScope?: MemoryScope };

export function byProject<T extends { projectId: string }>(items: T[], projectId: string): T[] {
  return items.filter((item) => item.projectId === projectId);
}

export function visibleInProject<T extends ScopedProjectItem>(items: T[], projectId: string): T[] {
  return items.filter((item) => item.projectId === projectId || item.workspaceProjectId === projectId || normalizeMemoryScope(item.memoryScope) === "global");
}

export function searchItems<T extends ScopedProjectItem>(
  items: T[],
  query: string,
  options: MainMemorySearchOptions,
  textOf: (item: T) => string = defaultSearchText
): T[] {
  const limit = options.limit ?? 24;
  const queryTokens = new Set(tokens(query));
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const scope = normalizeMemoryScope(item.memoryScope);
    if (options.projectId && item.projectId !== options.projectId && item.workspaceProjectId !== options.projectId && scope !== "global") continue;
    if (!options.includeEphemeral && scope === "ephemeral") continue;
    if ((item as T & { validationStatus?: string }).validationStatus === "rejected") continue;
    const score = lexicalScore(queryTokens, textOf(item));
    if (scope === "global" && score <= 0) continue;
    scored.push({ item, score });
  }
  return scored
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ item }) => item);
}

function defaultSearchText<T>(item: T): string {
  const record = item as T & { title?: string; content?: string; metadata?: unknown };
  return `${record.title ?? ""}\n${record.content ?? ""}\n${JSON.stringify(record.metadata ?? {})}`;
}

function lexicalScore(queryTokens: Set<string>, text: string): number {
  if (!queryTokens.size) return 0;
  let score = 0;
  const weight = 1 / queryTokens.size;
  for (const token of tokens(text)) {
    if (queryTokens.has(token)) score += weight;
  }
  return score;
}

function tokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .match(/\S+/g) ?? []
  );
}
