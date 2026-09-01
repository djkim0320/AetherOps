package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/id"
)

var (
	ErrProjectBusy       = errors.New("project has active or uncertain work")
	ErrApprovalNotActive = errors.New("approval request is no longer active")
)

// CreateProject is retained for migration and store-fixture compatibility. It
// creates the legacy snapshotless logical-empty head, which strict knowledge
// reads reject. Product code must use knowledge.Service.CreateProject so the
// project and its verified ontology snapshot become visible atomically.
func (db *DB) CreateProject(ctx context.Context, name string) (core.Project, error) {
	projectID, err := id.New("prj")
	if err != nil {
		return core.Project{}, err
	}
	sessionID, err := id.New("ses")
	if err != nil {
		return core.Project{}, err
	}
	generationID, err := id.New("kgen")
	if err != nil {
		return core.Project{}, err
	}
	now := time.Now().UTC()
	project := core.Project{ID: projectID, Name: name, CreatedAt: now, UpdatedAt: now}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.Project{}, err
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(ctx,
		"INSERT INTO projects(id, name, main_thread_id, created_at, updated_at) VALUES(?, ?, '', ?, ?)",
		project.ID, project.Name, formatTime(now), formatTime(now)); err != nil {
		return core.Project{}, err
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO conversation_sessions(
  id, project_id, title, codex_thread_id, status, revision, model, reasoning_effort,
  service_tier, created_at, updated_at, deleted_at
) VALUES(?, ?, '새 대화', '', 'unprovisioned', 0, '', '', '', ?, ?, NULL)`,
		sessionID, project.ID, formatTime(now), formatTime(now)); err != nil {
		return core.Project{}, err
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO knowledge_generations(
  project_id, id, ontology_id, contract_sha256, manifest_sha256, state,
  source_count, entity_count, assertion_count, error,
  created_at, validating_at, ready_at, retired_at, failed_at
) VALUES(?, ?, ?, ?, ?, 'ready', 0, 0, 0, '', ?, ?, ?, NULL, NULL)`,
		project.ID, generationID, CoreOntologyID, CoreOntologyContractSHA256,
		EmptyKnowledgeManifestSHA256, formatTime(now), formatTime(now), formatTime(now)); err != nil {
		return core.Project{}, err
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO project_knowledge_heads(
  project_id, generation_id, knowledge_revision, status, error, activated_at, updated_at
) VALUES(?, ?, 1, 'ready', '', ?, ?)`,
		project.ID, generationID, formatTime(now), formatTime(now)); err != nil {
		return core.Project{}, err
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO project_memory_heads(
  project_id, active_index_id, shadow_index_id, memory_revision, state, error, updated_at
) VALUES(?, NULL, NULL, 0, 'empty', '', ?)`, project.ID, formatTime(now)); err != nil {
		return core.Project{}, err
	}
	return project, transaction.Commit()
}

// CreateProjectWithKnowledgeSnapshot creates the product-visible project and
// its ontology-bearing empty graph as one SQLite transaction. The caller must
// publish and verify the canonical N-Quads object in CAS, then register that
// immutable blob before entering this method. This keeps a newly returned
// project from ever exposing the legacy snapshotless logical-empty head.
func (db *DB) CreateProjectWithKnowledgeSnapshot(
	ctx context.Context,
	name string,
	snapshot cas.Receipt,
	tripleCount int,
	contractSHA256 string,
) (core.Project, error) {
	if strings.TrimSpace(name) == "" || !validSHA256(snapshot.Hash) || snapshot.Size < 0 ||
		tripleCount <= 0 || !validSHA256(contractSHA256) {
		return core.Project{}, errors.New("project name and verified ontology snapshot contract are required")
	}
	projectID, err := id.New("prj")
	if err != nil {
		return core.Project{}, err
	}
	sessionID, err := id.New("ses")
	if err != nil {
		return core.Project{}, err
	}
	generationID, err := id.New("kgen")
	if err != nil {
		return core.Project{}, err
	}
	now := time.Now().UTC()
	project := core.Project{ID: projectID, Name: strings.TrimSpace(name), CreatedAt: now, UpdatedAt: now}
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.Project{}, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		"INSERT INTO projects(id, name, main_thread_id, created_at, updated_at) VALUES(?, ?, '', ?, ?)",
		project.ID, project.Name, formatTime(now), formatTime(now)); err != nil {
		return core.Project{}, err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO conversation_sessions(
  id, project_id, title, codex_thread_id, status, revision, model, reasoning_effort,
  service_tier, created_at, updated_at, deleted_at
) VALUES(?, ?, '새 대화', '', 'unprovisioned', 0, '', '', '', ?, ?, NULL)`,
		sessionID, project.ID, formatTime(now), formatTime(now)); err != nil {
		return core.Project{}, err
	}
	var registeredSize int64
	var registeredMediaType string
	if err := tx.QueryRowContext(ctx,
		"SELECT size,media_type FROM blobs WHERE hash=?", snapshot.Hash,
	).Scan(&registeredSize, &registeredMediaType); err != nil {
		return core.Project{}, fmt.Errorf("resolve registered ontology snapshot: %w", err)
	}
	if registeredSize != snapshot.Size || registeredMediaType != "application/n-quads" {
		return core.Project{}, errors.New("registered ontology snapshot metadata does not match its CAS receipt")
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO knowledge_generations(
  project_id, id, ontology_id, contract_sha256, manifest_sha256, state,
  source_count, entity_count, assertion_count, error,
  created_at, validating_at, ready_at, retired_at, failed_at
) VALUES(?, ?, ?, ?, '', 'building', 0, 0, 0, '', ?, NULL, NULL, NULL, NULL)`,
		project.ID, generationID, CoreOntologyID, strings.ToLower(contractSHA256), formatTime(now)); err != nil {
		return core.Project{}, err
	}
	expected, expectedTriples, err := buildKnowledgeNQuads(ctx, tx, project.ID, generationID, CoreOntologyID)
	if err != nil {
		return core.Project{}, err
	}
	expectedSum := sha256.Sum256(expected)
	if hex.EncodeToString(expectedSum[:]) != snapshot.Hash || expectedTriples != tripleCount || int64(len(expected)) != snapshot.Size {
		return core.Project{}, errors.New("ontology snapshot does not match the authoritative empty project projection")
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO knowledge_rdf_snapshots(
  project_id,generation_id,id,format,blob_hash,dataset_sha256,triple_count,created_at
) VALUES(?,?,?,?,?,?,?,?)`, project.ID, generationID, "krdf_"+snapshot.Hash[:32], "n-quads",
		snapshot.Hash, snapshot.Hash, tripleCount, formatTime(now)); err != nil {
		return core.Project{}, err
	}
	counts, manifest, err := validateKnowledgeGeneration(ctx, tx, project.ID, generationID, CoreOntologyID)
	if err != nil {
		return core.Project{}, err
	}
	if counts.sources != 0 || counts.entities != 0 || counts.assertions != 0 {
		return core.Project{}, errors.New("new project graph is not empty")
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE knowledge_generations SET state='validating',validating_at=?
WHERE project_id=? AND id=? AND state='building'`, formatTime(now), project.ID, generationID); err != nil {
		return core.Project{}, err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE knowledge_generations
SET state='ready',manifest_sha256=?,ready_at=?
WHERE project_id=? AND id=? AND state='validating'`,
		manifest, formatTime(now), project.ID, generationID); err != nil {
		return core.Project{}, err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO project_knowledge_heads(
  project_id, generation_id, knowledge_revision, status, error, activated_at, updated_at
) VALUES(?, ?, 1, 'ready', '', ?, ?)`,
		project.ID, generationID, formatTime(now), formatTime(now)); err != nil {
		return core.Project{}, err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO project_memory_heads(
  project_id, active_index_id, shadow_index_id, memory_revision, state, error, updated_at
) VALUES(?, NULL, NULL, 0, 'empty', '', ?)`, project.ID, formatTime(now)); err != nil {
		return core.Project{}, err
	}
	return project, tx.Commit()
}

func (db *DB) ListProjects(ctx context.Context) ([]core.Project, error) {
	rows, err := db.sql.QueryContext(ctx, `
SELECT id, name, main_thread_id, created_at, updated_at
FROM projects
ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var projects []core.Project
	for rows.Next() {
		project, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		projects = append(projects, project)
	}
	return projects, rows.Err()
}

func (db *DB) Project(ctx context.Context, projectID string) (core.Project, error) {
	return scanProject(db.sql.QueryRowContext(ctx, `
SELECT id, name, main_thread_id, created_at, updated_at
FROM projects WHERE id = ?`, projectID))
}

// RenameProject updates only the user-facing project name. Research state,
// conversation sessions, knowledge heads, and CAS references remain untouched.
func (db *DB) RenameProject(ctx context.Context, projectID, name string) (core.Project, error) {
	name = strings.TrimSpace(name)
	if projectID == "" || name == "" {
		return core.Project{}, errors.New("project id and name are required")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.Project{}, err
	}
	defer transaction.Rollback()
	current, err := scanProject(transaction.QueryRowContext(ctx, `
SELECT id, name, main_thread_id, created_at, updated_at
FROM projects WHERE id = ?`, projectID))
	if err != nil {
		return core.Project{}, err
	}
	now := time.Now().UTC()
	// Windows wall-clock resolution can return the same instant for two
	// consecutive user actions. Keep durable project revisions strictly
	// monotonic so UI refreshes and audit comparisons never miss a rename.
	if !now.After(current.UpdatedAt) {
		now = current.UpdatedAt.Add(time.Nanosecond)
	}
	result, err := transaction.ExecContext(ctx,
		"UPDATE projects SET name = ?, updated_at = ? WHERE id = ?",
		name, formatTime(now), projectID)
	if err != nil {
		return core.Project{}, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return core.Project{}, err
	}
	if count != 1 {
		return core.Project{}, sql.ErrNoRows
	}
	project, err := scanProject(transaction.QueryRowContext(ctx, `
SELECT id, name, main_thread_id, created_at, updated_at
FROM projects WHERE id = ?`, projectID))
	if err != nil {
		return core.Project{}, err
	}
	if err := transaction.Commit(); err != nil {
		return core.Project{}, err
	}
	return project, nil
}

func (db *DB) SetProjectMainThread(ctx context.Context, projectID, threadID string) error {
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	now := formatTime(time.Now())
	result, err := transaction.ExecContext(ctx,
		"UPDATE projects SET main_thread_id = ?, updated_at = ? WHERE id = ?",
		threadID, now, projectID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return sql.ErrNoRows
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE conversation_sessions SET codex_thread_id = ?, status = 'active', revision = revision + 1, updated_at = ?
WHERE id = (
  SELECT id FROM conversation_sessions
  WHERE project_id = ? AND deleted_at IS NULL
  ORDER BY created_at, id LIMIT 1
)`, threadID, now, projectID); err != nil {
		return err
	}
	return transaction.Commit()
}

func (db *DB) SetProjectMainThreadIfEmpty(ctx context.Context, projectID, threadID string) (string, error) {
	if threadID == "" {
		return "", errors.New("main thread id is empty")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(ctx, `
UPDATE projects SET main_thread_id = ?, updated_at = ?
WHERE id = ? AND main_thread_id = ''`, threadID, formatTime(time.Now()), projectID); err != nil {
		return "", err
	}
	var actual string
	if err := transaction.QueryRowContext(ctx,
		"SELECT main_thread_id FROM projects WHERE id = ?", projectID).Scan(&actual); err != nil {
		return "", err
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE conversation_sessions SET codex_thread_id = ?, status = 'active', revision = revision + 1, updated_at = ?
WHERE id = (
  SELECT id FROM conversation_sessions
  WHERE project_id = ? AND deleted_at IS NULL
  ORDER BY created_at, id LIMIT 1
) AND codex_thread_id = ''`, actual, formatTime(time.Now()), projectID); err != nil {
		return "", err
	}
	if err := transaction.Commit(); err != nil {
		return "", err
	}
	return actual, nil
}

// DeleteProject removes a project's relational state and returns CAS hashes
// which became unreferenced. The caller removes those exact CAS objects after
// the transaction commits.
func (db *DB) DeleteProject(ctx context.Context, projectID string) ([]string, error) {
	if strings.TrimSpace(projectID) == "" {
		return nil, errors.New("project id is required")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer transaction.Rollback()
	var activeWork int
	if err := transaction.QueryRowContext(ctx, `
SELECT
  (SELECT COUNT(*) FROM runs
   WHERE project_id=? AND status IN (
     'queued','planning','collecting','synthesizing','reviewing','revising',
     'waiting_approval','interrupted','uncertain'
   )) +
  (SELECT COUNT(*) FROM engineering_jobs
   WHERE project_id=? AND status IN ('running','uncertain')) +
  (SELECT COUNT(*) FROM knowledge_generations
   WHERE project_id=? AND state IN ('building','validating')) +
  (SELECT COUNT(*) FROM knowledge_extraction_batches
   WHERE project_id=? AND status IN ('queued','extracting','reviewing','validated','interrupted')) +
  (SELECT COUNT(*) FROM conversation_sessions
   WHERE project_id=? AND deleted_at IS NULL AND status IN ('provisioning','creation_unknown')) +
  (SELECT COUNT(*) FROM approvals a JOIN runs r ON r.id=a.run_id
   WHERE r.project_id=? AND a.status='pending') +
  (SELECT COUNT(*) FROM embedding_indexes
   WHERE project_id=? AND state='building') +
  (SELECT COUNT(*) FROM portable_tool_installations
   WHERE project_id=? AND state IN ('downloading','verifying','installing','probing')) +
  (SELECT COUNT(*) FROM tool_invocations
   WHERE project_id=? AND state IN ('running','uncertain'))`, projectID, projectID, projectID, projectID,
		projectID, projectID, projectID, projectID, projectID).Scan(&activeWork); err != nil {
		return nil, err
	}
	if activeWork != 0 {
		return nil, ErrProjectBusy
	}
	rows, err := transaction.QueryContext(ctx, `
SELECT DISTINCT blob_hash FROM (
  SELECT a.blob_hash FROM artifacts a JOIN runs r ON r.id = a.run_id WHERE r.project_id = ?
  UNION ALL
  SELECT e.blob_hash FROM evidence e JOIN runs r ON r.id = e.run_id WHERE r.project_id = ?
  UNION ALL
  SELECT s.input_artifact_hash FROM stage_attempts s JOIN runs r ON r.id = s.run_id
    WHERE r.project_id = ? AND s.input_artifact_hash <> ''
  UNION ALL
  SELECT s.output_artifact_hash FROM stage_attempts s JOIN runs r ON r.id = s.run_id
    WHERE r.project_id = ? AND s.output_artifact_hash <> ''
  UNION ALL
  SELECT d.blob_hash FROM documents d WHERE d.project_id = ?
  UNION ALL
  SELECT o.source_blob_hash FROM ontology_versions o
    WHERE o.project_id = ? AND o.source_blob_hash IS NOT NULL
  UNION ALL
  SELECT o.canonical_blob_hash FROM ontology_versions o
    WHERE o.project_id = ? AND o.canonical_blob_hash IS NOT NULL
  UNION ALL
  SELECT k.patch_blob_hash FROM knowledge_extraction_batches k
    WHERE k.project_id = ? AND k.patch_blob_hash IS NOT NULL
  UNION ALL
  SELECT k.blob_hash FROM knowledge_sources k WHERE k.project_id = ?
  UNION ALL
  SELECT k.blob_hash FROM knowledge_assertion_evidence k WHERE k.project_id = ?
  UNION ALL
  SELECT k.blob_hash FROM knowledge_rdf_snapshots k WHERE k.project_id = ?
  UNION ALL
  SELECT i.payload_blob_hash FROM portable_tool_installations i
    WHERE i.project_id = ? AND i.payload_blob_hash IS NOT NULL
  UNION ALL
  SELECT i.probe_output_blob_hash FROM portable_tool_installations i
    WHERE i.project_id = ? AND i.probe_output_blob_hash IS NOT NULL
  UNION ALL
  SELECT i.stdout_blob_hash FROM tool_invocations i
    WHERE i.project_id = ? AND i.stdout_blob_hash IS NOT NULL
  UNION ALL
  SELECT i.stderr_blob_hash FROM tool_invocations i
    WHERE i.project_id = ? AND i.stderr_blob_hash IS NOT NULL
  UNION ALL
  SELECT json_extract(c.payload_json, '$.memo_blob_hash')
    FROM knowledge_curation_events c
    WHERE c.project_id = ? AND json_type(c.payload_json, '$.memo_blob_hash') = 'text'
)`, projectID, projectID, projectID, projectID, projectID, projectID, projectID, projectID, projectID, projectID, projectID,
		projectID, projectID, projectID, projectID, projectID)
	if err != nil {
		return nil, err
	}
	var candidates []string
	for rows.Next() {
		var hash string
		if err := rows.Scan(&hash); err != nil {
			rows.Close()
			return nil, err
		}
		candidates = append(candidates, hash)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	// Runs and schedules point at conversation sessions with ON DELETE
	// RESTRICT, while all three are project-owned. Delete the dependants in an
	// explicit order so a confirmed project deletion cannot depend on SQLite's
	// cascade traversal order. Engineering jobs must precede their approvals.
	for _, statement := range []string{
		"DELETE FROM engineering_jobs WHERE project_id = ?",
		"DELETE FROM schedules WHERE project_id = ?",
		"DELETE FROM runs WHERE project_id = ?",
	} {
		if _, err := transaction.ExecContext(ctx, statement, projectID); err != nil {
			return nil, err
		}
	}
	result, err := transaction.ExecContext(ctx, "DELETE FROM projects WHERE id = ?", projectID)
	if err != nil {
		return nil, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, sql.ErrNoRows
	}
	var orphaned []string
	for _, hash := range candidates {
		var references int
		if err := transaction.QueryRowContext(ctx, `
SELECT
  (SELECT COUNT(*) FROM artifacts WHERE blob_hash = ?) +
  (SELECT COUNT(*) FROM evidence WHERE blob_hash = ?) +
  (SELECT COUNT(*) FROM stage_attempts WHERE input_artifact_hash = ?) +
  (SELECT COUNT(*) FROM stage_attempts WHERE output_artifact_hash = ?) +
  (SELECT COUNT(*) FROM documents WHERE blob_hash = ?) +
  (SELECT COUNT(*) FROM downloads WHERE blob_hash = ?) +
  (SELECT COUNT(*) FROM ontology_versions WHERE source_blob_hash = ? OR canonical_blob_hash = ?) +
  (SELECT COUNT(*) FROM knowledge_extraction_batches WHERE patch_blob_hash = ?) +
  (SELECT COUNT(*) FROM knowledge_sources WHERE blob_hash = ?) +
  (SELECT COUNT(*) FROM knowledge_assertion_evidence WHERE blob_hash = ?) +
  (SELECT COUNT(*) FROM knowledge_rdf_snapshots WHERE blob_hash = ?) +
  (SELECT COUNT(*) FROM portable_tool_installations
     WHERE payload_blob_hash = ? OR probe_output_blob_hash = ?) +
  (SELECT COUNT(*) FROM tool_invocations
     WHERE stdout_blob_hash = ? OR stderr_blob_hash = ?) +
  (SELECT COUNT(*) FROM knowledge_curation_events
     WHERE json_extract(payload_json, '$.memo_blob_hash') = ?)`,
			hash, hash, hash, hash, hash, hash, hash, hash, hash, hash, hash, hash,
			hash, hash, hash, hash, hash).Scan(&references); err != nil {
			return nil, err
		}
		if references == 0 {
			if _, err := transaction.ExecContext(ctx, "DELETE FROM blobs WHERE hash = ?", hash); err != nil {
				return nil, err
			}
			orphaned = append(orphaned, hash)
		}
	}
	if err := transaction.Commit(); err != nil {
		return nil, err
	}
	return orphaned, nil
}

type scanner interface {
	Scan(...any) error
}

func scanProject(row scanner) (core.Project, error) {
	var project core.Project
	var created, updated string
	if err := row.Scan(&project.ID, &project.Name, &project.MainThreadID, &created, &updated); err != nil {
		return core.Project{}, err
	}
	var err error
	project.CreatedAt, err = parseTime(created)
	if err != nil {
		return core.Project{}, err
	}
	project.UpdatedAt, err = parseTime(updated)
	return project, err
}

func (db *DB) CreateRun(ctx context.Context, projectID, scheduleID, question, mainThreadID string) (core.Run, error) {
	return db.CreateRunConfigured(ctx, projectID, scheduleID, question, mainThreadID, core.RunConfiguration{})
}

// CreateRunConfigured stores the exact user-selected model settings alongside
// the queued run so a restart or explicit resume cannot pick up newer UI
// defaults. Empty configuration is retained for scheduler-owned stage defaults.
func (db *DB) CreateRunConfigured(
	ctx context.Context,
	projectID, scheduleID, question, mainThreadID string,
	configuration core.RunConfiguration,
) (core.Run, error) {
	session, err := db.DefaultConversationSession(ctx, projectID)
	if err != nil {
		return core.Run{}, err
	}
	if session.CodexThreadID == "" && mainThreadID != "" {
		actual, err := db.SetProjectMainThreadIfEmpty(ctx, projectID, mainThreadID)
		if err != nil {
			return core.Run{}, err
		}
		session.CodexThreadID = actual
	}
	return db.CreateConversationRunConfigured(ctx, session.ID, scheduleID, question, mainThreadID, configuration)
}

// CreateConversationRunConfigured snapshots both the selected conversation
// identity and its Codex thread into the run. Later session edits cannot change
// the execution contract of an already queued run.
func (db *DB) CreateConversationRunConfigured(
	ctx context.Context,
	conversationSessionID, scheduleID, question, mainThreadID string,
	configuration core.RunConfiguration,
) (core.Run, error) {
	return db.createConversationRunConfigured(ctx, conversationSessionID, scheduleID, question, mainThreadID, "", configuration)
}

// CreatePlannedConversationRunConfigured consumes exactly one latest ready
// planning cycle in the same transaction that creates its run. The client does
// not provide the research brief, so a stale UI card cannot pair an old
// objective with a newer final plan or create the same planned run twice.
func (db *DB) CreatePlannedConversationRunConfigured(
	ctx context.Context,
	conversationSessionID, planCycleID, mainThreadID string,
	configuration core.RunConfiguration,
) (core.Run, error) {
	if strings.TrimSpace(planCycleID) == "" {
		return core.Run{}, errors.New("plan cycle id is required")
	}
	return db.createConversationRunConfigured(ctx, conversationSessionID, "", "", mainThreadID, planCycleID, configuration)
}

func (db *DB) createConversationRunConfigured(
	ctx context.Context,
	conversationSessionID, scheduleID, question, mainThreadID, planCycleID string,
	configuration core.RunConfiguration,
) (core.Run, error) {
	session, err := db.ConversationSession(ctx, conversationSessionID)
	if err != nil {
		return core.Run{}, err
	}
	if session.CodexThreadID != mainThreadID {
		return core.Run{}, errors.New("conversation session thread does not match run thread")
	}
	knowledgeHead, err := db.EnsureEmptyKnowledgeGeneration(ctx, session.ProjectID)
	if err != nil {
		return core.Run{}, fmt.Errorf("resolve run knowledge generation: %w", err)
	}
	if knowledgeHead.Status != KnowledgeHeadReady || knowledgeHead.Generation.State != KnowledgeReady {
		return core.Run{}, fmt.Errorf("hybrid_graph_v1 research is blocked while knowledge graph is %s/%s", knowledgeHead.Status, knowledgeHead.Generation.State)
	}
	runID, err := id.New("run")
	if err != nil {
		return core.Run{}, err
	}
	now := time.Now().UTC()
	productBuild := db.productBuildBinding()
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.Run{}, err
	}
	defer transaction.Rollback()
	if planCycleID != "" {
		cycle, cycleErr := scanConversationPlanCycle(transaction.QueryRowContext(ctx,
			planCycleSelect+" WHERE conversation_session_id=? AND id=?", session.ID, planCycleID))
		if cycleErr != nil {
			return core.Run{}, cycleErr
		}
		if cycle.Status != "ready" {
			return core.Run{}, ErrPlanCycleNotReady
		}
		var latestID string
		if err := transaction.QueryRowContext(ctx, `
SELECT id FROM conversation_plan_cycles
WHERE conversation_session_id=? ORDER BY created_at DESC,id DESC LIMIT 1`, session.ID).Scan(&latestID); err != nil {
			return core.Run{}, err
		}
		if latestID != cycle.ID {
			return core.Run{}, ErrPlanCycleSuperseded
		}
		// The final plan is the executable contract. The original objective stays
		// in the append-only plan cycle for audit, but replaying it into every
		// research stage can reintroduce instructions that the interview already
		// superseded (for example, an earlier "do not start research" preflight).
		question = "계획 모드에서 합의된 실행 계획:\n" + cycle.FinalPlan
	}
	run := core.Run{
		ID: runID, ProjectID: session.ProjectID, ConversationSessionID: session.ID,
		ScheduleID: scheduleID, Question: question,
		Status: core.RunQueued, MainThreadID: mainThreadID,
		ResearchProfileVersion: core.CurrentResearchProfileVersion,
		RetrievalProfile:       DefaultRetrievalProfile,
		KnowledgeGenerationID:  knowledgeHead.GenerationID,
		Model:                  configuration.Model, ReasoningEffort: configuration.ReasoningEffort,
		ServiceTier: configuration.ServiceTier, ProductBuild: productBuild,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := rejectRunWithMemoryReindex(ctx, transaction, session.ProjectID); err != nil {
		return core.Run{}, err
	}
	_, err = transaction.ExecContext(ctx, `
INSERT INTO runs(
  id, project_id, conversation_session_id, schedule_id, question, status, revision, revision_cycle,
	  main_thread_id, research_profile_version, retrieval_profile, knowledge_generation_id,
	  model, reasoning_effort, service_tier,
	  product_version, executable_sha256, runtime_manifest_sha256, knowledge_sidecar_tree_sha256,
	  report_artifact_id, error, created_at, updated_at
) VALUES(?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)`,
		run.ID, run.ProjectID, run.ConversationSessionID, run.ScheduleID, run.Question, run.Status,
		run.MainThreadID, run.ResearchProfileVersion, run.RetrievalProfile, run.KnowledgeGenerationID,
		run.Model, run.ReasoningEffort, run.ServiceTier,
		run.ProductBuild.Version, run.ProductBuild.ExecutableSHA256,
		run.ProductBuild.RuntimeManifestSHA256, run.ProductBuild.KnowledgeSidecarTreeSHA256,
		formatTime(now), formatTime(now),
	)
	if err != nil {
		return core.Run{}, err
	}
	if err := appendEvent(ctx, transaction, run.ID, "run.created", map[string]any{
		"status": run.Status, "model": run.Model, "reasoning_effort": run.ReasoningEffort,
		"service_tier": run.ServiceTier, "conversation_session_id": run.ConversationSessionID,
		"research_profile_version": run.ResearchProfileVersion,
		"retrieval_profile":        run.RetrievalProfile,
		"knowledge_generation_id":  run.KnowledgeGenerationID,
		"product_build":            run.ProductBuild,
		"plan_cycle_id":            planCycleID,
	}, now); err != nil {
		return core.Run{}, err
	}
	if planCycleID != "" {
		result, err := transaction.ExecContext(ctx, `
UPDATE conversation_plan_cycles
SET status='consumed',run_id=?,updated_at=?,consumed_at=?
WHERE conversation_session_id=? AND id=? AND status='ready'`,
			run.ID, formatTime(now), formatTime(now), session.ID, planCycleID)
		if err != nil {
			return core.Run{}, err
		}
		if count, err := result.RowsAffected(); err != nil || count != 1 {
			return core.Run{}, fmt.Errorf("consume plan cycle: affected=%d err=%v", count, err)
		}
	}
	if err := transaction.Commit(); err != nil {
		return core.Run{}, err
	}
	return run, nil
}

func (db *DB) Run(ctx context.Context, runID string) (core.Run, error) {
	return scanRun(db.sql.QueryRowContext(ctx, runSelect+" WHERE id = ?", runID))
}

func (db *DB) ListRuns(ctx context.Context, projectID string, limit int) ([]core.Run, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := db.sql.QueryContext(
		ctx,
		runSelect+" WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
		projectID,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var runs []core.Run
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

func (db *DB) ListConversationRuns(ctx context.Context, conversationSessionID string, limit int) ([]core.Run, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := db.sql.QueryContext(ctx,
		runSelect+" WHERE conversation_session_id = ? ORDER BY created_at DESC LIMIT ?",
		conversationSessionID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var runs []core.Run
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

func (db *DB) ListRunsByStatus(ctx context.Context, statuses ...core.RunStatus) ([]core.Run, error) {
	if len(statuses) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(statuses))
	arguments := make([]any, len(statuses))
	for index, status := range statuses {
		placeholders[index] = "?"
		arguments[index] = status
	}
	rows, err := db.sql.QueryContext(ctx,
		runSelect+" WHERE status IN ("+strings.Join(placeholders, ",")+") ORDER BY created_at, id",
		arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var runs []core.Run
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

const runSelect = `
SELECT id, project_id, conversation_session_id, schedule_id, question, status, revision, revision_cycle,
       main_thread_id, research_profile_version, retrieval_profile, knowledge_generation_id,
       model, reasoning_effort, service_tier,
       product_version, executable_sha256, runtime_manifest_sha256, knowledge_sidecar_tree_sha256,
       report_artifact_id, error, created_at, updated_at
FROM runs`

func scanRun(row scanner) (core.Run, error) {
	var run core.Run
	var created, updated string
	if err := row.Scan(
		&run.ID, &run.ProjectID, &run.ConversationSessionID, &run.ScheduleID, &run.Question, &run.Status,
		&run.Revision, &run.RevisionCycle, &run.MainThreadID,
		&run.ResearchProfileVersion, &run.RetrievalProfile, &run.KnowledgeGenerationID,
		&run.Model, &run.ReasoningEffort, &run.ServiceTier,
		&run.ProductBuild.Version, &run.ProductBuild.ExecutableSHA256,
		&run.ProductBuild.RuntimeManifestSHA256, &run.ProductBuild.KnowledgeSidecarTreeSHA256,
		&run.ReportArtifactID,
		&run.Error, &created, &updated,
	); err != nil {
		return core.Run{}, err
	}
	var err error
	run.CreatedAt, err = parseTime(created)
	if err != nil {
		return core.Run{}, err
	}
	run.UpdatedAt, err = parseTime(updated)
	return run, err
}

func (db *DB) TransitionRun(
	ctx context.Context,
	runID string,
	expectedRevision int64,
	next core.RunStatus,
	errorMessage string,
) (core.Run, error) {
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.Run{}, err
	}
	defer transaction.Rollback()
	current, err := scanRun(transaction.QueryRowContext(ctx, runSelect+" WHERE id = ?", runID))
	if err != nil {
		return core.Run{}, err
	}
	if current.Revision != expectedRevision {
		return core.Run{}, fmt.Errorf("run revision conflict: expected %d, found %d", expectedRevision, current.Revision)
	}
	if err := core.RequireTransition(current.Status, next); err != nil {
		return core.Run{}, err
	}
	now := time.Now().UTC()
	result, err := transaction.ExecContext(ctx, `
UPDATE runs
SET status = ?, revision = revision + 1, error = ?, updated_at = ?
WHERE id = ? AND revision = ?`,
		next, errorMessage, formatTime(now), runID, expectedRevision,
	)
	if err != nil {
		return core.Run{}, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return core.Run{}, err
	}
	if count != 1 {
		return core.Run{}, errors.New("run transition lost optimistic concurrency race")
	}
	if retiresPendingApprovals(next) {
		if err := retirePendingApprovals(ctx, transaction, runID, "run_"+string(next), now); err != nil {
			return core.Run{}, err
		}
	}
	if err := appendEvent(ctx, transaction, runID, "run.transition", map[string]any{
		"from": current.Status, "to": next, "revision": expectedRevision + 1, "error": errorMessage,
	}, now); err != nil {
		return core.Run{}, err
	}
	if err := transaction.Commit(); err != nil {
		return core.Run{}, err
	}
	current.Status = next
	current.Revision++
	current.Error = errorMessage
	current.UpdatedAt = now
	return current, nil
}

// QuiesceRun is the dispatcher terminalization boundary. It serializes with
// automatic external-action authorization and inspects the durable stage
// marker before deciding the final status. If an in-flight stage may already
// have crossed an external boundary, an ordinary cancellation or failure is
// recorded as uncertain instead. A terminalization that commits first makes a
// later authorization fail its active-run check.
//
// RunUncertain is intentionally idempotent here. Only DiscardRun represents a
// user's explicit decision to resolve that state as cancelled.
func (db *DB) QuiesceRun(
	ctx context.Context,
	runID string,
	requested core.RunStatus,
	errorMessage string,
) (core.Run, error) {
	if requested != core.RunCancelled && requested != core.RunFailed {
		return core.Run{}, errors.New("run quiescence requires cancelled or failed status")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.Run{}, err
	}
	defer transaction.Rollback()
	current, err := scanRun(transaction.QueryRowContext(ctx, runSelect+" WHERE id = ?", runID))
	if err != nil {
		return core.Run{}, err
	}
	if core.IsTerminal(current.Status) || current.Status == core.RunUncertain {
		return current, nil
	}
	updated, err := quiesceRunTransaction(
		ctx, transaction, current, requested, errorMessage, time.Now().UTC(),
	)
	if err != nil {
		return core.Run{}, err
	}
	if err := transaction.Commit(); err != nil {
		return core.Run{}, err
	}
	return updated, nil
}

func quiesceRunTransaction(
	ctx context.Context,
	transaction *sql.Tx,
	current core.Run,
	requested core.RunStatus,
	errorMessage string,
	now time.Time,
) (core.Run, error) {
	next := requested
	var sideEffectCount int
	if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM stage_attempts
WHERE run_id = ? AND external_side_effects = 1 AND status <> 'completed'`, current.ID).Scan(&sideEffectCount); err != nil {
		return core.Run{}, err
	}
	if sideEffectCount > 0 {
		next = core.RunUncertain
	}
	if err := core.RequireTransition(current.Status, next); err != nil {
		return core.Run{}, err
	}
	result, err := transaction.ExecContext(ctx, `
UPDATE runs
SET status = ?, revision = revision + 1, error = ?, updated_at = ?
WHERE id = ? AND revision = ?`,
		next, errorMessage, formatTime(now), current.ID, current.Revision,
	)
	if err != nil {
		return core.Run{}, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("run quiescence lost optimistic concurrency race")
		}
		return core.Run{}, err
	}
	if err := retirePendingApprovals(ctx, transaction, current.ID, "run_"+string(next), now); err != nil {
		return core.Run{}, err
	}
	payload := map[string]any{
		"from": current.Status, "to": next, "revision": current.Revision + 1, "error": errorMessage,
	}
	if next != requested {
		payload["requested"] = requested
		payload["external_side_effects"] = true
	}
	if err := appendEvent(ctx, transaction, current.ID, "run.transition", payload, now); err != nil {
		return core.Run{}, err
	}
	current.Status = next
	current.Revision++
	current.Error = errorMessage
	current.UpdatedAt = now
	return current, nil
}

// ResumeRunAfterApproval restores the stage status only after the last
// approval has been decided and while at least one owning turn is still live.
// It closes the race where a late UI click revived collecting after every
// collector had already failed.
func (db *DB) ResumeRunAfterApproval(
	ctx context.Context,
	runID string,
	prior core.RunStatus,
) (core.Run, error) {
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.Run{}, err
	}
	defer transaction.Rollback()
	current, err := scanRun(transaction.QueryRowContext(ctx, runSelect+" WHERE id = ?", runID))
	if err != nil {
		return core.Run{}, err
	}
	if current.Status != core.RunWaitingApproval {
		return current, ErrApprovalNotActive
	}
	var pendingCount int
	if err := transaction.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM approvals WHERE run_id = ? AND status = 'pending'", runID,
	).Scan(&pendingCount); err != nil {
		return core.Run{}, err
	}
	if pendingCount > 0 {
		return current, nil
	}
	var activeCount int
	if err := transaction.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM stage_attempts WHERE run_id = ? AND status = 'in_progress'", runID,
	).Scan(&activeCount); err != nil {
		return core.Run{}, err
	}
	if activeCount == 0 {
		return current, ErrApprovalNotActive
	}
	if err := core.RequireTransition(current.Status, prior); err != nil {
		return core.Run{}, err
	}
	now := time.Now().UTC()
	result, err := transaction.ExecContext(ctx, `
UPDATE runs
SET status = ?, revision = revision + 1, error = '', updated_at = ?
WHERE id = ? AND revision = ?`, prior, formatTime(now), runID, current.Revision)
	if err != nil {
		return core.Run{}, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("approval resume lost optimistic concurrency race")
		}
		return core.Run{}, err
	}
	if err := appendEvent(ctx, transaction, runID, "run.transition", map[string]any{
		"from": current.Status, "to": prior, "revision": current.Revision + 1, "error": "",
	}, now); err != nil {
		return core.Run{}, err
	}
	if err := transaction.Commit(); err != nil {
		return core.Run{}, err
	}
	current.Status = prior
	current.Revision++
	current.Error = ""
	current.UpdatedAt = now
	return current, nil
}

// SucceedRun is retained for store fixtures and migrations that do not render a
// user-facing Word companion. Product research execution uses
// SucceedRunWithReportDocument.
func (db *DB) SucceedRun(ctx context.Context, runID string, expectedRevision int64) (core.Run, error) {
	return db.succeedRun(ctx, runID, expectedRevision, nil)
}

type adoptedReportDocument struct {
	artifactID string
	receipt    cas.Receipt
}

// SucceedRunWithReportDocument commits the canonical JSON ReportManifest and
// its template-rendered DOCX companion in one SQLite transaction. The JSON
// artifact remains runs.report_artifact_id because knowledge and memory
// materialization decode that structured contract; the DOCX is an additional
// adopted, human-facing artifact on the same final report attempt.
func (db *DB) SucceedRunWithReportDocument(
	ctx context.Context,
	runID string,
	expectedRevision int64,
	documentReceipt cas.Receipt,
) (core.Run, error) {
	if documentReceipt.Hash == "" || documentReceipt.Size <= 0 {
		return core.Run{}, errors.New("report document CAS receipt is invalid")
	}
	artifactID, err := id.New("art")
	if err != nil {
		return core.Run{}, err
	}
	return db.succeedRun(ctx, runID, expectedRevision, &adoptedReportDocument{
		artifactID: artifactID,
		receipt:    documentReceipt,
	})
}

// succeedRun atomically transitions a reviewed run and adopts only its final
// report, optional rendered companion, and captured evidence. Draft plans,
// reviews, and superseded report revisions remain visible but are never marked
// as long-term memory inputs.
func (db *DB) succeedRun(
	ctx context.Context,
	runID string,
	expectedRevision int64,
	document *adoptedReportDocument,
) (core.Run, error) {
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.Run{}, err
	}
	defer transaction.Rollback()
	current, err := scanRun(transaction.QueryRowContext(ctx, runSelect+" WHERE id = ?", runID))
	if err != nil {
		return core.Run{}, err
	}
	if current.Revision != expectedRevision {
		return core.Run{}, fmt.Errorf("run revision conflict: expected %d, found %d", expectedRevision, current.Revision)
	}
	if err := core.RequireTransition(current.Status, core.RunSucceeded); err != nil {
		return core.Run{}, err
	}
	var reportArtifactID, reportAttemptID string
	err = transaction.QueryRowContext(ctx, `
SELECT a.id, a.stage_attempt_id
FROM artifacts a
JOIN stage_attempts s ON s.id = a.stage_attempt_id
WHERE a.run_id = ? AND s.status = 'completed'
  AND ((s.stage = 'synthesize' AND s.logical_ordinal = 0 AND ? = 0 AND a.kind = 'research.report')
    OR (s.stage = 'revise' AND s.logical_ordinal = ? AND a.kind = 'research.report.revision'))
ORDER BY a.created_at DESC, a.id DESC
LIMIT 1`, runID, current.RevisionCycle, current.RevisionCycle).Scan(&reportArtifactID, &reportAttemptID)
	if err != nil {
		return core.Run{}, fmt.Errorf("resolve final report artifact: %w", err)
	}
	now := time.Now().UTC()
	if document != nil {
		if _, err := transaction.ExecContext(ctx, `
INSERT INTO blobs(hash, size, media_type, created_at)
VALUES(?, ?, ?, ?)
ON CONFLICT(hash) DO NOTHING`,
			document.receipt.Hash, document.receipt.Size,
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document", formatTime(now),
		); err != nil {
			return core.Run{}, err
		}
		var storedSize int64
		var storedMediaType string
		if err := transaction.QueryRowContext(
			ctx, "SELECT size, media_type FROM blobs WHERE hash = ?", document.receipt.Hash,
		).Scan(&storedSize, &storedMediaType); err != nil {
			return core.Run{}, err
		}
		if storedSize != document.receipt.Size || storedMediaType != "application/vnd.openxmlformats-officedocument.wordprocessingml.document" {
			return core.Run{}, errors.New("report document blob metadata conflicts with CAS receipt")
		}
		if _, err := transaction.ExecContext(ctx, `
INSERT INTO artifacts(id, run_id, stage_attempt_id, kind, blob_hash, adopted, created_at)
VALUES(?, ?, ?, 'research.report.document', ?, 1, ?)`,
			document.artifactID, runID, reportAttemptID, document.receipt.Hash, formatTime(now),
		); err != nil {
			return core.Run{}, err
		}
		if err := appendEvent(ctx, transaction, runID, "artifact.published", map[string]any{
			"artifact_id": document.artifactID, "attempt_id": reportAttemptID,
			"kind": "research.report.document", "blob_hash": document.receipt.Hash,
		}, now); err != nil {
			return core.Run{}, err
		}
	}
	result, err := transaction.ExecContext(ctx, `
UPDATE runs
SET status = ?, revision = revision + 1, report_artifact_id = ?, error = '', updated_at = ?
WHERE id = ? AND revision = ?`, core.RunSucceeded, reportArtifactID, formatTime(now), runID, expectedRevision)
	if err != nil {
		return core.Run{}, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err != nil {
			return core.Run{}, err
		}
		return core.Run{}, errors.New("run success transition lost optimistic concurrency race")
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE artifacts SET adopted = 1
WHERE id = ? OR (run_id = ? AND stage_attempt_id IN (
  SELECT id FROM stage_attempts WHERE run_id = ? AND stage = 'collect' AND status = 'completed'
))`, reportArtifactID, runID, runID); err != nil {
		return core.Run{}, err
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE evidence SET adopted = 1
WHERE run_id = ? AND stage_attempt_id IN (
  SELECT id FROM stage_attempts
  WHERE run_id = ? AND status = 'completed'
)`, runID, runID); err != nil {
		return core.Run{}, err
	}
	// The report commit and graph invalidation are one durable boundary. A
	// process exit after this transaction can leave projection work pending,
	// but can never present the previous graph as current.
	headResult, err := transaction.ExecContext(ctx, `
UPDATE project_knowledge_heads
SET status='stale',error='successful run adoption is pending',
    knowledge_revision=knowledge_revision+1,updated_at=?
WHERE project_id=?`, formatTime(now), current.ProjectID)
	if err != nil {
		return core.Run{}, err
	}
	if count, err := headResult.RowsAffected(); err != nil || count != 1 {
		if err != nil {
			return core.Run{}, err
		}
		return core.Run{}, errors.New("successful run could not invalidate its knowledge head")
	}
	if err := retirePendingApprovals(ctx, transaction, runID, "run_"+string(core.RunSucceeded), now); err != nil {
		return core.Run{}, err
	}
	if err := appendEvent(ctx, transaction, runID, "run.transition", map[string]any{
		"from": current.Status, "to": core.RunSucceeded, "revision": expectedRevision + 1,
		"report_artifact_id": reportArtifactID,
	}, now); err != nil {
		return core.Run{}, err
	}
	if err := transaction.Commit(); err != nil {
		return core.Run{}, err
	}
	current.Status = core.RunSucceeded
	current.Revision++
	current.ReportArtifactID = reportArtifactID
	current.Error = ""
	current.UpdatedAt = now
	return current, nil
}

func (db *DB) SetRunCycle(ctx context.Context, runID string, expectedRevision int64, cycle int) (core.Run, error) {
	if cycle < 0 || cycle > core.MaxRevisions {
		return core.Run{}, errors.New("revision cycle outside allowed range")
	}
	result, err := db.sql.ExecContext(ctx, `
UPDATE runs SET revision_cycle = ?, revision = revision + 1, updated_at = ?
WHERE id = ? AND revision = ?`, cycle, formatTime(time.Now()), runID, expectedRevision)
	if err != nil {
		return core.Run{}, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return core.Run{}, err
	}
	if count != 1 {
		return core.Run{}, errors.New("run cycle update lost optimistic concurrency race")
	}
	return db.Run(ctx, runID)
}

func (db *DB) BeginStage(
	ctx context.Context,
	runID string,
	stage core.Stage,
	ordinal int,
	codexThreadID string,
	inputHash string,
) (core.StageAttempt, error) {
	attemptID, err := id.New("stg")
	if err != nil {
		return core.StageAttempt{}, err
	}
	now := time.Now().UTC()
	attempt := core.StageAttempt{
		ID: attemptID, RunID: runID, Stage: stage, Ordinal: ordinal, Status: "in_progress",
		CodexThreadID: codexThreadID, InputArtifactHash: inputHash, CreatedAt: now, UpdatedAt: now,
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.StageAttempt{}, err
	}
	defer transaction.Rollback()
	_, err = transaction.ExecContext(ctx, `
INSERT INTO stage_attempts(
  id, run_id, stage, ordinal, status, codex_thread_id, codex_turn_id,
  input_artifact_hash, output_artifact_hash, external_side_effects, error,
  created_at, updated_at, logical_ordinal
) VALUES(?, ?, ?, ?, 'in_progress', ?, '', ?, '', 0, '', ?, ?, ?)`,
		attempt.ID, attempt.RunID, attempt.Stage, attempt.Ordinal,
		attempt.CodexThreadID, attempt.InputArtifactHash, formatTime(now), formatTime(now), attempt.Ordinal,
	)
	if err != nil {
		return core.StageAttempt{}, err
	}
	if err := appendEvent(ctx, transaction, runID, "stage.started", map[string]any{
		"attempt_id": attempt.ID, "stage": stage, "ordinal": ordinal,
	}, now); err != nil {
		return core.StageAttempt{}, err
	}
	if err := transaction.Commit(); err != nil {
		return core.StageAttempt{}, err
	}
	return attempt, nil
}

func (db *DB) LatestStageAttempt(ctx context.Context, runID string) (core.StageAttempt, error) {
	return scanStageAttempt(db.sql.QueryRowContext(ctx, `
SELECT id, run_id, stage, logical_ordinal, status, codex_thread_id, codex_turn_id,
       input_artifact_hash, output_artifact_hash, external_side_effects, error,
       created_at, updated_at
FROM stage_attempts WHERE run_id = ?
ORDER BY created_at DESC, id DESC LIMIT 1`, runID))
}

// StageAttempt resolves one run-owned attempt without weakening the active
// capability checks performed by the caller. It is used to apply stage-local
// tool allowlists before a request can reach a side-effecting implementation.
func (db *DB) StageAttempt(ctx context.Context, runID, attemptID string) (core.StageAttempt, error) {
	return scanStageAttempt(db.sql.QueryRowContext(ctx, `
SELECT id, run_id, stage, logical_ordinal, status, codex_thread_id, codex_turn_id,
       input_artifact_hash, output_artifact_hash, external_side_effects, error,
       created_at, updated_at
FROM stage_attempts WHERE id = ? AND run_id = ?`, attemptID, runID))
}

func (db *DB) ActiveStageAttemptByThread(ctx context.Context, threadID string) (core.StageAttempt, error) {
	return scanStageAttempt(db.sql.QueryRowContext(ctx, `
SELECT id, run_id, stage, logical_ordinal, status, codex_thread_id, codex_turn_id,
       input_artifact_hash, output_artifact_hash, external_side_effects, error,
       created_at, updated_at
FROM stage_attempts
WHERE codex_thread_id = ? AND status = 'in_progress'
ORDER BY created_at DESC, id DESC LIMIT 1`, threadID))
}

func (db *DB) ListStageAttempts(ctx context.Context, runID string) ([]core.StageAttempt, error) {
	rows, err := db.sql.QueryContext(ctx, `
SELECT id, run_id, stage, logical_ordinal, status, codex_thread_id, codex_turn_id,
       input_artifact_hash, output_artifact_hash, external_side_effects, error,
       created_at, updated_at
FROM stage_attempts WHERE run_id = ? ORDER BY created_at, id`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var attempts []core.StageAttempt
	for rows.Next() {
		attempt, err := scanStageAttempt(rows)
		if err != nil {
			return nil, err
		}
		attempts = append(attempts, attempt)
	}
	return attempts, rows.Err()
}

func scanStageAttempt(row scanner) (core.StageAttempt, error) {
	var attempt core.StageAttempt
	var created, updated string
	if err := row.Scan(&attempt.ID, &attempt.RunID, &attempt.Stage, &attempt.Ordinal,
		&attempt.Status, &attempt.CodexThreadID, &attempt.CodexTurnID,
		&attempt.InputArtifactHash, &attempt.OutputArtifactHash,
		&attempt.ExternalSideEffects, &attempt.Error, &created, &updated); err != nil {
		return core.StageAttempt{}, err
	}
	var err error
	attempt.CreatedAt, err = parseTime(created)
	if err != nil {
		return core.StageAttempt{}, err
	}
	attempt.UpdatedAt, err = parseTime(updated)
	return attempt, err
}

func (db *DB) SetStageTurn(ctx context.Context, attemptID, threadID, turnID string) error {
	result, err := db.sql.ExecContext(ctx, `
UPDATE stage_attempts
SET codex_thread_id = ?, codex_turn_id = ?, updated_at = ?
WHERE id = ? AND status = 'in_progress'`,
		threadID, turnID, formatTime(time.Now()), attemptID,
	)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return sql.ErrNoRows
	}
	return nil
}

func (db *DB) MarkStageExternalSideEffects(ctx context.Context, attemptID string) error {
	result, err := db.sql.ExecContext(ctx, `
UPDATE stage_attempts
SET external_side_effects = 1, updated_at = ?
WHERE id = ? AND status = 'in_progress'`, formatTime(time.Now()), attemptID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return sql.ErrNoRows
	}
	return nil
}

// MarkActiveStageExternalSideEffects is the automatic-approval authorization
// boundary. Unlike MarkStageExternalSideEffects, it validates the owning run
// and attempt in the same write transaction before recording that an external
// action may be released to Codex. This prevents a stale Chrome or external
// MCP request from being accepted after its run has failed or been cancelled.
//
// A run can be waiting_approval while another live attempt owns an automatic
// request, so that status is accepted in addition to the attempt's stage
// status. A durable collector failure always wins and closes this boundary.
func (db *DB) MarkActiveStageExternalSideEffects(ctx context.Context, attemptID string) error {
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	var attemptStatus string
	var stage core.Stage
	var runStatus core.RunStatus
	var failedCollectorExists bool
	if err := transaction.QueryRowContext(ctx, `
SELECT s.status, s.stage, r.status,
       EXISTS(
         SELECT 1 FROM stage_attempts failed
         WHERE failed.run_id = s.run_id
           AND failed.stage = 'collect'
           AND failed.status = 'failed'
       )
FROM stage_attempts s
JOIN runs r ON r.id = s.run_id
WHERE s.id = ?`, attemptID).Scan(
		&attemptStatus, &stage, &runStatus, &failedCollectorExists,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrApprovalNotActive
		}
		return err
	}
	expectedRunStatus, ok := activeRunStatusForStage(stage)
	if !ok || attemptStatus != "in_progress" || failedCollectorExists ||
		(runStatus != expectedRunStatus && runStatus != core.RunWaitingApproval) {
		return ErrApprovalNotActive
	}
	now := time.Now().UTC()
	result, err := transaction.ExecContext(ctx, `
UPDATE stage_attempts
SET external_side_effects = 1, updated_at = ?
WHERE id = ? AND status = 'in_progress'`, formatTime(now), attemptID)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = ErrApprovalNotActive
		}
		return err
	}
	return transaction.Commit()
}

func activeRunStatusForStage(stage core.Stage) (core.RunStatus, bool) {
	switch stage {
	case core.StagePlan:
		return core.RunPlanning, true
	case core.StageCollect:
		return core.RunCollecting, true
	case core.StageSynthesize:
		return core.RunSynthesizing, true
	case core.StageReview:
		return core.RunReviewing, true
	case core.StageRevise:
		return core.RunRevising, true
	default:
		return "", false
	}
}

func (db *DB) CompleteStage(ctx context.Context, attemptID, outputHash, stageError string) error {
	status := "completed"
	if stageError != "" {
		status = "failed"
	}
	result, err := db.sql.ExecContext(ctx, `
UPDATE stage_attempts
SET status = ?, output_artifact_hash = ?, error = ?, updated_at = ?
WHERE id = ? AND status = 'in_progress'`,
		status, outputHash, stageError, formatTime(time.Now()), attemptID,
	)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return errors.New("stage was not active")
	}
	return nil
}

// FailCollectStageAndQuiesceRun records the first substantive collector
// failure and closes its run in one transaction. This is the linearization
// point that makes every pending approval non-actionable before sibling
// collectors are cancelled. Later collector failures only close their own
// attempts; they never create a second terminal transition.
func (db *DB) FailCollectStageAndQuiesceRun(
	ctx context.Context,
	attemptID, outputHash, stageError string,
) (core.Run, error) {
	if strings.TrimSpace(attemptID) == "" || strings.TrimSpace(stageError) == "" {
		return core.Run{}, errors.New("collector attempt and failure are required")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.Run{}, err
	}
	defer transaction.Rollback()
	var runID string
	var stage core.Stage
	var attemptStatus string
	if err := transaction.QueryRowContext(ctx, `
SELECT run_id, stage, status
FROM stage_attempts
WHERE id = ?`, attemptID).Scan(&runID, &stage, &attemptStatus); err != nil {
		return core.Run{}, err
	}
	if stage != core.StageCollect {
		return core.Run{}, errors.New("only a collect attempt can quiesce collection")
	}
	if attemptStatus != "in_progress" {
		return core.Run{}, errors.New("stage was not active")
	}
	current, err := scanRun(transaction.QueryRowContext(ctx, runSelect+" WHERE id = ?", runID))
	if err != nil {
		return core.Run{}, err
	}
	now := time.Now().UTC()
	result, err := transaction.ExecContext(ctx, `
UPDATE stage_attempts
SET status = 'failed', output_artifact_hash = ?, error = ?, updated_at = ?
WHERE id = ? AND status = 'in_progress'`,
		outputHash, stageError, formatTime(now), attemptID)
	if err != nil {
		return core.Run{}, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("stage was not active")
		}
		return core.Run{}, err
	}
	if core.IsTerminal(current.Status) || current.Status == core.RunInterrupted || current.Status == core.RunUncertain {
		if err := transaction.Commit(); err != nil {
			return core.Run{}, err
		}
		return current, nil
	}
	current, err = quiesceRunTransaction(
		ctx, transaction, current, core.RunFailed, stageError, now,
	)
	if err != nil {
		return core.Run{}, err
	}
	if err := transaction.Commit(); err != nil {
		return core.Run{}, err
	}
	return current, nil
}

// CompleteStageWithExecution atomically completes a successful stage and
// persists the exact model profile accepted from Codex App Server. Release
// verification never infers these values from UI preferences or a run label.
func (db *DB) CompleteStageWithExecution(
	ctx context.Context,
	attemptID, outputHash string,
	receipt StageExecutionReceipt,
) error {
	if attemptID == "" || receipt.StageAttemptID != attemptID || receipt.RunID == "" ||
		receipt.ResearchProfileVersion == "" || receipt.Model == "" || receipt.ReasoningEffort == "" ||
		receipt.ServiceTier == "" || receipt.CodexThreadID == "" || receipt.CodexTurnID == "" ||
		receipt.InputSHA256 == "" || outputHash == "" || receipt.OutputSHA256 != outputHash ||
		receipt.ExecutionContractSHA256 != core.StageExecutionContractSHA256 {
		return errors.New("complete stage execution receipt is incomplete or inconsistent")
	}
	if !receipt.ProductBuild.IsZero() {
		if err := receipt.ProductBuild.Validate(); err != nil {
			return fmt.Errorf("complete stage execution product build: %w", err)
		}
	}
	now := time.Now().UTC()
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO stage_execution_receipts(
	  stage_attempt_id,run_id,research_profile_version,model,reasoning_effort,service_tier,
	  codex_thread_id,codex_turn_id,input_sha256,output_sha256,execution_contract_sha256,
	  product_version,executable_sha256,runtime_manifest_sha256,knowledge_sidecar_tree_sha256,completed_at
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		receipt.StageAttemptID, receipt.RunID, receipt.ResearchProfileVersion,
		receipt.Model, receipt.ReasoningEffort, receipt.ServiceTier,
		receipt.CodexThreadID, receipt.CodexTurnID, receipt.InputSHA256,
		receipt.OutputSHA256, receipt.ExecutionContractSHA256,
		receipt.ProductBuild.Version, receipt.ProductBuild.ExecutableSHA256,
		receipt.ProductBuild.RuntimeManifestSHA256, receipt.ProductBuild.KnowledgeSidecarTreeSHA256,
		formatTime(now)); err != nil {
		return err
	}
	result, err := transaction.ExecContext(ctx, `
UPDATE stage_attempts
SET status='completed',output_artifact_hash=?,error='',updated_at=?
WHERE id=? AND status='in_progress'`, outputHash, formatTime(now), attemptID)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("stage was not active")
		}
		return err
	}
	return transaction.Commit()
}

func (db *DB) StageExecutionReceipt(ctx context.Context, attemptID string) (StageExecutionReceipt, error) {
	var receipt StageExecutionReceipt
	var completed string
	err := db.sql.QueryRowContext(ctx, `
SELECT stage_attempt_id,run_id,research_profile_version,model,reasoning_effort,service_tier,
	   codex_thread_id,codex_turn_id,input_sha256,output_sha256,execution_contract_sha256,
	   product_version,executable_sha256,runtime_manifest_sha256,knowledge_sidecar_tree_sha256,completed_at
FROM stage_execution_receipts WHERE stage_attempt_id=?`, attemptID).Scan(
		&receipt.StageAttemptID, &receipt.RunID, &receipt.ResearchProfileVersion,
		&receipt.Model, &receipt.ReasoningEffort, &receipt.ServiceTier,
		&receipt.CodexThreadID, &receipt.CodexTurnID, &receipt.InputSHA256,
		&receipt.OutputSHA256, &receipt.ExecutionContractSHA256,
		&receipt.ProductBuild.Version, &receipt.ProductBuild.ExecutableSHA256,
		&receipt.ProductBuild.RuntimeManifestSHA256, &receipt.ProductBuild.KnowledgeSidecarTreeSHA256,
		&completed,
	)
	if err != nil {
		return StageExecutionReceipt{}, err
	}
	receipt.CompletedAt, err = parseTime(completed)
	return receipt, err
}

func (db *DB) RecoverInFlight(ctx context.Context) (int, error) {
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer transaction.Rollback()
	rows, err := transaction.QueryContext(ctx, `
SELECT r.id, r.revision,
       COALESCE(MAX(CASE WHEN s.status IN ('in_progress','interrupted')
                         THEN s.external_side_effects ELSE 0 END), 0)
FROM runs r
LEFT JOIN stage_attempts s ON s.run_id = r.id
WHERE r.status IN ('planning','collecting','synthesizing','reviewing','revising','waiting_approval')
GROUP BY r.id, r.revision`)
	if err != nil {
		return 0, err
	}
	type recovery struct {
		runID       string
		revision    int64
		sideEffects bool
	}
	var recoveries []recovery
	for rows.Next() {
		var item recovery
		if err := rows.Scan(&item.runID, &item.revision, &item.sideEffects); err != nil {
			rows.Close()
			return 0, err
		}
		recoveries = append(recoveries, item)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	now := time.Now().UTC()
	// Native tool installation and invocation boundaries share this startup
	// transaction with run recovery. Interrupted installation work is safe to
	// retry only as a new attempt; a running native invocation is uncertain and
	// must never be replayed automatically.
	if _, err := recoverToolWork(ctx, transaction, now); err != nil {
		return 0, err
	}
	// Codex approval request IDs are scoped to the live App Server process. On
	// restart they cannot be answered safely, so never leave a stale approval
	// actionable in the UI.
	if _, err := transaction.ExecContext(ctx, `
UPDATE approvals
SET status = 'expired', updated_at = ?
WHERE status IN ('pending', 'authorizing')`, formatTime(now)); err != nil {
		return 0, err
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE engineering_jobs
SET status = 'uncertain', error = 'application exited while the external solver outcome was unknown',
    completed_at = ?, updated_at = ?
WHERE status = 'running'`, formatTime(now), formatTime(now)); err != nil {
		return 0, err
	}
	for _, item := range recoveries {
		status := core.RunInterrupted
		if item.sideEffects {
			status = core.RunUncertain
		}
		result, err := transaction.ExecContext(ctx, `
UPDATE runs SET status = ?, revision = revision + 1, updated_at = ?
WHERE id = ? AND revision = ?`, status, formatTime(now), item.runID, item.revision)
		if err != nil {
			return 0, err
		}
		count, err := result.RowsAffected()
		if err != nil || count != 1 {
			if err == nil {
				err = errors.New("recovery revision conflict")
			}
			return 0, err
		}
		if _, err := transaction.ExecContext(ctx, `
UPDATE stage_attempts
SET status = ?, updated_at = ?
WHERE run_id = ? AND status = 'in_progress'`, status, formatTime(now), item.runID); err != nil {
			return 0, err
		}
		if err := appendEvent(ctx, transaction, item.runID, "run.recovered", map[string]any{
			"status": status, "external_side_effects": item.sideEffects,
		}, now); err != nil {
			return 0, err
		}
	}
	if err := transaction.Commit(); err != nil {
		return 0, err
	}
	return len(recoveries), nil
}

// PrepareInterruptedRunForResume archives incomplete read-only attempts while
// retaining their immutable audit data. The user-facing logical ordinal stays
// unchanged, but a negative physical ordinal frees the stage uniqueness key so
// the explicit resume can create a fresh attempt. It is deliberately separate
// from startup recovery: no external turn is retried until the user asks.
func (db *DB) PrepareInterruptedRunForResume(ctx context.Context, runID string) error {
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	var status core.RunStatus
	if err := transaction.QueryRowContext(ctx, "SELECT status FROM runs WHERE id = ?", runID).Scan(&status); err != nil {
		return err
	}
	if status != core.RunInterrupted {
		return errors.New("only interrupted runs can be prepared for resume")
	}
	rows, err := transaction.QueryContext(ctx, `
SELECT id, stage, logical_ordinal, external_side_effects
FROM stage_attempts
WHERE run_id = ? AND status IN ('in_progress', 'interrupted')
ORDER BY created_at, id`, runID)
	if err != nil {
		return err
	}
	type interruptedAttempt struct {
		id, stage      string
		logicalOrdinal int
		external       bool
	}
	var attempts []interruptedAttempt
	for rows.Next() {
		var attempt interruptedAttempt
		if err := rows.Scan(&attempt.id, &attempt.stage, &attempt.logicalOrdinal, &attempt.external); err != nil {
			rows.Close()
			return err
		}
		attempts = append(attempts, attempt)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	now := time.Now().UTC()
	for _, attempt := range attempts {
		if attempt.external {
			return errors.New("interrupted attempt with external side effects cannot be resumed")
		}
		var minimum int
		if err := transaction.QueryRowContext(ctx, `
SELECT COALESCE(MIN(ordinal), 0) FROM stage_attempts WHERE run_id = ? AND stage = ?`,
			runID, attempt.stage).Scan(&minimum); err != nil {
			return err
		}
		archivedOrdinal := minimum - 1
		if minimum > 0 {
			archivedOrdinal = -1
		}
		result, err := transaction.ExecContext(ctx, `
UPDATE stage_attempts
SET ordinal = ?, status = 'superseded',
    error = CASE WHEN error = '' THEN ? ELSE error || '; ' || ? END,
    updated_at = ?
WHERE id = ? AND run_id = ? AND status IN ('in_progress', 'interrupted') AND external_side_effects = 0`,
			archivedOrdinal, "archived by explicit resume", "archived by explicit resume",
			formatTime(now), attempt.id, runID)
		if err != nil {
			return err
		}
		if changed, err := result.RowsAffected(); err != nil || changed != 1 {
			if err == nil {
				err = errors.New("interrupted attempt changed while preparing resume")
			}
			return err
		}
		if err := appendEvent(ctx, transaction, runID, "stage.retry_authorized", map[string]any{
			"attempt_id": attempt.id, "stage": attempt.stage, "ordinal": attempt.logicalOrdinal,
		}, now); err != nil {
			return err
		}
	}
	return transaction.Commit()
}

// PreparePlanContractRetry archives one failed, side-effect-free PLAN attempt
// while preserving its logical ordinal and audit trail. It is deliberately
// narrower than interrupted-run recovery: only a run that is still planning
// may retry a deterministic schema/contract rejection, and an attempt that
// crossed any external side-effect boundary is never replayed automatically.
func (db *DB) PreparePlanContractRetry(ctx context.Context, runID, attemptID string) error {
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	var runStatus core.RunStatus
	if err := transaction.QueryRowContext(ctx, "SELECT status FROM runs WHERE id=?", runID).Scan(&runStatus); err != nil {
		return err
	}
	if runStatus != core.RunPlanning {
		return errors.New("PLAN contract retry requires a planning run")
	}
	var stage, status string
	var ordinal, logicalOrdinal int
	var external bool
	if err := transaction.QueryRowContext(ctx, `
SELECT stage,status,ordinal,logical_ordinal,external_side_effects
FROM stage_attempts WHERE id=? AND run_id=?`, attemptID, runID).Scan(
		&stage, &status, &ordinal, &logicalOrdinal, &external,
	); err != nil {
		return err
	}
	if stage != string(core.StagePlan) || status != "failed" || logicalOrdinal != 0 || ordinal != 0 || external {
		return errors.New("only a failed side-effect-free logical PLAN attempt can be retried")
	}
	var minimum int
	if err := transaction.QueryRowContext(ctx,
		"SELECT COALESCE(MIN(ordinal),0) FROM stage_attempts WHERE run_id=? AND stage=?",
		runID, stage).Scan(&minimum); err != nil {
		return err
	}
	archivedOrdinal := minimum - 1
	if minimum > 0 {
		archivedOrdinal = -1
	}
	now := time.Now().UTC()
	result, err := transaction.ExecContext(ctx, `
UPDATE stage_attempts SET ordinal=?,status='superseded',updated_at=?
WHERE id=? AND run_id=? AND stage='plan' AND ordinal=0 AND logical_ordinal=0
  AND status='failed' AND external_side_effects=0`,
		archivedOrdinal, formatTime(now), attemptID, runID)
	if err != nil {
		return err
	}
	if changed, err := result.RowsAffected(); err != nil || changed != 1 {
		if err == nil {
			err = errors.New("PLAN attempt changed while preparing contract retry")
		}
		return err
	}
	if err := appendEvent(ctx, transaction, runID, "stage.retry_authorized", map[string]any{
		"attempt_id": attemptID, "stage": core.StagePlan, "ordinal": logicalOrdinal,
		"reason": "deterministic_contract_recovery",
	}, now); err != nil {
		return err
	}
	return transaction.Commit()
}

// HasEarlierUnresolvedRun is the durable half of project FIFO. It prevents a
// queued run from bypassing an older interrupted/uncertain run after restart,
// when the in-memory active-project map is necessarily empty.
func (db *DB) HasEarlierUnresolvedRun(ctx context.Context, runID string) (bool, error) {
	blocking, err := db.EarlierUnresolvedRun(ctx, runID)
	return blocking != nil, err
}

// EarlierUnresolvedRun returns the first durable project-FIFO predecessor that
// must be resolved before runID may start. The returned run can belong to a
// different conversation session in the same project, which lets callers
// direct the user to the exact interrupted or uncertain work instead of
// leaving a newer run visibly queued without an explanation.
func (db *DB) EarlierUnresolvedRun(ctx context.Context, runID string) (*core.Run, error) {
	var projectID, createdAt string
	if err := db.sql.QueryRowContext(ctx,
		"SELECT project_id, created_at FROM runs WHERE id = ?", runID,
	).Scan(&projectID, &createdAt); err != nil {
		return nil, err
	}
	blocking, err := scanRun(db.sql.QueryRowContext(ctx, runSelect+`
WHERE project_id = ? AND id <> ?
  AND (created_at < ? OR (created_at = ? AND id < ?))
  AND status IN (
    'queued','planning','collecting','synthesizing','reviewing','revising',
    'waiting_approval','interrupted','uncertain'
  )
ORDER BY created_at ASC, id ASC
LIMIT 1`, projectID, runID, createdAt, createdAt, runID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &blocking, nil
}

func (db *DB) EventsAfter(ctx context.Context, sequence int64, limit int) ([]Event, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	rows, err := db.sql.QueryContext(ctx, `
SELECT sequence, run_id, kind, payload_json, created_at
FROM run_events
WHERE sequence > ?
ORDER BY sequence
LIMIT ?`, sequence, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []Event
	for rows.Next() {
		var event Event
		var created, payload string
		if err := rows.Scan(&event.Sequence, &event.RunID, &event.Kind, &payload, &created); err != nil {
			return nil, err
		}
		event.Payload = json.RawMessage(payload)
		event.CreatedAt, err = parseTime(created)
		if err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

func appendEvent(
	ctx context.Context,
	executor interface {
		ExecContext(context.Context, string, ...any) (sql.Result, error)
	},
	runID, kind string,
	payload any,
	at time.Time,
) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = executor.ExecContext(
		ctx,
		"INSERT INTO run_events(run_id, kind, payload_json, created_at) VALUES(?, ?, ?, ?)",
		runID, kind, string(encoded), formatTime(at),
	)
	return err
}

func (db *DB) PublishArtifact(
	ctx context.Context,
	runID, attemptID, kind, mediaType string,
	receipt cas.Receipt,
) (Artifact, error) {
	artifactID, err := id.New("art")
	if err != nil {
		return Artifact{}, err
	}
	now := time.Now().UTC()
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return Artifact{}, err
	}
	defer transaction.Rollback()
	var attemptRunID, attemptStatus string
	if err := transaction.QueryRowContext(
		ctx,
		"SELECT run_id, status FROM stage_attempts WHERE id = ?",
		attemptID,
	).Scan(&attemptRunID, &attemptStatus); err != nil {
		return Artifact{}, err
	}
	if attemptRunID != runID || attemptStatus != "in_progress" {
		return Artifact{}, errors.New("artifact stage capability is not active for this run")
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO blobs(hash, size, media_type, created_at)
VALUES(?, ?, ?, ?)
ON CONFLICT(hash) DO NOTHING`,
		receipt.Hash, receipt.Size, mediaType, formatTime(now),
	); err != nil {
		return Artifact{}, err
	}
	var storedSize int64
	var storedMediaType string
	if err := transaction.QueryRowContext(
		ctx, "SELECT size, media_type FROM blobs WHERE hash = ?", receipt.Hash,
	).Scan(&storedSize, &storedMediaType); err != nil {
		return Artifact{}, err
	}
	if storedSize != receipt.Size || storedMediaType != mediaType {
		return Artifact{}, errors.New("blob metadata conflicts with CAS receipt")
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO artifacts(id, run_id, stage_attempt_id, kind, blob_hash, adopted, created_at)
VALUES(?, ?, ?, ?, ?, 0, ?)`,
		artifactID, runID, attemptID, kind, receipt.Hash, formatTime(now),
	); err != nil {
		return Artifact{}, err
	}
	if err := appendEvent(ctx, transaction, runID, "artifact.published", map[string]any{
		"artifact_id": artifactID, "attempt_id": attemptID, "kind": kind, "blob_hash": receipt.Hash,
	}, now); err != nil {
		return Artifact{}, err
	}
	if err := transaction.Commit(); err != nil {
		return Artifact{}, err
	}
	return Artifact{
		ID: artifactID, RunID: runID, StageAttemptID: attemptID,
		Kind: kind, BlobHash: receipt.Hash, CreatedAt: now,
	}, nil
}

func (db *DB) ValidateStageCapability(ctx context.Context, runID, attemptID string) (string, error) {
	var projectID, attemptRunID, attemptStatus string
	var runStatus core.RunStatus
	if err := db.sql.QueryRowContext(ctx, `
SELECT r.project_id, r.status, s.run_id, s.status
FROM stage_attempts s
JOIN runs r ON r.id = s.run_id
WHERE s.id = ?`, attemptID).Scan(&projectID, &runStatus, &attemptRunID, &attemptStatus); err != nil {
		return "", err
	}
	if attemptRunID != runID || attemptStatus != "in_progress" || core.IsTerminal(runStatus) {
		return "", errors.New("stage capability is not active for this run")
	}
	return projectID, nil
}

func (db *DB) CaptureEvidence(
	ctx context.Context,
	runID, attemptID, sourceURL, title, publisher, mediaType string,
	receipt cas.Receipt,
) (Evidence, error) {
	return db.captureEvidence(ctx, runID, attemptID, sourceURL, title, publisher, mediaType, receipt, "")
}

// CaptureEvidenceFromMCP is the production capability boundary used by the
// internal MCP server. The origin marker is committed in the same transaction
// as the evidence row, so release verification never has to infer MCP use from
// a later best-effort log write.
func (db *DB) CaptureEvidenceFromMCP(
	ctx context.Context,
	runID, attemptID, sourceURL, title, publisher, mediaType string,
	receipt cas.Receipt,
) (Evidence, error) {
	return db.captureEvidence(ctx, runID, attemptID, sourceURL, title, publisher, mediaType, receipt, "internal_mcp")
}

func (db *DB) captureEvidence(
	ctx context.Context,
	runID, attemptID, sourceURL, title, publisher, mediaType string,
	receipt cas.Receipt,
	origin string,
) (Evidence, error) {
	if sourceURL == "" || title == "" || receipt.Hash == "" {
		return Evidence{}, errors.New("evidence URL, title, and blob are required")
	}
	evidenceID, err := id.New("evd")
	if err != nil {
		return Evidence{}, err
	}
	now := time.Now().UTC()
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return Evidence{}, err
	}
	defer transaction.Rollback()
	var attemptRunID, attemptStatus string
	if err := transaction.QueryRowContext(ctx,
		"SELECT run_id, status FROM stage_attempts WHERE id = ?", attemptID,
	).Scan(&attemptRunID, &attemptStatus); err != nil {
		return Evidence{}, err
	}
	if attemptRunID != runID || attemptStatus != "in_progress" {
		return Evidence{}, errors.New("evidence stage capability is not active for this run")
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO blobs(hash, size, media_type, created_at)
VALUES(?, ?, ?, ?)
ON CONFLICT(hash) DO NOTHING`, receipt.Hash, receipt.Size, mediaType, formatTime(now)); err != nil {
		return Evidence{}, err
	}
	var storedSize int64
	var storedMediaType string
	if err := transaction.QueryRowContext(ctx,
		"SELECT size, media_type FROM blobs WHERE hash = ?", receipt.Hash).Scan(&storedSize, &storedMediaType); err != nil {
		return Evidence{}, err
	}
	if storedSize != receipt.Size || storedMediaType != mediaType {
		return Evidence{}, errors.New("blob metadata conflicts with CAS receipt")
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO evidence(
  id, run_id, stage_attempt_id, source_url, title, publisher,
  blob_hash, captured_at, adopted
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0)`, evidenceID, runID, attemptID,
		sourceURL, title, publisher, receipt.Hash, formatTime(now)); err != nil {
		return Evidence{}, err
	}
	payload := map[string]any{
		"evidence_id": evidenceID, "attempt_id": attemptID, "source_url": sourceURL,
		"blob_hash": receipt.Hash,
	}
	if origin != "" {
		payload["origin"] = origin
	}
	if err := appendEvent(ctx, transaction, runID, "evidence.captured", payload, now); err != nil {
		return Evidence{}, err
	}
	if err := transaction.Commit(); err != nil {
		return Evidence{}, err
	}
	return Evidence{
		ID: evidenceID, RunID: runID, StageAttemptID: attemptID,
		SourceURL: sourceURL, Title: title, Publisher: publisher,
		BlobHash: receipt.Hash, CapturedAt: now,
	}, nil
}

// VerifyEvidenceSources binds every cited source to evidence captured for this
// run through an active stage capability. A model cannot adopt an arbitrary or
// stale CAS hash merely by returning it in structured JSON.
func (db *DB) VerifyEvidenceSources(ctx context.Context, runID string, sources []core.EvidenceSource) error {
	if runID == "" || len(sources) == 0 {
		return errors.New("run and evidence sources are required")
	}
	for _, source := range sources {
		if _, receiptSource := core.EngineeringReceiptArtifactID(source); receiptSource {
			if err := db.verifyEngineeringReceiptEvidence(ctx, runID, "", source); err != nil {
				return err
			}
			continue
		}
		var count int
		if err := db.sql.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM evidence e
JOIN blobs b ON b.hash = e.blob_hash
WHERE e.run_id = ? AND e.source_url = ? AND e.title = ? AND e.blob_hash = ?`,
			runID, source.URL, source.Title, source.BlobHash).Scan(&count); err != nil {
			return err
		}
		if count != 1 {
			return fmt.Errorf("source %q was not captured exactly once for this run", source.ID)
		}
	}
	return nil
}

// VerifyEvidenceSourcesForAttempt strengthens release verification by binding
// every structured citation to the exact isolated collector attempt that
// captured it, including publisher and capture time. The more permissive
// run-level verifier remains for the in-flight callback, where the attempt is
// still owned by runStage.
func (db *DB) VerifyEvidenceSourcesForAttempt(
	ctx context.Context,
	runID, attemptID string,
	sources []core.EvidenceSource,
) error {
	if runID == "" || attemptID == "" || len(sources) == 0 {
		return errors.New("run, stage attempt, and evidence sources are required")
	}
	for _, source := range sources {
		if _, receiptSource := core.EngineeringReceiptArtifactID(source); receiptSource {
			if err := db.verifyEngineeringReceiptEvidence(ctx, runID, attemptID, source); err != nil {
				return err
			}
			continue
		}
		var count int
		if err := db.sql.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM evidence e
JOIN blobs b ON b.hash = e.blob_hash
JOIN stage_attempts s ON s.id = e.stage_attempt_id
WHERE e.run_id = ? AND e.stage_attempt_id = ?
  AND s.run_id = e.run_id AND s.stage = 'collect'
  AND e.source_url = ? AND e.title = ? AND e.publisher = ?
  AND e.captured_at = ? AND e.blob_hash = ?`,
			runID, attemptID, source.URL, source.Title, source.Publisher,
			formatTime(source.CapturedAt), source.BlobHash,
		).Scan(&count); err != nil {
			return err
		}
		if count != 1 {
			return fmt.Errorf("source %q was not captured exactly once by collector attempt %s", source.ID, attemptID)
		}
	}
	return nil
}

// VerifyEvidenceSourcesForCollector resolves the unique live or completed
// collector attempt by its plan ordinal. This lets both the in-flight JSON
// validator and checkpoint recovery enforce exact capture provenance.
func (db *DB) VerifyEvidenceSourcesForCollector(
	ctx context.Context,
	runID string,
	ordinal int,
	sources []core.EvidenceSource,
) error {
	attemptID, err := db.collectorAttemptID(ctx, runID, ordinal)
	if err != nil {
		return err
	}
	if len(sources) == 0 {
		return errors.New("evidence sources are required")
	}
	for _, source := range sources {
		if _, receiptSource := core.EngineeringReceiptArtifactID(source); receiptSource {
			if err := db.verifyEngineeringReceiptEvidence(ctx, runID, attemptID, source); err != nil {
				return err
			}
			continue
		}
		var count int
		if err := db.sql.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM evidence e
JOIN blobs b ON b.hash = e.blob_hash
WHERE e.run_id=? AND e.stage_attempt_id=?
  AND e.source_url=? AND e.title=? AND e.publisher=? AND e.blob_hash=?`,
			runID, attemptID, source.URL, source.Title, source.Publisher, source.BlobHash,
		).Scan(&count); err != nil {
			return err
		}
		if count != 1 {
			return fmt.Errorf("source %q was not captured exactly once by collector attempt %s", source.ID, attemptID)
		}
	}
	return nil
}

func (db *DB) collectorAttemptID(ctx context.Context, runID string, ordinal int) (string, error) {
	var attemptID string
	if err := db.sql.QueryRowContext(ctx, `
SELECT id FROM stage_attempts
WHERE run_id=? AND stage='collect' AND logical_ordinal=? AND status IN ('in_progress','completed')`,
		runID, ordinal,
	).Scan(&attemptID); err != nil {
		return "", err
	}
	return attemptID, nil
}

// EngineeringReceiptEvidenceForCollector resolves an untrusted opaque
// artifact id to the complete immutable EvidenceSource owned by the exact
// logical collector attempt. No model-supplied receipt URL, hash, title,
// publisher, or timestamp participates in this lookup.
func (db *DB) EngineeringReceiptEvidenceForCollector(
	ctx context.Context,
	runID string,
	ordinal int,
	artifactID string,
) (core.EvidenceSource, error) {
	if !core.IsEngineeringReceiptArtifactID(artifactID) {
		return core.EvidenceSource{}, errors.New("engineering receipt artifact id is invalid")
	}
	attemptID, err := db.collectorAttemptID(ctx, runID, ordinal)
	if err != nil {
		return core.EvidenceSource{}, err
	}
	return db.engineeringReceiptEvidence(ctx, runID, attemptID, artifactID)
}

func (db *DB) verifyEngineeringReceiptEvidence(
	ctx context.Context,
	runID, attemptID string,
	source core.EvidenceSource,
) error {
	artifactID, ok := core.EngineeringReceiptArtifactID(source)
	if !ok {
		return errors.New("engineering receipt evidence URL and source id do not match")
	}
	expected, err := db.engineeringReceiptEvidence(ctx, runID, attemptID, artifactID)
	if err != nil {
		return err
	}
	if source.ID != expected.ID || source.URL != expected.URL || source.Title != expected.Title ||
		source.Publisher != expected.Publisher || source.BlobHash != expected.BlobHash ||
		!source.CapturedAt.Equal(expected.CapturedAt) {
		return fmt.Errorf("engineering receipt source %q does not match its immutable receipt metadata", source.ID)
	}
	return nil
}

func (db *DB) engineeringReceiptEvidence(
	ctx context.Context,
	runID, attemptID, artifactID string,
) (core.EvidenceSource, error) {
	var operation, blobHash, created string
	err := db.sql.QueryRowContext(ctx, `
SELECT j.operation, a.blob_hash, a.created_at
FROM engineering_jobs j
JOIN engineering_job_artifacts ja
  ON ja.job_id=j.id AND ja.role='receipt' AND ja.artifact_id=j.receipt_artifact_id
JOIN artifacts a
  ON a.id=ja.artifact_id AND a.run_id=j.run_id AND a.stage_attempt_id=j.stage_attempt_id
JOIN blobs b ON b.hash=a.blob_hash AND b.hash=ja.blob_hash
JOIN stage_attempts s ON s.id=j.stage_attempt_id AND s.run_id=j.run_id AND s.stage='collect'
WHERE j.run_id=? AND (
    ?='' OR j.stage_attempt_id=? OR EXISTS(
      SELECT 1 FROM engineering_receipt_reuses reuse
      WHERE reuse.run_id=j.run_id
        AND reuse.stage_attempt_id=?
        AND reuse.source_job_id=j.id
        AND reuse.receipt_artifact_id=j.receipt_artifact_id
    )
  )
  AND j.status='succeeded' AND j.receipt_artifact_id=?`,
		runID, attemptID, attemptID, attemptID, artifactID,
	).Scan(&operation, &blobHash, &created)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return core.EvidenceSource{}, fmt.Errorf("engineering receipt source %q is not a succeeded run-owned collect receipt", artifactID)
		}
		return core.EvidenceSource{}, err
	}
	capturedAt, err := parseTime(created)
	if err != nil {
		return core.EvidenceSource{}, err
	}
	expected, err := core.EngineeringReceiptEvidenceSource(artifactID, operation, blobHash, capturedAt)
	if err != nil {
		return core.EvidenceSource{}, err
	}
	return expected, nil
}

func (db *DB) ListArtifacts(ctx context.Context, runID string) ([]Artifact, error) {
	rows, err := db.sql.QueryContext(ctx, `
SELECT id, run_id, stage_attempt_id, kind, blob_hash, adopted, created_at
FROM artifacts WHERE run_id = ? ORDER BY created_at`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var artifacts []Artifact
	for rows.Next() {
		var artifact Artifact
		var created string
		if err := rows.Scan(&artifact.ID, &artifact.RunID, &artifact.StageAttemptID,
			&artifact.Kind, &artifact.BlobHash, &artifact.Adopted, &created); err != nil {
			return nil, err
		}
		artifact.CreatedAt, err = parseTime(created)
		if err != nil {
			return nil, err
		}
		artifacts = append(artifacts, artifact)
	}
	return artifacts, rows.Err()
}

func (db *DB) Artifact(ctx context.Context, artifactID string) (Artifact, error) {
	var artifact Artifact
	var created string
	if err := db.sql.QueryRowContext(ctx, `
SELECT id, run_id, stage_attempt_id, kind, blob_hash, adopted, created_at
FROM artifacts WHERE id = ?`, artifactID).Scan(
		&artifact.ID, &artifact.RunID, &artifact.StageAttemptID, &artifact.Kind,
		&artifact.BlobHash, &artifact.Adopted, &created,
	); err != nil {
		return Artifact{}, err
	}
	var err error
	artifact.CreatedAt, err = parseTime(created)
	return artifact, err
}

func (db *DB) BlobMetadata(ctx context.Context, hash string) (BlobMetadata, error) {
	var metadata BlobMetadata
	var created string
	if err := db.sql.QueryRowContext(ctx, `
SELECT hash, size, media_type, created_at FROM blobs WHERE hash = ?`, hash).Scan(
		&metadata.Hash, &metadata.Size, &metadata.MediaType, &created,
	); err != nil {
		return BlobMetadata{}, err
	}
	var err error
	metadata.CreatedAt, err = parseTime(created)
	return metadata, err
}

func retiresPendingApprovals(status core.RunStatus) bool {
	return core.IsTerminal(status) || status == core.RunInterrupted || status == core.RunUncertain
}

func retirePendingApprovals(
	ctx context.Context,
	transaction *sql.Tx,
	runID string,
	reason string,
	now time.Time,
) error {
	rows, err := transaction.QueryContext(ctx, `
SELECT id FROM approvals
WHERE run_id = ? AND status = 'pending'
ORDER BY created_at, id`, runID)
	if err != nil {
		return fmt.Errorf("list pending approvals for retirement: %w", err)
	}
	var approvalIDs []string
	for rows.Next() {
		var approvalID string
		if err := rows.Scan(&approvalID); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan pending approval for retirement: %w", err)
		}
		approvalIDs = append(approvalIDs, approvalID)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close pending approval retirement rows: %w", err)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate pending approvals for retirement: %w", err)
	}
	for _, approvalID := range approvalIDs {
		result, err := transaction.ExecContext(ctx, `
UPDATE approvals
SET status = 'denied', updated_at = ?
WHERE id = ? AND run_id = ? AND status = 'pending'`,
			formatTime(now), approvalID, runID)
		if err != nil {
			return fmt.Errorf("retire approval %s: %w", approvalID, err)
		}
		if count, err := result.RowsAffected(); err != nil || count != 1 {
			if err == nil {
				err = errors.New("approval retirement lost concurrency race")
			}
			return fmt.Errorf("retire approval %s: %w", approvalID, err)
		}
		if err := appendEvent(ctx, transaction, runID, "approval.retired", map[string]any{
			"approval_id": approvalID,
			"reason":      reason,
		}, now); err != nil {
			return err
		}
	}
	return nil
}

func (db *DB) CreateApproval(ctx context.Context, approval core.Approval) (core.Approval, error) {
	if approval.ID == "" {
		generated, err := id.New("apr")
		if err != nil {
			return core.Approval{}, err
		}
		approval.ID = generated
	}
	if approval.RunID == "" || approval.StageAttemptID == "" || approval.ThreadID == "" || approval.TurnID == "" || approval.Kind == "" {
		return core.Approval{}, errors.New("approval run, thread, turn, and kind are required")
	}
	if (approval.ArgumentsJSON == "") != (approval.ArgumentsSHA256 == "") {
		return core.Approval{}, errors.New("approval arguments JSON and SHA-256 must be provided together")
	}
	if approval.ArgumentsJSON != "" {
		if !json.Valid([]byte(approval.ArgumentsJSON)) {
			return core.Approval{}, errors.New("approval arguments must be valid JSON")
		}
		digest := sha256.Sum256([]byte(approval.ArgumentsJSON))
		if approval.ArgumentsSHA256 != hex.EncodeToString(digest[:]) {
			return core.Approval{}, errors.New("approval arguments SHA-256 does not match the exact stored JSON")
		}
	}
	if approval.Risk == "" {
		approval.Risk = "unclassified"
	}
	now := time.Now().UTC()
	approval.Status = "pending"
	approval.CreatedAt = now
	approval.UpdatedAt = now
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.Approval{}, err
	}
	defer transaction.Rollback()
	var stageStatus, stage string
	var logicalOrdinal int
	var runStatus core.RunStatus
	if err := transaction.QueryRowContext(ctx, `
SELECT s.status, s.stage, s.logical_ordinal, r.status
FROM stage_attempts s
JOIN runs r ON r.id = s.run_id
WHERE s.id = ? AND s.run_id = ?`, approval.StageAttemptID, approval.RunID).Scan(
		&stageStatus, &stage, &logicalOrdinal, &runStatus,
	); err != nil {
		return core.Approval{}, err
	}
	if stageStatus != "in_progress" ||
		(runStatus != core.RunWaitingApproval && !core.CanTransition(runStatus, core.RunWaitingApproval)) {
		return core.Approval{}, ErrApprovalNotActive
	}
	if stage == string(core.StageCollect) && logicalOrdinal >= 0 && logicalOrdinal < core.EngineeringVerificationOrdinal {
		if err := requireXFOILScreeningApprovalOwner(approval, logicalOrdinal); err != nil {
			return core.Approval{}, err
		}
		if err := rejectDuplicateXFOILScreeningApproval(ctx, transaction, approval); err != nil {
			return core.Approval{}, err
		}
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO approvals(
  id, run_id, stage_attempt_id, thread_id, turn_id, item_id, kind, summary,
  server, tool, command_text, arguments_json, arguments_sha256, risk,
  external_side_effect, status, created_at, updated_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
		approval.ID, approval.RunID, approval.StageAttemptID, approval.ThreadID,
		approval.TurnID, approval.ItemID, approval.Kind, approval.Summary,
		approval.Server, approval.Tool, approval.Command, approval.ArgumentsJSON,
		approval.ArgumentsSHA256, approval.Risk, approval.ExternalSideEffect,
		formatTime(now), formatTime(now)); err != nil {
		return core.Approval{}, err
	}
	if err := appendEvent(ctx, transaction, approval.RunID, "approval.requested", map[string]any{
		"approval_id": approval.ID, "kind": approval.Kind, "summary": approval.Summary,
	}, now); err != nil {
		return core.Approval{}, err
	}
	if err := transaction.Commit(); err != nil {
		return core.Approval{}, err
	}
	return approval, nil
}

func (db *DB) ListPendingApprovals(ctx context.Context) ([]core.Approval, error) {
	rows, err := db.sql.QueryContext(ctx, `
SELECT id, run_id, stage_attempt_id, thread_id, turn_id, item_id, kind, summary,
       server, tool, command_text, arguments_json, arguments_sha256, risk,
       external_side_effect, status, created_at, updated_at
FROM approvals WHERE status = 'pending' ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var approvals []core.Approval
	for rows.Next() {
		approval, err := scanApproval(rows)
		if err != nil {
			return nil, err
		}
		approvals = append(approvals, approval)
	}
	return approvals, rows.Err()
}

func (db *DB) DecideApproval(ctx context.Context, approvalID, decision string) (core.Approval, error) {
	return db.decideApproval(ctx, approvalID, decision, false)
}

// DecideActiveApproval is the UI approval boundary. In addition to the
// approval row itself, it requires the owning stage to still be in progress
// and the run to still be waiting for that response. For an approved external
// action, the durable side-effect boundary is written in this same transaction,
// except for the exact app-owned engineering solver surface. That surface
// records the boundary atomically with its running job in BeginEngineeringJob
// after deterministic preflight. A collector failure or cancellation that
// retires the approval therefore wins without either marking a side effect or
// sending a late response to Codex.
func (db *DB) DecideActiveApproval(ctx context.Context, approvalID, decision string) (core.Approval, error) {
	return db.decideApproval(ctx, approvalID, decision, true)
}

func (db *DB) decideApproval(
	ctx context.Context,
	approvalID string,
	decision string,
	requireActive bool,
) (core.Approval, error) {
	if decision != "approved" && decision != "denied" {
		return core.Approval{}, errors.New("approval decision must be approved or denied")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.Approval{}, err
	}
	defer transaction.Rollback()
	approval, err := scanApproval(transaction.QueryRowContext(ctx, `
SELECT id, run_id, stage_attempt_id, thread_id, turn_id, item_id, kind, summary,
       server, tool, command_text, arguments_json, arguments_sha256, risk,
       external_side_effect, status, created_at, updated_at
FROM approvals WHERE id = ?`, approvalID))
	if err != nil {
		return core.Approval{}, err
	}
	if approval.Status != "pending" {
		if requireActive {
			return approval, ErrApprovalNotActive
		}
		return core.Approval{}, errors.New("approval is no longer pending")
	}
	now := time.Now().UTC()
	if requireActive {
		var stageStatus string
		var runStatus core.RunStatus
		var failedCollectorExists bool
		err := transaction.QueryRowContext(ctx, `
SELECT s.status, r.status,
       EXISTS(
         SELECT 1 FROM stage_attempts failed
         WHERE failed.run_id = s.run_id
           AND failed.stage = 'collect'
           AND failed.status = 'failed'
       )
FROM stage_attempts s
JOIN runs r ON r.id = s.run_id
WHERE s.id = ? AND s.run_id = ?`, approval.StageAttemptID, approval.RunID).Scan(
			&stageStatus, &runStatus, &failedCollectorExists,
		)
		if err != nil {
			return core.Approval{}, err
		}
		if stageStatus != "in_progress" || runStatus != core.RunWaitingApproval || failedCollectorExists {
			retirementReason := "stage_or_run_inactive"
			if failedCollectorExists {
				retirementReason = "collect_failed"
			}
			result, err := transaction.ExecContext(ctx, `
UPDATE approvals
SET status = 'denied', updated_at = ?
WHERE id = ? AND status = 'pending'`, formatTime(now), approval.ID)
			if err != nil {
				return core.Approval{}, err
			}
			if count, err := result.RowsAffected(); err != nil || count != 1 {
				if err == nil {
					err = errors.New("stale approval retirement lost concurrency race")
				}
				return core.Approval{}, err
			}
			if err := appendEvent(ctx, transaction, approval.RunID, "approval.retired", map[string]any{
				"approval_id": approval.ID,
				"reason":      retirementReason,
			}, now); err != nil {
				return core.Approval{}, err
			}
			if err := transaction.Commit(); err != nil {
				return core.Approval{}, err
			}
			approval.Status = "denied"
			approval.UpdatedAt = now
			return approval, ErrApprovalNotActive
		}
		if decision == "approved" && approval.ExternalSideEffect &&
			!EngineeringServiceOwnsExternalBoundary(approval) {
			result, err := transaction.ExecContext(ctx, `
UPDATE stage_attempts
SET external_side_effects = 1, updated_at = ?
WHERE id = ? AND run_id = ? AND status = 'in_progress'`,
				formatTime(now), approval.StageAttemptID, approval.RunID)
			if err != nil {
				return core.Approval{}, err
			}
			if count, err := result.RowsAffected(); err != nil || count != 1 {
				if err == nil {
					err = ErrApprovalNotActive
				}
				return core.Approval{}, err
			}
		}
	}
	result, err := transaction.ExecContext(ctx, `
UPDATE approvals SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
		decision, formatTime(now), approvalID)
	if err != nil {
		return core.Approval{}, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("approval decision lost concurrency race")
		}
		return core.Approval{}, err
	}
	if err := appendEvent(ctx, transaction, approval.RunID, "approval.decided", map[string]any{
		"approval_id": approval.ID, "decision": decision,
	}, now); err != nil {
		return core.Approval{}, err
	}
	if err := transaction.Commit(); err != nil {
		return core.Approval{}, err
	}
	approval.Status = decision
	approval.UpdatedAt = now
	return approval, nil
}

func scanApproval(row scanner) (core.Approval, error) {
	var approval core.Approval
	var created, updated string
	if err := row.Scan(&approval.ID, &approval.RunID, &approval.StageAttemptID,
		&approval.ThreadID, &approval.TurnID, &approval.ItemID, &approval.Kind,
		&approval.Summary, &approval.Server, &approval.Tool, &approval.Command,
		&approval.ArgumentsJSON, &approval.ArgumentsSHA256, &approval.Risk,
		&approval.ExternalSideEffect, &approval.Status, &created, &updated); err != nil {
		return core.Approval{}, err
	}
	var err error
	approval.CreatedAt, err = parseTime(created)
	if err != nil {
		return core.Approval{}, err
	}
	approval.UpdatedAt, err = parseTime(updated)
	return approval, err
}
