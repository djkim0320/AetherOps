import { AetherOpsOrchestrator } from "../core/orchestrator.js";
import { InMemoryResearchStore } from "../core/memoryStore.js";
import { MockOpenCodeAdapter } from "../core/mockOpenCodeAdapter.js";
import type {
  CreateProjectInput,
  EvidenceBasedResult,
  LoopIteration,
  AppSettings,
  RagContext,
  ResearchArtifact,
  ResearchProject,
  ResearchSession,
  ResearchSnapshot
} from "../core/types.js";
import type { AetherOpsApi } from "../vite-env.js";

class BrowserDemoApi implements AetherOpsApi {
  private currentSettings: AppSettings = {
    openCodeLlm: {
      source: "codex-oauth",
      model: "gpt-5.5"
    },
    updatedAt: new Date().toISOString()
  };
  private readonly orchestrator = new AetherOpsOrchestrator(
    new InMemoryResearchStore(),
    new MockOpenCodeAdapter(() => this.currentSettings)
  );
  private listeners = new Set<(iteration: LoopIteration) => void>();

  projects = {
    create: async (input: CreateProjectInput) => this.orchestrator.createProject(input),
    list: async (): Promise<ResearchProject[]> => this.orchestrator.listProjects()
  };

  sessions = {
    createForProject: async (projectId: string): Promise<ResearchSession[]> => {
      const snapshot = await this.orchestrator.createSubSessions(projectId);
      this.emitLatest(snapshot);
      return snapshot.sessions;
    }
  };

  researchDb = {
    create: async (projectId: string): Promise<ResearchSnapshot> => this.withEvent(this.orchestrator.createResearchDb(projectId))
  };

  research = {
    seedQuestions: async (projectId: string): Promise<ResearchSnapshot> => this.withEvent(this.orchestrator.seedQuestions(projectId))
  };

  loop = {
    start: async (projectId: string): Promise<ResearchSnapshot> => this.withEvent(this.orchestrator.startLoop(projectId)),
    pause: async (projectId: string): Promise<ResearchSnapshot> => this.withEvent(this.orchestrator.pause(projectId)),
    resume: async (projectId: string): Promise<ResearchSnapshot> => this.withEvent(this.orchestrator.resume(projectId)),
    abort: async (projectId: string): Promise<ResearchSnapshot> => this.withEvent(this.orchestrator.abort(projectId))
  };

  opencode = {
    run: async (projectId: string): Promise<ResearchSnapshot> => this.withEvent(this.orchestrator.runOpenCode(projectId))
  };

  artifacts = {
    store: async (projectId: string, artifact: Partial<ResearchArtifact>): Promise<ResearchSnapshot> =>
      this.withEvent(this.orchestrator.storeArtifact(projectId, artifact))
  };

  rag = {
    buildContext: (projectId: string): Promise<RagContext> => this.orchestrator.buildRagContext(projectId)
  };

  results = {
    derive: (projectId: string): Promise<EvidenceBasedResult> => this.orchestrator.deriveResult(projectId)
  };

  reports = {
    finalize: async (projectId: string): Promise<ResearchSnapshot> => this.withEvent(this.orchestrator.finalizeReport(projectId))
  };

  llm = {
    status: async (): Promise<{ provider: string; available: boolean }> => ({
      provider: "browser-demo",
      available: false
    })
  };

  settings = {
    get: async (): Promise<AppSettings> => this.currentSettings,
    save: async (settings: AppSettings): Promise<AppSettings> => {
      this.currentSettings = {
        ...settings,
        openCodeLlm:
          settings.openCodeLlm.source === "api"
            ? {
                ...settings.openCodeLlm,
                apiKey: undefined,
                apiKeyConfigured: Boolean(settings.openCodeLlm.apiKey || settings.openCodeLlm.apiKeyConfigured)
              }
            : settings.openCodeLlm,
        updatedAt: new Date().toISOString()
      };
      return this.currentSettings;
    }
  };

  snapshots = {
    get: (projectId: string): Promise<ResearchSnapshot> => this.orchestrator.getSnapshot(projectId)
  };

  events = {
    onLoopIteration: (callback: (iteration: LoopIteration) => void): (() => void) => {
      this.listeners.add(callback);
      return () => this.listeners.delete(callback);
    }
  };

  private async withEvent(snapshotPromise: Promise<ResearchSnapshot>): Promise<ResearchSnapshot> {
    const snapshot = await snapshotPromise;
    this.emitLatest(snapshot);
    return snapshot;
  }

  private emitLatest(snapshot: ResearchSnapshot): void {
    const latest = snapshot.iterations.at(-1);
    if (!latest) {
      return;
    }
    for (const listener of this.listeners) {
      listener(latest);
    }
  }
}

export function getAetherOpsApi(): AetherOpsApi {
  return window.aetherOps ?? new BrowserDemoApi();
}
