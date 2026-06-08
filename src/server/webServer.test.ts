import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStrictTestOrchestrator, strictTestSettings } from "../core/testing/orchestratorTestHarness.js";
import type { ResearchProjectInput } from "../core/shared/types.js";
import { NodeProjectStorage } from "./runtime/storage/projectResearchStore.js";
import { SqliteResearchStore } from "./runtime/storage/sqliteStore.js";
import { runEngineeringProgramDirect } from "./webServer.js";

let tempDir: string | undefined;
let store: SqliteResearchStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("web server engineering program RPC", () => {
  it("runs the bundled solver and persists the direct engineering report under project reports", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-engineering-rpc-"));
    store = new SqliteResearchStore(join(tempDir, "aetherops.sqlite"));
    const settings = {
      ...strictTestSettings,
      allowExternalSearch: true,
      allowCodeExecution: true,
      engineeringTools: {
        ...strictTestSettings.engineeringTools,
        enabled: true
      }
    };
    const orchestrator = createStrictTestOrchestrator({
      store,
      storage: new NodeProjectStorage(),
      projectRootBase: join(tempDir, "projects"),
      settings
    });
    const projectInput: ResearchProjectInput = {
      goal: "Run a real WebXFOIL aerodynamic polar analysis and save the report.",
      topic: "WebXFOIL direct report persistence",
      scope: "Server RPC direct engineering program operation",
      budget: "test",
      autonomyPolicy: {
        toolApproval: "suggested",
        allowExternalSearch: true,
        allowCodeExecution: true,
        maxLoopIterations: 1
      }
    };
    const snapshot = await orchestrator.createProject(projectInput);

    const result = await runEngineeringProgramDirect(
      {
        projectId: snapshot.project.id,
        title: "Clark Y WebXFOIL polar analysis",
        question: "Run a real Clark Y bundled WebXFOIL polar analysis and persist the generated report.",
        programRequests: [
          {
            kind: "xfoil-wasm-polar",
            target: "xfoil-wasm",
            sourceUrl: "https://m-selig.ae.illinois.edu/ads/coord/clarky.dat",
            reynolds: 1_000_000,
            mach: 0,
            alphaStart: -2,
            alphaEnd: 2,
            alphaStep: 2
          }
        ]
      },
      settings,
      orchestrator
    );

    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(result.savedReportArtifact).toMatchObject({
      relativePath: "reports/engineering-program-workbench.md",
      mimeType: "text/markdown"
    });
    expect(result.reportMarkdown).toContain("# Clark Y WebXFOIL polar analysis");
    expect(result.reportMarkdown).toContain("Runtime: webxfoil-wasm");
    expect(result.reportMarkdown).toContain("Source URL: https://m-selig.ae.illinois.edu/ads/coord/clarky.dat");

    const latest = await orchestrator.getSnapshot(snapshot.project.id);
    const saved = latest.artifacts.find((artifact) => artifact.id === result.savedReportArtifact?.id);
    expect(saved).toBeDefined();
    expect(saved?.relativePath).toBe("reports/engineering-program-workbench.md");
    expect(saved?.rawPath).toBe(join(snapshot.project.projectRoot, "reports", "engineering-program-workbench.md"));
    expect(existsSync(saved?.rawPath ?? "")).toBe(true);
    const savedMarkdown = readFileSync(saved?.rawPath ?? "", "utf8");
    expect(savedMarkdown).toContain("# Clark Y WebXFOIL polar analysis");
    expect(savedMarkdown).toContain("Artifacts: 1");
    expect(savedMarkdown).toContain("Evidence items: 1");
  });

  it("rejects direct XFOIL-WASM requests that do not name an airfoil input", async () => {
    const settings = {
      ...strictTestSettings,
      allowCodeExecution: true,
      engineeringTools: {
        ...strictTestSettings.engineeringTools,
        enabled: true
      }
    };

    await expect(
      runEngineeringProgramDirect(
        {
          title: "Invalid WebXFOIL request",
          programRequests: [
            {
              kind: "xfoil-wasm-polar",
              target: "xfoil-wasm",
              reynolds: 1_000_000
            }
          ]
        },
        settings
      )
    ).rejects.toThrow("xfoil-wasm-polar requires sourceUrl, artifactPath, or naca.");
  });
});
