import { ResearchLoopStep, type AppSettings, type ResearchProject, type ResearchSnapshot, type RuntimeRequirement } from "./types.js";

export class RuntimeRequirementError extends Error {
  readonly step: ResearchLoopStep;
  readonly unmetRequirements: RuntimeRequirement[];

  constructor(step: ResearchLoopStep, unmetRequirements: RuntimeRequirement[]) {
    super(unmetRequirements.map((item) => item.message ?? `${item.label} is required.`).join("\n"));
    this.name = "RuntimeRequirementError";
    this.step = step;
    this.unmetRequirements = unmetRequirements;
  }
}

export interface RuntimeRequirementContext {
  snapshot: ResearchSnapshot;
  settings: AppSettings;
  llmAvailable: boolean;
  openCodeReady?: boolean;
  storageWritable?: boolean;
}

export class RuntimeRequirementChecker {
  checkRequirements(step: ResearchLoopStep, context: RuntimeRequirementContext): RuntimeRequirement[] {
    const requirements: RuntimeRequirement[] = [];
    const project = context.snapshot.project;
    const settings = context.settings;

    if (step === ResearchLoopStep.InputResearchQuestionHypothesis) {
      requirements.push(requirement("research_input", "연구 질문/가설 입력", step, hasResearchInput(context.snapshot), "명시적인 연구 질문과 초기 가설을 입력해야 합니다."));
    }

    if (requiresLlm(step)) {
      requirements.push(requirement("llm", "LLM provider", step, context.llmAvailable, "LLM 설정 또는 Codex OAuth 인증이 필요합니다."));
    }

    if (step === ResearchLoopStep.ExecuteTools) {
      requirements.push(requirement("opencode.enabled", "OpenCode 사용 설정", step, settings.openCode.enabled, "OpenCode 도구 엔진을 활성화해야 합니다."));
      requirements.push(requirement("opencode.command", "OpenCode command/path", step, Boolean(settings.openCode.command?.trim()), "OpenCode command/path가 필요합니다."));
      if (context.openCodeReady !== undefined) {
        requirements.push(requirement("opencode.preflight", "OpenCode CLI 준비 상태", step, context.openCodeReady, "OpenCode CLI를 실행할 수 없습니다."));
      }
      requirements.push(...requiredToolRequirements(step, project, settings, context.snapshot.researchPlans.at(-1)?.requiredTools ?? []));
    }

    if (step === ResearchLoopStep.BuildVectorIndex) {
      const embedding = settings.embedding;
      const providerConfigured = embedding.provider !== "local" && Boolean(embedding.provider) && Boolean(embedding.model?.trim());
      const keyConfigured = embedding.provider === "custom" ? Boolean(embedding.apiKey && embedding.baseUrl) : Boolean(embedding.apiKey);
      requirements.push(
        requirement(
          "embedding.provider",
          "Embedding provider",
          step,
          providerConfigured,
          "실제 embedding provider와 모델이 필요합니다. 로컬 해시 임베딩은 production index에 사용할 수 없습니다."
        )
      );
      requirements.push(requirement("embedding.apiKey", "Embedding API key", step, keyConfigured, "Embedding API key가 필요합니다."));
    }

    if (step === ResearchLoopStep.BuildOntologyGraph) {
      const mode = settings.ontologyExtractionMode;
      const modeConfigured = mode === "rule_based" || mode === "llm" || mode === "hybrid";
      requirements.push(requirement("ontology.mode", "Ontology extraction mode", step, modeConfigured, "Ontology extraction mode를 설정해야 합니다."));
      if (mode === "llm" || mode === "hybrid") {
        requirements.push(requirement("ontology.llm", "Ontology LLM extraction", step, context.llmAvailable, "선택한 ontology extraction mode에는 LLM이 필요합니다."));
      }
    }

    if (step === ResearchLoopStep.FinalizeOutputs) {
      requirements.push(requirement("storage.writable", "프로젝트 저장소 쓰기 권한", step, context.storageWritable ?? true, "최종 산출물을 저장할 수 없습니다."));
    }

    return requirements;
  }

  assertStepReady(step: ResearchLoopStep, context: RuntimeRequirementContext): void {
    const unmet = this.checkRequirements(step, context).filter((item) => !item.isSatisfied);
    if (unmet.length) {
      throw new RuntimeRequirementError(step, unmet);
    }
  }
}

function requirement(key: string, label: string, step: ResearchLoopStep, isSatisfied: boolean, message: string): RuntimeRequirement {
  return {
    key,
    label,
    requiredForSteps: [step],
    isSatisfied,
    message: isSatisfied ? undefined : message
  };
}

function requiresLlm(step: ResearchLoopStep): boolean {
  return step === ResearchLoopStep.BuildResearchSpecification || step === ResearchLoopStep.PlanResearch || step === ResearchLoopStep.SynthesizeAndEvaluate;
}

function hasResearchInput(snapshot: ResearchSnapshot): boolean {
  return snapshot.researchInputs.some((input) => input.researchQuestion.trim() && input.initialHypotheses.length > 0);
}

function requiredToolRequirements(
  step: ResearchLoopStep,
  project: ResearchProject,
  settings: AppSettings,
  requiredTools: string[]
): RuntimeRequirement[] {
  const requirements: RuntimeRequirement[] = [];
  const normalizedTools = new Set(requiredTools.map(normalizeToolName));

  if (normalizedTools.has("websearchtool") || normalizedTools.has("backgroundbrowsertool")) {
    requirements.push(requirement("webSearch.allowed", "외부 검색 허용", step, project.autonomyPolicy.allowExternalSearch && settings.allowExternalSearch, "연구 계획이 외부 검색을 요구하지만 외부 검색이 비활성화되어 있습니다."));
    if (normalizedTools.has("websearchtool")) {
      const configured = settings.webSearch.provider !== "disabled" && Boolean(settings.webSearch.apiKey || settings.webSearch.apiKeyConfigured);
      requirements.push(requirement("webSearch.provider", "Web search provider/API key", step, configured, "Web search provider와 API key가 필요합니다."));
    }
    if (normalizedTools.has("backgroundbrowsertool")) {
      requirements.push(requirement("browserUse.enabled", "내장 Chromium 브라우저", step, settings.browserUse.enabled, "내장 Chromium 브라우저 도구가 비활성화되어 있습니다."));
    }
  }

  if (normalizedTools.has("codeexecutiontool")) {
    requirements.push(requirement("codeExecution.allowed", "코드 실행 허용", step, project.autonomyPolicy.allowCodeExecution && settings.allowCodeExecution, "연구 계획이 코드 실행을 요구하지만 코드 실행이 비활성화되어 있습니다."));
  }

  return requirements;
}

function normalizeToolName(value: string): string {
  return value.replace(/\(.*?\)/g, "").replace(/\s+/g, "").trim().toLowerCase();
}
