import { createStableId } from "../../shared/ids.js";
import { memoryScopeForTraceability, tagMemoryScope } from "../../memory/researchMemory.js";
import { assessSourceQuality, sourceQualityMetadata } from "../sourceQuality.js";
import type { NormalizedResearchRecord, ResearchArtifact, ResearchInput, ResearchPlan, ResearchSource, ResearchSpecification } from "../../shared/types.js";
import { joinPresent, metadata, sourceTraceability, validationStatusFor } from "./normalizationHelpers.js";

export function recordFromResearchInput(input: ResearchInput, iteration: number): NormalizedResearchRecord {
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
  return provenanceRecord(
    input.projectId,
    iteration,
    `research-input:${input.id}`,
    "Research input",
    content,
    `project://research-input/${input.id}`,
    input.createdAt
  );
}

export function recordFromSpecification(specification: ResearchSpecification, iteration: number): NormalizedResearchRecord {
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

export function recordFromPlan(plan: ResearchPlan, iteration: number): NormalizedResearchRecord {
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
  return provenanceRecord(
    plan.projectId,
    iteration,
    `research-plan:${plan.id}`,
    `Research plan ${plan.iteration}`,
    content,
    `project://research-plan/${plan.id}`,
    plan.createdAt
  );
}

export function provenanceRecord(
  projectId: string,
  iteration: number,
  stableKey: string,
  title: string,
  content: string,
  sourceUri: string,
  createdAt: string
): NormalizedResearchRecord {
  return tagMemoryScope(
    {
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
    },
    "project_only"
  );
}

export function recordFromSource(source: ResearchSource, iteration: number): NormalizedResearchRecord {
  const content = joinPresent("\n", source.title, source.url, source.doi, source.rawPath, JSON.stringify(source.metadata));
  const traceabilityKind = sourceTraceability(source);
  const quality = assessSourceQuality(source.url ?? source.rawPath, source.title);
  const sourceCandidateOnly = source.metadata.sourceCandidateOnly === true || source.metadata.canSupportHypothesis === false;
  const canSupportHypothesis = !sourceCandidateOnly && traceabilityKind === "external_source" && quality.canSupportHypothesis;
  return tagMemoryScope(
    {
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
    },
    memoryScopeForTraceability(traceabilityKind)
  );
}

export function recordFromArtifact(artifact: ResearchArtifact, iteration: number): NormalizedResearchRecord {
  const content = joinPresent("\n", artifact.title, artifact.summary, artifact.content, artifact.relativePath);
  return tagMemoryScope(
    {
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
    },
    "project_only"
  );
}
