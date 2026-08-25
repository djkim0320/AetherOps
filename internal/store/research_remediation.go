package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
)

var ErrResearchRemediationLimit = errors.New("autonomous research remediation limit reached")

// ResearchRemediation is the durable bridge from one failed REVIEW to the
// next PLAN. It contains conclusions only, never hidden reasoning or a copied
// conversation transcript.
type ResearchRemediation struct {
	RunID              string                       `json:"run_id"`
	Cycle              int                          `json:"cycle"`
	Action             core.ReviewRemediationAction `json:"action"`
	ReviewStageAttempt string                       `json:"review_stage_attempt_id"`
	ReviewOutputHash   string                       `json:"review_output_hash"`
	Summary            string                       `json:"summary"`
	RevisionRequests   []string                     `json:"revision_requests"`
	Tasks              []core.ReviewRemediationTask `json:"remediation_tasks"`
	CreatedAt          time.Time                    `json:"created_at"`
}

// PrepareResearchRemediation atomically seals every stage in the current
// research cycle as superseded and returns the same run to PLAN. Nothing is
// deleted: stage outputs, receipts, approvals, solver jobs, and CAS objects
// remain available for audit but are excluded from the new active cycle.
func (db *DB) PrepareResearchRemediation(
	ctx context.Context,
	runID string,
	expectedRevision int64,
	reviewOrdinal int,
	verdict core.ReviewVerdict,
) (core.Run, ResearchRemediation, error) {
	action := verdict.EffectiveRemediationAction()
	if !action.RestartsResearch() {
		return core.Run{}, ResearchRemediation{}, errors.New("review does not require a new research cycle")
	}
	requestsJSON, err := json.Marshal(verdict.RevisionRequests)
	if err != nil {
		return core.Run{}, ResearchRemediation{}, fmt.Errorf("encode remediation requests: %w", err)
	}
	tasksJSON, err := json.Marshal(verdict.RemediationTasks)
	if err != nil {
		return core.Run{}, ResearchRemediation{}, fmt.Errorf("encode remediation tasks: %w", err)
	}

	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.Run{}, ResearchRemediation{}, err
	}
	defer tx.Rollback()
	current, err := scanRun(tx.QueryRowContext(ctx, runSelect+" WHERE id = ?", runID))
	if err != nil {
		return core.Run{}, ResearchRemediation{}, err
	}
	if current.Revision != expectedRevision {
		return core.Run{}, ResearchRemediation{}, fmt.Errorf(
			"run revision conflict: expected %d, found %d", expectedRevision, current.Revision,
		)
	}
	if current.Status != core.RunReviewing {
		return core.Run{}, ResearchRemediation{}, fmt.Errorf("research remediation requires reviewing run, got %s", current.Status)
	}
	if err := core.RequireTransition(current.Status, core.RunPlanning); err != nil {
		return core.Run{}, ResearchRemediation{}, err
	}
	var active int
	if err := tx.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM stage_attempts WHERE run_id=? AND status='in_progress'", runID,
	).Scan(&active); err != nil {
		return core.Run{}, ResearchRemediation{}, err
	}
	if active != 0 {
		return core.Run{}, ResearchRemediation{}, errors.New("cannot replace a research cycle with an active stage")
	}
	var completedCycles int
	if err := tx.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM research_remediation_cycles WHERE run_id=?", runID,
	).Scan(&completedCycles); err != nil {
		return core.Run{}, ResearchRemediation{}, err
	}
	if completedCycles >= core.MaxResearchRemediations {
		return core.Run{}, ResearchRemediation{}, ErrResearchRemediationLimit
	}
	cycle := completedCycles + 1
	var reviewAttemptID, reviewHash string
	if err := tx.QueryRowContext(ctx, `
SELECT id,output_artifact_hash
FROM stage_attempts
WHERE run_id=? AND stage='review' AND logical_ordinal=? AND status='completed'
ORDER BY created_at DESC,id DESC LIMIT 1`, runID, reviewOrdinal).Scan(&reviewAttemptID, &reviewHash); err != nil {
		return core.Run{}, ResearchRemediation{}, fmt.Errorf("resolve remediation review checkpoint: %w", err)
	}
	if reviewHash == "" {
		return core.Run{}, ResearchRemediation{}, errors.New("remediation review checkpoint has no output hash")
	}
	now := time.Now().UTC()
	remediation := ResearchRemediation{
		RunID: runID, Cycle: cycle, Action: action, ReviewStageAttempt: reviewAttemptID,
		ReviewOutputHash: reviewHash, Summary: verdict.Summary,
		RevisionRequests: append([]string(nil), verdict.RevisionRequests...),
		Tasks:            append([]core.ReviewRemediationTask(nil), verdict.RemediationTasks...),
		CreatedAt:        now,
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO research_remediation_cycles(
 run_id,cycle,action,review_stage_attempt_id,review_output_hash,summary,
 revision_requests_json,remediation_tasks_json,created_at
) VALUES(?,?,?,?,?,?,?,?,?)`,
		remediation.RunID, remediation.Cycle, remediation.Action,
		remediation.ReviewStageAttempt, remediation.ReviewOutputHash, remediation.Summary,
		string(requestsJSON), string(tasksJSON), formatTime(now),
	); err != nil {
		return core.Run{}, ResearchRemediation{}, fmt.Errorf("record research remediation: %w", err)
	}

	type stageRow struct {
		id      string
		stage   string
		ordinal int
	}
	rows, err := tx.QueryContext(ctx, `
SELECT id,stage,ordinal FROM stage_attempts
WHERE run_id=? AND status<>'superseded'
ORDER BY stage,ordinal,created_at,id`, runID)
	if err != nil {
		return core.Run{}, ResearchRemediation{}, err
	}
	var stages []stageRow
	for rows.Next() {
		var row stageRow
		if err := rows.Scan(&row.id, &row.stage, &row.ordinal); err != nil {
			rows.Close()
			return core.Run{}, ResearchRemediation{}, err
		}
		stages = append(stages, row)
	}
	if err := rows.Close(); err != nil {
		return core.Run{}, ResearchRemediation{}, err
	}
	if len(stages) == 0 {
		return core.Run{}, ResearchRemediation{}, errors.New("research remediation has no completed stage history")
	}
	// Include already-superseded cycles when choosing archival ordinals. Using
	// only the active rows would collide with -1/-2 from the first remediation
	// when a later REVIEW requests another full research cycle.
	minimum := make(map[string]int)
	minimumRows, err := tx.QueryContext(ctx, `
SELECT stage,MIN(ordinal) FROM stage_attempts WHERE run_id=? GROUP BY stage`, runID)
	if err != nil {
		return core.Run{}, ResearchRemediation{}, err
	}
	for minimumRows.Next() {
		var stage string
		var ordinal int
		if err := minimumRows.Scan(&stage, &ordinal); err != nil {
			minimumRows.Close()
			return core.Run{}, ResearchRemediation{}, err
		}
		minimum[stage] = ordinal
	}
	if err := minimumRows.Close(); err != nil {
		return core.Run{}, ResearchRemediation{}, err
	}
	for _, row := range stages {
		minimum[row.stage]--
		result, err := tx.ExecContext(ctx, `
UPDATE stage_attempts SET ordinal=?,status='superseded',updated_at=?
WHERE id=? AND run_id=? AND status<>'superseded'`,
			minimum[row.stage], formatTime(now), row.id, runID,
		)
		if err != nil {
			return core.Run{}, ResearchRemediation{}, fmt.Errorf("seal prior %s stage: %w", row.stage, err)
		}
		if changed, err := result.RowsAffected(); err != nil || changed != 1 {
			if err == nil {
				err = errors.New("stage changed while sealing research cycle")
			}
			return core.Run{}, ResearchRemediation{}, err
		}
	}

	result, err := tx.ExecContext(ctx, `
UPDATE runs
SET status='planning',revision=revision+1,revision_cycle=0,
    report_artifact_id='',error='',updated_at=?
WHERE id=? AND revision=? AND status='reviewing'`,
		formatTime(now), runID, expectedRevision,
	)
	if err != nil {
		return core.Run{}, ResearchRemediation{}, err
	}
	if changed, err := result.RowsAffected(); err != nil || changed != 1 {
		if err == nil {
			err = errors.New("research remediation lost optimistic concurrency race")
		}
		return core.Run{}, ResearchRemediation{}, err
	}
	if err := retirePendingApprovals(ctx, tx, runID, "research_remediation", now); err != nil {
		return core.Run{}, ResearchRemediation{}, err
	}
	if err := appendEvent(ctx, tx, runID, "research.remediation_started", map[string]any{
		"cycle": cycle, "action": action, "review_stage_attempt_id": reviewAttemptID,
		"review_output_hash": reviewHash, "revision": expectedRevision + 1,
	}, now); err != nil {
		return core.Run{}, ResearchRemediation{}, err
	}
	if err := tx.Commit(); err != nil {
		return core.Run{}, ResearchRemediation{}, err
	}
	current.Status = core.RunPlanning
	current.Revision++
	current.RevisionCycle = 0
	current.ReportArtifactID = ""
	current.Error = ""
	current.UpdatedAt = now
	return current, remediation, nil
}

func (db *DB) LatestResearchRemediation(ctx context.Context, runID string) (ResearchRemediation, error) {
	var value ResearchRemediation
	var requestsJSON, tasksJSON, created string
	err := db.sql.QueryRowContext(ctx, `
SELECT run_id,cycle,action,review_stage_attempt_id,review_output_hash,summary,
       revision_requests_json,remediation_tasks_json,created_at
FROM research_remediation_cycles WHERE run_id=?
ORDER BY cycle DESC LIMIT 1`, runID).Scan(
		&value.RunID, &value.Cycle, &value.Action, &value.ReviewStageAttempt,
		&value.ReviewOutputHash, &value.Summary, &requestsJSON, &tasksJSON, &created,
	)
	if err != nil {
		return ResearchRemediation{}, err
	}
	if err := json.Unmarshal([]byte(requestsJSON), &value.RevisionRequests); err != nil {
		return ResearchRemediation{}, fmt.Errorf("decode remediation requests: %w", err)
	}
	if err := json.Unmarshal([]byte(tasksJSON), &value.Tasks); err != nil {
		return ResearchRemediation{}, fmt.Errorf("decode remediation tasks: %w", err)
	}
	value.CreatedAt, err = parseTime(created)
	return value, err
}

func (db *DB) ResearchRemediationCount(ctx context.Context, runID string) (int, error) {
	var count int
	err := db.sql.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM research_remediation_cycles WHERE run_id=?", runID,
	).Scan(&count)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return count, err
}
