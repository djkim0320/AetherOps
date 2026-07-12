import { describe, expect, it } from "vitest";
import { getToolDescriptor, plannerToolDescriptors } from "./toolDescriptors.js";

describe("tool descriptors", () => {
  it("uses one catalog for capability, phase, and strict planner input validation", () => {
    const descriptor = getToolDescriptor("WebFetchTool");

    expect(descriptor).toMatchObject({ phase: "acquisition.fetch", requiredCapabilities: ["search"], sideEffects: ["network"] });
    expect(descriptor?.inputSchema.safeParse({ urls: ["https://example.com/source"] }).success).toBe(true);
    expect(descriptor?.inputSchema.safeParse({ urls: ["https://example.com/source"], unexpected: true }).success).toBe(false);
  });

  it("excludes Codex CLI unless the job policy explicitly enables it", () => {
    const available = ["CodexCliTool", "ArtifactWriterTool"];

    expect(plannerToolDescriptors(available, { allowCodexCli: false }).map((item) => item.name)).toEqual(["ArtifactWriterTool"]);
    expect(plannerToolDescriptors(available, { allowCodexCli: true }).map((item) => item.name)).toEqual(["CodexCliTool", "ArtifactWriterTool"]);
  });
});
