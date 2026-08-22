import { del, get, listFrom, objectFrom, patch as patchRequest, post } from "./api";
import type {
  KnowledgeAssertion,
  KnowledgeEntity,
  KnowledgeEvidence,
  KnowledgeImportRequest,
  KnowledgeImportResponse,
  KnowledgeMaterial,
  KnowledgeRecord,
  KnowledgeSearchResult,
  KnowledgeStatus,
  KnowledgeSubgraphOptions
} from "./knowledge-types";
import {
  KNOWLEDGE_MAX_EDGES,
  KNOWLEDGE_MAX_NODES,
  KNOWLEDGE_MAX_SEARCH_RESULTS,
  KNOWLEDGE_MAX_SPARQL_ROWS
} from "./knowledge-types";

function projectKnowledgePath(projectID: string, suffix = ""): string {
  return `/api/v1/projects/${encodeURIComponent(projectID)}/knowledge${suffix}`;
}

function record(value: unknown, preferredKey?: string): KnowledgeRecord {
  return (objectFrom(value, preferredKey) ?? {}) as KnowledgeRecord;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function fetchKnowledgeStatus(projectID: string): Promise<KnowledgeStatus> {
  return record(await get<unknown>(projectKnowledgePath(projectID, "/status")), "status") as KnowledgeStatus;
}

export async function searchKnowledge(
  projectID: string,
  query: string,
  limit = KNOWLEDGE_MAX_SEARCH_RESULTS
): Promise<KnowledgeSearchResult[]> {
  const params = new URLSearchParams({
    q: query.trim(),
    limit: String(Math.max(1, Math.min(KNOWLEDGE_MAX_SEARCH_RESULTS, limit)))
  });
  const payload = await get<unknown>(projectKnowledgePath(projectID, `/search?${params.toString()}`));
  const source = record(payload);
  const items = listFrom<unknown>(payload, "results");
  const candidates = items.length > 0
    ? items
    : Array.isArray(source.entities) ? source.entities
    : Array.isArray(source.matches) ? source.matches
    : [];
  return candidates.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const raw = item as KnowledgeRecord;
    const id = text(raw.id) ?? text(raw.entity_id) ?? text(raw.iri);
    if (!id) return [];
    return [{
      id,
      label: text(raw.label) ?? text(raw.name) ?? text(raw.title) ?? id,
      kind: text(raw.kind) ?? text(raw.entity_type) ?? text(raw.type) ?? "entity",
      description: text(raw.description) ?? text(raw.summary),
      score: number(raw.score),
      raw
    }];
  });
}

export async function fetchKnowledgeSubgraph(projectID: string, options: KnowledgeSubgraphOptions): Promise<unknown> {
  const params = new URLSearchParams({
    mode: options.mode,
    max_nodes: String(Math.max(1, Math.min(KNOWLEDGE_MAX_NODES, options.maxNodes ?? KNOWLEDGE_MAX_NODES))),
    max_edges: String(Math.max(1, Math.min(KNOWLEDGE_MAX_EDGES, options.maxEdges ?? KNOWLEDGE_MAX_EDGES)))
  });
  if (options.query?.trim()) params.set("q", options.query.trim());
  if (options.entityID?.trim()) params.set("entity_id", options.entityID.trim());
  if (options.ontologyID?.trim()) params.set("ontology_id", options.ontologyID.trim());
  return get<unknown>(projectKnowledgePath(projectID, `/subgraph?${params.toString()}`));
}

export async function fetchKnowledgeEntity(projectID: string, entityID: string): Promise<KnowledgeEntity> {
  return record(
    await get<unknown>(projectKnowledgePath(projectID, `/entities/${encodeURIComponent(entityID)}`)),
    "entity"
  ) as KnowledgeEntity;
}

export async function fetchKnowledgeAssertion(projectID: string, assertionID: string): Promise<KnowledgeAssertion> {
  return record(
    await get<unknown>(projectKnowledgePath(projectID, `/assertions/${encodeURIComponent(assertionID)}`)),
    "assertion"
  ) as KnowledgeAssertion;
}

export async function fetchKnowledgeEvidence(projectID: string, evidenceID: string): Promise<KnowledgeEvidence[]> {
  const payload = await get<unknown>(projectKnowledgePath(projectID, `/evidence/${encodeURIComponent(evidenceID)}`));
  return listFrom<KnowledgeEvidence>(payload, "evidence");
}

export function executeKnowledgeSparql(projectID: string, query: string, maxRows = KNOWLEDGE_MAX_SPARQL_ROWS): Promise<unknown> {
  return post<unknown>(projectKnowledgePath(projectID, "/sparql"), {
    query,
    max_rows: Math.max(1, Math.min(KNOWLEDGE_MAX_SPARQL_ROWS, maxRows))
  });
}

export function submitKnowledgeEdit(projectID: string, patch: KnowledgeRecord): Promise<unknown> {
  return post<unknown>(projectKnowledgePath(projectID, "/edits"), { patch });
}

export async function importKnowledgeOntology(
  projectID: string,
  request: KnowledgeImportRequest
): Promise<KnowledgeImportResponse> {
  return record(
    await post<unknown>(projectKnowledgePath(projectID, "/ontology/import"), request),
    "ontology"
  ) as KnowledgeImportResponse;
}

export function activateKnowledgeOntology(projectID: string, versionID: string): Promise<unknown> {
  return post<unknown>(projectKnowledgePath(projectID, `/ontology/${encodeURIComponent(versionID)}/activate`));
}

export function rebuildKnowledge(projectID: string): Promise<unknown> {
  return post<unknown>(projectKnowledgePath(projectID, "/rebuild"));
}

export async function fetchKnowledgeMaterials(projectID: string): Promise<KnowledgeMaterial[]> {
  const payload = await get<unknown>(projectKnowledgePath(projectID, "/materials"));
  return listFrom<KnowledgeMaterial>(payload, "materials");
}

export function pinKnowledgeMaterial(projectID: string, request: {
  title: string;
  filename: string;
  media_type: string;
  content_base64: string;
  graph_adopt: boolean;
}): Promise<unknown> {
  return post<unknown>(projectKnowledgePath(projectID, "/materials"), request);
}

export function setKnowledgeMaterialGraphAdopt(projectID: string, materialID: string, graphAdopt: boolean): Promise<unknown> {
  return patchRequest<unknown>(projectKnowledgePath(projectID, `/materials/${encodeURIComponent(materialID)}`), {
    graph_adopt: graphAdopt
  });
}

export function deleteKnowledgeMaterial(projectID: string, materialID: string, confirmationTitle: string): Promise<unknown> {
  return del<unknown>(projectKnowledgePath(projectID, `/materials/${encodeURIComponent(materialID)}`), {
    document_id: materialID,
    confirm_title: confirmationTitle
  });
}

export function exportKnowledge(projectID: string, format = "jsonld"): Promise<unknown> {
  const params = new URLSearchParams({ format });
  return get<unknown>(projectKnowledgePath(projectID, `/export?${params.toString()}`));
}
