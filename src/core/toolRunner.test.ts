import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultResearchTools, DataAnalysisTool, PdfIngestionTool, WebFetchTool, WebSearchTool, type ResearchTool, type ResearchToolResult } from "./toolRegistry.js";
import { dedupeResearchTools, normalizeToolName, orderToolNames, ToolRunner, ToolRunnerError } from "./toolRunner.js";
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
    expect(results[1]?.sources).toHaveLength(1);
    expect(results[1]?.artifacts).toHaveLength(0);
    expect(input.sources).toEqual([]);
    expect(input.evidence).toEqual([]);
    expect(input.artifacts).toEqual([]);
  });

  it("passes accumulated sources, evidence, artifacts, and tool runs to later tools", async () => {
    const seedToolRun = { id: "opencode-tool-1", projectId: "project-1", iteration: 1, toolName: "OpenCodeTool", input: {}, output: {}, status: "completed" as const, startedAt: createdAt, completedAt: createdAt };
    const input = {
      ...runInput(["first", "second"]),
      sources: [webSource("seed-source", "https://example.edu/seed")],
      toolRuns: [seedToolRun]
    };
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

    expect(observed[0]?.sources).toHaveLength(2);
    expect(observed[0]?.evidence).toHaveLength(1);
    expect(observed[0]?.artifacts).toHaveLength(1);
    expect((observed[0] as OpenCodeRunInput & { toolRuns?: unknown[] }).toolRuns).toHaveLength(2);
    expect(input.sources).toHaveLength(1);
    expect(input.evidence).toEqual([]);
    expect(input.artifacts).toEqual([]);
  });

  it("orders required tools canonically so WebSearch runs before WebFetch", async () => {
    expect(orderToolNames(["WebFetchTool", "WebSearchTool", "ArtifactWriterTool"])).toEqual(["WebSearchTool", "WebFetchTool", "ArtifactWriterTool"]);
  });

  it("preserves partial outputs and failed tool run when a later tool fails", async () => {
    const input = runInput(["First", "Second"]);
    const first: ResearchTool = {
      name: "First",
      run: async (): Promise<ResearchToolResult> => ({
        toolRun: { id: "tool-1", projectId: "project-1", iteration: 1, toolName: "First", input: {}, output: {}, status: "completed", startedAt: createdAt, completedAt: createdAt },
        evidence: [],
        artifacts: [],
        sources: [webSource("s1", "https://example.edu/a")]
      })
    };
    const second: ResearchTool = {
      name: "Second",
      run: async (): Promise<ResearchToolResult> => ({
        toolRun: { id: "tool-2", projectId: "project-1", iteration: 1, toolName: "Second", input: {}, output: { reason: "boom" }, status: "failed", error: "boom", startedAt: createdAt, completedAt: createdAt },
        evidence: [],
        artifacts: [],
        sources: []
      })
    };

    try {
      await new ToolRunner([first, second]).runAll(input, settings);
      throw new Error("expected ToolRunnerError");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolRunnerError);
      const toolError = error as ToolRunnerError;
      expect(toolError.partialResults).toHaveLength(1);
      expect(toolError.partialResults[0]?.sources).toHaveLength(1);
      expect(toolError.failedResult?.toolRun.id).toBe("tool-2");
      expect(toolError.toolName).toBe("Second");
      expect(toolError.rollingInput.sources).toHaveLength(1);
      expect(toolError.rollingInput.toolRuns).toHaveLength(2);
    }
  });

  it("creates a synthetic failed ToolRun when a tool throws before returning a result", async () => {
    const input = runInput(["First", "ThrowingTool"]);
    const first: ResearchTool = {
      name: "First",
      run: async (): Promise<ResearchToolResult> => ({
        toolRun: { id: "tool-1", projectId: "project-1", iteration: 1, toolName: "First", input: {}, output: {}, status: "completed", startedAt: createdAt, completedAt: createdAt },
        evidence: [],
        artifacts: [],
        sources: [webSource("s1", "https://example.edu/a")]
      })
    };
    const throwing: ResearchTool = {
      name: "ThrowingTool",
      run: async () => {
        throw new Error("network exploded before result");
      }
    };

    await expect(new ToolRunner([first, throwing]).runAll(input, settings)).rejects.toMatchObject({
      partialResults: expect.arrayContaining([expect.objectContaining({ toolRun: expect.objectContaining({ toolName: "First" }) })]),
      failedResult: expect.objectContaining({
        toolRun: expect.objectContaining({
          toolName: "ThrowingTool",
          status: "failed",
          error: "network exploded before result"
        })
      }),
      toolName: "ThrowingTool"
    });
  });

  it("separates registered tools from currently executable tools", () => {
    const runner = new ToolRunner(createDefaultResearchTools());
    const input = runInput();
    const snapshot = {
      project: input.project,
      sources: [],
      evidence: [],
      artifacts: [],
      toolRuns: [],
      continuationDecisions: []
    } as unknown as Parameters<ToolRunner["listExecutableToolNames"]>[0]["snapshot"];

    const executable = runner.listExecutableToolNames({ snapshot, settings });

    expect(runner.listRegisteredToolNames()).toEqual(expect.arrayContaining(["PaperMetadataTool", "PdfIngestionTool"]));
    expect(executable).not.toContain("PaperMetadataTool");
    expect(executable).not.toContain("PdfIngestionTool");
    expect(executable).toEqual(expect.arrayContaining(["WebSearchTool", "WebFetchTool", "ArtifactWriterTool", "DataAnalysisTool"]));
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

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect((result.toolRun.output as { urls: string[] }).urls).toEqual(["https://Example.edu/a#section", "https://example.edu/fail", "https://example.edu/evidence"]);
    expect(fetched).toEqual(expect.arrayContaining(["https://Example.edu/a#section", "https://example.edu/fail", "https://example.edu/evidence"]));
    expect(result.evidence).toHaveLength(2);
    expect(result.sources).toHaveLength(2);
    expect(result.toolRun.output).toMatchObject({
      fetchedPages: 2,
      failedUrls: ["https://example.edu/fail"],
      failureReasons: { "https://example.edu/fail": "fetch failed for https://example.edu/fail: 500 Nope" },
      duplicateUrls: ["https://example.edu/a"],
      skippedUrls: []
    });
  });

  it("fetches from ResearchPlan.fetchCandidateUrls before source and citation candidates", async () => {
    const input = {
      ...runInput(["WebFetchTool"]),
      researchPlan: {
        ...runInput(["WebFetchTool"]).researchPlan!,
        fetchCandidateUrls: ["https://example.edu/from-plan"]
      },
      sources: [webSource("s1", "https://example.edu/from-source")],
      evidence: [
        { id: "e1", projectId: "project-1", category: "web_source" as const, title: "Citation URL", summary: "Summary", citation: "See https://example.edu/from-citation", keywords: [], linkedHypothesisIds: [], createdAt }
      ]
    };
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
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

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect((result.toolRun.output as { urls: string[] }).urls[0]).toBe("https://example.edu/from-plan");
    expect(fetched).toContain("https://example.edu/from-source");
    expect(fetched).toContain("https://example.edu/from-citation");
  });

  it("fetches up to two URLs concurrently while preserving failure mapping order", async () => {
    const input = {
      ...runInput(["WebFetchTool"]),
      sources: [
        webSource("one", "https://93.184.216.34/one"),
        webSource("two", "https://93.184.216.34/two"),
        webSource("three", "https://93.184.216.34/three")
      ]
    };
    const started: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const pending: Array<{ url: string; resolve: (value: unknown) => void }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        started.push(url);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => {
          pending.push({
            url,
            resolve: (value) => {
              inFlight -= 1;
              resolve(value);
            }
          });
        });
      })
    );

    const running = new WebFetchTool().run(input, settings);
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(started).toEqual(["https://93.184.216.34/one", "https://93.184.216.34/two"]);
    pending.find((item) => item.url.endsWith("/one"))?.resolve(successResponse("https://93.184.216.34/one"));
    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(started).toEqual(["https://93.184.216.34/one", "https://93.184.216.34/two", "https://93.184.216.34/three"]);
    pending.find((item) => item.url.endsWith("/three"))?.resolve(successResponse("https://93.184.216.34/three"));
    pending.find((item) => item.url.endsWith("/two"))?.resolve({
      ok: false,
      status: 503,
      statusText: "Slow Fail",
      url: "https://93.184.216.34/two",
      headers: new Headers(),
      text: async () => ""
    });

    const result = await running;

    expect(maxInFlight).toBe(2);
    expect(result.toolRun.status).toBe("completed");
    expect(result.evidence.map((item) => item.sourceUri)).toEqual(["https://93.184.216.34/one", "https://93.184.216.34/three"]);
    expect(result.toolRun.output).toMatchObject({
      failedUrls: ["https://93.184.216.34/two"],
      failureReasons: {
        "https://93.184.216.34/two": "fetch failed for https://93.184.216.34/two: 503 Slow Fail"
      }
    });
  });

  it("blocks internal WebFetch URLs before fetch and records failure reasons", async () => {
    const input = {
      ...runInput(["WebFetchTool"]),
      sources: [
        webSource("localhost", "http://localhost/admin"),
        webSource("loopback", "http://127.0.0.1/admin"),
        webSource("private", "http://10.1.2.3/admin"),
        webSource("internal", "https://service.internal/status")
      ]
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.sources).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);
    expect(result.toolRun.output).toMatchObject({
      fetchedPages: 0,
      failedUrls: ["http://localhost/admin", "http://127.0.0.1/admin", "http://10.1.2.3/admin"],
      skippedUrls: [],
      duplicateUrls: []
    });
    expect((result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons["http://localhost/admin"]).toContain("blocked internal hostname");
    expect((result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons["http://127.0.0.1/admin"]).toContain("blocked internal IP address");
  });

  it("rejects unsafe redirects, unsupported content types, and oversized responses", async () => {
    const input = {
      ...runInput(["WebFetchTool"]),
      sources: [
        webSource("redirect", "https://example.edu/redirect"),
        webSource("image", "https://example.edu/image"),
        webSource("large", "https://example.edu/large")
      ]
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(init?.signal).toBeDefined();
        if (url.includes("/redirect")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            url: "http://127.0.0.1/metadata",
            headers: new Headers({ "content-type": "text/html" }),
            text: async () => "<html><title>Redirected</title><body>Internal redirect.</body></html>"
          };
        }
        if (url.includes("/image")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            url,
            headers: new Headers({ "content-type": "image/png" }),
            text: async () => "not text"
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          url,
          headers: new Headers({ "content-type": "text/plain", "content-length": String(2 * 1024 * 1024 + 1) }),
          text: async () => "oversized"
        };
      })
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("failed");
    expect(result.sources).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);
    const output = result.toolRun.output as { failedUrls: string[]; failureReasons: Record<string, string>; fetchedPages: number };
    expect(output.fetchedPages).toBe(0);
    expect(output.failedUrls).toEqual(["https://example.edu/redirect", "https://example.edu/image", "https://example.edu/large"]);
    expect(output.failureReasons["https://example.edu/redirect"]).toContain("blocked internal IP address");
    expect(output.failureReasons["https://example.edu/image"]).toContain("unsupported content-type");
    expect(output.failureReasons["https://example.edu/large"]).toContain("content-length exceeds 2MB");
  });

  it("returns a failed tool run when every selected URL fails so ToolRunner rejects it", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("s1", "https://example.edu/fail")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({ ok: false, status: 503, statusText: "Unavailable", url, headers: new Headers(), text: async () => "" }))
    );

    const result = await new WebFetchTool().run(input, settings);
    expect(result.toolRun.status).toBe("failed");
    await expect(new ToolRunner([new WebFetchTool()]).runAll(input, settings)).rejects.toBeInstanceOf(ToolRunnerError);
  });

  it("blocks WebFetchTool direct runs when external search is disabled", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("s1", "https://example.edu/a")] };
    await expect(new WebFetchTool().run(input, { ...settings, allowExternalSearch: false })).rejects.toThrow("external network access");
  });

  it("blocks private or local fetch targets before calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const blockedUrls = [
      "http://localhost:3000",
      "http://127.0.0.1",
      "http://169.254.169.254"
    ];

    const result = await new WebFetchTool().run(
      { ...runInput(["WebFetchTool"]), sources: blockedUrls.map((url, index) => webSource(`blocked-${index}`, url)) },
      settings
    );

    expect(result.toolRun.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.toolRun.output).toMatchObject({ failedUrls: blockedUrls });
  });

  it("blocks IPv6 private, loopback, unspecified, and multicast fetch targets before calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const blockedUrls = [
      "http://[::1]",
      "http://[::]",
      "http://[fc00::1]"
    ];

    const result = await new WebFetchTool().run(
      { ...runInput(["WebFetchTool"]), sources: blockedUrls.map((url, index) => webSource(`blocked-${index}`, url)) },
      settings
    );

    expect(result.toolRun.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.toolRun.output).toMatchObject({ failedUrls: blockedUrls });
  });

  it("blocks IPv6 link-local and multicast fetch targets before calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const blockedUrls = ["http://[fe80::1]", "http://[ff02::1]"];

    const result = await new WebFetchTool().run(
      { ...runInput(["WebFetchTool"]), sources: blockedUrls.map((url, index) => webSource(`blocked-v6-${index}`, url)) },
      settings
    );

    expect(result.toolRun.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.toolRun.output).toMatchObject({ failedUrls: blockedUrls });
  });

  it("records body read timeout for slow HTML response streams", async () => {
    vi.useFakeTimers();
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("slow", "https://93.184.216.34/slow")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        url,
        headers: new Headers({ "content-type": "text/html" }),
        body: {
          getReader: () => ({
            read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
            cancel: () => Promise.resolve()
          })
        }
      }))
    );

    const pending = new WebFetchTool().run(input, settings);
    await vi.advanceTimersByTimeAsync(10_050);
    const result = await pending;

    expect(result.toolRun.status).toBe("failed");
    expect((result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons["https://93.184.216.34/slow"]).toContain("body read timeout");
  });

  it("records PDF body read timeout for slow PDF streams", async () => {
    vi.useFakeTimers();
    const input = {
      ...runInput(["PdfIngestionTool"]),
      researchPlan: { ...runInput(["PdfIngestionTool"]).researchPlan!, fetchCandidateUrls: ["https://93.184.216.34/paper.pdf"] }
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        url,
        headers: new Headers({ "content-type": "application/pdf" }),
        body: {
          getReader: () => ({
            read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
            cancel: () => Promise.resolve()
          })
        }
      }))
    );

    const pending = new PdfIngestionTool().run(input, settings);
    await vi.advanceTimersByTimeAsync(10_050);
    const result = await pending;

    expect(result.toolRun.status).toBe("failed");
    expect((result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons["https://93.184.216.34/paper.pdf"]).toContain("PDF body read timeout");
  });

  it("rejects oversized and non-text responses without creating evidence", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("s1", "https://example.com/huge"), webSource("s2", "https://example.com/image")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        url,
        headers: url.includes("huge")
          ? new Headers({ "content-type": "text/html", "content-length": String(2 * 1024 * 1024 + 1) })
          : new Headers({ "content-type": "image/png" }),
        text: async () => "should not become evidence"
      }))
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("failed");
    expect(result.evidence).toHaveLength(0);
    expect(Object.values((result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons).join(" ")).toMatch(/content-length|content-type/);
  });
});

describe("DataAnalysisTool", () => {
  it("returns expanded distributions and does not create evidence", async () => {
    const input = {
      ...runInput(["DataAnalysisTool"]),
      evidence: [
        { id: "e1", projectId: "project-1", category: "web_source" as const, title: "Evidence 1", summary: "Summary", citation: "Citation", sourceUri: "https://example.edu/one", keywords: ["scholarly"], linkedHypothesisIds: ["h1"], createdAt },
        { id: "e2", projectId: "project-1", category: "web_source" as const, title: "Evidence 2", summary: "Summary", keywords: ["weak"], linkedHypothesisIds: [], createdAt }
      ],
      sources: [webSource("s1", "https://example.edu/one")],
      artifacts: [{ id: "a1", projectId: "project-1", category: "generated_artifact" as const, title: "Artifact", relativePath: "artifact.md", mimeType: "text/markdown", summary: "Summary", createdAt }],
      toolRuns: [{ id: "tool-1", projectId: "project-1", iteration: 1, toolName: "WebFetchTool", input: {}, output: {}, status: "completed" as const, startedAt: createdAt, completedAt: createdAt }],
      normalizedRecords: [
        {
          id: "r1",
          projectId: "project-1",
          memoryScope: "global" as const,
          validationStatus: "validated" as const,
          iteration: 1,
          kind: "evidence" as const,
          title: "Record 1",
          content: "Record content",
          evidenceId: "e1",
          metadata: { canSupportHypothesis: true, sourceQualityTier: "scholarly", traceabilityKind: "external_source" },
          createdAt
        },
        {
          id: "r2",
          projectId: "project-1",
          memoryScope: "project_only" as const,
          validationStatus: "rejected" as const,
          iteration: 1,
          kind: "artifact" as const,
          title: "Record 2",
          content: "Record content",
          metadata: { canSupportHypothesis: false, sourceQualityTier: "weak", traceabilityKind: "internal_artifact" },
          createdAt
        }
      ],
      validationResults: [
        {
          id: "v1",
          projectId: "project-1",
          iteration: 1,
          hypothesisId: "h1",
          status: "partially_supported" as const,
          confidence: 0.5,
          supportingEvidenceIds: ["e1"],
          contradictingEvidenceIds: [],
          relatedEntityIds: [],
          relatedRelationIds: [],
          reasoningSummary: "Partial support.",
          limitations: [],
          evidenceGaps: ["Need a stronger source."],
          createdAt
        }
      ]
    };

    const result = await new DataAnalysisTool().run(input);

    expect(result.evidence).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.artifacts).toEqual([]);
    expect(result.toolRun.output).toMatchObject({
      evidenceCount: 2,
      supportEligibleEvidenceCount: 1,
      citationCoverage: 0.5,
      sourceQualityDistribution: { scholarly: 2, weak: 2 },
      traceabilityKindDistribution: { external_source: 1, internal_artifact: 1 },
      hypothesisEvidenceCoverage: { h1: { linkedEvidenceCount: 1, supportEligibleEvidenceCount: 1 } },
      validationStatusDistribution: { partially_supported: 1 },
      iterationGrowthSummary: {
        iteration: 1,
        evidenceCount: 2,
        artifactCount: 1,
        sourceCount: 1,
        toolRunCount: 1,
        normalizedRecordCount: 2,
        validationResultCount: 1,
        projectContextSnapshotCount: 0,
        synthesizedResultCount: 0
      },
      inputAvailability: {
        normalizedRecordCount: 2,
        validationResultCount: 1,
        projectContextSnapshotCount: 0,
        resultCount: 0
      },
      missingInputWarnings: ["projectContextSnapshots input was not available; context coverage analysis may be incomplete."],
      evidenceGapsFromLatestValidation: ["Need a stronger source."]
    });
  });

  it("reports missing analysis inputs explicitly", async () => {
    const result = await new DataAnalysisTool().run({ ...runInput(["DataAnalysisTool"]), evidence: [] });

    expect(result.toolRun.output).toMatchObject({
      supportEligibleEvidenceCount: 0,
      inputAvailability: {
        normalizedRecordCount: 0,
        validationResultCount: 0,
        projectContextSnapshotCount: 0
      },
      missingInputWarnings: expect.arrayContaining([
        "normalizedRecords input was not available; support eligibility may be undercounted.",
        "validationResults input was not available; latest evidence gaps may be incomplete."
      ])
    });
  });
});

function webSource(id: string, url: string): ResearchSource {
  return { id, projectId: "project-1", kind: "web", title: id, url, retrievedAt: createdAt, metadata: {}, createdAt };
}

function successResponse(url: string): unknown {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url,
    headers: new Headers({ "content-type": "text/html" }),
    text: async () => `<html><title>${url}</title><body>Readable text for ${url}</body></html>`
  };
}
