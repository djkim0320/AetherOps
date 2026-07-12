import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ResearchToolResult, ToolExecutionJournal, ToolExecutionStatusEvent } from "../../../core/tools/researchToolTypes.js";

interface WorkspaceExecution {
  root: string;
  manifest: WorkspaceManifest;
}

interface WorkspaceManifest {
  executionId: string;
  projectId: string;
  jobId?: string;
  iteration: number;
  actionCount: number;
  status: "running" | "completed" | "quarantined";
  startedAt: string;
  completedAt?: string;
  error?: string;
  actions: WorkspaceAction[];
}

interface WorkspaceAction {
  attemptId: string;
  decisionId: string;
  ordinal: number;
  phase: string;
  toolName: string;
  status: string;
  occurredAt: string;
  inputHash: string;
  outputHash?: string;
  outputIds?: string[];
  error?: string;
}

export class FileToolExecutionWorkspace implements ToolExecutionJournal {
  private readonly active = new Map<string, WorkspaceExecution>();
  private readonly preparedQuarantine = new Map<string, string>();

  constructor(private readonly dataRoot: string) {}

  async beginExecution(input: {
    executionId: string;
    projectId: string;
    jobId?: string;
    iteration: number;
    actionCount: number;
    startedAt: string;
  }): Promise<void> {
    const root = this.executionRoot("staging", input.jobId, input.executionId);
    await rm(root, { recursive: true, force: true });
    await mkdir(join(root, "actions"), { recursive: true });
    const manifest: WorkspaceManifest = { ...input, status: "running", actions: [] };
    this.active.set(input.executionId, { root, manifest });
    await writeJsonAtomic(join(root, "manifest.json"), manifest);
  }

  async record(event: ToolExecutionStatusEvent, result?: ResearchToolResult): Promise<void> {
    const executionId = executionIdFromAttempt(event.attemptId);
    const execution = this.requiredExecution(executionId);
    const action: WorkspaceAction = {
      attemptId: event.attemptId,
      decisionId: event.decisionId,
      ordinal: event.ordinal,
      phase: event.phase,
      toolName: event.toolName,
      status: event.status,
      occurredAt: event.occurredAt,
      inputHash: hashJson(event.inputs),
      ...(result ? { outputHash: hashJson(result), outputIds: collectOutputIds(result) } : {}),
      ...(event.error ? { error: event.error } : {})
    };
    const previous = execution.manifest.actions.findIndex((item) => item.attemptId === event.attemptId);
    if (previous >= 0) execution.manifest.actions[previous] = action;
    else execution.manifest.actions.push(action);
    execution.manifest.actions.sort((left, right) => left.ordinal - right.ordinal);
    const actionRoot = join(execution.root, "actions", safeSegment(event.decisionId));
    await mkdir(actionRoot, { recursive: true });
    await writeJsonAtomic(join(actionRoot, "status.json"), action);
    await writeJsonAtomic(join(execution.root, "manifest.json"), execution.manifest);
  }

  async completeExecution(executionId: string, completedAt: string): Promise<void> {
    const execution = this.requiredExecution(executionId);
    execution.manifest.status = "completed";
    execution.manifest.completedAt = completedAt;
    await writeJsonAtomic(join(execution.root, "manifest.json"), execution.manifest);
    const readyRoot = this.executionRoot("ready", execution.manifest.jobId, executionId);
    await mkdir(dirname(readyRoot), { recursive: true });
    await rm(readyRoot, { recursive: true, force: true });
    await rename(execution.root, readyRoot);
    this.active.delete(executionId);
  }

  async quarantineExecution(executionId: string, reason: string, completedAt: string): Promise<string | undefined> {
    await this.prepareQuarantine(executionId, reason, completedAt);
    return this.commitQuarantine(executionId);
  }

  async prepareQuarantine(executionId: string, reason: string, completedAt: string): Promise<string | undefined> {
    const execution = this.active.get(executionId);
    if (!execution) return undefined;
    execution.manifest.status = "quarantined";
    execution.manifest.completedAt = completedAt;
    execution.manifest.error = reason;
    await writeJsonAtomic(join(execution.root, "manifest.json"), execution.manifest);
    const quarantineRoot = this.executionRoot("quarantine", execution.manifest.jobId, executionId);
    await mkdir(dirname(quarantineRoot), { recursive: true });
    await rm(quarantineRoot, { recursive: true, force: true });
    this.preparedQuarantine.set(executionId, quarantineRoot);
    return quarantineRoot;
  }

  async commitQuarantine(executionId: string): Promise<string | undefined> {
    const execution = this.active.get(executionId);
    const quarantineRoot = this.preparedQuarantine.get(executionId);
    if (!execution || !quarantineRoot) return undefined;
    await rename(execution.root, quarantineRoot);
    this.active.delete(executionId);
    this.preparedQuarantine.delete(executionId);
    return quarantineRoot;
  }

  actionWorkspace(executionId: string, actionId: string): string | undefined {
    const execution = this.active.get(executionId);
    return execution ? join(execution.root, "actions", safeSegment(actionId)) : undefined;
  }

  private executionRoot(kind: "staging" | "ready" | "quarantine", jobId: string | undefined, executionId: string): string {
    return resolve(this.dataRoot, kind, "jobs", safeSegment(jobId ?? "standalone"), safeSegment(executionId));
  }

  private requiredExecution(executionId: string): WorkspaceExecution {
    const execution = this.active.get(executionId);
    if (!execution) throw new Error(`Tool execution workspace is not active: ${executionId}`);
    return execution;
  }
}

function executionIdFromAttempt(attemptId: string): string {
  const separator = attemptId.lastIndexOf(":");
  if (separator <= 0) throw new Error(`Invalid tool attempt id: ${attemptId}`);
  return attemptId.slice(0, separator);
}

function collectOutputIds(result: ResearchToolResult): string[] {
  return [result.toolRun.id, ...result.sources.map((item) => item.id), ...result.evidence.map((item) => item.id), ...result.artifacts.map((item) => item.id)];
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error("Invalid tool execution workspace identifier.");
  return safe;
}

function hashJson(value: unknown): string {
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

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  await rename(temporary, path);
}
