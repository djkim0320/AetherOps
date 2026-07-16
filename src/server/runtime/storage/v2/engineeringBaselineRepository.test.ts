import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AREA, LENGTH } from "../../../../core/aerospace/dimensions.js";
import type { ConfigurationBaseline } from "../../../../core/aerospace/configurationBaseline.js";
import type { EngineeringQuantity } from "../../../../core/aerospace/quantity.js";
import { configurationBaselineContentHash, configurationBaselineDependencyHash, aerodynamicReferenceHash } from "./engineeringBaselineIntegrity.js";
import { engineeringPromotionReceiptHash } from "./engineeringBaselineRepository.js";
import {
  assertStorageEngineeringBaselineV12SchemaReady,
  migrateStorageEngineeringBaselineV12Schema,
  STORAGE_ENGINEERING_BASELINE_MIGRATION_CHECKSUM,
  STORAGE_ENGINEERING_BASELINE_MIGRATION_NAME,
  STORAGE_ENGINEERING_BASELINE_SCHEMA_VERSION
} from "./engineeringBaselineSchema.js";
import type { StorageEngineeringResultPromotion } from "./engineeringBaselineTypes.js";
import type { StorageTerminalTransitionResult } from "./jobAtomicTypes.js";
import { createStorageV2Repositories, type StorageV2RepositorySet } from "./repositories.js";
import { StorageRevisionConflictError } from "./runStateErrors.js";
import { migrateStorageV2Schema } from "./schema.js";
import { TerminalCasJournal } from "./terminalCasJournal.js";
import { TerminalCasStore } from "./terminalCasStore.js";
import type { StorageTerminalCasObject } from "./terminalCasTypes.js";
import { computeToolPostconditionReceiptHash } from "./toolPostcondition.js";
import { StorageWorkerRuntime } from "../worker/typedRuntime.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // Individual tests may already have closed their restart boundary.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("engineering baseline and artifact repository", () => {
  it("installs checksum-bound v12 objects idempotently and detects ledger or trigger drift", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateStorageV2Schema(db);
      const before = schemaSql(db);
      migrateStorageEngineeringBaselineV12Schema(db);
      expect(schemaSql(db)).toEqual(before);
      expect(db.prepare("select name,checksum_sha256 from schema_migrations where version=?").get(STORAGE_ENGINEERING_BASELINE_SCHEMA_VERSION)).toEqual({
        name: STORAGE_ENGINEERING_BASELINE_MIGRATION_NAME,
        checksum_sha256: STORAGE_ENGINEERING_BASELINE_MIGRATION_CHECKSUM
      });
      db.exec("drop trigger trg_engineering_reads_owner_insert");
      expect(() => assertStorageEngineeringBaselineV12SchemaReady(db)).toThrow(/trigger is missing/i);
    } finally {
      db.close();
    }
  });

  it("binds the v12 checksum to normalized install SQL", () => {
    const source = readFileSync(new URL("./engineeringBaselineSchema.ts", import.meta.url), "utf8");
    const anchor = source.indexOf("function installStorageEngineeringBaselineV12Objects");
    const marker = "db.exec(`";
    const start = source.indexOf(marker, anchor) + marker.length;
    const end = source.indexOf("`);", start);
    const normalized = source
      .slice(start, end)
      .replace(
        /values \(12, 'operational-engineering-baselines-v12', '[a-f0-9]{64}', datetime\('now'\)\)/,
        "values (12, 'operational-engineering-baselines-v12', '<checksum>', datetime('now'))"
      );
    expect(sha256(normalized)).toBe(STORAGE_ENGINEERING_BASELINE_MIGRATION_CHECKSUM);
  });

  it("returns the active baseline for a lost-response semantic replay without creating a duplicate revision", () => {
    const harness = createHarness("activation-replay");
    const active = harness.repositories.engineering.getActive(harness.projectId)!;
    const replay = { ...active, id: "retry-id", createdAt: "2026-07-16T00:01:00.000Z" };

    const result = harness.repositories.engineering.activate({
      baseline: replay,
      expectedRevision: 0,
      changeReason: "Retry after the original activation response was lost."
    });

    expect(result).toMatchObject({ exactReplay: true, baseline: { id: active.id, revision: 1 }, changedAspects: [], stalePromotionIds: [] });
    expect(harness.db.prepare("select count(*) count from engineering_configuration_baselines where project_id=?").get(harness.projectId)).toEqual({
      count: 1
    });
    harness.db.close();
  });

  it("accepts only original-request or current-state baseline revisions for exact content replay", () => {
    const harness = createHarness("activation-replay-revisions");
    const active = harness.repositories.engineering.getActive(harness.projectId)!;
    const currentNoOp = { ...active, id: "current-no-op", revision: 2, createdAt: "2026-07-16T00:02:00.000Z" };
    const activate = (baseline: ConfigurationBaseline, expectedRevision: number) =>
      harness.repositories.engineering.activate({
        baseline,
        expectedRevision,
        changeReason: "Validate exact-content optimistic revision handling."
      });
    expect(activate(currentNoOp, 1)).toMatchObject({ exactReplay: true, baseline: { id: active.id, revision: 1 } });
    expect(() => activate({ ...currentNoOp, revision: 1_000 }, 999)).toThrow(StorageRevisionConflictError);
    expect(() => activate({ ...currentNoOp, revision: 2 }, 0)).toThrow(StorageRevisionConflictError);
    expect(harness.db.prepare("select count(*) count from engineering_configuration_baselines").get()).toEqual({
      count: 1
    });
    harness.db.close();
  });

  it("persists a baseline-bound polar and verifies bounded artifact readback after restart", () => {
    const harness = createHarness("restart-readback");
    const promotion = harness.repositories.engineering.recordPromotion(harness.promotion);
    harness.repositories.engineering.finalizePromotions([promotion]);
    const first = harness.repositories.engineering.readArtifact({ projectId: harness.projectId, promotionId: promotion.id, maximumBytes: 7 });
    expect(Buffer.from(first.excerptBase64, "base64").toString("utf8")).toBe('{"rows"');
    expect(first).toMatchObject({ excerptBytes: 7, complete: false, readReceiptHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    harness.db.close();

    const reopened = new DatabaseSync(harness.dbPath);
    try {
      const repositories = createStorageV2Repositories({ appDb: reopened }, { dataRoot: harness.root });
      const readback = repositories.engineering.readArtifact({ projectId: harness.projectId, promotionId: promotion.id, maximumBytes: 65_536 });
      expect(Buffer.from(readback.excerptBase64, "base64").toString("utf8")).toBe(harness.content);
      expect(readback).toMatchObject({ artifactUri: `artifact://${promotion.id}`, complete: true, promotion: { receiptHash: promotion.receiptHash } });
      expect(reopened.prepare("select count(*) count from engineering_artifact_read_receipts where promotion_id=?").get(promotion.id)).toEqual({ count: 2 });
    } finally {
      reopened.close();
    }
  });

  it("reconciles a post-commit CAS journal against durable promotion receipts on restart", () => {
    const harness = createHarness("restart-journal-reconcile");
    const promotion = harness.repositories.engineering.recordPromotion(harness.promotion);
    const journal = join(harness.root, "migration", "v2", "terminal-cas", "journal", `${promotion.artifact.sha256}.pending`);
    expect(existsSync(journal)).toBe(true);
    harness.db.close();

    const reopened = new DatabaseSync(harness.dbPath);
    try {
      createStorageV2Repositories({ appDb: reopened }, { dataRoot: harness.root });
      expect(existsSync(journal)).toBe(false);
      expect(reopened.prepare("select id from engineering_result_promotions where id=?").get(promotion.id)).toEqual({ id: promotion.id });
    } finally {
      reopened.close();
    }
  });

  it("returns committed terminal events with a reconciliation warning when CAS finalization fails", () => {
    const harness = createHarness("terminal-finalize-warning");
    harness.repositories.engineering.recordPromotion(harness.promotion);
    harness.db.close();
    const worker = new StorageWorkerRuntime(
      { appDbPath: harness.dbPath, vectorDbPath: harness.dbPath, ontologyDbPath: harness.dbPath, dataRoot: harness.root },
      { leaseClock: () => Date.parse("2026-07-16T00:00:05.000Z") }
    );
    const claimed = worker.handle({
      name: "job.claimAndStart",
      options: {
        projectId: harness.projectId,
        leaseOwner: "worker-terminal-finalize-warning",
        leaseExpiresAt: "2026-07-16T00:02:00.000Z",
        now: "2026-07-16T00:00:05.000Z"
      }
    }) as { fence: { jobId: string; attempt: number; leaseOwner: string; leaseGeneration: number } };
    const pendingCasObject = new TerminalCasStore(harness.root).materializeClaimedBytes(Buffer.from(harness.content, "utf8"), {
      projectId: harness.projectId,
      jobId: harness.promotion.jobId,
      attemptId: harness.promotion.attemptId,
      outputKind: "artifact",
      outputId: harness.promotion.outputId
    });
    const journal = join(harness.root, "migration", "v2", "terminal-cas", "journal", `${pendingCasObject.casHash}.${pendingCasObject.pendingClaimId}.pending`);
    const input = terminalPromotionInput(harness, claimed.fence, pendingCasObject);
    const finalize = vi.spyOn(TerminalCasJournal.prototype, "removeAuthorized").mockImplementationOnce(() => {
      throw new Error("injected post-commit CAS finalize failure");
    });

    try {
      const result = worker.handle({ name: "job.transitionTerminal", input }) as StorageTerminalTransitionResult;

      expect(result.events.map((event) => event.type)).toEqual(["artifact.created", "run.status.changed", "project.snapshot.changed"]);
      expect(result.postCommitWarnings).toEqual([
        {
          code: "ENGINEERING_CAS_FINALIZE_DEFERRED",
          operation: "engineering_cas_finalize",
          severity: "warning",
          message: "Engineering CAS journal finalization was deferred to durable startup reconciliation.",
          affectedObjectCount: 1
        }
      ]);
      expect(existsSync(journal)).toBe(true);
      const readback = new DatabaseSync(harness.dbPath, { readOnly: true });
      try {
        expect(readback.prepare("select status from jobs where id=?").get(harness.promotion.jobId)).toEqual({ status: "completed" });
        expect(readback.prepare("select count(*) count from engineering_result_promotions where id=?").get(harness.promotion.id)).toEqual({ count: 1 });
        expect(readback.prepare("select type from job_events where job_id=? order by sequence").all(harness.promotion.jobId)).toEqual([
          { type: "run.status.changed" },
          { type: "artifact.created" },
          { type: "run.status.changed" },
          { type: "project.snapshot.changed" }
        ]);
      } finally {
        readback.close();
      }

      finalize.mockRestore();
      const replay = worker.handle({ name: "job.transitionTerminal", input }) as StorageTerminalTransitionResult;
      expect(replay.postCommitWarnings).toBeUndefined();
      expect(replay.events).toEqual(result.events);
      expect(existsSync(journal)).toBe(false);
      const responseLossReplay = worker.handle({ name: "job.transitionTerminal", input }) as StorageTerminalTransitionResult;
      expect(responseLossReplay.postCommitWarnings).toBeUndefined();
      expect(responseLossReplay.events).toEqual(result.events);
      const forgedReplay = {
        ...input,
        promotions: input.promotions.map((promotion) => ({
          ...promotion,
          link: { ...promotion.link, outputId: "artifact-forged-replay-owner" }
        }))
      };
      expect(() => worker.handle({ name: "job.transitionTerminal", input: forgedReplay })).toThrow(/does not match durable output/i);
    } finally {
      finalize.mockRestore();
      worker.close();
    }
  });

  it("fails closed for tampering, cross-project reads, oversized excerpts, and direct read-owner corruption", () => {
    const harness = createHarness("readback-rejections");
    const promotion = harness.repositories.engineering.recordPromotion(harness.promotion);
    harness.repositories.engineering.finalizePromotions([promotion]);
    expect(() => harness.repositories.engineering.readArtifact({ projectId: "another-project", promotionId: promotion.id, maximumBytes: 32 })).toThrow();
    expect(() => harness.repositories.engineering.readArtifact({ projectId: harness.projectId, promotionId: promotion.id, maximumBytes: 65_537 })).toThrow(
      /limit/i
    );
    expect(() =>
      harness.db
        .prepare(
          `insert into engineering_artifact_read_receipts
           (id,project_id,promotion_id,artifact_hash,byte_length,complete,reader_version,read_at,receipt_hash)
           values (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          "forged-read",
          "another-project",
          promotion.id,
          promotion.artifact.sha256,
          promotion.artifact.byteLength,
          1,
          "forged",
          new Date().toISOString(),
          sha256("forged")
        )
    ).toThrow(/owner is unavailable/i);

    const artifactPath = join(harness.root, "migration", "v2", ...promotion.artifact.casLocator.split("/"));
    if (process.platform !== "win32") chmodSync(artifactPath, 0o600);
    writeFileSync(artifactPath, "tampered", "utf8");
    expect(() => harness.repositories.engineering.readArtifact({ projectId: harness.projectId, promotionId: promotion.id })).toThrow(/attestation|readback/i);
    harness.db.close();
  });

  it("rejects stale baselines, missing coefficient references, and non-converged results before promotion", () => {
    const harness = createHarness("promotion-rejections");
    const { referenceGeometry: _referenceGeometry, ...withoutReference } = harness.promotion;
    void _referenceGeometry;
    const missingReference = withReceipt({ ...withoutReference, id: "promotion-missing-reference" });
    expect(() => harness.repositories.engineering.recordPromotion(missingReference)).toThrow(/reference-geometry/i);
    const failed = withReceipt({ ...harness.promotion, convergence: "failed", id: "promotion-non-converged" });
    expect(() => harness.repositories.engineering.recordPromotion(failed)).toThrow(/convergence/i);

    const next = baseline(harness.projectId, 2, "baseline-v2", sha256("changed-geometry"));
    const activated = harness.repositories.engineering.activate({
      baseline: next,
      expectedRevision: 1,
      changeReason: "Change geometry for stale-result test."
    });
    expect(activated.baseline.revision).toBe(2);
    expect(() => harness.repositories.engineering.recordPromotion(harness.promotion)).toThrow(/baseline/i);
    harness.db.close();
  });

  it("marks a promoted result stale when an intersecting baseline dependency changes", () => {
    const harness = createHarness("stale-dependency");
    const promotion = harness.repositories.engineering.recordPromotion(harness.promotion);
    harness.repositories.engineering.finalizePromotions([promotion]);
    const next = baseline(harness.projectId, 2, "baseline-v2", sha256("changed-geometry"));

    const activated = harness.repositories.engineering.activate({
      baseline: next,
      expectedRevision: 1,
      changeReason: "Change geometry and invalidate dependent aerodynamic results."
    });

    expect(activated.changedAspects).toEqual(expect.arrayContaining(["geometry", "airfoil_geometry"]));
    expect(activated.stalePromotionIds).toEqual([promotion.id]);
    expect(harness.repositories.engineering.getPromotion(harness.projectId, promotion.id)).toMatchObject({
      staleAt: next.createdAt,
      staleReason: expect.stringContaining("geometry")
    });
    expect(() => harness.repositories.engineering.readArtifact({ projectId: harness.projectId, promotionId: promotion.id })).toThrow(/stale/i);
    harness.db.close();
  });

  it("keeps a hash-compatible result current when only an unrelated baseline aspect changes", () => {
    const harness = createHarness("compatible-baseline-revision");
    const promotion = harness.repositories.engineering.recordPromotion(harness.promotion);
    harness.repositories.engineering.finalizePromotions([promotion]);
    const changed = baseline(harness.projectId, 2, "baseline-v2", harness.promotion.geometryHash as string);
    const next = { ...changed, propulsionModelId: "propulsion-model-v2", contentHash: "0".repeat(64) };
    const active = { ...next, contentHash: configurationBaselineContentHash(next) };

    const activated = harness.repositories.engineering.activate({
      baseline: active,
      expectedRevision: 1,
      changeReason: "Change an unrelated propulsion dependency."
    });

    expect(activated.changedAspects).toEqual(["propulsion"]);
    expect(activated.stalePromotionIds).toEqual([]);
    expect(harness.repositories.engineering.getPromotion(harness.projectId, promotion.id)?.staleAt).toBeUndefined();
    expect(harness.repositories.engineering.readArtifact({ projectId: harness.projectId, promotionId: promotion.id })).toMatchObject({
      promotion: { id: promotion.id }
    });
    harness.db.close();
  });

  it("prevents active-pointer deletion and immutable promotion rewrites during staleness", () => {
    const harness = createHarness("immutable-stale-transition");
    const promotion = harness.repositories.engineering.recordPromotion(harness.promotion);
    expect(() => harness.db.prepare("delete from engineering_active_baselines where project_id=?").run(harness.projectId)).toThrow(/cannot be deleted/i);
    expect(() =>
      harness.db
        .prepare("update engineering_result_promotions set stale_at=?,stale_reason=?,artifact_hash=? where id=?")
        .run("2026-07-16T00:00:09.000Z", "forged", "f".repeat(64), promotion.id)
    ).toThrow(/immutable/i);
    expect(harness.repositories.engineering.getPromotion(harness.projectId, promotion.id)).toMatchObject({
      artifact: { sha256: promotion.artifact.sha256 },
      staleAt: undefined
    });
    harness.db.close();
  });
});

interface Harness {
  root: string;
  dbPath: string;
  db: DatabaseSync;
  repositories: StorageV2RepositorySet;
  projectId: string;
  content: string;
  promotion: StorageEngineeringResultPromotion;
}

function createHarness(label: string): Harness {
  const root = mkdtempSync(join(tmpdir(), `aetherops-engineering-baseline-${label}-`));
  roots.push(root);
  const dbPath = join(root, "storage.sqlite");
  const db = new DatabaseSync(dbPath);
  databases.push(db);
  migrateStorageV2Schema(db);
  const repositories = createStorageV2Repositories({ appDb: db }, { dataRoot: root });
  const projectId = `project-${label}`;
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot);
  repositories.projects.upsert({
    id: projectId,
    projectRoot,
    topic: "Engineering baseline repository test",
    status: "active",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z"
  });
  const active = baseline(projectId, 1, "baseline-v1", sha256("naca0012-geometry"));
  repositories.engineering.activate({ baseline: active, expectedRevision: 0, changeReason: "Create immutable test baseline." });
  expect(db.prepare("select change_reason from engineering_configuration_baselines where id=?").get(active.id)).toEqual({
    change_reason: "Create immutable test baseline."
  });
  const jobId = `job-${label}`;
  const attemptId = `attempt-${label}`;
  const decisionId = `decision-${label}`;
  repositories.jobs.enqueue({ id: jobId, projectId, operation: "engineering_run", payload: { projectRevision: 1 } });
  repositories.trace.recordToolDecision({
    id: decisionId,
    projectId,
    jobId,
    toolName: "EngineeringProgramTool",
    purpose: "Compute a baseline-bound aerodynamic polar.",
    expectedOutcome: "A converged CAS-backed polar.",
    rawSelection: { inputHash: sha256("input") },
    userPinned: true,
    policyStatus: "accepted",
    createdAt: "2026-07-16T00:00:01.000Z"
  });
  const attemptBase = {
    id: attemptId,
    projectId,
    jobId,
    decisionId,
    ordinal: 0,
    inputHash: sha256("input"),
    traceVersion: 1 as const,
    traceAvailability: "vnext" as const,
    descriptorVersion: "engineering-program-v1",
    descriptorSideEffects: ["process" as const, "filesystem" as const],
    sideEffectKey: `side-effect-${label}`,
    idempotencyKey: `idempotency-${label}`,
    dependsOnAttemptIds: [] as string[],
    queuedAt: "2026-07-16T00:00:01.000Z"
  };
  repositories.trace.saveToolAttempt({ ...attemptBase, status: "queued" });
  repositories.trace.saveToolAttempt({ ...attemptBase, status: "running", startedAt: "2026-07-16T00:00:02.000Z" });
  const verifiedAt = "2026-07-16T00:00:03.000Z";
  const receiptFields = { receiptId: `postcondition-${label}`, evidenceHash: sha256("postcondition-evidence"), verifier: "test-verifier-v1", verifiedAt };
  const postconditionReceipt = {
    ...receiptFields,
    receiptHash: computeToolPostconditionReceiptHash({
      attemptId,
      descriptorVersion: attemptBase.descriptorVersion,
      idempotencyKey: attemptBase.idempotencyKey,
      sideEffectKey: attemptBase.sideEffectKey,
      disposition: "applied",
      ...receiptFields
    })
  };
  repositories.trace.saveToolAttempt({
    ...attemptBase,
    status: "completed",
    startedAt: "2026-07-16T00:00:02.000Z",
    completedAt: verifiedAt,
    outputHash: sha256("output"),
    terminalCause: "completed",
    postconditionDisposition: "applied",
    postconditionReceipt
  });
  const outputId = `artifact-${label}`;
  const outputLinkId = `output-${label}`;
  repositories.trace.recordOutputLink({
    id: outputLinkId,
    projectId,
    jobId,
    attemptId,
    outputKind: "artifact",
    outputId,
    promoted: true,
    createdAt: verifiedAt,
    promotedAt: "2026-07-16T00:00:04.000Z"
  });
  const content = '{"rows":[{"alpha":0,"cl":0.1,"cd":0.01,"cm":-0.02}]}';
  const artifact = new TerminalCasStore(root).materializeBytes(Buffer.from(content, "utf8"));
  const dependencyAspects = [
    "geometry",
    "airfoil_geometry",
    "aerodynamic_reference",
    "atmosphere",
    "solver",
    "source_revision",
    "unit_convention",
    "coordinate_convention"
  ] as const;
  const promotion = withReceipt({
    id: `promotion-${label}`,
    schemaVersion: 1,
    projectId,
    jobId,
    attemptId,
    outputLinkId,
    outputId,
    resultKind: "polar",
    baselineId: active.id,
    baselineRevision: active.revision,
    baselineContentHash: active.contentHash,
    baselineDependencyHash: configurationBaselineDependencyHash(active, dependencyAspects),
    dependencyAspects,
    geometryHash: active.geometryHash,
    artifact: { casLocator: artifact.casLocator, sha256: artifact.casHash, byteLength: artifact.byteLength, mediaType: "application/json" },
    tool: {
      name: "EngineeringProgramTool",
      version: attemptBase.descriptorVersion,
      executionMedia: "xfoil-wasm@0.1.1",
      receiptHash: postconditionReceipt.receiptHash
    },
    referenceGeometry: { contentHash: aerodynamicReferenceHash(active)! },
    coefficientTypes: ["CL", "CD", "CM"],
    unitDefinition: { unit: "1", dimension: "dimensionless" },
    modelCardId: "model-card:xfoil-wasm:0.1.1",
    simulationRunReceiptId: `tool-run:${attemptId}`,
    convergence: "converged",
    domainAssessment: "verified",
    postcondition: "passed",
    postconditionReceiptHash: postconditionReceipt.receiptHash,
    sensitivity: "project",
    promotedAt: "2026-07-16T00:00:04.000Z"
  });
  return { root, dbPath, db, repositories, projectId, content, promotion };
}

function terminalPromotionInput(
  harness: Harness,
  fence: { jobId: string; attempt: number; leaseOwner: string; leaseGeneration: number },
  pendingCasObject?: StorageTerminalCasObject
) {
  const promotion = harness.promotion;
  return {
    fence,
    status: "completed" as const,
    projectRevision: 1,
    occurredAt: "2026-07-16T00:00:06.000Z",
    snapshotChange: { snapshotVersion: 1, reason: "job_changed" as const },
    promotions: [
      {
        link: {
          id: promotion.outputLinkId,
          projectId: promotion.projectId,
          jobId: promotion.jobId,
          attemptId: promotion.attemptId,
          outputKind: "artifact" as const,
          outputId: promotion.outputId,
          promoted: true,
          createdAt: "2026-07-16T00:00:03.000Z",
          promotedAt: promotion.promotedAt
        },
        artifact: { name: "polar.json", kind: "engineering_result" },
        engineering: promotion,
        ...(pendingCasObject ? { pendingCasObject } : {})
      }
    ]
  };
}

function baseline(projectId: string, revision: number, id: string, geometryHash: string): ConfigurationBaseline {
  const unhashed: ConfigurationBaseline = {
    id,
    projectId,
    revision,
    status: "active",
    geometryHash,
    airfoilGeometryHash: geometryHash,
    aerodynamicReference: {
      area: quantity(1, AREA, "m^2"),
      chord: quantity(1, LENGTH, "m"),
      span: quantity(1, LENGTH, "m"),
      momentReferencePointId: "quarter-chord",
      axisConventionId: "wind-axes-right-handed-v1",
      dynamicPressureDefinition: "q=0.5*rho*V^2"
    },
    atmosphereModelId: "isa-1976",
    unitConventionId: "si-v1",
    coordinateConventionId: "wind-axes-right-handed-v1",
    solverVersions: { "xfoil-wasm": "0.1.1" },
    materialRevisionIds: [],
    sourceRevisionIds: ["fixture:naca0012"],
    equationVersionIds: ["aero-coefficients-v1"],
    contentHash: "0".repeat(64),
    createdAt: `2026-07-16T00:00:0${revision}.000Z`,
    createdBy: "engineering-baseline-test",
    provenance: [{ id: "fixture:naca0012", contentHash: geometryHash }]
  };
  return { ...unhashed, contentHash: configurationBaselineContentHash(unhashed) };
}

function quantity(value: number, dimension: typeof AREA, unit: string): EngineeringQuantity {
  return {
    kind: "scalar",
    valueSI: value,
    dimension,
    semantic: "generic",
    originalValue: value,
    originalUnit: unit,
    displayUnit: unit,
    provenance: { sourceType: "user", sourceId: "engineering-baseline-test" },
    serializationVersion: 1
  };
}

function withReceipt(value: Omit<StorageEngineeringResultPromotion, "receiptHash"> | StorageEngineeringResultPromotion): StorageEngineeringResultPromotion {
  const body = { ...value, receiptHash: "" } as StorageEngineeringResultPromotion;
  return { ...body, receiptHash: engineeringPromotionReceiptHash(body) };
}

function schemaSql(db: DatabaseSync): unknown[] {
  return db.prepare("select type,name,tbl_name,sql from sqlite_master where name not like 'sqlite_%' order by type,name").all();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
