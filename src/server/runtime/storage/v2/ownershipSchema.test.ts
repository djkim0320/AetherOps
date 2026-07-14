import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StorageV2Database } from "./connection.js";
import {
  assertStorageOwnershipV10SchemaReady,
  STORAGE_OWNERSHIP_MIGRATION_CHECKSUM,
  STORAGE_OWNERSHIP_MIGRATION_NAME,
  STORAGE_OWNERSHIP_SCHEMA_VERSION
} from "./ownershipSchema.js";
import { migrateStorageV2Schema } from "./schema.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("storage ownership v10", () => {
  it("installs one immutable migration identity and requires every ownership trigger", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateStorageV2Schema(db);
      migrateStorageV2Schema(db);
      expect(db.prepare("select name,checksum_sha256 from schema_migrations where version=?").get(STORAGE_OWNERSHIP_SCHEMA_VERSION)).toEqual({
        name: STORAGE_OWNERSHIP_MIGRATION_NAME,
        checksum_sha256: STORAGE_OWNERSHIP_MIGRATION_CHECKSUM
      });
      expect(() => assertStorageOwnershipV10SchemaReady(db)).not.toThrow();
      db.exec("drop trigger trg_tool_output_links_owner_update");
      expect(() => assertStorageOwnershipV10SchemaReady(db)).toThrow(/trigger is missing/i);
    } finally {
      db.close();
    }
  });

  it("enables foreign keys on every production connection and rejects raw orphan ownership", () => {
    const fixture = databaseFixture("foreign-keys");
    const storage = new StorageV2Database({
      appDbPath: fixture.path,
      vectorDbPath: fixture.path,
      ontologyDbPath: fixture.path,
      dataRoot: fixture.root,
      requireFts5: false
    });
    try {
      expect(storage.appDb.prepare("pragma foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(() => insertOrphanAudit(storage.appDb)).toThrow(/owner is unavailable/i);
      expect(() => insertOrphanAttempt(storage.appDb)).toThrow(/owner is unavailable/i);
      expect(() => insertOrphanOutputLink(storage.appDb)).toThrow(/owner is unavailable/i);
      expect(() => insertOrphanAttestation(storage.appDb)).toThrow(/foreign key/i);
    } finally {
      storage.close();
    }
  });

  it("fails startup when persisted project roots overlap or split their serialized identity", () => {
    const overlap = databaseFixture("root-overlap");
    const parent = join(overlap.root, "projects", "parent");
    const child = join(parent, "child");
    mkdirSync(child, { recursive: true });
    seedProject(overlap.path, "project-parent", parent);
    seedProject(overlap.path, "project-child", child);
    expect(() => new StorageV2Database({ appDbPath: overlap.path, requireFts5: false })).toThrow();

    const split = databaseFixture("root-split");
    const root = join(split.root, "projects", "split");
    mkdirSync(root, { recursive: true });
    seedProject(split.path, "project-split", root, "project-other");
    expect(() => new StorageV2Database({ appDbPath: split.path, requireFts5: false })).toThrow();
  });
});

function databaseFixture(label: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), `aetherops-ownership-${label}-`));
  roots.push(root);
  const path = join(root, "storage.sqlite");
  const db = new DatabaseSync(path);
  migrateStorageV2Schema(db, { requireFts5: false });
  db.close();
  return { root, path };
}

function seedProject(path: string, id: string, projectRoot: string, payloadId = id): void {
  const db = new DatabaseSync(path);
  try {
    const value = { id: payloadId, projectRoot, topic: id, status: "active", createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z" };
    db.prepare("insert into projects_v2(id,short_id,project_root,topic,status,created_at,updated_at,data) values(?,?,?,?,?,?,?,?)").run(
      id,
      id.slice(0, 12),
      projectRoot,
      value.topic,
      value.status,
      value.createdAt,
      value.updatedAt,
      JSON.stringify(value)
    );
  } finally {
    db.close();
  }
}

function insertOrphanAudit(db: DatabaseSync): void {
  db.prepare(
    "insert into capability_audits(id,project_id,job_id,operation,capability,app_allowed,project_allowed,operation_allowed,allowed,audited_at) values(?,?,?,?,?,?,?,?,?,?)"
  ).run("audit-orphan", "project-orphan", "job-orphan", "agent", "agent", 1, 1, 1, 1, "2026-07-14T00:00:00.000Z");
}

function insertOrphanAttempt(db: DatabaseSync): void {
  db.prepare(
    "insert into tool_attempts(id,project_id,job_id,decision_id,ordinal,status,input_hash,depends_on_attempt_ids,queued_at) values(?,?,?,?,?,?,?,?,?)"
  ).run("attempt-orphan", "project-orphan", "job-orphan", "decision-orphan", 0, "queued", "a".repeat(64), "[]", "2026-07-14T00:00:00.000Z");
}

function insertOrphanOutputLink(db: DatabaseSync): void {
  db.prepare("insert into tool_output_links(id,project_id,job_id,attempt_id,output_kind,output_id,promoted,created_at) values(?,?,?,?,?,?,?,?)").run(
    "link-orphan",
    "project-orphan",
    "job-orphan",
    "attempt-orphan",
    "artifact",
    "artifact-orphan",
    0,
    "2026-07-14T00:00:00.000Z"
  );
}

function insertOrphanAttestation(db: DatabaseSync): void {
  db.prepare(
    `insert into canonical_terminal_result_attestations
      (id,schema_version,project_id,run_id,job_id,batch_hash,subject_kind,subject_id,content_hash,cas_locator,cas_hash,byte_length,
       provenance_attestation_ids,supporting_evidence_ids,contradicting_evidence_ids,source_evidence_ids_hash,supported_claim_hashes,attested_at,attestation_hash)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    "attestation-orphan",
    1,
    "project-orphan",
    "run-orphan",
    "job-orphan",
    "a".repeat(64),
    "artifact",
    "artifact-orphan",
    "b".repeat(64),
    `terminal-cas/sha256/bb/${"b".repeat(64)}`,
    "b".repeat(64),
    1,
    "[]",
    "[]",
    "[]",
    "c".repeat(64),
    "[]",
    "2026-07-14T00:00:00.000Z",
    "d".repeat(64)
  );
}
