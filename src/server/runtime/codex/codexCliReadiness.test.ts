import { describe, expect, it } from "vitest";
import { CodexCliError } from "./codexCliErrors.js";
import { assertCodexCliReadiness, probeCodexCliReadiness } from "./codexCliReadiness.js";
import { permissionProfileArgs } from "./codexPermissionProfiles.js";

const resolution = { command: "codex-test", argsPrefix: [], packageRoot: "C:/codex", version: "0.144.1" };

describe("Codex CLI readiness", () => {
  it("requires the elevated Windows sandbox and a network-disabled profile", async () => {
    let captured: string[] = [];
    const result = await probeCodexCliReadiness({
      platform: "win32",
      resolution,
      cwd: "C:/workspace",
      execute: async (_command, args) => {
        captured = args;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });
    expect(result).toMatchObject({ ready: true, status: "ready", sandboxMode: "elevated", networkPolicy: "disabled" });
    expect(captured).toContain('windows.sandbox="elevated"');
    expect(captured).toContain("sandbox");
    expect(captured.join(" ")).toContain("network={enabled=false}");
  });

  it("reports an unenforceable profile as blocked without fallback", async () => {
    const result = await probeCodexCliReadiness({
      platform: "win32",
      resolution,
      cwd: "C:/workspace",
      execute: async () => ({ exitCode: 1, stdout: "", stderr: "permission profile is unsupported" })
    });
    expect(result).toMatchObject({ ready: false, status: "permission_profile_invalid", sandboxMode: "elevated" });
    await expect(
      assertCodexCliReadiness({
        platform: "win32",
        resolution,
        cwd: "C:/workspace",
        execute: async () => ({ exitCode: 1, stdout: "", stderr: "permission profile is unsupported" })
      })
    ).rejects.toMatchObject<CodexCliError>({ kind: "NOT_READY" });
  });

  it("uses one valid inline TOML profile instead of fragmented invalid fields", () => {
    const args = permissionProfileArgs({ mode: "workspace", inputsDirectoryName: "inputs", outputsDirectoryName: "outputs" }, "win32");
    const profile = args.find((item) => item.startsWith("permissions.aetherops-workspace="));
    expect(profile).toContain('filesystem={":root"="deny"');
    expect(profile).toContain('"outputs"="write"');
    expect(args).not.toContain('permissions.aetherops-workspace.filesystem.":root"="deny"');
  });
});
