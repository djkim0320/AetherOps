import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { storageCanonicalJson } from "./runStatePayloadValidator.js";
import { MAX_TERMINAL_JSON_BYTES, TerminalCasStore, type StorageTerminalCasObject } from "./terminalCasStore.js";

const MAX_READBACK_IDS = 256;
const MAX_JSON_COLLECTION_ITEMS = 4_096;

export interface StorageTerminalArtifactReadback extends StorageTerminalCasObject {
  id: string;
  projectId: string;
  contentHash: string;
}

export interface StorageTerminalEvidenceReadback extends StorageTerminalCasObject {
  id: string;
  projectId: string;
  contentHash: string;
}

export interface StorageTerminalValidationReadback extends StorageTerminalCasObject {
  id: string;
  projectId: string;
  contentHash: string;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  supportedClaims: string[];
  supportedClaimHashes: string[];
}

export interface StorageTerminalResultReadback {
  artifacts: Map<string, StorageTerminalArtifactReadback>;
  evidence: Map<string, StorageTerminalEvidenceReadback>;
  validations: Map<string, StorageTerminalValidationReadback>;
}

export interface StorageTerminalResultReadbackRequest {
  projectId: string;
  artifactIds: string[];
  evidenceIds: string[];
  validationResultIds: string[];
}

/**
 * Reads canonical terminal facts from a consistent research-DB snapshot and artifact file descriptors,
 * never from a verifier request. The operational transaction re-runs this read at promotion time because
 * the legacy research database cannot participate in the operational SQLite commit atomically.
 */
export class TerminalResultReadbackRepository {
  private readonly cas: TerminalCasStore;

  constructor(
    private readonly appDb: DatabaseSync,
    private readonly dataRoot?: string
  ) {
    this.cas = new TerminalCasStore(dataRoot);
  }

  read(request: StorageTerminalResultReadbackRequest): StorageTerminalResultReadback {
    const artifactIds = boundedIds(request.artifactIds, "artifact");
    const evidenceIds = boundedIds(request.evidenceIds, "evidence");
    const validationIds = boundedIds(request.validationResultIds, "validation result");
    if (!artifactIds.length && !evidenceIds.length && !validationIds.length) {
      return { artifacts: new Map(), evidence: new Map(), validations: new Map() };
    }
    const databasePath = this.requiredResearchDatabasePath();
    const db = openReadOnly(databasePath);
    try {
      db.exec("begin");
      const artifacts = new Map(
        this.readRows(db, "artifacts", request.projectId, artifactIds).map((value) => {
          const readback = this.readArtifact(request.projectId, value);
          return [readback.id, readback] as const;
        })
      );
      const evidence = new Map(
        this.readRows(db, "evidence", request.projectId, evidenceIds).map((value) => {
          const readback = readEvidence(request.projectId, value, this.cas);
          return [readback.id, readback] as const;
        })
      );
      const validations = new Map(
        this.readRows(db, "validation_results", request.projectId, validationIds).map((value) => {
          const readback = readValidation(request.projectId, value, this.cas);
          return [readback.id, readback] as const;
        })
      );
      db.exec("commit");
      return { artifacts, evidence, validations };
    } catch (error) {
      if (db.isTransaction) db.exec("rollback");
      throw error;
    } finally {
      db.close();
    }
  }

  private readArtifact(projectId: string, value: Record<string, unknown>): StorageTerminalArtifactReadback {
    const id = identity(value, projectId, "artifact");
    try {
      const projectRoot = this.requiredProjectRoot(projectId);
      const relativePath = requiredText(value.relativePath, `artifact ${id} relative path`);
      const materialized = materializeProjectFile(projectRoot, relativePath, this.cas);
      const contentHash = materialized.casHash;
      const metadata = requiredObject(value.metadata, `artifact ${id} metadata`);
      if (requiredHash(metadata.sha256, `artifact ${id} persisted SHA-256`) !== contentHash) {
        throw new Error("hash mismatch");
      }
      return { id, projectId, contentHash, ...materialized };
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code) : "INTEGRITY";
      throw new Error(`Canonical terminal artifact persisted-byte readback failed (${code}): ${id}`, { cause: error });
    }
  }

  private readRows(db: DatabaseSync, table: string, projectId: string, ids: string[]): Record<string, unknown>[] {
    if (!ids.length) return [];
    assertTable(db, table);
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(`select id,project_id,data from ${table} where project_id=? and id in (${placeholders}) order by id`)
      .all(projectId, ...ids) as Array<{ id?: unknown; project_id?: unknown; data?: unknown }>;
    if (rows.length !== ids.length) throw new Error(`Canonical terminal ${table} readback is missing.`);
    return rows.map((row) => {
      const value = parseObject(row.data, `canonical terminal ${table} readback`);
      if (row.id !== value.id || row.project_id !== projectId || value.projectId !== projectId) {
        throw new Error(`Canonical terminal ${table} readback identity is inconsistent.`);
      }
      return value;
    });
  }

  private requiredProjectRoot(projectId: string): string {
    const row = this.appDb.prepare("select project_root from projects_v2 where id=?").get(projectId) as { project_root?: unknown } | undefined;
    const root = resolve(requiredText(row?.project_root, `project ${projectId} root`));
    let stat;
    try {
      stat = lstatSync(root);
    } catch {
      throw new Error(`Canonical terminal project root readback failed: ${projectId}`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Canonical terminal project root is not a regular directory.");
    const realRoot = realpathSync.native(root);
    const owners = this.appDb.prepare("select id,project_root from projects_v2 order by id").all() as Array<{
      id?: unknown;
      project_root?: unknown;
    }>;
    for (const owner of owners) {
      if (owner.id === projectId) continue;
      if (typeof owner.id !== "string" || typeof owner.project_root !== "string" || !owner.project_root) {
        throw new Error("Canonical terminal project root ownership is ambiguous.");
      }
      const ownerPath = resolve(owner.project_root);
      try {
        const ownerStat = lstatSync(ownerPath);
        if (!ownerStat.isDirectory() || ownerStat.isSymbolicLink()) throw new Error("invalid owner root");
        const ownerRoot = realpathSync.native(ownerPath);
        if (projectRootsOverlap(realRoot, ownerRoot)) {
          throw new Error("Canonical terminal project root ownership is ambiguous.");
        }
      } catch (error) {
        if (error instanceof Error && error.message === "Canonical terminal project root ownership is ambiguous.") throw error;
        if ((error as { code?: unknown })?.code === "ENOENT" && !projectRootsOverlap(realRoot, platformPath(ownerPath))) continue;
        throw new Error("Canonical terminal project root ownership is ambiguous.", { cause: error });
      }
    }
    return root;
  }

  private requiredResearchDatabasePath(): string {
    if (!this.dataRoot) throw new Error("Canonical terminal research readback is unavailable because the storage data root is not configured.");
    const path = join(resolve(this.dataRoot), "migration", "v2", "legacy-research.sqlite");
    if (!existsSync(path)) throw new Error("Canonical terminal persisted research database is unavailable.");
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      throw new Error("Canonical terminal persisted research database readback failed.");
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Canonical terminal persisted research database is not a regular file.");
    return path;
  }
}

function readEvidence(projectId: string, value: Record<string, unknown>, cas: TerminalCasStore): StorageTerminalEvidenceReadback {
  const id = identity(value, projectId, "evidence");
  const payload = {
    id,
    projectId,
    category: value.category,
    title: value.title,
    summary: value.summary,
    sourceId: value.sourceId,
    sourceUri: value.sourceUri,
    citation: value.citation,
    quote: value.quote,
    doi: value.doi,
    keywords: sortedStrings(value.keywords, `evidence ${id} keywords`),
    linkedHypothesisIds: sortedStrings(value.linkedHypothesisIds, `evidence ${id} hypothesis links`),
    reliabilityScore: value.reliabilityScore,
    relevanceScore: value.relevanceScore,
    evidenceStrength: value.evidenceStrength,
    limitations: sortedStrings(value.limitations ?? [], `evidence ${id} limitations`),
    createdAt: value.createdAt
  };
  const bytes = Buffer.from(storageCanonicalJson(payload), "utf8");
  const materialized = cas.materializeBytes(bytes);
  return { id, projectId, contentHash: materialized.casHash, ...materialized };
}

function readValidation(projectId: string, value: Record<string, unknown>, cas: TerminalCasStore): StorageTerminalValidationReadback {
  const id = identity(value, projectId, "validation result");
  if (value.status !== "supported") throw new Error(`Canonical terminal validation result ${id} is not supported.`);
  const supportingEvidenceIds = sortedStrings(value.supportingEvidenceIds, `validation result ${id} supporting evidence`);
  const contradictingEvidenceIds = sortedStrings(value.contradictingEvidenceIds, `validation result ${id} contradicting evidence`);
  if (!supportingEvidenceIds.length) throw new Error(`Canonical terminal validation result ${id} has no supporting evidence.`);
  if (supportingEvidenceIds.some((evidenceId) => contradictingEvidenceIds.includes(evidenceId))) {
    throw new Error(`Canonical terminal validation result ${id} has contradictory provenance ownership.`);
  }
  const scorecard = value.claimScorecard === undefined ? undefined : requiredObject(value.claimScorecard, `validation result ${id} scorecard`);
  const claims = scorecard?.claims;
  if (claims !== undefined && !Array.isArray(claims)) throw new Error(`Canonical terminal validation result ${id} claims are malformed.`);
  const supportedClaims = (claims ?? [])
    .map((claim) => requiredObject(claim, `validation result ${id} claim`))
    .filter((claim) => claim.status === "supported")
    .map((claim) => validatedSupportedClaim(id, claim, supportingEvidenceIds))
    .sort();
  if (!supportedClaims.length) throw new Error(`Canonical terminal validation result ${id} has no strictly supported claim.`);
  const bytes = Buffer.from(storageCanonicalJson(value), "utf8");
  const materialized = cas.materializeBytes(bytes);
  return {
    id,
    projectId,
    contentHash: materialized.casHash,
    supportingEvidenceIds,
    contradictingEvidenceIds,
    supportedClaims,
    supportedClaimHashes: supportedClaims.map((claim) => createHash("sha256").update(claim, "utf8").digest("hex")),
    ...materialized
  };
}

function projectRootsOverlap(left: string, right: string): boolean {
  const normalizedLeft = platformPath(left);
  const normalizedRight = platformPath(right);
  return isSameOrDescendant(relative(normalizedLeft, normalizedRight)) || isSameOrDescendant(relative(normalizedRight, normalizedLeft));
}

function platformPath(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function isSameOrDescendant(value: string): boolean {
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}

function materializeProjectFile(projectRoot: string, relativePath: string, cas: TerminalCasStore): StorageTerminalCasObject {
  if (isAbsolute(relativePath)) throw new Error("Canonical terminal artifact path must be project-relative.");
  const path = resolve(projectRoot, relativePath);
  const scoped = relative(projectRoot, path);
  if (!scoped || scoped.startsWith("..") || isAbsolute(scoped)) throw new Error("Canonical terminal artifact path escapes the project root.");
  const realRoot = realpathSync.native(projectRoot);
  let current = projectRoot;
  for (const segment of scoped.split(sep)) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("Canonical terminal artifact path contains a symbolic link.");
  }
  const realPath = realpathSync.native(path);
  const realScoped = relative(realRoot, realPath);
  if (!realScoped || realScoped.startsWith("..") || isAbsolute(realScoped)) throw new Error("Canonical terminal artifact real path escapes the project root.");
  const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error("Canonical terminal artifact readback is not a regular file.");
    const materialized = cas.materializeOpenFile(fd);
    const after = fstatSync(fd, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      realpathSync.native(path) !== realPath
    ) {
      throw new Error("Canonical terminal artifact changed during persisted-byte readback.");
    }
    return materialized;
  } finally {
    closeSync(fd);
  }
}

function openReadOnly(path: string): DatabaseSync {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    throw new Error("Canonical terminal persisted research database could not be opened read-only.");
  }
}

function boundedIds(values: string[], label: string): string[] {
  if (values.length > MAX_READBACK_IDS) throw new Error(`Canonical terminal ${label} readback exceeds the bounded limit.`);
  if (values.some((value) => !value || value.length > 320)) {
    throw new Error(`Canonical terminal ${label} readback identities are malformed.`);
  }
  const ids = [...new Set(values)].sort();
  return ids;
}

function assertTable(db: DatabaseSync, table: string): void {
  if (!db.prepare("select 1 from sqlite_master where type='table' and name=?").get(table)) {
    throw new Error(`Canonical terminal persisted ${table} table is unavailable.`);
  }
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string") throw new Error(`${label} is not JSON text.`);
  if (Buffer.byteLength(value, "utf8") > MAX_TERMINAL_JSON_BYTES) throw new Error(`${label} exceeds the bounded JSON byte limit.`);
  try {
    return requiredObject(JSON.parse(value), label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} contains malformed JSON.`, { cause: error });
    throw error;
  }
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed.`);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length) throw new Error(`${label} is missing.`);
  return value;
}

function requiredHash(value: unknown, label: string): string {
  const hash = requiredText(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${label} is malformed.`);
  return hash;
}

function sortedStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) throw new Error(`${label} are malformed.`);
  if (value.length > MAX_JSON_COLLECTION_ITEMS || value.some((entry) => entry.length > 10_000)) {
    throw new Error(`${label} exceed the bounded collection limit.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} are not unique.`);
  return [...value].sort();
}

function identity(value: Record<string, unknown>, projectId: string, label: string): string {
  const id = requiredText(value.id, `${label} id`);
  if (value.projectId !== projectId) throw new Error(`Canonical terminal ${label} belongs to a different project.`);
  return id;
}

export function normalizeTerminalClaim(value: string): string {
  return normalizeClaim(value);
}

function normalizeClaim(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function validatedSupportedClaim(id: string, claim: Record<string, unknown>, topLevelEvidence: string[]): string {
  const correctness = requiredObject(claim.correctness, `validation result ${id} correctness`);
  const citation = requiredObject(claim.citationFaithfulness, `validation result ${id} citation faithfulness`);
  const supporting = sortedStrings(correctness.supportingEvidenceIds, `validation result ${id} claim supporting evidence`);
  const contradicting = sortedStrings(correctness.contradictingEvidenceIds ?? [], `validation result ${id} claim contradicting evidence`);
  const cited = sortedStrings(citation.citedEvidenceIds, `validation result ${id} cited evidence`);
  const faithful = sortedStrings(citation.faithfulEvidenceIds, `validation result ${id} faithful evidence`);
  const unfaithful = sortedStrings(citation.unfaithfulEvidenceIds ?? [], `validation result ${id} unfaithful evidence`);
  const confidence = correctness.confidence;
  if (
    correctness.status !== "supported" ||
    citation.status !== "faithful" ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    contradicting.length ||
    unfaithful.length ||
    !sameStrings(supporting, topLevelEvidence) ||
    !sameStrings(cited, supporting) ||
    !sameStrings(faithful, supporting)
  ) {
    throw new Error(`Canonical terminal validation result ${id} has invalid support provenance.`);
  }
  return normalizeClaim(requiredText(claim.claim, `validation result ${id} supported claim`));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
