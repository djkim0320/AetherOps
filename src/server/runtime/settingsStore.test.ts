import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonAppSettingsStore } from "./settingsStore.js";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("JsonAppSettingsStore", () => {
  it("does not report unsupported safe encrypted keys as configured", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-settings-"));
    const settingsPath = join(tempRoot, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          embedding: {
            provider: "openai",
            model: "text-embedding-3-large",
            dimensions: 1024
          },
          encryptedEmbeddingKey: "safe:v10unsupported",
          updatedAt: "2026-05-20T00:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const store = new JsonAppSettingsStore(settingsPath);
    const publicSettings = await store.getSettings();
    const runtimeSettings = await store.getRuntimeSettings();

    expect(publicSettings.embedding.apiKeyConfigured).toBe(false);
    expect(runtimeSettings.embedding.apiKey).toBeUndefined();
  });

  it("stores and reuses newly entered embedding keys", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-settings-"));
    const settingsPath = join(tempRoot, "settings.json");
    const store = new JsonAppSettingsStore(settingsPath);

    await store.saveSettings({
      ...(await store.getSettings()),
      embedding: {
        provider: "openai",
        model: "text-embedding-3-large",
        dimensions: 1024,
        apiKey: "sk-test"
      }
    });

    const publicSettings = await store.getSettings();
    const runtimeSettings = await store.getRuntimeSettings();

    expect(publicSettings.embedding.apiKeyConfigured).toBe(true);
    expect(runtimeSettings.embedding.apiKey).toBe("sk-test");
  });

  it("ignores legacy maxLoopIterations because loop continuation is agent-controlled", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-settings-"));
    const settingsPath = join(tempRoot, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          maxLoopIterations: 1,
          updatedAt: "2026-05-20T00:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const store = new JsonAppSettingsStore(settingsPath);
    const publicSettings = await store.getSettings();
    const saved = await store.saveSettings(publicSettings);

    expect(publicSettings.maxLoopIterations).toBeUndefined();
    expect(saved.maxLoopIterations).toBeUndefined();
  });
});
