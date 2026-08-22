import type { ContextProfile, ContextWindowUsage } from "../types";

export type ContextMeterProps = {
  contextUsage: ContextWindowUsage | null;
  selectedContextProfile: ContextProfile;
  contextDetailsOpen: boolean;
  onToggleContextDetails: () => void;
};

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return tokens.toLocaleString();
}

export function ContextMeter({
  contextUsage,
  selectedContextProfile,
  contextDetailsOpen,
  onToggleContextDetails
}: ContextMeterProps) {
  if (!contextUsage) return null;

  const contextPercent = contextUsage.used_percent;
  const contextTone =
    contextPercent > 80 ? "critical" : contextPercent > 50 ? "warning" : "normal";

  return (
    <div class="context-meter">
      <button
        type="button"
        class={`context-indicator ${contextTone}`}
        onClick={onToggleContextDetails}
        aria-expanded={contextDetailsOpen}
        title={`컨텍스트 창 사용량: ${contextPercent}%`}
      >
        <span
          class="context-ring"
          style={{ "--context-progress": `${Math.min(100, contextPercent)}%` }}
        />
      </button>

      {contextDetailsOpen && (
        <div class="context-popover" role="dialog">
          <div class="context-popover-head">
            <span>컨텍스트 창</span>
            <strong>{contextPercent}%</strong>
          </div>
          <div class="context-usage-numbers">
            <strong>{formatTokenCount(contextUsage.current_tokens)}</strong>
            <span>/ {formatTokenCount(contextUsage.context_window)} 토큰</span>
          </div>
          <div class="context-usage-bar">
            <span style={{ width: `${Math.min(100, contextPercent)}%` }} />
          </div>
          <small>
            입력: {formatTokenCount(contextUsage.input_tokens)} · 출력:{" "}
            {formatTokenCount(contextUsage.output_tokens)}
          </small>
          {selectedContextProfile === "long_1m" && (
            <p>
              <small class="context-profile-ok">✓ 1M 대용량 컨텍스트 프로필 사용 중</small>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
