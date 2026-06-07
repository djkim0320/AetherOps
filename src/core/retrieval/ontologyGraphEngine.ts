import { extractKeywords } from "./chunking.js";
import { createStableId, nowIso } from "../shared/ids.js";
import { normalizeMemoryScope, tagMemoryScope } from "../memory/researchMemory.js";
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
} from "../shared/types.js";

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
      this.addRecord(builder, record, input.snapshot);
    }
    if (specification) {
      this.addSpecification(builder, specification, provenance.specificationRecordId);
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
    this.addParameters(builder, recordEntityId, record.content, record.id, record.evidenceId);
  }

  private addSpecification(builder: GraphBuilder, specification: ResearchSpecification, sourceRecordId?: string): void {
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

  private addParameters(builder: GraphBuilder, subjectId: string, text: string, sourceRecordId?: string, sourceEvidenceId?: string): void {
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
    const keywords = uniqueConceptKeywordsLazy(preferredKeywords, () => extractKeywords(text));
    const conceptIds: string[] = [];
    for (const keyword of keywords) {
      conceptIds.push(this.concept(keyword, confidence));
    }
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
    for (const relation of this.relations.values()) {
      if (!relation.sourceRecordId && !relation.sourceEvidenceId) {
        continue;
      }
      this.attachRelationSource(relation.subjectId, relation);
      this.attachRelationSource(relation.objectId, relation);
    }
    const entities: OntologyEntity[] = [];
    const entityIds = new Set<string>();
    for (const entity of this.entities.values()) {
      if (!entity.sourceRecordId && !entity.sourceEvidenceId) continue;
      entities.push(entity);
      entityIds.add(entity.id);
    }
    const relations: OntologyRelation[] = [];
    for (const relation of this.relations.values()) {
      if (!relation.sourceRecordId && !relation.sourceEvidenceId) continue;
      if (!entityIds.has(relation.subjectId) || !entityIds.has(relation.objectId)) continue;
      relations.push(relation);
    }
    const constraints: OntologyConstraint[] = [];
    for (const constraint of this.constraints.values()) {
      if (constraint.sourceRecordId) constraints.push(constraint);
    }
    return {
      entities,
      relations,
      constraints
    };
  }

  private attachRelationSource(entityId: string, relation: OntologyRelation): void {
    const entity = this.entities.get(entityId);
    if (!entity || entity.sourceRecordId || entity.sourceEvidenceId) {
      return;
    }
    this.entities.set(entityId, {
      ...entity,
      sourceRecordId: relation.sourceRecordId,
      sourceEvidenceId: relation.sourceEvidenceId,
      confidence: Math.min(entity.confidence, relation.confidence)
    });
  }
}

function entityTypeForRecord(record: NormalizedResearchRecord): OntologyEntityType {
  if (record.kind === "claim") return "Claim";
  if (record.kind === "evidence") return "Evidence";
  if (record.kind === "source") return "Source";
  if (record.kind === "citation") return "Citation";
  if (record.kind === "artifact") return "Artifact";
  if (record.kind === "observation") return "Result";
  return "Result";
}

function predicateForEvidenceFlags(keywords: ReturnType<typeof keywordFlags>): OntologyRelationType | undefined {
  if (keywords.contradicts || keywords.rejected) return "contradicts";
  if (keywords.evidenceGap || keywords.toolUnavailable) return undefined;
  return "supports";
}

function predicateForRecordFlags(keywords: ReturnType<typeof keywordFlags>): OntologyRelationType {
  if (keywords.contradicts || keywords.rejected) return "contradicts";
  return "supports";
}

function evidenceConfidence(evidence: EvidenceItem): number {
  const reliability = evidence.reliabilityScore ?? 0.35;
  const relevance = evidence.relevanceScore ?? 0.45;
  const strength = evidence.evidenceStrength === "strong" ? 0.12 : evidence.evidenceStrength === "medium" ? 0.04 : -0.08;
  const traceability = evidence.citation || evidence.sourceUri || evidence.sourceId ? 0.12 : -0.12;
  return clamp((reliability + relevance) / 2 + strength + traceability);
}

function isGapKeywordFlags(keywords: ReturnType<typeof keywordFlags>): boolean {
  return keywords.evidenceGap || keywords.toolUnavailable;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  for (const item of value) {
    if (typeof item === "string") output.push(item);
  }
  return output;
}

function keywordFlags(keywords: string[]): {
  contradicts: boolean;
  rejected: boolean;
  evidenceGap: boolean;
  toolUnavailable: boolean;
} {
  let contradicts = false;
  let rejected = false;
  let evidenceGap = false;
  let toolUnavailable = false;
  for (const keyword of keywords) {
    const normalized = keyword.toLowerCase();
    if (normalized === "contradicts") contradicts = true;
    else if (normalized === "rejected") rejected = true;
    else if (normalized === "evidence_gap") evidenceGap = true;
    else if (normalized === "tool_unavailable") toolUnavailable = true;
    if (contradicts && rejected && evidenceGap && toolUnavailable) break;
  }
  return { contradicts, rejected, evidenceGap, toolUnavailable };
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

function extractParameterMentions(text: string, limit = Number.POSITIVE_INFINITY): Array<{ value: string; unit?: string }> {
  const matches = new Map<string, { value: string; unit?: string }>();
  const slashPattern = /\b\d+\s*\/\s*\d+\b/g;
  for (const match of text.matchAll(slashPattern)) {
    const value = match[0].replace(/\s+/g, "");
    matches.set(value, { value, unit: "ratio" });
    if (matches.size >= limit) return mapValues(matches);
  }
  const unitPattern = /\b\d+(?:\.\d+)?\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?|%|percent|회|분|시간)\b/giu;
  for (const match of text.matchAll(unitPattern)) {
    const value = match[0].replace(/\s+/g, " ").trim();
    const unit = value.replace(/^[\d.]+\s*/, "");
    matches.set(value, { value, unit });
    if (matches.size >= limit) return mapValues(matches);
  }
  return mapValues(matches);
}

function mapValues<T>(map: Map<string, T>): T[] {
  const values: T[] = [];
  for (const value of map.values()) values.push(value);
  return values;
}

function normalizeConcept(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}/ -]/gu, " ").replace(/\s+/g, " ").trim();
}

function tokens(text: string): string[] {
  const matches = normalizeConcept(text).match(/\S+/g) ?? [];
  const output: string[] = [];
  for (const token of matches) {
    if (token.length >= 3 && !genericConcepts.has(token)) output.push(token);
  }
  return output;
}

function joinPresent(separator: string, ...values: unknown[]): string {
  const parts: string[] = [];
  for (const value of values) {
    if (value) parts.push(String(value));
  }
  return parts.join(separator);
}

function evidenceConceptText(evidence: EvidenceItem): string {
  const parts: string[] = [];
  if (evidence.title) parts.push(evidence.title);
  if (evidence.summary) parts.push(evidence.summary);
  if (evidence.quote) parts.push(evidence.quote);
  for (const keyword of evidence.keywords) {
    if (keyword) parts.push(keyword);
  }
  return parts.join(" ");
}

function uniqueConceptKeywordsLazy(preferredKeywords: string[], extract: () => string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  appendConceptKeywords(output, seen, preferredKeywords);
  if (output.length < 6) {
    appendConceptKeywords(output, seen, extract());
  }
  return output;
}

function appendConceptKeywords(output: string[], seen: Set<string>, values: string[]): void {
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const keyword = normalizeConcept(value);
    if (keyword.length < 3 || genericConcepts.has(keyword)) continue;
    output.push(keyword);
    if (output.length >= 6) return;
  }
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

function provenanceIndex(records: NormalizedResearchRecord[]): {
  specificationRecordId?: string;
  forText(text: string): string | undefined;
} {
  const provenanceRecords: Array<{ id: string; normalizedContent: string }> = [];
  let specificationRecordId: string | undefined;
  for (const record of records) {
    if (record.metadata.traceabilityKind !== "project_provenance") continue;
    provenanceRecords.push({ id: record.id, normalizedContent: normalizeConcept(record.content) });
    if (!specificationRecordId && record.sourceUri?.startsWith("project://research-specification/")) {
      specificationRecordId = record.id;
    }
  }
  return {
    specificationRecordId,
    forText(text: string): string | undefined {
      const normalized = normalizeConcept(text);
      for (const record of provenanceRecords) {
        if (record.normalizedContent.includes(normalized)) return record.id;
      }
      return specificationRecordId ?? provenanceRecords[0]?.id;
    }
  };
}

function tagGraphMemoryScope(graph: OntologyGraphBuildResult, records: NormalizedResearchRecord[]): OntologyGraphBuildResult {
  const recordById = new Map<string, NormalizedResearchRecord>();
  for (const record of records) {
    recordById.set(record.id, record);
  }
  const scopeForRecord = (sourceRecordId?: string): { memoryScope: import("../shared/types.js").MemoryScope; originProjectId?: string; workspaceProjectId?: string; validationStatus?: import("../shared/types.js").ValidationStatus } => {
    const record = sourceRecordId ? recordById.get(sourceRecordId) : undefined;
    return {
      memoryScope: normalizeMemoryScope(record?.memoryScope),
      originProjectId: record?.originProjectId ?? record?.projectId,
      workspaceProjectId: record?.workspaceProjectId ?? record?.projectId,
      validationStatus: record?.validationStatus === "normalized" ? "graph_linked" : record?.validationStatus
    };
  };

  const entities: OntologyEntity[] = [];
  for (const entity of graph.entities) {
    const scope = scopeForRecord(entity.sourceRecordId);
    entities.push({ ...tagMemoryScope(entity, scope.memoryScope, scope.originProjectId ?? entity.projectId, scope.workspaceProjectId ?? entity.projectId), validationStatus: scope.validationStatus ?? entity.validationStatus ?? "raw" });
  }
  const relations: OntologyRelation[] = [];
  for (const relation of graph.relations) {
    const scope = scopeForRecord(relation.sourceRecordId);
    relations.push({ ...tagMemoryScope(relation, scope.memoryScope, scope.originProjectId ?? relation.projectId, scope.workspaceProjectId ?? relation.projectId), validationStatus: scope.validationStatus ?? relation.validationStatus ?? "raw" });
  }
  const constraints: OntologyConstraint[] = [];
  for (const constraint of graph.constraints) {
    const scope = scopeForRecord(constraint.sourceRecordId);
    constraints.push({ ...tagMemoryScope(constraint, scope.memoryScope, scope.originProjectId ?? constraint.projectId, scope.workspaceProjectId ?? constraint.projectId), validationStatus: scope.validationStatus ?? constraint.validationStatus ?? "raw" });
  }
  return {
    entities,
    relations,
    constraints
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
