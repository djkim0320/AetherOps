import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInputProject, createStrictTestOrchestrator } from "../../core/orchestratorTestHarness.test.js";
import type { ResearchProjectInput } from "../../core/types.js";
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
    maxLoopIterations: 1,
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
    expect(reloaded.database?.sqlitePath).toContain("research.sqlite");
    expect(reloaded.openCodeRuns).toHaveLength(1);
    expect(reloaded.ragContexts).toHaveLength(1);
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
});
