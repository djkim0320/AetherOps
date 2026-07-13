import { stableStringify } from "./hash.mjs";
import { boolInt, normalizeJsonText, parseJsonField, readRows, summarizeTable } from "./v2Support.mjs";

function copyDirectTable(sourceDb, targetDb, sourceTable, bindRow) {
  const rows = readRows(sourceDb, sourceTable);
  const statements = {
    jobs: `
      insert into jobs (
        id, project_id, operation, status, priority, attempt, lease_generation, idempotency_key, request_hash,
        requested_capabilities, effective_capabilities, tool_policy, blocked_reason, failure_reason, requested_by,
        lease_owner, lease_expires_at, queued_at, started_at, completed_at, created_at, updated_at, payload, result, error
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        project_id = excluded.project_id,
        operation = excluded.operation,
        status = excluded.status,
        priority = excluded.priority,
        attempt = excluded.attempt,
        lease_generation = excluded.lease_generation,
        idempotency_key = excluded.idempotency_key,
        request_hash = excluded.request_hash,
        requested_capabilities = excluded.requested_capabilities,
        effective_capabilities = excluded.effective_capabilities,
        tool_policy = excluded.tool_policy,
        blocked_reason = excluded.blocked_reason,
        failure_reason = excluded.failure_reason,
        requested_by = excluded.requested_by,
        lease_owner = excluded.lease_owner,
        lease_expires_at = excluded.lease_expires_at,
        queued_at = excluded.queued_at,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        payload = excluded.payload,
        result = excluded.result,
        error = excluded.error
    `,
    job_events: `
      insert into job_events (
        sequence, event_id, project_id, job_id, type, created_at, payload
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(sequence) do update set
        event_id = excluded.event_id,
        project_id = excluded.project_id,
        job_id = excluded.job_id,
        type = excluded.type,
        created_at = excluded.created_at,
        payload = excluded.payload
    `,
    checkpoints: `
      insert into checkpoints (
        id, project_id, job_id, attempt_id, step, checkpoint_key, status, output_ref, error, created_at, committed_at, data
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        project_id = excluded.project_id,
        job_id = excluded.job_id,
        attempt_id = excluded.attempt_id,
        step = excluded.step,
        checkpoint_key = excluded.checkpoint_key,
        status = excluded.status,
        output_ref = excluded.output_ref,
        error = excluded.error,
        created_at = excluded.created_at,
        committed_at = excluded.committed_at,
        data = excluded.data
    `,
    step_attempts: `
      insert into step_attempts (
        id, project_id, job_id, step, attempt_index, status, worker_id, checkpoint_id, quarantine_ref, input_hash, output_hash, error, started_at, completed_at, data
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        project_id = excluded.project_id,
        job_id = excluded.job_id,
        step = excluded.step,
        attempt_index = excluded.attempt_index,
        status = excluded.status,
        worker_id = excluded.worker_id,
        checkpoint_id = excluded.checkpoint_id,
        quarantine_ref = excluded.quarantine_ref,
        input_hash = excluded.input_hash,
        output_hash = excluded.output_hash,
        error = excluded.error,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        data = excluded.data
    `,
    capability_audits: `
      insert into capability_audits (
        id, project_id, job_id, operation, capability, app_allowed, project_allowed, operation_allowed, allowed, reason, audited_at, data
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        project_id = excluded.project_id,
        job_id = excluded.job_id,
        operation = excluded.operation,
        capability = excluded.capability,
        app_allowed = excluded.app_allowed,
        project_allowed = excluded.project_allowed,
        operation_allowed = excluded.operation_allowed,
        allowed = excluded.allowed,
        reason = excluded.reason,
        audited_at = excluded.audited_at,
        data = excluded.data
    `,
    ontology_runs: `
      insert into ontology_runs (
        id, project_id, job_id, mode, status, entity_count, relation_count, constraint_count, error, started_at, completed_at, data
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        project_id = excluded.project_id,
        job_id = excluded.job_id,
        mode = excluded.mode,
        status = excluded.status,
        entity_count = excluded.entity_count,
        relation_count = excluded.relation_count,
        constraint_count = excluded.constraint_count,
        error = excluded.error,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        data = excluded.data
    `
  };
  const statement = targetDb.prepare(statements[sourceTable]);
  for (const row of rows) {
    statement.run(...bindRow(row));
  }
  return summarizeTable(sourceTable, rows, sourceTable);
}

export function copyJobs(sourceDb, targetDb) {
  return copyDirectTable(sourceDb, targetDb, "jobs", (row) => {
    const wasActive = ["running", "pause_requested", "cancel_requested"].includes(row.status);
    return [
      row.id,
      row.project_id,
      row.operation,
      wasActive ? "interrupted" : row.status,
      row.priority,
      row.attempt,
      Number.isInteger(row.lease_generation) && row.lease_generation >= 0 ? row.lease_generation : 0,
      row.idempotency_key ?? null,
      row.request_hash ?? null,
      normalizeJsonText(row.requested_capabilities),
      normalizeJsonText(row.effective_capabilities),
      normalizeJsonText(row.tool_policy),
      row.blocked_reason ?? null,
      row.failure_reason ?? null,
      row.requested_by ?? null,
      wasActive ? null : (row.lease_owner ?? null),
      wasActive ? null : (row.lease_expires_at ?? null),
      row.queued_at,
      row.started_at ?? null,
      wasActive ? (row.completed_at ?? row.updated_at ?? row.created_at) : (row.completed_at ?? null),
      row.created_at,
      row.updated_at,
      normalizeJsonText(row.payload),
      normalizeJsonText(row.result),
      wasActive ? (row.error ?? "migration_active_job_interrupted") : (row.error ?? null)
    ];
  });
}

export function copyJobEvents(sourceDb, targetDb) {
  return copyDirectTable(sourceDb, targetDb, "job_events", (row) => [
    row.sequence,
    row.event_id,
    row.project_id,
    row.job_id ?? null,
    row.type,
    row.created_at,
    normalizeJsonText(row.payload)
  ]);
}

export function copyCheckpoints(sourceDb, targetDb) {
  return copyDirectTable(sourceDb, targetDb, "checkpoints", (row) => [
    row.id,
    row.project_id,
    row.job_id,
    row.attempt_id ?? null,
    row.step,
    row.checkpoint_key,
    row.status,
    row.output_ref ?? null,
    row.error ?? null,
    row.created_at,
    row.committed_at ?? null,
    normalizeJsonText(row.data)
  ]);
}

export function copyStepAttempts(sourceDb, targetDb) {
  return copyDirectTable(sourceDb, targetDb, "step_attempts", (row) => [
    row.id,
    row.project_id,
    row.job_id,
    row.step,
    row.attempt_index,
    row.status,
    row.worker_id ?? null,
    row.checkpoint_id ?? null,
    row.quarantine_ref ?? null,
    row.input_hash ?? null,
    row.output_hash ?? null,
    row.error ?? null,
    row.started_at,
    row.completed_at ?? null,
    normalizeJsonText(row.data)
  ]);
}

export function copyCapabilityAudits(sourceDb, targetDb) {
  return copyDirectTable(sourceDb, targetDb, "capability_audits", (row) => [
    row.id,
    row.project_id,
    row.job_id ?? null,
    row.operation,
    row.capability,
    boolInt(row.app_allowed),
    boolInt(row.project_allowed),
    boolInt(row.operation_allowed),
    boolInt(row.allowed),
    row.reason ?? null,
    row.audited_at,
    normalizeJsonText(row.data)
  ]);
}

export function copyOntologyRuns(sourceDb, targetDb) {
  return copyDirectTable(sourceDb, targetDb, "ontology_runs", (row) => [
    row.id,
    row.project_id,
    row.job_id ?? null,
    row.mode,
    row.status,
    row.entity_count,
    row.relation_count,
    row.constraint_count,
    row.error ?? null,
    row.started_at,
    row.completed_at ?? null,
    normalizeJsonText(row.data)
  ]);
}

export function copyOntologyEntities(sourceDb, targetDb) {
  const rows = readRows(sourceDb, "ontology_entities");
  const statement = targetDb.prepare(
    `
      insert into ontology_entities_v2 (
        id, project_id, workspace_project_id, source_project_id, memory_scope, validation_status,
        label, type, confidence, source_record_id, source_evidence_id, created_at, data
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        project_id = excluded.project_id,
        workspace_project_id = excluded.workspace_project_id,
        source_project_id = excluded.source_project_id,
        memory_scope = excluded.memory_scope,
        validation_status = excluded.validation_status,
        label = excluded.label,
        type = excluded.type,
        confidence = excluded.confidence,
        source_record_id = excluded.source_record_id,
        source_evidence_id = excluded.source_evidence_id,
        created_at = excluded.created_at,
        data = excluded.data
    `
  );
  for (const row of rows) {
    const entity = parseJsonField(row.data, "ontology_entities.data");
    statement.run(
      entity.id,
      entity.projectId,
      entity.workspaceProjectId ?? null,
      entity.sourceProjectId ?? entity.originProjectId ?? null,
      entity.memoryScope ?? null,
      entity.validationStatus ?? null,
      entity.label,
      entity.type,
      entity.confidence,
      entity.sourceRecordId ?? null,
      entity.sourceEvidenceId ?? null,
      entity.createdAt,
      stableStringify(entity)
    );
  }
  return summarizeTable("ontology_entities", rows, "ontology_entities_v2");
}

export function copyOntologyRelations(sourceDb, targetDb) {
  const rows = readRows(sourceDb, "ontology_relations");
  const statement = targetDb.prepare(
    `
      insert into ontology_relations_v2 (
        id, project_id, workspace_project_id, source_project_id, memory_scope, validation_status,
        subject_id, predicate, object_id, confidence, source_record_id, source_evidence_id, created_at, data
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        project_id = excluded.project_id,
        workspace_project_id = excluded.workspace_project_id,
        source_project_id = excluded.source_project_id,
        memory_scope = excluded.memory_scope,
        validation_status = excluded.validation_status,
        subject_id = excluded.subject_id,
        predicate = excluded.predicate,
        object_id = excluded.object_id,
        confidence = excluded.confidence,
        source_record_id = excluded.source_record_id,
        source_evidence_id = excluded.source_evidence_id,
        created_at = excluded.created_at,
        data = excluded.data
    `
  );
  for (const row of rows) {
    const relation = parseJsonField(row.data, "ontology_relations.data");
    statement.run(
      relation.id,
      relation.projectId,
      relation.workspaceProjectId ?? null,
      relation.sourceProjectId ?? relation.originProjectId ?? null,
      relation.memoryScope ?? null,
      relation.validationStatus ?? null,
      relation.subjectId,
      relation.predicate,
      relation.objectId,
      relation.confidence,
      relation.sourceRecordId ?? null,
      relation.sourceEvidenceId ?? null,
      relation.createdAt,
      stableStringify(relation)
    );
  }
  return summarizeTable("ontology_relations", rows, "ontology_relations_v2");
}

export function copyOntologyConstraints(sourceDb, targetDb) {
  const rows = readRows(sourceDb, "ontology_constraints");
  const statement = targetDb.prepare(
    `
      insert into ontology_constraints_v2 (
        id, project_id, workspace_project_id, source_project_id, memory_scope, validation_status,
        label, rule_type, applies_to_entity_type, confidence, source_record_id, created_at, data
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        project_id = excluded.project_id,
        workspace_project_id = excluded.workspace_project_id,
        source_project_id = excluded.source_project_id,
        memory_scope = excluded.memory_scope,
        validation_status = excluded.validation_status,
        label = excluded.label,
        rule_type = excluded.rule_type,
        applies_to_entity_type = excluded.applies_to_entity_type,
        confidence = excluded.confidence,
        source_record_id = excluded.source_record_id,
        created_at = excluded.created_at,
        data = excluded.data
    `
  );
  for (const row of rows) {
    const constraint = parseJsonField(row.data, "ontology_constraints.data");
    statement.run(
      constraint.id,
      constraint.projectId,
      constraint.workspaceProjectId ?? null,
      constraint.sourceProjectId ?? constraint.originProjectId ?? null,
      constraint.memoryScope ?? null,
      constraint.validationStatus ?? null,
      constraint.label,
      constraint.ruleType,
      constraint.appliesToEntityType ?? null,
      constraint.confidence,
      constraint.sourceRecordId ?? null,
      constraint.createdAt,
      stableStringify(constraint)
    );
  }
  return summarizeTable("ontology_constraints", rows, "ontology_constraints_v2");
}
