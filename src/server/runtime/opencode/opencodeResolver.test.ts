import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOpenCodeCommand } from "./opencodeResolver.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("resolveOpenCodeCommand", () => {
  it("uses the bundled opencode-ai binary when no command is configured", () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-opencode-"));
    const bundledPath =
      process.platform === "win32" ? join(tempDir, "node_modules", "opencode-ai", "bin", "opencode.exe") : join(tempDir, "node_modules", ".bin", "opencode");
    mkdirSync(join(bundledPath, ".."), { recursive: true });
    writeFileSync(bundledPath, "", "utf8");

    const resolution = resolveOpenCodeCommand(undefined, { searchRoots: [tempDir] });

    expect(resolution.source).toBe("bundled");
    expect(resolution.command).toBe(bundledPath);
    expect(basename(resolution.command).toLowerCase()).toContain("opencode");
  });

  it("uses the bundled opencode-ai binary for the default opencode command", () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-opencode-"));
    const bundledPath =
      process.platform === "win32" ? join(tempDir, "node_modules", "opencode-ai", "bin", "opencode.exe") : join(tempDir, "node_modules", ".bin", "opencode");
    mkdirSync(join(bundledPath, ".."), { recursive: true });
    writeFileSync(bundledPath, "", "utf8");

    const resolution = resolveOpenCodeCommand("opencode", { searchRoots: [tempDir] });

    expect(resolution.source).toBe("bundled");
    expect(resolution.command).toBe(bundledPath);
    expect(basename(resolution.command).toLowerCase()).toContain("opencode");
  });

  it("keeps an explicit custom command under user control", () => {
    const resolution = resolveOpenCodeCommand("C:\\Tools\\opencode-custom.exe", { searchRoots: [] });

    expect(resolution.source).toBe("configured");
    expect(resolution.command).toBe("C:\\Tools\\opencode-custom.exe");
  });
});
