import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const spec = await new ResearchSpecificationBuilder(llm).build({
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
      ]
    });
    expect(plan.iteration).toBe(1);
    expect(plan.objective).toBeTruthy();
    expect(plan.requiredTools.length).toBeGreaterThan(0);
    expect(plan.expectedSources.length).toBeGreaterThan(0);
    expect(plan.stopCriteria.length).toBeGreaterThan(0);
  });

  it("fails closed when an engineering-only plan selects a runtime target that is not ready", async () => {
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
        ({
          objective: "Run Clark-Y with XFOIL-WASM.",
          requiredTools: ["WebFetchTool", "ResearchMetadataTool", "EngineeringProgramTool", "ArtifactWriterTool", "DataAnalysisTool"],
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

    await expect(
      new ResearchPlanner(llm).plan({
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
      })
    ).rejects.toThrow("did not produce any ready programRequests");
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
        ({
          objective: "Collect scholarly metadata.",
          requiredTools: ["ResearchMetadataTool", "ArtifactWriterTool", "DataAnalysisTool"]
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
        ({
          objective: "Try an unavailable OpenVSP run.",
          requiredTools: ["EngineeringProgramTool", "ArtifactWriterTool"],
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

  it("keeps ready OpenVSP program requests and normalizes them from the template contract", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-planner-openvsp-"));
    try {
      const scriptPath = join(tempRoot, "openvsp-script.mjs");
      writeFileSync(scriptPath, "console.log('OpenVSP planner harness');\n", "utf8");
      const base = snapshot();
      const spec = base.specifications[0]!;
      const llm: LlmProvider = {
        name: "ready-openvsp-request-test",
        isAvailable: async () => true,
        completeJson: async <T>(): Promise<T> =>
          ({
            objective: "Run configured OpenVSP.",
            requiredTools: ["EngineeringProgramTool", "ArtifactWriterTool"],
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
          }) as T
      };

      const plan = await new ResearchPlanner(llm).plan({
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
              probeArgs: ["--version"],
              runArgsTemplate: ["{script}", "--spec", "{spec}", "--output", "{output}"]
            }
          }
        },
        availableTools: ["EngineeringProgramTool", "ArtifactWriterTool", "DataAnalysisTool"]
      });

      expect(plan.requiredTools).toContain("EngineeringProgramTool");
      expect(plan.programRequests).toEqual([
        {
          kind: "openvsp-analysis-run",
          target: "openvsp",
          outputFileName: "openvsp-custom.json",
          cfdRunSpec: expect.objectContaining({
            target: "openvsp",
            geometry: expect.objectContaining({ source: "configuredCase" }),
            solver: expect.objectContaining({ name: "openvsp-vspaero" })
          }),
          reason: "Use the ready OpenVSP template."
        }
      ]);
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
          ({
            objective: "Run SU2 without an explicit target.",
            requiredTools: ["EngineeringProgramTool", "ArtifactWriterTool"],
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
      ).rejects.toThrow(/EngineeringProgramTool was selected/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps ready SU2 program requests only when the configured case contract is ready", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-planner-su2-"));
    try {
      const caseRoot = join(tempRoot, "case");
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");
      const base = snapshot();
      const spec = base.specifications[0]!;
      const llm: LlmProvider = {
        name: "ready-su2-request-test",
        isAvailable: async () => true,
        completeJson: async <T>(): Promise<T> =>
          ({
            objective: "Run configured SU2.",
            requiredTools: ["EngineeringProgramTool", "ArtifactWriterTool"],
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
          }) as T
      };

      const plan = await new ResearchPlanner(llm).plan({
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
      });

      expect(plan.requiredTools).toContain("EngineeringProgramTool");
      expect(plan.programRequests).toEqual([
        {
          kind: "su2-case-run",
          target: "su2",
          outputFileName: "su2-custom.txt",
          cfdRunSpec: expect.objectContaining({
            target: "su2",
            geometry: expect.objectContaining({ source: "configuredCase" }),
            solver: expect.objectContaining({ name: "su2" })
          }),
          reason: "Use the ready SU2 template."
        }
      ]);
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
        return {
          objective: "Retry with compact context.",
          requiredTools: ["WebFetchTool", "ArtifactWriterTool"],
          fetchCandidateUrls: ["https://arxiv.org/abs/2404.16130"]
        } as T;
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
});
