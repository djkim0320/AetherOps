import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildServerRuntimeToolDiagnostics as buildRuntimeToolDiagnostics } from "../../../src/server/runtime/engineering/runtimeEngineeringDiagnostics.js";
import { runEngineeringProgramPreflight } from "../../../src/server/runtime/engineering/engineeringProgramRegistry.js";
import { ResearchMetadataTool } from "../../../src/server/runtime/tools/researchMetadataTool.js";
import { CLARK_Y_COORDINATES, installToolRunnerTestCleanup, runInput, settings } from "./toolRunner.integration.support.js";

installToolRunnerTestCleanup();

describe("Runtime tool diagnostics and research metadata", () => {
  it("builds runtime tool diagnostics without exposing unavailable tool availability", () => {
    const blocked = buildRuntimeToolDiagnostics(settings);
    expect(blocked.researchMetadata.ready).toBe(true);
    expect(blocked.executableTools).toContain("ResearchMetadataTool");
    expect(blocked.executableTools).not.toContain("EngineeringProgramTool");
    expect(blocked.engineeringArtifactCandidates).toEqual([]);
    expect(blocked.engineeringPrograms.find((capability) => capability.target === "xfoil")?.blockedReason).toContain("Code execution");
    expect(blocked.engineeringProgramRequestTemplates.find((template) => template.id === "xfoil-polar:xfoil")?.ready).toBe(false);
    expect(blocked.engineeringProgramRequestTemplates.find((template) => template.id === "xfoil-polar:xfoil")?.request).toMatchObject({
      kind: "xfoil-polar",
      target: "xfoil"
    });

    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-diagnostics-mesh-"));
    try {
      const su2CaseRoot = join(tempRoot, "su2-case");
      mkdirSync(su2CaseRoot, { recursive: true });
      writeFileSync(join(su2CaseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");
      const openVspScriptPath = join(tempRoot, "openvsp-script.mjs");
      writeFileSync(openVspScriptPath, "console.log('OpenVSP harness ready');\n", "utf8");
      const xflr5ScriptPath = join(tempRoot, "xflr5-script.mjs");
      writeFileSync(xflr5ScriptPath, "console.log('XFLR5 harness ready');\n", "utf8");
      writeFileSync(join(tempRoot, "wing.obj"), ["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3", ""].join("\n"), "utf8");
      writeFileSync(join(tempRoot, "clarky.dat"), CLARK_Y_COORDINATES, "utf8");
      writeFileSync(join(tempRoot, "invalid.obj"), "not a mesh\n", "utf8");
      writeFileSync(join(tempRoot, "oversize.stl"), "solid oversize\n".repeat(2_000), "utf8");

      const configured = buildRuntimeToolDiagnostics({
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          modeling: { ...settings.engineeringTools.modeling, enabled: true, artifactRoot: tempRoot, maxMeshBytes: 16 * 1024 },
          su2: {
            ...settings.engineeringTools.su2,
            enabled: true,
            command: process.execPath,
            caseRoot: su2CaseRoot,
            configFile: "case.cfg",
            probeArgs: ["--version"],
            runArgsTemplate: ["{config}", "--output", "{output}"]
          },
          openVsp: {
            ...settings.engineeringTools.openVsp,
            enabled: true,
            command: process.execPath,
            scriptPath: openVspScriptPath,
            runArgsTemplate: ["{script}", "--spec", "{spec}", "--output", "{output}"]
          },
          xflr5: {
            ...settings.engineeringTools.xflr5,
            enabled: true,
            command: process.execPath,
            scriptPath: xflr5ScriptPath,
            runArgsTemplate: ["--script", "{script}", "--spec", "{spec}", "--output", "{output}"]
          }
        }
      });

      expect(configured.executableTools).toContain("EngineeringProgramTool");
      expect(configured.engineeringArtifactCandidates.find((candidate) => candidate.relativePath === "wing.obj")).toMatchObject({
        ready: true,
        validated: true,
        format: "obj"
      });
      expect(configured.engineeringArtifactCandidates.find((candidate) => candidate.relativePath === "clarky.dat")).toMatchObject({
        ready: true,
        validated: true,
        format: "airfoil-coordinate"
      });
      expect(configured.engineeringArtifactCandidates.find((candidate) => candidate.relativePath === "invalid.obj")).toMatchObject({
        ready: false,
        validated: false,
        format: "obj",
        blockedReason: expect.stringContaining("validation failed")
      });
      expect(configured.engineeringArtifactCandidates.find((candidate) => candidate.relativePath === "oversize.stl")).toMatchObject({
        ready: false,
        validated: false,
        format: "stl"
      });
      expect(configured.engineeringPrograms.find((capability) => capability.target === "su2")?.ready).toBe(true);
      expect(configured.engineeringPrograms.find((capability) => capability.target === "openvsp")?.ready).toBe(true);
      expect(configured.engineeringPrograms.find((capability) => capability.target === "xflr5")?.ready).toBe(true);
      expect(configured.engineeringProgramRequestTemplates.find((template) => template.id === "mesh-inspect:modeling")).toMatchObject({
        ready: true,
        request: { kind: "mesh-inspect", target: "modeling" }
      });
      expect(configured.engineeringProgramRequestTemplates.find((template) => template.id === "su2-case-run:su2")).toMatchObject({
        ready: true,
        request: { kind: "su2-case-run", target: "su2", outputFileName: "su2-run-output.txt", cfdRunSpec: expect.any(Object) }
      });
      expect(configured.engineeringProgramRequestTemplates.find((template) => template.id === "openvsp-analysis-run:openvsp")).toMatchObject({
        ready: true,
        request: { kind: "openvsp-analysis-run", target: "openvsp", outputFileName: "openvsp-analysis-output.json", cfdRunSpec: expect.any(Object) }
      });
      expect(configured.engineeringProgramRequestTemplates.find((template) => template.id === "xflr5-analysis-run:xflr5")).toMatchObject({
        ready: true,
        request: { kind: "xflr5-analysis-run", target: "xflr5", outputFileName: "xflr5-analysis-output.json", cfdRunSpec: expect.any(Object) }
      });
      const missingSu2RunArgs = buildRuntimeToolDiagnostics({
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          su2: {
            ...settings.engineeringTools.su2,
            enabled: true,
            command: process.execPath,
            caseRoot: su2CaseRoot,
            configFile: "case.cfg",
            runArgsTemplate: []
          }
        }
      });
      expect(missingSu2RunArgs.engineeringProgramRequestTemplates.find((template) => template.id === "su2-case-run:su2")).toMatchObject({
        ready: false,
        blockedReason: expect.stringContaining("run args template")
      });
      const missingSu2ConfigPlaceholder = buildRuntimeToolDiagnostics({
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          su2: {
            ...settings.engineeringTools.su2,
            enabled: true,
            command: process.execPath,
            caseRoot: su2CaseRoot,
            configFile: "case.cfg",
            runArgsTemplate: ["--output", "{output}"]
          }
        }
      });
      expect(missingSu2ConfigPlaceholder.engineeringProgramRequestTemplates.find((template) => template.id === "su2-case-run:su2")).toMatchObject({
        ready: false,
        blockedReason: expect.stringContaining("{config}")
      });
      const missingOpenVspRunArgs = buildRuntimeToolDiagnostics({
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          openVsp: {
            ...settings.engineeringTools.openVsp,
            enabled: true,
            command: process.execPath,
            scriptPath: openVspScriptPath,
            runArgsTemplate: []
          }
        }
      });
      expect(missingOpenVspRunArgs.engineeringProgramRequestTemplates.find((template) => template.id === "openvsp-analysis-run:openvsp")).toMatchObject({
        ready: false,
        blockedReason: expect.stringContaining("run args template")
      });
      const missingOpenVspScriptPlaceholder = buildRuntimeToolDiagnostics({
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          openVsp: {
            ...settings.engineeringTools.openVsp,
            enabled: true,
            command: process.execPath,
            scriptPath: openVspScriptPath,
            runArgsTemplate: ["--output", "{output}"]
          }
        }
      });
      expect(
        missingOpenVspScriptPlaceholder.engineeringProgramRequestTemplates.find((template) => template.id === "openvsp-analysis-run:openvsp")
      ).toMatchObject({
        ready: false,
        blockedReason: expect.stringContaining("{script}")
      });
      const missingOpenVspSpecPlaceholder = buildRuntimeToolDiagnostics({
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          openVsp: {
            ...settings.engineeringTools.openVsp,
            enabled: true,
            command: process.execPath,
            scriptPath: openVspScriptPath,
            runArgsTemplate: ["{script}", "--output", "{output}"]
          }
        }
      });
      expect(missingOpenVspSpecPlaceholder.engineeringProgramRequestTemplates.find((template) => template.id === "openvsp-analysis-run:openvsp")).toMatchObject(
        {
          ready: false,
          blockedReason: expect.stringContaining("{spec}")
        }
      );
      const missingXflr5SpecPlaceholder = buildRuntimeToolDiagnostics({
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          xflr5: {
            ...settings.engineeringTools.xflr5,
            enabled: true,
            command: process.execPath,
            scriptPath: xflr5ScriptPath,
            runArgsTemplate: ["--script", "{script}", "--output", "{output}"]
          }
        }
      });
      expect(missingXflr5SpecPlaceholder.engineeringProgramRequestTemplates.find((template) => template.id === "xflr5-analysis-run:xflr5")).toMatchObject({
        ready: false,
        blockedReason: expect.stringContaining("{spec}")
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }

    const missingRoot = buildRuntimeToolDiagnostics({
      ...settings,
      allowCodeExecution: true,
      engineeringTools: {
        ...settings.engineeringTools,
        enabled: true,
        modeling: { ...settings.engineeringTools.modeling, enabled: true, artifactRoot: join(tmpdir(), "aetherops-missing-mesh-root") }
      }
    });
    expect(missingRoot.engineeringArtifactCandidates).toEqual([]);
    expect(missingRoot.blockers.find((blocker) => blocker.key === "engineeringArtifacts")?.message).toContain("does not exist");
  });

  it("runs engineering preflight only against configured real commands", async () => {
    const blocked = await runEngineeringProgramPreflight(settings, "all");
    expect(blocked.status).toBe("failed");
    expect(blocked.error).toContain("code execution");

    const su2TempRoot = mkdtempSync(join(tmpdir(), "aetherops-su2-preflight-"));
    try {
      const caseRoot = join(su2TempRoot, "case");
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");
      const su2 = await runEngineeringProgramPreflight(
        {
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
              probeArgs: ["--version"],
              runArgsTemplate: ["{config}"]
            }
          }
        },
        "su2"
      );

      expect(su2.status).toBe("completed");
      expect(JSON.stringify(su2.output)).toContain("su2");
      expect(JSON.stringify(su2.output)).toContain(process.version);
    } finally {
      rmSync(su2TempRoot, { recursive: true, force: true });
    }

    const openVspTempRoot = mkdtempSync(join(tmpdir(), "aetherops-openvsp-preflight-"));
    try {
      const scriptPath = join(openVspTempRoot, "openvsp-script.mjs");
      writeFileSync(scriptPath, "console.log('OpenVSP harness ready');\n", "utf8");
      const openVsp = await runEngineeringProgramPreflight(
        {
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
              probeArgs: ["--version"],
              runArgsTemplate: ["{script}", "--spec", "{spec}", "--output", "{output}"]
            }
          }
        },
        "openvsp"
      );

      expect(openVsp.status).toBe("completed");
      expect(JSON.stringify(openVsp.output)).toContain("openvsp");
      expect(JSON.stringify(openVsp.output)).toContain(process.version);
    } finally {
      rmSync(openVspTempRoot, { recursive: true, force: true });
    }

    const xflr5TempRoot = mkdtempSync(join(tmpdir(), "aetherops-xflr5-preflight-"));
    try {
      const scriptPath = join(xflr5TempRoot, "xflr5-script.mjs");
      writeFileSync(scriptPath, "console.log('XFLR5 harness ready');\n", "utf8");
      const xflr5 = await runEngineeringProgramPreflight(
        {
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
              probeArgs: ["--version"],
              runArgsTemplate: ["--script", "{script}", "--spec", "{spec}", "--output", "{output}"]
            }
          }
        },
        "xflr5"
      );

      expect(xflr5.status).toBe("completed");
      expect(JSON.stringify(xflr5.output)).toContain("xflr5");
      expect(JSON.stringify(xflr5.output)).toContain(process.version);
    } finally {
      rmSync(xflr5TempRoot, { recursive: true, force: true });
    }
  });

  it("imports OpenAlex research metadata as paper sources and citation-backed evidence", async () => {
    const input = runInput(["ResearchMetadataTool"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        expect(String(url)).toContain("api.openalex.org/works");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            results: [
              {
                id: "https://openalex.org/W1",
                doi: "https://doi.org/10.1234/example",
                display_name: "Traceable research metadata for autonomous research systems",
                publication_year: 2026,
                cited_by_count: 7,
                abstract_inverted_index: {
                  Traceable: [0],
                  metadata: [1],
                  improves: [2],
                  research: [3],
                  validation: [4]
                },
                authorships: [{ author: { display_name: "Ada Kim" } }],
                primary_location: { landing_page_url: "https://doi.org/10.1234/example", source: { display_name: "Journal of AetherOps" } },
                open_access: { is_oa: true, oa_url: "https://doi.org/10.1234/example" }
              }
            ]
          })
        };
      })
    );

    const result = await new ResearchMetadataTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ kind: "paper", doi: "https://doi.org/10.1234/example" });
    expect(result.sources[0]?.metadata).toMatchObject({ provider: "openalex", traceabilityKind: "external_source" });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.quote).toContain("Traceable metadata improves research validation");
    expect(result.evidence[0]?.citation).toContain("Ada Kim");
  });

  it("tries concise OpenAlex metadata queries when the first project-topic query has no usable works", async () => {
    const input = runInput(["ResearchMetadataTool"]);
    input.project.topic = "GUI autonomy final: OpenAlex metadata before OpenCode";
    input.project.goal =
      "Evaluate whether citation-aware scholarly metadata improves evidence traceability for literature-review RAG compared with vector retrieval alone.";

    const requestedSearches: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const search = new URL(String(url)).searchParams.get("search") ?? "";
        requestedSearches.push(search);
        const hasConciseRagQuery = /retrieval|citation|literature|vector/i.test(search);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            results: hasConciseRagQuery
              ? [
                  {
                    id: "https://openalex.org/W2",
                    doi: "https://doi.org/10.1234/rag",
                    display_name: "Citation-aware retrieval augmented generation for literature review",
                    publication_year: 2025,
                    cited_by_count: 11,
                    abstract_inverted_index: {
                      Citation: [0],
                      aware: [1],
                      retrieval: [2],
                      supports: [3],
                      literature: [4],
                      review: [5]
                    },
                    authorships: [{ author: { display_name: "Mina Park" } }]
                  }
                ]
              : []
          })
        };
      })
    );

    const result = await new ResearchMetadataTool().run(input, settings);

    expect(requestedSearches.length).toBeGreaterThan(1);
    expect(result.toolRun.status).toBe("completed");
    expect(result.sources[0]?.title).toContain("Citation-aware retrieval");
    expect(result.toolRun.input).toMatchObject({ provider: "openalex" });
  });

  it("sanitizes OpenAlex wildcard characters and retries recoverable invalid query errors", async () => {
    const input = runInput(["ResearchMetadataTool"]);
    input.project.topic = "Clark-Y ?? ??";
    input.project.goal = "Clark-Y airfoil polar analysis with XFOIL evidence.";

    const requestedSearches: string[] = [];
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        callCount += 1;
        const search = new URL(String(url)).searchParams.get("search") ?? "";
        requestedSearches.push(search);
        expect(search).not.toMatch(/[?*]/);
        if (callCount === 1) {
          return {
            ok: false,
            status: 400,
            statusText: "Bad Request",
            headers: new Headers({ "content-type": "application/json" }),
            text: async () => '{"error":"Invalid query parameters error.","message":"Leading wildcards are not supported."}'
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            results: [
              {
                id: "https://openalex.org/W3",
                doi: "https://doi.org/10.1234/airfoil",
                display_name: "Airfoil polar analysis with XFOIL evidence",
                publication_year: 2024,
                cited_by_count: 4,
                abstract_inverted_index: {
                  Airfoil: [0],
                  polar: [1],
                  analysis: [2],
                  uses: [3],
                  XFOIL: [4]
                },
                authorships: [{ author: { display_name: "Theo Lee" } }]
              }
            ]
          })
        };
      })
    );

    const result = await new ResearchMetadataTool().run(input, settings);

    expect(requestedSearches.length).toBeGreaterThan(1);
    expect(result.toolRun.status).toBe("completed");
    expect(result.sources[0]?.title).toContain("Airfoil polar");
  });
});
