import type { ElementDefinition } from "cytoscape";
import type {
  KnowledgeEdge,
  KnowledgeGraph,
  KnowledgeGraphFilters,
  KnowledgeMode,
  KnowledgeNode,
  KnowledgeRecord
} from "./knowledge-types.ts";
import { KNOWLEDGE_MAX_EDGES, KNOWLEDGE_MAX_NODES } from "./knowledge-types.ts";

function isRecord(value: unknown): value is KnowledgeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): KnowledgeRecord {
  return isRecord(value) ? value : {};
}

function sourceRecord(payload: unknown): KnowledgeRecord {
  const root = object(payload);
  return isRecord(root.graph) ? root.graph : isRecord(root.subgraph) ? root.subgraph : root;
}

function text(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function stringArray(...values: unknown[]): string[] {
  for (const value of values) {
    if (Array.isArray(value)) {
      return [...new Set(value.flatMap((item) => {
        const candidate = typeof item === "string" ? item.trim() : isRecord(item)
          ? text(item.id, item.entity_id, item.assertion_id, item.evidence_id, item.iri, item.value)
          : undefined;
        return candidate ? [candidate] : [];
      }))];
    }
    const candidate = text(value);
    if (candidate) return [candidate];
  }
  return [];
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function booleanValue(...values: unknown[]): boolean {
  return values.some((value) => value === true || value === "true" || value === "conflict" || value === "contested" || value === "disputed");
}

function localName(value: string): string {
  const normalized = value.replace(/[\/#]+$/, "");
  const split = Math.max(normalized.lastIndexOf("#"), normalized.lastIndexOf("/"), normalized.lastIndexOf(":"));
  return split >= 0 ? normalized.slice(split + 1) || value : value;
}

function normalizeNode(value: unknown, mode: KnowledgeMode): KnowledgeNode | null {
  const raw = object(value);
  const id = text(raw.id, raw.entity_id, raw.iri, raw.uri, raw["@id"]);
  if (!id) return null;
  const types = stringArray(raw.types, raw.type_ids, raw["@type"], raw.type);
  const inferredKind = mode === "ontology" || types.some((type) => /(?:Class|Property|Ontology)$/i.test(type))
    ? "ontology"
    : "instance";
  return {
    id,
    label: text(raw.label, raw.name, raw.title, raw.compact_iri) ?? localName(id),
    kind: text(raw.kind, raw.node_type, raw.entity_type, raw.category) ?? inferredKind,
    types,
    assertionIDs: stringArray(raw.assertion_ids, raw.assertions),
    evidenceIDs: stringArray(raw.evidence_ids, raw.evidence),
    confidence: numberValue(raw.confidence, raw.score),
    conflict: booleanValue(raw.conflict, raw.contested, raw.has_conflict, raw.status),
    pinned: booleanValue(raw.pinned, raw.is_pinned),
    raw
  };
}

function endpointID(value: unknown): string | undefined {
  return text(value) ?? (isRecord(value) ? text(value.id, value.entity_id, value.iri, value["@id"]) : undefined);
}

function normalizeEdge(value: unknown, index: number): KnowledgeEdge | null {
  const raw = object(value);
  const source = endpointID(raw.source) ?? endpointID(raw.source_id) ?? endpointID(raw.from) ?? endpointID(raw.subject) ?? endpointID(raw.subject_id);
  const target = endpointID(raw.target) ?? endpointID(raw.target_id) ?? endpointID(raw.to) ?? endpointID(raw.object) ?? endpointID(raw.object_id);
  if (!source || !target) return null;
  const predicate = text(raw.predicate, raw.predicate_id, raw.relation, raw.type, raw.label) ?? "relatedTo";
  const assertionID = text(raw.assertion_id, raw.assertion);
  const validFrom = text(raw.valid_from, raw.validFrom);
  const validTo = text(raw.valid_to, raw.validTo);
  const fromTime = validFrom ? Date.parse(validFrom) : Number.NaN;
  const toTime = validTo ? Date.parse(validTo) : Number.NaN;
  if ((validFrom && !Number.isFinite(fromTime)) || (validTo && !Number.isFinite(toTime)) ||
    (Number.isFinite(fromTime) && Number.isFinite(toTime) && fromTime > toTime)) return null;
  return {
    id: text(raw.id, raw.edge_id) ?? `${source}::${predicate}::${target}::${index}`,
    source,
    target,
    label: text(raw.label, raw.predicate_label) ?? localName(predicate),
    predicate,
    assertionID,
    evidenceIDs: stringArray(raw.evidence_ids, raw.evidence),
    conflict: booleanValue(raw.conflict, raw.contested, raw.has_conflict, raw.status),
    status: text(raw.status),
    validFrom,
    validTo,
    raw
  };
}

function arrayFrom(source: KnowledgeRecord, keys: string[]): unknown[] {
  for (const key of keys) if (Array.isArray(source[key])) return source[key] as unknown[];
  return [];
}

export function adaptKnowledgeSubgraph(payload: unknown, mode: KnowledgeMode): KnowledgeGraph {
  const source = sourceRecord(payload);
  const rawNodes = arrayFrom(source, ["nodes", "entities", "vertices"]);
  const rawEdges = arrayFrom(source, ["edges", "relations", "links", "assertions"]);
  const seen = new Set<string>();
  const normalizedNodes: KnowledgeNode[] = [];
  for (const item of rawNodes) {
    const node = normalizeNode(item, mode);
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    normalizedNodes.push(node);
  }
  const nodeLimitExceeded = normalizedNodes.length > KNOWLEDGE_MAX_NODES;
  let nodes = normalizedNodes.slice(0, KNOWLEDGE_MAX_NODES);
  const allowed = new Set(nodes.map((node) => node.id));
  const normalizedEdges: KnowledgeEdge[] = [];
  const edgeIDs = new Set<string>();
  for (const item of rawEdges) {
    const edge = normalizeEdge(item, normalizedEdges.length);
    if (!edge || !allowed.has(edge.source) || !allowed.has(edge.target) || edgeIDs.has(edge.id)) continue;
    edgeIDs.add(edge.id);
    normalizedEdges.push(edge);
  }
  const edges = normalizedEdges.slice(0, KNOWLEDGE_MAX_EDGES);
  const conflictedNodeIDs = new Set(edges.filter((edge) => edge.conflict).flatMap((edge) => [edge.source, edge.target]));
  nodes = nodes.map((node) => conflictedNodeIDs.has(node.id) && !node.conflict ? { ...node, conflict: true } : node);
  const edgeLimitExceeded = normalizedEdges.length > KNOWLEDGE_MAX_EDGES;
  const totalNodes = numberValue(source.total_nodes, source.totalNodes, source.node_count) ?? normalizedNodes.length;
  const totalEdges = numberValue(source.total_edges, source.totalEdges, source.edge_count) ?? normalizedEdges.length;
  return {
    nodes,
    edges,
    totalNodes,
    totalEdges,
    truncated: booleanValue(source.truncated) || nodeLimitExceeded || edgeLimitExceeded || totalNodes > nodes.length || totalEdges > normalizedEdges.length
  };
}

export function filterKnowledgeGraph(graph: KnowledgeGraph, filters: KnowledgeGraphFilters): KnowledgeGraph {
  const query = filters.query.trim().toLowerCase();
  const visibleNodes = graph.nodes.filter((node) => {
    if (filters.type && filters.type !== "all" && !node.types.includes(filters.type) && node.kind !== filters.type) return false;
    if (!query) return true;
    return [node.id, node.label, node.kind, ...node.types].some((value) => value.toLowerCase().includes(query));
  });
  const nodeIDs = new Set(visibleNodes.map((node) => node.id));
  const validAt = filters.validAt ? Date.parse(filters.validAt) : Number.NaN;
  const visibleEdges = graph.edges.filter((edge) => {
    if (!nodeIDs.has(edge.source) || !nodeIDs.has(edge.target)) return false;
    if (filters.predicate && filters.predicate !== "all" && edge.predicate !== filters.predicate) return false;
    if (filters.conflict === "only" && !edge.conflict) return false;
    if (filters.conflict === "exclude" && edge.conflict) return false;
    if (Number.isFinite(validAt)) {
      const from = edge.validFrom ? Date.parse(edge.validFrom) : Number.NaN;
      const to = edge.validTo ? Date.parse(edge.validTo) : Number.NaN;
      if (Number.isFinite(from) && validAt < from) return false;
      if (Number.isFinite(to) && validAt > to) return false;
    }
    return true;
  });
  const connectedIDs = new Set(visibleEdges.flatMap((edge) => [edge.source, edge.target]));
  const relationFilterActive = (filters.predicate && filters.predicate !== "all") ||
    filters.conflict !== "all" || Number.isFinite(validAt);
  const nodes = relationFilterActive
    ? visibleNodes.filter((node) => connectedIDs.has(node.id))
    : visibleNodes;
  return { ...graph, nodes, edges: visibleEdges };
}

export function knowledgeGraphElements(graph: KnowledgeGraph, selectedEntityIDs: ReadonlySet<string> = new Set()): ElementDefinition[] {
  return [
    ...graph.nodes.map((node) => ({
      group: "nodes" as const,
      selected: selectedEntityIDs.has(node.id),
      data: {
        id: node.id,
        label: node.label,
        kind: node.kind,
        conflict: node.conflict ? "true" : "false",
        pinned: node.pinned ? "true" : "false",
        confidence: node.confidence ?? 0
      }
    })),
    ...graph.edges.map((edge) => ({
      group: "edges" as const,
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        predicate: edge.predicate,
        conflict: edge.conflict ? "true" : "false"
      }
    }))
  ];
}

export function graphFilterOptions(graph: KnowledgeGraph): { types: string[]; predicates: string[] } {
  const types = new Set<string>();
  for (const node of graph.nodes) {
    types.add(node.kind);
    for (const type of node.types) types.add(type);
  }
  return {
    types: [...types].sort(compareCodeUnits),
    predicates: [...new Set(graph.edges.map((edge) => edge.predicate))].sort(compareCodeUnits)
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
