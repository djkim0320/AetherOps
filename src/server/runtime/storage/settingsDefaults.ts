import { nowIso } from "../../../core/shared/ids.js";
import { embeddedEngineeringToolchainStatus } from "../engineering/engineeringToolchain.js";
import type { AppSettings, EmbeddingSettings, EngineeringProgramSettings, ResearchMetadataSettings, WebSearchSettings } from "../../../core/shared/types.js";
import {
  assertCodexSettings,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_TASK_TIMEOUT_MS,
  DEFAULT_CODEX_TIMEOUT_MS
} from "../../../shared/kernel/codexModels.js";

export interface PersistedSettings {
  codex?: AppSettings["codex"];
  /** Read-only migration inputs. New writes never persist these fields. */
  openCodeLlm?: Record<string, unknown>;
  /** Read-only migration input retained only in pre-migration backups. */
  openCode?: Record<string, unknown>;
  webSearch?: Omit<WebSearchSettings, "apiKey" | "apiKeyConfigured">;
  embedding?: Omit<EmbeddingSettings, "apiKey" | "apiKeyConfigured">;
  browserUse?: AppSettings["browserUse"];
  researchMetadata?: ResearchMetadataSettings;
  engineeringTools?: EngineeringProgramSettings;
  allowAgent?: boolean;
  allowExternalSearch?: boolean;
  allowCodeExecution?: boolean;
  maxLoopIterations?: number;
  ontologyExtractionMode?: AppSettings["ontologyExtractionMode"];
  finalOutputExport?: AppSettings["finalOutputExport"];
  encryptedWebSearchKey?: string;
  encryptedEmbeddingKey?: string;
  updatedAt: string;
}

export const defaultSettings: AppSettings = {
  codex: {
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    timeoutMs: DEFAULT_CODEX_TIMEOUT_MS,
    taskTimeoutMs: DEFAULT_CODEX_TASK_TIMEOUT_MS
  },
  webSearch: { provider: "disabled", timeoutMs: 10_000 },
  embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
  browserUse: { enabled: true, mode: "background", maxPages: 2, timeoutMs: 30_000, captureScreenshots: true },
  researchMetadata: { enabled: true, provider: "openalex", maxResults: 5, timeoutMs: 15_000 },
  engineeringTools: {
    enabled: false,
    toolchainRoot: "vendor/engineering-tools",
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
      command: "vspscript",
      scriptPath: "",
      workingDirectory: "",
      probeArgs: ["-help"],
      runArgsTemplate: ["-script", "{script}", "-spec", "{spec}", "-output", "{output}"],
      timeoutMs: 30 * 60_000
    },
    xflr5: {
      enabled: false,
      command: "xflr5",
      scriptPath: "",
      workingDirectory: "",
      probeArgs: ["--help"],
      runArgsTemplate: ["--script", "{script}", "--spec", "{spec}", "--output", "{output}"],
      timeoutMs: 30 * 60_000
    }
  },
  allowAgent: true,
  allowExternalSearch: true,
  allowCodeExecution: false,
  ontologyExtractionMode: "rule_based",
  finalOutputExport: { markdown: true, json: true, ontologyGraph: true, artifactPackage: true },
  updatedAt: nowIso()
};

export function normalizePersisted(settings: PersistedSettings): PersistedSettings {
  const codex = normalizeCodexSettings(settings.codex, settings.openCodeLlm, settings.openCode?.timeoutMs);
  const embedding = {
    ...defaultSettings.embedding,
    ...(settings.embedding ?? {}),
    provider: normalizeEmbeddingProvider(settings.embedding?.provider ?? defaultSettings.embedding.provider)
  };
  return {
    ...settings,
    codex,
    webSearch: normalizeWebSearch(settings.webSearch),
    embedding,
    browserUse: normalizeBrowserUse(settings.browserUse),
    researchMetadata: normalizeResearchMetadata(settings.researchMetadata),
    engineeringTools: normalizeEngineeringTools(settings.engineeringTools),
    allowAgent: normalizeStrictBoolean(settings.allowAgent, defaultSettings.allowAgent, "allowAgent"),
    allowExternalSearch: normalizeStrictBoolean(settings.allowExternalSearch, defaultSettings.allowExternalSearch, "allowExternalSearch"),
    allowCodeExecution: normalizeStrictBoolean(settings.allowCodeExecution, defaultSettings.allowCodeExecution, "allowCodeExecution"),
    ontologyExtractionMode: ["llm", "rule_based", "hybrid"].includes(settings.ontologyExtractionMode ?? "")
      ? settings.ontologyExtractionMode
      : defaultSettings.ontologyExtractionMode,
    finalOutputExport: {
      markdown: settings.finalOutputExport?.markdown ?? defaultSettings.finalOutputExport?.markdown ?? true,
      json: settings.finalOutputExport?.json ?? defaultSettings.finalOutputExport?.json ?? true,
      ontologyGraph: settings.finalOutputExport?.ontologyGraph ?? defaultSettings.finalOutputExport?.ontologyGraph ?? true,
      artifactPackage: settings.finalOutputExport?.artifactPackage ?? defaultSettings.finalOutputExport?.artifactPackage ?? true
    },
    updatedAt: settings.updatedAt ?? nowIso()
  };
}

export function normalizeCodexSettings(value: unknown, legacyLlm?: unknown, legacyTaskTimeoutMs?: unknown): AppSettings["codex"] {
  const input = codexSettingsRecord(value === undefined ? normalizeLegacyCodexSettings(legacyLlm) : value);
  const candidate = {
    model: input.model === undefined ? DEFAULT_CODEX_MODEL : input.model,
    reasoningEffort: input.reasoningEffort === undefined ? DEFAULT_CODEX_REASONING_EFFORT : input.reasoningEffort,
    timeoutMs: input.timeoutMs === undefined ? DEFAULT_CODEX_TIMEOUT_MS : input.timeoutMs,
    taskTimeoutMs: input.taskTimeoutMs === undefined ? inheritedTaskTimeout(legacyTaskTimeoutMs) : input.taskTimeoutMs
  };
  assertCodexSettings(candidate);
  return candidate;
}

function normalizeLegacyCodexSettings(value: unknown): unknown {
  if (value === undefined) return {};
  const legacy = codexSettingsRecord(value);
  return {
    model: legacy.model,
    reasoningEffort: legacy.reasoningEffort,
    timeoutMs: legacy.timeoutMs
  };
}

function codexSettingsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) assertCodexSettings(value);
  return value as Record<string, unknown>;
}

function inheritedTaskTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_CODEX_TASK_TIMEOUT_MS;
  const candidate = {
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    timeoutMs: DEFAULT_CODEX_TIMEOUT_MS,
    taskTimeoutMs: value
  };
  assertCodexSettings(candidate);
  return Math.max(DEFAULT_CODEX_TASK_TIMEOUT_MS, candidate.taskTimeoutMs);
}

export function normalizeBrowserUse(settings: unknown): AppSettings["browserUse"] {
  const input = settings && typeof settings === "object" ? (settings as Partial<AppSettings["browserUse"]>) : {};
  return {
    enabled: input.enabled ?? defaultSettings.browserUse.enabled,
    mode: input.mode === "visible" ? "visible" : "background",
    maxPages: clampNumber(input.maxPages, 1, 5, defaultSettings.browserUse.maxPages),
    timeoutMs: clampNumber(input.timeoutMs, 5_000, 120_000, defaultSettings.browserUse.timeoutMs),
    captureScreenshots: input.captureScreenshots ?? defaultSettings.browserUse.captureScreenshots
  };
}

export function normalizeResearchMetadata(settings: unknown): ResearchMetadataSettings {
  const input = settings && typeof settings === "object" ? (settings as Partial<ResearchMetadataSettings>) : {};
  return {
    enabled: input.enabled ?? defaultSettings.researchMetadata.enabled,
    provider: "openalex",
    mailto: typeof input.mailto === "string" && input.mailto.trim() ? input.mailto.trim() : undefined,
    maxResults: clampNumber(input.maxResults, 1, 25, defaultSettings.researchMetadata.maxResults),
    timeoutMs: clampNumber(input.timeoutMs, 5_000, 60_000, defaultSettings.researchMetadata.timeoutMs)
  };
}

export function normalizeEngineeringTools(settings: unknown): EngineeringProgramSettings {
  const input = settings && typeof settings === "object" ? (settings as Partial<EngineeringProgramSettings>) : {};
  const xfoil = (input.xfoil ?? {}) as Partial<EngineeringProgramSettings["xfoil"]>;
  const modeling = (input.modeling ?? {}) as Partial<EngineeringProgramSettings["modeling"]>;
  const su2 = (input.su2 ?? {}) as Partial<EngineeringProgramSettings["su2"]>;
  const openVsp = (input.openVsp ?? {}) as Partial<EngineeringProgramSettings["openVsp"]>;
  const xflr5 = (input.xflr5 ?? {}) as Partial<EngineeringProgramSettings["xflr5"]>;
  return hydrateEmbeddedEngineeringTools({
    enabled: input.enabled ?? defaultSettings.engineeringTools.enabled,
    toolchainRoot: textOr(input.toolchainRoot, defaultSettings.engineeringTools.toolchainRoot),
    xfoil: {
      enabled: xfoil.enabled ?? defaultSettings.engineeringTools.xfoil.enabled,
      command: typeof xfoil.command === "string" ? xfoil.command.trim() : defaultSettings.engineeringTools.xfoil.command,
      timeoutMs: clampNumber(xfoil.timeoutMs, 5_000, 120_000, defaultSettings.engineeringTools.xfoil.timeoutMs)
    },
    modeling: {
      enabled: modeling.enabled ?? defaultSettings.engineeringTools.modeling.enabled,
      artifactRoot: typeof modeling.artifactRoot === "string" ? modeling.artifactRoot.trim() : defaultSettings.engineeringTools.modeling.artifactRoot,
      maxMeshBytes: clampNumber(modeling.maxMeshBytes, 1024, 200 * 1024 * 1024, defaultSettings.engineeringTools.modeling.maxMeshBytes)
    },
    su2: {
      enabled: su2.enabled ?? defaultSettings.engineeringTools.su2.enabled,
      command: typeof su2.command === "string" ? su2.command.trim() : defaultSettings.engineeringTools.su2.command,
      caseRoot: textOr(su2.caseRoot, defaultSettings.engineeringTools.su2.caseRoot),
      configFile: textOr(su2.configFile, defaultSettings.engineeringTools.su2.configFile),
      workingDirectory: textOr(su2.workingDirectory, defaultSettings.engineeringTools.su2.workingDirectory),
      probeArgs: normalizeArgList(su2.probeArgs, defaultSettings.engineeringTools.su2.probeArgs),
      runArgsTemplate: normalizeArgList(su2.runArgsTemplate, defaultSettings.engineeringTools.su2.runArgsTemplate),
      timeoutMs: clampNumber(su2.timeoutMs, 5_000, 6 * 60 * 60_000, defaultSettings.engineeringTools.su2.timeoutMs)
    },
    openVsp: {
      enabled: openVsp.enabled ?? defaultSettings.engineeringTools.openVsp.enabled,
      command: normalizeCommand(openVsp.command, defaultSettings.engineeringTools.openVsp.command),
      scriptPath: textOr(openVsp.scriptPath, defaultSettings.engineeringTools.openVsp.scriptPath),
      workingDirectory: textOr(openVsp.workingDirectory, defaultSettings.engineeringTools.openVsp.workingDirectory),
      probeArgs: normalizeArgList(openVsp.probeArgs, defaultSettings.engineeringTools.openVsp.probeArgs),
      runArgsTemplate: normalizeArgList(openVsp.runArgsTemplate, defaultSettings.engineeringTools.openVsp.runArgsTemplate),
      timeoutMs: clampNumber(openVsp.timeoutMs, 5_000, 6 * 60 * 60_000, defaultSettings.engineeringTools.openVsp.timeoutMs)
    },
    xflr5: {
      enabled: xflr5.enabled ?? defaultSettings.engineeringTools.xflr5.enabled,
      command: normalizeCommand(xflr5.command, defaultSettings.engineeringTools.xflr5.command),
      scriptPath: textOr(xflr5.scriptPath, defaultSettings.engineeringTools.xflr5.scriptPath),
      workingDirectory: textOr(xflr5.workingDirectory, defaultSettings.engineeringTools.xflr5.workingDirectory),
      probeArgs: normalizeArgList(xflr5.probeArgs, defaultSettings.engineeringTools.xflr5.probeArgs),
      runArgsTemplate: normalizeArgList(xflr5.runArgsTemplate, defaultSettings.engineeringTools.xflr5.runArgsTemplate),
      timeoutMs: clampNumber(xflr5.timeoutMs, 5_000, 6 * 60 * 60_000, defaultSettings.engineeringTools.xflr5.timeoutMs)
    }
  });
}

export function assertStrictBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`AetherOps setting ${field} must be a boolean.`);
}

export function formatSettingsReadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveIncomingSecret(incoming: unknown, current: string | undefined): string | undefined {
  if (incoming === undefined) return current;
  if (typeof incoming !== "string") throw new Error("AetherOps API key values must be strings.");
  return incoming.trim() || undefined;
}

function normalizeWebSearch(settings: unknown): WebSearchSettings {
  const input = settings && typeof settings === "object" ? (settings as Partial<WebSearchSettings>) : {};
  return { ...defaultSettings.webSearch, ...input, timeoutMs: clampNumber(input.timeoutMs, 1_000, 60_000, defaultSettings.webSearch.timeoutMs ?? 10_000) };
}

function hydrateEmbeddedEngineeringTools(settings: EngineeringProgramSettings): EngineeringProgramSettings {
  if (!settings.enabled) return settings;
  const status = embeddedEngineeringToolchainStatus(settings);
  return {
    ...settings,
    su2: hydrate(settings.su2, status.su2),
    openVsp: hydrate(settings.openVsp, status.openvsp),
    xflr5: hydrate(settings.xflr5, status.xflr5)
  };
}

function hydrate<T extends { enabled: boolean; command?: string }>(tool: T, status: { ready: boolean; command?: string }): T {
  return status.ready && status.command ? { ...tool, enabled: true, command: status.command } : tool;
}

function normalizeCommand(value: unknown, fallback: string | undefined): string {
  return typeof value === "string" && value.trim() ? value.trim() : (fallback ?? "");
}

function normalizeArgList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function normalizeStrictBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  assertStrictBoolean(value, field);
  return value;
}

function normalizeEmbeddingProvider(provider: unknown): EmbeddingSettings["provider"] {
  if (provider === "openai" || provider === "google" || provider === "custom") return provider;
  return provider === "openrouter" ? "google" : "openai";
}

function textOr(value: unknown, fallback: string | undefined): string {
  return typeof value === "string" ? value.trim() : (fallback ?? "");
}
