import type { ResearchTool } from "./researchToolTypes.js";

const canonicalToolOrder = [
  "opencodetool",
  "websearchtool",
  "backgroundbrowsertool",
  "webfetchtool",
  "researchmetadatatool",
  "pdfingestiontool",
  "engineeringprogramtool",
  "artifactwritertool",
  "dataanalysistool"
];

const canonicalToolOrderByName = buildCanonicalToolOrderMap();

export function normalizeToolName(value: string): string {
  return value.replace(toolAnnotationPattern, "").replace(toolWhitespacePattern, "").trim().toLowerCase();
}

export function orderToolNames(values: string[]): string[] {
  const output: string[] = [];
  for (const item of orderedToolEntries(values)) output.push(item.value);
  return output;
}

export function dedupeResearchTools(tools: ResearchTool[]): ResearchTool[] {
  const map = new Map<string, ResearchTool>();
  for (const tool of tools) {
    map.set(normalizeToolName(tool.name), tool);
  }
  const deduped: ResearchTool[] = [];
  for (const tool of map.values()) deduped.push(tool);
  return deduped;
}

function buildCanonicalToolOrderMap(): Map<string, number> {
  const order = new Map<string, number>();
  for (let index = 0; index < canonicalToolOrder.length; index += 1) {
    order.set(canonicalToolOrder[index] as string, index);
  }
  return order;
}

function orderedToolEntries(values: string[]): Array<{ normalized: string; value: string }> {
  const ordered: Array<{ normalized: string; value: string }> = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeToolName(value);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      ordered.push({ normalized, value });
    }
  }
  if (ordered.length > 1) {
    ordered.sort((left, right) => {
      const leftIndex = canonicalToolOrderByName.get(left.normalized);
      const rightIndex = canonicalToolOrderByName.get(right.normalized);
      if (leftIndex === undefined && rightIndex === undefined) return 0;
      if (leftIndex === undefined) return 1;
      if (rightIndex === undefined) return -1;
      return leftIndex - rightIndex;
    });
  }
  return ordered;
}

const toolAnnotationPattern = /\(.*?\)/g;
const toolWhitespacePattern = /\s+/g;
