import { createId, nowIso } from "./ids.js";
import type { ContinuationDecision, EvidenceBasedResult, ResearchSnapshot } from "./types.js";

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
    const latestContext = [...after.projectContextSnapshots].reverse().find((context) => context.iteration === input.iteration);
    const continuationContext = latestContext ? collectContinuationContext(after, latestContext) : emptyContinuationContext();
    const sourceCandidatesNeedFetch = Boolean(
      latestContext &&
      latestContext.selectedEvidenceIds.length === 0 &&
      continuationContext.fetchCandidateUrls.length > 0
    );
    const fetchEvidenceGap = "Source candidates found but not fetched into citation-backed evidence";
    const evidenceGaps = [
      ...input.result.nextQuestions,
      ...after.validationResults.slice(-after.hypotheses.length).flatMap((result) => result.evidenceGaps),
      ...(sourceCandidatesNeedFetch ? [fetchEvidenceGap] : [])
    ].filter(Boolean);
    const repeatedLowGrowth = input.iteration > 1 && Object.values(growth).every((value) => value <= 0);
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
      reason: reason({ hitSafetyCap, statusBlocked, repeatedLowGrowth, result: input.result, growth }),
      nextObjective: shouldContinue
        ? `Resolve ${evidenceGaps[0] ?? "remaining evidence gaps"} and improve citation coverage for priority hypotheses.`
        : undefined,
      nextQuestions: shouldContinue ? [...new Set(input.result.nextQuestions)].slice(0, 5) : [],
      evidenceGaps: [...new Set(evidenceGaps)].slice(0, 8),
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
  const fetchCandidateUrls = [...urls].slice(0, 12);
  return {
    selectedSourceIds: [...selectedSourceIds],
    selectedRecordIds: [...selectedRecordIds],
    selectedEvidenceIds: [...selectedEvidenceIds],
    selectedChunkIds: [...selectedChunkIds],
    selectedCitationUrls: context.citations.flatMap(extractPublicHttpUrls),
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

function addUrls(target: Set<string>, value: string | undefined): void {
  for (const url of extractPublicHttpUrls(value)) target.add(url);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractPublicHttpUrls(value: string | undefined): string[] {
  if (!value) return [];
  const matches = value.match(/https?:\/\/[^\s)<>"']+/gi) ?? [];
  return matches.map(normalizePublicHttpUrl).filter((url): url is string => Boolean(url));
}

function normalizePublicHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value.trim().replace(/[.,;]+$/g, ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.hash = "";
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!hostname || hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) return undefined;
    if (isPrivateIpv4(hostname) || hostname === "::1") return undefined;
    parsed.hostname = hostname;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return first === 0 || first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254);
}

function reason(input: {
  hitSafetyCap: boolean;
  statusBlocked: boolean;
  repeatedLowGrowth: boolean;
  result: EvidenceBasedResult;
  growth: Record<string, number>;
}): string {
  if (input.hitSafetyCap) return "Internal loop safety cap reached; finalize with explicit limitations.";
  if (input.statusBlocked) return "Project is paused or aborted.";
  if (input.repeatedLowGrowth) return "No meaningful new evidence, artifact, vector chunk, or graph relation was produced.";
  if (input.result.needsMoreEvidence || input.result.needsMoreAnalysis || input.result.nextQuestions.length) {
    return `More research is needed. Growth: ${JSON.stringify(input.growth)}.`;
  }
  return "Current evidence and analysis are sufficient for final output.";
}
