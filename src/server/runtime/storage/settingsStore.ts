import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nowIso } from "../../../core/shared/ids.js";
import { embeddedEngineeringToolchainStatus } from "../../../core/tools/engineeringToolchain.js";
import type {
  AppSettings,
  EmbeddingSettings,
  EngineeringProgramSettings,
  OpenCodeApiLlmSettings,
  OpenCodeLlmSettings,
  ResearchMetadataSettings,
  WebSearchSettings
} from "../../../core/shared/types.js";

interface PersistedSettings {
  openCodeLlm?: Omit<OpenCodeApiLlmSettings, "apiKey" | "apiKeyConfigured"> | Extract<OpenCodeLlmSettings, { source: "codex-oauth" }>;
  openCode?: AppSettings["openCode"];
  webSearch?: Omit<WebSearchSettings, "apiKey" | "apiKeyConfigured">;
  embedding?: Omit<EmbeddingSettings, "apiKey" | "apiKeyConfigured">;
  browserUse?: AppSettings["browserUse"];
  researchMetadata?: ResearchMetadataSettings;
  engineeringTools?: EngineeringProgramSettings;
  allowExternalSearch?: boolean;
  allowCodeExecution?: boolean;
  /** @deprecated 반복 횟수는 에이전트의 계속 연구 판단이 결정하며 저장값은 무시됩니다. */
  maxLoopIterations?: number;
  ontologyExtractionMode?: AppSettings["ontologyExtractionMode"];
  finalOutputExport?: AppSettings["finalOutputExport"];
  encryptedApiKey?: string;
  encryptedWebSearchKey?: string;
  encryptedEmbeddingKey?: string;
  updatedAt: string;
}

export interface AppSettingsStore {
  getSettings(): Promise<AppSettings>;
  getRuntimeSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
}

export const defaultSettings: AppSettings = {
  openCodeLlm: {
    source: "codex-oauth",
    model: "gpt-5.5"
  },
  openCode: {
    enabled: true,
    command: "opencode",
    provider: "openai",
    model: "gpt-5.5",
    timeoutMs: 180_000
  },
  webSearch: {
    provider: "disabled",
    timeoutMs: 10_000
  },
  embedding: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536
  },
  browserUse: {
    enabled: true,
    mode: "background",
    maxPages: 2,
    timeoutMs: 30_000,
    captureScreenshots: true
  },
  researchMetadata: {
    enabled: true,
    provider: "openalex",
    maxResults: 5,
    timeoutMs: 15_000
  },
  engineeringTools: {
    enabled: false,
    toolchainRoot: "vendor/engineering-tools",
    xfoil: {
      enabled: false,
      command: "",
      timeoutMs: 30_000
    },
    modeling: {
      enabled: false,
      artifactRoot: "",
      maxMeshBytes: 20 * 1024 * 1024
    },
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
  allowExternalSearch: true,
  allowCodeExecution: false,
  ontologyExtractionMode: "rule_based",
  finalOutputExport: {
    markdown: true,
    json: true,
    ontologyGraph: true,
    artifactPackage: true
  },
  updatedAt: nowIso()
};

export class JsonAppSettingsStore implements AppSettingsStore {
  constructor(private readonly settingsPath: string) {}

  async getSettings(): Promise<AppSettings> {
    return this.toPublicSettings(this.readPersisted());
  }

  async getRuntimeSettings(): Promise<AppSettings> {
    const persisted = this.readPersisted();
    const publicSettings = this.toPublicSettings(persisted);
    return {
      ...publicSettings,
      openCodeLlm:
        publicSettings.openCodeLlm.source === "api"
          ? {
              ...publicSettings.openCodeLlm,
              apiKey: this.decryptKey(persisted.encryptedApiKey)
            }
          : publicSettings.openCodeLlm,
      webSearch: {
        ...publicSettings.webSearch,
        apiKey: this.decryptKey(persisted.encryptedWebSearchKey)
      },
      embedding: {
        ...publicSettings.embedding,
        apiKey: this.decryptKey(persisted.encryptedEmbeddingKey)
      }
    };
  }

  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    const current = this.readPersisted();
    const updatedAt = nowIso();
    const currentApiKey = this.usableEncryptedKey(current.encryptedApiKey);
    const currentWebSearchKey = this.usableEncryptedKey(current.encryptedWebSearchKey);
    const currentEmbeddingKey = this.usableEncryptedKey(current.encryptedEmbeddingKey);
    const persisted: PersistedSettings = {
      openCodeLlm:
        settings.openCodeLlm.source === "api"
          ? {
              source: "api",
              provider: settings.openCodeLlm.provider,
              model: settings.openCodeLlm.model,
              baseUrl: settings.openCodeLlm.baseUrl
            }
          : {
              source: "codex-oauth",
              model: settings.openCodeLlm.model
            },
      openCode: settings.openCode,
      webSearch: {
        provider: settings.webSearch.provider,
        endpoint: settings.webSearch.endpoint,
        timeoutMs: settings.webSearch.timeoutMs
      },
      embedding: {
        provider: settings.embedding.provider,
        model: settings.embedding.model,
        baseUrl: settings.embedding.baseUrl,
        dimensions: settings.embedding.dimensions
      },
      browserUse: normalizeBrowserUse(settings.browserUse),
      researchMetadata: normalizeResearchMetadata(settings.researchMetadata),
      engineeringTools: normalizeEngineeringTools(settings.engineeringTools),
      allowExternalSearch: settings.allowExternalSearch,
      allowCodeExecution: settings.allowCodeExecution,
      ontologyExtractionMode: settings.ontologyExtractionMode,
      finalOutputExport: settings.finalOutputExport,
      encryptedApiKey: settings.openCodeLlm.source === "api" ? currentApiKey : undefined,
      encryptedWebSearchKey: currentWebSearchKey,
      encryptedEmbeddingKey: currentEmbeddingKey,
      updatedAt
    };

    if (settings.openCodeLlm.source === "api") {
      persisted.encryptedApiKey = updateEncryptedKey(settings.openCodeLlm.apiKey, currentApiKey, (key) => this.encryptKey(key));
    }
    persisted.encryptedWebSearchKey = updateEncryptedKey(settings.webSearch.apiKey, currentWebSearchKey, (key) => this.encryptKey(key));
    persisted.encryptedEmbeddingKey = updateEncryptedKey(settings.embedding.apiKey, currentEmbeddingKey, (key) => this.encryptKey(key));

    this.writePersisted(persisted);
    return this.toPublicSettings(persisted);
  }

  private readPersisted(): PersistedSettings {
    if (!existsSync(this.settingsPath)) {
      return this.toPersisted(defaultSettings);
    }

    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, "utf8")) as PersistedSettings;
      return normalizePersisted(parsed);
    } catch {
      return this.toPersisted(defaultSettings);
    }
  }

  private writePersisted(settings: PersistedSettings): void {
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    writeFileSync(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  private toPersisted(settings: AppSettings): PersistedSettings {
    return {
      openCodeLlm:
        settings.openCodeLlm.source === "api"
          ? {
              source: "api",
              provider: settings.openCodeLlm.provider,
              model: settings.openCodeLlm.model,
              baseUrl: settings.openCodeLlm.baseUrl
            }
          : settings.openCodeLlm,
      openCode: settings.openCode,
      webSearch: {
        provider: settings.webSearch.provider,
        endpoint: settings.webSearch.endpoint,
        timeoutMs: settings.webSearch.timeoutMs
      },
      embedding: {
        provider: settings.embedding.provider,
        model: settings.embedding.model,
        baseUrl: settings.embedding.baseUrl,
        dimensions: settings.embedding.dimensions
      },
      browserUse: normalizeBrowserUse(settings.browserUse),
      researchMetadata: normalizeResearchMetadata(settings.researchMetadata),
      engineeringTools: normalizeEngineeringTools(settings.engineeringTools),
      allowExternalSearch: settings.allowExternalSearch,
      allowCodeExecution: settings.allowCodeExecution,
      ontologyExtractionMode: settings.ontologyExtractionMode,
      finalOutputExport: settings.finalOutputExport,
      updatedAt: settings.updatedAt
    };
  }

  private toPublicSettings(settings: PersistedSettings): AppSettings {
    const normalized = normalizePersisted(settings);
    return {
      openCodeLlm:
        normalized.openCodeLlm?.source === "api"
          ? {
              ...normalized.openCodeLlm,
              apiKeyConfigured: this.isEncryptedKeyUsable(normalized.encryptedApiKey)
            }
          : {
              source: "codex-oauth",
              model: normalized.openCodeLlm?.source === "codex-oauth" ? normalized.openCodeLlm.model : "gpt-5.5"
            },
      openCode: normalized.openCode ?? defaultSettings.openCode,
      webSearch: {
        ...(normalized.webSearch ?? defaultSettings.webSearch),
        apiKeyConfigured: this.isEncryptedKeyUsable(normalized.encryptedWebSearchKey)
      },
      embedding: {
        ...(normalized.embedding ?? defaultSettings.embedding),
        apiKeyConfigured: this.isEncryptedKeyUsable(normalized.encryptedEmbeddingKey)
      },
      browserUse: normalizeBrowserUse(normalized.browserUse),
      researchMetadata: normalizeResearchMetadata(normalized.researchMetadata),
      engineeringTools: normalizeEngineeringTools(normalized.engineeringTools),
      allowExternalSearch: normalized.allowExternalSearch ?? defaultSettings.allowExternalSearch,
      allowCodeExecution: normalized.allowCodeExecution ?? defaultSettings.allowCodeExecution,
      ontologyExtractionMode: normalized.ontologyExtractionMode ?? defaultSettings.ontologyExtractionMode,
      finalOutputExport: normalized.finalOutputExport ?? defaultSettings.finalOutputExport,
      updatedAt: normalized.updatedAt
    };
  }

  private encryptKey(apiKey: string): string {
    return `plain:${Buffer.from(apiKey, "utf8").toString("base64")}`;
  }

  private decryptKey(encryptedApiKey?: string): string | undefined {
    if (!encryptedApiKey) {
      return undefined;
    }
    if (encryptedApiKey.startsWith("plain:")) {
      return Buffer.from(encryptedApiKey.slice(6), "base64").toString("utf8");
    }
    return undefined;
  }

  private isEncryptedKeyUsable(encryptedApiKey?: string): boolean {
    return Boolean(this.decryptKey(encryptedApiKey));
  }

  private usableEncryptedKey(encryptedApiKey?: string): string | undefined {
    return this.isEncryptedKeyUsable(encryptedApiKey) ? encryptedApiKey : undefined;
  }
}

function normalizePersisted(settings: PersistedSettings): PersistedSettings {
  const openCodeLlm =
    settings.openCodeLlm?.source === "api"
      ? {
          ...settings.openCodeLlm,
          provider: normalizeApiProvider(settings.openCodeLlm.provider)
        }
      : settings.openCodeLlm;
  const openCode = {
    ...defaultSettings.openCode,
    ...(settings.openCode ?? {}),
    provider: normalizeRuntimeProvider(settings.openCode?.provider ?? defaultSettings.openCode.provider)
  };
  const embedding = {
    ...defaultSettings.embedding,
    ...(settings.embedding ?? {}),
    provider: normalizeEmbeddingProvider(settings.embedding?.provider ?? defaultSettings.embedding.provider)
  };
  return {
    ...settings,
    openCodeLlm: openCodeLlm ?? defaultSettings.openCodeLlm,
    openCode,
    webSearch: normalizeWebSearch(settings.webSearch),
    embedding,
    browserUse: normalizeBrowserUse(settings.browserUse),
    researchMetadata: normalizeResearchMetadata(settings.researchMetadata),
    engineeringTools: normalizeEngineeringTools(settings.engineeringTools),
    allowExternalSearch: settings.allowExternalSearch ?? defaultSettings.allowExternalSearch,
    allowCodeExecution: settings.allowCodeExecution ?? defaultSettings.allowCodeExecution,
    ontologyExtractionMode:
      settings.ontologyExtractionMode === "llm" || settings.ontologyExtractionMode === "rule_based" || settings.ontologyExtractionMode === "hybrid"
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

function normalizeWebSearch(settings: unknown): WebSearchSettings {
  const input = settings && typeof settings === "object" ? (settings as Partial<WebSearchSettings>) : {};
  return {
    ...defaultSettings.webSearch,
    ...input,
    timeoutMs: clampNumber(input.timeoutMs, 1_000, 60_000, defaultSettings.webSearch.timeoutMs ?? 10_000)
  };
}
function normalizeBrowserUse(settings: unknown): AppSettings["browserUse"] {
  const input = settings && typeof settings === "object" ? (settings as Partial<AppSettings["browserUse"]>) : {};
  return {
    enabled: input.enabled ?? defaultSettings.browserUse.enabled,
    mode: input.mode === "visible" ? "visible" : "background",
    maxPages: clampNumber(input.maxPages, 1, 5, defaultSettings.browserUse.maxPages),
    timeoutMs: clampNumber(input.timeoutMs, 5_000, 120_000, defaultSettings.browserUse.timeoutMs),
    captureScreenshots: input.captureScreenshots ?? defaultSettings.browserUse.captureScreenshots
  };
}

function normalizeResearchMetadata(settings: unknown): ResearchMetadataSettings {
  const input = settings && typeof settings === "object" ? (settings as Partial<ResearchMetadataSettings>) : {};
  return {
    enabled: input.enabled ?? defaultSettings.researchMetadata.enabled,
    provider: "openalex",
    mailto: typeof input.mailto === "string" && input.mailto.trim() ? input.mailto.trim() : undefined,
    maxResults: clampNumber(input.maxResults, 1, 25, defaultSettings.researchMetadata.maxResults),
    timeoutMs: clampNumber(input.timeoutMs, 5_000, 60_000, defaultSettings.researchMetadata.timeoutMs)
  };
}

function normalizeEngineeringTools(settings: unknown): EngineeringProgramSettings {
  const input = settings && typeof settings === "object" ? (settings as Partial<EngineeringProgramSettings>) : {};
  const xfoil = (input.xfoil ?? {}) as Partial<EngineeringProgramSettings["xfoil"]>;
  const modeling = (input.modeling ?? {}) as Partial<EngineeringProgramSettings["modeling"]>;
  const su2 = (input.su2 ?? {}) as Partial<EngineeringProgramSettings["su2"]>;
  const openVsp = (input.openVsp ?? {}) as Partial<EngineeringProgramSettings["openVsp"]>;
  const xflr5 = (input.xflr5 ?? {}) as Partial<EngineeringProgramSettings["xflr5"]>;
  return hydrateEmbeddedEngineeringTools({
    enabled: input.enabled ?? defaultSettings.engineeringTools.enabled,
    toolchainRoot: typeof input.toolchainRoot === "string" && input.toolchainRoot.trim()
      ? input.toolchainRoot.trim()
      : defaultSettings.engineeringTools.toolchainRoot,
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
      caseRoot: typeof su2.caseRoot === "string" ? su2.caseRoot.trim() : defaultSettings.engineeringTools.su2.caseRoot,
      configFile: typeof su2.configFile === "string" ? su2.configFile.trim() : defaultSettings.engineeringTools.su2.configFile,
      workingDirectory:
        typeof su2.workingDirectory === "string" ? su2.workingDirectory.trim() : defaultSettings.engineeringTools.su2.workingDirectory,
      probeArgs: normalizeArgList(su2.probeArgs, defaultSettings.engineeringTools.su2.probeArgs),
      runArgsTemplate: normalizeArgList(su2.runArgsTemplate, defaultSettings.engineeringTools.su2.runArgsTemplate),
      timeoutMs: clampNumber(su2.timeoutMs, 5_000, 6 * 60 * 60_000, defaultSettings.engineeringTools.su2.timeoutMs)
    },
    openVsp: {
      enabled: openVsp.enabled ?? defaultSettings.engineeringTools.openVsp.enabled,
      command: normalizeCommand(openVsp.command, defaultSettings.engineeringTools.openVsp.command),
      scriptPath: typeof openVsp.scriptPath === "string" ? openVsp.scriptPath.trim() : defaultSettings.engineeringTools.openVsp.scriptPath,
      workingDirectory:
        typeof openVsp.workingDirectory === "string" ? openVsp.workingDirectory.trim() : defaultSettings.engineeringTools.openVsp.workingDirectory,
      probeArgs: normalizeArgList(openVsp.probeArgs, defaultSettings.engineeringTools.openVsp.probeArgs),
      runArgsTemplate: normalizeArgList(openVsp.runArgsTemplate, defaultSettings.engineeringTools.openVsp.runArgsTemplate),
      timeoutMs: clampNumber(openVsp.timeoutMs, 5_000, 6 * 60 * 60_000, defaultSettings.engineeringTools.openVsp.timeoutMs)
    },
    xflr5: {
      enabled: xflr5.enabled ?? defaultSettings.engineeringTools.xflr5.enabled,
      command: normalizeCommand(xflr5.command, defaultSettings.engineeringTools.xflr5.command),
      scriptPath: typeof xflr5.scriptPath === "string" ? xflr5.scriptPath.trim() : defaultSettings.engineeringTools.xflr5.scriptPath,
      workingDirectory:
        typeof xflr5.workingDirectory === "string" ? xflr5.workingDirectory.trim() : defaultSettings.engineeringTools.xflr5.workingDirectory,
      probeArgs: normalizeArgList(xflr5.probeArgs, defaultSettings.engineeringTools.xflr5.probeArgs),
      runArgsTemplate: normalizeArgList(xflr5.runArgsTemplate, defaultSettings.engineeringTools.xflr5.runArgsTemplate),
      timeoutMs: clampNumber(xflr5.timeoutMs, 5_000, 6 * 60 * 60_000, defaultSettings.engineeringTools.xflr5.timeoutMs)
    }
  });
}

function hydrateEmbeddedEngineeringTools(settings: EngineeringProgramSettings): EngineeringProgramSettings {
  if (!settings.enabled) return settings;
  const status = embeddedEngineeringToolchainStatus(settings);
  return {
    ...settings,
    su2: hydrateEmbeddedExecutable(settings.su2, status.su2),
    openVsp: hydrateEmbeddedExecutable(settings.openVsp, status.openvsp),
    xflr5: hydrateEmbeddedExecutable(settings.xflr5, status.xflr5)
  };
}

function hydrateEmbeddedExecutable<T extends { enabled: boolean; command?: string }>(
  tool: T,
  status: { ready: boolean; command?: string }
): T {
  if (!status.ready || !status.command) return tool;
  return {
    ...tool,
    enabled: true,
    command: status.command
  };
}
function normalizeCommand(value: unknown, defaultValue: string | undefined): string {
  const normalizedDefault = defaultValue ?? "";
  if (typeof value !== "string") return normalizedDefault;
  return value.trim() || normalizedDefault;
}

function normalizeArgList(value: unknown, defaultValue: string[]): string[] {
  if (!Array.isArray(value)) return [...defaultValue];
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const cleaned = item.trim();
    if (!cleaned) continue;
    normalized.push(cleaned);
    if (normalized.length >= 24) break;
  }
  return normalized;
}

function clampNumber(value: unknown, min: number, max: number, defaultValue: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : defaultValue;
}

function normalizeApiProvider(provider: unknown): OpenCodeApiLlmSettings["provider"] {
  return provider === "openai" || provider === "anthropic" || provider === "google" || provider === "custom" ? provider : "google";
}

function normalizeRuntimeProvider(provider: unknown): string {
  return provider === "openrouter" ? "google" : typeof provider === "string" && provider ? provider : "openai";
}

function normalizeEmbeddingProvider(provider: unknown): EmbeddingSettings["provider"] {
  if (provider === "openai" || provider === "google" || provider === "custom") {
    return provider;
  }
  return provider === "openrouter" ? "google" : "openai";
}

function updateEncryptedKey(
  incoming: string | undefined,
  current: string | undefined,
  encrypt: (value: string) => string
): string | undefined {
  if (incoming === undefined) {
    return current;
  }
  if (incoming.trim() === "") {
    return undefined;
  }
  return encrypt(incoming.trim());
}
