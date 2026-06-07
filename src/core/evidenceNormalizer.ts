import { extractKeywords } from "./chunking.js";
import { createStableId, nowIso } from "./ids.js";
import { memoryScopeForTraceability, tagMemoryScope } from "./researchMemory.js";
import { assessSourceQuality, canEvidenceSupportHypothesis, sourceQualityMetadata } from "./sourceQuality.js";
import type {
  EvidenceItem,
  NormalizedRecordKind,
  NormalizedResearchRecord,
  ResearchArtifact,
  ResearchInput,
  ResearchPlan,
  ResearchSnapshot,
  ResearchSource,
  ResearchSpecification,
  ToolRun,
  TraceabilityKind
} from "./types.js";

export class EvidenceNormalizer {
  normalize(snapshot: ResearchSnapshot, iteration: number): NormalizedResearchRecord[] {
    const records: NormalizedResearchRecord[] = [];
    const sourceById = new Map<string, ResearchSource>();
    for (const source of snapshot.sources) {
      sourceById.set(source.id, source);
    }

    for (const input of snapshot.researchInputs) {
      records.push(recordFromResearchInput(input, iteration));
    }

    const specification = snapshot.specifications.at(-1);
    if (specification) {
      records.push(recordFromSpecification(specification, iteration));
    }

    const plan = snapshot.researchPlans.at(-1);
    if (plan) {
      records.push(recordFromPlan(plan, iteration));
    }

    for (const source of snapshot.sources) {
      records.push(recordFromSource(source, iteration));
    }
    for (const artifact of snapshot.artifacts) {
      records.push(recordFromArtifact(artifact, iteration));
    }
    for (const evidence of snapshot.evidence) {
      appendRecordsFromEvidence(records, evidence, iteration, sourceById.get(evidence.sourceId ?? ""));
    }
    for (const toolRun of snapshot.toolRuns) {
      appendRecordsFromToolRun(records, toolRun);
    }
    return dedupe(records);
  }
}

function recordFromResearchInput(input: ResearchInput, iteration: number): NormalizedResearchRecord {
  const lines = [input.researchQuestion];
  for (const hypothesis of input.initialHypotheses) {
    lines.push(`Hypothesis: ${hypothesis}`);
  }
  for (const constraint of input.constraints) {
    lines.push(`Constraint: ${constraint}`);
  }
  for (const output of input.expectedOutputs) {
    lines.push(`Expected output: ${output}`);
  }
  const content = lines.join("\n");
  return provenanceRecord(input.projectId, iteration, `research-input:${input.id}`, "Research input", content, `project://research-input/${input.id}`, input.createdAt);
}

function recordFromSpecification(specification: ResearchSpecification, iteration: number): NormalizedResearchRecord {
  const lines: string[] = [];
  for (const question of specification.researchQuestions) {
    lines.push(`Question: ${question}`);
  }
  for (const hypothesis of specification.refinedHypotheses) {
    lines.push(`Refined hypothesis: ${hypothesis}`);
  }
  for (const question of specification.competencyQuestions) {
    lines.push(`Competency question: ${question}`);
  }
  for (const criterion of specification.successCriteria) {
    lines.push(`Success criterion: ${criterion}`);
  }
  const content = lines.join("\n");
  return provenanceRecord(
    specification.projectId,
    iteration,
    `research-specification:${specification.id}`,
    "Research specification",
    content,
    `project://research-specification/${specification.id}`,
    specification.createdAt
  );
}

function recordFromPlan(plan: ResearchPlan, iteration: number): NormalizedResearchRecord {
  const lines = [plan.objective];
  for (const question of plan.targetQuestions) {
    lines.push(`Target question: ${question}`);
  }
  for (const hypothesis of plan.targetHypotheses) {
    lines.push(`Target hypothesis: ${hypothesis}`);
  }
  for (const tool of plan.requiredTools) {
    lines.push(`Required tool: ${tool}`);
  }
  for (const url of plan.fetchCandidateUrls ?? []) {
    lines.push(`Fetch candidate URL: ${url}`);
  }
  for (const step of plan.executionSteps) {
    lines.push(`Execution step: ${step}`);
  }
  for (const criterion of plan.stopCriteria) {
    lines.push(`Stop criterion: ${criterion}`);
  }
  const content = lines.join("\n");
  return provenanceRecord(plan.projectId, iteration, `research-plan:${plan.id}`, `Research plan ${plan.iteration}`, content, `project://research-plan/${plan.id}`, plan.createdAt);
}

function provenanceRecord(
  projectId: string,
  iteration: number,
  stableKey: string,
  title: string,
  content: string,
  sourceUri: string,
  createdAt: string
): NormalizedResearchRecord {
  return tagMemoryScope({
    id: createStableId("record", stableKey),
    projectId,
    iteration,
    kind: "observation",
    title,
    content,
    sourceUri,
    metadata: metadata("project_provenance", false, content, { sourceKind: "conversation" }),
    confidence: 0.6,
    validationStatus: "raw",
    createdAt
  }, "project_only");
}

function recordFromSource(source: ResearchSource, iteration: number): NormalizedResearchRecord {
  const content = joinPresent("\n", source.title, source.url, source.doi, source.rawPath, JSON.stringify(source.metadata));
  const traceabilityKind = sourceTraceability(source);
  const quality = assessSourceQuality(source.url ?? source.rawPath, source.title);
  const sourceCandidateOnly = source.metadata.sourceCandidateOnly === true || source.metadata.canSupportHypothesis === false;
  const canSupportHypothesis = !sourceCandidateOnly && traceabilityKind === "external_source" && quality.canSupportHypothesis;
  return tagMemoryScope({
    id: createStableId("record", `${source.id}:source`),
    projectId: source.projectId,
    iteration,
    kind: "source",
    title: source.title,
    content,
    sourceId: source.id,
    citation: source.url || source.doi || source.rawPath,
    sourceUri: source.url || source.rawPath,
    metadata: metadata(traceabilityKind, canSupportHypothesis, content, {
      sourceKind: source.kind,
      authors: source.authors,
      publishedAt: source.publishedAt,
      doi: source.doi,
      ...sourceQualityMetadata(source.url ?? source.rawPath, source.title)
    }),
    confidence: canSupportHypothesis ? quality.reliabilityScore : traceabilityKind === "external_source" ? Math.min(0.55, quality.reliabilityScore) : 0.35,
    validationStatus: sourceCandidateOnly ? "raw" : validationStatusFor(traceabilityKind, canSupportHypothesis, "source"),
    createdAt: source.createdAt ?? source.retrievedAt
  }, memoryScopeForTraceability(traceabilityKind));
}

function recordFromArtifact(artifact: ResearchArtifact, iteration: number): NormalizedResearchRecord {
  const content = joinPresent("\n", artifact.title, artifact.summary, artifact.content, artifact.relativePath);
  return tagMemoryScope({
    id: createStableId("record", `${artifact.id}:artifact`),
    projectId: artifact.projectId,
    iteration,
    kind: "artifact",
    title: artifact.title,
    content,
    artifactId: artifact.id,
    citation: artifact.relativePath,
    sourceUri: artifact.rawPath ?? artifact.relativePath,
    metadata: metadata("internal_artifact", false, content, {
      category: artifact.category,
      mimeType: artifact.mimeType,
      sourceKind: "artifact"
    }),
    confidence: artifact.category === "generated_artifact" ? 0.55 : 0.45,
    validationStatus: "raw",
    createdAt: artifact.createdAt
  }, "project_only");
}

function appendRecordsFromEvidence(records: NormalizedResearchRecord[], evidence: EvidenceItem, iteration: number, source?: ResearchSource): void {
  const content = joinPresent("\n", evidence.title, evidence.summary, evidence.quote, evidence.citation, evidence.sourceUri, evidence.doi);
  const keywordFlags = evidenceKeywordFlags(evidence.keywords);
  const traceabilityKind = evidenceTraceability(evidence, source, keywordFlags);
  const canSupportHypothesis =
    (traceabilityKind === "external_source" || (traceabilityKind === "tool_observation" && hasNonInternalTrace(evidence))) &&
    canEvidenceSupportHypothesis(evidence, source);
  const confidence = confidenceFromEvidence(evidence, canSupportHypothesis);
  const isError = keywordFlags.recordError;
  const isGeneratedArtifact = evidence.category === "generated_artifact";
  const kind: NormalizedRecordKind = isError ? "error" : canSupportHypothesis && !isGeneratedArtifact ? "evidence" : isGeneratedArtifact ? "observation" : "claim";
  const memoryScope = memoryScopeForTraceability(traceabilityKind);
  const base = {
    projectId: evidence.projectId,
    originProjectId: evidence.projectId,
    workspaceProjectId: evidence.projectId,
    memoryScope,
    iteration,
    evidenceId: evidence.id,
    sourceId: evidence.sourceId,
    citation: canSupportHypothesis ? evidence.citation || evidence.sourceUri || evidence.doi : undefined,
    sourceUri: evidence.sourceUri,
    metadata: metadata(traceabilityKind, canSupportHypothesis && !isGeneratedArtifact, content, {
      ...(evidence.metadata ?? {}),
      category: evidence.category,
      linkedHypothesisIds: evidence.linkedHypothesisIds,
      reliabilityScore: evidence.reliabilityScore,
      relevanceScore: evidence.relevanceScore,
      evidenceStrength: evidence.evidenceStrength,
      limitations: evidence.limitations,
      sourceKind: source?.kind,
      doi: evidence.doi,
      ...sourceQualityMetadata(evidence.sourceUri ?? source?.url ?? source?.rawPath, evidence.title)
    }),
    confidence,
    validationStatus: validationStatusFor(traceabilityKind, canSupportHypothesis && !isGeneratedArtifact, kind),
    createdAt: evidence.createdAt
  };
  records.push(tagMemoryScope({
    ...base,
    id: createStableId("record", `${evidence.id}:${kind}`),
    kind,
    title: evidence.title,
    content
  }, memoryScope));

  if (canSupportHypothesis && (evidence.citation || evidence.sourceUri || evidence.doi)) {
    records.push(tagMemoryScope({
      ...base,
      id: createStableId("record", `${evidence.id}:citation:${evidence.citation ?? evidence.sourceUri ?? evidence.doi}`),
      kind: "citation",
      title: `Citation for ${evidence.title}`,
      content: evidence.citation ?? evidence.sourceUri ?? evidence.doi ?? evidence.title,
      metadata: metadata(traceabilityKind, false, content, {
        ...(evidence.metadata ?? {}),
        category: evidence.category,
        sourceKind: source?.kind,
        doi: evidence.doi
      }),
      confidence: 0.7
    }, memoryScope));
  }

  records.push(tagMemoryScope({
    ...base,
    id: createStableId("record", `${evidence.id}:claim`),
    kind: "claim",
    title: `Claim: ${evidence.title}`,
    content: evidence.summary,
    citation: undefined,
    metadata: metadata(traceabilityKind, false, evidence.summary, {
      ...(evidence.metadata ?? {}),
      category: evidence.category,
      linkedHypothesisIds: evidence.linkedHypothesisIds
    }),
    confidence: Math.max(0.1, confidence - 0.15),
    validationStatus: "raw"
  }, memoryScope));
}

function appendRecordsFromToolRun(records: NormalizedResearchRecord[], toolRun: ToolRun): void {
  const content = joinPresent(
    "\n",
    toolRun.toolName,
    toolRun.status,
    JSON.stringify(toolRun.input),
    JSON.stringify(toolRun.output),
    toolRun.error
  );
  const isError = toolRun.status === "failed";
  records.push(tagMemoryScope({
    id: createStableId("record", `${toolRun.id}:${isError ? "error" : "observation"}`),
    projectId: toolRun.projectId,
    iteration: toolRun.iteration,
    kind: isError ? "error" : "observation",
    title: `${toolRun.toolName} ${toolRun.status}`,
    content,
    sourceUri: `logs/iteration-${toolRun.iteration}.json`,
    metadata: metadata(isError ? "error" : "tool_observation", false, content, {
      toolRunId: toolRun.id,
      status: toolRun.status,
      error: toolRun.error,
      sourceKind: "log"
    }),
    confidence: toolRun.status === "completed" ? 0.65 : 0.2,
    validationStatus: isError ? "rejected" : "raw",
    createdAt: toolRun.completedAt || nowIso()
  }, isError ? "ephemeral" : "project_only"));

  if (toolRun.toolName === "OpenCodeStructuredOutput" && toolRun.status === "completed") {
    appendRecordsFromOpenCodeStructuredOutput(records, toolRun);
  }
}

function appendRecordsFromOpenCodeStructuredOutput(records: NormalizedResearchRecord[], toolRun: ToolRun): void {
  const output = toolRun.output as { claims?: unknown; observations?: unknown } | undefined;
  appendStructuredItems(records, output?.claims, "claim", toolRun);
  appendStructuredItems(records, output?.observations, "observation", toolRun);
}

function appendStructuredItems(
  records: NormalizedResearchRecord[],
  value: unknown,
  kind: Extract<NormalizedRecordKind, "claim" | "observation">,
  toolRun: ToolRun
): void {
  if (!Array.isArray(value)) return;
  const limit = Math.min(value.length, 48);
  for (let index = 0; index < limit; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object") continue;
    const record = item as { title?: unknown; content?: unknown; sourceUri?: unknown; citation?: unknown; metadata?: unknown };
    const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : `OpenCode ${kind} ${index + 1}`;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content && typeof record.sourceUri !== "string" && typeof record.citation !== "string") continue;
    const metadataExtra = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? record.metadata as Record<string, unknown>
      : {};
    records.push(tagMemoryScope({
      id: createStableId("record", `${toolRun.id}:${kind}:${index}:${title}:${content.slice(0, 120)}`),
      projectId: toolRun.projectId,
      iteration: toolRun.iteration,
      kind,
      title,
      content,
      sourceUri: typeof record.sourceUri === "string" ? record.sourceUri : `logs/iteration-${toolRun.iteration}.json`,
      citation: typeof record.citation === "string" ? record.citation : undefined,
      metadata: metadata("tool_observation", false, content || title, {
        ...metadataExtra,
        toolRunId: toolRun.id,
        sourceKind: "log",
        openCodeStructuredOutput: true
      }),
      confidence: 0.4,
      validationStatus: "raw",
      createdAt: toolRun.completedAt || nowIso()
    }, "project_only"));
  }
}

function metadata(traceabilityKind: TraceabilityKind, canSupportHypothesis: boolean, text: string, extra: Record<string, unknown>): Record<string, unknown> {
  const keywords = extractKeywords(text);
  return {
    ...extra,
    traceabilityKind,
    canSupportHypothesis,
    keywords,
    inferredKeywords: keywords.slice(0, 12),
    domainTags: keywords.slice(0, 8)
  };
}

function joinPresent(separator: string, ...values: unknown[]): string {
  const parts: string[] = [];
  for (const value of values) {
    if (value) parts.push(String(value));
  }
  return parts.join(separator);
}

function validationStatusFor(traceabilityKind: TraceabilityKind, canSupportHypothesis: boolean, kind: NormalizedRecordKind): "raw" | "normalized" | "rejected" {
  if (traceabilityKind === "error") return "rejected";
  if (traceabilityKind === "external_source" && (canSupportHypothesis || kind === "source" || kind === "citation")) return "normalized";
  return "raw";
}

function sourceTraceability(source: ResearchSource): TraceabilityKind {
  if (source.kind === "web" || source.kind === "paper") {
    return source.url || source.doi || source.rawPath ? "external_source" : "project_provenance";
  }
  if (source.kind === "file") {
    return source.rawPath && !isInternalUri(source.rawPath) ? "external_source" : "project_provenance";
  }
  if (source.kind === "log") return "tool_observation";
  if (source.kind === "artifact") return "internal_artifact";
  return "project_provenance";
}

function evidenceTraceability(evidence: EvidenceItem, source?: ResearchSource, keywordFlags = evidenceKeywordFlags(evidence.keywords)): TraceabilityKind {
  if (keywordFlags.traceabilityError) {
    return "error";
  }
  if (evidence.category === "generated_artifact") {
    return "internal_artifact";
  }
  if (evidence.category === "experiment_log") {
    return "tool_observation";
  }
  if (evidence.doi || isExternalUri(evidence.sourceUri) || isExternalCitation(evidence.citation) || sourceTraceability(source ?? emptySource()) === "external_source") {
    return "external_source";
  }
  return "project_provenance";
}

function confidenceFromEvidence(evidence: EvidenceItem, canSupportHypothesis: boolean): number {
  const reliability = evidence.reliabilityScore ?? 0.35;
  const relevance = evidence.relevanceScore ?? 0.5;
  const traceability = canSupportHypothesis ? 0.15 : -0.15;
  const strength = evidence.evidenceStrength === "strong" ? 0.15 : evidence.evidenceStrength === "medium" ? 0.05 : -0.05;
  return Math.max(0.05, Math.min(0.95, (reliability + relevance) / 2 + traceability + strength));
}

function isExternalUri(value: string | undefined): boolean {
  return Boolean(value && /^https?:\/\//i.test(value));
}

function isExternalCitation(value: string | undefined): boolean {
  return Boolean(value && (/https?:\/\//i.test(value) || /\bdoi\b/i.test(value) || /10\.\d{4,9}\//.test(value)));
}

function isInternalUri(value: string): boolean {
  const normalized = value.includes("\\") ? value.replace(/\\/g, "/") : value;
  return /^(project:\/\/|artifacts\/|logs\/|reports\/|knowledge\/|ontology\/|exports\/)/i.test(normalized);
}

function evidenceKeywordFlags(keywords: string[]): { traceabilityError: boolean; recordError: boolean } {
  let traceabilityError = false;
  let recordError = false;
  for (const keyword of keywords) {
    if (keyword.includes("error") || keyword.includes("failed")) {
      traceabilityError = true;
      recordError = true;
    } else if (keyword.includes("tool_unavailable")) {
      recordError = true;
    }
    if (traceabilityError && recordError) break;
  }
  return { traceabilityError, recordError };
}

function hasNonInternalTrace(evidence: EvidenceItem): boolean {
  const trace = evidence.sourceUri ?? evidence.citation ?? evidence.doi;
  return Boolean(trace && (isExternalUri(trace) || evidence.doi || !isInternalUri(trace)));
}

function emptySource(): ResearchSource {
  return {
    id: "",
    projectId: "",
    kind: "conversation",
    title: "",
    retrievedAt: nowIso(),
    metadata: {}
  };
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
