package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/id"
)

func (db *DB) CreateSchedule(ctx context.Context, schedule core.Schedule) (core.Schedule, error) {
	if schedule.ConversationSessionID == "" && schedule.ProjectID != "" {
		session, err := db.DefaultConversationSession(ctx, schedule.ProjectID)
		if err != nil {
			return core.Schedule{}, err
		}
		schedule.ConversationSessionID = session.ID
	}
	if schedule.ProjectID == "" || schedule.ConversationSessionID == "" || schedule.Question == "" || schedule.Kind == "" || schedule.Expression == "" || schedule.MainThreadID == "" {
		return core.Schedule{}, errors.New("schedule project, question, expression, and main thread are required")
	}
	session, err := db.ConversationSession(ctx, schedule.ConversationSessionID)
	if err != nil {
		return core.Schedule{}, err
	}
	if session.ProjectID != schedule.ProjectID || session.CodexThreadID != schedule.MainThreadID {
		return core.Schedule{}, errors.New("schedule conversation session does not match its project and thread")
	}
	if schedule.ID == "" {
		generated, err := id.New("sch")
		if err != nil {
			return core.Schedule{}, err
		}
		schedule.ID = generated
	}
	now := time.Now().UTC()
	schedule.CreatedAt = now
	schedule.UpdatedAt = now
	_, err = db.sql.ExecContext(ctx, `
INSERT INTO schedules(
  id, project_id, conversation_session_id, question, kind, expression, timezone, enabled,
  next_run_at, last_run_at, main_thread_id, created_at, updated_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		schedule.ID, schedule.ProjectID, schedule.ConversationSessionID, schedule.Question, schedule.Kind,
		schedule.Expression, schedule.Timezone, schedule.Enabled,
		formatNullableTime(schedule.NextRunAt), formatNullableTime(schedule.LastRunAt),
		schedule.MainThreadID, formatTime(now), formatTime(now))
	return schedule, err
}

func (db *DB) ListDueSchedules(ctx context.Context, now time.Time) ([]core.Schedule, error) {
	rows, err := db.sql.QueryContext(ctx, `
SELECT id, project_id, conversation_session_id, question, kind, expression, timezone, enabled,
       next_run_at, last_run_at, main_thread_id, created_at, updated_at
FROM schedules
WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
ORDER BY next_run_at, id`, formatTime(now))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var schedules []core.Schedule
	for rows.Next() {
		schedule, err := scanSchedule(rows)
		if err != nil {
			return nil, err
		}
		schedules = append(schedules, schedule)
	}
	return schedules, rows.Err()
}

func (db *DB) ListSchedules(ctx context.Context, projectID string) ([]core.Schedule, error) {
	query := `
SELECT id, project_id, conversation_session_id, question, kind, expression, timezone, enabled,
       next_run_at, last_run_at, main_thread_id, created_at, updated_at
FROM schedules`
	var arguments []any
	if projectID != "" {
		query += " WHERE project_id = ?"
		arguments = append(arguments, projectID)
	}
	query += " ORDER BY created_at, id"
	rows, err := db.sql.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var schedules []core.Schedule
	for rows.Next() {
		schedule, err := scanSchedule(rows)
		if err != nil {
			return nil, err
		}
		schedules = append(schedules, schedule)
	}
	return schedules, rows.Err()
}

func (db *DB) SetScheduleEnabled(ctx context.Context, scheduleID string, enabled bool) (core.Schedule, error) {
	result, err := db.sql.ExecContext(ctx, `
UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ?`,
		enabled, formatTime(time.Now()), scheduleID)
	if err != nil {
		return core.Schedule{}, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return core.Schedule{}, err
	}
	if count != 1 {
		return core.Schedule{}, sql.ErrNoRows
	}
	return scanSchedule(db.sql.QueryRowContext(ctx, `
SELECT id, project_id, conversation_session_id, question, kind, expression, timezone, enabled,
       next_run_at, last_run_at, main_thread_id, created_at, updated_at
FROM schedules WHERE id = ?`, scheduleID))
}

func (db *DB) DeleteSchedule(ctx context.Context, scheduleID string) error {
	result, err := db.sql.ExecContext(ctx, "DELETE FROM schedules WHERE id = ?", scheduleID)
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

func scanSchedule(row scanner) (core.Schedule, error) {
	var schedule core.Schedule
	var enabled bool
	var next, last sql.NullString
	var created, updated string
	if err := row.Scan(&schedule.ID, &schedule.ProjectID, &schedule.ConversationSessionID, &schedule.Question,
		&schedule.Kind, &schedule.Expression, &schedule.Timezone, &enabled,
		&next, &last, &schedule.MainThreadID, &created, &updated); err != nil {
		return core.Schedule{}, err
	}
	schedule.Enabled = enabled
	var err error
	schedule.NextRunAt, err = nullableTime(next)
	if err != nil {
		return core.Schedule{}, err
	}
	schedule.LastRunAt, err = nullableTime(last)
	if err != nil {
		return core.Schedule{}, err
	}
	schedule.CreatedAt, err = parseTime(created)
	if err != nil {
		return core.Schedule{}, err
	}
	schedule.UpdatedAt, err = parseTime(updated)
	return schedule, err
}

func formatNullableTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return formatTime(*value)
}

func (db *DB) RecordMissedSchedule(ctx context.Context, scheduleID string, scheduledFor time.Time) (bool, error) {
	result, err := db.sql.ExecContext(ctx, `
INSERT INTO schedule_firings(schedule_id, scheduled_for, run_id, status, created_at)
VALUES(?, ?, NULL, 'missed_expired', ?)
ON CONFLICT(schedule_id, scheduled_for) DO NOTHING`, scheduleID,
		formatTime(scheduledFor), formatTime(time.Now()))
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count == 1, err
}

// CreateScheduledRun atomically claims a scheduled occurrence and creates its
// queued run. The unique firing key prevents duplicate runs across restarts.
func (db *DB) CreateScheduledRun(
	ctx context.Context,
	schedule core.Schedule,
	scheduledFor time.Time,
) (core.Run, bool, error) {
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.Run{}, false, err
	}
	defer transaction.Rollback()
	now := time.Now().UTC()
	result, err := transaction.ExecContext(ctx, `
INSERT INTO schedule_firings(schedule_id, scheduled_for, run_id, status, created_at)
VALUES(?, ?, NULL, 'claiming', ?)
ON CONFLICT(schedule_id, scheduled_for) DO NOTHING`, schedule.ID,
		formatTime(scheduledFor), formatTime(now))
	if err != nil {
		return core.Run{}, false, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return core.Run{}, false, err
	}
	if count == 0 {
		return core.Run{}, false, nil
	}
	var currentThread, currentProjectID string
	var deletedAt sql.NullString
	if err := transaction.QueryRowContext(ctx, `
SELECT codex_thread_id, project_id, deleted_at FROM conversation_sessions WHERE id = ?`,
		schedule.ConversationSessionID).Scan(&currentThread, &currentProjectID, &deletedAt); err != nil {
		return core.Run{}, false, err
	}
	if deletedAt.Valid || currentProjectID != schedule.ProjectID || currentThread == "" || currentThread != schedule.MainThreadID {
		if _, err := transaction.ExecContext(ctx, `
UPDATE schedule_firings SET status = 'blocked_main_thread_lost'
WHERE schedule_id = ? AND scheduled_for = ?`, schedule.ID, formatTime(scheduledFor)); err != nil {
			return core.Run{}, false, err
		}
		if _, err := transaction.ExecContext(ctx,
			"UPDATE schedules SET enabled = 0, updated_at = ? WHERE id = ?",
			formatTime(now), schedule.ID); err != nil {
			return core.Run{}, false, err
		}
		if err := transaction.Commit(); err != nil {
			return core.Run{}, false, err
		}
		return core.Run{}, false, errors.New("schedule blocked because its conversation session thread was lost")
	}
	knowledgeHead, err := scanKnowledgeHead(transaction.QueryRowContext(ctx,
		knowledgeHeadSelect+" WHERE h.project_id = ?", schedule.ProjectID))
	if err != nil {
		return core.Run{}, false, fmt.Errorf("resolve scheduled run knowledge generation: %w", err)
	}
	if knowledgeHead.Status != KnowledgeHeadReady || knowledgeHead.Generation.State != KnowledgeReady {
		return core.Run{}, false, fmt.Errorf(
			"hybrid_graph_v1 scheduled research is blocked while knowledge graph is %s/%s",
			knowledgeHead.Status, knowledgeHead.Generation.State,
		)
	}
	if err := rejectRunWithMemoryReindex(ctx, transaction, schedule.ProjectID); err != nil {
		return core.Run{}, false, err
	}
	runID, err := id.New("run")
	if err != nil {
		return core.Run{}, false, err
	}
	productBuild := db.productBuildBinding()
	run := core.Run{
		ID: runID, ProjectID: schedule.ProjectID, ConversationSessionID: schedule.ConversationSessionID,
		ScheduleID: schedule.ID,
		Question:   schedule.Question, Status: core.RunQueued, MainThreadID: currentThread,
		ResearchProfileVersion: core.CurrentResearchProfileVersion,
		RetrievalProfile:       DefaultRetrievalProfile,
		KnowledgeGenerationID:  knowledgeHead.GenerationID,
		ProductBuild:           productBuild,
		CreatedAt:              now, UpdatedAt: now,
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO runs(
	  id, project_id, conversation_session_id, schedule_id, question, status, revision, revision_cycle,
	  main_thread_id, research_profile_version, retrieval_profile, knowledge_generation_id,
	  product_version, executable_sha256, runtime_manifest_sha256, knowledge_sidecar_tree_sha256,
	  report_artifact_id, error, created_at, updated_at
) VALUES(?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)`, run.ID, run.ProjectID,
		run.ConversationSessionID, run.ScheduleID, run.Question, run.Status, run.MainThreadID,
		run.ResearchProfileVersion, run.RetrievalProfile, run.KnowledgeGenerationID,
		run.ProductBuild.Version, run.ProductBuild.ExecutableSHA256,
		run.ProductBuild.RuntimeManifestSHA256, run.ProductBuild.KnowledgeSidecarTreeSHA256,
		formatTime(now), formatTime(now)); err != nil {
		return core.Run{}, false, err
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE schedule_firings SET run_id = ?, status = 'queued'
WHERE schedule_id = ? AND scheduled_for = ?`, run.ID, schedule.ID,
		formatTime(scheduledFor)); err != nil {
		return core.Run{}, false, err
	}
	if err := appendEvent(ctx, transaction, run.ID, "run.created", map[string]any{
		"status": run.Status, "schedule_id": schedule.ID, "scheduled_for": formatTime(scheduledFor),
		"conversation_session_id":  run.ConversationSessionID,
		"research_profile_version": run.ResearchProfileVersion,
		"retrieval_profile":        run.RetrievalProfile,
		"knowledge_generation_id":  run.KnowledgeGenerationID,
		"product_build":            run.ProductBuild,
	}, now); err != nil {
		return core.Run{}, false, err
	}
	if err := transaction.Commit(); err != nil {
		return core.Run{}, false, err
	}
	return run, true, nil
}

func (db *DB) UpdateScheduleTimes(
	ctx context.Context,
	scheduleID string,
	expectedNext time.Time,
	last, next *time.Time,
) error {
	result, err := db.sql.ExecContext(ctx, `
UPDATE schedules SET last_run_at = ?, next_run_at = ?, updated_at = ?
WHERE id = ? AND next_run_at = ?`,
		formatNullableTime(last), formatNullableTime(next), formatTime(time.Now()), scheduleID,
		formatTime(expectedNext))
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		var exists int
		if err := db.sql.QueryRowContext(ctx, "SELECT COUNT(*) FROM schedules WHERE id = ?", scheduleID).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			return sql.ErrNoRows
		}
		// Another scheduler tick advanced this cursor after the caller listed
		// due schedules. Treat that as completed progress and never move it back.
		return nil
	}
	return nil
}
