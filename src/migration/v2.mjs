import { existsSync } from "node:fs";
import { stableJsonHash, stableStringify } from "./hash.mjs";
import {
  copyJobs,
  copyJobEvents,
  copyCheckpoints,
  copyStepAttempts,
  copyCapabilityAudits,
  copyOntologyRuns,
  copyOntologyEntities,
  copyOntologyRelations,
  copyOntologyConstraints
} from "./v2OperationalTables.mjs";
import { summarizeTable, readRows, parseJsonField, shortProjectId, float32EmbeddingToBlob } from "./v2Support.mjs";
import {
  buildV2SchemaFingerprint,
  buildDatabaseVerification,
  createV2Database,
  openDatabase,
  readUserTableSummaries,
  sqliteSchemaFingerprint
} from "./sqlite.mjs";

export function migrateV1AppDbToV2(sourceDbPath, targetDbPath) {
  const sourceExists = existsSync(sourceDbPath);
  const sourceDb = sourceExists ? openDatabase(sourceDbPath) : undefined;
  const targetDb = createV2Database(targetDbPath, {
    schemaVersion: 2,
    sourceSchemaFingerprint: sourceExists ? sqliteSchemaFingerprint(sourceDbPath) : undefined,
    expectedSchemaFingerprint: buildV2SchemaFingerprint()
  });
  const copySummary = [];
  try {
    if (!sourceDb) {
      copySummary.push({ table: "source", copied: 0 });
      return {
        sourcePresent: false,
        targetPath: targetDbPath,
        targetSchemaFingerprint: sqliteSchemaFingerprint(targetDb),
        schemaFingerprint: buildV2SchemaFingerprint(),
        verification: buildDatabaseVerification(targetDb),
        tables: copySummary
      };
    }

    targetDb.exec("begin immediate");
    try {
      copySummary.push(copyProjects(sourceDb, targetDb));
      copySummary.push(copyRecords(sourceDb, targetDb));
      copySummary.push(copyMemoryItems(sourceDb, targetDb));
      copySummary.push(copyJobs(sourceDb, targetDb));
      copySummary.push(copyJobEvents(sourceDb, targetDb));
      copySummary.push(copyCheckpoints(sourceDb, targetDb));
      copySummary.push(copyStepAttempts(sourceDb, targetDb));
      copySummary.push(copyCapabilityAudits(sourceDb, targetDb));
      copySummary.push(copyOntologyRuns(sourceDb, targetDb));
      copySummary.push(copyOntologyEntities(sourceDb, targetDb));
      copySummary.push(copyOntologyRelations(sourceDb, targetDb));
      copySummary.push(copyOntologyConstraints(sourceDb, targetDb));
      copySummary.push(copyChunkEmbeddings(sourceDb, targetDb));
      targetDb.exec("commit");
    } catch (error) {
      targetDb.exec("rollback");
      throw error;
    }

    const sourceSummary = summarizeV1Source(sourceDb);
    return {
      sourcePresent: true,
      targetPath: targetDbPath,
      targetSchemaFingerprint: sqliteSchemaFingerprint(targetDb),
      schemaFingerprint: buildV2SchemaFingerprint(),
      verification: buildDatabaseVerification(targetDb),
      tables: copySummary,
      sourceTables: sourceSummary.tables,
      sourceDatabaseHash: sourceSummary.rawSha256
    };
  } finally {
    sourceDb?.close();
    targetDb.close();
  }
}

export function summarizeV1Source(sourceDb) {
  return {
    rawSha256: stableJsonHash(readUserTableSummaries(sourceDb)),
    tables: readUserTableSummaries(sourceDb)
  };
}

function copyProjects(sourceDb, targetDb) {
  const rows = readRows(sourceDb, "projects");
  const statement = targetDb.prepare(
    `
      insert into projects_v2 (
        id, short_id, project_root, topic, status, current_step, created_at, updated_at, data
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        short_id = excluded.short_id,
        project_root = excluded.project_root,
        topic = excluded.topic,
        status = excluded.status,
        current_step = excluded.current_step,
        updated_at = excluded.updated_at,
        data = excluded.data
    `
  );
  for (const row of rows) {
    const project = parseJsonField(row.data, "projects.data");
    statement.run(
      project.id,
      shortProjectId(project.id),
      project.projectRoot,
      project.topic,
      project.status,
      project.currentStep ?? null,
      project.createdAt,
      project.updatedAt,
      stableStringify(project)
    );
  }
  targetDb.exec(`insert into project_revision_heads(project_id,revision,last_receipt_id,updated_at)
    select id,0,null,updated_at from projects_v2 where true on conflict(project_id) do nothing`);
  return summarizeTable("projects", rows, "projects_v2");
}

function copyRecords(sourceDb, targetDb) {
  const rows = readRows(sourceDb, "normalized_records");
  const statement = targetDb.prepare(
    `
      insert into records_v2 (
        id, project_id, workspace_project_id, source_project_id, kind, memory_scope, validation_status,
        title, content, source_id, artifact_id, evidence_id, citation, created_at, data
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        project_id = excluded.project_id,
        workspace_project_id = excluded.workspace_project_id,
        source_project_id = excluded.source_project_id,
        kind = excluded.kind,
        memory_scope = excluded.memory_scope,
        validation_status = excluded.validation_status,
        title = excluded.title,
        content = excluded.content,
        source_id = excluded.source_id,
        artifact_id = excluded.artifact_id,
        evidence_id = excluded.evidence_id,
        citation = excluded.citation,
        created_at = excluded.created_at,
        data = excluded.data
    `
  );
  for (const row of rows) {
    const record = parseJsonField(row.data, "normalized_records.data");
    statement.run(
      record.id,
      record.projectId,
      record.workspaceProjectId ?? null,
      record.sourceProjectId ?? record.originProjectId ?? null,
      record.kind,
      record.memoryScope,
      record.validationStatus,
      record.title,
      record.content,
      record.sourceId ?? null,
      record.artifactId ?? null,
      record.evidenceId ?? null,
      record.citation ?? null,
      record.createdAt,
      stableStringify(record)
    );
  }
  return summarizeTable("normalized_records", rows, "records_v2");
}

function copyMemoryItems(sourceDb, targetDb) {
  const chunkRows = readRows(sourceDb, "chunks");
  const globalRows = readRows(sourceDb, "global_memory_items");
  const statement = targetDb.prepare(
    `
      insert into memory_items_v2 (
        id, project_id, workspace_project_id, source_project_id, kind, memory_scope, validation_status,
        title, content, source_id, record_id, evidence_id, created_at, data
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        project_id = excluded.project_id,
        workspace_project_id = excluded.workspace_project_id,
        source_project_id = excluded.source_project_id,
        kind = excluded.kind,
        memory_scope = excluded.memory_scope,
        validation_status = excluded.validation_status,
        title = excluded.title,
        content = excluded.content,
        source_id = excluded.source_id,
        record_id = excluded.record_id,
        evidence_id = excluded.evidence_id,
        created_at = excluded.created_at,
        data = excluded.data
    `
  );
  for (const row of globalRows) {
    const item = parseJsonField(row.data, "global_memory_items.data");
    statement.run(
      item.id,
      item.projectId,
      null,
      item.sourceProjectId ?? null,
      "global_item",
      item.memoryScope ?? "global",
      item.validationStatus,
      item.title,
      item.content,
      null,
      null,
      null,
      item.createdAt,
      stableStringify(item)
    );
  }
  for (const row of chunkRows) {
    const chunk = parseJsonField(row.data, "chunks.data");
    statement.run(
      chunk.id,
      chunk.projectId,
      chunk.workspaceProjectId ?? null,
      chunk.sourceProjectId ?? chunk.originProjectId ?? null,
      "chunk",
      chunk.memoryScope ?? "project_only",
      chunk.validationStatus ?? "indexed",
      `${chunk.sourceId}:${chunk.chunkIndex}`,
      chunk.text,
      chunk.sourceId ?? null,
      chunk.recordId ?? null,
      chunk.evidenceId ?? null,
      chunk.createdAt,
      stableStringify(chunk)
    );
  }
  return {
    table: "memory_items",
    copied: chunkRows.length + globalRows.length
  };
}

function copyChunkEmbeddings(sourceDb, targetDb) {
  const rows = readRows(sourceDb, "chunks");
  const statement = targetDb.prepare(
    `
      insert into embeddings_v2 (
        id, project_id, owner_table, owner_id, scope, dimensions, provider, model, embedding, created_at, updated_at, data
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        project_id = excluded.project_id,
        owner_table = excluded.owner_table,
        owner_id = excluded.owner_id,
        scope = excluded.scope,
        dimensions = excluded.dimensions,
        provider = excluded.provider,
        model = excluded.model,
        embedding = excluded.embedding,
        updated_at = excluded.updated_at,
        data = excluded.data
    `
  );
  let copied = 0;
  for (const row of rows) {
    const chunk = parseJsonField(row.data, "chunks.data");
    if (!Array.isArray(chunk.embedding) || !chunk.embedding.length) continue;
    const vector = new Float32Array(chunk.embedding.map((value) => Number(value)));
    statement.run(
      `emb_${chunk.id}`,
      chunk.projectId,
      "memory_items_v2",
      chunk.id,
      chunk.memoryScope ?? "project_only",
      chunk.embeddingDimensions ?? vector.length,
      chunk.embeddingProvider ?? null,
      chunk.embeddingModel ?? null,
      float32EmbeddingToBlob(vector),
      chunk.createdAt,
      chunk.createdAt,
      chunk.embeddingMetadata ? stableStringify(chunk.embeddingMetadata) : null
    );
    copied += 1;
  }
  return { table: "embeddings_v2", copied };
}
