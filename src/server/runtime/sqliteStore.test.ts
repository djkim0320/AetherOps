import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createInputProject, createStrictTestOrchestrator } from "../../core/orchestratorTestHarness.test.js";
import {
  ResearchLoopStep,
  type GlobalMemoryItem,
  type NormalizedResearchRecord,
  type OntologyEntity,
  type OntologyRelation,
  type ResearchChunk,
  type ResearchProject,
  type ResearchProjectInput,
  type ResearchSource,
  type ResearchStore
} from "../../core/types.js";
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
  it("implements the ResearchStore interface", () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-"));
    const sqliteStore = new SqliteResearchStore(join(tempDir, "aetherops.sqlite"));
    store = sqliteStore;
    const researchStore: ResearchStore = sqliteStore;
    expect(researchStore).toBe(sqliteStore);
  });

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

  it("strips external rawText before writing sources to app and Main SQLite", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-"));
    const sqlitePath = join(tempDir, "aetherops.sqlite");
    store = new SqliteResearchStore(sqlitePath);
    const project = testProject("raw-text-project", "2026-05-20T00:00:00.000Z");
    await store.saveProject(project);
    const source: ResearchSource = {
      id: "source-raw-text",
      projectId: project.id,
      kind: "web",
      title: "Fetched page",
      url: "https://example.edu/raw",
      retrievedAt: "2026-05-20T00:00:00.000Z",
      rawPath: join(tempDir, "main", "files", "sources", "web", "source-raw-text.json"),
      metadata: { rawText: "full fetched page body", fetchStatus: "fetched" },
      createdAt: "2026-05-20T00:00:00.000Z"
    };

    await store.saveSources([source]);

    const appDb = new DatabaseSync(sqlitePath);
    const mainDb = new DatabaseSync(join(tempDir, "main", "main.sqlite"));
    try {
      const appRow = appDb.prepare("select data from sources where id = ?").get(source.id) as { data: string } | undefined;
      const mainRow = mainDb.prepare("select data from global_sources where id = ?").get(source.id) as { data: string } | undefined;
      const appSource = JSON.parse(appRow?.data ?? "{}") as ResearchSource;
      const mainSource = JSON.parse(mainRow?.data ?? "{}") as ResearchSource;
      expect(appSource.metadata.rawText).toBeUndefined();
      expect(mainSource.metadata.rawText).toBeUndefined();
      expect(appSource.metadata.characterCount).toBe("full fetched page body".length);
      expect(mainSource.rawPath).toContain(join(tempDir, "main", "files", "sources"));
    } finally {
      appDb.close();
      mainDb.close();
    }
  });

  it("assembles project snapshots from project rows plus global-visible main research memory", async () => {
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
      { ...testRecord("ephemeral-record-a", projectA.id, "project_only", createdAt), memoryScope: "ephemeral" },
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
    expect(snapshot.normalizedRecords.map((record) => record.id)).toEqual(expect.arrayContaining(["global-record-a", "global-record-linked-to-b", "local-record-b"]));
    expect(snapshot.normalizedRecords.map((record) => record.id)).not.toContain("local-record-a");
    expect(snapshot.normalizedRecords.map((record) => record.id)).not.toContain("ephemeral-record-a");
    expect(snapshot.chunks.map((chunk) => chunk.id)).toEqual(expect.arrayContaining(["global-chunk-a", "global-chunk-linked-to-b", "local-chunk-b"]));
    expect(snapshot.chunks.map((chunk) => chunk.id)).not.toContain("local-chunk-a");
    expect(snapshot.ontologyEntities.map((entity) => entity.id)).toEqual(expect.arrayContaining(["global-entity-a", "global-entity-linked-to-b", "local-entity-b"]));
    expect(snapshot.ontologyEntities.map((entity) => entity.id)).not.toContain("local-entity-a");
  });

  it("persists main memory records and project workspace context links", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-"));
    store = new SqliteResearchStore(join(tempDir, "aetherops.sqlite"));
    const createdAt = new Date().toISOString();
    const project = testProject("project-memory", createdAt);
    await store.saveProject(project);
    const otherProject = testProject("project-memory-other", createdAt);
    await store.saveProject(otherProject);
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
    const globalItem: GlobalMemoryItem = {
      id: "memory-item",
      projectId: project.id,
      sourceProjectId: project.id,
      memoryScope: "global",
      title: "Validated memory",
      content: "Validated content",
      validationResultId: "validation-1",
      supportingRecordIds: [record.id],
      supportingEvidenceIds: [],
      citations: ["https://example.edu/source"],
      promotionReason: "test promotion",
      validationStatus: "validated",
      createdAt
    };
    await store.saveGlobalMemoryItems([
      globalItem,
      { ...globalItem, id: "project-local-memory-item", memoryScope: undefined }
    ]);

    expect(existsSync(join(tempDir, "main", "main.sqlite"))).toBe(true);
    expect(existsSync(join(project.projectRoot, "project.sqlite"))).toBe(true);
    const mainDb = new DatabaseSync(join(tempDir, "main", "main.sqlite"));
    const projectDb = new DatabaseSync(join(project.projectRoot, "project.sqlite"));
    try {
      const globalRecord = mainDb.prepare("select count(*) as count from global_normalized_records").get() as { count: number };
      const globalMemoryItem = mainDb.prepare("select count(*) as count from global_memory_items").get() as { count: number };
      const linkedRecord = projectDb.prepare("select count(*) as count from project_record_links").get() as { count: number };
      const contextSnapshots = projectDb.prepare("select count(*) as count from project_context_snapshots").get() as { count: number };
      expect(globalRecord.count).toBe(1);
      expect(globalMemoryItem.count).toBe(2);
      expect(linkedRecord.count).toBe(1);
      expect(contextSnapshots.count).toBe(1);
    } finally {
      mainDb.close();
      projectDb.close();
    }
    const snapshot = await store.getSnapshot(project.id);
    expect(snapshot.projectContextSnapshots).toHaveLength(1);
    expect(snapshot.globalMemoryItems?.map((item) => item.id)).toContain("memory-item");
    const otherSnapshot = await store.getSnapshot(otherProject.id);
    expect(otherSnapshot.globalMemoryItems?.map((item) => item.id)).toContain("memory-item");
    expect(otherSnapshot.globalMemoryItems?.map((item) => item.id)).not.toContain("project-local-memory-item");
  });

  it("searches global records, chunks, and graph with project visibility and relevance filters", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-"));
    store = new SqliteResearchStore(join(tempDir, "aetherops.sqlite"));
    const createdAt = new Date().toISOString();
    const projectA = testProject("project-search-a", createdAt);
    const projectB = testProject("project-search-b", createdAt);
    await store.saveProject(projectA);
    await store.saveProject(projectB);

    await store.saveNormalizedRecords([
      { ...testRecord("global-pomodoro", projectA.id, "global", createdAt), title: "Pomodoro focus fatigue", content: "pomodoro focus fatigue study break" },
      { ...testRecord("global-off-topic", projectA.id, "global", createdAt), title: "Wind turbine", content: "gearbox lubrication blade maintenance" },
      { ...testRecord("other-project-only", projectA.id, "project_only", createdAt), title: "Pomodoro private", content: "pomodoro private note" },
      { ...testRecord("project-b-local", projectB.id, "project_only", createdAt), title: "Pomodoro local", content: "pomodoro local workspace" },
      { ...testRecord("ephemeral-pomodoro", projectA.id, "project_only", createdAt), memoryScope: "ephemeral", title: "Pomodoro raw snippet", content: "pomodoro raw snippet" },
      { ...testRecord("rejected-pomodoro", projectA.id, "global", createdAt), validationStatus: "rejected", title: "Pomodoro rejected", content: "pomodoro rejected" }
    ]);
    await store.saveChunks([
      { ...testChunk("global-chunk-pomodoro", projectA.id, "global", createdAt), text: "pomodoro focus chunk", recordId: "global-pomodoro" },
      { ...testChunk("global-chunk-off-topic", projectA.id, "global", createdAt), text: "wind turbine chunk", recordId: "global-off-topic" },
      { ...testChunk("project-b-chunk", projectB.id, "project_only", createdAt), text: "pomodoro local chunk", recordId: "project-b-local" }
    ]);
    const entity = { ...testEntity("global-entity-pomodoro", projectA.id, "global", createdAt), label: "Pomodoro focus", sourceRecordId: "global-pomodoro" };
    const relation: OntologyRelation = {
      id: "global-relation-pomodoro",
      projectId: projectA.id,
      originProjectId: projectA.id,
      workspaceProjectId: projectA.id,
      sourceProjectId: projectA.id,
      memoryScope: "global",
      validationStatus: "graph_linked",
      subjectId: entity.id,
      predicate: "mentions",
      objectId: entity.id,
      sourceRecordId: "global-pomodoro",
      confidence: 0.7,
      createdAt
    };
    await store.saveOntologyEntities([
      entity,
      { ...testEntity("global-entity-off-topic", projectA.id, "global", createdAt), label: "Wind turbine", sourceRecordId: "global-off-topic" },
      { ...testEntity("project-b-entity", projectB.id, "project_only", createdAt), label: "Pomodoro local", sourceRecordId: "project-b-local" }
    ]);
    await store.saveOntologyRelations([relation]);

    const records = await store.searchGlobalRecords("pomodoro focus", { projectId: projectB.id, limit: 10 });
    expect(records.map((record) => record.id)).toEqual(expect.arrayContaining(["global-pomodoro", "project-b-local"]));
    expect(records.map((record) => record.id)).not.toEqual(expect.arrayContaining(["global-off-topic", "other-project-only", "ephemeral-pomodoro", "rejected-pomodoro"]));

    const chunks = await store.searchGlobalChunks("pomodoro focus", { projectId: projectB.id, limit: 10 });
    expect(chunks.map((chunk) => chunk.id)).toEqual(expect.arrayContaining(["global-chunk-pomodoro", "project-b-chunk"]));
    expect(chunks.map((chunk) => chunk.id)).not.toContain("global-chunk-off-topic");

    const graph = await store.searchGlobalGraph("pomodoro focus", { projectId: projectB.id, limit: 10 });
    expect(graph.entities.map((item) => item.id)).toEqual(expect.arrayContaining(["global-entity-pomodoro", "project-b-entity"]));
    expect(graph.entities.map((item) => item.id)).not.toContain("global-entity-off-topic");
    expect(graph.relations.map((item) => item.id)).toContain("global-relation-pomodoro");
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
