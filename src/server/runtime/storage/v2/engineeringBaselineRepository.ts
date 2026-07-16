import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  analyzeBaselineChange,
  validateConfigurationBaseline,
  type BaselineAspect,
  type ConfigurationBaseline
} from "../../../../core/aerospace/configurationBaseline.js";
import { assertEngineeringPromotion } from "../../../../core/aerospace/engineeringPromotionPolicy.js";
import { StorageImmutableConflictError, StorageOwnershipConflictError, StorageRevisionConflictError } from "./runStateErrors.js";
import { json, optionalString, parseJson, requiredNumber, requiredString, type Row } from "./repositorySupport.js";
import { storageCanonicalHasher } from "./runStatePayloadValidator.js";
import { MAX_TERMINAL_ARTIFACT_BYTES, TerminalCasStore, type StorageTerminalCasClaim, type StorageTerminalCasObject } from "./terminalCasStore.js";
import { createStorageTerminalCasReferenceSource } from "./terminalCasReferences.js";
import { aerodynamicReferenceHash, configurationBaselineContentHash, configurationBaselineDependencyHash } from "./engineeringBaselineIntegrity.js";
import { EngineeringArtifactNotCurrentError } from "./engineeringBaselineTypes.js";
import type {
  StorageActivateEngineeringBaselineInput,
  StorageActivateEngineeringBaselineResult,
  StorageEngineeringArtifactReadInput,
  StorageEngineeringArtifactReadback,
  StorageEngineeringResultPromotion
} from "./engineeringBaselineTypes.js";

const MAX_READ_EXCERPT_BYTES = 64 * 1024;

export class EngineeringBaselineRepository {
  private readonly cas: TerminalCasStore;

  constructor(
    private readonly db: DatabaseSync,
    dataRoot?: string,
    private readonly clock: () => string = () => new Date().toISOString()
  ) {
    this.cas = new TerminalCasStore(dataRoot);
  }

  activate(input: StorageActivateEngineeringBaselineInput): StorageActivateEngineeringBaselineResult {
    const next = input.baseline;
    const changeReason = input.changeReason.trim();
    validateConfigurationBaseline(next);
    if (next.status !== "active" || !changeReason || changeReason.length > 2_000) {
      throw new Error("Baseline activation requires active status and a bounded change reason.");
    }
    if (configurationBaselineContentHash(next) !== next.contentHash) throw new Error("Configuration baseline content hash is invalid.");
    this.assertProject(next.projectId);
    const previous = this.getActive(next.projectId);
    const actualRevision = previous?.revision ?? 0;
    if (previous?.contentHash === next.contentHash) {
      assertExactBaselineReplayRevision(input.expectedRevision, next.revision, previous.revision);
      return { baseline: previous, exactReplay: true, changedAspects: [], stalePromotionIds: [] };
    }
    if (actualRevision !== input.expectedRevision) throw new StorageRevisionConflictError(input.expectedRevision, actualRevision);
    if (next.revision !== actualRevision + 1) throw new StorageRevisionConflictError(actualRevision + 1, next.revision);
    const duplicate = this.db
      .prepare("select id from engineering_configuration_baselines where project_id=? and content_hash=?")
      .get(next.projectId, next.contentHash) as { id?: unknown } | undefined;
    if (duplicate) throw new StorageImmutableConflictError();
    this.db
      .prepare(
        `insert into engineering_configuration_baselines(id,project_id,revision,content_hash,created_at,created_by,change_reason,data)
         values(?,?,?,?,?,?,?,?)`
      )
      .run(next.id, next.projectId, next.revision, next.contentHash, next.createdAt, next.createdBy, changeReason, json(next));
    const changedAspects = previous ? [...analyzeBaselineChange(previous, next, []).changedAspects] : [];
    const stalePromotionIds = previous ? this.markStale(next.projectId, changedAspects, next.createdAt) : [];
    if (previous) {
      this.db
        .prepare(
          `update engineering_active_baselines set baseline_id=?,revision=?,content_hash=?,generation=generation+1,updated_at=?
           where project_id=? and revision=?`
        )
        .run(next.id, next.revision, next.contentHash, next.createdAt, next.projectId, input.expectedRevision);
    } else {
      this.db
        .prepare("insert into engineering_active_baselines(project_id,baseline_id,revision,content_hash,generation,updated_at) values(?,?,?,?,1,?)")
        .run(next.projectId, next.id, next.revision, next.contentHash, next.createdAt);
    }
    const active = this.getActive(next.projectId);
    if (!active || active.id !== next.id || active.contentHash !== next.contentHash) throw new Error("Configuration baseline activation readback failed.");
    return { baseline: active, exactReplay: false, changedAspects, stalePromotionIds };
  }

  get(projectId: string, baselineId: string): ConfigurationBaseline | undefined {
    const row = this.db
      .prepare(
        `select b.*,case when a.baseline_id=b.id then 1 else 0 end active
         from engineering_configuration_baselines b left join engineering_active_baselines a on a.project_id=b.project_id
         where b.project_id=? and b.id=?`
      )
      .get(projectId, baselineId) as Row | undefined;
    return row ? baselineFromRow(row) : undefined;
  }

  getActive(projectId: string): ConfigurationBaseline | undefined {
    const row = this.db
      .prepare(
        `select b.*,1 active from engineering_active_baselines a
         join engineering_configuration_baselines b on b.id=a.baseline_id and b.project_id=a.project_id
         where a.project_id=?`
      )
      .get(projectId) as Row | undefined;
    return row ? baselineFromRow(row) : undefined;
  }

  list(projectId: string, limit = 100): ConfigurationBaseline[] {
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 500)) : 100;
    return (
      this.db
        .prepare(
          `select b.*,case when a.baseline_id=b.id then 1 else 0 end active
           from engineering_configuration_baselines b left join engineering_active_baselines a on a.project_id=b.project_id
           where b.project_id=? order by b.revision desc limit ?`
        )
        .all(projectId, bounded) as Row[]
    ).map(baselineFromRow);
  }

  recordPromotion(value: StorageEngineeringResultPromotion): StorageEngineeringResultPromotion {
    const existing = this.getPromotion(value.projectId, value.id) ?? this.getPromotionByOutputLink(value.outputLinkId);
    if (existing) {
      if (existing.receiptHash !== value.receiptHash || existing.outputLinkId !== value.outputLinkId || existing.projectId !== value.projectId) {
        throw new StorageImmutableConflictError();
      }
      return existing;
    }
    const baseline = this.getActive(value.projectId);
    if (!baseline) throw new Error("The project has no active engineering configuration baseline.");
    assertCurrentPromotion(value, baseline);
    if (engineeringPromotionReceiptHash(value) !== value.receiptHash) throw new Error("Engineering promotion receipt hash is invalid.");
    this.cas.verify(
      { casLocator: value.artifact.casLocator, casHash: value.artifact.sha256, byteLength: value.artifact.byteLength },
      MAX_TERMINAL_ARTIFACT_BYTES
    );
    this.db
      .prepare(
        `insert into engineering_result_promotions
          (id,schema_version,project_id,job_id,attempt_id,output_link_id,output_id,result_kind,baseline_id,baseline_revision,
           baseline_content_hash,baseline_dependency_hash,dependency_aspects,geometry_hash,artifact_hash,artifact_bytes,media_type,cas_locator,
           tool_name,tool_version,execution_media,tool_receipt_hash,reference_geometry_hash,convergence,domain_assessment,postcondition,
           postcondition_receipt_hash,sensitivity,promoted_at,receipt_hash,data)
         values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        value.id,
        value.schemaVersion,
        value.projectId,
        value.jobId,
        value.attemptId,
        value.outputLinkId,
        value.outputId,
        value.resultKind,
        value.baselineId,
        value.baselineRevision,
        value.baselineContentHash,
        value.baselineDependencyHash,
        json(value.dependencyAspects),
        value.geometryHash ?? null,
        value.artifact.sha256,
        value.artifact.byteLength,
        value.artifact.mediaType,
        value.artifact.casLocator,
        value.tool.name,
        value.tool.version,
        value.tool.executionMedia,
        value.tool.receiptHash,
        value.referenceGeometry?.contentHash ?? null,
        value.convergence,
        value.domainAssessment,
        value.postcondition,
        value.postconditionReceiptHash ?? null,
        value.sensitivity,
        value.promotedAt,
        value.receiptHash,
        json(withoutStale(value))
      );
    return this.requiredPromotion(value.projectId, value.id);
  }

  getPromotion(projectId: string, promotionId: string): StorageEngineeringResultPromotion | undefined {
    const row = this.db.prepare("select * from engineering_result_promotions where project_id=? and id=?").get(projectId, promotionId) as Row | undefined;
    return row ? promotionFromRow(row) : undefined;
  }

  listPromotionsForJob(jobId: string, limit = 200): StorageEngineeringResultPromotion[] {
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 200)) : 200;
    return (this.db.prepare("select * from engineering_result_promotions where job_id=? order by promoted_at,id limit ?").all(jobId, bounded) as Row[]).map(
      promotionFromRow
    );
  }

  readArtifact(input: StorageEngineeringArtifactReadInput): StorageEngineeringArtifactReadback {
    const promotion = this.requiredPromotion(input.projectId, input.promotionId);
    if (promotion.staleAt) throw new EngineeringArtifactNotCurrentError("A stale engineering result cannot be read as a current artifact.");
    const active = this.getActive(input.projectId);
    if (!active) {
      throw new EngineeringArtifactNotCurrentError("Engineering artifact no longer matches the active configuration baseline.");
    }
    assertCurrentPromotion(promotion, active, true);
    const maximumBytes = input.maximumBytes ?? MAX_READ_EXCERPT_BYTES;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_READ_EXCERPT_BYTES) {
      throw new Error("Engineering artifact excerpt limit is invalid.");
    }
    const excerpt = this.cas.readVerifiedExcerpt(
      { casLocator: promotion.artifact.casLocator, casHash: promotion.artifact.sha256, byteLength: promotion.artifact.byteLength },
      maximumBytes
    );
    const readAt = this.clock();
    const receiptBody = {
      projectId: input.projectId,
      promotionId: promotion.id,
      artifactHash: promotion.artifact.sha256,
      byteLength: promotion.artifact.byteLength,
      complete: excerpt.complete,
      readerVersion: "engineering-artifact-readback-v1",
      readAt
    };
    const readReceiptHash = storageCanonicalHasher.sha256Canonical(receiptBody);
    const id = `engineering-read-${randomUUID()}`;
    this.db
      .prepare(
        `insert into engineering_artifact_read_receipts
          (id,project_id,promotion_id,artifact_hash,byte_length,complete,reader_version,read_at,receipt_hash)
         values(?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        input.projectId,
        promotion.id,
        promotion.artifact.sha256,
        promotion.artifact.byteLength,
        excerpt.complete ? 1 : 0,
        receiptBody.readerVersion,
        readAt,
        readReceiptHash
      );
    const persistedReceipt = this.db
      .prepare(
        "select project_id,promotion_id,artifact_hash,byte_length,complete,reader_version,read_at,receipt_hash from engineering_artifact_read_receipts where id=?"
      )
      .get(id) as Row | undefined;
    if (
      persistedReceipt?.project_id !== input.projectId ||
      persistedReceipt.promotion_id !== promotion.id ||
      persistedReceipt.artifact_hash !== promotion.artifact.sha256 ||
      persistedReceipt.byte_length !== promotion.artifact.byteLength ||
      persistedReceipt.complete !== (excerpt.complete ? 1 : 0) ||
      persistedReceipt.reader_version !== receiptBody.readerVersion ||
      persistedReceipt.read_at !== readAt ||
      persistedReceipt.receipt_hash !== readReceiptHash
    ) {
      throw new Error("Engineering artifact read receipt persistence verification failed.");
    }
    return {
      promotion,
      artifactUri: `artifact://${promotion.id}`,
      excerptBase64: Buffer.from(excerpt.bytes).toString("base64"),
      excerptBytes: excerpt.bytes.byteLength,
      complete: excerpt.complete,
      readAt,
      readReceiptHash
    };
  }

  finalizePromotions(values: readonly StorageEngineeringResultPromotion[]): void {
    this.finalizeCasObjects(
      values.map((value) => ({ casLocator: value.artifact.casLocator, casHash: value.artifact.sha256, byteLength: value.artifact.byteLength }))
    );
  }

  finalizeCasObjects(objects: readonly StorageTerminalCasObject[]): void {
    this.cas.finalize(objects);
  }

  verifyCasObjects(objects: readonly StorageTerminalCasObject[]): void {
    for (const object of objects) this.cas.verify(object);
  }

  finalizeCasClaims(claims: readonly StorageTerminalCasClaim[]): void {
    this.cas.finalizeClaims(claims);
  }

  abortCasClaims(claims: readonly StorageTerminalCasClaim[]) {
    return this.cas.abort(claims, createStorageTerminalCasReferenceSource(this.db));
  }

  commitCasClaims<T>(claims: readonly StorageTerminalCasClaim[], work: () => { result: T; disposition: "finalize" | "abort" }, allowDurableReplay = false) {
    return this.cas.commitClaims(claims, createStorageTerminalCasReferenceSource(this.db), work, allowDurableReplay);
  }

  private getPromotionByOutputLink(outputLinkId: string): StorageEngineeringResultPromotion | undefined {
    const row = this.db.prepare("select * from engineering_result_promotions where output_link_id=?").get(outputLinkId) as Row | undefined;
    return row ? promotionFromRow(row) : undefined;
  }

  private requiredPromotion(projectId: string, promotionId: string): StorageEngineeringResultPromotion {
    const value = this.getPromotion(projectId, promotionId);
    if (!value) throw new StorageOwnershipConflictError();
    return value;
  }

  private assertProject(projectId: string): void {
    if (!this.db.prepare("select 1 present from projects_v2 where id=?").get(projectId)) throw new StorageOwnershipConflictError();
  }

  private markStale(projectId: string, changed: readonly BaselineAspect[], staleAt: string): string[] {
    if (!changed.length) return [];
    const rows = this.db
      .prepare("select id,dependency_aspects from engineering_result_promotions where project_id=? and stale_at is null order by id")
      .all(projectId) as Array<{ id?: unknown; dependency_aspects?: unknown }>;
    const changedSet = new Set(changed);
    const selected = rows.filter((row) => dependencyAspects(row.dependency_aspects).some((aspect) => changedSet.has(aspect)));
    const reason = `baseline_changed:${[...changed].sort().join(",")}`;
    const update = this.db.prepare("update engineering_result_promotions set stale_at=?,stale_reason=? where id=? and stale_at is null");
    for (const row of selected) update.run(staleAt, reason, String(row.id));
    return selected.map((row) => String(row.id));
  }
}

function assertExactBaselineReplayRevision(expectedRevision: number, incomingRevision: number, storedRevision: number): void {
  const originalRequestRevision = storedRevision - 1;
  if (expectedRevision !== originalRequestRevision && expectedRevision !== storedRevision) {
    throw new StorageRevisionConflictError(expectedRevision, storedRevision);
  }
  const requiredIncomingRevision = expectedRevision === originalRequestRevision ? storedRevision : storedRevision + 1;
  if (incomingRevision !== requiredIncomingRevision) {
    throw new StorageRevisionConflictError(requiredIncomingRevision, incomingRevision);
  }
}

export function engineeringPromotionReceiptHash(value: StorageEngineeringResultPromotion): string {
  return storageCanonicalHasher.sha256Canonical(withoutReceiptAndStale(value));
}

function assertCurrentPromotion(value: StorageEngineeringResultPromotion, baseline: ConfigurationBaseline, allowCompatibleBaselineRevision = false): void {
  const referenceHash = aerodynamicReferenceHash(baseline);
  assertEngineeringPromotion(value, {
    projectId: value.projectId,
    activeBaseline: baseline,
    expectedBaselineDependencyHash: configurationBaselineDependencyHash(baseline, value.dependencyAspects),
    allowCompatibleBaselineRevision,
    ...(referenceHash ? { expectedReferenceGeometryHash: referenceHash } : {})
  });
}

function baselineFromRow(row: Row): ConfigurationBaseline {
  const stored = parseJson(row.data) as ConfigurationBaseline;
  const value: ConfigurationBaseline = {
    ...stored,
    id: requiredString(row.id, "engineering baseline id"),
    projectId: requiredString(row.project_id, "engineering baseline project"),
    revision: requiredNumber(row.revision, "engineering baseline revision"),
    contentHash: requiredString(row.content_hash, "engineering baseline content hash"),
    createdAt: requiredString(row.created_at, "engineering baseline timestamp"),
    createdBy: requiredString(row.created_by, "engineering baseline actor"),
    status: Number(row.active) === 1 ? "active" : "superseded"
  };
  validateConfigurationBaseline(value);
  if (configurationBaselineContentHash(value) !== value.contentHash) throw new Error("Persisted configuration baseline content hash is invalid.");
  return value;
}

function promotionFromRow(row: Row): StorageEngineeringResultPromotion {
  const stored = parseJson(row.data) as StorageEngineeringResultPromotion;
  const value = {
    ...stored,
    id: requiredString(row.id, "engineering promotion id"),
    receiptHash: requiredString(row.receipt_hash, "engineering promotion receipt hash"),
    staleAt: optionalString(row.stale_at),
    staleReason: optionalString(row.stale_reason)
  };
  if (engineeringPromotionReceiptHash(value) !== value.receiptHash) throw new Error("Persisted engineering promotion receipt hash is invalid.");
  return value;
}

function dependencyAspects(value: unknown): BaselineAspect[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("Persisted engineering dependency aspects are invalid.");
  return parsed as BaselineAspect[];
}

function withoutStale(value: StorageEngineeringResultPromotion): StorageEngineeringResultPromotion {
  const { staleAt, staleReason, ...stored } = value;
  void staleAt;
  void staleReason;
  return stored;
}

function withoutReceiptAndStale(value: StorageEngineeringResultPromotion): Omit<StorageEngineeringResultPromotion, "receiptHash" | "staleAt" | "staleReason"> {
  const { receiptHash, staleAt, staleReason, ...body } = value;
  void receiptHash;
  void staleAt;
  void staleReason;
  return body;
}
