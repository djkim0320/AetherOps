import { extractKeywords } from "./chunking.js";
import { createStableId, nowIso } from "./ids.js";
import type {
  EvidenceItem,
  NormalizedRecordKind,
  NormalizedResearchRecord,
  ResearchArtifact,
  ResearchSnapshot,
  ResearchSource,
  ToolRun
} from "./types.js";

export class EvidenceNormalizer {
  normalize(snapshot: ResearchSnapshot, iteration: number): NormalizedResearchRecord[] {
    const records: NormalizedResearchRecord[] = [];
    for (const source of snapshot.sources) {
      records.push(recordFromSource(source, iteration));
    }
    for (const artifact of snapshot.artifacts) {
      records.push(recordFromArtifact(artifact, iteration));
    }
    for (const evidence of snapshot.evidence) {
      records.push(...recordsFromEvidence(evidence, iteration));
    }
    for (const toolRun of snapshot.toolRuns) {
      records.push(recordFromToolRun(toolRun));
    }
    return dedupe(records);
  }
}

function recordFromSource(source: ResearchSource, iteration: number): NormalizedResearchRecord {
  const content = [source.title, source.url, source.doi, JSON.stringify(source.metadata)].filter(Boolean).join("\n");
  return {
    id: createStableId("record", `${source.id}:source`),
    projectId: source.projectId,
    iteration,
    kind: "source",
    title: source.title,
    content,
    sourceId: source.id,
    citation: source.url || source.doi,
    sourceUri: source.url || source.rawPath,
    metadata: { kind: source.kind, authors: source.authors, publishedAt: source.publishedAt, keywords: extractKeywords(content) },
    confidence: source.url || source.doi || source.rawPath ? 0.75 : 0.35,
    createdAt: source.createdAt ?? source.retrievedAt
  };
}

function recordFromArtifact(artifact: ResearchArtifact, iteration: number): NormalizedResearchRecord {
  const content = [artifact.title, artifact.summary, artifact.content, artifact.relativePath].filter(Boolean).join("\n");
  return {
    id: createStableId("record", `${artifact.id}:artifact`),
    projectId: artifact.projectId,
    iteration,
    kind: "artifact",
    title: artifact.title,
    content,
    artifactId: artifact.id,
    citation: artifact.relativePath,
    sourceUri: artifact.rawPath ?? artifact.relativePath,
    metadata: { category: artifact.category, mimeType: artifact.mimeType, keywords: extractKeywords(content) },
    confidence: artifact.category === "generated_artifact" ? 0.55 : 0.45,
    createdAt: artifact.createdAt
  };
}

function recordsFromEvidence(evidence: EvidenceItem, iteration: number): NormalizedResearchRecord[] {
  const confidence = confidenceFromEvidence(evidence);
  const content = [evidence.title, evidence.summary, evidence.quote, evidence.citation, evidence.sourceUri].filter(Boolean).join("\n");
  const base = {
    projectId: evidence.projectId,
    iteration,
    evidenceId: evidence.id,
    sourceId: evidence.sourceId,
    citation: evidence.citation,
    sourceUri: evidence.sourceUri,
    metadata: {
      category: evidence.category,
      linkedHypothesisIds: evidence.linkedHypothesisIds,
      reliabilityScore: evidence.reliabilityScore,
      relevanceScore: evidence.relevanceScore,
      evidenceStrength: evidence.evidenceStrength,
      limitations: evidence.limitations,
      keywords: evidence.keywords.length ? evidence.keywords : extractKeywords(content)
    },
    confidence,
    createdAt: evidence.createdAt
  };
  const kind: NormalizedRecordKind = evidence.keywords.some((keyword) => keyword.includes("gap")) ? "observation" : "evidence";
  const records: NormalizedResearchRecord[] = [
    {
      ...base,
      id: createStableId("record", `${evidence.id}:${kind}`),
      kind,
      title: evidence.title,
      content
    }
  ];
  if (evidence.citation || evidence.sourceUri || evidence.sourceId) {
    records.push({
      ...base,
      id: createStableId("record", `${evidence.id}:citation:${evidence.citation ?? evidence.sourceUri ?? evidence.sourceId}`),
      kind: "citation",
      title: `Citation for ${evidence.title}`,
      content: evidence.citation ?? evidence.sourceUri ?? evidence.sourceId ?? evidence.title,
      confidence: 0.7
    });
  }
  records.push({
    ...base,
    id: createStableId("record", `${evidence.id}:claim`),
    kind: "claim",
    title: `Claim: ${evidence.title}`,
    content: evidence.summary,
    confidence: Math.max(0.1, confidence - 0.15)
  });
  return records;
}

function recordFromToolRun(toolRun: ToolRun): NormalizedResearchRecord {
  const content = [
    toolRun.toolName,
    toolRun.status,
    JSON.stringify(toolRun.input),
    JSON.stringify(toolRun.output),
    toolRun.error
  ].filter(Boolean).join("\n");
  return {
    id: createStableId("record", `${toolRun.id}:observation`),
    projectId: toolRun.projectId,
    iteration: toolRun.iteration,
    kind: "observation",
    title: `${toolRun.toolName} ${toolRun.status}`,
    content,
    sourceUri: `logs/iteration-${toolRun.iteration}.json`,
    metadata: { toolRunId: toolRun.id, status: toolRun.status, error: toolRun.error, keywords: extractKeywords(content) },
    confidence: toolRun.status === "completed" ? 0.65 : 0.35,
    createdAt: toolRun.completedAt || nowIso()
  };
}

function confidenceFromEvidence(evidence: EvidenceItem): number {
  const reliability = evidence.reliabilityScore ?? 0.35;
  const relevance = evidence.relevanceScore ?? 0.5;
  const traceability = evidence.citation || evidence.sourceUri || evidence.sourceId ? 0.15 : -0.15;
  const strength = evidence.evidenceStrength === "strong" ? 0.15 : evidence.evidenceStrength === "medium" ? 0.05 : -0.05;
  return Math.max(0.05, Math.min(0.95, (reliability + relevance) / 2 + traceability + strength));
}

function dedupe(records: NormalizedResearchRecord[]): NormalizedResearchRecord[] {
  const map = new Map<string, NormalizedResearchRecord>();
  for (const record of records) {
    const key = `${record.kind}:${record.sourceId ?? ""}:${record.artifactId ?? ""}:${record.evidenceId ?? ""}:${record.title}:${record.content.slice(0, 120)}`;
    const stableId = createStableId("record", key);
    map.set(stableId, { ...record, id: stableId });
  }
  return [...map.values()];
}
