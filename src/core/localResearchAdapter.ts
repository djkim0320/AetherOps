import { createId, nowIso } from "./ids.js";
import type { LlmProvider } from "./llm.js";
import { NoopLlmProvider } from "./llm.js";
import { createDefaultResearchTools, type ResearchTool } from "./toolRegistry.js";
import type {
  AgentPlan,
  AppSettings,
  EvidenceItem,
  OpenCodeAdapter,
  OpenCodeRunInput,
  OpenCodeRunOutput,
  ResearchArtifact,
  ResearchSource,
  ToolRun
} from "./types.js";

type SettingsGetter = () => AppSettings | Promise<AppSettings>;

export class LocalResearchAdapter implements OpenCodeAdapter {
  constructor(
    private readonly getSettings: SettingsGetter,
    private readonly llm: LlmProvider = new NoopLlmProvider(),
    private readonly tools: ResearchTool[] = createDefaultResearchTools()
  ) {}

  async run(input: OpenCodeRunInput): Promise<OpenCodeRunOutput> {
    const settings = await this.getSettings();
    const startedAt = nowIso();
    const agentPlan = await this.createAgentPlan(input);
    const artifacts: ResearchArtifact[] = [];
    const evidence: EvidenceItem[] = [];
    const sources: ResearchSource[] = [];
    const toolRuns: ToolRun[] = [];

    for (const tool of this.tools) {
      const result = await tool.run(input, settings);
      toolRuns.push(result.toolRun);
      artifacts.push(...result.artifacts);
      evidence.push(...result.evidence);
      sources.push(...result.sources);
    }

    const completedAt = nowIso();
    const unavailableTools = toolRuns.filter((toolRun) => toolRun.status === "skipped");
    const nextActions = this.nextActions(input, unavailableTools.length > 0);
    const needsMoreEvidence = input.iteration < input.project.autonomyPolicy.maxLoopIterations && evidence.some((item) => item.keywords.includes("evidence_gap"));
    const needsMoreAnalysis = input.iteration < input.project.autonomyPolicy.maxLoopIterations && input.hypotheses.some((item) => item.status !== "supported");

    return {
      run: {
        id: createId("opencode"),
        projectId: input.project.id,
        iteration: input.iteration,
        prompt: this.buildPrompt(input),
        toolPlan: ["local-plan", ...this.tools.map((tool) => tool.name), "summarize-gaps"],
        status: "completed",
        logs: [
          "OpenCode CLI가 없거나 사용할 수 없어 LocalResearchAdapter가 안전한 fallback 연구 루프를 실행했습니다.",
          `실행 도구: ${this.tools.map((tool) => tool.name).join(", ")}`,
          unavailableTools.length ? `사용 불가 도구: ${unavailableTools.map((toolRun) => toolRun.toolName).join(", ")}` : "모든 내장 도구가 정상 처리되었습니다.",
          "실제 출처가 없는 내용은 seed evidence 또는 evidence_gap으로만 기록했습니다."
        ],
        artifactIds: artifacts.map((item) => item.id),
        evidenceIds: evidence.map((item) => item.id),
        startedAt,
        completedAt
      },
      artifacts,
      evidence,
      sources,
      toolRuns,
      agentPlan,
      nextActions,
      needsMoreEvidence,
      needsMoreAnalysis
    };
  }

  private async createAgentPlan(input: OpenCodeRunInput): Promise<AgentPlan> {
    const createdAt = nowIso();
    const defaultPlan: AgentPlan = {
      id: createId("plan"),
      projectId: input.project.id,
      iteration: input.iteration,
      objective: `${input.project.topic}에 대해 근거 공백을 확인하고 다음 검증 단계를 좁힙니다.`,
      steps: [
        "현재 질문과 가설을 확인한다.",
        "사용 가능한 검색/논문/코드 실행 도구를 점검한다.",
        "부족한 근거는 evidence_gap으로 기록한다.",
        "반복 산출물과 다음 질문을 생성한다."
      ],
      targetQuestions: input.questions.map((item) => item.id),
      targetHypotheses: input.hypotheses.map((item) => item.id),
      requiredTools: this.tools.map((tool) => tool.name),
      expectedSources: ["web", "paper", "artifact", "log"],
      expectedArtifacts: [`artifacts/iteration-${input.iteration}/research-note.md`],
      executionSteps: [
        "Review the current research plan and evidence gaps.",
        "Run available tools and record unavailable tools explicitly.",
        "Write iteration artifacts and evidence gap notes."
      ],
      stopCriteria: [
        "All target hypotheses have enough cited evidence.",
        "The maximum loop iteration is reached.",
        "No new evidence, artifacts, or normalized records are produced."
      ],
      createdAt
    };

    if (!(await this.llm.isAvailable())) {
      return defaultPlan;
    }

    try {
      const response = await this.llm.completeJson<Partial<AgentPlan>>({
        schemaName: "AetherOpsAgentPlan",
        system: "You are AetherOps. Return only valid JSON.",
        user: [
          "Create a concise executable research plan for this iteration.",
          "Return JSON keys: objective, steps, requiredTools, expectedArtifacts.",
          `Project: ${JSON.stringify(input.project)}`,
          `Questions: ${JSON.stringify(input.questions)}`,
          `Hypotheses: ${JSON.stringify(input.hypotheses)}`,
          `RAG Context: ${JSON.stringify(input.ragContext)}`
        ].join("\n"),
        timeoutMs: 120_000
      });
      return {
        ...defaultPlan,
        objective: cleanString(response.objective) || defaultPlan.objective,
        steps: normalizeStringArray(response.steps).length ? normalizeStringArray(response.steps) : defaultPlan.steps,
        requiredTools: normalizeStringArray(response.requiredTools).length ? normalizeStringArray(response.requiredTools) : defaultPlan.requiredTools,
        expectedArtifacts: normalizeStringArray(response.expectedArtifacts).length
          ? normalizeStringArray(response.expectedArtifacts)
          : defaultPlan.expectedArtifacts
      };
    } catch {
      return defaultPlan;
    }
  }

  private nextActions(input: OpenCodeRunInput, hasUnavailableTools: boolean): string[] {
    const actions = [
      "RAG context에 연결된 근거의 citation/sourceUri를 검토한다.",
      "가설별로 추가 검증이 필요한 근거를 좁힌다."
    ];
    if (hasUnavailableTools) {
      actions.unshift("OpenCode CLI, 검색 API, 논문 metadata API 중 필요한 설정을 보완한다.");
    }
    if (input.project.autonomyPolicy.allowExternalSearch) {
      actions.push("외부 검색이 가능하면 공개 자료 3~5개를 확보한다.");
    }
    return actions;
  }

  private buildPrompt(input: OpenCodeRunInput): string {
    return [
      `Research goal: ${input.project.goal}`,
      `Topic: ${input.project.topic}`,
      `Scope: ${input.project.scope}`,
      `Iteration: ${input.iteration}`,
      "Questions:",
      ...input.questions.map((item) => `- ${item.text}`),
      "Hypotheses:",
      ...input.hypotheses.map((item) => `- ${item.statement}`),
      input.ragContext?.contextText ? `RAG Context:\n${input.ragContext.contextText}` : "RAG Context: not available"
    ].join("\n");
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean).slice(0, 12) : [];
}
