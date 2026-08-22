import cytoscape, { type Core } from "cytoscape";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { formatApiError } from "./api";
import {
  activateKnowledgeOntology,
  deleteKnowledgeMaterial,
  executeKnowledgeSparql,
  exportKnowledge,
  fetchKnowledgeAssertion,
  fetchKnowledgeEntity,
  fetchKnowledgeEvidence,
  fetchKnowledgeMaterials,
  fetchKnowledgeStatus,
  fetchKnowledgeSubgraph,
  importKnowledgeOntology,
  pinKnowledgeMaterial,
  rebuildKnowledge,
  searchKnowledge,
  setKnowledgeMaterialGraphAdopt,
  submitKnowledgeEdit
} from "./knowledge-api";
import {
  adaptKnowledgeSubgraph,
  filterKnowledgeGraph,
  graphFilterOptions,
  knowledgeGraphElements
} from "./knowledge-graph";
import type {
  KnowledgeAssertion,
  KnowledgeEditKind,
  KnowledgeEntity,
  KnowledgeEvidence,
  KnowledgeEvidenceBackedEdit,
  KnowledgeGraph,
  KnowledgeMaterial,
  KnowledgeMode,
  KnowledgeRecord,
  KnowledgeQualifierDraft,
  KnowledgeSearchResult,
  KnowledgeSplitAssignmentDraft,
  KnowledgeSplitEntityDraft,
  KnowledgeStatus,
  KnowledgeTypedLiteralDraft
} from "./knowledge-types";
import {
  KNOWLEDGE_MAX_EDGES,
  KNOWLEDGE_MAX_IMPORT_BYTES,
  KNOWLEDGE_MAX_NODES,
  KNOWLEDGE_MAX_SPARQL_ROWS
} from "./knowledge-types";

import { KnowledgeCurationStudio } from "./knowledge/KnowledgeCurationStudio";
import { KnowledgeGraphPanel } from "./knowledge/KnowledgeGraphPanel";
import { KnowledgeInspector } from "./knowledge/KnowledgeInspector";
import { KnowledgeMaterialsPanel } from "./knowledge/KnowledgeMaterialsPanel";
import { KnowledgeOntologyStudio } from "./knowledge/KnowledgeOntologyStudio";
import { KnowledgeSparqlConsole } from "./knowledge/KnowledgeSparqlConsole";
import { KnowledgeToolbar, type KnowledgeTab } from "./knowledge/KnowledgeToolbar";

export type KnowledgeViewProps = {
  projectID: string;
  projectName?: string;
  connected: boolean;
};

const emptyGraph: KnowledgeGraph = {
  nodes: [],
  edges: [],
  totalNodes: 0,
  totalEdges: 0,
  truncated: false
};

const defaultSparql = `SELECT ?subject ?predicate ?object
WHERE {
  ?subject ?predicate ?object
}
LIMIT 100`;

const defaultOntologyDraft = `@prefix project: <urn:aetherops:project:> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .

project:Concept a rdfs:Class ;
  rdfs:label "Concept"@en .

project:relatedTo a owl:ObjectProperty ;
  rdfs:label "related to"@en ;
  rdfs:domain project:Concept ;
  rdfs:range project:Concept .`;

function isRecord(value: unknown): value is KnowledgeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pretty(value: unknown): string {
  if (value === undefined) return "정보 없음";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function arrayValue(record: KnowledgeRecord | null, ...keys: string[]): unknown[] {
  if (!record) return [];
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function referenceIDs(
  record: KnowledgeRecord | null,
  pluralKey: string,
  embeddedKey: string
): string[] {
  const values = [...arrayValue(record, pluralKey), ...arrayValue(record, embeddedKey)];
  return [
    ...new Set(
      values.flatMap((value) => {
        if (typeof value === "string" && value.trim()) return [value.trim()];
        if (!isRecord(value)) return [];
        const id =
          text(value.id) ??
          text(value.entity_id) ??
          text(value.assertion_id) ??
          text(value.evidence_id);
        return id ? [id] : [];
      })
    )
  ];
}

function ontologyVersions(status: KnowledgeStatus | null): KnowledgeRecord[] {
  if (!status) return [];
  const values = status.ontology_versions ?? status.ontologyVersions;
  return Array.isArray(values) ? values.filter(isRecord) : [];
}

function importFormat(file: File): string {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "ttl") return "text/turtle";
  if (extension === "rdf" || extension === "owl") return "application/rdf+xml";
  if (extension === "jsonld") return "application/ld+json";
  return file.type || "application/octet-stream";
}

function bytesBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    parts.push(
      String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)))
    );
  }
  return window.btoa(parts.join(""));
}

async function fileBase64(file: File): Promise<string> {
  return bytesBase64(new Uint8Array(await file.arrayBuffer()));
}

function utf8Base64(value: string): string {
  return bytesBase64(new TextEncoder().encode(value));
}

function downloadExport(payload: unknown, projectName: string) {
  const source =
    isRecord(payload) &&
    (typeof payload.content === "string" || typeof payload.data === "string")
      ? String(payload.content ?? payload.data)
      : typeof payload === "string"
      ? payload
      : JSON.stringify(payload, null, 2);
  const filename =
    isRecord(payload) && text(payload.filename)
      ? text(payload.filename)!
      : `${projectName || "aetherops"}-knowledge.jsonld`;
  const blob = new Blob([source], { type: "application/ld+json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replace(/[\\/\0-\x1f<>:"|?*]/g, "-");
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function uniqueHandles(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function curationID(prefix: string): string {
  const uuid =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replaceAll("-", "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${uuid}`;
}

function emptyTypedLiteral(): KnowledgeTypedLiteralDraft {
  return {
    lexical_form: "",
    datatype: "xsd:string",
    language: "",
    unit: "",
    si_value: "",
    si_unit: ""
  };
}

function typedLiteralFromValue(value: unknown): KnowledgeTypedLiteralDraft {
  const source = isRecord(value) ? value : {};
  return {
    lexical_form: text(source.lexical_form) ?? "",
    datatype: text(source.datatype) ?? "xsd:string",
    language: text(source.language) ?? "",
    unit: text(source.unit) ?? "",
    si_value: text(source.si_value) ?? "",
    si_unit: text(source.si_unit) ?? ""
  };
}

function rfc3339FromLocal(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    throw new Error("유효 시점은 올바른 날짜와 시간이어야 합니다.");
  return parsed.toISOString();
}

function localDateTimeFromRFC3339(value: unknown): string {
  const source = text(value);
  if (!source) return "";
  const parsed = new Date(source);
  if (!Number.isFinite(parsed.getTime())) return "";
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

export function KnowledgeView({ projectID, projectName = "", connected }: KnowledgeViewProps) {
  const [activeTab, setActiveTab] = useState<KnowledgeTab>("explorer");
  const [mode, setMode] = useState<KnowledgeMode>("instance");
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [graph, setGraph] = useState<KnowledgeGraph>(emptyGraph);
  const [searchQuery, setSearchQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [focusEntityID, setFocusEntityID] = useState("");
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([]);
  const [filterQuery, setFilterQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [predicateFilter, setPredicateFilter] = useState("all");
  const [validAtFilter, setValidAtFilter] = useState("");
  const [conflictFilter, setConflictFilter] = useState<"all" | "only" | "exclude">("all");
  const [selectedEntityID, setSelectedEntityID] = useState("");
  const [selectedEntityIDs, setSelectedEntityIDs] = useState<string[]>([]);
  const [selectedEdgeID, setSelectedEdgeID] = useState("");
  const [entity, setEntity] = useState<KnowledgeEntity | null>(null);
  const [assertionID, setAssertionID] = useState("");
  const [assertion, setAssertion] = useState<KnowledgeAssertion | null>(null);
  const [evidenceID, setEvidenceID] = useState("");
  const [evidence, setEvidence] = useState<KnowledgeEvidence[] | null>(null);
  const [sparql, setSparql] = useState(defaultSparql);
  const [sparqlResult, setSparqlResult] = useState<unknown>(null);
  const [editKind, setEditKind] = useState<KnowledgeEditKind>("add_assertion");
  const [editEvidenceText, setEditEvidenceText] = useState("");
  const [editMemo, setEditMemo] = useState("");
  const [newEntityID, setNewEntityID] = useState(() => curationID("kent"));
  const [newEntityClass, setNewEntityClass] = useState("Entity");
  const [newEntityName, setNewEntityName] = useState("");
  const [newEntityDescription, setNewEntityDescription] = useState("");
  const [aliasValue, setAliasValue] = useState("");
  const [aliasLanguage, setAliasLanguage] = useState("");
  const [conflictID, setConflictID] = useState("");
  const [relationAssertionID, setRelationAssertionID] = useState(() => curationID("ka"));
  const [relationSubjectID, setRelationSubjectID] = useState("");
  const [relationPredicate, setRelationPredicate] = useState("");
  const [relationObjectKind, setRelationObjectKind] = useState<"entity" | "literal">("entity");
  const [relationTargetID, setRelationTargetID] = useState("");
  const [relationLiteral, setRelationLiteral] = useState<KnowledgeTypedLiteralDraft>(() =>
    emptyTypedLiteral()
  );
  const [relationQualifiers, setRelationQualifiers] = useState<KnowledgeQualifierDraft[]>([]);
  const [relationValidFrom, setRelationValidFrom] = useState("");
  const [relationValidTo, setRelationValidTo] = useState("");
  const [relationPolarity, setRelationPolarity] = useState<"affirmed" | "negated">("affirmed");
  const [relationStatus, setRelationStatus] = useState<
    "accepted" | "disputed" | "superseded" | "retracted"
  >("accepted");
  const [relationConfidence, setRelationConfidence] = useState("1");
  const [mergeSurvivorID, setMergeSurvivorID] = useState("");
  const [editAssertionID, setEditAssertionID] = useState("");
  const [pinValue, setPinValue] = useState(true);
  const [splitEntities, setSplitEntities] = useState<KnowledgeSplitEntityDraft[]>([
    { id: curationID("kent"), class_key: "Entity", canonical_name: "" },
    { id: curationID("kent"), class_key: "Entity", canonical_name: "" }
  ]);
  const [splitAssignments, setSplitAssignments] = useState<
    Record<string, KnowledgeSplitAssignmentDraft>
  >({});
  const [ontologyFile, setOntologyFile] = useState<File | null>(null);
  const [versionID, setVersionID] = useState("");
  const [ontologyPreview, setOntologyPreview] = useState<KnowledgeRecord | null>(null);
  const [schemaDraftName, setSchemaDraftName] = useState("project-schema.ttl");
  const [schemaDraft, setSchemaDraft] = useState(defaultOntologyDraft);
  const [materials, setMaterials] = useState<KnowledgeMaterial[] | null>(null);
  const [materialFile, setMaterialFile] = useState<File | null>(null);
  const [materialTitle, setMaterialTitle] = useState("");
  const [materialGraphAdopt, setMaterialGraphAdopt] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const graphElement = useRef<HTMLDivElement>(null);
  const graphInstance = useRef<Core | null>(null);
  const selectionCallback = useRef<(ids: string[], primary?: string) => void>(() => undefined);
  const syncingCanvasSelection = useRef(false);
  const selectedEntityIDsRef = useRef<string[]>([]);
  const refreshSequence = useRef(0);

  const filteredGraph = useMemo(
    () =>
      filterKnowledgeGraph(graph, {
        query: filterQuery,
        type: typeFilter,
        predicate: predicateFilter,
        validAt: validAtFilter,
        conflict: conflictFilter
      }),
    [conflictFilter, filterQuery, graph, predicateFilter, typeFilter, validAtFilter]
  );

  const filterOptions = useMemo(() => graphFilterOptions(graph), [graph]);

  const selectedNode = useMemo(
    () => graph.nodes.find((node) => node.id === selectedEntityID) ?? null,
    [graph.nodes, selectedEntityID]
  );

  const selectedNodes = useMemo(
    () =>
      selectedEntityIDs.flatMap((id) => {
        const node = graph.nodes.find((candidate) => candidate.id === id);
        return node ? [node] : [];
      }),
    [graph.nodes, selectedEntityIDs]
  );

  const selectedEdge = useMemo(
    () => graph.edges.find((edge) => edge.id === selectedEdgeID) ?? null,
    [graph.edges, selectedEdgeID]
  );

  const embeddedAssertions = useMemo(
    () => arrayValue(entity, "assertions", "assertion_views").filter(isRecord),
    [entity]
  );

  const assertionIDs = useMemo(
    () => [
      ...new Set([
        ...(selectedNode?.assertionIDs ?? []),
        ...referenceIDs(entity, "assertion_ids", "assertions")
      ])
    ],
    [entity, selectedNode]
  );

  const evidenceIDs = useMemo(
    () => [
      ...new Set([
        ...(selectedNode?.evidenceIDs ?? []),
        ...referenceIDs(entity, "evidence_ids", "evidence"),
        ...referenceIDs(assertion, "evidence_ids", "evidence")
      ])
    ],
    [assertion, entity, selectedNode]
  );

  const proof = useMemo(
    () => [
      ...arrayValue(assertion, "proofs", "proof_steps"),
      ...arrayValue(entity, "inferred_types", "type_inferences")
    ],
    [assertion, entity]
  );

  const conflicts = useMemo(() => {
    const values = [
      ...arrayValue(entity, "conflicts", "conflict_set"),
      ...embeddedAssertions.flatMap((item) => arrayValue(item, "conflicts", "conflict_set")),
      ...arrayValue(assertion, "conflicts", "conflict_set"),
      ...arrayValue(selectedNode?.raw ?? null, "conflicts", "conflict_set")
    ];
    const seen = new Set<string>();
    return values.filter((value) => {
      const key = isRecord(value)
        ? text(value.id) ?? text(value.conflict_id) ?? pretty(value)
        : pretty(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [assertion, embeddedAssertions, entity, selectedNode]);

  const entityAssertionsMayBeTruncated = useMemo(() => {
    if (!entity) return false;
    if (entity.assertions_truncated === true) return true;
    const declaredCount = number(entity.assertion_count);
    return declaredCount !== undefined && declaredCount > embeddedAssertions.length;
  }, [embeddedAssertions.length, entity]);

  const conflictIDs = [
    ...new Set(
      conflicts.flatMap((value) => {
        if (typeof value === "string" && value.trim()) return [value.trim()];
        if (!isRecord(value)) return [];
        const id = text(value.id) ?? text(value.conflict_id);
        return id ? [id] : [];
      })
    )
  ];

  const editEvidenceIDs = useMemo(() => uniqueHandles(editEvidenceText), [editEvidenceText]);
  const currentAssertionID =
    editAssertionID || text(assertion?.id) || text(assertion?.assertion_id) || assertionID;

  const selectedOntologyVersion = useMemo(
    () =>
      ontologyVersions(status).find(
        (version) => (text(version.id) ?? text(version.version_id)) === versionID
      ) ?? null,
    [status, versionID]
  );

  const canActivateOntology = Boolean(
    versionID &&
      selectedOntologyVersion &&
      text(selectedOntologyVersion.project_id) === projectID &&
      text(selectedOntologyVersion.state) === "draft"
  );

  const applyEntitySelection = useCallback((ids: string[], primary?: string) => {
    const normalized = [...new Set(ids.filter(Boolean))];
    selectedEntityIDsRef.current = normalized;
    setSelectedEntityIDs(normalized);
    setSelectedEntityID(primary && normalized.includes(primary) ? primary : normalized[0] ?? "");
    setAssertion(null);
    setEvidence(null);
    setError("");
  }, []);

  const selectEntity = useCallback(
    (id: string, additive = false) => {
      setSelectedEdgeID("");
      const current = selectedEntityIDsRef.current;
      if (!additive) {
        applyEntitySelection([id], id);
        return;
      }
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      applyEntitySelection(next, current.includes(id) ? undefined : id);
    },
    [applyEntitySelection]
  );

  const focusSelectedEntity = useCallback(
    (id: string) => {
      setSelectedEdgeID("");
      const current = selectedEntityIDsRef.current;
      applyEntitySelection(current.includes(id) ? current : [id], id);
    },
    [applyEntitySelection]
  );

  selectionCallback.current = applyEntitySelection;
  selectedEntityIDsRef.current = selectedEntityIDs;

  const refresh = useCallback(async () => {
    if (!projectID || !connected) return;
    const sequence = ++refreshSequence.current;
    setBusy("refresh");
    setError("");
    const [statusResult, graphResult, materialsResult] = await Promise.allSettled([
      fetchKnowledgeStatus(projectID),
      fetchKnowledgeSubgraph(projectID, {
        mode,
        ontologyID: mode === "ontology" ? versionID : undefined,
        query: appliedQuery,
        entityID: focusEntityID,
        maxNodes: KNOWLEDGE_MAX_NODES,
        maxEdges: KNOWLEDGE_MAX_EDGES
      }),
      fetchKnowledgeMaterials(projectID)
    ]);
    if (sequence !== refreshSequence.current) return;
    if (statusResult.status === "fulfilled") setStatus(statusResult.value);
    if (graphResult.status === "fulfilled")
      setGraph(adaptKnowledgeSubgraph(graphResult.value, mode));
    if (materialsResult.status === "fulfilled") setMaterials(materialsResult.value);
    const failures = [statusResult, graphResult, materialsResult].flatMap((result) =>
      result.status === "rejected" ? [formatApiError(result.reason)] : []
    );
    if (failures.length) setError(failures.join(" · "));
    setBusy("");
  }, [appliedQuery, connected, focusEntityID, mode, projectID, versionID]);

  useEffect(() => {
    refreshSequence.current += 1;
    setStatus(null);
    setGraph(emptyGraph);
    setSelectedEntityID("");
    setSelectedEntityIDs([]);
    setSelectedEdgeID("");
    selectedEntityIDsRef.current = [];
    setEntity(null);
    setAssertion(null);
    setEvidence(null);
    setMaterials(null);
    setSearchResults([]);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedEntityID) return;
    if (editKind === "add_assertion") setRelationSubjectID(selectedEntityID);
    setMergeSurvivorID((current) =>
      selectedEntityIDs.includes(current) ? current : selectedEntityID
    );
    setRelationTargetID((current) =>
      current && current !== selectedEntityID
        ? current
        : selectedEntityIDs.find((id) => id !== selectedEntityID) ?? ""
    );
    setPinValue((entity?.pinned ?? selectedNode?.pinned) !== true);
  }, [editKind, entity?.pinned, selectedEntityID, selectedEntityIDs, selectedNode?.pinned]);

  useEffect(() => {
    if (!selectedEntityID || !projectID || !connected) {
      setEntity(null);
      return;
    }
    if (mode === "ontology") {
      setEntity((selectedNode?.raw ?? null) as KnowledgeEntity | null);
      return;
    }
    let active = true;
    setBusy("entity");
    void fetchKnowledgeEntity(projectID, selectedEntityID)
      .then((value) => {
        if (active) setEntity(value);
      })
      .catch((cause) => {
        if (active) setError(formatApiError(cause));
      })
      .finally(() => {
        if (active) setBusy("");
      });
    return () => {
      active = false;
    };
  }, [connected, mode, projectID, selectedEntityID, selectedNode?.raw]);

  // Cytoscape Canvas Lifecycle (Only when explorer tab is active)
  useEffect(() => {
    if (activeTab !== "explorer" || !graphElement.current) return;
    graphInstance.current?.destroy();
    const instance = cytoscape({
      container: graphElement.current,
      elements: knowledgeGraphElements(filteredGraph),
      boxSelectionEnabled: true,
      selectionType: "additive",
      minZoom: 0.18,
      maxZoom: 2.5,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#4c9be8",
            "border-color": "#9fcfff",
            "border-width": 1,
            color: "#eaf5ff",
            label: "data(label)",
            "font-size": 11,
            "text-wrap": "ellipsis",
            "text-max-width": "120px",
            "text-valign": "bottom",
            "text-margin-y": 8,
            width: 30,
            height: 30
          }
        },
        {
          selector: 'node[kind = "ontology"]',
          style: { "background-color": "#8b6fe8", shape: "round-rectangle" }
        },
        {
          selector: 'node[conflict = "true"]',
          style: {
            "background-color": "#d25c69",
            "border-color": "#ffc1c7",
            "border-width": 3
          }
        },
        {
          selector: 'node[pinned = "true"]',
          style: { "border-color": "#ffd36f", "border-width": 3 }
        },
        {
          selector: "node:selected",
          style: {
            "background-color": "#65d7a7",
            "border-color": "#e7fff9",
            "border-width": 4
          }
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#506986",
            "target-arrow-color": "#6b86a7",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            color: "#9caec4",
            "font-size": 9,
            "text-background-color": "#171816",
            "text-background-opacity": 0.88,
            "text-background-padding": "3px"
          }
        },
        {
          selector: 'edge[conflict = "true"]',
          style: {
            "line-color": "#d96b77",
            "target-arrow-color": "#d96b77",
            "line-style": "dashed"
          }
        }
      ]
    });

    instance.on("select unselect", "node", (event) => {
      if (syncingCanvasSelection.current) return;
      setSelectedEdgeID("");
      const ids = instance.nodes(":selected").map((node) => node.id());
      selectionCallback.current(ids, event.type === "select" ? event.target.id() : undefined);
    });

    instance.on("tap", "edge", (event) => {
      const edgeID = event.target.id();
      const edge = filteredGraph.edges.find((candidate) => candidate.id === edgeID);
      if (!edge) return;
      setSelectedEdgeID(edgeID);
      selectionCallback.current([edge.source], edge.source);
      if (edge.assertionID) void loadAssertion(edge.assertionID);
    });

    instance
      .layout(
        mode === "ontology"
          ? {
              name: "breadthfirst",
              directed: true,
              padding: 28,
              spacingFactor: 1.35,
              animate: false
            }
          : {
              name: "cose",
              padding: 28,
              nodeRepulsion: 7500,
              idealEdgeLength: 90,
              animate: false,
              randomize: true
            }
      )
      .run();

    syncingCanvasSelection.current = true;
    for (const id of selectedEntityIDsRef.current) instance.getElementById(id).select();
    syncingCanvasSelection.current = false;
    graphInstance.current = instance;

    return () => {
      instance.destroy();
      if (graphInstance.current === instance) graphInstance.current = null;
    };
  }, [activeTab, filteredGraph, mode]);

  useEffect(() => {
    const instance = graphInstance.current;
    if (!instance) return;
    syncingCanvasSelection.current = true;
    instance.nodes().unselect();
    for (const id of selectedEntityIDs) instance.getElementById(id).select();
    syncingCanvasSelection.current = false;
  }, [selectedEntityIDs]);

  async function submitSearch(event: Event) {
    event.preventDefault();
    if (!projectID || !searchQuery.trim()) return;
    setBusy("search");
    setError("");
    try {
      if (mode === "ontology") {
        setSearchResults([]);
        setAppliedQuery(searchQuery.trim());
        setFocusEntityID("");
        setNotice("선택한 온톨로지 draft의 term·axiom 검색 범위를 갱신합니다.");
        return;
      }
      const results = await searchKnowledge(projectID, searchQuery);
      setSearchResults(results);
      setAppliedQuery(searchQuery.trim());
      setFocusEntityID("");
      setNotice(`${results.length}개의 검색 결과를 불러왔습니다.`);
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy("");
    }
  }

  function focusSearchResult(result: KnowledgeSearchResult) {
    setFocusEntityID(result.id);
    setAppliedQuery(searchQuery.trim());
    selectEntity(result.id);
    setActiveTab("explorer");
  }

  function selectGraphEdge(edgeID: string) {
    const edge = graph.edges.find((candidate) => candidate.id === edgeID);
    if (!edge) return;
    setSelectedEdgeID(edge.id);
    applyEntitySelection([edge.source], edge.source);
    if (edge.assertionID) {
      setEditAssertionID(edge.assertionID);
      void loadAssertion(edge.assertionID);
    }
  }

  async function loadAssertion(id = assertionID) {
    if (!projectID || !id.trim()) return;
    setBusy("assertion");
    setError("");
    try {
      const value = await fetchKnowledgeAssertion(projectID, id.trim());
      setAssertion(value);
      setAssertionID(id.trim());
      setEditAssertionID(id.trim());
      if (editKind === "update_assertion") populateAssertionEdit(value);
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy("");
    }
  }

  async function loadEvidence(id = evidenceID) {
    if (!projectID || !id.trim()) return;
    setBusy("evidence");
    setError("");
    try {
      const value = await fetchKnowledgeEvidence(projectID, id.trim());
      setEvidence(value);
      setEvidenceID(id.trim());
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy("");
    }
  }

  async function runSparql(event: Event) {
    event.preventDefault();
    if (!sparql.trim()) return;
    setBusy("sparql");
    setError("");
    setNotice("");
    setSparqlResult(null);
    try {
      setSparqlResult(await executeKnowledgeSparql(projectID, sparql, KNOWLEDGE_MAX_SPARQL_ROWS));
      setNotice("읽기 전용 SPARQL 질의가 완료되었습니다.");
    } catch (cause) {
      setSparqlResult(null);
      setError(formatApiError(cause));
    } finally {
      setBusy("");
    }
  }

  async function submitEdit(event: Event) {
    event.preventDefault();
    setBusy("edit");
    setError("");
    let recorded = false;
    try {
      const patch = buildEditPatch();
      await submitKnowledgeEdit(projectID, patch);
      recorded = true;
      await rebuildKnowledge(projectID);
      setNotice("편집 제안을 기록하고 검증된 shadow graph를 활성화했습니다.");
      await refresh();
      setActiveTab("explorer");
    } catch (cause) {
      if (recorded) {
        setNotice(
          "편집 제안은 append-only 원장에 이미 기록되었습니다. 같은 제안을 다시 제출하지 마세요."
        );
        setError(
          `shadow graph 재구성에 실패했습니다. 상단의 재구성 버튼으로 다시 시도하세요. ${formatApiError(
            cause
          )}`
        );
        await refresh();
      } else {
        setError(formatApiError(cause));
      }
    } finally {
      setBusy("");
    }
  }

  async function importOntology(event: Event) {
    event.preventDefault();
    if (!ontologyFile) return;
    if (ontologyFile.size > KNOWLEDGE_MAX_IMPORT_BYTES) {
      setError(
        `온톨로지 파일은 최대 ${Math.round(
          KNOWLEDGE_MAX_IMPORT_BYTES / 1024 / 1024
        )} MiB까지 가져올 수 있습니다.`
      );
      return;
    }
    setBusy("import");
    setError("");
    try {
      const format = importFormat(ontologyFile);
      if (!["text/turtle", "application/rdf+xml", "application/ld+json"].includes(format)) {
        throw new Error("온톨로지는 .ttl, .jsonld, .rdf, .owl 형식만 지원합니다.");
      }
      const response = await importKnowledgeOntology(projectID, {
        name: ontologyFile.name,
        format,
        content_base64: await fileBase64(ontologyFile)
      });
      setOntologyPreview(response);
      const importedVersion = text(response.version_id) ?? text(response.ontology_version_id);
      if (importedVersion) setVersionID(importedVersion);
      setNotice(
        importedVersion
          ? `온톨로지 ${importedVersion}을(를) 가져왔습니다.`
          : "온톨로지를 가져왔습니다."
      );
      setOntologyFile(null);
      await refresh();
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy("");
    }
  }

  async function importSchemaDraft(event: Event) {
    event.preventDefault();
    const source = schemaDraft.trim();
    if (!source) {
      setError("프로젝트 스키마 Turtle 원문을 입력하세요.");
      return;
    }
    const encoded = new TextEncoder().encode(source);
    if (encoded.byteLength > KNOWLEDGE_MAX_IMPORT_BYTES) {
      setError(
        `프로젝트 스키마는 최대 ${Math.round(
          KNOWLEDGE_MAX_IMPORT_BYTES / 1024 / 1024
        )} MiB까지 가능합니다.`
      );
      return;
    }
    setBusy("schema-import");
    setError("");
    try {
      const response = await importKnowledgeOntology(projectID, {
        name: schemaDraftName.trim() || "project-schema.ttl",
        format: "text/turtle",
        content_base64: utf8Base64(source)
      });
      setOntologyPreview(response);
      const importedVersion = text(response.version_id) ?? text(response.ontology_version_id);
      if (importedVersion) setVersionID(importedVersion);
      setNotice(
        "프로젝트 스키마를 검증해 비활성 draft 버전으로 저장했습니다. 미리보기를 확인한 뒤 명시적으로 활성화하세요."
      );
      await refresh();
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy("");
    }
  }

  async function activateOntology(id = versionID) {
    if (!id.trim()) return;
    setBusy("activate");
    setError("");
    try {
      await activateKnowledgeOntology(projectID, id.trim());
      setNotice(`온톨로지 ${id.trim()}을(를) 활성화했습니다.`);
      setVersionID(id.trim());
      await refresh();
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy("");
    }
  }

  async function rebuild() {
    setBusy("rebuild");
    setError("");
    try {
      await rebuildKnowledge(projectID);
      setNotice("지식 그래프 재구성을 요청했습니다.");
      await refresh();
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy("");
    }
  }

  async function exportGraph() {
    setBusy("export");
    setError("");
    try {
      downloadExport(await exportKnowledge(projectID, "jsonld"), projectName);
      setNotice("JSON-LD 내보내기를 준비했습니다.");
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy("");
    }
  }

  async function uploadMaterial(event: Event) {
    event.preventDefault();
    if (!materialFile) return;
    if (materialFile.size === 0 || materialFile.size > KNOWLEDGE_MAX_IMPORT_BYTES) {
      setError(
        `자료 파일은 1 byte 이상 ${Math.round(
          KNOWLEDGE_MAX_IMPORT_BYTES / 1024 / 1024
        )} MiB 이하여야 합니다.`
      );
      return;
    }
    setBusy("material-upload");
    setError("");
    try {
      await pinKnowledgeMaterial(projectID, {
        title: materialTitle.trim() || materialFile.name,
        filename: materialFile.name,
        media_type: materialFile.type || "application/octet-stream",
        content_base64: await fileBase64(materialFile),
        graph_adopt: materialGraphAdopt
      });
      setMaterialFile(null);
      setMaterialTitle("");
      setNotice("프로젝트 자료를 고정했습니다.");
      await refresh();
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy("");
    }
  }

  async function toggleMaterialAdopt(material: KnowledgeMaterial) {
    const id = text(material.id) ?? text(material.material_id);
    if (!id) return;
    setBusy(`material-adopt-${id}`);
    setError("");
    try {
      await setKnowledgeMaterialGraphAdopt(projectID, id, material.graph_adopt !== true);
      setNotice(
        material.graph_adopt
          ? "그래프 채택을 해제했습니다."
          : "그래프 채택 대상으로 표시했습니다."
      );
      await refresh();
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy("");
    }
  }

  async function removeMaterial(material: KnowledgeMaterial) {
    const id = text(material.id) ?? text(material.material_id);
    if (!id) return;
    const title = material.title || id;
    const confirmation = window.prompt(
      `자료를 기억에서 제거하려면 정확한 제목을 입력하세요:\n${title}`
    );
    if (confirmation === null) return;
    if (confirmation !== title) {
      setError("제목이 일치하지 않아 자료를 제거하지 않았습니다.");
      return;
    }
    setBusy(`material-delete-${id}`);
    setError("");
    try {
      const result = (await deleteKnowledgeMaterial(
        projectID,
        id,
        confirmation
      )) as KnowledgeRecord;
      setNotice(
        result.retained_for_graph_provenance === true
          ? "RAG 기억에서 제거했습니다. 기존 그래프의 근거 보존본은 재구축 전까지 유지됩니다."
          : "자료와 참조되지 않는 저장 객체를 제거했습니다."
      );
      await refresh();
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy("");
    }
  }

  function changeMode(next: KnowledgeMode) {
    setMode(next);
    setFocusEntityID("");
    setSearchResults([]);
    setSelectedEdgeID("");
    applyEntitySelection([]);
    setTypeFilter("all");
    setPredicateFilter("all");
    setValidAtFilter("");
    setConflictFilter("all");
  }

  function addEditEvidenceHandle(id: string) {
    const normalized = id.trim();
    if (!normalized) return;
    setEditEvidenceText((current) =>
      [...new Set([...uniqueHandles(current), normalized])].join("\n")
    );
    setNotice(`근거 handle "${normalized}"이(가) 편집 입력에 추가되었습니다.`);
  }

  function chooseEditKind(kind: KnowledgeEditKind) {
    setEditKind(kind);
    setActiveTab("curation");
    setError("");
    if ((kind === "retract_assertion" || kind === "restore_assertion") && assertion) {
      setEditAssertionID(text(assertion.id) ?? text(assertion.assertion_id) ?? "");
    }
    if ((kind === "resolve_conflict" || kind === "dismiss_conflict") && !conflictID) {
      setConflictID(conflictIDs[0] ?? "");
    }
    if (kind === "add_entity") setNewEntityID(curationID("kent"));
    if (kind === "add_assertion") {
      setRelationAssertionID(curationID("ka"));
      setRelationSubjectID(selectedEntityID);
      setRelationPolarity("affirmed");
      setRelationStatus("accepted");
      setRelationConfidence("1");
    }
    if (kind === "update_assertion") {
      if (assertion) populateAssertionEdit(assertion);
      else setError("Inspector에서 기존 assertion을 조회한 뒤 편집을 선택하세요.");
    }
  }

  function populateAssertionEdit(value: KnowledgeAssertion) {
    const assertionHandle = text(value.id) ?? text(value.assertion_id) ?? "";
    setRelationAssertionID(assertionHandle);
    setEditAssertionID(assertionHandle);
    setRelationSubjectID(text(value.subject_entity_id) ?? "");
    setRelationPredicate(text(value.predicate_key) ?? text(value.predicate) ?? "");
    const objectEntityID = text(value.object_entity_id) ?? "";
    if (objectEntityID) {
      setRelationObjectKind("entity");
      setRelationTargetID(objectEntityID);
      setRelationLiteral(emptyTypedLiteral());
    } else {
      setRelationObjectKind("literal");
      setRelationTargetID("");
      setRelationLiteral(typedLiteralFromValue(value.literal ?? value.object_literal));
    }
    const qualifierEntries: [string, unknown][] = Array.isArray(value.qualifiers)
      ? value.qualifiers.flatMap((item) =>
          isRecord(item) && text(item.predicate)
            ? ([[text(item.predicate)!, item] as [string, unknown]])
            : []
        )
      : isRecord(value.qualifiers)
      ? Object.entries(value.qualifiers)
      : [];
    setRelationQualifiers(
      qualifierEntries.map(([pred, rawValue]) => {
        const qualifier = isRecord(rawValue) ? rawValue : {};
        const literal = qualifier.literal;
        return {
          id: curationID("kqual"),
          predicate: pred,
          value_kind:
            literal === undefined || literal === null
              ? ("entity" as const)
              : ("literal" as const),
          entity_id: text(qualifier.entity_id) ?? "",
          literal: typedLiteralFromValue(literal)
        };
      })
    );
    setRelationValidFrom(localDateTimeFromRFC3339(value.valid_from));
    setRelationValidTo(localDateTimeFromRFC3339(value.valid_to));
    const polarity = text(value.polarity);
    setRelationPolarity(polarity === "negated" ? "negated" : "affirmed");
    const statusValue = text(value.status);
    setRelationStatus(
      statusValue === "disputed" ||
        statusValue === "superseded" ||
        statusValue === "retracted"
        ? statusValue
        : "accepted"
    );
    const confidence = number(value.confidence);
    setRelationConfidence(String(confidence === undefined ? 1 : confidence));
    setEditEvidenceText(referenceIDs(value, "evidence_ids", "evidence").join("\n"));
  }

  function updateSplitEntity(
    index: number,
    field: keyof KnowledgeSplitEntityDraft,
    value: string
  ) {
    setSplitEntities((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item
      )
    );
  }

  function addSplitEntity() {
    setSplitEntities((current) => [
      ...current,
      { id: curationID("kent"), class_key: "Entity", canonical_name: "" }
    ]);
  }

  function removeSplitEntity(index: number) {
    setSplitEntities((current) =>
      current.length <= 2 ? current : current.filter((_, itemIndex) => itemIndex !== index)
    );
  }

  function updateSplitAssignment(
    assertionIDValue: string,
    field: "side" | "entity_id",
    value: string
  ) {
    setSplitAssignments((current) => ({
      ...current,
      [assertionIDValue]: {
        assertion_id: assertionIDValue,
        side:
          field === "side"
            ? (value as "subject" | "object")
            : current[assertionIDValue]?.side ?? "subject",
        entity_id: field === "entity_id" ? value : current[assertionIDValue]?.entity_id ?? ""
      }
    }));
  }

  function updateRelationLiteral(field: keyof KnowledgeTypedLiteralDraft, value: string) {
    setRelationLiteral((current) => ({ ...current, [field]: value }));
  }

  function addRelationQualifier() {
    setRelationQualifiers((current) => [
      ...current,
      {
        id: curationID("kqual"),
        predicate: "",
        value_kind: "entity",
        entity_id: "",
        literal: emptyTypedLiteral()
      }
    ]);
  }

  function updateRelationQualifier(id: string, update: Partial<KnowledgeQualifierDraft>) {
    setRelationQualifiers((current) =>
      current.map((item) => (item.id === id ? { ...item, ...update } : item))
    );
  }

  function updateQualifierLiteral(
    id: string,
    field: keyof KnowledgeTypedLiteralDraft,
    value: string
  ) {
    setRelationQualifiers((current) =>
      current.map((item) =>
        item.id === id
          ? { ...item, literal: { ...item.literal, [field]: value } }
          : item
      )
    );
  }

  function validatedLiteral(
    draft: KnowledgeTypedLiteralDraft,
    label: string
  ): KnowledgeTypedLiteralDraft {
    const literal = Object.fromEntries(
      Object.entries(draft).map(([key, val]) => [key, val.trim()])
    ) as KnowledgeTypedLiteralDraft;
    if (!literal.lexical_form || !literal.datatype) {
      throw new Error(`${label}의 원문 값과 datatype을 입력하세요.`);
    }
    if (
      (literal.unit || literal.si_value || literal.si_unit) &&
      (!literal.unit || !literal.si_value || !literal.si_unit)
    ) {
      throw new Error(`${label}의 단위 값은 unit, SI value, SI unit을 모두 입력해야 합니다.`);
    }
    return literal;
  }

  function buildEditPatch(): KnowledgeEvidenceBackedEdit {
    const evidence_ids = editEvidenceIDs;
    const memo = editMemo.trim();
    if (evidence_ids.length === 0 && !memo) {
      throw new Error(
        "기존 evidence handle을 하나 이상 선택하거나 새 고정 메모를 작성하세요."
      );
    }
    const common = { evidence_ids, ...(memo ? { memo } : {}) };
    switch (editKind) {
      case "add_entity": {
        if (!newEntityID.trim() || !newEntityClass.trim() || !newEntityName.trim()) {
          throw new Error("새 엔터티의 ID, 유형, 이름을 모두 입력하세요.");
        }
        return {
          kind: "add_entity",
          id: newEntityID.trim(),
          class_key: newEntityClass.trim(),
          canonical_name: newEntityName.trim(),
          description: newEntityDescription.trim(),
          ...common
        };
      }
      case "add_alias": {
        if (!selectedEntityID || !aliasValue.trim()) {
          throw new Error("대상 엔터티를 선택하고 별칭을 입력하세요.");
        }
        return {
          kind: "add_alias",
          entity_id: selectedEntityID,
          alias: aliasValue.trim(),
          language: aliasLanguage.trim(),
          ...common
        };
      }
      case "add_assertion":
      case "update_assertion": {
        const updating = editKind === "update_assertion";
        const subject = relationSubjectID.trim();
        const predicate = relationPredicate.trim();
        const id = relationAssertionID.trim();
        const selectedAssertionHandle =
          text(assertion?.id) ?? text(assertion?.assertion_id) ?? "";
        if (updating && (!selectedAssertionHandle || selectedAssertionHandle !== id)) {
          throw new Error("현재 Inspector에서 선택한 assertion만 편집할 수 있습니다.");
        }
        if (!subject || !predicate || !id) {
          throw new Error("출발 엔터티와 predicate, assertion ID를 모두 지정하세요.");
        }
        const object: KnowledgeRecord = {};
        if (relationObjectKind === "entity") {
          const target = relationTargetID.trim();
          if (!target) throw new Error("도착 엔터티를 지정하세요.");
          object.object_entity_id = target;
        } else {
          object.object_literal = validatedLiteral(relationLiteral, "객체 literal");
        }
        const qualifiers: KnowledgeRecord = {};
        relationQualifiers.forEach((item, index) => {
          const predicateKey = item.predicate.trim();
          if (!predicateKey)
            throw new Error(`Qualifier ${index + 1}의 predicate를 입력하세요.`);
          if (qualifiers[predicateKey] !== undefined)
            throw new Error(`Qualifier predicate ${predicateKey}가 중복되었습니다.`);
          if (item.value_kind === "entity") {
            if (!item.entity_id.trim())
              throw new Error(`Qualifier ${index + 1}의 엔터티를 지정하세요.`);
            qualifiers[predicateKey] = { entity_id: item.entity_id.trim() };
          } else {
            qualifiers[predicateKey] = {
              literal: validatedLiteral(item.literal, `Qualifier ${index + 1}`)
            };
          }
        });
        const validFrom = rfc3339FromLocal(relationValidFrom);
        const validTo = rfc3339FromLocal(relationValidTo);
        if (validFrom && validTo && Date.parse(validFrom) > Date.parse(validTo)) {
          throw new Error("유효 시작 시점은 종료 시점보다 늦을 수 없습니다.");
        }
        const assertionFields = {
          subject_entity_id: subject,
          predicate_key: predicate,
          ...object,
          qualifiers,
          valid_time: { start: validFrom, end: validTo }
        };
        if (!updating)
          return { kind: "add_assertion", id, ...assertionFields, ...common };
        const confidence = Number(relationConfidence);
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
          throw new Error("Confidence는 0 이상 1 이하의 숫자여야 합니다.");
        }
        return {
          kind: "update_assertion",
          assertion_id: id,
          ...assertionFields,
          polarity: relationPolarity,
          status: relationStatus,
          confidence,
          ...common
        };
      }
      case "merge_entities": {
        if (selectedEntityIDs.length < 2 || !selectedEntityIDs.includes(mergeSurvivorID)) {
          throw new Error("병합할 엔터티를 둘 이상 선택하고 유지할 엔터티를 지정하세요.");
        }
        return {
          kind: "merge_entities",
          survivor_id: mergeSurvivorID,
          merged_ids: selectedEntityIDs.filter((id) => id !== mergeSurvivorID),
          ...common
        };
      }
      case "split_entity": {
        if (!selectedEntityID) throw new Error("분리할 원본 엔터티를 선택하세요.");
        if (entityAssertionsMayBeTruncated) {
          throw new Error(
            "Entity 응답이 일부 주장만 포함하므로 완전한 배치를 만들 수 없습니다. 이 엔터티의 분리를 차단했습니다."
          );
        }
        if (
          splitEntities.length < 2 ||
          splitEntities.some(
            (item) =>
              !item.id.trim() || !item.class_key.trim() || !item.canonical_name.trim()
          )
        ) {
          throw new Error(
            "새 엔터티를 둘 이상 만들고 각각 ID, 유형, 이름을 입력하세요."
          );
        }
        const newIDs = splitEntities.map((item) => item.id.trim());
        if (new Set(newIDs).size !== newIDs.length || newIDs.includes(selectedEntityID)) {
          throw new Error(
            "새 엔터티 ID는 서로 달라야 하며 원본 ID와 같을 수 없습니다."
          );
        }
        if (assertionIDs.length === 0)
          throw new Error("이 엔터티에 연결된 주장이 없어 분리 배치를 만들 수 없습니다.");
        const assignments = assertionIDs
          .map((id) => splitAssignments[id])
          .filter(Boolean);
        if (
          assignments.length !== assertionIDs.length ||
          assignments.some((item) => !item.entity_id || !newIDs.includes(item.entity_id))
        ) {
          throw new Error(
            "원본에 연결된 모든 주장의 이동 방향과 새 엔터티를 지정하세요."
          );
        }
        return {
          kind: "split_entity",
          source_entity_id: selectedEntityID,
          new_entities: splitEntities.map((item) => ({
            ...item,
            id: item.id.trim(),
            class_key: item.class_key.trim(),
            canonical_name: item.canonical_name.trim(),
            evidence_ids
          })),
          assertion_assignments: assignments.map((item) => ({
            assertion_id: item.assertion_id,
            [`${item.side}_entity_id`]: item.entity_id
          })),
          ...common
        };
      }
      case "retract_assertion":
      case "restore_assertion": {
        if (!currentAssertionID.trim())
          throw new Error("철회하거나 복원할 assertion ID를 지정하세요.");
        return { kind: editKind, assertion_id: currentAssertionID.trim(), ...common };
      }
      case "resolve_conflict":
      case "dismiss_conflict": {
        if (!conflictID.trim()) throw new Error("검토할 conflict ID를 지정하세요.");
        return { kind: editKind, conflict_id: conflictID.trim(), ...common };
      }
      case "pin_entity": {
        if (!selectedEntityID)
          throw new Error("고정 상태를 변경할 엔터티를 선택하세요.");
        return {
          kind: "pin_entity",
          entity_id: selectedEntityID,
          pinned: pinValue,
          ...common
        };
      }
    }
  }

  if (!projectID) {
    return (
      <section class="panel knowledge-empty">
        <p class="eyebrow">Knowledge</p>
        <h2>프로젝트를 먼저 선택하세요</h2>
        <p>
          채팅 · 연구 화면에서 프로젝트를 선택하면 해당 프로젝트의 지식 그래프를 탐색할 수
          있습니다.
        </p>
      </section>
    );
  }

  return (
    <div class="knowledge-view">
      <KnowledgeToolbar
        projectName={projectName}
        projectID={projectID}
        connected={connected}
        busy={busy}
        status={status}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onSearchSubmit={submitSearch}
        searchResults={searchResults}
        onSelectSearchResult={focusSearchResult}
        onRefresh={refresh}
        onRebuild={rebuild}
        onExport={exportGraph}
        error={error}
        notice={notice}
      />

      {activeTab === "explorer" && (
        <div class="knowledge-layout">
          <KnowledgeGraphPanel
            mode={mode}
            onModeChange={changeMode}
            graph={graph}
            filteredGraph={filteredGraph}
            filterOptions={filterOptions}
            filterQuery={filterQuery}
            onFilterQueryChange={setFilterQuery}
            typeFilter={typeFilter}
            onTypeFilterChange={setTypeFilter}
            predicateFilter={predicateFilter}
            onPredicateFilterChange={setPredicateFilter}
            validAtFilter={validAtFilter}
            onValidAtFilterChange={setValidAtFilter}
            conflictFilter={conflictFilter}
            onConflictFilterChange={setConflictFilter}
            selectedEntityID={selectedEntityID}
            selectedEntityIDs={selectedEntityIDs}
            selectedNodes={selectedNodes}
            selectedEdgeID={selectedEdgeID}
            onSelectEntity={selectEntity}
            onFocusEntity={focusSelectedEntity}
            onSelectEdge={selectGraphEdge}
            onClearSelection={() => applyEntitySelection([])}
            graphRef={graphElement}
          />

          <KnowledgeInspector
            mode={mode}
            selectedEntityID={selectedEntityID}
            selectedEntityIDs={selectedEntityIDs}
            selectedNode={selectedNode}
            selectedEdge={selectedEdge}
            entity={entity}
            assertion={assertion}
            assertionID={assertionID}
            onAssertionIDChange={setAssertionID}
            assertionIDs={assertionIDs}
            onLoadAssertion={loadAssertion}
            evidence={evidence}
            evidenceID={evidenceID}
            onEvidenceIDChange={setEvidenceID}
            evidenceIDs={evidenceIDs}
            onLoadEvidence={loadEvidence}
            onAddEditEvidenceHandle={addEditEvidenceHandle}
            proof={proof}
            conflicts={conflicts}
            busy={busy}
            onChooseEditKind={chooseEditKind}
          />
        </div>
      )}

      {activeTab === "curation" && (
        <KnowledgeCurationStudio
          mode={mode}
          editKind={editKind}
          onChooseEditKind={chooseEditKind}
          onSubmitEdit={submitEdit}
          busy={busy}
          selectedEntityID={selectedEntityID}
          selectedEntityIDs={selectedEntityIDs}
          selectedNodes={selectedNodes}
          nodes={graph.nodes}
          assertion={assertion}
          assertionIDs={assertionIDs}
          conflictIDs={conflictIDs}
          entity={entity}
          selectedNode={selectedNode}
          entityAssertionsMayBeTruncated={entityAssertionsMayBeTruncated}
          embeddedAssertionsCount={embeddedAssertions.length}
          newEntityID={newEntityID}
          onNewEntityIDChange={setNewEntityID}
          newEntityClass={newEntityClass}
          onNewEntityClassChange={setNewEntityClass}
          newEntityName={newEntityName}
          onNewEntityNameChange={setNewEntityName}
          newEntityDescription={newEntityDescription}
          onNewEntityDescriptionChange={setNewEntityDescription}
          aliasValue={aliasValue}
          onAliasValueChange={setAliasValue}
          aliasLanguage={aliasLanguage}
          onAliasLanguageChange={setAliasLanguage}
          relationSubjectID={relationSubjectID}
          onRelationSubjectIDChange={setRelationSubjectID}
          relationPredicate={relationPredicate}
          onRelationPredicateChange={setRelationPredicate}
          relationAssertionID={relationAssertionID}
          onRelationAssertionIDChange={setRelationAssertionID}
          relationObjectKind={relationObjectKind}
          onRelationObjectKindChange={setRelationObjectKind}
          relationTargetID={relationTargetID}
          onRelationTargetIDChange={setRelationTargetID}
          relationLiteral={relationLiteral}
          onUpdateRelationLiteral={updateRelationLiteral}
          relationQualifiers={relationQualifiers}
          onAddRelationQualifier={addRelationQualifier}
          onRemoveRelationQualifier={(id) =>
            setRelationQualifiers((current) => current.filter((item) => item.id !== id))
          }
          onUpdateRelationQualifier={updateRelationQualifier}
          onUpdateQualifierLiteral={updateQualifierLiteral}
          relationValidFrom={relationValidFrom}
          onRelationValidFromChange={setRelationValidFrom}
          relationValidTo={relationValidTo}
          onRelationValidToChange={setRelationValidTo}
          relationPolarity={relationPolarity}
          onRelationPolarityChange={setRelationPolarity}
          relationStatus={relationStatus}
          onRelationStatusChange={setRelationStatus}
          relationConfidence={relationConfidence}
          onRelationConfidenceChange={setRelationConfidence}
          mergeSurvivorID={mergeSurvivorID}
          onMergeSurvivorIDChange={setMergeSurvivorID}
          splitEntities={splitEntities}
          onUpdateSplitEntity={updateSplitEntity}
          onAddSplitEntity={addSplitEntity}
          onRemoveSplitEntity={removeSplitEntity}
          splitAssignments={splitAssignments}
          onUpdateSplitAssignment={updateSplitAssignment}
          currentAssertionID={currentAssertionID}
          onEditAssertionIDChange={setEditAssertionID}
          conflictID={conflictID}
          onConflictIDChange={setConflictID}
          pinValue={pinValue}
          onPinValueChange={setPinValue}
          editEvidenceText={editEvidenceText}
          onEditEvidenceTextChange={setEditEvidenceText}
          editEvidenceIDs={editEvidenceIDs}
          editMemo={editMemo}
          onEditMemoChange={setEditMemo}
        />
      )}

      {activeTab === "ontology" && (
        <KnowledgeOntologyStudio
          status={status}
          projectID={projectID}
          busy={busy}
          ontologyFile={ontologyFile}
          onOntologyFileChange={setOntologyFile}
          onImportOntology={importOntology}
          schemaDraftName={schemaDraftName}
          onSchemaDraftNameChange={setSchemaDraftName}
          schemaDraft={schemaDraft}
          onSchemaDraftChange={setSchemaDraft}
          onImportSchemaDraft={importSchemaDraft}
          ontologyPreview={ontologyPreview}
          versionID={versionID}
          onVersionIDChange={setVersionID}
          onActivateOntology={activateOntology}
          canActivateOntology={canActivateOntology}
          onSelectVersion={(ver) => {
            const verID = text(ver.id) ?? text(ver.version_id) ?? "";
            setVersionID(verID);
            setOntologyPreview(ver);
          }}
        />
      )}

      {activeTab === "materials" && (
        <KnowledgeMaterialsPanel
          materials={materials}
          materialFile={materialFile}
          onMaterialFileChange={setMaterialFile}
          materialTitle={materialTitle}
          onMaterialTitleChange={setMaterialTitle}
          materialGraphAdopt={materialGraphAdopt}
          onMaterialGraphAdoptChange={setMaterialGraphAdopt}
          onUploadMaterial={uploadMaterial}
          onToggleMaterialAdopt={toggleMaterialAdopt}
          onRemoveMaterial={removeMaterial}
          busy={busy}
        />
      )}

      {activeTab === "sparql" && (
        <KnowledgeSparqlConsole
          sparql={sparql}
          onSparqlChange={setSparql}
          onRunSparql={runSparql}
          sparqlResult={sparqlResult}
          busy={busy}
        />
      )}
    </div>
  );
}
