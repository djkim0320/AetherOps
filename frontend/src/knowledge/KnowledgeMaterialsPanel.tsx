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
  const isUploading = busy === "material-upload";

  return (
    <section class="panel knowledge-tool-card materials-panel-card" aria-label="프로젝트 자료 및 지식 채택">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Pinned Project Context</p>
          <h2>프로젝트 자료 및 지식 채택 (Materials & Graph Adopt)</h2>
        </div>
      </div>

      <div class="materials-grid">
        {/* Left Column: Upload New Material */}
        <div class="material-upload-section">
          <h3>새 프로젝트 자료 고정</h3>
          <p class="section-desc">
            문서나 데이터 파일을 프로젝트 기억(RAG)에 고정하고, 지식 그래프 추출 대상으로 채택할 수
            있습니다.
          </p>

          <form class="knowledge-material-form" onSubmit={onUploadMaterial}>
            <label for="knowledge-material-title">자료 표시 이름 (선택)</label>
            <input
              id="knowledge-material-title"
              value={materialTitle}
              onInput={(e) => onMaterialTitleChange(e.currentTarget.value)}
              placeholder="비워 두면 파일명을 사용합니다"
            />

            <label for="knowledge-material-file">자료 파일 선택</label>
            <input
              id="knowledge-material-file"
              type="file"
              onChange={(e) => onMaterialFileChange(e.currentTarget.files?.[0] ?? null)}
            />

            <label class="knowledge-checkbox-row">
              <input
                type="checkbox"
                checked={materialGraphAdopt}
                onChange={(e) => onMaterialGraphAdoptChange(e.currentTarget.checked)}
              />
              <span>지식 그래프 채택 대상으로 표시 (Graph Adopt)</span>
            </label>

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
                {isUploading ? "고정 중…" : "자료 고정"}
              </button>
            </div>
          </form>
        </div>

        {/* Right Column: Material List */}
        <div class="material-list-section">
          <div class="section-title-row">
            <h3>고정된 프로젝트 자료 목록</h3>
            <span class="count-badge">{materials?.length ?? 0}</span>
          </div>

          <div class="knowledge-material-list">
            {materials === null ? (
              <p class="knowledge-muted">자료 목록을 불러오는 중입니다…</p>
            ) : materials.length === 0 ? (
              <p class="knowledge-muted">고정된 프로젝트 자료가 없습니다.</p>
            ) : (
              materials.map((material, index) => {
                const id = text(material.id) ?? text(material.material_id) ?? `material-${index + 1}`;
                const isToggling = busy === `material-adopt-${id}`;
                const isDeleting = busy === `material-delete-${id}`;

                return (
                  <article class="material-card-item" key={id}>
                    <div class="material-info">
                      <strong>{material.title || id}</strong>
                      <div class="material-meta-row">
                        <span class="material-media-type">{material.media_type || "unknown"}</span>
                        {number(material.size) !== undefined && (
                          <span class="material-size">
                            {(number(material.size)! / 1024).toFixed(1)} KB
                          </span>
                        )}
                        {material.graph_adopt && (
                          <span class="material-adopt-tag">✓ Graph Adopt</span>
                        )}
                      </div>
                    </div>

                    <div class="material-actions">
                      <button
                        type="button"
                        class={`button small ${material.graph_adopt ? "adopt-active" : "secondary"}`}
                        onClick={() => onToggleMaterialAdopt(material)}
                        disabled={Boolean(busy)}
                      >
                        {isToggling
                          ? "…"
                          : material.graph_adopt
                          ? "✓ 채택됨"
                          : "채택 켜기"}
                      </button>
                      <button
                        type="button"
                        class="button danger-outline small"
                        onClick={() => onRemoveMaterial(material)}
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
