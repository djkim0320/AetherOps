package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

var ErrDeletionConfirmation = errors.New("deletion confirmation does not match")

type MemoryDocument struct {
	Document
	MediaType           string `json:"media_type"`
	Size                int64  `json:"size"`
	KnowledgeReferences int    `json:"knowledge_references"`
}

type MemoryDeletion struct {
	DocumentID                 string `json:"document_id"`
	Deleted                    bool   `json:"deleted"`
	Forgotten                  bool   `json:"forgotten"`
	RetainedForGraphProvenance bool   `json:"retained_for_graph_provenance"`
	KnowledgeGraphStale        bool   `json:"knowledge_graph_stale"`
	OrphanedBlobHash           string `json:"-"`
}

// MemoryDocuments returns only live RAG inputs. Forgotten documents remain in
// SQLite solely when an immutable graph generation still needs their chunks as
// provenance, and are intentionally excluded here and from retrieval.
func (db *DB) MemoryDocuments(ctx context.Context, projectID string) ([]MemoryDocument, error) {
	if strings.TrimSpace(projectID) == "" {
		return nil, errors.New("project id is required")
	}
	var projectExists int
	if err := db.sql.QueryRowContext(ctx, "SELECT COUNT(*) FROM projects WHERE id=?", projectID).Scan(&projectExists); err != nil {
		return nil, err
	}
	if projectExists != 1 {
		return nil, sql.ErrNoRows
	}
	rows, err := db.sql.QueryContext(ctx, `
SELECT d.id,d.project_id,COALESCE(d.artifact_id,''),d.title,d.blob_hash,d.status,
       d.embedding_model,d.embedding_dimensions,d.pinned,d.graph_adopt,d.created_at,d.updated_at,
       b.media_type,b.size,
       (SELECT COUNT(*) FROM knowledge_sources ks JOIN chunks c ON c.id=ks.chunk_id WHERE c.document_id=d.id) +
       (SELECT COUNT(*) FROM knowledge_extraction_batches kb WHERE kb.document_id=d.id)
FROM documents d JOIN blobs b ON b.hash=d.blob_hash
WHERE d.project_id=? AND d.status='ready'
ORDER BY d.updated_at DESC,d.id`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var documents []MemoryDocument
	for rows.Next() {
		var document MemoryDocument
		var created, updated string
		if err := rows.Scan(
			&document.ID, &document.ProjectID, &document.ArtifactID, &document.Title,
			&document.BlobHash, &document.Status, &document.EmbeddingModel,
			&document.EmbeddingDimensions, &document.Pinned, &document.GraphAdopt,
			&created, &updated, &document.MediaType, &document.Size, &document.KnowledgeReferences,
		); err != nil {
			return nil, err
		}
		var parseErr error
		document.CreatedAt, parseErr = parseTime(created)
		if parseErr != nil {
			return nil, parseErr
		}
		document.UpdatedAt, parseErr = parseTime(updated)
		if parseErr != nil {
			return nil, parseErr
		}
		documents = append(documents, document)
	}
	return documents, rows.Err()
}

// ForgetMemoryDocument removes a single document from RAG after an exact title
// confirmation. If an immutable graph generation still references its chunks,
// the document is tombstoned instead of destroying provenance. An orphan CAS
// hash is returned only after the relational transaction has committed.
func (db *DB) ForgetMemoryDocument(
	ctx context.Context,
	projectID, documentID, confirmationTitle string,
) (MemoryDeletion, error) {
	if strings.TrimSpace(projectID) == "" || strings.TrimSpace(documentID) == "" || confirmationTitle == "" {
		return MemoryDeletion{}, errors.New("project, document, and exact title confirmation are required")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return MemoryDeletion{}, err
	}
	defer transaction.Rollback()
	if err := rejectMemoryMutationWithProjectWork(ctx, transaction, projectID); err != nil {
		return MemoryDeletion{}, err
	}
	var title, blobHash, status string
	var pinned, graphAdopt bool
	if err := transaction.QueryRowContext(ctx, `
SELECT title,blob_hash,status,pinned,graph_adopt
FROM documents WHERE id=? AND project_id=? AND status='ready'`, documentID, projectID).Scan(
		&title, &blobHash, &status, &pinned, &graphAdopt,
	); err != nil {
		return MemoryDeletion{}, err
	}
	if confirmationTitle != title {
		return MemoryDeletion{}, ErrDeletionConfirmation
	}
	var graphReferences int
	if err := transaction.QueryRowContext(ctx, `
SELECT
  (SELECT COUNT(*) FROM knowledge_sources ks JOIN chunks c ON c.id=ks.chunk_id WHERE c.document_id=?)+
  (SELECT COUNT(*) FROM knowledge_extraction_batches WHERE document_id=?)`, documentID, documentID).Scan(&graphReferences); err != nil {
		return MemoryDeletion{}, err
	}
	result := MemoryDeletion{DocumentID: documentID}
	if graphReferences > 0 {
		if _, err := transaction.ExecContext(ctx, `
UPDATE documents SET status='forgotten',pinned=0,graph_adopt=0,updated_at=?
WHERE id=? AND project_id=? AND status='ready'`, formatTime(time.Now().UTC()), documentID, projectID); err != nil {
			return MemoryDeletion{}, err
		}
		if graphAdopt {
			if _, err := transaction.ExecContext(ctx, `
UPDATE project_knowledge_heads
SET status='stale',error='graph-adopted memory was forgotten; rebuild required',
    knowledge_revision=knowledge_revision+1,updated_at=?
WHERE project_id=?`, formatTime(time.Now().UTC()), projectID); err != nil {
				return MemoryDeletion{}, err
			}
			result.KnowledgeGraphStale = true
		}
		if err := recordProjectMemoryMutation(ctx, transaction, projectID, time.Now().UTC()); err != nil {
			return MemoryDeletion{}, err
		}
		if err := transaction.Commit(); err != nil {
			return MemoryDeletion{}, err
		}
		result.Forgotten = true
		result.RetainedForGraphProvenance = true
		return result, nil
	}
	deleteResult, err := transaction.ExecContext(ctx,
		"DELETE FROM documents WHERE id=? AND project_id=? AND status='ready'", documentID, projectID)
	if err != nil {
		return MemoryDeletion{}, err
	}
	if affected, err := deleteResult.RowsAffected(); err != nil || affected != 1 {
		if err == nil {
			err = sql.ErrNoRows
		}
		return MemoryDeletion{}, err
	}
	if err := recordProjectMemoryMutation(ctx, transaction, projectID, time.Now().UTC()); err != nil {
		return MemoryDeletion{}, err
	}
	references, err := blobReferenceCount(ctx, transaction, blobHash)
	if err != nil {
		return MemoryDeletion{}, err
	}
	if references == 0 {
		if _, err := transaction.ExecContext(ctx, "DELETE FROM blobs WHERE hash=?", blobHash); err != nil {
			return MemoryDeletion{}, err
		}
		result.OrphanedBlobHash = blobHash
	}
	if err := transaction.Commit(); err != nil {
		return MemoryDeletion{}, err
	}
	result.Deleted = true
	return result, nil
}

func (db *DB) PinnedMaterials(ctx context.Context, projectID string) ([]Document, error) {
	rows, err := db.sql.QueryContext(ctx, `
SELECT id, project_id, COALESCE(artifact_id,''), title, blob_hash, status,
       embedding_model, embedding_dimensions, pinned, graph_adopt, created_at, updated_at
FROM documents WHERE project_id=? AND pinned=1 ORDER BY created_at,id`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var documents []Document
	for rows.Next() {
		document, err := scanDocument(rows)
		if err != nil {
			return nil, err
		}
		documents = append(documents, document)
	}
	return documents, rows.Err()
}

func (db *DB) UpdatePinnedMaterialGraphAdopt(ctx context.Context, projectID, documentID string, enabled bool) (Document, error) {
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return Document{}, err
	}
	defer transaction.Rollback()
	if err := rejectMemoryMutationWithProjectWork(ctx, transaction, projectID); err != nil {
		return Document{}, err
	}
	var current bool
	var pinned bool
	if err := transaction.QueryRowContext(ctx, "SELECT graph_adopt,pinned FROM documents WHERE id=? AND project_id=?", documentID, projectID).Scan(&current, &pinned); err != nil {
		return Document{}, err
	}
	if !pinned {
		return Document{}, errors.New("only user-pinned material can change graph adoption")
	}
	if current != enabled {
		if _, err := transaction.ExecContext(ctx, "UPDATE documents SET graph_adopt=?,updated_at=? WHERE id=? AND project_id=?", enabled, formatTime(time.Now().UTC()), documentID, projectID); err != nil {
			return Document{}, err
		}
		if _, err := transaction.ExecContext(ctx, `UPDATE project_knowledge_heads SET status='stale',error='pinned material adoption changed; rebuild required',knowledge_revision=knowledge_revision+1,updated_at=? WHERE project_id=?`, formatTime(time.Now().UTC()), projectID); err != nil {
			return Document{}, err
		}
	}
	document, err := scanDocument(transaction.QueryRowContext(ctx, `SELECT id,project_id,COALESCE(artifact_id,''),title,blob_hash,status,embedding_model,embedding_dimensions,pinned,graph_adopt,created_at,updated_at FROM documents WHERE id=? AND project_id=?`, documentID, projectID))
	if err != nil {
		return Document{}, err
	}
	if err := transaction.Commit(); err != nil {
		return Document{}, err
	}
	return document, nil
}

// DeletePinnedMaterial returns a CAS hash only when the relational deletion
// made it completely unreferenced. Graph-adopted material must first be removed
// through a validated generation rebuild.
func (db *DB) DeletePinnedMaterial(ctx context.Context, projectID, documentID string) (string, error) {
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer transaction.Rollback()
	if err := rejectMemoryMutationWithProjectWork(ctx, transaction, projectID); err != nil {
		return "", err
	}
	var blobHash string
	var pinned, graphAdopt bool
	if err := transaction.QueryRowContext(ctx, "SELECT blob_hash,pinned,graph_adopt FROM documents WHERE id=? AND project_id=?", documentID, projectID).Scan(&blobHash, &pinned, &graphAdopt); err != nil {
		return "", err
	}
	if !pinned {
		return "", errors.New("document is not user-pinned material")
	}
	if graphAdopt {
		return "", errors.New("graph-adopted material must be unadopted and rebuilt before deletion")
	}
	var graphReferences int
	if err := transaction.QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_sources ks JOIN chunks c ON c.id=ks.chunk_id WHERE c.document_id=?`, documentID).Scan(&graphReferences); err != nil {
		return "", err
	}
	if graphReferences != 0 {
		return "", errors.New("material is still referenced by a knowledge generation")
	}
	if err := transaction.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM knowledge_extraction_batches WHERE document_id=?`, documentID,
	).Scan(&graphReferences); err != nil {
		return "", err
	}
	if graphReferences != 0 {
		return "", errors.New("material still has a knowledge extraction batch")
	}
	if _, err := transaction.ExecContext(ctx, "DELETE FROM documents WHERE id=? AND project_id=?", documentID, projectID); err != nil {
		return "", err
	}
	if err := recordProjectMemoryMutation(ctx, transaction, projectID, time.Now().UTC()); err != nil {
		return "", err
	}
	references, err := blobReferenceCount(ctx, transaction, blobHash)
	if err != nil {
		return "", err
	}
	orphan := ""
	if references == 0 {
		if _, err := transaction.ExecContext(ctx, "DELETE FROM blobs WHERE hash=?", blobHash); err != nil {
			return "", err
		}
		orphan = blobHash
	}
	if err := transaction.Commit(); err != nil {
		return "", err
	}
	return orphan, nil
}

func blobReferenceCount(ctx context.Context, transaction *sql.Tx, hash string) (int, error) {
	var references int
	err := transaction.QueryRowContext(ctx, `
SELECT (SELECT COUNT(*) FROM artifacts WHERE blob_hash=?)+
       (SELECT COUNT(*) FROM evidence WHERE blob_hash=?)+
       (SELECT COUNT(*) FROM stage_attempts WHERE input_artifact_hash=?)+
       (SELECT COUNT(*) FROM stage_attempts WHERE output_artifact_hash=?)+
       (SELECT COUNT(*) FROM documents WHERE blob_hash=?)+
       (SELECT COUNT(*) FROM downloads WHERE blob_hash=?)+
       (SELECT COUNT(*) FROM ontology_versions WHERE source_blob_hash=? OR canonical_blob_hash=?)+
       (SELECT COUNT(*) FROM knowledge_sources WHERE blob_hash=?)+
       (SELECT COUNT(*) FROM knowledge_rdf_snapshots WHERE blob_hash=?)+
       (SELECT COUNT(*) FROM knowledge_extraction_batches WHERE patch_blob_hash=?)+
       (SELECT COUNT(*) FROM knowledge_assertion_evidence WHERE blob_hash=?)+
       (SELECT COUNT(*) FROM knowledge_curation_events
          WHERE json_extract(payload_json,'$.memo_blob_hash')=?)`,
		hash, hash, hash, hash, hash, hash, hash, hash, hash, hash, hash, hash, hash).Scan(&references)
	return references, err
}

func scanDocument(row scanner) (Document, error) {
	var document Document
	var created, updated string
	if err := row.Scan(&document.ID, &document.ProjectID, &document.ArtifactID, &document.Title, &document.BlobHash, &document.Status, &document.EmbeddingModel, &document.EmbeddingDimensions, &document.Pinned, &document.GraphAdopt, &created, &updated); err != nil {
		return Document{}, err
	}
	var err error
	document.CreatedAt, err = parseTime(created)
	if err != nil {
		return Document{}, err
	}
	document.UpdatedAt, err = parseTime(updated)
	return document, err
}
