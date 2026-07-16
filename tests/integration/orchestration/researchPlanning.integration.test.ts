import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LlmTimeoutError, type LlmJsonRequest, type LlmProvider } from "../../../src/core/providers/llm.js";
import { ResearchPlanner } from "../../../src/core/planning/researchPlanner.js";
import { ResearchSpecificationBuilder } from "../../../src/core/planning/researchSpecification.js";
import { DeterministicLlmProvider } from "../../../src/core/testing/orchestratorTestHarness.js";
import { cfdRunSpec, createdAt, settings, snapshot } from "./researchArchitecture.integration.support.js";

describe("Research specification and planning architecture", () => {
  it("builds specification and plan from project questions and hypotheses", async () => {
    const base = snapshot();
    const llm = new DeterministicLlmProvider();
    const spec = await new ResearchSpecificationBuilder().build({
      project: base.project,
      questions: base.questions,
      hypotheses: base.hypotheses,
      evidence: base.evidence
    });
    expect(spec.researchQuestions.length).toBeGreaterThanOrEqual(3);
    expect(spec.refinedHypotheses.length).toBeGreaterThanOrEqual(2);
    expect(spec.competencyQuestions.length).toBeGreaterThan(0);
    expect(spec.requiredEvidenceTypes.length).toBeGreaterThan(0);
    expect(spec.successCriteria.length).toBeGreaterThan(0);

    const invocationMetadata: Array<{ promptVersion: string; schemaVersion: string }> = [];
    const plan = await new ResearchPlanner(llm).plan({
      snapshot: base,
      specification: spec,
      iteration: 1,
      settings,
      availableTools: [
        "WebSearchTool",
        "WebFetchTool",
        "ResearchMetadataTool",
        "PdfIngestionTool",
        "ArtifactWriterTool",
        "DataAnalysisTool",
        "BackgroundBrowserTool"
      ],
      onLlmInvocation: (metadata) => invocationMetadata.push(metadata)
    });
    expect(plan.iteration).toBe(1);
    expect(plan.objective).toBeTruthy();
    expect(plan.requiredTools.length).toBeGreaterThan(0);
    expect(plan.expectedSources.length).toBeGreaterThan(0);
    expect(plan.stopCriteria.length).toBeGreaterThan(0);
    expect(invocationMetadata).toEqual([expect.objectContaining({ promptVersion: "research-plan-v2", schemaVersion: "research-plan-strict-v1" })]);
  });

  it("keeps bundled WebXFOIL ready when Engineering is allowed even if external engineering tools are disabled", async () => {
    const clarkYUrl = "https://m-selig.ae.illinois.edu/ads/coord/clarky.dat";
    const base = snapshot();
    base.project.topic = "Clark-Y airfoil polar analysis";
    base.project.goal = "Build and run a real Clark-Y aerodynamic polar experiment with XFOIL-WASM.";
    base.project.scope = "Use a traceable Clark-Y coordinate source and produce CL, CD, and L/D results.";
    base.questions = [
      { id: "q-aero", projectId: "project-1", text: "What Clark-Y polar is computed at Re 1,000,000 from alpha -4 to 12?", status: "open", createdAt }
    ];
    base.hypotheses = [
      {
        id: "h-aero",
        projectId: "project-1",
        questionId: "q-aero",
        statement: "Clark-Y lift increases through the pre-stall alpha sweep.",
        status: "untested",
        confidence: 0.35,
        createdAt
      }
    ];
    const spec = {
      ...base.specifications[0]!,
      researchQuestions: ["What Clark-Y polar is computed at Re 1,000,000 from alpha -4 to 12?"],
      initialHypotheses: ["Clark-Y lift increases through the pre-stall alpha sweep."],
      refinedHypotheses: ["Clark-Y lift increases across the requested XFOIL-WASM sweep before stall effects dominate."],
      scope: "Engineering-only 2D airfoil polar computation.",
      requiredEvidenceTypes: ["airfoil coordinate source", "tool log", "polar result", "final report"],
      evaluationMetrics: ["CL", "CD", "L/D", "solver completion"],
      successCriteria: ["EngineeringProgramTool completes with numeric polar rows."]
    };
    const llm: LlmProvider = {
      name: "engineering-metadata-gating-test",
      isAvailable: async () => true,
      completeJson: async <T>(): Promise<T> =>
        strictPlanResponse({
          objective: "Run Clark-Y with XFOIL-WASM.",
          tools: ["WebFetchTool", "EngineeringProgramTool", "ArtifactWriterTool", "DataAnalysisTool"],
          expectedSources: ["UIUC Clark-Y coordinate file"],
          fetchCandidateUrls: [clarkYUrl],
          programRequests: [
            {
              kind: "xfoil-wasm-polar",
              target: "xfoil-wasm",
              sourceUrl: clarkYUrl,
              reynolds: 1_000_000,
              mach: 0,
              alphaStart: -4,
              alphaEnd: 12,
              alphaStep: 2,
              outputFileName: "clark-y-polar.json"
            }
          ]
        }) as T
    };

    const plan = await new ResearchPlanner(llm).plan({
      snapshot: base,
      specification: spec,
      iteration: 1,
      settings: {
        ...settings,
        allowExternalSearch: true,
        allowCodeExecution: true,
        engineeringTools: { ...settings.engineeringTools, enabled: false }
      },
      availableTools: ["WebFetchTool", "ResearchMetadataTool", "EngineeringProgramTool", "ArtifactWriterTool", "DataAnalysisTool"]
    });
    expect(plan.programRequests).toEqual([expect.objectContaining({ kind: "xfoil-wasm-polar", target: "xfoil-wasm", sourceUrl: clarkYUrl })]);
  });

  it("rejects target=all when the user explicitly requires unavailable SU2 without fallback", async () => {
    const base = snapshot();
    base.project.goal = "Run the configured SU2 case and block if SU2 is unavailable.";
    base.project.topic = "Unavailable SU2 without solver fallback";
    base.project.scope = "SU2 is explicitly required. Do not select WebXFOIL, XFLR5, OpenVSP, or native XFOIL.";
    const llm: LlmProvider = {
      name: "explicit-su2-no-fallback-test",
      isAvailable: async () => true,
      completeJson: async <T>(): Promise<T> =>
        strictPlanResponse({
          objective: "Probe the toolchain and continue analysis.",
          tools: ["EngineeringProgramTool", "DataAnalysisTool", "ArtifactWriterTool"],
          programRequests: [{ kind: "toolchain-check", target: "all", reason: "Check whether SU2 is present." }]
        }) as T
    };

    await expect(
      new ResearchPlanner(llm).plan({
        snapshot: base,
        specification: base.specifications[0]!,
        iteration: 1,
        settings: { ...settings, allowCodeExecution: true },
        availableTools: ["EngineeringProgramTool", "DataAnalysisTool", "ArtifactWriterTool"],
        effectiveCapabilities: { agent: true, engineering: true, search: false },
        toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } }
      })
    ).rejects.toThrow(/explicitly required su2|target=all|forbidden solver substitution/i);
  });

  it("keeps research metadata collection when scholarly paper metadata is explicitly requested", async () => {
    const base = snapshot();
    base.project.topic = "Citation-aware literature review";
    base.project.goal = "Collect scholarly paper metadata and DOI-backed citation metadata for a literature review.";
    const spec = {
      ...base.specifications[0]!,
      researchQuestions: ["Which scholarly papers support citation-aware retrieval?"],
      refinedHypotheses: ["Citation metadata improves traceable literature review evidence."],
      requiredEvidenceTypes: ["scholarly paper metadata", "DOI", "citation metadata"],
      successCriteria: ["OpenAlex paper metadata is imported."]
    };
    const llm: LlmProvider = {
      name: "scholarly-metadata-gating-test",
      isAvailable: async () => true,
      completeJson: async <T>(): Promise<T> =>
        strictPlanResponse({
          objective: "Collect scholarly metadata.",
          tools: ["ResearchMetadataTool", "ArtifactWriterTool", "DataAnalysisTool"]
        }) as T
    };

    const plan = await new ResearchPlanner(llm).plan({
      snapshot: base,
      specification: spec,
      iteration: 1,
      settings: { ...settings, allowExternalSearch: true },
      availableTools: ["ResearchMetadataTool", "ArtifactWriterTool", "DataAnalysisTool"]
    });

    expect(plan.requiredTools).toContain("ResearchMetadataTool");
  });

  it("fails closed when LLM engineering program requests are not backed by ready runtime templates", async () => {
    const base = snapshot();
    const spec = base.specifications[0]!;
    const llm: LlmProvider = {
      name: "unsafe-engineering-request-test",
      isAvailable: async () => true,
      completeJson: async <T>(): Promise<T> =>
        strictPlanResponse({
          objective: "Try an unavailable OpenVSP run.",
          tools: ["EngineeringProgramTool", "ArtifactWriterTool"],
          programRequests: [{ kind: "openvsp-analysis-run", target: "openvsp", outputFileName: "unsafe.json" }]
        }) as T
    };

    await expect(
      new ResearchPlanner(llm).plan({
        snapshot: base,
        specification: spec,
        iteration: 1,
        settings: {
          ...settings,
          allowCodeExecution: true,
          engineeringTools: { ...settings.engineeringTools, enabled: true }
        },
        availableTools: ["EngineeringProgramTool", "ArtifactWriterTool", "DataAnalysisTool"]
      })
    ).rejects.toThrow(/EngineeringProgramTool was selected/);
  });

  it("fails closed before execution when configured OpenVSP lacks a durable runtime receipt", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-planner-openvsp-"));
    try {
      const scriptPath = join(tempRoot, "openvsp-script.mjs");
      const executionMarker = join(tempRoot, "openvsp-executed.txt");
      writeFileSync(scriptPath, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(executionMarker)}, "executed");\n`, "utf8");
      const base = snapshot();
      base.project.goal = "Run OpenVSP and block if its exact durable runtime receipt is unavailable.";
      base.project.topic = "Explicit OpenVSP execution";
      base.project.scope = "OpenVSP is mandatory; do not substitute another solver.";
      const spec = base.specifications[0]!;
      const prompts: string[] = [];
      const llm: LlmProvider = {
        name: "blocked-openvsp-request-test",
        isAvailable: async () => true,
        completeJson: async <T>(request: LlmJsonRequest): Promise<T> => {
          prompts.push(request.user);
          return strictPlanResponse({
            objective: "Run configured OpenVSP.",
            tools: ["EngineeringProgramTool", "ArtifactWriterTool"],
            programRequests: [
              {
                kind: "openvsp-analysis-run",
                target: "openvsp",
                artifactPath: "../outside.vsp3",
                outputFileName: "openvsp-custom.json",
                cfdRunSpec: cfdRunSpec("openvsp"),
                reason: "Use the ready OpenVSP template."
              }
            ]
          }) as T;
        }
      };

      await expect(
        new ResearchPlanner(llm).plan({
          snapshot: base,
          specification: spec,
          iteration: 1,
          settings: {
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
                probeArgs: [scriptPath],
                runArgsTemplate: ["{script}", "--spec", "{spec}", "--output", "{output}"]
              }
            }
          },
          availableTools: ["EngineeringProgramTool", "ArtifactWriterTool", "DataAnalysisTool"]
        })
      ).rejects.toThrow(/explicit engineering target openvsp is unavailable or not ready/i);

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatch(/openvsp-analysis-run:openvsp[\s\S]*?"ready":false/);
      expect(prompts[0]).toMatch(/openvsp is NOT_READY because AetherOps cannot yet verify its exact runtime-version receipt/);
      expect(existsSync(executionMarker)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on SU2 program requests that omit the required target", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-planner-su2-missing-target-"));
    try {
      const caseRoot = join(tempRoot, "case");
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");
      const base = snapshot();
      const spec = base.specifications[0]!;
      const llm: LlmProvider = {
        name: "missing-su2-target-request-test",
        isAvailable: async () => true,
        completeJson: async <T>(): Promise<T> =>
          strictPlanResponse({
            objective: "Run SU2 without an explicit target.",
            tools: ["EngineeringProgramTool", "ArtifactWriterTool"],
            programRequests: [{ kind: "su2-case-run", outputFileName: "su2-custom.txt" }]
          }) as T
      };

      await expect(
        new ResearchPlanner(llm).plan({
          snapshot: base,
          specification: spec,
          iteration: 1,
          settings: {
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
                runArgsTemplate: ["{config}", "--output", "{output}"]
              }
            }
          },
          availableTools: ["EngineeringProgramTool", "ArtifactWriterTool", "DataAnalysisTool"]
        })
      ).rejects.toThrow(/su2-case-run requires target=su2/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed before execution when configured SU2 lacks a durable runtime receipt", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-planner-su2-"));
    try {
      const caseRoot = join(tempRoot, "case");
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");
      const executionMarker = join(tempRoot, "su2-executed.txt");
      const probePath = join(tempRoot, "su2-probe.mjs");
      writeFileSync(probePath, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(executionMarker)}, "executed");\n`, "utf8");
      const base = snapshot();
      base.project.goal = "Run SU2 and block if its exact durable runtime receipt is unavailable.";
      base.project.topic = "Explicit SU2 execution";
      base.project.scope = "SU2 is mandatory; do not substitute another solver.";
      const spec = base.specifications[0]!;
      const prompts: string[] = [];
      const llm: LlmProvider = {
        name: "blocked-su2-request-test",
        isAvailable: async () => true,
        completeJson: async <T>(request: LlmJsonRequest): Promise<T> => {
          prompts.push(request.user);
          return strictPlanResponse({
            objective: "Run configured SU2.",
            tools: ["EngineeringProgramTool", "ArtifactWriterTool"],
            programRequests: [
              {
                kind: "su2-case-run",
                target: "su2",
                artifactPath: "../outside.su2",
                outputFileName: "su2-custom.txt",
                cfdRunSpec: cfdRunSpec("su2"),
                reason: "Use the ready SU2 template."
              }
            ]
          }) as T;
        }
      };

      await expect(
        new ResearchPlanner(llm).plan({
          snapshot: base,
          specification: spec,
          iteration: 1,
          settings: {
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
                probeArgs: [probePath],
                runArgsTemplate: ["{config}", "--output", "{output}"]
              }
            }
          },
          availableTools: ["EngineeringProgramTool", "ArtifactWriterTool", "DataAnalysisTool"]
        })
      ).rejects.toThrow(/explicit engineering target su2 is unavailable or not ready/i);

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatch(/su2-case-run:su2[\s\S]*?"ready":false/);
      expect(prompts[0]).toMatch(/su2 is NOT_READY because AetherOps cannot yet verify its exact runtime-version receipt/);
      expect(existsSync(executionMarker)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("retries PlanResearch LLM timeout with a compact prompt and preserves fetch candidates", async () => {
    const base = snapshot();
    const spec = base.specifications[0]!;
    const prompts: string[] = [];
    const timeoutMetadata: Array<{ retryAttempt: number; promptLength: number }> = [];
    const decision = {
      id: "decision-retry",
      projectId: base.project.id,
      iteration: 2,
      shouldContinue: true,
      reason: "Need PDF span evidence.",
      nextObjective: "Fetch GraphRAG PDF spans.",
      nextQuestions: [],
      evidenceGaps: ["Need page/span evidence"],
      planRevisionHints: ["Use WebFetchTool to fetch selected source URLs from previous ProjectContextSnapshot."],
      fetchCandidateUrls: ["https://arxiv.org/abs/2404.16130"],
      createdAt
    };
    const llm: LlmProvider = {
      name: "timeout-test",
      isAvailable: async () => true,
      completeJson: async <T>(request: LlmJsonRequest): Promise<T> => {
        prompts.push(request.user);
        if (prompts.length === 1) {
          throw new LlmTimeoutError("Codex LLM request timed out after 120000ms.", {
            provider: "timeout-test",
            timeoutMs: 120_000,
            promptLength: request.user.length,
            promptTokenEstimate: Math.ceil(request.user.length / 4),
            retryAttempt: 0,
            step: "PLAN_RESEARCH",
            schemaName: request.schemaName
          });
        }
        return strictPlanResponse({
          objective: "Retry with compact context.",
          tools: ["WebFetchTool", "ArtifactWriterTool"],
          fetchCandidateUrls: ["https://arxiv.org/abs/2404.16130"]
        }) as T;
      }
    };
    const plan = await new ResearchPlanner(llm, (_projectId, error, retryAttempt) => {
      timeoutMetadata.push({ retryAttempt, promptLength: error.metadata.promptLength });
    }).plan({
      snapshot: { ...base, continuationDecisions: [decision] },
      specification: spec,
      iteration: 3,
      settings,
      availableTools: ["WebFetchTool", "ArtifactWriterTool", "DataAnalysisTool"],
      continuationDecision: decision
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.length).toBeLessThan(prompts[0]!.length);
    expect(timeoutMetadata).toEqual([{ retryAttempt: 0, promptLength: prompts[0]!.length }]);
    expect(plan.fetchCandidateUrls).toContain("https://arxiv.org/abs/2404.16130");
    expect(plan.requiredTools).toContain("WebFetchTool");
  });

  it("rejects a missing toolRequests field instead of silently selecting default tools", async () => {
    const base = snapshot();
    const llm: LlmProvider = {
      name: "missing-tool-requests-test",
      isAvailable: async () => true,
      completeJson: async <T>(): Promise<T> =>
        ({
          objective: "Do not infer tools.",
          targetQuestions: ["q1"],
          targetHypotheses: ["h1"],
          expectedSources: [],
          expectedArtifacts: [],
          executionSteps: ["No implicit execution."],
          stopCriteria: ["Stop on invalid planning output."],
          fetchCandidateUrls: []
        }) as T
    };

    await expect(
      new ResearchPlanner(llm).plan({
        snapshot: base,
        specification: base.specifications[0]!,
        iteration: 1,
        settings,
        availableTools: ["ArtifactWriterTool", "DataAnalysisTool"]
      })
    ).rejects.toThrow(/toolRequests/);
  });

  it("rejects an unknown tool instead of substituting an available tool", async () => {
    const base = snapshot();
    const llm: LlmProvider = {
      name: "unknown-tool-test",
      isAvailable: async () => true,
      completeJson: async <T>(): Promise<T> => strictPlanResponse({ objective: "Select an unknown tool.", tools: ["ImaginarySuccessTool"] }) as T
    };

    await expect(
      new ResearchPlanner(llm).plan({
        snapshot: base,
        specification: base.specifications[0]!,
        iteration: 1,
        settings,
        availableTools: ["ArtifactWriterTool", "DataAnalysisTool"]
      })
    ).rejects.toThrow(/Tool is not available/);
  });

  it("keeps Codex CLI out of planner candidates unless the job policy explicitly allows it", async () => {
    const base = snapshot();
    const llm: LlmProvider = {
      name: "codex-cli-policy-test",
      isAvailable: async () => true,
      completeJson: async <T>(): Promise<T> => strictPlanResponse({ objective: "Run an authorized coding task.", tools: ["CodexCliTool"] }) as T
    };
    const planner = new ResearchPlanner(llm);
    const common = {
      snapshot: base,
      specification: base.specifications[0]!,
      iteration: 1,
      settings,
      availableTools: ["CodexCliTool", "ArtifactWriterTool", "DataAnalysisTool"]
    };

    await expect(planner.plan(common)).rejects.toThrow(/Tool is not available: CodexCliTool/);
    await expect(planner.plan({ ...common, toolPolicy: { allowCodexCli: true } })).resolves.toMatchObject({ requiredTools: ["CodexCliTool"] });
  });
});

function strictPlanResponse(input: {
  objective: string;
  tools: string[];
  expectedSources?: string[];
  fetchCandidateUrls?: string[];
  programRequests?: unknown[];
}): Record<string, unknown> {
  const urls = input.fetchCandidateUrls ?? [];
  return {
    objective: input.objective,
    targetQuestions: ["q1"],
    targetHypotheses: ["h1"],
    toolRequests: input.tools.map((toolName, index) => ({
      intentId: `intent-${index + 1}`,
      toolName,
      purpose: `Execute ${toolName} for this plan.`,
      expectedOutcome: `${toolName} produces a traceable result.`,
      inputs: strictToolInputs(toolName, urls, input.programRequests)
    })),
    expectedSources: input.expectedSources ?? ["traceable source"],
    expectedArtifacts: ["artifacts/iteration-1/research-note.md"],
    executionSteps: input.tools.map((toolName) => `Run ${toolName}.`),
    stopCriteria: ["The requested evidence and artifacts are produced."],
    fetchCandidateUrls: urls
  };
}

function strictToolInputs(toolName: string, urls: string[], programRequests: unknown[] | undefined): Record<string, unknown> {
  if (toolName === "WebFetchTool" || toolName === "PdfIngestionTool") return { urls: urls.length ? urls : ["https://example.com/source"] };
  if (toolName === "ResearchMetadataTool" || toolName === "WebSearchTool") return { query: "citation-aware research evidence" };
  if (toolName === "BackgroundBrowserTool") return { urls: urls.length ? urls : ["https://example.com/source"] };
  if (toolName === "EngineeringProgramTool") return { programRequests: programRequests ?? [] };
  if (toolName === "ArtifactWriterTool")
    return { artifacts: [{ relativePath: "artifacts/iteration-1/research-note.md", kind: "research_report", format: "markdown" }] };
  if (toolName === "DataAnalysisTool") return { checks: ["evidence_coverage", "hypothesis_coverage"] };
  if (toolName === "CodexCliTool")
    return {
      task: "Implement the explicitly authorized engineering task.",
      inputArtifactIds: [],
      outputs: [{ relativePath: "reports/codex-result.md", kind: "report" }]
    };
  return {};
}
