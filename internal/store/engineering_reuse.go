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
