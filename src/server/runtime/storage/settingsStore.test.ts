import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("round-trips OpenVSP engineering tool settings", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-settings-"));
    const settingsPath = join(tempRoot, "settings.json");
    const scriptPath = join(tempRoot, "openvsp-script.mjs");
    writeFileSync(scriptPath, "console.log('OpenVSP settings round-trip');\n", "utf8");
    const store = new JsonAppSettingsStore(settingsPath);
    const current = await store.getSettings();

    await store.saveSettings({
      ...current,
      allowCodeExecution: true,
      engineeringTools: {
        ...current.engineeringTools,
        enabled: true,
        openVsp: {
          enabled: true,
          command: "node.exe",
          scriptPath,
          workingDirectory: tempRoot,
          probeArgs: ["--version"],
          runArgsTemplate: ["{script}", "--output", "{output}"],
          timeoutMs: 60_000
        }
      }
    });

    const publicSettings = await store.getSettings();
    const runtimeSettings = await store.getRuntimeSettings();

    expect(publicSettings.engineeringTools.openVsp).toMatchObject({
      enabled: true,
      command: "node.exe",
      scriptPath,
      workingDirectory: tempRoot,
      probeArgs: ["--version"],
      runArgsTemplate: ["{script}", "--output", "{output}"],
      timeoutMs: 60_000
    });
    expect(runtimeSettings.engineeringTools.openVsp).toEqual(publicSettings.engineeringTools.openVsp);
  });

  it("round-trips SU2 engineering tool settings", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-settings-"));
    const settingsPath = join(tempRoot, "settings.json");
    const caseRoot = join(tempRoot, "su2-case");
    mkdirSync(caseRoot, { recursive: true });
    writeFileSync(join(caseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");
    const store = new JsonAppSettingsStore(settingsPath);
    const current = await store.getSettings();

    await store.saveSettings({
      ...current,
      allowCodeExecution: true,
      engineeringTools: {
        ...current.engineeringTools,
        enabled: true,
        su2: {
          enabled: true,
          command: "SU2_CFD.exe",
          caseRoot,
          configFile: "case.cfg",
          workingDirectory: caseRoot,
          probeArgs: ["--help"],
          runArgsTemplate: ["{config}", "--output", "{output}"],
          timeoutMs: 60_000
        }
      }
    });

    const publicSettings = await store.getSettings();
    const runtimeSettings = await store.getRuntimeSettings();

    expect(publicSettings.engineeringTools.su2).toMatchObject({
      enabled: true,
      command: "SU2_CFD.exe",
      caseRoot,
      configFile: "case.cfg",
      workingDirectory: caseRoot,
      probeArgs: ["--help"],
      runArgsTemplate: ["{config}", "--output", "{output}"],
      timeoutMs: 60_000
    });
    expect(runtimeSettings.engineeringTools.su2).toEqual(publicSettings.engineeringTools.su2);
  });
});
