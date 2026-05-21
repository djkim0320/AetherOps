import { extractKeywords } from "./chunking.js";
import { createStableId, nowIso } from "./ids.js";
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
    const sourceById = new Map(snapshot.sources.map((source) => [source.id, source]));

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
      records.push(...recordsFromEvidence(evidence, iteration, sourceById.get(evidence.sourceId ?? "")));
    }
    for (const toolRun of snapshot.toolRuns) {
      records.push(recordFromToolRun(toolRun));
    }
    return dedupe(records);
  }
}

function recordFromResearchInput(input: ResearchInput, iteration: number): NormalizedResearchRecord {
  const content = [
    input.researchQuestion,
    ...input.initialHypotheses.map((hypothesis) => `Hypothesis: ${hypothesis}`),
    ...input.constraints.map((constraint) => `Constraint: ${constraint}`),
    ...input.expectedOutputs.map((output) => `Expected output: ${output}`)
  ].join("\n");
  return provenanceRecord(input.projectId, iteration, `research-input:${input.id}`, "Research input", content, `project://research-input/${input.id}`, input.createdAt);
}

function recordFromSpecification(specification: ResearchSpecification, iteration: number): NormalizedResearchRecord {
  const content = [
    ...specification.researchQuestions.map((question) => `Question: ${question}`),
    ...specification.refinedHypotheses.map((hypothesis) => `Refined hypothesis: ${hypothesis}`),
    ...specification.competencyQuestions.map((question) => `Competency question: ${question}`),
    ...specification.successCriteria.map((criterion) => `Success criterion: ${criterion}`)
  ].join("\n");
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
  const content = [
    plan.objective,
    ...plan.targetQuestions.map((question) => `Target question: ${question}`),
    ...plan.targetHypotheses.map((hypothesis) => `Target hypothesis: ${hypothesis}`),
    ...plan.requiredTools.map((tool) => `Required tool: ${tool}`),
    ...plan.executionSteps.map((step) => `Execution step: ${step}`),
    ...plan.stopCriteria.map((criterion) => `Stop criterion: ${criterion}`)
  ].join("\n");
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
  return {
    id: createStableId("record", stableKey),
    projectId,
    iteration,
    kind: "observation",
    title,
    content,
    sourceUri,
    metadata: metadata("project_provenance", false, content, { sourceKind: "conversation" }),
    confidence: 0.6,
    createdAt
  };
}

function recordFromSource(source: ResearchSource, iteration: number): NormalizedResearchRecord {
  const content = [source.title, source.url, source.doi, source.rawPath, JSON.stringify(source.metadata)].filter(Boolean).join("\n");
  const traceabilityKind = sourceTraceability(source);
  return {
    id: createStableId("record", `${source.id}:source`),
    projectId: source.projectId,
    iteration,
    kind: "source",
    title: source.title,
    content,
    sourceId: source.id,
    citation: source.url || source.doi || source.rawPath,
    sourceUri: source.url || source.rawPath,
    metadata: metadata(traceabilityKind, traceabilityKind === "external_source", content, {
      sourceKind: source.kind,
      authors: source.authors,
      publishedAt: source.publishedAt,
      doi: source.doi
    }),
    confidence: traceabilityKind === "external_source" ? 0.75 : 0.35,
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
    metadata: metadata("internal_artifact", false, content, {
      category: artifact.category,
      mimeType: artifact.mimeType,
      sourceKind: "artifact"
    }),
    confidence: artifact.category === "generated_artifact" ? 0.55 : 0.45,
    createdAt: artifact.createdAt
  };
}

function recordsFromEvidence(evidence: EvidenceItem, iteration: number, source?: ResearchSource): NormalizedResearchRecord[] {
  const content = [evidence.title, evidence.summary, evidence.quote, evidence.citation, evidence.sourceUri, evidence.doi].filter(Boolean).join("\n");
  const traceabilityKind = evidenceTraceability(evidence, source);
  const canSupportHypothesis =
    traceabilityKind === "external_source" ||
    (traceabilityKind === "tool_observation" && hasNonInternalTrace(evidence));
  const confidence = confidenceFromEvidence(evidence, canSupportHypothesis);
  const isError = evidence.keywords.some((keyword) => keyword.includes("error") || keyword.includes("failed") || keyword.includes("tool_unavailable"));
  const isGeneratedArtifact = evidence.category === "generated_artifact";
  const kind: NormalizedRecordKind = isError ? "error" : canSupportHypothesis && !isGeneratedArtifact ? "evidence" : isGeneratedArtifact ? "observation" : "claim";
  const base = {
    projectId: evidence.projectId,
    iteration,
    evidenceId: evidence.id,
    sourceId: evidence.sourceId,
    citation: canSupportHypothesis ? evidence.citation || evidence.sourceUri || evidence.doi : undefined,
    sourceUri: evidence.sourceUri,
    metadata: metadata(traceabilityKind, canSupportHypothesis && !isGeneratedArtifact, content, {
      category: evidence.category,
      linkedHypothesisIds: evidence.linkedHypothesisIds,
      reliabilityScore: evidence.reliabilityScore,
      relevanceScore: evidence.relevanceScore,
      evidenceStrength: evidence.evidenceStrength,
      limitations: evidence.limitations,
      sourceKind: source?.kind,
      doi: evidence.doi
    }),
    confidence,
    createdAt: evidence.createdAt
  };
  const records: NormalizedResearchRecord[] = [
    {
      ...base,
      id: createStableId("record", `${evidence.id}:${kind}`),
      kind,
      title: evidence.title,
      content
    }
  ];

  if (canSupportHypothesis && (evidence.citation || evidence.sourceUri || evidence.doi)) {
    records.push({
      ...base,
      id: createStableId("record", `${evidence.id}:citation:${evidence.citation ?? evidence.sourceUri ?? evidence.doi}`),
      kind: "citation",
      title: `Citation for ${evidence.title}`,
      content: evidence.citation ?? evidence.sourceUri ?? evidence.doi ?? evidence.title,
      metadata: metadata(traceabilityKind, false, content, {
        category: evidence.category,
        sourceKind: source?.kind,
        doi: evidence.doi
      }),
      confidence: 0.7
    });
  }

  records.push({
    ...base,
    id: createStableId("record", `${evidence.id}:claim`),
    kind: "claim",
    title: `Claim: ${evidence.title}`,
    content: evidence.summary,
    citation: undefined,
    metadata: metadata(traceabilityKind, false, evidence.summary, {
      category: evidence.category,
      linkedHypothesisIds: evidence.linkedHypothesisIds
    }),
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
  const isError = toolRun.status === "failed";
  return {
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
    createdAt: toolRun.completedAt || nowIso()
  };
}

function metadata(traceabilityKind: TraceabilityKind, canSupportHypothesis: boolean, text: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    traceabilityKind,
    canSupportHypothesis,
    keywords: extractKeywords(text)
  };
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

function evidenceTraceability(evidence: EvidenceItem, source?: ResearchSource): TraceabilityKind {
  if (evidence.keywords.some((keyword) => keyword.includes("error") || keyword.includes("failed"))) {
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
  return /^(project:\/\/|artifacts\/|logs\/|reports\/|knowledge\/|ontology\/|exports\/)/i.test(value.replace(/\\/g, "/"));
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
