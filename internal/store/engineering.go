package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/id"
)

// ErrDuplicateEngineeringScreening means another general collector in the
// same run already owns an equivalent XFOIL screening intent. The approval
// router declines the later Codex request instead of presenting a second UI
// approval or permitting another process launch.
var ErrDuplicateEngineeringScreening = errors.New("duplicate XFOIL screening scope is already active in this run")

type EngineeringJob struct {
	ID                string     `json:"id"`
	ProjectID         string     `json:"project_id"`
	RunID             string     `json:"run_id"`
	StageAttemptID    string     `json:"stage_attempt_id"`
	Operation         string     `json:"operation"`
	SpecJSON          string     `json:"spec_json"`
	SpecSHA256        string     `json:"spec_sha256"`
	ToolComponent     string     `json:"tool_component"`
	ToolVersion       string     `json:"tool_version"`
	ApprovalID        string     `json:"approval_id"`
	ApprovalScopeHash string     `json:"approval_scope_hash"`
	Status            string     `json:"status"`
	ReceiptArtifactID string     `json:"receipt_artifact_id,omitempty"`
	Error             string     `json:"error,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	StartedAt         *time.Time `json:"started_at,omitempty"`
	CompletedAt       *time.Time `json:"completed_at,omitempty"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

type EngineeringJobArtifact struct {
	ArtifactID string `json:"artifact_id"`
	Role       string `json:"role"`
	FileName   string `json:"file_name"`
	MediaType  string `json:"media_type"`
	BlobHash   string `json:"blob_hash"`
}

type EngineeringResult struct {
	Job       EngineeringJob           `json:"job"`
	Artifacts []EngineeringJobArtifact `json:"artifacts"`
}

// EngineeringServiceOwnsExternalBoundary identifies the deliberately small,
// app-owned solver surface whose durable side-effect boundary is recorded by
// BeginEngineeringJob. The match is intentionally exact: aliases, casing
// variants, and unknown tools remain ordinary external approvals whose
// boundary is owned by the approval router.
func EngineeringServiceOwnsExternalBoundary(approval core.Approval) bool {
	if !approval.ExternalSideEffect || approval.Kind != "item/mcpToolCall/requestApproval" ||
		approval.Server != "aetherops_engineering" {
		return false
	}
	switch approval.Tool {
	case "openvsp_wing_aero", "openvsp_modify_wing", "gmsh_wing_mesh", "xfoil_polar", "su2_naca0012":
		return true
	default:
		return false
	}
}

// ValidateEngineeringCapability is intentionally narrower than the generic
// artifact capability. Solvers may only run in an active COLLECT attempt.
func (db *DB) ValidateEngineeringCapability(ctx context.Context, runID, attemptID string) (string, error) {
	var projectID, attemptRunID, attemptStatus, stage string
	var runStatus core.RunStatus
	if err := db.sql.QueryRowContext(ctx, `
SELECT r.project_id, r.status, s.run_id, s.stage, s.status
FROM stage_attempts s
JOIN runs r ON r.id = s.run_id
WHERE s.id = ?`, attemptID).Scan(
		&projectID, &runStatus, &attemptRunID, &stage, &attemptStatus,
	); err != nil {
		return "", err
	}
	if attemptRunID != runID || stage != string(core.StageCollect) || attemptStatus != "in_progress" {
		return "", errors.New("engineering tools require the active collect stage")
	}
	if runStatus != core.RunCollecting && runStatus != core.RunWaitingApproval {
		return "", fmt.Errorf("engineering tools are unavailable while run status is %s", runStatus)
	}
	return projectID, nil
}

// SucceededEngineeringJobForApprovalScope returns a completed job only when
// the approval request is an exact replay in the same run, stage attempt, and
// operation. The approval router uses this narrow lookup to skip a second UI
// prompt; the engineering service still recomputes the full runtime-bound spec
// hash before it can read the result, and a non-matching spec has no approval
// with which to start a new process.
func (db *DB) SucceededEngineeringJobForApprovalScope(
	ctx context.Context, runID, attemptID, operation, approvalScopeHash string,
) (EngineeringJob, bool, error) {
	if runID == "" || attemptID == "" || operation == "" || approvalScopeHash == "" {
		return EngineeringJob{}, false, errors.New("engineering replay scope is incomplete")
	}
	job, err := scanEngineeringJob(db.sql.QueryRowContext(ctx, engineeringJobSelect+`
WHERE run_id = ? AND stage_attempt_id = ? AND operation = ?
  AND approval_scope_hash = ? AND status = 'succeeded'
  AND receipt_artifact_id IS NOT NULL
ORDER BY completed_at DESC, id
LIMIT 1`, runID, attemptID, operation, approvalScopeHash))
	if errors.Is(err, sql.ErrNoRows) {
		return EngineeringJob{}, false, nil
	}
	if err != nil {
		return EngineeringJob{}, false, err
	}
	return job, true, nil
}

func rejectDuplicateXFOILScreeningApproval(
	ctx context.Context,
	transaction *sql.Tx,
	approval core.Approval,
) error {
	identity, screening, err := xfoilScreeningApprovalIdentity(approval)
	if err != nil || !screening {
		return err
	}
	rows, err := transaction.QueryContext(ctx, `
SELECT a.id, a.stage_attempt_id, a.arguments_json, a.status, COALESCE(j.status, '')
FROM approvals a
JOIN stage_attempts s
  ON s.id=a.stage_attempt_id AND s.run_id=a.run_id
LEFT JOIN engineering_jobs j
  ON j.approval_id=a.id AND j.run_id=a.run_id AND j.operation='xfoil_polar'
WHERE a.run_id=? AND a.kind='item/mcpToolCall/requestApproval'
  AND a.server='aetherops_engineering' AND a.tool='xfoil_polar'
  AND a.status IN ('pending','approved')
  AND s.stage='collect' AND s.logical_ordinal>=0 AND s.logical_ordinal<?
ORDER BY a.created_at, a.id, j.created_at, j.id`, approval.RunID, core.EngineeringVerificationOrdinal)
	if err != nil {
		return err
	}
	defer rows.Close()
	type candidateState struct {
		stageAttemptID string
		argumentsJSON  string
		status         string
		jobStatuses    []string
	}
	candidates := make(map[string]*candidateState)
	order := make([]string, 0)
	for rows.Next() {
		var approvalID, stageAttemptID, argumentsJSON, status, jobStatus string
		if err := rows.Scan(&approvalID, &stageAttemptID, &argumentsJSON, &status, &jobStatus); err != nil {
			return err
		}
		candidate := candidates[approvalID]
		if candidate == nil {
			candidate = &candidateState{stageAttemptID: stageAttemptID, argumentsJSON: argumentsJSON, status: status}
			candidates[approvalID] = candidate
			order = append(order, approvalID)
		}
		if jobStatus != "" {
			candidate.jobStatuses = append(candidate.jobStatuses, jobStatus)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, approvalID := range order {
		candidate := candidates[approvalID]
		candidateIdentity, candidateIsScreening, err := xfoilScreeningApprovalIdentity(core.Approval{
			RunID: approval.RunID, StageAttemptID: candidate.stageAttemptID,
			Kind: "item/mcpToolCall/requestApproval", Server: "aetherops_engineering", Tool: "xfoil_polar",
			ArgumentsJSON: candidate.argumentsJSON, ExternalSideEffect: true,
		})
		if err != nil {
			return fmt.Errorf("inspect existing XFOIL screening approval %s: %w", approvalID, err)
		}
		if !candidateIsScreening || candidateIdentity != identity {
			continue
		}
		if candidate.status == "pending" || len(candidate.jobStatuses) == 0 {
			return fmt.Errorf("%w: approval %s is %s", ErrDuplicateEngineeringScreening, approvalID, candidate.status)
		}
		failedOnly := true
		for _, status := range candidate.jobStatuses {
			if status != "failed" {
				failedOnly = false
				break
			}
		}
		if !failedOnly {
			return fmt.Errorf("%w: approval %s has a non-failed engineering job", ErrDuplicateEngineeringScreening, approvalID)
		}
	}
	return nil
}

func xfoilScreeningApprovalIdentity(approval core.Approval) (string, bool, error) {
	if approval.Kind != "item/mcpToolCall/requestApproval" ||
		approval.Server != "aetherops_engineering" || approval.Tool != "xfoil_polar" ||
		!approval.ExternalSideEffect || approval.ArgumentsJSON == "" {
		return "", false, nil
	}
	var arguments map[string]any
	if err := json.Unmarshal([]byte(approval.ArgumentsJSON), &arguments); err != nil {
		return "", false, errors.New("decode XFOIL screening approval arguments")
	}
	purpose, _ := arguments["execution_purpose"].(string)
	if purpose != "screening" {
		return "", false, nil
	}
	runID, _ := arguments["run_id"].(string)
	attemptID, _ := arguments["stage_attempt_id"].(string)
	if runID != approval.RunID || attemptID != approval.StageAttemptID {
		return "", false, errors.New("XFOIL screening approval capability does not match its run or stage attempt")
	}
	delete(arguments, "run_id")
	delete(arguments, "stage_attempt_id")
	encoded, err := json.Marshal(arguments)
	if err != nil {
		return "", false, errors.New("encode XFOIL screening approval identity")
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), true, nil
}

// BeginEngineeringJob gives one normalized spec at-most-once execution within
// a stage attempt. A completed job is returned for readback; every other prior
// state is fail-closed and requires a new stage attempt.
func (db *DB) BeginEngineeringJob(ctx context.Context, job EngineeringJob) (EngineeringJob, bool, error) {
	if job.ProjectID == "" || job.RunID == "" || job.StageAttemptID == "" ||
		job.Operation == "" || job.SpecJSON == "" || job.SpecSHA256 == "" ||
		job.ToolComponent == "" || job.ToolVersion == "" ||
		job.ApprovalScopeHash == "" {
		return EngineeringJob{}, false, errors.New("engineering job identity, spec, and tool are required")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return EngineeringJob{}, false, err
	}
	defer transaction.Rollback()
	if err := requireXFOILScreeningJobOwner(ctx, transaction, job); err != nil {
		return EngineeringJob{}, false, err
	}
	existing, err := scanEngineeringJob(transaction.QueryRowContext(ctx, engineeringJobSelect+`
WHERE run_id = ? AND stage_attempt_id = ? AND operation = ? AND spec_sha256 = ?`,
		job.RunID, job.StageAttemptID, job.Operation, job.SpecSHA256))
	if err == nil {
		if existing.Status == "succeeded" {
			return existing, false, transaction.Commit()
		}
		return EngineeringJob{}, false, fmt.Errorf("identical engineering job is %s and will not be re-executed", existing.Status)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return EngineeringJob{}, false, err
	}
	var approvalID string
	if err := transaction.QueryRowContext(ctx, `
SELECT id FROM approvals
WHERE run_id = ? AND stage_attempt_id = ? AND status = 'approved'
  AND arguments_sha256 = ? AND external_side_effect = 1
  AND kind = 'item/mcpToolCall/requestApproval'
  AND server = 'aetherops_engineering'
  AND tool = ?
ORDER BY updated_at DESC LIMIT 1`, job.RunID, job.StageAttemptID,
		job.ApprovalScopeHash, job.Operation).Scan(&approvalID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return EngineeringJob{}, false, errors.New("no exact approved scope authorizes this engineering job")
		}
		return EngineeringJob{}, false, err
	}
	job.ApprovalID = approvalID
	var running int
	if err := transaction.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM engineering_jobs WHERE status = 'running'",
	).Scan(&running); err != nil {
		return EngineeringJob{}, false, err
	}
	if running >= 2 {
		return EngineeringJob{}, false, errors.New("the global engineering execution limit is reached")
	}
	if job.ID == "" {
		job.ID, err = id.New("eng")
		if err != nil {
			return EngineeringJob{}, false, err
		}
	}
	now := time.Now().UTC()
	job.Status = "running"
	job.CreatedAt, job.UpdatedAt, job.StartedAt = now, now, &now
	// The app-owned engineering MCP performs all deterministic preflight before
	// reaching this admission transaction. Couple the durable stage marker to
	// creation of the running job so a rejected preflight leaves neither, while
	// a committed job can never be mistaken for replay-safe interrupted work.
	result, err := transaction.ExecContext(ctx, `
UPDATE stage_attempts
SET external_side_effects = 1, updated_at = ?
WHERE id = ? AND run_id = ? AND stage = 'collect' AND status = 'in_progress'
  AND EXISTS(
    SELECT 1 FROM runs r
    WHERE r.id = ? AND r.project_id = ?
      AND r.status IN ('collecting', 'waiting_approval')
  )
  AND NOT EXISTS(
    SELECT 1 FROM stage_attempts failed
    WHERE failed.run_id = ? AND failed.stage = 'collect' AND failed.status = 'failed'
  )`, formatTime(now), job.StageAttemptID, job.RunID, job.RunID, job.ProjectID, job.RunID)
	if err != nil {
		return EngineeringJob{}, false, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = ErrApprovalNotActive
		}
		return EngineeringJob{}, false, err
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO engineering_jobs(
  id, project_id, run_id, stage_attempt_id, operation, spec_json, spec_sha256,
  tool_component, tool_version, approval_id, approval_scope_hash,
  status, error, created_at, started_at, updated_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', '', ?, ?, ?)`,
		job.ID, job.ProjectID, job.RunID, job.StageAttemptID, job.Operation,
		job.SpecJSON, job.SpecSHA256, job.ToolComponent, job.ToolVersion,
		job.ApprovalID, job.ApprovalScopeHash,
		formatTime(now), formatTime(now), formatTime(now)); err != nil {
		return EngineeringJob{}, false, err
	}
	if err := appendEvent(ctx, transaction, job.RunID, "engineering.job.started", map[string]any{
		"job_id": job.ID, "attempt_id": job.StageAttemptID,
		"operation": job.Operation, "spec_sha256": job.SpecSHA256,
	}, now); err != nil {
		return EngineeringJob{}, false, err
	}
	if err := transaction.Commit(); err != nil {
		return EngineeringJob{}, false, err
	}
	return job, true, nil
}

func (db *DB) CompleteEngineeringJob(
	ctx context.Context, jobID, receiptArtifactID string, artifacts []EngineeringJobArtifact,
) (EngineeringJob, error) {
	if jobID == "" || receiptArtifactID == "" || len(artifacts) == 0 {
		return EngineeringJob{}, errors.New("engineering completion requires receipt and artifacts")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return EngineeringJob{}, err
	}
	defer transaction.Rollback()
	job, err := scanEngineeringJob(transaction.QueryRowContext(ctx, engineeringJobSelect+" WHERE id = ?", jobID))
	if err != nil {
		return EngineeringJob{}, err
	}
	if job.Status != "running" {
		return EngineeringJob{}, fmt.Errorf("engineering job is %s, not running", job.Status)
	}
	for _, artifact := range artifacts {
		if artifact.ArtifactID == "" || artifact.Role == "" || artifact.FileName == "" ||
			artifact.MediaType == "" || artifact.BlobHash == "" {
			return EngineeringJob{}, errors.New("engineering artifact metadata is incomplete")
		}
		var artifactRunID, artifactAttemptID, artifactHash string
		if err := transaction.QueryRowContext(ctx, `
SELECT run_id, stage_attempt_id, blob_hash FROM artifacts WHERE id = ?`, artifact.ArtifactID).Scan(
			&artifactRunID, &artifactAttemptID, &artifactHash,
		); err != nil {
			return EngineeringJob{}, err
		}
		if artifactRunID != job.RunID || artifactAttemptID != job.StageAttemptID || artifactHash != artifact.BlobHash {
			return EngineeringJob{}, errors.New("engineering artifact does not belong to this job stage")
		}
		if _, err := transaction.ExecContext(ctx, `
INSERT INTO engineering_job_artifacts(job_id, artifact_id, role, file_name, media_type, blob_hash)
VALUES(?, ?, ?, ?, ?, ?)`, job.ID, artifact.ArtifactID, artifact.Role,
			artifact.FileName, artifact.MediaType, artifact.BlobHash); err != nil {
			return EngineeringJob{}, err
		}
	}
	now := time.Now().UTC()
	result, err := transaction.ExecContext(ctx, `
UPDATE engineering_jobs
SET status = 'succeeded', receipt_artifact_id = ?, completed_at = ?, updated_at = ?
WHERE id = ? AND status = 'running'`, receiptArtifactID, formatTime(now), formatTime(now), job.ID)
	if err != nil {
		return EngineeringJob{}, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("engineering completion lost concurrency race")
		}
		return EngineeringJob{}, err
	}
	if err := appendEvent(ctx, transaction, job.RunID, "engineering.job.succeeded", map[string]any{
		"job_id": job.ID, "receipt_artifact_id": receiptArtifactID,
	}, now); err != nil {
		return EngineeringJob{}, err
	}
	if err := transaction.Commit(); err != nil {
		return EngineeringJob{}, err
	}
	job.Status, job.ReceiptArtifactID = "succeeded", receiptArtifactID
	job.CompletedAt, job.UpdatedAt = &now, now
	return job, nil
}

func (db *DB) FailEngineeringJob(ctx context.Context, jobID string, cause error) error {
	message := "engineering execution failed"
	if cause != nil {
		message = cause.Error()
	}
	now := time.Now().UTC()
	result, err := db.sql.ExecContext(ctx, `
UPDATE engineering_jobs
SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
WHERE id = ? AND status = 'running'`, message, formatTime(now), formatTime(now), jobID)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("engineering job was not running")
		}
		return err
	}
	return nil
}

func (db *DB) EngineeringJob(ctx context.Context, jobID string) (EngineeringJob, error) {
	return scanEngineeringJob(db.sql.QueryRowContext(ctx, engineeringJobSelect+" WHERE id = ?", jobID))
}

// ListRunEngineeringJobs returns every durable attempt for one operation,
// including failures. Deterministic optimization verification must account for
// failed sweep members rather than silently treating the successful subset as
// the requested candidate set.
func (db *DB) ListRunEngineeringJobs(ctx context.Context, runID, operation string) ([]EngineeringJob, error) {
	if runID == "" || operation == "" {
		return nil, errors.New("engineering run and operation are required")
	}
	rows, err := db.sql.QueryContext(ctx, engineeringJobSelect+`
WHERE run_id = ? AND operation = ? ORDER BY created_at, id`, runID, operation)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := make([]EngineeringJob, 0)
	for rows.Next() {
		job, err := scanEngineeringJob(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}

func (db *DB) EngineeringJobArtifacts(ctx context.Context, jobID string) ([]EngineeringJobArtifact, error) {
	rows, err := db.sql.QueryContext(ctx, `
SELECT artifact_id, role, file_name, media_type, blob_hash
FROM engineering_job_artifacts WHERE job_id = ? ORDER BY role, file_name`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var artifacts []EngineeringJobArtifact
	for rows.Next() {
		var artifact EngineeringJobArtifact
		if err := rows.Scan(&artifact.ArtifactID, &artifact.Role, &artifact.FileName,
			&artifact.MediaType, &artifact.BlobHash); err != nil {
			return nil, err
		}
		artifacts = append(artifacts, artifact)
	}
	return artifacts, rows.Err()
}

func (db *DB) ListRunEngineeringResults(ctx context.Context, runID string) ([]EngineeringResult, error) {
	rows, err := db.sql.QueryContext(ctx, engineeringJobSelect+`
WHERE run_id = ? AND status = 'succeeded' ORDER BY created_at, id`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var jobs []EngineeringJob
	for rows.Next() {
		job, err := scanEngineeringJob(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	results := make([]EngineeringResult, 0, len(jobs))
	for _, job := range jobs {
		artifacts, err := db.EngineeringJobArtifacts(ctx, job.ID)
		if err != nil {
			return nil, err
		}
		results = append(results, EngineeringResult{Job: job, Artifacts: artifacts})
	}
	return results, nil
}

func (db *DB) VerifyRunArtifactHashes(ctx context.Context, runID string, hashes []string) error {
	for _, hash := range hashes {
		var count int
		if err := db.sql.QueryRowContext(ctx, `
SELECT COUNT(*) FROM artifacts WHERE run_id = ? AND blob_hash = ?`, runID, hash).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			return fmt.Errorf("artifact hash %s is not owned by run %s", hash, runID)
		}
	}
	return nil
}

func (db *DB) RunArtifact(ctx context.Context, runID, artifactID string) (Artifact, BlobMetadata, error) {
	artifact, err := db.Artifact(ctx, artifactID)
	if err != nil {
		return Artifact{}, BlobMetadata{}, err
	}
	if artifact.RunID != runID {
		return Artifact{}, BlobMetadata{}, errors.New("artifact does not belong to this run")
	}
	metadata, err := db.BlobMetadata(ctx, artifact.BlobHash)
	return artifact, metadata, err
}

const engineeringJobSelect = `
SELECT id, project_id, run_id, stage_attempt_id, operation, spec_json, spec_sha256,
       tool_component, tool_version, approval_id, approval_scope_hash,
       status, COALESCE(receipt_artifact_id, ''), error,
       created_at, started_at, completed_at, updated_at
FROM engineering_jobs`

func scanEngineeringJob(row scanner) (EngineeringJob, error) {
	var job EngineeringJob
	var created, updated string
	var started, completed sql.NullString
	if err := row.Scan(&job.ID, &job.ProjectID, &job.RunID, &job.StageAttemptID,
		&job.Operation, &job.SpecJSON, &job.SpecSHA256, &job.ToolComponent,
		&job.ToolVersion, &job.ApprovalID, &job.ApprovalScopeHash,
		&job.Status, &job.ReceiptArtifactID, &job.Error,
		&created, &started, &completed, &updated); err != nil {
		return EngineeringJob{}, err
	}
	var err error
	job.CreatedAt, err = parseTime(created)
	if err != nil {
		return EngineeringJob{}, err
	}
	job.UpdatedAt, err = parseTime(updated)
	if err != nil {
		return EngineeringJob{}, err
	}
	job.StartedAt, err = nullableTime(started)
	if err != nil {
		return EngineeringJob{}, err
	}
	job.CompletedAt, err = nullableTime(completed)
	return job, err
}
