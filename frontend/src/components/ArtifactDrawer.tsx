import { useState } from "preact/hooks";
import type { Artifact } from "../types";
import { artifactFormattedText, artifactRawText } from "../artifact-content";
import { FormattedMessage } from "./FormattedMessage";

export type ArtifactPresentation = {
  title: string;
  label: string;
  description: string;
  tone: string;
};

export type ArtifactDrawerProps = {
  artifact: Artifact | null;
  content: unknown;
  presentation: ArtifactPresentation | null;
  busy: boolean;
  onClose: () => void;
};

export function ArtifactDrawer({
  artifact,
  content,
  presentation,
  busy,
  onClose
}: ArtifactDrawerProps) {
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<"formatted" | "raw">("formatted");

  if (!artifact) return null;

  const rawText = artifactRawText(content);
  const formattedText = artifactFormattedText(artifact.kind, content);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(rawText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  }

  return (
    <div class="artifact-drawer-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div class="artifact-drawer-panel" onClick={(e) => e.stopPropagation()}>
        <header class="artifact-drawer-header">
          <div>
            <div class="artifact-drawer-tags">
              <span class={`artifact-kind ${presentation?.tone ?? ""}`}>
                {presentation?.label ?? artifact.kind}
              </span>
              {artifact.adopted && <span class="artifact-adopted-badge">✓ 채택됨</span>}
            </div>
            <h2>{presentation?.title ?? artifact.kind}</h2>
            {presentation?.description && <p>{presentation.description}</p>}
          </div>

          <div class="artifact-drawer-actions">
            <button
              type="button"
              class="button secondary small"
              onClick={() => setViewMode((m) => (m === "formatted" ? "raw" : "formatted"))}
            >
              {viewMode === "formatted" ? "원문 (JSON/Raw)" : "서식 보기"}
            </button>
            <button
              type="button"
              class="button secondary small"
              onClick={handleCopy}
              disabled={!rawText}
            >
              {copied ? "✓ 복사 완료" : "복사"}
            </button>
            <button
              type="button"
              class="artifact-drawer-close"
              onClick={onClose}
              aria-label="서랍 닫기"
            >
              ✕
            </button>
          </div>
        </header>

        <div class="artifact-drawer-body">
          {busy ? (
            <div class="empty-state">
              <strong>산출물 불러오는 중…</strong>
              <span>내용을 가져오고 있습니다.</span>
            </div>
          ) : !content ? (
            <div class="empty-state">
              <strong>표시할 내용이 없습니다</strong>
              <span>산출물 데이터가 비어 있습니다.</span>
            </div>
          ) : viewMode === "raw" ? (
            <pre class="artifact-raw-code">
              <code>{rawText}</code>
            </pre>
          ) : (
            <FormattedMessage text={formattedText} />
          )}
        </div>
      </div>
    </div>
  );
}
