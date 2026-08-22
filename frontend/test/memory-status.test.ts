import assert from "node:assert/strict";
import test from "node:test";

import { canReindexMemory, memoryStateLabel, type ProjectMemoryStatus } from "../src/memory-status.ts";

function status(state: ProjectMemoryStatus["state"], active = true): ProjectMemoryStatus {
  return {
    project_id: "prj_test",
    active_index_id: active ? "idx_active" : undefined,
    memory_revision: 3,
    state,
    updated_at: "2026-08-09T00:00:00Z"
  };
}

test("memory state labels expose reindex progress and failure", () => {
  assert.equal(memoryStateLabel(status("reindexing")), "재색인 중");
  assert.equal(memoryStateLabel(status("failed")), "재색인 실패");
});

test("reindex requires an active index and rejects an in-flight build", () => {
  assert.equal(canReindexMemory(status("ready")), true);
  assert.equal(canReindexMemory(status("failed")), true);
  assert.equal(canReindexMemory(status("reindexing")), false);
  assert.equal(canReindexMemory(status("empty", false)), false);
});
