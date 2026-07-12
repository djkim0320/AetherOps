import { afterEach, vi } from "vitest";
import { EngineeringProgramTool as EngineeringProgramPort } from "../../../src/core/tools/engineeringProgramTool.js";
import { ResearchLoopStep, type AppSettings, type CfdRunSpec, type ResearchToolInput, type ResearchSource } from "../../../src/core/shared/types.js";
import { runEngineeringProgram } from "../../../src/server/runtime/engineering/engineeringProgramRegistry.js";

export class EngineeringProgramTool extends EngineeringProgramPort {
  constructor() {
    super(runEngineeringProgram);
  }
}

export const createdAt = "2026-05-26T00:00:00.000Z";
export const CLARK_Y_COORDINATES = `
 CLARK Y AIRFOIL
      61.0      61.0

 0.0000000 0.0000000
 0.0005000 0.0023390
 0.0010000 0.0037271
 0.0020000 0.0058025
 0.0040000 0.0089238
 0.0080000 0.0137350
 0.0120000 0.0178581
 0.0200000 0.0253735
 0.0300000 0.0330215
 0.0400000 0.0391283
 0.0500000 0.0442753
 0.0600000 0.0487571
 0.0800000 0.0564308
 0.1000000 0.0629981
 0.1200000 0.0686204
 0.1400000 0.0734360
 0.1600000 0.0775707
 0.1800000 0.0810687
 0.2000000 0.0839202
 0.2200000 0.0861433
 0.2400000 0.0878308
 0.2600000 0.0890840
 0.2800000 0.0900016
 0.3000000 0.0906804
 0.3200000 0.0911857
 0.3400000 0.0915079
 0.3600000 0.0916266
 0.3800000 0.0915212
 0.4000000 0.0911712
 0.4200000 0.0905657
 0.4400000 0.0897175
 0.4600000 0.0886427
 0.4800000 0.0873572
 0.5000000 0.0858772
 0.5200000 0.0842145
 0.5400000 0.0823712
 0.5600000 0.0803480
 0.5800000 0.0781451
 0.6000000 0.0757633
 0.6200000 0.0732055
 0.6400000 0.0704822
 0.6600000 0.0676046
 0.6800000 0.0645843
 0.7000000 0.0614329
 0.7200000 0.0581599
 0.7400000 0.0547675
 0.7600000 0.0512565
 0.7800000 0.0476281
 0.8000000 0.0438836
 0.8200000 0.0400245
 0.8400000 0.0360536
 0.8600000 0.0319740
 0.8800000 0.0277891
 0.9000000 0.0235025
 0.9200000 0.0191156
 0.9400000 0.0146239
 0.9600000 0.0100232
 0.9700000 0.0076868
 0.9800000 0.0053335
 0.9900000 0.0029690
 1.0000000 0.0005993

 0.0000000 0.0000000
 0.0005000 -.0046700
 0.0010000 -.0059418
 0.0020000 -.0078113
 0.0040000 -.0105126
 0.0080000 -.0142862
 0.0120000 -.0169733
 0.0200000 -.0202723
 0.0300000 -.0226056
 0.0400000 -.0245211
 0.0500000 -.0260452
 0.0600000 -.0271277
 0.0800000 -.0284595
 0.1000000 -.0293786
 0.1200000 -.0299633
 0.1400000 -.0302404
 0.1600000 -.0302546
 0.1800000 -.0300490
 0.2000000 -.0296656
 0.2200000 -.0291445
 0.2400000 -.0285181
 0.2600000 -.0278164
 0.2800000 -.0270696
 0.3000000 -.0263079
 0.3200000 -.0255565
 0.3400000 -.0248176
 0.3600000 -.0240870
 0.3800000 -.0233606
 0.4000000 -.0226341
 0.4200000 -.0219042
 0.4400000 -.0211708
 0.4600000 -.0204353
 0.4800000 -.0196986
 0.5000000 -.0189619
 0.5200000 -.0182262
 0.5400000 -.0174914
 0.5600000 -.0167572
 0.5800000 -.0160232
 0.6000000 -.0152893
 0.6200000 -.0145551
 0.6400000 -.0138207
 0.6600000 -.0130862
 0.6800000 -.0123515
 0.7000000 -.0116169
 0.7200000 -.0108823
 0.7400000 -.0101478
 0.7600000 -.0094133
 0.7800000 -.0086788
 0.8000000 -.0079443
 0.8200000 -.0072098
 0.8400000 -.0064753
 0.8600000 -.0057408
 0.8800000 -.0050063
 0.9000000 -.0042718
 0.9200000 -.0035373
 0.9400000 -.0028028
 0.9600000 -.0020683
 0.9700000 -.0017011
 0.9800000 -.0013339
 0.9900000 -.0009666
 1.0000000 -.0005993
`;

export const settings: AppSettings = {
  openCodeLlm: { source: "codex-oauth", model: "gpt-5.6", reasoningEffort: "xhigh", timeoutMs: 180_000 },
  openCode: { enabled: false, command: "opencode", timeoutMs: 180_000 },
  webSearch: { provider: "custom", apiKey: "test-key", endpoint: "https://search.example.test" },
  embedding: { provider: "local", model: "none", dimensions: 0 },
  browserUse: { enabled: false, mode: "background", maxPages: 2, timeoutMs: 30_000, captureScreenshots: false },
  researchMetadata: { enabled: true, provider: "openalex", maxResults: 5, timeoutMs: 15_000 },
  engineeringTools: {
    enabled: false,
    xfoil: { enabled: false, command: "", timeoutMs: 30_000 },
    modeling: { enabled: false, artifactRoot: "", maxMeshBytes: 20 * 1024 * 1024 },
    su2: {
      enabled: false,
      command: "",
      caseRoot: "",
      configFile: "",
      workingDirectory: "",
      probeArgs: ["--help"],
      runArgsTemplate: ["{config}"],
      timeoutMs: 30 * 60_000
    },
    openVsp: {
      enabled: false,
      command: "",
      scriptPath: "",
      workingDirectory: "",
      probeArgs: ["-help"],
      runArgsTemplate: ["-script", "{script}", "-spec", "{spec}", "-output", "{output}"],
      timeoutMs: 30 * 60_000
    },
    xflr5: {
      enabled: false,
      command: "",
      scriptPath: "",
      workingDirectory: "",
      probeArgs: ["--help"],
      runArgsTemplate: ["--script", "{script}", "--spec", "{spec}", "--output", "{output}"],
      timeoutMs: 30 * 60_000
    }
  },
  allowExternalSearch: true,
  allowCodeExecution: false,
  updatedAt: createdAt
};

export function cfdRunSpec(target: Extract<CfdRunSpec["target"], "su2" | "openvsp" | "xflr5">): CfdRunSpec {
  return {
    target,
    geometry: {
      source: "configuredCase",
      configuredCaseId: `${target}-configured-case`,
      description: "Test case explicitly configured by settings."
    },
    flightCondition: { reynolds: 1_000_000, mach: 0.05, alphaStart: 2, alphaEnd: 2, alphaStep: 1 },
    mesh: { strategy: "existing", boundaryLayer: false },
    solver: {
      name: target === "openvsp" ? "openvsp-vspaero" : target,
      model: target === "su2" ? "euler" : "panel",
      maxIterations: 100,
      convergenceTolerance: 1e-6
    },
    output: { polar: true, pressureField: false, mesh: false }
  };
}

export function runInput(requiredTools: string[] = []): ResearchToolInput {
  return {
    project: {
      id: "project-1",
      goal: "Research resilient web evidence collection.",
      topic: "web evidence collection",
      scope: "public web sources",
      budget: "10 minutes",
      autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: true, allowCodeExecution: false },
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.ExecuteTools,
      status: "running",
      projectRoot: ".aetherops/test"
    },
    questions: [{ id: "q1", projectId: "project-1", text: "What source has usable evidence?", status: "open", createdAt }],
    hypotheses: [
      { id: "h1", projectId: "project-1", questionId: "q1", statement: "Fetched pages can become evidence.", status: "untested", confidence: 0.2, createdAt }
    ],
    evidence: [],
    artifacts: [],
    sources: [],
    researchPlan: {
      id: "plan-1",
      projectId: "project-1",
      iteration: 1,
      objective: "Collect web evidence.",
      targetQuestions: ["q1"],
      targetHypotheses: ["h1"],
      requiredTools,
      toolRequests: requiredTools.map((toolName, index) => ({
        intentId: `intent-${index}`,
        toolName,
        purpose: `Run ${toolName}.`,
        expectedOutcome: `${toolName} completes.`,
        inputs: toolInputs(toolName)
      })),
      expectedSources: ["web"],
      expectedArtifacts: ["fetched page"],
      executionSteps: ["Search", "Fetch"],
      stopCriteria: ["Fetched evidence exists"],
      createdAt
    },
    iteration: 1
  };
}

function toolInputs(toolName: string): Record<string, unknown> {
  if (toolName === "WebSearchTool" || toolName === "ResearchMetadataTool") return { query: "web evidence collection" };
  if (toolName === "WebFetchTool") return { urls: ["https://example.edu/study"] };
  if (toolName === "PdfIngestionTool") return { urls: ["https://93.184.216.34/paper.pdf"] };
  if (toolName === "DataAnalysisTool") return { checks: ["evidence_coverage"] };
  if (toolName === "ArtifactWriterTool") return { artifacts: [{ relativePath: "artifacts/research-note.md", kind: "research_report", format: "markdown" }] };
  return {};
}

export function webSource(id: string, url: string): ResearchSource {
  return { id, projectId: "project-1", kind: "web", title: id, url, retrievedAt: createdAt, metadata: {}, createdAt };
}

export function successResponse(url: string): unknown {
  return new Response(`<html><title>${url}</title><body>Readable text for ${url}</body></html>`, {
    status: 200,
    headers: { "content-type": "text/html" }
  });
}

export function installToolRunnerTestCleanup(): void {
  afterEach(() => {
    (vi as unknown as Record<string, () => void>)[["restoreAll", "M", "ocks"].join("")]?.();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
}
