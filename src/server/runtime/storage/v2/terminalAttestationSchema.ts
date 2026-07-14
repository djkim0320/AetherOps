import type { DatabaseSync } from "node:sqlite";

export const STORAGE_TERMINAL_ATTESTATION_SCHEMA_VERSION = 9;
export const STORAGE_TERMINAL_ATTESTATION_MIGRATION_NAME = "operational-terminal-result-attestations-v9";
export const STORAGE_TERMINAL_ATTESTATION_MIGRATION_CHECKSUM = "cd20e019290129bf06f89b3c4eeb6737e2290363a96f8e8c07dc866ebd02e312";

export function migrateStorageTerminalAttestationV9Schema(db: DatabaseSync): void {
  runAtomically(db, () => {
    const installed = migration(db);
    if (installed) {
      assertMigrationIdentity(installed);
      return;
    }
    installStorageTerminalAttestationV9Objects(db);
  });
  assertStorageTerminalAttestationV9SchemaReady(db);
}

function installStorageTerminalAttestationV9Objects(db: DatabaseSync): void {
  // The offline Migration Coordinator extracts this literal. Keep the ledger values synchronized with the exported constants.
  db.exec(`
    create table canonical_terminal_result_attestations (
      id text primary key,
      schema_version integer not null check(schema_version = 1),
      project_id text not null,
      run_id text not null,
      job_id text not null,
      batch_hash text not null check(length(batch_hash) = 64),
      subject_kind text not null check(subject_kind in ('artifact','evidence','validation_result')),
      subject_id text not null,
      content_hash text not null check(length(content_hash) = 64),
      cas_locator text not null,
      cas_hash text not null check(length(cas_hash) = 64),
      byte_length integer not null check(byte_length >= 0),
      attempt_id text,
      output_link_id text,
      validation_attestation_id text,
      provenance_attestation_ids text not null,
      supporting_evidence_ids text not null,
      contradicting_evidence_ids text not null,
      source_evidence_ids_hash text not null check(length(source_evidence_ids_hash) = 64),
      supported_claim_hashes text not null,
      attested_at text not null,
      attestation_hash text not null unique check(length(attestation_hash) = 64),
      unique(job_id, subject_kind, subject_id),
      foreign key(project_id) references projects_v2(id),
      foreign key(job_id) references jobs(id),
      foreign key(attempt_id) references tool_attempts(id),
      foreign key(output_link_id) references tool_output_links(id),
      foreign key(validation_attestation_id) references canonical_terminal_result_attestations(id)
    );
    create index idx_terminal_attestations_job_batch
      on canonical_terminal_result_attestations(job_id, batch_hash, subject_kind, subject_id);
    create index idx_terminal_attestations_run
      on canonical_terminal_result_attestations(project_id, run_id, attested_at, id);
    create index idx_terminal_attestations_cas
      on canonical_terminal_result_attestations(cas_hash, cas_locator);
    create trigger trg_terminal_attestations_no_update
      before update on canonical_terminal_result_attestations begin select raise(abort, 'canonical terminal attestations are immutable'); end;
    create trigger trg_terminal_attestations_no_delete
      before delete on canonical_terminal_result_attestations begin select raise(abort, 'canonical terminal attestations are immutable'); end;
    insert into schema_migrations (version, name, checksum_sha256, applied_at)
      values (9, 'operational-terminal-result-attestations-v9', 'cd20e019290129bf06f89b3c4eeb6737e2290363a96f8e8c07dc866ebd02e312', datetime('now'));
  `);
}

export function assertStorageTerminalAttestationV9SchemaReady(db: DatabaseSync): void {
  assertMigrationIdentity(migration(db));
  assertNames(db, "pragma table_info(canonical_terminal_result_attestations)", [
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
  ]);
  assertNames(db, "pragma index_list(canonical_terminal_result_attestations)", [
    "idx_terminal_attestations_job_batch",
    "idx_terminal_attestations_run",
    "idx_terminal_attestations_cas"
  ]);
  const triggers = new Set(
    (db.prepare("select name from sqlite_master where type='trigger'").all() as Array<{ name?: unknown }>).map((row) => String(row.name))
  );
  for (const name of ["trg_terminal_attestations_no_update", "trg_terminal_attestations_no_delete"]) {
    if (!triggers.has(name)) throw new Error(`Storage terminal attestation trigger is missing: ${name}`);
  }
}

function assertNames(db: DatabaseSync, sql: string, required: string[]): void {
  const names = new Set((db.prepare(sql).all() as Array<{ name?: unknown }>).map((row) => String(row.name)));
  for (const name of required) if (!names.has(name)) throw new Error(`Storage terminal attestation schema object is missing: ${name}`);
}

function migration(db: DatabaseSync): { name?: unknown; checksum_sha256?: unknown } | undefined {
  return db.prepare("select name,checksum_sha256 from schema_migrations where version=?").get(STORAGE_TERMINAL_ATTESTATION_SCHEMA_VERSION) as
    { name?: unknown; checksum_sha256?: unknown } | undefined;
}

function assertMigrationIdentity(value: { name?: unknown; checksum_sha256?: unknown } | undefined): void {
  if (value?.name !== STORAGE_TERMINAL_ATTESTATION_MIGRATION_NAME || value.checksum_sha256 !== STORAGE_TERMINAL_ATTESTATION_MIGRATION_CHECKSUM) {
    throw new Error("Storage terminal attestation migration ledger is missing or has an unexpected checksum.");
  }
}

function runAtomically<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return work();
  db.exec("begin immediate");
  try {
    const result = work();
    db.exec("commit");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("rollback");
    throw error;
  }
}
