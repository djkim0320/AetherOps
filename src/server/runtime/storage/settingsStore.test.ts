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
            su2: { enabled: false, command: "", caseRoot: "", configFile: "", workingDirectory: "", probeArgs: ["--help"], runArgsTemplate: ["{config}"], timeoutMs: 60_000 },
            openVsp: { enabled: false, command: "", scriptPath: "", workingDirectory: "", probeArgs: ["-help"], runArgsTemplate: ["-script", "{script}", "-spec", "{spec}", "-output", "{output}"], timeoutMs: 60_000 },
            xflr5: { enabled: false, command: "", scriptPath: "", workingDirectory: "", probeArgs: ["--help"], runArgsTemplate: ["--script", "{script}", "--spec", "{spec}", "--output", "{output}"], timeoutMs: 60_000 }
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
