import { useEffect, useState } from "preact/hooks";
import { formatApiError, get, listFrom, post } from "./api";

export type ToolPackage = {
  id: string;
  project_id: string;
  kind: "skill" | "mcp";
  name: string;
  display_name: string;
  description: string;
  version: string;
  state: "pending_approval" | "active" | "disabled" | "failed";
  package_sha256: string;
  requires_restart: boolean;
  created_at: string;
  error?: string;
  files?: Array<{ path: string; content?: string; content_sha256: string; size: number }>;
};

export type ToolStudioViewProps = {
  projectID: string;
  connected: boolean;
};

export function ToolStudioView({ projectID, connected }: ToolStudioViewProps) {
  const [packages, setPackages] = useState<ToolPackage[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<ToolPackage | null>(null);
  const [stateFilter, setStateFilter] = useState<"all" | "pending_approval" | "active" | "disabled">("all");
  const [kindFilter, setKindFilter] = useState<"all" | "skill" | "mcp">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  async function refresh() {
    if (!projectID || !connected) {
      setPackages([]);
      return;
    }
    setBusy("refresh");
    try {
      const res = await get<unknown>(
        `/api/v1/projects/${encodeURIComponent(projectID)}/tools`
      );
      setPackages(listFrom<ToolPackage>(res, "tools"));
      setError(null);
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    setPackages(null);
    void refresh();
  }, [projectID, connected]);

  async function transition(pkg: ToolPackage, action: "activate" | "disable") {
    setBusy(pkg.id);
    setError(null);
    setNotice(null);
    try {
      await post<ToolPackage>(
        `/api/v1/projects/${encodeURIComponent(projectID)}/tools/${encodeURIComponent(pkg.id)}/${action}`,
        {}
      );
      if (action === "activate" && reviewing?.id === pkg.id) {
        setReviewing(null);
      }
      setNotice(
        action === "activate"
          ? `도구 패키지 "${pkg.display_name}"을(를) 승인했습니다. 프로젝트 도구 카탈로그에 즉시 적용되었습니다.`
          : `도구 패키지 "${pkg.display_name}"을(를) 비활성화했습니다.`
      );
      await refresh();
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function review(pkg: ToolPackage) {
    setBusy(pkg.id);
    setError(null);
    try {
      const details = await get<ToolPackage>(
        `/api/v1/projects/${encodeURIComponent(projectID)}/tools/${encodeURIComponent(pkg.id)}`
      );
      setReviewing(details);
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function copyToClipboard(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // Fallback
    }
  }

  // Filtered list calculation
  const filteredPackages = packages?.filter((pkg) => {
    const matchesState = stateFilter === "all" || pkg.state === stateFilter;
    const matchesKind = kindFilter === "all" || pkg.kind === kindFilter;
    const q = searchQuery.toLowerCase().trim();
    const matchesSearch =
      !q ||
      pkg.name.toLowerCase().includes(q) ||
      pkg.display_name.toLowerCase().includes(q) ||
      pkg.description.toLowerCase().includes(q) ||
      pkg.package_sha256.toLowerCase().includes(q);
    return matchesState && matchesKind && matchesSearch;
  });

  const totalCount = packages?.length ?? 0;
  const pendingCount = packages?.filter((p) => p.state === "pending_approval").length ?? 0;
  const activeCount = packages?.filter((p) => p.state === "active").length ?? 0;
  const skillCount = packages?.filter((p) => p.kind === "skill").length ?? 0;
  const mcpCount = packages?.filter((p) => p.kind === "mcp").length ?? 0;

  if (!projectID) {
    return (
      <section class="panel empty-state">
        <p class="eyebrow">Tool Studio</p>
        <h2>프로젝트를 먼저 선택하세요</h2>
        <p>왼쪽 사이드바에서 프로젝트를 선택하면 해당 프로젝트의 확장 도구를 관리할 수 있습니다.</p>
      </section>
    );
  }

  return (
    <div class="tool-studio-layout" aria-label="도구 스튜디오 화면">
      {/* Left Column: Safety Hero & Overview Stats */}
      <section class="panel tool-studio-hero">
        <div class="tool-hero-head">
          <div>
            <p class="eyebrow">관리형 도구 카탈로그</p>
            <h2>Tool Studio</h2>
          </div>
          {pendingCount > 0 && (
            <span class="tool-pending-alert">승인 대기 {pendingCount}건</span>
          )}
        </div>

        <p class="tool-studio-lead">
          연구 에이전트가 복합 분석에 필요한 새 기능을 발견하면 스킬 또는 내부 MCP 어댑터 패키지를
          제안합니다. 모든 제안은 자동 실행되지 않으며, 파일 원문과 SHA-256 해시를 검토하고
          승인한 뒤에만 현재 프로젝트에 안전하게 적용됩니다.
        </p>

        {/* Live Stat Badges */}
        <div class="tool-stats-summary-grid">
          <div class="tool-stat-box">
            <span>총 등록 도구</span>
            <strong>{totalCount}개</strong>
          </div>
          <div class="tool-stat-box">
            <span>활성 도구</span>
            <strong class="stat-active">{activeCount}개</strong>
          </div>
          <div class="tool-stat-box">
            <span>승인 대기</span>
            <strong class={pendingCount > 0 ? "stat-pending" : ""}>{pendingCount}개</strong>
          </div>
          <div class="tool-stat-box">
            <span>종류별 구성</span>
            <strong>
              Skill {skillCount} · MCP {mcpCount}
            </strong>
          </div>
        </div>

        {/* Safety Principles */}
        <div class="tool-safety-grid">
          <div class="tool-safety-card">
            <strong>• Skill 확장 원칙</strong>
            <span>프로젝트 특화 프롬프트 지침 및 도메인 분석 템플릿</span>
          </div>
          <div class="tool-safety-card">
            <strong>• 내부 MCP 어댑터 원칙</strong>
            <span>인증 및 보안 검증된 공개 HTTPS JSON GET 인터페이스만 허용</span>
          </div>
          <div class="tool-safety-card">
            <strong>• 프로젝트 단위 격리</strong>
            <span>승인 즉시 현재 프로젝트의 도구 카탈로그에만 안전하게 반영</span>
          </div>
        </div>

        {notice && (
          <div class="alert success" role="status">
            {notice}
          </div>
        )}
        {error && (
          <div class="alert danger" role="alert">
            {error}
          </div>
        )}
      </section>

      {/* Right Column: Filterable Package Catalog */}
      <section class="panel tool-package-panel">
        <div class="panel-heading tool-panel-head">
          <div class="tool-head-title-row">
            <div>
              <p class="eyebrow">패키지 관리</p>
              <h2>도구 목록 ({filteredPackages?.length ?? 0}/{totalCount})</h2>
            </div>
            <button
              class="button secondary small"
              onClick={() => void refresh()}
              disabled={busy === "refresh"}
            >
              {busy === "refresh" ? "새로고침 중…" : "새로 고침"}
            </button>
          </div>

          {/* Search & Multi-facet Filter Bar */}
          <div class="tool-controls-bar">
            <input
              type="search"
              class="tool-search-input"
              placeholder="도구 이름, 설명, SHA-256 해시 검색…"
              value={searchQuery}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
            />

            <div class="tool-filters-row">
              {/* Kind Tabs */}
              <div class="tool-kind-filter-tabs">
                <button
                  type="button"
                  class={`filter-tab ${kindFilter === "all" ? "active" : ""}`}
                  onClick={() => setKindFilter("all")}
                >
                  종류: 전체
                </button>
                <button
                  type="button"
                  class={`filter-tab ${kindFilter === "skill" ? "active" : ""}`}
                  onClick={() => setKindFilter("skill")}
                >
                  Skill ({skillCount})
                </button>
                <button
                  type="button"
                  class={`filter-tab ${kindFilter === "mcp" ? "active" : ""}`}
                  onClick={() => setKindFilter("mcp")}
                >
                  MCP ({mcpCount})
                </button>
              </div>

              {/* State Tabs */}
              <div class="tool-state-filter-tabs">
                <button
                  type="button"
                  class={`filter-tab ${stateFilter === "all" ? "active" : ""}`}
                  onClick={() => setStateFilter("all")}
                >
                  상태: 전체
                </button>
                <button
                  type="button"
                  class={`filter-tab ${stateFilter === "pending_approval" ? "active" : ""}`}
                  onClick={() => setStateFilter("pending_approval")}
                >
                  대기 ({pendingCount})
                </button>
                <button
                  type="button"
                  class={`filter-tab ${stateFilter === "active" ? "active" : ""}`}
                  onClick={() => setStateFilter("active")}
                >
                  활성 ({activeCount})
                </button>
                <button
                  type="button"
                  class={`filter-tab ${stateFilter === "disabled" ? "active" : ""}`}
                  onClick={() => setStateFilter("disabled")}
                >
                  비활성 ({packages?.filter((p) => p.state === "disabled").length ?? 0})
                </button>
              </div>
            </div>
          </div>
        </div>

        {packages === null ? (
          <p class="tool-muted">도구 제안 목록을 불러오는 중입니다…</p>
        ) : (filteredPackages?.length ?? 0) === 0 ? (
          <div class="empty-state">
            <strong>
              {searchQuery || stateFilter !== "all" || kindFilter !== "all"
                ? "조건에 일치하는 도구가 없습니다."
                : "아직 등록되거나 제안된 도구가 없습니다."}
            </strong>
            <span>
              연구 에이전트가 복합 분석을 진행하며 특화 도구가 필요할 때 새 스킬/어댑터를 제안합니다.
            </span>
          </div>
        ) : (
          <div class="tool-package-list">
            {filteredPackages?.map((pkg) => {
              const isPackageBusy = busy === pkg.id;
              return (
                <article class={`tool-package-card ${pkg.state}`} key={pkg.id}>
                  <div class="tool-package-title">
                    <span class={`tool-kind-badge ${pkg.kind}`}>
                      {pkg.kind === "skill" ? "SKILL" : "MCP"}
                    </span>
                    <div class="tool-info-title">
                      <strong>{pkg.display_name}</strong>
                      <small>
                        {pkg.name} · v{pkg.version}
                      </small>
                    </div>
                    <span class={`tool-state-badge ${pkg.state}`}>
                      {pkg.state === "pending_approval"
                        ? "승인 대기"
                        : pkg.state === "active"
                        ? "✓ 활성"
                        : pkg.state === "disabled"
                        ? "비활성"
                        : "실패"}
                    </span>
                  </div>

                  <p class="tool-desc">{pkg.description}</p>

                  <details class="tool-details">
                    <summary>패키지 무결성 정보</summary>
                    <dl class="tool-dl">
                      <div>
                        <dt>SHA-256</dt>
                        <dd class="sha-dd">
                          <code>{pkg.package_sha256}</code>
                          <button
                            type="button"
                            class="chat-code-copy-btn"
                            onClick={() => copyToClipboard(pkg.package_sha256, `sha-${pkg.id}`)}
                          >
                            {copiedKey === `sha-${pkg.id}` ? "✓ 복사됨" : "복사"}
                          </button>
                        </dd>
                      </div>
                      <div>
                        <dt>적용 시점</dt>
                        <dd>{pkg.requires_restart ? "앱 재시작 시" : "승인 즉시 반영"}</dd>
                      </div>
                      <div>
                        <dt>제안 시각</dt>
                        <dd>{new Date(pkg.created_at).toLocaleString("ko-KR")}</dd>
                      </div>
                    </dl>
                  </details>

                  {pkg.error && (
                    <div class="alert danger small-alert" role="alert">
                      {pkg.error}
                    </div>
                  )}

                  <div class="tool-package-actions">
                    <button
                      class="button secondary small"
                      disabled={busy !== null}
                      onClick={() => void review(pkg)}
                    >
                      {isPackageBusy && reviewing?.id === pkg.id ? "불러오는 중…" : "원문 파일 검토"}
                    </button>

                    {pkg.state === "pending_approval" && (
                      <button
                        class="button small"
                        disabled={busy !== null}
                        onClick={() => void transition(pkg, "activate")}
                      >
                        {isPackageBusy ? "승인 중…" : "이 패키지 승인"}
                      </button>
                    )}

                    {pkg.state === "active" && (
                      <button
                        class="button secondary small"
                        disabled={busy !== null}
                        onClick={() => void transition(pkg, "disable")}
                      >
                        {isPackageBusy ? "처리 중…" : "비활성화"}
                      </button>
                    )}

                    {pkg.state === "disabled" && (
                      <button
                        class="button small"
                        disabled={busy !== null}
                        onClick={() => void transition(pkg, "activate")}
                      >
                        {isPackageBusy ? "활성화 중…" : "다시 활성화"}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Review Drawer / Modal */}
      {reviewing && (
        <div
          class="artifact-drawer-overlay"
          onClick={() => setReviewing(null)}
          role="dialog"
          aria-modal="true"
        >
          <div class="artifact-drawer-panel tool-drawer-panel" onClick={(e) => e.stopPropagation()}>
            <header class="artifact-drawer-header">
              <div>
                <div class="tool-drawer-badge-row">
                  <span class={`tool-kind-badge ${reviewing.kind}`}>
                    {reviewing.kind === "skill" ? "SKILL" : "MCP"}
                  </span>
                  <span class={`tool-state-badge ${reviewing.state}`}>
                    {reviewing.state === "pending_approval"
                      ? "승인 대기"
                      : reviewing.state === "active"
                      ? "✓ 활성"
                      : reviewing.state === "disabled"
                      ? "비활성"
                      : "실패"}
                  </span>
                </div>
                <h2>{reviewing.display_name}</h2>
                <p>{reviewing.description}</p>
                <small class="tool-drawer-meta">
                  식별자: {reviewing.name} · v{reviewing.version} · SHA-256:{" "}
                  <code>{reviewing.package_sha256.slice(0, 16)}…</code>
                </small>
              </div>
              <button
                type="button"
                class="artifact-drawer-close"
                onClick={() => setReviewing(null)}
                aria-label="닫기"
              >
                ✕
              </button>
            </header>

            <div class="artifact-drawer-body">
              <div class="tool-review-files">
                {(reviewing.files ?? []).length === 0 ? (
                  <div class="empty-state">
                    <strong>포함된 파일이 없습니다.</strong>
                  </div>
                ) : (
                  (reviewing.files ?? []).map((file) => (
                    <div class="tool-file-box" key={file.path}>
                      <div class="tool-file-head">
                        <strong>{file.path}</strong>
                        <div class="file-head-actions">
                          <small>{file.size.toLocaleString()} bytes</small>
                          <button
                            type="button"
                            class="chat-code-copy-btn"
                            onClick={() =>
                              copyToClipboard(file.content ?? "", `file-${file.path}`)
                            }
                          >
                            {copiedKey === `file-${file.path}` ? "✓ 복사됨" : "복사"}
                          </button>
                        </div>
                      </div>
                      <pre class="tool-file-code">
                        <code>{file.content || "(내용이 비어 있습니다)"}</code>
                      </pre>
                    </div>
                  ))
                )}
              </div>

              <div class="tool-review-footer">
                <p class="safety-note">
                  승인하면 이 패키지의 정확한 SHA-256 검증본만 현재 프로젝트의 내부 도구 카탈로그에
                  즉시 적용됩니다.
                </p>
                <div class="review-action-row">
                  <button
                    class="button secondary small"
                    type="button"
                    onClick={() => setReviewing(null)}
                  >
                    닫기
                  </button>

                  {reviewing.state !== "active" ? (
                    <button
                      class="button small"
                      disabled={busy !== null}
                      onClick={() => void transition(reviewing, "activate")}
                    >
                      {busy === reviewing.id ? "승인 중…" : "이 패키지 승인 및 활성화"}
                    </button>
                  ) : (
                    <button
                      class="button secondary small"
                      disabled={busy !== null}
                      onClick={() => void transition(reviewing, "disable")}
                    >
                      {busy === reviewing.id ? "처리 중…" : "도구 비활성화"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
