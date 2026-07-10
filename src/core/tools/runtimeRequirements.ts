import { ResearchLoopStep, type AppSettings, type ResearchProject, type ResearchSnapshot, type RuntimeRequirement } from "../shared/types.js";
import { hasExecutableEngineeringTool } from "./engineeringProgramTool.js";
import { normalizeToolName } from "./toolRunner.js";

export class RuntimeRequirementError extends Error {
  readonly step: ResearchLoopStep;
  readonly unmetRequirements: RuntimeRequirement[];

  constructor(step: ResearchLoopStep, unmetRequirements: RuntimeRequirement[]) {
    super(formatRequirementMessages(unmetRequirements));
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
  registeredToolNames?: string[];
}

export class RuntimeRequirementChecker {
  checkRequirements(step: ResearchLoopStep, context: RuntimeRequirementContext): RuntimeRequirement[] {
    const requirements: RuntimeRequirement[] = [];
    const project = context.snapshot.project;
    const settings = context.settings;

    if (step === ResearchLoopStep.InputResearchQuestionHypothesis) {
      requirements.push(
        requirement("research_input", "연구 질문/가설 입력", step, hasResearchInput(context.snapshot), "명시적인 연구 질문과 초기 가설을 입력해야 합니다.")
      );
    }

    if (requiresLlm(step)) {
      requirements.push(requirement("llm", "LLM provider", step, context.llmAvailable, "LLM 설정 또는 Codex OAuth 인증이 필요합니다."));
    }

    if (step === ResearchLoopStep.ExecuteTools) {
      const requiredTools = context.snapshot.researchPlans.at(-1)?.requiredTools ?? [];
      const openCodeRequired = normalizedToolSet(requiredTools).has("opencodetool");
      if (openCodeRequired) {
        requirements.push(requirement("opencode.enabled", "OpenCode 사용 설정", step, settings.openCode.enabled, "OpenCode 도구 엔진을 활성화해야 합니다."));
        requirements.push(
          requirement("opencode.command", "OpenCode command/path", step, Boolean(settings.openCode.command?.trim()), "OpenCode command/path가 필요합니다.")
        );
        if (context.openCodeReady !== undefined) {
          requirements.push(requirement("opencode.preflight", "OpenCode CLI 준비 상태", step, context.openCodeReady, "OpenCode CLI를 실행할 수 없습니다."));
        }
      }
      requirements.push(...requiredToolRequirements(step, project, settings, requiredTools, context.registeredToolNames ?? []));
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
          "실제 embedding provider와 모델이 필요합니다. local/local-hash embedding은 production index에 사용할 수 없습니다."
        )
      );
      requirements.push(requirement("embedding.apiKey", "Embedding API key", step, keyConfigured, "Embedding API key가 필요합니다."));
    }

    if (step === ResearchLoopStep.BuildOntologyGraph) {
      const mode = settings.ontologyExtractionMode;
      const modeConfigured = mode === "rule_based" || mode === "llm" || mode === "hybrid";
      requirements.push(requirement("ontology.mode", "Ontology extraction mode", step, modeConfigured, "Ontology extraction mode를 설정해야 합니다."));
      if (mode === "llm" || mode === "hybrid") {
        requirements.push(
          requirement("ontology.llm", "Ontology LLM extraction", step, context.llmAvailable, "선택한 ontology extraction mode에는 LLM이 필요합니다.")
        );
      }
    }

    if (step === ResearchLoopStep.FinalizeOutputs) {
      requirements.push(
        requirement("storage.writable", "프로젝트 저장소 쓰기 권한", step, context.storageWritable ?? true, "최종 산출물을 저장할 수 없습니다.")
      );
    }

    return requirements;
  }

  assertStepReady(step: ResearchLoopStep, context: RuntimeRequirementContext): void {
    const unmet = collectUnmetRequirements(this.checkRequirements(step, context));
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
  requiredTools: string[],
  registeredToolNames: string[]
): RuntimeRequirement[] {
  const requirements: RuntimeRequirement[] = [];
  const normalizedTools = normalizedToolSet(requiredTools);
  const registered = normalizedToolSet(registeredToolNames);

  for (const tool of normalizedTools) {
    if (tool && tool !== "opencodetool" && !registered.has(tool)) {
      requirements.push(requirement("tool.registered", "Registered research tool", step, false, `Research plan requires an unregistered tool: ${tool}`));
    }
  }

  if (
    normalizedTools.has("websearchtool") ||
    normalizedTools.has("backgroundbrowsertool") ||
    normalizedTools.has("webfetchtool") ||
    normalizedTools.has("researchmetadatatool") ||
    normalizedTools.has("pdfingestiontool")
  ) {
    requirements.push(
      requirement(
        "webSearch.allowed",
        "외부 검색 허용",
        step,
        project.autonomyPolicy.allowExternalSearch && settings.allowExternalSearch,
        "연구 계획이 WebSearchTool/BackgroundBrowserTool/WebFetchTool/PdfIngestionTool 외부 네트워크 접근을 요구하지만 외부 검색이 비활성화되어 있습니다."
      )
    );
    if (normalizedTools.has("websearchtool")) {
      const configured = settings.webSearch.provider !== "disabled" && Boolean(settings.webSearch.apiKey || settings.webSearch.apiKeyConfigured);
      requirements.push(requirement("webSearch.provider", "Web search provider/API key", step, configured, "Web search provider와 API key가 필요합니다."));
    }
    if (normalizedTools.has("backgroundbrowsertool")) {
      requirements.push(
        requirement("browserUse.enabled", "내장 Chromium 브라우저", step, settings.browserUse.enabled, "내장 Chromium 브라우저 도구가 비활성화되어 있습니다.")
      );
    }
  }

  if (normalizedTools.has("researchmetadatatool")) {
    requirements.push(
      requirement(
        "researchMetadata.enabled",
        "Research metadata provider",
        step,
        settings.researchMetadata.enabled,
        "ResearchMetadataTool requires the OpenAlex metadata provider to be enabled."
      )
    );
  }

  if (normalizedTools.has("engineeringprogramtool")) {
    requirements.push(
      requirement(
        "codeExecution.allowed",
        "코드 실행 허용",
        step,
        project.autonomyPolicy.allowCodeExecution && settings.allowCodeExecution,
        "연구 계획이 코드 실행을 요구하지만 코드 실행이 비활성화되어 있습니다."
      )
    );
  }

  if (normalizedTools.has("engineeringprogramtool")) {
    requirements.push(
      requirement(
        "engineeringTools.configured",
        "Engineering program toolchain",
        step,
        hasExecutableEngineeringTool(settings),
        "EngineeringProgramTool requires an embedded XFOIL/SU2/OpenVSP/XFLR5 executable, bundled XFOIL-WASM path, or configured modeling artifact root."
      )
    );
  }

  return requirements;
}

function formatRequirementMessages(requirements: RuntimeRequirement[]): string {
  const messages: string[] = [];
  for (const item of requirements) {
    messages.push(item.message ?? `${item.label} is required.`);
  }
  return messages.join("\n");
}

function collectUnmetRequirements(requirements: RuntimeRequirement[]): RuntimeRequirement[] {
  const unmet: RuntimeRequirement[] = [];
  for (const item of requirements) {
    if (!item.isSatisfied) unmet.push(item);
  }
  return unmet;
}

function normalizedToolSet(tools: string[]): Set<string> {
  const normalized = new Set<string>();
  for (const tool of tools) {
    const name = normalizeToolName(tool);
    if (name) normalized.add(name);
  }
  return normalized;
}
