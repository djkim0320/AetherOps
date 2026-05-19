import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AetherOpsOrchestrator } from "../core/orchestrator.js";
import type { CreateProjectInput } from "../core/types.js";
import { NodeProjectStorage } from "./projectResearchStore.js";
import { SqliteResearchStore } from "./sqliteStore.js";

let tempDir: string | undefined;
let store: SqliteResearchStore | undefined;

const input: CreateProjectInput = {
  goal: "프로젝트별 독립 저장소 생성 검증",
  topic: "project storage",
  scope: "research.sqlite, vector.sqlite, artifacts, reports, knowledge 생성",
  budget: "test",
  autonomyPolicy: {
    toolApproval: "suggested",
    maxLoopIterations: 1,
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
    const orchestrator = new AetherOpsOrchestrator(
      store,
      undefined,
      undefined,
      join(tempDir, "projects"),
      undefined,
      new NodeProjectStorage()
    );

    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.createSubSessions(snapshot.project.id);
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);

    expect(snapshot.database).toBeDefined();
    expect(existsSync(snapshot.project.projectRoot)).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "research.sqlite"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "vector.sqlite"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "artifacts"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "reports"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "knowledge"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "project.json"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "project.md"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "aetherops-loop.json"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "aetherops-loop.md"))).toBe(true);
  });
});
