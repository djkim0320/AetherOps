export const KNOWLEDGE_MAX_NODES = 500;
export const KNOWLEDGE_MAX_EDGES = 1_000;
export const KNOWLEDGE_MAX_SEARCH_RESULTS = 50;
export const KNOWLEDGE_MAX_SPARQL_ROWS = 500;
export const KNOWLEDGE_MAX_IMPORT_BYTES = 16 * 1024 * 1024;

export type KnowledgeMode = "instance" | "ontology";

export type KnowledgeValue = unknown;
export type KnowledgeRecord = Record<string, KnowledgeValue>;

export type KnowledgeNode = {
  id: string;
  label: string;
  kind: string;
  types: string[];
  assertionIDs: string[];
  evidenceIDs: string[];
  confidence?: number;
  conflict: boolean;
  pinned: boolean;
  raw: KnowledgeRecord;
};

export type KnowledgeEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  predicate: string;
  assertionID?: string;
  evidenceIDs: string[];
  conflict: boolean;
  status?: string;
  validFrom?: string;
  validTo?: string;
  raw: KnowledgeRecord;
};

export type KnowledgeGraph = {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
};

export type KnowledgeSearchResult = {
  id: string;
  label: string;
  kind: string;
  description?: string;
  score?: number;
  raw: KnowledgeRecord;
};

export type KnowledgeStatus = KnowledgeRecord & {
  ready?: boolean;
  state?: string;
  active_ontology_version_id?: string;
  activeOntologyVersionID?: string;
  ontology_versions?: KnowledgeRecord[];
  ontologyVersions?: KnowledgeRecord[];
  entity_count?: number;
  assertion_count?: number;
  evidence_count?: number;
  conflict_count?: number;
};

export type KnowledgeEntity = KnowledgeRecord & {
  id?: string;
  entity_id?: string;
  label?: string;
  assertion_ids?: string[];
  assertions?: KnowledgeAssertion[];
  assertion_count?: number;
  assertions_truncated?: boolean;
  evidence_ids?: string[];
  conflicts?: unknown[];
  pinned?: boolean;
  inferred_types?: unknown[];
};

export type KnowledgeAssertion = KnowledgeRecord & {
  id?: string;
  assertion_id?: string;
  subject_entity_id?: string;
  predicate_key?: string;
  predicate?: string;
  object_entity_id?: string;
  literal?: unknown;
  object_literal?: unknown;
  qualifiers?: unknown;
  polarity?: string;
  valid_from?: string;
  valid_to?: string;
  status?: string;
  confidence?: number;
  evidence_ids?: string[];
  evidence?: unknown[];
  proof?: unknown;
  proof_steps?: unknown[];
  proofs?: unknown[];
  conflicts?: unknown[];
};

export type KnowledgeEvidence = KnowledgeRecord & {
  id?: string;
  evidence_id?: string;
  assertion_id?: string;
  kind?: string;
  blob_hash?: string;
  chunk_id?: string;
  claim_id?: string;
  source_id?: string;
  start_byte?: number;
  end_byte?: number;
  locator?: unknown;
  evidence_sha256?: string;
  title?: string;
  source_url?: string;
  excerpt?: string;
};

export type KnowledgeImportRequest = {
  name: string;
  format: string;
  content_base64: string;
};

export type KnowledgeImportResponse = KnowledgeRecord & {
  version_id?: string;
  ontology_version_id?: string;
};

export type KnowledgeMaterial = KnowledgeRecord & {
  id?: string;
  material_id?: string;
  title?: string;
  media_type?: string;
  graph_adopt?: boolean;
  size?: number;
  created_at?: string;
};

export type KnowledgeSubgraphOptions = {
  mode: KnowledgeMode;
  ontologyID?: string;
  query?: string;
  entityID?: string;
  maxNodes?: number;
  maxEdges?: number;
};

export type KnowledgeGraphFilters = {
  query: string;
  type: string;
  predicate: string;
  validAt: string;
  conflict: "all" | "only" | "exclude";
};

export type KnowledgeEditKind =
  | "add_entity"
  | "add_alias"
  | "add_assertion"
  | "update_assertion"
  | "merge_entities"
  | "split_entity"
  | "retract_assertion"
  | "restore_assertion"
  | "resolve_conflict"
  | "dismiss_conflict"
  | "pin_entity";

export type KnowledgeEvidenceBackedEdit = KnowledgeRecord & {
  kind: KnowledgeEditKind;
  evidence_ids: string[];
  memo?: string;
};

export type KnowledgeSplitEntityDraft = {
  id: string;
  class_key: string;
  canonical_name: string;
  evidence_ids?: string[];
};

export type KnowledgeSplitAssignmentDraft = {
  assertion_id: string;
  side: "subject" | "object";
  entity_id: string;
};

export type KnowledgeTypedLiteralDraft = {
  lexical_form: string;
  datatype: string;
  language: string;
  unit: string;
  si_value: string;
  si_unit: string;
};

export type KnowledgeQualifierDraft = {
  id: string;
  predicate: string;
  value_kind: "entity" | "literal";
  entity_id: string;
  literal: KnowledgeTypedLiteralDraft;
};
