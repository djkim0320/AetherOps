import { join } from "node:path";
import { AetherOpsOrchestrator } from "../../core/orchestration/orchestrator.js";
import { ApiEmbeddingProvider } from "../../core/providers/embeddingProvider.js";
import { VectorRagEngine } from "../../core/retrieval/vectorRagEngine.js";
import { CodexCliTool } from "../../core/tools/codexCliTool.js";
import { dedupeResearchTools, ToolRunner } from "../../core/tools/toolRunner.js";
import { BackgroundBrowserRuntime } from "../runtime/browser/backgroundBrowserRuntime.js";
import { BrowserResearchTool } from "../runtime/browser/browserResearchTool.js";
import { CodexCliAdapter } from "../runtime/codex/codexCliAdapter.js";
import { CodexOAuthLlmProvider } from "../runtime/codex/codexOAuthLlmProvider.js";
import { buildServerRuntimeToolDiagnostics } from "../runtime/engineering/runtimeEngineeringDiagnostics.js";
import type { AppSettingsStore } from "../runtime/storage/settingsStore.js";
import { createLegacyStorageWorker } from "../runtime/storage/worker/legacyStorageClient.js";
import { createRuntimeResearchTools } from "../runtime/tools/defaultResearchTools.js";
import { FileToolExecutionWorkspace } from "../runtime/tools/toolExecutionWorkspace.js";
import { DurableJobRuntime } from "./durableJobRuntime.js";
import { ProjectMutationSagaCoordinator, type ProjectMutationSagaDependencies } from "./projectMutationSagaCoordinator.js";
import { registerDurableJobHandlers } from "./registerDurableJobHandlers.js";
import { initializeStartupResources, StartupResourceRegistry } from "./runtimeResourceCleanup.js";
import type { SseRuntimeDiagnostics } from "./sseRuntimeDiagnostics.js";

export type WebProjectMutationResultMapper = ProjectMutationSagaDependencies["resultMapper"];

export interface WebRuntimeCompositionOptions {
  appRoot: string;
  dataRoot: string;
  sseDiagnostics: SseRuntimeDiagnostics;
  projectMutationResultMapper: WebProjectMutationResultMapper;
}

export interface WebRuntimeComposition {
  jobs: DurableJobRuntime;
  settingsStore: AppSettingsStore;
  llm: CodexOAuthLlmProvider;
  orchestrator: AetherOpsOrchestrator;
  projectMutations: ProjectMutationSagaCoordinator;
  closeResources(): Promise<void>;
}

export async function composeWebRuntime(options: WebRuntimeCompositionOptions): Promise<WebRuntimeComposition> {
  const resources = new StartupResourceRegistry();
  return initializeStartupResources(resources, async () => {
    const legacyStorage = createLegacyStorageWorker(
      join(options.dataRoot, "migration", "v2", "legacy-research.sqlite"),
      join(options.dataRoot, "settings.json")
    );
    resources.registerDependency("storage", () => legacyStorage.close());
    await legacyStorage.ready;

    const settingsStore = legacyStorage.settingsStore;
    const jobs = new DurableJobRuntime(join(options.dataRoot, "migration", "v2", "storage.sqlite"), {
      sseDiagnostics: options.sseDiagnostics,
      dataRoot: options.dataRoot
    });
    resources.registerController("jobs", () => jobs.close());

    const settings = () => settingsStore.getRuntimeSettings();
    const embeddingProvider = createEmbeddingProvider(settingsStore);
    const llm = new CodexOAuthLlmProvider({
      appRoot: options.appRoot,
      settings: async () => {
        const { codex } = await settings();
        return {
          model: codex.model,
          reasoningEffort: codex.reasoningEffort,
          timeoutMs: codex.timeoutMs
        };
      }
    });
    resources.registerDependency("llm", () => llm.dispose());

    const codexCli = new CodexCliAdapter({ appRoot: options.appRoot });
    resources.registerDependency("codex-cli", () => codexCli.dispose());
    const browserRuntime = new BackgroundBrowserRuntime(options.dataRoot);
    resources.registerDependency("browser", () => browserRuntime.dispose());

    const toolRunner = new ToolRunner(
      dedupeResearchTools([...createRuntimeResearchTools(), new BrowserResearchTool(browserRuntime), new CodexCliTool(codexCli)]),
      new FileToolExecutionWorkspace(options.dataRoot)
    );
    const orchestrator = new AetherOpsOrchestrator(
      legacyStorage.researchStore,
      codexCli,
      new VectorRagEngine(embeddingProvider),
      join(options.dataRoot, "projects"),
      llm,
      legacyStorage.projectStorage,
      embeddingProvider,
      settings,
      toolRunner,
      (runtimeSettings) => buildServerRuntimeToolDiagnostics(runtimeSettings)
    );
    const projectMutations = new ProjectMutationSagaCoordinator({
      operational: jobs.projectMutations,
      legacy: legacyStorage.projectMutations,
      getSnapshot: (projectId) => orchestrator.getSnapshot(projectId),
      getProjectRevisionHead: (projectId) => jobs.getProjectRevisionHead(projectId),
      projectRootBase: join(options.dataRoot, "projects"),
      resultMapper: options.projectMutationResultMapper
    });

    await projectMutations.recoverPending();
    registerDurableJobHandlers({
      dataRoot: options.dataRoot,
      orchestrator,
      settingsStore,
      jobs,
      events: jobs,
      codexCli
    });
    await jobs.initialize();

    return {
      jobs,
      settingsStore,
      llm,
      orchestrator,
      projectMutations,
      closeResources: resources.close
    };
  });
}

function createEmbeddingProvider(settingsStore: AppSettingsStore) {
  let cachedSettings = "";
  let cachedProvider: ApiEmbeddingProvider | undefined;
  return {
    embed: async (text: string) => {
      const { embedding } = await settingsStore.getRuntimeSettings();
      const serializedSettings = JSON.stringify(embedding);
      if (!cachedProvider || cachedSettings !== serializedSettings) {
        cachedSettings = serializedSettings;
        cachedProvider = new ApiEmbeddingProvider(embedding);
      }
      return cachedProvider.embed(text);
    }
  };
}
