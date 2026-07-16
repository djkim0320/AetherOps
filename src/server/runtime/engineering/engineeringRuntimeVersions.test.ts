import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_WEBXFOIL_RUNTIME, BUNDLED_WEBXFOIL_VERSION } from "./engineeringRuntimeVersions.js";

describe("bundled engineering runtime versions", () => {
  it("binds the WebXFOIL receipt version to the exact manifest, lockfile, and installed package identity", () => {
    const root = process.cwd();
    const manifest = json(resolve(root, "package.json")) as { dependencies?: Record<string, string> };
    const lock = json(resolve(root, "package-lock.json")) as {
      packages?: Record<string, { version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string> }>;
    };
    const installed = json(resolve(root, "node_modules", BUNDLED_WEBXFOIL_RUNTIME, "package.json")) as {
      name?: string;
      version?: string;
    };
    const rootLock = lock.packages?.[""];
    const packageLock = lock.packages?.[`node_modules/${BUNDLED_WEBXFOIL_RUNTIME}`];

    expect(BUNDLED_WEBXFOIL_RUNTIME).toBe("webxfoil-wasm");
    expect(manifest.dependencies?.[BUNDLED_WEBXFOIL_RUNTIME]).toBe(BUNDLED_WEBXFOIL_VERSION);
    expect(rootLock?.dependencies?.[BUNDLED_WEBXFOIL_RUNTIME]).toBe(BUNDLED_WEBXFOIL_VERSION);
    expect(packageLock).toMatchObject({
      version: BUNDLED_WEBXFOIL_VERSION,
      resolved: `https://registry.npmjs.org/${BUNDLED_WEBXFOIL_RUNTIME}/-/${BUNDLED_WEBXFOIL_RUNTIME}-${BUNDLED_WEBXFOIL_VERSION}.tgz`
    });
    expect(packageLock?.integrity).toMatch(/^sha512-/);
    expect(installed).toMatchObject({ name: BUNDLED_WEBXFOIL_RUNTIME, version: BUNDLED_WEBXFOIL_VERSION });
  });
});

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
