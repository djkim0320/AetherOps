import type { EvidenceItem, HybridContext, NormalizedResearchRecord, OntologyRelation, ProjectContextSnapshot } from "../../../core/shared/types.js";

export function finalClaimEvidence(projectId: string, hypothesisId: string, createdAt: string): EvidenceItem {
  return {
    id: "e-final-claim-support",
    projectId,
    category: "web_source",
    title: "Short-break fatigue study",
    summary: "A controlled study directly supports frequent short breaks reduce fatigue.",
    sourceId: "source-final-claim-support",
    sourceUri: "https://example.edu/final-claim-support",
    citation: "Example citation final-claim-support",
    keywords: ["short", "breaks", "fatigue"],
    linkedHypothesisIds: [hypothesisId],
    reliabilityScore: 0.9,
    relevanceScore: 0.9,
    evidenceStrength: "strong",
    limitations: [],
    createdAt
  };
}

export function finalClaimRecord(projectId: string, evidence: EvidenceItem, createdAt: string): NormalizedResearchRecord {
  return {
    id: "record-final-claim-support",
    projectId,
    memoryScope: "global",
    validationStatus: "normalized",
    iteration: 1,
    kind: "evidence",
    title: evidence.title,
    content: evidence.summary,
    sourceId: evidence.sourceId,
    evidenceId: evidence.id,
    citation: evidence.citation,
    sourceUri: evidence.sourceUri,
    metadata: { traceabilityKind: "external_source", sourceQualityTier: "scholarly", canSupportHypothesis: true },
    confidence: 0.9,
    createdAt
  };
}

export function finalClaimRelation(projectId: string, hypothesisId: string, evidenceId: string, sourceRecordId: string, createdAt: string): OntologyRelation {
  return {
    id: "relation-final-claim-support",
    projectId,
    memoryScope: "global",
    validationStatus: "graph_linked",
    subjectId: "entity-final-claim-support",
    predicate: "supports",
    objectId: hypothesisId,
    sourceRecordId,
    sourceEvidenceId: evidenceId,
    confidence: 0.9,
    createdAt
  };
}

export function finalClaimProjectContext(
  projectId: string,
  evidenceId: string,
  recordId: string,
  relationId: string,
  createdAt: string
): ProjectContextSnapshot {
  return {
    id: "context-final-claim",
    projectId,
    iteration: 1,
    query: "short breaks fatigue",
    selectedRecordIds: [recordId],
    selectedSourceIds: ["source-final-claim-support"],
    selectedEvidenceIds: [evidenceId],
    selectedChunkIds: [],
    selectedEntityIds: [],
    selectedRelationIds: [relationId],
    citations: ["https://example.edu/final-claim-support"],
    selectionReason: "Fixture selected traceable support evidence for final answer scoring.",
    createdAt
  };
}

export function finalClaimHybridContext(projectId: string, evidenceId: string, relationId: string, createdAt: string): HybridContext {
  return {
    id: "hybrid-final-claim",
    projectId,
    iteration: 1,
    query: "short breaks fatigue",
    vectorChunkIds: [],
    ontologyEntityIds: [],
    ontologyRelationIds: [relationId],
    evidenceIds: [evidenceId],
    artifactIds: [],
    citations: ["https://example.edu/final-claim-support"],
    vectorSummary: "Frequent short breaks reduce fatigue.",
    graphSummary: "Short-break evidence supports the fatigue hypothesis.",
    contextText: "A controlled study directly supports frequent short breaks reduce fatigue.",
    retrievalScores: { [evidenceId]: 1 },
    createdAt
  };
}
