import { sha256Hex } from "./hash.mjs";
import {
  assertColumnsForInspection,
  assertForeignKeysForInspection,
  assertIndexesForInspection,
  assertTriggersForInspection,
  tableExists
} from "./operationalSchemaInspection.mjs";

export const PROJECT_MUTATION_TABLE = "project_mutation_journal";
export const PROJECT_MUTATION_INDEXES = ["idx_project_mutations_active_project", "idx_project_mutations_pending"];
export const PROJECT_MUTATION_TRIGGERS = ["trg_project_mutations_transition", "trg_project_mutations_no_delete"];
const OBJECT_SQL_HASHES = new Map([
  [PROJECT_MUTATION_TABLE, "e9de51a36e572628a3e5d24bdd9f3b271248fcf7d213011a3cb5575d7ae6ac52"],
  ["idx_project_mutations_active_project", "d5706b8947e748e60535a8de494631ef43cb575e7ef9035e7dbd560c7f405354"],
  ["idx_project_mutations_pending", "b247ca7489831ef6345e6c4747cfd1dc0926057c9921fb726d98c1fea0cf92b9"],
  ["trg_project_mutations_no_delete", "d042ec76ade343cd4a1ff849e6cd49b49193a30295afc17ae0451d2e5310200d"],
  ["trg_project_mutations_transition", "ae63aaf102ea9f5f8fec7b2e3dca6da204cc1fca642ba466171653b74b13b192"]
]);
const LEGACY_METHODS = new Map([
  ["projects.create", "project.create"],
  ["projects.update", "project.update"],
  ["sessions.create", "session.create"],
  ["sessions.delete", "session.delete"]
]);
const RESEARCH_STEPS = new Set([
  "CREATE_RESEARCH_DB",
  "INPUT_RESEARCH_QUESTION_HYPOTHESIS",
  "BUILD_RESEARCH_SPECIFICATION",
  "PLAN_RESEARCH",
  "EXECUTE_TOOLS",
  "NORMALIZE_DATA",
  "BUILD_VECTOR_INDEX",
  "BUILD_ONTOLOGY_GRAPH",
  "REASON_AND_VALIDATE",
  "SYNTHESIZE_AND_EVALUATE",
  "DECIDE_CONTINUATION",
  "FINALIZE_OUTPUTS"
]);
const PROJECT_STATUSES = new Set(["idle", "running", "paused", "aborted", "completed", "failed", "blocked"]);

const COLUMNS = [
  "operation_id",
  "schema_version",
  "method",
  "request_id",
  "request_hash",
  "project_id",
  "expected_revision",
  "command_json",
  "command_hash",
  "legacy_before_hash",
  "state",
  "legacy_receipt_hash",
  "legacy_snapshot_hash",
  "legacy_applied_at",
  "finalize_request_hash",
  "event_id",
  "committed_revision",
  "public_result_json",
  "public_result_hash",
  "prepared_at",
  "updated_at",
  "finalized_at"
];

export function inspectProjectMutationSchema(db, errors) {
  if (!tableExists(db, PROJECT_MUTATION_TABLE)) {
    errors.push(`Operational table is missing: ${PROJECT_MUTATION_TABLE}`);
    return;
  }
  assertColumnsForInspection(db, PROJECT_MUTATION_TABLE, COLUMNS, errors);
  assertIndexesForInspection(db, PROJECT_MUTATION_TABLE, PROJECT_MUTATION_INDEXES, errors);
  assertForeignKeysForInspection(db, PROJECT_MUTATION_TABLE, ["job_events"], errors);
  assertTriggersForInspection(db, PROJECT_MUTATION_TRIGGERS, errors);
  inspectObjectSqlIdentity(db, errors);
  inspectSemantics(db, errors);
}

function inspectObjectSqlIdentity(db, errors) {
  const statement = db.prepare("select sql from sqlite_master where name=? and type in ('table','index','trigger')");
  for (const [name, expectedHash] of OBJECT_SQL_HASHES) {
    const sql = statement.get(name)?.sql;
    if (typeof sql !== "string" || sha256Hex(canonicalSql(sql)) !== expectedHash) {
      errors.push(`Operational project mutation schema object changed: ${name}`);
    }
  }
}

function canonicalSql(sql) {
  return sql.trim().replace(/\s+/g, " ").replace(/;$/, "").trim().toLowerCase();
}

function inspectSemantics(db, errors) {
  const rows = db.prepare("select * from project_mutation_journal order by operation_id").all();
  const activeProjects = new Set();
  for (const row of rows) {
    const commandInspection = inspectProjectMutationCommandEnvelope(row);
    const result = row.public_result_json === null ? undefined : parseObject(row.public_result_json);
    const identityHash = runtimeHash({ method: row.method, requestId: row.request_id });
    const resultHash = result ? safeRuntimeHash(result) : undefined;
    if (row.operation_id !== `project-mutation:${identityHash}` || (result && resultHash !== row.public_result_hash))
      errors.push(`Project mutation journal hash is inconsistent: ${row.operation_id}`);
    if (commandInspection.reasons.length) {
      errors.push(`Project mutation journal command envelope is unrecoverable: ${row.operation_id} (${commandInspection.reasons.join(", ")})`);
    }
    if (row.state === "finalizing") errors.push(`Project mutation journal contains an uncommitted finalizing state: ${row.operation_id}`);
    if (["prepared", "legacy_applied", "finalizing"].includes(row.state)) {
      if (activeProjects.has(row.project_id)) errors.push(`Project mutation reservation is duplicated: ${row.project_id}`);
      activeProjects.add(row.project_id);
      if (!validOperationalBase(db, row)) errors.push(`Project mutation journal base revision is inconsistent: ${row.operation_id}`);
    }
    if (row.state === "finalized" && !validFinalizedReadback(db, row)) {
      errors.push(`Project mutation finalized readback is inconsistent: ${row.operation_id}`);
    }
  }
}

export function inspectProjectMutationCommandEnvelope(row) {
  const reasons = [];
  const envelope = parseObject(row.command_json);
  if (!envelope) return { envelope: undefined, reasons: ["invalid command JSON"] };
  if (!hasExactKeys(envelope, ["appliedAt", "command", "expectedBeforeHash", "legacyMethod"])) reasons.push("envelope fields");
  const expectedLegacyMethod = LEGACY_METHODS.get(String(row.method));
  if (!expectedLegacyMethod || envelope.legacyMethod !== expectedLegacyMethod) reasons.push("method mapping");
  if (!validHash(row.request_hash)) reasons.push("request hash");
  if (!validId(row.project_id)) reasons.push("project identity");
  if (!Number.isSafeInteger(row.expected_revision) || row.expected_revision < 0 || (row.method === "projects.create" && row.expected_revision !== 0)) {
    reasons.push("expected revision");
  }
  if (!validOptionalHash(envelope.expectedBeforeHash)) reasons.push("expected-before hash");
  if (row.method === "projects.create" ? envelope.expectedBeforeHash !== null : envelope.expectedBeforeHash === null) {
    reasons.push("expected-before presence");
  }
  const expectedBeforeHash = envelope.expectedBeforeHash ?? runtimeHash(null);
  if (!validHash(row.legacy_before_hash) || row.legacy_before_hash !== expectedBeforeHash) reasons.push("journal before hash");
  if (!canonicalTimestamp(envelope.appliedAt) || !canonicalTimestamp(row.prepared_at) || envelope.appliedAt !== row.prepared_at) {
    reasons.push("applied timestamp");
  }
  const canonicalEnvelope = safeRuntimeCanonicalJson(envelope);
  if (!canonicalEnvelope || String(row.command_json) !== canonicalEnvelope) reasons.push("non-canonical command JSON");
  if (!validHash(row.command_hash) || !canonicalEnvelope || sha256Hex(canonicalEnvelope) !== row.command_hash) reasons.push("command envelope hash");
  reasons.push(...legacyCommandReasons(String(row.method), row, envelope.command));
  return { envelope, reasons };
}

function legacyCommandReasons(method, row, command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) return ["command shape"];
  if (method === "projects.create" || method === "projects.update") return projectCommandReasons(row, command);
  if (method === "sessions.create") return sessionCommandReasons(row, command);
  if (method === "sessions.delete") {
    return hasExactKeys(command, ["sessionId"]) && validId(command.sessionId) ? [] : ["session delete command"];
  }
  return ["unsupported public method"];
}

function projectCommandReasons(row, command) {
  if (!hasExactKeys(command, ["project"])) return ["project command fields"];
  const project = command.project;
  if (
    !project ||
    typeof project !== "object" ||
    Array.isArray(project) ||
    !hasExactKeys(project, ["autonomyPolicy", "budget", "createdAt", "currentStep", "goal", "id", "projectRoot", "scope", "status", "topic", "updatedAt"])
  )
    return ["project command shape"];
  if (
    project.id !== row.project_id ||
    !validId(project.id) ||
    ![project.goal, project.topic, project.scope, project.budget, project.projectRoot].every(requiredText) ||
    !canonicalTimestamp(project.createdAt) ||
    !canonicalTimestamp(project.updatedAt) ||
    !RESEARCH_STEPS.has(project.currentStep) ||
    !PROJECT_STATUSES.has(project.status) ||
    !validAutonomyPolicy(project.autonomyPolicy)
  )
    return ["project command value"];
  return [];
}

function sessionCommandReasons(row, command) {
  if (!hasExactKeys(command, ["session"])) return ["session command fields"];
  const session = command.session;
  if (
    !session ||
    typeof session !== "object" ||
    Array.isArray(session) ||
    !hasExactKeys(session, ["createdAt", "focus", "id", "projectId", "title"]) ||
    session.projectId !== row.project_id ||
    !validId(session.id) ||
    !requiredText(session.title) ||
    !requiredText(session.focus) ||
    !canonicalTimestamp(session.createdAt)
  )
    return ["session command shape"];
  return [];
}

function validAutonomyPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(["allowAgent", "allowCodeExecution", "allowExternalSearch", "maxLoopIterations", "toolApproval"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (!["manual", "suggested", "automatic"].includes(value.toolApproval)) return false;
  if (typeof value.allowCodeExecution !== "boolean" || typeof value.allowExternalSearch !== "boolean") return false;
  if (value.allowAgent !== undefined && typeof value.allowAgent !== "boolean") return false;
  return value.maxLoopIterations === undefined || (Number.isSafeInteger(value.maxLoopIterations) && value.maxLoopIterations >= 1);
}

function hasExactKeys(value, keys) {
  return Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function validHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validOptionalHash(value) {
  return value === null || validHash(value);
}

function canonicalTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validId(value) {
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    value.length <= 512 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function requiredText(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function validFinalizedReadback(db, row) {
  try {
    if (!["job_events", "project_revision_event_links", "project_revision_heads"].every((name) => tableExists(db, name))) return false;
    const linked = db
      .prepare(
        `select e.project_id,l.revision,h.revision head_revision from job_events e
      join project_revision_event_links l on l.event_id=e.event_id
      join project_revision_heads h on h.project_id=e.project_id where e.event_id=?`
      )
      .get(row.event_id);
    return (
      linked?.project_id === row.project_id &&
      Number(linked.revision) === Number(row.committed_revision) &&
      Number(linked.head_revision) >= Number(row.committed_revision)
    );
  } catch {
    return false;
  }
}

function validOperationalBase(db, row) {
  try {
    if (!["projects_v2", "project_revision_heads"].every((name) => tableExists(db, name))) return false;
    const project = db.prepare("select 1 present from projects_v2 where id=?").get(row.project_id);
    const head = db.prepare("select revision from project_revision_heads where project_id=?").get(row.project_id);
    if (row.method === "projects.create") return project === undefined && head === undefined && row.expected_revision === 0;
    return Boolean(project && head && Number.isSafeInteger(head.revision) && Number(head.revision) === Number(row.expected_revision));
  } catch {
    return false;
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

function runtimeHash(value) {
  return sha256Hex(runtimeCanonicalJson(value));
}

function safeRuntimeHash(value) {
  const canonical = safeRuntimeCanonicalJson(value);
  return canonical ? sha256Hex(canonical) : undefined;
}

function safeRuntimeCanonicalJson(value) {
  try {
    return runtimeCanonicalJson(value);
  } catch {
    return undefined;
  }
}

function runtimeCanonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Project mutation inspection rejects non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(runtimeCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${runtimeCanonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`Project mutation inspection rejects unsupported value type: ${typeof value}`);
}
