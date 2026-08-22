import type { KnowledgeRecord, KnowledgeSearchResult, KnowledgeStatus } from "../knowledge-types";

export type KnowledgeTab = "explorer" | "curation" | "ontology" | "materials" | "sparql";

export type KnowledgeToolbarProps = {
  projectName: string;
  projectID: string;
  connected: boolean;
  busy: string;
  status: KnowledgeStatus | null;
  activeTab: KnowledgeTab;
  onSelectTab: (tab: KnowledgeTab) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onSearchSubmit: (e: Event) => void;
  searchResults: KnowledgeSearchResult[];
  onSelectSearchResult: (result: KnowledgeSearchResult) => void;
  onRefresh: () => void;
  onRebuild: () => void;
  onExport: () => void;
  error: string;
  notice: string;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function activeOntologyVersion(status: KnowledgeStatus | null): string {
  return text(status?.active_ontology_version_id) ?? text(status?.activeOntologyVersionID) ?? "";
}

export function KnowledgeToolbar({
  projectName,
  projectID,
  connected,
  busy,
  status,
  activeTab,
  onSelectTab,
  searchQuery,
  onSearchQueryChange,
  onSearchSubmit,
  searchResults,
  onSelectSearchResult,
  onRefresh,
  onRebuild,
  onExport,
  error,
  notice
}: KnowledgeToolbarProps) {
  const isRefreshing = busy === "refresh";
  const isRebuilding = busy === "rebuild";
  const isExporting = busy === "export";

  return (
    <section class="panel knowledge-toolbar" aria-label="프로젝트 지식 툴바">
      {/* Header Row */}
      <div class="knowledge-toolbar-head">
        <div>
          <p class="eyebrow">Project Knowledge</p>
          <h2>{projectName || projectID}</h2>
        </div>
        <div class="knowledge-toolbar-actions">
          <button
            class="button secondary small"
            type="button"
            onClick={onRefresh}
            disabled={!connected || Boolean(busy)}
            title="지식 상태 및 그래프 새로 고침"
          >
            <span>↻</span> {isRefreshing ? "불러오는 중…" : "새로 고침"}
          </button>
          <button
            class="button secondary small"
            type="button"
            onClick={onRebuild}
            disabled={!connected || Boolean(busy)}
            title="Shadow graph 재구성"
          >
            <span>⚙</span> {isRebuilding ? "재구성 중…" : "그래프 재구성"}
          </button>
          <button
            class="button secondary small"
            type="button"
            onClick={onExport}
            disabled={!connected || Boolean(busy)}
            title="JSON-LD 파일로 내보내기"
          >
            <span>↓</span> {isExporting ? "내보내는 중…" : "JSON-LD 내보내기"}
          </button>
        </div>
      </div>

      {/* Primary Sub-Tabs Navigation (No emojis) */}
      <div class="knowledge-nav-row">
        <nav class="knowledge-subtabs" aria-label="지식 도구 탭">
          <button
            type="button"
            class={`knowledge-subtab-btn ${activeTab === "explorer" ? "active" : ""}`}
            onClick={() => onSelectTab("explorer")}
          >
            <span>•</span> 그래프 탐색기
          </button>
          <button
            type="button"
            class={`knowledge-subtab-btn ${activeTab === "curation" ? "active" : ""}`}
            onClick={() => onSelectTab("curation")}
          >
            <span>•</span> 구조화 편집
          </button>
          <button
            type="button"
            class={`knowledge-subtab-btn ${activeTab === "ontology" ? "active" : ""}`}
            onClick={() => onSelectTab("ontology")}
          >
            <span>•</span> 온톨로지 & 스키마
          </button>
          <button
            type="button"
            class={`knowledge-subtab-btn ${activeTab === "materials" ? "active" : ""}`}
            onClick={() => onSelectTab("materials")}
          >
            <span>•</span> 프로젝트 자료
          </button>
          <button
            type="button"
            class={`knowledge-subtab-btn ${activeTab === "sparql" ? "active" : ""}`}
            onClick={() => onSelectTab("sparql")}
          >
            <span>•</span> SPARQL 질의
          </button>
        </nav>

        {/* Global Knowledge Search */}
        <form class="knowledge-search" onSubmit={onSearchSubmit}>
          <label class="sr-only" for="knowledge-search-input">
            지식 검색
          </label>
          <input
            id="knowledge-search-input"
            value={searchQuery}
            onInput={(e) => onSearchQueryChange(e.currentTarget.value)}
            placeholder="엔터티, 개념, 별칭 검색…"
            disabled={!connected}
          />
          <button
            class="button small"
            type="submit"
            disabled={!connected || !searchQuery.trim() || Boolean(busy)}
          >
            검색
          </button>
        </form>
      </div>

      {/* Live Status Row */}
      <div class="knowledge-status-row" aria-live="polite">
        <span class={`knowledge-state ${text(status?.state) ?? (status?.ready ? "ready" : "unknown")}`}>
          {text(status?.state) ?? (status?.ready ? "준비 완료" : "상태 확인 중")}
        </span>
        <span class="knowledge-stat-chip">
          <strong>{number(status?.entity_count) ?? 0}</strong> 엔터티
        </span>
        <span class="knowledge-stat-chip">
          <strong>{number(status?.assertion_count) ?? 0}</strong> 주장
        </span>
        <span class="knowledge-stat-chip">
          <strong>{number(status?.evidence_count) ?? 0}</strong> 근거
        </span>
        <span class="knowledge-stat-chip">
          <strong>{number(status?.conflict_count) ?? 0}</strong> 충돌
        </span>
        <span class="knowledge-stat-chip">
          활성 온톨로지: <strong>{activeOntologyVersion(status) || "없음"}</strong>
        </span>
      </div>

      {/* Search Results Dropdown */}
      {searchResults.length > 0 && (
        <div class="knowledge-search-results" aria-label="지식 검색 결과">
          <div class="knowledge-search-results-head">
            <span>검색 결과 ({searchResults.length}건)</span>
            <small>엔터티를 클릭하여 포커스합니다</small>
          </div>
          <div class="knowledge-search-results-list">
            {searchResults.map((result) => (
              <button
                type="button"
                key={result.id}
                class="search-result-item"
                onClick={() => onSelectSearchResult(result)}
              >
                <div class="search-result-title">
                  <strong>{result.label}</strong>
                  <span class="search-result-kind">{result.kind}</span>
                  {result.score !== undefined && (
                    <small class="search-result-score">점수: {result.score.toFixed(3)}</small>
                  )}
                </div>
                <small class="search-result-desc">{result.description ?? result.id}</small>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Alerts */}
      {error && (
        <div class="alert danger knowledge-alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div class="alert success knowledge-alert" role="status">
          {notice}
        </div>
      )}
    </section>
  );
}
