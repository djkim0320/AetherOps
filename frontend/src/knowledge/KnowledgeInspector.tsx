import type {
  KnowledgeAssertion,
  KnowledgeEditKind,
  KnowledgeEntity,
  KnowledgeEvidence,
  KnowledgeEdge,
  KnowledgeNode,
  KnowledgeMode,
  KnowledgeRecord
} from "../knowledge-types";

export type KnowledgeInspectorProps = {
  mode: KnowledgeMode;
  selectedEntityID: string;
  selectedEntityIDs: string[];
  selectedNode: KnowledgeNode | null;
  selectedEdge: KnowledgeEdge | null;
  entity: KnowledgeEntity | null;
  assertion: KnowledgeAssertion | null;
  assertionID: string;
  onAssertionIDChange: (id: string) => void;
  assertionIDs: string[];
  onLoadAssertion: (id?: string) => void;
  evidence: KnowledgeEvidence[] | null;
  evidenceID: string;
  onEvidenceIDChange: (id: string) => void;
  evidenceIDs: string[];
  onLoadEvidence: (id?: string) => void;
  onAddEditEvidenceHandle: (handle: string) => void;
  proof: unknown[];
  conflicts: unknown[];
  busy: string;
  onChooseEditKind: (kind: KnowledgeEditKind) => void;
};

function pretty(value: unknown): string {
  if (value === undefined) return "정보 없음";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function JsonBlock({ value, empty = "정보가 없습니다." }: { value: unknown; empty?: string }) {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
    return <p class="knowledge-muted">{empty}</p>;
  }
  return <pre class="knowledge-json">{pretty(value)}</pre>;
}

export function KnowledgeInspector({
  mode,
  selectedEntityID,
  selectedEntityIDs,
  selectedNode,
  selectedEdge,
  entity,
  assertion,
  assertionID,
  onAssertionIDChange,
  assertionIDs,
  onLoadAssertion,
  evidence,
  evidenceID,
  onEvidenceIDChange,
  evidenceIDs,
  onLoadEvidence,
  onAddEditEvidenceHandle,
  proof,
  conflicts,
  busy,
  onChooseEditKind
}: KnowledgeInspectorProps) {
  const isQueryingEntity = busy === "entity";
  const isQueryingAssertion = busy === "assertion";
  const isQueryingEvidence = busy === "evidence";

  return (
    <aside class="panel knowledge-inspector" aria-label="지식 인스펙터">
      {/* Header */}
      <div class="panel-heading inspector-header">
        <div>
          <p class="eyebrow">
            Inspector
            {selectedEntityIDs.length > 1 && ` · ${selectedEntityIDs.length}개 선택`}
          </p>
          <h2>{selectedNode?.label || selectedEntityID || "노드를 선택하세요"}</h2>
        </div>
        {isQueryingEntity && <span class="loading-label">조회 중…</span>}
      </div>

      {!selectedEntityID ? (
        <div class="knowledge-inspector-empty">
          <strong>선택된 항목 없음</strong>
          <span>캔버스나 목록에서 노드를 선택하면 세부 정보와 근거 연결을 확인할 수 있습니다.</span>
        </div>
      ) : (
        <div class="inspector-content">
          {/* Quick Action Buttons */}
          <div class="inspector-quick-actions">
            <button
              type="button"
              class="button secondary small"
              onClick={() => onChooseEditKind("add_assertion")}
            >
              + 관계 생성
            </button>
            {assertion && (
              <button
                type="button"
                class="button secondary small"
                onClick={() => onChooseEditKind("update_assertion")}
              >
                ✎ 주장 편집
              </button>
            )}
            <button
              type="button"
              class="button secondary small"
              onClick={() => onChooseEditKind("pin_entity")}
            >
              고정 설정
            </button>
          </div>

          {/* Selected Edge Info (if edge clicked) */}
          {selectedEdge && (
            <section class="knowledge-inspector-section">
              <div class="section-title">
                <h3>{mode === "ontology" ? "Ontology Axiom" : "선택한 관계"}</h3>
              </div>
              <JsonBlock value={selectedEdge.raw} />
            </section>
          )}

          {/* Entity Details */}
          <section class="knowledge-inspector-section">
            <div class="section-title">
              <h3>엔터티 정보</h3>
            </div>
            <JsonBlock value={entity ?? selectedNode?.raw} />
          </section>

          {/* Assertions & Proofs */}
          <section class="knowledge-inspector-section">
            <div class="section-title">
              <h3>주장 (Assertions) & 증명</h3>
            </div>

            {assertionIDs.length > 0 && (
              <div class="knowledge-reference-chips">
                {assertionIDs.map((id) => (
                  <button
                    type="button"
                    key={id}
                    class={`ref-chip ${id === assertionID ? "active" : ""}`}
                    onClick={() => onLoadAssertion(id)}
                  >
                    {id}
                  </button>
                ))}
              </div>
            )}

            <div class="knowledge-id-input-row">
              <input
                value={assertionID}
                onInput={(e) => onAssertionIDChange(e.currentTarget.value)}
                placeholder="assertion ID 입력…"
              />
              <button
                class="button secondary small"
                type="button"
                onClick={() => onLoadAssertion()}
                disabled={!assertionID.trim() || isQueryingAssertion}
              >
                {isQueryingAssertion ? "…" : "조회"}
              </button>
            </div>

            <JsonBlock value={assertion} empty="주장을 선택하면 검증 정보가 표시됩니다." />

            <h4>Proof Chain</h4>
            <JsonBlock value={proof} empty="연결된 proof가 없습니다." />
          </section>

          {/* Evidence Handles & Occurrences */}
          <section class="knowledge-inspector-section">
            <div class="section-title">
              <h3>근거 (Evidence)</h3>
            </div>

            {evidenceIDs.length > 0 && (
              <div class="knowledge-reference-chips">
                {evidenceIDs.map((id) => (
                  <span class="evidence-chip-group" key={id}>
                    <button
                      type="button"
                      class={`ref-chip ${id === evidenceID ? "active" : ""}`}
                      onClick={() => onLoadEvidence(id)}
                    >
                      {id}
                    </button>
                    <button
                      type="button"
                      class="chip-add-action"
                      title="편집 근거에 추가"
                      onClick={() => onAddEditEvidenceHandle(id)}
                    >
                      +
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div class="knowledge-id-input-row">
              <input
                value={evidenceID}
                onInput={(e) => onEvidenceIDChange(e.currentTarget.value)}
                placeholder="evidence ID 입력…"
              />
              <button
                class="button secondary small"
                type="button"
                onClick={() => onLoadEvidence()}
                disabled={!evidenceID.trim() || isQueryingEvidence}
              >
                {isQueryingEvidence ? "…" : "조회"}
              </button>
            </div>

            {evidence === null ? (
              <p class="knowledge-muted">근거를 선택하면 출처와 스냅샷 정보가 표시됩니다.</p>
            ) : evidence.length === 0 ? (
              <p class="knowledge-muted">이 handle의 근거 occurrence가 없습니다.</p>
            ) : (
              <div class="knowledge-evidence-occurrences">
                {evidence.map((item, index) => (
                  <article
                    class="evidence-card"
                    key={`${text(item.id) ?? evidenceID}-${text(item.assertion_id) ?? index}`}
                  >
                    <h4>
                      Occurrence {index + 1}
                      {text(item.assertion_id) ? ` · ${text(item.assertion_id)}` : ""}
                    </h4>
                    <JsonBlock value={item} />
                  </article>
                ))}
              </div>
            )}

            {evidence && evidence.length > 0 && (
              <button
                class="button secondary small full-width-btn"
                type="button"
                onClick={() =>
                  onAddEditEvidenceHandle(
                    text(evidence[0].id) ?? text(evidence[0].evidence_id) ?? evidenceID
                  )
                }
                disabled={!(text(evidence[0].id) ?? text(evidence[0].evidence_id) ?? evidenceID)}
              >
                + 이 handle을 편집 근거에 추가
              </button>
            )}
          </section>

          {/* Conflicts */}
          <section class="knowledge-inspector-section">
            <div class="section-title">
              <h3>감지된 충돌 (Conflicts)</h3>
            </div>
            <JsonBlock value={conflicts} empty="감지된 충돌이 없습니다." />
          </section>
        </div>
      )}
    </aside>
  );
}
