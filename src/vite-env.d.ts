/// <reference types="vite/client" />

import type {
  ResearchProjectInput,
  EvidenceBasedResult,
  LoopIteration,
  RagContext,
  ResearchArtifact,
  ResearchProject,
  ResearchSession,
  AppSettings,
  ResearchSnapshot
} from "./core/types.js";

export interface AetherOpsApi {
  projects: {
    create(input: ResearchProjectInput): Promise<ResearchSnapshot>;
    list(): Promise<ResearchProject[]>;
  };
  sessions: {
    createForProject(projectId: string): Promise<ResearchSession[]>;
    create(projectId: string, title?: string, focus?: string): Promise<ResearchSnapshot>;
    delete(projectId: string, sessionId: string): Promise<ResearchSnapshot>;
  };
  chat: {
    send(projectId: string, sessionId: string, content: string): Promise<ResearchSnapshot>;
  };
  researchDb: {
    create(projectId: string): Promise<ResearchSnapshot>;
  };
  research: {
    seedQuestions(projectId: string): Promise<ResearchSnapshot>;
    inputResearchQuestionHypothesis(
      projectId: string,
      payload?: {
        researchQuestion: string;
        initialHypotheses: string[];
        constraints: string[];
        expectedOutputs: string[];
      }
    ): Promise<ResearchSnapshot>;
    buildSpecification(projectId: string): Promise<ResearchSnapshot>;
    plan(projectId: string): Promise<ResearchSnapshot>;
  };
  loop: {
    start(projectId: string): Promise<ResearchSnapshot>;
    pause(projectId: string): Promise<ResearchSnapshot>;
    resume(projectId: string): Promise<ResearchSnapshot>;
    abort(projectId: string): Promise<ResearchSnapshot>;
  };
  opencode: {
    run(projectId: string): Promise<ResearchSnapshot>;
    authLogin(provider?: string): Promise<{ ok: boolean; message: string; output?: string }>;
    authList(): Promise<{ ok: boolean; message: string; output?: string }>;
  };
  artifacts: {
    store(projectId: string, artifact: Partial<ResearchArtifact>): Promise<ResearchSnapshot>;
  };
  rag: {
    buildContext(projectId: string): Promise<RagContext>;
  };
  results: {
    derive(projectId: string): Promise<EvidenceBasedResult>;
  };
  reports: {
    finalize(projectId: string): Promise<ResearchSnapshot>;
  };
  llm: {
    status(): Promise<{ provider: string; available: boolean }>;
  };
  settings: {
    get(): Promise<AppSettings>;
    save(settings: AppSettings): Promise<AppSettings>;
  };
  snapshots: {
    get(projectId: string): Promise<ResearchSnapshot>;
  };
  events: {
    onLoopIteration(callback: (iteration: LoopIteration) => void): () => void;
  };
}

declare global {
  interface Window {
    aetherOps?: AetherOpsApi;
  }
}
