import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nowIso } from "../../core/ids.js";
import type {
  AppSettings,
  EmbeddingSettings,
  OpenCodeApiLlmSettings,
  OpenCodeLlmSettings,
  WebSearchSettings
} from "../../core/types.js";

interface PersistedSettings {
  openCodeLlm?: Omit<OpenCodeApiLlmSettings, "apiKey" | "apiKeyConfigured"> | Extract<OpenCodeLlmSettings, { source: "codex-oauth" }>;
  openCode?: AppSettings["openCode"];
  webSearch?: Omit<WebSearchSettings, "apiKey" | "apiKeyConfigured">;
  embedding?: Omit<EmbeddingSettings, "apiKey" | "apiKeyConfigured">;
  allowExternalSearch?: boolean;
  allowCodeExecution?: boolean;
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
    provider: "disabled"
  },
  embedding: {
    provider: "local",
    model: "local-hash",
    dimensions: 96
  },
  allowExternalSearch: true,
  allowCodeExecution: false,
  maxLoopIterations: 2,
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
        endpoint: settings.webSearch.endpoint
      },
      embedding: {
        provider: settings.embedding.provider,
        model: settings.embedding.model,
        baseUrl: settings.embedding.baseUrl,
        dimensions: settings.embedding.dimensions
      },
      allowExternalSearch: settings.allowExternalSearch,
      allowCodeExecution: settings.allowCodeExecution,
      maxLoopIterations: settings.maxLoopIterations,
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
        endpoint: settings.webSearch.endpoint
      },
      embedding: {
        provider: settings.embedding.provider,
        model: settings.embedding.model,
        baseUrl: settings.embedding.baseUrl,
        dimensions: settings.embedding.dimensions
      },
      allowExternalSearch: settings.allowExternalSearch,
      allowCodeExecution: settings.allowCodeExecution,
      maxLoopIterations: settings.maxLoopIterations,
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
      allowExternalSearch: normalized.allowExternalSearch ?? defaultSettings.allowExternalSearch,
      allowCodeExecution: normalized.allowCodeExecution ?? defaultSettings.allowCodeExecution,
      maxLoopIterations: normalized.maxLoopIterations ?? defaultSettings.maxLoopIterations,
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
    webSearch: {
      ...defaultSettings.webSearch,
      ...(settings.webSearch ?? {})
    },
    embedding,
    allowExternalSearch: settings.allowExternalSearch ?? defaultSettings.allowExternalSearch,
    allowCodeExecution: settings.allowCodeExecution ?? defaultSettings.allowCodeExecution,
    maxLoopIterations: settings.maxLoopIterations ?? defaultSettings.maxLoopIterations,
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

function normalizeApiProvider(provider: unknown): OpenCodeApiLlmSettings["provider"] {
  return provider === "openai" || provider === "anthropic" || provider === "google" || provider === "custom" ? provider : "google";
}

function normalizeRuntimeProvider(provider: unknown): string {
  return provider === "openrouter" ? "google" : typeof provider === "string" && provider ? provider : "openai";
}

function normalizeEmbeddingProvider(provider: unknown): EmbeddingSettings["provider"] {
  if (provider === "openai" || provider === "google" || provider === "custom" || provider === "local") {
    return provider;
  }
  return provider === "openrouter" ? "google" : "local";
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
