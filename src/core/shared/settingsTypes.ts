import type { CodexModelId, CodexReasoningEffort } from "../../shared/kernel/codexModels.js";

export interface CodexSettings {
  model: CodexModelId;
  reasoningEffort: CodexReasoningEffort;
  timeoutMs: number;
  taskTimeoutMs: number;
}

export interface WebSearchSettings {
  provider: "tavily" | "brave" | "custom" | "disabled";
  apiKey?: string;
  apiKeyConfigured?: boolean;
  endpoint?: string;
  timeoutMs?: number;
}

export interface EmbeddingSettings {
  provider: "openai" | "google" | "custom" | "local";
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyConfigured?: boolean;
  dimensions: number;
}

export interface BrowserUseSettings {
  enabled: boolean;
  mode: "background" | "visible";
  maxPages: number;
  timeoutMs: number;
  captureScreenshots: boolean;
}

export interface ResearchMetadataSettings {
  enabled: boolean;
  provider: "openalex";
  mailto?: string;
  maxResults: number;
  timeoutMs: number;
}

export interface EngineeringProgramSettings {
  enabled: boolean;
  toolchainRoot?: string;
  xfoil: {
    enabled: boolean;
    command?: string;
    timeoutMs: number;
  };
  modeling: {
    enabled: boolean;
    artifactRoot?: string;
    maxMeshBytes: number;
  };
  su2: {
    enabled: boolean;
    command?: string;
    caseRoot?: string;
    configFile?: string;
    workingDirectory?: string;
    probeArgs: string[];
    runArgsTemplate: string[];
    timeoutMs: number;
  };
  openVsp: {
    enabled: boolean;
    command?: string;
    scriptPath?: string;
    workingDirectory?: string;
    probeArgs: string[];
    runArgsTemplate: string[];
    timeoutMs: number;
  };
  xflr5: {
    enabled: boolean;
    command?: string;
    scriptPath?: string;
    workingDirectory?: string;
    probeArgs: string[];
    runArgsTemplate: string[];
    timeoutMs: number;
  };
}

export interface AppSettings {
  codex: CodexSettings;
  webSearch: WebSearchSettings;
  embedding: EmbeddingSettings;
  browserUse: BrowserUseSettings;
  researchMetadata: ResearchMetadataSettings;
  engineeringTools: EngineeringProgramSettings;
  allowAgent: boolean;
  allowExternalSearch: boolean;
  allowCodeExecution: boolean;
  ontologyExtractionMode?: "llm" | "rule_based" | "hybrid";
  finalOutputExport?: {
    markdown: boolean;
    json: boolean;
    ontologyGraph: boolean;
    artifactPackage: boolean;
  };
  updatedAt: string;
}
