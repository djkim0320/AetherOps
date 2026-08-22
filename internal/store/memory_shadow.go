package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrShadowBuildInProgress = errors.New("a shadow index is already building for this project")
var ErrMemoryRunInProgress = errors.New("memory reindexing is blocked by active or recoverable research")
var ErrMemoryReindexInProgress = errors.New("research is blocked while memory reindexing is in progress")
var ErrMemoryMutationBlocked = errors.New("memory mutation is blocked by active or recoverable research or shadow reindexing")

type ShadowRecoveryResult struct {
	Activated int `json:"activated"`
	Failed    int `json:"failed"`
}

// FailShadowIndex records a terminal shadow-build failure without modifying
// the currently active index. A completed or active index cannot be rewritten.
func (db *DB) FailShadowIndex(ctx context.Context, indexID, reason string) error {
	if strings.TrimSpace(indexID) == "" || strings.TrimSpace(reason) == "" {
		return errors.New("shadow index id and failure reason are required")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	var projectID string
	if err := transaction.QueryRowContext(ctx,
		"SELECT project_id FROM embedding_indexes WHERE id = ? AND state = 'building'", indexID,
	).Scan(&projectID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("shadow index is not in building state")
		}
		return err
	}
	now := time.Now().UTC()
	result, err := transaction.ExecContext(ctx, `
UPDATE embedding_indexes
SET state = 'failed', error = ?, completed_at = ?
WHERE id = ? AND state = 'building'`, reason, formatTime(now), indexID)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return errors.New("shadow index is not in building state")
	}
	headResult, err := transaction.ExecContext(ctx, `
UPDATE project_memory_heads
SET shadow_index_id = NULL, state = 'failed', error = ?, updated_at = ?
WHERE project_id = ? AND shadow_index_id = ?`, reason, formatTime(now), projectID, indexID)
	if err != nil {
		return err
	}
	if changed, err := headResult.RowsAffected(); err != nil || changed != 1 {
		if err == nil {
			err = errors.New("memory head does not own the failed shadow index")
		}
		return err
	}
	return transaction.Commit()
}

// RecoverShadowIndexes resolves every durable build without issuing another
// embedding request. Complete, checksum-valid builds are atomically activated;
// incomplete or corrupt builds are failed while the previous active index is
// preserved.
func (db *DB) RecoverShadowIndexes(ctx context.Context) (ShadowRecoveryResult, error) {
	rows, err := db.sql.QueryContext(ctx, `
SELECT id FROM embedding_indexes WHERE state = 'building' ORDER BY project_id, created_at, id`)
	if err != nil {
		return ShadowRecoveryResult{}, err
	}
	var indexIDs []string
	for rows.Next() {
		var indexID string
		if err := rows.Scan(&indexID); err != nil {
			rows.Close()
			return ShadowRecoveryResult{}, err
		}
		indexIDs = append(indexIDs, indexID)
	}
	if err := rows.Close(); err != nil {
		return ShadowRecoveryResult{}, err
	}
	if err := rows.Err(); err != nil {
		return ShadowRecoveryResult{}, err
	}
	result := ShadowRecoveryResult{}
	for _, indexID := range indexIDs {
		var blockingRuns int
		if err := db.sql.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM runs r JOIN embedding_indexes i ON i.project_id = r.project_id
WHERE i.id = ? AND r.status IN (
  'queued','planning','collecting','synthesizing','reviewing','revising',
  'waiting_approval','interrupted','uncertain'
)`, indexID).Scan(&blockingRuns); err != nil {
			return result, err
		}
		if blockingRuns != 0 {
			reason := "startup recovery rejected shadow index because research is active or recoverable"
			if err := db.FailShadowIndex(ctx, indexID, reason); err != nil {
				return result, err
			}
			result.Failed++
			continue
		}
		if _, activateErr := db.ActivateShadowIndex(ctx, indexID); activateErr == nil {
			result.Activated++
			continue
		} else {
			reason := "startup recovery rejected interrupted shadow index: " + activateErr.Error()
			if failErr := db.FailShadowIndex(ctx, indexID, reason); failErr != nil {
				return result, errors.Join(activateErr, fmt.Errorf("fail interrupted shadow index %s: %w", indexID, failErr))
			}
			result.Failed++
		}
	}
	return result, nil
}

func (db *DB) ProjectMemoryStatus(ctx context.Context, projectID string) (ProjectMemoryHead, error) {
	if strings.TrimSpace(projectID) == "" {
		return ProjectMemoryHead{}, errors.New("project id is required")
	}
	var head ProjectMemoryHead
	var activeID, shadowID sql.NullString
	var updated string
	if err := db.sql.QueryRowContext(ctx, `
SELECT project_id, active_index_id, shadow_index_id, memory_revision, state, error, updated_at
FROM project_memory_heads WHERE project_id = ?`, projectID).Scan(
		&head.ProjectID, &activeID, &shadowID, &head.MemoryRevision, &head.State, &head.Error, &updated,
	); err != nil {
		return ProjectMemoryHead{}, err
	}
	head.ActiveIndexID = activeID.String
	head.ShadowIndexID = shadowID.String
	parsed, err := parseTime(updated)
	if err != nil {
		return ProjectMemoryHead{}, err
	}
	head.UpdatedAt = parsed
	if activeID.Valid {
		index, err := db.embeddingIndex(ctx, activeID.String)
		if err != nil {
			return ProjectMemoryHead{}, err
		}
		head.ActiveIndex = &index
	}
	if shadowID.Valid {
		index, err := db.embeddingIndex(ctx, shadowID.String)
		if err != nil {
			return ProjectMemoryHead{}, err
		}
		head.ShadowIndex = &index
	}
	return head, nil
}

func (db *DB) embeddingIndex(ctx context.Context, indexID string) (EmbeddingIndex, error) {
	return scanEmbeddingIndex(db.sql.QueryRowContext(ctx, `
SELECT id, project_id, model, dimensions, state, error, created_at, completed_at
FROM embedding_indexes WHERE id = ?`, indexID))
}

func recordActiveMemoryMutation(
	ctx context.Context,
	transaction *sql.Tx,
	projectID, activeIndexID string,
	now time.Time,
) error {
	result, err := transaction.ExecContext(ctx, `
UPDATE project_memory_heads
SET active_index_id = ?, memory_revision = memory_revision + 1,
    state = CASE WHEN state IN ('reindexing', 'failed') THEN state ELSE 'ready' END,
    shadow_index_id = CASE WHEN state = 'reindexing' THEN shadow_index_id ELSE NULL END,
    error = CASE WHEN state IN ('reindexing', 'failed') THEN error ELSE '' END,
    updated_at = ?
WHERE project_id = ?`, activeIndexID, formatTime(now), projectID)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return sql.ErrNoRows
	}
	return nil
}

func recordProjectMemoryMutation(ctx context.Context, transaction *sql.Tx, projectID string, now time.Time) error {
	var activeIndexID string
	if err := transaction.QueryRowContext(ctx, `
SELECT id FROM embedding_indexes WHERE project_id = ? AND state = 'active'`, projectID).Scan(&activeIndexID); err != nil {
		return err
	}
	return recordActiveMemoryMutation(ctx, transaction, projectID, activeIndexID, now)
}

func rejectMemoryReindexWithActiveRun(ctx context.Context, transaction *sql.Tx, projectID string) error {
	var blocking int
	if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM runs
WHERE project_id = ? AND status IN (
  'queued','planning','collecting','synthesizing','reviewing','revising',
  'waiting_approval','interrupted','uncertain'
)`, projectID).Scan(&blocking); err != nil {
		return err
	}
	if blocking != 0 {
		return ErrMemoryRunInProgress
	}
	return nil
}

func rejectRunWithMemoryReindex(ctx context.Context, transaction *sql.Tx, projectID string) error {
	var building int
	if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM embedding_indexes WHERE project_id = ? AND state = 'building'`, projectID).Scan(&building); err != nil {
		return err
	}
	if building != 0 {
		return ErrMemoryReindexInProgress
	}
	return nil
}

func rejectMemoryMutationWithProjectWork(ctx context.Context, transaction *sql.Tx, projectID string) error {
	var blocking int
	if err := transaction.QueryRowContext(ctx, `
SELECT
  (SELECT COUNT(*) FROM runs
   WHERE project_id = ? AND status IN (
     'queued','planning','collecting','synthesizing','reviewing','revising',
     'waiting_approval','interrupted','uncertain'
   )) +
  (SELECT COUNT(*) FROM embedding_indexes
   WHERE project_id = ? AND state = 'building')`, projectID, projectID).Scan(&blocking); err != nil {
		return err
	}
	if blocking != 0 {
		return ErrMemoryMutationBlocked
	}
	return nil
}

// ValidateMemoryMutationAllowed is an early fail-closed preflight for callers
// that would otherwise perform CAS or embeddings work. Mutation methods repeat
// the same check inside their write transaction to close the race.
func (db *DB) ValidateMemoryMutationAllowed(ctx context.Context, projectID string) error {
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	if err := rejectMemoryMutationWithProjectWork(ctx, transaction, projectID); err != nil {
		return err
	}
	return transaction.Commit()
}
