import { createId, nowIso } from "./ids.js";
import type { AppSettings, OpenCodeAdapter, OpenCodeRunInput, OpenCodeRunOutput } from "./types.js";

export class MockOpenCodeAdapter implements OpenCodeAdapter {
  constructor(private readonly getSettings?: () => AppSettings | Promise<AppSettings>) {}

  async run(input: OpenCodeRunInput): Promise<OpenCodeRunOutput> {
    const settings = await this.getSettings?.();
    const llmLabel = settings ? describeOpenCodeLlm(settings) : "mock/default";
    const startedAt = nowIso();
    const completedAt = nowIso();
    const openHypotheses = input.hypotheses.filter((item) => item.status !== "supported");
    const targetHypothesisIds = openHypotheses.length
      ? openHypotheses.map((item) => item.id)
      : input.hypotheses.map((item) => item.id);

    const artifact = {
      id: createId("artifact"),
      projectId: input.project.id,
      category: "generated_artifact" as const,
      title: `Iteration ${input.iteration} analysis script`,
      relativePath: `artifacts/iteration-${input.iteration}/analysis.md`,
      mimeType: "text/markdown",
      summary: `${input.project.topic} 연구를 위한 mock OpenCode 분석 산출물입니다.`,
      createdAt: completedAt
    };

    const evidence = {
      id: createId("evidence"),
      projectId: input.project.id,
      category: "experiment_log" as const,
      title: `OpenCode 실행 로그 ${input.iteration}`,
      summary:
        input.ragContext?.summary ??
        "초기 질문과 가설을 바탕으로 분석, 자료 정리, 다음 실행 계획을 도출했습니다.",
      keywords: ["opencode", "analysis", `iteration-${input.iteration}`],
      linkedHypothesisIds: targetHypothesisIds,
      createdAt: completedAt
    };

    return {
      run: {
        id: createId("opencode"),
        projectId: input.project.id,
        iteration: input.iteration,
        prompt: this.buildPrompt(input),
        toolPlan: ["analyze-context", "draft-script", "summarize-evidence"],
        status: "completed",
        logs: [
          "AetherOps 연구 에이전트가 OpenCode 실행을 지시했습니다.",
          `OpenCode LLM setting: ${llmLabel}.`,
          "mock adapter가 분석, 코드/스크립트 계획, 근거 요약을 생성했습니다.",
          "실제 OpenCode SDK/서버 연결 시 이 adapter만 교체합니다."
        ],
        artifactIds: [artifact.id],
        evidenceIds: [evidence.id],
        startedAt,
        completedAt
      },
      artifacts: [artifact],
      evidence: [evidence]
    };
  }

  private buildPrompt(input: OpenCodeRunInput): string {
    const questionText = input.questions.map((item) => `- ${item.text}`).join("\n");
    const hypothesisText = input.hypotheses.map((item) => `- ${item.statement}`).join("\n");
    return [
      `Research goal: ${input.project.goal}`,
      `Topic: ${input.project.topic}`,
      "Questions:",
      questionText,
      "Hypotheses:",
      hypothesisText,
      input.ragContext ? `RAG context: ${input.ragContext.summary}` : "RAG context: not built yet"
    ].join("\n");
  }
}

function describeOpenCodeLlm(settings: AppSettings): string {
  const llm = settings.openCodeLlm;
  if (llm.source === "codex-oauth") {
    return `codex-oauth${llm.model ? `/${llm.model}` : ""}`;
  }
  const keyState = llm.apiKeyConfigured || llm.apiKey ? "key configured" : "key missing";
  return `${llm.provider}/${llm.model}${llm.baseUrl ? ` via ${llm.baseUrl}` : ""} (${keyState})`;
}
