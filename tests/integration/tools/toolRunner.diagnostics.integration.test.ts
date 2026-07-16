import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildServerRuntimeToolDiagnostics as buildRuntimeToolDiagnostics } from "../../../src/server/runtime/engineering/runtimeEngineeringDiagnostics.js";
import { runEngineeringProgramPreflight } from "../../../src/server/runtime/engineering/engineeringProgramRegistry.js";
import { BUNDLED_WEBXFOIL_RUNTIME, BUNDLED_WEBXFOIL_VERSION } from "../../../src/server/runtime/engineering/engineeringRuntimeVersions.js";
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
      const su2Marker = join(tempRoot, "su2-diagnostics-executed.txt");
      const su2ProbePath = join(tempRoot, "su2-probe.mjs");
      writeFileSync(su2ProbePath, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(su2Marker)}, "executed");\n`, "utf8");
      const openVspScriptPath = join(tempRoot, "openvsp-script.mjs");
      const openVspMarker = join(tempRoot, "openvsp-diagnostics-executed.txt");
      writeFileSync(openVspScriptPath, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(openVspMarker)}, "executed");\n`, "utf8");
      const xflr5ScriptPath = join(tempRoot, "xflr5-script.mjs");
      const xflr5Marker = join(tempRoot, "xflr5-diagnostics-executed.txt");
      writeFileSync(xflr5ScriptPath, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(xflr5Marker)}, "executed");\n`, "utf8");
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
            probeArgs: [su2ProbePath],
            runArgsTemplate: ["{config}", "--output", "{output}"]
          },
          openVsp: {
            ...settings.engineeringTools.openVsp,
            enabled: true,
            command: process.execPath,
            scriptPath: openVspScriptPath,
            probeArgs: [openVspScriptPath],
            runArgsTemplate: ["{script}", "--spec", "{spec}", "--output", "{output}"]
          },
          xflr5: {
            ...settings.engineeringTools.xflr5,
            enabled: true,
            command: process.execPath,
            scriptPath: xflr5ScriptPath,
            probeArgs: [xflr5ScriptPath],
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
      for (const target of ["modeling", "su2", "openvsp", "xflr5"] as const) {
        expect(configured.engineeringPrograms.find((capability) => capability.target === target)).toMatchObject({
          ready: false,
          blockedReason: expect.stringMatching(new RegExp(`${target === "modeling" ? "mesh" : target}.*NOT_READY.*exact runtime-version receipt`, "i"))
        });
      }
      expect(configured.engineeringPrograms.find((capability) => capability.target === "xfoil")).toMatchObject({
        ready: false,
        blockedReason: expect.stringContaining("not configured")
      });
      expect(configured.engineeringProgramRequestTemplates.filter((template) => template.ready).map((template) => template.id)).toEqual([
        "xfoil-wasm-polar:xfoil-wasm"
      ]);
      expect(configured.engineeringProgramRequestTemplates.find((template) => template.id === "mesh-inspect:modeling")).toMatchObject({
        ready: false,
        blockedReason: expect.stringMatching(/mesh.*NOT_READY.*exact runtime-version receipt/i),
        request: { kind: "mesh-inspect", target: "modeling" }
      });
      expect(configured.engineeringProgramRequestTemplates.find((template) => template.id === "su2-case-run:su2")).toMatchObject({
        ready: false,
        blockedReason: expect.stringMatching(/su2.*NOT_READY.*exact runtime-version receipt/i),
        request: { kind: "su2-case-run", target: "su2", outputFileName: "su2-run-output.txt", cfdRunSpec: expect.any(Object) }
      });
      expect(configured.engineeringProgramRequestTemplates.find((template) => template.id === "openvsp-analysis-run:openvsp")).toMatchObject({
        ready: false,
        blockedReason: expect.stringMatching(/openvsp.*NOT_READY.*exact runtime-version receipt/i),
        request: { kind: "openvsp-analysis-run", target: "openvsp", outputFileName: "openvsp-analysis-output.json", cfdRunSpec: expect.any(Object) }
      });
      expect(configured.engineeringProgramRequestTemplates.find((template) => template.id === "xflr5-analysis-run:xflr5")).toMatchObject({
        ready: false,
        blockedReason: expect.stringMatching(/xflr5.*NOT_READY.*exact runtime-version receipt/i),
        request: { kind: "xflr5-analysis-run", target: "xflr5", outputFileName: "xflr5-analysis-output.json", cfdRunSpec: expect.any(Object) }
      });
      expect(existsSync(su2Marker)).toBe(false);
      expect(existsSync(openVspMarker)).toBe(false);
      expect(existsSync(xflr5Marker)).toBe(false);
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
        blockedReason: expect.stringMatching(/su2.*NOT_READY.*exact runtime-version receipt/i)
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
        blockedReason: expect.stringMatching(/su2.*NOT_READY.*exact runtime-version receipt/i)
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
        blockedReason: expect.stringMatching(/openvsp.*NOT_READY.*exact runtime-version receipt/i)
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
        blockedReason: expect.stringMatching(/openvsp.*NOT_READY.*exact runtime-version receipt/i)
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
          blockedReason: expect.stringMatching(/openvsp.*NOT_READY.*exact runtime-version receipt/i)
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
        blockedReason: expect.stringMatching(/xflr5.*NOT_READY.*exact runtime-version receipt/i)
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

  it("fails native and modeling preflight before probes or filesystem inspection and only allows pinned WebXFOIL", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-receipt-preflight-"));
    try {
      const markers = {
        xfoil: join(tempRoot, "xfoil-probed.txt"),
        su2: join(tempRoot, "su2-probed.txt"),
        openvsp: join(tempRoot, "openvsp-probed.txt"),
        xflr5: join(tempRoot, "xflr5-probed.txt")
      };
      const xfoilCommand = join(tempRoot, process.platform === "win32" ? "xfoil.cmd" : "xfoil");
      writeMarkerCommand(xfoilCommand, markers.xfoil);
      const su2Probe = writeNodeMarkerScript(tempRoot, "su2", markers.su2);
      const openVspProbe = writeNodeMarkerScript(tempRoot, "openvsp", markers.openvsp);
      const xflr5Probe = writeNodeMarkerScript(tempRoot, "xflr5", markers.xflr5);
      const caseRoot = join(tempRoot, "case");
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");
      const configured = {
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          xfoil: { ...settings.engineeringTools.xfoil, enabled: true, command: xfoilCommand },
          modeling: { ...settings.engineeringTools.modeling, enabled: true, artifactRoot: join(tempRoot, "missing-model-root") },
          su2: {
            ...settings.engineeringTools.su2,
            enabled: true,
            command: process.execPath,
            caseRoot,
            configFile: "case.cfg",
            probeArgs: [su2Probe]
          },
          openVsp: {
            ...settings.engineeringTools.openVsp,
            enabled: true,
            command: process.execPath,
            scriptPath: openVspProbe,
            probeArgs: [openVspProbe]
          },
          xflr5: {
            ...settings.engineeringTools.xflr5,
            enabled: true,
            command: process.execPath,
            scriptPath: xflr5Probe,
            probeArgs: [xflr5Probe]
          }
        }
      };

      for (const [target, promotionTarget] of [
        ["all", "all"],
        ["xfoil", "xfoil"],
        ["modeling", "mesh"],
        ["su2", "su2"],
        ["openvsp", "openvsp"],
        ["xflr5", "xflr5"]
      ] as const) {
        const result = await runEngineeringProgramPreflight(configured, target);
        expect(result).toMatchObject({
          target,
          status: "failed",
          error: expect.stringMatching(new RegExp(`${promotionTarget}.*NOT_READY.*exact runtime-version receipt`, "i"))
        });
      }
      expect(Object.values(markers).every((marker) => !existsSync(marker))).toBe(true);

      const webXfoil = await runEngineeringProgramPreflight(configured, "xfoil-wasm");
      expect(webXfoil).toMatchObject({
        target: "xfoil-wasm",
        status: "completed",
        output: {
          checked: ["xfoil-wasm"],
          xfoilWasm: { runtime: BUNDLED_WEBXFOIL_RUNTIME, version: BUNDLED_WEBXFOIL_VERSION, bundled: true }
        }
      });
      expect(Object.values(markers).every((marker) => !existsSync(marker))).toBe(true);

      const disabledWebXfoil = await runEngineeringProgramPreflight({ ...configured, allowCodeExecution: false }, "xfoil-wasm");
      expect(disabledWebXfoil).toMatchObject({ status: "failed", error: expect.stringContaining("code execution") });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("imports OpenAlex research metadata as paper sources and citation-backed evidence", async () => {
    const input = runInput(["ResearchMetadataTool"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        expect(String(url)).toContain("api.openalex.org/works");
        return new Response(
          JSON.stringify({
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
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
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
        return new Response(
          JSON.stringify({
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
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
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
          return new Response('{"error":"Invalid query parameters error.","message":"Leading wildcards are not supported."}', {
            status: 400,
            statusText: "Bad Request",
            headers: { "content-type": "application/json" }
          });
        }
        return new Response(
          JSON.stringify({
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
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );

    const result = await new ResearchMetadataTool().run(input, settings);

    expect(requestedSearches.length).toBeGreaterThan(1);
    expect(result.toolRun.status).toBe("completed");
    expect(result.sources[0]?.title).toContain("Airfoil polar");
  });
});

function writeNodeMarkerScript(root: string, name: string, marker: string): string {
  const scriptPath = join(root, `${name}-probe.mjs`);
  writeFileSync(scriptPath, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "probed", "utf8");\n`, "utf8");
  return scriptPath;
}

function writeMarkerCommand(path: string, marker: string): void {
  if (process.platform === "win32") {
    writeFileSync(path, `@echo off\r\n> "${marker}" echo probed\r\n`, "utf8");
    return;
  }
  writeFileSync(path, `#!/bin/sh\nprintf probed > '${marker.replace(/'/g, `'\\''`)}'\n`, "utf8");
  chmodSync(path, 0o700);
}
