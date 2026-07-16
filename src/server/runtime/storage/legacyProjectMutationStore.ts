import type { DatabaseSync } from "node:sqlite";
import { ResearchLoopStep, type ResearchProject, type ResearchSession, type ResearchSnapshot } from "../../../core/shared/types.js";
import {
  canonicalLegacyProjectMutationResult,
  legacyProjectMutationCommandHash,
  legacyProjectMutationReceiptHash,
  legacyProjectMutationResultHash,
  legacyProjectSnapshotHash
} from "./legacyProjectMutationHash.js";
import type {
  LegacyProjectMutationApplyResult,
  LegacyProjectMutationMethod,
  LegacyProjectMutationReceipt,
  LegacyProjectMutationReceiptQuery,
  LegacyProjectMutationRequest,
  LegacyProjectMutationResultIdentity
} from "./legacyProjectMutationTypes.js";
import { sanitizeProject } from "./sqliteStoreSupport.js";

interface MutationReceiptRow {
  operation_id: string;
  method: string;
  request_hash: string;
  command_hash: string;
  project_id: string;
  before_hash: string | null;
  snapshot_hash: string;
  result_json: string;
  result_hash: string;
  applied_at: string;
  receipt_hash: string;
}

export class LegacyProjectMutationConflictError extends Error {
  override readonly name = "LegacyProjectMutationConflictError";
}

export class LegacyProjectMutationDriftError extends Error {
  override readonly name = "LegacyProjectMutationDriftError";
}

export function applyLegacyProjectMutation(
  db: DatabaseSync,
  request: LegacyProjectMutationRequest,
  readSnapshot: (projectId: string) => ResearchSnapshot
): LegacyProjectMutationApplyResult {
  db.exec("begin immediate");
  try {
    validateRequest(request);
    const commandHash = legacyProjectMutationCommandHash(request);
    const stored = readLegacyProjectMutationReceipt(db, request.operationId);
    if (stored) {
      assertExactReplay(stored, request, commandHash);
      const snapshot = readSnapshot(request.projectId);
      if (legacyProjectSnapshotHash(snapshot) !== stored.snapshotHash) {
        throw new LegacyProjectMutationDriftError("Legacy project state advanced after the stored mutation receipt.");
      }
      db.exec("commit");
      return { snapshot, receipt: stored, exactReplay: true };
    }

    const projectExists = hasProject(db, request.projectId);
    const beforeSnapshot = projectExists ? readSnapshot(request.projectId) : undefined;
    const beforeHash = beforeSnapshot ? legacyProjectSnapshotHash(beforeSnapshot) : null;
    if (beforeHash !== request.expectedBeforeHash) {
      throw new LegacyProjectMutationDriftError("Legacy project mutation expected-before hash does not match durable state.");
    }

    const result = applyCommand(db, request, beforeSnapshot);
    const snapshot = readSnapshot(request.projectId);
    const receipt = createReceipt(request, commandHash, beforeHash, snapshot, result);
    insertReceipt(db, receipt);
    const readback = readLegacyProjectMutationReceipt(db, request.operationId);
    if (!readback || readback.receiptHash !== receipt.receiptHash) {
      throw new Error("Legacy project mutation receipt readback failed.");
    }
    db.exec("commit");
    return { snapshot, receipt: readback, exactReplay: false };
  } catch (error) {
    if (db.isTransaction) db.exec("rollback");
    throw error;
  }
}

export function readLegacyProjectMutationReceipt(db: DatabaseSync, operationId: string): LegacyProjectMutationReceipt | undefined {
  const id = requiredId(operationId, "operationId");
  const row = db.prepare("select * from legacy_project_mutation_receipts where operation_id = ?").get(id) as MutationReceiptRow | undefined;
  return row ? receiptFromRow(row) : undefined;
}

export function listLegacyProjectMutationReceipts(db: DatabaseSync, query: LegacyProjectMutationReceiptQuery = {}): LegacyProjectMutationReceipt[] {
  const value: unknown = query;
  if (!isRecord(value)) throw new Error("Legacy project mutation receipt query is invalid.");
  assertAllowedKeys(value, ["limit", "projectId"]);
  const limit = value.limit ?? 100;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Legacy project mutation receipt limit must be between 1 and 1000.");
  }
  const projectId = value.projectId === undefined ? undefined : requiredId(value.projectId, "projectId");
  const rows = projectId
    ? (db
        .prepare("select * from legacy_project_mutation_receipts where project_id = ? order by applied_at asc, operation_id asc limit ?")
        .all(projectId, limit) as unknown as MutationReceiptRow[])
    : (db
        .prepare("select * from legacy_project_mutation_receipts order by applied_at asc, operation_id asc limit ?")
        .all(limit) as unknown as MutationReceiptRow[]);
  return rows.map(receiptFromRow);
}

function applyCommand(db: DatabaseSync, request: LegacyProjectMutationRequest, before: ResearchSnapshot | undefined): LegacyProjectMutationResultIdentity {
  switch (request.method) {
    case "project.create": {
      if (before) throw new LegacyProjectMutationConflictError("Legacy project already exists.");
      const project = validatedProjectCommand(request);
      db.prepare("insert into projects (id, created_at, data) values (?, ?, ?)").run(project.id, project.createdAt, JSON.stringify(project));
      return { kind: "project", projectId: project.id };
    }
    case "project.update": {
      if (!before) throw new LegacyProjectMutationDriftError("Legacy project update requires an existing project.");
      const project = validatedProjectCommand(request);
      assertProjectIdentityStable(before.project, project);
      const result = db.prepare("update projects set data = ? where id = ?").run(JSON.stringify(project), project.id);
      if (Number(result.changes) !== 1) throw new LegacyProjectMutationDriftError("Legacy project disappeared during update.");
      return { kind: "project", projectId: project.id };
    }
    case "session.create": {
      if (!before) throw new LegacyProjectMutationDriftError("Legacy session creation requires an existing project.");
      const session = validatedSessionCommand(request);
      if (hasSession(db, request.projectId, session.id)) throw new LegacyProjectMutationConflictError("Legacy session already exists.");
      db.prepare("insert into sessions (id, project_id, created_at, data) values (?, ?, ?, ?)").run(
        session.id,
        session.projectId,
        session.createdAt,
        JSON.stringify(session)
      );
      return { kind: "session", projectId: request.projectId, sessionId: session.id, state: "created" };
    }
    case "session.delete": {
      if (!before) throw new LegacyProjectMutationDriftError("Legacy session deletion requires an existing project.");
      const sessionId = validatedDeleteCommand(request);
      const result = db.prepare("delete from sessions where project_id = ? and id = ?").run(request.projectId, sessionId);
      if (Number(result.changes) !== 1) throw new LegacyProjectMutationDriftError("Legacy session deletion target does not exist.");
      return { kind: "session", projectId: request.projectId, sessionId, state: "deleted" };
    }
  }
}

function createReceipt(
  request: LegacyProjectMutationRequest,
  commandHash: string,
  beforeHash: string | null,
  snapshot: ResearchSnapshot,
  result: LegacyProjectMutationResultIdentity
): LegacyProjectMutationReceipt {
  const resultJson = canonicalLegacyProjectMutationResult(result);
  const body: Omit<LegacyProjectMutationReceipt, "receiptHash"> = {
    operationId: request.operationId,
    method: request.method,
    requestHash: request.requestHash,
    commandHash,
    projectId: request.projectId,
    beforeHash,
    snapshotHash: legacyProjectSnapshotHash(snapshot),
    resultJson,
    resultHash: legacyProjectMutationResultHash(resultJson),
    appliedAt: request.appliedAt
  };
  return { ...body, receiptHash: legacyProjectMutationReceiptHash(body) };
}

function insertReceipt(db: DatabaseSync, receipt: LegacyProjectMutationReceipt): void {
  db.prepare(
    `insert into legacy_project_mutation_receipts
      (operation_id, method, request_hash, command_hash, project_id, before_hash, snapshot_hash, result_json, result_hash, applied_at, receipt_hash)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    receipt.operationId,
    receipt.method,
    receipt.requestHash,
    receipt.commandHash,
    receipt.projectId,
    receipt.beforeHash,
    receipt.snapshotHash,
    receipt.resultJson,
    receipt.resultHash,
    receipt.appliedAt,
    receipt.receiptHash
  );
}

function receiptFromRow(row: MutationReceiptRow): LegacyProjectMutationReceipt {
  const body: Omit<LegacyProjectMutationReceipt, "receiptHash"> = {
    operationId: requiredId(row.operation_id, "stored operationId"),
    method: requiredMethod(row.method),
    requestHash: requiredHash(row.request_hash, "stored requestHash"),
    commandHash: requiredHash(row.command_hash, "stored commandHash"),
    projectId: requiredId(row.project_id, "stored projectId"),
    beforeHash: optionalHash(row.before_hash, "stored beforeHash"),
    snapshotHash: requiredHash(row.snapshot_hash, "stored snapshotHash"),
    resultJson: row.result_json,
    resultHash: requiredHash(row.result_hash, "stored resultHash"),
    appliedAt: requiredTimestamp(row.applied_at, "stored appliedAt")
  };
  if (legacyProjectMutationResultHash(body.resultJson) !== body.resultHash) throw new Error("Legacy project mutation result hash verification failed.");
  validateResultIdentity(body);
  const receiptHash = requiredHash(row.receipt_hash, "stored receiptHash");
  if (legacyProjectMutationReceiptHash(body) !== receiptHash) throw new Error("Legacy project mutation receipt hash verification failed.");
  return { ...body, receiptHash };
}

function assertExactReplay(receipt: LegacyProjectMutationReceipt, request: LegacyProjectMutationRequest, commandHash: string): void {
  if (
    receipt.requestHash !== request.requestHash ||
    receipt.commandHash !== commandHash ||
    receipt.method !== request.method ||
    receipt.projectId !== request.projectId ||
    receipt.beforeHash !== request.expectedBeforeHash ||
    receipt.appliedAt !== request.appliedAt
  ) {
    throw new LegacyProjectMutationConflictError("Legacy project mutation operationId was reused with divergent content.");
  }
}

function validateResultIdentity(receipt: Omit<LegacyProjectMutationReceipt, "receiptHash">): void {
  const result = JSON.parse(receipt.resultJson) as unknown;
  if (!isRecord(result) || result.projectId !== receipt.projectId) throw new Error("Legacy project mutation result identity is invalid.");
  const projectMethod = receipt.method === "project.create" || receipt.method === "project.update";
  if (projectMethod && (result.kind !== "project" || Object.keys(result).sort().join("\u0000") !== "kind\u0000projectId")) {
    throw new Error("Legacy project mutation project result identity is invalid.");
  }
  if (!projectMethod) {
    const expectedState = receipt.method === "session.create" ? "created" : "deleted";
    if (
      result.kind !== "session" ||
      result.state !== expectedState ||
      typeof result.sessionId !== "string" ||
      Object.keys(result).sort().join("\u0000") !== "kind\u0000projectId\u0000sessionId\u0000state"
    ) {
      throw new Error("Legacy project mutation session result identity is invalid.");
    }
  }
}

function validateRequest(request: LegacyProjectMutationRequest): void {
  assertExactKeys(request, ["appliedAt", "command", "expectedBeforeHash", "method", "operationId", "projectId", "requestHash"]);
  requiredId(request.operationId, "operationId");
  requiredMethod(request.method);
  requiredHash(request.requestHash, "requestHash");
  requiredId(request.projectId, "projectId");
  optionalHash(request.expectedBeforeHash, "expectedBeforeHash");
  requiredTimestamp(request.appliedAt, "appliedAt");
  legacyProjectMutationCommandHash(request);
}

function validatedProjectCommand(request: LegacyProjectMutationRequest): ResearchProject {
  assertExactKeys(request.command, ["project"]);
  const project = (request.command as { project?: ResearchProject }).project;
  if (!isRecord(project) || project.id !== request.projectId) throw new Error("Legacy project mutation command has an invalid project identity.");
  assertExactKeys(project, ["autonomyPolicy", "budget", "createdAt", "currentStep", "goal", "id", "projectRoot", "scope", "status", "topic", "updatedAt"]);
  for (const key of ["goal", "topic", "scope", "budget", "projectRoot"] as const) requiredString(project[key], `project.${key}`);
  requiredTimestamp(project.createdAt, "project.createdAt");
  requiredTimestamp(project.updatedAt, "project.updatedAt");
  if (!Object.values(ResearchLoopStep).includes(project.currentStep)) throw new Error("Legacy project mutation command has an invalid currentStep.");
  if (!new Set(["idle", "running", "paused", "aborted", "completed", "failed", "blocked"]).has(project.status)) {
    throw new Error("Legacy project mutation command has an invalid status.");
  }
  validateAutonomyPolicy(project.autonomyPolicy);
  return sanitizeProject(project);
}

function validatedSessionCommand(request: LegacyProjectMutationRequest): ResearchSession {
  assertExactKeys(request.command, ["session"]);
  const session = (request.command as { session?: ResearchSession }).session;
  if (!isRecord(session) || session.projectId !== request.projectId) throw new Error("Legacy session mutation command has an invalid project identity.");
  assertExactKeys(session, ["createdAt", "focus", "id", "projectId", "title"]);
  requiredId(session.id, "session.id");
  requiredString(session.title, "session.title");
  requiredString(session.focus, "session.focus");
  requiredTimestamp(session.createdAt, "session.createdAt");
  return session;
}

function validatedDeleteCommand(request: LegacyProjectMutationRequest): string {
  assertExactKeys(request.command, ["sessionId"]);
  return requiredId((request.command as { sessionId?: string }).sessionId, "sessionId");
}

function validateAutonomyPolicy(value: ResearchProject["autonomyPolicy"]): void {
  if (!isRecord(value)) throw new Error("Legacy project mutation command requires autonomyPolicy.");
  const allowed = ["allowAgent", "allowCodeExecution", "allowExternalSearch", "maxLoopIterations", "toolApproval"];
  assertAllowedKeys(value, allowed);
  if (!new Set(["manual", "suggested", "automatic"]).has(String(value.toolApproval))) throw new Error("Invalid project autonomy tool approval.");
  for (const key of ["allowCodeExecution", "allowExternalSearch"] as const)
    if (typeof value[key] !== "boolean") throw new Error(`Invalid project autonomy ${key}.`);
  if (value.allowAgent !== undefined && typeof value.allowAgent !== "boolean") throw new Error("Invalid project autonomy allowAgent.");
  if (value.maxLoopIterations !== undefined && (!Number.isSafeInteger(value.maxLoopIterations) || value.maxLoopIterations < 1)) {
    throw new Error("Invalid project autonomy maxLoopIterations.");
  }
}

function assertProjectIdentityStable(before: ResearchProject, after: ResearchProject): void {
  if (before.id !== after.id || before.createdAt !== after.createdAt || before.projectRoot !== after.projectRoot) {
    throw new LegacyProjectMutationConflictError("Legacy project update attempted to change immutable identity fields.");
  }
}

function hasProject(db: DatabaseSync, projectId: string): boolean {
  return Boolean(db.prepare("select 1 as present from projects where id = ?").get(projectId));
}

function hasSession(db: DatabaseSync, projectId: string, sessionId: string): boolean {
  return Boolean(db.prepare("select 1 as present from sessions where project_id = ? and id = ?").get(projectId, sessionId));
}

function requiredMethod(value: unknown): LegacyProjectMutationMethod {
  if (value !== "project.create" && value !== "project.update" && value !== "session.create" && value !== "session.delete") {
    throw new Error("Unsupported legacy project mutation method.");
  }
  return value;
}

function requiredHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Legacy project mutation ${label} must be a lowercase SHA-256 hash.`);
  return value;
}

function optionalHash(value: unknown, label: string): string | null {
  return value === null ? null : requiredHash(value, label);
}

function requiredTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`Legacy project mutation ${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || [...value].some(isControlCharacter)) {
    throw new Error(`Legacy project mutation ${label} is invalid.`);
  }
  return value;
}

function isControlCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code < 32 || code === 127;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Legacy project mutation ${label} is required.`);
  return value;
}

function assertExactKeys(value: unknown, expected: readonly string[]): void {
  if (!isRecord(value) || Object.keys(value).sort().join("\u0000") !== [...expected].sort().join("\u0000")) {
    throw new Error("Legacy project mutation command has unknown or missing fields.");
  }
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new Error("Legacy project mutation command has unknown fields.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
