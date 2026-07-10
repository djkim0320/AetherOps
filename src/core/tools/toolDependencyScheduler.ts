import { normalizeToolName, orderToolNames } from "./toolMerger.js";

export interface ToolFilterOptions {
  includeTools?: string[];
  excludeTools?: string[];
}

export function normalizedRequiredTools(requiredTools: string[]): string[] {
  const normalized: string[] = [];
  for (const tool of orderToolNames(requiredTools)) {
    const name = normalizeToolName(tool);
    if (name !== "opencodetool") normalized.push(name);
  }
  return normalized;
}

export function filterRequiredTools(requiredTools: string[], options: ToolFilterOptions): string[] {
  const include = normalizedToolFilter(options.includeTools);
  const exclude = normalizedToolFilter(options.excludeTools);
  const filtered: string[] = [];
  for (const tool of requiredTools) {
    if (include && !include.has(tool)) continue;
    if (exclude?.has(tool)) continue;
    filtered.push(tool);
  }
  return filtered;
}

export function normalizedToolFilter(tools: string[] | undefined): Set<string> | undefined {
  if (!tools?.length) return undefined;
  const normalized = new Set<string>();
  for (const tool of tools) {
    const name = normalizeToolName(tool);
    if (name && name !== "opencodetool") normalized.add(name);
  }
  return normalized;
}

export function orderedToolNames(values: string[]): string[] {
  return orderToolNames(values);
}
