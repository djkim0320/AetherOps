import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalResultReadbackRepository } from "./terminalResultReadbackRepository.js";

const PROJECT_ID = "project-terminal-readback-security";
const ARTIFACT_ID = "artifact-terminal-readback-security";
const BYTES = "authoritative security fixture";
const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("terminal persisted-result readback path security", () => {
  it("rejects an artifact path that escapes the persisted project root without exposing the path", () => {
    const fixture = createFixture("../outside.txt", (root) => writeFileSync(join(root, "outside.txt"), BYTES, "utf8"));
    expectReadbackFailure(fixture);
  });

  it("rejects a parent directory junction even when its target file has the expected hash", () => {
    const fixture = createFixture("linked/terminal.txt", (root, projectRoot) => {
      const outside = join(root, "outside");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "terminal.txt"), BYTES, "utf8");
      symlinkSync(outside, join(projectRoot, "linked"), "junction");
    });
    expectReadbackFailure(fixture);
  });

  it("rejects ambiguous project-root ownership without breaking a uniquely owned existing root", () => {
    const fixture = createFixture("terminal.txt", (_root, projectRoot) => writeFileSync(join(projectRoot, "terminal.txt"), BYTES, "utf8"));
    expect(() => fixture.repository.read({ projectId: PROJECT_ID, artifactIds: [ARTIFACT_ID], evidenceIds: [], validationResultIds: [] })).not.toThrow();
    fixture.appDb.prepare("insert into projects_v2 (id,project_root) values (?,?)").run("project-ambiguous-owner", fixture.projectRoot);
    expectReadbackFailure(fixture);
  });

  it("rejects parent and child project-root overlap before reading canonical artifact bytes", () => {
    const parentFixture = createFixture("terminal.txt", (_root, projectRoot) => writeFileSync(join(projectRoot, "terminal.txt"), BYTES, "utf8"));
    const nestedRoot = join(parentFixture.projectRoot, "nested-project");
    mkdirSync(nestedRoot);
    parentFixture.appDb.prepare("insert into projects_v2 (id,project_root) values (?,?)").run("project-nested-owner", nestedRoot);
    expectReadbackFailure(parentFixture);

    const childFixture = createFixture("terminal.txt", (_root, projectRoot) => writeFileSync(join(projectRoot, "terminal.txt"), BYTES, "utf8"));
    childFixture.appDb.prepare("insert into projects_v2 (id,project_root) values (?,?)").run("project-parent-owner", childFixture.root);
    expectReadbackFailure(childFixture);
  });

  it("does not let an unrelated missing legacy root block a uniquely owned terminal readback", () => {
    const fixture = createFixture("terminal.txt", (_root, projectRoot) => writeFileSync(join(projectRoot, "terminal.txt"), BYTES, "utf8"));
    fixture.appDb.prepare("insert into projects_v2 (id,project_root) values (?,?)").run("project-missing-unrelated", join(fixture.root, "unrelated-missing"));
    expect(() => fixture.repository.read({ projectId: PROJECT_ID, artifactIds: [ARTIFACT_ID], evidenceIds: [], validationResultIds: [] })).not.toThrow();
  });

  it("rejects a missing legacy root whose lexical location overlaps the active project", () => {
    const fixture = createFixture("terminal.txt", (_root, projectRoot) => writeFileSync(join(projectRoot, "terminal.txt"), BYTES, "utf8"));
    fixture.appDb.prepare("insert into projects_v2 (id,project_root) values (?,?)").run("project-missing-overlap", join(fixture.projectRoot, "missing-child"));
    expectReadbackFailure(fixture);
  });

  it("bounds and sanitizes malformed persisted JSON before parsing", () => {
    const malformed = createValidationFixture('{"secret":"must-not-leak",');
    expectValidationFailure(malformed, /contains malformed JSON/i, ["must-not-leak", "Unexpected token", "position"]);
    const oversized = createValidationFixture(JSON.stringify({ padding: "x".repeat(8 * 1024 * 1024) }));
    expectValidationFailure(oversized, /bounded JSON byte limit/i);
  });

  it("requires supported claims to have faithful and evidence-complete validation provenance", () => {
    const value = {
      id: "validation-terminal-readback-security",
      projectId: PROJECT_ID,
      status: "supported",
      supportingEvidenceIds: ["evidence-1"],
      contradictingEvidenceIds: [],
      claimScorecard: {
        claims: [
          {
            claim: "A supported claim",
            status: "supported",
            correctness: {
              status: "supported",
              confidence: 1,
              supportingEvidenceIds: ["evidence-1"],
              contradictingEvidenceIds: []
            },
            citationFaithfulness: {
              status: "unfaithful",
              citedEvidenceIds: ["evidence-1"],
              faithfulEvidenceIds: [],
              unfaithfulEvidenceIds: ["evidence-1"]
            }
          }
        ]
      }
    };
    expectValidationFailure(createValidationFixture(JSON.stringify(value)), /invalid support provenance/i);
  });
});

function createFixture(relativePath: string, files: (root: string, projectRoot: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "aetherops-terminal-readback-security-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  files(root, projectRoot);
  const appDb = new DatabaseSync(join(root, "storage.sqlite"));
  databases.push(appDb);
  appDb.exec("create table projects_v2 (id text primary key, project_root text not null)");
  appDb.prepare("insert into projects_v2 (id,project_root) values (?,?)").run(PROJECT_ID, projectRoot);
  const legacyPath = join(root, "migration", "v2", "legacy-research.sqlite");
  mkdirSync(dirname(legacyPath), { recursive: true });
  const legacy = new DatabaseSync(legacyPath);
  try {
    legacy.exec("create table artifacts (id text primary key, project_id text not null, created_at text not null, data text not null)");
    const artifact = {
      id: ARTIFACT_ID,
      projectId: PROJECT_ID,
      relativePath,
      metadata: { sha256: createHash("sha256").update(BYTES).digest("hex") },
      createdAt: "2026-07-14T00:00:00.000Z"
    };
    legacy
      .prepare("insert into artifacts (id,project_id,created_at,data) values (?,?,?,?)")
      .run(ARTIFACT_ID, PROJECT_ID, artifact.createdAt, JSON.stringify(artifact));
  } finally {
    legacy.close();
  }
  return { root, projectRoot, appDb, repository: new TerminalResultReadbackRepository(appDb, root) };
}

function expectReadbackFailure(fixture: ReturnType<typeof createFixture>): void {
  let message = "";
  try {
    fixture.repository.read({ projectId: PROJECT_ID, artifactIds: [ARTIFACT_ID], evidenceIds: [], validationResultIds: [] });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(/artifact persisted-byte readback failed/i);
  expect(message).not.toContain(fixture.root);
}

function createValidationFixture(data: string) {
  const root = mkdtempSync(join(tmpdir(), "aetherops-terminal-validation-security-"));
  roots.push(root);
  const appDb = new DatabaseSync(join(root, "storage.sqlite"));
  databases.push(appDb);
  appDb.exec("create table projects_v2 (id text primary key, project_root text not null)");
  appDb.prepare("insert into projects_v2 (id,project_root) values (?,?)").run(PROJECT_ID, root);
  const legacyPath = join(root, "migration", "v2", "legacy-research.sqlite");
  mkdirSync(dirname(legacyPath), { recursive: true });
  const legacy = new DatabaseSync(legacyPath);
  try {
    legacy.exec("create table validation_results (id text primary key, project_id text not null, created_at text not null, data text not null)");
    legacy
      .prepare("insert into validation_results (id,project_id,created_at,data) values (?,?,?,?)")
      .run("validation-terminal-readback-security", PROJECT_ID, "2026-07-14T00:00:00.000Z", data);
  } finally {
    legacy.close();
  }
  return { repository: new TerminalResultReadbackRepository(appDb, root) };
}

function expectValidationFailure(fixture: ReturnType<typeof createValidationFixture>, pattern: RegExp, absent: string[] = []): void {
  let message = "";
  try {
    fixture.repository.read({
      projectId: PROJECT_ID,
      artifactIds: [],
      evidenceIds: [],
      validationResultIds: ["validation-terminal-readback-security"]
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(pattern);
  for (const value of absent) expect(message).not.toContain(value);
}
