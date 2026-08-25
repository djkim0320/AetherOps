package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
)

type MemoryMaterial struct {
	ProjectID  string `json:"project_id"`
	RunID      string `json:"run_id"`
	ArtifactID string `json:"artifact_id,omitempty"`
	Title      string `json:"title"`
	BlobHash   string `json:"blob_hash"`
	MediaType  string `json:"media_type"`
}

// SuccessfulRunAdoption is a succeeded run whose atomically adopted report
// still needs its memory and knowledge projections recovered. Rows are ordered
// by project and run creation time so callers can preserve project FIFO.
type SuccessfulRunAdoption struct {
	RunID     string    `json:"run_id"`
	ProjectID string    `json:"project_id"`
	CreatedAt time.Time `json:"created_at"`
}

// AppliedRunKnowledge identifies durable report-patch history. Only applied
// batches in immutable ready/retired generations qualify. A batch left in a
// building, validating, or failed crash candidate is intentionally ignored.
type AppliedRunKnowledge struct {
	GenerationID            string                   `json:"generation_id"`
	State                   KnowledgeGenerationState `json:"state"`
	Active                  bool                     `json:"active"`
	ArtifactID              string                   `json:"artifact_id"`
	ExtractorContractSHA256 string                   `json:"extractor_contract_sha256"`
	InputSHA256             string                   `json:"input_sha256"`
	OutputSHA256            string                   `json:"output_sha256"`
	PatchBlobHash           string                   `json:"patch_blob_hash"`
}

func (db *DB) AdoptedMemoryMaterials(ctx context.Context, runID string) ([]MemoryMaterial, error) {
	rows, err := db.sql.QueryContext(ctx, `
SELECT r.project_id, r.id, a.id, 'Research report', a.blob_hash, b.media_type
FROM runs r
JOIN artifacts a ON a.id = r.report_artifact_id AND a.adopted = 1
JOIN blobs b ON b.hash = a.blob_hash
WHERE r.id = ? AND r.status = 'succeeded'
UNION ALL
SELECT r.project_id, r.id, '', e.title, e.blob_hash, b.media_type
FROM runs r
JOIN evidence e ON e.run_id = r.id AND e.adopted = 1
JOIN blobs b ON b.hash = e.blob_hash
WHERE r.id = ? AND r.status = 'succeeded'
ORDER BY 3 DESC, 4`, runID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var materials []MemoryMaterial
	for rows.Next() {
		var material MemoryMaterial
		if err := rows.Scan(&material.ProjectID, &material.RunID, &material.ArtifactID,
			&material.Title, &material.BlobHash, &material.MediaType); err != nil {
			return nil, err
		}
		materials = append(materials, material)
	}
	return materials, rows.Err()
}

func (db *DB) SucceededRuns(ctx context.Context) ([]string, error) {
	rows, err := db.sql.QueryContext(ctx, "SELECT id FROM runs WHERE status = 'succeeded' ORDER BY created_at")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var runIDs []string
	for rows.Next() {
		var runID string
		if err := rows.Scan(&runID); err != nil {
			return nil, err
		}
		runIDs = append(runIDs, runID)
	}
	return runIDs, rows.Err()
}

// PendingSucceededRunAdoptions returns only successful, adopted reports that
// have no durable applied patch in a ready/retired generation. It also returns
// a ready-but-not-activated crash candidate while the project head is stale,
// allowing startup recovery to finish the already validated atomic swap.
func (db *DB) PendingSucceededRunAdoptions(ctx context.Context) ([]SuccessfulRunAdoption, error) {
	rows, err := db.sql.QueryContext(ctx, `
SELECT r.id,r.project_id,r.created_at
FROM runs r
JOIN artifacts a
  ON a.id=r.report_artifact_id AND a.run_id=r.id AND a.adopted=1
 AND a.kind IN ('research.report','research.report.revision')
JOIN project_knowledge_heads h ON h.project_id=r.project_id
WHERE r.status='succeeded'
  AND (
    NOT EXISTS (
      SELECT 1
      FROM knowledge_extraction_batches b
      JOIN knowledge_generations g
        ON g.project_id=b.project_id AND g.id=b.generation_id
      WHERE b.project_id=r.project_id AND b.run_id=r.id
        AND b.source_kind='report' AND b.status='applied'
        AND g.state IN ('ready','retired')
    )
    OR (
      h.status<>'ready'
      AND EXISTS (
        SELECT 1
        FROM knowledge_extraction_batches b
        JOIN knowledge_generations g
          ON g.project_id=b.project_id AND g.id=b.generation_id
        WHERE b.project_id=r.project_id AND b.run_id=r.id
          AND b.source_kind='report' AND b.status='applied'
          AND g.state='ready' AND b.generation_id<>h.generation_id
      )
    )
  )
ORDER BY r.project_id,r.created_at,r.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var pending []SuccessfulRunAdoption
	for rows.Next() {
		var item SuccessfulRunAdoption
		var created string
		if err := rows.Scan(&item.RunID, &item.ProjectID, &created); err != nil {
			return nil, err
		}
		item.CreatedAt, err = parseTime(created)
		if err != nil {
			return nil, err
		}
		pending = append(pending, item)
	}
	return pending, rows.Err()
}

// AppliedKnowledgeForRun searches the complete immutable generation lineage,
// not only the active generation. Rebuilds copy the projection but deliberately
// do not copy extraction receipts, so lineage history is the idempotency key.
func (db *DB) AppliedKnowledgeForRun(ctx context.Context, projectID, runID string) (AppliedRunKnowledge, error) {
	if projectID == "" || runID == "" {
		return AppliedRunKnowledge{}, errors.New("knowledge project and run are required")
	}
	var applied AppliedRunKnowledge
	var active int
	err := db.sql.QueryRowContext(ctx, `
SELECT b.generation_id,g.state,
       CASE WHEN h.generation_id=b.generation_id THEN 1 ELSE 0 END AS is_active
       ,b.artifact_id,b.extractor_contract_sha256,b.input_sha256,b.output_sha256,b.patch_blob_hash
FROM knowledge_extraction_batches b
JOIN knowledge_generations g
  ON g.project_id=b.project_id AND g.id=b.generation_id
JOIN project_knowledge_heads h ON h.project_id=b.project_id
WHERE b.project_id=? AND b.run_id=?
  AND b.source_kind='report' AND b.status='applied'
  AND g.state IN ('ready','retired')
ORDER BY is_active DESC,
         CASE g.state WHEN 'ready' THEN 0 ELSE 1 END,
         g.created_at DESC,b.created_at DESC,b.id DESC
LIMIT 1`, projectID, runID).Scan(
		&applied.GenerationID, &applied.State, &active,
		&applied.ArtifactID, &applied.ExtractorContractSHA256, &applied.InputSHA256,
		&applied.OutputSHA256, &applied.PatchBlobHash,
	)
	if err != nil {
		return AppliedRunKnowledge{}, err
	}
	applied.Active = active != 0
	return applied, nil
}

// RunKnowledgeSourceCount proves that the materialized generation contains
// at least one deterministic source row emitted for this exact run. A batch
// receipt alone is insufficient because it could otherwise point at an empty
// or unrelated copied projection.
func (db *DB) RunKnowledgeSourceCount(ctx context.Context, projectID, generationID, runID string) (int, error) {
	if projectID == "" || generationID == "" || runID == "" {
		return 0, errors.New("knowledge project, generation, and run are required")
	}
	var count int
	err := db.sql.QueryRowContext(ctx, `
SELECT COUNT(*) FROM knowledge_sources
WHERE project_id=? AND generation_id=?
  AND json_extract(source_locator_json,'$.run_id')=?`, projectID, generationID, runID).Scan(&count)
	return count, err
}

// VerifyKnowledgeGenerationRetention checks that a later ready generation
// still carries every authoritative source, entity, assertion, and provenance
// row from a retired applied generation. Derived inference rows are deliberately
// excluded because they are recomputed against the descendant ontology.
func (db *DB) VerifyKnowledgeGenerationRetention(ctx context.Context, projectID, ancestorID, descendantID string) error {
	if projectID == "" || ancestorID == "" || descendantID == "" || ancestorID == descendantID {
		return errors.New("distinct knowledge ancestor and descendant generations are required")
	}
	type retentionCheck struct {
		name  string
		query string
	}
	checks := []retentionCheck{
		{"source", `SELECT COUNT(*) FROM knowledge_sources a
WHERE a.project_id=? AND a.generation_id=? AND NOT EXISTS(
 SELECT 1 FROM knowledge_sources d WHERE d.project_id=a.project_id AND d.generation_id=?
 AND d.chunk_id=a.chunk_id AND d.blob_hash=a.blob_hash AND d.source_kind=a.source_kind
 AND d.source_locator_json=a.source_locator_json AND d.text_hash=a.text_hash)`},
		{"entity", `SELECT COUNT(*) FROM knowledge_entities a
WHERE a.project_id=? AND a.generation_id=? AND NOT EXISTS(
 SELECT 1 FROM knowledge_entities d WHERE d.project_id=a.project_id AND d.generation_id=?
 AND d.id=a.id AND d.class_key=a.class_key AND d.canonical_name=a.canonical_name
 AND d.normalized_name=a.normalized_name AND d.description=a.description AND d.identity_key=a.identity_key)`},
		{"alias", `SELECT COUNT(*) FROM knowledge_aliases a
WHERE a.project_id=? AND a.generation_id=? AND NOT EXISTS(
 SELECT 1 FROM knowledge_aliases d WHERE d.project_id=a.project_id AND d.generation_id=?
 AND d.entity_id=a.entity_id AND d.normalized_alias=a.normalized_alias
 AND d.alias=a.alias AND d.language=a.language)`},
		{"mention", `SELECT COUNT(*) FROM knowledge_mentions a
WHERE a.project_id=? AND a.generation_id=? AND NOT EXISTS(
 SELECT 1 FROM knowledge_mentions d WHERE d.project_id=a.project_id AND d.generation_id=?
 AND d.id=a.id AND d.entity_id=a.entity_id AND d.chunk_id=a.chunk_id
 AND d.start_byte=a.start_byte AND d.end_byte=a.end_byte AND d.excerpt_sha256=a.excerpt_sha256)`},
		{"assertion evidence", `SELECT COUNT(*) FROM knowledge_assertion_evidence a
WHERE a.project_id=? AND a.generation_id=? AND NOT EXISTS(
 SELECT 1 FROM knowledge_assertion_evidence d WHERE d.project_id=a.project_id AND d.generation_id=?
 AND d.assertion_id=a.assertion_id AND d.evidence_kind=a.evidence_kind AND d.blob_hash=a.blob_hash
 AND d.chunk_id IS a.chunk_id AND d.claim_id=a.claim_id AND d.source_id=a.source_id
 AND d.start_byte IS a.start_byte AND d.end_byte IS a.end_byte
 AND d.locator_json=a.locator_json AND d.evidence_sha256=a.evidence_sha256)`},
	}
	for _, check := range checks {
		var missing int
		if err := db.sql.QueryRowContext(ctx, check.query, projectID, ancestorID, descendantID).Scan(&missing); err != nil {
			return fmt.Errorf("verify retained knowledge %s rows: %w", check.name, err)
		}
		if missing != 0 {
			return fmt.Errorf("descendant generation omits %d %s row(s) from retired applied generation", missing, check.name)
		}
	}
	if err := db.verifyRetainedKnowledgeAssertions(ctx, projectID, ancestorID, descendantID); err != nil {
		return err
	}
	return nil
}

func (db *DB) verifyRetainedKnowledgeAssertions(ctx context.Context, projectID, ancestorID, descendantID string) error {
	type retainedAssertion struct {
		id, subject, predicate, literal, qualifiers, polarity string
		validFrom, validTo, status                            string
		object                                                sql.NullString
		confidence                                            float64
	}
	rows, err := db.sql.QueryContext(ctx, `
SELECT id,subject_entity_id,predicate_key,object_entity_id,literal_json,qualifiers_json,polarity,
       COALESCE(valid_from,''),COALESCE(valid_to,''),status,confidence
FROM knowledge_assertions WHERE project_id=? AND generation_id=? ORDER BY id`, projectID, ancestorID)
	if err != nil {
		return err
	}
	var ancestors []retainedAssertion
	for rows.Next() {
		var ancestor retainedAssertion
		if err := rows.Scan(&ancestor.id, &ancestor.subject, &ancestor.predicate, &ancestor.object,
			&ancestor.literal, &ancestor.qualifiers, &ancestor.polarity, &ancestor.validFrom,
			&ancestor.validTo, &ancestor.status, &ancestor.confidence); err != nil {
			rows.Close()
			return err
		}
		ancestors = append(ancestors, ancestor)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	missing := 0
	for _, ancestor := range ancestors {
		var descendant retainedAssertion
		err := db.sql.QueryRowContext(ctx, `
SELECT id,subject_entity_id,predicate_key,object_entity_id,literal_json,qualifiers_json,polarity,
       COALESCE(valid_from,''),COALESCE(valid_to,''),status,confidence
FROM knowledge_assertions WHERE project_id=? AND generation_id=? AND id=?`,
			projectID, descendantID, ancestor.id).Scan(&descendant.id, &descendant.subject,
			&descendant.predicate, &descendant.object, &descendant.literal, &descendant.qualifiers,
			&descendant.polarity, &descendant.validFrom, &descendant.validTo, &descendant.status,
			&descendant.confidence)
		if errors.Is(err, sql.ErrNoRows) {
			missing++
			continue
		}
		if err != nil {
			return err
		}
		timesEqual, err := retainedKnowledgeIntervalsEqual(
			ancestor.validFrom, ancestor.validTo, descendant.validFrom, descendant.validTo,
		)
		if err != nil {
			return fmt.Errorf("verify retained knowledge assertion %s validity: %w", ancestor.id, err)
		}
		if ancestor.subject != descendant.subject || ancestor.predicate != descendant.predicate ||
			ancestor.object.Valid != descendant.object.Valid || ancestor.object.String != descendant.object.String ||
			ancestor.literal != descendant.literal || ancestor.qualifiers != descendant.qualifiers ||
			ancestor.polarity != descendant.polarity || ancestor.status != descendant.status ||
			ancestor.confidence != descendant.confidence || !timesEqual {
			missing++
		}
	}
	if missing != 0 {
		return fmt.Errorf("descendant generation omits %d assertion row(s) from retired applied generation", missing)
	}
	return nil
}

func retainedKnowledgeIntervalsEqual(leftFrom, leftTo, rightFrom, rightTo string) (bool, error) {
	equal := func(left, right string) (bool, error) {
		leftTime, err := core.ParseKnowledgeTimeBoundary(left)
		if err != nil {
			return false, err
		}
		rightTime, err := core.ParseKnowledgeTimeBoundary(right)
		if err != nil {
			return false, err
		}
		if leftTime == nil || rightTime == nil {
			return leftTime == nil && rightTime == nil, nil
		}
		return leftTime.Equal(*rightTime), nil
	}
	fromEqual, err := equal(leftFrom, rightFrom)
	if err != nil || !fromEqual {
		return false, err
	}
	return equal(leftTo, rightTo)
}

// FailIncompleteRunKnowledgeCandidates quarantines crash candidates that have
// an applied receipt but never reached an immutable usable generation. Their
// receipts remain auditable but must never suppress a clean recovery attempt.
func (db *DB) FailIncompleteRunKnowledgeCandidates(ctx context.Context, projectID, runID, reason string) (int, error) {
	if projectID == "" || runID == "" || reason == "" {
		return 0, errors.New("knowledge project, run, and failure reason are required")
	}
	rows, err := db.sql.QueryContext(ctx, `
SELECT DISTINCT g.id,g.state
FROM knowledge_extraction_batches b
JOIN knowledge_generations g
  ON g.project_id=b.project_id AND g.id=b.generation_id
WHERE b.project_id=? AND b.run_id=?
  AND b.source_kind='report' AND b.status='applied'
  AND g.state IN ('building','validating')
ORDER BY g.created_at,g.id`, projectID, runID)
	if err != nil {
		return 0, err
	}
	type candidate struct {
		id    string
		state KnowledgeGenerationState
	}
	var candidates []candidate
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.id, &item.state); err != nil {
			rows.Close()
			return 0, err
		}
		candidates = append(candidates, item)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	failed := 0
	for _, item := range candidates {
		if _, err := db.TransitionKnowledgeGeneration(ctx, projectID, item.id, item.state, KnowledgeFailed, reason); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			return failed, fmt.Errorf("fail incomplete generation %s: %w", item.id, err)
		}
		failed++
	}
	return failed, nil
}

func (db *DB) MemoryDocumentExists(ctx context.Context, projectID, artifactID, blobHash string) (bool, error) {
	if projectID == "" || blobHash == "" {
		return false, errors.New("project and blob hash are required")
	}
	var count int
	err := db.sql.QueryRowContext(ctx, `
SELECT COUNT(*) FROM documents
WHERE project_id = ? AND blob_hash = ? AND COALESCE(artifact_id, '') = ? AND status = 'ready'`,
		projectID, blobHash, artifactID).Scan(&count)
	return count > 0, err
}
