import type { RefObject } from "preact";
import type { KnowledgeGraph, KnowledgeNode, KnowledgeMode } from "../knowledge-types";
import { KNOWLEDGE_MAX_EDGES, KNOWLEDGE_MAX_NODES } from "../knowledge-types";

export type FilterOptions = {
  types: string[];
  predicates: string[];
};

export type KnowledgeGraphPanelProps = {
  mode: KnowledgeMode;
  onModeChange: (mode: KnowledgeMode) => void;
  graph: KnowledgeGraph;
  filteredGraph: KnowledgeGraph;
  filterOptions: FilterOptions;
  filterQuery: string;
  onFilterQueryChange: (val: string) => void;
  typeFilter: string;
  onTypeFilterChange: (val: string) => void;
  predicateFilter: string;
  onPredicateFilterChange: (val: string) => void;
  validAtFilter: string;
  onValidAtFilterChange: (val: string) => void;
  conflictFilter: "all" | "only" | "exclude";
  onConflictFilterChange: (val: "all" | "only" | "exclude") => void;
  selectedEntityID: string;
  selectedEntityIDs: string[];
  selectedNodes: KnowledgeNode[];
  selectedEdgeID: string;
  onSelectEntity: (id: string, additive?: boolean) => void;
  onFocusEntity: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onClearSelection: () => void;
  graphRef: RefObject<HTMLDivElement>;
};

export function KnowledgeGraphPanel({
  mode,
  onModeChange,
  graph,
  filteredGraph,
  filterOptions,
  filterQuery,
  onFilterQueryChange,
  typeFilter,
  onTypeFilterChange,
  predicateFilter,
  onPredicateFilterChange,
  validAtFilter,
  onValidAtFilterChange,
  conflictFilter,
  onConflictFilterChange,
  selectedEntityID,
  selectedEntityIDs,
  selectedNodes,
  selectedEdgeID,
  onSelectEntity,
  onFocusEntity,
  onSelectEdge,
  onClearSelection,
  graphRef
}: KnowledgeGraphPanelProps) {
  return (
    <section class="panel knowledge-graph-panel" aria-label="지식 그래프 탐색기">
      {/* Graph Panel Header */}
      <div class="panel-heading knowledge-graph-heading">
        <div class="knowledge-heading-left">
          <div class="knowledge-mode-toggle" aria-label="그래프 모드">
            <button
              type="button"
              class={`mode-btn ${mode === "instance" ? "active" : ""}`}
              onClick={() => onModeChange("instance")}
            >
              인스턴스 그래프
            </button>
            <button
              type="button"
              class={`mode-btn ${mode === "ontology" ? "active" : ""}`}
              onClick={() => onModeChange("ontology")}
            >
              온톨로지 스키마
            </button>
          </div>
        </div>

        <div class="knowledge-graph-stats">
          <span>{filteredGraph.nodes.length} 노드</span>
          <span>·</span>
          <span>{filteredGraph.edges.length} 관계</span>
        </div>
      </div>

      {/* Sleek Horizontal Filter Bar */}
      <div class="knowledge-filters-bar">
        <div class="filter-field search-filter">
          <label for="graph-filter-query">내부 검색</label>
          <input
            id="graph-filter-query"
            value={filterQuery}
            onInput={(e) => onFilterQueryChange(e.currentTarget.value)}
            placeholder="노드/관계 필터…"
          />
        </div>

        <div class="filter-field">
          <label for="graph-type-filter">유형</label>
          <select
            id="graph-type-filter"
            value={typeFilter}
            onChange={(e) => onTypeFilterChange(e.currentTarget.value)}
          >
            <option value="all">모든 유형</option>
            {filterOptions.types.map((val) => (
              <option value={val} key={val}>
                {val}
              </option>
            ))}
          </select>
        </div>

        <div class="filter-field">
          <label for="graph-predicate-filter">관계</label>
          <select
            id="graph-predicate-filter"
            value={predicateFilter}
            onChange={(e) => onPredicateFilterChange(e.currentTarget.value)}
          >
            <option value="all">모든 관계</option>
            {filterOptions.predicates.map((val) => (
              <option value={val} key={val}>
                {val}
              </option>
            ))}
          </select>
        </div>

        <div class="filter-field">
          <label for="graph-valid-at">유효 시점</label>
          <input
            id="graph-valid-at"
            type="datetime-local"
            value={validAtFilter}
            onInput={(e) => onValidAtFilterChange(e.currentTarget.value)}
          />
        </div>

        <div class="filter-field">
          <label for="graph-conflict-filter">충돌</label>
          <select
            id="graph-conflict-filter"
            value={conflictFilter}
            onChange={(e) =>
              onConflictFilterChange(e.currentTarget.value as "all" | "only" | "exclude")
            }
          >
            <option value="all">전체</option>
            <option value="only">충돌만</option>
            <option value="exclude">충돌 제외</option>
          </select>
        </div>
      </div>

      {/* Multi-selection Bar */}
      <div class="knowledge-selection-toolbar" aria-live="polite">
        <div class="selection-indicator">
          <strong>{selectedEntityIDs.length}개 선택됨</strong>
          <small>캔버스 드래그 박스 또는 체크박스로 다중 선택</small>
        </div>

        <div class="knowledge-selection-chips">
          {selectedNodes.map((node) => (
            <button
              type="button"
              key={node.id}
              class="selection-chip"
              title={`${node.label} 선택 해제`}
              onClick={() => onSelectEntity(node.id, true)}
            >
              <span>{node.label}</span>
              <span class="chip-remove" aria-hidden="true">
                ✕
              </span>
            </button>
          ))}
        </div>

        {selectedEntityIDs.length > 0 && (
          <button class="button secondary small" type="button" onClick={onClearSelection}>
            선택 해제
          </button>
        )}
      </div>

      {/* Truncation Warning */}
      {graph.truncated && (
        <div class="knowledge-limit-note">
          안전한 렌더링을 위해 최대 {KNOWLEDGE_MAX_NODES}개 노드와 {KNOWLEDGE_MAX_EDGES}개 엣지로
          제한했습니다. 검색어로 범위를 좁히세요.
        </div>
      )}

      {/* Cytoscape Canvas Container */}
      <div
        class="knowledge-canvas"
        ref={graphRef}
        role="img"
        aria-label={`${filteredGraph.nodes.length}개 노드와 ${filteredGraph.edges.length}개 관계가 있는 ${mode} 지식 그래프.`}
      />

      {/* Accessible Collapsible List */}
      <details class="knowledge-accessible-list">
        <summary>접근 가능한 그래프 목록 (노드 & 관계)</summary>
        <div class="knowledge-list-columns">
          <section class="accessible-column">
            <h3>노드 목록 ({filteredGraph.nodes.length})</h3>
            <ul class="accessible-items">
              {filteredGraph.nodes.map((node) => (
                <li class="knowledge-node-list-item" key={node.id}>
                  <label class="node-checkbox-label" title={`${node.label} 다중 선택`}>
                    <input
                      type="checkbox"
                      checked={selectedEntityIDs.includes(node.id)}
                      onChange={() => onSelectEntity(node.id, true)}
                    />
                  </label>
                  <button
                    type="button"
                    class={`node-list-btn ${node.id === selectedEntityID ? "selected" : ""}`}
                    onClick={() => onFocusEntity(node.id)}
                  >
                    <div class="node-btn-title">
                      <strong>{node.label}</strong>
                      {node.pinned && <span class="badge-pinned">고정됨</span>}
                      {node.conflict && <span class="badge-conflict">충돌</span>}
                    </div>
                    <span class="node-btn-kind">{node.kind}</span>
                    <small class="node-btn-id">{node.id}</small>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section class="accessible-column">
            <h3>관계 목록 ({filteredGraph.edges.length})</h3>
            <ul class="accessible-items">
              {filteredGraph.edges.map((edge) => (
                <li key={edge.id}>
                  <button
                    type="button"
                    class={`edge-list-btn ${edge.conflict ? "conflict" : ""} ${
                      edge.id === selectedEdgeID ? "selected" : ""
                    }`}
                    onClick={() => onSelectEdge(edge.id)}
                  >
                    <div class="edge-btn-title">
                      <strong>{edge.label}</strong>
                      {edge.conflict && <span class="badge-conflict">충돌</span>}
                    </div>
                    <small class="edge-btn-path">
                      {edge.source} → {edge.target}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </details>
    </section>
  );
}
