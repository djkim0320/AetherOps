import { useEffect, useMemo, useState } from "preact/hooks";
import { formatApiError, get, listFrom, post } from "./api";

type ToolInstallation = {
  id: string;
  state:
    | "downloading"
    | "verifying"
    | "installing"
    | "probing"
    | "ready"
    | "failed"
    | "interrupted"
    | "quarantined";
  expected_payload_sha256: string;
  payload_blob_hash?: string;
  payload_size_bytes: number;
  installed_tree_sha256?: string;
  entrypoint?: string;
  probe_output_blob_hash?: string;
  error?: string;
  updated_at: string;
};

export type ToolPackage = {
  id: string;
  project_id: string;
  kind: "skill" | "mcp";
  name: string;
  display_name: string;
  description: string;
  version: string;
  state: "pending_approval" | "active" | "disabled" | "failed";
  manifest_json?: string;
  package_sha256: string;
  requires_restart: boolean;
  created_at: string;
  error?: string;
  installation?: ToolInstallation;
  files?: Array<{ path: string; content?: string; content_sha256: string; size: number }>;
};

type PortableManifest = {
  schema: "aetherops_tool_package_v2";
  distribution: {
    type: "portable_exe" | "portable_zip";
    url: string;
    sha256: string;
    size_bytes: number;
    publisher: string;
    source_url: string;
    license_spdx: string;
    entrypoint: string;
    allowed_redirect_hosts?: string[];
    probe: { argv: string[]; stdout_contains?: string };
  };
  permissions: {
    native_code: true;
    same_windows_user: true;
    os_network_sandboxed: false;
    os_filesystem_sandboxed: false;
  };
  tools: Array<{
    name: string;
    description: string;
    action: { type: string; argv?: Array<{ literal?: string; input?: string }>; timeout_seconds?: number };
  }>;
};

export type ToolStudioViewProps = {
  projectID: string;
  connected: boolean;
};

const installStates = new Set(["downloading", "verifying", "installing", "probing"]);

function portableManifest(pkg: ToolPackage): PortableManifest | null {
  if (!pkg.manifest_json) return null;
  try {
    const value = JSON.parse(pkg.manifest_json) as PortableManifest;
    return value.schema === "aetherops_tool_package_v2" && value.distribution ? value : null;
  } catch {
    return null;
  }
}

function stateLabel(pkg: ToolPackage) {
  const install = pkg.installation?.state;
  if (install === "downloading") return "다운로드 중";
  if (install === "verifying") return "해시 검증 중";
  if (install === "installing") return "설치 중";
  if (install === "probing") return "호환성 점검 중";
  if (install === "failed") return "설치 실패";
  if (install === "interrupted") return "설치 중단";
  if (install === "quarantined") return "격리됨";
  if (pkg.state === "pending_approval") return "승인 대기";
  if (pkg.state === "active") return "활성";
  if (pkg.state === "disabled") return "비활성";
  return "실패";
}

function shortHash(value?: string) {
  return value ? `${value.slice(0, 12)}…${value.slice(-8)}` : "—";
}

export function ToolStudioView({ projectID, connected }: ToolStudioViewProps) {
  const [packages, setPackages] = useState<ToolPackage[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<ToolPackage | null>(null);
  const [stateFilter, setStateFilter] = useState<"all" | ToolPackage["state"]>("all");
  const [kindFilter, setKindFilter] = useState<"all" | "skill" | "mcp">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  async function refresh(silent = false) {
    if (!projectID || !connected) {
      setPackages([]);
      return;
    }
    if (!silent) setBusy("refresh");
    try {
      const response = await get<unknown>(`/api/v1/projects/${encodeURIComponent(projectID)}/tools`);
      setPackages(listFrom<ToolPackage>(response, "tools"));
      setError(null);
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      if (!silent) setBusy(null);
    }
  }

  useEffect(() => {
    setPackages(null);
    void refresh();
  }, [projectID, connected]);

  const hasLiveInstall = packages?.some((pkg) => installStates.has(pkg.installation?.state ?? "")) ?? false;
  useEffect(() => {
    if (!hasLiveInstall) return;
    const timer = window.setInterval(() => void refresh(true), 1500);
    return () => window.clearInterval(timer);
  }, [hasLiveInstall, projectID, connected]);

  async function transition(pkg: ToolPackage, action: "activate" | "disable") {
    setBusy(pkg.id);
    setError(null);
    setNotice(null);
    try {
      const updated = await post<ToolPackage>(
        `/api/v1/projects/${encodeURIComponent(projectID)}/tools/${encodeURIComponent(pkg.id)}/${action}`,
        {},
      );
      setReviewing((current) => (current?.id === pkg.id ? updated : current));
      setNotice(
        action === "activate"
          ? portableManifest(pkg)
            ? `“${pkg.display_name}”의 정확한 payload를 검증하고 설치했습니다.`
            : `“${pkg.display_name}”을 프로젝트 도구로 활성화했습니다.`
          : `“${pkg.display_name}”을 비활성화했습니다.`,
      );
      await refresh(true);
    } catch (cause) {
      setError(formatApiError(cause));
      await refresh(true);
    } finally {
      setBusy(null);
    }
  }

  async function review(pkg: ToolPackage) {
    setBusy(pkg.id);
    setError(null);
    try {
      setReviewing(
        await get<ToolPackage>(
          `/api/v1/projects/${encodeURIComponent(projectID)}/tools/${encodeURIComponent(pkg.id)}`,
        ),
      );
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function copyToClipboard(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(null), 1600);
  }

  const filteredPackages = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return (packages ?? []).filter((pkg) => {
      const portable = portableManifest(pkg);
      return (
        (stateFilter === "all" || pkg.state === stateFilter) &&
        (kindFilter === "all" || pkg.kind === kindFilter) &&
        (!query ||
          [pkg.name, pkg.display_name, pkg.description, pkg.package_sha256, portable?.distribution.publisher]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(query)))
      );
    });
  }, [packages, stateFilter, kindFilter, searchQuery]);

  if (!projectID) {
    return (
      <section class="panel empty-state">
        <p class="eyebrow">Tool Studio</p>
        <h2>프로젝트를 먼저 선택하세요</h2>
        <p>프로젝트별 승인 도구와 설치 상태를 여기에서 관리합니다.</p>
      </section>
    );
  }

  const pendingCount = packages?.filter((pkg) => pkg.state === "pending_approval").length ?? 0;
  const activeCount = packages?.filter((pkg) => pkg.state === "active").length ?? 0;
  const portableCount = packages?.filter((pkg) => portableManifest(pkg)).length ?? 0;

  return (
    <div class="tool-studio-layout" aria-label="도구 스튜디오">
      <section class="panel tool-studio-hero">
        <div class="tool-hero-head">
          <div>
            <p class="eyebrow">Project Tool Boundary</p>
            <h2>Tool Studio</h2>
          </div>
          {pendingCount > 0 && <span class="tool-pending-alert">승인 대기 {pendingCount}건</span>}
        </div>
        <p class="tool-studio-lead">
          연구에 필요한 기능이 없으면 에이전트가 선언형 호출 어댑터를 먼저 제안합니다. Portable CLI는 사용자가
          정확한 출처·SHA-256·권한을 승인한 뒤에만 다운로드, 검증, 점검되고 현재 연구 단계에 연결됩니다.
        </p>
        <div class="tool-stats-summary-grid">
          <div class="tool-stat-box"><span>전체</span><strong>{packages?.length ?? 0}</strong></div>
          <div class="tool-stat-box"><span>활성</span><strong class="stat-active">{activeCount}</strong></div>
          <div class="tool-stat-box"><span>승인 대기</span><strong class={pendingCount ? "stat-pending" : ""}>{pendingCount}</strong></div>
          <div class="tool-stat-box"><span>Portable CLI</span><strong>{portableCount}</strong></div>
        </div>
        <div class="tool-safety-grid">
          <div class="tool-safety-card"><strong>승인 전에 어댑터 고정</strong><span>URL, payload hash, argv, timeout과 출력 제한까지 승인 해시에 포함합니다.</span></div>
          <div class="tool-safety-card"><strong>설치 프로그램 제외</strong><span>Portable EXE/ZIP만 허용하며 MSI, npm/pip, 스크립트, 서비스와 PATH 변경은 실행하지 않습니다.</span></div>
          <div class="tool-safety-card"><strong>같은 단계에서 계속</strong><span>승인 후 새 모델 턴을 만들지 않고 현재 run과 stage attempt에서 도구 호출을 이어갑니다.</span></div>
        </div>
        <div class="alert warning" role="note">
          Native CLI는 Job Object로 수명과 자식 프로세스를 관리하지만 아직 AppContainer가 아닙니다. 승인한 바이너리는
          현재 Windows 사용자 권한으로 실행되며 OS 수준 네트워크·파일시스템 샌드박스를 제공하지 않습니다.
        </div>
        {notice && <div class="alert success" role="status">{notice}</div>}
        {error && <div class="alert danger" role="alert">{error}</div>}
      </section>

      <section class="panel tool-package-panel">
        <div class="panel-heading tool-panel-head">
          <div class="tool-head-title-row">
            <div><p class="eyebrow">Approved Extensions</p><h2>프로젝트 도구 ({filteredPackages.length})</h2></div>
            <button class="button secondary small" onClick={() => void refresh()} disabled={busy === "refresh"}>
              {busy === "refresh" ? "새로고침 중…" : "새로고침"}
            </button>
          </div>
          <div class="tool-controls-bar">
            <input class="tool-search-input" type="search" value={searchQuery} onInput={(event) => setSearchQuery(event.currentTarget.value)} placeholder="이름, 설명, 배포자, SHA-256 검색" />
            <div class="tool-filters-row">
              <div class="tool-kind-filter-tabs">
                {(["all", "skill", "mcp"] as const).map((kind) => (
                  <button class={`filter-tab ${kindFilter === kind ? "active" : ""}`} type="button" onClick={() => setKindFilter(kind)}>
                    {kind === "all" ? "모든 종류" : kind === "skill" ? "Skill" : "MCP / CLI"}
                  </button>
                ))}
              </div>
              <div class="tool-state-filter-tabs">
                {(["all", "pending_approval", "active", "disabled", "failed"] as const).map((state) => (
                  <button class={`filter-tab ${stateFilter === state ? "active" : ""}`} type="button" onClick={() => setStateFilter(state)}>
                    {state === "all" ? "모든 상태" : state === "pending_approval" ? "승인 대기" : state === "active" ? "활성" : state === "disabled" ? "비활성" : "실패"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {packages === null ? (
          <p class="tool-muted">도구 목록을 불러오는 중입니다…</p>
        ) : filteredPackages.length === 0 ? (
          <div class="empty-state"><strong>표시할 도구가 없습니다.</strong><span>연구 중 재사용 가능한 기능이 필요하면 에이전트가 이곳에 제안합니다.</span></div>
        ) : (
          <div class="tool-package-list">
            {filteredPackages.map((pkg) => {
              const portable = portableManifest(pkg);
              const installing = installStates.has(pkg.installation?.state ?? "");
              return (
                <article class={`tool-package-card ${pkg.state}`} key={pkg.id}>
                  <div class="tool-package-title">
                    <span class={`tool-kind-badge ${portable ? "portable" : pkg.kind}`}>{portable ? "CLI" : pkg.kind.toUpperCase()}</span>
                    <div class="tool-info-title"><strong>{pkg.display_name}</strong><small>{pkg.name} · v{pkg.version}</small></div>
                    <span class={`tool-state-badge ${pkg.installation?.state ?? pkg.state}`}>{stateLabel(pkg)}</span>
                  </div>
                  <p class="tool-desc">{pkg.description}</p>
                  {portable && (
                    <div class="tool-portable-summary">
                      <span><b>{portable.distribution.publisher}</b> · {portable.distribution.license_spdx}</span>
                      <span>{portable.distribution.type === "portable_zip" ? "Portable ZIP" : "Single EXE"} · {(portable.distribution.size_bytes / 1024 / 1024).toFixed(1)} MiB</span>
                      <code title={portable.distribution.sha256}>{shortHash(portable.distribution.sha256)}</code>
                    </div>
                  )}
                  <details class="tool-details">
                    <summary>무결성 정보</summary>
                    <dl class="tool-dl">
                      <div><dt>패키지 SHA-256</dt><dd class="sha-dd"><code>{pkg.package_sha256}</code><button class="chat-code-copy-btn" type="button" onClick={() => void copyToClipboard(pkg.package_sha256, `sha-${pkg.id}`)}>{copiedKey === `sha-${pkg.id}` ? "복사됨" : "복사"}</button></dd></div>
                      {pkg.installation && <div><dt>설치 트리</dt><dd><code>{shortHash(pkg.installation.installed_tree_sha256)}</code></dd></div>}
                      <div><dt>제안 시각</dt><dd>{new Date(pkg.created_at).toLocaleString("ko-KR")}</dd></div>
                    </dl>
                  </details>
                  {(pkg.error || pkg.installation?.error) && <div class="alert danger small-alert" role="alert">{pkg.installation?.error || pkg.error}</div>}
                  <div class="tool-package-actions">
                    <button class="button secondary small" disabled={busy !== null} onClick={() => void review(pkg)}>내용 검토</button>
                    {(pkg.state === "pending_approval" || pkg.state === "disabled" || pkg.state === "failed") && (
                      <button class="button small" disabled={busy !== null || installing} onClick={() => void transition(pkg, "activate")}>
                        {busy === pkg.id || installing ? "다운로드·검증 중…" : portable ? "승인하고 설치" : "활성화"}
                      </button>
                    )}
                    {pkg.state === "active" && <button class="button secondary small" disabled={busy !== null} onClick={() => void transition(pkg, "disable")}>비활성화</button>}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {reviewing && (
        <div class="artifact-drawer-overlay" onClick={() => setReviewing(null)} role="dialog" aria-modal="true" aria-label="도구 패키지 검토">
          <div class="artifact-drawer-panel tool-drawer-panel" onClick={(event) => event.stopPropagation()}>
            <header class="artifact-drawer-header">
              <div><p class="eyebrow">Exact Approval Scope</p><h2>{reviewing.display_name}</h2><p>{reviewing.description}</p></div>
              <button type="button" class="artifact-drawer-close" onClick={() => setReviewing(null)} aria-label="닫기">×</button>
            </header>
            <div class="artifact-drawer-body">
              {(() => {
                const portable = portableManifest(reviewing);
                return portable ? (
                  <section class="tool-portable-review">
                    <h3>다운로드 및 실행 범위</h3>
                    <dl class="tool-dl">
                      <div><dt>배포자</dt><dd>{portable.distribution.publisher}</dd></div>
                      <div><dt>공식 안내</dt><dd><a href={portable.distribution.source_url} target="_blank" rel="noreferrer">{portable.distribution.source_url}</a></dd></div>
                      <div><dt>다운로드</dt><dd><code>{portable.distribution.url}</code></dd></div>
                      <div><dt>Payload SHA-256</dt><dd><code>{portable.distribution.sha256}</code></dd></div>
                      <div><dt>실행 파일</dt><dd><code>{portable.distribution.entrypoint}</code></dd></div>
                      <div><dt>Probe</dt><dd><code>{portable.distribution.probe.argv.join(" ")}</code></dd></div>
                      <div><dt>호출 도구</dt><dd>{portable.tools.map((tool) => tool.name).join(", ")}</dd></div>
                    </dl>
                    <div class="alert warning">이 바이너리는 같은 Windows 사용자 권한으로 실행됩니다. 현재 OS 수준 네트워크·파일시스템 격리는 없습니다.</div>
                  </section>
                ) : null;
              })()}
              <div class="tool-review-files">
                {(reviewing.files ?? []).map((file) => (
                  <div class="tool-file-box" key={file.path}>
                    <div class="tool-file-head"><strong>{file.path}</strong><small>{file.size.toLocaleString()} bytes</small></div>
                    <pre class="tool-file-code"><code>{file.content || "(내용 없음)"}</code></pre>
                  </div>
                ))}
              </div>
              <div class="tool-review-footer">
                <p class="safety-note">표시된 패키지·payload·adapter·권한 해시가 하나라도 바뀌면 다시 승인해야 합니다.</p>
                <div class="review-action-row">
                  <button class="button secondary small" type="button" onClick={() => setReviewing(null)}>닫기</button>
                  {reviewing.state !== "active" ? (
                    <button class="button small" disabled={busy !== null} onClick={() => void transition(reviewing, "activate")}>{busy === reviewing.id ? "설치 중…" : portableManifest(reviewing) ? "승인하고 설치" : "활성화"}</button>
                  ) : (
                    <button class="button secondary small" disabled={busy !== null} onClick={() => void transition(reviewing, "disable")}>비활성화</button>
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
