package store

import "context"

// ApplicationIdle reports whether background runtime verification can use the
// live App Server/browser without competing with product work. Interrupted and
// uncertain runs are intentionally not active computation, while queued work,
// approval waits, graph builds, extraction, and engineering jobs all block an
// update probe.
func (db *DB) ApplicationIdle(ctx context.Context) (bool, error) {
	var busy int
	err := db.sql.QueryRowContext(ctx, `
SELECT
  EXISTS(SELECT 1 FROM runs
         WHERE status IN ('queued','planning','collecting','synthesizing','reviewing','revising','waiting_approval'))
  OR EXISTS(SELECT 1 FROM engineering_jobs WHERE status = 'running')
  OR EXISTS(SELECT 1 FROM knowledge_generations WHERE state IN ('building','validating'))
  OR EXISTS(SELECT 1 FROM knowledge_extraction_batches
            WHERE status IN ('queued','extracting','reviewing','validated'))
  OR EXISTS(SELECT 1 FROM conversation_sessions
            WHERE status = 'provisioning' AND deleted_at IS NULL)
  OR EXISTS(SELECT 1 FROM approvals WHERE status = 'pending')`).Scan(&busy)
	if err != nil {
		return false, err
	}
	return busy == 0, nil
}
