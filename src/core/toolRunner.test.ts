import { describe, expect, it } from "vitest";
import { createDefaultResearchTools, type ResearchTool } from "./toolRegistry.js";
import { dedupeResearchTools, normalizeToolName, ToolRunner } from "./toolRunner.js";

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
