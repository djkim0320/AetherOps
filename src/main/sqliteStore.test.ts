import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AetherOpsOrchestrator } from "../core/orchestrator.js";
import type { CreateProjectInput } from "../core/types.js";
import { SqliteResearchStore } from "./sqliteStore.js";

let tempDir: string | undefined;
let store: SqliteResearchStore | undefined;

const input: CreateProjectInput = {
  goal: "SQLite 저장소 검증",
  topic: "sqlite persistence",
  scope: "프로젝트별 연구 자료 저장",
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
    const orchestrator = new AetherOpsOrchestrator(store, undefined, undefined, join(tempDir, "projects"));

    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    const reloaded = await store.getSnapshot(snapshot.project.id);
    expect(reloaded.database?.sqlitePath).toContain("research.sqlite");
    expect(reloaded.openCodeRuns).toHaveLength(1);
    expect(reloaded.ragContexts).toHaveLength(1);
    expect(reloaded.report).toBeDefined();
    expect((await store.listProjects()).at(0)?.id).toBe(snapshot.project.id);
    store.close();
  });
});
