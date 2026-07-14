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

  it("validates explicit WebXFOIL transition policy in the shared planner schema", () => {
    const descriptor = getToolDescriptor("EngineeringProgramTool");
    const request = {
      programRequests: [
        {
          kind: "xfoil-wasm-polar",
          target: "xfoil-wasm",
          coordinateBindingId: "binding:naca0012",
          transition: { mode: "forced", upperXOverC: 0.05, lowerXOverC: 0.05, sourceEvidenceId: "NASA-TM-4074" }
        }
      ]
    };
    expect(descriptor?.inputSchema.safeParse(request).success).toBe(true);
    expect(
      descriptor?.inputSchema.safeParse({
        programRequests: [
          {
            ...request.programRequests[0],
            transition: { mode: "forced", upperXOverC: 1.2, lowerXOverC: 0.05, sourceEvidenceId: "NASA-TM-4074" }
          }
        ]
      }).success
    ).toBe(false);
  });
});
