import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEngineeringToolCommand } from "./engineeringToolchain.js";
import type { EngineeringProgramSettings } from "../../../core/shared/types.js";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

function settings(root: string, command = "xflr5"): EngineeringProgramSettings {
  return {
    enabled: true,
    toolchainRoot: root,
    xfoil: { enabled: false, command: "", timeoutMs: 30_000 },
    modeling: { enabled: false, artifactRoot: "", maxMeshBytes: 20 * 1024 * 1024 },
    su2: {
      enabled: false,
      command: "",
      caseRoot: "",
      configFile: "",
      workingDirectory: "",
      probeArgs: ["--help"],
      runArgsTemplate: ["{config}"],
      timeoutMs: 30 * 60_000
    },
    openVsp: {
      enabled: false,
      command: "vspscript",
      scriptPath: "",
      workingDirectory: "",
      probeArgs: ["-help"],
      runArgsTemplate: ["-script", "{script}", "-spec", "{spec}", "-output", "{output}"],
      timeoutMs: 30 * 60_000
    },
    xflr5: {
      enabled: true,
      command,
      scriptPath: "",
      workingDirectory: "",
      probeArgs: ["--help"],
      runArgsTemplate: ["--script", "{script}", "--spec", "{spec}", "--output", "{output}"],
      timeoutMs: 30 * 60_000
    }
  };
}

describe("embedded engineering toolchain resolver", () => {
  it("resolves bare commands only from the embedded toolchain root", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-toolchain-"));
    const toolRoot = join(tempRoot, "vendor", "engineering-tools");
    const fakePathOnlyRoot = join(tempRoot, "path-only");
    mkdirSync(join(toolRoot, "xflr5", "bin"), { recursive: true });
    mkdirSync(fakePathOnlyRoot, { recursive: true });
    writeFileSync(join(toolRoot, "xflr5", "bin", "xflr5.exe"), "", "utf8");
    writeFileSync(join(fakePathOnlyRoot, "xflr5.exe"), "", "utf8");

    const resolved = resolveEngineeringToolCommand(settings(toolRoot), "xflr5", "xflr5");

    expect(resolved).toMatchObject({ tool: "xflr5", source: "embedded" });
    expect(resolved.command).toContain(join("xflr5", "bin", "xflr5.exe"));
    expect(resolved.command).not.toContain("path-only");
  });

  it("fails closed instead of falling back to PATH when the embedded executable is missing", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-toolchain-missing-"));
    const toolRoot = join(tempRoot, "vendor", "engineering-tools");
    mkdirSync(toolRoot, { recursive: true });

    expect(() => resolveEngineeringToolCommand(settings(toolRoot), "xflr5", "xflr5")).toThrow(/does not use PATH fallback/);
  });

  it("allows an explicit executable path as a custom override", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-toolchain-custom-"));
    const customPath = join(tempRoot, "custom-xflr5.exe");
    writeFileSync(customPath, "", "utf8");

    expect(resolveEngineeringToolCommand(settings(join(tempRoot, "empty"), customPath), "xflr5", customPath)).toMatchObject({
      command: customPath,
      source: "custom"
    });
  });

  it("prefers headless OpenVSP script executables over GUI launchers in the same folder", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "aetherops-toolchain-openvsp-"));
    const toolRoot = join(tempRoot, "vendor", "engineering-tools");
    const binRoot = join(toolRoot, "openvsp");
    mkdirSync(binRoot, { recursive: true });
    writeFileSync(join(binRoot, "vsp.exe"), "", "utf8");
    writeFileSync(join(binRoot, "vspscript.exe"), "", "utf8");

    const resolved = resolveEngineeringToolCommand(settings(toolRoot, "vspscript"), "openvsp", "vspscript");

    expect(resolved.command).toContain("vspscript.exe");
  });
});
