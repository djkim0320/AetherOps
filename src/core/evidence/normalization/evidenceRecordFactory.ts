import { createStableId } from "../../shared/ids.js";
import { memoryScopeForTraceability, tagMemoryScope } from "../../memory/researchMemory.js";
import { canEvidenceSupportHypothesis, sourceQualityMetadata } from "../sourceQuality.js";
import type { EvidenceItem, NormalizedRecordKind, NormalizedResearchRecord, ResearchSource } from "../../shared/types.js";
import {
  confidenceFromEvidence,
  evidenceKeywordFlags,
  evidenceTraceability,
  hasNonInternalTrace,
  joinPresent,
  metadata,
  validationStatusFor
} from "./normalizationHelpers.js";

export function appendRecordsFromEvidence(records: NormalizedResearchRecord[], evidence: EvidenceItem, iteration: number, source?: ResearchSource): void {
  const content = joinPresent("\n", evidence.title, evidence.summary, evidence.quote, evidence.citation, evidence.sourceUri, evidence.doi);
  const keywordFlags = evidenceKeywordFlags(evidence.keywords);
  const traceabilityKind = evidenceTraceability(evidence, source, keywordFlags);
  const canSupportHypothesis =
    (traceabilityKind === "external_source" || (traceabilityKind === "tool_observation" && hasNonInternalTrace(evidence))) &&
    canEvidenceSupportHypothesis(evidence, source);
  const confidence = confidenceFromEvidence(evidence, canSupportHypothesis);
  const isError = keywordFlags.recordError;
  const isGeneratedArtifact = evidence.category === "generated_artifact";
  const kind: NormalizedRecordKind = isError
    ? "error"
    : canSupportHypothesis && !isGeneratedArtifact
      ? "evidence"
      : isGeneratedArtifact
        ? "observation"
        : "claim";
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
  records.push(
    tagMemoryScope(
      {
        ...base,
        id: createStableId("record", `${evidence.id}:${kind}`),
        kind,
        title: evidence.title,
        content
      },
      memoryScope
    )
  );

  if (canSupportHypothesis && (evidence.citation || evidence.sourceUri || evidence.doi)) {
    records.push(
      tagMemoryScope(
        {
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
        },
        memoryScope
      )
    );
  }

  records.push(
    tagMemoryScope(
      {
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
      },
      memoryScope
    )
  );
}
