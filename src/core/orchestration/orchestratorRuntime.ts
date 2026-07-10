/* eslint-disable @typescript-eslint/no-explicit-any -- abstract bridge preserves concrete subclass signatures */
import type { EmbeddingProvider } from "../providers/embeddingProvider.js";
import { EvidenceNormalizer } from "../evidence/evidenceNormalizer.js";
import { nowIso } from "../shared/ids.js";
import { type LlmProvider } from "../providers/llm.js";
import { LoopDecisionEngine } from "../planning/loopDecision.js";
import { ContextCompressionEngine } from "../memory/contextCompression.js";
import { MemoryPromotionEngine } from "../memory/memoryPromotion.js";
import { OntologyGraphEngine } from "../retrieval/ontologyGraphEngine.js";
import type { ProjectStorage } from "../storage/projectStorage.js";
import { ProjectContextBuilder } from "../retrieval/projectContextBuilder.js";
import { ReasoningEngine } from "../reasoning/reasoningEngine.js";
import { ResearchPlanner } from "../planning/researchPlanner.js";
import { ResearchSpecificationBuilder } from "../planning/researchSpecification.js";
import { RuntimeRequirementChecker } from "../tools/runtimeRequirements.js";
import { ToolRunner } from "../tools/toolRunner.js";
import { ValidationEngine } from "../reasoning/validationEngine.js";
import { ResultSynthesizer } from "../reasoning/resultSynthesizer.js";
import { ResearchLoopStep, type AppSettings, type OpenCodeAdapter, type RagEngine, type ResearchStore } from "../shared/types.js";
import { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT, DEFAULT_CODEX_TIMEOUT_MS } from "../../shared/kernel/codexModels.js";

type SettingsGetter = () => AppSettings | Promise<AppSettings>;

const defaultSettings: AppSettings = {
  openCodeLlm: {
    source: "codex-oauth",
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    timeoutMs: DEFAULT_CODEX_TIMEOUT_MS
  },
  openCode: { enabled: false, command: "opencode", provider: "openai", model: "gpt-5.5", timeoutMs: 180_000 },
  webSearch: { provider: "disabled" },
  embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
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
  updatedAt: nowIso()
};
export abstract class OrchestratorRuntime {
  protected readonly specificationBuilder: ResearchSpecificationBuilder;
  protected readonly planner: ResearchPlanner;
  protected readonly normalizer = new EvidenceNormalizer();
  protected readonly contextCompression = new ContextCompressionEngine();
  protected readonly ontologyGraph = new OntologyGraphEngine();
  protected readonly reasoning = new ReasoningEngine();
  protected readonly validation = new ValidationEngine();
  protected readonly projectContextBuilder = new ProjectContextBuilder();
  protected readonly resultSynthesizer = new ResultSynthesizer();
  protected readonly memoryPromotion = new MemoryPromotionEngine();
  protected readonly loopDecision = new LoopDecisionEngine();
  protected readonly requirements = new RuntimeRequirementChecker();

  constructor(
    protected readonly store: ResearchStore,
    protected readonly openCode: OpenCodeAdapter,
    protected readonly ragEngine: RagEngine,
    protected readonly projectRootBase = ".aetherops/projects",
    protected readonly llm: LlmProvider | undefined,
    protected readonly projectStorage: ProjectStorage,
    protected readonly embeddingProvider: EmbeddingProvider,
    protected readonly getSettings: SettingsGetter = () => defaultSettings,
    protected readonly toolRunner?: ToolRunner
  ) {
    this.specificationBuilder = new ResearchSpecificationBuilder(llm);
    this.planner = new ResearchPlanner(llm, async (projectId, error, retryAttempt) => {
      await this.saveStepError(projectId, ResearchLoopStep.PlanResearch, error.message, "llm_timeout", {
        ...error.metadata,
        retryAttempt
      });
    });
  }

  abstract listProjects(...args: any[]): any;
  abstract getSnapshot(...args: any[]): any;
  abstract updateProjectInput(...args: any[]): any;
  abstract createProject(...args: any[]): any;
  abstract createSubSessions(...args: any[]): any;
  abstract createChatSession(...args: any[]): any;
  abstract deleteChatSession(...args: any[]): any;
  abstract sendChatMessage(...args: any[]): any;
  abstract createResearchDb(...args: any[]): any;
  abstract inputResearchQuestionHypothesis(...args: any[]): any;
  abstract buildResearchSpecification(...args: any[]): any;
  abstract planResearch(...args: any[]): any;
  abstract seedQuestions(...args: any[]): any;
  abstract startLoop(...args: any[]): any;
  abstract pause(...args: any[]): any;
  abstract resume(...args: any[]): any;
  abstract abort(...args: any[]): any;
  abstract executeTools(...args: any[]): any;
  abstract normalizeData(...args: any[]): any;
  abstract buildVectorIndex(...args: any[]): any;
  abstract buildOntologyGraph(...args: any[]): any;
  abstract reasonAndValidate(...args: any[]): any;
  abstract synthesizeAndEvaluate(...args: any[]): any;
  abstract decideContinuation(...args: any[]): any;
  abstract finalizeOutputs(...args: any[]): any;
  abstract storeArtifact(...args: any[]): any;
  protected abstract persistExecutionOutputs(...args: any[]): any;
  protected abstract persistToolResults(...args: any[]): any;
  protected abstract createOpenCodeRunAttempt(...args: any[]): any;
  protected abstract preflightExecutionEngine(...args: any[]): any;
  protected abstract ensureResearchDb(...args: any[]): any;
  protected abstract ensureResearchInput(...args: any[]): any;
  protected abstract ensureResearchSpecification(...args: any[]): any;
  protected abstract ensureResearchPlan(...args: any[]): any;
  protected abstract ensureSpecification(...args: any[]): any;
  protected abstract ingestSources(...args: any[]): any;
  protected abstract checkAbortOrPause(...args: any[]): any;
  protected abstract requireDatabase(...args: any[]): any;
  protected abstract assertStepReady(...args: any[]): any;
  protected abstract registeredToolNames(...args: any[]): any;
  protected abstract executableToolNames(...args: any[]): any;
  protected abstract assertPlanToolsAllowed(...args: any[]): any;
  protected abstract blockProject(...args: any[]): any;
  protected abstract failProject(...args: any[]): any;
  protected abstract writeRunAudit(...args: any[]): any;
  protected abstract saveStepError(...args: any[]): any;
  protected abstract tryLlmResult(...args: any[]): any;
  protected abstract applyHypothesisUpdates(...args: any[]): any;
  protected abstract setStatus(...args: any[]): any;
  protected abstract moveProject(...args: any[]): any;
  protected abstract record(...args: any[]): any;
  protected abstract reportIterationToChat(...args: any[]): any;
  protected abstract syncProjectState(...args: any[]): any;
  protected abstract completeChatReply(...args: any[]): any;
}
