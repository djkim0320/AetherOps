import { useState } from "preact/hooks";
import type { KnowledgeMaterial } from "../knowledge-types";
import { KNOWLEDGE_MAX_IMPORT_BYTES } from "../knowledge-types";

export type KnowledgeMaterialsPanelProps = {
  materials: KnowledgeMaterial[] | null;
  materialFile: File | null;
  onMaterialFileChange: (file: File | null) => void;
  materialTitle: string;
  onMaterialTitleChange: (val: string) => void;
  materialGraphAdopt: boolean;
  onMaterialGraphAdoptChange: (val: boolean) => void;
  onUploadMaterial: (e: Event) => void;
  onToggleMaterialAdopt: (m: KnowledgeMaterial) => void;
  onRemoveMaterial: (m: KnowledgeMaterial) => void;
  busy: string;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getMediaTypeBadge(type?: string): string {
  if (!type) return "FILE";
  const t = type.toLowerCase();
  if (t.includes("pdf")) return "PDF";
  if (t.includes("markdown") || t.includes("md")) return "MD";
  if (t.includes("json")) return "JSON";
  if (t.includes("text") || t.includes("plain")) return "TXT";
  if (t.includes("csv")) return "CSV";
  return "DOC";
}

export function KnowledgeMaterialsPanel({
  materials,
  materialFile,
  onMaterialFileChange,
  materialTitle,
  onMaterialTitleChange,
  materialGraphAdopt,
  onMaterialGraphAdoptChange,
  onUploadMaterial,
  onToggleMaterialAdopt,
  onRemoveMaterial,
  busy
}: KnowledgeMaterialsPanelProps) {
  const [searchFilter, setSearchFilter] = useState("");
  const isUploading = busy === "material-upload";

  const adoptedCount = materials?.filter((m) => m.graph_adopt).length ?? 0;
  const filteredMaterials = (materials ?? []).filter((m) => {
    const q = searchFilter.toLowerCase().trim();
    if (!q) return true;
    const title = (m.title || m.id || "").toLowerCase();
    const media = (m.media_type || "").toLowerCase();
    return title.includes(q) || media.includes(q);
  });

  return (
    <section class="panel knowledge-tool-card materials-panel-card" aria-label="프로젝트 자료 관리">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Project Sources</p>
          <h2>프로젝트 자료</h2>
        </div>

        <div class="materials-head-stats">
          <span class="version-stat-badge">
            지식에 반영: <strong>{adoptedCount}개</strong>
          </span>
          <span class="count-badge">총 자료 {materials?.length ?? 0}개</span>
        </div>
      </div>

      <div class="materials-grid">
        {/* Left Column: Upload New Material Form */}
        <div class="material-upload-section">
          <div class="card-section-head">
            <h3>새 자료 추가</h3>
            <small>검색과 지식 정리에 사용할 원본</small>
          </div>
          <p class="section-desc">
            보고서나 데이터 파일을 프로젝트에 보관하고, 필요한 자료만 검증된 지식과 관계를 만드는 데
            사용하도록 선택할 수 있습니다. SU2 격자와 설정 파일은 연구 계획에서 해석 입력으로 선택할 수
            있습니다.
          </p>

          <form class="knowledge-material-form" onSubmit={onUploadMaterial}>
            <label for="knowledge-material-title">자료 표시 이름 (선택)</label>
            <input
              id="knowledge-material-title"
              value={materialTitle}
              onInput={(e) => onMaterialTitleChange(e.currentTarget.value)}
              placeholder="비워 둘 경우 원본 파일명을 사용합니다"
            />

            <label for="knowledge-material-file">자료 파일 선택 (PDF, TXT, MD, JSON, CSV, SU2, CFG)</label>
            <input
              id="knowledge-material-file"
              type="file"
              onChange={(e) => onMaterialFileChange(e.currentTarget.files?.[0] ?? null)}
            />

            <div class="material-adopt-card">
              <label class="knowledge-checkbox-row">
                <input
                  type="checkbox"
                  checked={materialGraphAdopt}
                  onChange={(e) => onMaterialGraphAdoptChange(e.currentTarget.checked)}
                />
                <strong>이 자료를 프로젝트 지식에 반영</strong>
              </label>
              <small>
                체크하면 연구가 이 문서에서 주요 대상과 관계를 추출하고, 검토를 거쳐 프로젝트 지식에
                반영합니다.
              </small>
            </div>

            <div class="knowledge-form-footer">
              <span>
                {materialFile
                  ? `${materialFile.name} · ${(materialFile.size / 1024).toFixed(1)} KiB`
                  : `최대 ${Math.round(KNOWLEDGE_MAX_IMPORT_BYTES / 1024 / 1024)} MiB`}
              </span>
              <button
                class="button small"
                type="submit"
                disabled={!materialFile || isUploading}
              >
                {isUploading ? "추가 및 처리 중…" : "자료 추가"}
              </button>
            </div>
          </form>
        </div>

        {/* Right Column: Material List */}
        <div class="material-list-section">
          <div class="section-title-row">
            <h3>프로젝트 자료 목록</h3>
            <span class="count-badge">{filteredMaterials.length}/{materials?.length ?? 0}</span>
          </div>

          <div class="materials-search-row">
            <input
              type="search"
              class="materials-search-input"
              value={searchFilter}
              onInput={(e) => setSearchFilter(e.currentTarget.value)}
              placeholder="자료 제목, 형식 검색…"
            />
          </div>

          <div class="knowledge-material-list">
            {materials === null ? (
              <p class="knowledge-muted">자료 목록을 불러오는 중입니다…</p>
            ) : filteredMaterials.length === 0 ? (
              <p class="knowledge-muted">
                {searchFilter ? "일치하는 자료가 없습니다." : "추가된 프로젝트 자료가 없습니다."}
              </p>
            ) : (
              filteredMaterials.map((material, index) => {
                const id = text(material.id) ?? text(material.material_id) ?? `material-${index + 1}`;
                const isToggling = busy === `material-adopt-${id}`;
                const isDeleting = busy === `material-delete-${id}`;
                const mediaBadge = getMediaTypeBadge(material.media_type);

                return (
                  <article class="material-card-item" key={id}>
                    <div class="material-info">
                      <div class="material-title-row">
                        <span class="media-type-pill">{mediaBadge}</span>
                        <strong>{material.title || id}</strong>
                      </div>

                      <div class="material-meta-row">
                        <span>{material.media_type || "unknown"}</span>
                        {number(material.size) !== undefined && (
                          <span class="material-size">
                            {(number(material.size)! / 1024).toFixed(1)} KB
                          </span>
                        )}
                        {material.graph_adopt && (
                          <span class="material-adopt-tag">지식에 반영</span>
                        )}
                      </div>
                    </div>

                    <div class="material-actions">
                      <button
                        type="button"
                        class={`button small ${material.graph_adopt ? "adopt-active" : "secondary"}`}
                        onClick={() => onToggleMaterialAdopt(material)}
                        disabled={Boolean(busy)}
                        title={material.graph_adopt ? "지식 반영 대상에서 제외" : "지식 반영 대상으로 지정"}
                      >
                        {isToggling
                          ? "…"
                          : material.graph_adopt
                          ? "✓ 채택됨"
                          : "지식에 반영"}
                      </button>
                      <button
                        type="button"
                        class="button danger small"
                        onClick={() => {
                          if (window.confirm(`자료 "${material.title || id}"을(를) 영구 삭제할까요?`)) {
                            onRemoveMaterial(material);
                          }
                        }}
                        disabled={Boolean(busy)}
                      >
                        {isDeleting ? "…" : "삭제"}
                      </button>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
