import { normalizeMemoryScope, tagMemoryScope } from "../../memory/researchMemory.js";
import type { MemoryScope, NormalizedResearchRecord, OntologyConstraint, OntologyEntity, OntologyRelation, ValidationStatus } from "../../shared/types.js";
import { normalizeConcept } from "./graphAnalysis.js";
import type { OntologyGraphBuildResult } from "./types.js";

export function provenanceIndex(records: NormalizedResearchRecord[]): {
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

export function tagGraphMemoryScope(graph: OntologyGraphBuildResult, records: NormalizedResearchRecord[]): OntologyGraphBuildResult {
  const recordById = new Map<string, NormalizedResearchRecord>();
  for (const record of records) {
    recordById.set(record.id, record);
  }
  const scopeForRecord = (
    sourceRecordId?: string
  ): { memoryScope: MemoryScope; originProjectId?: string; workspaceProjectId?: string; validationStatus?: ValidationStatus } => {
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
    entities.push({
      ...tagMemoryScope(entity, scope.memoryScope, scope.originProjectId ?? entity.projectId, scope.workspaceProjectId ?? entity.projectId),
      validationStatus: scope.validationStatus ?? entity.validationStatus ?? "raw"
    });
  }
  const relations: OntologyRelation[] = [];
  for (const relation of graph.relations) {
    const scope = scopeForRecord(relation.sourceRecordId);
    relations.push({
      ...tagMemoryScope(relation, scope.memoryScope, scope.originProjectId ?? relation.projectId, scope.workspaceProjectId ?? relation.projectId),
      validationStatus: scope.validationStatus ?? relation.validationStatus ?? "raw"
    });
  }
  const constraints: OntologyConstraint[] = [];
  for (const constraint of graph.constraints) {
    const scope = scopeForRecord(constraint.sourceRecordId);
    constraints.push({
      ...tagMemoryScope(constraint, scope.memoryScope, scope.originProjectId ?? constraint.projectId, scope.workspaceProjectId ?? constraint.projectId),
      validationStatus: scope.validationStatus ?? constraint.validationStatus ?? "raw"
    });
  }
  return {
    entities,
    relations,
    constraints
  };
}
