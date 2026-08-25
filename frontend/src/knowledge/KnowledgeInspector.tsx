import { useState } from "preact/hooks";
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

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  const [copiedID, setCopiedID] = useState(false);
  const isQueryingEntity = busy === "entity";
  const isQueryingAssertion = busy === "assertion";
  const isQueryingEvidence = busy === "evidence";

  async function copyEntityID() {
    if (!selectedEntityID) return;
    try {
      await navigator.clipboard.writeText(selectedEntityID);
      setCopiedID(true);
      setTimeout(() => setCopiedID(false), 2000);
    } catch {
      // Fallback
    }
  }

  const rawEntity = (entity ?? selectedNode?.raw) as KnowledgeRecord | undefined;
  const canonicalName =
    text(rawEntity?.canonical_name) ??
    text(rawEntity?.label) ??
    selectedNode?.label ??
    selectedEntityID;
  const classKey =
    text(rawEntity?.class_key) ??
    text(rawEntity?.kind) ??
    selectedNode?.kind ??
    "Entity";
  const description = text(rawEntity?.description);
  const aliases = Array.isArray(rawEntity?.aliases) ? (rawEntity.aliases as string[]) : [];
  const isPinned = Boolean(rawEntity?.pinned ?? selectedNode?.pinned);
  const hasConflict = Boolean(rawEntity?.conflict ?? selectedNode?.conflict);

  return (
    <aside class="panel knowledge-inspector" aria-label="지식 인스펙터">
      {/* Header */}
      <div class="panel-heading inspector-header">
        <div>
          <p class="eyebrow">
            Inspector
            {selectedEntityIDs.length > 1 && ` · ${selectedEntityIDs.length}개 노드 선택됨`}
          </p>
          <h2>{canonicalName || "노드를 선택하세요"}</h2>
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
              관계 생성
            </button>
            {assertion && (
              <button
                type="button"
                class="button secondary small"
                onClick={() => onChooseEditKind("update_assertion")}
              >
                주장 편집
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
                <span class="count-badge">{selectedEdge.predicate || selectedEdge.label}</span>
              </div>

              <div class="inspector-field-grid">
                <div class="inspector-field">
                  <span>출발 (Subject)</span>
                  <code>{selectedEdge.source}</code>
                </div>
                <div class="inspector-field">
                  <span>도착 (Target)</span>
                  <code>{selectedEdge.target}</code>
                </div>
                <div class="inspector-field">
                  <span>술어 (Predicate)</span>
                  <strong class="predicate-highlight">{selectedEdge.predicate || selectedEdge.label}</strong>
                </div>
                {selectedEdge.status && (
                  <div class="inspector-field">
                    <span>상태</span>
                    <span class="status-pill">{selectedEdge.status}</span>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Entity Details Card */}
          <section class="knowledge-inspector-section">
            <div class="section-title">
              <h3>엔터티 정보</h3>
              <div class="entity-badge-row">
                <span class="class-pill">{classKey}</span>
                {isPinned && <span class="badge-pinned">✓ 고정됨</span>}
                {hasConflict && <span class="badge-conflict">충돌 감지</span>}
              </div>
            </div>

            <div class="inspector-field-grid">
              <div class="inspector-field full-width">
                <span>식별자 (ID)</span>
                <div class="id-copy-row">
                  <code>{selectedEntityID}</code>
                  <button type="button" class="copy-tiny-btn" onClick={copyEntityID}>
                    {copiedID ? "✓ 복사됨" : "복사"}
                  </button>
                </div>
              </div>

              <div class="inspector-field">
                <span>대표 이름</span>
                <strong>{canonicalName}</strong>
              </div>

              <div class="inspector-field">
                <span>유형 (Class)</span>
                <code>{classKey}</code>
              </div>

              {description && (
                <div class="inspector-field full-width">
                  <span>설명</span>
                  <p class="entity-desc-text">{description}</p>
                </div>
              )}

              {aliases.length > 0 && (
                <div class="inspector-field full-width">
                  <span>승인된 별칭 (Aliases)</span>
                  <div class="alias-chips-row">
                    {aliases.map((alias) => (
                      <span class="alias-chip" key={alias}>
                        {alias}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Assertions & Proofs */}
          <section class="knowledge-inspector-section">
            <div class="section-title">
              <h3>주장 (Assertions) & 검증</h3>
              <span class="count-badge">{assertionIDs.length}개</span>
            </div>

            {assertionIDs.length > 0 ? (
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
            ) : (
              <p class="knowledge-muted">이 엔터티에 직접 연결된 주장이 없습니다.</p>
            )}

            <div class="knowledge-id-input-row">
              <input
                value={assertionID}
                onInput={(e) => onAssertionIDChange(e.currentTarget.value)}
                placeholder="assertion ID 직접 입력…"
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

            {assertion ? (
              <div class="assertion-card">
                <div class="assertion-card-head">
                  <span class={`polarity-pill ${assertion.polarity ?? "affirmed"}`}>
                    {assertion.polarity === "negated" ? "✕ 부정 주장" : "✓ 긍정 주장"}
                  </span>
                  <span class="status-pill">{text(assertion.status) ?? "accepted"}</span>
                  {assertion.confidence !== undefined && (
                    <span class="confidence-pill">
                      신뢰도: {Math.round(Number(assertion.confidence) * 100)}%
                    </span>
                  )}
                </div>

                <div class="assertion-triple-summary">
                  <code>{text(assertion.subject_entity_id)}</code>
                  <span class="predicate-badge">{text(assertion.predicate_key) ?? text(assertion.predicate)}</span>
                  <code>
                    {text(assertion.object_entity_id) ??
                      (typeof assertion.literal === "object"
                        ? JSON.stringify(assertion.literal)
                        : String(assertion.literal ?? assertion.object_literal ?? "—"))}
                  </code>
                </div>

                {(assertion.valid_from || assertion.valid_to) && (
                  <div class="valid-time-row">
                    <span>유효 기간:</span>
                    <small>
                      {text(assertion.valid_from) ?? "처음부터"} ~ {text(assertion.valid_to) ?? "영구"}
                    </small>
                  </div>
                )}
              </div>
            ) : (
              <p class="knowledge-muted">주장 ID를 선택하면 세부 검증 정보가 표시됩니다.</p>
            )}

            {proof && proof.length > 0 && (
              <div class="proof-chain-section">
                <h4>증명 체인 (Proof Chain)</h4>
                <div class="proof-steps-list">
                  {proof.map((p, idx) => (
                    <div class="proof-step-item" key={idx}>
                      <span class="step-num">{idx + 1}</span>
                      <code>{typeof p === "string" ? p : JSON.stringify(p)}</code>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Evidence Handles & Occurrences */}
          <section class="knowledge-inspector-section">
            <div class="section-title">
              <h3>근거 (Evidence)</h3>
              <span class="count-badge">{evidenceIDs.length}개</span>
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
              <p class="knowledge-muted">근거 ID를 선택하면 원본 문서 출처와 스냅샷이 표시됩니다.</p>
            ) : evidence.length === 0 ? (
              <p class="knowledge-muted">이 handle의 근거 occurrence가 없습니다.</p>
            ) : (
              <div class="knowledge-evidence-occurrences">
                {evidence.map((item, index) => {
                  const rawItem = item as KnowledgeRecord;
                  const docTitle = text(rawItem.source_title) ?? text(rawItem.document_id) ?? "문서 원본";
                  const snippet = text(rawItem.text_snippet) ?? text(rawItem.snippet) ?? text(rawItem.content);
                  const casHash = text(rawItem.content_sha256) ?? text(rawItem.sha256);

                  return (
                    <article class="evidence-card" key={`${text(item.id) ?? evidenceID}-${index}`}>
                      <div class="evidence-card-head">
                        <strong>출처: {docTitle}</strong>
                        {text(item.assertion_id) && (
                          <span class="assertion-ref-tag">{text(item.assertion_id)}</span>
                        )}
                      </div>
                      {snippet && <p class="evidence-snippet-quote">"{snippet}"</p>}
                      {casHash && (
                        <div class="evidence-cas-row">
                          <span>CAS SHA-256:</span>
                          <code>{casHash.slice(0, 16)}…</code>
                        </div>
                      )}
                    </article>
                  );
                })}
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
              <span class={`count-badge ${conflicts.length > 0 ? "danger" : ""}`}>
                {conflicts.length}건
              </span>
            </div>
            {conflicts.length === 0 ? (
              <p class="knowledge-muted">감지된 충돌이 없습니다.</p>
            ) : (
              <div class="conflicts-list">
                {conflicts.map((c, idx) => (
                  <div class="conflict-item-card" key={idx}>
                    <strong>충돌 #{idx + 1}</strong>
                    <p>{typeof c === "string" ? c : JSON.stringify(c)}</p>
                    <button
                      type="button"
                      class="button secondary small"
                      onClick={() => onChooseEditKind("resolve_conflict")}
                    >
                      충돌 해결하기
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}
