package store

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"strings"

	"github.com/djkim0320/Aether-claw/internal/rag"
)

// MemoryShadowReleaseExpectation binds an offline verification to the exact
// live transition observed before the product was stopped.
type MemoryShadowReleaseExpectation struct {
	ProjectID         string
	PreviousIndexID   string
	ActiveIndexID     string
	BeforeRevision    int64
	AfterRevision     int64
	ExpectedDocuments int
}

// MemoryShadowReleaseProof is a deterministic summary of a complete active
// shadow swap. The per-row vector checks are performed before these digests are
// returned; the digest is not a substitute for validation.
type MemoryShadowReleaseProof struct {
	ProjectID       string `json:"project_id"`
	PreviousIndexID string `json:"previous_index_id"`
	ActiveIndexID   string `json:"active_index_id"`
	MemoryRevision  int64  `json:"memory_revision"`
	DocumentCount   int    `json:"document_count"`
	ChunkCount      int    `json:"chunk_count"`
	VectorCount     int    `json:"vector_count"`
	SourceSetSHA256 string `json:"source_set_sha256"`
	VectorSetSHA256 string `json:"vector_set_sha256"`
}

// VerifyMemoryShadowRelease proves that an observed building generation
// became the sole active complete generation and that the prior active index
// was retired. It is read-only and is suitable for DBs opened by OpenReadOnly.
func (db *DB) VerifyMemoryShadowRelease(ctx context.Context, expected MemoryShadowReleaseExpectation) (MemoryShadowReleaseProof, error) {
	if strings.TrimSpace(expected.ProjectID) == "" || strings.TrimSpace(expected.PreviousIndexID) == "" ||
		strings.TrimSpace(expected.ActiveIndexID) == "" || expected.PreviousIndexID == expected.ActiveIndexID ||
		expected.BeforeRevision < 0 || expected.AfterRevision != expected.BeforeRevision+1 || expected.ExpectedDocuments < 1 {
		return MemoryShadowReleaseProof{}, errors.New("complete shadow release expectation is required")
	}
	head, err := db.ProjectMemoryStatus(ctx, expected.ProjectID)
	if err != nil {
		return MemoryShadowReleaseProof{}, err
	}
	if head.State != "ready" || head.Error != "" || head.ShadowIndexID != "" || head.ShadowIndex != nil ||
		head.ActiveIndexID != expected.ActiveIndexID || head.MemoryRevision != expected.AfterRevision || head.ActiveIndex == nil {
		return MemoryShadowReleaseProof{}, errors.New("durable memory head does not match the exact observed ready shadow swap")
	}
	active := *head.ActiveIndex
	if active.State != "active" || active.Model != rag.EmbeddingModel || active.Dimensions != rag.EmbeddingDimensions ||
		active.ProjectID != expected.ProjectID || active.CompletedAt == nil || active.Error != "" {
		return MemoryShadowReleaseProof{}, errors.New("active shadow index contract is invalid")
	}
	previous, err := db.embeddingIndex(ctx, expected.PreviousIndexID)
	if err != nil {
		return MemoryShadowReleaseProof{}, fmt.Errorf("load previous embedding index: %w", err)
	}
	if previous.ProjectID != expected.ProjectID || previous.State != "retired" || previous.CompletedAt == nil ||
		previous.Model != rag.EmbeddingModel || previous.Dimensions != rag.EmbeddingDimensions {
		return MemoryShadowReleaseProof{}, errors.New("previous active index was not exactly retired by the swap")
	}

	var documentCount int
	if err := db.sql.QueryRowContext(ctx, `SELECT COUNT(*) FROM documents WHERE project_id=? AND status='ready'`, expected.ProjectID).Scan(&documentCount); err != nil {
		return MemoryShadowReleaseProof{}, err
	}
	if documentCount != expected.ExpectedDocuments {
		return MemoryShadowReleaseProof{}, fmt.Errorf("ready document count is %d, want observed %d", documentCount, expected.ExpectedDocuments)
	}

	sourceDigest := sha256.New()
	sourceRows, err := db.sql.QueryContext(ctx, `
SELECT d.id,COALESCE(d.artifact_id,''),d.blob_hash,c.id,c.ordinal,c.text,c.text_hash
FROM documents d JOIN chunks c ON c.document_id=d.id
WHERE d.project_id=? AND d.status='ready'
ORDER BY d.id,c.ordinal,c.id`, expected.ProjectID)
	if err != nil {
		return MemoryShadowReleaseProof{}, err
	}
	chunkCount := 0
	for sourceRows.Next() {
		var documentID, artifactID, blobHash, chunkID, text, textHash string
		var ordinal int
		if err := sourceRows.Scan(&documentID, &artifactID, &blobHash, &chunkID, &ordinal, &text, &textHash); err != nil {
			sourceRows.Close()
			return MemoryShadowReleaseProof{}, err
		}
		textSum := sha256.Sum256([]byte(text))
		if textHash != hex.EncodeToString(textSum[:]) {
			sourceRows.Close()
			return MemoryShadowReleaseProof{}, fmt.Errorf("chunk %s text hash mismatch", chunkID)
		}
		writeDigestFields(sourceDigest, documentID, artifactID, blobHash, chunkID, fmt.Sprint(ordinal), textHash)
		chunkCount++
	}
	if err := sourceRows.Close(); err != nil {
		return MemoryShadowReleaseProof{}, err
	}
	if err := sourceRows.Err(); err != nil {
		return MemoryShadowReleaseProof{}, err
	}
	if chunkCount < 1 {
		return MemoryShadowReleaseProof{}, errors.New("active memory release contains no ready chunks")
	}

	vectorDigest := sha256.New()
	vectorRows, err := db.sql.QueryContext(ctx, `
SELECT e.chunk_id,e.model,e.dimensions,e.vector,e.vector_hash,d.project_id
FROM embeddings e
JOIN chunks c ON c.id=e.chunk_id
JOIN documents d ON d.id=c.document_id
WHERE e.index_id=?
ORDER BY e.chunk_id`, expected.ActiveIndexID)
	if err != nil {
		return MemoryShadowReleaseProof{}, err
	}
	vectorCount := 0
	for vectorRows.Next() {
		var chunkID, model, vectorHash, ownerProject string
		var dimensions int
		var vector []byte
		if err := vectorRows.Scan(&chunkID, &model, &dimensions, &vector, &vectorHash, &ownerProject); err != nil {
			vectorRows.Close()
			return MemoryShadowReleaseProof{}, err
		}
		if ownerProject != expected.ProjectID || model != rag.EmbeddingModel || dimensions != rag.EmbeddingDimensions {
			vectorRows.Close()
			return MemoryShadowReleaseProof{}, fmt.Errorf("embedding %s crosses project or contract boundary", chunkID)
		}
		vectorSum := sha256.Sum256(vector)
		if vectorHash != hex.EncodeToString(vectorSum[:]) {
			vectorRows.Close()
			return MemoryShadowReleaseProof{}, fmt.Errorf("embedding %s vector hash mismatch", chunkID)
		}
		if _, err := rag.DecodeVector(vector, rag.EmbeddingDimensions); err != nil {
			vectorRows.Close()
			return MemoryShadowReleaseProof{}, fmt.Errorf("embedding %s vector is invalid: %w", chunkID, err)
		}
		writeDigestFields(vectorDigest, chunkID, model, fmt.Sprint(dimensions), vectorHash)
		vectorCount++
	}
	if err := vectorRows.Close(); err != nil {
		return MemoryShadowReleaseProof{}, err
	}
	if err := vectorRows.Err(); err != nil {
		return MemoryShadowReleaseProof{}, err
	}
	if vectorCount != chunkCount {
		return MemoryShadowReleaseProof{}, fmt.Errorf("active index has %d vectors for %d ready chunks", vectorCount, chunkCount)
	}
	return MemoryShadowReleaseProof{
		ProjectID: expected.ProjectID, PreviousIndexID: expected.PreviousIndexID, ActiveIndexID: expected.ActiveIndexID,
		MemoryRevision: expected.AfterRevision, DocumentCount: documentCount, ChunkCount: chunkCount, VectorCount: vectorCount,
		SourceSetSHA256: hex.EncodeToString(sourceDigest.Sum(nil)), VectorSetSHA256: hex.EncodeToString(vectorDigest.Sum(nil)),
	}, nil
}

func writeDigestFields(destination hash.Hash, fields ...string) {
	for _, field := range fields {
		_ = binary.Write(destination, binary.BigEndian, uint64(len(field)))
		_, _ = destination.Write([]byte(field))
	}
}
