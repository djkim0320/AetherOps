package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/rag"
)

func TestVerifyDocumentIndexChecksDeterministicChunksAndIndexes(t *testing.T) {
	db, projectID, document, chunks := indexedIntegrityFixture(t)
	if err := db.VerifyDocumentIndex(context.Background(), projectID, "", document.BlobHash, chunks); err != nil {
		t.Fatalf("verify valid index: %v", err)
	}

	wrong := append([]rag.Chunk(nil), chunks...)
	wrong[0].Text += " drift"
	if err := db.VerifyDocumentIndex(context.Background(), projectID, "", document.BlobHash, wrong); err == nil || !strings.Contains(err.Error(), "deterministic") {
		t.Fatalf("deterministic chunk drift was accepted: %v", err)
	}
}

func TestVerifyDocumentIndexRejectsCorruptHashVectorAndFTS(t *testing.T) {
	tests := []struct {
		name       string
		corrupt    func(*testing.T, *DB, Document)
		wantDetail string
	}{
		{
			name: "text hash",
			corrupt: func(t *testing.T, db *DB, document Document) {
				if _, err := db.SQL().ExecContext(context.Background(),
					"UPDATE chunks SET text_hash=? WHERE document_id=?", strings.Repeat("0", 64), document.ID); err != nil {
					t.Fatal(err)
				}
			},
			wantDetail: "text hash",
		},
		{
			name: "zero vector with matching hash",
			corrupt: func(t *testing.T, db *DB, document Document) {
				zero := make([]byte, rag.EmbeddingDimensions*4)
				sum := sha256.Sum256(zero)
				if _, err := db.SQL().ExecContext(context.Background(), `
UPDATE embeddings SET vector=?,vector_hash=?
WHERE chunk_id=(SELECT id FROM chunks WHERE document_id=? LIMIT 1)`,
					zero, hex.EncodeToString(sum[:]), document.ID); err != nil {
					t.Fatal(err)
				}
			},
			wantDetail: "zero norm",
		},
		{
			name: "vector hash",
			corrupt: func(t *testing.T, db *DB, document Document) {
				if _, err := db.SQL().ExecContext(context.Background(), `
UPDATE embeddings SET vector_hash=?
WHERE chunk_id=(SELECT id FROM chunks WHERE document_id=? LIMIT 1)`, strings.Repeat("f", 64), document.ID); err != nil {
					t.Fatal(err)
				}
			},
			wantDetail: "vector hash",
		},
		{
			name: "FTS row",
			corrupt: func(t *testing.T, db *DB, document Document) {
				var rowID int64
				var text string
				if err := db.SQL().QueryRowContext(context.Background(),
					"SELECT rowid,text FROM chunks WHERE document_id=? LIMIT 1", document.ID).Scan(&rowID, &text); err != nil {
					t.Fatal(err)
				}
				if _, err := db.SQL().ExecContext(context.Background(),
					"INSERT INTO chunks_fts(chunks_fts,rowid,text) VALUES('delete',?,?)", rowID, text); err != nil {
					t.Fatal(err)
				}
			},
			wantDetail: "FTS",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db, projectID, document, chunks := indexedIntegrityFixture(t)
			test.corrupt(t, db, document)
			err := db.VerifyDocumentIndex(context.Background(), projectID, "", document.BlobHash, chunks)
			if err == nil || !strings.Contains(err.Error(), test.wantDetail) {
				t.Fatalf("corrupt %s was accepted: %v", test.name, err)
			}
		})
	}
}

func indexedIntegrityFixture(t *testing.T) (*DB, string, Document, []rag.Chunk) {
	t.Helper()
	db, objects := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "memory integrity")
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte("한국어 English adopted memory integrity evidence")
	receipt, err := objects.PutBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/plain; charset=utf-8"); err != nil {
		t.Fatal(err)
	}
	chunks := rag.ChunkText(string(raw), rag.DefaultChunkRunes, rag.DefaultOverlapRunes)
	vectors := make([][]float32, len(chunks))
	for index := range vectors {
		vectors[index] = make([]float32, rag.EmbeddingDimensions)
		vectors[index][index%rag.EmbeddingDimensions] = 1
	}
	document, err := db.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "integrity evidence", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
		Pinned: true,
	}, chunks, vectors)
	if err != nil {
		t.Fatal(err)
	}
	return db, project.ID, document, chunks
}
