import type {
  KnowledgeAssertion,
  KnowledgeEditKind,
  KnowledgeEntity,
  KnowledgeNode,
  KnowledgeMode,
  KnowledgeQualifierDraft,
  KnowledgeSplitAssignmentDraft,
  KnowledgeSplitEntityDraft,
  KnowledgeTypedLiteralDraft
} from "../knowledge-types";

export const EDIT_KIND_LABELS: Record<KnowledgeEditKind, string> = {
  add_entity: "엔터티 생성",
  add_alias: "별칭 추가",
  add_assertion: "관계 생성",
  update_assertion: "기존 주장 편집",
  merge_entities: "엔터티 병합",
  split_entity: "엔터티 분리",
  retract_assertion: "주장 철회",
  restore_assertion: "주장 복원",
  resolve_conflict: "충돌 해결",
  dismiss_conflict: "충돌 기각",
  pin_entity: "엔터티 고정"
};

export type KnowledgeCurationStudioProps = {
  mode: KnowledgeMode;
  editKind: KnowledgeEditKind;
  onChooseEditKind: (kind: KnowledgeEditKind) => void;
  onSubmitEdit: (e: Event) => void;
  busy: string;
  selectedEntityID: string;
  selectedEntityIDs: string[];
  selectedNodes: KnowledgeNode[];
  nodes: KnowledgeNode[];
  assertion: KnowledgeAssertion | null;
  assertionIDs: string[];
  conflictIDs: string[];
  entity: KnowledgeEntity | null;
  selectedNode: KnowledgeNode | null;
  entityAssertionsMayBeTruncated: boolean;
  embeddedAssertionsCount: number;

  // Form States
  newEntityID: string;
  onNewEntityIDChange: (val: string) => void;
  newEntityClass: string;
  onNewEntityClassChange: (val: string) => void;
  newEntityName: string;
  onNewEntityNameChange: (val: string) => void;
  newEntityDescription: string;
  onNewEntityDescriptionChange: (val: string) => void;

  aliasValue: string;
  onAliasValueChange: (val: string) => void;
  aliasLanguage: string;
  onAliasLanguageChange: (val: string) => void;

  relationSubjectID: string;
  onRelationSubjectIDChange: (val: string) => void;
  relationPredicate: string;
  onRelationPredicateChange: (val: string) => void;
  relationAssertionID: string;
  onRelationAssertionIDChange: (val: string) => void;
  relationObjectKind: "entity" | "literal";
  onRelationObjectKindChange: (kind: "entity" | "literal") => void;
  relationTargetID: string;
  onRelationTargetIDChange: (val: string) => void;
  relationLiteral: KnowledgeTypedLiteralDraft;
  onUpdateRelationLiteral: (field: keyof KnowledgeTypedLiteralDraft, val: string) => void;
  relationQualifiers: KnowledgeQualifierDraft[];
  onAddRelationQualifier: () => void;
  onRemoveRelationQualifier: (id: string) => void;
  onUpdateRelationQualifier: (id: string, update: Partial<KnowledgeQualifierDraft>) => void;
  onUpdateQualifierLiteral: (
    id: string,
    field: keyof KnowledgeTypedLiteralDraft,
    val: string
  ) => void;
  relationValidFrom: string;
  onRelationValidFromChange: (val: string) => void;
  relationValidTo: string;
  onRelationValidToChange: (val: string) => void;
  relationPolarity: "affirmed" | "negated";
  onRelationPolarityChange: (val: "affirmed" | "negated") => void;
  relationStatus: "accepted" | "disputed" | "superseded" | "retracted";
  onRelationStatusChange: (
    val: "accepted" | "disputed" | "superseded" | "retracted"
  ) => void;
  relationConfidence: string;
  onRelationConfidenceChange: (val: string) => void;

  mergeSurvivorID: string;
  onMergeSurvivorIDChange: (val: string) => void;

  splitEntities: KnowledgeSplitEntityDraft[];
  onUpdateSplitEntity: (
    index: number,
    field: keyof KnowledgeSplitEntityDraft,
    val: string
  ) => void;
  onAddSplitEntity: () => void;
  onRemoveSplitEntity: (index: number) => void;
  splitAssignments: Record<string, KnowledgeSplitAssignmentDraft>;
  onUpdateSplitAssignment: (
    assertionID: string,
    field: "side" | "entity_id",
    val: string
  ) => void;

  currentAssertionID: string;
  onEditAssertionIDChange: (val: string) => void;

  conflictID: string;
  onConflictIDChange: (val: string) => void;

  pinValue: boolean;
  onPinValueChange: (val: boolean) => void;

  editEvidenceText: string;
  onEditEvidenceTextChange: (val: string) => void;
  editEvidenceIDs: string[];
  editMemo: string;
  onEditMemoChange: (val: string) => void;
};

export function KnowledgeCurationStudio({
  mode,
  editKind,
  onChooseEditKind,
  onSubmitEdit,
  busy,
  selectedEntityID,
  selectedEntityIDs,
  selectedNodes,
  nodes,
  assertion,
  assertionIDs,
  conflictIDs,
  entity,
  selectedNode,
  entityAssertionsMayBeTruncated,
  embeddedAssertionsCount,
  newEntityID,
  onNewEntityIDChange,
  newEntityClass,
  onNewEntityClassChange,
  newEntityName,
  onNewEntityNameChange,
  newEntityDescription,
  onNewEntityDescriptionChange,
  aliasValue,
  onAliasValueChange,
  aliasLanguage,
  onAliasLanguageChange,
  relationSubjectID,
  onRelationSubjectIDChange,
  relationPredicate,
  onRelationPredicateChange,
  relationAssertionID,
  onRelationAssertionIDChange,
  relationObjectKind,
  onRelationObjectKindChange,
  relationTargetID,
  onRelationTargetIDChange,
  relationLiteral,
  onUpdateRelationLiteral,
  relationQualifiers,
  onAddRelationQualifier,
  onRemoveRelationQualifier,
  onUpdateRelationQualifier,
  onUpdateQualifierLiteral,
  relationValidFrom,
  onRelationValidFromChange,
  relationValidTo,
  onRelationValidToChange,
  relationPolarity,
  onRelationPolarityChange,
  relationStatus,
  onRelationStatusChange,
  relationConfidence,
  onRelationConfidenceChange,
  mergeSurvivorID,
  onMergeSurvivorIDChange,
  splitEntities,
  onUpdateSplitEntity,
  onAddSplitEntity,
  onRemoveSplitEntity,
  splitAssignments,
  onUpdateSplitAssignment,
  currentAssertionID,
  onEditAssertionIDChange,
  conflictID,
  onConflictIDChange,
  pinValue,
  onPinValueChange,
  editEvidenceText,
  onEditEvidenceTextChange,
  editEvidenceIDs,
  editMemo,
  onEditMemoChange
}: KnowledgeCurationStudioProps) {
  const isEditing = busy === "edit";

  return (
    <section class="panel knowledge-tool-card curation-card" aria-label="구조화된 지식 편집">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Evidence-backed Knowledge Curation</p>
          <h2>구조화 편집 (Curation Studio)</h2>
        </div>
        <span class="count-badge">{EDIT_KIND_LABELS[editKind]}</span>
      </div>

      <form class="knowledge-edit-form" onSubmit={onSubmitEdit}>
        {mode === "ontology" && (
          <div class="alert warning knowledge-form-warning">
            온톨로지 구조는 온톨로지 & 스키마 탭에서 작성하세요. 인스턴스 curation은 Instance
            모드에서만 제출할 수 있습니다.
          </div>
        )}

        {/* 2-Column Curation Layout */}
        <div class="curation-studio-grid">
          {/* Left Column: Navigator, Live Preview, and Evidence Memo */}
          <div class="curation-left-col">
            {/* Categorized Operation Selector */}
            <div class="curation-card-section">
              <h3>편집 작업 선택</h3>
              <div class="curation-categories-nav">
                <div class="curation-cat-group">
                  <span class="curation-cat-label">엔터티:</span>
                  <button
                    type="button"
                    class={`filter-chip ${editKind === "add_entity" ? "active" : ""}`}
                    onClick={() => onChooseEditKind("add_entity")}
                  >
                    생성
                  </button>
                  <button
                    type="button"
                    class={`filter-chip ${editKind === "add_alias" ? "active" : ""}`}
                    onClick={() => onChooseEditKind("add_alias")}
                  >
                    별칭
                  </button>
                  <button
                    type="button"
                    class={`filter-chip ${editKind === "pin_entity" ? "active" : ""}`}
                    onClick={() => onChooseEditKind("pin_entity")}
                  >
                    고정
                  </button>
                </div>

                <div class="curation-cat-group">
                  <span class="curation-cat-label">관계/주장:</span>
                  <button
                    type="button"
                    class={`filter-chip ${editKind === "add_assertion" ? "active" : ""}`}
                    onClick={() => onChooseEditKind("add_assertion")}
                  >
                    생성
                  </button>
                  <button
                    type="button"
                    class={`filter-chip ${editKind === "update_assertion" ? "active" : ""}`}
                    onClick={() => onChooseEditKind("update_assertion")}
                  >
                    편집
                  </button>
                  <button
                    type="button"
                    class={`filter-chip ${editKind === "retract_assertion" ? "active" : ""}`}
                    onClick={() => onChooseEditKind("retract_assertion")}
                  >
                    철회
                  </button>
                  <button
                    type="button"
                    class={`filter-chip ${editKind === "restore_assertion" ? "active" : ""}`}
                    onClick={() => onChooseEditKind("restore_assertion")}
                  >
                    복원
                  </button>
                </div>

                <div class="curation-cat-group">
                  <span class="curation-cat-label">재구성:</span>
                  <button
                    type="button"
                    class={`filter-chip ${editKind === "merge_entities" ? "active" : ""}`}
                    onClick={() => onChooseEditKind("merge_entities")}
                  >
                    병합
                  </button>
                  <button
                    type="button"
                    class={`filter-chip ${editKind === "split_entity" ? "active" : ""}`}
                    onClick={() => onChooseEditKind("split_entity")}
                  >
                    분리
                  </button>
                </div>

                <div class="curation-cat-group">
                  <span class="curation-cat-label">충돌:</span>
                  <button
                    type="button"
                    class={`filter-chip ${editKind === "resolve_conflict" ? "active" : ""}`}
                    onClick={() => onChooseEditKind("resolve_conflict")}
                  >
                    해결
                  </button>
                  <button
                    type="button"
                    class={`filter-chip ${editKind === "dismiss_conflict" ? "active" : ""}`}
                    onClick={() => onChooseEditKind("dismiss_conflict")}
                  >
                    기각
                  </button>
                </div>
              </div>
            </div>

            {/* Live Triple Preview (Active for assertion edits) */}
            {(editKind === "add_assertion" || editKind === "update_assertion") && (
              <div class="curation-card-section">
                <h3>실시간 주장 시각화</h3>
                <div class="triple-preview-box">
                  <div class="triple-visual-flow">
                    <span class="triple-subject">{relationSubjectID || "(출발 엔터티)"}</span>
                    <span class="triple-arrow">──[{relationPredicate || "predicate"}]──▶</span>
                    <span class="triple-object">
                      {relationObjectKind === "entity"
                        ? relationTargetID || "(도착 엔터티)"
                        : `"${relationLiteral.lexical_form || "값"}"^^<${relationLiteral.datatype || "xsd:string"}>`}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Required Evidence & Memo Card */}
            <div class="curation-card-section">
              <h3>필수 근거 (Evidence & CAS Memo)</h3>
              <div class="evidence-memo-box">
                <label for="curation-evidence-handles">Evidence Handles</label>
                <input
                  id="curation-evidence-handles"
                  value={editEvidenceText}
                  onInput={(e) => onEditEvidenceTextChange(e.currentTarget.value)}
                  placeholder="예: evid_1, evid_2"
                />

                {editEvidenceIDs.length > 0 && (
                  <div class="knowledge-edit-evidence-list">
                    {editEvidenceIDs.map((id) => (
                      <button
                        type="button"
                        key={id}
                        class="selection-chip"
                        title="제거"
                        onClick={() =>
                          onEditEvidenceTextChange(
                            editEvidenceIDs.filter((item) => item !== id).join("\n")
                          )
                        }
                      >
                        <span>{id}</span>
                        <span class="chip-remove" aria-hidden="true">
                          ✕
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                <label for="curation-edit-memo" class="memo-label">
                  새 CAS 고정 메모
                </label>
                <textarea
                  id="curation-edit-memo"
                  value={editMemo}
                  onInput={(e) => onEditMemoChange(e.currentTarget.value)}
                  placeholder="판단의 근거와 변경 이유를 기록하세요. 서버가 CAS에 고정합니다."
                  rows={3}
                />
              </div>
            </div>

            {/* Submit Action Box */}
            <div class="curation-submit-box">
              <button
                class="button primary full-width-btn"
                type="submit"
                disabled={
                  mode === "ontology" ||
                  Boolean(busy) ||
                  (editKind === "split_entity" && entityAssertionsMayBeTruncated) ||
                  (editKind === "update_assertion" && !assertion)
                }
              >
                {isEditing ? "검증 및 재구성 중…" : "제출하고 그래프 재구성"}
              </button>
              <small class="submit-hint">append-only 기록 후 shadow graph를 검증·교체합니다.</small>
            </div>
          </div>

          {/* Right Column: Active Form Editor */}
          <div class="curation-right-col">
            {/* 1. Add Entity */}
            {editKind === "add_entity" && (
              <fieldset class="curation-fieldset">
                <legend>새 엔터티 생성</legend>
                <div class="form-grid-2">
                  <label>
                    엔터티 ID
                    <input value={newEntityID} onInput={(e) => onNewEntityIDChange(e.currentTarget.value)} />
                  </label>
                  <label>
                    유형 (Class Key)
                    <input
                      value={newEntityClass}
                      onInput={(e) => onNewEntityClassChange(e.currentTarget.value)}
                      placeholder="예: Entity, Concept"
                    />
                  </label>
                </div>
                <label>
                  대표 이름 (Canonical Name)
                  <input value={newEntityName} onInput={(e) => onNewEntityNameChange(e.currentTarget.value)} />
                </label>
                <label>
                  설명
                  <textarea
                    value={newEntityDescription}
                    onInput={(e) => onNewEntityDescriptionChange(e.currentTarget.value)}
                    rows={3}
                  />
                </label>
              </fieldset>
            )}

            {/* 2. Add Alias */}
            {editKind === "add_alias" && (
              <fieldset class="curation-fieldset">
                <legend>사용자 승인 별칭 추가</legend>
                <label>
                  대상 엔터티
                  <input value={selectedEntityID} readOnly placeholder="그래프에서 엔터티 선택" />
                </label>
                <div class="form-grid-2">
                  <label>
                    별칭 (Alias)
                    <input value={aliasValue} onInput={(e) => onAliasValueChange(e.currentTarget.value)} />
                  </label>
                  <label>
                    언어 태그
                    <input
                      value={aliasLanguage}
                      onInput={(e) => onAliasLanguageChange(e.currentTarget.value)}
                      placeholder="ko, en 등 (선택)"
                    />
                  </label>
                </div>
              </fieldset>
            )}

            {/* 3 & 4. Add / Update Assertion */}
            {(editKind === "add_assertion" || editKind === "update_assertion") && (
              <fieldset class="curation-fieldset">
                <legend>{editKind === "update_assertion" ? "기존 주장 편집" : "관계 및 속성 주장 생성"}</legend>
                {editKind === "update_assertion" && !assertion && (
                  <div class="alert warning knowledge-form-warning">
                    Inspector에서 assertion을 먼저 조회하세요.
                  </div>
                )}

                <div class="form-grid-3">
                  <label>
                    출발 엔터티
                    <input
                      list="knowledge-entity-options"
                      value={relationSubjectID}
                      onInput={(e) => onRelationSubjectIDChange(e.currentTarget.value)}
                      readOnly={editKind === "add_assertion"}
                      placeholder="엔터티 선택"
                    />
                  </label>
                  <label>
                    관계 술어 (Predicate)
                    <input
                      value={relationPredicate}
                      onInput={(e) => onRelationPredicateChange(e.currentTarget.value)}
                      placeholder="예: related_to"
                    />
                  </label>
                  <label>
                    Assertion ID
                    <input
                      value={relationAssertionID}
                      onInput={(e) => onRelationAssertionIDChange(e.currentTarget.value)}
                      readOnly={editKind === "update_assertion"}
                    />
                  </label>
                </div>

                <div class="knowledge-pin-options" role="radiogroup" aria-label="주장 객체 유형">
                  <label class="radio-label">
                    <input
                      type="radio"
                      name="curation-object-kind"
                      checked={relationObjectKind === "entity"}
                      onChange={() => onRelationObjectKindChange("entity")}
                    />
                    엔터티 관계
                  </label>
                  <label class="radio-label">
                    <input
                      type="radio"
                      name="curation-object-kind"
                      checked={relationObjectKind === "literal"}
                      onChange={() => onRelationObjectKindChange("literal")}
                    />
                    Typed Literal (값)
                  </label>
                </div>

                {relationObjectKind === "entity" ? (
                  <label>
                    도착 엔터티 (Object Entity)
                    <input
                      list="knowledge-entity-options"
                      value={relationTargetID}
                      onInput={(e) => onRelationTargetIDChange(e.currentTarget.value)}
                      placeholder="entity ID"
                    />
                  </label>
                ) : (
                  <div class="knowledge-literal-grid">
                    <label>
                      원문 값
                      <input
                        value={relationLiteral.lexical_form}
                        onInput={(e) => onUpdateRelationLiteral("lexical_form", e.currentTarget.value)}
                      />
                    </label>
                    <label>
                      Datatype
                      <input
                        list="knowledge-datatype-options"
                        value={relationLiteral.datatype}
                        onInput={(e) => onUpdateRelationLiteral("datatype", e.currentTarget.value)}
                      />
                    </label>
                    <label>
                      언어 태그
                      <input
                        value={relationLiteral.language}
                        onInput={(e) => onUpdateRelationLiteral("language", e.currentTarget.value)}
                        placeholder="ko, en"
                      />
                    </label>
                    <label>
                      원문 단위
                      <input
                        value={relationLiteral.unit}
                        onInput={(e) => onUpdateRelationLiteral("unit", e.currentTarget.value)}
                        placeholder="m, Pa"
                      />
                    </label>
                    <label>
                      SI 값
                      <input
                        value={relationLiteral.si_value}
                        onInput={(e) => onUpdateRelationLiteral("si_value", e.currentTarget.value)}
                      />
                    </label>
                    <label>
                      SI 단위
                      <input
                        value={relationLiteral.si_unit}
                        onInput={(e) => onUpdateRelationLiteral("si_unit", e.currentTarget.value)}
                        placeholder="m, Pa"
                      />
                    </label>
                  </div>
                )}

                <datalist id="knowledge-entity-options">
                  {nodes
                    .filter((node) => node.id !== selectedEntityID)
                    .map((node) => (
                      <option value={node.id} key={node.id}>
                        {node.label}
                      </option>
                    ))}
                </datalist>

                <datalist id="knowledge-datatype-options">
                  <option value="xsd:string" />
                  <option value="xsd:boolean" />
                  <option value="xsd:integer" />
                  <option value="xsd:decimal" />
                  <option value="xsd:dateTime" />
                  <option value="aetherops:length" />
                  <option value="aetherops:area" />
                  <option value="aetherops:mass" />
                  <option value="aetherops:time" />
                  <option value="aetherops:speed" />
                  <option value="aetherops:pressure" />
                  <option value="aetherops:angle" />
                  <option value="aetherops:temperature" />
                </datalist>

                {/* Qualifiers */}
                <div class="qualifiers-header">
                  <strong>한정자 (Qualifiers)</strong>
                  <button class="button secondary small" type="button" onClick={onAddRelationQualifier}>
                    + 한정자 추가
                  </button>
                </div>

                {relationQualifiers.map((item, index) => (
                  <div class="qualifier-box" key={item.id}>
                    <div class="qualifier-head">
                      <span>Qualifier {index + 1}</span>
                      <button
                        type="button"
                        class="button danger small"
                        onClick={() => onRemoveRelationQualifier(item.id)}
                      >
                        삭제
                      </button>
                    </div>

                    <div class="form-grid-2">
                      <label>
                        Predicate
                        <input
                          value={item.predicate}
                          onInput={(e) =>
                            onUpdateRelationQualifier(item.id, {
                              predicate: e.currentTarget.value
                            })
                          }
                        />
                      </label>
                      <label>
                        유형
                        <select
                          value={item.value_kind}
                          onChange={(e) =>
                            onUpdateRelationQualifier(item.id, {
                              value_kind: e.currentTarget.value as "entity" | "literal"
                            })
                          }
                        >
                          <option value="entity">엔터티</option>
                          <option value="literal">Literal 값</option>
                        </select>
                      </label>
                    </div>

                    {item.value_kind === "entity" ? (
                      <label>
                        Entity ID
                        <input
                          value={item.entity_id}
                          onInput={(e) =>
                            onUpdateRelationQualifier(item.id, {
                              entity_id: e.currentTarget.value
                            })
                          }
                        />
                      </label>
                    ) : (
                      <div class="knowledge-literal-grid">
                        <label>
                          Lexical Form
                          <input
                            value={item.literal.lexical_form}
                            onInput={(e) =>
                              onUpdateQualifierLiteral(item.id, "lexical_form", e.currentTarget.value)
                            }
                          />
                        </label>
                        <label>
                          Datatype
                          <input
                            value={item.literal.datatype}
                            onInput={(e) =>
                              onUpdateQualifierLiteral(item.id, "datatype", e.currentTarget.value)
                            }
                          />
                        </label>
                      </div>
                    )}
                  </div>
                ))}

                {/* Valid Times & Status */}
                <div class="form-grid-2">
                  <label>
                    유효 시작 (Valid From)
                    <input
                      type="datetime-local"
                      value={relationValidFrom}
                      onInput={(e) => onRelationValidFromChange(e.currentTarget.value)}
                    />
                  </label>
                  <label>
                    유효 종료 (Valid To)
                    <input
                      type="datetime-local"
                      value={relationValidTo}
                      onInput={(e) => onRelationValidToChange(e.currentTarget.value)}
                    />
                  </label>
                </div>

                {editKind === "update_assertion" && (
                  <div class="form-grid-3">
                    <label>
                      극성 (Polarity)
                      <select
                        value={relationPolarity}
                        onChange={(e) =>
                          onRelationPolarityChange(e.currentTarget.value as "affirmed" | "negated")
                        }
                      >
                        <option value="affirmed">긍정 주장 (Affirmed)</option>
                        <option value="negated">부정 주장 (Negated)</option>
                      </select>
                    </label>

                    <label>
                      상태 (Status)
                      <select
                        value={relationStatus}
                        onChange={(e) =>
                          onRelationStatusChange(
                            e.currentTarget.value as
                              | "accepted"
                              | "disputed"
                              | "superseded"
                              | "retracted"
                          )
                        }
                      >
                        <option value="accepted">수용됨 (Accepted)</option>
                        <option value="disputed">이의 제기 (Disputed)</option>
                        <option value="superseded">대체됨 (Superseded)</option>
                        <option value="retracted">철회됨 (Retracted)</option>
                      </select>
                    </label>

                    <label>
                      신뢰도 (Confidence)
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        value={relationConfidence}
                        onInput={(e) => onRelationConfidenceChange(e.currentTarget.value)}
                      />
                    </label>
                  </div>
                )}
              </fieldset>
            )}

            {/* 5. Merge Entities */}
            {editKind === "merge_entities" && (
              <fieldset class="curation-fieldset">
                <legend>엔터티 병합</legend>
                <div class="knowledge-merge-list">
                  <span>선택된 엔터티 ({selectedEntityIDs.length}개):</span>
                  {selectedEntityIDs.map((id) => (
                    <span class="merge-item-pill" key={id}>
                      {id}
                    </span>
                  ))}
                </div>
                <label>
                  유지할 엔터티 (Survivor ID)
                  <select
                    value={mergeSurvivorID}
                    onChange={(e) => onMergeSurvivorIDChange(e.currentTarget.value)}
                  >
                    {selectedEntityIDs.map((id) => (
                      <option value={id} key={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
              </fieldset>
            )}

            {/* 6. Split Entity */}
            {editKind === "split_entity" && (
              <fieldset class="curation-fieldset">
                <legend>엔터티 분리</legend>
                <label>
                  분리할 원본 엔터티
                  <input value={selectedEntityID} readOnly />
                </label>

                <div class="qualifiers-header">
                  <strong>새 엔터티 목록</strong>
                  <button class="button secondary small" type="button" onClick={onAddSplitEntity}>
                    + 새 엔터티 추가
                  </button>
                </div>

                {splitEntities.map((item, index) => (
                  <div class="split-entity-card" key={index}>
                    <div class="split-entity-head">
                      <span>새 엔터티 #{index + 1}</span>
                      {splitEntities.length > 2 && (
                        <button
                          type="button"
                          class="button danger small"
                          onClick={() => onRemoveSplitEntity(index)}
                        >
                          삭제
                        </button>
                      )}
                    </div>
                    <div class="form-grid-3">
                      <label>
                        ID
                        <input
                          value={item.id}
                          onInput={(e) => onUpdateSplitEntity(index, "id", e.currentTarget.value)}
                        />
                      </label>
                      <label>
                        유형
                        <input
                          value={item.class_key}
                          onInput={(e) =>
                            onUpdateSplitEntity(index, "class_key", e.currentTarget.value)
                          }
                        />
                      </label>
                      <label>
                        대표 이름
                        <input
                          value={item.canonical_name}
                          onInput={(e) =>
                            onUpdateSplitEntity(index, "canonical_name", e.currentTarget.value)
                          }
                        />
                      </label>
                    </div>
                  </div>
                ))}

                <h4>연결된 주장 재배치</h4>
                {assertionIDs.map((id) => {
                  const assignment = splitAssignments[id];
                  return (
                    <div class="split-assignment-row" key={id}>
                      <code>{id}</code>
                      <select
                        value={assignment?.side ?? "subject"}
                        onChange={(e) =>
                          onUpdateSplitAssignment(id, "side", e.currentTarget.value)
                        }
                      >
                        <option value="subject">Subject 변경</option>
                        <option value="object">Object 변경</option>
                      </select>
                      <select
                        value={assignment?.entity_id ?? splitEntities[0]?.id ?? ""}
                        onChange={(e) =>
                          onUpdateSplitAssignment(id, "entity_id", e.currentTarget.value)
                        }
                      >
                        {splitEntities.map((ent) => (
                          <option value={ent.id} key={ent.id}>
                            {ent.id || "(ID 미지정)"}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </fieldset>
            )}

            {/* 7 & 8. Retract / Restore Assertion */}
            {(editKind === "retract_assertion" || editKind === "restore_assertion") && (
              <fieldset class="curation-fieldset">
                <legend>{editKind === "retract_assertion" ? "주장 철회" : "주장 복원"}</legend>
                <label>
                  대상 Assertion ID
                  <input
                    value={currentAssertionID}
                    onInput={(e) => onEditAssertionIDChange(e.currentTarget.value)}
                    placeholder="assertion ID"
                  />
                </label>
              </fieldset>
            )}

            {/* 9 & 10. Resolve / Dismiss Conflict */}
            {(editKind === "resolve_conflict" || editKind === "dismiss_conflict") && (
              <fieldset class="curation-fieldset">
                <legend>{editKind === "resolve_conflict" ? "충돌 해결" : "충돌 기각"}</legend>
                <label>
                  Conflict ID
                  <input
                    value={conflictID}
                    onInput={(e) => onConflictIDChange(e.currentTarget.value)}
                    placeholder="conflict ID"
                  />
                </label>
              </fieldset>
            )}

            {/* 11. Pin Entity */}
            {editKind === "pin_entity" && (
              <fieldset class="curation-fieldset">
                <legend>엔터티 고정 설정</legend>
                <label>
                  대상 엔터티 ID
                  <input value={selectedEntityID} readOnly />
                </label>
                <div class="knowledge-pin-options">
                  <label class="radio-label">
                    <input
                      type="radio"
                      name="curation-pin-value"
                      checked={pinValue}
                      onChange={() => onPinValueChange(true)}
                    />
                    고정 (Pinned)
                  </label>
                  <label class="radio-label">
                    <input
                      type="radio"
                      name="curation-pin-value"
                      checked={!pinValue}
                      onChange={() => onPinValueChange(false)}
                    />
                    고정 해제
                  </label>
                </div>
              </fieldset>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}
