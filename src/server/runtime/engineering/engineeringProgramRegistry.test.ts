import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResearchToolInput } from "../../../core/shared/types.js";
import { strictTestSettings } from "../../../core/testing/orchestratorTestHarness.js";
import { runEngineeringProgram } from "./engineeringProgramRegistry.js";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("engineering program durable promotion guard", () => {
  it("rejects a configured native solver before its process can create a side effect", async () => {
    root = mkdtempSync(join(tmpdir(), "aetherops-native-receipt-guard-"));
    const marker = join(root, "native-solver-ran.txt");
    const command = join(root, process.platform === "win32" ? "xfoil.cmd" : "xfoil");
    writeMarkerCommand(command, marker);
    const settings = {
      ...strictTestSettings,
      allowCodeExecution: true,
      engineeringTools: {
        ...strictTestSettings.engineeringTools,
        enabled: true,
        xfoil: { ...strictTestSettings.engineeringTools.xfoil, enabled: true, command }
      }
    };

    await expect(runEngineeringProgram(input(), settings)).rejects.toMatchObject({
      name: "RuntimeRequirementError",
      unmetRequirements: [expect.objectContaining({ key: "engineering.runtimeReceipt.xfoil", isSatisfied: false })]
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects an all-target toolchain probe because it includes receipt-unsupported processes", async () => {
    const value = input();
    value.researchPlan!.programRequests = [{ kind: "toolchain-check", target: "all" }];

    await expect(runEngineeringProgram(value, { ...strictTestSettings, allowCodeExecution: true })).rejects.toMatchObject({
      name: "RuntimeRequirementError",
      unmetRequirements: [expect.objectContaining({ key: "engineering.runtimeReceipt.all", message: expect.stringMatching(/all.*NOT_READY/i) })]
    });
  });
});

function writeMarkerCommand(path: string, marker: string): void {
  if (process.platform === "win32") {
    writeFileSync(path, `@echo off\r\n> "${marker}" echo ran\r\n`, "utf8");
    return;
  }
  writeFileSync(path, `#!/bin/sh\nprintf ran > '${marker.replace(/'/g, `'\\''`)}'\n`, "utf8");
  chmodSync(path, 0o700);
}

function input(): ResearchToolInput {
  return {
    project: {
      id: "project-native-guard",
      name: "Native guard",
      description: "Verify no native process side effect occurs.",
      status: "running",
      currentStep: "EXECUTE_TOOLS",
      maxIterations: 1,
      convergenceThreshold: 1,
      autoRunOpenCode: false,
      autonomyPolicy: { allowAgent: true, allowCodeExecution: true, allowExternalSearch: false },
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z"
    },
    questions: [],
    hypotheses: [],
    evidence: [],
    artifacts: [],
    sources: [],
    researchPlan: {
      id: "plan-native-guard",
      projectId: "project-native-guard",
      iteration: 1,
      objective: "Run native XFOIL.",
      targetQuestions: [],
      targetHypotheses: [],
      requiredTools: ["EngineeringProgramTool"],
      toolRequests: [],
      programRequests: [{ kind: "xfoil-polar", target: "xfoil", naca: "0012" }],
      expectedSources: [],
      expectedArtifacts: [],
      executionSteps: [],
      stopCriteria: [],
      createdAt: "2026-07-16T00:00:00.000Z"
    },
    iteration: 1
  };
}
