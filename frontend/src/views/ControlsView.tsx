import { useState } from "preact/hooks";
import { formatApiError, post } from "../api";
import type { Connection } from "../types";

export type ControlsViewProps = {
  browserState: string | null;
  browserMode: "automatic" | "manual" | null;
  statusError: string | null;
  connection: Connection;
  busy: string | null;
  onSetBrowserMode: (mode: "automatic" | "manual") => Promise<void>;
  onEmergencyStop: () => Promise<void>;
};

export function ControlsView({
  browserState,
  browserMode,
  statusError,
  connection,
  busy,
  onSetBrowserMode,
  onEmergencyStop
}: ControlsViewProps) {
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState("");
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [testUrl, setTestUrl] = useState("https://arxiv.org");
  const [urlValidationResult, setUrlValidationResult] = useState<string | null>(null);

  const isSettingMode = busy === "browser-mode";
  const isEmergency = busy === "emergency-stop";
  const isResetting = busy === "profile-reset";

  async function handleProfileReset(e: Event) {
    e.preventDefault();
    if (resetConfirmation.trim() !== "RESET INTERNET PROFILE") return;
    setResetNotice(null);
    setResetError(null);
    try {
      await post("/api/v1/browser/profile-reset", {
        confirmation: "RESET INTERNET PROFILE"
      });
      setResetNotice("브라우저 샌드박스 프로필, 캐시 및 쿠키를 안전하게 초기화했습니다.");
      setResetConfirmation("");
      setResetModalOpen(false);
    } catch (err) {
      setResetError(formatApiError(err));
    }
  }

  function validateUrlLocally(input: string) {
    const raw = input.trim();
    if (!raw) {
      setUrlValidationResult(null);
      return;
    }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        setUrlValidationResult("차단됨: http 또는 https 프로토콜만 허용됩니다.");
        return;
      }
      if (parsed.username || parsed.password) {
        setUrlValidationResult("차단됨: 사용자 자격 증명이 포함된 URL은 보안상 허용되지 않습니다.");
        return;
      }
      const host = parsed.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host.startsWith("10.") ||
        host.startsWith("192.168.") ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
      ) {
        setUrlValidationResult("차단됨 (Gate0): 루프백 및 내부 사설망 IP 접근은 원천 차단됩니다.");
        return;
      }
      setUrlValidationResult("통과됨: 안전한 공개 웹 리서치 대상 URL입니다.");
    } catch {
      setUrlValidationResult("오류: 유효한 URL 형식이 아닙니다.");
    }
  }

  return (
    <div class="control-layout" aria-label="브라우저 자동화 및 안전 제어 화면">
      {/* Left Column: Real-time Telemetry & Mode Switcher */}
      <section class="panel control-hero">
        <div class="control-hero-head">
          <div>
            <p class="eyebrow">웹 리서치 자동화 & 안전 운영</p>
            <h2>브라우저 제어 센터</h2>
          </div>
          <div class="control-status-badges">
            <span
              class={`control-connection-pill ${
                connection === "connected" ? "connected" : "offline"
              }`}
            >
              {connection === "connected" ? "✓ 서비스 연결됨" : "오프라인"}
            </span>
          </div>
        </div>

        <p class="control-lead-text">
          연구 에이전트의 외부 웹 브라우징 및 수집 활동을 실시간으로 확인하고, 자동화/수동 개입 모드
          전환, 전역 긴급 중지, 샌드박스 프로필 초기화를 즉시 수행할 수 있습니다.
        </p>

        {/* 4 Telemetry Stat Cards */}
        <div class="control-status-grid">
          <div class="control-stat-card">
            <span class="stat-card-label">브라우저 프로세스 상태</span>
            <div class="stat-card-value">
              <span class={`status-dot ${browserState === "ready" ? "active" : ""}`} />
              <strong>{browserState ?? (statusError ? "상태 조회 실패" : "상태 확인 중")}</strong>
            </div>
          </div>

          <div class="control-stat-card">
            <span class="stat-card-label">현재 제어 모드</span>
            <div class="stat-card-value">
              <strong class={browserMode === "automatic" ? "mode-auto" : "mode-manual"}>
                {browserMode === "automatic"
                  ? "자동 제어 (에이전트)"
                  : browserMode === "manual"
                  ? "수동 개입 (사용자)"
                  : statusError
                  ? "확인 불가"
                  : "확인 중"}
              </strong>
            </div>
          </div>

          <div class="control-stat-card">
            <span class="stat-card-label">보안 게이트 (SSRF 방어)</span>
            <div class="stat-card-value">
              <strong class="gate-secure">Gate0 활성 (루프백 차단)</strong>
            </div>
          </div>

          <div class="control-stat-card">
            <span class="stat-card-label">실행 환경 격리</span>
            <div class="stat-card-value">
              <strong>WebView2 임시 프로필</strong>
            </div>
          </div>
        </div>

        {statusError && (
          <div class="alert danger" role="alert">
            <strong>브라우저 상태를 불러오지 못했습니다.</strong> {statusError}
          </div>
        )}

        {/* Interactive Mode Control Panel */}
        <div class="control-panel-section">
          <div class="control-mode-desc-box">
            <div class="mode-desc-item">
              <strong>• 자동 제어 (Automatic):</strong>
              <span>에이전트가 연구 계획에 따라 웹 문서를 탐색하고 증거를 자율 수집합니다.</span>
            </div>
            <div class="mode-desc-item">
              <strong>• 수동 개입 (Manual):</strong>
              <span>에이전트의 자동 조작을 멈추고 사용자가 직접 브라우징을 제어합니다.</span>
            </div>
          </div>

          <div class="control-action-bar">
            <div class="control-mode-buttons">
              <button
                class={`button ${browserMode === "automatic" ? "active" : "secondary"}`}
                onClick={() => onSetBrowserMode("automatic")}
                disabled={isSettingMode || connection !== "connected"}
              >
                {isSettingMode && browserMode !== "automatic" ? "전환 중…" : "자동 제어 시작"}
              </button>
              <button
                class={`button ${browserMode === "manual" ? "active" : "secondary"}`}
                onClick={() => onSetBrowserMode("manual")}
                disabled={isSettingMode || connection !== "connected"}
              >
                {isSettingMode && browserMode !== "manual" ? "전환 중…" : "수동 개입으로 전환"}
              </button>
            </div>

            <div class="control-critical-actions">
              <button
                type="button"
                class="button secondary"
                onClick={() => setResetModalOpen(true)}
                disabled={connection !== "connected"}
              >
                프로필 초기화…
              </button>

              <button
                class="button danger"
                onClick={onEmergencyStop}
                disabled={isEmergency || connection !== "connected"}
              >
                {isEmergency ? "중지 요청 중…" : "전역 긴급 중지"}
              </button>
            </div>
          </div>
        </div>

        {resetNotice && (
          <div class="alert success" role="status">
            {resetNotice}
          </div>
        )}
        {resetError && (
          <div class="alert danger" role="alert">
            {resetError}
          </div>
        )}

        <p class="safety-note">
          전역 긴급 중지는 실행 중인 모든 외부 웹 브라우징 인스턴스와 수집 워커에 즉시 종료 신호를
          전송하고 안전하게 연결을 해제합니다.
        </p>
      </section>

      {/* Right Column: Security Policy & Gate0 URL Simulator */}
      <section class="panel control-policy-card">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">보안 아키텍처 & 정책</p>
            <h2>Gate0 안전 원칙</h2>
          </div>
        </div>

        <div class="policy-list">
          <article class="policy-item">
            <div class="policy-item-title">
              <span class="policy-step-pill">1</span>
              <strong>SSRF 방어 및 사설망 원천 차단 (Gate0)</strong>
            </div>
            <p>
              DNS 사전 분석을 통해 <code>127.0.0.1</code>, <code>localhost</code>, 사설 서브넷(
              <code>10.0.0.0/8</code>, <code>192.168.0.0/16</code>)으로 향하는 모든 연결 요청을
              물리적으로 차단합니다.
            </p>
          </article>

          <article class="policy-item">
            <div class="policy-item-title">
              <span class="policy-step-pill">2</span>
              <strong>읽기 중심 안전 탐색 (Read-only Crawling)</strong>
            </div>
            <p>
              외부 웹 작업은 정적 및 동적 문서 열람에 한정되며, 결제 요청, 비인가 폼 전송, 계정 인증
              수정 등의 위험 행위는 시도되지 않습니다.
            </p>
          </article>

          <article class="policy-item">
            <div class="policy-item-title">
              <span class="policy-step-pill">3</span>
              <strong>CAS 불변 스냅샷 SHA-256 저장</strong>
            </div>
            <p>
              웹에서 수집된 모든 페이지와 표 데이터는 Content-Addressable Storage(CAS)에 SHA-256
              해시로 영구 고정되어 사후 검증이 보장됩니다.
            </p>
          </article>
        </div>

        {/* Gate0 URL Tester Simulator */}
        <div class="url-validator-box">
          <div class="url-validator-head">
            <strong>Gate0 URL 정책 검증기</strong>
            <small>주소가 보안 정책을 통과하는지 실시간 확인</small>
          </div>

          <div class="url-validator-input-row">
            <input
              type="text"
              class="url-test-input"
              value={testUrl}
              onInput={(e) => {
                setTestUrl(e.currentTarget.value);
                validateUrlLocally(e.currentTarget.value);
              }}
              placeholder="https://example.com"
            />
            <button
              type="button"
              class="button secondary small"
              onClick={() => validateUrlLocally(testUrl)}
            >
              검증
            </button>
          </div>

          {urlValidationResult && (
            <div
              class={`url-result-box ${
                urlValidationResult.startsWith("통과") ? "passed" : "blocked"
              }`}
            >
              {urlValidationResult}
            </div>
          )}
        </div>
      </section>

      {/* Profile Reset Confirmation Modal */}
      {resetModalOpen && (
        <div
          class="artifact-drawer-overlay"
          onClick={() => setResetModalOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div class="profile-reset-dialog" onClick={(e) => e.stopPropagation()}>
            <div class="reset-dialog-header">
              <h3>브라우저 샌드박스 프로필 초기화</h3>
              <button
                type="button"
                class="artifact-drawer-close"
                onClick={() => setResetModalOpen(false)}
                aria-label="닫기"
              >
                ✕
              </button>
            </div>

            <p class="reset-dialog-warning">
              이 작업은 WebView2 샌드박스에 저장된 모든 임시 브라우징 세션 데이터, 캐시, 쿠키를
              영구 삭제하고 기본 상태로 되돌립니다.
            </p>

            <form onSubmit={handleProfileReset} class="reset-form">
              <label for="reset-confirmation-input">
                확인을 위해 아래 상자에 <code>RESET INTERNET PROFILE</code> 을 정확히 입력하세요:
              </label>
              <input
                id="reset-confirmation-input"
                type="text"
                value={resetConfirmation}
                onInput={(e) => setResetConfirmation(e.currentTarget.value)}
                placeholder="RESET INTERNET PROFILE"
                autoComplete="off"
              />

              <div class="reset-actions-row">
                <button
                  type="button"
                  class="button secondary small"
                  onClick={() => setResetModalOpen(false)}
                >
                  취소
                </button>
                <button
                  type="submit"
                  class="button danger small"
                  disabled={resetConfirmation.trim() !== "RESET INTERNET PROFILE" || isResetting}
                >
                  {isResetting ? "초기화 중…" : "프로필 영구 초기화"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
