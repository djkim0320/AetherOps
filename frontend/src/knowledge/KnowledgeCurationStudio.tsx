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
          <p class="eyebrow">Evidence-backed Change</p>
          <h2>구조화 편집 (Curation Studio)</h2>
        </div>
      </div>

      <form class="knowledge-edit-form" onSubmit={onSubmitEdit}>
        {mode === "ontology" && (
          <div class="alert warning knowledge-form-warning">
            온톨로지 구조는 온톨로지 & 스키마 탭에서 작성하세요. 인스턴스 curation은 Instance
            모드에서만 제출할 수 있습니다.
          </div>
        )}

        <div class="curation-kind-selector">
          <label for="knowledge-edit-kind">편집 작업 선택</label>
          <select
            id="knowledge-edit-kind"
            value={editKind}
            onChange={(e) => onChooseEditKind(e.currentTarget.value as KnowledgeEditKind)}
          >
            {(Object.keys(EDIT_KIND_LABELS) as KnowledgeEditKind[]).map((kind) => (
              <option value={kind} key={kind}>
                {EDIT_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </div>

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
                rows={2}
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
              <h4>한정자 (Qualifiers)</h4>
              <button
                class="button secondary small"
                type="button"
                onClick={onAddRelationQualifier}
              >
                + 추가
              </button>
            </div>

            {relationQualifiers.length === 0 ? (
              <p class="knowledge-form-hint">조건이나 환경 메타데이터가 필요할 때 한정자를 추가하세요.</p>
            ) : (
              <div class="knowledge-qualifier-list">
                {relationQualifiers.map((item, index) => (
                  <article class="qualifier-box" key={item.id}>
                    <div class="qualifier-head">
                      <strong>Qualifier {index + 1}</strong>
                      <button
                        class="button text small"
                        type="button"
                        onClick={() => onRemoveRelationQualifier(item.id)}
                      >
                        제거
                      </button>
                    </div>
                    <div class="form-grid-2">
                      <label>
                        Predicate
                        <input
                          value={item.predicate}
                          onInput={(e) =>
                            onUpdateRelationQualifier(item.id, { predicate: e.currentTarget.value })
                          }
                        />
                      </label>
                      <label>
                        값 유형
                        <select
                          value={item.value_kind}
                          onChange={(e) =>
                            onUpdateRelationQualifier(item.id, {
                              value_kind: e.currentTarget.value as "entity" | "literal"
                            })
                          }
                        >
                          <option value="entity">엔터티</option>
                          <option value="literal">Typed Literal</option>
                        </select>
                      </label>
                    </div>
                    {item.value_kind === "entity" ? (
                      <label>
                        엔터티 ID
                        <input
                          list="knowledge-entity-options"
                          value={item.entity_id}
                          onInput={(e) =>
                            onUpdateRelationQualifier(item.id, { entity_id: e.currentTarget.value })
                          }
                        />
                      </label>
                    ) : (
                      <div class="knowledge-literal-grid">
                        <label>
                          원문 값
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
                            list="knowledge-datatype-options"
                            value={item.literal.datatype}
                            onInput={(e) =>
                              onUpdateQualifierLiteral(item.id, "datatype", e.currentTarget.value)
                            }
                          />
                        </label>
                        <label>
                          언어
                          <input
                            value={item.literal.language}
                            onInput={(e) =>
                              onUpdateQualifierLiteral(item.id, "language", e.currentTarget.value)
                            }
                          />
                        </label>
                        <label>
                          단위
                          <input
                            value={item.literal.unit}
                            onInput={(e) =>
                              onUpdateQualifierLiteral(item.id, "unit", e.currentTarget.value)
                            }
                          />
                        </label>
                        <label>
                          SI 값
                          <input
                            value={item.literal.si_value}
                            onInput={(e) =>
                              onUpdateQualifierLiteral(item.id, "si_value", e.currentTarget.value)
                            }
                          />
                        </label>
                        <label>
                          SI 단위
                          <input
                            value={item.literal.si_unit}
                            onInput={(e) =>
                              onUpdateQualifierLiteral(item.id, "si_unit", e.currentTarget.value)
                            }
                          />
                        </label>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}

            <div class="form-grid-2">
              <label>
                유효 시작 시점
                <input
                  type="datetime-local"
                  value={relationValidFrom}
                  onInput={(e) => onRelationValidFromChange(e.currentTarget.value)}
                />
              </label>
              <label>
                유효 종료 시점
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
                  Polarity
                  <select
                    value={relationPolarity}
                    onChange={(e) =>
                      onRelationPolarityChange(e.currentTarget.value as "affirmed" | "negated")
                    }
                  >
                    <option value="affirmed">affirmed</option>
                    <option value="negated">negated</option>
                  </select>
                </label>
                <label>
                  Status
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
                    <option value="accepted">accepted</option>
                    <option value="disputed">disputed</option>
                    <option value="superseded">superseded</option>
                    <option value="retracted">retracted</option>
                  </select>
                </label>
                <label>
                  Confidence
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
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
            <legend>선택된 {selectedEntityIDs.length}개 엔터티 병합</legend>
            {selectedNodes.length < 2 ? (
              <div class="alert warning knowledge-form-warning">
                그래프 또는 목록에서 엔터티를 둘 이상 선택하세요.
              </div>
            ) : (
              <>
                <label>
                  유지할 대표 엔터티 (Survivor)
                  <select
                    value={mergeSurvivorID}
                    onChange={(e) => onMergeSurvivorIDChange(e.currentTarget.value)}
                  >
                    {selectedNodes.map((node) => (
                      <option value={node.id} key={node.id}>
                        {node.label} · {node.id}
                      </option>
                    ))}
                  </select>
                </label>
                <div class="knowledge-merge-list">
                  <span>병합될 엔터티 목록:</span>
                  {selectedNodes
                    .filter((node) => node.id !== mergeSurvivorID)
                    .map((node) => (
                      <span class="merge-item-pill" key={node.id}>
                        {node.label} ({node.id})
                      </span>
                    ))}
                </div>
              </>
            )}
          </fieldset>
        )}

        {/* 6. Split Entity */}
        {editKind === "split_entity" && (
          <fieldset class="curation-fieldset">
            <legend>{selectedNode?.label || selectedEntityID || "원본 엔터티"} 분리 초안</legend>
            {entityAssertionsMayBeTruncated && (
              <div class="alert danger knowledge-form-warning" role="alert">
                연결 주장 전체 중 {embeddedAssertionsCount}개만 응답에 포함되었습니다. 모든 주장을
                배치할 수 없어 분리를 차단합니다.
              </div>
            )}
            <div class="knowledge-split-entities">
              {splitEntities.map((item, index) => (
                <article class="split-entity-card" key={`${item.id}-${index}`}>
                  <div class="split-entity-head">
                    <strong>새 분할 엔터티 {index + 1}</strong>
                    <button
                      class="button text small"
                      type="button"
                      onClick={() => onRemoveSplitEntity(index)}
                      disabled={splitEntities.length <= 2}
                    >
                      제거
                    </button>
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
                        onInput={(e) => onUpdateSplitEntity(index, "class_key", e.currentTarget.value)}
                      />
                    </label>
                    <label>
                      이름
                      <input
                        value={item.canonical_name}
                        onInput={(e) =>
                          onUpdateSplitEntity(index, "canonical_name", e.currentTarget.value)
                        }
                        placeholder="새 이름"
                      />
                    </label>
                  </div>
                </article>
              ))}
            </div>
            <button
              class="button secondary small"
              type="button"
              onClick={onAddSplitEntity}
            >
              + 새 분할 엔터티 추가
            </button>

            <h4 class="sub-heading">주장 이동 대상 배치</h4>
            {assertionIDs.length === 0 ? (
              <p class="knowledge-form-warning">원본에 연결된 주장을 먼저 불러오세요.</p>
            ) : (
              <div class="knowledge-split-assignments">
                {assertionIDs.map((id) => (
                  <article class="split-assignment-row" key={id}>
                    <code>{id}</code>
                    <label>
                      방향
                      <select
                        value={splitAssignments[id]?.side ?? "subject"}
                        onChange={(e) => onUpdateSplitAssignment(id, "side", e.currentTarget.value)}
                      >
                        <option value="subject">subject</option>
                        <option value="object">object</option>
                      </select>
                    </label>
                    <label>
                      이동 대상
                      <select
                        value={splitAssignments[id]?.entity_id ?? ""}
                        onChange={(e) =>
                          onUpdateSplitAssignment(id, "entity_id", e.currentTarget.value)
                        }
                      >
                        <option value="">선택</option>
                        {splitEntities.map((item) => (
                          <option value={item.id} key={item.id}>
                            {item.canonical_name || item.id}
                          </option>
                        ))}
                      </select>
                    </label>
                  </article>
                ))}
              </div>
            )}
          </fieldset>
        )}

        {/* 7 & 8. Retract / Restore Assertion */}
        {(editKind === "retract_assertion" || editKind === "restore_assertion") && (
          <fieldset class="curation-fieldset">
            <legend>{editKind === "retract_assertion" ? "철회할 주장" : "복원할 주장"}</legend>
            <label>
              Assertion ID
              <input
                list="knowledge-assertion-options"
                value={currentAssertionID}
                onInput={(e) => onEditAssertionIDChange(e.currentTarget.value)}
                placeholder="assertion ID"
              />
            </label>
            <datalist id="knowledge-assertion-options">
              {assertionIDs.map((id) => (
                <option value={id} key={id} />
              ))}
            </datalist>
          </fieldset>
        )}

        {/* 9 & 10. Resolve / Dismiss Conflict */}
        {(editKind === "resolve_conflict" || editKind === "dismiss_conflict") && (
          <fieldset class="curation-fieldset">
            <legend>{editKind === "resolve_conflict" ? "충돌 해결 승인" : "충돌 기각 승인"}</legend>
            <label>
              Conflict ID
              <input
                list="knowledge-conflict-options"
                value={conflictID}
                onInput={(e) => onConflictIDChange(e.currentTarget.value)}
                placeholder="conflict ID"
              />
            </label>
            <datalist id="knowledge-conflict-options">
              {conflictIDs.map((id) => (
                <option value={id} key={id} />
              ))}
            </datalist>
          </fieldset>
        )}

        {/* 11. Pin Entity */}
        {editKind === "pin_entity" && (
          <fieldset class="curation-fieldset">
            <legend>엔터티 고정 상태 설정</legend>
            <label>
              엔터티 ID
              <input value={selectedEntityID} readOnly placeholder="그래프에서 선택" />
            </label>
            <p class="knowledge-form-hint">
              현재 상태: {(entity?.pinned ?? selectedNode?.pinned) === true ? "고정됨" : "고정 안 됨"}
            </p>
            <div class="knowledge-pin-options">
              <label class="radio-label">
                <input
                  type="radio"
                  name="curation-pin"
                  checked={pinValue}
                  onChange={() => onPinValueChange(true)}
                />
                고정
              </label>
              <label class="radio-label">
                <input
                  type="radio"
                  name="curation-pin"
                  checked={!pinValue}
                  onChange={() => onPinValueChange(false)}
                />
                고정 해제
              </label>
            </div>
          </fieldset>
        )}

        {/* Evidence & Memo Requirements */}
        <fieldset class="curation-fieldset knowledge-evidence-editor">
          <legend>필수 근거 (Evidence & Memo)</legend>
          <label for="curation-evidence-handles">
            Evidence Handles (쉼표 또는 줄바꿈 구분)
            <input
              id="curation-evidence-handles"
              value={editEvidenceText}
              onInput={(e) => onEditEvidenceTextChange(e.currentTarget.value)}
              placeholder="예: evid_1, evid_2"
            />
          </label>

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

          <label for="curation-edit-memo">
            새 고정 메모
            <textarea
              id="curation-edit-memo"
              value={editMemo}
              onInput={(e) => onEditMemoChange(e.currentTarget.value)}
              placeholder="판단의 근거와 변경 이유를 상세히 기록하세요."
              rows={2}
            />
          </label>
          <p class="knowledge-form-hint">
            기존 evidence handle 또는 새 메모가 반드시 필요합니다. 새 메모는 서버가 CAS에 고정하고
            정확한 span·chunk를 검증한 뒤 근거로 채택합니다.
          </p>
        </fieldset>

        {/* Footer */}
        <div class="knowledge-form-footer">
          <span>append-only curation 기록 후 shadow graph를 검증·교체합니다.</span>
          <button
            class="button"
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
        </div>
      </form>
    </section>
  );
}
