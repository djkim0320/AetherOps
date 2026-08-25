package store

const initialSchema = `
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    main_thread_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    schedule_id TEXT NOT NULL DEFAULT '',
    question TEXT NOT NULL,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    revision_cycle INTEGER NOT NULL DEFAULT 0,
    main_thread_id TEXT NOT NULL DEFAULT '',
    report_artifact_id TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX runs_project_created ON runs(project_id, created_at DESC);
CREATE INDEX runs_status ON runs(status);

CREATE TABLE stage_attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    status TEXT NOT NULL,
    codex_thread_id TEXT NOT NULL DEFAULT '',
    codex_turn_id TEXT NOT NULL DEFAULT '',
    input_artifact_hash TEXT NOT NULL DEFAULT '',
    output_artifact_hash TEXT NOT NULL DEFAULT '',
    external_side_effects INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, stage, ordinal)
);
CREATE INDEX stage_attempts_run ON stage_attempts(run_id, created_at);

CREATE TABLE run_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX run_events_run_sequence ON run_events(run_id, sequence);

CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    kind TEXT NOT NULL,
    expression TEXT NOT NULL,
    timezone TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    next_run_at TEXT,
    last_run_at TEXT,
    main_thread_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE schedule_firings (
    schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    scheduled_for TEXT NOT NULL,
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(schedule_id, scheduled_for)
);

CREATE TABLE blobs (
    hash TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    blob_hash TEXT NOT NULL REFERENCES blobs(hash),
    adopted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX artifacts_run ON artifacts(run_id, created_at);

CREATE TABLE evidence (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE CASCADE,
    source_url TEXT NOT NULL,
    title TEXT NOT NULL,
    publisher TEXT NOT NULL DEFAULT '',
    blob_hash TEXT NOT NULL REFERENCES blobs(hash),
    captured_at TEXT NOT NULL,
    adopted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    artifact_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    blob_hash TEXT NOT NULL REFERENCES blobs(hash),
    status TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    embedding_dimensions INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX documents_project_status ON documents(project_id, status);

CREATE TABLE chunks (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    UNIQUE(document_id, ordinal)
);

CREATE TABLE embedding_indexes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE UNIQUE INDEX embedding_indexes_one_active
ON embedding_indexes(project_id) WHERE state = 'active';
CREATE INDEX embedding_indexes_project_state ON embedding_indexes(project_id, state);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
    text,
    content='chunks',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 0'
);

CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE embeddings (
    chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    index_id TEXT NOT NULL REFERENCES embedding_indexes(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    vector BLOB NOT NULL,
    vector_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(chunk_id, index_id)
);
CREATE INDEX embeddings_index ON embeddings(index_id, chunk_id);

CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE runtime_versions (
    component TEXT NOT NULL,
    version TEXT NOT NULL,
    state TEXT NOT NULL,
    path TEXT NOT NULL,
    verified_at TEXT,
    error TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(component, version)
);
`

const downloadsSchema = `
CREATE TABLE downloads (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    blob_hash TEXT NOT NULL REFERENCES blobs(hash),
    size INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(file_name, blob_hash)
);
CREATE INDEX downloads_created ON downloads(created_at DESC);
`

const runConfigurationSchema = `
ALTER TABLE runs ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN service_tier TEXT NOT NULL DEFAULT '';
`

const conversationSessionsSchema = `
CREATE TABLE conversation_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    codex_thread_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT '',
    reasoning_effort TEXT NOT NULL DEFAULT '',
    service_tier TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);
CREATE INDEX conversation_sessions_project_updated
ON conversation_sessions(project_id, deleted_at, updated_at DESC);
CREATE UNIQUE INDEX conversation_sessions_codex_thread
ON conversation_sessions(codex_thread_id) WHERE codex_thread_id <> '';

ALTER TABLE runs ADD COLUMN conversation_session_id TEXT
REFERENCES conversation_sessions(id) ON DELETE RESTRICT;
CREATE INDEX runs_conversation_created
ON runs(conversation_session_id, created_at DESC);

ALTER TABLE schedules ADD COLUMN conversation_session_id TEXT
REFERENCES conversation_sessions(id) ON DELETE RESTRICT;
CREATE INDEX schedules_conversation
ON schedules(conversation_session_id, created_at);

INSERT INTO conversation_sessions(
    id, project_id, title, codex_thread_id, status, revision,
    model, reasoning_effort, service_tier, created_at, updated_at, deleted_at
)
SELECT 'ses_' || lower(hex(randomblob(16))), id, '기본 대화', main_thread_id,
       CASE WHEN main_thread_id = '' THEN 'unprovisioned' ELSE 'active' END, 0,
       '', '', '', created_at, updated_at, NULL
FROM projects;

UPDATE runs
SET conversation_session_id = (
    SELECT cs.id FROM conversation_sessions cs
    WHERE cs.project_id = runs.project_id AND cs.deleted_at IS NULL
    ORDER BY cs.created_at, cs.id LIMIT 1
);

UPDATE schedules
SET conversation_session_id = (
    SELECT cs.id FROM conversation_sessions cs
    WHERE cs.project_id = schedules.project_id AND cs.deleted_at IS NULL
    ORDER BY cs.created_at, cs.id LIMIT 1
);
`

const engineeringSchema = `
ALTER TABLE approvals ADD COLUMN stage_attempt_id TEXT NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN server TEXT NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN tool TEXT NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN command_text TEXT NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN arguments_json TEXT NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN arguments_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN risk TEXT NOT NULL DEFAULT 'unclassified';
ALTER TABLE approvals ADD COLUMN external_side_effect INTEGER NOT NULL DEFAULT 0;

CREATE TABLE engineering_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE CASCADE,
    operation TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    spec_sha256 TEXT NOT NULL,
    tool_component TEXT NOT NULL,
    tool_version TEXT NOT NULL,
    approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE RESTRICT,
    approval_scope_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    receipt_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, stage_attempt_id, operation, spec_sha256)
);
CREATE INDEX engineering_jobs_run_created
ON engineering_jobs(run_id, created_at);
CREATE INDEX engineering_jobs_status_created
ON engineering_jobs(status, created_at);

CREATE TABLE engineering_job_artifacts (
    job_id TEXT NOT NULL REFERENCES engineering_jobs(id) ON DELETE CASCADE,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    file_name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    blob_hash TEXT NOT NULL REFERENCES blobs(hash),
    PRIMARY KEY(job_id, artifact_id),
    UNIQUE(job_id, role, file_name)
);
`

// knowledgeGraphSchema is migration 6. Keep migrations 1-5 byte-for-byte
// stable: their checksums protect existing databases from accidental rewrites.
const knowledgeGraphSchema = `
ALTER TABLE documents ADD COLUMN graph_adopt INTEGER NOT NULL DEFAULT 0
CHECK(graph_adopt IN (0, 1));
ALTER TABLE embedding_indexes ADD COLUMN error TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN research_profile_version TEXT NOT NULL DEFAULT 'research_v2';
ALTER TABLE runs ADD COLUMN retrieval_profile TEXT NOT NULL DEFAULT 'hybrid_graph_v1';
ALTER TABLE runs ADD COLUMN knowledge_generation_id TEXT NOT NULL DEFAULT '';

CREATE TABLE ontology_versions (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    semantic_version TEXT NOT NULL,
    source_blob_hash TEXT REFERENCES blobs(hash) ON DELETE RESTRICT,
    canonical_blob_hash TEXT REFERENCES blobs(hash) ON DELETE RESTRICT,
    canonical_sha256 TEXT NOT NULL CHECK(length(canonical_sha256) = 64),
    triple_count INTEGER NOT NULL CHECK(triple_count >= 0),
    state TEXT NOT NULL CHECK(state IN ('draft', 'active', 'retired')),
    created_at TEXT NOT NULL,
    activated_at TEXT,
    retired_at TEXT
);
CREATE UNIQUE INDEX ontology_versions_one_active_core
ON ontology_versions((1)) WHERE state = 'active' AND project_id IS NULL;
CREATE UNIQUE INDEX ontology_versions_one_active_project
ON ontology_versions(project_id) WHERE state = 'active' AND project_id IS NOT NULL;
CREATE UNIQUE INDEX ontology_versions_core_canonical
ON ontology_versions(canonical_sha256) WHERE project_id IS NULL;
CREATE UNIQUE INDEX ontology_versions_project_canonical
ON ontology_versions(project_id, canonical_sha256) WHERE project_id IS NOT NULL;

CREATE TABLE ontology_terms (
    ontology_id TEXT NOT NULL REFERENCES ontology_versions(id) ON DELETE CASCADE,
    term_key TEXT NOT NULL,
    iri TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN (
        'class', 'object_property', 'datatype_property', 'annotation_property', 'individual'
    )),
    label TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    domain_key TEXT NOT NULL DEFAULT '',
    range_key TEXT NOT NULL DEFAULT '',
    value_kind TEXT NOT NULL DEFAULT '' CHECK(value_kind IN ('', 'entity', 'string', 'number', 'boolean', 'time', 'json')),
    functional INTEGER NOT NULL DEFAULT 0 CHECK(functional IN (0, 1)),
    temporal INTEGER NOT NULL DEFAULT 0 CHECK(temporal IN (0, 1)),
    expandable INTEGER NOT NULL DEFAULT 0 CHECK(expandable IN (0, 1)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(ontology_id, term_key),
    UNIQUE(ontology_id, iri)
);

CREATE TABLE ontology_axioms (
    ontology_id TEXT NOT NULL REFERENCES ontology_versions(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    axiom_type TEXT NOT NULL CHECK(axiom_type IN (
        'subclass_of', 'subproperty_of', 'domain', 'range', 'inverse_of',
        'symmetric', 'transitive', 'functional', 'annotation'
    )),
    subject_key TEXT NOT NULL,
    predicate_key TEXT NOT NULL DEFAULT '',
    object_key TEXT NOT NULL DEFAULT '',
    literal_json TEXT NOT NULL DEFAULT '' CHECK(literal_json = '' OR json_valid(literal_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(ontology_id, id)
);

CREATE TABLE ontology_imports (
    ontology_id TEXT NOT NULL REFERENCES ontology_versions(id) ON DELETE CASCADE,
    imported_ontology_id TEXT NOT NULL REFERENCES ontology_versions(id) ON DELETE CASCADE,
    required INTEGER NOT NULL DEFAULT 1 CHECK(required IN (0, 1)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(ontology_id, imported_ontology_id),
    CHECK(ontology_id <> imported_ontology_id)
);

CREATE TABLE knowledge_generations (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    ontology_id TEXT NOT NULL REFERENCES ontology_versions(id) ON DELETE RESTRICT,
    contract_sha256 TEXT NOT NULL CHECK(length(contract_sha256) = 64),
    manifest_sha256 TEXT NOT NULL DEFAULT '' CHECK(manifest_sha256 = '' OR length(manifest_sha256) = 64),
    state TEXT NOT NULL CHECK(state IN ('building', 'validating', 'ready', 'retired', 'failed')),
    source_count INTEGER NOT NULL DEFAULT 0 CHECK(source_count >= 0),
    entity_count INTEGER NOT NULL DEFAULT 0 CHECK(entity_count >= 0),
    assertion_count INTEGER NOT NULL DEFAULT 0 CHECK(assertion_count >= 0),
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    validating_at TEXT,
    ready_at TEXT,
    retired_at TEXT,
    failed_at TEXT,
    PRIMARY KEY(project_id, id),
    UNIQUE(id)
);
CREATE INDEX knowledge_generations_project_state
ON knowledge_generations(project_id, state, created_at);

CREATE TABLE project_knowledge_heads (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    generation_id TEXT NOT NULL,
    knowledge_revision INTEGER NOT NULL DEFAULT 1 CHECK(knowledge_revision >= 1),
    status TEXT NOT NULL CHECK(status IN ('ready', 'stale', 'failed')),
    error TEXT NOT NULL DEFAULT '',
    activated_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id, generation_id)
        REFERENCES knowledge_generations(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE knowledge_extraction_batches (
    project_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
    artifact_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('report', 'evidence', 'pinned', 'engineering', 'backfill')),
    extractor_model TEXT NOT NULL DEFAULT '',
    extractor_contract_sha256 TEXT NOT NULL CHECK(length(extractor_contract_sha256) = 64),
    status TEXT NOT NULL CHECK(status IN (
        'queued', 'extracting', 'reviewing', 'validated', 'applied', 'interrupted', 'failed'
    )),
    codex_thread_id TEXT NOT NULL DEFAULT '',
    codex_turn_id TEXT NOT NULL DEFAULT '',
    input_sha256 TEXT NOT NULL DEFAULT '' CHECK(input_sha256 = '' OR length(input_sha256) = 64),
    output_sha256 TEXT NOT NULL DEFAULT '' CHECK(output_sha256 = '' OR length(output_sha256) = 64),
    patch_blob_hash TEXT REFERENCES blobs(hash) ON DELETE RESTRICT,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY(project_id, generation_id, id),
    UNIQUE(id),
    FOREIGN KEY(project_id, generation_id)
        REFERENCES knowledge_generations(project_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_extraction_batches_generation_status
ON knowledge_extraction_batches(project_id, generation_id, status, created_at);

CREATE TABLE knowledge_sources (
    project_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    blob_hash TEXT NOT NULL REFERENCES blobs(hash) ON DELETE RESTRICT,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('report', 'evidence', 'pinned', 'engineering')),
    source_locator_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(source_locator_json)),
    text_hash TEXT NOT NULL CHECK(length(text_hash) = 64),
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, generation_id, chunk_id),
    UNIQUE(project_id, generation_id, chunk_id, blob_hash),
    FOREIGN KEY(project_id, generation_id)
        REFERENCES knowledge_generations(project_id, id) ON DELETE CASCADE
);

CREATE TABLE knowledge_entities (
    project_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    class_key TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    identity_key TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, generation_id, id),
    FOREIGN KEY(project_id, generation_id)
        REFERENCES knowledge_generations(project_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_entities_lookup
ON knowledge_entities(project_id, generation_id, class_key, normalized_name);

CREATE TABLE knowledge_aliases (
    project_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    normalized_alias TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, generation_id, entity_id, normalized_alias),
    FOREIGN KEY(project_id, generation_id, entity_id)
        REFERENCES knowledge_entities(project_id, generation_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_aliases_lookup
ON knowledge_aliases(project_id, generation_id, normalized_alias);

CREATE TABLE knowledge_mentions (
    project_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    start_byte INTEGER NOT NULL CHECK(start_byte >= 0),
    end_byte INTEGER NOT NULL CHECK(end_byte > start_byte),
    excerpt_sha256 TEXT NOT NULL CHECK(length(excerpt_sha256) = 64),
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, generation_id, id),
    UNIQUE(project_id, generation_id, entity_id, chunk_id, start_byte, end_byte),
    FOREIGN KEY(project_id, generation_id, entity_id)
        REFERENCES knowledge_entities(project_id, generation_id, id) ON DELETE CASCADE,
    FOREIGN KEY(project_id, generation_id, chunk_id)
        REFERENCES knowledge_sources(project_id, generation_id, chunk_id) ON DELETE CASCADE
);

CREATE TABLE knowledge_assertions (
    project_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    subject_entity_id TEXT NOT NULL,
    predicate_key TEXT NOT NULL,
    object_entity_id TEXT,
    literal_json TEXT NOT NULL DEFAULT '',
    qualifiers_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(qualifiers_json)),
    polarity TEXT NOT NULL DEFAULT 'affirmed' CHECK(polarity IN ('affirmed', 'negated')),
    valid_from TEXT,
    valid_to TEXT,
    status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted', 'disputed', 'superseded', 'retracted')),
    confidence REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1),
    assertion_key TEXT NOT NULL CHECK(length(assertion_key) = 64),
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, generation_id, id),
    UNIQUE(project_id, generation_id, assertion_key, id),
    CHECK(valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to),
    CHECK(
        (object_entity_id IS NOT NULL AND literal_json = '') OR
        (object_entity_id IS NULL AND literal_json <> '' AND json_valid(literal_json))
    ),
    FOREIGN KEY(project_id, generation_id, subject_entity_id)
        REFERENCES knowledge_entities(project_id, generation_id, id) ON DELETE CASCADE,
    FOREIGN KEY(project_id, generation_id, object_entity_id)
        REFERENCES knowledge_entities(project_id, generation_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_assertions_subject
ON knowledge_assertions(project_id, generation_id, subject_entity_id, predicate_key);
CREATE INDEX knowledge_assertions_object
ON knowledge_assertions(project_id, generation_id, object_entity_id, predicate_key)
WHERE object_entity_id IS NOT NULL;

CREATE TABLE knowledge_assertion_evidence (
    project_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    assertion_id TEXT NOT NULL,
    evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('text_span', 'artifact_value')),
    blob_hash TEXT NOT NULL REFERENCES blobs(hash) ON DELETE RESTRICT,
    chunk_id TEXT,
    claim_id TEXT NOT NULL DEFAULT '',
    source_id TEXT NOT NULL DEFAULT '',
    start_byte INTEGER,
    end_byte INTEGER,
    locator_json TEXT NOT NULL DEFAULT '{}',
    evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, generation_id, assertion_id, evidence_kind, blob_hash, evidence_sha256),
    CHECK(
        (evidence_kind = 'text_span' AND chunk_id IS NOT NULL
          AND start_byte IS NOT NULL AND start_byte >= 0
          AND end_byte IS NOT NULL AND end_byte > start_byte
          AND locator_json = '{}') OR
        (evidence_kind = 'artifact_value' AND chunk_id IS NULL
          AND start_byte IS NULL AND end_byte IS NULL
          AND json_valid(locator_json) AND locator_json <> '{}')
    ),
    FOREIGN KEY(project_id, generation_id, assertion_id)
        REFERENCES knowledge_assertions(project_id, generation_id, id) ON DELETE CASCADE,
    FOREIGN KEY(project_id, generation_id, chunk_id, blob_hash)
        REFERENCES knowledge_sources(project_id, generation_id, chunk_id, blob_hash) ON DELETE CASCADE
);

CREATE TABLE knowledge_conflicts (
    project_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    left_assertion_id TEXT NOT NULL,
    right_assertion_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved', 'dismissed')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    PRIMARY KEY(project_id, generation_id, id),
    UNIQUE(project_id, generation_id, left_assertion_id, right_assertion_id),
    CHECK(left_assertion_id <> right_assertion_id),
    FOREIGN KEY(project_id, generation_id, left_assertion_id)
        REFERENCES knowledge_assertions(project_id, generation_id, id) ON DELETE CASCADE,
    FOREIGN KEY(project_id, generation_id, right_assertion_id)
        REFERENCES knowledge_assertions(project_id, generation_id, id) ON DELETE CASCADE
);

CREATE TABLE knowledge_inferences (
    project_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    conclusion_assertion_id TEXT NOT NULL,
    ontology_id TEXT NOT NULL,
    rule_axiom_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted', 'rejected')),
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, generation_id, id),
    UNIQUE(project_id, generation_id, conclusion_assertion_id),
    FOREIGN KEY(project_id, generation_id, conclusion_assertion_id)
        REFERENCES knowledge_assertions(project_id, generation_id, id) ON DELETE CASCADE,
    FOREIGN KEY(ontology_id, rule_axiom_id)
        REFERENCES ontology_axioms(ontology_id, id) ON DELETE RESTRICT
);

CREATE TABLE knowledge_inference_proofs (
    project_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    inference_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    premise_assertion_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, generation_id, inference_id, ordinal),
    UNIQUE(project_id, generation_id, inference_id, premise_assertion_id),
    FOREIGN KEY(project_id, generation_id, inference_id)
        REFERENCES knowledge_inferences(project_id, generation_id, id) ON DELETE CASCADE,
    FOREIGN KEY(project_id, generation_id, premise_assertion_id)
        REFERENCES knowledge_assertions(project_id, generation_id, id) ON DELETE CASCADE
);

CREATE TABLE knowledge_rdf_snapshots (
    project_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    format TEXT NOT NULL CHECK(format IN ('n-quads', 'turtle', 'json-ld')),
    blob_hash TEXT NOT NULL REFERENCES blobs(hash) ON DELETE RESTRICT,
    dataset_sha256 TEXT NOT NULL CHECK(length(dataset_sha256) = 64),
    triple_count INTEGER NOT NULL CHECK(triple_count >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, generation_id, id),
    UNIQUE(project_id, generation_id, format),
    FOREIGN KEY(project_id, generation_id)
        REFERENCES knowledge_generations(project_id, id) ON DELETE CASCADE
);

CREATE TABLE knowledge_curation_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN (
        'add_entity', 'add_assertion', 'update_assertion', 'merge_entities',
        'split_entity', 'retract_assertion', 'restore_assertion', 'add_alias',
        'pin_entity', 'resolve_conflict', 'dismiss_conflict'
    )),
    actor TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
    previous_event_sha256 TEXT NOT NULL DEFAULT '' CHECK(previous_event_sha256 = '' OR length(previous_event_sha256) = 64),
    event_sha256 TEXT NOT NULL UNIQUE CHECK(length(event_sha256) = 64),
    created_at TEXT NOT NULL,
    FOREIGN KEY(project_id, generation_id)
        REFERENCES knowledge_generations(project_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_curation_events_project_sequence
ON knowledge_curation_events(project_id, sequence);

CREATE TRIGGER ontology_versions_state_transition
BEFORE UPDATE OF state ON ontology_versions
WHEN NOT (
    OLD.state = NEW.state OR
    (OLD.state = 'draft' AND NEW.state = 'active') OR
    (OLD.state = 'active' AND NEW.state = 'retired')
)
BEGIN
    SELECT RAISE(ABORT, 'invalid ontology state transition');
END;
CREATE TRIGGER ontology_versions_no_delete
BEFORE DELETE ON ontology_versions
WHEN OLD.project_id IS NULL OR EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'ontology versions are append-only'); END;
CREATE TRIGGER ontology_versions_content_immutable
BEFORE UPDATE OF id, project_id, semantic_version, source_blob_hash,
                 canonical_blob_hash, canonical_sha256, triple_count, created_at
ON ontology_versions BEGIN
    SELECT RAISE(ABORT, 'ontology version content is immutable');
END;
CREATE TRIGGER ontology_versions_project_blobs_required
BEFORE INSERT ON ontology_versions
WHEN NEW.project_id IS NOT NULL
 AND (NEW.source_blob_hash IS NULL OR NEW.canonical_blob_hash IS NULL)
BEGIN SELECT RAISE(ABORT, 'project ontology requires source and canonical CAS blobs'); END;
CREATE TRIGGER ontology_versions_core_blobs_embedded
BEFORE INSERT ON ontology_versions
WHEN NEW.project_id IS NULL
 AND (NEW.source_blob_hash IS NOT NULL OR NEW.canonical_blob_hash IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'core ontology is embedded and must not claim CAS blobs'); END;

CREATE TRIGGER ontology_terms_insert_guard
BEFORE INSERT ON ontology_terms
WHEN (SELECT state FROM ontology_versions WHERE id = NEW.ontology_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'active ontology terms are immutable'); END;
CREATE TRIGGER ontology_terms_update_guard
BEFORE UPDATE ON ontology_terms BEGIN SELECT RAISE(ABORT, 'ontology terms are append-only'); END;
CREATE TRIGGER ontology_terms_delete_guard
BEFORE DELETE ON ontology_terms
WHEN EXISTS(
    SELECT 1 FROM ontology_versions o
    WHERE o.id = OLD.ontology_id
      AND (o.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id = o.project_id))
)
BEGIN SELECT RAISE(ABORT, 'ontology terms are append-only'); END;
CREATE TRIGGER ontology_axioms_insert_guard
BEFORE INSERT ON ontology_axioms
WHEN (SELECT state FROM ontology_versions WHERE id = NEW.ontology_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'active ontology axioms are immutable'); END;
CREATE TRIGGER ontology_axioms_update_guard
BEFORE UPDATE ON ontology_axioms BEGIN SELECT RAISE(ABORT, 'ontology axioms are append-only'); END;
CREATE TRIGGER ontology_axioms_delete_guard
BEFORE DELETE ON ontology_axioms
WHEN EXISTS(
    SELECT 1 FROM ontology_versions o
    WHERE o.id = OLD.ontology_id
      AND (o.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id = o.project_id))
)
BEGIN SELECT RAISE(ABORT, 'ontology axioms are append-only'); END;
CREATE TRIGGER ontology_imports_insert_guard
BEFORE INSERT ON ontology_imports
WHEN (SELECT state FROM ontology_versions WHERE id = NEW.ontology_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'active ontology imports are immutable'); END;
CREATE TRIGGER ontology_imports_scope_guard
BEFORE INSERT ON ontology_imports
WHEN NOT EXISTS (
    SELECT 1
    FROM ontology_versions owner
    JOIN ontology_versions imported ON imported.id = NEW.imported_ontology_id
    WHERE owner.id = NEW.ontology_id
      AND owner.project_id IS NOT NULL
      AND imported.state = 'active'
      AND (imported.project_id IS NULL OR imported.project_id = owner.project_id)
)
BEGIN SELECT RAISE(ABORT, 'ontology import is not active in this project scope'); END;
CREATE TRIGGER ontology_imports_collision_guard
BEFORE INSERT ON ontology_imports
WHEN EXISTS (
    SELECT 1
    FROM ontology_terms incoming
    JOIN ontology_imports existing ON existing.ontology_id = NEW.ontology_id
    JOIN ontology_terms imported
      ON imported.ontology_id = existing.imported_ontology_id
     AND imported.term_key = incoming.term_key
    WHERE incoming.ontology_id = NEW.imported_ontology_id
)
BEGIN SELECT RAISE(ABORT, 'ontology imports contain an ambiguous term key'); END;
CREATE TRIGGER ontology_imports_update_guard
BEFORE UPDATE ON ontology_imports BEGIN SELECT RAISE(ABORT, 'ontology imports are append-only'); END;
CREATE TRIGGER ontology_imports_delete_guard
BEFORE DELETE ON ontology_imports
WHEN EXISTS(
    SELECT 1 FROM ontology_versions o
    WHERE o.id = OLD.ontology_id
      AND (o.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id = o.project_id))
)
BEGIN SELECT RAISE(ABORT, 'ontology imports are append-only'); END;

CREATE TRIGGER knowledge_generation_state_transition
BEFORE UPDATE OF state ON knowledge_generations
WHEN NOT (
    OLD.state = NEW.state OR
    (OLD.state = 'building' AND NEW.state IN ('validating', 'failed')) OR
    (OLD.state = 'validating' AND NEW.state IN ('ready', 'failed')) OR
    (OLD.state = 'ready' AND NEW.state = 'retired')
)
BEGIN
    SELECT RAISE(ABORT, 'invalid knowledge generation state transition');
END;
CREATE TRIGGER knowledge_generation_content_immutable
BEFORE UPDATE OF project_id, id, ontology_id, contract_sha256, manifest_sha256,
                 source_count, entity_count, assertion_count, error, created_at,
                 validating_at, ready_at, failed_at
ON knowledge_generations
WHEN OLD.state IN ('ready', 'retired', 'failed')
BEGIN SELECT RAISE(ABORT, 'validated knowledge generation content is immutable'); END;
CREATE TRIGGER knowledge_generation_terminal_immutable
BEFORE UPDATE ON knowledge_generations
WHEN OLD.state IN ('retired', 'failed')
BEGIN SELECT RAISE(ABORT, 'terminal knowledge generation is immutable'); END;
CREATE TRIGGER knowledge_generation_retirement_guard
BEFORE UPDATE OF state, retired_at ON knowledge_generations
WHEN OLD.state = 'ready'
 AND (
   NOT (NEW.state = 'retired' AND NEW.retired_at IS NOT NULL) OR
   EXISTS (
     SELECT 1 FROM project_knowledge_heads h
     WHERE h.project_id = OLD.project_id AND h.generation_id = OLD.id
   ) OR NOT EXISTS (
     SELECT 1 FROM project_knowledge_heads h
     WHERE h.project_id = OLD.project_id
       AND h.generation_id <> OLD.id
       AND h.activated_at = NEW.retired_at
   )
 )
BEGIN SELECT RAISE(ABORT, 'ready generation may only record an atomic retirement'); END;
CREATE TRIGGER knowledge_generation_delete_guard
BEFORE DELETE ON knowledge_generations
WHEN EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
     AND OLD.state <> 'building'
BEGIN SELECT RAISE(ABORT, 'validated knowledge generation is immutable'); END;

CREATE TRIGGER project_knowledge_head_insert_guard
BEFORE INSERT ON project_knowledge_heads
WHEN NOT EXISTS (
    SELECT 1 FROM knowledge_generations g
    WHERE g.project_id = NEW.project_id AND g.id = NEW.generation_id AND g.state = 'ready'
)
BEGIN SELECT RAISE(ABORT, 'knowledge head requires a ready generation'); END;
CREATE TRIGGER project_knowledge_head_swap_guard
BEFORE UPDATE OF generation_id ON project_knowledge_heads
WHEN OLD.generation_id <> NEW.generation_id AND NOT EXISTS (
    SELECT 1 FROM knowledge_generations g
    WHERE g.project_id = NEW.project_id AND g.id = NEW.generation_id AND g.state = 'ready'
)
BEGIN SELECT RAISE(ABORT, 'knowledge head swap requires a ready candidate'); END;
CREATE TRIGGER project_knowledge_head_retire_previous
AFTER UPDATE OF generation_id ON project_knowledge_heads
WHEN OLD.generation_id <> NEW.generation_id
BEGIN
    UPDATE knowledge_generations
    SET state = 'retired', retired_at = NEW.activated_at
    WHERE project_id = OLD.project_id AND id = OLD.generation_id AND state = 'ready';
    SELECT CASE WHEN changes() <> 1
      THEN RAISE(ABORT, 'knowledge head predecessor was not ready') END;
END;
CREATE TRIGGER project_knowledge_head_project_immutable
BEFORE UPDATE OF project_id ON project_knowledge_heads
BEGIN SELECT RAISE(ABORT, 'knowledge head project is immutable'); END;
CREATE TRIGGER project_knowledge_head_delete_guard
BEFORE DELETE ON project_knowledge_heads
WHEN EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'knowledge head may only be deleted with its project'); END;
CREATE TRIGGER runs_knowledge_generation_insert_guard
BEFORE INSERT ON runs
WHEN NEW.knowledge_generation_id <> '' AND NOT EXISTS (
    SELECT 1 FROM knowledge_generations g
    WHERE g.project_id = NEW.project_id AND g.id = NEW.knowledge_generation_id
)
BEGIN SELECT RAISE(ABORT, 'run knowledge generation belongs to another project'); END;
CREATE TRIGGER runs_knowledge_generation_update_guard
BEFORE UPDATE OF project_id, knowledge_generation_id ON runs
WHEN NEW.knowledge_generation_id <> '' AND NOT EXISTS (
    SELECT 1 FROM knowledge_generations g
    WHERE g.project_id = NEW.project_id AND g.id = NEW.knowledge_generation_id
)
BEGIN SELECT RAISE(ABORT, 'run knowledge generation belongs to another project'); END;

CREATE TRIGGER knowledge_extraction_batch_project_guard
BEFORE INSERT ON knowledge_extraction_batches
WHEN NEW.document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM documents d WHERE d.id = NEW.document_id AND d.project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'knowledge extraction document belongs to another project'); END;
CREATE TRIGGER knowledge_extraction_batch_project_update_guard
BEFORE UPDATE OF project_id, document_id ON knowledge_extraction_batches
WHEN NEW.document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM documents d WHERE d.id = NEW.document_id AND d.project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'knowledge extraction document belongs to another project'); END;
CREATE TRIGGER knowledge_extraction_run_project_guard
BEFORE INSERT ON knowledge_extraction_batches
WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runs r WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'knowledge extraction run belongs to another project'); END;
CREATE TRIGGER knowledge_extraction_run_project_update_guard
BEFORE UPDATE OF project_id, run_id ON knowledge_extraction_batches
WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runs r WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'knowledge extraction run belongs to another project'); END;
CREATE TRIGGER knowledge_extraction_artifact_project_guard
BEFORE INSERT ON knowledge_extraction_batches
WHEN NEW.artifact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM artifacts a JOIN runs r ON r.id = a.run_id
    WHERE a.id = NEW.artifact_id AND r.project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'knowledge extraction artifact belongs to another project'); END;
CREATE TRIGGER knowledge_extraction_artifact_project_update_guard
BEFORE UPDATE OF project_id, artifact_id ON knowledge_extraction_batches
WHEN NEW.artifact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM artifacts a JOIN runs r ON r.id = a.run_id
    WHERE a.id = NEW.artifact_id AND r.project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'knowledge extraction artifact belongs to another project'); END;
CREATE TRIGGER knowledge_source_project_guard
BEFORE INSERT ON knowledge_sources
WHEN NOT EXISTS (
    SELECT 1 FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.id = NEW.chunk_id AND d.project_id = NEW.project_id
      AND d.blob_hash = NEW.blob_hash AND c.text_hash = NEW.text_hash
      AND d.graph_adopt = 1
)
BEGIN SELECT RAISE(ABORT, 'knowledge source is not graph-adopted by this project'); END;
CREATE TRIGGER knowledge_source_project_update_guard
BEFORE UPDATE OF project_id, chunk_id, blob_hash, text_hash ON knowledge_sources
WHEN NOT EXISTS (
    SELECT 1 FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.id = NEW.chunk_id AND d.project_id = NEW.project_id
      AND d.blob_hash = NEW.blob_hash AND c.text_hash = NEW.text_hash
      AND d.graph_adopt = 1
)
BEGIN SELECT RAISE(ABORT, 'knowledge source is not graph-adopted by this project'); END;
CREATE TRIGGER knowledge_generation_ontology_project_guard
BEFORE INSERT ON knowledge_generations
WHEN NOT EXISTS (
    SELECT 1 FROM ontology_versions o
    WHERE o.id = NEW.ontology_id AND o.state = 'active'
      AND (o.project_id IS NULL OR o.project_id = NEW.project_id)
)
BEGIN SELECT RAISE(ABORT, 'knowledge ontology is not active for this project'); END;
CREATE TRIGGER knowledge_artifact_evidence_project_guard
BEFORE INSERT ON knowledge_assertion_evidence
WHEN NEW.evidence_kind = 'artifact_value' AND NOT EXISTS (
    SELECT 1 FROM documents d
      WHERE d.project_id = NEW.project_id AND d.blob_hash = NEW.blob_hash AND d.graph_adopt = 1
    UNION ALL
    SELECT 1 FROM artifacts a JOIN runs r ON r.id = a.run_id
      WHERE r.project_id = NEW.project_id AND a.blob_hash = NEW.blob_hash AND a.adopted = 1
    UNION ALL
    SELECT 1 FROM evidence e JOIN runs r ON r.id = e.run_id
      WHERE r.project_id = NEW.project_id AND e.blob_hash = NEW.blob_hash AND e.adopted = 1
    UNION ALL
    SELECT 1 FROM engineering_job_artifacts eja
      JOIN engineering_jobs ej ON ej.id = eja.job_id
      WHERE ej.project_id = NEW.project_id AND eja.blob_hash = NEW.blob_hash
)
BEGIN SELECT RAISE(ABORT, 'artifact evidence is not adopted by this project'); END;
CREATE TRIGGER knowledge_artifact_evidence_project_update_guard
BEFORE UPDATE OF project_id, evidence_kind, blob_hash ON knowledge_assertion_evidence
WHEN NEW.evidence_kind = 'artifact_value' AND NOT EXISTS (
    SELECT 1 FROM documents d
      WHERE d.project_id = NEW.project_id AND d.blob_hash = NEW.blob_hash AND d.graph_adopt = 1
    UNION ALL
    SELECT 1 FROM artifacts a JOIN runs r ON r.id = a.run_id
      WHERE r.project_id = NEW.project_id AND a.blob_hash = NEW.blob_hash AND a.adopted = 1
    UNION ALL
    SELECT 1 FROM evidence e JOIN runs r ON r.id = e.run_id
      WHERE r.project_id = NEW.project_id AND e.blob_hash = NEW.blob_hash AND e.adopted = 1
    UNION ALL
    SELECT 1 FROM engineering_job_artifacts eja
      JOIN engineering_jobs ej ON ej.id = eja.job_id
      WHERE ej.project_id = NEW.project_id AND eja.blob_hash = NEW.blob_hash
)
BEGIN SELECT RAISE(ABORT, 'artifact evidence is not adopted by this project'); END;

CREATE TRIGGER knowledge_inference_ontology_guard
BEFORE INSERT ON knowledge_inferences
WHEN NOT EXISTS (
    SELECT 1
    FROM knowledge_generations g
    WHERE g.project_id = NEW.project_id AND g.id = NEW.generation_id
      AND (
        g.ontology_id = NEW.ontology_id OR EXISTS (
          SELECT 1 FROM ontology_imports oi
          WHERE oi.ontology_id = g.ontology_id
            AND oi.imported_ontology_id = NEW.ontology_id
        )
      )
)
BEGIN SELECT RAISE(ABORT, 'inference axiom is outside the generation ontology'); END;
CREATE TRIGGER knowledge_inference_ontology_update_guard
BEFORE UPDATE OF project_id, generation_id, ontology_id ON knowledge_inferences
WHEN NOT EXISTS (
    SELECT 1
    FROM knowledge_generations g
    WHERE g.project_id = NEW.project_id AND g.id = NEW.generation_id
      AND (
        g.ontology_id = NEW.ontology_id OR EXISTS (
          SELECT 1 FROM ontology_imports oi
          WHERE oi.ontology_id = g.ontology_id
            AND oi.imported_ontology_id = NEW.ontology_id
        )
      )
)
BEGIN SELECT RAISE(ABORT, 'inference axiom is outside the generation ontology'); END;

CREATE TRIGGER knowledge_curation_active_guard
BEFORE INSERT ON knowledge_curation_events
WHEN NOT EXISTS (
    SELECT 1 FROM project_knowledge_heads h
    WHERE h.project_id = NEW.project_id AND h.generation_id = NEW.generation_id
)
BEGIN SELECT RAISE(ABORT, 'curation requires the active knowledge generation'); END;
CREATE TRIGGER knowledge_curation_update_guard
BEFORE UPDATE ON knowledge_curation_events BEGIN
    SELECT RAISE(ABORT, 'knowledge curation is append-only');
END;
CREATE TRIGGER knowledge_curation_delete_guard
BEFORE DELETE ON knowledge_curation_events
WHEN EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'knowledge curation is append-only'); END;

CREATE TRIGGER knowledge_extraction_batches_insert_lock
BEFORE INSERT ON knowledge_extraction_batches
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_extraction_batches_update_lock
BEFORE UPDATE ON knowledge_extraction_batches
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
  OR (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_extraction_batches_delete_lock
BEFORE DELETE ON knowledge_extraction_batches
WHEN EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
 AND (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;

CREATE TRIGGER knowledge_sources_insert_lock
BEFORE INSERT ON knowledge_sources
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_sources_update_lock
BEFORE UPDATE ON knowledge_sources
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
  OR (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_sources_delete_lock
BEFORE DELETE ON knowledge_sources
WHEN EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
 AND (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;

CREATE TRIGGER knowledge_entities_insert_lock
BEFORE INSERT ON knowledge_entities
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_entities_update_lock
BEFORE UPDATE ON knowledge_entities
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
  OR (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_entities_delete_lock
BEFORE DELETE ON knowledge_entities
WHEN EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
 AND (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;

CREATE TRIGGER knowledge_aliases_insert_lock
BEFORE INSERT ON knowledge_aliases
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_aliases_update_lock
BEFORE UPDATE ON knowledge_aliases
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
  OR (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_aliases_delete_lock
BEFORE DELETE ON knowledge_aliases
WHEN EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
 AND (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;

CREATE TRIGGER knowledge_mentions_insert_lock
BEFORE INSERT ON knowledge_mentions
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_mentions_update_lock
BEFORE UPDATE ON knowledge_mentions
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
  OR (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_mentions_delete_lock
BEFORE DELETE ON knowledge_mentions
WHEN EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
 AND (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;

CREATE TRIGGER knowledge_assertions_insert_lock
BEFORE INSERT ON knowledge_assertions
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_assertions_update_lock
BEFORE UPDATE ON knowledge_assertions
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
  OR (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_assertions_delete_lock
BEFORE DELETE ON knowledge_assertions
WHEN EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
 AND (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;

CREATE TRIGGER knowledge_assertion_evidence_insert_lock
BEFORE INSERT ON knowledge_assertion_evidence
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_assertion_evidence_update_lock
BEFORE UPDATE ON knowledge_assertion_evidence
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
  OR (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_assertion_evidence_delete_lock
BEFORE DELETE ON knowledge_assertion_evidence
WHEN EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
 AND (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;

CREATE TRIGGER knowledge_conflicts_insert_lock
BEFORE INSERT ON knowledge_conflicts
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_conflicts_update_lock
BEFORE UPDATE ON knowledge_conflicts
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
  OR (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_conflicts_delete_lock
BEFORE DELETE ON knowledge_conflicts
WHEN EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
 AND (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;

CREATE TRIGGER knowledge_inferences_insert_lock
BEFORE INSERT ON knowledge_inferences
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_inferences_update_lock
BEFORE UPDATE ON knowledge_inferences
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
  OR (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_inferences_delete_lock
BEFORE DELETE ON knowledge_inferences
WHEN EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
 AND (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;

CREATE TRIGGER knowledge_inference_proofs_insert_lock
BEFORE INSERT ON knowledge_inference_proofs
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_inference_proofs_update_lock
BEFORE UPDATE ON knowledge_inference_proofs
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
  OR (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_inference_proofs_delete_lock
BEFORE DELETE ON knowledge_inference_proofs
WHEN EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
 AND (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;

CREATE TRIGGER knowledge_rdf_snapshots_insert_lock
BEFORE INSERT ON knowledge_rdf_snapshots
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_rdf_snapshots_update_lock
BEFORE UPDATE ON knowledge_rdf_snapshots
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
  OR (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_rdf_snapshots_delete_lock
BEFORE DELETE ON knowledge_rdf_snapshots
WHEN EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
 AND (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;

INSERT INTO ontology_versions(
    id, project_id, semantic_version, source_blob_hash, canonical_blob_hash,
    canonical_sha256, triple_count, state,
    created_at, activated_at, retired_at
) VALUES(
    'ont_core_v1', NULL, '1.0.0',
    NULL, NULL,
    '88879f6e13dfefafbc28c96d68b33c5edef3e9f35d039646f392780640c9ad52',
    28, 'draft', CURRENT_TIMESTAMP, NULL, NULL
);

INSERT INTO ontology_terms(
    ontology_id, term_key, iri, kind, label, description,
    domain_key, range_key, value_kind, functional, temporal, expandable, created_at
) VALUES
('ont_core_v1','thing','urn:aetherops:core:Thing','class','Thing','Root entity class','','','',0,0,0,CURRENT_TIMESTAMP),
('ont_core_v1','concept','urn:aetherops:core:Concept','class','Concept','','thing','','',0,0,0,CURRENT_TIMESTAMP),
('ont_core_v1','claim','urn:aetherops:core:Claim','class','Claim','','thing','','',0,0,0,CURRENT_TIMESTAMP),
('ont_core_v1','person','urn:aetherops:core:Person','class','Person','','thing','','',0,0,0,CURRENT_TIMESTAMP),
('ont_core_v1','organization','urn:aetherops:core:Organization','class','Organization','','thing','','',0,0,0,CURRENT_TIMESTAMP),
('ont_core_v1','place','urn:aetherops:core:Place','class','Place','','thing','','',0,0,0,CURRENT_TIMESTAMP),
('ont_core_v1','document','urn:aetherops:core:Document','class','Document','','thing','','',0,0,0,CURRENT_TIMESTAMP),
('ont_core_v1','dataset','urn:aetherops:core:Dataset','class','Dataset','','thing','','',0,0,0,CURRENT_TIMESTAMP),
('ont_core_v1','software','urn:aetherops:core:Software','class','Software','','thing','','',0,0,0,CURRENT_TIMESTAMP),
('ont_core_v1','method','urn:aetherops:core:Method','class','Method','','thing','','',0,0,0,CURRENT_TIMESTAMP),
('ont_core_v1','physical_system','urn:aetherops:core:PhysicalSystem','class','Physical system','','thing','','',0,0,0,CURRENT_TIMESTAMP),
('ont_core_v1','component','urn:aetherops:core:Component','class','Component','','thing','','',0,0,0,CURRENT_TIMESTAMP),
('ont_core_v1','material','urn:aetherops:core:Material','class','Material','','thing','','',0,0,0,CURRENT_TIMESTAMP),
('ont_core_v1','experiment','urn:aetherops:core:Experiment','class','Experiment','','thing','','',0,0,0,CURRENT_TIMESTAMP),
('ont_core_v1','parameter','urn:aetherops:core:Parameter','class','Parameter','','thing','','',0,0,0,CURRENT_TIMESTAMP),
('ont_core_v1','measurement','urn:aetherops:core:Measurement','class','Measurement','','thing','','',0,0,0,CURRENT_TIMESTAMP),
('ont_core_v1','part_of','urn:aetherops:core:partOf','object_property','part of','','thing','thing','entity',0,1,1,CURRENT_TIMESTAMP),
('ont_core_v1','uses','urn:aetherops:core:uses','object_property','uses','','thing','thing','entity',0,1,1,CURRENT_TIMESTAMP),
('ont_core_v1','produces','urn:aetherops:core:produces','object_property','produces','','thing','thing','entity',0,1,1,CURRENT_TIMESTAMP),
('ont_core_v1','measures','urn:aetherops:core:measures','object_property','measures','','thing','thing','entity',0,1,1,CURRENT_TIMESTAMP),
('ont_core_v1','depends_on','urn:aetherops:core:dependsOn','object_property','depends on','','thing','thing','entity',0,1,1,CURRENT_TIMESTAMP),
('ont_core_v1','derived_from','urn:aetherops:core:derivedFrom','object_property','derived from','','thing','thing','entity',0,1,1,CURRENT_TIMESTAMP),
('ont_core_v1','has_parameter','urn:aetherops:core:hasParameter','object_property','has parameter','','thing','parameter','entity',0,1,1,CURRENT_TIMESTAMP),
('ont_core_v1','has_result','urn:aetherops:core:hasResult','object_property','has result','','thing','measurement','entity',0,1,1,CURRENT_TIMESTAMP),
('ont_core_v1','supports','urn:aetherops:core:supports','object_property','supports','','claim','claim','entity',0,1,1,CURRENT_TIMESTAMP),
('ont_core_v1','contradicts','urn:aetherops:core:contradicts','object_property','contradicts','','claim','claim','entity',0,1,1,CURRENT_TIMESTAMP),
('ont_core_v1','has_value','urn:aetherops:core:hasValue','datatype_property','has value','','measurement','','number',1,1,0,CURRENT_TIMESTAMP),
('ont_core_v1','has_unit','urn:aetherops:core:hasUnit','datatype_property','has unit','','measurement','','string',1,1,0,CURRENT_TIMESTAMP);

INSERT INTO ontology_axioms(
    ontology_id, id, axiom_type, subject_key, predicate_key, object_key, literal_json, created_at
)
SELECT 'ont_core_v1', 'ax_subclass_' || term_key, 'subclass_of', term_key, '', 'thing', '', CURRENT_TIMESTAMP
FROM ontology_terms
WHERE ontology_id = 'ont_core_v1' AND kind = 'class' AND term_key <> 'thing';

UPDATE ontology_versions
SET state = 'active', activated_at = CURRENT_TIMESTAMP
WHERE id = 'ont_core_v1' AND state = 'draft';

INSERT INTO knowledge_generations(
    project_id, id, ontology_id, contract_sha256, manifest_sha256, state,
    source_count, entity_count, assertion_count, error,
    created_at, validating_at, ready_at, retired_at, failed_at
)
SELECT id, 'kgen_' || lower(hex(randomblob(16))), 'ont_core_v1',
       '88879f6e13dfefafbc28c96d68b33c5edef3e9f35d039646f392780640c9ad52',
       'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
       'ready', 0, 0, 0, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL
FROM projects;

INSERT INTO project_knowledge_heads(
    project_id, generation_id, knowledge_revision, status, error, activated_at, updated_at
)
SELECT project_id, id, 1, 'ready', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM knowledge_generations;
`

// knowledgeTypeInferenceSchema is migration 7. Entity classifications are a
// separate projection because knowledge_assertions intentionally model only
// evidence-backed domain statements. This keeps rdf:type inference queryable
// without inventing class entities or weakening assertion foreign keys.
const knowledgeTypeInferenceSchema = `
CREATE TABLE knowledge_type_inferences (
    project_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    class_key TEXT NOT NULL,
    ontology_id TEXT NOT NULL,
    rule_axiom_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted', 'rejected')),
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, generation_id, id),
    UNIQUE(project_id, generation_id, entity_id, class_key),
    FOREIGN KEY(project_id, generation_id, entity_id)
        REFERENCES knowledge_entities(project_id, generation_id, id) ON DELETE CASCADE,
    FOREIGN KEY(ontology_id, rule_axiom_id)
        REFERENCES ontology_axioms(ontology_id, id) ON DELETE RESTRICT
);
CREATE INDEX knowledge_type_inferences_entity
ON knowledge_type_inferences(project_id, generation_id, entity_id, class_key);

CREATE TRIGGER ontology_import_owner_term_collision_guard
BEFORE INSERT ON ontology_imports
WHEN EXISTS (
    SELECT 1 FROM ontology_terms own
    JOIN ontology_terms imported ON imported.ontology_id = NEW.imported_ontology_id
      AND imported.term_key = own.term_key AND imported.iri <> own.iri
    WHERE own.ontology_id = NEW.ontology_id
)
BEGIN SELECT RAISE(ABORT, 'ontology owner/import term-key collision'); END;

CREATE TABLE knowledge_type_inference_proofs (
    project_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    inference_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    premise_kind TEXT NOT NULL CHECK(premise_kind IN ('entity_class', 'assertion', 'type_inference')),
    premise_entity_id TEXT,
    premise_class_key TEXT NOT NULL DEFAULT '',
    premise_assertion_id TEXT,
    premise_type_inference_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, generation_id, inference_id, ordinal),
    CHECK(
        (premise_kind = 'entity_class' AND premise_entity_id IS NOT NULL
          AND premise_class_key <> '' AND premise_assertion_id IS NULL
          AND premise_type_inference_id IS NULL) OR
        (premise_kind = 'assertion' AND premise_entity_id IS NULL
          AND premise_class_key = '' AND premise_assertion_id IS NOT NULL
          AND premise_type_inference_id IS NULL) OR
        (premise_kind = 'type_inference' AND premise_entity_id IS NULL
          AND premise_class_key = '' AND premise_assertion_id IS NULL
          AND premise_type_inference_id IS NOT NULL)
    ),
	CHECK(premise_type_inference_id IS NULL OR premise_type_inference_id <> inference_id),
    FOREIGN KEY(project_id, generation_id, inference_id)
        REFERENCES knowledge_type_inferences(project_id, generation_id, id) ON DELETE CASCADE,
    FOREIGN KEY(project_id, generation_id, premise_entity_id)
        REFERENCES knowledge_entities(project_id, generation_id, id) ON DELETE CASCADE,
    FOREIGN KEY(project_id, generation_id, premise_assertion_id)
        REFERENCES knowledge_assertions(project_id, generation_id, id) ON DELETE CASCADE,
    FOREIGN KEY(project_id, generation_id, premise_type_inference_id)
        REFERENCES knowledge_type_inferences(project_id, generation_id, id) ON DELETE CASCADE
);

CREATE TRIGGER knowledge_type_inference_ontology_guard
BEFORE INSERT ON knowledge_type_inferences
WHEN NOT EXISTS (
    SELECT 1 FROM knowledge_generations g
    WHERE g.project_id = NEW.project_id AND g.id = NEW.generation_id
      AND (g.ontology_id = NEW.ontology_id OR EXISTS (
        SELECT 1 FROM ontology_imports oi
        WHERE oi.ontology_id = g.ontology_id
          AND oi.imported_ontology_id = NEW.ontology_id
      ))
)
BEGIN SELECT RAISE(ABORT, 'type inference axiom is outside the generation ontology'); END;
CREATE TRIGGER knowledge_type_inference_ontology_update_guard
BEFORE UPDATE OF project_id, generation_id, ontology_id ON knowledge_type_inferences
WHEN NOT EXISTS (
    SELECT 1 FROM knowledge_generations g
    WHERE g.project_id = NEW.project_id AND g.id = NEW.generation_id
      AND (g.ontology_id = NEW.ontology_id OR EXISTS (
        SELECT 1 FROM ontology_imports oi
        WHERE oi.ontology_id = g.ontology_id
          AND oi.imported_ontology_id = NEW.ontology_id
      ))
)
BEGIN SELECT RAISE(ABORT, 'type inference axiom is outside the generation ontology'); END;

CREATE TRIGGER knowledge_type_inference_class_guard
BEFORE INSERT ON knowledge_type_inferences
WHEN NOT EXISTS (
    SELECT 1 FROM ontology_terms t
    JOIN knowledge_generations g
      ON g.project_id = NEW.project_id AND g.id = NEW.generation_id
    WHERE t.term_key = NEW.class_key AND t.kind = 'class'
      AND (t.ontology_id = g.ontology_id OR t.ontology_id IN (
        SELECT imported_ontology_id FROM ontology_imports WHERE ontology_id = g.ontology_id
      ))
)
BEGIN SELECT RAISE(ABORT, 'type inference class is outside the generation ontology'); END;
CREATE TRIGGER knowledge_type_inference_class_update_guard
BEFORE UPDATE OF project_id, generation_id, class_key ON knowledge_type_inferences
WHEN NOT EXISTS (
    SELECT 1 FROM ontology_terms t
    JOIN knowledge_generations g
      ON g.project_id = NEW.project_id AND g.id = NEW.generation_id
    WHERE t.term_key = NEW.class_key AND t.kind = 'class'
      AND (t.ontology_id = g.ontology_id OR t.ontology_id IN (
        SELECT imported_ontology_id FROM ontology_imports WHERE ontology_id = g.ontology_id
      ))
)
BEGIN SELECT RAISE(ABORT, 'type inference class is outside the generation ontology'); END;

CREATE TRIGGER knowledge_type_inference_proof_entity_class_guard
BEFORE INSERT ON knowledge_type_inference_proofs
WHEN NEW.premise_kind = 'entity_class' AND NOT EXISTS (
    SELECT 1 FROM knowledge_entities e
    WHERE e.project_id = NEW.project_id AND e.generation_id = NEW.generation_id
      AND e.id = NEW.premise_entity_id AND e.class_key = NEW.premise_class_key
)
BEGIN SELECT RAISE(ABORT, 'type inference entity-class premise mismatch'); END;
CREATE TRIGGER knowledge_type_inference_proof_entity_class_update_guard
BEFORE UPDATE OF project_id, generation_id, premise_kind, premise_entity_id, premise_class_key
ON knowledge_type_inference_proofs
WHEN NEW.premise_kind = 'entity_class' AND NOT EXISTS (
    SELECT 1 FROM knowledge_entities e
    WHERE e.project_id = NEW.project_id AND e.generation_id = NEW.generation_id
      AND e.id = NEW.premise_entity_id AND e.class_key = NEW.premise_class_key
)
BEGIN SELECT RAISE(ABORT, 'type inference entity-class premise mismatch'); END;

CREATE TRIGGER knowledge_type_inferences_insert_lock
BEFORE INSERT ON knowledge_type_inferences
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_type_inferences_update_lock
BEFORE UPDATE ON knowledge_type_inferences
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
  OR (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_type_inferences_delete_lock
BEFORE DELETE ON knowledge_type_inferences
WHEN EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
 AND (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;

CREATE TRIGGER knowledge_type_inference_proofs_insert_lock
BEFORE INSERT ON knowledge_type_inference_proofs
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_type_inference_proofs_update_lock
BEFORE UPDATE ON knowledge_type_inference_proofs
WHEN (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
  OR (SELECT state FROM knowledge_generations
      WHERE project_id = NEW.project_id AND id = NEW.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
CREATE TRIGGER knowledge_type_inference_proofs_delete_lock
BEFORE DELETE ON knowledge_type_inference_proofs
WHEN EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id)
 AND (SELECT state FROM knowledge_generations
      WHERE project_id = OLD.project_id AND id = OLD.generation_id) <> 'building'
BEGIN SELECT RAISE(ABORT, 'knowledge generation is immutable outside building'); END;
`

const releaseAuditSchema = `
CREATE TABLE stage_execution_receipts (
    stage_attempt_id TEXT PRIMARY KEY REFERENCES stage_attempts(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    research_profile_version TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning_effort TEXT NOT NULL,
    service_tier TEXT NOT NULL,
    codex_thread_id TEXT NOT NULL,
    codex_turn_id TEXT NOT NULL,
    input_sha256 TEXT NOT NULL CHECK(length(input_sha256) = 64),
    output_sha256 TEXT NOT NULL CHECK(length(output_sha256) = 64),
    execution_contract_sha256 TEXT NOT NULL CHECK(length(execution_contract_sha256) = 64),
    completed_at TEXT NOT NULL
);

CREATE TRIGGER stage_execution_receipts_insert_guard
BEFORE INSERT ON stage_execution_receipts
WHEN NOT EXISTS (
    SELECT 1
    FROM stage_attempts s
    JOIN runs r ON r.id = s.run_id
    WHERE s.id = NEW.stage_attempt_id AND s.run_id = NEW.run_id
      AND s.status = 'in_progress'
      AND s.codex_thread_id = NEW.codex_thread_id
      AND s.codex_turn_id = NEW.codex_turn_id
      AND s.input_artifact_hash = NEW.input_sha256
      AND r.research_profile_version = NEW.research_profile_version
)
BEGIN SELECT RAISE(ABORT, 'stage execution receipt does not match its active attempt'); END;

CREATE TRIGGER stage_execution_receipts_update_lock
BEFORE UPDATE ON stage_execution_receipts
BEGIN SELECT RAISE(ABORT, 'stage execution receipt is immutable'); END;

CREATE TRIGGER stage_execution_receipts_delete_lock
BEFORE DELETE ON stage_execution_receipts
WHEN EXISTS(SELECT 1 FROM runs WHERE id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'stage execution receipt is immutable'); END;

CREATE TRIGGER runs_research_contract_immutable
BEFORE UPDATE OF project_id, research_profile_version, retrieval_profile, knowledge_generation_id ON runs
WHEN NEW.project_id <> OLD.project_id
  OR NEW.research_profile_version <> OLD.research_profile_version
  OR NEW.retrieval_profile <> OLD.retrieval_profile
  OR NEW.knowledge_generation_id <> OLD.knowledge_generation_id
BEGIN SELECT RAISE(ABORT, 'run research contract is immutable'); END;
`

// memoryShadowLifecycleSchema is migration 9. It adds one durable project
// pointer for the active RAG projection and makes an in-flight shadow build a
// database-enforced singleton. Existing duplicate builds are failed
// deterministically before the unique index is created; the newest build is
// retained for startup integrity recovery.
const memoryShadowLifecycleSchema = `
UPDATE embedding_indexes AS candidate
SET state = 'failed',
    error = 'superseded duplicate shadow build during migration 9',
    completed_at = CURRENT_TIMESTAMP
WHERE candidate.state = 'building'
  AND EXISTS (
    SELECT 1 FROM embedding_indexes AS newer
    WHERE newer.project_id = candidate.project_id
      AND newer.state = 'building'
      AND (
        newer.created_at > candidate.created_at OR
        (newer.created_at = candidate.created_at AND newer.id > candidate.id)
      )
  );

CREATE UNIQUE INDEX embedding_indexes_one_building
ON embedding_indexes(project_id) WHERE state = 'building';

CREATE TABLE project_memory_heads (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    active_index_id TEXT REFERENCES embedding_indexes(id) ON DELETE SET NULL,
    shadow_index_id TEXT REFERENCES embedding_indexes(id) ON DELETE SET NULL,
    memory_revision INTEGER NOT NULL DEFAULT 0 CHECK(memory_revision >= 0),
    state TEXT NOT NULL CHECK(state IN ('empty', 'ready', 'reindexing', 'failed')),
    error TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    CHECK(
        (state = 'empty' AND active_index_id IS NULL AND shadow_index_id IS NULL) OR
        (state = 'ready' AND active_index_id IS NOT NULL AND shadow_index_id IS NULL) OR
        (state = 'reindexing' AND shadow_index_id IS NOT NULL) OR
        (state = 'failed' AND shadow_index_id IS NULL)
    )
);

CREATE TRIGGER project_memory_heads_index_owner_insert_guard
BEFORE INSERT ON project_memory_heads
WHEN (NEW.active_index_id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM embedding_indexes i
        WHERE i.id = NEW.active_index_id AND i.project_id = NEW.project_id
     ))
  OR (NEW.shadow_index_id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM embedding_indexes i
        WHERE i.id = NEW.shadow_index_id AND i.project_id = NEW.project_id
     ))
BEGIN SELECT RAISE(ABORT, 'memory head index belongs to another project'); END;

CREATE TRIGGER project_memory_heads_index_owner_update_guard
BEFORE UPDATE OF project_id, active_index_id, shadow_index_id ON project_memory_heads
WHEN (NEW.active_index_id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM embedding_indexes i
        WHERE i.id = NEW.active_index_id AND i.project_id = NEW.project_id
     ))
  OR (NEW.shadow_index_id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM embedding_indexes i
        WHERE i.id = NEW.shadow_index_id AND i.project_id = NEW.project_id
     ))
BEGIN SELECT RAISE(ABORT, 'memory head index belongs to another project'); END;

INSERT INTO project_memory_heads(
    project_id, active_index_id, shadow_index_id, memory_revision, state, error, updated_at
)
SELECT p.id,
       (SELECT i.id FROM embedding_indexes i
        WHERE i.project_id = p.id AND i.state = 'active' LIMIT 1),
       (SELECT i.id FROM embedding_indexes i
        WHERE i.project_id = p.id AND i.state = 'building' LIMIT 1),
       CASE WHEN EXISTS(
         SELECT 1 FROM embedding_indexes i WHERE i.project_id = p.id AND i.state = 'active'
       ) THEN 1 ELSE 0 END,
       CASE
         WHEN EXISTS(SELECT 1 FROM embedding_indexes i
                     WHERE i.project_id = p.id AND i.state = 'building') THEN 'reindexing'
         WHEN EXISTS(SELECT 1 FROM embedding_indexes i
                     WHERE i.project_id = p.id AND i.state = 'active') THEN 'ready'
         ELSE 'empty'
       END,
       '', CURRENT_TIMESTAMP
FROM projects p;
`

// releaseBuildProvenanceSchema is migration 10. Migration 8's release audit
// tables remain checksum-stable; this migration adds an immutable product
// build identity to runs and their stage receipts.
const releaseBuildProvenanceSchema = `
ALTER TABLE runs ADD COLUMN product_version TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN executable_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN runtime_manifest_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN knowledge_sidecar_tree_sha256 TEXT NOT NULL DEFAULT '';

ALTER TABLE stage_execution_receipts ADD COLUMN product_version TEXT NOT NULL DEFAULT '';
ALTER TABLE stage_execution_receipts ADD COLUMN executable_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE stage_execution_receipts ADD COLUMN runtime_manifest_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE stage_execution_receipts ADD COLUMN knowledge_sidecar_tree_sha256 TEXT NOT NULL DEFAULT '';

CREATE TRIGGER runs_product_build_insert_guard
BEFORE INSERT ON runs
WHEN NOT (
    (NEW.product_version = '' AND NEW.executable_sha256 = ''
     AND NEW.runtime_manifest_sha256 = '' AND NEW.knowledge_sidecar_tree_sha256 = '')
    OR
    (NEW.product_version <> '' AND length(NEW.executable_sha256) = 64
     AND length(NEW.runtime_manifest_sha256) = 64
     AND length(NEW.knowledge_sidecar_tree_sha256) = 64)
)
BEGIN SELECT RAISE(ABORT, 'run product build binding is incomplete'); END;

CREATE TRIGGER runs_product_build_immutable
BEFORE UPDATE OF product_version, executable_sha256, runtime_manifest_sha256, knowledge_sidecar_tree_sha256 ON runs
WHEN NEW.product_version <> OLD.product_version
  OR NEW.executable_sha256 <> OLD.executable_sha256
  OR NEW.runtime_manifest_sha256 <> OLD.runtime_manifest_sha256
  OR NEW.knowledge_sidecar_tree_sha256 <> OLD.knowledge_sidecar_tree_sha256
BEGIN SELECT RAISE(ABORT, 'run product build binding is immutable'); END;

CREATE TRIGGER stage_execution_receipts_product_build_insert_guard
BEFORE INSERT ON stage_execution_receipts
WHEN NOT EXISTS (
    SELECT 1 FROM runs r
    WHERE r.id = NEW.run_id
      AND r.product_version = NEW.product_version
      AND r.executable_sha256 = NEW.executable_sha256
      AND r.runtime_manifest_sha256 = NEW.runtime_manifest_sha256
      AND r.knowledge_sidecar_tree_sha256 = NEW.knowledge_sidecar_tree_sha256
)
BEGIN SELECT RAISE(ABORT, 'stage execution receipt product build does not match its run'); END;
`

// stageAttemptRetrySchema is migration 11. The physical ordinal continues to
// provide the historical uniqueness key while logical_ordinal preserves the
// research contract ordinal across an explicit user-authorized retry. This
// lets an interrupted attempt remain auditable without replaying it
// automatically or deleting its external thread/turn identity.
const stageAttemptRetrySchema = `
ALTER TABLE stage_attempts ADD COLUMN logical_ordinal INTEGER NOT NULL DEFAULT 0;
UPDATE stage_attempts SET logical_ordinal = ordinal;
`

// runStatusDomainSchema is migration 12. runs remains the authoritative state
// row, so its status domain must hold even for raw SQL maintenance paths. The
// disposable CHECK table preflights every existing row inside the migration
// transaction; a legacy invalid value aborts before either trigger is created
// or the migration ledger advances.
const runStatusDomainSchema = `
CREATE TABLE migration_12_run_status_preflight (
    status TEXT NOT NULL CHECK(status IN (
        'queued', 'planning', 'collecting', 'synthesizing', 'reviewing',
        'revising', 'waiting_approval', 'succeeded', 'quality_failed',
        'failed', 'cancelled', 'interrupted', 'uncertain'
    ))
);
INSERT INTO migration_12_run_status_preflight(status)
SELECT status FROM runs;
DROP TABLE migration_12_run_status_preflight;

CREATE TRIGGER runs_status_insert_guard
BEFORE INSERT ON runs
WHEN NEW.status NOT IN (
    'queued', 'planning', 'collecting', 'synthesizing', 'reviewing',
    'revising', 'waiting_approval', 'succeeded', 'quality_failed',
    'failed', 'cancelled', 'interrupted', 'uncertain'
)
BEGIN SELECT RAISE(ABORT, 'invalid run status'); END;

CREATE TRIGGER runs_status_update_guard
BEFORE UPDATE OF status ON runs
WHEN NEW.status NOT IN (
    'queued', 'planning', 'collecting', 'synthesizing', 'reviewing',
    'revising', 'waiting_approval', 'succeeded', 'quality_failed',
    'failed', 'cancelled', 'interrupted', 'uncertain'
)
BEGIN SELECT RAISE(ABORT, 'invalid run status'); END;
`

// curationMemoProvenanceSchema is migration 13. A user curation memo is a
// pinned, fully indexed document but is not an LLM graph-adoption input. The
// dedicated bit lets the deterministic curation materializer reference its
// chunks without weakening the existing cross-project knowledge-source guard.
const curationMemoProvenanceSchema = `
ALTER TABLE documents ADD COLUMN curation_memo INTEGER NOT NULL DEFAULT 0
CHECK(curation_memo IN (0,1));

CREATE TRIGGER documents_curation_memo_insert_guard
BEFORE INSERT ON documents
WHEN NEW.curation_memo=1 AND (
  NEW.pinned<>1 OR NEW.status<>'ready' OR NEW.artifact_id IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'curation memo must be a ready pinned non-artifact document'); END;

CREATE TRIGGER documents_curation_memo_update_guard
BEFORE UPDATE OF curation_memo ON documents
WHEN NEW.curation_memo=1 AND (
  NEW.pinned<>1 OR NEW.status<>'ready' OR NEW.artifact_id IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'curation memo must be a ready pinned non-artifact document'); END;

DROP TRIGGER knowledge_source_project_guard;
DROP TRIGGER knowledge_source_project_update_guard;

CREATE TRIGGER knowledge_source_project_guard
BEFORE INSERT ON knowledge_sources
WHEN NOT EXISTS (
    SELECT 1 FROM chunks c JOIN documents d ON d.id=c.document_id
    WHERE c.id=NEW.chunk_id AND d.project_id=NEW.project_id
      AND d.blob_hash=NEW.blob_hash AND c.text_hash=NEW.text_hash
      AND (d.graph_adopt=1 OR (d.curation_memo=1 AND d.pinned=1 AND d.status='ready'))
)
BEGIN SELECT RAISE(ABORT, 'knowledge source is not graph-adopted or curation-memo provenance for this project'); END;

CREATE TRIGGER knowledge_source_project_update_guard
BEFORE UPDATE OF project_id,chunk_id,blob_hash,text_hash ON knowledge_sources
WHEN NOT EXISTS (
    SELECT 1 FROM chunks c JOIN documents d ON d.id=c.document_id
    WHERE c.id=NEW.chunk_id AND d.project_id=NEW.project_id
      AND d.blob_hash=NEW.blob_hash AND c.text_hash=NEW.text_hash
      AND (d.graph_adopt=1 OR (d.curation_memo=1 AND d.pinned=1 AND d.status='ready'))
)
BEGIN SELECT RAISE(ABORT, 'knowledge source is not graph-adopted or curation-memo provenance for this project'); END;
`

// legacyRunKnowledgeBackfillSchema is migration 14. Older successful reports
// predate ReportManifest.knowledge_patch and therefore require isolated model
// extraction before they can enter an immutable knowledge generation. The
// locator is a server-authored idempotency key; it never contains prompt text
// or model output. Keeping it on the existing append-only extraction receipt
// preserves the exact run/document/chunk/role boundary across process exit.
const legacyRunKnowledgeBackfillSchema = `
ALTER TABLE knowledge_extraction_batches ADD COLUMN source_locator_json TEXT NOT NULL DEFAULT '{}'
CHECK(json_valid(source_locator_json));

CREATE UNIQUE INDEX knowledge_extraction_batches_legacy_run_chunk_role
ON knowledge_extraction_batches(
  project_id,generation_id,run_id,document_id,
  json_extract(source_locator_json,'$.contract'),
  json_extract(source_locator_json,'$.chunk_ordinal'),
  json_extract(source_locator_json,'$.role')
)
WHERE source_kind='backfill' AND run_id IS NOT NULL
  AND json_extract(source_locator_json,'$.contract')='legacy_run_knowledge_backfill_v1';
`

// conversationPlanCyclesSchema is migration 15. Interactive planning used to
// be reconstructed from transient UI markers, which made the selected
// objective ambiguous after restart or after more than one planning cycle.
// The cycle is now an explicit, session-scoped contract. Only one active or
// ready cycle may exist, and a consumed cycle is immutably bound to one run.
const conversationPlanCyclesSchema = `
CREATE TABLE conversation_plan_cycles (
    id TEXT PRIMARY KEY,
    conversation_session_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
    objective TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','ready','consumed','superseded')),
    final_plan TEXT NOT NULL DEFAULT '',
    run_id TEXT UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ready_at TEXT,
    consumed_at TEXT,
    superseded_at TEXT,
    CHECK(
      (status='active' AND final_plan='' AND run_id IS NULL AND ready_at IS NULL AND consumed_at IS NULL AND superseded_at IS NULL) OR
      (status='ready' AND final_plan<>'' AND run_id IS NULL AND ready_at IS NOT NULL AND consumed_at IS NULL AND superseded_at IS NULL) OR
      (status='consumed' AND final_plan<>'' AND run_id IS NOT NULL AND ready_at IS NOT NULL AND consumed_at IS NOT NULL AND superseded_at IS NULL) OR
      (status='superseded' AND run_id IS NULL AND consumed_at IS NULL AND superseded_at IS NOT NULL)
    )
);

CREATE INDEX conversation_plan_cycles_session_created
ON conversation_plan_cycles(conversation_session_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX conversation_plan_cycles_one_current
ON conversation_plan_cycles(conversation_session_id)
WHERE status IN ('active','ready');

CREATE TRIGGER conversation_plan_cycles_identity_immutable
BEFORE UPDATE OF id,conversation_session_id,objective,created_at ON conversation_plan_cycles
WHEN NEW.id<>OLD.id OR NEW.conversation_session_id<>OLD.conversation_session_id
  OR NEW.objective<>OLD.objective OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT, 'conversation plan cycle identity is immutable'); END;

CREATE TRIGGER conversation_plan_cycles_terminal_immutable
BEFORE UPDATE ON conversation_plan_cycles
WHEN OLD.status IN ('consumed','superseded')
BEGIN SELECT RAISE(ABORT, 'terminal conversation plan cycle is immutable'); END;

CREATE TRIGGER conversation_plan_cycles_delete_lock
BEFORE DELETE ON conversation_plan_cycles
WHEN EXISTS(
  SELECT 1 FROM conversation_sessions s
  WHERE s.id=OLD.conversation_session_id
)
AND (OLD.run_id IS NULL OR EXISTS(SELECT 1 FROM runs r WHERE r.id=OLD.run_id))
BEGIN SELECT RAISE(ABORT, 'conversation plan cycle is append-only'); END;
`

// toolStudioSchema is migration 16. Tool proposals are immutable content-
// addressed packages. Activation is an explicit user action recorded in an
// append-only audit table; an agent can propose but cannot approve itself.
const toolStudioSchema = `
CREATE TABLE tool_packages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('skill','mcp')),
    name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL,
    version TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending_approval','active','disabled','failed')),
    manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
    package_sha256 TEXT NOT NULL CHECK(length(package_sha256)=64),
    source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    source_stage_attempt_id TEXT REFERENCES stage_attempts(id) ON DELETE SET NULL,
    requires_restart INTEGER NOT NULL CHECK(requires_restart IN (0,1)),
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    activated_at TEXT,
    UNIQUE(project_id,name,version),
    CHECK((source_run_id IS NULL) = (source_stage_attempt_id IS NULL)),
    CHECK((state='active' AND activated_at IS NOT NULL) OR state<>'active')
);
CREATE UNIQUE INDEX tool_packages_one_active_name
ON tool_packages(project_id,name) WHERE state='active';

CREATE TABLE tool_package_files (
    package_id TEXT NOT NULL REFERENCES tool_packages(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content BLOB NOT NULL,
    content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
    size INTEGER NOT NULL CHECK(size>=0),
    PRIMARY KEY(package_id,path),
    CHECK(length(content)=size)
);

CREATE TABLE tool_activation_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id TEXT NOT NULL REFERENCES tool_packages(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK(action IN ('approved','disabled','failed')),
    package_sha256 TEXT NOT NULL CHECK(length(package_sha256)=64),
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TRIGGER tool_packages_content_immutable
BEFORE UPDATE OF id,project_id,kind,name,display_name,description,version,manifest_json,
                 package_sha256,source_run_id,source_stage_attempt_id,created_at ON tool_packages
BEGIN SELECT RAISE(ABORT, 'tool package proposal content is immutable'); END;

CREATE TRIGGER tool_package_files_immutable_update
BEFORE UPDATE ON tool_package_files
BEGIN SELECT RAISE(ABORT, 'tool package files are immutable'); END;

CREATE TRIGGER tool_activation_events_immutable_update
BEFORE UPDATE ON tool_activation_events
BEGIN SELECT RAISE(ABORT, 'tool activation audit is append-only'); END;
`

// conversationContextProfileSchema is migration 17. Context selection is a
// session-scoped execution contract so a restarted UI cannot silently resume
// a Codex thread under a different window policy.
const conversationContextProfileSchema = `
ALTER TABLE conversation_sessions ADD COLUMN context_profile TEXT NOT NULL DEFAULT 'default'
CHECK(context_profile IN ('default','long_1m'));
`

// portableToolExecutionSchema is migration 18. It adds durable companion
// state without changing the content-addressed migration-16 proposal tables.
// Approval, installation, stage capability, and invocation identities are
// separate so a downloaded executable can never become a global capability.
const portableToolExecutionSchema = `
CREATE TABLE portable_tool_installations (
    id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL REFERENCES tool_packages(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    package_sha256 TEXT NOT NULL CHECK(length(package_sha256)=64),
    approval_sha256 TEXT NOT NULL CHECK(length(approval_sha256)=64),
    expected_payload_sha256 TEXT NOT NULL CHECK(length(expected_payload_sha256)=64),
    payload_blob_hash TEXT REFERENCES blobs(hash),
    payload_size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(payload_size_bytes>=0),
    installed_tree_sha256 TEXT CHECK(installed_tree_sha256 IS NULL OR length(installed_tree_sha256)=64),
    entrypoint TEXT NOT NULL DEFAULT '',
    probe_output_blob_hash TEXT REFERENCES blobs(hash),
    state TEXT NOT NULL CHECK(state IN (
      'downloading','verifying','installing','probing','ready','failed','interrupted','quarantined'
    )),
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    CHECK(payload_blob_hash IS NULL OR payload_blob_hash=expected_payload_sha256),
    CHECK(
      (state='ready' AND payload_blob_hash IS NOT NULL AND installed_tree_sha256 IS NOT NULL
       AND entrypoint<>'' AND completed_at IS NOT NULL AND error='')
      OR state<>'ready'
    )
);
CREATE INDEX portable_tool_installations_package_created
ON portable_tool_installations(package_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX portable_tool_installations_one_live
ON portable_tool_installations(package_id)
WHERE state IN ('downloading','verifying','installing','probing','ready');

CREATE TABLE tool_stage_grants (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE CASCADE,
    package_id TEXT NOT NULL REFERENCES tool_packages(id) ON DELETE CASCADE,
    installation_id TEXT NOT NULL REFERENCES portable_tool_installations(id) ON DELETE CASCADE,
    package_sha256 TEXT NOT NULL CHECK(length(package_sha256)=64),
    approval_sha256 TEXT NOT NULL CHECK(length(approval_sha256)=64),
    created_at TEXT NOT NULL,
    UNIQUE(stage_attempt_id,package_id,installation_id)
);
CREATE INDEX tool_stage_grants_run_attempt
ON tool_stage_grants(run_id,stage_attempt_id,created_at);

CREATE TABLE tool_invocations (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE CASCADE,
    package_id TEXT NOT NULL REFERENCES tool_packages(id) ON DELETE CASCADE,
    installation_id TEXT NOT NULL REFERENCES portable_tool_installations(id) ON DELETE CASCADE,
    stage_grant_id TEXT NOT NULL REFERENCES tool_stage_grants(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    arguments_sha256 TEXT NOT NULL CHECK(length(arguments_sha256)=64),
    adapter_sha256 TEXT NOT NULL CHECK(length(adapter_sha256)=64),
    state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','uncertain')),
    stdout_blob_hash TEXT REFERENCES blobs(hash),
    stderr_blob_hash TEXT REFERENCES blobs(hash),
    exit_code INTEGER,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(stage_attempt_id,idempotency_key),
    CHECK(
      (state='running' AND completed_at IS NULL AND exit_code IS NULL) OR
      (state='succeeded' AND completed_at IS NOT NULL AND exit_code IS NOT NULL AND error='') OR
      (state IN ('failed','uncertain') AND completed_at IS NOT NULL AND error<>'')
    )
);
CREATE INDEX tool_invocations_run_attempt_created
ON tool_invocations(run_id,stage_attempt_id,created_at);
CREATE UNIQUE INDEX tool_invocations_exact_stage_call
ON tool_invocations(stage_attempt_id,package_id,installation_id,tool_name,arguments_sha256,adapter_sha256);

CREATE TABLE tool_install_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    installation_id TEXT NOT NULL REFERENCES portable_tool_installations(id) ON DELETE CASCADE,
    package_id TEXT NOT NULL REFERENCES tool_packages(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK(action IN (
      'begun','downloaded','verifying','installing','probing','ready','failed','interrupted','quarantined'
    )),
    approval_sha256 TEXT NOT NULL CHECK(length(approval_sha256)=64),
    detail_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail_json)),
    created_at TEXT NOT NULL
);
CREATE INDEX tool_install_events_installation_sequence
ON tool_install_events(installation_id,sequence);

CREATE TRIGGER portable_tool_installations_insert_guard
BEFORE INSERT ON portable_tool_installations
WHEN NOT EXISTS(
  SELECT 1 FROM tool_packages p
  WHERE p.id=NEW.package_id AND p.project_id=NEW.project_id
    AND p.package_sha256=NEW.package_sha256 AND p.kind='mcp'
)
BEGIN SELECT RAISE(ABORT, 'portable installation does not match its package'); END;

CREATE TRIGGER portable_tool_installations_identity_immutable
BEFORE UPDATE OF id,package_id,project_id,package_sha256,approval_sha256,
                 expected_payload_sha256,created_at ON portable_tool_installations
BEGIN SELECT RAISE(ABORT, 'portable installation identity is immutable'); END;

CREATE TRIGGER portable_tool_installations_state_guard
BEFORE UPDATE OF state ON portable_tool_installations
WHEN NOT (
  NEW.state=OLD.state OR
  (OLD.state='downloading' AND NEW.state IN ('verifying','failed','interrupted','quarantined')) OR
  (OLD.state='verifying' AND NEW.state IN ('installing','failed','interrupted','quarantined')) OR
  (OLD.state='installing' AND NEW.state IN ('probing','failed','interrupted','quarantined')) OR
  (OLD.state='probing' AND NEW.state IN ('ready','failed','interrupted','quarantined'))
)
BEGIN SELECT RAISE(ABORT, 'invalid portable installation transition'); END;

CREATE TRIGGER portable_tool_installations_terminal_immutable
BEFORE UPDATE ON portable_tool_installations
WHEN OLD.state IN ('ready','failed','interrupted','quarantined')
BEGIN SELECT RAISE(ABORT, 'terminal portable installation is immutable'); END;

CREATE TRIGGER tool_stage_grants_insert_guard
BEFORE INSERT ON tool_stage_grants
WHEN NOT EXISTS(
  SELECT 1
  FROM stage_attempts s
  JOIN runs r ON r.id=s.run_id
  JOIN tool_packages p ON p.id=NEW.package_id
  JOIN portable_tool_installations i ON i.id=NEW.installation_id
  WHERE s.id=NEW.stage_attempt_id AND s.run_id=NEW.run_id
    AND r.project_id=NEW.project_id AND p.project_id=NEW.project_id
    AND p.state='active' AND p.package_sha256=NEW.package_sha256
    AND i.package_id=p.id AND i.project_id=NEW.project_id AND i.state='ready'
    AND i.package_sha256=NEW.package_sha256 AND i.approval_sha256=NEW.approval_sha256
)
BEGIN SELECT RAISE(ABORT, 'tool stage grant does not match an active installed package'); END;

CREATE TRIGGER tool_stage_grants_immutable
BEFORE UPDATE ON tool_stage_grants
BEGIN SELECT RAISE(ABORT, 'tool stage grant is immutable'); END;

CREATE TRIGGER tool_invocations_insert_guard
BEFORE INSERT ON tool_invocations
WHEN NOT EXISTS(
  SELECT 1
  FROM tool_stage_grants g
  JOIN tool_packages p ON p.id=g.package_id
  JOIN portable_tool_installations i ON i.id=g.installation_id
  WHERE g.id=NEW.stage_grant_id AND g.project_id=NEW.project_id
    AND g.run_id=NEW.run_id AND g.stage_attempt_id=NEW.stage_attempt_id
    AND g.package_id=NEW.package_id AND g.installation_id=NEW.installation_id
    AND p.state='active' AND p.project_id=NEW.project_id
    AND i.state='ready' AND i.project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'tool invocation does not match its exact stage grant'); END;

CREATE TRIGGER tool_invocations_identity_immutable
BEFORE UPDATE OF id,idempotency_key,project_id,run_id,stage_attempt_id,package_id,
                 installation_id,stage_grant_id,tool_name,arguments_sha256,
                 adapter_sha256,created_at,started_at ON tool_invocations
BEGIN SELECT RAISE(ABORT, 'tool invocation identity is immutable'); END;

CREATE TRIGGER tool_invocations_terminal_immutable
BEFORE UPDATE ON tool_invocations
WHEN OLD.state IN ('succeeded','failed','uncertain')
BEGIN SELECT RAISE(ABORT, 'terminal tool invocation is immutable'); END;

CREATE TRIGGER tool_invocations_state_guard
BEFORE UPDATE OF state ON tool_invocations
WHEN NOT (OLD.state='running' AND NEW.state IN ('succeeded','failed','uncertain'))
BEGIN SELECT RAISE(ABORT, 'invalid tool invocation transition'); END;

CREATE TRIGGER tool_install_events_immutable
BEFORE UPDATE ON tool_install_events
BEGIN SELECT RAISE(ABORT, 'tool installation audit is append-only'); END;

CREATE TRIGGER tool_packages_portable_activation_guard
BEFORE UPDATE OF state ON tool_packages
WHEN NEW.state='active'
  AND json_extract(NEW.manifest_json,'$.schema')='aetherops_tool_package_v2'
  AND NOT EXISTS(
    SELECT 1 FROM portable_tool_installations i
    WHERE i.package_id=NEW.id AND i.project_id=NEW.project_id
      AND i.package_sha256=NEW.package_sha256 AND i.state='ready'
  )
BEGIN SELECT RAISE(ABORT, 'portable tool package has no ready installation'); END;
`

// researchRemediationSchema is migration 19. A failed REVIEW can request a
// fresh research cycle without deleting or reinterpreting the prior immutable
// stage artifacts. The previous attempt graph is retained as superseded audit
// history; this row carries the exact structured gap into the next PLAN.
const researchRemediationSchema = `
CREATE TABLE research_remediation_cycles (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    cycle INTEGER NOT NULL CHECK(cycle BETWEEN 1 AND 3),
    action TEXT NOT NULL CHECK(action IN ('additional_research','replan')),
    review_stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id),
    review_output_hash TEXT NOT NULL REFERENCES blobs(hash),
    summary TEXT NOT NULL,
    revision_requests_json TEXT NOT NULL CHECK(json_valid(revision_requests_json)),
    remediation_tasks_json TEXT NOT NULL CHECK(json_valid(remediation_tasks_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(run_id,cycle),
    UNIQUE(review_stage_attempt_id)
);
CREATE INDEX research_remediation_cycles_run_created
ON research_remediation_cycles(run_id,created_at);
`
