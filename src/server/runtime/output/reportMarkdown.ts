export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  const paragraph: string[] = [];
  let listKind: "ul" | "ol" | undefined;
  let inCode = false;
  let codeLines: string[] = [];
  let inTable = false;
  let tableRows = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${formatInline(paragraph.join(" "))}</p>`);
    paragraph.length = 0;
  };
  const closeList = () => {
    if (!listKind) return;
    html.push(`</${listKind}>`);
    listKind = undefined;
  };
  const closeTable = () => {
    if (!inTable) return;
    html.push("</tbody></table></div>");
    inTable = false;
    tableRows = 0;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flushParagraph();
      closeList();
      closeTable();
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      closeList();
      closeTable();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      closeList();
      closeTable();
      const level = Math.min(heading[1]?.length ?? 1, 3);
      html.push(`<h${level}>${formatInline(heading[2] ?? "")}</h${level}>`);
      continue;
    }
    if (isTableRow(trimmed)) {
      flushParagraph();
      closeList();
      if (isTableSeparator(trimmed)) continue;
      if (!inTable) {
        html.push('<div class="table-block"><table>');
        inTable = true;
      }
      const cells = splitTableCells(trimmed);
      const cellTag = tableRows === 0 ? "th" : "td";
      const row = cells.map((cell) => `<${cellTag}>${formatInline(cell)}</${cellTag}>`).join("");
      html.push(tableRows === 0 ? `<thead><tr>${row}</tr></thead><tbody>` : `<tr>${row}</tr>`);
      tableRows += 1;
      continue;
    }
    closeTable();
    const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    if (unordered) {
      flushParagraph();
      if (listKind !== "ul") {
        closeList();
        html.push("<ul>");
        listKind = "ul";
      }
      html.push(`<li>${formatInline(unordered[1] ?? "")}</li>`);
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (listKind !== "ol") {
        closeList();
        html.push("<ol>");
        listKind = "ol";
      }
      html.push(`<li>${formatInline(ordered[1] ?? "")}</li>`);
      continue;
    }
    if (trimmed.startsWith(">")) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${formatInline(trimmed.replace(/^>\s?/, ""))}</blockquote>`);
      continue;
    }
    closeList();
    paragraph.push(trimmed);
  }
  if (inCode) html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  flushParagraph();
  closeList();
  closeTable();
  return html.join("\n");
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function isTableRow(line: string): boolean {
  return line.startsWith("|") && line.endsWith("|") && line.slice(1, -1).includes("|");
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line);
}

function splitTableCells(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function formatInline(value: string): string {
  return value
    .split(/(`[^`]+`)/g)
    .map((part) => (part.startsWith("`") && part.endsWith("`") && part.length > 1 ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : escapeHtml(part)))
    .join("");
}
