import { ResearchLoopStep, type AppSettings, type CfdRunSpec, type ResearchSnapshot } from "../../../src/core/shared/types.js";

export const createdAt = "2026-05-20T00:00:00.000Z";
export const settings: AppSettings = {
  openCodeLlm: { source: "codex-oauth", model: "gpt-5.5", reasoningEffort: "xhigh", timeoutMs: 180_000 },
  openCode: { enabled: false, command: "opencode", provider: "openai", model: "gpt-5.5", timeoutMs: 180_000 },
  webSearch: { provider: "disabled" },
  embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 64, apiKey: "test-key", apiKeyConfigured: true },
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
  allowExternalSearch: false,
  allowCodeExecution: false,
  ontologyExtractionMode: "rule_based",
  finalOutputExport: { markdown: true, json: true, ontologyGraph: true, artifactPackage: true },
  updatedAt: createdAt
};

export function cfdRunSpec(target: Extract<CfdRunSpec["target"], "su2" | "openvsp">): CfdRunSpec {
  return {
    target,
    geometry: { source: "configuredCase", description: "Planner test uses an explicitly configured case." },
    flightCondition: { reynolds: 1_000_000, mach: 0.05, alphaStart: 2, alphaEnd: 2, alphaStep: 1 },
    mesh: { strategy: "existing", boundaryLayer: false },
    solver: {
      name: target === "openvsp" ? "openvsp-vspaero" : "su2",
      model: target === "su2" ? "euler" : "panel",
      maxIterations: 100,
      convergenceTolerance: 1e-6
    },
    output: { polar: true, pressureField: false, mesh: false }
  };
}

export function snapshot(): ResearchSnapshot {
  return {
    project: {
      id: "project-1",
      goal: "Compare Pomodoro 25/5 and 50/10 for a two-hour study session.",
      topic: "Pomodoro 25/5 vs 50/10",
      scope: "focus fatigue completion",
      budget: "30 minutes",
      autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: false, allowCodeExecution: false },
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.CreateResearchDb,
      status: "running",
      projectRoot: ".aetherops/test"
    },
    sessions: [],
    questions: [
      { id: "q1", projectId: "project-1", text: "Which method sustains focus better?", status: "open", createdAt },
      { id: "q2", projectId: "project-1", text: "Which method reduces fatigue?", status: "open", createdAt },
      { id: "q3", projectId: "project-1", text: "Which method improves task completion?", status: "open", createdAt }
    ],
    hypotheses: [
      { id: "h1", projectId: "project-1", questionId: "q1", statement: "25/5 may reduce fatigue.", status: "untested", confidence: 0.35, createdAt },
      { id: "h2", projectId: "project-1", questionId: "q3", statement: "50/10 may improve deep work.", status: "untested", confidence: 0.35, createdAt }
    ],
    evidence: [
      {
        id: "e1",
        projectId: "project-1",
        category: "web_source",
        title: "Study break observation",
        summary: "Frequent short breaks may help fatigue management during studying.",
        sourceId: "s1",
        sourceUri: "https://arxiv.org/abs/2401.00001",
        citation: "Open academic study-break paper - https://arxiv.org/abs/2401.00001",
        keywords: ["pomodoro", "breaks", "fatigue"],
        linkedHypothesisIds: ["h1"],
        reliabilityScore: 0.7,
        relevanceScore: 0.8,
        evidenceStrength: "strong",
        limitations: [],
        createdAt
      },
      {
        id: "gap1",
        projectId: "project-1",
        category: "experiment_log",
        title: "Search unavailable",
        summary: "External search is disabled.",
        keywords: ["evidence_gap", "tool_unavailable"],
        linkedHypothesisIds: ["h2"],
        reliabilityScore: 0.1,
        relevanceScore: 0.3,
        evidenceStrength: "weak",
        limitations: ["Gap log only."],
        createdAt
      }
    ],
    artifacts: [
      {
        id: "a1",
        projectId: "project-1",
        category: "generated_artifact",
        title: "Mini experiment design",
        relativePath: "artifacts/iteration-1/design.md",
        mimeType: "text/markdown",
        summary: "A mini experiment design for comparing 25/5 and 50/10.",
        content: "Measure focus, fatigue, and completion for Pomodoro 25/5 and 50/10.",
        createdAt
      }
    ],
    sources: [
      {
        id: "s1",
        projectId: "project-1",
        kind: "paper",
        title: "Study break observation",
        url: "https://arxiv.org/abs/2401.00001",
        retrievedAt: createdAt,
        metadata: {},
        createdAt
      }
    ],
    researchInputs: [
      {
        id: "input-1",
        projectId: "project-1",
        researchQuestion: "Which Pomodoro pattern is better for a two-hour study session?",
        initialHypotheses: ["25/5 may reduce fatigue.", "50/10 may improve deep work."],
        constraints: ["No live experiment."],
        expectedOutputs: ["final report"],
        createdAt
      }
    ],
    chunks: [],
    toolRuns: [],
    agentPlans: [],
    researchPlans: [
      {
        id: "plan-1",
        projectId: "project-1",
        iteration: 1,
        objective: "Compare cited study-break evidence.",
        targetQuestions: ["q1", "q2"],
        targetHypotheses: ["h1", "h2"],
        requiredTools: ["OpenCodeTool"],
        expectedSources: ["web source"],
        expectedArtifacts: ["comparison note"],
        executionSteps: ["Collect sources", "Normalize evidence"],
        stopCriteria: ["Cited evidence covers hypotheses"],
        createdAt
      }
    ],
    specifications: [
      {
        id: "spec-1",
        projectId: "project-1",
        researchQuestions: ["Which method sustains focus better?", "Which method reduces fatigue?", "Which method improves task completion?"],
        initialHypotheses: ["25/5 may reduce fatigue.", "50/10 may improve deep work."],
        refinedHypotheses: ["25/5 reduces fatigue better than 50/10.", "50/10 improves deep-work completion better than 25/5."],
        scope: "Two-hour study session.",
        assumptions: ["No live experiment."],
        constraints: ["Avoid medical certainty."],
        successCriteria: ["Cited evidence and clear limitations."],
        requiredEvidenceTypes: ["web source", "citation"],
        competencyQuestions: ["Which hypothesis has cited support?"],
        evaluationMetrics: ["focus", "fatigue", "completion"],
        createdAt
      }
    ],
    normalizedRecords: [],
    ontologyEntities: [],
    ontologyRelations: [],
    ontologyConstraints: [],
    projectContextSnapshots: [],
    hybridContexts: [],
    validationResults: [],
    continuationDecisions: [],
    finalOutputs: [],
    runAuditOutputs: [],
    benchmarkPlans: [],
    runtimeBlockers: [],
    stepErrors: [],
    openCodeRuns: [],
    ragContexts: [],
    results: [],
    iterations: []
  };
}

export function supportRecord(
  id: string,
  evidenceId: string,
  traceabilityKind: string,
  sourceQualityTier: string,
  canSupportHypothesis: boolean
): ResearchSnapshot["normalizedRecords"][number] {
  return {
    id,
    projectId: "project-1",
    memoryScope: "global",
    validationStatus: "normalized",
    iteration: 1,
    kind: "evidence",
    title: `Pomodoro ${id}`,
    content: `Pomodoro fatigue focus study evidence ${id}`,
    sourceId: "s1",
    evidenceId,
    citation: sourceQualityTier === "scholarly" ? `https://example.com/${id}` : undefined,
    sourceUri: `https://example.com/${id}`,
    metadata: { traceabilityKind, sourceQualityTier, canSupportHypothesis },
    confidence: 0.8,
    createdAt
  };
}
