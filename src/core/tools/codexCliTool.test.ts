import { describe, expect, it, vi } from "vitest";
import type { AppSettings, CodexCliAdapter, ResearchToolInput } from "../shared/types.js";
import { CodexCliTool } from "./codexCliTool.js";

describe("CodexCliTool", () => {
  it("requires promoted hash-verified inputs and preserves Codex trace provenance", async () => {
    const adapter: CodexCliAdapter = {
      run: vi.fn(async () => ({
        summary: "probe completed",
        outputs: [
          {
            relativePath: "reports/result.json",
            kind: "data" as const,
            absolutePath: "D:/staging/workspace/outputs/reports/result.json",
            sha256: "b".repeat(64),
            bytes: 12
          }
        ],
        trace: {
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          sandboxProfile: "aetherops-codex-workspace-v1" as const,
          networkPolicy: "disabled" as const,
          durationMs: 100,
          exitCode: 0,
          eventCount: 3,
          workspaceManifestHash: "c".repeat(64),
          outputManifestHash: "d".repeat(64),
          terminationReason: "completed"
        }
      }))
    };
    const tool = new CodexCliTool(adapter);
    const result = await tool.run(input(), settings(), {
      signal: new AbortController().signal,
      attemptId: "attempt-1",
      decisionId: "decision-1",
      ordinal: 0,
      phase: "exclusive",
      inputs: {
        task: "Read the probe.",
        inputArtifactIds: ["artifact-1"],
        outputs: [{ relativePath: "reports/result.json", kind: "data" }]
      },
      stagingRef: "D:/staging"
    });

    expect(adapter.run).toHaveBeenCalledWith(expect.objectContaining({ actionRoot: "D:/staging", settings: settings().codex }));
    expect(result.toolRun.status).toBe("completed");
    expect(result.artifacts[0]).toMatchObject({ relativePath: "reports/result.json", metadata: { originTool: "CodexCliTool", sha256: "b".repeat(64) } });
    expect(result.toolRun.output).toMatchObject({ outputManifestHash: "d".repeat(64) });
  });

  it("rejects execution outside an isolated action workspace", async () => {
    const tool = new CodexCliTool({ run: vi.fn() });
    await expect(tool.run(input(), settings())).rejects.toThrow("isolated action workspace");
  });
});

function input(): ResearchToolInput {
  return {
    project: { id: "project-1" },
    questions: [],
    hypotheses: [],
    artifacts: [
      {
        id: "artifact-1",
        projectId: "project-1",
        category: "generated_artifact",
        title: "probe",
        relativePath: "probe.json",
        rawPath: "D:/ready/probe.json",
        mimeType: "application/json",
        summary: "probe",
        metadata: { sha256: "a".repeat(64) },
        createdAt: "2026-07-11T00:00:00.000Z"
      }
    ],
    iteration: 1
  } as unknown as ResearchToolInput;
}

function settings(): AppSettings {
  return {
    codex: { model: "gpt-5.6-sol", reasoningEffort: "high", timeoutMs: 180_000, taskTimeoutMs: 600_000 }
  } as AppSettings;
}
