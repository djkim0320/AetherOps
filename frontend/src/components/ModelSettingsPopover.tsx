import type { ContextProfile, ModelOption, Speed } from "../types";

export type ModelSettingsPopoverProps = {
  modelSettingsOpen: boolean;
  modelOptions: ModelOption[];
  selectedModel: string;
  selectedEffort: string;
  selectedSpeed: Speed;
  selectedContextProfile: ContextProfile;
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
};

export function effortLabel(effort: string): string {
  switch (effort) {
    case "low":
      return "낮음 (빠른 탐색)";
    case "medium":
      return "보통 (표준 균형)";
    case "high":
      return "높음 (심층 분석)";
    default:
      return effort || "기본값";
  }
}

export function effortCompactLabel(effort: string): string {
  switch (effort) {
    case "low":
      return "낮음";
    case "medium":
      return "보통";
    case "high":
      return "높음";
    default:
      return effort || "기본";
  }
}

export function ModelSettingsPopover({
  modelSettingsOpen,
  modelOptions,
  selectedModel,
  selectedEffort,
  selectedSpeed,
  selectedContextProfile,
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
  onCloseModelSettings
}: ModelSettingsPopoverProps) {
  return (
    <div class="model-settings">
      <button
        type="button"
        class="model-settings-trigger"
        onClick={onToggleModelSettings}
        aria-expanded={modelSettingsOpen}
      >
        <span>{selectedModelOption?.display_name ?? selectedModel ?? "모델 선택"}</span>
        <span class="chevron">⌄</span>
      </button>

      {modelSettingsOpen && (
        <div class="model-settings-popover" role="dialog">
          <div class="model-popover-header">
            <div>
              <span>추론 모델</span>
              <strong>{selectedModelOption?.display_name ?? selectedModel}</strong>
            </div>
            <button type="button" onClick={onCloseModelSettings} aria-label="닫기">
              ✕
            </button>
          </div>

          <div class="model-option-list">
            {modelOptions.map((opt) => (
              <button
                type="button"
                key={opt.id}
                class={`model-option ${opt.id === selectedModel ? "active" : ""}`}
                onClick={() => onSelectModel(opt.id)}
              >
                <span>
                  <strong>{opt.display_name}</strong>
                  <small>{opt.id}</small>
                </span>
                {opt.id === selectedModel && <i>✓</i>}
              </button>
            ))}
          </div>

          {reasoningOptions.length > 0 && (
            <div class="reasoning-setting">
              <div class="setting-line">
                <span>추론 노력 (Reasoning)</span>
                <strong>{effortLabel(selectedEffort)}</strong>
              </div>
              <input
                type="range"
                min={0}
                max={reasoningOptions.length - 1}
                value={reasoningIndex}
                style={{ "--range-progress": `${reasoningProgress}%` }}
                onInput={(e) => {
                  const nextEffort = reasoningOptions[Number(e.currentTarget.value)];
                  if (nextEffort) onSelectEffort(nextEffort);
                }}
              />
              <div class="range-labels">
                {reasoningOptions.map((effort) => (
                  <span key={effort}>{effortCompactLabel(effort)}</span>
                ))}
              </div>
            </div>
          )}

          <div class="popover-speed">
            <div>
              <span>응답 속도</span>
              <small>
                {selectedSpeed === "fast" ? "우선순위 빠른 응답" : "표준 처리 속도"}
              </small>
            </div>
            <div class="speed-toggle">
              <button
                type="button"
                class={selectedSpeed === "standard" ? "active" : ""}
                onClick={() => onSelectSpeed("standard")}
              >
                표준
              </button>
              <button
                type="button"
                class={selectedSpeed === "fast" ? "active" : ""}
                onClick={() => onSelectSpeed("fast")}
              >
                빠름
              </button>
            </div>
          </div>

          {longContextEligible && (
            <div class="popover-speed context-profile-setting">
              <div>
                <span>1M 대용량 컨텍스트</span>
                <small>GPT-5.6 Sol 전용 대용량 문서 분석</small>
              </div>
              <div class="speed-toggle">
                <button
                  type="button"
                  class={selectedContextProfile === "default" ? "active" : ""}
                  onClick={() => onSelectContextProfile("default")}
                >
                  기본
                </button>
                <button
                  type="button"
                  class={selectedContextProfile === "long_1m" ? "active" : ""}
                  onClick={() => onSelectContextProfile("long_1m")}
                >
                  1M
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
