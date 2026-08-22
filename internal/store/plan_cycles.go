package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/id"
)

var (
	ErrPlanCycleNotActive  = errors.New("conversation plan cycle is not active")
	ErrPlanCycleNotReady   = errors.New("conversation plan cycle is not ready")
	ErrPlanCycleSuperseded = errors.New("conversation plan cycle is not the latest cycle")
)

const planCycleSelect = `
SELECT id,conversation_session_id,objective,status,final_plan,COALESCE(run_id,''),
       created_at,updated_at,ready_at,consumed_at,superseded_at
FROM conversation_plan_cycles`

func (db *DB) BeginConversationPlanCycle(ctx context.Context, sessionID, objective string) (core.ConversationPlanCycle, error) {
	objective = strings.TrimSpace(objective)
	if objective == "" || !utf8.ValidString(objective) || strings.ContainsRune(objective, utf8.RuneError) || len(objective) > 64*1024 {
		return core.ConversationPlanCycle{}, errors.New("plan objective must be non-empty valid UTF-8 no larger than 64KB")
	}
	cycleID, err := id.New("pln")
	if err != nil {
		return core.ConversationPlanCycle{}, err
	}
	now := time.Now().UTC()
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.ConversationPlanCycle{}, err
	}
	defer tx.Rollback()
	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM conversation_sessions WHERE id=? AND deleted_at IS NULL`, sessionID).Scan(&exists); err != nil {
		return core.ConversationPlanCycle{}, err
	}
	if exists != 1 {
		return core.ConversationPlanCycle{}, sql.ErrNoRows
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE conversation_plan_cycles
SET status='superseded',updated_at=?,superseded_at=?
WHERE conversation_session_id=? AND status IN ('active','ready')`,
		formatTime(now), formatTime(now), sessionID); err != nil {
		return core.ConversationPlanCycle{}, err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO conversation_plan_cycles(
 id,conversation_session_id,objective,status,final_plan,run_id,
 created_at,updated_at,ready_at,consumed_at,superseded_at
) VALUES(?,?,?,'active','',NULL,?,?,NULL,NULL,NULL)`,
		cycleID, sessionID, objective, formatTime(now), formatTime(now)); err != nil {
		return core.ConversationPlanCycle{}, err
	}
	if err := tx.Commit(); err != nil {
		return core.ConversationPlanCycle{}, err
	}
	return db.ConversationPlanCycle(ctx, sessionID, cycleID)
}

func (db *DB) ConversationPlanCycle(ctx context.Context, sessionID, cycleID string) (core.ConversationPlanCycle, error) {
	return scanConversationPlanCycle(db.sql.QueryRowContext(ctx,
		planCycleSelect+" WHERE conversation_session_id=? AND id=?", sessionID, cycleID))
}

func (db *DB) LatestConversationPlanCycle(ctx context.Context, sessionID string) (core.ConversationPlanCycle, error) {
	return scanConversationPlanCycle(db.sql.QueryRowContext(ctx,
		planCycleSelect+" WHERE conversation_session_id=? ORDER BY created_at DESC,id DESC LIMIT 1", sessionID))
}

func (db *DB) RequireActiveConversationPlanCycle(ctx context.Context, sessionID, cycleID string) (core.ConversationPlanCycle, error) {
	cycle, err := db.ConversationPlanCycle(ctx, sessionID, cycleID)
	if err != nil {
		return core.ConversationPlanCycle{}, err
	}
	if cycle.Status != "active" {
		return core.ConversationPlanCycle{}, ErrPlanCycleNotActive
	}
	latest, err := db.LatestConversationPlanCycle(ctx, sessionID)
	if err != nil {
		return core.ConversationPlanCycle{}, err
	}
	if latest.ID != cycle.ID {
		return core.ConversationPlanCycle{}, ErrPlanCycleSuperseded
	}
	return cycle, nil
}

func (db *DB) CompleteConversationPlanCycle(ctx context.Context, sessionID, cycleID, finalPlan string) (core.ConversationPlanCycle, error) {
	finalPlan = strings.TrimSpace(finalPlan)
	if finalPlan == "" || !utf8.ValidString(finalPlan) || strings.ContainsRune(finalPlan, utf8.RuneError) || len(finalPlan) > 512*1024 {
		return core.ConversationPlanCycle{}, errors.New("final plan must be valid non-empty UTF-8 no larger than 512KB")
	}
	now := time.Now().UTC()
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.ConversationPlanCycle{}, err
	}
	defer tx.Rollback()
	cycle, err := scanConversationPlanCycle(tx.QueryRowContext(ctx,
		planCycleSelect+" WHERE conversation_session_id=? AND id=?", sessionID, cycleID))
	if err != nil {
		return core.ConversationPlanCycle{}, err
	}
	if cycle.Status != "active" {
		return core.ConversationPlanCycle{}, ErrPlanCycleNotActive
	}
	var latestID string
	if err := tx.QueryRowContext(ctx, `SELECT id FROM conversation_plan_cycles WHERE conversation_session_id=? ORDER BY created_at DESC,id DESC LIMIT 1`, sessionID).Scan(&latestID); err != nil {
		return core.ConversationPlanCycle{}, err
	}
	if latestID != cycleID {
		return core.ConversationPlanCycle{}, ErrPlanCycleSuperseded
	}
	result, err := tx.ExecContext(ctx, `
UPDATE conversation_plan_cycles
SET status='ready',final_plan=?,updated_at=?,ready_at=?
WHERE conversation_session_id=? AND id=? AND status='active'`,
		finalPlan, formatTime(now), formatTime(now), sessionID, cycleID)
	if err != nil {
		return core.ConversationPlanCycle{}, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		return core.ConversationPlanCycle{}, fmt.Errorf("complete plan cycle: affected=%d err=%v", count, err)
	}
	if err := tx.Commit(); err != nil {
		return core.ConversationPlanCycle{}, err
	}
	return db.ConversationPlanCycle(ctx, sessionID, cycleID)
}

func scanConversationPlanCycle(row scanner) (core.ConversationPlanCycle, error) {
	var cycle core.ConversationPlanCycle
	var created, updated string
	var ready, consumed, superseded sql.NullString
	if err := row.Scan(&cycle.ID, &cycle.ConversationSessionID, &cycle.Objective, &cycle.Status,
		&cycle.FinalPlan, &cycle.RunID, &created, &updated, &ready, &consumed, &superseded); err != nil {
		return core.ConversationPlanCycle{}, err
	}
	var err error
	if cycle.CreatedAt, err = parseTime(created); err != nil {
		return core.ConversationPlanCycle{}, err
	}
	if cycle.UpdatedAt, err = parseTime(updated); err != nil {
		return core.ConversationPlanCycle{}, err
	}
	optionalTimes := []struct {
		source sql.NullString
		target **time.Time
	}{{ready, &cycle.ReadyAt}, {consumed, &cycle.ConsumedAt}, {superseded, &cycle.SupersededAt}}
	for _, optional := range optionalTimes {
		if !optional.source.Valid {
			continue
		}
		parsed, parseErr := parseTime(optional.source.String)
		if parseErr != nil {
			return core.ConversationPlanCycle{}, parseErr
		}
		*optional.target = &parsed
	}
	return cycle, nil
}
