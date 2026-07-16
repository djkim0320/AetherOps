import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStorageV2Repositories, type StorageV2RepositoryOptions, type StorageV2RepositorySet } from "./repositories.js";
import { assertStorageV2SchemaReady, preflightFts5 } from "./schema.js";
import type { StorageV2OpenOptions } from "./types.js";

export class StorageV2Database {
  readonly appDb: DatabaseSync;
  readonly vectorDb: DatabaseSync;
  readonly ontologyDb: DatabaseSync;
  readonly repositories: StorageV2RepositorySet;
  readonly dataRoot?: string;

  private readonly dbs: DatabaseSync[];
  private closed = false;

  constructor(options: StorageV2OpenOptions, repositoryOptions: StorageV2RepositoryOptions = {}) {
    this.dataRoot = options.dataRoot;
    this.appDb = openDatabase(options.appDbPath);
    this.vectorDb = options.vectorDbPath && options.vectorDbPath !== options.appDbPath ? openDatabase(options.vectorDbPath) : this.appDb;
    this.ontologyDb =
      options.ontologyDbPath && options.ontologyDbPath !== options.appDbPath && options.ontologyDbPath !== options.vectorDbPath
        ? openDatabase(options.ontologyDbPath)
        : options.ontologyDbPath === options.vectorDbPath
          ? this.vectorDb
          : this.appDb;

    this.dbs = uniqueDbs([this.appDb, this.vectorDb, this.ontologyDb]);
    try {
      for (const db of this.dbs) {
        if (options.requireFts5 !== false) preflightFts5(db);
        assertStorageV2SchemaReady(db);
      }
      this.repositories = createStorageV2Repositories(
        {
          appDb: this.appDb,
          vectorDb: this.vectorDb,
          ontologyDb: this.ontologyDb
        },
        { ...repositoryOptions, dataRoot: options.dataRoot }
      );
      this.repositories.projects.assertOwnershipIntegrity();
    } catch (error) {
      for (const db of [...this.dbs].reverse()) db.close();
      this.closed = true;
      throw error;
    }
  }

  transaction<T>(work: (repositories: StorageV2RepositorySet) => T): T {
    if (this.dbs.length !== 1) {
      throw new Error("Atomic storage batch cannot span app, vector, and ontology databases; use an idempotent operation-journal saga.");
    }
    const db = this.dbs[0] as DatabaseSync;
    db.exec("begin immediate");
    try {
      this.repositories.projectRevisions.beginMutationScope();
      const result = work(this.repositories);
      this.repositories.projectRevisions.finalizeMutationScope();
      db.exec("commit");
      return result;
    } catch (error) {
      this.repositories.projectRevisions.abortMutationScope();
      if (db.isTransaction) db.exec("rollback");
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    try {
      this.repositories.terminalAttestedReadback.close();
    } finally {
      for (const db of [...this.dbs].reverse()) db.close();
      this.closed = true;
    }
  }
}

function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("pragma foreign_keys=on");
    const row = db.prepare("pragma foreign_keys").get() as { foreign_keys?: unknown } | undefined;
    if (Number(row?.foreign_keys) !== 1) throw new Error("Foreign-key enforcement readback is disabled.");
    return db;
  } catch (error) {
    db.close();
    throw new Error("Storage database foreign-key enforcement is unavailable.", { cause: error });
  }
}

function uniqueDbs(dbs: readonly DatabaseSync[]): DatabaseSync[] {
  const output: DatabaseSync[] = [];
  for (const db of dbs) {
    if (!output.includes(db)) output.push(db);
  }
  return output;
}
