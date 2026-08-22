package store

import (
	"context"
	"errors"
)

// DeleteBuildingKnowledgeGeneration removes only the exact disposable
// generation created by a caller-owned validation contract. Ready, failed,
// validating, active, or differently contracted generations are immutable.
func (db *DB) DeleteBuildingKnowledgeGeneration(ctx context.Context, projectID, generationID, contractSHA256 string) error {
	if projectID == "" || generationID == "" || !validSHA256(contractSHA256) {
		return errors.New("project, generation, and validation contract SHA-256 are required")
	}
	result, err := db.sql.ExecContext(ctx, `DELETE FROM knowledge_generations
WHERE project_id=? AND id=? AND state='building' AND contract_sha256=?
  AND NOT EXISTS(
    SELECT 1 FROM project_knowledge_heads h
    WHERE h.project_id=knowledge_generations.project_id AND h.generation_id=knowledge_generations.id
  )`, projectID, generationID, contractSHA256)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return errors.New("disposable building knowledge generation was not deleted")
	}
	return nil
}

// DeleteBuildingKnowledgeGenerationsByContract is startup crash recovery for
// local validation-only candidates. It never touches product materialization
// contracts or any generation that progressed beyond building.
func (db *DB) DeleteBuildingKnowledgeGenerationsByContract(ctx context.Context, contractSHA256 string) (int64, error) {
	if !validSHA256(contractSHA256) {
		return 0, errors.New("validation contract SHA-256 is required")
	}
	result, err := db.sql.ExecContext(ctx, `DELETE FROM knowledge_generations
WHERE state='building' AND contract_sha256=?
  AND NOT EXISTS(
    SELECT 1 FROM project_knowledge_heads h
    WHERE h.project_id=knowledge_generations.project_id AND h.generation_id=knowledge_generations.id
  )`, contractSHA256)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}
