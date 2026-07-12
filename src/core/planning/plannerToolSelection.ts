import { normalizeToolName } from "../tools/toolRunner.js";

export const ENGINEERING_PROGRAM_TOOL = normalizeToolName("EngineeringProgramTool");

export function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function withFetchCandidateSources(expectedSources: string[], fetchCandidateUrls: string[]): string[] {
  if (!fetchCandidateUrls.length) return expectedSources;
  const output: string[] = [];
  const seen = new Set<string>();
  for (const source of expectedSources) pushUnique(output, seen, source);
  for (const url of fetchCandidateUrls) pushUnique(output, seen, `Fetch candidate URL: ${url}`);
  return output;
}

export function pushUnique(output: string[], seen: Set<string>, value: string): void {
  if (seen.has(value)) return;
  seen.add(value);
  output.push(value);
}
