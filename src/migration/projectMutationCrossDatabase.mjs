import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { sha256Hex, stableJsonHash } from "./hash.mjs";
import { inspectProjectMutationCommandEnvelope } from "./operationalProjectMutationSchema.mjs";

const JOURNAL_TABLE = "project_mutation_journal";
const RECEIPT_TABLE = "legacy_project_mutation_receipts";
const LEGACY_METHODS = new Map([
  ["projects.create", "project.create"],
  ["projects.update", "project.update"],
  ["sessions.create", "session.create"],
  ["sessions.delete", "session.delete"]
]);

export function inspectProjectMutationCrossDatabase(operationalPath, legacyPath) {
  const errors = [];
  const conflicts = [];
  const operational = openReadOnly(operationalPath);
  const legacy = openReadOnly(legacyPath);
  try {
    const hasJournal = operational ? tableExists(operational, JOURNAL_TABLE) : false;
    const hasReceipts = legacy ? tableExists(legacy, RECEIPT_TABLE) : false;
    if (!operational) errors.push("Operational project mutation database is missing.");
    else if (!hasJournal) errors.push("Operational project mutation journal is missing.");
    if (!legacy) errors.push("Legacy project mutation database is missing.");
    else if (!hasReceipts) errors.push("Legacy project mutation receipt table is missing.");

    const journals = hasJournal ? operational.prepare(`select * from ${JOURNAL_TABLE} order by operation_id`).all() : [];
    const receipts = hasReceipts ? legacy.prepare(`select * from ${RECEIPT_TABLE} order by operation_id`).all() : [];
    const journalsById = new Map(journals.map((row) => [String(row.operation_id), row]));
    const receiptsById = new Map(receipts.map((row) => [String(row.operation_id), row]));
    const matched = [];
    for (const journal of journals) {
      const operationId = String(journal.operation_id);
      const commandInspection = inspectProjectMutationCommandEnvelope(journal);
      if (commandInspection.reasons.length) {
        conflicts.push(`Operational project mutation command envelope is unrecoverable ${operationId}: ${commandInspection.reasons.join(", ")}`);
        continue;
      }
      const receipt = receiptsById.get(operationId);
      if (!receipt) {
        if (journal.state !== "prepared") conflicts.push(`Operational project mutation has no legacy receipt: ${operationId}`);
        else {
          const reasons = comparePreparedLegacyBase(legacy, journal, commandInspection.envelope);
          if (reasons.length) conflicts.push(`Prepared project mutation legacy precondition mismatch ${operationId}: ${reasons.join(", ")}`);
        }
        continue;
      }
      const reasons = compareMutationPair(journal, receipt, commandInspection.envelope);
      if (journal.state !== "finalized") reasons.push(...compareActiveLegacyReadback(legacy, journal, receipt));
      if (reasons.length) conflicts.push(`Project mutation cross-database mismatch ${operationId}: ${reasons.join(", ")}`);
      else matched.push(pairSummary(journal, receipt));
    }
    for (const receipt of receipts) {
      const operationId = String(receipt.operation_id);
      if (!journalsById.has(operationId)) conflicts.push(`Legacy project mutation receipt has no operational journal: ${operationId}`);
    }
    return {
      ready: errors.length === 0 && conflicts.length === 0,
      errors,
      conflicts,
      journalCount: journals.length,
      receiptCount: receipts.length,
      matchedCount: matched.length,
      readbackHash: stableJsonHash(matched)
    };
  } finally {
    operational?.close();
    legacy?.close();
  }
}

function compareMutationPair(journal, receipt, envelope) {
  const reasons = [];
  const expectedLegacyMethod = LEGACY_METHODS.get(String(journal.method));
  if (!envelope || !expectedLegacyMethod) return ["invalid command envelope"];
  if (envelope.legacyMethod !== expectedLegacyMethod || receipt.method !== expectedLegacyMethod) reasons.push("method");
  if (receipt.request_hash !== journal.request_hash) reasons.push("request hash");
  if (receipt.project_id !== journal.project_id) reasons.push("project identity");
  const expectedBeforeHash = envelope.expectedBeforeHash ?? runtimeHash(null);
  if (journal.legacy_before_hash !== expectedBeforeHash) reasons.push("journal before hash");
  if (receipt.before_hash !== envelope.expectedBeforeHash) reasons.push("receipt before hash");
  if (envelope.appliedAt !== journal.prepared_at || receipt.applied_at !== journal.prepared_at) reasons.push("applied timestamp");
  const commandHash = runtimeHash({
    method: envelope.legacyMethod,
    projectId: journal.project_id,
    expectedBeforeHash: envelope.expectedBeforeHash,
    command: envelope.command,
    appliedAt: envelope.appliedAt
  });
  if (receipt.command_hash !== commandHash) reasons.push("command hash");
  if (runtimeHash(envelope) !== journal.command_hash) reasons.push("command envelope hash");
  if (journal.state !== "prepared") {
    if (journal.legacy_receipt_hash !== receipt.receipt_hash) reasons.push("receipt hash");
    if (journal.legacy_snapshot_hash !== receipt.snapshot_hash) reasons.push("snapshot hash");
    if (journal.legacy_applied_at !== receipt.applied_at) reasons.push("legacy applied timestamp");
  }
  return reasons;
}

function pairSummary(journal, receipt) {
  return {
    operationId: journal.operation_id,
    state: journal.state,
    requestHash: journal.request_hash,
    commandHash: receipt.command_hash,
    receiptHash: receipt.receipt_hash,
    snapshotHash: receipt.snapshot_hash,
    appliedAt: receipt.applied_at
  };
}

function comparePreparedLegacyBase(legacy, journal, envelope) {
  if (!legacy || !tableExists(legacy, "projects") || !tableExists(legacy, "sessions")) return ["legacy project tables"];
  const state = readLegacyProjectState(legacy, journal.project_id);
  if (state === null) return ["legacy project readback"];
  if (journal.method === "projects.create") return state ? ["project already exists"] : [];
  if (!state) return ["project is missing"];
  const reasons = [];
  if (safeRuntimeHash(state) !== envelope.expectedBeforeHash) reasons.push("snapshot before hash");
  if (journal.method === "projects.update") {
    const project = envelope.command.project;
    if (project.createdAt !== state.project.createdAt || project.projectRoot !== state.project.projectRoot) reasons.push("immutable project identity");
  } else if (journal.method === "sessions.create") {
    if (state.sessions.some((session) => session.id === envelope.command.session.id)) reasons.push("session already exists");
  } else if (!state.sessions.some((session) => session.id === envelope.command.sessionId)) {
    reasons.push("session target is missing");
  }
  return reasons;
}

function compareActiveLegacyReadback(legacy, journal, receipt) {
  if (!legacy || !tableExists(legacy, "projects") || !tableExists(legacy, "sessions")) return ["legacy project tables"];
  const state = readLegacyProjectState(legacy, journal.project_id);
  if (!state) return ["legacy project readback"];
  return safeRuntimeHash(state) === receipt.snapshot_hash ? [] : ["legacy snapshot readback"];
}

function readLegacyProjectState(legacy, projectId) {
  try {
    const projectRow = legacy.prepare("select data from projects where id=?").get(projectId);
    if (!projectRow) return undefined;
    const project = parseObject(projectRow.data);
    if (!project) return null;
    normalizeLegacyProjectStep(project);
    const sessions = legacy
      .prepare("select data from sessions where project_id=? order by created_at, id")
      .all(projectId)
      .map((row) => parseObject(row.data));
    if (sessions.some((session) => !session)) return null;
    sessions.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || String(left.id).localeCompare(String(right.id)));
    return { project, sessions };
  } catch {
    return null;
  }
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeLegacyProjectStep(project) {
  const replacements = new Map([
    ["CREATE_PROJECT", "CREATE_RESEARCH_DB"],
    ["CREATE_SUB_SESSIONS", "CREATE_RESEARCH_DB"],
    ["GENERATE_QUESTIONS_HYPOTHESES_EVIDENCE", "BUILD_RESEARCH_SPECIFICATION"],
    ["STORE_RESULTS", "NORMALIZE_DATA"],
    ["BUILD_RAG_CONTEXT", "BUILD_VECTOR_INDEX"],
    ["DERIVE_EVIDENCE_BASED_RESULT", "SYNTHESIZE_AND_EVALUATE"],
    ["FINALIZE_RESEARCH_OUTPUTS", "FINALIZE_OUTPUTS"]
  ]);
  project.currentStep = replacements.get(project.currentStep) ?? project.currentStep;
}

function runtimeHash(value) {
  return sha256Hex(runtimeCanonicalJson(value));
}

function safeRuntimeHash(value) {
  try {
    return runtimeHash(value);
  } catch {
    return undefined;
  }
}

function runtimeCanonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Project mutation cross-database inspection rejects non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(runtimeCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${runtimeCanonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`Project mutation cross-database inspection rejects unsupported value type: ${typeof value}`);
}

function openReadOnly(path) {
  return existsSync(path) ? new DatabaseSync(path, { readOnly: true }) : undefined;
}

function tableExists(db, name) {
  return Boolean(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name));
}
