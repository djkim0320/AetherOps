import { useMemo, useState } from "preact/hooks";
import type { KnowledgeGraph, KnowledgeNode } from "../knowledge-types";

export type KnowledgeLibraryProps = {
  graph: KnowledgeGraph;
  selectedEntityID: string;
  onSelectEntity: (id: string) => void;
  onOpenGraph: (id: string) => void;
  onManageMaterials: () => void;
  onOpenReview: () => void;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function description(node: KnowledgeNode): string {
  return (
    text(node.raw.description) ??
    text(node.raw.summary) ??
    text(node.raw.definition) ??
    "연결된 관계와 근거를 열어 세부 내용을 확인할 수 있습니다."
  );
}

function aliases(node: KnowledgeNode): string[] {
  const value = node.raw.aliases;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim()];
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const label = text(record.alias) ?? text(record.value) ?? text(record.label);
    return label ? [label] : [];
  });
}

export function KnowledgeLibrary({
  graph,
  selectedEntityID,
  onSelectEntity,
  onOpenGraph,
  onManageMaterials,
  onOpenReview
}: KnowledgeLibraryProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const kinds = useMemo(
    () => [...new Set(graph.nodes.map((node) => node.kind).filter(Boolean))].sort(),
    [graph.nodes]
  );
  const relationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of graph.edges) {
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
      if (edge.target !== edge.source) counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
    }
    return counts;
  }, [graph.edges]);
  const filteredNodes = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return graph.nodes
      .filter((node) => kind === "all" || node.kind === kind)
      .filter((node) => {
        if (!normalized) return true;
        return [node.label, node.id, node.kind, ...node.types, ...aliases(node)]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalized);
      })
      .sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        if (left.conflict !== right.conflict) return left.conflict ? -1 : 1;
        return left.label.localeCompare(right.label, "ko");
      });
  }, [graph.nodes, kind, query]);
  const selectedNode =
    graph.nodes.find((node) => node.id === selectedEntityID) ?? filteredNodes[0] ?? null;
  const selectedRelations = selectedNode
    ? graph.edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id).slice(0, 10)
    : [];

  return (
    <section class="knowledge-library" aria-label="프로젝트 지식 목록">
      <div class="panel knowledge-library-main">
        <div class="panel-heading knowledge-library-heading">
          <div>
            <p class="eyebrow">Verified Knowledge</p>
            <h2>프로젝트가 기억하는 지식</h2>
            <p>채택된 자료와 성공한 연구에서 근거가 확인된 항목만 표시합니다.</p>
          </div>
          <span class="count-badge">{filteredNodes.length}/{graph.totalNodes}</span>
        </div>

        <div class="knowledge-library-filters">
          <label>
            <span class="sr-only">지식 검색</span>
            <input
              type="search"
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder="이름, 별칭, 유형으로 찾기…"
            />
          </label>
          <label>
            <span class="sr-only">지식 유형</span>
            <select value={kind} onChange={(event) => setKind(event.currentTarget.value)}>
              <option value="all">모든 유형</option>
              {kinds.map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>

        {graph.truncated && (
          <div class="knowledge-limit-note">
            현재 검색 범위의 일부만 표시하고 있습니다. 상단 검색으로 대상을 좁혀 주세요.
          </div>
        )}

        <div class="knowledge-library-list">
          {filteredNodes.length === 0 ? (
            <div class="knowledge-overview-empty">
              <strong>{graph.nodes.length === 0 ? "아직 정리된 지식이 없습니다" : "조건에 맞는 지식이 없습니다"}</strong>
              <span>
                {graph.nodes.length === 0
                  ? "자료를 채택하거나 연구를 완료하면 검증된 지식이 생성됩니다."
                  : "검색어나 유형 필터를 변경해 보세요."}
              </span>
              {graph.nodes.length === 0 && (
                <button class="button small" type="button" onClick={onManageMaterials}>
                  자료 관리 열기
                </button>
              )}
            </div>
          ) : (
            filteredNodes.map((node) => (
              <button
                type="button"
                key={node.id}
                class={`knowledge-library-item ${selectedNode?.id === node.id ? "selected" : ""}`}
                onClick={() => onSelectEntity(node.id)}
              >
                <span class="knowledge-library-item-main">
                  <span class="knowledge-library-title-row">
                    <strong>{node.label}</strong>
                    {node.pinned && <span class="knowledge-library-tag pinned">고정</span>}
                    {node.conflict && <span class="knowledge-library-tag conflict">검토 필요</span>}
                  </span>
                  <small>{description(node)}</small>
                </span>
                <span class="knowledge-library-item-meta">
                  <span>{node.kind || "미분류"}</span>
                  <small>{relationCounts.get(node.id) ?? 0}개 관계</small>
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      <aside class="panel knowledge-library-detail" aria-label="선택한 지식 상세">
        {selectedNode ? (
          <>
            <div class="knowledge-library-detail-head">
              <div>
                <p class="eyebrow">Knowledge Detail</p>
                <h2>{selectedNode.label}</h2>
              </div>
              <span class="knowledge-library-kind">{selectedNode.kind || "미분류"}</span>
            </div>

            <p class="knowledge-library-description">{description(selectedNode)}</p>

            <dl class="knowledge-library-facts">
              <div>
                <dt>유형</dt>
                <dd>{selectedNode.types.length > 0 ? selectedNode.types.join(", ") : selectedNode.kind}</dd>
              </div>
              <div>
                <dt>연결된 관계</dt>
                <dd>{relationCounts.get(selectedNode.id) ?? 0}개</dd>
              </div>
              <div>
                <dt>주장</dt>
                <dd>{selectedNode.assertionIDs.length}개</dd>
              </div>
              <div>
                <dt>근거</dt>
                <dd>{selectedNode.evidenceIDs.length}개</dd>
              </div>
              {selectedNode.confidence !== undefined && (
                <div>
                  <dt>신뢰도</dt>
                  <dd>{Math.round(selectedNode.confidence * 100)}%</dd>
                </div>
              )}
            </dl>

            {aliases(selectedNode).length > 0 && (
              <section class="knowledge-library-detail-section">
                <h3>다른 이름</h3>
                <div class="knowledge-library-chips">
                  {aliases(selectedNode).map((alias) => (
                    <span key={alias}>{alias}</span>
                  ))}
                </div>
              </section>
            )}

            <section class="knowledge-library-detail-section">
              <h3>주요 관계</h3>
              {selectedRelations.length === 0 ? (
                <p class="knowledge-muted">현재 범위에 표시할 관계가 없습니다.</p>
              ) : (
                <ul class="knowledge-library-relations">
                  {selectedRelations.map((edge) => (
                    <li key={edge.id}>
                      <strong>{edge.label}</strong>
                      <span>
                        {edge.source === selectedNode.id ? edge.target : edge.source}
                      </span>
                      {edge.conflict && <small>검토 필요</small>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div class="knowledge-library-detail-actions">
              <button class="button small" type="button" onClick={() => onOpenGraph(selectedNode.id)}>
                관계도에서 보기
              </button>
              {(selectedNode.conflict || selectedNode.assertionIDs.length > 0) && (
                <button class="button secondary small" type="button" onClick={onOpenReview}>
                  검토함 열기
                </button>
              )}
            </div>
          </>
        ) : (
          <div class="knowledge-overview-empty">
            <strong>지식을 선택하세요</strong>
            <span>왼쪽 목록에서 항목을 고르면 핵심 관계와 근거 수를 보여줍니다.</span>
          </div>
        )}
      </aside>
    </section>
  );
}
