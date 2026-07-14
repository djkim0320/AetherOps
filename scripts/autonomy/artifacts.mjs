import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { assertSanitizedArtifact, sanitizeAutonomyArtifact } from "./sanitize.mjs";

export function createArtifactWriter(outputRoot) {
  const root = resolve(outputRoot);
  mkdirSync(root, { recursive: true });
  const written = new Set();
  return {
    root,
    json(path, value) {
      const sanitized = sanitizeAutonomyArtifact(value);
      assertSanitizedArtifact(sanitized);
      return write(path, `${JSON.stringify(sanitized, null, 2)}\n`);
    },
    jsonl(path, values) {
      const lines = values.map((value) => {
        const sanitized = sanitizeAutonomyArtifact(value);
        assertSanitizedArtifact(sanitized);
        return JSON.stringify(sanitized);
      });
      return write(path, `${lines.join("\n")}${lines.length ? "\n" : ""}`);
    },
    text(path, value) {
      const sanitized = sanitizeAutonomyArtifact(String(value));
      assertSanitizedArtifact(sanitized);
      return write(path, sanitized);
    },
    manifest(metadata = {}) {
      const entries = [...written].sort().map((path) => ({ path, sha256: sha256File(join(root, path)), bytes: readFileSync(join(root, path)).byteLength }));
      const manifest = sanitizeAutonomyArtifact({ schemaVersion: 1, generatedAt: new Date().toISOString(), ...metadata, files: entries });
      writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      return manifest;
    }
  };

  function write(path, contents) {
    const target = resolve(root, path);
    const relativePath = relative(root, target).replace(/\\/g, "/");
    if (!relativePath || relativePath.startsWith("../") || relativePath === "..") throw new Error(`Artifact path escapes output root: ${path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
    written.add(relativePath);
    return target;
  }
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function defaultAutonomyOutputRoot(repoRoot, profile) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(repoRoot, ".tmp", "autonomy-verify", `${profile}-${stamp}-${process.pid}`);
}
