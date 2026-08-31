import { useState } from "preact/hooks";
import type { Artifact } from "../types";
import { artifactBinaryContent, artifactFormattedText, artifactRawText } from "../artifact-content";
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
  const binaryContent = artifactBinaryContent(content);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(rawText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  }

  function handleDownload() {
    if (!binaryContent) return;
    const url = URL.createObjectURL(binaryContent.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = binaryContent.filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
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
            {!binaryContent && (
              <button
                type="button"
                class="button secondary small"
                onClick={() => setViewMode((m) => (m === "formatted" ? "raw" : "formatted"))}
              >
                {viewMode === "formatted" ? "원문 (JSON/Raw)" : "서식 보기"}
              </button>
            )}
            {!binaryContent && (
              <button
                type="button"
                class="button secondary small"
                onClick={handleCopy}
                disabled={!rawText}
              >
                {copied ? "✓ 복사 완료" : "복사"}
              </button>
            )}
            {binaryContent && (
              <button type="button" class="button secondary small" onClick={handleDownload}>
                Word 보고서 다운로드
              </button>
            )}
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
          ) : binaryContent ? (
            <div class="empty-state artifact-document-ready">
              <strong>템플릿 보고서가 준비되었습니다.</strong>
              <span>{binaryContent.filename}</span>
              <span>{(binaryContent.size / 1024).toFixed(1)} KB · SHA-256 검증 완료</span>
              <button type="button" class="button primary" onClick={handleDownload}>
                Word 보고서 다운로드
              </button>
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
