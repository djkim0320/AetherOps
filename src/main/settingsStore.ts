import { safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nowIso } from "../core/ids.js";
import type { AppSettings, OpenCodeApiLlmSettings, OpenCodeLlmSettings } from "../core/types.js";

interface PersistedSettings {
  openCodeLlm: Omit<OpenCodeApiLlmSettings, "apiKey" | "apiKeyConfigured"> | Extract<OpenCodeLlmSettings, { source: "codex-oauth" }>;
  encryptedApiKey?: string;
  updatedAt: string;
}

export interface AppSettingsStore {
  getSettings(): Promise<AppSettings>;
  getRuntimeSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
}

const defaultSettings: AppSettings = {
  openCodeLlm: {
    source: "codex-oauth",
    model: "gpt-5.5"
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
    if (publicSettings.openCodeLlm.source !== "api") {
      return publicSettings;
    }

    return {
      ...publicSettings,
      openCodeLlm: {
        ...publicSettings.openCodeLlm,
        apiKey: this.decryptApiKey(persisted.encryptedApiKey)
      }
    };
  }

  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    const current = this.readPersisted();
    const updatedAt = nowIso();
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
      encryptedApiKey: settings.openCodeLlm.source === "api" ? current.encryptedApiKey : undefined,
      updatedAt
    };

    if (settings.openCodeLlm.source === "api") {
      if (settings.openCodeLlm.apiKey && settings.openCodeLlm.apiKey.trim()) {
        persisted.encryptedApiKey = this.encryptApiKey(settings.openCodeLlm.apiKey.trim());
      } else if (settings.openCodeLlm.apiKey === "") {
        persisted.encryptedApiKey = undefined;
      }
    }

    this.writePersisted(persisted);
    return this.toPublicSettings(persisted);
  }

  private readPersisted(): PersistedSettings {
    if (!existsSync(this.settingsPath)) {
      return this.toPersisted(defaultSettings);
    }

    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, "utf8")) as PersistedSettings;
      if (!parsed.openCodeLlm?.source) {
        return this.toPersisted(defaultSettings);
      }
      return parsed;
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
      updatedAt: settings.updatedAt
    };
  }

  private toPublicSettings(settings: PersistedSettings): AppSettings {
    return {
      openCodeLlm:
        settings.openCodeLlm.source === "api"
          ? {
              ...settings.openCodeLlm,
              apiKeyConfigured: Boolean(settings.encryptedApiKey)
            }
          : settings.openCodeLlm,
      updatedAt: settings.updatedAt
    };
  }

  private encryptApiKey(apiKey: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return `safe:${safeStorage.encryptString(apiKey).toString("base64")}`;
    }
    return `plain:${Buffer.from(apiKey, "utf8").toString("base64")}`;
  }

  private decryptApiKey(encryptedApiKey?: string): string | undefined {
    if (!encryptedApiKey) {
      return undefined;
    }
    if (encryptedApiKey.startsWith("safe:") && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(encryptedApiKey.slice(5), "base64"));
    }
    if (encryptedApiKey.startsWith("plain:")) {
      return Buffer.from(encryptedApiKey.slice(6), "base64").toString("utf8");
    }
    return undefined;
  }
}
