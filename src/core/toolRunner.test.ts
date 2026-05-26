import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultResearchTools, WebFetchTool, WebSearchTool, type ResearchTool, type ResearchToolResult } from "./toolRegistry.js";
import { dedupeResearchTools, normalizeToolName, ToolRunner } from "./toolRunner.js";
import { ResearchLoopStep, type AppSettings, type OpenCodeRunInput, type ResearchSource } from "./types.js";

const createdAt = "2026-05-26T00:00:00.000Z";

const settings: AppSettings = {
  openCodeLlm: { source: "codex-oauth", model: "gpt-5" },
  openCode: { enabled: false, command: "opencode", timeoutMs: 180_000 },
  webSearch: { provider: "custom", apiKey: "test-key", endpoint: "https://search.example.test" },
  embedding: { provider: "local", model: "none", dimensions: 0 },
  browserUse: { enabled: false, mode: "background", maxPages: 2, timeoutMs: 30_000, captureScreenshots: false },
  allowExternalSearch: true,
  allowCodeExecution: false,
  updatedAt: createdAt
};

function runInput(requiredTools: string[] = []): OpenCodeRunInput {
  return {
    project: {
      id: "project-1",
      goal: "Research resilient web evidence collection.",
      topic: "web evidence collection",
      scope: "public web sources",
      budget: "10 minutes",
      autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: true, allowCodeExecution: false },
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.ExecuteTools,
      status: "running",
      projectRoot: ".aetherops/test"
    },
    questions: [{ id: "q1", projectId: "project-1", text: "What source has usable evidence?", status: "open", createdAt }],
    hypotheses: [{ id: "h1", projectId: "project-1", questionId: "q1", statement: "Fetched pages can become evidence.", status: "untested", confidence: 0.2, createdAt }],
    evidence: [],
    artifacts: [],
    sources: [],
    researchPlan: {
      id: "plan-1",
      projectId: "project-1",
      iteration: 1,
      objective: "Collect web evidence.",
      targetQuestions: ["q1"],
      targetHypotheses: ["h1"],
      requiredTools,
      expectedSources: ["web"],
      expectedArtifacts: ["fetched page"],
      executionSteps: ["Search", "Fetch"],
      stopCriteria: ["Fetched evidence exists"],
      createdAt
    },
    iteration: 1
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ToolRunner registry", () => {
  it("lists default tools and a background browser tool without duplicates", () => {
    const duplicate: ResearchTool = {
      name: "BackgroundBrowserTool",
      run: async () => {
        throw new Error("not used by this registry test");
      }
    };
    const runner = new ToolRunner(dedupeResearchTools([...createDefaultResearchTools(), duplicate, duplicate]));

    expect(runner.hasTool("ArtifactWriterTool")).toBe(true);
    expect(runner.hasTool("Data Analysis Tool")).toBe(true);
    expect(runner.hasTool("BackgroundBrowserTool")).toBe(true);
    expect(runner.hasTool("OpenCodeTool")).toBe(false);
    expect(runner.listToolNames().filter((name) => normalizeToolName(name) === "backgroundbrowsertool")).toHaveLength(1);
  });
});

describe("ToolRunner web tool pipeline", () => {
  it("chains WebSearch sources into WebFetch and only creates evidence after fetch without mutating the original input", async () => {
    const input = runInput(["WebSearchTool", "WebFetchTool"]);
    const search = new WebSearchTool();
    (search as unknown as { search: () => Promise<Array<{ title: string; url: string; snippet: string }>> }).search = async () => [
      { title: "Search result", url: "https://example.edu/study", snippet: "Discovery snippet only." }
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        url,
        headers: new Headers({ "content-type": "text/html" }),
        text: async () => "<html><title>Fetched study</title><body>Fetched page text that can become evidence.</body></html>"
      }))
    );

    const results = await new ToolRunner([search, new WebFetchTool()]).runAll(input, settings);

    expect(results).toHaveLength(2);
    expect(results[0]?.sources).toHaveLength(1);
    expect(results[0]?.evidence).toHaveLength(0);
    expect(results[1]?.evidence).toHaveLength(1);
    expect(results[1]?.artifacts).toHaveLength(0);
    expect(input.sources).toEqual([]);
    expect(input.evidence).toEqual([]);
    expect(input.artifacts).toEqual([]);
  });

  it("passes accumulated sources, evidence, artifacts, and tool runs to later tools", async () => {
    const input = runInput(["first", "second"]);
    const observed: OpenCodeRunInput[] = [];
    const first: ResearchTool = {
      name: "First",
      run: async (): Promise<ResearchToolResult> => ({
        toolRun: { id: "tool-1", projectId: "project-1", iteration: 1, toolName: "First", input: {}, output: {}, status: "completed", startedAt: createdAt, completedAt: createdAt },
        evidence: [{ id: "e1", projectId: "project-1", category: "web_source", title: "Evidence", summary: "Summary", sourceUri: "https://example.edu/a", keywords: [], linkedHypothesisIds: [], createdAt }],
        artifacts: [{ id: "a1", projectId: "project-1", category: "generated_artifact", title: "Artifact", relativePath: "artifact.md", mimeType: "text/markdown", summary: "Summary", createdAt }],
        sources: [{ id: "s1", projectId: "project-1", kind: "web", title: "Source", url: "https://example.edu/a", retrievedAt: createdAt, metadata: {}, createdAt }]
      })
    };
    const second: ResearchTool = {
      name: "Second",
      run: async (nextInput): Promise<ResearchToolResult> => {
        observed.push(nextInput);
        return {
          toolRun: { id: "tool-2", projectId: "project-1", iteration: 1, toolName: "Second", input: {}, output: {}, status: "completed", startedAt: createdAt, completedAt: createdAt },
          evidence: [],
          artifacts: [],
          sources: []
        };
      }
    };

    await new ToolRunner([first, second]).runAll(input, settings);

    expect(observed[0]?.sources).toHaveLength(1);
    expect(observed[0]?.evidence).toHaveLength(1);
    expect(observed[0]?.artifacts).toHaveLength(1);
    expect((observed[0] as OpenCodeRunInput & { toolRuns?: unknown[] }).toolRuns).toHaveLength(1);
    expect(input.sources).toEqual([]);
    expect(input.evidence).toEqual([]);
    expect(input.artifacts).toEqual([]);
  });

  it("fetches web sources before evidence URLs, dedupes normalized URLs, caps at three, and reports partial failures as completed", async () => {
    const input = {
      ...runInput(),
      sources: [
        webSource("s1", "https://Example.edu/a#section"),
        webSource("s2", "https://example.edu/a"),
        { ...webSource("s3", "https://example.edu/ignored-paper"), kind: "paper" as const },
        webSource("s4", "https://example.edu/fail")
      ],
      evidence: [
        { id: "e1", projectId: "project-1", category: "web_source" as const, title: "Evidence URL", summary: "Summary", sourceUri: "https://example.edu/evidence", keywords: [], linkedHypothesisIds: [], createdAt },
        { id: "e2", projectId: "project-1", category: "web_source" as const, title: "Capped URL", summary: "Summary", sourceUri: "https://example.edu/capped", keywords: [], linkedHypothesisIds: [], createdAt }
      ]
    };
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        if (url.includes("/fail")) {
          return { ok: false, status: 500, statusText: "Nope", url, headers: new Headers(), text: async () => "" };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          url,
          headers: new Headers({ "content-type": "text/html" }),
          text: async () => `<html><title>${url}</title><body>Readable text for ${url}</body></html>`
        };
      })
    );

    const result = await new WebFetchTool().run(input);

    expect(result.toolRun.status).toBe("completed");
    expect(fetched).toEqual(["https://Example.edu/a#section", "https://example.edu/fail", "https://example.edu/evidence"]);
    expect(result.evidence).toHaveLength(2);
    expect(result.sources).toHaveLength(2);
    expect(result.toolRun.output).toMatchObject({ fetchedPages: 2, failedUrls: ["https://example.edu/fail"] });
  });

  it("returns a failed tool run when every selected URL fails so ToolRunner rejects it", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("s1", "https://example.edu/fail")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({ ok: false, status: 503, statusText: "Unavailable", url, headers: new Headers(), text: async () => "" }))
    );

    const result = await new WebFetchTool().run(input);
    expect(result.toolRun.status).toBe("failed");
    await expect(new ToolRunner([new WebFetchTool()]).runAll(input, settings)).rejects.toThrow("WebFetchTool did not complete successfully");
  });
});

function webSource(id: string, url: string): ResearchSource {
  return { id, projectId: "project-1", kind: "web", title: id, url, retrievedAt: createdAt, metadata: {}, createdAt };
}
