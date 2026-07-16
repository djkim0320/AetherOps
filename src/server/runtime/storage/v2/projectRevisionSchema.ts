import type { DatabaseSync } from "node:sqlite";

export const STORAGE_PROJECT_REVISION_SCHEMA_VERSION = 13;
export const STORAGE_PROJECT_REVISION_MIGRATION_NAME = "operational-project-revisions-v13";
export const STORAGE_PROJECT_REVISION_MIGRATION_CHECKSUM = "2770dab150f192287f74ad3229a5113804d28d2b66aaf7de62ded687a83b7537";

const TABLES = ["project_revision_heads", "project_revision_receipts", "project_revision_event_links"] as const;
const TRIGGERS = [
  "trg_project_revision_receipts_insert",
  "trg_project_revision_receipts_no_update",
  "trg_project_revision_receipts_no_delete",
  "trg_project_revision_links_insert",
  "trg_project_revision_links_no_update",
  "trg_project_revision_links_no_delete",
  "trg_project_revision_heads_insert",
  "trg_project_revision_heads_update",
  "trg_project_revision_heads_no_delete"
] as const;

export function migrateStorageProjectRevisionV13Schema(db: DatabaseSync): void {
  runAtomically(db, () => {
    const installed = migration(db);
    if (installed) {
      assertMigrationIdentity(installed);
      return;
    }
    installStorageProjectRevisionV13Objects(db);
  });
  assertStorageProjectRevisionV13SchemaReady(db);
}

function installStorageProjectRevisionV13Objects(db: DatabaseSync): void {
  // The offline Migration Coordinator extracts this literal. Keep ledger identity synchronized with the exported constants.
  db.exec(`
    create table project_revision_receipts (
      id text primary key,
      schema_version integer not null check(schema_version = 1),
      project_id text not null,
      revision integer not null check(revision > 0),
      mutation_id text not null,
      mutation_hash text,
      anchor_event_id text,
      reason text not null check(length(reason) > 0),
      committed_at text not null,
      unique(project_id, revision),
      unique(project_id, mutation_id),
      unique(anchor_event_id),
      check(
        (reason = 'legacy_unavailable' and mutation_hash is null and anchor_event_id is null)
        or (reason <> 'legacy_unavailable' and length(mutation_hash) = 64 and anchor_event_id is not null)
      ),
      foreign key(project_id) references projects_v2(id),
      foreign key(anchor_event_id) references job_events(event_id)
    );
    create index idx_project_revision_receipts_project_revision
      on project_revision_receipts(project_id, revision desc);
    create table project_revision_event_links (
      event_id text primary key,
      receipt_id text not null,
      project_id text not null,
      revision integer not null check(revision > 0),
      linked_at text not null,
      foreign key(event_id) references job_events(event_id),
      foreign key(receipt_id) references project_revision_receipts(id),
      foreign key(project_id) references projects_v2(id)
    );
    create index idx_project_revision_links_receipt
      on project_revision_event_links(receipt_id, event_id);
    create table project_revision_heads (
      project_id text primary key,
      revision integer not null check(revision >= 0),
      last_receipt_id text unique,
      updated_at text not null,
      check((revision = 0 and last_receipt_id is null) or (revision > 0 and last_receipt_id is not null)),
      foreign key(project_id) references projects_v2(id),
      foreign key(last_receipt_id) references project_revision_receipts(id)
    );
    create trigger trg_project_revision_receipts_insert before insert on project_revision_receipts
      when not exists (select 1 from projects_v2 p where p.id=new.project_id)
        or (new.reason='legacy_unavailable' and exists (select 1 from project_revision_heads h where h.project_id=new.project_id))
        or (new.reason<>'legacy_unavailable' and (
          new.revision<>coalesce((select h.revision+1 from project_revision_heads h where h.project_id=new.project_id),1)
          or not exists (
            select 1 from job_events e
            where e.event_id=new.anchor_event_id and e.project_id=new.project_id
              and json_valid(e.payload)=1 and json_type(e.payload,'$.projectRevision')='integer'
              and json_extract(e.payload,'$.projectRevision')=new.revision
          )
        ))
      begin select raise(abort, 'project revision receipt owner or sequence is invalid'); end;
    create trigger trg_project_revision_receipts_no_update before update on project_revision_receipts
      begin select raise(abort, 'project revision receipts are immutable'); end;
    create trigger trg_project_revision_receipts_no_delete before delete on project_revision_receipts
      begin select raise(abort, 'project revision receipts are immutable'); end;
    create trigger trg_project_revision_links_insert before insert on project_revision_event_links
      when not exists (
        select 1 from project_revision_receipts r join job_events e on e.event_id=new.event_id
        where r.id=new.receipt_id and r.project_id=new.project_id and r.revision=new.revision
          and e.project_id=new.project_id and json_valid(e.payload)=1
          and json_type(e.payload,'$.projectRevision')='integer'
          and json_extract(e.payload,'$.projectRevision')=new.revision
          and (e.type<>'project.snapshot.changed' or (
            json_type(e.payload,'$.data.snapshotVersion')='integer'
            and json_extract(e.payload,'$.data.snapshotVersion')=new.revision
          ))
      )
      begin select raise(abort, 'project revision event link is invalid'); end;
    create trigger trg_project_revision_links_no_update before update on project_revision_event_links
      begin select raise(abort, 'project revision event links are immutable'); end;
    create trigger trg_project_revision_links_no_delete before delete on project_revision_event_links
      begin select raise(abort, 'project revision event links are immutable'); end;
    create trigger trg_project_revision_heads_insert before insert on project_revision_heads
      when (new.revision=0 and new.last_receipt_id is not null)
        or (new.revision>0 and not exists (
          select 1 from project_revision_receipts r
          where r.id=new.last_receipt_id and r.project_id=new.project_id and r.revision=new.revision
        ))
      begin select raise(abort, 'project revision head receipt is invalid'); end;
    create trigger trg_project_revision_heads_update before update on project_revision_heads
      when new.project_id<>old.project_id or new.revision<>old.revision+1
        or not exists (
          select 1 from project_revision_receipts r
          where r.id=new.last_receipt_id and r.project_id=new.project_id and r.revision=new.revision
        )
      begin select raise(abort, 'project revision head transition is invalid'); end;
    create trigger trg_project_revision_heads_no_delete before delete on project_revision_heads
      begin select raise(abort, 'project revision heads cannot be deleted'); end;
    insert into project_revision_receipts
      (id,schema_version,project_id,revision,mutation_id,mutation_hash,anchor_event_id,reason,committed_at)
    select 'project-revision-v13-legacy:'||e.project_id||':'||json_extract(e.payload,'$.projectRevision'),
      1,e.project_id,cast(json_extract(e.payload,'$.projectRevision') as integer),
      'project-revision-v13-legacy:'||e.project_id||':'||json_extract(e.payload,'$.projectRevision'),
      null,null,'legacy_unavailable',min(e.created_at)
    from job_events e join projects_v2 p on p.id=e.project_id
    where json_valid(e.payload)=1 and json_type(e.payload,'$.projectRevision')='integer'
      and cast(json_extract(e.payload,'$.projectRevision') as integer)>0
    group by e.project_id,cast(json_extract(e.payload,'$.projectRevision') as integer)
    order by e.project_id,cast(json_extract(e.payload,'$.projectRevision') as integer);
    insert into project_revision_event_links (event_id,receipt_id,project_id,revision,linked_at)
    select e.event_id,
      'project-revision-v13-legacy:'||e.project_id||':'||json_extract(e.payload,'$.projectRevision'),
      e.project_id,cast(json_extract(e.payload,'$.projectRevision') as integer),e.created_at
    from job_events e join projects_v2 p on p.id=e.project_id
    where json_valid(e.payload)=1 and json_type(e.payload,'$.projectRevision')='integer'
      and cast(json_extract(e.payload,'$.projectRevision') as integer)>0;
    insert into project_revision_heads (project_id,revision,last_receipt_id,updated_at)
    select p.id,
      coalesce(max(r.revision),0),
      case when max(r.revision) is null then null
        else 'project-revision-v13-legacy:'||p.id||':'||max(r.revision) end,
      p.updated_at
    from projects_v2 p left join project_revision_receipts r on r.project_id=p.id
    group by p.id,p.updated_at;
    insert into schema_migrations (version, name, checksum_sha256, applied_at)
      values (13, 'operational-project-revisions-v13', '2770dab150f192287f74ad3229a5113804d28d2b66aaf7de62ded687a83b7537', datetime('now'));
  `);
}

export function assertStorageProjectRevisionV13SchemaReady(db: DatabaseSync): void {
  assertMigrationIdentity(migration(db));
  const tables = names(db, "select name from sqlite_master where type='table'");
  for (const name of TABLES) if (!tables.has(name)) throw new Error(`Storage project revision table is missing: ${name}`);
  const triggers = names(db, "select name from sqlite_master where type='trigger'");
  for (const name of TRIGGERS) if (!triggers.has(name)) throw new Error(`Storage project revision trigger is missing: ${name}`);
  assertColumns(db, "project_revision_heads", ["project_id", "revision", "last_receipt_id", "updated_at"]);
  assertColumns(db, "project_revision_receipts", ["project_id", "revision", "mutation_id", "mutation_hash", "anchor_event_id", "reason"]);
  assertColumns(db, "project_revision_event_links", ["event_id", "receipt_id", "project_id", "revision", "linked_at"]);
  assertProjectRevisionSemantics(db);
}

function assertProjectRevisionSemantics(db: DatabaseSync): void {
  const invalidHead = db
    .prepare(
      `
    select h.project_id from project_revision_heads h
    left join project_revision_receipts r on r.id=h.last_receipt_id
    where (h.revision=0 and h.last_receipt_id is not null)
      or (h.revision>0 and (r.id is null or r.project_id<>h.project_id or r.revision<>h.revision))
    limit 1
  `
    )
    .get() as { project_id?: unknown } | undefined;
  if (invalidHead) throw new Error(`Storage project revision head is inconsistent: ${String(invalidHead.project_id)}`);
  const missingHead = db
    .prepare(
      `
    select p.id from projects_v2 p left join project_revision_heads h on h.project_id=p.id
    where h.project_id is null limit 1
  `
    )
    .get() as { id?: unknown } | undefined;
  if (missingHead) throw new Error(`Storage project revision head is missing: ${String(missingHead.id)}`);
  const invalidLink = db
    .prepare(
      `
    select l.event_id from project_revision_event_links l
    left join project_revision_receipts r on r.id=l.receipt_id
    left join job_events e on e.event_id=l.event_id
    where r.id is null or r.project_id<>l.project_id or r.revision<>l.revision
      or e.event_id is null or e.project_id<>l.project_id or json_valid(e.payload)=0
      or json_type(e.payload,'$.projectRevision')<>'integer'
      or json_extract(e.payload,'$.projectRevision')<>l.revision
      or (e.type='project.snapshot.changed' and (
        json_type(e.payload,'$.data.snapshotVersion')<>'integer'
        or json_extract(e.payload,'$.data.snapshotVersion')<>l.revision
      ))
    limit 1
  `
    )
    .get() as { event_id?: unknown } | undefined;
  if (invalidLink) throw new Error(`Storage project revision event link is inconsistent: ${String(invalidLink.event_id)}`);
  const unlinkedEvent = db
    .prepare(
      `
    select e.event_id from job_events e
    left join project_revision_event_links l on l.event_id=e.event_id
    where json_valid(e.payload)=1 and json_type(e.payload,'$.projectRevision')='integer'
      and cast(json_extract(e.payload,'$.projectRevision') as integer)>0 and l.event_id is null
    limit 1
  `
    )
    .get() as { event_id?: unknown } | undefined;
  if (unlinkedEvent) throw new Error(`Storage project revision event receipt is missing: ${String(unlinkedEvent.event_id)}`);
}

function assertColumns(db: DatabaseSync, table: string, required: readonly string[]): void {
  const columns = names(db, `pragma table_info(${table})`);
  for (const name of required) if (!columns.has(name)) throw new Error(`Storage project revision column is missing: ${table}.${name}`);
}

function names(db: DatabaseSync, sql: string): Set<string> {
  return new Set((db.prepare(sql).all() as Array<{ name?: unknown }>).map((row) => String(row.name)));
}

function migration(db: DatabaseSync): { name?: unknown; checksum_sha256?: unknown } | undefined {
  return db.prepare("select name,checksum_sha256 from schema_migrations where version=?").get(STORAGE_PROJECT_REVISION_SCHEMA_VERSION) as
    { name?: unknown; checksum_sha256?: unknown } | undefined;
}

function assertMigrationIdentity(value: { name?: unknown; checksum_sha256?: unknown } | undefined): void {
  if (value?.name !== STORAGE_PROJECT_REVISION_MIGRATION_NAME || value.checksum_sha256 !== STORAGE_PROJECT_REVISION_MIGRATION_CHECKSUM) {
    throw new Error("Storage project revision migration ledger is missing or has an unexpected checksum.");
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
