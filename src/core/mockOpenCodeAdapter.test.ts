import { describe, expect, it } from "vitest";
import { MockOpenCodeAdapter } from "./mockOpenCodeAdapter.js";
import { ResearchLoopStep, type AppSettings, type OpenCodeRunInput, type ResearchProject } from "./types.js";

const baseSettings: Omit<AppSettings, "openCodeLlm"> = {
  openCode: {
    enabled: false,
    command: "opencode",
    provider: "openai",
    model: "gpt-5.5",
    timeoutMs: 180_000
  },
  webSearch: {
    provider: "disabled"
  },
  embedding: {
    provider: "local",
    model: "local-hash",
    dimensions: 96
  },
  allowExternalSearch: true,
  allowCodeExecution: false,
  maxLoopIterations: 2,
  updatedAt: "2026-05-14T00:00:00.000Z"
};

const project: ResearchProject = {
  id: "project-test",
  goal: "test",
  topic: "OpenCode LLM setting",
  scope: "settings",
  budget: "test",
  autonomyPolicy: {
    toolApproval: "suggested",
    maxLoopIterations: 1,
    allowExternalSearch: false,
    allowCodeExecution: true
  },
  createdAt: "2026-05-14T00:00:00.000Z",
  updatedAt: "2026-05-14T00:00:00.000Z",
  currentStep: ResearchLoopStep.RunOpenCode,
  status: "running",
  projectRoot: ".aetherops/test"
};

describe("MockOpenCodeAdapter", () => {
  it("records the configured OpenCode API LLM source in execution logs", async () => {
    const settings: AppSettings = {
      ...baseSettings,
      openCodeLlm: {
        source: "api",
        provider: "openai",
        model: "gpt-5.5",
        apiKeyConfigured: true
      }
    };
    const adapter = new MockOpenCodeAdapter(() => settings);
    const input: OpenCodeRunInput = {
      project,
      questions: [],
      hypotheses: [],
      iteration: 1
    };

    const output = await adapter.run(input);
    expect(output.run.logs.join("\n")).toContain("OpenCode LLM setting: openai/gpt-5.5");
    expect(output.run.logs.join("\n")).toContain("key configured");
  });

  it("records Codex OAuth bridge settings in execution logs", async () => {
    const settings: AppSettings = {
      ...baseSettings,
      openCodeLlm: {
        source: "codex-oauth",
        model: "gpt-5.5"
      }
    };
    const adapter = new MockOpenCodeAdapter(() => settings);
    const output = await adapter.run({ project, questions: [], hypotheses: [], iteration: 1 });

    expect(output.run.logs.join("\n")).toContain("OpenCode LLM setting: codex-oauth/gpt-5.5");
  });
});
