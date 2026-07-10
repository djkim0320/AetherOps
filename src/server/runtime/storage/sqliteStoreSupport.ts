import { createHash } from "node:crypto";
import type {
  MainMemorySearchOptions,
  NormalizedResearchRecord,
  ResearchProject,
  ResearchSource,
  ValidationStatus,
  MemoryScope
} from "../../../core/shared/types.js";
import { normalizeMemoryScope } from "../../../core/memory/researchMemory.js";

export interface ScopedProjectItem {
  id: string;
  projectId: string;
  workspaceProjectId?: string;
  memoryScope?: MemoryScope;
  validationStatus?: ValidationStatus;
}

export function defaultValidationStatus(parsed: Record<string, unknown>): ValidationStatus {
  if (parsed.memoryScope === "ephemeral") return "raw";
  const metadata = typeof parsed.metadata === "object" && parsed.metadata ? (parsed.metadata as Record<string, unknown>) : {};
  if (metadata.traceabilityKind === "external_source") return "normalized";
  if (metadata.traceabilityKind === "error") return "rejected";
  return "raw";
}

export function normalizeRecord(record: NormalizedResearchRecord): NormalizedResearchRecord {
  return {
    ...record,
    memoryScope: normalizeMemoryScope(record.memoryScope),
    sourceProjectId: record.sourceProjectId ?? record.originProjectId ?? record.projectId,
    validationStatus: record.validationStatus ?? defaultValidationStatus(record as unknown as Record<string, unknown>)
  };
}

export function groupByProject<T extends { projectId: string }>(items: T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(item.projectId, [...(groups.get(item.projectId) ?? []), item]);
  return [...groups.entries()];
}

export function sanitizeProject(project: ResearchProject): ResearchProject {
  return project;
}

export function sanitizeSourceForSqlite(source: ResearchSource): ResearchSource {
  if ((source.kind !== "web" && source.kind !== "paper") || (!source.url && !source.doi) || !Object.prototype.hasOwnProperty.call(source.metadata, "rawText"))
    return source;
  const metadata = { ...source.metadata };
  const rawText = typeof metadata.rawText === "string" ? metadata.rawText : undefined;
  delete metadata.rawText;
  if (rawText) {
    metadata.excerpt = typeof metadata.excerpt === "string" ? metadata.excerpt : rawText.slice(0, 1_000);
    metadata.characterCount = typeof metadata.characterCount === "number" ? metadata.characterCount : rawText.length;
    metadata.contentHash = metadata.contentHash ?? createHash("sha256").update(rawText).digest("hex");
  }
  return { ...source, metadata };
}

export function searchScopedItems<T extends ScopedProjectItem>(
  items: T[],
  query: string,
  options: MainMemorySearchOptions,
  textOf: (item: T) => string = defaultText
): T[] {
  const limit = options.limit ?? 24;
  if (limit <= 0) return [];
  const queryTokens = new Set(tokens(query));
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const scope = normalizeMemoryScope(item.memoryScope);
    if (!isVisibleScopedItemWithScope(item, options, scope)) continue;
    const score = queryTokens.size ? lexicalScore(queryTokens, textOf(item)) : 0;
    if (scope === "global" && score <= 0) continue;
    insertTopScored(scored, { item, score }, limit);
  }
  return scored.map((entry) => entry.item);
}

export function isVisibleScopedItem<T extends ScopedProjectItem>(item: T, options: MainMemorySearchOptions): boolean {
  return isVisibleScopedItemWithScope(item, options, normalizeMemoryScope(item.memoryScope));
}

function isVisibleScopedItemWithScope<T extends ScopedProjectItem>(item: T, options: MainMemorySearchOptions, scope: MemoryScope): boolean {
  if (options.projectId && item.projectId !== options.projectId && item.workspaceProjectId !== options.projectId && scope !== "global") return false;
  if (!options.includeEphemeral && scope === "ephemeral") return false;
  return item.validationStatus !== "rejected";
}

function defaultText<T extends ScopedProjectItem>(item: T): string {
  const searchable = item as T & { title?: string; content?: string; metadata?: unknown };
  return `${searchable.title ?? ""}\n${searchable.content ?? ""}\n${JSON.stringify(searchable.metadata ?? {})}`;
}

function insertTopScored<T>(scored: Array<{ item: T; score: number }>, entry: { item: T; score: number }, limit: number): void {
  let insertAt = scored.findIndex((candidate) => entry.score > candidate.score);
  if (insertAt < 0) insertAt = scored.length;
  if (insertAt >= limit) return;
  scored.splice(insertAt, 0, entry);
  if (scored.length > limit) scored.pop();
}

function lexicalScore(queryTokens: Set<string>, text: string): number {
  const weight = 1 / queryTokens.size;
  return tokens(text).reduce((score, token) => score + (queryTokens.has(token) ? weight : 0), 0);
}

function tokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .match(/\S+/g) ?? []
  );
}
