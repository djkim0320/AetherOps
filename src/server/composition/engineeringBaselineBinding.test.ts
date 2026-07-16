import { describe, expect, it } from "vitest";
import type { ConfigurationBaseline } from "../../core/aerospace/configurationBaseline.js";
import { RuntimeRequirementError } from "../../core/tools/runtimeRequirements.js";
import { assertBoundEngineeringBaseline } from "./engineeringBaselineBinding.js";

describe("durable engineering baseline binding", () => {
  it("returns only the exact active baseline frozen at enqueue", () => {
    const active = baseline();
    expect(assertBoundEngineeringBaseline({ id: active.id, revision: active.revision, contentHash: active.contentHash }, active)).toBe(active);
  });

  it.each([
    [undefined, baseline(), "no immutable engineering baseline binding"],
    [null, baseline(), "no active configuration baseline existed at enqueue"],
    [{ id: "baseline-1", revision: 1, contentHash: "a".repeat(64) }, undefined, "no longer active"],
    [{ id: "baseline-1", revision: 1, contentHash: "a".repeat(64) }, { ...baseline(), revision: 2 }, "changed after enqueue"],
    [{ id: "baseline-1", revision: 1, contentHash: "a".repeat(64) }, { ...baseline(), contentHash: "b".repeat(64) }, "changed after enqueue"]
  ] as const)("fails closed for a missing or changed binding", (binding, active, message) => {
    expect(() => assertBoundEngineeringBaseline(binding, active)).toThrow(RuntimeRequirementError);
    expect(() => assertBoundEngineeringBaseline(binding, active)).toThrow(message);
  });
});

function baseline(): ConfigurationBaseline {
  return {
    id: "baseline-1",
    projectId: "project-1",
    revision: 1,
    status: "active",
    unitConventionId: "si-v1",
    coordinateConventionId: "body-axis-v1",
    solverVersions: { codex: "0.144.1" },
    materialRevisionIds: [],
    sourceRevisionIds: ["source-1"],
    equationVersionIds: [],
    contentHash: "a".repeat(64),
    createdAt: "2026-07-16T00:00:00.000Z",
    createdBy: "test",
    provenance: [{ id: "source-1", contentHash: "c".repeat(64) }]
  };
}
