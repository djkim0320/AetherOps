import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { StorageV2RepositorySet } from "./repositories.js";
import type { StorageToolPostconditionVerifyInput, StorageToolPostconditionVerifyResult } from "./jobAtomicTypes.js";
import { assertVerifiedToolPostcondition, computeToolPostconditionReceiptHash, toolAttemptRequiresVerifiedPostcondition } from "./toolPostcondition.js";
import type { StorageCodexCliExecution, StorageToolAttempt, StorageToolDecision, StorageToolOutputLink } from "./traceTypes.js";

const MAX_STATUS_BYTES = 1_048_576;
const MAX_OUTPUT_FILES = 256;
const MAX_OUTPUT_BYTES = 100_000_000;

export function verifyToolPostcondition(
  repositories: StorageV2RepositorySet,
  input: StorageToolPostconditionVerifyInput,
  dataRoot: string | undefined
): StorageToolPostconditionVerifyResult {
  const job = repositories.jobs.assertFence(input.fence, ["running"]);
  const attempt = repositories.trace.getToolAttempt(input.attemptId);
  if (!attempt || attempt.projectId !== job.projectId || attempt.jobId !== job.id)
    throw new Error("Tool postcondition attempt does not belong to the fenced job.");
  if (attempt.postconditionReceipt) {
    assertVerifiedToolPostcondition(attempt);
    return { attempt };
  }
  if (attempt.status !== "completed" || !attempt.outputHash || !attempt.completedAt) {
    throw new Error("Tool postcondition verification requires a completed attempt with an output hash.");
  }
  if (!toolAttemptRequiresVerifiedPostcondition(attempt)) throw new Error("Tool attempt does not require a mutating postcondition receipt.");
  if (!dataRoot) throw new Error("Storage worker has no configured data root for workspace postcondition verification.");
  if (!Number.isFinite(Date.parse(input.verifiedAt)) || Date.parse(input.verifiedAt) < Date.parse(attempt.completedAt)) {
    throw new Error("Tool postcondition verification time precedes attempt completion.");
  }
  const decision = repositories.trace.getToolDecision(attempt.decisionId);
  if (!decision || decision.projectId !== job.projectId || decision.jobId !== job.id) throw new Error("Tool postcondition decision linkage is missing.");
  const links = repositories.trace.listOutputLinks(attempt.id, 1_000);
  if (links.length >= 1_000) throw new Error("Tool postcondition output linkage exceeds its bounded verification window.");
  const workspace = verifyWorkspace(dataRoot, attempt, decision, links);
  const codex = decision.toolName === "CodexCliTool" ? verifyCodexWorkspace(repositories, attempt, decision, workspace.actionRoot) : undefined;
  const evidenceHash = hashCanonical({
    version: 1,
    projectId: job.projectId,
    jobId: job.id,
    attemptId: attempt.id,
    inputHash: attempt.inputHash,
    outputHash: attempt.outputHash,
    statusHash: workspace.statusHash,
    outputLinks: links.map(linkIdentity).sort(compareCanonical),
    ...(codex ? { codex } : {})
  });
  const receiptId = `postcondition:${hashCanonical({ attemptId: attempt.id, evidenceHash }).slice(0, 48)}`;
  const verifier = codex ? "storage-worker-codex-workspace-v1" : "storage-worker-action-workspace-v1";
  const receiptHash = computeToolPostconditionReceiptHash({
    attemptId: attempt.id,
    descriptorVersion: attempt.descriptorVersion,
    idempotencyKey: required(attempt.idempotencyKey, "Tool attempt idempotency key"),
    sideEffectKey: required(attempt.sideEffectKey, "Tool attempt side-effect key"),
    disposition: "applied",
    receiptId,
    evidenceHash,
    verifier,
    verifiedAt: input.verifiedAt
  });
  const attemptData = object(attempt.data, "tool attempt data");
  const accounting = object(attemptData.accounting, "tool attempt accounting");
  const verified = repositories.trace.saveToolAttempt({
    ...attempt,
    data: {
      ...attemptData,
      accounting: {
        ...accounting,
        ...(codex ? { workspaceOutputBytes: codex.outputBytes, workspaceSource: "verified_codex_output_manifest_v1" } : {})
      }
    },
    postconditionDisposition: "applied",
    postconditionReceipt: { receiptId, evidenceHash, receiptHash, verifier, verifiedAt: input.verifiedAt }
  });
  const event = repositories.events.append({
    projectId: job.projectId,
    jobId: job.id,
    type: "tool.run.changed",
    createdAt: input.verifiedAt,
    payload: {
      projectRevision: input.projectRevision,
      data: {
        jobId: job.id,
        decisionId: attempt.decisionId,
        attemptId: attempt.id,
        ordinal: attempt.ordinal,
        toolName: decision.toolName,
        status: attempt.status
      }
    }
  });
  return { attempt: verified, event };
}

function verifyWorkspace(
  dataRoot: string,
  attempt: StorageToolAttempt,
  decision: StorageToolDecision,
  links: StorageToolOutputLink[]
): { actionRoot: string; statusHash: string } {
  const actionRoot = requiredActionRoot(dataRoot, attempt);
  const statusPath = join(actionRoot, "status.json");
  if (!existsSync(statusPath)) throw new Error("Tool action status receipt is missing.");
  const statusStat = lstatSync(statusPath);
  if (!statusStat.isFile() || statusStat.isSymbolicLink() || statusStat.size > MAX_STATUS_BYTES)
    throw new Error("Tool action status receipt is not a bounded regular file.");
  const status = object(JSON.parse(readFileSync(statusPath, "utf8")), "tool action status receipt");
  const rawAttemptId = text(status.attemptId, "tool action attempt id");
  const rawDecisionId = text(status.decisionId, "tool action decision id");
  const outputIds = stringArray(status.outputIds, "tool action output IDs");
  const outputBytes = nonnegativeInteger(status.outputBytes, "tool action output bytes");
  const attemptAccounting = object(object(attempt.data, "tool attempt data").accounting, "tool attempt accounting");
  if (
    traceId("attempt", attempt.jobId, rawAttemptId) !== attempt.id ||
    traceId("decision", attempt.jobId, executionIdFromAttempt(rawAttemptId), rawDecisionId) !== attempt.decisionId ||
    status.status !== "completed" ||
    status.toolName !== decision.toolName ||
    status.inputHash !== attempt.inputHash ||
    status.outputHash !== attempt.outputHash ||
    outputBytes !== nonnegativeInteger(attemptAccounting.canonicalResultBytes, "canonical result bytes")
  ) {
    throw new Error("Tool action workspace status does not match its immutable attempt trace.");
  }
  const linkedIds = new Set(links.map((link) => link.outputId));
  if (linkedIds.size !== links.length || links.some((link) => link.promoted || !outputIds.includes(link.outputId)) || outputIds.length !== linkedIds.size + 1) {
    throw new Error("Tool action workspace outputs do not match the unpromoted output linkage set.");
  }
  return { actionRoot, statusHash: hashCanonical(status) };
}

function verifyCodexWorkspace(
  repositories: StorageV2RepositorySet,
  attempt: StorageToolAttempt,
  decision: StorageToolDecision,
  actionRoot: string
): { workspaceManifestHash: string; outputManifestHash: string; filesHash: string; outputBytes: number } {
  const traces = repositories.trace.listCodexCliExecutions(attempt.jobId, 1_000).filter((entry) => entry.attemptId === attempt.id);
  if (traces.length !== 1) throw new Error("Codex postcondition requires exactly one immutable CLI execution trace.");
  const trace = traces[0] as StorageCodexCliExecution;
  if (!trace.workspaceManifestHash || !trace.outputManifestHash || trace.networkPolicy !== "disabled") {
    throw new Error("Codex postcondition trace is missing offline workspace manifest hashes.");
  }
  const declarations = codexOutputDeclarations(decision);
  const outputsRoot = join(actionRoot, "workspace", "outputs");
  if (!existsSync(outputsRoot)) throw new Error("Tool output workspace is missing.");
  assertNoSymlinkPath(actionRoot, relative(actionRoot, outputsRoot));
  const files = fileManifest(outputsRoot);
  if (files.length !== declarations.length) throw new Error("Codex output file count no longer matches the compiled action contract.");
  const kinds = new Map(declarations.map((entry) => [entry.relativePath, entry.kind]));
  const manifest = files.map((file) => ({ ...file, kind: required(kinds.get(file.relativePath), `Codex output declaration ${file.relativePath}`) }));
  const outputManifestHash = hashCanonical(manifest.map(({ relativePath, kind, sha256, bytes }) => ({ relativePath, kind, sha256, bytes })));
  if (outputManifestHash !== trace.outputManifestHash) throw new Error("Codex output manifest changed after workspace validation.");
  return {
    workspaceManifestHash: trace.workspaceManifestHash,
    outputManifestHash,
    filesHash: hashCanonical(files),
    outputBytes: files.reduce((total, file) => total + file.bytes, 0)
  };
}

function requiredActionRoot(dataRoot: string, attempt: StorageToolAttempt): string {
  const stagingRef = required(attempt.stagingRef, "Tool attempt staging reference");
  const resolvedDataRoot = resolve(dataRoot);
  const allowedRoot = resolve(resolvedDataRoot, "staging", "jobs", safeSegment(attempt.jobId));
  const actionRoot = isAbsolute(stagingRef) ? resolve(stagingRef) : resolve(dataRoot, stagingRef);
  const path = relative(allowedRoot, actionRoot);
  if (!path || path.startsWith("..") || isAbsolute(path)) throw new Error("Tool attempt staging reference escapes the fenced job workspace.");
  if (!existsSync(actionRoot)) throw new Error("Tool action workspace is missing.");
  assertNoSymlinkPath(resolvedDataRoot, relative(resolvedDataRoot, actionRoot));
  return actionRoot;
}

function assertNoSymlinkPath(root: string, relativePath: string): void {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Tool action workspace root is not a regular directory.");
  let current = root;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("Tool action workspace path contains a symbolic link.");
  }
}

function fileManifest(root: string): Array<{ relativePath: string; sha256: string; bytes: number }> {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Tool output workspace root is not a regular directory.");
  const files: Array<{ relativePath: string; sha256: string; bytes: number }> = [];
  let totalBytes = 0;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("Tool output workspace contains a symbolic link.");
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        totalBytes += stat.size;
        if (files.length >= MAX_OUTPUT_FILES || totalBytes > MAX_OUTPUT_BYTES)
          throw new Error("Tool output workspace exceeds its bounded verification budget.");
        files.push({ relativePath: relative(root, path).split(sep).join("/"), sha256: hashBytes(readFileSync(path)), bytes: stat.size });
      } else throw new Error("Tool output workspace contains an unsupported filesystem entry.");
    }
  };
  walk(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function codexOutputDeclarations(decision: StorageToolDecision): Array<{ relativePath: string; kind: "code" | "report" | "data" }> {
  const compiled = object(decision.compiledAction, "compiled Codex action");
  if (!Array.isArray(compiled.outputDeclarations) || compiled.outputDeclarations.length < 1 || compiled.outputDeclarations.length > 8)
    throw new Error("Compiled Codex output declarations are unavailable.");
  const declarations = compiled.outputDeclarations.map((value) => {
    const item = object(value, "compiled Codex output declaration");
    const relativePath = text(item.relativePath, "Codex output relative path").replaceAll("\\", "/");
    const kind = item.kind;
    if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("Compiled Codex output path is unsafe.");
    }
    if (kind !== "code" && kind !== "report" && kind !== "data") throw new Error("Compiled Codex output kind is invalid.");
    return { relativePath, kind: kind as "code" | "report" | "data" };
  });
  declarations.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (new Set(declarations.map((entry) => entry.relativePath.toLowerCase())).size !== declarations.length) {
    throw new Error("Compiled Codex output paths are not unique.");
  }
  return declarations;
}

function linkIdentity(link: StorageToolOutputLink): Record<string, unknown> {
  return { id: link.id, kind: link.outputKind, outputId: link.outputId, createdAt: link.createdAt };
}

function compareCanonical(left: unknown, right: unknown): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 1_000 || value.some((entry) => typeof entry !== "string" || !entry)) throw new Error(`${label} are invalid.`);
  if (new Set(value).size !== value.length) throw new Error(`${label} are not unique.`);
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer.`);
  return value;
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined || value === "") throw new Error(`${label} is required.`);
  return value;
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error("Invalid workspace identifier.");
  return safe;
}

function traceId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}

function executionIdFromAttempt(attemptId: string): string {
  const separator = attemptId.lastIndexOf(":");
  if (separator <= 0) throw new Error("Tool action attempt ID is invalid.");
  return attemptId.slice(0, separator);
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
