import type { NormalizedResearchRecord, ResearchSnapshot, ResearchSpecification } from "../../shared/types.js";
import { GraphBuilder } from "./graphBuilder.js";
import {
  entityTypeForRecord,
  extractParameterMentions,
  isGapKeywordFlags,
  keywordFlags,
  overlapScore,
  predicateForRecordFlags,
  readStringArray
} from "./graphAnalysis.js";

export function addRecordToGraph(builder: GraphBuilder, record: NormalizedResearchRecord, snapshot: ResearchSnapshot): void {
  const recordType = entityTypeForRecord(record);
  const recordEntityId = builder.entity({
    type: recordType,
    label: record.title,
    key: record.id,
    description: record.content.slice(0, 900),
    sourceRecordId: record.id,
    sourceEvidenceId: record.evidenceId,
    confidence: record.confidence ?? 0.45
  });
  if (record.sourceId) {
    builder.relation({
      subjectId: recordEntityId,
      predicate: "derivedFrom",
      objectId: builder.entityId("Source", record.sourceId),
      sourceRecordId: record.id,
      sourceEvidenceId: record.evidenceId,
      confidence: 0.68
    });
  }
  if (record.artifactId) {
    builder.relation({
      subjectId: recordEntityId,
      predicate: "derivedFrom",
      objectId: builder.entityId("Artifact", record.artifactId),
      sourceRecordId: record.id,
      sourceEvidenceId: record.evidenceId,
      confidence: 0.65
    });
  }
  if (record.evidenceId) {
    builder.relation({
      subjectId: recordEntityId,
      predicate: "derivedFrom",
      objectId: builder.entityId("Evidence", record.evidenceId),
      sourceRecordId: record.id,
      sourceEvidenceId: record.evidenceId,
      confidence: 0.68
    });
  }
  if (record.citation || record.sourceUri) {
    const sourceId = builder.entity({
      type: "Source",
      label: record.citation ?? record.sourceUri ?? record.title,
      key: `record-source:${record.id}:${record.citation ?? record.sourceUri}`,
      description: record.sourceUri,
      sourceRecordId: record.id,
      sourceEvidenceId: record.evidenceId,
      confidence: 0.65
    });
    builder.relation({
      subjectId: recordEntityId,
      predicate: "cites",
      objectId: sourceId,
      sourceRecordId: record.id,
      sourceEvidenceId: record.evidenceId,
      confidence: 0.7
    });
    const citationId = builder.entity({
      type: "Citation",
      label: record.citation ?? record.sourceUri ?? record.title,
      key: `record-citation:${record.id}:${record.citation ?? record.sourceUri}`,
      description: record.sourceUri,
      sourceRecordId: record.id,
      sourceEvidenceId: record.evidenceId,
      confidence: 0.68
    });
    builder.relation({
      subjectId: sourceId,
      predicate: "hasCitation",
      objectId: citationId,
      sourceRecordId: record.id,
      sourceEvidenceId: record.evidenceId,
      confidence: 0.68
    });
  }
  const linkedHypothesisIds = readStringArray(record.metadata.linkedHypothesisIds);
  if (linkedHypothesisIds.length) {
    const recordFlags = keywordFlags(readStringArray(record.metadata.keywords));
    const recordIsGap = isGapKeywordFlags(recordFlags);
    const recordPredicate = predicateForRecordFlags(recordFlags);
    const confidence = record.confidence ?? 0.45;
    for (const hypothesisId of linkedHypothesisIds) {
      const targetId = builder.entityId("Hypothesis", hypothesisId);
      if (recordIsGap) {
        builder.relation({
          subjectId: targetId,
          predicate: "hasLimitation",
          objectId: recordEntityId,
          sourceRecordId: record.id,
          sourceEvidenceId: record.evidenceId,
          confidence
        });
      } else {
        builder.relation({
          subjectId: recordEntityId,
          predicate: recordPredicate,
          objectId: targetId,
          sourceRecordId: record.id,
          sourceEvidenceId: record.evidenceId,
          confidence
        });
      }
    }
  }
  const canAnswerQuestion = record.kind === "claim" || record.kind === "evidence" || record.kind === "observation";
  for (const question of snapshot.questions) {
    const score = canAnswerQuestion ? overlapScore(question.text, record.content) : 0;
    if (score >= 0.18) {
      builder.relation({
        subjectId: recordEntityId,
        predicate: "answers",
        objectId: builder.entityId("ResearchQuestion", question.id),
        sourceRecordId: record.id,
        sourceEvidenceId: record.evidenceId,
        confidence: Math.max(0.35, Math.min(0.7, score))
      });
    }
  }
  for (const conceptId of builder.conceptsFrom(record.content, recordEntityId, 0.45, readStringArray(record.metadata.keywords))) {
    builder.relation({
      subjectId: recordEntityId,
      predicate: "mentions",
      objectId: conceptId,
      sourceRecordId: record.id,
      sourceEvidenceId: record.evidenceId,
      confidence: 0.42
    });
  }
  addParametersToGraph(builder, recordEntityId, record.content, record.id, record.evidenceId);
}

export function addSpecificationToGraph(builder: GraphBuilder, specification: ResearchSpecification, sourceRecordId?: string): void {
  for (const metric of specification.evaluationMetrics) {
    const metricId = builder.entity({
      type: "Metric",
      label: metric,
      key: `metric:${metric}`,
      description: "Evaluation metric from the research specification.",
      sourceRecordId,
      confidence: 0.78
    });
    for (const hypothesis of specification.refinedHypotheses) {
      const conceptId = builder.concept(hypothesis, 0.5);
      builder.relation({ subjectId: conceptId, predicate: "requires", objectId: metricId, sourceRecordId, confidence: 0.42 });
    }
  }
  for (const evidenceType of specification.requiredEvidenceTypes) {
    const methodId = builder.entity({
      type: "Method",
      label: `Required evidence: ${evidenceType}`,
      key: `method:required-evidence:${evidenceType}`,
      description: "Evidence collection method required by the research specification.",
      sourceRecordId,
      confidence: 0.7
    });
    for (const hypothesis of specification.refinedHypotheses.length ? specification.refinedHypotheses : specification.initialHypotheses) {
      const hypothesisId = builder.entity({
        type: "Hypothesis",
        label: hypothesis,
        key: `spec-hypothesis:${hypothesis}`,
        description: "Hypothesis from the research specification.",
        sourceRecordId,
        confidence: 0.55
      });
      builder.relation({
        subjectId: hypothesisId,
        predicate: "requires",
        objectId: methodId,
        sourceRecordId,
        confidence: 0.5
      });
    }
  }
  for (const assumption of specification.assumptions) {
    builder.entity({
      type: "Assumption",
      label: assumption,
      key: `assumption:${assumption}`,
      description: assumption,
      sourceRecordId,
      confidence: 0.62
    });
  }
  for (const constraint of specification.constraints) {
    const constraintId = builder.entity({
      type: "Constraint",
      label: constraint,
      key: `constraint:${constraint}`,
      description: constraint,
      sourceRecordId,
      confidence: 0.72
    });
    builder.constraint({
      label: constraint,
      description: constraint,
      appliesToEntityType: "Hypothesis",
      ruleType: "custom",
      rule: { source: "research_specification", constraintEntityId: constraintId },
      sourceRecordId,
      confidence: 0.72
    });
  }
  for (const question of specification.competencyQuestions) {
    builder.entity({
      type: "ResearchQuestion",
      label: question,
      key: `competency:${question}`,
      description: "Competency question used to test whether the ontology can answer the research need.",
      sourceRecordId,
      confidence: 0.68
    });
  }
}

export function addParametersToGraph(builder: GraphBuilder, subjectId: string, text: string, sourceRecordId?: string, sourceEvidenceId?: string): void {
  const matches = extractParameterMentions(text, 6);
  for (const match of matches) {
    const parameterId = builder.entity({
      type: "Parameter",
      label: match.value,
      key: `parameter:${match.value}`,
      description: `Detected parameter mention: ${match.value}`,
      sourceRecordId,
      sourceEvidenceId,
      confidence: 0.55
    });
    builder.relation({ subjectId, predicate: "hasParameter", objectId: parameterId, sourceRecordId, sourceEvidenceId, confidence: 0.5 });
    if (match.unit) {
      const unitId = builder.entity({
        type: "Unit",
        label: match.unit,
        key: `unit:${match.unit}`,
        description: `Detected unit for ${match.value}`,
        sourceRecordId,
        sourceEvidenceId,
        confidence: 0.55
      });
      builder.relation({ subjectId: parameterId, predicate: "measuredIn", objectId: unitId, sourceRecordId, sourceEvidenceId, confidence: 0.52 });
    }
  }
}
