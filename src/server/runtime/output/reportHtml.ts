import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { escapeHtml, renderMarkdown } from "./reportMarkdown.js";

interface ReportHtmlInput {
  title: string;
  projectId: string;
  markdown: string;
  createdAt: string;
}

export function renderPdfHtml(input: ReportHtmlInput): string {
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

let cachedReportFontFace: string | undefined;

function requiredReportFontFace(): string {
  if (cachedReportFontFace) return cachedReportFontFace;
  const fontPath = requiredReportFontPath();
  const mimeType = extname(fontPath).toLowerCase() === ".ttf" ? "font/ttf" : "font/otf";
  const format = mimeType === "font/ttf" ? "truetype" : "opentype";
  cachedReportFontFace = `@font-face { font-family: "AetherOpsReportFont"; font-style: normal; font-weight: 400 900; src: url("data:${mimeType};base64,${readFileSync(fontPath).toString("base64")}") format("${format}"); }`;
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
  if (!fontPath)
    throw new Error("PDF report rendering requires a local Unicode CJK font such as Malgun Gothic, Apple SD Gothic Neo, Noto Sans CJK, or Nanum Gothic.");
  return fontPath;
}

const pdfCss = `
@page { size: A4; }
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: #202123; font-family: "AetherOpsReportFont", sans-serif; font-size: 10.5pt; line-height: 1.55; }
.report { width: 100%; }
.cover { border-bottom: 1px solid #d8d8d3; margin-bottom: 18px; padding-bottom: 16px; }
.eyebrow { color: #6b7280; font-size: 8.5pt; font-weight: 700; letter-spacing: .04em; margin: 0 0 8px; text-transform: uppercase; }
h1 { color: #111; font-size: 22pt; line-height: 1.18; margin: 0 0 12px; break-after: avoid-page; }
h2 { border-top: 1px solid #e3e3df; color: #171717; font-size: 15pt; line-height: 1.25; margin: 20px 0 8px; padding-top: 12px; break-after: avoid-page; }
h3 { color: #202123; font-size: 12pt; margin: 14px 0 6px; break-after: avoid-page; }
p { margin: 0 0 10px; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 10px 18px; padding: 0; }
li { margin: 0 0 4px; }
.meta { display: grid; gap: 4px; margin: 10px 0 0; }
.meta div { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 8px; }
dt { color: #6b7280; font-weight: 700; }
dd { margin: 0; overflow-wrap: anywhere; }
code { background: #f4f4f2; border: 1px solid #e3e3df; border-radius: 4px; font-family: "Cascadia Mono", Consolas, monospace; font-size: 9pt; padding: 1px 4px; }
pre { background: #f7f7f5; border: 1px solid #deded9; border-radius: 6px; margin: 0 0 12px; padding: 9px 10px; white-space: pre-wrap; word-break: break-word; }
pre code { background: transparent; border: 0; padding: 0; }
.table-block { break-inside: auto; margin: 8px 0 14px; width: 100%; }
table { border-collapse: collapse; break-inside: auto; font-size: 8pt; margin: 0; table-layout: fixed; width: 100%; }
thead { display: table-header-group; }
tr { break-inside: avoid-page; }
th, td { border: 1px solid #d9d9d4; padding: 5px 6px; text-align: left; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
th { background: #eeeeeb; color: #171717; font-weight: 800; }
blockquote { border-left: 3px solid #c9c9c3; color: #4b5563; margin: 8px 0 12px; padding: 4px 0 4px 10px; }
`;
