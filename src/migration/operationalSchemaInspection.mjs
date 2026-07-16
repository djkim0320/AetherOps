export function assertColumnsForInspection(db, table, required, errors) {
  if (!tableExists(db, table)) return;
  const columns = columnNames(db, table);
  for (const name of required) if (!columns.has(name)) errors.push(`Operational column is missing: ${table}.${name}`);
}

export function assertIndexesForInspection(db, table, required, errors) {
  if (!tableExists(db, table)) return;
  const indexes = new Set(
    db
      .prepare(`pragma index_list(${table})`)
      .all()
      .map((row) => String(row.name))
  );
  for (const name of required) if (!indexes.has(name)) errors.push(`Operational index is missing: ${name}`);
}

export function assertTriggersForInspection(db, required, errors) {
  const triggers = new Set(
    db
      .prepare("select name from sqlite_master where type='trigger'")
      .all()
      .map((row) => String(row.name))
  );
  for (const name of required) if (!triggers.has(name)) errors.push(`Operational trigger is missing: ${name}`);
}

export function assertForeignKeysForInspection(db, table, required, errors) {
  if (!tableExists(db, table)) return;
  const targets = new Set(
    db
      .prepare(`pragma foreign_key_list(${table})`)
      .all()
      .map((row) => String(row.table))
  );
  for (const target of required) if (!targets.has(target)) errors.push(`Operational foreign key is missing: ${table}->${target}`);
}

export function tableExists(db, name) {
  return Boolean(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name));
}

export function columnNames(db, table) {
  return new Set(
    db
      .prepare(`pragma table_info(${table})`)
      .all()
      .map((row) => String(row.name))
  );
}
