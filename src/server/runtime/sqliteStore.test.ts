import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createInputProject, createStrictTestOrchestrator } from "../../core/orchestratorTestHarness.test.js";
import { ResearchLoopStep, type NormalizedResearchRecord, type OntologyEntity, type ResearchChunk, type ResearchProject, type ResearchProjectInput } from "../../core/types.js";
import { SqliteResearchStore } from "./sqliteStore.js";

let tempDir: string | undefined;
let store: SqliteResearchStore | undefined;

const input: ResearchProjectInput = {
  goal: "SQLite storage verification",
  topic: "sqlite persistence",
  scope: "Persist project research data.",
  budget: "MVP",
  autonomyPolicy: {
    toolApproval: "suggested",
    allowExternalSearch: false,
    allowCodeExecution: true
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

describe("SqliteResearchStore", () => {
  it("persists project snapshots with DB, runs, RAG contexts, and final report", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-"));
    store = new SqliteResearchStore(join(tempDir, "aetherops.sqlite"));
    const orchestrator = createStrictTestOrchestrator({ store, projectRootBase: join(tempDir, "projects") });

    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    const reloaded = await store.getSnapshot(snapshot.project.id);
    expect(reloaded.database?.sqlitePath).toContain("project.sqlite");
    expect(reloaded.openCodeRuns.length).toBeGreaterThanOrEqual(1);
    expect(reloaded.ragContexts.length).toBeGreaterThanOrEqual(1);
    expect(reloaded.report).toBeDefined();
    expect((await store.listProjects()).at(0)?.id).toBe(snapshot.project.id);
    store.close();
  });

  it("persists chat sessions and session deletion across store reloads", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-"));
    const sqlitePath = join(tempDir, "aetherops.sqlite");
    store = new SqliteResearchStore(sqlitePath);
    let orchestrator = createStrictTestOrchestrator({ store, projectRootBase: join(tempDir, "projects") });

    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.createSubSessions(snapshot.project.id);
    snapshot = await orchestrator.createChatSession(snapshot.project.id);
    const projectId = snapshot.project.id;
    const firstSessionId = snapshot.sessions[0]?.id ?? "";

    expect(snapshot.sessions).toHaveLength(2);
    store.close();

    store = new SqliteResearchStore(sqlitePath);
    let reloaded = await store.getSnapshot(projectId);
    expect(reloaded.sessions).toHaveLength(2);

    orchestrator = createStrictTestOrchestrator({ store, projectRootBase: join(tempDir, "projects") });
    reloaded = await orchestrator.deleteChatSession(projectId, firstSessionId);
    expect(reloaded.sessions).toHaveLength(1);
    expect(reloaded.sessions[0]?.title).toBe("채팅 세션 2");
    store.close();

    store = new SqliteResearchStore(sqlitePath);
    reloaded = await store.getSnapshot(projectId);
    expect(reloaded.sessions).toHaveLength(1);
    expect(reloaded.sessions[0]?.title).toBe("채팅 세션 2");
  });

  it("assembles project snapshots from project rows plus linked main research memory", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-"));
    store = new SqliteResearchStore(join(tempDir, "aetherops.sqlite"));
    const createdAt = new Date().toISOString();
    const projectA = testProject("project-a", createdAt);
    const projectB = testProject("project-b", createdAt);
    await store.saveProject(projectA);
    await store.saveProject(projectB);

    const records: NormalizedResearchRecord[] = [
      testRecord("global-record-a", projectA.id, "global", createdAt),
      { ...testRecord("global-record-linked-to-b", projectA.id, "global", createdAt), workspaceProjectId: projectB.id },
      testRecord("local-record-a", projectA.id, "project_only", createdAt),
      testRecord("local-record-b", projectB.id, "project_only", createdAt)
    ];
    await store.saveNormalizedRecords(records);
    await store.saveChunks([
      testChunk("global-chunk-a", projectA.id, "global", createdAt),
      { ...testChunk("global-chunk-linked-to-b", projectA.id, "global", createdAt), workspaceProjectId: projectB.id },
      testChunk("local-chunk-a", projectA.id, "project_only", createdAt),
      testChunk("local-chunk-b", projectB.id, "project_only", createdAt)
    ]);
    await store.saveOntologyEntities([
      testEntity("global-entity-a", projectA.id, "global", createdAt),
      { ...testEntity("global-entity-linked-to-b", projectA.id, "global", createdAt), workspaceProjectId: projectB.id, sourceRecordId: "global-record-linked-to-b" },
      testEntity("local-entity-a", projectA.id, "project_only", createdAt),
      testEntity("local-entity-b", projectB.id, "project_only", createdAt)
    ]);

    const snapshot = await store.getSnapshot(projectB.id);
    expect(snapshot.normalizedRecords.map((record) => record.id)).toEqual(expect.arrayContaining(["global-record-linked-to-b", "local-record-b"]));
    expect(snapshot.normalizedRecords.map((record) => record.id)).not.toContain("global-record-a");
    expect(snapshot.normalizedRecords.map((record) => record.id)).not.toContain("local-record-a");
    expect(snapshot.chunks.map((chunk) => chunk.id)).toEqual(expect.arrayContaining(["global-chunk-linked-to-b", "local-chunk-b"]));
    expect(snapshot.chunks.map((chunk) => chunk.id)).not.toContain("global-chunk-a");
    expect(snapshot.chunks.map((chunk) => chunk.id)).not.toContain("local-chunk-a");
    expect(snapshot.ontologyEntities.map((entity) => entity.id)).toEqual(expect.arrayContaining(["global-entity-linked-to-b", "local-entity-b"]));
    expect(snapshot.ontologyEntities.map((entity) => entity.id)).not.toContain("global-entity-a");
    expect(snapshot.ontologyEntities.map((entity) => entity.id)).not.toContain("local-entity-a");
  });

  it("persists main memory records and project workspace context links", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-"));
    store = new SqliteResearchStore(join(tempDir, "aetherops.sqlite"));
    const createdAt = new Date().toISOString();
    const project = testProject("project-memory", createdAt);
    await store.saveProject(project);
    const record = testRecord("global-record-memory", project.id, "global", createdAt);
    await store.saveNormalizedRecords([record]);
    await store.saveProjectContextSnapshot({
      id: "context-memory",
      projectId: project.id,
      iteration: 1,
      query: "memory query",
      selectedRecordIds: [record.id],
      selectedSourceIds: [],
      selectedEvidenceIds: [],
      selectedChunkIds: [],
      selectedEntityIds: [],
      selectedRelationIds: [],
      citations: ["https://example.edu/source"],
      selectionReason: "test selection",
      createdAt
    });
    await store.saveGlobalMemoryItems([{
      id: "memory-item",
      projectId: project.id,
      sourceProjectId: project.id,
      title: "Validated memory",
      content: "Validated content",
      validationResultId: "validation-1",
      supportingRecordIds: [record.id],
      supportingEvidenceIds: [],
      citations: ["https://example.edu/source"],
      promotionReason: "test promotion",
      validationStatus: "validated",
      createdAt
    }]);

    expect(existsSync(join(tempDir, "main", "main.sqlite"))).toBe(true);
    expect(existsSync(join(project.projectRoot, "project.sqlite"))).toBe(true);
    const mainDb = new DatabaseSync(join(tempDir, "main", "main.sqlite"));
    const projectDb = new DatabaseSync(join(project.projectRoot, "project.sqlite"));
    try {
      const globalRecord = mainDb.prepare("select count(*) as count from global_normalized_records").get() as { count: number };
      const linkedRecord = projectDb.prepare("select count(*) as count from project_record_links").get() as { count: number };
      expect(globalRecord.count).toBe(1);
      expect(linkedRecord.count).toBe(1);
    } finally {
      mainDb.close();
      projectDb.close();
    }
    const snapshot = await store.getSnapshot(project.id);
    expect(snapshot.projectContextSnapshots).toHaveLength(1);
    expect(snapshot.globalMemoryItems?.map((item) => item.id)).toContain("memory-item");
  });
});

function testProject(id: string, createdAt: string): ResearchProject {
  return {
    ...input,
    id,
    createdAt,
    updatedAt: createdAt,
    currentStep: ResearchLoopStep.CreateResearchDb,
    status: "idle",
    projectRoot: join(tempDir ?? "", "projects", id)
  };
}

function testRecord(id: string, projectId: string, memoryScope: "global" | "project_only", createdAt: string): NormalizedResearchRecord {
  return {
    id,
    projectId,
    originProjectId: projectId,
    workspaceProjectId: projectId,
    memoryScope,
    sourceProjectId: projectId,
    validationStatus: memoryScope === "global" ? "normalized" : "raw",
    iteration: 1,
    kind: "source",
    title: id,
    content: `record ${id}`,
    metadata: { traceabilityKind: memoryScope === "global" ? "external_source" : "project_provenance", canSupportHypothesis: memoryScope === "global" },
    confidence: 0.7,
    createdAt
  };
}

function testChunk(id: string, projectId: string, memoryScope: "global" | "project_only", createdAt: string): ResearchChunk {
  return {
    id,
    projectId,
    originProjectId: projectId,
    workspaceProjectId: projectId,
    memoryScope,
    sourceProjectId: projectId,
    validationStatus: memoryScope === "global" ? "indexed" : "raw",
    sourceId: `source-${id}`,
    text: `chunk ${id}`,
    chunkIndex: 0,
    keywords: [id],
    createdAt
  };
}

function testEntity(id: string, projectId: string, memoryScope: "global" | "project_only", createdAt: string): OntologyEntity {
  return {
    id,
    projectId,
    originProjectId: projectId,
    workspaceProjectId: projectId,
    memoryScope,
    sourceProjectId: projectId,
    validationStatus: memoryScope === "global" ? "graph_linked" : "raw",
    label: id,
    type: "Source",
    sourceRecordId: memoryScope === "global" ? "global-record-a" : id.replace("entity", "record"),
    confidence: 0.7,
    createdAt
  };
}
