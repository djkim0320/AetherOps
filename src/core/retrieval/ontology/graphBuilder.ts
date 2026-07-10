import { extractKeywords } from "../chunking.js";
import { createStableId, nowIso } from "../../shared/ids.js";
import type { OntologyConstraint, OntologyEntity, OntologyEntityType, OntologyRelation, OntologyRelationType } from "../../shared/types.js";
import type { OntologyGraphBuildResult } from "./types.js";
import { clamp, mergeEntity, normalizeConcept, uniqueConceptKeywordsLazy } from "./graphAnalysis.js";

export interface EntitySeed {
  type: OntologyEntityType;
  label: string;
  key: string;
  description?: string;
  sourceRecordId?: string;
  sourceEvidenceId?: string;
  confidence: number;
}

export interface RelationSeed {
  subjectId: string;
  predicate: OntologyRelationType;
  objectId: string;
  sourceRecordId?: string;
  sourceEvidenceId?: string;
  confidence: number;
}

export class GraphBuilder {
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
      [this.projectId, seed.subjectId, seed.predicate, seed.objectId, seed.sourceRecordId ?? "", seed.sourceEvidenceId ?? ""].join(":")
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
