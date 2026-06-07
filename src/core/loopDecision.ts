import { createId, nowIso } from "./ids.js";
import type { ContinuationDecision, EvidenceBasedResult, ResearchSnapshot } from "./types.js";

const PUBLIC_HTTP_URL_PATTERN = /https?:\/\/[^\s)<>"']+/gi;
const TRAILING_URL_PUNCTUATION_PATTERN = /[.,;]+$/g;
const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal"];

export class LoopDecisionEngine {
  decide(input: {
    snapshot: ResearchSnapshot;
    result: EvidenceBasedResult;
    iteration: number;
    safetyCapIterations: number;
    beforeCounts: { evidence: number; artifacts: number; chunks: number; entities: number; relations: number };
  }): ContinuationDecision {
    const after = input.snapshot;
    const growth = {
      evidence: after.evidence.length - input.beforeCounts.evidence,
      artifacts: after.artifacts.length - input.beforeCounts.artifacts,
      chunks: after.chunks.length - input.beforeCounts.chunks,
      entities: after.ontologyEntities.length - input.beforeCounts.entities,
      relations: after.ontologyRelations.length - input.beforeCounts.relations
    };
    const latestContext = findLatestContextForIteration(after, input.iteration);
    const continuationContext = latestContext ? collectContinuationContext(after, latestContext) : emptyContinuationContext();
    const analysisSignal = latestDataAnalysisSignal(after);
    const analysisHasInputs = (analysisSignal?.normalizedRecordCount ?? 0) > 0 || (analysisSignal?.validationResultCount ?? 0) > 0;
    const sourceCandidatesNeedFetch = Boolean(
      latestContext &&
      latestContext.selectedEvidenceIds.length === 0 &&
      continuationContext.fetchCandidateUrls.length > 0
    );
    const fetchEvidenceGap = "Source candidates found but not fetched into citation-backed evidence";
    const evidenceGaps: string[] = [];
    for (const question of input.result.nextQuestions) {
      if (question) evidenceGaps.push(question);
    }
    const validationStart = Math.max(0, after.validationResults.length - after.hypotheses.length);
    for (let index = validationStart; index < after.validationResults.length; index += 1) {
      const validation = after.validationResults[index];
      if (!validation) continue;
      for (const gap of validation.evidenceGaps) {
        if (gap) evidenceGaps.push(gap);
      }
    }
    if (analysisHasInputs) {
      for (const gap of analysisSignal?.evidenceGapsFromLatestValidation ?? []) {
        if (gap) evidenceGaps.push(gap);
      }
      if (analysisSignal?.supportEligibleEvidenceCount === 0) {
        evidenceGaps.push("DataAnalysisTool found no support-eligible citation-backed evidence.");
      }
      if (typeof analysisSignal?.citationCoverage === "number" && analysisSignal.citationCoverage < 0.5) {
        evidenceGaps.push(`DataAnalysisTool reported low citation coverage (${analysisSignal.citationCoverage.toFixed(2)}).`);
      }
    }
    if (sourceCandidatesNeedFetch) {
      evidenceGaps.push(fetchEvidenceGap);
    }
    const repeatedLowGrowth =
      input.iteration > 1 &&
      growth.evidence <= 0 &&
      growth.artifacts <= 0 &&
      growth.chunks <= 0 &&
      growth.entities <= 0 &&
      growth.relations <= 0;
    const hitSafetyCap = input.iteration >= input.safetyCapIterations;
    const statusBlocked = after.project.status === "aborted" || after.project.status === "paused";
    const shouldContinue =
      !hitSafetyCap &&
      !statusBlocked &&
      !repeatedLowGrowth &&
      (input.result.needsMoreEvidence || input.result.needsMoreAnalysis || input.result.nextQuestions.length > 0 || sourceCandidatesNeedFetch);

    return {
      id: createId("decision"),
      projectId: after.project.id,
      iteration: input.iteration,
      shouldContinue,
      reason: reason({ hitSafetyCap, statusBlocked, repeatedLowGrowth, result: input.result, growth, analysisSignal }),
      nextObjective: shouldContinue
        ? `Resolve ${evidenceGaps[0] ?? "remaining evidence gaps"} and improve citation coverage for priority hypotheses.`
        : undefined,
      nextQuestions: shouldContinue ? uniqueFirstStrings(input.result.nextQuestions, 5) : [],
      evidenceGaps: uniqueFirstStrings(evidenceGaps, 8),
      selectedSourceIds: continuationContext.selectedSourceIds,
      selectedRecordIds: continuationContext.selectedRecordIds,
      selectedEvidenceIds: continuationContext.selectedEvidenceIds,
      selectedChunkIds: continuationContext.selectedChunkIds,
      selectedCitationUrls: continuationContext.selectedCitationUrls,
      fetchCandidateUrls: continuationContext.fetchCandidateUrls,
      projectContextSnapshotId: latestContext?.id,
      forceStop: hitSafetyCap,
      planRevisionHints: shouldContinue
        ? [
            "Return to Step 4 and revise the research plan before executing tools again.",
            "Prioritize traceable sources over additional seed or untraceable artifacts.",
            ...(sourceCandidatesNeedFetch ? ["Use WebFetchTool to fetch selected source URLs from previous ProjectContextSnapshot."] : []),
            growth.evidence <= 0 ? "Previous iteration produced little or no new evidence; change tool/source strategy." : "Use new evidence to narrow validation targets."
          ]
        : [],
      createdAt: nowIso()
    };
  }
}

function collectContinuationContext(
  snapshot: ResearchSnapshot,
  context: NonNullable<ResearchSnapshot["projectContextSnapshots"][number]>
): {
  selectedSourceIds: string[];
  selectedRecordIds: string[];
  selectedEvidenceIds: string[];
  selectedChunkIds: string[];
  selectedCitationUrls: string[];
  fetchCandidateUrls: string[];
} {
  const selectedRecordIds = new Set(context.selectedRecordIds);
  const selectedSourceIds = new Set(context.selectedSourceIds);
  const selectedEvidenceIds = new Set(context.selectedEvidenceIds);
  const selectedChunkIds = new Set(context.selectedChunkIds);
  const urls = new Set<string>();
  for (const citation of context.citations) addUrls(urls, citation);
  for (const source of snapshot.sources) {
    if (!selectedSourceIds.has(source.id)) continue;
    addUrls(urls, source.url);
    addUrls(urls, readString(source.metadata.url));
    addUrls(urls, readString(source.metadata.sourceUri));
    addUrls(urls, readString(source.metadata.pdfUrl));
  }
  for (const evidence of snapshot.evidence) {
    if (!selectedEvidenceIds.has(evidence.id)) continue;
    addUrls(urls, evidence.sourceUri);
    addUrls(urls, evidence.citation);
  }
  for (const record of snapshot.normalizedRecords) {
    if (!selectedRecordIds.has(record.id) && (!record.evidenceId || !selectedEvidenceIds.has(record.evidenceId))) continue;
    if (record.memoryScope === "ephemeral" || record.validationStatus === "rejected") continue;
    addUrls(urls, record.sourceUri);
    addUrls(urls, record.citation);
    addUrls(urls, readString(record.metadata.url));
    addUrls(urls, readString(record.metadata.sourceUri));
    addUrls(urls, readString(record.metadata.pdfUrl));
  }
  for (const chunk of snapshot.chunks) {
    if (!selectedChunkIds.has(chunk.id)) continue;
    if (chunk.memoryScope === "ephemeral" || chunk.validationStatus === "rejected") continue;
    addUrls(urls, chunk.citation);
    addUrls(urls, readString((chunk as { metadata?: Record<string, unknown> }).metadata?.url));
    addUrls(urls, readString((chunk as { metadata?: Record<string, unknown> }).metadata?.sourceUri));
    addUrls(urls, readString((chunk as { metadata?: Record<string, unknown> }).metadata?.pdfUrl));
  }
  const fetchCandidateUrls: string[] = [];
  for (const url of urls) {
    fetchCandidateUrls.push(url);
    if (fetchCandidateUrls.length >= 12) break;
  }
  const selectedCitationUrls: string[] = [];
  for (const citation of context.citations) {
    appendPublicHttpUrls(selectedCitationUrls, citation);
  }
  return {
    selectedSourceIds: [...selectedSourceIds],
    selectedRecordIds: [...selectedRecordIds],
    selectedEvidenceIds: [...selectedEvidenceIds],
    selectedChunkIds: [...selectedChunkIds],
    selectedCitationUrls,
    fetchCandidateUrls
  };
}

function emptyContinuationContext(): ReturnType<typeof collectContinuationContext> {
  return {
    selectedSourceIds: [],
    selectedRecordIds: [],
    selectedEvidenceIds: [],
    selectedChunkIds: [],
    selectedCitationUrls: [],
    fetchCandidateUrls: []
  };
}

function findLatestContextForIteration(snapshot: ResearchSnapshot, iteration: number): ResearchSnapshot["projectContextSnapshots"][number] | undefined {
  for (let index = snapshot.projectContextSnapshots.length - 1; index >= 0; index -= 1) {
    const context = snapshot.projectContextSnapshots[index];
    if (context?.iteration === iteration) return context;
  }
  return undefined;
}

interface DataAnalysisSignal {
  supportEligibleEvidenceCount?: number;
  citationCoverage?: number;
  evidenceGapsFromLatestValidation?: string[];
  normalizedRecordCount?: number;
  validationResultCount?: number;
}

function latestDataAnalysisSignal(snapshot: ResearchSnapshot): DataAnalysisSignal | undefined {
  const output = findLatestCompletedDataAnalysisOutput(snapshot);
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const value = output as Record<string, unknown>;
  return {
    supportEligibleEvidenceCount: readNumber(value.supportEligibleEvidenceCount),
    citationCoverage: readNumber(value.citationCoverage),
    normalizedRecordCount: readNumber(readObject(value.inputAvailability)?.normalizedRecordCount),
    validationResultCount: readNumber(readObject(value.inputAvailability)?.validationResultCount),
    evidenceGapsFromLatestValidation: readStringArray(value.evidenceGapsFromLatestValidation)
  };
}

function findLatestCompletedDataAnalysisOutput(snapshot: ResearchSnapshot): unknown {
  for (let index = snapshot.toolRuns.length - 1; index >= 0; index -= 1) {
    const run = snapshot.toolRuns[index];
    if (run?.toolName === "DataAnalysisTool" && run.status === "completed") return run.output;
  }
  return undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item === "string") strings.push(item);
  }
  return strings;
}

function uniqueFirstStrings(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    output.push(value);
    if (output.length >= limit) break;
  }
  return output;
}

function addUrls(target: Set<string>, value: string | undefined): void {
  for (const url of extractPublicHttpUrls(value)) target.add(url);
}

function appendPublicHttpUrls(target: string[], value: string | undefined): void {
  for (const url of extractPublicHttpUrls(value)) target.push(url);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractPublicHttpUrls(value: string | undefined): string[] {
  if (!value) return [];
  const matches = value.match(PUBLIC_HTTP_URL_PATTERN) ?? [];
  const urls: string[] = [];
  for (const match of matches) {
    const url = normalizePublicHttpUrl(match);
    if (url) urls.push(url);
  }
  return urls;
}

function normalizePublicHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value.trim().replace(TRAILING_URL_PUNCTUATION_PATTERN, ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.hash = "";
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!hostname || hostname === "localhost" || hasBlockedHostSuffix(hostname)) return undefined;
    if (isPrivateIpv4(hostname) || hostname === "::1") return undefined;
    parsed.hostname = hostname;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function hasBlockedHostSuffix(hostname: string): boolean {
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (hostname.endsWith(suffix)) return true;
  }
  return false;
}

function isPrivateIpv4(hostname: string): boolean {
  const segments = hostname.split(".");
  if (segments.length !== 4) return false;
  const parts: number[] = [];
  for (const segment of segments) {
    const part = Number(segment);
    if (!Number.isInteger(part) || part < 0 || part > 255) return false;
    parts.push(part);
  }
  const [first, second] = parts;
  return first === 0 || first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254);
}

function reason(input: {
  hitSafetyCap: boolean;
  statusBlocked: boolean;
  repeatedLowGrowth: boolean;
  result: EvidenceBasedResult;
  growth: Record<string, number>;
  analysisSignal?: DataAnalysisSignal;
}): string {
  if (input.hitSafetyCap) return "Internal loop safety cap reached; finalize with explicit limitations.";
  if (input.statusBlocked) return "Project is paused or aborted.";
  if (input.repeatedLowGrowth) return "No meaningful new evidence, artifact, vector chunk, or graph relation was produced.";
  const analysisHasInputs = (input.analysisSignal?.normalizedRecordCount ?? 0) > 0 || (input.analysisSignal?.validationResultCount ?? 0) > 0;
  if (analysisHasInputs && input.analysisSignal?.supportEligibleEvidenceCount === 0) {
    return `More research is needed. DataAnalysisTool found no support-eligible evidence and citation coverage is ${input.analysisSignal.citationCoverage ?? "unknown"}. Growth: ${JSON.stringify(input.growth)}.`;
  }
  if (analysisHasInputs && typeof input.analysisSignal?.citationCoverage === "number" && input.analysisSignal.citationCoverage < 0.5) {
    return `More research is needed. DataAnalysisTool reported low citation coverage (${input.analysisSignal.citationCoverage.toFixed(2)}). Growth: ${JSON.stringify(input.growth)}.`;
  }
  if (input.result.needsMoreEvidence || input.result.needsMoreAnalysis || input.result.nextQuestions.length) {
    return `More research is needed. Growth: ${JSON.stringify(input.growth)}.`;
  }
  return "Current evidence and analysis are sufficient for final output.";
}
