import { createId, nowIso } from "./ids.js";
import type {
  AppSettings,
  EvidenceItem,
  OpenCodeRunInput,
  ResearchArtifact,
  ResearchSource,
  ToolRun
} from "./types.js";

export interface ResearchToolResult {
  toolRun: ToolRun;
  evidence: EvidenceItem[];
  artifacts: ResearchArtifact[];
  sources: ResearchSource[];
}

export interface ResearchTool {
  name: string;
  run(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult>;
}

export class WebSearchTool implements ResearchTool {
  name = "WebSearchTool";

  async run(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const query = input.project.topic;
    if (!input.project.autonomyPolicy.allowExternalSearch || !settings.allowExternalSearch) {
      return this.skipped(input, startedAt, query, "외부 검색이 프로젝트 또는 앱 설정에서 비활성화되어 있습니다.");
    }
    if (settings.webSearch.provider === "disabled" || !settings.webSearch.apiKey) {
      return this.skipped(input, startedAt, query, "검색 provider 또는 API key가 설정되어 있지 않습니다.");
    }

    try {
      const results = await this.search(settings, query);
      const completedAt = nowIso();
      const sources = results.map((result) => ({
        id: createId("source"),
        projectId: input.project.id,
        kind: "web" as const,
        title: result.title,
        url: result.url,
        retrievedAt: completedAt,
        metadata: { snippet: result.snippet, provider: settings.webSearch.provider },
        createdAt: completedAt
      }));
      const evidence = results.slice(0, 5).map((result, index) => ({
        id: createId("evidence"),
        projectId: input.project.id,
        category: "web_source" as const,
        title: result.title,
        summary: result.snippet || "검색 결과 snippet이 제공되지 않았습니다.",
        sourceId: sources[index]?.id,
        sourceUri: result.url,
        citation: `${result.title} - ${result.url}`,
        keywords: ["web", "search", ...input.project.topic.split(/\s+/).slice(0, 4)],
        linkedHypothesisIds: input.hypotheses.map((item) => item.id),
        reliabilityScore: 0.55,
        relevanceScore: 0.65,
        evidenceStrength: "medium" as const,
        limitations: ["검색 결과 snippet 기반이므로 원문 확인이 필요합니다."],
        createdAt: completedAt
      }));

      return {
        toolRun: {
          id: createId("tool"),
          projectId: input.project.id,
          iteration: input.iteration,
          toolName: this.name,
          input: { query, provider: settings.webSearch.provider },
          output: { resultCount: results.length },
          status: "completed",
          startedAt,
          completedAt
        },
        evidence,
        artifacts: [],
        sources
      };
    } catch (error) {
      return this.skipped(input, startedAt, query, `검색 실패: ${formatError(error)}`);
    }
  }

  private async search(settings: AppSettings, query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
    if (settings.webSearch.provider === "custom" && settings.webSearch.endpoint) {
      const response = await fetch(`${settings.webSearch.endpoint}${settings.webSearch.endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`);
      const parsed = (await response.json()) as { results?: Array<{ title?: string; url?: string; snippet?: string }> };
      return normalizeSearchResults(parsed.results);
    }

    if (settings.webSearch.provider === "brave") {
      const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
        headers: { accept: "application/json", "x-subscription-token": settings.webSearch.apiKey ?? "" }
      });
      const parsed = (await response.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
      return normalizeSearchResults(parsed.web?.results?.map((item) => ({ ...item, snippet: item.description })));
    }

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: settings.webSearch.apiKey, query, max_results: 5 })
    });
    const parsed = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return normalizeSearchResults(parsed.results?.map((item) => ({ ...item, snippet: item.content })));
  }

  private skipped(input: OpenCodeRunInput, startedAt: string, query: string, reason: string): ResearchToolResult {
    const completedAt = nowIso();
    return {
      toolRun: {
        id: createId("tool"),
        projectId: input.project.id,
        iteration: input.iteration,
        toolName: this.name,
        input: { query },
        output: { reason },
        status: "skipped",
        error: "tool_unavailable",
        startedAt,
        completedAt
      },
      evidence: [
        {
          id: createId("evidence"),
          projectId: input.project.id,
          category: "experiment_log",
          title: "외부 검색 evidence_gap",
          summary: reason,
          keywords: ["tool_unavailable", "evidence_gap", "web_search"],
          linkedHypothesisIds: input.hypotheses.map((item) => item.id),
          reliabilityScore: 0.15,
          relevanceScore: 0.4,
          evidenceStrength: "weak",
          limitations: ["검색 API가 없어 실제 외부 근거를 확인하지 못했습니다."],
          createdAt: completedAt
        }
      ],
      artifacts: [],
      sources: []
    };
  }
}

export class WebFetchTool implements ResearchTool {
  name = "WebFetchTool";

  async run(input: OpenCodeRunInput): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const urls = (input.evidence ?? []).map((item) => item.sourceUri).filter((url): url is string => Boolean(url)).slice(0, 3);
    const completedAt = nowIso();
    return {
      toolRun: {
        id: createId("tool"),
        projectId: input.project.id,
        iteration: input.iteration,
        toolName: this.name,
        input: { urls },
        output: { reason: urls.length ? "원문 fetch는 후속 단계에서 처리합니다." : "fetch할 URL이 없습니다." },
        status: "skipped",
        error: urls.length ? undefined : "tool_unavailable",
        startedAt,
        completedAt
      },
      evidence: [],
      artifacts: [],
      sources: []
    };
  }
}

export class PaperMetadataTool implements ResearchTool {
  name = "PaperMetadataTool";

  async run(input: OpenCodeRunInput): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const completedAt = nowIso();
    return {
      toolRun: {
        id: createId("tool"),
        projectId: input.project.id,
        iteration: input.iteration,
        toolName: this.name,
        input: { query: input.project.topic },
        output: { reason: "공개 논문 metadata API는 안정성을 위해 MVP에서 자동 호출하지 않습니다." },
        status: "skipped",
        error: "tool_unavailable",
        startedAt,
        completedAt
      },
      evidence: [
        {
          id: createId("evidence"),
          projectId: input.project.id,
          category: "paper_reference",
          title: "논문 metadata evidence_gap",
          summary: "논문 API가 설정되지 않았거나 자동 호출이 비활성화되어 DOI/초록 기반 근거를 확보하지 못했습니다.",
          keywords: ["paper", "metadata", "evidence_gap"],
          linkedHypothesisIds: input.hypotheses.map((item) => item.id),
          reliabilityScore: 0.15,
          relevanceScore: 0.35,
          evidenceStrength: "weak",
          limitations: ["실제 논문 근거가 아니며, 후속 검색 또는 수동 PDF 입력이 필요합니다."],
          createdAt: completedAt
        }
      ],
      artifacts: [],
      sources: []
    };
  }
}

export class CodeExecutionTool implements ResearchTool {
  name = "CodeExecutionTool";

  async run(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const completedAt = nowIso();
    const allowed = input.project.autonomyPolicy.allowCodeExecution && settings.allowCodeExecution;
    return {
      toolRun: {
        id: createId("tool"),
        projectId: input.project.id,
        iteration: input.iteration,
        toolName: this.name,
        input: { allowCodeExecution: allowed },
        output: {
          reason: allowed
            ? "MVP에서는 안전한 명시 스크립트가 있을 때만 별도 실행합니다."
            : "코드 실행이 프로젝트 또는 앱 설정에서 비활성화되어 있습니다."
        },
        status: "skipped",
        error: allowed ? undefined : "tool_unavailable",
        startedAt,
        completedAt
      },
      evidence: [],
      artifacts: [],
      sources: []
    };
  }
}

export class ArtifactWriterTool implements ResearchTool {
  name = "ArtifactWriterTool";

  async run(input: OpenCodeRunInput): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const completedAt = nowIso();
    const content = [
      `# Iteration ${input.iteration} 연구 노트`,
      "",
      `## 목표`,
      input.project.goal,
      "",
      `## 현재 질문`,
      ...input.questions.map((item) => `- ${item.text}`),
      "",
      `## 검증 가설`,
      ...input.hypotheses.map((item) => `- ${item.statement} (${item.status}, confidence=${item.confidence})`),
      "",
      `## RAG 요약`,
      input.ragContext?.summary ?? "아직 구성된 RAG context가 없습니다.",
      "",
      "## 한계",
      "- 자동 검색 또는 OpenCode 실행이 불가능하면 이 산출물은 계획과 gap 정리에 집중합니다.",
      "- 실제 출처가 없는 내용은 논문 근거로 간주하지 않습니다."
    ].join("\n");
    const artifact: ResearchArtifact = {
      id: createId("artifact"),
      projectId: input.project.id,
      category: "generated_artifact",
      title: `Iteration ${input.iteration} research note`,
      relativePath: `artifacts/iteration-${input.iteration}/research-note.md`,
      mimeType: "text/markdown",
      summary: "현재 질문, 가설, RAG 요약, 근거 공백을 정리한 반복 연구 노트입니다.",
      content,
      createdAt: completedAt
    };
    return {
      toolRun: {
        id: createId("tool"),
        projectId: input.project.id,
        iteration: input.iteration,
        toolName: this.name,
        input: { relativePath: artifact.relativePath },
        output: { artifactId: artifact.id },
        status: "completed",
        startedAt,
        completedAt
      },
      evidence: [
        {
          id: createId("evidence"),
          projectId: input.project.id,
          category: "generated_artifact",
          title: artifact.title,
          summary: artifact.summary,
          sourceUri: artifact.relativePath,
          citation: artifact.relativePath,
          keywords: ["artifact", "iteration", "research_note"],
          linkedHypothesisIds: input.hypotheses.map((item) => item.id),
          reliabilityScore: 0.45,
          relevanceScore: 0.7,
          evidenceStrength: "medium",
          limitations: ["도구가 생성한 산출물이며 외부 독립 근거는 아닙니다."],
          createdAt: completedAt
        }
      ],
      artifacts: [artifact],
      sources: []
    };
  }
}

export class PdfIngestionTool implements ResearchTool {
  name = "PdfIngestionTool";

  async run(input: OpenCodeRunInput): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const completedAt = nowIso();
    return {
      toolRun: {
        id: createId("tool"),
        projectId: input.project.id,
        iteration: input.iteration,
        toolName: this.name,
        input: { projectRoot: input.project.projectRoot },
        output: { reason: "No PDF files were explicitly attached for ingestion in this MVP pass." },
        status: "skipped",
        error: "tool_unavailable",
        startedAt,
        completedAt
      },
      evidence: [
        {
          id: createId("evidence"),
          projectId: input.project.id,
          category: "paper_reference",
          title: "PDF ingestion evidence_gap",
          summary: "PDF ingestion was requested as a supported research layer, but no PDF attachment/path was available.",
          keywords: ["pdf", "evidence_gap", "tool_unavailable"],
          linkedHypothesisIds: input.hypotheses.map((item) => item.id),
          reliabilityScore: 0.12,
          relevanceScore: 0.25,
          evidenceStrength: "weak",
          limitations: ["This is a gap log, not paper evidence."],
          createdAt: completedAt
        }
      ],
      artifacts: [],
      sources: []
    };
  }
}

export class DataAnalysisTool implements ResearchTool {
  name = "DataAnalysisTool";

  async run(input: OpenCodeRunInput): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const completedAt = nowIso();
    const output = {
      evidenceCount: input.evidence?.length ?? 0,
      artifactCount: input.artifacts?.length ?? 0,
      hypothesisCount: input.hypotheses.length
    };
    return {
      toolRun: {
        id: createId("tool"),
        projectId: input.project.id,
        iteration: input.iteration,
        toolName: this.name,
        input: { iteration: input.iteration },
        output,
        status: "completed",
        startedAt,
        completedAt
      },
      evidence: [
        {
          id: createId("evidence"),
          projectId: input.project.id,
          category: "experiment_log",
          title: `Iteration ${input.iteration} data coverage observation`,
          summary: `현재 evidence=${output.evidenceCount}, artifacts=${output.artifactCount}, hypotheses=${output.hypothesisCount}로 집계되었습니다.`,
          keywords: ["observation", "data_coverage", "analysis"],
          linkedHypothesisIds: input.hypotheses.map((item) => item.id),
          reliabilityScore: 0.6,
          relevanceScore: 0.55,
          evidenceStrength: "medium",
          limitations: ["This is a coverage observation, not an external source."],
          createdAt: completedAt
        }
      ],
      artifacts: [],
      sources: []
    };
  }
}

export function createDefaultResearchTools(): ResearchTool[] {
  return [
    new WebSearchTool(),
    new WebFetchTool(),
    new PaperMetadataTool(),
    new PdfIngestionTool(),
    new CodeExecutionTool(),
    new ArtifactWriterTool(),
    new DataAnalysisTool()
  ];
}

function normalizeSearchResults(items: Array<{ title?: string; url?: string; snippet?: string }> | undefined): Array<{ title: string; url: string; snippet: string }> {
  return (items ?? [])
    .map((item) => ({
      title: item.title?.trim() || item.url?.trim() || "Untitled search result",
      url: item.url?.trim() || "",
      snippet: item.snippet?.trim() || ""
    }))
    .filter((item) => item.url)
    .slice(0, 5);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
