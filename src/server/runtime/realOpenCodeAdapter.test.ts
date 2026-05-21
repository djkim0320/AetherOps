import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchLoopStep, type AppSettings, type OpenCodeRunInput, type ResearchProject } from "../../core/types.js";
import { RealOpenCodeAdapter } from "./realOpenCodeAdapter.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("RealOpenCodeAdapter", () => {
  it("parses OpenCode json text events as the final schema", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-real-opencode-"));
    const command = createFakeOpenCodeCommand(tempDir);
    const adapter = new RealOpenCodeAdapter(() => settings(command));

    const output = await adapter.run(input());

    expect(output.run.status).toBe("completed");
    expect(output.run.logs[0]).toContain("parsed from OpenCode text event");
    expect(output.nextActions).toEqual([]);
    expect(output.needsMoreEvidence).toBe(false);
    expect(output.needsMoreAnalysis).toBe(false);
    expect(output.fatalError).toBeUndefined();
  });
});

function createFakeOpenCodeCommand(root: string): string {
  mkdirSync(root, { recursive: true });
  const event = JSON.stringify({
    type: "text",
    part: {
      text: JSON.stringify({
        summary: "parsed from OpenCode text event",
        toolPlan: ["self-check"],
        artifacts: [],
        evidence: [],
        nextActions: [],
        needsMoreEvidence: false,
        needsMoreAnalysis: false
      })
    }
  });

  if (process.platform === "win32") {
    const command = join(root, "fake-opencode.cmd");
    writeFileSync(command, `@echo off\r\necho ${event}\r\nexit /b 0\r\n`, "utf8");
    return command;
  }

  const command = join(root, "fake-opencode");
  writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' '${event.replace(/'/g, "'\\''")}'\n`, "utf8");
  chmodSync(command, 0o755);
  return command;
}

function settings(command: string): AppSettings {
  return {
    openCodeLlm: {
      source: "codex-oauth",
      model: "gpt-5.5"
    },
    openCode: {
      enabled: true,
      command,
      provider: "openai",
      model: "gpt-5.5",
      timeoutMs: 10_000
    },
    webSearch: {
      provider: "disabled"
    },
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      apiKey: "test-key",
      apiKeyConfigured: true
    },
    browserUse: {
      enabled: false,
      mode: "background",
      maxPages: 2,
      timeoutMs: 30_000,
      captureScreenshots: false
    },
    allowExternalSearch: true,
    allowCodeExecution: false,
    maxLoopIterations: 2,
    updatedAt: "2026-05-20T00:00:00.000Z"
  };
}

function input(): OpenCodeRunInput {
  const project: ResearchProject = {
    id: "project-test",
    goal: "integration check",
    topic: "OpenCode integration",
    scope: "short check",
    budget: "none",
    autonomyPolicy: {
      toolApproval: "suggested",
      maxLoopIterations: 1,
      allowExternalSearch: false,
      allowCodeExecution: false
    },
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    currentStep: ResearchLoopStep.ExecuteTools,
    status: "running",
    projectRoot: tempDir ?? ""
  };
  return {
    project,
    questions: [],
    hypotheses: [],
    iteration: 1
  };
}
