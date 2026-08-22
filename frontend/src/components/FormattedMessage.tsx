import { useState } from "preact/hooks";

export type FormattedMessageProps = {
  text: string;
};

export function inlineMessageContent(text: string) {
  const segments: Array<{ text: string; code: boolean }> = [];
  let cursor = 0;
  const inlineCodeRegex = /`([^`]+)`/g;
  let match: RegExpExecArray | null = inlineCodeRegex.exec(text);
  while (match !== null) {
    if (match.index > cursor) {
      segments.push({ text: text.slice(cursor, match.index), code: false });
    }
    segments.push({ text: match[1], code: true });
    cursor = inlineCodeRegex.lastIndex;
    match = inlineCodeRegex.exec(text);
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), code: false });
  }
  return segments.map((seg, idx) =>
    seg.code ? <code key={idx}>{seg.text}</code> : <span key={idx}>{seg.text}</span>
  );
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  }

  return (
    <div class="chat-code-wrapper">
      <div class="chat-code-header">
        <span class="chat-code-lang">{language || "text"}</span>
        <button
          type="button"
          class="chat-code-copy-btn"
          onClick={handleCopy}
          aria-label="코드 복사"
        >
          {copied ? "✓ 복사 완료" : "복사"}
        </button>
      </div>
      <pre class="chat-code">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function FormattedMessage({ text }: FormattedMessageProps) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return (
    <div class="rich-chat-content">
      {parts.map((part, index) => {
        if (part.startsWith("```") && part.endsWith("```")) {
          const lines = part.slice(3, -3).split("\n");
          const firstLine = lines[0].trim();
          const language = firstLine || "";
          const codeContent = lines.slice(firstLine ? 1 : 0).join("\n");
          return <CodeBlock key={index} code={codeContent} language={language} />;
        }
        const paragraphs = part.split(/\n\n+/);
        return paragraphs.map((paragraph, pIndex) => {
          if (!paragraph.trim()) return null;
          if (paragraph.startsWith("# ")) {
            return (
              <h3 class="chat-heading level-1" key={`${index}-${pIndex}`}>
                {paragraph.slice(2)}
              </h3>
            );
          }
          if (paragraph.startsWith("## ")) {
            return (
              <h4 class="chat-heading level-2" key={`${index}-${pIndex}`}>
                {paragraph.slice(3)}
              </h4>
            );
          }
          if (paragraph.startsWith("> ")) {
            return <blockquote key={`${index}-${pIndex}`}>{paragraph.slice(2)}</blockquote>;
          }
          const lines = paragraph.split("\n");
          if (
            lines.every(
              (line) =>
                line.trim().startsWith("- ") ||
                line.trim().startsWith("* ") ||
                /^\d+\.\s/.test(line.trim())
            )
          ) {
            const isOrdered = /^\d+\.\s/.test(lines[0].trim());
            if (isOrdered) {
              return (
                <ol key={`${index}-${pIndex}`}>
                  {lines.map((line, lIndex) => (
                    <li key={lIndex}>
                      {inlineMessageContent(line.replace(/^\d+\.\s+/, ""))}
                    </li>
                  ))}
                </ol>
              );
            }
            return (
              <ul key={`${index}-${pIndex}`}>
                {lines.map((line, lIndex) => (
                  <li key={lIndex}>{inlineMessageContent(line.replace(/^[-*]\s+/, ""))}</li>
                ))}
              </ul>
            );
          }
          return (
            <p key={`${index}-${pIndex}`}>
              {lines.map((line, lIndex) => (
                <span key={lIndex}>
                  {inlineMessageContent(line)}
                  {lIndex < lines.length - 1 ? <br /> : null}
                </span>
              ))}
            </p>
          );
        });
      })}
    </div>
  );
}
