import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
  it("inspects OBJ mesh artifacts only from the configured modeling root", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-mesh-"));
    try {
      writeFileSync(join(tempRoot, "wing.obj"), ["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3", ""].join("\n"), "utf8");
      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "mesh-inspect", target: "modeling", artifactPath: "wing.obj" }]
      };
      const result = await new EngineeringProgramTool().run(input, {
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          modeling: { ...settings.engineeringTools.modeling, enabled: true, artifactRoot: tempRoot }
        }
      });

      expect(result.toolRun.status).toBe("completed");
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0]?.content).toContain('"vertexCount": 3');
      expect(result.artifacts[0]?.content).toContain('"triangleCount": 1');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs an XFLR5 adapter only from explicit settings and a CFD run spec", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-xflr5-run-"));
    try {
      const scriptPath = join(tempRoot, "xflr5-runner.mjs");
      writeFileSync(
        scriptPath,
        [
          "import { readFileSync, writeFileSync } from 'node:fs';",
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
      const result = await new EngineeringProgramTool().run(input, {
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
      });

      expect(result.toolRun.status).toBe("completed");
      expect(result.artifacts[0]?.content).toContain("xflr5-result.json");
      expect(result.artifacts[0]?.content).toContain("xflr5");
      expect(result.evidence[0]?.metadata).toMatchObject({ program: "xflr5", traceabilityKind: "tool_observation" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs an SU2-compatible case command only from explicit settings", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-su2-run-"));
    try {
      const caseRoot = join(tempRoot, "case");
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");
      const runnerPath = join(tempRoot, "su2-runner.mjs");
      writeFileSync(
        runnerPath,
        [
          "import { writeFileSync } from 'node:fs';",
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
      const result = await new EngineeringProgramTool().run(input, {
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
      });

      expect(result.toolRun.status).toBe("completed");
      expect(result.artifacts[0]?.content).toContain("su2-result.txt");
      expect(result.artifacts[0]?.content).toContain("cl=0.42");
      expect(result.evidence[0]?.metadata).toMatchObject({ program: "su2", traceabilityKind: "tool_observation" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for SU2 case runs without explicit config file and target", async () => {
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
      const missingConfigResult = await new EngineeringProgramTool().run(withoutConfig, {
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
      });

      expect(missingConfigResult.toolRun.status).toBe("failed");
      expect(missingConfigResult.toolRun.error).toContain("config file");
      expect(missingConfigResult.artifacts).toHaveLength(0);
      expect(missingConfigResult.evidence).toHaveLength(0);

      const withoutTarget = runInput(["EngineeringProgramTool"]);
      withoutTarget.project.autonomyPolicy.allowCodeExecution = true;
      withoutTarget.researchPlan = {
        ...withoutTarget.researchPlan!,
        programRequests: [{ kind: "su2-case-run", outputFileName: "su2-result.txt" }]
      };
      const missingTargetResult = await new EngineeringProgramTool().run(withoutTarget, {
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
      });

      expect(missingTargetResult.toolRun.status).toBe("failed");
      expect(missingTargetResult.toolRun.error).toContain("requires target su2");
      expect(missingTargetResult.artifacts).toHaveLength(0);
      expect(missingTargetResult.evidence).toHaveLength(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs an OpenVSP-compatible headless script only from explicit settings", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-openvsp-run-"));
    try {
      const scriptPath = join(tempRoot, "openvsp-runner.mjs");
      writeFileSync(
        scriptPath,
        [
          "import { readFileSync, writeFileSync } from 'node:fs';",
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
      const result = await new EngineeringProgramTool().run(input, {
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
      });

      expect(result.toolRun.status).toBe("completed");
      expect(result.artifacts[0]?.content).toContain("openvsp-result.json");
      expect(result.artifacts[0]?.content).toContain("components");
      expect(result.evidence[0]?.metadata).toMatchObject({ program: "openvsp", traceabilityKind: "tool_observation" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for XFOIL polar requests when no XFOIL command is configured", async () => {
    const input = runInput(["EngineeringProgramTool"]);
    input.project.autonomyPolicy.allowCodeExecution = true;
    input.researchPlan = {
      ...input.researchPlan!,
      programRequests: [{ kind: "xfoil-polar", target: "xfoil", naca: "2412", reynolds: 1_000_000, alphaStart: -2, alphaEnd: 4, alphaStep: 2 }]
    };

    const result = await new EngineeringProgramTool().run(input, {
      ...settings,
      allowCodeExecution: true,
      engineeringTools: {
        ...settings.engineeringTools,
        enabled: true,
        xfoil: { ...settings.engineeringTools.xfoil, enabled: false, command: "" }
      }
    });

    expect(result.toolRun.status).toBe("failed");
    expect(result.toolRun.error).toContain("embedded XFOIL executable");
    expect(result.artifacts).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);
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

  it("fails closed for SU2 case runs when the args template omits the config placeholder", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-su2-fail-"));
    try {
      const caseRoot = join(tempRoot, "case");
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");
      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "su2-case-run", target: "su2", outputFileName: "su2-result.txt", cfdRunSpec: cfdRunSpec("su2") }]
      };

      const result = await new EngineeringProgramTool().run(input, {
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
            runArgsTemplate: ["--output", "{output}"],
            probeArgs: ["--version"]
          }
        }
      });

      expect(result.toolRun.status).toBe("failed");
      expect(result.toolRun.error).toContain("{config}");
      expect(result.artifacts).toHaveLength(0);
      expect(result.evidence).toHaveLength(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for OpenVSP analysis runs when the args template omits the script placeholder", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-openvsp-fail-"));
    try {
      const scriptPath = join(tempRoot, "openvsp-runner.mjs");
      writeFileSync(scriptPath, "console.log('should not run without explicit script placeholder');\n", "utf8");
      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "openvsp-analysis-run", target: "openvsp", outputFileName: "openvsp-result.json", cfdRunSpec: cfdRunSpec("openvsp") }]
      };

      const result = await new EngineeringProgramTool().run(input, {
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
      });

      expect(result.toolRun.status).toBe("failed");
      expect(result.toolRun.error).toContain("{script}");
      expect(result.artifacts).toHaveLength(0);
      expect(result.evidence).toHaveLength(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
