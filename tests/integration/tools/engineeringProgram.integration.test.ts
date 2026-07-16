import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScriptedCfdConfig } from "../../../src/core/tools/engineeringProgramTypes.js";
import { validateCustomScriptedCfdTemplate } from "../../../src/server/runtime/engineering/engineeringProgramScriptedCfdAdapter.js";
import { runSu2Case, validateSu2CaseConfig, validateSu2RunArgsTemplate } from "../../../src/server/runtime/engineering/engineeringProgramSu2Adapter.js";
import {
  CLARK_Y_COORDINATES,
  EngineeringProgramTool,
  cfdRunSpec,
  createdAt,
  installToolRunnerTestCleanup,
  runInput,
  settings
} from "./toolRunner.integration.support.js";

installToolRunnerTestCleanup();

describe("Engineering program adapters", () => {
  it("rejects mesh inspection before reading or changing the configured modeling root", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-mesh-"));
    try {
      writeFileSync(join(tempRoot, "wing.obj"), ["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3", ""].join("\n"), "utf8");
      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "mesh-inspect", target: "modeling", artifactPath: "wing.obj" }]
      };
      await expectNativeRuntimeNotReady(
        new EngineeringProgramTool().run(input, {
          ...settings,
          allowCodeExecution: true,
          engineeringTools: {
            ...settings.engineeringTools,
            enabled: true,
            modeling: { ...settings.engineeringTools.modeling, enabled: true, artifactRoot: tempRoot }
          }
        }),
        "mesh"
      );
      expect(readdirSync(tempRoot)).toEqual(["wing.obj"]);
      expect(readFileSync(join(tempRoot, "wing.obj"), "utf8")).toBe(["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3", ""].join("\n"));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects an explicitly configured XFLR5 adapter before its process can run", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-xflr5-run-"));
    try {
      const scriptPath = join(tempRoot, "xflr5-runner.mjs");
      const markerPath = join(tempRoot, "xflr5-ran.txt");
      writeFileSync(
        scriptPath,
        [
          "import { readFileSync, writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(markerPath)}, 'ran', 'utf8');`,
          "const specIndex = process.argv.indexOf('--spec');",
          "const outputIndex = process.argv.indexOf('--output');",
          "if (specIndex < 0 || outputIndex < 0) process.exit(2);",
          "const spec = JSON.parse(readFileSync(process.argv[specIndex + 1], 'utf8'));",
          "writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ program: 'xflr5', target: spec.target, alpha: spec.flightCondition.alphaStart }) + '\\n', 'utf8');",
          "console.log('XFLR5 harness completed');"
        ].join("\n"),
        "utf8"
      );

      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "xflr5-analysis-run", target: "xflr5", outputFileName: "xflr5-result.json", cfdRunSpec: cfdRunSpec("xflr5") }]
      };
      await expectNativeRuntimeNotReady(
        new EngineeringProgramTool().run(input, {
          ...settings,
          allowCodeExecution: true,
          engineeringTools: {
            ...settings.engineeringTools,
            enabled: true,
            xflr5: {
              ...settings.engineeringTools.xflr5,
              enabled: true,
              command: process.execPath,
              scriptPath,
              runArgsTemplate: ["{script}", "--spec", "{spec}", "--output", "{output}"],
              probeArgs: ["--version"]
            }
          }
        }),
        "xflr5"
      );
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects an explicitly configured SU2 case before its process can run", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-su2-run-"));
    try {
      const caseRoot = join(tempRoot, "case");
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");
      const runnerPath = join(tempRoot, "su2-runner.mjs");
      const markerPath = join(tempRoot, "su2-ran.txt");
      writeFileSync(
        runnerPath,
        [
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(markerPath)}, 'ran', 'utf8');`,
          "const outputIndex = process.argv.indexOf('--output');",
          "const configPath = process.argv[2];",
          "if (!configPath || outputIndex < 0) process.exit(2);",
          "writeFileSync(process.argv[outputIndex + 1], `config=${configPath}\\ncl=0.42\\n`, 'utf8');",
          "console.log('SU2 harness completed');"
        ].join("\n"),
        "utf8"
      );

      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "su2-case-run", target: "su2", outputFileName: "su2-result.txt", cfdRunSpec: cfdRunSpec("su2") }]
      };
      await expectNativeRuntimeNotReady(
        new EngineeringProgramTool().run(input, {
          ...settings,
          allowCodeExecution: true,
          engineeringTools: {
            ...settings.engineeringTools,
            enabled: true,
            su2: {
              ...settings.engineeringTools.su2,
              enabled: true,
              command: process.execPath,
              caseRoot,
              configFile: "case.cfg",
              runArgsTemplate: [runnerPath, "{config}", "--output", "{output}"],
              probeArgs: ["--version"]
            }
          }
        }),
        "su2"
      );
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects SU2 before config access while still rejecting a missing target at schema validation", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-su2-explicit-contract-"));
    try {
      const caseRoot = join(tempRoot, "case");
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");

      const withoutConfig = runInput(["EngineeringProgramTool"]);
      withoutConfig.project.autonomyPolicy.allowCodeExecution = true;
      withoutConfig.researchPlan = {
        ...withoutConfig.researchPlan!,
        programRequests: [{ kind: "su2-case-run", target: "su2", outputFileName: "su2-result.txt", cfdRunSpec: cfdRunSpec("su2") }]
      };
      await expectNativeRuntimeNotReady(
        new EngineeringProgramTool().run(withoutConfig, {
          ...settings,
          allowCodeExecution: true,
          engineeringTools: {
            ...settings.engineeringTools,
            enabled: true,
            su2: {
              ...settings.engineeringTools.su2,
              enabled: true,
              command: process.execPath,
              caseRoot,
              configFile: "",
              runArgsTemplate: ["{config}", "--output", "{output}"],
              probeArgs: ["--version"]
            }
          }
        }),
        "su2"
      );
      expect(() => validateSu2CaseConfig(caseRoot, "")).toThrow("SU2 case config file is not configured");

      const withoutTarget = runInput(["EngineeringProgramTool"]);
      withoutTarget.project.autonomyPolicy.allowCodeExecution = true;
      withoutTarget.researchPlan = {
        ...withoutTarget.researchPlan!,
        programRequests: [{ kind: "su2-case-run", outputFileName: "su2-result.txt" }]
      };
      await expect(
        new EngineeringProgramTool().run(withoutTarget, {
          ...settings,
          allowCodeExecution: true,
          engineeringTools: {
            ...settings.engineeringTools,
            enabled: true,
            su2: {
              ...settings.engineeringTools.su2,
              enabled: true,
              command: process.execPath,
              caseRoot,
              configFile: "case.cfg",
              runArgsTemplate: ["{config}", "--output", "{output}"],
              probeArgs: ["--version"]
            }
          }
        })
      ).rejects.toThrow("requires target=su2");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects an explicitly configured OpenVSP script before its process can run", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-openvsp-run-"));
    try {
      const scriptPath = join(tempRoot, "openvsp-runner.mjs");
      const markerPath = join(tempRoot, "openvsp-ran.txt");
      writeFileSync(
        scriptPath,
        [
          "import { readFileSync, writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(markerPath)}, 'ran', 'utf8');`,
          "const specIndex = process.argv.indexOf('--spec');",
          "const outputIndex = process.argv.indexOf('--output');",
          "if (specIndex < 0 || outputIndex < 0) process.exit(2);",
          "const spec = JSON.parse(readFileSync(process.argv[specIndex + 1], 'utf8'));",
          "writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ program: 'openvsp', target: spec.target, components: 2, units: 'm' }) + '\\n', 'utf8');",
          "console.log('OpenVSP harness completed');"
        ].join("\n"),
        "utf8"
      );

      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "openvsp-analysis-run", target: "openvsp", outputFileName: "openvsp-result.json", cfdRunSpec: cfdRunSpec("openvsp") }]
      };
      await expectNativeRuntimeNotReady(
        new EngineeringProgramTool().run(input, {
          ...settings,
          allowCodeExecution: true,
          engineeringTools: {
            ...settings.engineeringTools,
            enabled: true,
            openVsp: {
              ...settings.engineeringTools.openVsp,
              enabled: true,
              command: process.execPath,
              scriptPath,
              runArgsTemplate: ["{script}", "--spec", "{spec}", "--output", "{output}"],
              probeArgs: ["--version"]
            }
          }
        }),
        "openvsp"
      );
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects an explicitly configured native XFOIL command before its process can run", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-xfoil-native-"));
    try {
      const markerPath = join(tempRoot, "xfoil-ran.txt");
      const commandPath = join(tempRoot, process.platform === "win32" ? "xfoil.cmd" : "xfoil");
      writeMarkerCommand(commandPath, markerPath);
      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "xfoil-polar", target: "xfoil", naca: "2412", reynolds: 1_000_000, alphaStart: -2, alphaEnd: 4, alphaStep: 2 }]
      };

      await expectNativeRuntimeNotReady(
        new EngineeringProgramTool().run(input, {
          ...settings,
          allowCodeExecution: true,
          engineeringTools: {
            ...settings.engineeringTools,
            enabled: true,
            xfoil: { ...settings.engineeringTools.xfoil, enabled: true, command: commandPath }
          }
        }),
        "xfoil"
      );
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs bundled WebXFOIL on Clark Y coordinates without a local xfoil executable", async () => {
    const clarkYUrl = "https://m-selig.ae.illinois.edu/ads/coord/clarky.dat";
    const input = {
      ...runInput(["EngineeringProgramTool"]),
      sources: [
        {
          id: "source-clark-y-stale",
          projectId: "project-1",
          kind: "web" as const,
          title: "Stale CLARK Y AIRFOIL",
          url: clarkYUrl,
          retrievedAt: createdAt,
          metadata: { rawText: "CLARK Y AIRFOIL 61.0 61.0 0.0000000 0.0000000", contentType: "text/plain", fetchStatus: "fetched" },
          createdAt
        },
        {
          id: "source-clark-y",
          projectId: "project-1",
          kind: "web" as const,
          title: "CLARK Y AIRFOIL",
          url: clarkYUrl,
          retrievedAt: createdAt,
          metadata: { rawText: CLARK_Y_COORDINATES, contentType: "text/plain", fetchStatus: "fetched" },
          createdAt
        }
      ]
    };
    input.project.autonomyPolicy.allowCodeExecution = true;
    input.researchPlan = {
      ...input.researchPlan!,
      programRequests: [
        {
          kind: "xfoil-wasm-polar",
          target: "xfoil-wasm",
          sourceUrl: clarkYUrl,
          reynolds: 1_000_000,
          mach: 0,
          alphaStart: -2,
          alphaEnd: 2,
          alphaStep: 2
        }
      ]
    };

    const result = await new EngineeringProgramTool().run(input, {
      ...settings,
      allowCodeExecution: true,
      engineeringTools: {
        ...settings.engineeringTools,
        enabled: true
      }
    });

    expect(result.toolRun.status).toBe("completed");
    expect(result.artifacts).toHaveLength(1);
    const summary = JSON.parse(result.artifacts[0]?.content ?? "{}") as {
      airfoil?: string;
      rowCount?: number;
      rows?: Array<{ alpha: number; cl: number; cd: number }>;
      runtime?: string;
      sourceUrl?: string;
    };
    expect(summary.runtime).toBe("webxfoil-wasm");
    expect(summary.airfoil).toContain("CLARK Y");
    expect(summary.sourceUrl).toBe(clarkYUrl);
    expect(summary.rowCount).toBeGreaterThanOrEqual(2);
    expect(summary.rows?.some((row) => row.alpha === 0 && Number.isFinite(row.cl) && Number.isFinite(row.cd))).toBe(true);
    expect(result.evidence[0]?.metadata).toMatchObject({ program: "xfoil-wasm", traceabilityKind: "tool_observation", sourceUrl: clarkYUrl });
  });

  it("rejects an invalid SU2 command contract at the native runtime receipt gate without execution", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-su2-fail-"));
    try {
      const caseRoot = join(tempRoot, "case");
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");
      const markerPath = join(tempRoot, "su2-invalid-contract-ran.txt");
      const commandPath = join(tempRoot, process.platform === "win32" ? "su2.cmd" : "su2");
      writeMarkerCommand(commandPath, markerPath);
      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "su2-case-run", target: "su2", outputFileName: "su2-result.txt", cfdRunSpec: cfdRunSpec("su2") }]
      };
      const executionSettings = {
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          su2: {
            ...settings.engineeringTools.su2,
            enabled: true,
            command: commandPath,
            caseRoot,
            configFile: "case.cfg",
            runArgsTemplate: ["--output", "{output}"],
            probeArgs: ["--version"]
          }
        }
      };

      await expectNativeRuntimeNotReady(new EngineeringProgramTool().run(input, executionSettings), "su2");
      expect(existsSync(markerPath)).toBe(false);
      await expect(runSu2Case(input.researchPlan.programRequests![0]!, executionSettings)).rejects.toThrow("must include {config}");
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects an invalid OpenVSP command contract at the native runtime receipt gate without execution", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-openvsp-fail-"));
    try {
      const scriptPath = join(tempRoot, "openvsp-runner.mjs");
      const markerPath = join(tempRoot, "openvsp-invalid-contract-ran.txt");
      writeFileSync(scriptPath, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "ran", "utf8");\n`, "utf8");
      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "openvsp-analysis-run", target: "openvsp", outputFileName: "openvsp-result.json", cfdRunSpec: cfdRunSpec("openvsp") }]
      };
      const executionSettings = {
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          openVsp: {
            ...settings.engineeringTools.openVsp,
            enabled: true,
            command: process.execPath,
            scriptPath,
            runArgsTemplate: ["--output", "{output}"],
            probeArgs: ["--version"]
          }
        }
      };

      await expectNativeRuntimeNotReady(new EngineeringProgramTool().run(input, executionSettings), "openvsp");
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "SU2 empty template", validate: () => validateSu2RunArgsTemplate([]), expected: /not configured/ },
    { name: "SU2 missing config", validate: () => validateSu2RunArgsTemplate(["--output", "{output}"]), expected: /must include \{config\}/ },
    {
      name: "OpenVSP empty template",
      validate: () => validateCustomScriptedCfdTemplate(scriptedTemplate("openvsp", [])),
      expected: /not configured/
    },
    {
      name: "OpenVSP missing script",
      validate: () => validateCustomScriptedCfdTemplate(scriptedTemplate("openvsp", ["--spec", "{spec}"])),
      expected: /must include \{script\}/
    },
    {
      name: "OpenVSP missing spec",
      validate: () => validateCustomScriptedCfdTemplate(scriptedTemplate("openvsp", ["--script", "{script}"])),
      expected: /must include \{spec\}/
    },
    {
      name: "XFLR5 empty template",
      validate: () => validateCustomScriptedCfdTemplate(scriptedTemplate("xflr5", [])),
      expected: /not configured/
    },
    {
      name: "XFLR5 missing script",
      validate: () => validateCustomScriptedCfdTemplate(scriptedTemplate("xflr5", ["--spec", "{spec}"])),
      expected: /must include \{script\}/
    },
    {
      name: "XFLR5 missing spec",
      validate: () => validateCustomScriptedCfdTemplate(scriptedTemplate("xflr5", ["--script", "{script}"])),
      expected: /must include \{spec\}/
    }
  ])("preserves $name validation independently of the runtime receipt gate", ({ validate, expected }) => {
    expect(validate).toThrow(expected);
  });
});

async function expectNativeRuntimeNotReady(operation: Promise<unknown>, target: "mesh" | "xflr5" | "su2" | "openvsp" | "xfoil"): Promise<void> {
  await expect(operation).rejects.toMatchObject({
    name: "RuntimeRequirementError",
    step: "EXECUTE_TOOLS",
    message: expect.stringMatching(new RegExp(`${target}.*NOT_READY`, "i")),
    unmetRequirements: [
      expect.objectContaining({
        key: `engineering.runtimeReceipt.${target}`,
        isSatisfied: false,
        message: expect.stringMatching(/NOT_READY/)
      })
    ]
  });
}

function writeMarkerCommand(path: string, marker: string): void {
  if (process.platform === "win32") {
    writeFileSync(path, `@echo off\r\n> "${marker}" echo ran\r\n`, "utf8");
    return;
  }
  writeFileSync(path, `#!/bin/sh\nprintf ran > '${marker.replace(/'/g, `'\\''`)}'\n`, "utf8");
  chmodSync(path, 0o700);
}

function scriptedTemplate(target: "openvsp" | "xflr5", runArgsTemplate: string[]): ScriptedCfdConfig {
  return {
    target,
    label: target === "openvsp" ? "OpenVSP" : "XFLR5",
    command: "not-executed",
    scriptPath: "not-read.mjs",
    workingDirectory: "",
    probeArgs: [],
    runArgsTemplate,
    timeoutMs: 1_000
  };
}
