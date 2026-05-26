import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
