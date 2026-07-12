import { describe, expect, it } from "vitest";
import { toProgramRequest } from "./registerDurableJobHandlers.js";

describe("durable engineering job request dispatch", () => {
  it("never falls an explicit Codex CLI request through to mesh-inspect", () => {
    expect(() =>
      toProgramRequest({
        target: "codex",
        objective: "Implement the requested project-local change.",
        inputs: { inputArtifactIds: [], outputs: [{ relativePath: "reports/result.md", kind: "report" }] }
      })
    ).toThrow(/explicit Codex CLI handler/);
  });

  it("keeps the explicit mesh mapping for real mesh requests", () => {
    expect(toProgramRequest({ target: "mesh", objective: "Inspect the mesh.", inputs: { artifactPath: "mesh/case.msh" } })).toMatchObject({
      kind: "mesh-inspect",
      target: "modeling",
      artifactPath: "mesh/case.msh"
    });
  });
});
