import {
  assertColumnsForInspection,
  assertForeignKeysForInspection,
  assertIndexesForInspection,
  assertTriggersForInspection,
  tableExists
} from "./operationalSchemaInspection.mjs";
import { stableJsonHash, stableStringify } from "./hash.mjs";

export const ENGINEERING_BASELINE_TABLES = [
  "engineering_configuration_baselines",
  "engineering_active_baselines",
  "engineering_result_promotions",
  "engineering_artifact_read_receipts"
];

export const ENGINEERING_BASELINE_COLUMNS = {
  engineering_configuration_baselines: ["id", "project_id", "revision", "content_hash", "created_at", "created_by", "change_reason", "data"],
  engineering_active_baselines: ["project_id", "baseline_id", "revision", "content_hash", "generation", "updated_at"],
  engineering_result_promotions: [
    "id",
    "project_id",
    "job_id",
    "attempt_id",
    "output_link_id",
    "result_kind",
    "baseline_id",
    "baseline_revision",
    "baseline_content_hash",
    "baseline_dependency_hash",
    "artifact_hash",
    "artifact_bytes",
    "media_type",
    "cas_locator",
    "tool_name",
    "tool_version",
    "execution_media",
    "reference_geometry_hash",
    "stale_at",
    "receipt_hash",
    "data"
  ],
  engineering_artifact_read_receipts: [
    "id",
    "project_id",
    "promotion_id",
    "artifact_hash",
    "byte_length",
    "complete",
    "reader_version",
    "read_at",
    "receipt_hash"
  ]
};

export const ENGINEERING_BASELINE_INDEXES = {
  engineering_configuration_baselines: ["idx_engineering_baselines_project_revision"],
  engineering_result_promotions: ["idx_engineering_promotions_project_baseline", "idx_engineering_promotions_job"],
  engineering_artifact_read_receipts: ["idx_engineering_reads_promotion"]
};

export const ENGINEERING_BASELINE_FOREIGN_KEYS = {
  engineering_configuration_baselines: ["projects_v2"],
  engineering_active_baselines: ["projects_v2", "engineering_configuration_baselines"],
  engineering_result_promotions: ["projects_v2", "jobs", "tool_attempts", "tool_output_links", "engineering_configuration_baselines"],
  engineering_artifact_read_receipts: ["projects_v2", "engineering_result_promotions"]
};

export const ENGINEERING_BASELINE_TRIGGERS = [
  "trg_engineering_baselines_revision_insert",
  "trg_engineering_baselines_no_update",
  "trg_engineering_baselines_no_delete",
  "trg_engineering_active_baseline_insert",
  "trg_engineering_active_baseline_update",
  "trg_engineering_active_baseline_no_delete",
  "trg_engineering_promotions_owner_insert",
  "trg_engineering_promotions_stale_only",
  "trg_engineering_promotions_no_delete",
  "trg_engineering_reads_owner_insert",
  "trg_engineering_reads_no_update",
  "trg_engineering_reads_no_delete"
];

export function inspectEngineeringBaselineSchema(db, errors) {
  for (const table of ENGINEERING_BASELINE_TABLES) if (!tableExists(db, table)) errors.push(`Operational table is missing: ${table}`);
  for (const [table, columns] of Object.entries(ENGINEERING_BASELINE_COLUMNS)) assertColumnsForInspection(db, table, columns, errors);
  for (const [table, indexes] of Object.entries(ENGINEERING_BASELINE_INDEXES)) assertIndexesForInspection(db, table, indexes, errors);
  for (const [table, targets] of Object.entries(ENGINEERING_BASELINE_FOREIGN_KEYS)) assertForeignKeysForInspection(db, table, targets, errors);
  assertTriggersForInspection(db, ENGINEERING_BASELINE_TRIGGERS, errors);
  if (ENGINEERING_BASELINE_TABLES.every((table) => tableExists(db, table))) inspectEngineeringBaselineSemantics(db, errors);
}

function inspectEngineeringBaselineSemantics(db, errors) {
  const baselines = new Map();
  const projectRevisions = new Map();
  for (const row of db.prepare("select * from engineering_configuration_baselines order by project_id,revision,id").all()) {
    const data = parseObject(row.data, `engineering baseline ${row.id}`, errors);
    if (!data) continue;
    const identityMatches =
      data.id === row.id &&
      data.projectId === row.project_id &&
      data.revision === row.revision &&
      data.contentHash === row.content_hash &&
      data.createdAt === row.created_at &&
      data.createdBy === row.created_by;
    if (!identityMatches) errors.push(`Engineering baseline row/data identity mismatch: ${row.id}`);
    if (!String(row.change_reason ?? "").trim()) errors.push(`Engineering baseline change reason is missing: ${row.id}`);
    if (stableJsonHash(baselineContent(data)) !== row.content_hash) errors.push(`Engineering baseline content hash mismatch: ${row.id}`);
    baselines.set(String(row.id), { row, data });
    const revisions = projectRevisions.get(String(row.project_id)) ?? [];
    revisions.push(Number(row.revision));
    projectRevisions.set(String(row.project_id), revisions);
  }
  for (const [projectId, revisions] of projectRevisions) {
    if (revisions.some((revision, index) => revision !== index + 1)) errors.push(`Engineering baseline revisions are not contiguous: ${projectId}`);
  }

  const activeProjects = new Set();
  for (const row of db.prepare("select * from engineering_active_baselines order by project_id").all()) {
    const projectId = String(row.project_id);
    activeProjects.add(projectId);
    const baseline = baselines.get(String(row.baseline_id));
    if (!baseline || baseline.row.project_id !== row.project_id || baseline.row.revision !== row.revision || baseline.row.content_hash !== row.content_hash) {
      errors.push(`Active engineering baseline pointer is inconsistent: ${projectId}`);
      continue;
    }
    const revisions = projectRevisions.get(projectId) ?? [];
    if (Number(row.revision) !== revisions.at(-1)) errors.push(`Active engineering baseline is not the latest revision: ${projectId}`);
    if (!Number.isSafeInteger(Number(row.generation)) || Number(row.generation) !== Number(row.revision)) {
      errors.push(`Active engineering baseline generation is inconsistent: ${projectId}`);
    }
  }
  for (const projectId of projectRevisions.keys()) {
    if (!activeProjects.has(projectId)) errors.push(`Engineering baseline history has no active pointer: ${projectId}`);
  }

  const promotions = new Map();
  for (const row of db.prepare("select * from engineering_result_promotions order by project_id,id").all()) {
    const data = parseObject(row.data, `engineering promotion ${row.id}`, errors);
    if (!data) continue;
    const baseline = baselines.get(String(row.baseline_id));
    if (!baseline) {
      errors.push(`Engineering promotion baseline is missing: ${row.id}`);
      continue;
    }
    const aspects = parseArray(row.dependency_aspects, `engineering promotion dependencies ${row.id}`, errors);
    if (!aspects) continue;
    const identityMatches =
      data.id === row.id &&
      data.projectId === row.project_id &&
      data.jobId === row.job_id &&
      data.attemptId === row.attempt_id &&
      data.outputLinkId === row.output_link_id &&
      data.outputId === row.output_id &&
      data.resultKind === row.result_kind &&
      data.baselineId === row.baseline_id &&
      data.baselineRevision === row.baseline_revision &&
      data.baselineContentHash === row.baseline_content_hash &&
      data.baselineDependencyHash === row.baseline_dependency_hash &&
      stableStringify(data.dependencyAspects) === stableStringify(aspects) &&
      optional(data.geometryHash) === optional(row.geometry_hash) &&
      data.artifact?.sha256 === row.artifact_hash &&
      data.artifact?.byteLength === row.artifact_bytes &&
      data.artifact?.mediaType === row.media_type &&
      data.artifact?.casLocator === row.cas_locator &&
      data.tool?.name === row.tool_name &&
      data.tool?.version === row.tool_version &&
      data.tool?.executionMedia === row.execution_media &&
      data.tool?.receiptHash === row.tool_receipt_hash &&
      optional(data.referenceGeometry?.contentHash) === optional(row.reference_geometry_hash) &&
      data.convergence === row.convergence &&
      data.domainAssessment === row.domain_assessment &&
      data.postcondition === row.postcondition &&
      optional(data.postconditionReceiptHash) === optional(row.postcondition_receipt_hash) &&
      data.sensitivity === row.sensitivity &&
      data.promotedAt === row.promoted_at &&
      data.receiptHash === row.receipt_hash;
    if (!identityMatches) errors.push(`Engineering promotion row/data identity mismatch: ${row.id}`);
    if (
      baseline.row.project_id !== row.project_id ||
      baseline.row.revision !== row.baseline_revision ||
      baseline.row.content_hash !== row.baseline_content_hash
    ) {
      errors.push(`Engineering promotion baseline ownership mismatch: ${row.id}`);
    }
    if (baselineDependencyHash(baseline.data, aspects) !== row.baseline_dependency_hash) {
      errors.push(`Engineering promotion dependency hash mismatch: ${row.id}`);
    }
    const expectedReference = baseline.data.aerodynamicReference ? stableJsonHash(baseline.data.aerodynamicReference) : undefined;
    if (optional(row.reference_geometry_hash) !== optional(expectedReference)) {
      errors.push(`Engineering promotion reference geometry mismatch: ${row.id}`);
    }
    const { receiptHash, staleAt, staleReason, ...receiptBody } = data;
    void staleAt;
    void staleReason;
    if (stableJsonHash(receiptBody) !== row.receipt_hash || receiptHash !== row.receipt_hash) {
      errors.push(`Engineering promotion receipt hash mismatch: ${row.id}`);
    }
    if ((row.stale_at === null) !== (row.stale_reason === null)) errors.push(`Engineering promotion stale state is incomplete: ${row.id}`);
    promotions.set(String(row.id), row);
  }

  for (const row of db.prepare("select * from engineering_artifact_read_receipts order by project_id,id").all()) {
    const promotion = promotions.get(String(row.promotion_id));
    if (
      !promotion ||
      promotion.project_id !== row.project_id ||
      promotion.artifact_hash !== row.artifact_hash ||
      promotion.artifact_bytes !== row.byte_length
    ) {
      errors.push(`Engineering artifact read ownership mismatch: ${row.id}`);
    }
    const receipt = {
      projectId: row.project_id,
      promotionId: row.promotion_id,
      artifactHash: row.artifact_hash,
      byteLength: row.byte_length,
      complete: Number(row.complete) === 1,
      readerVersion: row.reader_version,
      readAt: row.read_at
    };
    if (stableJsonHash(receipt) !== row.receipt_hash) errors.push(`Engineering artifact read receipt hash mismatch: ${row.id}`);
  }
}

function baselineContent(value) {
  return {
    ...(value.geometryHash ? { geometryHash: value.geometryHash } : {}),
    ...(value.airfoilGeometryHash ? { airfoilGeometryHash: value.airfoilGeometryHash } : {}),
    ...(value.aerodynamicReference ? { aerodynamicReference: value.aerodynamicReference } : {}),
    ...(value.massProperties ? { massProperties: value.massProperties } : {}),
    ...(value.massPropertiesHash ? { massPropertiesHash: value.massPropertiesHash } : {}),
    ...(value.atmosphereModelId ? { atmosphereModelId: value.atmosphereModelId } : {}),
    ...(value.propulsionModelId ? { propulsionModelId: value.propulsionModelId } : {}),
    unitConventionId: value.unitConventionId,
    coordinateConventionId: value.coordinateConventionId,
    solverVersions: Object.fromEntries(Object.entries(value.solverVersions ?? {}).sort(([left], [right]) => left.localeCompare(right))),
    materialRevisionIds: [...(value.materialRevisionIds ?? [])].sort(),
    sourceRevisionIds: [...(value.sourceRevisionIds ?? [])].sort(),
    equationVersionIds: [...(value.equationVersionIds ?? [])].sort(),
    provenance: [...(value.provenance ?? [])]
      .map((entry) => ({ id: entry.id, ...(entry.contentHash ? { contentHash: entry.contentHash } : {}) }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)) || String(left.contentHash ?? "").localeCompare(String(right.contentHash ?? "")))
  };
}

function baselineDependencyHash(baseline, aspects) {
  return stableJsonHash({
    projectId: baseline.projectId,
    aspects: Object.fromEntries([...new Set(aspects)].sort().map((aspect) => [aspect, baselineAspectValue(baseline, aspect)]))
  });
}

function baselineAspectValue(value, aspect) {
  const values = {
    geometry: value.geometryHash ?? null,
    airfoil_geometry: value.airfoilGeometryHash ?? null,
    aerodynamic_reference: value.aerodynamicReference ?? null,
    mass_properties: { value: value.massProperties ?? null, hash: value.massPropertiesHash ?? null },
    atmosphere: value.atmosphereModelId ?? null,
    propulsion: value.propulsionModelId ?? null,
    unit_convention: value.unitConventionId,
    coordinate_convention: value.coordinateConventionId,
    solver: Object.fromEntries(Object.entries(value.solverVersions ?? {}).sort(([left], [right]) => left.localeCompare(right))),
    material: [...(value.materialRevisionIds ?? [])].sort(),
    source_revision: {
      ids: [...(value.sourceRevisionIds ?? [])].sort(),
      provenance: baselineContent(value).provenance
    },
    equation: [...(value.equationVersionIds ?? [])].sort()
  };
  return Object.hasOwn(values, aspect) ? values[aspect] : { invalidAspect: aspect };
}

function parseObject(value, label, errors) {
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    errors.push(`Persisted ${label} JSON is invalid.`);
    return undefined;
  }
}

function parseArray(value, label, errors) {
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("not a string array");
    return parsed;
  } catch {
    errors.push(`Persisted ${label} JSON is invalid.`);
    return undefined;
  }
}

function optional(value) {
  return value === null || value === undefined ? undefined : value;
}
