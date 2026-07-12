import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CodexCliInputArtifact, CodexCliTaskInput } from "./codexCliTypes.js";

export interface PreparedCodexWorkspace {
  actionRoot: string;
  workspaceRoot: string;
  inputsRoot: string;
  outputsRoot: string;
  controlRoot: string;
  schemaPath: string;
  resultPath: string;
  permissionProfilePath: string;
  inputManifestHash: string;
  inputFiles: Array<{ id: string; relativePath: string; sha256: string; bytes: number }>;
}

export interface ValidatedCodexOutput {
  outputManifestHash: string;
  outputs: Array<{ relativePath: string; kind: "code" | "report" | "data"; absolutePath: string; sha256: string; bytes: number }>;
}

export async function prepareCodexWorkspace(
  actionRoot: string,
  task: CodexCliTaskInput,
  availableArtifacts: CodexCliInputArtifact[],
  runtimeReadRoots: string[]
): Promise<PreparedCodexWorkspace> {
  validateTask(task);
  const root = resolve(actionRoot);
  const workspaceRoot = join(root, "workspace");
  const inputsRoot = join(workspaceRoot, "inputs");
  const outputsRoot = join(workspaceRoot, "outputs");
  const controlRoot = join(root, "control");
  await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(controlRoot, { recursive: true, force: true })]);
  await Promise.all([mkdir(inputsRoot, { recursive: true }), mkdir(outputsRoot, { recursive: true }), mkdir(controlRoot, { recursive: true })]);

  const byId = new Map(availableArtifacts.map((item) => [item.id, item]));
  const inputFiles: PreparedCodexWorkspace["inputFiles"] = [];
  for (const id of task.inputArtifactIds) {
    const source = byId.get(id);
    if (!source) throw new Error(`Codex CLI input artifact is unavailable: ${id}`);
    const sourceStat = await lstat(source.sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`Codex CLI input artifact must be a regular file: ${id}`);
    const actualHash = await hashFile(source.sourcePath);
    if (actualHash !== source.sha256) throw new Error(`Codex CLI input artifact hash mismatch: ${id}`);
    const targetRelativePath = `${safeSegment(id)}/${basename(source.sourcePath)}`.replaceAll("\\", "/");
    const target = resolveWithin(inputsRoot, targetRelativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source.sourcePath, target);
    inputFiles.push({ id, relativePath: targetRelativePath, sha256: actualHash, bytes: sourceStat.size });
  }
  inputFiles.sort((left, right) => left.id.localeCompare(right.id));
  const inputManifestHash = hashCanonical(inputFiles);
  const schemaPath = join(controlRoot, "result.schema.json");
  const resultPath = join(controlRoot, "result.json");
  const permissionProfilePath = join(controlRoot, "permission-profile.json");
  await writeJson(schemaPath, resultSchema(task));
  await writeJson(
    permissionProfilePath,
    permissionProfile({ workspaceRoot, inputsRoot, outputsRoot, controlRoot, runtimeReadRoots: runtimeReadRoots.map((item) => resolve(item)) })
  );
  await writeJson(join(controlRoot, "workspace-manifest.json"), {
    version: 1,
    networkPolicy: "disabled",
    inputManifestHash,
    inputs: inputFiles,
    outputs: task.outputs
  });
  return {
    actionRoot: root,
    workspaceRoot,
    inputsRoot,
    outputsRoot,
    controlRoot,
    schemaPath,
    resultPath,
    permissionProfilePath,
    inputManifestHash,
    inputFiles
  };
}

export async function validateCodexWorkspace(
  prepared: PreparedCodexWorkspace,
  task: CodexCliTaskInput,
  result: { summary: string; outputs: Array<{ relativePath: string; kind: "code" | "report" | "data" }> }
): Promise<ValidatedCodexOutput> {
  const currentInputs = await fileManifest(prepared.inputsRoot);
  const expectedInputs = prepared.inputFiles.map(({ relativePath, sha256, bytes }) => ({ relativePath, sha256, bytes }));
  if (hashCanonical(currentInputs) !== hashCanonical(expectedInputs)) throw new Error("Codex CLI modified or removed an input artifact.");
  const requested = canonicalOutputDeclarations(task.outputs);
  const declared = canonicalOutputDeclarations(result.outputs);
  if (hashCanonical(requested) !== hashCanonical(declared)) throw new Error("Codex CLI final JSON does not exactly match the requested output contract.");
  const actualFiles = await fileManifest(prepared.outputsRoot);
  const actualPaths = actualFiles.map((item) => item.relativePath).sort();
  const requestedPaths = requested.map((item) => item.relativePath).sort();
  if (hashCanonical(actualPaths) !== hashCanonical(requestedPaths)) throw new Error("Codex CLI created missing, undeclared, or additional output files.");
  const outputByPath = new Map(actualFiles.map((item) => [item.relativePath, item]));
  const outputs = requested.map((item) => {
    const file = outputByPath.get(item.relativePath);
    if (!file) throw new Error(`Codex CLI output is missing: ${item.relativePath}`);
    return { ...item, absolutePath: resolveWithin(prepared.outputsRoot, item.relativePath), sha256: file.sha256, bytes: file.bytes };
  });
  return {
    outputs,
    outputManifestHash: hashCanonical(outputs.map((item) => ({ relativePath: item.relativePath, kind: item.kind, sha256: item.sha256, bytes: item.bytes })))
  };
}

export function workspaceManifestHash(prepared: PreparedCodexWorkspace, task: CodexCliTaskInput): string {
  return hashCanonical({ version: 1, networkPolicy: "disabled", inputManifestHash: prepared.inputManifestHash, outputs: task.outputs });
}

function validateTask(task: CodexCliTaskInput): void {
  if (!task.task.trim()) throw new Error("Codex CLI task must not be empty.");
  if (new Set(task.inputArtifactIds).size !== task.inputArtifactIds.length) throw new Error("Codex CLI input artifact IDs must be unique.");
  if (!task.outputs.length) throw new Error("Codex CLI task must declare at least one output.");
  canonicalOutputDeclarations(task.outputs);
}

function canonicalOutputDeclarations(outputs: CodexCliTaskInput["outputs"]): CodexCliTaskInput["outputs"] {
  const normalized = outputs.map((item) => ({ relativePath: normalizeRelativePath(item.relativePath), kind: item.kind }));
  if (new Set(normalized.map((item) => item.relativePath.toLowerCase())).size !== normalized.length) {
    throw new Error("Codex CLI output paths must be unique.");
  }
  return normalized.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || isAbsolute(normalized) || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid Codex CLI output path: ${value}`);
  }
  return normalized;
}

async function fileManifest(root: string): Promise<Array<{ relativePath: string; sha256: string; bytes: number }>> {
  const files: Array<{ relativePath: string; sha256: string; bytes: number }> = [];
  await walk(root, root, files);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function walk(root: string, current: string, files: Array<{ relativePath: string; sha256: string; bytes: number }>): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Codex CLI workspace contains a symbolic link: ${relative(root, path)}`);
    if (stat.isDirectory()) await walk(root, path, files);
    else if (stat.isFile()) files.push({ relativePath: relative(root, path).split(sep).join("/"), sha256: await hashFile(path), bytes: stat.size });
    else throw new Error(`Codex CLI workspace contains an unsupported filesystem entry: ${relative(root, path)}`);
  }
}

function resultSchema(task: CodexCliTaskInput): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["summary", "outputs"],
    properties: {
      summary: { type: "string", minLength: 1, maxLength: 4_000 },
      outputs: {
        type: "array",
        minItems: task.outputs.length,
        maxItems: task.outputs.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["relativePath", "kind"],
          properties: {
            relativePath: { type: "string", enum: task.outputs.map((item) => normalizeRelativePath(item.relativePath)) },
            kind: { type: "string", enum: ["code", "report", "data"] }
          }
        }
      }
    }
  };
}

function permissionProfile(input: {
  workspaceRoot: string;
  inputsRoot: string;
  outputsRoot: string;
  controlRoot: string;
  runtimeReadRoots: string[];
}): Record<string, unknown> {
  return {
    version: 1,
    name: "aetherops-codex-workspace-v1",
    filesystem: {
      default: "deny",
      read: [input.workspaceRoot, ...input.runtimeReadRoots],
      write: [input.outputsRoot],
      deny: ["**/.env", "**/.env.*"]
    },
    network: { mode: "disabled" },
    process: { workingDirectory: input.workspaceRoot, inheritEnvironment: false },
    inputs: { root: input.inputsRoot, mode: "read-only" }
  };
}

function resolveWithin(root: string, relativePath: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, relativePath);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) throw new Error("Codex CLI path escapes its workspace.");
  return target;
}

function safeSegment(value: string): string {
  const result = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!result || result === "." || result === "..") throw new Error(`Invalid Codex CLI artifact ID: ${value}`);
  return result;
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
