import { describe, expect, it, vi } from "vitest";
import type { ResearchTool, ResearchToolResult } from "../../../src/core/tools/researchToolTypes.js";
import { dedupeResearchTools, normalizeToolName, orderToolNames, ToolRunner, ToolRunnerError } from "../../../src/core/tools/toolRunner.js";
import { createRuntimeResearchTools as createDefaultResearchTools } from "../../../src/server/runtime/tools/defaultResearchTools.js";
import { WebFetchTool } from "../../../src/server/runtime/tools/webFetchTool.js";
import { WebSearchTool } from "../../../src/server/runtime/tools/webSearchTool.js";
import { createdAt, installToolRunnerTestCleanup, runInput, settings, webSource } from "./toolRunner.integration.support.js";

installToolRunnerTestCleanup();

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

describe("ToolRunner scheduling and availability", () => {
  it("times out web search response body parsing instead of waiting indefinitely", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "application/json" }),
        json: () => new Promise(() => undefined)
      }))
    );

    const running = new WebSearchTool().run(runInput(["WebSearchTool"]), {
      ...settings,
      webSearch: { ...settings.webSearch, endpoint: "https://93.184.216.34/search", timeoutMs: 1_000 }
    });
    const rejection = expect(running).rejects.toThrow("custom search timeout after 1000ms");
    await vi.advanceTimersByTimeAsync(1_001);

    await rejection;
  });
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

    const results = await new ToolRunner([search, new WebFetchTool()]).execute(input, settings);

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
    const seedToolRun = {
      id: "opencode-tool-1",
      projectId: "project-1",
      iteration: 1,
      toolName: "OpenCodeTool",
      input: {},
      output: {},
      status: "completed" as const,
      startedAt: createdAt,
      completedAt: createdAt
    };
    const input = {
      ...runInput(["first", "second"]),
      sources: [webSource("seed-source", "https://example.edu/seed")],
      toolRuns: [seedToolRun]
    };
    const observed: ResearchToolInput[] = [];
    const first: ResearchTool = {
      name: "First",
      run: async (): Promise<ResearchToolResult> => ({
        toolRun: {
          id: "tool-1",
          projectId: "project-1",
          iteration: 1,
          toolName: "First",
          input: {},
          output: {},
          status: "completed",
          startedAt: createdAt,
          completedAt: createdAt
        },
        evidence: [
          {
            id: "e1",
            projectId: "project-1",
            category: "web_source",
            title: "Evidence",
            summary: "Summary",
            sourceUri: "https://example.edu/a",
            keywords: [],
            linkedHypothesisIds: [],
            createdAt
          }
        ],
        artifacts: [
          {
            id: "a1",
            projectId: "project-1",
            category: "generated_artifact",
            title: "Artifact",
            relativePath: "artifact.md",
            mimeType: "text/markdown",
            summary: "Summary",
            createdAt
          }
        ],
        sources: [
          { id: "s1", projectId: "project-1", kind: "web", title: "Source", url: "https://example.edu/a", retrievedAt: createdAt, metadata: {}, createdAt }
        ]
      })
    };
    const second: ResearchTool = {
      name: "Second",
      run: async (nextInput): Promise<ResearchToolResult> => {
        observed.push(nextInput);
        return {
          toolRun: {
            id: "tool-2",
            projectId: "project-1",
            iteration: 1,
            toolName: "Second",
            input: {},
            output: {},
            status: "completed",
            startedAt: createdAt,
            completedAt: createdAt
          },
          evidence: [],
          artifacts: [],
          sources: []
        };
      }
    };

    await new ToolRunner([first, second]).execute(input, settings);

    expect(observed[0]?.sources).toHaveLength(2);
    expect(observed[0]?.evidence).toHaveLength(1);
    expect(observed[0]?.artifacts).toHaveLength(1);
    expect((observed[0] as ResearchToolInput & { toolRuns?: unknown[] }).toolRuns).toHaveLength(2);
    expect(input.sources).toHaveLength(1);
    expect(input.evidence).toEqual([]);
    expect(input.artifacts).toEqual([]);
  });

  it("orders required tools canonically so WebSearch runs before WebFetch", async () => {
    expect(orderToolNames(["WebFetchTool", "WebSearchTool", "ArtifactWriterTool"])).toEqual(["WebSearchTool", "WebFetchTool", "ArtifactWriterTool"]);
  });

  it("can run only included tools and then exclude those tools from a later pass", async () => {
    const input = runInput(["First", "Second", "Third"]);
    const calls: string[] = [];
    const makeTool = (name: string): ResearchTool => ({
      name,
      run: async (): Promise<ResearchToolResult> => {
        calls.push(name);
        return {
          toolRun: {
            id: `tool-${name}`,
            projectId: "project-1",
            iteration: 1,
            toolName: name,
            input: {},
            output: {},
            status: "completed",
            startedAt: createdAt,
            completedAt: createdAt
          },
          evidence: [],
          artifacts: [],
          sources: []
        };
      }
    });
    const runner = new ToolRunner([makeTool("First"), makeTool("Second"), makeTool("Third")]);

    const firstPass = await runner.execute(input, settings, { includeTools: ["Second"] });
    const secondPass = await runner.execute(input, settings, { excludeTools: ["Second"] });

    expect(firstPass.map((result) => result.toolRun.toolName)).toEqual(["Second"]);
    expect(secondPass.map((result) => result.toolRun.toolName)).toEqual(["First", "Third"]);
    expect(calls).toEqual(["Second", "First", "Third"]);
  });

  it("preserves partial outputs and failed tool run when a later tool fails", async () => {
    const input = runInput(["First", "Second"]);
    const first: ResearchTool = {
      name: "First",
      run: async (): Promise<ResearchToolResult> => ({
        toolRun: {
          id: "tool-1",
          projectId: "project-1",
          iteration: 1,
          toolName: "First",
          input: {},
          output: {},
          status: "completed",
          startedAt: createdAt,
          completedAt: createdAt
        },
        evidence: [],
        artifacts: [],
        sources: [webSource("s1", "https://example.edu/a")]
      })
    };
    const second: ResearchTool = {
      name: "Second",
      run: async (): Promise<ResearchToolResult> => ({
        toolRun: {
          id: "tool-2",
          projectId: "project-1",
          iteration: 1,
          toolName: "Second",
          input: {},
          output: { reason: "boom" },
          status: "failed",
          error: "boom",
          startedAt: createdAt,
          completedAt: createdAt
        },
        evidence: [],
        artifacts: [],
        sources: []
      })
    };

    try {
      await new ToolRunner([first, second]).execute(input, settings);
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
        toolRun: {
          id: "tool-1",
          projectId: "project-1",
          iteration: 1,
          toolName: "First",
          input: {},
          output: {},
          status: "completed",
          startedAt: createdAt,
          completedAt: createdAt
        },
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

    await expect(new ToolRunner([first, throwing]).execute(input, settings)).rejects.toMatchObject({
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

  it("creates a synthetic failed ToolRun when a tool returns a non-object result", async () => {
    const input = runInput(["MalformedTool"]);
    const malformed: ResearchTool = {
      name: "MalformedTool",
      run: async () => null as unknown as ResearchToolResult
    };

    try {
      await new ToolRunner([malformed]).execute(input, settings);
      throw new Error("expected ToolRunnerError");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolRunnerError);
      const toolError = error as ToolRunnerError;
      expect(toolError.message).toBe("MalformedTool returned a malformed tool result: result must be an object");
      expect(toolError.partialResults).toHaveLength(0);
      expect(toolError.failedResult?.toolRun).toMatchObject({
        toolName: "MalformedTool",
        status: "failed",
        output: { failureKind: "malformed_tool_result", evidenceFailure: true },
        error: "result must be an object"
      });
      expect(toolError.failure?.message).toBe("result must be an object");
      expect(toolError.rollingInput.toolRuns).toEqual([
        expect.objectContaining({
          toolName: "MalformedTool",
          status: "failed",
          error: "result must be an object"
        })
      ]);
    }
  });

  it("preserves prior output but does not accept a malformed returned result", async () => {
    const input = runInput(["First", "MalformedTool"]);
    const first: ResearchTool = {
      name: "First",
      run: async (): Promise<ResearchToolResult> => ({
        toolRun: {
          id: "tool-1",
          projectId: "project-1",
          iteration: 1,
          toolName: "First",
          input: {},
          output: {},
          status: "completed",
          startedAt: createdAt,
          completedAt: createdAt
        },
        evidence: [],
        artifacts: [],
        sources: [webSource("s1", "https://example.edu/a")]
      })
    };
    const malformed: ResearchTool = {
      name: "MalformedTool",
      run: async () =>
        ({
          toolRun: {
            id: "tool-malformed",
            projectId: "project-1",
            iteration: 1,
            toolName: "MalformedTool",
            input: {},
            output: {},
            status: "completed",
            startedAt: createdAt,
            completedAt: createdAt
          },
          evidence: [
            {
              id: "e-malformed",
              projectId: "project-1",
              category: "web_source",
              title: "Malformed",
              summary: "Should not be accepted",
              sourceUri: "https://example.edu/b",
              keywords: [],
              linkedHypothesisIds: [],
              createdAt
            }
          ],
          artifacts: [],
          sources: "not an array"
        }) as unknown as Promise<ResearchToolResult>
    };

    try {
      await new ToolRunner([first, malformed]).execute(input, settings);
      throw new Error("expected ToolRunnerError");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolRunnerError);
      const toolError = error as ToolRunnerError;
      expect(toolError.message).toBe("MalformedTool returned a malformed tool result: sources must be an array");
      expect(toolError.partialResults).toHaveLength(1);
      expect(toolError.failedResult?.toolRun).toMatchObject({
        toolName: "MalformedTool",
        status: "failed",
        output: { failureKind: "malformed_tool_result", evidenceFailure: true },
        error: "sources must be an array"
      });
      expect(toolError.rollingInput.sources).toHaveLength(1);
      expect(toolError.rollingInput.evidence).toHaveLength(0);
      expect(toolError.rollingInput.toolRuns).toHaveLength(2);
      expect(toolError.rollingInput.toolRuns?.[1]).toMatchObject({
        toolName: "MalformedTool",
        status: "failed",
        error: "sources must be an array"
      });
    }
  });

  it("does not accept malformed nested evidence items as usable tool evidence", async () => {
    const input = runInput(["MalformedEvidenceTool"]);
    const malformed: ResearchTool = {
      name: "MalformedEvidenceTool",
      run: async () =>
        ({
          toolRun: {
            id: "tool-malformed-evidence",
            projectId: "project-1",
            iteration: 1,
            toolName: "MalformedEvidenceTool",
            input: {},
            output: {},
            status: "completed",
            startedAt: createdAt,
            completedAt: createdAt
          },
          evidence: [
            {
              id: "e-malformed",
              projectId: "project-1",
              category: "web_source",
              title: "Malformed",
              summary: "Missing keywords and linkedHypothesisIds",
              createdAt
            }
          ],
          artifacts: [],
          sources: []
        }) as unknown as Promise<ResearchToolResult>
    };

    try {
      await new ToolRunner([malformed]).execute(input, settings);
      throw new Error("expected ToolRunnerError");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolRunnerError);
      const toolError = error as ToolRunnerError;
      expect(toolError.message).toBe("MalformedEvidenceTool returned a malformed tool result: evidence[0].keywords must be a string array");
      expect(toolError.failedResult?.toolRun).toMatchObject({
        toolName: "MalformedEvidenceTool",
        status: "failed",
        output: { failureKind: "malformed_tool_result", evidenceFailure: true },
        error: "evidence[0].keywords must be a string array"
      });
      expect(toolError.rollingInput.evidence).toEqual([]);
      expect(toolError.rollingInput.toolRuns).toEqual([
        expect.objectContaining({
          toolName: "MalformedEvidenceTool",
          status: "failed",
          error: "evidence[0].keywords must be a string array"
        })
      ]);
    }
  });
});
