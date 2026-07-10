import { GraphBuilder } from "./ontology/graphBuilder.js";
import { evidenceConceptText, evidenceConfidence, isGapKeywordFlags, joinPresent, keywordFlags, predicateForEvidenceFlags } from "./ontology/graphAnalysis.js";
import { provenanceIndex, tagGraphMemoryScope } from "./ontology/graphProvenance.js";
import { addParametersToGraph, addRecordToGraph, addSpecificationToGraph } from "./ontology/recordGraphPopulator.js";
export type { OntologyGraphBuildResult } from "./ontology/types.js";
import type { OntologyGraphBuildResult } from "./ontology/types.js";
import type {
  EvidenceItem,
  Hypothesis,
  NormalizedResearchRecord,
  ResearchArtifact,
  ResearchQuestion,
  ResearchSnapshot,
  ResearchSource,
  ResearchSpecification,
  ToolRun
} from "../shared/types.js";

export class OntologyGraphEngine {
  build(input: { snapshot: ResearchSnapshot; records: NormalizedResearchRecord[]; specification?: ResearchSpecification }): OntologyGraphBuildResult {
    const builder = new GraphBuilder(input.snapshot.project.id);
    const specification = input.specification ?? input.snapshot.specifications.at(-1);
    const provenance = provenanceIndex(input.records);

    for (const question of input.snapshot.questions) {
      this.addQuestion(builder, question, provenance.forText(question.text));
    }
    for (const hypothesis of input.snapshot.hypotheses) {
      this.addHypothesis(builder, hypothesis, provenance.forText(hypothesis.statement));
    }
    for (const source of input.snapshot.sources) {
      this.addSource(builder, source);
    }
    for (const artifact of input.snapshot.artifacts) {
      this.addArtifact(builder, artifact);
    }
    for (const toolRun of input.snapshot.toolRuns) {
      this.addToolRun(builder, toolRun);
    }
    for (const evidence of input.snapshot.evidence) {
      this.addEvidence(builder, evidence);
    }
    for (const record of input.records) {
      addRecordToGraph(builder, record, input.snapshot);
    }
    if (specification) {
      addSpecificationToGraph(builder, specification, provenance.specificationRecordId);
    }

    return tagGraphMemoryScope(builder.result(), input.records);
  }

  private addQuestion(builder: GraphBuilder, question: ResearchQuestion, sourceRecordId?: string): void {
    const questionId = builder.entity({
      type: "ResearchQuestion",
      label: question.text,
      key: question.id,
      description: `Research question status: ${question.status}`,
      sourceRecordId,
      confidence: 0.86
    });
    for (const conceptId of builder.conceptsFrom(question.text, questionId, 0.62)) {
      builder.relation({ subjectId: questionId, predicate: "mentions", objectId: conceptId, sourceRecordId, confidence: 0.58 });
    }
  }

  private addHypothesis(builder: GraphBuilder, hypothesis: Hypothesis, sourceRecordId?: string): void {
    const hypothesisId = builder.entity({
      type: "Hypothesis",
      label: hypothesis.statement,
      key: hypothesis.id,
      description: `Hypothesis status: ${hypothesis.status}`,
      sourceRecordId,
      sourceEvidenceId: undefined,
      confidence: hypothesis.confidence
    });
    if (hypothesis.questionId) {
      builder.relation({
        subjectId: hypothesisId,
        predicate: "refines",
        objectId: builder.entityId("ResearchQuestion", hypothesis.questionId),
        sourceRecordId,
        confidence: 0.72
      });
    }
    for (const conceptId of builder.conceptsFrom(hypothesis.statement, hypothesisId, 0.58)) {
      builder.relation({ subjectId: hypothesisId, predicate: "mentions", objectId: conceptId, sourceRecordId, confidence: 0.54 });
    }
  }

  private addSource(builder: GraphBuilder, source: ResearchSource): void {
    const sourceId = builder.entity({
      type: "Source",
      label: source.title,
      key: source.id,
      description: joinPresent(" / ", source.kind, source.url, source.doi, source.rawPath),
      confidence: source.url || source.doi || source.rawPath ? 0.82 : 0.48
    });
    for (const conceptId of builder.conceptsFrom(joinPresent(" ", source.title, source.url, source.doi), sourceId, 0.48)) {
      builder.relation({ subjectId: sourceId, predicate: "mentions", objectId: conceptId, confidence: 0.42 });
    }
  }

  private addArtifact(builder: GraphBuilder, artifact: ResearchArtifact): void {
    const artifactId = builder.entity({
      type: "Artifact",
      label: artifact.title,
      key: artifact.id,
      description: joinPresent(" / ", artifact.category, artifact.relativePath, artifact.summary),
      confidence: artifact.rawPath || artifact.relativePath ? 0.72 : 0.52
    });
    if (artifact.category === "generated_artifact") {
      const writerId = builder.entity({
        type: "Tool",
        label: "ArtifactWriterTool",
        key: "tool:ArtifactWriterTool",
        description: "Built-in artifact writer used to persist generated research outputs.",
        confidence: 0.7
      });
      builder.relation({ subjectId: artifactId, predicate: "generatedBy", objectId: writerId, confidence: 0.68 });
    }
    for (const conceptId of builder.conceptsFrom(joinPresent(" ", artifact.title, artifact.summary, artifact.content), artifactId, 0.5)) {
      builder.relation({ subjectId: artifactId, predicate: "mentions", objectId: conceptId, confidence: 0.45 });
    }
    addParametersToGraph(builder, artifactId, artifact.content ?? artifact.summary);
  }

  private addToolRun(builder: GraphBuilder, toolRun: ToolRun): void {
    const toolId = builder.entity({
      type: "Tool",
      label: toolRun.toolName,
      key: `tool:${toolRun.toolName}`,
      description: "Executable research tool.",
      confidence: 0.76
    });
    const observationId = builder.entity({
      type: "Result",
      label: `${toolRun.toolName} ${toolRun.status}`,
      key: toolRun.id,
      description: joinPresent("\n", JSON.stringify(toolRun.output), toolRun.error).slice(0, 900),
      confidence: toolRun.status === "completed" ? 0.68 : 0.34
    });
    builder.relation({
      subjectId: observationId,
      predicate: "generatedBy",
      objectId: toolId,
      confidence: toolRun.status === "completed" ? 0.68 : 0.34
    });
    if (toolRun.status !== "completed") {
      const limitationId = builder.entity({
        type: "Limitation",
        label: `${toolRun.toolName} unavailable or failed`,
        key: `limitation:${toolRun.id}`,
        description: toolRun.error ?? "Tool did not complete successfully.",
        confidence: 0.82
      });
      builder.relation({ subjectId: observationId, predicate: "hasLimitation", objectId: limitationId, confidence: 0.78 });
    }
  }

  private addEvidence(builder: GraphBuilder, evidence: EvidenceItem): void {
    const evidenceId = builder.entity({
      type: "Evidence",
      label: evidence.title,
      key: evidence.id,
      description: evidence.summary,
      sourceEvidenceId: evidence.id,
      confidence: evidenceConfidence(evidence)
    });
    if (evidence.sourceId) {
      builder.relation({
        subjectId: evidenceId,
        predicate: "derivedFrom",
        objectId: builder.entityId("Source", evidence.sourceId),
        sourceEvidenceId: evidence.id,
        confidence: 0.74
      });
    }
    if (evidence.citation || evidence.sourceUri || evidence.doi) {
      const sourceKey = evidence.sourceId ?? `citation:${evidence.citation ?? evidence.sourceUri ?? evidence.doi}`;
      const sourceId = builder.entity({
        type: "Source",
        label: evidence.citation ?? evidence.sourceUri ?? evidence.doi ?? evidence.title,
        key: sourceKey,
        description: joinPresent(" / ", evidence.sourceUri, evidence.doi),
        sourceEvidenceId: evidence.id,
        confidence: 0.76
      });
      builder.relation({ subjectId: evidenceId, predicate: "cites", objectId: sourceId, sourceEvidenceId: evidence.id, confidence: 0.76 });
      const citationId = builder.entity({
        type: "Citation",
        label: evidence.citation ?? evidence.sourceUri ?? evidence.doi ?? evidence.title,
        key: `citation:${evidence.id}:${evidence.citation ?? evidence.sourceUri ?? evidence.doi}`,
        description: joinPresent(" / ", evidence.quote, evidence.sourceUri, evidence.doi),
        sourceEvidenceId: evidence.id,
        confidence: 0.78
      });
      builder.relation({ subjectId: evidenceId, predicate: "cites", objectId: citationId, sourceEvidenceId: evidence.id, confidence: 0.78 });
      builder.relation({ subjectId: sourceId, predicate: "hasCitation", objectId: citationId, sourceEvidenceId: evidence.id, confidence: 0.76 });
    }
    if (evidence.linkedHypothesisIds.length) {
      const evidenceFlags = keywordFlags(evidence.keywords);
      const predicate = predicateForEvidenceFlags(evidenceFlags);
      const isGap = isGapKeywordFlags(evidenceFlags);
      const confidence = evidenceConfidence(evidence);
      for (const hypothesisId of evidence.linkedHypothesisIds) {
        const targetId = builder.entityId("Hypothesis", hypothesisId);
        if (predicate) {
          builder.relation({
            subjectId: evidenceId,
            predicate,
            objectId: targetId,
            sourceEvidenceId: evidence.id,
            confidence
          });
        }
        if (isGap) {
          const limitationId = builder.entity({
            type: "Limitation",
            label: evidence.title,
            key: `limitation:${evidence.id}`,
            description: evidence.summary,
            sourceEvidenceId: evidence.id,
            confidence: 0.76
          });
          builder.relation({ subjectId: targetId, predicate: "hasLimitation", objectId: limitationId, sourceEvidenceId: evidence.id, confidence: 0.76 });
        }
      }
    }
    for (const limitation of evidence.limitations ?? []) {
      const limitationId = builder.entity({
        type: "Limitation",
        label: limitation,
        key: `limitation:${evidence.id}:${limitation}`,
        description: limitation,
        sourceEvidenceId: evidence.id,
        confidence: 0.7
      });
      builder.relation({ subjectId: evidenceId, predicate: "hasLimitation", objectId: limitationId, sourceEvidenceId: evidence.id, confidence: 0.68 });
    }
    for (const conceptId of builder.conceptsFrom(evidenceConceptText(evidence), evidenceId, 0.55)) {
      builder.relation({ subjectId: evidenceId, predicate: "mentions", objectId: conceptId, sourceEvidenceId: evidence.id, confidence: 0.5 });
    }
    addParametersToGraph(builder, evidenceId, evidence.summary);
  }
}
