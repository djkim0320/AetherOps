import { DatabaseSync } from "node:sqlite";
import { loadV2FtsSql, loadV2OperationalMigrationSql } from "./sqlite.mjs";
import { sha256Hex } from "./hash.mjs";
import { sanitizeLegacyJobPolicies } from "./v2JobPolicySanitizer.mjs";
import {
  assertColumnsForInspection,
  assertForeignKeysForInspection,
  assertIndexesForInspection,
  assertTriggersForInspection,
  columnNames,
  tableExists
} from "./operationalSchemaInspection.mjs";
import {
  TOOL_SIDE_EFFECT_COLUMNS,
  TOOL_SIDE_EFFECT_FOREIGN_KEYS,
  TOOL_SIDE_EFFECT_INDEXES,
  TOOL_SIDE_EFFECT_TABLE,
  TOOL_SIDE_EFFECT_TRIGGERS
} from "./operationalToolSideEffectSchema.mjs";
import { inspectEngineeringBaselineSchema } from "./operationalEngineeringBaselineSchema.mjs";
import { inspectProjectRevisionSchema } from "./operationalProjectRevisionSchema.mjs";
import { inspectProjectMutationSchema } from "./operationalProjectMutationSchema.mjs";

const BASE_TABLES = ["storage_v2_meta", "projects_v2", "jobs", "checkpoints"];
const TRACE_TABLES = ["llm_invocations", "tool_decisions", "tool_attempts", "tool_output_links", "network_audits", "codex_cli_executions"];
const RUN_STATE_TABLES = ["task_contracts", "context_packs", "run_state_revisions", "run_job_links"];
const TERMINAL_RECEIPT_TABLE = "canonical_terminal_verifier_receipts";
const TERMINAL_ATTESTATION_TABLE = "canonical_terminal_result_attestations";
const TERMINAL_RECEIPT_COLUMNS = [
  "id",
  "project_id",
  "run_id",
  "job_id",
  "request_hash",
  "receipt_kind",
  "criterion_id",
  "subject_kind",
  "subject_id",
  "subject_hash",
  "output_hash",
  "source_receipt_ids",
  "verifier_version",
  "verified_at",
  "receipt_hash"
];
const RUN_STATE_COLUMNS = {
  task_contracts: ["id", "project_id", "schema_version", "content_hash", "created_at", "data"],
  context_packs: [
    "id",
    "project_id",
    "run_id",
    "job_id",
    "schema_version",
    "state_revision",
    "task_contract_id",
    "task_contract_hash",
    "content_hash",
    "created_at",
    "data"
  ],
  run_state_revisions: [
    "id",
    "project_id",
    "run_id",
    "job_id",
    "schema_version",
    "revision",
    "previous_revision",
    "parent_revision_hash",
    "state_hash",
    "task_contract_id",
    "task_contract_hash",
    "context_pack_id",
    "created_at",
    "data"
  ],
  run_job_links: [
    "run_id",
    "project_id",
    "job_id",
    "predecessor_job_id",
    "resume_checkpoint_id",
    "link_kind",
    "lineage_sequence",
    "linked_at_revision",
    "created_at"
  ]
};
const RUN_STATE_INDEXES = {
  task_contracts: ["idx_task_contracts_project_created"],
  context_packs: ["idx_context_packs_project_run_revision", "idx_context_packs_job_revision", "idx_context_packs_task_contract"],
  run_state_revisions: [
    "idx_run_state_revisions_project_run",
    "idx_run_state_revisions_job",
    "idx_run_state_revisions_task_contract",
    "idx_run_state_revisions_context_pack"
  ],
  run_job_links: ["idx_run_job_links_run_sequence"]
};
const RUN_STATE_FOREIGN_KEYS = {
  task_contracts: ["projects_v2"],
  context_packs: ["projects_v2", "jobs", "task_contracts"],
  run_state_revisions: ["projects_v2", "jobs", "task_contracts", "context_packs"],
  run_job_links: ["projects_v2", "jobs", "checkpoints"]
};
const JOB_COLUMNS = ["lease_generation", "request_hash", "requested_capabilities", "effective_capabilities", "tool_policy", "blocked_reason", "failure_reason"];
const ATTEMPT_COLUMNS = [
  "terminal_cause",
  "depends_on_attempt_ids",
  "trace_version",
  "descriptor_version",
  "descriptor_side_effects",
  "side_effect_key",
  "idempotency_key",
  "postcondition_disposition",
  "postcondition_receipt"
];
const JOB_INDEXES = ["idx_jobs_project_lane", "idx_jobs_ready", "idx_jobs_one_active_project", "idx_jobs_lease_generation"];
const RUN_STATE_TRIGGERS = [
  "trg_task_contracts_no_update",
  "trg_task_contracts_no_delete",
  "trg_context_packs_no_update",
  "trg_context_packs_no_delete",
  "trg_run_state_revisions_no_update",
  "trg_run_state_revisions_no_delete",
  "trg_run_job_links_no_update",
  "trg_run_job_links_no_delete"
];
const TERMINAL_RECEIPT_TRIGGERS = ["trg_terminal_verifier_receipts_no_update", "trg_terminal_verifier_receipts_no_delete"];
const TERMINAL_ATTESTATION_TRIGGERS = ["trg_terminal_attestations_no_update", "trg_terminal_attestations_no_delete"];
const OWNERSHIP_TRIGGERS = [
  "trg_capability_audits_owner_insert",
  "trg_capability_audits_owner_update",
  "trg_tool_attempts_owner_insert",
  "trg_tool_attempts_owner_update",
  "trg_tool_output_links_owner_insert",
  "trg_tool_output_links_owner_update"
];
const TERMINAL_ATTESTATION_COLUMNS = [
  "id",
  "schema_version",
  "project_id",
  "run_id",
  "job_id",
  "batch_hash",
  "subject_kind",
  "subject_id",
  "content_hash",
  "cas_locator",
  "cas_hash",
  "byte_length",
  "attempt_id",
  "output_link_id",
  "validation_attestation_id",
  "provenance_attestation_ids",
  "supporting_evidence_ids",
  "contradicting_evidence_ids",
  "source_evidence_ids_hash",
  "supported_claim_hashes",
  "attested_at",
  "attestation_hash"
];

export function inspectOperationalSchema(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return inspectOperationalSchemaDatabase(db);
  } finally {
    db.close();
  }
}

export function upgradeOperationalSchema(dbPath) {
  const before = inspectOperationalSchema(dbPath);
  if (before.conflicts.length) throw new Error(`Operational schema cannot be upgraded: ${before.conflicts.join("; ")}`);
  if (before.ready) return { changed: false, appliedVersions: [], before, after: before };

  const sql = loadV2OperationalMigrationSql();
  const expected = expectedMigrations(sql);
  const db = new DatabaseSync(dbPath);
  const appliedVersions = [];
  try {
    db.exec("pragma foreign_keys = on");
    db.exec("pragma secure_delete = on");
    db.exec("pragma journal_mode = WAL");
    db.exec("begin immediate");
    try {
      db.exec(sql.trace);
      addMissingTraceColumns(db);
      if (!before.installedVersions.includes(4)) {
        addColumnUnlessPresent(db, "jobs", "lease_generation", "integer not null default 0");
        sanitizeLegacyJobPolicies(db, true);
        db.exec(sql.jobFencing);
      } else sanitizeLegacyJobPolicies(db, false);
      if (!before.installedVersions.includes(5)) db.exec(sql.runState);
      if (!before.installedVersions.includes(7)) db.exec(sql.runStateBootstrap);
      if (!before.installedVersions.includes(8)) db.exec(sql.terminalReceipt);
      if (!before.installedVersions.includes(9)) db.exec(sql.terminalAttestation);
      if (!before.installedVersions.includes(10)) db.exec(sql.ownership);
      if (!before.installedVersions.includes(11)) db.exec(sql.toolSideEffects);
      if (!before.installedVersions.includes(12)) db.exec(sql.engineeringBaselines);
      if (!before.installedVersions.includes(13)) db.exec(sql.projectRevisions);
      if (!before.installedVersions.includes(14)) db.exec(sql.projectMutations);
      db.exec(loadV2FtsSql());
      assertMigrationLedger(db, expected);
      const foreignKeys = db.prepare("pragma foreign_key_check").all();
      if (foreignKeys.length) throw new Error("Operational schema upgrade introduced foreign-key violations.");
      db.exec("commit");
    } catch (error) {
      if (db.isTransaction) db.exec("rollback");
      throw error;
    }
    for (const version of expected.keys()) if (!before.installedVersions.includes(version)) appliedVersions.push(version);
  } finally {
    db.close();
  }

  const after = inspectOperationalSchema(dbPath);
  if (!after.ready) throw new Error(`Operational schema upgrade did not reach the current schema: ${after.errors.join("; ")}`);
  return { changed: true, appliedVersions, before, after };
}

function inspectOperationalSchemaDatabase(db) {
  const sql = loadV2OperationalMigrationSql();
  const expected = expectedMigrations(sql);
  const errors = [];
  const conflicts = [];
  for (const table of BASE_TABLES) if (!tableExists(db, table)) errors.push(`Required v2 table is missing: ${table}`);
  const schemaVersion = readSchemaVersion(db);
  if (schemaVersion !== "2") conflicts.push(`Expected storage schema version 2, found ${schemaVersion ?? "missing"}`);
  const ledger = readLedger(db);
  for (const row of ledger) {
    const descriptor = expected.get(row.version);
    if (!descriptor) {
      conflicts.push(`Unsupported operational migration version ${row.version} is installed.`);
    } else if (row.name !== descriptor.name || row.checksum !== descriptor.checksum) {
      conflicts.push(`Operational migration ${row.version} has an unexpected identity or checksum.`);
    }
  }
  const installedVersions = ledger.map((row) => row.version).sort((left, right) => left - right);
  for (const version of expected.keys()) if (!installedVersions.includes(version)) errors.push(`Operational migration ${version} is missing.`);
  for (const table of [...TRACE_TABLES, ...RUN_STATE_TABLES, TERMINAL_RECEIPT_TABLE, TERMINAL_ATTESTATION_TABLE, TOOL_SIDE_EFFECT_TABLE])
    if (!tableExists(db, table)) errors.push(`Operational table is missing: ${table}`);
  assertColumnsForInspection(db, "jobs", JOB_COLUMNS, errors);
  assertColumnsForInspection(db, "tool_attempts", ATTEMPT_COLUMNS, errors);
  assertIndexesForInspection(db, "jobs", JOB_INDEXES, errors);
  for (const [table, columns] of Object.entries(RUN_STATE_COLUMNS)) assertColumnsForInspection(db, table, columns, errors);
  for (const [table, indexes] of Object.entries(RUN_STATE_INDEXES)) assertIndexesForInspection(db, table, indexes, errors);
  for (const [table, targets] of Object.entries(RUN_STATE_FOREIGN_KEYS)) assertForeignKeysForInspection(db, table, targets, errors);
  assertTriggersForInspection(db, RUN_STATE_TRIGGERS, errors);
  assertColumnsForInspection(db, TERMINAL_RECEIPT_TABLE, TERMINAL_RECEIPT_COLUMNS, errors);
  assertIndexesForInspection(db, TERMINAL_RECEIPT_TABLE, ["idx_terminal_verifier_receipts_job_request", "idx_terminal_verifier_receipts_run"], errors);
  assertForeignKeysForInspection(db, TERMINAL_RECEIPT_TABLE, ["projects_v2", "jobs"], errors);
  assertTriggersForInspection(db, TERMINAL_RECEIPT_TRIGGERS, errors);
  assertColumnsForInspection(db, TERMINAL_ATTESTATION_TABLE, TERMINAL_ATTESTATION_COLUMNS, errors);
  assertIndexesForInspection(
    db,
    TERMINAL_ATTESTATION_TABLE,
    ["idx_terminal_attestations_job_batch", "idx_terminal_attestations_run", "idx_terminal_attestations_cas"],
    errors
  );
  assertForeignKeysForInspection(
    db,
    TERMINAL_ATTESTATION_TABLE,
    ["projects_v2", "jobs", "tool_attempts", "tool_output_links", TERMINAL_ATTESTATION_TABLE],
    errors
  );
  assertTriggersForInspection(db, TERMINAL_ATTESTATION_TRIGGERS, errors);
  assertTriggersForInspection(db, OWNERSHIP_TRIGGERS, errors);
  assertColumnsForInspection(db, TOOL_SIDE_EFFECT_TABLE, TOOL_SIDE_EFFECT_COLUMNS, errors);
  assertIndexesForInspection(db, TOOL_SIDE_EFFECT_TABLE, TOOL_SIDE_EFFECT_INDEXES, errors);
  assertForeignKeysForInspection(db, TOOL_SIDE_EFFECT_TABLE, TOOL_SIDE_EFFECT_FOREIGN_KEYS, errors);
  assertTriggersForInspection(db, TOOL_SIDE_EFFECT_TRIGGERS, errors);
  inspectEngineeringBaselineSchema(db, errors);
  inspectProjectRevisionSchema(db, errors);
  inspectProjectMutationSchema(db, errors);
  const lineageSql = tableSql(db, "run_job_links");
  if (!lineageSql?.includes("link_kind") || !lineageSql.includes("'bootstrap'")) errors.push("Run-state bootstrap lineage constraint is missing.");
  return {
    ready: errors.length === 0 && conflicts.length === 0,
    currentVersion: installedVersions.at(-1) ?? 0,
    installedVersions,
    expectedVersions: [...expected.keys()],
    errors,
    conflicts
  };
}

function expectedMigrations(sql) {
  const migrations = new Map();
  for (const source of Object.values(sql)) {
    const pattern = /values\s*\(\s*(\d+)\s*,\s*'([^']+)'\s*,\s*'([a-f0-9]{64})'/gi;
    for (const match of source.matchAll(pattern)) {
      migrations.set(Number(match[1]), { name: match[2], checksum: match[3] });
    }
  }
  for (const version of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
    if (!migrations.has(version)) throw new Error(`Could not extract operational migration ${version} from the runtime schema.`);
  }
  assertMigrationSourceChecksum(sql.engineeringBaselines, migrations.get(12), 12);
  assertMigrationSourceChecksum(sql.projectRevisions, migrations.get(13), 13);
  assertMigrationSourceChecksum(sql.projectMutations, migrations.get(14), 14);
  return new Map([...migrations].sort(([left], [right]) => left - right));
}

function assertMigrationSourceChecksum(source, descriptor, version) {
  if (!descriptor || source.split(descriptor.checksum).length !== 2) {
    throw new Error(`Operational migration ${version} checksum literal is missing or ambiguous.`);
  }
  const actual = sha256Hex(source.replace(descriptor.checksum, "<checksum>"));
  if (actual !== descriptor.checksum) {
    throw new Error(`Operational migration ${version} source checksum mismatch: expected ${descriptor.checksum}, computed ${actual}.`);
  }
}

function addMissingTraceColumns(db) {
  for (const [name, type] of [
    ["request_hash", "text"],
    ["requested_capabilities", "text"],
    ["effective_capabilities", "text"],
    ["tool_policy", "text"],
    ["blocked_reason", "text"],
    ["failure_reason", "text"]
  ]) {
    addColumnUnlessPresent(db, "jobs", name, type);
  }
  for (const [name, type] of [
    ["terminal_cause", "text"],
    ["depends_on_attempt_ids", "text not null default '[]'"],
    ["trace_version", "integer check(trace_version = 1)"],
    ["descriptor_version", "text"],
    ["descriptor_side_effects", "text"],
    ["side_effect_key", "text"],
    ["idempotency_key", "text"],
    ["postcondition_disposition", "text check(postcondition_disposition in ('applied', 'not_applied'))"],
    ["postcondition_receipt", "text"]
  ]) {
    addColumnUnlessPresent(db, "tool_attempts", name, type);
  }
  db.exec("create index if not exists idx_tool_attempts_side_effect_key on tool_attempts(project_id, side_effect_key) where side_effect_key is not null");
}

function assertMigrationLedger(db, expected) {
  const ledger = new Map(readLedger(db).map((row) => [row.version, row]));
  for (const [version, descriptor] of expected) {
    const row = ledger.get(version);
    if (row?.name !== descriptor.name || row.checksum !== descriptor.checksum) {
      throw new Error(`Operational migration ${version} is missing or has an unexpected identity or checksum.`);
    }
  }
}

function addColumnUnlessPresent(db, table, name, definition) {
  if (!columnNames(db, table).has(name)) db.exec(`alter table ${table} add column ${name} ${definition}`);
}

function readSchemaVersion(db) {
  if (!tableExists(db, "storage_v2_meta")) return undefined;
  return String(db.prepare("select value from storage_v2_meta where key='schema_version'").get()?.value ?? "") || undefined;
}

function readLedger(db) {
  if (!tableExists(db, "schema_migrations")) return [];
  return db
    .prepare("select version,name,checksum_sha256 from schema_migrations order by version")
    .all()
    .map((row) => ({ version: Number(row.version), name: String(row.name), checksum: String(row.checksum_sha256) }));
}

function tableSql(db, name) {
  return db.prepare("select sql from sqlite_master where type='table' and name=?").get(name)?.sql;
}
