import { describe, expect, it } from "vitest";
import { ResearchLoopStep, type AppSettings, type ResearchToolInput } from "../../../core/shared/types.js";
import { BrowserResearchTool } from "./browserResearchTool.js";
import type { BrowserCollectInput, BrowserPageCollector } from "./backgroundBrowserRuntime.js";

const createdAt = "2026-05-21T00:00:00.000Z";

const settings: AppSettings = {
  codex: { model: "gpt-5.6", reasoningEffort: "xhigh", timeoutMs: 180_000, taskTimeoutMs: 600_000 },
  webSearch: { provider: "disabled" },
  embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536, apiKey: "test-key", apiKeyConfigured: true },
  browserUse: { enabled: true, mode: "background", maxPages: 2, timeoutMs: 30_000, captureScreenshots: true },
  allowExternalSearch: true,
  allowCodeExecution: false,
  ontologyExtractionMode: "rule_based",
  finalOutputExport: { markdown: true, json: true, ontologyGraph: true, artifactPackage: true },
  updatedAt: createdAt
};

describe("BrowserResearchTool", () => {
  it("converts background Chromium pages into sources, artifacts, and evidence", async () => {
    const collector: BrowserPageCollector = {
      collect: async (input: BrowserCollectInput) => [
        {
          url: input.urls?.[0] ?? "https://example.test/research",
          title: "Collected research page",
          text: "This page contains relevant research context about study breaks, fatigue, and task completion.",
          screenshotBase64: Buffer.from("png").toString("base64"),
          screenshotMimeType: "image/png"
        }
      ]
    };

    const result = await new BrowserResearchTool(collector).run(input(), settings);

    expect(result.toolRun.status).toBe("completed");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].kind).toBe("web");
    expect(result.sources[0].metadata.sourceQualityTier).toBeTruthy();
    expect(result.evidence[0].sourceUri).toBe("https://example.test/research");
    expect(result.evidence[0].keywords).not.toContain("manufacturing");
    expect(result.artifacts.some((artifact) => artifact.relativePath.includes("browser/page-1.md"))).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.relativePath.includes("screenshot"))).toBe(true);
  });

  it("prioritizes public scholarly discovery terms in the browser query", async () => {
    let capturedQuery = "";
    const collector: BrowserPageCollector = {
      collect: async (input: BrowserCollectInput) => {
        capturedQuery = input.query;
        return [
          {
            url: "https://arxiv.org/abs/2401.00001",
            title: "Open academic paper",
            text: "A paper-like source with traceable academic metadata."
          }
        ];
      }
    };

    const result = await new BrowserResearchTool(collector).run(input(), settings);

    expect(capturedQuery).toContain("Google Scholar");
    expect(capturedQuery).toContain("Semantic Scholar");
    expect(capturedQuery).toContain("Crossref");
    expect(result.evidence[0].reliabilityScore).toBeGreaterThanOrEqual(0.8);
    expect(result.evidence[0].evidenceStrength).toBe("strong");
  });

  it("throws a structured tool error when browser use is disabled", async () => {
    const disabled = {
      ...settings,
      browserUse: { ...settings.browserUse, enabled: false }
    };
    const collector: BrowserPageCollector = {
      collect: async () => {
        throw new Error("should not be called");
      }
    };

    await expect(new BrowserResearchTool(collector).run(input(), disabled)).rejects.toThrow("background browser is disabled");
  });

  it("uses plan URLs directly and prohibits search in allowlist mode", async () => {
    let captured: BrowserCollectInput | undefined;
    const collector: BrowserPageCollector = {
      collect: async (value) => {
        captured = value;
        return [{ url: "https://example.test/planned", title: "Planned", text: "planned page" }];
      }
    };
    const runInput = input();
    runInput.researchPlan = {
      id: "plan-browser",
      projectId: runInput.project.id,
      iteration: 1,
      objective: "Inspect explicit page",
      targetQuestions: [],
      targetHypotheses: [],
      requiredTools: ["BackgroundBrowserTool"],
      expectedSources: [],
      expectedArtifacts: [],
      executionSteps: [],
      stopCriteria: [],
      fetchCandidateUrls: ["https://example.test/planned"],
      createdAt
    };
    runInput.executionContext = {
      toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "allowlist", urls: ["https://example.test/planned"] } }
    };
    await new BrowserResearchTool(collector).run(runInput, settings);
    expect(captured?.query).toBe("");
    expect(captured?.urls).toEqual(["https://example.test/planned"]);
  });

  it("fails instead of silently dropping an out-of-policy plan URL", async () => {
    const runInput = input();
    runInput.researchPlan = {
      id: "plan-browser-denied",
      projectId: runInput.project.id,
      iteration: 1,
      objective: "Inspect explicit page",
      targetQuestions: [],
      targetHypotheses: [],
      requiredTools: ["BackgroundBrowserTool"],
      expectedSources: [],
      expectedArtifacts: [],
      executionSteps: [],
      stopCriteria: [],
      fetchCandidateUrls: ["https://outside.example/"],
      createdAt
    };
    runInput.executionContext = {
      toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "allowlist", urls: ["https://example.test/planned"] } }
    };
    await expect(new BrowserResearchTool({ collect: async () => [] }).run(runInput, settings)).rejects.toThrow(/outside the job allowlist/);
  });

  it("keeps plan URLs ahead of ranked evidence URLs", async () => {
    let captured: BrowserCollectInput | undefined;
    const runInput = input();
    runInput.researchPlan = {
      id: "plan-browser-priority",
      projectId: runInput.project.id,
      iteration: 1,
      objective: "Inspect explicit page",
      targetQuestions: [],
      targetHypotheses: [],
      requiredTools: ["BackgroundBrowserTool"],
      expectedSources: [],
      expectedArtifacts: [],
      executionSteps: [],
      stopCriteria: [],
      fetchCandidateUrls: ["https://example.test/planned"],
      createdAt
    };
    runInput.executionContext = {
      toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "discovery", allowedDomains: [] } }
    };
    await new BrowserResearchTool({
      collect: async (value) => {
        captured = value;
        return [{ url: value.urls?.[0] ?? "https://example.test/planned", title: "Planned", text: "planned page" }];
      }
    }).run(runInput, settings);
    expect(captured?.urls?.[0]).toBe("https://example.test/planned");
    expect(captured?.query).toBe("");
  });
});

function input(): ResearchToolInput {
  return {
    project: {
      id: "project-browser",
      goal: "Verify browser collection",
      topic: "study break research",
      scope: "web evidence collection",
      budget: "short",
      autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: true, allowCodeExecution: false },
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.ExecuteTools,
      status: "running",
      projectRoot: ".aetherops/projects/project-browser"
    },
    questions: [{ id: "q1", projectId: "project-browser", text: "What evidence is available?", status: "open", createdAt }],
    hypotheses: [
      {
        id: "h1",
        projectId: "project-browser",
        questionId: "q1",
        statement: "Web evidence can be collected without controlling the user's Chrome.",
        status: "untested",
        confidence: 0.4,
        createdAt
      }
    ],
    evidence: [
      {
        id: "e1",
        projectId: "project-browser",
        category: "web_source",
        title: "Seed URL",
        summary: "Seed URL for browser verification.",
        sourceUri: "https://example.test/research",
        keywords: ["seed"],
        linkedHypothesisIds: ["h1"],
        createdAt
      }
    ],
    artifacts: [],
    iteration: 1
  };
}
