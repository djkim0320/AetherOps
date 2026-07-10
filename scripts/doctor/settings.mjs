import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readPersistedSettings(dataRoot) {
  const path = join(dataRoot, "settings.json");
  if (!existsSync(path)) return { path, present: false, value: {} };
  const value = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  return { path, present: true, value };
}

export function hasEncryptedSecret(value) {
  return typeof value === "string" && value.trim().length > 0 && value !== "keep";
}

export function codexSettings(settings) {
  return settings.codex ?? settings.openCodeLlm ?? {};
}

export function capabilitySettings(settings) {
  if (settings.capabilities) return settings.capabilities;
  return {
    agent: true,
    engineering: Boolean(settings.allowCodeExecution),
    search: Boolean(settings.allowExternalSearch)
  };
}
