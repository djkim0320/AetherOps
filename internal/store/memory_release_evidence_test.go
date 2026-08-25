package store

import (
	"context"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/rag"
)

func TestVerifyMemoryShadowReleaseChecksExactSwapAndVectors(t *testing.T) {
	db, projectID, _, _ := indexedIntegrityFixture(t)
	ctx := context.Background()
	before, err := db.ProjectMemoryStatus(ctx, projectID)
	if err != nil {
		t.Fatal(err)
	}
	shadow, err := db.BeginShadowIndex(ctx, projectID, rag.EmbeddingModel, rag.EmbeddingDimensions)
	if err != nil {
		t.Fatal(err)
	}
	chunks, err := db.ShadowChunks(ctx, shadow.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, chunk := range chunks {
		vector := make([]float32, rag.EmbeddingDimensions)
		vector[1] = 1
		if err := db.AddShadowEmbeddings(ctx, shadow.ID, []string{chunk.ID}, [][]float32{vector}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ActivateShadowIndex(ctx, shadow.ID); err != nil {
		t.Fatal(err)
	}
	after, err := db.ProjectMemoryStatus(ctx, projectID)
	if err != nil {
		t.Fatal(err)
	}
	proof, err := db.VerifyMemoryShadowRelease(ctx, MemoryShadowReleaseExpectation{
		ProjectID: projectID, PreviousIndexID: before.ActiveIndexID, ActiveIndexID: shadow.ID,
		BeforeRevision: before.MemoryRevision, AfterRevision: after.MemoryRevision, ExpectedDocuments: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if proof.ChunkCount != len(chunks) || proof.VectorCount != len(chunks) || len(proof.VectorSetSHA256) != 64 {
		t.Fatalf("unexpected proof: %+v", proof)
	}
}

func TestVerifyMemoryShadowReleaseRejectsCorruptActiveVector(t *testing.T) {
	db, projectID, _, _ := indexedIntegrityFixture(t)
	ctx := context.Background()
	before, _ := db.ProjectMemoryStatus(ctx, projectID)
	shadow, err := db.BeginShadowIndex(ctx, projectID, rag.EmbeddingModel, rag.EmbeddingDimensions)
	if err != nil {
		t.Fatal(err)
	}
	chunks, err := db.ShadowChunks(ctx, shadow.ID)
	if err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	if err := db.AddShadowEmbeddings(ctx, shadow.ID, []string{chunks[0].ID}, [][]float32{vector}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ActivateShadowIndex(ctx, shadow.ID); err != nil {
		t.Fatal(err)
	}
	after, _ := db.ProjectMemoryStatus(ctx, projectID)
	if _, err := db.SQL().ExecContext(ctx, "UPDATE embeddings SET vector_hash=? WHERE index_id=?", strings.Repeat("0", 64), shadow.ID); err != nil {
		t.Fatal(err)
	}
	_, err = db.VerifyMemoryShadowRelease(ctx, MemoryShadowReleaseExpectation{
		ProjectID: projectID, PreviousIndexID: before.ActiveIndexID, ActiveIndexID: shadow.ID,
		BeforeRevision: before.MemoryRevision, AfterRevision: after.MemoryRevision, ExpectedDocuments: 1,
	})
	if err == nil || !strings.Contains(err.Error(), "vector hash") {
		t.Fatalf("corrupt active vector accepted: %v", err)
	}
}
