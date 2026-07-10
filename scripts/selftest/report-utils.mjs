export function table(headers, rows) {
  if (!rows.length) return "No rows.";
  const lines = [tableRow(headers), tableSeparator(headers.length)];
  for (const row of rows) {
    lines.push(tableRow(row));
  }
  return lines.join("\n");
}

export function staticCheckRows(checks = []) {
  const rows = [];
  for (const item of checks) {
    rows.push([item.label, item.skipped ? `SKIPPED (${item.reason})` : item.exitCode === 0 ? "PASS" : "FAIL", String(item.seconds)]);
  }
  return rows;
}

export function grepCheckList(checks = []) {
  if (!checks.length) return "- None.";
  const lines = [];
  for (const item of checks) {
    lines.push(`- ${item.passed ? "PASS" : "FAIL"}: ${item.label}${item.sample ? ` - ${item.sample}` : ""}`);
  }
  return lines.join("\n");
}

export function evidencePolicyTableRows(rows = []) {
  const tableRows = [];
  for (const item of evidencePolicyRowsForReport(rows)) {
    tableRows.push([
      item.id,
      item.traceabilityKind,
      String(item.canSupportHypothesis),
      item.hasCitation ? "yes" : "no",
      item.hasQuote ? "yes" : "no",
      item.sourceQualityTier,
      item.generatedBy,
      item.verdict
    ]);
  }
  return tableRows;
}

export function requiredPathSummary(paths) {
  if (!paths) return "not run";
  if (!paths.length) return "none";
  const parts = [];
  for (const item of paths) {
    parts.push(`${item.exists ? "PASS" : "FAIL"} ${item.path}`);
  }
  return parts.join("; ");
}

export function dbSummariesJson(summaries = []) {
  const output = [];
  for (const item of summaries) {
    output.push({ path: item.path, counts: item.counts });
  }
  return JSON.stringify(output);
}

export function list(items) {
  if (!items.length) return "- None.";
  const lines = [];
  for (const item of items) {
    lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

export function tableRow(values) {
  const cells = [];
  for (const value of values) {
    cells.push(escapeTableCell(value));
  }
  return `| ${cells.join(" | ")} |`;
}

export function tableSeparator(count) {
  const cells = [];
  for (let index = 0; index < count; index += 1) {
    cells.push("---");
  }
  return `| ${cells.join(" | ")} |`;
}

export function escapeTableCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

export function evidencePolicyRowsForReport(rows = []) {
  return rows.length
    ? rows
    : [
        {
          id: "none",
          traceabilityKind: "n/a",
          canSupportHypothesis: false,
          hasCitation: false,
          hasQuote: false,
          sourceQualityTier: "n/a",
          generatedBy: "n/a",
          verdict: "PASS: no evidence rows to inspect"
        }
      ];
}

export function shouldWriteMarkdownBom() {
  const setting = process.env.AETHEROPS_MARKDOWN_BOM?.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(setting ?? "")) return true;
  if (["false", "0", "no", "off"].includes(setting ?? "")) return false;
  return process.platform === "win32";
}

export function withOptionalMarkdownBom(markdown) {
  if (!shouldWriteMarkdownBom() || markdown.startsWith("\uFEFF")) return markdown;
  return `\uFEFF${markdown}`;
}
