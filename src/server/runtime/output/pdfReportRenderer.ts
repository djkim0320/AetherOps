import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { chromium } from "playwright";

export interface PdfReportRenderInput {
  title: string;
  projectId: string;
  markdown: string;
  outputPath: string;
  createdAt: string;
}

export async function writePdfReport(input: PdfReportRenderInput): Promise<void> {
  mkdirSync(dirname(input.outputPath), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
    await page.setContent(renderPdfHtml(input), { waitUntil: "load" });
    await page.emulateMedia({ media: "print" });
    await page.pdf({
      path: input.outputPath,
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate:
        '<div style="font-family: Arial, sans-serif; font-size: 8px; color: #6b7280; padding-left: 36px; width: 100%;">AetherOps research report</div>',
      footerTemplate:
        '<div style="font-family: Arial, sans-serif; font-size: 8px; color: #6b7280; padding: 0 36px; width: 100%; display: flex; justify-content: space-between;"><span>AetherOps research report</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
      margin: {
        top: "18mm",
        right: "16mm",
        bottom: "18mm",
        left: "16mm"
      }
    });
  } finally {
    await browser.close();
  }
}

function renderPdfHtml(input: PdfReportRenderInput): string {
  return [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8" />',
    `<title>${escapeHtml(input.title)}</title>`,
    "<style>",
    requiredReportFontFace(),
    pdfCss,
    "</style>",
    "</head>",
    "<body>",
    '<main class="report">',
    '<section class="cover">',
    '<p class="eyebrow">AetherOps Research Report</p>',
    `<h1>${escapeHtml(input.title)}</h1>`,
    '<dl class="meta">',
    `<div><dt>Project ID</dt><dd>${escapeHtml(input.projectId)}</dd></div>`,
    `<div><dt>Created</dt><dd>${escapeHtml(input.createdAt)}</dd></div>`,
    "</dl>",
    "</section>",
    renderMarkdown(input.markdown),
    "</main>",
    "</body>",
    "</html>"
  ].join("\n");
}

const pdfCss = `
@page {
  size: A4;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #ffffff;
  color: #202123;
  font-family: "AetherOpsReportFont", sans-serif;
  font-size: 10.5pt;
  line-height: 1.55;
}

.report {
  width: 100%;
}

.cover {
  border-bottom: 1px solid #d8d8d3;
  margin-bottom: 18px;
  padding-bottom: 16px;
}

.eyebrow {
  color: #6b7280;
  font-size: 8.5pt;
  font-weight: 700;
  letter-spacing: 0.04em;
  margin: 0 0 8px;
  text-transform: uppercase;
}

h1 {
  color: #111111;
  font-size: 22pt;
  line-height: 1.18;
  margin: 0 0 12px;
  page-break-after: avoid;
}

h2 {
  border-top: 1px solid #e3e3df;
  color: #171717;
  font-size: 15pt;
  line-height: 1.25;
  margin: 20px 0 8px;
  padding-top: 12px;
  page-break-after: avoid;
}

h3 {
  color: #202123;
  font-size: 12pt;
  margin: 14px 0 6px;
  page-break-after: avoid;
}

p {
  margin: 0 0 8px;
}

ul,
ol {
  margin: 0 0 10px 18px;
  padding: 0;
}

li {
  margin: 0 0 4px;
}

.meta {
  display: grid;
  gap: 4px;
  margin: 10px 0 0;
}

.meta div {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  gap: 8px;
}

dt {
  color: #6b7280;
  font-weight: 700;
}

dd {
  margin: 0;
  overflow-wrap: anywhere;
}

code {
  background: #f4f4f2;
  border: 1px solid #e3e3df;
  border-radius: 4px;
  font-family: "Cascadia Mono", "Consolas", monospace;
  font-size: 9pt;
  padding: 1px 4px;
}

pre {
  background: #f7f7f5;
  border: 1px solid #deded9;
  border-radius: 6px;
  margin: 0 0 12px;
  padding: 9px 10px;
  white-space: pre-wrap;
  word-break: break-word;
}

pre code {
  background: transparent;
  border: 0;
  padding: 0;
}

table {
  border-collapse: collapse;
  font-size: 8.5pt;
  margin: 8px 0 14px;
  table-layout: fixed;
  width: 100%;
}

thead {
  display: table-header-group;
}

tr {
  break-inside: avoid;
}

th,
td {
  border: 1px solid #d9d9d4;
  padding: 5px 6px;
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}

th {
  background: #eeeeeb;
  color: #171717;
  font-weight: 800;
}

blockquote {
  border-left: 3px solid #c9c9c3;
  color: #4b5563;
  margin: 8px 0 12px;
  padding: 4px 0 4px 10px;
}
`;

let cachedReportFontFace: string | undefined;

function requiredReportFontFace(): string {
  if (cachedReportFontFace) return cachedReportFontFace;
  const fontPath = requiredReportFontPath();
  const mimeType = fontMimeType(fontPath);
  const format = mimeType === "font/ttf" ? "truetype" : "opentype";
  cachedReportFontFace = `@font-face {
  font-family: "AetherOpsReportFont";
  font-style: normal;
  font-weight: 400 900;
  src: url("data:${mimeType};base64,${readFileSync(fontPath).toString("base64")}") format("${format}");
}`;
  return cachedReportFontFace;
}

function requiredReportFontPath(): string {
  const candidates = [
    "C:/Windows/Fonts/malgun.ttf",
    "C:/Windows/Fonts/malgunbd.ttf",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKkr-Regular.otf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/nanum/NanumGothic.ttf"
  ];
  const fontPath = candidates.find((candidate) => existsSync(candidate));
  if (!fontPath) {
    throw new Error("PDF report rendering requires a local Unicode CJK font such as Malgun Gothic, Apple SD Gothic Neo, Noto Sans CJK, or Nanum Gothic.");
  }
  return fontPath;
}

function fontMimeType(fontPath: string): "font/ttf" | "font/otf" {
  const extension = extname(fontPath).toLowerCase();
  return extension === ".ttf" ? "font/ttf" : "font/otf";
}

function renderMarkdown(markdown: string): string {
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
    html.push(tableRows <= 1 ? "</tbody></table>" : "</tbody></table>");
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
        inCode = false;
      } else {
        inCode = true;
      }
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
        html.push("<table><tbody>");
        inTable = true;
      }
      const cells = splitTableCells(trimmed);
      const tag = tableRows === 0 ? "th" : "td";
      html.push(`<tr>${cells.map((cell) => `<${tag}>${formatInline(cell)}</${tag}>`).join("")}</tr>`);
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
  const parts = value.split(/(`[^`]+`)/g);
  return parts
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part);
    })
    .join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
