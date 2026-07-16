import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSettings, JsonAppSettingsStore } from "./settingsStore.js";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("JsonAppSettingsStore", () => {
  it("uses the current Codex planner and workspace task defaults", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-settings-"));
    const store = new JsonAppSettingsStore(join(tempRoot, "settings.json"));

    expect(await store.getSettings()).toMatchObject({
      codex: { model: "gpt-5.6", reasoningEffort: "xhigh", timeoutMs: 180_000, taskTimeoutMs: 600_000 }
    });
  });

  it("defaults only missing persisted Codex fields", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-settings-"));
    const settingsPath = join(tempRoot, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ codex: { model: "gpt-5.6-sol" }, updatedAt: "2026-07-10T00:00:00.000Z" }), "utf8");

    await expect(new JsonAppSettingsStore(settingsPath).getSettings()).resolves.toMatchObject({
      codex: { model: "gpt-5.6-sol", reasoningEffort: "xhigh", timeoutMs: 180_000, taskTimeoutMs: 600_000 }
    });
  });

  it("fails closed for explicit null, array, and invalid Codex timeout values", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-settings-"));
    const cases = [
      { name: "null", codex: null, error: "Codex settings must be an object" },
      { name: "array", codex: [], error: "Unsupported Codex model" },
      {
        name: "null-timeout",
        codex: { model: "gpt-5.6", reasoningEffort: "xhigh", timeoutMs: null, taskTimeoutMs: 600_000 },
        error: "Codex timeoutMs must be an integer"
      },
      {
        name: "out-of-range-task-timeout",
        codex: { model: "gpt-5.6", reasoningEffort: "xhigh", timeoutMs: 180_000, taskTimeoutMs: 900_001 },
        error: "Codex taskTimeoutMs must be an integer"
      }
    ];

    for (const testCase of cases) {
      const settingsPath = join(tempRoot, `${testCase.name}.json`);
      writeFileSync(settingsPath, JSON.stringify({ codex: testCase.codex, updatedAt: "2026-07-10T00:00:00.000Z" }), "utf8");
      await expect(new JsonAppSettingsStore(settingsPath).getSettings()).rejects.toThrow(testCase.error);
    }
  });

  it("fails closed for unsupported persisted Codex models after migration", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-settings-"));
    const settingsPath = join(tempRoot, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        codex: { model: "gpt-5.5-codex", reasoningEffort: "xhigh", timeoutMs: 180_000, taskTimeoutMs: 600_000 },
        updatedAt: "2026-07-10T00:00:00.000Z"
      }),
      "utf8"
    );

    await expect(new JsonAppSettingsStore(settingsPath).getSettings()).rejects.toThrow("Unsupported Codex model");
  });

  it("round-trips model, reasoning effort, and both Codex timeouts", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-settings-"));
    const store = new JsonAppSettingsStore(join(tempRoot, "settings.json"));
    const initial = await store.getSettings();
    const saved = await store.saveSettings({
      ...initial,
      codex: { model: "gpt-5.6-terra", reasoningEffort: "max", timeoutMs: 240_000, taskTimeoutMs: 720_000 }
    });

    expect(saved.codex).toEqual({ model: "gpt-5.6-terra", reasoningEffort: "max", timeoutMs: 240_000, taskTimeoutMs: 720_000 });
    const persisted = JSON.parse(readFileSync(join(tempRoot, "settings.json"), "utf8"));
    expect(persisted.openCodeLlm).toBeUndefined();
    expect(persisted.openCode).toBeUndefined();
  });

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

  it("fails closed when an existing settings file is invalid", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-settings-"));
    const settingsPath = join(tempRoot, "settings.json");
    writeFileSync(settingsPath, "{ invalid json", "utf8");
    const store = new JsonAppSettingsStore(settingsPath);

    await expect(store.getSettings()).rejects.toThrow(/Invalid AetherOps settings file/);
    await expect(store.getRuntimeSettings()).rejects.toThrow(/Invalid AetherOps settings file/);
    await expect(store.saveSettings(defaultSettings)).rejects.toThrow(/Invalid AetherOps settings file/);
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

    const persisted = JSON.parse(readFileSync(settingsPath, "utf8")) as { encryptedEmbeddingKey?: string };
    expect(persisted.encryptedEmbeddingKey).toMatch(/^enc:v1:/);
    expect(persisted.encryptedEmbeddingKey).not.toContain(Buffer.from("sk-test", "utf8").toString("base64"));
  });

  it("reads legacy plain keys and migrates them to protected storage on save", async () => {
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
          encryptedEmbeddingKey: `plain:${Buffer.from("legacy-key", "utf8").toString("base64")}`,
          updatedAt: "2026-05-20T00:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const store = new JsonAppSettingsStore(settingsPath);
    expect((await store.getSettings()).embedding.apiKeyConfigured).toBe(true);
    expect((await store.getRuntimeSettings()).embedding.apiKey).toBe("legacy-key");

    await store.saveSettings(await store.getSettings());

    const persisted = JSON.parse(readFileSync(settingsPath, "utf8")) as { encryptedEmbeddingKey?: string };
    expect(persisted.encryptedEmbeddingKey).toMatch(/^enc:v1:/);
    expect(persisted.encryptedEmbeddingKey).not.toContain("plain:");
    expect((await store.getRuntimeSettings()).embedding.apiKey).toBe("legacy-key");
  });

  it("writes settings through a cleaned-up temporary file", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-settings-"));
    const settingsPath = join(tempRoot, "settings.json");
    const store = new JsonAppSettingsStore(settingsPath);

    await store.saveSettings({
      ...(await store.getSettings()),
      allowAgent: false,
      allowExternalSearch: false,
      allowCodeExecution: false
    });

    const entries = readdirSync(tempRoot);
    expect(entries).toContain("settings.json");
    expect(entries.some((name) => name.startsWith("settings.json.") && name.endsWith(".tmp"))).toBe(false);
    expect(await store.getRuntimeSettings()).toMatchObject({ allowAgent: false, allowExternalSearch: false, allowCodeExecution: false });
  });

  it("rejects non-boolean execution safety settings instead of coercing them", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-settings-"));
    const settingsPath = join(tempRoot, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          allowAgent: true,
          allowExternalSearch: "true",
          allowCodeExecution: false,
          updatedAt: "2026-05-20T00:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const store = new JsonAppSettingsStore(settingsPath);
    await expect(store.getSettings()).rejects.toThrow("allowExternalSearch must be a boolean");

    const validStore = new JsonAppSettingsStore(join(tempRoot, "valid-settings.json"));
    await expect(
      validStore.saveSettings({
        ...(await validStore.getSettings()),
        allowCodeExecution: "false" as never
      })
    ).rejects.toThrow("allowCodeExecution must be a boolean");
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

  it("hydrates installed embedded engineering tools into runtime settings", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-settings-toolchain-"));
    const settingsPath = join(tempRoot, "settings.json");
    const toolchainRoot = join(tempRoot, "vendor", "engineering-tools");
    const su2Path = join(toolchainRoot, "su2", "bin", "SU2_CFD.exe");
    const openVspPath = join(toolchainRoot, "openvsp", "OpenVSP", "vspscript.exe");
    const xflr5Path = join(toolchainRoot, "xflr5", "bin", "xflr5.exe");
    mkdirSync(join(toolchainRoot, "su2", "bin"), { recursive: true });
    mkdirSync(join(toolchainRoot, "openvsp", "OpenVSP"), { recursive: true });
    mkdirSync(join(toolchainRoot, "xflr5", "bin"), { recursive: true });
    writeFileSync(su2Path, "", "utf8");
    writeFileSync(openVspPath, "", "utf8");
    writeFileSync(xflr5Path, "", "utf8");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          allowCodeExecution: true,
          engineeringTools: {
            enabled: true,
            toolchainRoot,
            su2: {
              enabled: false,
              command: "",
              caseRoot: "",
              configFile: "",
              workingDirectory: "",
              probeArgs: ["--help"],
              runArgsTemplate: ["{config}"],
              timeoutMs: 60_000
            },
            openVsp: {
              enabled: false,
              command: "",
              scriptPath: "",
              workingDirectory: "",
              probeArgs: ["-help"],
              runArgsTemplate: ["-script", "{script}", "-spec", "{spec}", "-output", "{output}"],
              timeoutMs: 60_000
            },
            xflr5: {
              enabled: false,
              command: "",
              scriptPath: "",
              workingDirectory: "",
              probeArgs: ["--help"],
              runArgsTemplate: ["--script", "{script}", "--spec", "{spec}", "--output", "{output}"],
              timeoutMs: 60_000
            }
          },
          updatedAt: "2026-06-24T00:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const store = new JsonAppSettingsStore(settingsPath);
    const publicSettings = await store.getSettings();
    const runtimeSettings = await store.getRuntimeSettings();

    expect(publicSettings.engineeringTools.su2).toMatchObject({ enabled: true, command: su2Path });
    expect(publicSettings.engineeringTools.openVsp).toMatchObject({ enabled: true, command: openVspPath });
    expect(publicSettings.engineeringTools.xflr5).toMatchObject({ enabled: true, command: xflr5Path });
    expect(runtimeSettings.engineeringTools).toEqual(publicSettings.engineeringTools);
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
        toolchainRoot: join(tempRoot, "empty-openvsp-toolchain"),
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
        toolchainRoot: join(tempRoot, "empty-su2-toolchain"),
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
