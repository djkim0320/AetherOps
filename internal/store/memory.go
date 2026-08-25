package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/id"
	"github.com/djkim0320/AetherOps/internal/rag"
)

const (
	memoryCandidateLimit = 50
	memoryResultLimit    = 12
)

type MemoryResult struct {
	ChunkID    string  `json:"chunk_id"`
	DocumentID string  `json:"document_id"`
	ArtifactID string  `json:"artifact_id,omitempty"`
	Title      string  `json:"title"`
	Text       string  `json:"text"`
	Score      float64 `json:"score"`
}

// RegisterBlob records a CAS receipt after the caller has completed verified CAS
// readback. A hash may be reused only when its immutable metadata is identical.
func (db *DB) RegisterBlob(ctx context.Context, receipt cas.Receipt, mediaType string) error {
	if receipt.Hash == "" || receipt.Size < 0 || mediaType == "" {
		return errors.New("invalid blob metadata")
	}
	now := time.Now().UTC()
	_, err := db.sql.ExecContext(ctx, `
INSERT INTO blobs(hash, size, media_type, created_at)
VALUES(?, ?, ?, ?)
ON CONFLICT(hash) DO NOTHING`,
		receipt.Hash, receipt.Size, mediaType, formatTime(now))
	if err != nil {
		return err
	}
	var size int64
	var storedMediaType string
	if err := db.sql.QueryRowContext(ctx,
		"SELECT size, media_type FROM blobs WHERE hash = ?", receipt.Hash,
	).Scan(&size, &storedMediaType); err != nil {
		return err
	}
	if size != receipt.Size || storedMediaType != mediaType {
		return errors.New("blob metadata conflicts with existing CAS object")
	}
	return nil
}

type BlobRegistryReconcileResult struct {
	Reachable               map[string]struct{}
	UnreferencedRowsRemoved int
}

// ReconcileBlobRegistry removes registry rows which no adopted object can
// reach and returns the authoritative CAS reachability set. The primary
// application calls it once at startup, before any CAS writers begin.
func (db *DB) ReconcileBlobRegistry(ctx context.Context) (BlobRegistryReconcileResult, error) {
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return BlobRegistryReconcileResult{}, err
	}
	defer transaction.Rollback()
	rows, err := transaction.QueryContext(ctx, `
SELECT DISTINCT hash FROM (
  SELECT blob_hash AS hash FROM artifacts
  UNION ALL SELECT blob_hash FROM evidence
  UNION ALL SELECT input_artifact_hash FROM stage_attempts WHERE input_artifact_hash <> ''
  UNION ALL SELECT output_artifact_hash FROM stage_attempts WHERE output_artifact_hash <> ''
  UNION ALL SELECT blob_hash FROM documents
  UNION ALL SELECT blob_hash FROM downloads
  UNION ALL SELECT source_blob_hash FROM ontology_versions WHERE source_blob_hash IS NOT NULL
  UNION ALL SELECT canonical_blob_hash FROM ontology_versions WHERE canonical_blob_hash IS NOT NULL
  UNION ALL SELECT patch_blob_hash FROM knowledge_extraction_batches WHERE patch_blob_hash IS NOT NULL
  UNION ALL SELECT blob_hash FROM knowledge_sources
  UNION ALL SELECT blob_hash FROM knowledge_assertion_evidence
  UNION ALL SELECT blob_hash FROM knowledge_rdf_snapshots
  UNION ALL SELECT payload_blob_hash FROM portable_tool_installations WHERE payload_blob_hash IS NOT NULL
  UNION ALL SELECT probe_output_blob_hash FROM portable_tool_installations WHERE probe_output_blob_hash IS NOT NULL
  UNION ALL SELECT stdout_blob_hash FROM tool_invocations WHERE stdout_blob_hash IS NOT NULL
  UNION ALL SELECT stderr_blob_hash FROM tool_invocations WHERE stderr_blob_hash IS NOT NULL
  UNION ALL SELECT json_extract(payload_json,'$.memo_blob_hash')
    FROM knowledge_curation_events
    WHERE json_type(payload_json,'$.memo_blob_hash')='text'
) ORDER BY hash`)
	if err != nil {
		return BlobRegistryReconcileResult{}, err
	}
	reachable := map[string]struct{}{}
	for rows.Next() {
		var hash string
		if err := rows.Scan(&hash); err != nil {
			rows.Close()
			return BlobRegistryReconcileResult{}, err
		}
		reachable[hash] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return BlobRegistryReconcileResult{}, err
	}
	if err := rows.Close(); err != nil {
		return BlobRegistryReconcileResult{}, err
	}
	registryRows, err := transaction.QueryContext(ctx, "SELECT hash FROM blobs ORDER BY hash")
	if err != nil {
		return BlobRegistryReconcileResult{}, err
	}
	var unreferenced []string
	for registryRows.Next() {
		var hash string
		if err := registryRows.Scan(&hash); err != nil {
			registryRows.Close()
			return BlobRegistryReconcileResult{}, err
		}
		if _, ok := reachable[hash]; !ok {
			unreferenced = append(unreferenced, hash)
		}
	}
	if err := registryRows.Err(); err != nil {
		registryRows.Close()
		return BlobRegistryReconcileResult{}, err
	}
	if err := registryRows.Close(); err != nil {
		return BlobRegistryReconcileResult{}, err
	}
	for _, hash := range unreferenced {
		if _, err := transaction.ExecContext(ctx, "DELETE FROM blobs WHERE hash=?", hash); err != nil {
			return BlobRegistryReconcileResult{}, err
		}
	}
	if err := transaction.Commit(); err != nil {
		return BlobRegistryReconcileResult{}, err
	}
	return BlobRegistryReconcileResult{
		Reachable: reachable, UnreferencedRowsRemoved: len(unreferenced),
	}, nil
}

// IndexDocument atomically adopts and indexes a verified document. Non-artifact
// material must be explicitly pinned; artifact material must belong to a
// successful run unless the user explicitly pinned it.
func (db *DB) IndexDocument(
	ctx context.Context,
	document Document,
	chunks []rag.Chunk,
	vectors [][]float32,
) (Document, error) {
	if document.ProjectID == "" || document.Title == "" || document.BlobHash == "" {
		return Document{}, errors.New("document project, title, and blob hash are required")
	}
	if document.EmbeddingModel == "" {
		return Document{}, errors.New("embedding model is required")
	}
	if document.EmbeddingDimensions != rag.EmbeddingDimensions {
		return Document{}, errors.New("document embedding dimensions are not supported")
	}
	if len(chunks) == 0 || len(chunks) != len(vectors) {
		return Document{}, errors.New("each document chunk requires one embedding")
	}
	encoded := make([][]byte, len(vectors))
	vectorHashes := make([]string, len(vectors))
	for index, vector := range vectors {
		data, err := rag.EncodeVector(vector)
		if err != nil {
			return Document{}, fmt.Errorf("encode embedding %d: %w", index, err)
		}
		encoded[index] = data
		sum := sha256.Sum256(data)
		vectorHashes[index] = hex.EncodeToString(sum[:])
	}
	if document.ID == "" {
		generated, err := id.New("doc")
		if err != nil {
			return Document{}, err
		}
		document.ID = generated
	}
	now := time.Now().UTC()
	document.Status = "indexing"
	document.CreatedAt = now
	document.UpdatedAt = now

	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return Document{}, err
	}
	defer transaction.Rollback()
	if err := rejectMemoryMutationWithProjectWork(ctx, transaction, document.ProjectID); err != nil {
		return Document{}, err
	}
	if err := validateAdoption(ctx, transaction, document); err != nil {
		return Document{}, err
	}
	indexID, err := ensureActiveEmbeddingIndex(ctx, transaction, document.ProjectID,
		document.EmbeddingModel, document.EmbeddingDimensions, now)
	if err != nil {
		return Document{}, err
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO documents(
  id, project_id, artifact_id, title, blob_hash, status,
  embedding_model, embedding_dimensions, pinned, created_at, updated_at
) VALUES(?, ?, NULLIF(?, ''), ?, ?, 'indexing', ?, ?, ?, ?, ?)`,
		document.ID, document.ProjectID, document.ArtifactID, document.Title,
		document.BlobHash, document.EmbeddingModel, document.EmbeddingDimensions,
		document.Pinned, formatTime(now), formatTime(now)); err != nil {
		return Document{}, err
	}
	for index, chunk := range chunks {
		chunkID, err := id.New("chk")
		if err != nil {
			return Document{}, err
		}
		textSum := sha256.Sum256([]byte(chunk.Text))
		if _, err := transaction.ExecContext(ctx, `
INSERT INTO chunks(id, document_id, ordinal, text, text_hash)
VALUES(?, ?, ?, ?, ?)`, chunkID, document.ID, chunk.Ordinal, chunk.Text,
			hex.EncodeToString(textSum[:])); err != nil {
			return Document{}, err
		}
		if _, err := transaction.ExecContext(ctx, `
INSERT INTO embeddings(chunk_id, index_id, model, dimensions, vector, vector_hash, created_at)
VALUES(?, ?, ?, ?, ?, ?, ?)`, chunkID, indexID, document.EmbeddingModel,
			document.EmbeddingDimensions, encoded[index], vectorHashes[index], formatTime(now)); err != nil {
			return Document{}, err
		}
	}
	if _, err := transaction.ExecContext(ctx,
		"UPDATE documents SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'indexing'",
		formatTime(now), document.ID); err != nil {
		return Document{}, err
	}
	if err := recordActiveMemoryMutation(ctx, transaction, document.ProjectID, indexID, now); err != nil {
		return Document{}, err
	}
	if err := transaction.Commit(); err != nil {
		return Document{}, err
	}
	document.Status = "ready"
	return document, nil
}

func ensureActiveEmbeddingIndex(
	ctx context.Context,
	transaction *sql.Tx,
	projectID, model string,
	dimensions int,
	now time.Time,
) (string, error) {
	var indexID, currentModel string
	var currentDimensions int
	err := transaction.QueryRowContext(ctx, `
SELECT id, model, dimensions FROM embedding_indexes
WHERE project_id = ? AND state = 'active'`, projectID).Scan(
		&indexID, &currentModel, &currentDimensions)
	if err == nil {
		if currentModel != model || currentDimensions != dimensions {
			return "", errors.New("embedding contract differs from the active index; build a shadow index first")
		}
		return indexID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	indexID, err = id.New("idx")
	if err != nil {
		return "", err
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO embedding_indexes(id, project_id, model, dimensions, state, created_at, completed_at)
VALUES(?, ?, ?, ?, 'active', ?, ?)`, indexID, projectID, model, dimensions,
		formatTime(now), formatTime(now)); err != nil {
		return "", err
	}
	return indexID, nil
}

func validateAdoption(ctx context.Context, transaction *sql.Tx, document Document) error {
	var blobExists int
	if err := transaction.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM blobs WHERE hash = ?", document.BlobHash,
	).Scan(&blobExists); err != nil {
		return err
	}
	if blobExists != 1 {
		return errors.New("document blob is not registered")
	}
	if document.ArtifactID == "" {
		if document.Pinned {
			return nil
		}
		var adoptedEvidence int
		if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM evidence e
JOIN runs r ON r.id = e.run_id
WHERE r.project_id = ? AND r.status = 'succeeded' AND e.adopted = 1 AND e.blob_hash = ?`,
			document.ProjectID, document.BlobHash).Scan(&adoptedEvidence); err != nil {
			return err
		}
		if adoptedEvidence == 0 {
			return errors.New("non-artifact material must be successful adopted evidence or explicitly pinned")
		}
		return nil
	}
	var projectID, blobHash string
	var status core.RunStatus
	if err := transaction.QueryRowContext(ctx, `
SELECT r.project_id, r.status, a.blob_hash
FROM artifacts a
JOIN runs r ON r.id = a.run_id
WHERE a.id = ?`, document.ArtifactID).Scan(&projectID, &status, &blobHash); err != nil {
		return err
	}
	if projectID != document.ProjectID || blobHash != document.BlobHash {
		return errors.New("artifact does not match the document project or blob")
	}
	if status != core.RunSucceeded && !document.Pinned {
		return errors.New("only successful artifacts or user-pinned material may enter memory")
	}
	return nil
}

// SearchMemory requires both lexical and vector retrieval to succeed. It never
// silently falls back to a different retrieval mode.
func (db *DB) SearchMemory(
	ctx context.Context,
	projectID, query string,
	queryVector []float32,
	limit int,
) ([]MemoryResult, error) {
	if projectID == "" || strings.TrimSpace(query) == "" {
		return nil, errors.New("project and search query are required")
	}
	if len(queryVector) != rag.EmbeddingDimensions {
		return nil, errors.New("query embedding dimension mismatch")
	}
	if limit <= 0 || limit > memoryResultLimit {
		limit = memoryResultLimit
	}
	lexical, err := db.lexicalCandidates(ctx, projectID, query)
	if err != nil {
		return nil, fmt.Errorf("lexical retrieval failed: %w", err)
	}
	semantic, err := db.semanticCandidates(ctx, projectID, queryVector)
	if err != nil {
		return nil, fmt.Errorf("vector retrieval failed: %w", err)
	}
	fused := rag.ReciprocalRankFusion(lexical, semantic, limit)
	return db.loadMemoryResults(ctx, projectID, fused)
}

func (db *DB) lexicalCandidates(ctx context.Context, projectID, query string) ([]rag.Ranked, error) {
	match := ftsMatch(query)
	if match == "" {
		return nil, errors.New("search query contains no searchable terms")
	}
	rows, err := db.sql.QueryContext(ctx, `
SELECT c.id, bm25(chunks_fts)
FROM chunks_fts
JOIN chunks c ON c.rowid = chunks_fts.rowid
JOIN documents d ON d.id = c.document_id
WHERE chunks_fts MATCH ? AND d.project_id = ? AND d.status = 'ready'
ORDER BY bm25(chunks_fts), c.id
LIMIT ?`, match, projectID, memoryCandidateLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ranked []rag.Ranked
	for rows.Next() {
		var item rag.Ranked
		var bm25 float64
		if err := rows.Scan(&item.ID, &bm25); err != nil {
			return nil, err
		}
		item.Score = -bm25
		ranked = append(ranked, item)
	}
	return ranked, rows.Err()
}

func ftsMatch(query string) string {
	terms := strings.Fields(query)
	quoted := make([]string, 0, len(terms))
	for _, term := range terms {
		term = strings.TrimSpace(term)
		if term == "" {
			continue
		}
		quoted = append(quoted, `"`+strings.ReplaceAll(term, `"`, `""`)+`"`)
	}
	return strings.Join(quoted, " OR ")
}

func (db *DB) semanticCandidates(ctx context.Context, projectID string, query []float32) ([]rag.Ranked, error) {
	rows, err := db.sql.QueryContext(ctx, `
SELECT e.chunk_id, e.vector, e.vector_hash, e.dimensions
FROM embeddings e
JOIN embedding_indexes i ON i.id = e.index_id
JOIN chunks c ON c.id = e.chunk_id
JOIN documents d ON d.id = c.document_id
WHERE d.project_id = ? AND d.status = 'ready'
  AND i.project_id = d.project_id AND i.state = 'active'`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var records []rag.VectorRecord
	for rows.Next() {
		var chunkID, expectedHash string
		var data []byte
		var dimensions int
		if err := rows.Scan(&chunkID, &data, &expectedHash, &dimensions); err != nil {
			return nil, err
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != expectedHash {
			return nil, fmt.Errorf("embedding checksum mismatch for chunk %s", chunkID)
		}
		vector, err := rag.DecodeVector(data, dimensions)
		if err != nil {
			return nil, fmt.Errorf("decode embedding for chunk %s: %w", chunkID, err)
		}
		if dimensions != rag.EmbeddingDimensions {
			return nil, fmt.Errorf("stored embedding dimension mismatch for chunk %s", chunkID)
		}
		records = append(records, rag.VectorRecord{ID: chunkID, Vector: vector})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return rag.ExactTopK(query, records, memoryCandidateLimit)
}

func (db *DB) ActiveEmbeddingIndex(ctx context.Context, projectID string) (EmbeddingIndex, error) {
	return scanEmbeddingIndex(db.sql.QueryRowContext(ctx, `
SELECT id, project_id, model, dimensions, state, error, created_at, completed_at
FROM embedding_indexes WHERE project_id = ? AND state = 'active'`, projectID))
}

func (db *DB) BeginShadowIndex(ctx context.Context, projectID, model string, dimensions int) (EmbeddingIndex, error) {
	if projectID == "" || model == "" || dimensions <= 0 {
		return EmbeddingIndex{}, errors.New("shadow index project, model, and dimensions are required")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return EmbeddingIndex{}, err
	}
	defer transaction.Rollback()
	if err := rejectMemoryReindexWithActiveRun(ctx, transaction, projectID); err != nil {
		return EmbeddingIndex{}, err
	}
	var building int
	if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM embedding_indexes WHERE project_id = ? AND state = 'building'`,
		projectID).Scan(&building); err != nil {
		return EmbeddingIndex{}, err
	}
	if building != 0 {
		return EmbeddingIndex{}, ErrShadowBuildInProgress
	}
	indexID, err := id.New("idx")
	if err != nil {
		return EmbeddingIndex{}, err
	}
	now := time.Now().UTC()
	_, err = transaction.ExecContext(ctx, `
INSERT INTO embedding_indexes(id, project_id, model, dimensions, state, created_at, completed_at)
VALUES(?, ?, ?, ?, 'building', ?, NULL)`, indexID, projectID, model, dimensions, formatTime(now))
	if err != nil {
		return EmbeddingIndex{}, err
	}
	result, err := transaction.ExecContext(ctx, `
UPDATE project_memory_heads
SET shadow_index_id = ?, state = 'reindexing', error = '', updated_at = ?
WHERE project_id = ?`, indexID, formatTime(now), projectID)
	if err != nil {
		return EmbeddingIndex{}, err
	}
	if changed, err := result.RowsAffected(); err != nil || changed != 1 {
		if err == nil {
			err = sql.ErrNoRows
		}
		return EmbeddingIndex{}, err
	}
	if err := transaction.Commit(); err != nil {
		return EmbeddingIndex{}, err
	}
	return EmbeddingIndex{
		ID: indexID, ProjectID: projectID, Model: model, Dimensions: dimensions,
		State: "building", CreatedAt: now,
	}, nil
}

func (db *DB) ShadowChunks(ctx context.Context, indexID string) ([]ShadowChunk, error) {
	rows, err := db.sql.QueryContext(ctx, `
SELECT c.id, c.text
FROM embedding_indexes i
JOIN documents d ON d.project_id = i.project_id AND d.status = 'ready'
JOIN chunks c ON c.document_id = d.id
LEFT JOIN embeddings e ON e.index_id = i.id AND e.chunk_id = c.id
WHERE i.id = ? AND i.state = 'building' AND e.chunk_id IS NULL
ORDER BY d.id, c.ordinal`, indexID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var chunks []ShadowChunk
	for rows.Next() {
		var chunk ShadowChunk
		if err := rows.Scan(&chunk.ID, &chunk.Text); err != nil {
			return nil, err
		}
		chunks = append(chunks, chunk)
	}
	return chunks, rows.Err()
}

func (db *DB) AddShadowEmbeddings(
	ctx context.Context,
	indexID string,
	chunkIDs []string,
	vectors [][]float32,
) error {
	if len(chunkIDs) == 0 || len(chunkIDs) != len(vectors) {
		return errors.New("each shadow chunk requires one embedding")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	var projectID, model, state string
	var dimensions int
	if err := transaction.QueryRowContext(ctx, `
SELECT project_id, model, dimensions, state FROM embedding_indexes WHERE id = ?`,
		indexID).Scan(&projectID, &model, &dimensions, &state); err != nil {
		return err
	}
	if state != "building" || dimensions != rag.EmbeddingDimensions {
		return errors.New("shadow index is not an active supported build")
	}
	now := time.Now().UTC()
	for index, chunkID := range chunkIDs {
		data, err := rag.EncodeVector(vectors[index])
		if err != nil {
			return fmt.Errorf("encode shadow embedding %s: %w", chunkID, err)
		}
		var ownerProject string
		if err := transaction.QueryRowContext(ctx, `
SELECT d.project_id FROM chunks c JOIN documents d ON d.id = c.document_id
WHERE c.id = ? AND d.status = 'ready'`, chunkID).Scan(&ownerProject); err != nil {
			return err
		}
		if ownerProject != projectID {
			return errors.New("shadow chunk does not belong to the index project")
		}
		sum := sha256.Sum256(data)
		if _, err := transaction.ExecContext(ctx, `
INSERT INTO embeddings(chunk_id, index_id, model, dimensions, vector, vector_hash, created_at)
VALUES(?, ?, ?, ?, ?, ?, ?)`, chunkID, indexID, model, dimensions, data,
			hex.EncodeToString(sum[:]), formatTime(now)); err != nil {
			return err
		}
	}
	return transaction.Commit()
}

func (db *DB) ActivateShadowIndex(ctx context.Context, indexID string) (EmbeddingIndex, error) {
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return EmbeddingIndex{}, err
	}
	defer transaction.Rollback()
	index, err := scanEmbeddingIndex(transaction.QueryRowContext(ctx, `
SELECT id, project_id, model, dimensions, state, error, created_at, completed_at
FROM embedding_indexes WHERE id = ?`, indexID))
	if err != nil {
		return EmbeddingIndex{}, err
	}
	if index.State != "building" {
		return EmbeddingIndex{}, errors.New("index is not a shadow build")
	}
	var expected, actual int
	if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM chunks c JOIN documents d ON d.id = c.document_id
WHERE d.project_id = ? AND d.status = 'ready'`, index.ProjectID).Scan(&expected); err != nil {
		return EmbeddingIndex{}, err
	}
	if err := transaction.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM embeddings WHERE index_id = ?", index.ID).Scan(&actual); err != nil {
		return EmbeddingIndex{}, err
	}
	if expected == 0 || actual != expected {
		return EmbeddingIndex{}, fmt.Errorf("shadow index is incomplete: %d of %d chunks", actual, expected)
	}
	rows, err := transaction.QueryContext(ctx, `
SELECT chunk_id, vector, vector_hash, dimensions FROM embeddings WHERE index_id = ?`, index.ID)
	if err != nil {
		return EmbeddingIndex{}, err
	}
	for rows.Next() {
		var chunkID, expectedHash string
		var data []byte
		var dimensions int
		if err := rows.Scan(&chunkID, &data, &expectedHash, &dimensions); err != nil {
			rows.Close()
			return EmbeddingIndex{}, err
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != expectedHash || dimensions != index.Dimensions {
			rows.Close()
			return EmbeddingIndex{}, fmt.Errorf("shadow embedding integrity failed for chunk %s", chunkID)
		}
		if _, err := rag.DecodeVector(data, dimensions); err != nil {
			rows.Close()
			return EmbeddingIndex{}, fmt.Errorf("shadow embedding validation failed for chunk %s: %w", chunkID, err)
		}
	}
	if err := rows.Close(); err != nil {
		return EmbeddingIndex{}, err
	}
	if err := rows.Err(); err != nil {
		return EmbeddingIndex{}, err
	}
	now := time.Now().UTC()
	if _, err := transaction.ExecContext(ctx, `
UPDATE embedding_indexes SET state = 'retired', completed_at = ?
WHERE project_id = ? AND state = 'active'`, formatTime(now), index.ProjectID); err != nil {
		return EmbeddingIndex{}, err
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE embedding_indexes SET state = 'active', completed_at = ?
WHERE id = ? AND state = 'building'`, formatTime(now), index.ID); err != nil {
		return EmbeddingIndex{}, err
	}
	result, err := transaction.ExecContext(ctx, `
UPDATE project_memory_heads
SET active_index_id = ?, shadow_index_id = NULL, memory_revision = memory_revision + 1,
    state = 'ready', error = '', updated_at = ?
WHERE project_id = ? AND shadow_index_id = ? AND state = 'reindexing'`,
		index.ID, formatTime(now), index.ProjectID, index.ID)
	if err != nil {
		return EmbeddingIndex{}, err
	}
	if changed, err := result.RowsAffected(); err != nil || changed != 1 {
		if err == nil {
			err = errors.New("memory head does not own the shadow index")
		}
		return EmbeddingIndex{}, err
	}
	if err := transaction.Commit(); err != nil {
		return EmbeddingIndex{}, err
	}
	index.State = "active"
	index.CompletedAt = &now
	return index, nil
}

func scanEmbeddingIndex(row scanner) (EmbeddingIndex, error) {
	var index EmbeddingIndex
	var created string
	var completed sql.NullString
	if err := row.Scan(&index.ID, &index.ProjectID, &index.Model, &index.Dimensions,
		&index.State, &index.Error, &created, &completed); err != nil {
		return EmbeddingIndex{}, err
	}
	var err error
	index.CreatedAt, err = parseTime(created)
	if err != nil {
		return EmbeddingIndex{}, err
	}
	index.CompletedAt, err = nullableTime(completed)
	return index, err
}

func (db *DB) loadMemoryResults(ctx context.Context, projectID string, ranked []rag.Ranked) ([]MemoryResult, error) {
	if len(ranked) == 0 {
		return nil, nil
	}
	byID := make(map[string]MemoryResult, len(ranked))
	for _, item := range ranked {
		var result MemoryResult
		if err := db.sql.QueryRowContext(ctx, `
SELECT c.id, c.document_id, COALESCE(d.artifact_id,''), d.title, c.text
FROM chunks c
JOIN documents d ON d.id = c.document_id
WHERE c.id = ? AND d.project_id = ? AND d.status = 'ready'`, item.ID, projectID).Scan(
			&result.ChunkID, &result.DocumentID, &result.ArtifactID, &result.Title, &result.Text,
		); err != nil {
			return nil, err
		}
		result.Score = item.Score
		byID[item.ID] = result
	}
	results := make([]MemoryResult, 0, len(ranked))
	for _, item := range ranked {
		if result, ok := byID[item.ID]; ok {
			results = append(results, result)
		}
	}
	return results, nil
}

func (db *DB) MemoryGet(ctx context.Context, projectID, chunkID string) (MemoryResult, error) {
	var result MemoryResult
	if err := db.sql.QueryRowContext(ctx, `
SELECT c.id, c.document_id, COALESCE(d.artifact_id,''), d.title, c.text
FROM chunks c
JOIN documents d ON d.id = c.document_id
WHERE c.id = ? AND d.project_id = ? AND d.status = 'ready'`, chunkID, projectID).Scan(
		&result.ChunkID, &result.DocumentID, &result.ArtifactID, &result.Title, &result.Text,
	); err != nil {
		return MemoryResult{}, err
	}
	return result, nil
}

func sortMemoryResults(results []MemoryResult) {
	sort.Slice(results, func(left, right int) bool {
		if results[left].Score == results[right].Score {
			return results[left].ChunkID < results[right].ChunkID
		}
		return results[left].Score > results[right].Score
	})
}
