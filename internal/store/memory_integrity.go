package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/djkim0320/AetherOps/internal/rag"
)

// VerifyDocumentIndex proves that one adopted material is represented by the
// exact deterministic chunks and by complete, valid rows in the project's
// active embedding and FTS indexes. It is intentionally read-only so release
// verification can run against an immutable product database.
func (db *DB) VerifyDocumentIndex(
	ctx context.Context,
	projectID, artifactID, blobHash string,
	expected []rag.Chunk,
) error {
	if strings.TrimSpace(projectID) == "" || strings.TrimSpace(blobHash) == "" {
		return errors.New("memory index project and blob hash are required")
	}
	if len(expected) == 0 {
		return errors.New("memory index requires deterministic expected chunks")
	}

	type documentRow struct {
		id, status, model string
		dimensions        int
	}
	documentRows, err := db.sql.QueryContext(ctx, `
SELECT id,status,embedding_model,embedding_dimensions
FROM documents
WHERE project_id=? AND blob_hash=? AND COALESCE(artifact_id,'')=?
ORDER BY id`, projectID, blobHash, artifactID)
	if err != nil {
		return fmt.Errorf("load memory document: %w", err)
	}
	var documents []documentRow
	for documentRows.Next() {
		var document documentRow
		if err := documentRows.Scan(&document.id, &document.status, &document.model, &document.dimensions); err != nil {
			documentRows.Close()
			return fmt.Errorf("scan memory document: %w", err)
		}
		documents = append(documents, document)
	}
	if err := documentRows.Err(); err != nil {
		documentRows.Close()
		return fmt.Errorf("iterate memory documents: %w", err)
	}
	if err := documentRows.Close(); err != nil {
		return fmt.Errorf("close memory documents: %w", err)
	}
	if len(documents) != 1 {
		return fmt.Errorf("memory material has %d document rows, want exactly one", len(documents))
	}
	document := documents[0]
	if document.status != "ready" {
		return fmt.Errorf("memory document is %s, want ready", document.status)
	}
	if document.model != rag.EmbeddingModel || document.dimensions != rag.EmbeddingDimensions {
		return fmt.Errorf("memory document embedding contract is %s/%d, want %s/%d",
			document.model, document.dimensions, rag.EmbeddingModel, rag.EmbeddingDimensions)
	}

	active, err := db.ActiveEmbeddingIndex(ctx, projectID)
	if err != nil {
		return fmt.Errorf("load active memory embedding index: %w", err)
	}
	if active.State != "active" || active.Model != rag.EmbeddingModel || active.Dimensions != rag.EmbeddingDimensions {
		return fmt.Errorf("active memory embedding contract is %s/%s/%d, want active/%s/%d",
			active.State, active.Model, active.Dimensions, rag.EmbeddingModel, rag.EmbeddingDimensions)
	}

	type chunkRow struct {
		rowID                      int64
		id, text, textHash         string
		ordinal                    int
		embeddingModel, vectorHash string
		embeddingDimensions        int
		vector                     []byte
	}
	rows, err := db.sql.QueryContext(ctx, `
SELECT c.rowid,c.id,c.ordinal,c.text,c.text_hash,
       COALESCE(e.model,''),COALESCE(e.dimensions,0),e.vector,COALESCE(e.vector_hash,'')
FROM chunks c
LEFT JOIN embeddings e ON e.chunk_id=c.id AND e.index_id=?
WHERE c.document_id=?
ORDER BY c.ordinal,c.id`, active.ID, document.id)
	if err != nil {
		return fmt.Errorf("load indexed memory chunks: %w", err)
	}
	var chunks []chunkRow
	for rows.Next() {
		var chunk chunkRow
		if err := rows.Scan(&chunk.rowID, &chunk.id, &chunk.ordinal, &chunk.text, &chunk.textHash,
			&chunk.embeddingModel, &chunk.embeddingDimensions, &chunk.vector, &chunk.vectorHash); err != nil {
			rows.Close()
			return fmt.Errorf("scan indexed memory chunk: %w", err)
		}
		chunks = append(chunks, chunk)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("iterate indexed memory chunks: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close indexed memory chunks: %w", err)
	}
	if len(chunks) != len(expected) {
		return fmt.Errorf("memory document has %d chunks, want %d deterministic chunks", len(chunks), len(expected))
	}

	for index, chunk := range chunks {
		want := expected[index]
		if chunk.ordinal != want.Ordinal || chunk.text != want.Text {
			return fmt.Errorf("memory chunk %d does not match deterministic ordinal/text", index)
		}
		textSum := sha256.Sum256([]byte(chunk.text))
		if chunk.textHash != hex.EncodeToString(textSum[:]) {
			return fmt.Errorf("memory chunk %s text hash mismatch", chunk.id)
		}
		if chunk.embeddingModel != rag.EmbeddingModel || chunk.embeddingDimensions != rag.EmbeddingDimensions {
			return fmt.Errorf("memory chunk %s active embedding contract mismatch", chunk.id)
		}
		vectorSum := sha256.Sum256(chunk.vector)
		if chunk.vectorHash != hex.EncodeToString(vectorSum[:]) {
			return fmt.Errorf("memory chunk %s vector hash mismatch", chunk.id)
		}
		if _, err := rag.DecodeVector(chunk.vector, rag.EmbeddingDimensions); err != nil {
			return fmt.Errorf("memory chunk %s vector validation failed: %w", chunk.id, err)
		}
		if err := db.verifyFTSChunk(ctx, chunk.rowID, chunk.text); err != nil {
			return fmt.Errorf("memory chunk %s FTS validation failed: %w", chunk.id, err)
		}
	}
	return nil
}

func (db *DB) verifyFTSChunk(ctx context.Context, rowID int64, text string) error {
	// A full quoted phrase makes FTS5 consult its inverted index and prove every
	// token, in order, for this row. Exact bytes are checked separately above.
	phrase := `"` + strings.ReplaceAll(text, `"`, `""`) + `"`
	var count int
	if err := db.sql.QueryRowContext(ctx, `
SELECT COUNT(*) FROM chunks_fts
WHERE chunks_fts MATCH ? AND rowid=?`, phrase, rowID).Scan(&count); err != nil {
		return err
	}
	if count != 1 {
		return fmt.Errorf("FTS row count is %d, want one exact phrase match", count)
	}
	return nil
}
