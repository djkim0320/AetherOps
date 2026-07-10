import type {
  NormalizedResearchRecord,
  OntologyConstraint,
  OntologyEntity,
  OntologyRelation,
  ResearchChunk,
  MemoryScope,
  TraceabilityKind
} from "../shared/types.js";

export type ScopedResearchMemoryItem = NormalizedResearchRecord | ResearchChunk | OntologyEntity | OntologyRelation | OntologyConstraint;

export function memoryScopeForTraceability(traceabilityKind: TraceabilityKind): MemoryScope {
  if (traceabilityKind === "external_source") return "global";
  if (traceabilityKind === "error") return "ephemeral";
  return "project_only";
}

export function tagMemoryScope<
  T extends { projectId: string; memoryScope?: MemoryScope; originProjectId?: string; workspaceProjectId?: string; sourceProjectId?: string }
>(
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

export function isVisibleInProjectMemory<T extends { projectId: string; memoryScope?: MemoryScope }>(item: T, projectId: string): boolean {
  return item.projectId === projectId || item.memoryScope === "global";
}

export function splitMemoryScope<T extends { memoryScope?: MemoryScope }>(items: T[]): { global: T[]; project: T[]; ephemeral: T[] } {
  const global: T[] = [];
  const project: T[] = [];
  const ephemeral: T[] = [];
  for (const item of items) {
    if (item.memoryScope === "global") {
      global.push(item);
    } else if (item.memoryScope === "ephemeral") {
      ephemeral.push(item);
    } else if (item.memoryScope === "project_only") {
      project.push(item);
    }
  }
  return { global, project, ephemeral };
}

export function normalizeMemoryScope(value: unknown): MemoryScope {
  if (value === "global" || value === "project_only" || value === "ephemeral") return value;
  if (value === "project") return "project_only";
  return "project_only";
}
