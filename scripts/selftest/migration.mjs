import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { countFiles, countMatchingFiles, hasDataColumn, hasMissingRequiredPath, quoteSqlIdentifier, safeReaddir } from "./runtime.mjs";

export async function prepareDataRoot(context) {
  const tempRoot = resolve(context.repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  if (lstatSync(tempRoot).isSymbolicLink()) {
    throw new Error(`Refusing to use a symbolic-link self-test temp root: ${tempRoot}`);
  }
  const tempRelativeDataRoot = relative(tempRoot, context.dataRoot);
  const isSingleSelfTestDirectory = /^[^/\\]+$/.test(tempRelativeDataRoot) && /^aetherops-selftest(?:-|$)/.test(tempRelativeDataRoot);
  if (!isSingleSelfTestDirectory || tempRelativeDataRoot.startsWith("..") || isAbsolute(tempRelativeDataRoot)) {
    throw new Error(`Self-test data root must be a dedicated .tmp/aetherops-selftest* directory: ${context.dataRoot}`);
  }
  if (existsSync(context.dataRoot) && lstatSync(context.dataRoot).isSymbolicLink()) {
    throw new Error(`Refusing to clear a symbolic-link self-test data root: ${context.dataRoot}`);
  }
  rmSync(context.dataRoot, { recursive: true, force: true });
  mkdirSync(context.dataRoot, { recursive: true });
}

export async function validateArtifactsAndDb(context) {
  const storageRoot = activeStorageRoot(context.dataRoot);
  const dbPaths = [
    join(context.dataRoot, "aetherops.sqlite"),
    join(storageRoot, "storage.sqlite"),
    join(storageRoot, "legacy-research.sqlite"),
    join(storageRoot, "main", "main.sqlite"),
    join(storageRoot, "main", "vector.sqlite"),
    join(storageRoot, "main", "ontology.sqlite")
  ];
  const projectsRoot = join(context.dataRoot, "projects");
  if (existsSync(projectsRoot)) {
    for (const name of safeReaddir(projectsRoot)) {
      const projectDb = join(projectsRoot, name, "project.sqlite");
      if (existsSync(projectDb)) dbPaths.push(projectDb);
    }
  }
  const dbSummaries = [];
  let rawTextHits = 0;
  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tableRows = db.prepare("select name from sqlite_master where type='table' order by name").all();
      const counts = {};
      for (const row of tableRows) {
        const table = row.name;
        const quotedTable = quoteSqlIdentifier(table);
        counts[table] = db.prepare(`select count(*) as n from ${quotedTable}`).get().n;
        if (hasDataColumn(db, quotedTable)) {
          rawTextHits += db.prepare(`select count(*) as n from ${quotedTable} where data like '%rawText%'`).get().n;
        }
      }
      dbSummaries.push({ path: relative(context.dataRoot, dbPath), counts });
    } finally {
      db.close();
    }
  }
  const requiredPaths = [
    join(storageRoot, "storage.sqlite"),
    join(storageRoot, "main", "main.sqlite"),
    join(storageRoot, "main", "vector.sqlite"),
    join(storageRoot, "main", "ontology.sqlite"),
    join(storageRoot, "main", "files", "sources"),
    projectsRoot
  ].map((path) => ({ path: relative(context.dataRoot, path), exists: existsSync(path) }));
  context.results.artifacts = {
    requiredPaths,
    dbSummaries,
    rawTextHits,
    mainSourceFiles: countFiles(join(storageRoot, "main", "files", "sources")),
    projectWebSourceFiles: countMatchingFiles(projectsRoot, /[\\/]sources[\\/]web[\\/]/)
  };
  if (hasMissingRequiredPath(requiredPaths)) context.results.findings.medium.push("One or more expected self-test data paths were not created.");
  if (rawTextHits > 0) context.results.findings.high.push(`rawText payload found in SQLite JSON rows: ${rawTextHits}.`);
}

function activeStorageRoot(dataRoot) {
  const currentPath = join(dataRoot, "migration", "current.json");
  if (!existsSync(currentPath)) return dataRoot;
  const current = JSON.parse(readFileSync(currentPath, "utf8"));
  const targetRoot = resolve(String(current.targetRoot ?? ""));
  const targetRelative = relative(dataRoot, targetRoot);
  if (!targetRelative || targetRelative.startsWith("..") || isAbsolute(targetRelative)) {
    throw new Error(`Migration target root is outside the self-test data root: ${targetRoot}`);
  }
  return targetRoot;
}
