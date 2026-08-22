import { useEffect, useRef } from "preact/hooks";
import type {
  ChatMode,
  Connection,
  ContextProfile,
  ContextWindowUsage,
  ModelOption,
  Run,
  Speed
} from "../types";
import { SLASH_COMMANDS, STATUS_LABELS } from "../types";
import { researchQuestionDisplay } from "../research-display";
import { ContextMeter } from "./ContextMeter";
import { ModelSettingsPopover } from "./ModelSettingsPopover";

export type ChatComposerProps = {
  query: string;
  onQueryChange: (val: string) => void;
  onSubmit: () => void;
  onKeyDown: (e: globalThis.KeyboardEvent) => void;
  chatMode: ChatMode;
  onClosePlanMode: () => void;
  slashMenuOpen: boolean;
  slashQuery: string;
  onSelectSlashCommand: (command: string) => void;
  coreReady: boolean;
  connection: Connection;
  selectedSessionID: string;
  sessionBusy: boolean;
  busy: string | null;
  activeRun: Run | null;
  artifactsCount: number | null;
  onOpenActiveRun: () => void;
  composerRef: { current: HTMLTextAreaElement | null };

  // Context usage
  contextUsage: ContextWindowUsage | null;
  selectedContextProfile: ContextProfile;
  contextDetailsOpen: boolean;
  onToggleContextDetails: () => void;

  // Model settings
  modelSettingsOpen: boolean;
  modelOptions: ModelOption[];
  selectedModel: string;
  selectedEffort: string;
  selectedSpeed: Speed;
  reasoningOptions: string[];
  reasoningIndex: number;
  reasoningProgress: number;
  longContextEligible: boolean;
  selectedModelOption: ModelOption | undefined;
  onSelectModel: (id: string) => void;
  onSelectEffort: (effort: string) => void;
  onSelectSpeed: (speed: Speed) => void;
  onSelectContextProfile: (profile: ContextProfile) => void;
  onToggleModelSettings: () => void;
  onCloseModelSettings: () => void;

  // Prompt chips
  onSelectPromptChip: (promptText: string) => void;
};

const PROMPT_CHIPS = [
  { label: "프로젝트 분석", text: "프로젝트 아키텍처와 주요 의존성을 분석해줘" },
  { label: "성능 최적화", text: "시스템 병목 지점과 성능 최적화 방안을 검토해줘" },
  { label: "단위 테스트", text: "핵심 모듈에 대한 포괄적인 단위 테스트 계획을 세워줘" },
  { label: "계획 수립", text: "/plan" }
];

export function ChatComposer({
  query,
  onQueryChange,
  onSubmit,
  onKeyDown,
  chatMode,
  onClosePlanMode,
  slashMenuOpen,
  slashQuery,
  onSelectSlashCommand,
  coreReady,
  connection,
  selectedSessionID,
  sessionBusy,
  busy,
  activeRun,
  artifactsCount,
  onOpenActiveRun,
  composerRef,
  contextUsage,
  selectedContextProfile,
  contextDetailsOpen,
  onToggleContextDetails,
  modelSettingsOpen,
  modelOptions,
  selectedModel,
  selectedEffort,
  selectedSpeed,
  reasoningOptions,
  reasoningIndex,
  reasoningProgress,
  longContextEligible,
  selectedModelOption,
  onSelectModel,
  onSelectEffort,
  onSelectSpeed,
  onSelectContextProfile,
  onToggleModelSettings,
  onCloseModelSettings,
  onSelectPromptChip
}: ChatComposerProps) {
  // Auto-resize textarea
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const nextHeight = Math.min(el.scrollHeight, 180);
    el.style.height = `${Math.max(44, nextHeight)}px`;
  }, [query, composerRef]);

  const filteredSlashCommands = SLASH_COMMANDS.filter(
    (cmd) =>
      cmd.command.toLowerCase().includes(slashQuery.toLowerCase()) ||
      cmd.label.toLowerCase().includes(slashQuery.toLowerCase())
  );

  return (
    <div class="composer-dock">
      {/* Quick Prompt Chips */}
      {!query && (
        <div class="composer-quick-chips" role="toolbar" aria-label="빠른 입력 칩">
          {PROMPT_CHIPS.map((chip) => (
            <button
              type="button"
              key={chip.label}
              class="composer-chip-btn"
              onClick={() => onSelectPromptChip(chip.text)}
              disabled={!coreReady || sessionBusy || connection !== "connected"}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

      {/* Active Run Status Pill */}
      {activeRun && (
        <button
          type="button"
          class={`composer-activity-pill ${activeRun.status}`}
          onClick={onOpenActiveRun}
          title="활성 연구 상세 확인"
        >
          <span>{researchQuestionDisplay(activeRun.question).text}</span>
          <strong>{STATUS_LABELS[activeRun.status] ?? activeRun.status}</strong>
          <em>{artifactsCount !== null ? `${artifactsCount}개 산출물` : "산출물 확인 중"}</em>
        </button>
      )}

      {/* Main Composer Box */}
      <div class={`chat-composer ${chatMode === "plan" ? "plan-mode" : ""}`}>
        {chatMode === "plan" && (
          <div class="plan-mode-strip">
            <span class="plan-mode-icon">P</span>
            <div>
              <strong>계획 모드</strong>
              <small>질문을 주고받으며 연구 목표와 검증 범위를 정리합니다.</small>
            </div>
            <button
              type="button"
              onClick={onClosePlanMode}
              title="계획 모드 닫기 (/chat)"
              aria-label="계획 모드 닫기"
            >
              ✕
            </button>
          </div>
        )}

        {/* Slash Command Popover */}
        {slashMenuOpen && (
          <div class="slash-command-menu" role="menu">
            <div class="slash-menu-head">
              <span>슬래시 명령어</span>
              <kbd>ESC 닫기</kbd>
            </div>
            {filteredSlashCommands.map((cmd) => (
              <button
                key={cmd.command}
                type="button"
                onClick={() => onSelectSlashCommand(cmd.command)}
              >
                <i>{cmd.glyph}</i>
                <span>
                  <strong>{cmd.label}</strong>
                  <small>{cmd.description}</small>
                </span>
                <code>{cmd.command}</code>
              </button>
            ))}
          </div>
        )}

        <textarea
          ref={composerRef}
          value={query}
          onInput={(e) => onQueryChange(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder=""
          aria-label="메시지 입력"
          rows={1}
          disabled={!coreReady || sessionBusy || connection !== "connected"}
        />

        <div class="chat-composer-footer">
          <div class="composer-mode-label">
            <i class={chatMode === "plan" ? "plan" : ""}>
              {chatMode === "plan" ? "계획 모드" : "대화"}
            </i>
            <span>Enter 전송 · Shift+Enter 줄바꿈 · Ctrl+Enter 스티어링</span>
          </div>

          <div class="composer-actions-row">
            <ContextMeter
              contextUsage={contextUsage}
              selectedContextProfile={selectedContextProfile}
              contextDetailsOpen={contextDetailsOpen}
              onToggleContextDetails={onToggleContextDetails}
            />

            <ModelSettingsPopover
              modelSettingsOpen={modelSettingsOpen}
              modelOptions={modelOptions}
              selectedModel={selectedModel}
              selectedEffort={selectedEffort}
              selectedSpeed={selectedSpeed}
              selectedContextProfile={selectedContextProfile}
              reasoningOptions={reasoningOptions}
              reasoningIndex={reasoningIndex}
              reasoningProgress={reasoningProgress}
              longContextEligible={longContextEligible}
              selectedModelOption={selectedModelOption}
              onSelectModel={onSelectModel}
              onSelectEffort={onSelectEffort}
              onSelectSpeed={onSelectSpeed}
              onSelectContextProfile={onSelectContextProfile}
              onToggleModelSettings={onToggleModelSettings}
              onCloseModelSettings={onCloseModelSettings}
            />

            <button
              type="button"
              class="send-button"
              onClick={onSubmit}
              disabled={
                !coreReady ||
                sessionBusy ||
                !query.trim() ||
                connection !== "connected" ||
                busy === "run"
              }
              aria-label="전송"
            >
              ↑
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
