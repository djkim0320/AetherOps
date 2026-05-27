import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createStrictTestOrchestrator } from "../../core/orchestratorTestHarness.test.js";
import type { ResearchProjectInput, OntologyEntity, OntologyRelation } from "../../core/types.js";
import { NodeProjectStorage } from "./projectResearchStore.js";
import { SqliteResearchStore } from "./sqliteStore.js";

let tempDir: string | undefined;
let store: SqliteResearchStore | undefined;

const input: ResearchProjectInput = {
  goal: "프로젝트별 독립 저장소 생성 검증",
  topic: "project storage",
  scope: "project.sqlite, context, reports, knowledge 생성",
  budget: "test",
  autonomyPolicy: {
    toolApproval: "suggested",
    allowExternalSearch: false,
    allowCodeExecution: false
  }
};

afterEach(() => {
  store?.close();
  store = undefined;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("NodeProjectStorage", () => {
  it("creates project-isolated research and vector storage", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-storage-"));
    store = new SqliteResearchStore(join(tempDir, "aetherops.sqlite"));
    const orchestrator = createStrictTestOrchestrator({ store, storage: new NodeProjectStorage(), projectRootBase: join(tempDir, "projects") });

    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.createSubSessions(snapshot.project.id);
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);

    expect(snapshot.database).toBeDefined();
    expect(existsSync(snapshot.project.projectRoot)).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "project.sqlite"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "context"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "context", "vector-links.sqlite"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "context", "ontology-links.sqlite"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "artifacts"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "sources"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "logs"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "reports"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "knowledge"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "ontology"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "exports"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "errors"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "state.json"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "project.json"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "project.md"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "aetherops-loop.json"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "aetherops-loop.md"))).toBe(true);
  });

  it("persists ontology graph files and ontology.sqlite records", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-storage-"));
    store = new SqliteResearchStore(join(tempDir, "aetherops.sqlite"));
    const projectStorage = new NodeProjectStorage();
    const orchestrator = createStrictTestOrchestrator({ store, storage: projectStorage, projectRootBase: join(tempDir, "projects") });

    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);
    const createdAt = "2026-05-20T00:00:00.000Z";
    const entity: OntologyEntity = {
      id: "entity-test",
      projectId: snapshot.project.id,
      type: "Concept",
      label: "ontology persistence",
      confidence: 0.8,
      createdAt
    };
    const relation: OntologyRelation = {
      id: "relation-test",
      projectId: snapshot.project.id,
      subjectId: entity.id,
      predicate: "mentions",
      objectId: entity.id,
      confidence: 0.5,
      createdAt
    };
    await projectStorage.writeOntologyGraph(snapshot.project, snapshot.database!, {
      entities: [entity],
      relations: [relation],
      constraints: [],
      exportedAt: createdAt
    });

    expect(existsSync(join(snapshot.project.projectRoot, "ontology", "project-graph.json"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "ontology", "project-graph.nt"))).toBe(true);
  });

  it("stores external raw sources in Main files while internal artifacts stay in the project workspace", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-storage-"));
    store = new SqliteResearchStore(join(tempDir, "aetherops.sqlite"));
    const projectStorage = new NodeProjectStorage();
    const orchestrator = createStrictTestOrchestrator({ store, storage: projectStorage, projectRootBase: join(tempDir, "projects") });

    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);
    const createdAt = "2026-05-20T00:00:00.000Z";
    const savedSources = await projectStorage.writeSources(snapshot.project, snapshot.database!, [
      {
        id: "source-web-main",
        projectId: snapshot.project.id,
        kind: "web",
        title: "Fetched external page",
        url: "https://example.edu/pomodoro",
        retrievedAt: createdAt,
        metadata: { rawText: "full fetched page body", fetchStatus: "fetched" },
        createdAt
      },
      {
        id: "source-web-main-duplicate",
        projectId: snapshot.project.id,
        kind: "web",
        title: "Duplicate fetched external page",
        url: "https://example.edu/pomodoro#section",
        retrievedAt: createdAt,
        metadata: { sourceCandidateOnly: true },
        createdAt
      }
    ]);
    const [source] = savedSources;
    const [artifact] = await projectStorage.writeArtifacts(snapshot.project, snapshot.database!, 1, [
      {
        id: "artifact-local",
        projectId: snapshot.project.id,
        category: "generated_artifact",
        title: "Internal note",
        relativePath: "artifacts/iteration-1/internal-note.md",
        mimeType: "text/markdown",
        summary: "Internal project artifact",
        content: "internal artifact body",
        createdAt
      }
    ]);

    expect(source?.rawPath).toContain(join(tempDir, "main", "files", "sources", "web"));
    expect(savedSources).toHaveLength(1);
    expect(source?.metadata.sourceCandidateOnly).toBe(true);
    expect(source?.rawPath).not.toContain(join(snapshot.project.projectRoot, "sources", "web"));
    expect(source?.rawPath && existsSync(source.rawPath)).toBe(true);
    expect(artifact?.rawPath).toContain(join(snapshot.project.projectRoot, "artifacts"));
    expect(artifact?.rawPath && existsSync(artifact.rawPath)).toBe(true);

    const projectDb = new DatabaseSync(snapshot.database!.sqlitePath);
    try {
      const row = projectDb.prepare("select data from sources where id = ?").get("source-web-main") as { data: string } | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(row?.data ?? "{}").metadata.rawText).toBeUndefined();
    } finally {
      projectDb.close();
    }
  });
});
