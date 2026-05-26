import type {
  NormalizedResearchRecord,
  OntologyConstraint,
  OntologyEntity,
  OntologyRelation,
  ResearchChunk,
  MemoryScope,
  TraceabilityKind
} from "./types.js";

export type ScopedResearchMemoryItem =
  | NormalizedResearchRecord
  | ResearchChunk
  | OntologyEntity
  | OntologyRelation
  | OntologyConstraint;

export function memoryScopeForTraceability(traceabilityKind: TraceabilityKind): MemoryScope {
  if (traceabilityKind === "external_source") return "global";
  if (traceabilityKind === "error") return "ephemeral";
  return "project_only";
}

export function tagMemoryScope<T extends { projectId: string; memoryScope?: MemoryScope; originProjectId?: string; workspaceProjectId?: string; sourceProjectId?: string }>(
  item: T,
  memoryScope: MemoryScope,
  originProjectId = item.originProjectId ?? item.projectId,
  workspaceProjectId = item.workspaceProjectId ?? item.projectId
): T & { memoryScope: MemoryScope; originProjectId: string; workspaceProjectId: string; sourceProjectId: string } {
  return {
    ...item,
    memoryScope,
    originProjectId,
    workspaceProjectId,
    sourceProjectId: item.sourceProjectId ?? originProjectId
  };
}

export function isVisibleInProjectMemory<T extends { projectId: string; memoryScope?: MemoryScope }>(
  item: T,
  projectId: string
): boolean {
  return item.projectId === projectId || item.memoryScope === "global";
}

export function splitMemoryScope<T extends { memoryScope?: MemoryScope }>(items: T[]): { global: T[]; project: T[]; ephemeral: T[] } {
  return {
    global: items.filter((item) => item.memoryScope === "global"),
    project: items.filter((item) => item.memoryScope === "project_only"),
    ephemeral: items.filter((item) => item.memoryScope === "ephemeral")
  };
}

export function normalizeMemoryScope(value: unknown): MemoryScope {
  if (value === "global" || value === "project_only" || value === "ephemeral") return value;
  if (value === "project") return "project_only";
  return "project_only";
}
