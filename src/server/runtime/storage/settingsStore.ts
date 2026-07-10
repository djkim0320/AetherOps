import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nowIso } from "../../../core/shared/ids.js";
import type { AppSettings } from "../../../core/shared/types.js";
import { decryptMachineBoundSecret, encryptMachineBoundSecret } from "../security/settingsSecrets.js";
import {
  assertStrictBoolean,
  defaultSettings,
  formatSettingsReadError,
  normalizeBrowserUse,
  normalizeCodexSettings,
  normalizeEngineeringTools,
  normalizePersisted,
  normalizeResearchMetadata,
  resolveIncomingSecret,
  type PersistedSettings
} from "./settingsDefaults.js";

export { defaultSettings } from "./settingsDefaults.js";

export interface AppSettingsStore {
  getSettings(): Promise<AppSettings>;
  getRuntimeSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
}

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
      webSearch: { ...publicSettings.webSearch, apiKey: this.decryptKey(persisted.encryptedWebSearchKey) },
      embedding: { ...publicSettings.embedding, apiKey: this.decryptKey(persisted.encryptedEmbeddingKey) }
    };
  }

  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    assertStrictBoolean(settings.allowExternalSearch, "allowExternalSearch");
    assertStrictBoolean(settings.allowCodeExecution, "allowCodeExecution");
    const current = this.readPersisted();
    const currentWebSearchKey = this.decryptKey(current.encryptedWebSearchKey);
    const currentEmbeddingKey = this.decryptKey(current.encryptedEmbeddingKey);
    const persisted: PersistedSettings = {
      openCodeLlm: normalizeCodexSettings(settings.openCodeLlm),
      openCode: settings.openCode,
      webSearch: { provider: settings.webSearch.provider, endpoint: settings.webSearch.endpoint, timeoutMs: settings.webSearch.timeoutMs },
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
      encryptedWebSearchKey: this.nextEncryptedKey(settings.webSearch.apiKey, currentWebSearchKey),
      encryptedEmbeddingKey: this.nextEncryptedKey(settings.embedding.apiKey, currentEmbeddingKey),
      updatedAt: nowIso()
    };
    this.writePersisted(persisted);
    return this.toPublicSettings(persisted);
  }

  private readPersisted(): PersistedSettings {
    if (!existsSync(this.settingsPath)) return this.toPersisted(defaultSettings);
    try {
      return normalizePersisted(JSON.parse(readFileSync(this.settingsPath, "utf8")) as PersistedSettings);
    } catch (error) {
      throw new Error(`Invalid AetherOps settings file at ${this.settingsPath}: ${formatSettingsReadError(error)}`, { cause: error });
    }
  }

  private writePersisted(settings: PersistedSettings): void {
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    const tempPath = `${this.settingsPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      renameSync(tempPath, this.settingsPath);
    } catch (error) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        /* best-effort cleanup */
      }
      throw error;
    }
  }

  private toPersisted(settings: AppSettings): PersistedSettings {
    return {
      openCodeLlm: settings.openCodeLlm,
      openCode: settings.openCode,
      webSearch: { provider: settings.webSearch.provider, endpoint: settings.webSearch.endpoint, timeoutMs: settings.webSearch.timeoutMs },
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
      openCodeLlm: normalizeCodexSettings(normalized.openCodeLlm, normalized.openCode?.timeoutMs),
      openCode: normalized.openCode ?? defaultSettings.openCode,
      webSearch: { ...(normalized.webSearch ?? defaultSettings.webSearch), apiKeyConfigured: this.isEncryptedKeyUsable(normalized.encryptedWebSearchKey) },
      embedding: { ...(normalized.embedding ?? defaultSettings.embedding), apiKeyConfigured: this.isEncryptedKeyUsable(normalized.encryptedEmbeddingKey) },
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

  private decryptKey(encryptedValue?: unknown): string | undefined {
    if (typeof encryptedValue !== "string" || !encryptedValue) return undefined;
    if (encryptedValue.startsWith("plain:")) return Buffer.from(encryptedValue.slice(6), "base64").toString("utf8");
    return decryptMachineBoundSecret(encryptedValue);
  }

  private isEncryptedKeyUsable(encryptedValue?: unknown): boolean {
    return Boolean(this.decryptKey(encryptedValue));
  }

  private nextEncryptedKey(incoming: unknown, currentPlaintext: string | undefined): string | undefined {
    const nextPlaintext = resolveIncomingSecret(incoming, currentPlaintext);
    return nextPlaintext ? encryptMachineBoundSecret(nextPlaintext) : undefined;
  }
}
