import { createId, nowIso } from "../../core/ids.js";
import { assessSourceQuality, rankResearchUrls, sourceQualityMetadata } from "../../core/sourceQuality.js";
import type { ResearchTool, ResearchToolResult } from "../../core/toolRegistry.js";
import type { AppSettings, EvidenceItem, OpenCodeRunInput, ResearchArtifact, ResearchSource } from "../../core/types.js";
import type { BrowserCollectedPage, BrowserPageCollector } from "./backgroundBrowserRuntime.js";

export class BrowserResearchTool implements ResearchTool {
  name = "BackgroundBrowserTool";

  constructor(private readonly browser: BrowserPageCollector) {}

  async run(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    if (!settings.browserUse.enabled) {
      throw new Error("AetherOps background browser is disabled in settings.");
    }
    if (!input.project.autonomyPolicy.allowExternalSearch || !settings.allowExternalSearch) {
      throw new Error("External browsing is disabled by project autonomy or app settings.");
    }

    const query = buildQuery(input);
    const urls = extractHttpEvidenceUrls(input).slice(0, settings.browserUse.maxPages);

    try {
      const pages = await this.browser.collect({
        project: input.project,
        query,
        urls,
        settings: settings.browserUse
      });
      return completed(input, startedAt, this.name, query, pages, settings);
    } catch (error) {
      throw new Error(`Background browser failed for query "${query}": ${formatError(error)}`);
    }
  }
}

function completed(
  input: OpenCodeRunInput,
  startedAt: string,
  toolName: string,
  query: string,
  pages: BrowserCollectedPage[],
  settings: AppSettings
): ResearchToolResult {
  const completedAt = nowIso();
  const sources: ResearchSource[] = [];
  const artifacts: ResearchArtifact[] = [];
  const evidence: EvidenceItem[] = [];

  for (const [index, page] of pages.entries()) {
    const sourceId = createId("source");
    const excerpt = page.text.slice(0, 1_200);
    const quality = assessSourceQuality(page.url, page.title);
    sources.push({
      id: sourceId,
      projectId: input.project.id,
      kind: "web",
      title: page.title,
      url: page.url,
      retrievedAt: completedAt,
      metadata: {
        browserUse: true,
        query,
        excerpt,
        characterCount: page.text.length,
        ...sourceQualityMetadata(page.url, page.title)
      },
      createdAt: completedAt
    });

    artifacts.push({
      id: createId("artifact"),
      projectId: input.project.id,
      category: "web_source",
      title: `Browser page ${index + 1}: ${page.title}`,
      relativePath: `artifacts/iteration-${input.iteration}/browser/page-${index + 1}.md`,
      mimeType: "text/markdown",
      summary: excerpt || "Background browser collected this page, but no readable body text was extracted.",
      content: [`# ${page.title}`, "", `- URL: ${page.url}`, `- Query: ${query}`, "", page.text].join("\n"),
      createdAt: completedAt
    });

    if (settings.browserUse.captureScreenshots && page.screenshotBase64) {
      artifacts.push({
        id: createId("artifact"),
        projectId: input.project.id,
        category: "web_source",
        title: `Browser screenshot ${index + 1}: ${page.title}`,
        relativePath: `artifacts/iteration-${input.iteration}/browser/page-${index + 1}-screenshot.md`,
        mimeType: "text/markdown",
        summary: `Background browser screenshot for ${page.url}`,
        content: `# ${page.title}\n\n![screenshot](data:${page.screenshotMimeType ?? "image/png"};base64,${page.screenshotBase64})\n`,
        createdAt: completedAt
      });
    }

    evidence.push({
      id: createId("evidence"),
      projectId: input.project.id,
      category: "web_source",
      title: page.title,
      summary: excerpt || "Readable page text was not available.",
      sourceId,
      sourceUri: page.url,
      citation: `${page.title} - ${page.url}`,
      quote: excerpt.slice(0, 500),
      keywords: ["background_browser", "web_source", quality.tier, ...keywordSlice(input.project.topic)],
      linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
      reliabilityScore: quality.reliabilityScore,
      relevanceScore: quality.preferredForSearch ? 0.78 : 0.58,
      evidenceStrength: quality.evidenceStrength,
      limitations: [
        "Automatically collected web page text; claims still require citation-level review.",
        ...quality.limitations
      ],
      createdAt: completedAt
    });
  }

  return {
    toolRun: {
      id: createId("tool"),
      projectId: input.project.id,
      iteration: input.iteration,
      toolName,
      input: { query },
      output: {
        collectedPages: pages.length,
        urls: pages.map((page) => page.url),
        mode: settings.browserUse.mode,
        headless: settings.browserUse.mode === "background"
      },
      status: "completed",
      startedAt,
      completedAt
    },
    evidence,
    artifacts,
    sources
  };
}

function buildQuery(input: OpenCodeRunInput): string {
  const plannedQuestion = input.researchPlan?.targetQuestions.find(Boolean);
  const question = plannedQuestion ?? input.questions.find((item) => item.status === "open")?.text;
  const hypotheses = input.hypotheses.map((item) => item.statement).join(" ");
  const academicKeywords = "Google Scholar Semantic Scholar Crossref arXiv DOI NIST OECD ISO systematic review framework standard report";
  return compactSearchQuery([question, input.project.topic, input.project.goal, hypotheses, academicKeywords].filter(Boolean).join(" "));
}

function compactSearchQuery(value: string): string {
  return value
    .replace(/\b20\d{2}년?\b/g, " ")
    .replace(/검증\s*\d*[:：]?/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[{}[\]"'`]/g, " ")
    .trim()
    .slice(0, 280);
}

function extractHttpEvidenceUrls(input: OpenCodeRunInput): string[] {
  const urls = (input.evidence ?? [])
    .map((item) => item.sourceUri)
    .filter((value): value is string => Boolean(value))
    .filter((value) => value.startsWith("http://") || value.startsWith("https://"));
  return rankResearchUrls(urls);
}

function keywordSlice(value: string): string[] {
  return value.split(/\s+/).map((item) => item.trim()).filter(Boolean).slice(0, 5);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
