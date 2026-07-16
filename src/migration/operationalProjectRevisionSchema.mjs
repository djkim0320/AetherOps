import {
  assertColumnsForInspection,
  assertForeignKeysForInspection,
  assertIndexesForInspection,
  assertTriggersForInspection,
  tableExists
} from "./operationalSchemaInspection.mjs";
import { sha256Hex } from "./hash.mjs";

export const PROJECT_REVISION_TABLES = ["project_revision_heads", "project_revision_receipts", "project_revision_event_links"];
export const PROJECT_REVISION_TRIGGERS = [
  "trg_project_revision_receipts_insert",
  "trg_project_revision_receipts_no_update",
  "trg_project_revision_receipts_no_delete",
  "trg_project_revision_links_insert",
  "trg_project_revision_links_no_update",
  "trg_project_revision_links_no_delete",
  "trg_project_revision_heads_insert",
  "trg_project_revision_heads_update",
  "trg_project_revision_heads_no_delete"
];

export function inspectProjectRevisionSchema(db, errors) {
  for (const table of PROJECT_REVISION_TABLES) if (!tableExists(db, table)) errors.push(`Operational table is missing: ${table}`);
  assertColumnsForInspection(db, "project_revision_heads", ["project_id", "revision", "last_receipt_id", "updated_at"], errors);
  assertColumnsForInspection(
    db,
    "project_revision_receipts",
    ["id", "schema_version", "project_id", "revision", "mutation_id", "mutation_hash", "anchor_event_id", "reason", "committed_at"],
    errors
  );
  assertColumnsForInspection(db, "project_revision_event_links", ["event_id", "receipt_id", "project_id", "revision", "linked_at"], errors);
  assertIndexesForInspection(db, "project_revision_receipts", ["idx_project_revision_receipts_project_revision"], errors);
  assertIndexesForInspection(db, "project_revision_event_links", ["idx_project_revision_links_receipt"], errors);
  assertForeignKeysForInspection(db, "project_revision_heads", ["projects_v2", "project_revision_receipts"], errors);
  assertForeignKeysForInspection(db, "project_revision_receipts", ["projects_v2", "job_events"], errors);
  assertForeignKeysForInspection(db, "project_revision_event_links", ["projects_v2", "job_events", "project_revision_receipts"], errors);
  assertTriggersForInspection(db, PROJECT_REVISION_TRIGGERS, errors);
  if (PROJECT_REVISION_TABLES.every((table) => tableExists(db, table))) inspectSemantics(db, errors);
}

function inspectSemantics(db, errors) {
  const heads = new Map(
    db
      .prepare("select * from project_revision_heads order by project_id")
      .all()
      .map((row) => [String(row.project_id), row])
  );
  for (const row of db.prepare("select id from projects_v2 order by id").all()) {
    if (!heads.has(String(row.id))) errors.push(`Project revision head is missing: ${row.id}`);
  }
  const receipts = new Map(
    db
      .prepare("select * from project_revision_receipts order by project_id,revision")
      .all()
      .map((row) => [String(row.id), row])
  );
  for (const [projectId, head] of heads) {
    const receipt = head.last_receipt_id === null ? undefined : receipts.get(String(head.last_receipt_id));
    if (
      (Number(head.revision) === 0 && receipt) ||
      (Number(head.revision) > 0 && (!receipt || receipt.project_id !== projectId || Number(receipt.revision) !== Number(head.revision)))
    ) {
      errors.push(`Project revision head is inconsistent: ${projectId}`);
    }
  }
  const linkedEvents = new Map();
  for (const row of db
    .prepare(
      `select l.*,e.job_id,e.type,e.payload from project_revision_event_links l join job_events e on e.event_id=l.event_id order by l.receipt_id,l.event_id`
    )
    .all()) {
    const receipt = receipts.get(String(row.receipt_id));
    const payload = parseObject(row.payload, `project revision event ${row.event_id}`, errors);
    if (
      !receipt ||
      receipt.project_id !== row.project_id ||
      Number(receipt.revision) !== Number(row.revision) ||
      !payload ||
      payload.projectRevision !== row.revision ||
      (row.type === "project.snapshot.changed" && payload.data?.snapshotVersion !== row.revision)
    ) {
      errors.push(`Project revision event link is inconsistent: ${row.event_id}`);
      continue;
    }
    const events = linkedEvents.get(String(row.receipt_id)) ?? [];
    events.push({ eventId: row.event_id, jobId: row.job_id ?? null, type: row.type, payload });
    linkedEvents.set(String(row.receipt_id), events);
  }
  for (const receipt of receipts.values()) {
    if (receipt.reason === "legacy_unavailable") continue;
    const events = linkedEvents.get(String(receipt.id)) ?? [];
    const mutationHash = runtimeCanonicalHash({ projectId: receipt.project_id, revision: receipt.revision, events });
    if (
      !events.length ||
      receipt.anchor_event_id !== events[0]?.eventId ||
      receipt.mutation_hash !== mutationHash ||
      receipt.id !== `project-revision-receipt:${mutationHash}` ||
      receipt.mutation_id !== `project-revision-mutation:${mutationHash}`
    ) {
      errors.push(`Project revision receipt hash or event set is inconsistent: ${receipt.id}`);
    }
  }
  const unlinked = db
    .prepare(
      `
    select e.event_id from job_events e left join project_revision_event_links l on l.event_id=e.event_id
    where json_valid(e.payload)=1 and json_type(e.payload,'$.projectRevision')='integer'
      and cast(json_extract(e.payload,'$.projectRevision') as integer)>0 and l.event_id is null
    limit 1
  `
    )
    .get();
  if (unlinked) errors.push(`Project revision event receipt is missing: ${unlinked.event_id}`);
}

function parseObject(value, label, errors) {
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    errors.push(`Persisted ${label} JSON is invalid.`);
    return undefined;
  }
}

function runtimeCanonicalHash(value) {
  return sha256Hex(runtimeCanonicalJson(value));
}

function runtimeCanonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Persisted project revision hashing rejects non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => runtimeCanonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${runtimeCanonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`Persisted project revision hashing rejects unsupported value type: ${typeof value}`);
}
