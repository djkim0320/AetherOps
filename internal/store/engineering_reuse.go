package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// AuthorizeEngineeringReceiptReuses binds exact, already-succeeded receipts
// to one active collector attempt. It is used only by the Go state machine
// before a REVIEW-directed readback turn starts; model output cannot create a
// reuse grant.
func (db *DB) AuthorizeEngineeringReceiptReuses(
	ctx context.Context,
	runID, attemptID string,
	results []EngineeringResult,
) error {
	if runID == "" || attemptID == "" || len(results) == 0 {
		return errors.New("engineering receipt reuse authorization is incomplete")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	now := formatTime(time.Now().UTC())
	for _, result := range results {
		job := result.Job
		if job.ID == "" || job.RunID != runID || job.StageAttemptID == attemptID ||
			job.Status != "succeeded" || job.ReceiptArtifactID == "" {
			return fmt.Errorf("engineering job %q is not an immutable prior succeeded receipt", job.ID)
		}
		if _, err := transaction.ExecContext(ctx, `
INSERT INTO engineering_receipt_reuses(
  run_id,stage_attempt_id,source_job_id,receipt_artifact_id,created_at
) VALUES(?,?,?,?,?)
ON CONFLICT(stage_attempt_id,receipt_artifact_id) DO NOTHING`,
			runID, attemptID, job.ID, job.ReceiptArtifactID, now,
		); err != nil {
			return fmt.Errorf("authorize engineering receipt %s reuse: %w", job.ReceiptArtifactID, err)
		}
		var count int
		if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM engineering_receipt_reuses
WHERE run_id=? AND stage_attempt_id=? AND source_job_id=? AND receipt_artifact_id=?`,
			runID, attemptID, job.ID, job.ReceiptArtifactID,
		).Scan(&count); err != nil {
			return err
		}
		if count != 1 {
			return fmt.Errorf("engineering receipt %s reuse authorization was not persisted exactly once", job.ReceiptArtifactID)
		}
	}
	return transaction.Commit()
}

// RemediationEngineeringResults returns the exact engineering jobs from the
// research cycle sealed by one remediation record. Matching the stage
// updated_at to the remediation created_at prevents an older superseded cycle
// from being silently mixed into the current readback contract.
func (db *DB) RemediationEngineeringResults(
	ctx context.Context,
	runID, operation string,
	cycle int,
) ([]EngineeringResult, error) {
	if runID == "" || operation == "" || cycle < 1 {
		return nil, errors.New("remediation engineering lookup is incomplete")
	}
	rows, err := db.sql.QueryContext(ctx, engineeringJobSelect+`
WHERE engineering_jobs.run_id=? AND engineering_jobs.operation=?
  AND EXISTS(
    SELECT 1
    FROM stage_attempts attempt
    JOIN research_remediation_cycles remediation
      ON remediation.run_id=attempt.run_id
     AND remediation.cycle=?
     AND remediation.created_at=attempt.updated_at
    WHERE attempt.id=engineering_jobs.stage_attempt_id
      AND attempt.run_id=engineering_jobs.run_id
      AND attempt.stage='collect'
      AND attempt.logical_ordinal=0
      AND attempt.status='superseded'
  )
ORDER BY engineering_jobs.created_at,engineering_jobs.id`, runID, operation, cycle)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var jobs []EngineeringJob
	for rows.Next() {
		job, scanErr := scanEngineeringJob(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		jobs = append(jobs, job)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	results := make([]EngineeringResult, 0, len(jobs))
	for _, job := range jobs {
		artifacts, artifactErr := db.EngineeringJobArtifacts(ctx, job.ID)
		if artifactErr != nil {
			return nil, artifactErr
		}
		results = append(results, EngineeringResult{Job: job, Artifacts: artifacts})
	}
	return results, nil
}

// EngineeringReceiptReadbackOnly reports whether the active attempt was
// explicitly prepared to read prior receipts. Approval routing uses this to
// decline any solver execution request without presenting a misleading UI
// approval.
func (db *DB) EngineeringReceiptReadbackOnly(ctx context.Context, runID, attemptID string) (bool, error) {
	var count int
	err := db.sql.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM engineering_receipt_reuses reuse
JOIN stage_attempts attempt
  ON attempt.id=reuse.stage_attempt_id AND attempt.run_id=reuse.run_id
WHERE reuse.run_id=? AND reuse.stage_attempt_id=?
  AND attempt.stage='collect' AND attempt.status='in_progress'`, runID, attemptID).Scan(&count)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return count > 0, err
}
