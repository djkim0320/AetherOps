import { normalizeToolName } from "../tools/toolRunner.js";
import type { AppSettings, ContinuationDecision, ResearchSnapshot, ResearchSpecification } from "../shared/types.js";

const WEB_SEARCH_TOOL = normalizeToolName("WebSearchTool");
const WEB_FETCH_TOOL = normalizeToolName("WebFetchTool");
const OPEN_CODE_TOOL = normalizeToolName("OpenCodeTool");
export const ENGINEERING_PROGRAM_TOOL = normalizeToolName("EngineeringProgramTool");
const RESEARCH_METADATA_TOOL = normalizeToolName("ResearchMetadataTool");
const PDF_URL_PATTERN = /\.pdf($|[?#])/i;
const ARXIV_ABS_URL_PATTERN = /arxiv\.org\/abs\//i;
const HTTP_URL_PATTERN = /^https?:\/\//i;
const WEB_FETCH_HINT_PATTERN = /webfetchtool|fetch selected source urls/i;
const RESEARCH_METADATA_INTENT_PATTERN =
  /\b(openalex|research metadata|paper metadata|scholarly metadata|citation metadata|literature review|systematic review|related work|scholarly|peer[-\s]?reviewed|academic paper|journal article|conference paper|publication|publications|doi|bibliograph|arxiv|pubmed|semantic scholar)\b/i;

export function ensureHintTools(
  tools: string[],
  input: {
    availableTools: string[];
    continuationDecision?: ContinuationDecision;
    fetchCandidateUrls?: string[];
  }
): string[] {
  const available = normalizedToolSet(input.availableTools);
  const needsFetch = Boolean(input.fetchCandidateUrls?.length) || hasWebFetchHint(input.continuationDecision?.planRevisionHints);
  const result = copyStrings(tools);
  if (needsFetch && available.has(WEB_FETCH_TOOL) && !hasNormalizedTool(result, WEB_FETCH_TOOL)) {
    result.push("WebFetchTool");
  }
  return result;
}

export function filterResearchMetadataTool(
  tools: string[],
  input: {
    snapshot: ResearchSnapshot;
    specification: ResearchSpecification;
    continuationDecision?: ContinuationDecision;
  }
): string[] {
  if (hasResearchMetadataIntent(input)) return tools;
  return tools.filter((tool) => normalizeToolName(tool) !== RESEARCH_METADATA_TOOL);
}

export function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function strings(value: unknown, defaultValue: string[]): string[] {
  if (!Array.isArray(value)) return defaultValue;
  const normalized: string[] = [];
  for (const item of value) {
    const cleaned = clean(item);
    if (!cleaned) continue;
    normalized.push(cleaned);
    if (normalized.length >= 12) break;
  }
  return normalized.length ? normalized : defaultValue;
}

export function selectIdsOrText(value: unknown, defaultValue: string[]): string[] {
  return strings(value, defaultValue);
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

export function normalizedToolSet(tools: string[]): Set<string> {
  const normalized = new Set<string>();
  for (const tool of tools) {
    const name = normalizeToolName(tool);
    if (name) normalized.add(name);
  }
  return normalized;
}

export function hasPdfFetchTarget(urls: string[]): boolean {
  for (const url of urls) {
    if (PDF_URL_PATTERN.test(url) || ARXIV_ABS_URL_PATTERN.test(url)) return true;
  }
  return false;
}

export function hasWebFetchHint(hints: string[] | undefined): boolean {
  for (const hint of hints ?? []) {
    if (WEB_FETCH_HINT_PATTERN.test(hint)) return true;
  }
  return false;
}

export function hasExternalEvidenceOrSourceUrl(snapshot: ResearchSnapshot): boolean {
  for (const item of snapshot.evidence) {
    if (typeof item.sourceUri === "string" && HTTP_URL_PATTERN.test(item.sourceUri)) return true;
  }
  for (const source of snapshot.sources) {
    if (typeof source.url === "string" && HTTP_URL_PATTERN.test(source.url)) return true;
  }
  return false;
}

export function defaultCandidateTools(
  settings: AppSettings,
  state: {
    available: Set<string>;
    externalNetworkReady: boolean;
    hasExternalUrls: boolean;
    hasFetchHint: boolean;
    hasPdfTargets: boolean;
    researchMetadataReady: boolean;
    researchMetadataRelevant: boolean;
    engineeringProgramReady: boolean;
    webSearchReady: boolean;
  }
): string[] {
  const tools: string[] = [];
  if (settings.openCode.enabled && settings.openCode.command?.trim() && state.available.has(OPEN_CODE_TOOL)) tools.push("OpenCodeTool");
  if (state.webSearchReady) tools.push("WebSearchTool");
  if (state.researchMetadataReady && state.researchMetadataRelevant) tools.push("ResearchMetadataTool");
  if (state.externalNetworkReady && (state.hasFetchHint || state.hasExternalUrls || state.available.has(WEB_SEARCH_TOOL))) {
    tools.push("WebFetchTool");
  }
  if (state.hasPdfTargets) tools.push("PdfIngestionTool");
  if (settings.browserUse.enabled && settings.allowExternalSearch) tools.push("BackgroundBrowserTool");
  if (state.engineeringProgramReady) tools.push("EngineeringProgramTool");
  tools.push("ArtifactWriterTool", "DataAnalysisTool");
  return tools;
}

export function hasResearchMetadataIntent(input: {
  snapshot: ResearchSnapshot;
  specification: ResearchSpecification;
  continuationDecision?: ContinuationDecision;
}): boolean {
  const parts: string[] = [
    input.snapshot.project.topic,
    input.snapshot.project.goal,
    input.snapshot.project.scope,
    input.specification.scope,
    ...input.snapshot.questions.map((question) => question.text),
    ...input.snapshot.hypotheses.map((hypothesis) => hypothesis.statement),
    ...input.snapshot.researchInputs.map((researchInput) => researchInput.researchQuestion),
    ...input.specification.researchQuestions,
    ...input.specification.initialHypotheses,
    ...input.specification.refinedHypotheses,
    ...input.specification.assumptions,
    ...input.specification.constraints,
    ...input.specification.successCriteria,
    ...input.specification.requiredEvidenceTypes,
    ...input.specification.competencyQuestions,
    ...input.specification.evaluationMetrics,
    input.continuationDecision?.nextObjective ?? "",
    ...(input.continuationDecision?.nextQuestions ?? []),
    ...(input.continuationDecision?.evidenceGaps ?? []),
    ...(input.continuationDecision?.planRevisionHints ?? [])
  ];
  return RESEARCH_METADATA_INTENT_PATTERN.test(parts.filter(Boolean).join("\n"));
}

export function executableCandidateTools(candidateTools: string[], available: Set<string>): string[] {
  const tools: string[] = [];
  for (const tool of candidateTools) {
    if (tool === "OpenCodeTool" || available.has(normalizeToolName(tool))) tools.push(tool);
  }
  return tools;
}

function copyStrings(values: string[]): string[] {
  return [...values];
}

function hasNormalizedTool(tools: string[], normalizedTarget: string): boolean {
  return tools.some((tool) => normalizeToolName(tool) === normalizedTarget);
}
