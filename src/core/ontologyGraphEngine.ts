import { extractKeywords } from "./chunking.js";
import { createStableId, nowIso } from "./ids.js";
import type {
  EvidenceItem,
  Hypothesis,
  NormalizedResearchRecord,
  OntologyConstraint,
  OntologyEntity,
  OntologyEntityType,
  OntologyRelation,
  OntologyRelationType,
  ResearchArtifact,
  ResearchQuestion,
  ResearchSnapshot,
  ResearchSource,
  ResearchSpecification,
  ToolRun
} from "./types.js";

export interface OntologyGraphBuildResult {
  entities: OntologyEntity[];
  relations: OntologyRelation[];
  constraints: OntologyConstraint[];
}

interface EntitySeed {
  type: OntologyEntityType;
  label: string;
  key: string;
  description?: string;
  sourceRecordId?: string;
  sourceEvidenceId?: string;
  confidence: number;
}

interface RelationSeed {
  subjectId: string;
  predicate: OntologyRelationType;
  objectId: string;
  sourceRecordId?: string;
  sourceEvidenceId?: string;
  confidence: number;
}

export class OntologyGraphEngine {
  build(input: {
    snapshot: ResearchSnapshot;
    records: NormalizedResearchRecord[];
    specification?: ResearchSpecification;
  }): OntologyGraphBuildResult {
    const builder = new GraphBuilder(input.snapshot.project.id);
    const specification = input.specification ?? input.snapshot.specifications.at(-1);

    for (const question of input.snapshot.questions) {
      this.addQuestion(builder, question);
    }
    for (const hypothesis of input.snapshot.hypotheses) {
      this.addHypothesis(builder, hypothesis);
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
      this.addRecord(builder, record, input.snapshot);
    }
    if (specification) {
      this.addSpecification(builder, specification);
    }

    return builder.result();
  }

  private addQuestion(builder: GraphBuilder, question: ResearchQuestion): void {
    const questionId = builder.entity({
      type: "ResearchQuestion",
      label: question.text,
      key: question.id,
      description: `Research question status: ${question.status}`,
      confidence: 0.86
    });
    for (const conceptId of builder.conceptsFrom(question.text, questionId, 0.62)) {
      builder.relation({ subjectId: questionId, predicate: "mentions", objectId: conceptId, confidence: 0.58 });
    }
  }

  private addHypothesis(builder: GraphBuilder, hypothesis: Hypothesis): void {
    const hypothesisId = builder.entity({
      type: "Hypothesis",
      label: hypothesis.statement,
      key: hypothesis.id,
      description: `Hypothesis status: ${hypothesis.status}`,
      sourceEvidenceId: undefined,
      confidence: hypothesis.confidence
    });
    if (hypothesis.questionId) {
      builder.relation({
        subjectId: hypothesisId,
        predicate: "refines",
        objectId: builder.entityId("ResearchQuestion", hypothesis.questionId),
        confidence: 0.72
      });
    }
    for (const conceptId of builder.conceptsFrom(hypothesis.statement, hypothesisId, 0.58)) {
      builder.relation({ subjectId: hypothesisId, predicate: "mentions", objectId: conceptId, confidence: 0.54 });
    }
  }

  private addSource(builder: GraphBuilder, source: ResearchSource): void {
    const sourceId = builder.entity({
      type: "Source",
      label: source.title,
      key: source.id,
      description: [source.kind, source.url, source.doi, source.rawPath].filter(Boolean).join(" / "),
      confidence: source.url || source.doi || source.rawPath ? 0.82 : 0.48
    });
    for (const conceptId of builder.conceptsFrom([source.title, source.url, source.doi].filter(Boolean).join(" "), sourceId, 0.48)) {
      builder.relation({ subjectId: sourceId, predicate: "mentions", objectId: conceptId, confidence: 0.42 });
    }
  }

  private addArtifact(builder: GraphBuilder, artifact: ResearchArtifact): void {
    const artifactId = builder.entity({
      type: "Artifact",
      label: artifact.title,
      key: artifact.id,
      description: [artifact.category, artifact.relativePath, artifact.summary].filter(Boolean).join(" / "),
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
    for (const conceptId of builder.conceptsFrom([artifact.title, artifact.summary, artifact.content].filter(Boolean).join(" "), artifactId, 0.5)) {
      builder.relation({ subjectId: artifactId, predicate: "mentions", objectId: conceptId, confidence: 0.45 });
    }
    this.addParameters(builder, artifactId, artifact.content ?? artifact.summary);
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
      description: [JSON.stringify(toolRun.output), toolRun.error].filter(Boolean).join("\n").slice(0, 900),
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
        description: [evidence.sourceUri, evidence.doi].filter(Boolean).join(" / "),
        sourceEvidenceId: evidence.id,
        confidence: 0.76
      });
      builder.relation({ subjectId: evidenceId, predicate: "cites", objectId: sourceId, sourceEvidenceId: evidence.id, confidence: 0.76 });
    }
    for (const hypothesisId of evidence.linkedHypothesisIds) {
      const targetId = builder.entityId("Hypothesis", hypothesisId);
      const predicate = predicateForEvidence(evidence);
      if (predicate) {
        builder.relation({
          subjectId: evidenceId,
          predicate,
          objectId: targetId,
          sourceEvidenceId: evidence.id,
          confidence: evidenceConfidence(evidence)
        });
      }
      if (isGapEvidence(evidence)) {
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
    for (const conceptId of builder.conceptsFrom([evidence.title, evidence.summary, evidence.quote, ...evidence.keywords].filter(Boolean).join(" "), evidenceId, 0.55)) {
      builder.relation({ subjectId: evidenceId, predicate: "mentions", objectId: conceptId, sourceEvidenceId: evidence.id, confidence: 0.5 });
    }
    this.addParameters(builder, evidenceId, evidence.summary);
  }

  private addRecord(builder: GraphBuilder, record: NormalizedResearchRecord, snapshot: ResearchSnapshot): void {
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
    }
    for (const hypothesisId of readStringArray(record.metadata.linkedHypothesisIds)) {
      const targetId = builder.entityId("Hypothesis", hypothesisId);
      if (isGapRecord(record)) {
        builder.relation({
          subjectId: targetId,
          predicate: "hasLimitation",
          objectId: recordEntityId,
          sourceRecordId: record.id,
          sourceEvidenceId: record.evidenceId,
          confidence: record.confidence ?? 0.45
        });
      } else {
        builder.relation({
          subjectId: recordEntityId,
          predicate: predicateForRecord(record),
          objectId: targetId,
          sourceRecordId: record.id,
          sourceEvidenceId: record.evidenceId,
          confidence: record.confidence ?? 0.45
        });
      }
    }
    for (const question of snapshot.questions) {
      if (overlapScore(question.text, record.content) >= 0.18 && (record.kind === "claim" || record.kind === "evidence" || record.kind === "observation")) {
        builder.relation({
          subjectId: recordEntityId,
          predicate: "answers",
          objectId: builder.entityId("ResearchQuestion", question.id),
          sourceRecordId: record.id,
          sourceEvidenceId: record.evidenceId,
          confidence: Math.max(0.35, Math.min(0.7, overlapScore(question.text, record.content)))
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
    this.addParameters(builder, recordEntityId, record.content, record.id, record.evidenceId);
  }

  private addSpecification(builder: GraphBuilder, specification: ResearchSpecification): void {
    for (const metric of specification.evaluationMetrics) {
      const metricId = builder.entity({
        type: "Metric",
        label: metric,
        key: `metric:${metric}`,
        description: "Evaluation metric from the research specification.",
        confidence: 0.78
      });
      for (const hypothesis of specification.refinedHypotheses) {
        const conceptId = builder.concept(hypothesis, 0.5);
        builder.relation({ subjectId: conceptId, predicate: "requires", objectId: metricId, confidence: 0.42 });
      }
    }
    for (const evidenceType of specification.requiredEvidenceTypes) {
      const methodId = builder.entity({
        type: "Method",
        label: `Required evidence: ${evidenceType}`,
        key: `method:required-evidence:${evidenceType}`,
        description: "Evidence collection method required by the research specification.",
        confidence: 0.7
      });
      for (const hypothesis of specification.refinedHypotheses.length ? specification.refinedHypotheses : specification.initialHypotheses) {
        const hypothesisId = builder.entity({
          type: "Hypothesis",
          label: hypothesis,
          key: `spec-hypothesis:${hypothesis}`,
          description: "Hypothesis from the research specification.",
          confidence: 0.55
        });
        builder.relation({
          subjectId: hypothesisId,
          predicate: "requires",
          objectId: methodId,
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
        confidence: 0.62
      });
    }
    for (const constraint of specification.constraints) {
      const constraintId = builder.entity({
        type: "Constraint",
        label: constraint,
        key: `constraint:${constraint}`,
        description: constraint,
        confidence: 0.72
      });
      builder.constraint({
        label: constraint,
        description: constraint,
        appliesToEntityType: "Hypothesis",
        ruleType: "custom",
        rule: { source: "research_specification", constraintEntityId: constraintId },
        confidence: 0.72
      });
    }
    for (const question of specification.competencyQuestions) {
      builder.entity({
        type: "ResearchQuestion",
        label: question,
        key: `competency:${question}`,
        description: "Competency question used to test whether the ontology can answer the research need.",
        confidence: 0.68
      });
    }
  }

  private addParameters(builder: GraphBuilder, subjectId: string, text: string, sourceRecordId?: string, sourceEvidenceId?: string): void {
    const matches = extractParameterMentions(text).slice(0, 6);
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
}

class GraphBuilder {
  private readonly entities = new Map<string, OntologyEntity>();
  private readonly relations = new Map<string, OntologyRelation>();
  private readonly constraints = new Map<string, OntologyConstraint>();

  constructor(private readonly projectId: string) {}

  entity(seed: EntitySeed): string {
    const id = this.entityId(seed.type, seed.key);
    const current = this.entities.get(id);
    const next: OntologyEntity = {
      id,
      projectId: this.projectId,
      label: seed.label,
      type: seed.type,
      description: seed.description,
      sourceRecordId: seed.sourceRecordId,
      sourceEvidenceId: seed.sourceEvidenceId,
      confidence: clamp(seed.confidence),
      createdAt: nowIso()
    };
    this.entities.set(id, current ? mergeEntity(current, next) : next);
    return id;
  }

  entityId(type: OntologyEntityType, key: string): string {
    return createStableId("entity", `${this.projectId}:${type}:${key}`);
  }

  concept(label: string, confidence: number): string {
    const normalized = normalizeConcept(label);
    return this.entity({
      type: "Concept",
      label: normalized,
      key: `concept:${normalized}`,
      description: `Concept extracted from research memory: ${normalized}`,
      confidence
    });
  }

  conceptsFrom(text: string, subjectId: string, confidence: number, preferredKeywords: string[] = []): string[] {
    const keywords = unique([...preferredKeywords, ...extractKeywords(text)])
      .map(normalizeConcept)
      .filter((keyword) => keyword.length >= 3 && !genericConcepts.has(keyword))
      .slice(0, 6);
    const conceptIds = keywords.map((keyword) => this.concept(keyword, confidence));
    for (const conceptId of conceptIds) {
      this.relation({ subjectId, predicate: "mentions", objectId: conceptId, confidence: Math.max(0.25, confidence - 0.08) });
    }
    return conceptIds;
  }

  relation(seed: RelationSeed): string {
    if (seed.subjectId === seed.objectId) {
      return "";
    }
    const id = createStableId(
      "relation",
      [
        this.projectId,
        seed.subjectId,
        seed.predicate,
        seed.objectId,
        seed.sourceRecordId ?? "",
        seed.sourceEvidenceId ?? ""
      ].join(":")
    );
    const current = this.relations.get(id);
    const next: OntologyRelation = {
      id,
      projectId: this.projectId,
      subjectId: seed.subjectId,
      predicate: seed.predicate,
      objectId: seed.objectId,
      sourceRecordId: seed.sourceRecordId,
      sourceEvidenceId: seed.sourceEvidenceId,
      confidence: clamp(seed.confidence),
      createdAt: nowIso()
    };
    this.relations.set(id, current ? { ...current, confidence: Math.max(current.confidence, next.confidence) } : next);
    return id;
  }

  constraint(seed: Omit<OntologyConstraint, "id" | "projectId" | "createdAt">): string {
    const id = createStableId("constraint", `${this.projectId}:${seed.label}:${seed.ruleType}`);
    this.constraints.set(id, {
      ...seed,
      id,
      projectId: this.projectId,
      confidence: clamp(seed.confidence),
      createdAt: nowIso()
    });
    return id;
  }

  result(): OntologyGraphBuildResult {
    return {
      entities: [...this.entities.values()],
      relations: [...this.relations.values()],
      constraints: [...this.constraints.values()]
    };
  }
}

function entityTypeForRecord(record: NormalizedResearchRecord): OntologyEntityType {
  if (record.kind === "claim") return "Claim";
  if (record.kind === "evidence") return "Evidence";
  if (record.kind === "source" || record.kind === "citation") return "Source";
  if (record.kind === "artifact") return "Artifact";
  if (record.kind === "observation") return "Result";
  return "Result";
}

function predicateForEvidence(evidence: EvidenceItem): OntologyRelationType | undefined {
  const keywords = new Set(evidence.keywords.map((keyword) => keyword.toLowerCase()));
  if (keywords.has("contradicts") || keywords.has("rejected")) return "contradicts";
  if (keywords.has("evidence_gap") || keywords.has("tool_unavailable")) return undefined;
  return "supports";
}

function predicateForRecord(record: NormalizedResearchRecord): OntologyRelationType {
  const keywords = new Set(readStringArray(record.metadata.keywords).map((keyword) => keyword.toLowerCase()));
  if (keywords.has("contradicts") || keywords.has("rejected")) return "contradicts";
  return "supports";
}

function evidenceConfidence(evidence: EvidenceItem): number {
  const reliability = evidence.reliabilityScore ?? 0.35;
  const relevance = evidence.relevanceScore ?? 0.45;
  const strength = evidence.evidenceStrength === "strong" ? 0.12 : evidence.evidenceStrength === "medium" ? 0.04 : -0.08;
  const traceability = evidence.citation || evidence.sourceUri || evidence.sourceId ? 0.12 : -0.12;
  return clamp((reliability + relevance) / 2 + strength + traceability);
}

function isGapEvidence(evidence: EvidenceItem): boolean {
  const keywords = new Set(evidence.keywords.map((keyword) => keyword.toLowerCase()));
  return keywords.has("evidence_gap") || keywords.has("tool_unavailable");
}

function isGapRecord(record: NormalizedResearchRecord): boolean {
  const keywords = new Set(readStringArray(record.metadata.keywords).map((keyword) => keyword.toLowerCase()));
  return keywords.has("evidence_gap") || keywords.has("tool_unavailable");
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function overlapScore(left: string, right: string): number {
  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / leftTokens.size;
}

function extractParameterMentions(text: string): Array<{ value: string; unit?: string }> {
  const matches = new Map<string, { value: string; unit?: string }>();
  const slashPattern = /\b\d+\s*\/\s*\d+\b/g;
  for (const match of text.matchAll(slashPattern)) {
    const value = match[0].replace(/\s+/g, "");
    matches.set(value, { value, unit: "ratio" });
  }
  const unitPattern = /\b\d+(?:\.\d+)?\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?|%|percent|회|분|시간)\b/giu;
  for (const match of text.matchAll(unitPattern)) {
    const value = match[0].replace(/\s+/g, " ").trim();
    const unit = value.replace(/^[\d.]+\s*/, "");
    matches.set(value, { value, unit });
  }
  return [...matches.values()];
}

function normalizeConcept(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}/ -]/gu, " ").replace(/\s+/g, " ").trim();
}

function tokens(text: string): string[] {
  return normalizeConcept(text).split(/\s+/).filter((token) => token.length >= 3 && !genericConcepts.has(token));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function clamp(value: number): number {
  return Math.max(0.05, Math.min(0.95, Number(value.toFixed(4))));
}

function mergeEntity(current: OntologyEntity, next: OntologyEntity): OntologyEntity {
  return {
    ...current,
    label: current.label || next.label,
    description: current.description ?? next.description,
    sourceRecordId: current.sourceRecordId ?? next.sourceRecordId,
    sourceEvidenceId: current.sourceEvidenceId ?? next.sourceEvidenceId,
    confidence: Math.max(current.confidence, next.confidence)
  };
}

const genericConcepts = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "research",
  "study",
  "evidence",
  "source",
  "result",
  "analysis",
  "대한",
  "연구",
  "근거",
  "결과",
  "자료"
]);
