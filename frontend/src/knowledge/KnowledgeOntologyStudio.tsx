import type { KnowledgeRecord, KnowledgeStatus } from "../knowledge-types";
import { KNOWLEDGE_MAX_IMPORT_BYTES } from "../knowledge-types";

export type KnowledgeOntologyStudioProps = {
  status: KnowledgeStatus | null;
  projectID: string;
  busy: string;
  ontologyFile: File | null;
  onOntologyFileChange: (file: File | null) => void;
  onImportOntology: (e: Event) => void;
  schemaDraftName: string;
  onSchemaDraftNameChange: (val: string) => void;
  schemaDraft: string;
  onSchemaDraftChange: (val: string) => void;
  onImportSchemaDraft: (e: Event) => void;
  ontologyPreview: KnowledgeRecord | null;
  versionID: string;
  onVersionIDChange: (val: string) => void;
  onActivateOntology: (id?: string) => void;
  canActivateOntology: boolean;
  onSelectVersion: (version: KnowledgeRecord) => void;
};

const PREFIX_PRESETS = [
  { label: "@prefix project:", value: "@prefix project: <urn:aetherops:project:> .\n" },
  { label: "@prefix rdfs:", value: "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n" },
  { label: "@prefix owl:", value: "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n" },
  { label: "@prefix xsd:", value: "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n" }
];

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is KnowledgeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ontologyVersions(status: KnowledgeStatus | null): KnowledgeRecord[] {
  if (!status) return [];
  const values = status.ontology_versions ?? status.ontologyVersions;
  return Array.isArray(values) ? values.filter(isRecord) : [];
}

function activeOntologyVersion(status: KnowledgeStatus | null): string {
  return text(status?.active_ontology_version_id) ?? text(status?.activeOntologyVersionID) ?? "";
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

function JsonBlock({ value, empty = "정보가 없습니다." }: { value: unknown; empty?: string }) {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
    return <p class="knowledge-muted">{empty}</p>;
  }
  return <pre class="knowledge-json">{pretty(value)}</pre>;
}

export function KnowledgeOntologyStudio({
  status,
  projectID,
  busy,
  ontologyFile,
  onOntologyFileChange,
  onImportOntology,
  schemaDraftName,
  onSchemaDraftNameChange,
  schemaDraft,
  onSchemaDraftChange,
  onImportSchemaDraft,
  ontologyPreview,
  versionID,
  onVersionIDChange,
  onActivateOntology,
  canActivateOntology,
  onSelectVersion
}: KnowledgeOntologyStudioProps) {
  const isImporting = busy === "import";
  const isSchemaImporting = busy === "schema-import";
  const isActivating = busy === "activate";
  const versions = ontologyVersions(status);
  const activeVersion = activeOntologyVersion(status);

  function insertPrefix(prefixText: string) {
    if (schemaDraft.includes(prefixText.trim())) return;
    onSchemaDraftChange(prefixText + schemaDraft);
  }

  return (
    <section class="panel knowledge-tool-card ontology-studio-card" aria-label="온톨로지 및 스키마 관리">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Ontology Lifecycle & Schema Management</p>
          <h2>온톨로지 & 스키마 관리</h2>
        </div>

        <div class="ontology-head-stats">
          <span class="version-stat-badge">
            활성 버전: <strong>{activeVersion || "기본 (Default)"}</strong>
          </span>
          <span class="count-badge">버전 {versions.length}개</span>
        </div>
      </div>

      <div class="ontology-grid">
        {/* Left Column: Import File & Schema Editor */}
        <div class="ontology-left-col">
          {/* 1. File Upload Section */}
          <div class="ontology-card-section">
            <div class="card-section-head">
              <h3>RDF/OWL 온톨로지 파일 가져오기</h3>
              <small>.ttl, .jsonld, .rdf, .owl</small>
            </div>
            <form onSubmit={onImportOntology} class="knowledge-import-form">
              <label for="knowledge-ontology-file" class="sr-only">
                온톨로지 파일 선택
              </label>
              <input
                id="knowledge-ontology-file"
                type="file"
                accept=".ttl,.jsonld,.rdf,.owl,text/turtle,application/rdf+xml,application/ld+json"
                onChange={(e) => onOntologyFileChange(e.currentTarget.files?.[0] ?? null)}
              />
              <div class="file-status-row">
                <span>
                  {ontologyFile
                    ? `${ontologyFile.name} · ${(ontologyFile.size / 1024).toFixed(1)} KiB`
                    : `최대 ${Math.round(KNOWLEDGE_MAX_IMPORT_BYTES / 1024 / 1024)} MiB`}
                </span>
                <button
                  class="button small"
                  type="submit"
                  disabled={!ontologyFile || isImporting}
                >
                  {isImporting ? "가져오는 중…" : "파일 가져오기"}
                </button>
              </div>
            </form>
          </div>

          {/* 2. Turtle Schema Interactive Editor */}
          <div class="ontology-card-section">
            <div class="card-section-head">
              <h3>프로젝트 스키마 편집 (Turtle/RDFS)</h3>
              <small>구조 정의 및 온톨로지 Draft 생성</small>
            </div>

            <form onSubmit={onImportSchemaDraft} class="schema-draft-form">
              <div class="schema-draft-name-row">
                <label for="knowledge-schema-name">Draft 스키마 이름</label>
                <input
                  id="knowledge-schema-name"
                  value={schemaDraftName}
                  onInput={(e) => onSchemaDraftNameChange(e.currentTarget.value)}
                  placeholder="예: engineering-v2-draft"
                />
              </div>

              {/* Quick Prefix Inserters */}
              <div class="prefix-presets-row">
                <span>빠른 접두사:</span>
                {PREFIX_PRESETS.map((p) => (
                  <button
                    type="button"
                    key={p.label}
                    class="preset-chip"
                    onClick={() => insertPrefix(p.value)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              <div class="schema-code-wrapper">
                <label for="knowledge-schema-source" class="sr-only">
                  Turtle 스키마 소스 코드
                </label>
                <textarea
                  id="knowledge-schema-source"
                  class="knowledge-code-input schema-code-area"
                  value={schemaDraft}
                  onInput={(e) => onSchemaDraftChange(e.currentTarget.value)}
                  spellcheck={false}
                  rows={10}
                />
              </div>

              <div class="knowledge-form-footer">
                <span>RDFS/OWL 부분집합 검증 후 안전하게 draft로 등록됩니다.</span>
                <button
                  class="button small"
                  type="submit"
                  disabled={!schemaDraft.trim() || isSchemaImporting}
                >
                  {isSchemaImporting ? "검증 중…" : "검증하고 Draft 생성"}
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* Right Column: Preview, Versions & Activation */}
        <div class="ontology-right-col">
          {/* Validation Preview */}
          <div class="ontology-card-section">
            <div class="card-section-head">
              <h3>검증 미리보기</h3>
              <small>Triple · Term · Axiom 통계 및 SHA-256</small>
            </div>
            <JsonBlock
              value={ontologyPreview}
              empty="가져온 draft의 버전 ID, canonical SHA-256, triple·term·axiom 수가 여기에 표시됩니다."
            />
          </div>

          {/* Version Control & Activation */}
          <div class="ontology-card-section">
            <div class="card-section-head">
              <h3>온톨로지 버전 활성화</h3>
              <small>프로젝트 전역 적용</small>
            </div>

            <div class="knowledge-version-control">
              <input
                id="knowledge-version"
                value={versionID}
                onInput={(e) => onVersionIDChange(e.currentTarget.value)}
                placeholder="활성화할 버전 ID"
              />
              <button
                class="button secondary small"
                type="button"
                onClick={() => onActivateOntology()}
                disabled={!canActivateOntology || isActivating}
                title={
                  canActivateOntology
                    ? "검증된 project draft를 활성화"
                    : "이 프로젝트의 draft 버전만 활성화할 수 있습니다"
                }
              >
                {isActivating ? "활성화 중…" : "버전 활성화"}
              </button>
            </div>

            <h4 class="sub-heading">등록된 온톨로지 버전 목록</h4>
            {versions.length === 0 ? (
              <p class="knowledge-muted">등록된 온톨로지 버전이 없습니다.</p>
            ) : (
              <div class="knowledge-version-list">
                {versions.map((ver, index) => {
                  const id = text(ver.id) ?? text(ver.version_id) ?? `version-${index + 1}`;
                  const isActive = id === activeVersion;
                  const isSelected = id === versionID;

                  return (
                    <button
                      type="button"
                      key={id}
                      class={`version-card ${isActive ? "active" : ""} ${
                        isSelected ? "selected" : ""
                      }`}
                      onClick={() => onSelectVersion(ver)}
                    >
                      <div class="version-card-head">
                        <strong>{text(ver.semantic_version) ?? text(ver.label) ?? id}</strong>
                        <span class={`version-badge ${isActive ? "active" : ""}`}>
                          {isActive ? "✓ 활성" : text(ver.state) ?? "대기"}
                        </span>
                      </div>
                      <small class="version-id">{id}</small>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
