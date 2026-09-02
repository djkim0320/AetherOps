import { useEffect, useRef, useState } from "preact/hooks";
import { attachmentAccept, formatAttachmentSize, type ChatAttachmentDraft } from "../chat-attachments";
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
import { COMPOSER_PROMPT_CHIPS, composerModePresentation } from "../composer-mode";
import { researchQuestionDisplay } from "../research-display";
import { ContextMeter } from "./ContextMeter";
import { ModelSettingsPopover } from "./ModelSettingsPopover";

export type ChatComposerProps = {
  query: string;
  onQueryChange: (val: string) => void;
  onSubmit: () => void;
  onKeyDown: (e: globalThis.KeyboardEvent) => void;
  chatMode: ChatMode;
  onSelectPlanMode: () => void;
  onClosePlanMode: () => void;
  slashMenuOpen: boolean;
  slashQuery: string;
  onSelectSlashCommand: (command: string) => void;
  coreReady: boolean;
  connection: Connection;
  sessionBusy: boolean;
  busy: string | null;
  activeRun: Run | null;
  artifactsCount: number | null;
  onOpenActiveRun: () => void;
  composerRef: { current: HTMLTextAreaElement | null };
  attachments: ChatAttachmentDraft[];
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;

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

export function ChatComposer({
  query,
  onQueryChange,
  onSubmit,
  onKeyDown,
  chatMode,
  onSelectPlanMode,
  onClosePlanMode,
  slashMenuOpen,
  slashQuery,
  onSelectSlashCommand,
  coreReady,
  connection,
  sessionBusy,
  busy,
  activeRun,
  artifactsCount,
  onOpenActiveRun,
  composerRef,
  attachments,
  onAddFiles,
  onRemoveAttachment,
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragDepth, setDragDepth] = useState(0);
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
  const modePresentation = composerModePresentation(chatMode);

  return (
    <div class="composer-dock">
      {/* Quick Prompt Chips */}
      {!query && (
        <div class="composer-quick-chips" role="toolbar" aria-label="빠른 입력 칩">
          {COMPOSER_PROMPT_CHIPS.map((chip) => (
            <button
              type="button"
              key={chip.label}
              class="composer-chip-btn"
              onClick={() =>
                chip.kind === "mode"
                  ? onSelectPlanMode()
                  : onSelectPromptChip(chip.value)
              }
              disabled={
                !coreReady ||
                sessionBusy ||
                connection !== "connected"
              }
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
      <div
        class={`chat-composer ${chatMode === "plan" ? "plan-mode" : ""} ${dragDepth > 0 ? "drag-active" : ""}`}
        onDragEnter={(event) => {
          if (!event.dataTransfer?.types.includes("Files")) return;
          event.preventDefault();
          setDragDepth((depth) => depth + 1);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer?.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragDepth((depth) => Math.max(0, depth - 1));
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragDepth(0);
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length) onAddFiles(files);
        }}
      >
        {dragDepth > 0 && <div class="attachment-drop-overlay">파일을 놓아 첨부</div>}
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

        {attachments.length > 0 && (
          <div class="attachment-list" aria-label="첨부 파일">
            {attachments.map((attachment) => (
              <span class="attachment-chip" key={attachment.id} title={attachment.name}>
                <b aria-hidden="true">{attachment.kind === "image" ? "▧" : attachment.kind === "document" ? "▰" : "▤"}</b>
                <span>{attachment.name}</span>
                <small>{formatAttachmentSize(attachment.size)}</small>
                <button type="button" onClick={() => onRemoveAttachment(attachment.id)} aria-label={`${attachment.name} 첨부 제거`}>×</button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={composerRef}
          value={query}
          onInput={(e) => onQueryChange(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder={modePresentation.placeholder}
          aria-label="메시지 입력"
          rows={1}
          disabled={!coreReady || sessionBusy || connection !== "connected"}
        />

        <div class="chat-composer-footer">
          <div class="composer-left-row">
            <input
              ref={fileInputRef}
              class="attachment-file-input"
              type="file"
              multiple
              accept={attachmentAccept()}
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                if (files.length) onAddFiles(files);
              }}
            />
            <button
              type="button"
              class="attachment-add-button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!coreReady || sessionBusy || connection !== "connected"}
              title="파일 첨부"
              aria-label="파일 첨부"
            >+</button>
            <div
              class={`composer-mode-label ${modePresentation.active ? "plan-active" : ""}`}
              aria-live="polite"
            >
              <span
                class={`composer-mode-badge ${modePresentation.active ? "plan" : ""}`}
                role="status"
              >
                <b aria-hidden="true">{modePresentation.glyph}</b>
                <span>{modePresentation.label}</span>
              </span>
              <span class="composer-key-hint">
                Enter 전송 · Shift+Enter 줄바꿈 · Ctrl+Enter 스티어링
              </span>
            </div>
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
                (!query.trim() && attachments.length === 0) ||
                connection !== "connected" ||
                busy === "run" ||
                busy === "conversation-bootstrap"
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
