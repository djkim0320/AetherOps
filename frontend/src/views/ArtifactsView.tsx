import { useMemo, useState } from "preact/hooks";
import { artifactPresentation } from "../artifact-presentation";
import { FormattedMessage } from "../components/FormattedMessage";
import { artifactFormattedText, artifactRawText } from "../artifact-content";
import type { Artifact, Run } from "../types";
import { STATUS_LABELS } from "../types";

export type ArtifactsViewProps = {
  runs?: Run[] | null;
  activeRun: Run | null;
  selectedRunID?: string;
  onSelectRunID?: (id: string) => void;
  artifacts: Artifact[] | null;
  selectedArtifactID: string;
  onSelectArtifact: (artifact: Artifact) => void;
  artifactContent: unknown;
  busy: string | null;
  formatDate: (val: unknown) => string;
};

export function ArtifactsView({
  runs,
  activeRun,
  selectedRunID,
  onSelectRunID,
  artifacts,
  selectedArtifactID,
  onSelectArtifact,
  artifactContent,
  busy,
  formatDate
}: ArtifactsViewProps) {
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [searchFilter, setSearchFilter] = useState<string>("");
  const [sortBy, setSortBy] = useState<"newest" | "kind" | "adopted">("newest");
  const [viewMode, setViewMode] = useState<"formatted" | "raw">("formatted");
  const [copied, setCopied] = useState(false);

  const selectedArtifact =
    artifacts?.find((a) => a.id === selectedArtifactID) ?? artifacts?.[0] ?? null;
  const presentation = selectedArtifact ? artifactPresentation(selectedArtifact.kind) : null;

  const rawText = useMemo(() => artifactRawText(artifactContent), [artifactContent]);
  const formattedText = useMemo(
    () => artifactFormattedText(selectedArtifact?.kind ?? "", artifactContent),
    [selectedArtifact, artifactContent]
  );

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(rawText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  }

  function handleDownload() {
    if (!selectedArtifact || !rawText) return;
    const blob = new Blob([rawText], {
      type: viewMode === "raw" ? "application/json" : "text/markdown"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedArtifact.id}-${selectedArtifact.kind}.${
      viewMode === "raw" ? "json" : "md"
    }`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Filter & Sort
  const filteredArtifacts = useMemo(() => {
    if (!artifacts) return [];
    let list = artifacts.filter((artifact) => {
      const p = artifactPresentation(artifact.kind);
      const matchesKind =
        kindFilter === "all" || artifact.kind.toLowerCase().includes(kindFilter.toLowerCase());
      const q = searchFilter.toLowerCase().trim();
      const matchesSearch =
        !q ||
        p.title.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        artifact.kind.toLowerCase().includes(q) ||
        artifact.id.toLowerCase().includes(q);
      return matchesKind && matchesSearch;
    });

    if (sortBy === "newest") {
      list = list.sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime());
    } else if (sortBy === "kind") {
      list = list.sort((a, b) => a.kind.localeCompare(b.kind));
    } else if (sortBy === "adopted") {
      list = list.sort((a, b) => (b.adopted ? 1 : 0) - (a.adopted ? 1 : 0));
    }
    return list;
  }, [artifacts, kindFilter, searchFilter, sortBy]);

  const reportCount = artifacts?.filter((a) => a.kind.includes("report")).length ?? 0;
  const evidenceCount = artifacts?.filter((a) => a.kind.includes("evidence")).length ?? 0;
  const reviewCount =
    artifacts?.filter((a) => a.kind.includes("review") || a.kind.includes("verification")).length ?? 0;

  return (
    <div class="artifact-layout" aria-label="연구 산출물 화면">
      {/* Left Column: Artifacts List, Runs Switcher, and Filters */}
      <section class="panel artifact-list-panel">
        {/* Header & Run Selector */}
        <div class="panel-heading artifact-list-head">
          <div>
            <p class="eyebrow">
              {activeRun ? STATUS_LABELS[activeRun.status] ?? activeRun.status : "실행 산출물"}
            </p>
            <h2>보고서 · 근거 · 리뷰</h2>
          </div>
          <span class="count-badge">{artifacts?.length ?? 0}</span>
        </div>

        {/* Run Selector (if multiple runs exist in session) */}
        {runs && runs.length > 1 && onSelectRunID && (
          <div class="artifact-run-selector-row">
            <label for="artifact-run-select">실행 선택:</label>
            <select
              id="artifact-run-select"
              value={selectedRunID ?? activeRun?.id ?? ""}
              onChange={(e) => onSelectRunID(e.currentTarget.value)}
            >
              {runs.map((r, idx) => (
                <option value={r.id} key={r.id}>
                  실행 #{runs.length - idx}: {STATUS_LABELS[r.status] ?? r.status} (
                  {formatDate(r.created_at)})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Filter & Search Toolbar */}
        <div class="artifact-filter-toolbar">
          <div class="artifact-search-row">
            <input
              type="search"
              class="artifact-search-input"
              placeholder="산출물 제목, 설명, 식별자 검색…"
              value={searchFilter}
              onInput={(e) => setSearchFilter(e.currentTarget.value)}
            />
            <select
              class="artifact-sort-select"
              value={sortBy}
              onChange={(e) => setSortBy(e.currentTarget.value as typeof sortBy)}
            >
              <option value="newest">최신순</option>
              <option value="kind">종류순</option>
              <option value="adopted">채택 여부순</option>
            </select>
          </div>

          <div class="artifact-kind-chips">
            <button
              type="button"
              class={`filter-chip ${kindFilter === "all" ? "active" : ""}`}
              onClick={() => setKindFilter("all")}
            >
              전체 ({artifacts?.length ?? 0})
            </button>
            <button
              type="button"
              class={`filter-chip ${kindFilter === "report" ? "active" : ""}`}
              onClick={() => setKindFilter("report")}
            >
              보고서 ({reportCount})
            </button>
            <button
              type="button"
              class={`filter-chip ${kindFilter === "evidence" ? "active" : ""}`}
              onClick={() => setKindFilter("evidence")}
            >
              근거 ({evidenceCount})
            </button>
            <button
              type="button"
              class={`filter-chip ${kindFilter === "review" ? "active" : ""}`}
              onClick={() => setKindFilter("review")}
            >
              리뷰 ({reviewCount})
            </button>
          </div>
        </div>

        {/* List Content */}
        {!activeRun && (!artifacts || artifacts.length === 0) ? (
          <div class="empty-state">
            <strong>실행을 선택하세요</strong>
            <span>대화 및 연구 화면에서 실행을 선택하면 관련 산출물을 확인할 수 있습니다.</span>
          </div>
        ) : artifacts === null ? (
          <div class="empty-state">
            <strong>산출물을 불러오는 중입니다…</strong>
            <span>실행에 연결된 자료를 확인하고 있습니다.</span>
          </div>
        ) : filteredArtifacts.length === 0 ? (
          <div class="empty-state">
            <strong>
              {searchFilter || kindFilter !== "all"
                ? "일치하는 산출물이 없습니다"
                : "아직 산출물이 없습니다"}
            </strong>
            <span>연구가 진행되면 보고서, 근거, 검증 리뷰가 여기에 추가됩니다.</span>
          </div>
        ) : (
          <div class="artifact-list">
            {filteredArtifacts.map((artifact) => {
              const p = artifactPresentation(artifact.kind);
              const isSelected = artifact.id === selectedArtifact?.id;

              return (
                <button
                  key={artifact.id}
                  class={`artifact-item ${isSelected ? "selected" : ""}`}
                  onClick={() => onSelectArtifact(artifact)}
                >
                  <span class={`artifact-kind ${p.tone}`}>{p.label}</span>
                  <span class="artifact-copy">
                    <span class="artifact-title-row">
                      <strong>{p.title}</strong>
                      {artifact.adopted && <span class="artifact-adopted-pill">✓ 채택됨</span>}
                    </span>
                    <small>{p.description}</small>
                    <em>
                      {formatDate(artifact.created_at)} · <code>{artifact.kind}</code>
                    </em>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Right Column: Artifact Viewer & Controls */}
      <section class="panel artifact-content-panel">
        <div class="panel-heading artifact-viewer-head">
          <div>
            <div class="artifact-viewer-tag-row">
              <span class={`artifact-kind ${presentation?.tone ?? "neutral"}`}>
                {presentation?.label ?? "산출물"}
              </span>
              {selectedArtifact?.adopted && (
                <span class="artifact-adopted-pill">✓ 공식 채택됨</span>
              )}
            </div>
            <h2>{presentation?.title ?? "산출물을 선택하세요"}</h2>
            {presentation?.description && (
              <p class="artifact-detail-description">{presentation.description}</p>
            )}
          </div>

          {selectedArtifact && (
            <div class="artifact-viewer-actions">
              <div class="view-mode-toggle">
                <button
                  type="button"
                  class={`toggle-btn ${viewMode === "formatted" ? "active" : ""}`}
                  onClick={() => setViewMode("formatted")}
                >
                  서식 보기
                </button>
                <button
                  type="button"
                  class={`toggle-btn ${viewMode === "raw" ? "active" : ""}`}
                  onClick={() => setViewMode("raw")}
                >
                  원문 (JSON/Raw)
                </button>
              </div>

              <button
                type="button"
                class="button secondary small"
                onClick={handleCopy}
                disabled={!rawText}
              >
                {copied ? "✓ 복사됨" : "복사"}
              </button>

              <button
                type="button"
                class="button secondary small"
                onClick={handleDownload}
                disabled={!rawText}
              >
                다운로드
              </button>
            </div>
          )}
        </div>

        {selectedArtifact && (
          <details class="artifact-technical-details">
            <summary>기술 메타데이터 및 무결성 정보</summary>
            <div class="artifact-tech-grid">
              <div>
                <span>종류</span>
                <code>{selectedArtifact.kind}</code>
              </div>
              <div>
                <span>식별자</span>
                <code>{selectedArtifact.id}</code>
              </div>
              <div>
                <span>생성 시각</span>
                <span>{formatDate(selectedArtifact.created_at)}</span>
              </div>
              <div>
                <span>채택 여부</span>
                <code>{selectedArtifact.adopted ? "채택됨 (Adopted)" : "일반"}</code>
              </div>
            </div>
          </details>
        )}

        <div class="artifact-content-body">
          {busy === "artifact" ? (
            <div class="empty-state">
              <strong>내용을 불러오는 중…</strong>
              <span>산출물 응답을 기다리고 있습니다.</span>
            </div>
          ) : !selectedArtifact || artifactContent === null ? (
            <div class="empty-state">
              <strong>표시할 내용이 없습니다</strong>
              <span>왼쪽 목록에서 보고서, 근거 또는 리뷰를 선택하세요.</span>
            </div>
          ) : viewMode === "raw" ? (
            <pre class="artifact-raw-code">
              <code>{rawText}</code>
            </pre>
          ) : (
            <FormattedMessage text={formattedText} />
          )}
        </div>
      </section>
    </div>
  );
}
