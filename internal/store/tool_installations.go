package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/id"
)

type ToolInstallationUpdate struct {
	State               string
	PayloadBlobHash     string
	PayloadSizeBytes    *int64
	InstalledTreeSHA256 string
	Entrypoint          string
	ProbeOutputBlobHash string
	DetailJSON          string
}

type ToolRecoveryResult struct {
	InstallationsInterrupted int `json:"installations_interrupted"`
	InvocationsUncertain     int `json:"invocations_uncertain"`
}

func validToolSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

// BeginToolInstallation reserves one immutable download/install attempt. An
// identical live or ready attempt is returned with start=false; failed and
// interrupted history is retained while a new explicit attempt may be made.
func (db *DB) BeginToolInstallation(ctx context.Context, installation core.ToolInstallation) (core.ToolInstallation, bool, error) {
	if installation.PackageID == "" || installation.ProjectID == "" ||
		!validToolSHA256(installation.PackageSHA256) || !validToolSHA256(installation.ApprovalSHA256) ||
		!validToolSHA256(installation.ExpectedPayloadSHA256) {
		return core.ToolInstallation{}, false, errors.New("tool installation package and exact approval hashes are required")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.ToolInstallation{}, false, err
	}
	defer transaction.Rollback()
	existing, err := scanToolInstallation(transaction.QueryRowContext(ctx, toolInstallationSelect+`
WHERE package_id=? AND state IN ('downloading','verifying','installing','probing','ready')
ORDER BY created_at DESC,id DESC LIMIT 1`, installation.PackageID))
	if err == nil {
		if existing.ProjectID != installation.ProjectID ||
			existing.PackageSHA256 != installation.PackageSHA256 ||
			existing.ApprovalSHA256 != installation.ApprovalSHA256 ||
			existing.ExpectedPayloadSHA256 != installation.ExpectedPayloadSHA256 {
			return core.ToolInstallation{}, false, errors.New("a different approved installation is already live for this package")
		}
		return existing, false, transaction.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return core.ToolInstallation{}, false, err
	}
	if installation.ID == "" {
		installation.ID, err = id.New("tinst")
		if err != nil {
			return core.ToolInstallation{}, false, err
		}
	}
	now := time.Now().UTC()
	installation.State = "downloading"
	installation.PayloadBlobHash = ""
	installation.PayloadSizeBytes = 0
	installation.InstalledTreeSHA256 = ""
	installation.Entrypoint = ""
	installation.ProbeOutputBlobHash = ""
	installation.Error = ""
	installation.CreatedAt, installation.UpdatedAt, installation.CompletedAt = now, now, nil
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO portable_tool_installations(
 id,package_id,project_id,package_sha256,approval_sha256,expected_payload_sha256,
 state,created_at,updated_at
) VALUES(?,?,?,?,?,?,'downloading',?,?)`, installation.ID, installation.PackageID,
		installation.ProjectID, installation.PackageSHA256, installation.ApprovalSHA256,
		installation.ExpectedPayloadSHA256, formatTime(now), formatTime(now)); err != nil {
		return core.ToolInstallation{}, false, err
	}
	if err := appendToolInstallEvent(ctx, transaction, installation, "begun", `{}`, now); err != nil {
		return core.ToolInstallation{}, false, err
	}
	if err := transaction.Commit(); err != nil {
		return core.ToolInstallation{}, false, err
	}
	return installation, true, nil
}

// UpdateToolInstallation advances exactly one nonterminal state and attaches
// verified CAS/tree/probe metadata. Empty string fields preserve prior values.
func (db *DB) UpdateToolInstallation(ctx context.Context, installationID, expectedState string, update ToolInstallationUpdate) (core.ToolInstallation, error) {
	if installationID == "" || expectedState == "" || update.State == "" {
		return core.ToolInstallation{}, errors.New("tool installation id and state transition are required")
	}
	if update.State != "verifying" && update.State != "installing" && update.State != "probing" {
		return core.ToolInstallation{}, errors.New("use completion, failure, or recovery for a terminal installation state")
	}
	if update.DetailJSON == "" {
		update.DetailJSON = `{}`
	}
	if !json.Valid([]byte(update.DetailJSON)) {
		return core.ToolInstallation{}, errors.New("tool installation event detail must be valid JSON")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.ToolInstallation{}, err
	}
	defer transaction.Rollback()
	current, err := scanToolInstallation(transaction.QueryRowContext(ctx, toolInstallationSelect+" WHERE id=?", installationID))
	if err != nil {
		return core.ToolInstallation{}, err
	}
	if current.State != expectedState {
		return core.ToolInstallation{}, fmt.Errorf("tool installation is %s, not %s", current.State, expectedState)
	}
	if update.PayloadBlobHash != "" {
		current.PayloadBlobHash = update.PayloadBlobHash
	}
	if update.PayloadSizeBytes != nil {
		if *update.PayloadSizeBytes < 0 {
			return core.ToolInstallation{}, errors.New("tool payload size cannot be negative")
		}
		current.PayloadSizeBytes = *update.PayloadSizeBytes
	}
	if update.InstalledTreeSHA256 != "" {
		current.InstalledTreeSHA256 = update.InstalledTreeSHA256
	}
	if update.Entrypoint != "" {
		current.Entrypoint = update.Entrypoint
	}
	if update.ProbeOutputBlobHash != "" {
		current.ProbeOutputBlobHash = update.ProbeOutputBlobHash
	}
	if current.PayloadBlobHash != "" && !validToolSHA256(current.PayloadBlobHash) ||
		current.InstalledTreeSHA256 != "" && !validToolSHA256(current.InstalledTreeSHA256) ||
		current.ProbeOutputBlobHash != "" && !validToolSHA256(current.ProbeOutputBlobHash) {
		return core.ToolInstallation{}, errors.New("tool installation contains an invalid CAS or tree hash")
	}
	now := time.Now().UTC()
	result, err := transaction.ExecContext(ctx, `
UPDATE portable_tool_installations
SET state=?,payload_blob_hash=?,payload_size_bytes=?,installed_tree_sha256=?,entrypoint=?,
    probe_output_blob_hash=?,error='',updated_at=?
WHERE id=? AND state=?`, update.State, nullString(current.PayloadBlobHash), current.PayloadSizeBytes,
		nullString(current.InstalledTreeSHA256), current.Entrypoint, nullString(current.ProbeOutputBlobHash),
		formatTime(now), current.ID, expectedState)
	if err != nil {
		return core.ToolInstallation{}, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("tool installation transition lost concurrency race")
		}
		return core.ToolInstallation{}, err
	}
	current.State, current.Error, current.UpdatedAt = update.State, "", now
	if err := appendToolInstallEvent(ctx, transaction, current, update.State, update.DetailJSON, now); err != nil {
		return core.ToolInstallation{}, err
	}
	if err := transaction.Commit(); err != nil {
		return core.ToolInstallation{}, err
	}
	return current, nil
}

func (db *DB) CompleteToolInstallation(ctx context.Context, installationID, installedTreeSHA256, entrypoint, probeOutputBlobHash string) (core.ToolInstallation, error) {
	if !validToolSHA256(installedTreeSHA256) || strings.TrimSpace(entrypoint) == "" {
		return core.ToolInstallation{}, errors.New("ready installation requires a tree hash and entrypoint")
	}
	if probeOutputBlobHash != "" && !validToolSHA256(probeOutputBlobHash) {
		return core.ToolInstallation{}, errors.New("probe output CAS hash is invalid")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.ToolInstallation{}, err
	}
	defer transaction.Rollback()
	current, err := scanToolInstallation(transaction.QueryRowContext(ctx, toolInstallationSelect+" WHERE id=?", installationID))
	if err != nil {
		return core.ToolInstallation{}, err
	}
	if current.State == "ready" {
		if current.InstalledTreeSHA256 == installedTreeSHA256 && current.Entrypoint == entrypoint && current.ProbeOutputBlobHash == probeOutputBlobHash {
			return current, transaction.Commit()
		}
		return core.ToolInstallation{}, errors.New("ready installation completion identity differs")
	}
	if current.State != "probing" {
		return core.ToolInstallation{}, fmt.Errorf("tool installation is %s, not probing", current.State)
	}
	if current.PayloadBlobHash == "" {
		return core.ToolInstallation{}, errors.New("tool installation payload was not verified")
	}
	now := time.Now().UTC()
	result, err := transaction.ExecContext(ctx, `
UPDATE portable_tool_installations
SET state='ready',installed_tree_sha256=?,entrypoint=?,probe_output_blob_hash=?,error='',
    updated_at=?,completed_at=?
WHERE id=? AND state='probing'`, installedTreeSHA256, entrypoint, nullString(probeOutputBlobHash),
		formatTime(now), formatTime(now), current.ID)
	if err != nil {
		return core.ToolInstallation{}, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("tool installation completion lost concurrency race")
		}
		return core.ToolInstallation{}, err
	}
	current.State, current.InstalledTreeSHA256, current.Entrypoint = "ready", installedTreeSHA256, entrypoint
	current.ProbeOutputBlobHash, current.Error = probeOutputBlobHash, ""
	current.UpdatedAt, current.CompletedAt = now, &now
	if err := appendToolInstallEvent(ctx, transaction, current, "ready", `{}`, now); err != nil {
		return core.ToolInstallation{}, err
	}
	if err := transaction.Commit(); err != nil {
		return core.ToolInstallation{}, err
	}
	return current, nil
}

func (db *DB) FailToolInstallation(ctx context.Context, installationID string, cause error) (core.ToolInstallation, error) {
	message := "tool installation failed"
	if cause != nil && strings.TrimSpace(cause.Error()) != "" {
		message = cause.Error()
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.ToolInstallation{}, err
	}
	defer transaction.Rollback()
	current, err := scanToolInstallation(transaction.QueryRowContext(ctx, toolInstallationSelect+" WHERE id=?", installationID))
	if err != nil {
		return core.ToolInstallation{}, err
	}
	if current.State == "failed" {
		if current.Error == message {
			return current, transaction.Commit()
		}
		return core.ToolInstallation{}, errors.New("failed installation has a different terminal error")
	}
	if current.State == "ready" || current.State == "interrupted" || current.State == "quarantined" {
		return core.ToolInstallation{}, fmt.Errorf("tool installation is terminal: %s", current.State)
	}
	now := time.Now().UTC()
	result, err := transaction.ExecContext(ctx, `
UPDATE portable_tool_installations SET state='failed',error=?,updated_at=?,completed_at=?
WHERE id=? AND state IN ('downloading','verifying','installing','probing')`, message,
		formatTime(now), formatTime(now), current.ID)
	if err != nil {
		return core.ToolInstallation{}, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("tool installation failure lost concurrency race")
		}
		return core.ToolInstallation{}, err
	}
	current.State, current.Error, current.UpdatedAt, current.CompletedAt = "failed", message, now, &now
	detail, _ := json.Marshal(map[string]string{"error": message})
	if err := appendToolInstallEvent(ctx, transaction, current, "failed", string(detail), now); err != nil {
		return core.ToolInstallation{}, err
	}
	if err := transaction.Commit(); err != nil {
		return core.ToolInstallation{}, err
	}
	return current, nil
}

func (db *DB) ToolInstallation(ctx context.Context, installationID string) (core.ToolInstallation, error) {
	return scanToolInstallation(db.sql.QueryRowContext(ctx, toolInstallationSelect+" WHERE id=?", installationID))
}

func (db *DB) CreateToolStageGrant(ctx context.Context, grant core.ToolStageGrant) (core.ToolStageGrant, error) {
	if grant.ProjectID == "" || grant.RunID == "" || grant.StageAttemptID == "" ||
		grant.PackageID == "" || grant.InstallationID == "" ||
		!validToolSHA256(grant.PackageSHA256) || !validToolSHA256(grant.ApprovalSHA256) {
		return core.ToolStageGrant{}, errors.New("exact tool stage grant identity is required")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.ToolStageGrant{}, err
	}
	defer transaction.Rollback()
	existing, err := scanToolStageGrant(transaction.QueryRowContext(ctx, toolStageGrantSelect+`
WHERE stage_attempt_id=? AND package_id=? AND installation_id=?`, grant.StageAttemptID, grant.PackageID, grant.InstallationID))
	if err == nil {
		if existing.ProjectID == grant.ProjectID && existing.RunID == grant.RunID &&
			existing.PackageSHA256 == grant.PackageSHA256 && existing.ApprovalSHA256 == grant.ApprovalSHA256 {
			return existing, transaction.Commit()
		}
		return core.ToolStageGrant{}, errors.New("existing tool stage grant identity differs")
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return core.ToolStageGrant{}, err
	}
	var attemptStatus string
	var runStatus core.RunStatus
	if err := transaction.QueryRowContext(ctx, `
SELECT s.status,r.status FROM stage_attempts s JOIN runs r ON r.id=s.run_id
WHERE s.id=? AND s.run_id=? AND r.project_id=?`, grant.StageAttemptID, grant.RunID, grant.ProjectID).Scan(&attemptStatus, &runStatus); err != nil {
		return core.ToolStageGrant{}, err
	}
	if attemptStatus != "in_progress" || core.IsTerminal(runStatus) {
		return core.ToolStageGrant{}, errors.New("tool stage grant target is not active")
	}
	if grant.ID == "" {
		grant.ID, err = id.New("tgrant")
		if err != nil {
			return core.ToolStageGrant{}, err
		}
	}
	grant.CreatedAt = time.Now().UTC()
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO tool_stage_grants(id,project_id,run_id,stage_attempt_id,package_id,installation_id,
 package_sha256,approval_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, grant.ID, grant.ProjectID,
		grant.RunID, grant.StageAttemptID, grant.PackageID, grant.InstallationID,
		grant.PackageSHA256, grant.ApprovalSHA256, formatTime(grant.CreatedAt)); err != nil {
		return core.ToolStageGrant{}, err
	}
	if err := transaction.Commit(); err != nil {
		return core.ToolStageGrant{}, err
	}
	return grant, nil
}

func (db *DB) HasExactToolStageGrant(ctx context.Context, projectID, runID, stageAttemptID, packageID, installationID, packageSHA256, approvalSHA256 string) (bool, error) {
	_, err := db.ToolStageGrant(ctx, projectID, runID, stageAttemptID, packageID,
		installationID, packageSHA256, approvalSHA256)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// ToolStageGrant returns only an exact grant identity. Callers need its opaque
// ID to bind a later invocation reservation; no nearest or package-only lookup
// exists because that could widen a capability to another stage.
func (db *DB) ToolStageGrant(ctx context.Context, projectID, runID, stageAttemptID, packageID, installationID, packageSHA256, approvalSHA256 string) (core.ToolStageGrant, error) {
	return scanToolStageGrant(db.sql.QueryRowContext(ctx, toolStageGrantSelect+`
WHERE project_id=? AND run_id=? AND stage_attempt_id=? AND package_id=? AND installation_id=?
  AND package_sha256=? AND approval_sha256=?`, projectID, runID, stageAttemptID, packageID,
		installationID, packageSHA256, approvalSHA256))
}

// ReserveToolInvocation writes the external side-effect marker and running
// invocation atomically. A duplicate exact idempotency key never executes.
func (db *DB) ReserveToolInvocation(ctx context.Context, invocation core.ToolInvocation) (core.ToolInvocation, bool, error) {
	if invocation.IdempotencyKey == "" || invocation.ProjectID == "" || invocation.RunID == "" ||
		invocation.StageAttemptID == "" || invocation.PackageID == "" || invocation.InstallationID == "" ||
		invocation.StageGrantID == "" || invocation.ToolName == "" ||
		!validToolSHA256(invocation.ArgumentsSHA256) || !validToolSHA256(invocation.AdapterSHA256) {
		return core.ToolInvocation{}, false, errors.New("tool invocation identity, grant, and hashes are required")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.ToolInvocation{}, false, err
	}
	defer transaction.Rollback()
	existing, err := scanToolInvocation(transaction.QueryRowContext(ctx, toolInvocationSelect+`
WHERE stage_attempt_id=? AND idempotency_key=?`, invocation.StageAttemptID, invocation.IdempotencyKey))
	if err == nil {
		if !sameToolInvocationIdentity(existing, invocation) {
			return core.ToolInvocation{}, false, errors.New("tool invocation idempotency key was reused with different input")
		}
		return existing, false, transaction.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return core.ToolInvocation{}, false, err
	}
	// A model-generated call identifier is useful for protocol replay, but it
	// must not be possible to bypass at-most-once execution by inventing a new
	// identifier for the same normalized stage/package/tool/input contract.
	existing, err = scanToolInvocation(transaction.QueryRowContext(ctx, toolInvocationSelect+`
WHERE stage_attempt_id=? AND package_id=? AND installation_id=? AND tool_name=?
  AND arguments_sha256=? AND adapter_sha256=?`, invocation.StageAttemptID, invocation.PackageID,
		invocation.InstallationID, invocation.ToolName, invocation.ArgumentsSHA256, invocation.AdapterSHA256))
	if err == nil {
		return existing, false, transaction.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return core.ToolInvocation{}, false, err
	}
	var stageStatus string
	var runStatus core.RunStatus
	if err := transaction.QueryRowContext(ctx, `
SELECT s.status,r.status FROM stage_attempts s JOIN runs r ON r.id=s.run_id
JOIN tool_stage_grants g ON g.id=? AND g.project_id=r.project_id AND g.run_id=r.id
 AND g.stage_attempt_id=s.id AND g.package_id=? AND g.installation_id=?
JOIN tool_packages p ON p.id=g.package_id AND p.project_id=r.project_id AND p.state='active'
JOIN portable_tool_installations i ON i.id=g.installation_id AND i.project_id=r.project_id AND i.state='ready'
WHERE s.id=? AND s.run_id=? AND r.project_id=?`, invocation.StageGrantID, invocation.PackageID,
		invocation.InstallationID, invocation.StageAttemptID, invocation.RunID, invocation.ProjectID).Scan(&stageStatus, &runStatus); err != nil {
		return core.ToolInvocation{}, false, err
	}
	if stageStatus != "in_progress" || core.IsTerminal(runStatus) {
		return core.ToolInvocation{}, false, errors.New("tool invocation stage is not active")
	}
	if invocation.ID == "" {
		invocation.ID, err = id.New("tcall")
		if err != nil {
			return core.ToolInvocation{}, false, err
		}
	}
	now := time.Now().UTC()
	invocation.State, invocation.Error = "running", ""
	invocation.CreatedAt, invocation.UpdatedAt, invocation.StartedAt = now, now, &now
	invocation.CompletedAt, invocation.ExitCode = nil, nil
	result, err := transaction.ExecContext(ctx, `
UPDATE stage_attempts SET external_side_effects=1,updated_at=?
WHERE id=? AND run_id=? AND status='in_progress'`, formatTime(now), invocation.StageAttemptID, invocation.RunID)
	if err != nil {
		return core.ToolInvocation{}, false, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("tool invocation stage changed before reservation")
		}
		return core.ToolInvocation{}, false, err
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO tool_invocations(
 id,idempotency_key,project_id,run_id,stage_attempt_id,package_id,installation_id,stage_grant_id,
 tool_name,arguments_sha256,adapter_sha256,state,error,created_at,updated_at,started_at
) VALUES(?,?,?,?,?,?,?,?,?,?,?,'running','',?,?,?)`, invocation.ID, invocation.IdempotencyKey,
		invocation.ProjectID, invocation.RunID, invocation.StageAttemptID, invocation.PackageID,
		invocation.InstallationID, invocation.StageGrantID, invocation.ToolName,
		invocation.ArgumentsSHA256, invocation.AdapterSHA256, formatTime(now), formatTime(now), formatTime(now)); err != nil {
		return core.ToolInvocation{}, false, err
	}
	if err := appendEvent(ctx, transaction, invocation.RunID, "tool.invocation.started", map[string]any{
		"invocation_id": invocation.ID, "stage_attempt_id": invocation.StageAttemptID,
		"package_id": invocation.PackageID, "tool": invocation.ToolName,
	}, now); err != nil {
		return core.ToolInvocation{}, false, err
	}
	if err := transaction.Commit(); err != nil {
		return core.ToolInvocation{}, false, err
	}
	return invocation, true, nil
}

func (db *DB) CompleteToolInvocation(ctx context.Context, invocationID, stdoutBlobHash, stderrBlobHash string, exitCode int) (core.ToolInvocation, error) {
	if stdoutBlobHash != "" && !validToolSHA256(stdoutBlobHash) || stderrBlobHash != "" && !validToolSHA256(stderrBlobHash) {
		return core.ToolInvocation{}, errors.New("tool invocation output CAS hash is invalid")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.ToolInvocation{}, err
	}
	defer transaction.Rollback()
	current, err := scanToolInvocation(transaction.QueryRowContext(ctx, toolInvocationSelect+" WHERE id=?", invocationID))
	if err != nil {
		return core.ToolInvocation{}, err
	}
	if current.State == "succeeded" {
		if current.StdoutBlobHash == stdoutBlobHash && current.StderrBlobHash == stderrBlobHash && current.ExitCode != nil && *current.ExitCode == exitCode {
			return current, transaction.Commit()
		}
		return core.ToolInvocation{}, errors.New("completed tool invocation result differs")
	}
	if current.State != "running" {
		return core.ToolInvocation{}, fmt.Errorf("tool invocation is terminal: %s", current.State)
	}
	now := time.Now().UTC()
	result, err := transaction.ExecContext(ctx, `
UPDATE tool_invocations SET state='succeeded',stdout_blob_hash=?,stderr_blob_hash=?,exit_code=?,
 error='',updated_at=?,completed_at=? WHERE id=? AND state='running'`, nullString(stdoutBlobHash),
		nullString(stderrBlobHash), exitCode, formatTime(now), formatTime(now), current.ID)
	if err != nil {
		return core.ToolInvocation{}, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("tool invocation completion lost concurrency race")
		}
		return core.ToolInvocation{}, err
	}
	current.State, current.StdoutBlobHash, current.StderrBlobHash = "succeeded", stdoutBlobHash, stderrBlobHash
	current.ExitCode, current.Error, current.UpdatedAt, current.CompletedAt = &exitCode, "", now, &now
	if err := appendEvent(ctx, transaction, current.RunID, "tool.invocation.succeeded", map[string]any{
		"invocation_id": current.ID, "exit_code": exitCode,
	}, now); err != nil {
		return core.ToolInvocation{}, err
	}
	if err := transaction.Commit(); err != nil {
		return core.ToolInvocation{}, err
	}
	return current, nil
}

func (db *DB) FailToolInvocation(ctx context.Context, invocationID string, cause error) (core.ToolInvocation, error) {
	message := "tool invocation failed"
	if cause != nil && strings.TrimSpace(cause.Error()) != "" {
		message = cause.Error()
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.ToolInvocation{}, err
	}
	defer transaction.Rollback()
	current, err := scanToolInvocation(transaction.QueryRowContext(ctx, toolInvocationSelect+" WHERE id=?", invocationID))
	if err != nil {
		return core.ToolInvocation{}, err
	}
	if current.State == "failed" {
		if current.Error == message {
			return current, transaction.Commit()
		}
		return core.ToolInvocation{}, errors.New("failed tool invocation has a different terminal error")
	}
	if current.State != "running" {
		return core.ToolInvocation{}, fmt.Errorf("tool invocation is terminal: %s", current.State)
	}
	now := time.Now().UTC()
	result, err := transaction.ExecContext(ctx, `
UPDATE tool_invocations SET state='failed',error=?,updated_at=?,completed_at=?
WHERE id=? AND state='running'`, message, formatTime(now), formatTime(now), current.ID)
	if err != nil {
		return core.ToolInvocation{}, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("tool invocation failure lost concurrency race")
		}
		return core.ToolInvocation{}, err
	}
	current.State, current.Error, current.UpdatedAt, current.CompletedAt = "failed", message, now, &now
	if err := appendEvent(ctx, transaction, current.RunID, "tool.invocation.failed", map[string]any{
		"invocation_id": current.ID, "error": message,
	}, now); err != nil {
		return core.ToolInvocation{}, err
	}
	if err := transaction.Commit(); err != nil {
		return core.ToolInvocation{}, err
	}
	return current, nil
}

func (db *DB) ToolInvocation(ctx context.Context, invocationID string) (core.ToolInvocation, error) {
	return scanToolInvocation(db.sql.QueryRowContext(ctx, toolInvocationSelect+" WHERE id=?", invocationID))
}

func recoverToolWork(ctx context.Context, transaction *sql.Tx, now time.Time) (ToolRecoveryResult, error) {
	var result ToolRecoveryResult
	rows, err := transaction.QueryContext(ctx, toolInstallationSelect+`
WHERE state IN ('downloading','verifying','installing','probing') ORDER BY created_at,id`)
	if err != nil {
		return result, err
	}
	var installations []core.ToolInstallation
	for rows.Next() {
		installation, scanErr := scanToolInstallation(rows)
		if scanErr != nil {
			rows.Close()
			return result, scanErr
		}
		installations = append(installations, installation)
	}
	if err := rows.Close(); err != nil {
		return result, err
	}
	for _, installation := range installations {
		message := "application exited while tool installation was in progress"
		if _, err := transaction.ExecContext(ctx, `
UPDATE portable_tool_installations SET state='interrupted',error=?,updated_at=?,completed_at=?
WHERE id=? AND state IN ('downloading','verifying','installing','probing')`, message,
			formatTime(now), formatTime(now), installation.ID); err != nil {
			return result, err
		}
		installation.State, installation.Error = "interrupted", message
		if err := appendToolInstallEvent(ctx, transaction, installation, "interrupted", `{}`, now); err != nil {
			return result, err
		}
		result.InstallationsInterrupted++
	}
	invocationRows, err := transaction.QueryContext(ctx, toolInvocationSelect+" WHERE state='running' ORDER BY created_at,id")
	if err != nil {
		return result, err
	}
	var invocations []core.ToolInvocation
	for invocationRows.Next() {
		invocation, scanErr := scanToolInvocation(invocationRows)
		if scanErr != nil {
			invocationRows.Close()
			return result, scanErr
		}
		invocations = append(invocations, invocation)
	}
	if err := invocationRows.Close(); err != nil {
		return result, err
	}
	for _, invocation := range invocations {
		message := "application exited while native tool outcome was unknown"
		if _, err := transaction.ExecContext(ctx, `
UPDATE tool_invocations SET state='uncertain',error=?,updated_at=?,completed_at=?
WHERE id=? AND state='running'`, message, formatTime(now), formatTime(now), invocation.ID); err != nil {
			return result, err
		}
		if err := appendEvent(ctx, transaction, invocation.RunID, "tool.invocation.uncertain", map[string]any{
			"invocation_id": invocation.ID, "stage_attempt_id": invocation.StageAttemptID,
		}, now); err != nil {
			return result, err
		}
		result.InvocationsUncertain++
	}
	return result, nil
}

func appendToolInstallEvent(ctx context.Context, transaction *sql.Tx, installation core.ToolInstallation, action, detailJSON string, now time.Time) error {
	_, err := transaction.ExecContext(ctx, `
INSERT INTO tool_install_events(installation_id,package_id,project_id,action,approval_sha256,detail_json,created_at)
VALUES(?,?,?,?,?,?,?)`, installation.ID, installation.PackageID, installation.ProjectID, action,
		installation.ApprovalSHA256, detailJSON, formatTime(now))
	return err
}

const toolInstallationSelect = `SELECT id,package_id,project_id,package_sha256,approval_sha256,
 expected_payload_sha256,COALESCE(payload_blob_hash,''),payload_size_bytes,
 COALESCE(installed_tree_sha256,''),entrypoint,COALESCE(probe_output_blob_hash,''),state,error,
 created_at,updated_at,completed_at FROM portable_tool_installations`

func scanToolInstallation(row scanner) (core.ToolInstallation, error) {
	var installation core.ToolInstallation
	var created, updated string
	var completed sql.NullString
	err := row.Scan(&installation.ID, &installation.PackageID, &installation.ProjectID,
		&installation.PackageSHA256, &installation.ApprovalSHA256, &installation.ExpectedPayloadSHA256,
		&installation.PayloadBlobHash, &installation.PayloadSizeBytes, &installation.InstalledTreeSHA256,
		&installation.Entrypoint, &installation.ProbeOutputBlobHash, &installation.State,
		&installation.Error, &created, &updated, &completed)
	if err != nil {
		return core.ToolInstallation{}, err
	}
	installation.CreatedAt, err = parseTime(created)
	if err != nil {
		return core.ToolInstallation{}, err
	}
	installation.UpdatedAt, err = parseTime(updated)
	if err != nil {
		return core.ToolInstallation{}, err
	}
	if completed.Valid {
		value, parseErr := parseTime(completed.String)
		if parseErr != nil {
			return core.ToolInstallation{}, parseErr
		}
		installation.CompletedAt = &value
	}
	return installation, nil
}

const toolStageGrantSelect = `SELECT id,project_id,run_id,stage_attempt_id,package_id,installation_id,
 package_sha256,approval_sha256,created_at FROM tool_stage_grants`

func scanToolStageGrant(row scanner) (core.ToolStageGrant, error) {
	var grant core.ToolStageGrant
	var created string
	err := row.Scan(&grant.ID, &grant.ProjectID, &grant.RunID, &grant.StageAttemptID,
		&grant.PackageID, &grant.InstallationID, &grant.PackageSHA256, &grant.ApprovalSHA256, &created)
	if err != nil {
		return core.ToolStageGrant{}, err
	}
	grant.CreatedAt, err = parseTime(created)
	return grant, err
}

const toolInvocationSelect = `SELECT id,idempotency_key,project_id,run_id,stage_attempt_id,package_id,
 installation_id,stage_grant_id,tool_name,arguments_sha256,adapter_sha256,state,
 COALESCE(stdout_blob_hash,''),COALESCE(stderr_blob_hash,''),exit_code,error,
 created_at,updated_at,started_at,completed_at FROM tool_invocations`

func scanToolInvocation(row scanner) (core.ToolInvocation, error) {
	var invocation core.ToolInvocation
	var exitCode sql.NullInt64
	var created, updated, started string
	var completed sql.NullString
	err := row.Scan(&invocation.ID, &invocation.IdempotencyKey, &invocation.ProjectID,
		&invocation.RunID, &invocation.StageAttemptID, &invocation.PackageID,
		&invocation.InstallationID, &invocation.StageGrantID, &invocation.ToolName,
		&invocation.ArgumentsSHA256, &invocation.AdapterSHA256, &invocation.State,
		&invocation.StdoutBlobHash, &invocation.StderrBlobHash, &exitCode, &invocation.Error,
		&created, &updated, &started, &completed)
	if err != nil {
		return core.ToolInvocation{}, err
	}
	invocation.CreatedAt, err = parseTime(created)
	if err != nil {
		return core.ToolInvocation{}, err
	}
	invocation.UpdatedAt, err = parseTime(updated)
	if err != nil {
		return core.ToolInvocation{}, err
	}
	startedAt, err := parseTime(started)
	if err != nil {
		return core.ToolInvocation{}, err
	}
	invocation.StartedAt = &startedAt
	if completed.Valid {
		completedAt, parseErr := parseTime(completed.String)
		if parseErr != nil {
			return core.ToolInvocation{}, parseErr
		}
		invocation.CompletedAt = &completedAt
	}
	if exitCode.Valid {
		value := int(exitCode.Int64)
		invocation.ExitCode = &value
	}
	return invocation, nil
}

func sameToolInvocationIdentity(left, right core.ToolInvocation) bool {
	return left.IdempotencyKey == right.IdempotencyKey && left.ProjectID == right.ProjectID &&
		left.RunID == right.RunID && left.StageAttemptID == right.StageAttemptID &&
		left.PackageID == right.PackageID && left.InstallationID == right.InstallationID &&
		left.StageGrantID == right.StageGrantID && left.ToolName == right.ToolName &&
		left.ArgumentsSHA256 == right.ArgumentsSHA256 && left.AdapterSHA256 == right.AdapterSHA256
}
