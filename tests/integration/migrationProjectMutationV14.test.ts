import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, verifyMigration } from "../../src/migration/commands.mjs";
import { upgradeLegacyProjectMutationSchema } from "../../src/migration/legacyProjectMutationSchema.mjs";
import { inspectOperationalSchema, upgradeOperationalSchema } from "../../src/migration/operationalSchema.mjs";
import { inspectProjectMutationCrossDatabase } from "../../src/migration/projectMutationCrossDatabase.mjs";
import {
  assertStorageProjectMutationV14SchemaReady,
  STORAGE_PROJECT_MUTATION_MIGRATION_CHECKSUM,
  STORAGE_PROJECT_MUTATION_MIGRATION_NAME
} from "../../src/server/runtime/storage/v2/projectMutationSchema.js";
import { storageCanonicalHasher, storageCanonicalJson } from "../../src/server/runtime/storage/v2/runStatePayloadValidator.js";
import { migrateStorageV2Schema } from "../../src/server/runtime/storage/v2/schema.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("operational project mutation v14 forward upgrade", () => {
  it("adds the checksum-versioned journal and is idempotent", () => {
    const path = createV13Fixture();
    expect(inspectOperationalSchema(path)).toMatchObject({ ready: false, currentVersion: 13 });
    expect(upgradeOperationalSchema(path)).toMatchObject({ changed: true, appliedVersions: [14] });
    expect(inspectOperationalSchema(path)).toMatchObject({ ready: true, currentVersion: 14 });
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("select name,checksum_sha256 from schema_migrations where version=14").get()).toEqual({
        name: STORAGE_PROJECT_MUTATION_MIGRATION_NAME,
        checksum_sha256: STORAGE_PROJECT_MUTATION_MIGRATION_CHECKSUM
      });
      expect(db.prepare("select count(*) count from project_mutation_journal").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
    const before = databaseSnapshot(path);
    expect(upgradeOperationalSchema(path)).toMatchObject({ changed: false, appliedVersions: [] });
    expect(databaseSnapshot(path)).toEqual(before);
  });

  it("rolls the entire migration back when an index identity conflicts", () => {
    const path = createV13Fixture();
    const sabotage = new DatabaseSync(path);
    sabotage.exec("create index idx_project_mutations_pending on jobs(status)");
    sabotage.close();
    const before = databaseSnapshot(path);
    expect(() => upgradeOperationalSchema(path)).toThrow(/already exists/i);
    expect(databaseSnapshot(path)).toEqual(before);
    const readback = new DatabaseSync(path, { readOnly: true });
    try {
      expect(readback.prepare("select 1 from sqlite_master where type='table' and name='project_mutation_journal'").get()).toBeUndefined();
      expect(readback.prepare("select 1 from schema_migrations where version=14").get()).toBeUndefined();
    } finally {
      readback.close();
    }
  });

  it.each([
    {
      label: "transition trigger",
      tamper:
        "drop trigger trg_project_mutations_transition; create trigger trg_project_mutations_transition before update on project_mutation_journal begin select 1; end"
    },
    {
      label: "active reservation index",
      tamper:
        "drop index idx_project_mutations_active_project; create unique index idx_project_mutations_active_project on project_mutation_journal(request_id)"
    }
  ])("rejects a same-name tampered $label in standalone and runtime inspection", ({ tamper }) => {
    const path = createV14Fixture();
    const db = new DatabaseSync(path);
    try {
      db.exec(tamper);
      expect(() => assertStorageProjectMutationV14SchemaReady(db)).toThrow(/schema object changed/i);
    } finally {
      db.close();
    }
    expect(inspectOperationalSchema(path)).toMatchObject({ ready: false, currentVersion: 14 });
    expect(inspectOperationalSchema(path).errors).toEqual(expect.arrayContaining([expect.stringMatching(/schema object changed/i)]));
  });

  it("rejects an unrecoverable prepared row before migration verification", () => {
    const path = createV14Fixture();
    const legacyPath = createLegacyFixture(path);
    insertPrepared(path, { requestId: "invalid-envelope", command: { foo: "bar" } });

    expect(inspectOperationalSchema(path)).toMatchObject({
      ready: false,
      currentVersion: 14,
      errors: [expect.stringMatching(/command envelope is unrecoverable.*envelope fields/i)]
    });
    expect(inspectProjectMutationCrossDatabase(path, legacyPath)).toMatchObject({
      ready: false,
      journalCount: 1,
      receiptCount: 0,
      conflicts: [expect.stringMatching(/command envelope is unrecoverable.*envelope fields/i)]
    });
  });

  it("accepts a valid prepared crash window with no legacy receipt", () => {
    const path = createV14Fixture();
    const legacyPath = createLegacyFixture(path);
    insertPrepared(path, { requestId: "valid-crash-window", command: validCreateEnvelope("project-valid-crash-window") });

    expect(inspectOperationalSchema(path)).toMatchObject({ ready: true, currentVersion: 14, errors: [] });
    expect(inspectProjectMutationCrossDatabase(path, legacyPath)).toMatchObject({
      ready: true,
      journalCount: 1,
      receiptCount: 0,
      matchedCount: 0,
      errors: [],
      conflicts: []
    });
  });

  it("surfaces an unrecoverable prepared row through the migration verify command", () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-project-mutation-verify-"));
    roots.push(root);
    const context = { dataRoot: root, migrationRoot: join(root, "migration") };
    const source = new DatabaseSync(join(root, "aetherops.sqlite"));
    try {
      source.exec("create table projects(id text primary key,data text not null)");
      source.prepare("insert into projects(id,data) values(?,?)").run(
        "project-existing",
        JSON.stringify({
          id: "project-existing",
          projectRoot: "fixture-root",
          topic: "Migration verifier fixture",
          status: "idle",
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z"
        })
      );
    } finally {
      source.close();
    }
    expect(applyMigration(context)).toMatchObject({ ok: true, applied: true });
    const current = JSON.parse(readFileSync(join(context.migrationRoot, "current.json"), "utf8")) as { targetDbPath: string };
    insertPrepared(current.targetDbPath, { requestId: "verify-invalid-envelope", command: { foo: "bar" } });

    const verification = verifyMigration(context);
    expect(verification, JSON.stringify(verification, null, 2)).toMatchObject({
      ok: false,
      status: "mismatch",
      verification: {
        ok: false,
        errors: [expect.stringMatching(/command envelope is unrecoverable.*envelope fields/i)],
        projectMutationCrossDatabase: {
          ready: false,
          conflicts: [expect.stringMatching(/command envelope is unrecoverable.*envelope fields/i)]
        }
      }
    });
  });

  it.each([
    {
      label: "unknown envelope field",
      mutate: (row: PreparedRow) => ({ ...row, command: { ...validCreateEnvelope(row.projectId), unexpected: true } })
    },
    {
      label: "public-to-legacy method mapping",
      mutate: (row: PreparedRow) => ({ ...row, command: { ...validCreateEnvelope(row.projectId), legacyMethod: "project.update" } })
    },
    {
      label: "journal before hash",
      mutate: (row: PreparedRow) => ({ ...row, legacyBeforeHash: storageCanonicalHasher.sha256Canonical("different") })
    },
    {
      label: "canonical applied timestamp",
      mutate: (row: PreparedRow) => ({
        ...row,
        command: { ...validCreateEnvelope(row.projectId), appliedAt: "2026-07-16T00:00:00Z" }
      })
    },
    {
      label: "canonical command hash",
      mutate: (row: PreparedRow) => ({ ...row, commandHash: storageCanonicalHasher.sha256Canonical("different") })
    },
    {
      label: "legacy recovery command shape",
      mutate: (row: PreparedRow) => ({ ...row, command: { ...validCreateEnvelope(row.projectId), command: { foo: "bar" } } })
    },
    {
      label: "request hash",
      mutate: (row: PreparedRow) => ({ ...row, requestHash: "z".repeat(64) })
    },
    {
      label: "create expected revision",
      mutate: (row: PreparedRow) => ({ ...row, expectedRevision: 1 })
    },
    {
      label: "safe integer revision",
      mutate: (row: PreparedRow) => ({ ...row, expectedRevision: 1.5 })
    }
  ])("rejects a prepared row with invalid $label", ({ mutate }) => {
    const path = createV14Fixture();
    const row = mutate(preparedRow("prepared-validation"));
    insertPrepared(path, row);
    expect(inspectOperationalSchema(path)).toMatchObject({
      ready: false,
      errors: expect.arrayContaining([expect.stringMatching(/command envelope is unrecoverable/i)])
    });
  });

  it("rejects an invalid project identity on a session command", () => {
    const path = createV14Fixture();
    const beforeHash = "a".repeat(64);
    insertPrepared(path, {
      requestId: "invalid-session-project",
      projectId: "",
      method: "sessions.delete",
      expectedRevision: 1,
      legacyBeforeHash: beforeHash,
      command: {
        legacyMethod: "session.delete",
        expectedBeforeHash: beforeHash,
        appliedAt: "2026-07-16T00:00:00.000Z",
        command: { sessionId: "session-valid" }
      }
    });

    expect(inspectOperationalSchema(path)).toMatchObject({
      ready: false,
      errors: expect.arrayContaining([expect.stringMatching(/command envelope is unrecoverable.*project identity/i)])
    });
  });

  it("rejects an active create whose operational project base already exists", () => {
    const path = createV14Fixture();
    const projectId = "project-existing-operational-base";
    insertPrepared(path, { requestId: "existing-operational-base", projectId, command: validCreateEnvelope(projectId) });
    seedOperationalRevisionZero(path, projectId);

    expect(inspectOperationalSchema(path)).toMatchObject({
      ready: false,
      errors: expect.arrayContaining([expect.stringMatching(/base revision is inconsistent/i)])
    });
  });

  it("rejects an active create whose operational project row exists without a revision head", () => {
    const path = createV14Fixture();
    const projectId = "project-existing-row-without-head";
    insertPrepared(path, { requestId: "existing-row-without-head", projectId, command: validCreateEnvelope(projectId) });
    seedOperationalProject(path, projectId, false);

    expect(inspectOperationalSchema(path)).toMatchObject({
      ready: false,
      errors: expect.arrayContaining([expect.stringMatching(/base revision is inconsistent/i)])
    });
  });

  it("reports missing project revision dependencies without throwing", () => {
    const path = createV14Fixture();
    const projectId = "project-missing-revision-schema";
    insertPrepared(path, { requestId: "missing-revision-schema", projectId, command: validCreateEnvelope(projectId) });
    const db = new DatabaseSync(path);
    try {
      db.exec("drop table project_revision_heads");
    } finally {
      db.close();
    }

    expect(() => inspectOperationalSchema(path)).not.toThrow();
    expect(inspectOperationalSchema(path)).toMatchObject({
      ready: false,
      errors: expect.arrayContaining([expect.stringMatching(/base revision is inconsistent/i)])
    });
  });

  it("rejects a non-create mutation whose expected revision differs from the operational head", () => {
    const path = createV14Fixture();
    const projectId = "project-stale-operational-base";
    const beforeHash = "a".repeat(64);
    seedOperationalRevisionZero(path, projectId);
    insertPrepared(path, {
      requestId: "stale-operational-base",
      projectId,
      method: "sessions.delete",
      expectedRevision: 1,
      legacyBeforeHash: beforeHash,
      command: validDeleteEnvelope("session-stale", beforeHash)
    });

    expect(inspectOperationalSchema(path)).toMatchObject({
      ready: false,
      errors: [expect.stringMatching(/base revision is inconsistent/i)]
    });
  });

  it("rejects a prepared create when the legacy project already exists", () => {
    const path = createV14Fixture();
    const legacyPath = createLegacyFixture(path);
    const projectId = "project-existing-legacy-base";
    insertPrepared(path, { requestId: "existing-legacy-base", projectId, command: validCreateEnvelope(projectId) });
    seedLegacyProject(legacyPath, projectId);

    expect(inspectProjectMutationCrossDatabase(path, legacyPath)).toMatchObject({
      ready: false,
      conflicts: [expect.stringMatching(/legacy precondition mismatch.*project already exists/i)]
    });
  });

  it("rejects an unreadable legacy project instead of treating it as absent", () => {
    const path = createV14Fixture();
    const legacyPath = createLegacyFixture(path);
    const projectId = "project-unreadable-legacy-base";
    insertPrepared(path, { requestId: "unreadable-legacy-base", projectId, command: validCreateEnvelope(projectId) });
    const legacy = new DatabaseSync(legacyPath);
    try {
      legacy.prepare("insert into projects(id,created_at,data) values(?,?,?)").run(projectId, "2026-07-16T00:00:00.000Z", "{");
    } finally {
      legacy.close();
    }

    expect(() => inspectProjectMutationCrossDatabase(path, legacyPath)).not.toThrow();
    expect(inspectProjectMutationCrossDatabase(path, legacyPath)).toMatchObject({
      ready: false,
      conflicts: [expect.stringMatching(/legacy precondition mismatch.*legacy project readback/i)]
    });
  });

  it("rejects a prepared update whose expected-before hash differs from legacy readback", () => {
    const path = createV14Fixture();
    const legacyPath = createLegacyFixture(path);
    const projectId = "project-stale-legacy-base";
    const beforeHash = "b".repeat(64);
    seedLegacyProject(legacyPath, projectId);
    insertPrepared(path, {
      requestId: "stale-legacy-base",
      projectId,
      method: "projects.update",
      legacyBeforeHash: beforeHash,
      command: validUpdateEnvelope(projectId, beforeHash)
    });

    expect(inspectProjectMutationCrossDatabase(path, legacyPath)).toMatchObject({
      ready: false,
      conflicts: [expect.stringMatching(/legacy precondition mismatch.*snapshot before hash/i)]
    });
  });

  it("returns a structured mismatch for non-finite JSON numbers", () => {
    const path = createV14Fixture();
    const projectId = "project-non-finite-command";
    const rawCommandJson = storageCanonicalJson(validCreateEnvelope(projectId)).replace('"budget":"offline"', '"budget":1e999');
    insertPrepared(path, {
      requestId: "non-finite-command",
      projectId,
      command: validCreateEnvelope(projectId),
      rawCommandJson
    });

    expect(() => inspectOperationalSchema(path)).not.toThrow();
    expect(inspectOperationalSchema(path)).toMatchObject({
      ready: false,
      errors: [expect.stringMatching(/command envelope is unrecoverable.*non-canonical command JSON/i)]
    });
  });
});

interface PreparedRow {
  requestId: string;
  projectId: string;
  command: Record<string, unknown>;
  commandHash?: string;
  legacyBeforeHash?: string;
  requestHash?: string;
  expectedRevision?: number;
  method?: "projects.create" | "projects.update" | "sessions.create" | "sessions.delete";
  rawCommandJson?: string;
}

function preparedRow(requestId: string): PreparedRow {
  const projectId = `project-${requestId}`;
  return { requestId, projectId, command: validCreateEnvelope(projectId) };
}

function validCreateEnvelope(projectId: string): Record<string, unknown> {
  const appliedAt = "2026-07-16T00:00:00.000Z";
  return {
    legacyMethod: "project.create",
    expectedBeforeHash: null,
    appliedAt,
    command: {
      project: {
        id: projectId,
        goal: "Validate durable recovery",
        topic: "Prepared crash window",
        scope: "Migration verifier",
        budget: "offline",
        autonomyPolicy: {
          toolApproval: "suggested",
          allowAgent: true,
          allowExternalSearch: false,
          allowCodeExecution: false,
          maxLoopIterations: 3
        },
        createdAt: appliedAt,
        updatedAt: appliedAt,
        currentStep: "CREATE_RESEARCH_DB",
        status: "idle",
        projectRoot: `fixture/${projectId}`
      }
    }
  };
}

function validUpdateEnvelope(projectId: string, expectedBeforeHash: string): Record<string, unknown> {
  const create = validCreateEnvelope(projectId);
  return {
    ...create,
    legacyMethod: "project.update",
    expectedBeforeHash
  };
}

function validDeleteEnvelope(sessionId: string, expectedBeforeHash: string): Record<string, unknown> {
  return {
    legacyMethod: "session.delete",
    expectedBeforeHash,
    appliedAt: "2026-07-16T00:00:00.000Z",
    command: { sessionId }
  };
}

function insertPrepared(path: string, input: Partial<PreparedRow> & Pick<PreparedRow, "requestId" | "command">): void {
  const method = input.method ?? "projects.create";
  const projectId = input.projectId ?? `project-${input.requestId}`;
  const preparedAt = "2026-07-16T00:00:00.000Z";
  const commandJson = input.rawCommandJson ?? storageCanonicalJson(input.command);
  const db = new DatabaseSync(path);
  try {
    db.prepare(
      `insert into project_mutation_journal
        (operation_id,schema_version,method,request_id,request_hash,project_id,expected_revision,command_json,command_hash,
         legacy_before_hash,state,prepared_at,updated_at)
       values (?,1,?,?,?,?,?,?,?,?,'prepared',?,?)`
    ).run(
      `project-mutation:${storageCanonicalHasher.sha256Canonical({ method, requestId: input.requestId })}`,
      method,
      input.requestId,
      input.requestHash ?? storageCanonicalHasher.sha256Canonical({ method, requestId: input.requestId, fixture: true }),
      projectId,
      input.expectedRevision ?? 0,
      commandJson,
      input.commandHash ?? storageCanonicalHasher.sha256Text(commandJson),
      input.legacyBeforeHash ?? storageCanonicalHasher.sha256Canonical(null),
      preparedAt,
      preparedAt
    );
  } finally {
    db.close();
  }
}

function seedOperationalRevisionZero(path: string, projectId: string): void {
  seedOperationalProject(path, projectId, true);
}

function seedOperationalProject(path: string, projectId: string, includeHead: boolean): void {
  const db = new DatabaseSync(path);
  try {
    const createdAt = "2026-07-16T00:00:00.000Z";
    const project = (validCreateEnvelope(projectId).command as { project: Record<string, unknown> }).project;
    db.prepare("insert into projects_v2(id,short_id,project_root,topic,status,current_step,created_at,updated_at,data) values(?,?,?,?,?,?,?,?,?)").run(
      projectId,
      projectId,
      project.projectRoot,
      project.topic,
      project.status,
      project.currentStep,
      createdAt,
      createdAt,
      JSON.stringify(project)
    );
    if (includeHead)
      db.prepare("insert into project_revision_heads(project_id,revision,last_receipt_id,updated_at) values(?,0,null,?)").run(projectId, createdAt);
  } finally {
    db.close();
  }
}

function seedLegacyProject(path: string, projectId: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      create table if not exists projects(id text primary key,created_at text not null,data text not null);
      create table if not exists sessions(id text primary key,project_id text not null,created_at text not null,data text not null);
    `);
    const project = (validCreateEnvelope(projectId).command as { project: Record<string, unknown> }).project;
    db.prepare("insert into projects(id,created_at,data) values(?,?,?)").run(projectId, project.createdAt, JSON.stringify(project));
  } finally {
    db.close();
  }
}

function createLegacyFixture(operationalPath: string): string {
  const path = join(dirname(operationalPath), "legacy-research.sqlite");
  upgradeLegacyProjectMutationSchema(path);
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      create table if not exists projects(id text primary key,created_at text not null,data text not null);
      create table if not exists sessions(id text primary key,project_id text not null,created_at text not null,data text not null);
    `);
  } finally {
    db.close();
  }
  return path;
}

function createV14Fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "aetherops-project-mutation-v14-tamper-"));
  roots.push(root);
  const path = join(root, "storage.sqlite");
  const db = new DatabaseSync(path);
  try {
    migrateStorageV2Schema(db);
  } finally {
    db.close();
  }
  return path;
}

function createV13Fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "aetherops-project-mutation-migration-"));
  roots.push(root);
  const path = join(root, "storage.sqlite");
  const db = new DatabaseSync(path);
  try {
    migrateStorageV2Schema(db);
    db.exec("drop table project_mutation_journal; delete from schema_migrations where version=14");
  } finally {
    db.close();
  }
  return path;
}

function databaseSnapshot(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      schema: db.prepare("select type,name,tbl_name,sql from sqlite_master where name not like 'sqlite_%' order by type,name").all(),
      migrations: db.prepare("select version,name,checksum_sha256 from schema_migrations order by version").all()
    };
  } finally {
    db.close();
  }
}
