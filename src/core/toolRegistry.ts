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
      throw new Error("외부 검색이 프로젝트 또는 앱 설정에서 비활성화되어 있습니다.");
    }
    if (settings.webSearch.provider === "disabled" || !settings.webSearch.apiKey) {
      throw new Error("검색 provider와 API key가 설정되어 있지 않습니다.");
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
      throw new Error(`검색 실패: ${formatError(error)}`);
    }
  }

  private async search(settings: AppSettings, query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
    if (settings.webSearch.provider === "custom" && settings.webSearch.endpoint) {
      const response = await fetch(`${settings.webSearch.endpoint}${settings.webSearch.endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error(`custom search failed: ${response.status} ${response.statusText}`);
      const parsed = (await response.json()) as { results?: Array<{ title?: string; url?: string; snippet?: string }> };
      return normalizeSearchResults(parsed.results);
    }

    if (settings.webSearch.provider === "brave") {
      const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
        headers: { accept: "application/json", "x-subscription-token": settings.webSearch.apiKey ?? "" }
      });
      if (!response.ok) throw new Error(`brave search failed: ${response.status} ${response.statusText}`);
      const parsed = (await response.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
      return normalizeSearchResults(parsed.web?.results?.map((item) => ({ ...item, snippet: item.description })));
    }

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: settings.webSearch.apiKey, query, max_results: 5 })
    });
    if (!response.ok) throw new Error(`tavily search failed: ${response.status} ${response.statusText}`);
    const parsed = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return normalizeSearchResults(parsed.results?.map((item) => ({ ...item, snippet: item.content })));
  }
}

export class WebFetchTool implements ResearchTool {
  name = "WebFetchTool";

  async run(input: OpenCodeRunInput): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const urls = (input.evidence ?? []).map((item) => item.sourceUri).filter((url): url is string => Boolean(url)).slice(0, 3);
    if (!urls.length) {
      throw new Error("WebFetchTool requires at least one source URL from previous evidence.");
    }
    const completedAt = nowIso();
    return {
      toolRun: {
        id: createId("tool"),
        projectId: input.project.id,
        iteration: input.iteration,
        toolName: this.name,
        input: { urls },
        output: { reason: "URL fetch placeholder completed for configured source URLs.", urls },
        status: "completed",
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
    void input;
    throw new Error("PaperMetadataTool requires a configured paper metadata provider; none is configured.");
  }
}

export class CodeExecutionTool implements ResearchTool {
  name = "CodeExecutionTool";

  async run(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const completedAt = nowIso();
    const allowed = input.project.autonomyPolicy.allowCodeExecution && settings.allowCodeExecution;
    if (!allowed) {
      throw new Error("코드 실행이 프로젝트 또는 앱 설정에서 비활성화되어 있습니다.");
    }
    return {
      toolRun: {
        id: createId("tool"),
        projectId: input.project.id,
        iteration: input.iteration,
        toolName: this.name,
        input: { allowCodeExecution: allowed },
        output: { reason: "No explicit script was provided; CodeExecutionTool completed without running arbitrary code." },
        status: "completed",
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
      "## 목표",
      input.project.goal,
      "",
      "## 현재 질문",
      ...input.questions.map((item) => `- ${item.text}`),
      "",
      "## 검증 가설",
      ...input.hypotheses.map((item) => `- ${item.statement} (${item.status}, confidence=${item.confidence})`),
      "",
      "## RAG 요약",
      input.ragContext?.summary ?? "아직 구성된 RAG context가 없습니다.",
      "",
      "## 한계",
      "- 자동 검색 또는 OpenCode 도구 호출이 불가능하면 산출물은 결론이 아니라 계획과 gap 정리에 집중합니다.",
      "- 실제 출처가 없는 내용은 사실 근거로 간주하지 않습니다."
    ].join("\n");
    const artifact: ResearchArtifact = {
      id: createId("artifact"),
      projectId: input.project.id,
      category: "generated_artifact",
      title: `Iteration ${input.iteration} research note`,
      relativePath: `artifacts/iteration-${input.iteration}/research-note.md`,
      mimeType: "text/markdown",
      summary: "현재 질문, 가설, RAG 요약, 한계를 정리한 반복 연구 노트입니다.",
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
          limitations: ["도구가 생성한 산출물이며 외부 원천 근거가 아닙니다."],
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
    void input;
    throw new Error("PdfIngestionTool requires explicit PDF file paths; none were provided.");
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
      evidence: [],
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
