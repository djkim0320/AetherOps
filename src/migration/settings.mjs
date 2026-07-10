import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { homedir, hostname, userInfo } from "node:os";
import { normalizeText, sha256Hex, stableJsonHash } from "./hash.mjs";

export const protectedSecretPrefix = "enc:v1:";
export const defaultCodexModel = "gpt-5.6";
export const defaultCodexReasoningEffort = "xhigh";
export const defaultCodexTimeoutMs = 180_000;

const supportedCodexModels = new Set(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]);
const supportedEfforts = new Set(["low", "medium", "high", "xhigh", "max"]);

const algorithm = "aes-256-gcm";
const aad = Buffer.from("aetherops-settings-secret:v1", "utf8");
const salt = "aetherops-settings-machine-user-bound:v1";

export function encryptMachineBoundSecret(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, deriveMachineUserKey(), iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(String(secret), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${protectedSecretPrefix}${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptMachineBoundSecret(value) {
  if (typeof value !== "string" || !value.startsWith(protectedSecretPrefix)) return undefined;
  const parts = value.slice(protectedSecretPrefix.length).split(":");
  if (parts.length !== 3) return undefined;
  try {
    const [iv, tag, encrypted] = parts.map((part) => Buffer.from(part, "base64url"));
    if (iv.byteLength !== 12 || tag.byteLength !== 16 || encrypted.byteLength === 0) return undefined;
    const decipher = createDecipheriv(algorithm, deriveMachineUserKey(), iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

export function readSettingsSnapshot(settingsPath) {
  if (!existsSync(settingsPath)) {
    return {
      present: false,
      path: settingsPath
    };
  }
  const raw = readFileSync(settingsPath, "utf8");
  const text = normalizeText(raw);
  const parsed = parseSettingsJson(text, settingsPath);
  const normalized = normalizeSettings(parsed);
  const ciphertexts = summarizeCiphertexts(parsed);
  return {
    present: true,
    path: settingsPath,
    rawSha256: sha256Hex(Buffer.from(raw, "utf8")),
    semanticSha256: stableJsonHash({
      ...normalized,
      ciphertexts: ciphertexts.map((entry) => ({
        field: entry.field,
        prefix: entry.prefix,
        length: entry.length,
        sha256: entry.sha256,
        decryptable: entry.decryptable,
        plaintextSha256: entry.plaintextSha256,
        plaintextLength: entry.plaintextLength
      }))
    }),
    updatedAt: normalized.updatedAt,
    settings: normalized,
    ciphertexts,
    codexMigration: normalized.codexMigration
  };
}

export function migrateCodexSettingsFile(settingsPath, journalPath) {
  if (!existsSync(settingsPath)) return { changed: false, present: false };
  const raw = readFileSync(settingsPath, "utf8");
  const parsed = parseSettingsJson(normalizeText(raw), settingsPath);
  const migration = migrateCodexSettingsObject(parsed);
  if (!migration.changed)
    return { ...migration, present: true, beforeSha256: sha256Hex(Buffer.from(raw, "utf8")), afterSha256: sha256Hex(Buffer.from(raw, "utf8")) };
  const next = `${JSON.stringify(migration.settings, null, 2)}\n`;
  const tempPath = `${settingsPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tempPath, next, "utf8");
    renameSync(tempPath, settingsPath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
  const result = {
    present: true,
    changed: true,
    originalModel: migration.originalModel,
    model: migration.model,
    reason: migration.reason,
    beforeSha256: sha256Hex(Buffer.from(raw, "utf8")),
    afterSha256: sha256Hex(Buffer.from(next, "utf8")),
    migratedAt: new Date().toISOString()
  };
  if (journalPath) writeFileSync(journalPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

export function migrateCodexSettingsObject(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("AetherOps settings file must contain a JSON object.");
  const original = settings.openCodeLlm && typeof settings.openCodeLlm === "object" ? settings.openCodeLlm : {};
  const originalModel = typeof original.model === "string" ? original.model : undefined;
  const model = supportedCodexModels.has(originalModel) ? originalModel : defaultCodexModel;
  const reasoningEffort = supportedEfforts.has(original.reasoningEffort) ? original.reasoningEffort : defaultCodexReasoningEffort;
  const legacyTimeout = settings.openCode && typeof settings.openCode === "object" ? settings.openCode.timeoutMs : undefined;
  const timeoutMs = validTimeout(original.timeoutMs) ?? validTimeout(legacyTimeout) ?? defaultCodexTimeoutMs;
  const compatibleEffort = reasoningEffort === "max" && !model.startsWith("gpt-5.6") ? defaultCodexReasoningEffort : reasoningEffort;
  const migrated = { source: "codex-oauth", model, reasoningEffort: compatibleEffort, timeoutMs };
  const changed = stableJsonHash(original) !== stableJsonHash(migrated);
  return {
    changed,
    originalModel,
    model,
    reason: originalModel && !supportedCodexModels.has(originalModel) ? "unsupported_model" : originalModel ? "settings_upgrade" : "missing_model",
    settings: changed ? { ...settings, openCodeLlm: migrated } : settings
  };
}

export function summarizeCiphertexts(settingsObject) {
  const fields = ["encryptedApiKey", "encryptedWebSearchKey", "encryptedEmbeddingKey"];
  const output = [];
  for (const field of fields) {
    const value = settingsObject?.[field];
    if (typeof value !== "string" || !value) {
      continue;
    }
    const decryptable = decryptMachineBoundSecret(value);
    const plain = typeof value === "string" && value.startsWith("plain:") ? Buffer.from(value.slice(6), "base64").toString("utf8") : decryptable;
    output.push({
      field,
      prefix: value.startsWith(protectedSecretPrefix) ? protectedSecretPrefix.slice(0, -1) : value.startsWith("plain:") ? "plain" : "unknown",
      length: value.length,
      sha256: sha256Hex(value),
      decryptable: Boolean(decryptable),
      plaintextSha256: plain ? sha256Hex(plain) : undefined,
      plaintextLength: plain ? Buffer.byteLength(plain, "utf8") : undefined
    });
  }
  return output;
}

function parseSettingsJson(text, path) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid AetherOps settings file at ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function normalizeSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("AetherOps settings file must contain a JSON object.");
  }
  const input = settings;
  assertStrictBooleanIfPresent(input.allowExternalSearch, "allowExternalSearch");
  assertStrictBooleanIfPresent(input.allowCodeExecution, "allowCodeExecution");
  const codexMigration = migrateCodexSettingsObject(input);
  const openCodeLlm = codexMigration.settings.openCodeLlm;
  const webSearch = input.webSearch && typeof input.webSearch === "object" ? input.webSearch : {};
  const embedding = input.embedding && typeof input.embedding === "object" ? input.embedding : {};
  return {
    openCodeLlm: {
      source: "codex-oauth",
      model: openCodeLlm.model,
      reasoningEffort: openCodeLlm.reasoningEffort,
      timeoutMs: openCodeLlm.timeoutMs,
      apiKeyConfigured: Boolean(decryptMachineBoundSecret(input.encryptedApiKey))
    },
    webSearch: {
      provider: typeof webSearch.provider === "string" ? webSearch.provider : "disabled",
      endpoint: typeof webSearch.endpoint === "string" ? webSearch.endpoint : undefined,
      timeoutMs: typeof webSearch.timeoutMs === "number" && Number.isFinite(webSearch.timeoutMs) ? webSearch.timeoutMs : undefined,
      apiKeyConfigured: Boolean(decryptMachineBoundSecret(input.encryptedWebSearchKey))
    },
    embedding: {
      provider: typeof embedding.provider === "string" ? embedding.provider : "openai",
      model: typeof embedding.model === "string" ? embedding.model : undefined,
      baseUrl: typeof embedding.baseUrl === "string" ? embedding.baseUrl : undefined,
      dimensions: typeof embedding.dimensions === "number" && Number.isFinite(embedding.dimensions) ? embedding.dimensions : undefined,
      apiKeyConfigured: Boolean(decryptMachineBoundSecret(input.encryptedEmbeddingKey))
    },
    browserUse: input.browserUse && typeof input.browserUse === "object" ? input.browserUse : undefined,
    researchMetadata: input.researchMetadata && typeof input.researchMetadata === "object" ? input.researchMetadata : undefined,
    engineeringTools: input.engineeringTools && typeof input.engineeringTools === "object" ? input.engineeringTools : undefined,
    allowExternalSearch: input.allowExternalSearch,
    allowCodeExecution: input.allowCodeExecution,
    ontologyExtractionMode: typeof input.ontologyExtractionMode === "string" ? input.ontologyExtractionMode : undefined,
    finalOutputExport: input.finalOutputExport && typeof input.finalOutputExport === "object" ? input.finalOutputExport : undefined,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : undefined,
    codexMigration: {
      changed: codexMigration.changed,
      originalModel: codexMigration.originalModel,
      model: codexMigration.model,
      reason: codexMigration.reason
    }
  };
}

function validTimeout(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1_000 && value <= 900_000 ? value : undefined;
}

function assertStrictBooleanIfPresent(value, field) {
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    throw new Error(`AetherOps setting ${field} must be a boolean.`);
  }
}

function deriveMachineUserKey() {
  const material = machineUserMaterial();
  return scryptSync(material, salt, 32);
}

function machineUserMaterial() {
  let username = "unknown-user";
  try {
    username = userInfo().username || username;
  } catch {
    username = process.env.USERNAME || process.env.USER || username;
  }
  return [process.platform, process.arch, hostname(), username, homedir()].join("\0");
}
