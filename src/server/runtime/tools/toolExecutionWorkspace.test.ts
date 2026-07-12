import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileToolExecutionWorkspace } from "./toolExecutionWorkspace.js";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("FileToolExecutionWorkspace", () => {
  it("provides an isolated action root and moves failed execution state into quarantine", async () => {
    root = mkdtempSync(join(tmpdir(), "aetherops-tool-workspace-"));
    const workspace = new FileToolExecutionWorkspace(root);
    await workspace.beginExecution({
      executionId: "execution-1",
      projectId: "project-1",
      jobId: "job-1",
      iteration: 1,
      actionCount: 1,
      startedAt: "2026-07-11T00:00:00.000Z"
    });
    const actionRoot = workspace.actionWorkspace("execution-1", "action-1");
    expect(actionRoot).toBe(join(root, "staging", "jobs", "job-1", "execution-1", "actions", "action-1"));
    await workspace.record({
      signal: new AbortController().signal,
      jobId: "job-1",
      attemptId: "execution-1:action-1",
      decisionId: "action-1",
      ordinal: 0,
      phase: "exclusive",
      inputs: { task: "bounded task" },
      purpose: "Test isolated execution.",
      expectedOutcome: "A quarantined action manifest.",
      stagingRef: actionRoot!,
      toolName: "OpenCodeTool",
      status: "failed",
      occurredAt: "2026-07-11T00:00:01.000Z",
      error: "forced failure"
    });
    expect(existsSync(join(actionRoot!, "status.json"))).toBe(true);
    const quarantineRoot = await workspace.quarantineExecution("execution-1", "forced failure", "2026-07-11T00:00:02.000Z");
    expect(quarantineRoot).toBe(join(root, "quarantine", "jobs", "job-1", "execution-1"));
    expect(existsSync(join(quarantineRoot!, "manifest.json"))).toBe(true);
    expect(existsSync(join(root, "staging", "jobs", "job-1", "execution-1"))).toBe(false);
  });
});
