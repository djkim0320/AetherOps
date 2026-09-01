import { useState } from "preact/hooks";
import { LifecycleControls } from "../LifecycleControls";
import type { CodexAccountStatus, Connection, JsonRecord, Project } from "../types";

export type SettingsViewProps = {
  selectedProject: Project | null;
  codexAccount: CodexAccountStatus | null;
  deviceCode: JsonRecord | null;
  onRequestDeviceCode: () => Promise<void>;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  onSaveApiKey: (e: Event) => Promise<void>;
  runtimeUpdate: JsonRecord | null;
  connection: Connection;
  coreReady: boolean;
  busy: string | null;
};

function firstText(source: unknown, ...keys: string[]): string | undefined {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return undefined;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const val = record[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function SettingsView({
  selectedProject,
  codexAccount,
  deviceCode,
  onRequestDeviceCode,
  apiKey,
  onApiKeyChange,
  onSaveApiKey,
  runtimeUpdate,
  connection,
  coreReady,
  busy
}: SettingsViewProps) {
  const [showApiKey, setShowApiKey] = useState(false);
  const isRequestingCode = busy === "device-code";
  const isSavingApiKey = busy === "api-key";

  return (
    <div class="settings-layout" aria-label="설정 및 계정 관리 화면">
      {/* 1. Codex Account */}
      <section class="panel setting-card">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">계정 연결</p>
            <h2>Codex 로그인</h2>
          </div>
          <span
            class={`account-status-badge ${
              codexAccount?.authenticated && codexAccount.chatgpt ? "active" : ""
            }`}
          >
            {codexAccount?.authenticated && codexAccount.chatgpt ? "✓ 연결됨" : "미연결"}
          </span>
        </div>

        <p class="setting-desc">
          {codexAccount?.authenticated && codexAccount.chatgpt
            ? `ChatGPT (${codexAccount.plan_type || "Pro"}) 계정으로 연결되어 있습니다.`
            : coreReady
            ? "브라우저에서 간편하게 로그인할 수 있는 장치 인증 코드를 요청합니다."
            : "관리 런타임이 준비된 후 로그인할 수 있습니다."}
        </p>

        <button
          class="button"
          type="button"
          onClick={onRequestDeviceCode}
          disabled={isRequestingCode || connection !== "connected" || !coreReady}
        >
          {isRequestingCode
            ? "인증 코드 요청 중…"
            : codexAccount?.authenticated && codexAccount.chatgpt
            ? "다시 로그인 / 재인증"
            : "장치 로그인 코드 요청"}
        </button>

        {deviceCode && !(codexAccount?.authenticated && codexAccount.chatgpt) && (
          <div class="device-code-card">
            {firstText(deviceCode, "user_code") && (
              <div class="user-code-row">
                <span>인증 코드:</span>
                <strong class="user-code-value">{firstText(deviceCode, "user_code")}</strong>
              </div>
            )}

            {firstText(deviceCode, "verification_uri_complete", "verification_uri") && (
              <button
                class="button secondary small"
                type="button"
                onClick={() =>
                  window.open(
                    firstText(deviceCode, "verification_uri_complete", "verification_uri"),
                    "_blank"
                  )
                }
              >
                브라우저에서 로그인 페이지 열기 ↗
              </button>
            )}

            {numberValue(deviceCode.expires_in) && (
              <small class="code-expiry-note">
                {numberValue(deviceCode.expires_in)}초 이내에 브라우저에서 승인하세요.
              </small>
            )}
          </div>
        )}
      </section>

      {/* 2. OpenAI API Key for embeddings */}
      <section class="panel setting-card">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">지식 검색 연결 (선택 사항)</p>
            <h2>OpenAI API 키</h2>
          </div>
        </div>

        <p class="setting-desc">
          장기 기억과 지식 검색에 사용할 OpenAI 임베딩 API 키를 등록합니다. 대화와 연구 실행에는 위의
          Codex 로그인이 별도로 필요합니다.
        </p>

        <form class="api-key-form" onSubmit={onSaveApiKey}>
          <div class="api-key-input-row">
            <input
              id="api-key-input"
              type={showApiKey ? "text" : "password"}
              value={apiKey}
              onInput={(e) => onApiKeyChange(e.currentTarget.value)}
              placeholder="sk-..."
              disabled={connection !== "connected"}
            />
            <button
              type="button"
              class="button secondary small"
              onClick={() => setShowApiKey((v) => !v)}
            >
              {showApiKey ? "숨김" : "표시"}
            </button>
          </div>

          <div class="api-key-footer">
            <span>키는 로컬 머신에 안전하게 암호화되어 보관됩니다.</span>
            <button
              class="button small"
              type="submit"
              disabled={isSavingApiKey || !apiKey.trim() || connection !== "connected"}
            >
              {isSavingApiKey ? "저장 중…" : "API 키 저장"}
            </button>
          </div>
        </form>
      </section>

      {/* 3. Runtime & Stability Channel */}
      <section class="panel setting-card">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">런타임 상태</p>
            <h2>업데이트 및 연결 정보</h2>
          </div>
        </div>

        <div class="runtime-update-grid">
          <div>
            <span>배포 피드</span>
            <strong>{runtimeUpdate?.configured === true ? "서명 검증 사용" : "표준 피드"}</strong>
          </div>
          <div>
            <span>채널</span>
            <strong>{firstText(runtimeUpdate, "channel") ?? "stable"}</strong>
          </div>
          <div>
            <span>핵심 연결 상태</span>
            <strong>{connection === "connected" ? "✓ 핵심 서비스 연결됨" : "확인 중"}</strong>
          </div>
          <div>
            <span>Webview2 브릿지</span>
            <strong>정상 동작 중</strong>
          </div>
        </div>
      </section>

      {/* 4. Project Lifecycle & Cleanup */}
      <LifecycleControls
        project={selectedProject}
        connected={connection === "connected"}
      />
    </div>
  );
}
