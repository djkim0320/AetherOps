import { createId } from "../../../core/shared/ids.js";
import type {
  EvidenceItem,
  OpenCodeClaim,
  OpenCodeObservation,
  OpenCodeRunInput,
  OpenCodeRunOutput,
  ResearchArtifact,
  ResearchSource,
  ToolRun
} from "../../../core/shared/types.js";
import { cleanString, collectIds, collectStrings } from "./realOpenCodeCommon.js";
import type { OpenCodeSchema } from "./realOpenCodeOutputParser.js";

export function normalizeOpenCodeRunOutput(
  input: OpenCodeRunInput,
  parsed: OpenCodeSchema,
  startedAt: string,
  completedAt: string,
  stderr: string,
  prompt: string
): OpenCodeRunOutput {
  const downgraded = downgradeLegacyEvidence(parsed);
  const artifacts = normalizeArtifacts(input, parsed, completedAt);
  const claims = normalizeClaimLike(parsed.claims);
  claims.push(...downgraded.claims);
  const observations = normalizeClaimLike(parsed.observations);
  observations.push(...downgraded.observations);
  const sourceCandidates = mergeSourceCandidateRecords(parsed.sourceCandidates, downgraded.sourceCandidates);
  const sources = normalizeSourceCandidates(input, sourceCandidates, completedAt);
  const toolRuns = buildOpenCodeStructuredOutputToolRuns(input, claims, observations, sources, startedAt, completedAt);
  return {
    run: {
      id: input.openCodeRunId ?? createId("opencode"),
      projectId: input.project.id,
      iteration: input.iteration,
      prompt,
      toolPlan: parsed.toolPlan?.length ? parsed.toolPlan : ["opencode-cli"],
      status: "completed",
      logs: [
        parsed.summary || "OpenCode CLI execution completed.",
        "OpenCode CLI was resolved from AetherOps bundled dependencies when available.",
        downgraded.downgradedCount
          ? `Downgraded ${downgraded.downgradedCount} legacy evidence items to non-support claims/source candidates.`
          : "No legacy evidence items were returned.",
        stderr ? `stderr: ${stderr.slice(0, 2000)}` : "stderr: empty"
      ],
      artifactIds: collectIds(artifacts),
      evidenceIds: [],
      startedAt,
      completedAt
    },
    artifacts,
    evidence: [],
    sources,
    sourceCandidates: sources,
    claims,
    observations,
    toolRuns,
    nextActions: collectStrings(parsed.nextActions),
    needsMoreEvidence: Boolean(parsed.needsMoreEvidence),
    needsMoreAnalysis: Boolean(parsed.needsMoreAnalysis)
  };
}

export function buildOpenCodeStructuredOutputToolRuns(
  input: OpenCodeRunInput,
  claims: OpenCodeClaim[],
  observations: OpenCodeObservation[],
  sources: ResearchSource[],
  startedAt: string,
  completedAt: string
): ToolRun[] {
  if (!claims.length && !observations.length && !sources.length) return [];
  return [
    {
      id: createId("tool"),
      projectId: input.project.id,
      iteration: input.iteration,
      toolName: "OpenCodeStructuredOutput",
      input: { iteration: input.iteration },
      output: {
        claims,
        observations,
        sourceCandidateIds: collectIds(sources)
      },
      status: "completed",
      startedAt,
      completedAt
    }
  ];
}

function normalizeArtifacts(input: OpenCodeRunInput, parsed: OpenCodeSchema, createdAt: string): ResearchArtifact[] {
  const artifacts: ResearchArtifact[] = [];
  const items = parsed.artifacts ?? [];
  const maxItems = Math.min(items.length, 12);
  for (let index = 0; index < maxItems; index += 1) {
    const artifact = items[index];
    artifacts.push({
      id: createId("artifact"),
      projectId: input.project.id,
      category: "generated_artifact",
      title: cleanString(artifact.title) || `OpenCode artifact ${index + 1}`,
      relativePath: cleanString(artifact.relativePath) || `artifacts/iteration-${input.iteration}/opencode-artifact-${index + 1}.md`,
      mimeType: cleanString(artifact.mimeType) || "text/markdown",
      summary: cleanString(artifact.summary) || "OpenCode generated artifact.",
      content: cleanString(artifact.content) || cleanString(artifact.summary),
      createdAt
    });
  }
  return artifacts;
}

function normalizeClaimLike(items: Array<Record<string, unknown>> | undefined): OpenCodeClaim[] {
  const normalized: OpenCodeClaim[] = [];
  const maxItems = Math.min(items?.length ?? 0, 24);
  for (let index = 0; index < maxItems; index += 1) {
    const item = items?.[index];
    if (!item) continue;
    const content = cleanString(item.content) || cleanString(item.summary) || cleanString(item.quote);
    const sourceUri = cleanString(item.sourceUri) || cleanString(item.url) || undefined;
    const citation = cleanString(item.citation) || undefined;
    if (!content && !sourceUri && !citation) continue;
    normalized.push({
      title: cleanString(item.title) || `OpenCode claim ${index + 1}`,
      content,
      sourceUri,
      citation,
      metadata: {
        traceabilityKind: "tool_observation",
        canSupportHypothesis: false,
        downgradedFromEvidence: item.downgradedFromEvidence === true
      }
    });
  }
  return normalized;
}

function normalizeSourceCandidates(input: OpenCodeRunInput, candidates: Array<Record<string, unknown>>, createdAt: string): ResearchSource[] {
  const sources: ResearchSource[] = [];
  const maxItems = Math.min(candidates.length, 24);
  for (let index = 0; index < maxItems; index += 1) {
    const item = candidates[index];
    const url = cleanString(item.url) || cleanString(item.sourceUri);
    const doi = cleanString(item.doi);
    if (!url && !doi) continue;
    sources.push({
      id: createId("source"),
      projectId: input.project.id,
      kind: doi && !url ? ("paper" as const) : ("web" as const),
      title: cleanString(item.title) || cleanString(item.citation) || `OpenCode source candidate ${index + 1}`,
      url: url || undefined,
      doi: doi || undefined,
      retrievedAt: createdAt,
      metadata: {
        provider: "opencode",
        snippet: cleanString(item.snippet) || cleanString(item.summary) || cleanString(item.quote),
        citation: cleanString(item.citation) || undefined,
        traceabilityKind: "external_source",
        canSupportHypothesis: false,
        sourceCandidateOnly: true
      },
      createdAt
    });
  }
  return sources;
}

function mergeSourceCandidateRecords(
  parsedCandidates: Array<Record<string, unknown>> | undefined,
  downgradedCandidates: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  if (!parsedCandidates?.length) return downgradedCandidates;
  const merged: Array<Record<string, unknown>> = [];
  for (const candidate of parsedCandidates) merged.push(candidate);
  for (const candidate of downgradedCandidates) merged.push(candidate);
  return merged;
}

function downgradeLegacyEvidence(parsed: OpenCodeSchema): {
  claims: OpenCodeClaim[];
  observations: OpenCodeObservation[];
  sourceCandidates: Array<Record<string, unknown>>;
  downgradedCount: number;
} {
  const claims: OpenCodeClaim[] = [];
  const observations: OpenCodeObservation[] = [];
  const sourceCandidates: Array<Record<string, unknown>> = [];
  const evidence = parsed.evidence ?? [];
  const maxItems = Math.min(evidence.length, 24);
  for (let index = 0; index < maxItems; index += 1) {
    const item = evidence[index];
    const title = cleanString(item.title) || "Downgraded OpenCode claim";
    const content = cleanString(item.summary) || cleanString(item.quote) || cleanString(item.citation) || cleanString(item.sourceUri);
    const sourceUri = cleanString(item.sourceUri);
    const citation = cleanString(item.citation);
    const downgraded = {
      title,
      content,
      sourceUri: sourceUri || undefined,
      citation: citation || undefined,
      metadata: { downgradedFromEvidence: true, canSupportHypothesis: false }
    };
    if (normalizeCategory(item.category) === "generated_artifact") {
      observations.push(downgraded);
    } else {
      claims.push(downgraded);
    }
    if (sourceUri || cleanString(item.doi)) {
      sourceCandidates.push({
        title,
        url: sourceUri,
        doi: cleanString(item.doi),
        citation,
        snippet: content,
        downgradedFromEvidence: true
      });
    }
  }
  return { claims, observations, sourceCandidates, downgradedCount: claims.length + observations.length };
}

function normalizeCategory(value: unknown): EvidenceItem["category"] {
  const allowed: EvidenceItem["category"][] = ["generated_artifact", "paper_reference", "web_source", "experiment_log", "conversation_memo"];
  return allowed.includes(value as EvidenceItem["category"]) ? (value as EvidenceItem["category"]) : "experiment_log";
}
