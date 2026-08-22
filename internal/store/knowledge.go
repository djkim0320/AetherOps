package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/id"
)

const (
	CoreOntologyID               = "ont_core_v1"
	CoreOntologyContractSHA256   = "88879f6e13dfefafbc28c96d68b33c5edef3e9f35d039646f392780640c9ad52"
	EmptyKnowledgeManifestSHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	DefaultRetrievalProfile      = "hybrid_graph_v1"
)

type KnowledgeGenerationState string

const (
	KnowledgeBuilding   KnowledgeGenerationState = "building"
	KnowledgeValidating KnowledgeGenerationState = "validating"
	KnowledgeReady      KnowledgeGenerationState = "ready"
	KnowledgeRetired    KnowledgeGenerationState = "retired"
	KnowledgeFailed     KnowledgeGenerationState = "failed"
)

type KnowledgeHeadStatus string

const (
	KnowledgeHeadReady  KnowledgeHeadStatus = "ready"
	KnowledgeHeadStale  KnowledgeHeadStatus = "stale"
	KnowledgeHeadFailed KnowledgeHeadStatus = "failed"
)

type KnowledgeGeneration struct {
	ProjectID      string                   `json:"project_id"`
	ID             string                   `json:"id"`
	OntologyID     string                   `json:"ontology_id"`
	ContractSHA256 string                   `json:"contract_sha256"`
	ManifestSHA256 string                   `json:"manifest_sha256,omitempty"`
	State          KnowledgeGenerationState `json:"state"`
	SourceCount    int                      `json:"source_count"`
	EntityCount    int                      `json:"entity_count"`
	AssertionCount int                      `json:"assertion_count"`
	Error          string                   `json:"error,omitempty"`
	CreatedAt      time.Time                `json:"created_at"`
	ValidatingAt   *time.Time               `json:"validating_at,omitempty"`
	ReadyAt        *time.Time               `json:"ready_at,omitempty"`
	RetiredAt      *time.Time               `json:"retired_at,omitempty"`
	FailedAt       *time.Time               `json:"failed_at,omitempty"`
}

type KnowledgeHead struct {
	ProjectID         string              `json:"project_id"`
	GenerationID      string              `json:"generation_id"`
	KnowledgeRevision int64               `json:"knowledge_revision"`
	Status            KnowledgeHeadStatus `json:"status"`
	Error             string              `json:"error,omitempty"`
	ActivatedAt       time.Time           `json:"activated_at"`
	UpdatedAt         time.Time           `json:"updated_at"`
	Generation        KnowledgeGeneration `json:"generation"`
}

type KnowledgeCurationEvent struct {
	Sequence            int64           `json:"sequence"`
	ID                  string          `json:"id"`
	ProjectID           string          `json:"project_id"`
	GenerationID        string          `json:"generation_id"`
	Kind                string          `json:"kind"`
	Actor               string          `json:"actor"`
	Payload             json.RawMessage `json:"payload"`
	PayloadSHA256       string          `json:"payload_sha256"`
	PreviousEventSHA256 string          `json:"previous_event_sha256,omitempty"`
	EventSHA256         string          `json:"event_sha256"`
	CreatedAt           time.Time       `json:"created_at"`
}

var knowledgeCurationKinds = map[string]bool{
	"add_entity": true, "add_assertion": true, "update_assertion": true,
	"merge_entities": true, "split_entity": true, "retract_assertion": true,
	"restore_assertion": true, "add_alias": true, "pin_entity": true,
	"resolve_conflict": true, "dismiss_conflict": true,
}

// EnsureEmptyKnowledgeGeneration gives a project a usable, verified empty
// graph. It is idempotent and is safe to call immediately after CreateProject.
func (db *DB) EnsureEmptyKnowledgeGeneration(ctx context.Context, projectID string) (KnowledgeHead, error) {
	if strings.TrimSpace(projectID) == "" {
		return KnowledgeHead{}, errors.New("knowledge project is required")
	}
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return KnowledgeHead{}, err
	}
	defer tx.Rollback()

	head, err := scanKnowledgeHead(tx.QueryRowContext(ctx, knowledgeHeadSelect+" WHERE h.project_id = ?", projectID))
	if err == nil {
		if err := tx.Commit(); err != nil {
			return KnowledgeHead{}, err
		}
		return head, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return KnowledgeHead{}, err
	}
	return KnowledgeHead{}, errors.New("project has no knowledge head; initialize it through the ontology snapshot service")
}

func (db *DB) CreateKnowledgeGeneration(
	ctx context.Context,
	projectID, ontologyID, contractSHA256 string,
) (KnowledgeGeneration, error) {
	if projectID == "" || ontologyID == "" || !validSHA256(contractSHA256) {
		return KnowledgeGeneration{}, errors.New("knowledge project, active ontology, and contract SHA-256 are required")
	}
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return KnowledgeGeneration{}, err
	}
	defer tx.Rollback()
	var ontologyProject sql.NullString
	var ontologyState string
	if err := tx.QueryRowContext(ctx,
		"SELECT project_id, state FROM ontology_versions WHERE id = ?", ontologyID,
	).Scan(&ontologyProject, &ontologyState); err != nil {
		return KnowledgeGeneration{}, err
	}
	if ontologyState != "active" || (ontologyProject.Valid && ontologyProject.String != projectID) {
		return KnowledgeGeneration{}, errors.New("ontology is not active for the requested project")
	}
	var projectExists int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM projects WHERE id = ?", projectID).Scan(&projectExists); err != nil {
		return KnowledgeGeneration{}, err
	}
	if projectExists != 1 {
		return KnowledgeGeneration{}, sql.ErrNoRows
	}
	generationID, err := id.New("kgen")
	if err != nil {
		return KnowledgeGeneration{}, err
	}
	now := time.Now().UTC()
	if _, err := tx.ExecContext(ctx, `
INSERT INTO knowledge_generations(
  project_id, id, ontology_id, contract_sha256, manifest_sha256, state,
  source_count, entity_count, assertion_count, error,
  created_at, validating_at, ready_at, retired_at, failed_at
) VALUES(?, ?, ?, ?, '', 'building', 0, 0, 0, '', ?, NULL, NULL, NULL, NULL)`,
		projectID, generationID, ontologyID, strings.ToLower(contractSHA256), formatTime(now)); err != nil {
		return KnowledgeGeneration{}, err
	}
	generation, err := scanKnowledgeGeneration(tx.QueryRowContext(ctx,
		knowledgeGenerationSelect+" WHERE project_id = ? AND id = ?", projectID, generationID))
	if err != nil {
		return KnowledgeGeneration{}, err
	}
	if err := tx.Commit(); err != nil {
		return KnowledgeGeneration{}, err
	}
	return generation, nil
}

func (db *DB) KnowledgeGeneration(ctx context.Context, projectID, generationID string) (KnowledgeGeneration, error) {
	return scanKnowledgeGeneration(db.sql.QueryRowContext(ctx,
		knowledgeGenerationSelect+" WHERE project_id = ? AND id = ?", projectID, generationID))
}

func (db *DB) ActiveKnowledgeGeneration(ctx context.Context, projectID string) (KnowledgeHead, error) {
	return scanKnowledgeHead(db.sql.QueryRowContext(ctx, knowledgeHeadSelect+" WHERE h.project_id = ?", projectID))
}

func (db *DB) TransitionKnowledgeGeneration(
	ctx context.Context,
	projectID, generationID string,
	expected, next KnowledgeGenerationState,
	errorMessage string,
) (KnowledgeGeneration, error) {
	if !validKnowledgeTransition(expected, next) {
		return KnowledgeGeneration{}, fmt.Errorf("invalid knowledge generation transition %s -> %s", expected, next)
	}
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return KnowledgeGeneration{}, err
	}
	defer tx.Rollback()
	current, err := scanKnowledgeGeneration(tx.QueryRowContext(ctx,
		knowledgeGenerationSelect+" WHERE project_id = ? AND id = ?", projectID, generationID))
	if err != nil {
		return KnowledgeGeneration{}, err
	}
	if current.State != expected {
		return KnowledgeGeneration{}, fmt.Errorf("knowledge generation state conflict: expected %s, found %s", expected, current.State)
	}
	now := time.Now().UTC()
	switch next {
	case KnowledgeValidating:
		if _, err := tx.ExecContext(ctx, `
UPDATE knowledge_generations SET state = 'validating', validating_at = ?, error = ''
WHERE project_id = ? AND id = ? AND state = 'building'`, formatTime(now), projectID, generationID); err != nil {
			return KnowledgeGeneration{}, err
		}
	case KnowledgeReady:
		counts, manifest, err := validateKnowledgeGeneration(ctx, tx, projectID, generationID, current.OntologyID)
		if err != nil {
			return KnowledgeGeneration{}, err
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE knowledge_generations
SET state = 'ready', manifest_sha256 = ?, source_count = ?, entity_count = ?,
    assertion_count = ?, ready_at = ?, error = ''
WHERE project_id = ? AND id = ? AND state = 'validating'`,
			manifest, counts.sources, counts.entities, counts.assertions,
			formatTime(now), projectID, generationID); err != nil {
			return KnowledgeGeneration{}, err
		}
	case KnowledgeFailed:
		if strings.TrimSpace(errorMessage) == "" {
			return KnowledgeGeneration{}, errors.New("failed knowledge generation requires an error")
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE knowledge_generations SET state = 'failed', error = ?, failed_at = ?
WHERE project_id = ? AND id = ? AND state = ?`,
			errorMessage, formatTime(now), projectID, generationID, expected); err != nil {
			return KnowledgeGeneration{}, err
		}
	default:
		return KnowledgeGeneration{}, errors.New("knowledge transition must be performed through its dedicated operation")
	}
	updated, err := scanKnowledgeGeneration(tx.QueryRowContext(ctx,
		knowledgeGenerationSelect+" WHERE project_id = ? AND id = ?", projectID, generationID))
	if err != nil {
		return KnowledgeGeneration{}, err
	}
	if err := tx.Commit(); err != nil {
		return KnowledgeGeneration{}, err
	}
	return updated, nil
}

func validKnowledgeTransition(expected, next KnowledgeGenerationState) bool {
	return (expected == KnowledgeBuilding && (next == KnowledgeValidating || next == KnowledgeFailed)) ||
		(expected == KnowledgeValidating && (next == KnowledgeReady || next == KnowledgeFailed))
}

// ActivateKnowledgeGeneration retires the previous ready generation and swaps
// the project head in one immediate SQLite transaction.
func (db *DB) ActivateKnowledgeGeneration(ctx context.Context, projectID, generationID string) (KnowledgeHead, error) {
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return KnowledgeHead{}, err
	}
	defer tx.Rollback()
	candidate, err := scanKnowledgeGeneration(tx.QueryRowContext(ctx,
		knowledgeGenerationSelect+" WHERE project_id = ? AND id = ?", projectID, generationID))
	if err != nil {
		return KnowledgeHead{}, err
	}
	if candidate.State != KnowledgeReady || !validSHA256(candidate.ManifestSHA256) {
		return KnowledgeHead{}, errors.New("only a validated ready generation can become active")
	}
	if err := validateKnowledgeSnapshotBinding(ctx, tx, projectID, generationID, candidate.OntologyID, knowledgeCounts{
		sources: candidate.SourceCount, entities: candidate.EntityCount, assertions: candidate.AssertionCount,
	}); err != nil {
		return KnowledgeHead{}, fmt.Errorf("activate knowledge generation: %w", err)
	}
	now := time.Now().UTC()
	var previousGeneration string
	var previousRevision int64
	err = tx.QueryRowContext(ctx, `
SELECT generation_id, knowledge_revision FROM project_knowledge_heads WHERE project_id = ?`,
		projectID).Scan(&previousGeneration, &previousRevision)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if _, err := tx.ExecContext(ctx, `
INSERT INTO project_knowledge_heads(
  project_id, generation_id, knowledge_revision, status, error, activated_at, updated_at
) VALUES(?, ?, 1, 'ready', '', ?, ?)`, projectID, generationID, formatTime(now), formatTime(now)); err != nil {
			return KnowledgeHead{}, err
		}
	case err != nil:
		return KnowledgeHead{}, err
	case previousGeneration == generationID:
		if _, err := tx.ExecContext(ctx, `
UPDATE project_knowledge_heads
SET status = 'ready', error = '', knowledge_revision = knowledge_revision + 1, updated_at = ?
WHERE project_id = ? AND generation_id = ?`, formatTime(now), projectID, generationID); err != nil {
			return KnowledgeHead{}, err
		}
	default:
		if _, err := tx.ExecContext(ctx, `
UPDATE project_knowledge_heads
SET generation_id = ?, knowledge_revision = knowledge_revision + 1,
    status = 'ready', error = '', activated_at = ?, updated_at = ?
WHERE project_id = ? AND generation_id = ?`,
			generationID, formatTime(now), formatTime(now), projectID, previousGeneration); err != nil {
			return KnowledgeHead{}, err
		}
	}
	head, err := scanKnowledgeHead(tx.QueryRowContext(ctx, knowledgeHeadSelect+" WHERE h.project_id = ?", projectID))
	if err != nil {
		return KnowledgeHead{}, err
	}
	if err := tx.Commit(); err != nil {
		return KnowledgeHead{}, err
	}
	return head, nil
}

func (db *DB) SetKnowledgeHeadStatus(
	ctx context.Context,
	projectID string,
	expectedRevision int64,
	status KnowledgeHeadStatus,
	errorMessage string,
) (KnowledgeHead, error) {
	if status != KnowledgeHeadReady && status != KnowledgeHeadStale && status != KnowledgeHeadFailed {
		return KnowledgeHead{}, errors.New("invalid knowledge head status")
	}
	if status == KnowledgeHeadFailed && strings.TrimSpace(errorMessage) == "" {
		return KnowledgeHead{}, errors.New("failed knowledge head requires an error")
	}
	now := time.Now().UTC()
	result, err := db.sql.ExecContext(ctx, `
UPDATE project_knowledge_heads
SET status = ?, error = ?, knowledge_revision = knowledge_revision + 1, updated_at = ?
WHERE project_id = ? AND knowledge_revision = ?`,
		status, errorMessage, formatTime(now), projectID, expectedRevision)
	if err != nil {
		return KnowledgeHead{}, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("knowledge head revision conflict")
		}
		return KnowledgeHead{}, err
	}
	return db.ActiveKnowledgeGeneration(ctx, projectID)
}

func (db *DB) AppendKnowledgeCuration(
	ctx context.Context,
	projectID, generationID, kind, actor string,
	payload json.RawMessage,
) (KnowledgeCurationEvent, error) {
	if !knowledgeCurationKinds[kind] || strings.TrimSpace(actor) == "" || !json.Valid(payload) {
		return KnowledgeCurationEvent{}, errors.New("valid curation kind, actor, and JSON payload are required")
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, payload); err != nil {
		return KnowledgeCurationEvent{}, err
	}
	compactPayload := compact.Bytes()
	if len(compactPayload) == 0 || compactPayload[0] != '{' {
		return KnowledgeCurationEvent{}, errors.New("knowledge curation payload must be a JSON object")
	}
	var payloadMetadata curationMemoBinding
	if err := json.Unmarshal(compactPayload, &payloadMetadata); err != nil {
		return KnowledgeCurationEvent{}, errors.New("knowledge curation payload must be a JSON object")
	}
	var payloadFields map[string]json.RawMessage
	if err := json.Unmarshal(compactPayload, &payloadFields); err != nil {
		return KnowledgeCurationEvent{}, errors.New("knowledge curation payload must be a JSON object")
	}
	if _, hasRawMemo := payloadFields["memo"]; hasRawMemo {
		return KnowledgeCurationEvent{}, errors.New("raw curation memo text must be replaced by a server-verified CAS binding")
	}
	payloadSum := sha256.Sum256(compactPayload)
	payloadHash := hex.EncodeToString(payloadSum[:])
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return KnowledgeCurationEvent{}, err
	}
	defer tx.Rollback()
	var activeGeneration string
	if err := tx.QueryRowContext(ctx, `
SELECT generation_id FROM project_knowledge_heads
WHERE project_id = ?`, projectID).Scan(&activeGeneration); err != nil {
		return KnowledgeCurationEvent{}, err
	}
	if activeGeneration != generationID {
		return KnowledgeCurationEvent{}, errors.New("curation targets a non-active knowledge generation")
	}
	if err := validateCurationMemoBinding(ctx, tx, projectID, payloadMetadata); err != nil {
		return KnowledgeCurationEvent{}, err
	}
	var previous string
	err = tx.QueryRowContext(ctx, `
SELECT event_sha256 FROM knowledge_curation_events
WHERE project_id = ? AND generation_id = ? ORDER BY sequence DESC LIMIT 1`,
		projectID, generationID).Scan(&previous)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return KnowledgeCurationEvent{}, err
	}
	eventID, err := id.New("kcur")
	if err != nil {
		return KnowledgeCurationEvent{}, err
	}
	now := time.Now().UTC()
	eventMaterial := strings.Join([]string{
		previous, eventID, projectID, generationID, kind, actor, payloadHash, formatTime(now),
	}, "\n")
	eventSum := sha256.Sum256([]byte(eventMaterial))
	eventHash := hex.EncodeToString(eventSum[:])
	result, err := tx.ExecContext(ctx, `
INSERT INTO knowledge_curation_events(
  id, project_id, generation_id, kind, actor, payload_json, payload_sha256,
  previous_event_sha256, event_sha256, created_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		eventID, projectID, generationID, kind, actor, string(compactPayload), payloadHash,
		previous, eventHash, formatTime(now))
	if err != nil {
		return KnowledgeCurationEvent{}, err
	}
	sequence, err := result.LastInsertId()
	if err != nil {
		return KnowledgeCurationEvent{}, err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE project_knowledge_heads
SET status='stale',error='curation pending verified shadow rebuild',
    knowledge_revision = knowledge_revision + 1, updated_at = ?
WHERE project_id = ? AND generation_id = ?`, formatTime(now), projectID, generationID); err != nil {
		return KnowledgeCurationEvent{}, err
	}
	if err := tx.Commit(); err != nil {
		return KnowledgeCurationEvent{}, err
	}
	return KnowledgeCurationEvent{
		Sequence: sequence, ID: eventID, ProjectID: projectID, GenerationID: generationID,
		Kind: kind, Actor: actor, Payload: append(json.RawMessage(nil), compactPayload...),
		PayloadSHA256: payloadHash, PreviousEventSHA256: previous,
		EventSHA256: eventHash, CreatedAt: now,
	}, nil
}

type curationMemoChunkBinding struct {
	ChunkID    string `json:"chunk_id"`
	StartByte  int    `json:"start_byte"`
	EndByte    int    `json:"end_byte"`
	SpanSHA256 string `json:"span_sha256"`
}

type curationMemoBinding struct {
	MemoBlobHash   string                     `json:"memo_blob_hash"`
	MemoDocumentID string                     `json:"memo_document_id"`
	MemoStartByte  int                        `json:"memo_start_byte"`
	MemoEndByte    int                        `json:"memo_end_byte"`
	MemoSpanSHA256 string                     `json:"memo_span_sha256"`
	MemoChunks     []curationMemoChunkBinding `json:"memo_chunks"`
}

func validateCurationMemoBinding(ctx context.Context, tx *sql.Tx, projectID string, binding curationMemoBinding) error {
	present := binding.MemoBlobHash != "" || binding.MemoDocumentID != "" || binding.MemoStartByte != 0 ||
		binding.MemoEndByte != 0 || binding.MemoSpanSHA256 != "" || len(binding.MemoChunks) != 0
	if !present {
		return nil
	}
	if !validSHA256(binding.MemoBlobHash) || !validSHA256(binding.MemoSpanSHA256) ||
		binding.MemoDocumentID == "" || binding.MemoStartByte != 0 || binding.MemoEndByte <= 0 ||
		binding.MemoSpanSHA256 != binding.MemoBlobHash || len(binding.MemoChunks) == 0 {
		return errors.New("knowledge curation memo binding is incomplete or invalid")
	}
	var blobSize int
	if err := tx.QueryRowContext(ctx, `SELECT size FROM blobs WHERE hash=?`, binding.MemoBlobHash).Scan(&blobSize); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("knowledge curation memo blob is not registered")
		}
		return err
	}
	if binding.MemoEndByte != blobSize {
		return errors.New("knowledge curation memo CAS span does not cover the registered blob")
	}
	var documentBlob, status string
	var pinned, curationMemo int
	if err := tx.QueryRowContext(ctx, `
SELECT blob_hash,status,pinned,curation_memo FROM documents
WHERE id=? AND project_id=?`, binding.MemoDocumentID, projectID).Scan(&documentBlob, &status, &pinned, &curationMemo); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("knowledge curation memo document does not belong to the project")
		}
		return err
	}
	if documentBlob != binding.MemoBlobHash || status != "ready" || pinned != 1 || curationMemo != 1 {
		return errors.New("knowledge curation memo document is not a ready pinned copy of the CAS blob")
	}
	var chunkCount int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM chunks WHERE document_id=?`, binding.MemoDocumentID).Scan(&chunkCount); err != nil {
		return err
	}
	if chunkCount == 0 || chunkCount != len(binding.MemoChunks) {
		return errors.New("knowledge curation memo binding does not cover every deterministic chunk")
	}
	seen := make(map[string]bool, len(binding.MemoChunks))
	for _, chunk := range binding.MemoChunks {
		if chunk.ChunkID == "" || seen[chunk.ChunkID] || chunk.StartByte != 0 ||
			chunk.EndByte <= 0 || !validSHA256(chunk.SpanSHA256) {
			return errors.New("knowledge curation memo chunk binding is invalid or duplicated")
		}
		seen[chunk.ChunkID] = true
		var text, textHash string
		if err := tx.QueryRowContext(ctx, `
SELECT text,text_hash FROM chunks WHERE id=? AND document_id=?`, chunk.ChunkID, binding.MemoDocumentID).Scan(&text, &textHash); err != nil {
			return errors.New("knowledge curation memo chunk does not belong to the pinned document")
		}
		data := []byte(text)
		if !utf8.Valid(data) || chunk.EndByte != len(data) || !utf8.Valid(data[chunk.StartByte:chunk.EndByte]) {
			return errors.New("knowledge curation memo chunk span is not valid UTF-8")
		}
		sum := sha256.Sum256(data[chunk.StartByte:chunk.EndByte])
		actual := hex.EncodeToString(sum[:])
		if actual != textHash || actual != chunk.SpanSHA256 {
			return errors.New("knowledge curation memo chunk hash/span mismatch")
		}
	}
	return nil
}

// MarkCurationMemoDocument grants a ready pinned non-artifact document the
// narrow right to serve as deterministic curation provenance. It does not set
// graph_adopt and therefore never schedules the document for LLM extraction.
func (db *DB) MarkCurationMemoDocument(ctx context.Context, projectID, documentID, blobHash string) error {
	if projectID == "" || documentID == "" || !validSHA256(blobHash) {
		return errors.New("curation memo project, document, and blob hash are required")
	}
	result, err := db.sql.ExecContext(ctx, `
UPDATE documents SET curation_memo=1
WHERE id=? AND project_id=? AND blob_hash=? AND status='ready' AND pinned=1
  AND artifact_id IS NULL`, documentID, projectID, blobHash)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("curation memo document is not a ready pinned project document")
		}
		return err
	}
	return nil
}

func (db *DB) SetDocumentGraphAdopt(ctx context.Context, projectID, documentID string, adopted bool) error {
	value := 0
	if adopted {
		value = 1
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	if err := rejectMemoryMutationWithProjectWork(ctx, transaction, projectID); err != nil {
		return err
	}
	result, err := transaction.ExecContext(ctx, `
UPDATE documents SET graph_adopt = ?, updated_at = ?
WHERE id = ? AND project_id = ? AND status = 'ready'`,
		value, formatTime(time.Now()), documentID, projectID)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = sql.ErrNoRows
		}
		return err
	}
	return transaction.Commit()
}

type knowledgeCounts struct {
	sources    int
	entities   int
	assertions int
}

// MarkKnowledgeHeadFailedForGeneration fails closed only when generationID is
// still the active head. A retired run-pinned generation cannot poison a newer
// project head, but its caller still receives the verification error.
func (db *DB) MarkKnowledgeHeadFailedForGeneration(ctx context.Context, projectID, generationID string, cause error) error {
	head, err := db.ActiveKnowledgeGeneration(ctx, projectID)
	if err != nil {
		return err
	}
	if head.GenerationID != generationID {
		return nil
	}
	message := "knowledge snapshot verification failed"
	if cause != nil {
		message = cause.Error()
	}
	_, err = db.SetKnowledgeHeadStatus(ctx, projectID, head.KnowledgeRevision, KnowledgeHeadFailed, message)
	return err
}

func validateKnowledgeGeneration(
	ctx context.Context,
	tx *sql.Tx,
	projectID, generationID, ontologyID string,
) (knowledgeCounts, string, error) {
	var counts knowledgeCounts
	if err := validateKnowledgeAssertionIntervals(ctx, tx, projectID, generationID); err != nil {
		return knowledgeCounts{}, "", err
	}
	for query, target := range map[string]*int{
		"SELECT COUNT(*) FROM knowledge_sources WHERE project_id = ? AND generation_id = ?":    &counts.sources,
		"SELECT COUNT(*) FROM knowledge_entities WHERE project_id = ? AND generation_id = ?":   &counts.entities,
		"SELECT COUNT(*) FROM knowledge_assertions WHERE project_id = ? AND generation_id = ?": &counts.assertions,
	} {
		if err := tx.QueryRowContext(ctx, query, projectID, generationID).Scan(target); err != nil {
			return knowledgeCounts{}, "", err
		}
	}
	checks := []struct {
		query   string
		message string
		args    []any
	}{
		{`SELECT COUNT(*) FROM (
  SELECT assertion_key
  FROM knowledge_assertions
  WHERE project_id = ? AND generation_id = ?
  GROUP BY assertion_key
  HAVING COUNT(*) > 1
)`,
			"knowledge generation contains duplicate assertion keys", []any{projectID, generationID}},
		{`WITH reachable(ontology_id) AS (
  SELECT ?
  UNION
  SELECT imported_ontology_id FROM ontology_imports WHERE ontology_id = ?
)
SELECT COUNT(*) FROM knowledge_entities e
WHERE e.project_id = ? AND e.generation_id = ? AND NOT EXISTS (
  SELECT 1 FROM ontology_terms t
  WHERE t.term_key = e.class_key AND t.kind = 'class' AND (
    t.ontology_id = ? OR (
      t.ontology_id IN (SELECT ontology_id FROM reachable WHERE ontology_id <> ?)
      AND NOT EXISTS (
        SELECT 1 FROM ontology_terms own
        WHERE own.ontology_id = ? AND own.term_key = e.class_key
      )
    )
  )
)`,
			"knowledge entity references an unknown ontology class",
			[]any{ontologyID, ontologyID, projectID, generationID, ontologyID, ontologyID, ontologyID}},
		{`SELECT COUNT(*) FROM knowledge_entities e
LEFT JOIN knowledge_mentions m ON m.project_id = e.project_id AND m.generation_id = e.generation_id AND m.entity_id = e.id
WHERE e.project_id = ? AND e.generation_id = ? AND m.id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM knowledge_assertions a
    JOIN knowledge_assertion_evidence ae
      ON ae.project_id = a.project_id AND ae.generation_id = a.generation_id
     AND ae.assertion_id = a.id AND ae.evidence_kind = 'artifact_value'
    WHERE a.project_id = e.project_id AND a.generation_id = e.generation_id
      AND (
        a.subject_entity_id = e.id OR a.object_entity_id = e.id OR EXISTS (
          SELECT 1 FROM json_each(a.qualifiers_json) q
          WHERE json_extract(q.value, '$.entity_id') = e.id
        )
      )
  )`,
			"knowledge entity has neither a source mention nor artifact-backed assertion provenance", []any{projectID, generationID}},
		{`WITH reachable(ontology_id) AS (
  SELECT ?
  UNION
  SELECT imported_ontology_id FROM ontology_imports WHERE ontology_id = ?
)
SELECT COUNT(*) FROM knowledge_assertions a
WHERE a.project_id = ? AND a.generation_id = ? AND NOT EXISTS (
  SELECT 1 FROM ontology_terms t
  WHERE t.term_key = a.predicate_key
    AND ((a.object_entity_id IS NOT NULL AND t.kind = 'object_property' AND t.value_kind = 'entity')
      OR (a.object_entity_id IS NULL AND t.kind = 'datatype_property' AND t.value_kind <> 'entity'))
    AND (
      t.ontology_id = ? OR (
        t.ontology_id IN (SELECT ontology_id FROM reachable WHERE ontology_id <> ?)
        AND NOT EXISTS (
          SELECT 1 FROM ontology_terms own
          WHERE own.ontology_id = ? AND own.term_key = a.predicate_key
        )
      )
    )
)`,
			"knowledge assertion references an incompatible ontology predicate",
			[]any{ontologyID, ontologyID, projectID, generationID, ontologyID, ontologyID, ontologyID}},
		{`SELECT COUNT(*) FROM knowledge_assertions a
LEFT JOIN knowledge_assertion_evidence e
 ON e.project_id = a.project_id AND e.generation_id = a.generation_id AND e.assertion_id = a.id
WHERE a.project_id = ? AND a.generation_id = ? AND e.assertion_id IS NULL`,
			"knowledge assertion has no evidence", []any{projectID, generationID}},
		{`SELECT COUNT(*) FROM knowledge_inferences i
LEFT JOIN knowledge_inference_proofs p
 ON p.project_id = i.project_id AND p.generation_id = i.generation_id AND p.inference_id = i.id
WHERE i.project_id = ? AND i.generation_id = ? AND p.inference_id IS NULL`,
			"knowledge inference has no proof", []any{projectID, generationID}},
		{`SELECT COUNT(*) FROM knowledge_type_inferences i
LEFT JOIN knowledge_type_inference_proofs p
 ON p.project_id = i.project_id AND p.generation_id = i.generation_id AND p.inference_id = i.id
WHERE i.project_id = ? AND i.generation_id = ? AND p.inference_id IS NULL`,
			"knowledge type inference has no proof", []any{projectID, generationID}},
		{`SELECT COUNT(*)
FROM ontology_terms own
JOIN ontology_imports oi ON oi.ontology_id=own.ontology_id
JOIN ontology_terms imported ON imported.ontology_id=oi.imported_ontology_id
 AND imported.term_key=own.term_key AND imported.iri<>own.iri
WHERE own.ontology_id=?`,
			"generation ontology has an owner/import term-key collision", []any{ontologyID}},
		{`SELECT COUNT(*) FROM knowledge_extraction_batches
WHERE project_id = ? AND generation_id = ? AND status <> 'applied'`,
			"knowledge extraction batch is not applied", []any{projectID, generationID}},
	}
	for _, check := range checks {
		var invalid int
		if err := tx.QueryRowContext(ctx, check.query, check.args...).Scan(&invalid); err != nil {
			return knowledgeCounts{}, "", err
		}
		if invalid != 0 {
			return knowledgeCounts{}, "", fmt.Errorf("%s (%d rows)", check.message, invalid)
		}
	}
	if err := validateKnowledgeSpans(ctx, tx, projectID, generationID); err != nil {
		return knowledgeCounts{}, "", err
	}
	if err := validateKnowledgeRelationInferenceProofs(ctx, tx, projectID, generationID); err != nil {
		return knowledgeCounts{}, "", err
	}
	if err := validateKnowledgeTypeInferenceProofs(ctx, tx, projectID, generationID); err != nil {
		return knowledgeCounts{}, "", err
	}
	if err := validateKnowledgeSnapshotBinding(ctx, tx, projectID, generationID, ontologyID, counts); err != nil {
		return knowledgeCounts{}, "", err
	}
	manifest, err := knowledgeManifest(ctx, tx, projectID, generationID)
	if err != nil {
		return knowledgeCounts{}, "", err
	}
	return counts, manifest, nil
}

func validateKnowledgeAssertionIntervals(ctx context.Context, queryer knowledgeRDFQueryer, projectID, generationID string) error {
	rows, err := queryer.QueryContext(ctx, `
SELECT id,COALESCE(valid_from,''),COALESCE(valid_to,'')
FROM knowledge_assertions WHERE project_id=? AND generation_id=? ORDER BY id`, projectID, generationID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var assertionID, validFrom, validTo string
		if err := rows.Scan(&assertionID, &validFrom, &validTo); err != nil {
			return err
		}
		if _, _, err := core.CanonicalKnowledgeInterval(validFrom, validTo); err != nil {
			return fmt.Errorf("knowledge assertion %s has an invalid validity interval: %w", assertionID, err)
		}
	}
	return rows.Err()
}

// AuditActiveKnowledgeIntervals is the startup fail-closed boundary for
// historical rows. It reads legacy RFC3339Nano encodings semantically, but an
// invalid or reversed active interval marks the project head failed before
// retrieval or scheduling can resume.
func (db *DB) AuditActiveKnowledgeIntervals(ctx context.Context, projectID string) error {
	head, err := db.ActiveKnowledgeGeneration(ctx, projectID)
	if err != nil {
		return err
	}
	if err := validateKnowledgeAssertionIntervals(ctx, db.sql, projectID, head.GenerationID); err != nil {
		auditErr := fmt.Errorf("active knowledge validity audit failed: %w", err)
		if head.Status == KnowledgeHeadFailed {
			return auditErr
		}
		if _, markErr := db.SetKnowledgeHeadStatus(
			context.WithoutCancel(ctx), projectID, head.KnowledgeRevision, KnowledgeHeadFailed, auditErr.Error(),
		); markErr != nil {
			return errors.Join(auditErr, fmt.Errorf("mark invalid knowledge head failed: %w", markErr))
		}
		return auditErr
	}
	return nil
}

type storedTypeInference struct {
	id, entityID, classKey, ontologyID, axiomID, status string
}

type storedTypeProof struct {
	kind, entityID, classKey, assertionID, typeInferenceID string
	ordinal                                                int
}

type storedTypeAxiom struct {
	kind, subject, object string
}

type storedTypeAssertion struct {
	subject, predicate, object, polarity, status string
}

func validateKnowledgeTypeInferenceProofs(ctx context.Context, tx *sql.Tx, projectID, generationID string) error {
	inferences := map[string]storedTypeInference{}
	rows, err := tx.QueryContext(ctx, `
SELECT id,entity_id,class_key,ontology_id,rule_axiom_id,status
FROM knowledge_type_inferences WHERE project_id=? AND generation_id=?`, projectID, generationID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var value storedTypeInference
		if err := rows.Scan(&value.id, &value.entityID, &value.classKey, &value.ontologyID, &value.axiomID, &value.status); err != nil {
			rows.Close()
			return err
		}
		inferences[value.id] = value
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(inferences) == 0 {
		return nil
	}
	proofs := map[string][]storedTypeProof{}
	rows, err = tx.QueryContext(ctx, `
SELECT inference_id,ordinal,premise_kind,COALESCE(premise_entity_id,''),premise_class_key,
       COALESCE(premise_assertion_id,''),COALESCE(premise_type_inference_id,'')
FROM knowledge_type_inference_proofs
WHERE project_id=? AND generation_id=? ORDER BY inference_id,ordinal`, projectID, generationID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var inferenceID string
		var value storedTypeProof
		if err := rows.Scan(&inferenceID, &value.ordinal, &value.kind, &value.entityID, &value.classKey,
			&value.assertionID, &value.typeInferenceID); err != nil {
			rows.Close()
			return err
		}
		proofs[inferenceID] = append(proofs[inferenceID], value)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	axioms := map[string]storedTypeAxiom{}
	rows, err = tx.QueryContext(ctx, `
SELECT ontology_id,id,axiom_type,subject_key,object_key FROM ontology_axioms
WHERE ontology_id IN(
 SELECT ontology_id FROM knowledge_generations WHERE project_id=? AND id=?
 UNION SELECT oi.imported_ontology_id FROM knowledge_generations g
 JOIN ontology_imports oi ON oi.ontology_id=g.ontology_id
 WHERE g.project_id=? AND g.id=?
)`, projectID, generationID, projectID, generationID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var ontologyID, axiomID string
		var value storedTypeAxiom
		if err := rows.Scan(&ontologyID, &axiomID, &value.kind, &value.subject, &value.object); err != nil {
			rows.Close()
			return err
		}
		axioms[ontologyID+"\x00"+axiomID] = value
	}
	if err := rows.Close(); err != nil {
		return err
	}
	entityClasses := map[string]string{}
	rows, err = tx.QueryContext(ctx, `SELECT id,class_key FROM knowledge_entities WHERE project_id=? AND generation_id=?`, projectID, generationID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, classKey string
		if err := rows.Scan(&id, &classKey); err != nil {
			rows.Close()
			return err
		}
		entityClasses[id] = classKey
	}
	if err := rows.Close(); err != nil {
		return err
	}
	assertions := map[string]storedTypeAssertion{}
	rows, err = tx.QueryContext(ctx, `
SELECT id,subject_entity_id,predicate_key,COALESCE(object_entity_id,''),polarity,status
FROM knowledge_assertions WHERE project_id=? AND generation_id=?`, projectID, generationID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id string
		var value storedTypeAssertion
		if err := rows.Scan(&id, &value.subject, &value.predicate, &value.object, &value.polarity, &value.status); err != nil {
			rows.Close()
			return err
		}
		assertions[id] = value
	}
	if err := rows.Close(); err != nil {
		return err
	}
	state := map[string]int{}
	var validate func(string) error
	validate = func(id string) error {
		if state[id] == 1 {
			return fmt.Errorf("knowledge type inference proof cycle at %s", id)
		}
		if state[id] == 2 {
			return nil
		}
		inference, ok := inferences[id]
		if !ok || inference.status != "accepted" {
			return fmt.Errorf("knowledge type inference %s is missing or not accepted", id)
		}
		items := proofs[id]
		if len(items) != 1 || items[0].ordinal != 0 {
			return fmt.Errorf("knowledge type inference %s must have exactly one ordinal-zero proof", id)
		}
		axiom, ok := axioms[inference.ontologyID+"\x00"+inference.axiomID]
		if !ok || inference.classKey != axiom.object {
			return fmt.Errorf("knowledge type inference %s conclusion does not match its axiom", id)
		}
		proof := items[0]
		state[id] = 1
		switch axiom.kind {
		case "subclass_of":
			switch proof.kind {
			case "entity_class":
				if proof.entityID != inference.entityID || proof.classKey != axiom.subject || entityClasses[proof.entityID] != proof.classKey {
					return fmt.Errorf("knowledge type inference %s has an invalid entity-class premise", id)
				}
			case "type_inference":
				parent, ok := inferences[proof.typeInferenceID]
				if !ok || parent.entityID != inference.entityID || parent.classKey != axiom.subject || parent.status != "accepted" {
					return fmt.Errorf("knowledge type inference %s has an invalid inferred-type premise", id)
				}
				if err := validate(parent.id); err != nil {
					return err
				}
			default:
				return fmt.Errorf("knowledge type inference %s subclass proof has the wrong premise kind", id)
			}
		case "domain", "range":
			if proof.kind != "assertion" {
				return fmt.Errorf("knowledge type inference %s property proof has the wrong premise kind", id)
			}
			assertion, ok := assertions[proof.assertionID]
			if !ok || assertion.status != "accepted" || assertion.polarity != "affirmed" || assertion.predicate != axiom.subject {
				return fmt.Errorf("knowledge type inference %s has an invalid assertion premise", id)
			}
			if axiom.kind == "domain" && assertion.subject != inference.entityID {
				return fmt.Errorf("knowledge type inference %s domain entity does not match", id)
			}
			if axiom.kind == "range" && assertion.object != inference.entityID {
				return fmt.Errorf("knowledge type inference %s range entity does not match", id)
			}
		default:
			return fmt.Errorf("knowledge type inference %s uses unsupported axiom %s", id, axiom.kind)
		}
		state[id] = 2
		return nil
	}
	for id := range inferences {
		if err := validate(id); err != nil {
			return err
		}
	}
	return nil
}

func validateKnowledgeSpans(ctx context.Context, tx *sql.Tx, projectID, generationID string) error {
	queries := []struct {
		name  string
		query string
	}{
		{"entity mention", `SELECT m.id, m.start_byte, m.end_byte, m.excerpt_sha256, c.text
FROM knowledge_mentions m JOIN chunks c ON c.id = m.chunk_id
WHERE m.project_id = ? AND m.generation_id = ?`},
		{"assertion evidence", `SELECT e.assertion_id, e.start_byte, e.end_byte, e.evidence_sha256, c.text
FROM knowledge_assertion_evidence e JOIN chunks c ON c.id = e.chunk_id
WHERE e.project_id = ? AND e.generation_id = ? AND e.evidence_kind = 'text_span'`},
	}
	for _, item := range queries {
		rows, err := tx.QueryContext(ctx, item.query, projectID, generationID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var sourceID, expectedHash, text string
			var start, end int
			if err := rows.Scan(&sourceID, &start, &end, &expectedHash, &text); err != nil {
				rows.Close()
				return err
			}
			data := []byte(text)
			if start < 0 || end <= start || end > len(data) || !utf8.Valid(data[start:end]) ||
				(start < len(data) && data[start]&0xc0 == 0x80) || (end < len(data) && data[end]&0xc0 == 0x80) {
				rows.Close()
				return fmt.Errorf("%s %s has an invalid UTF-8 byte span", item.name, sourceID)
			}
			sum := sha256.Sum256(data[start:end])
			if hex.EncodeToString(sum[:]) != expectedHash {
				rows.Close()
				return fmt.Errorf("%s %s evidence hash mismatch", item.name, sourceID)
			}
		}
		if err := rows.Close(); err != nil {
			return err
		}
		if err := rows.Err(); err != nil {
			return err
		}
	}
	return nil
}

func knowledgeManifest(ctx context.Context, tx *sql.Tx, projectID, generationID string) (string, error) {
	digest := sha256.New()
	queries := []string{
		`SELECT json_object('chunk',chunk_id,'blob',blob_hash,'text_hash',text_hash,'kind',source_kind,'locator',source_locator_json)
 FROM knowledge_sources WHERE project_id = ? AND generation_id = ? ORDER BY chunk_id`,
		`SELECT json_object('id',id,'class',class_key,'name',canonical_name,'normalized',normalized_name,'description',description,'identity',identity_key)
 FROM knowledge_entities WHERE project_id = ? AND generation_id = ? ORDER BY id`,
		`SELECT json_object('entity',entity_id,'alias',alias,'normalized',normalized_alias,'language',language)
 FROM knowledge_aliases WHERE project_id = ? AND generation_id = ? ORDER BY entity_id, normalized_alias`,
		`SELECT json_object('id',id,'entity',entity_id,'chunk',chunk_id,'start',start_byte,'end',end_byte,'hash',excerpt_sha256)
 FROM knowledge_mentions WHERE project_id = ? AND generation_id = ? ORDER BY id`,
		`SELECT json_object('id',id,'subject',subject_entity_id,'predicate',predicate_key,'object',object_entity_id,
 'literal',literal_json,'qualifiers',qualifiers_json,'polarity',polarity,'from',valid_from,'to',valid_to,
 'status',status,'confidence',confidence,'key',assertion_key)
 FROM knowledge_assertions WHERE project_id = ? AND generation_id = ? ORDER BY id`,
		`SELECT json_object('assertion',assertion_id,'kind',evidence_kind,'blob',blob_hash,'chunk',chunk_id,
 'claim',claim_id,'source',source_id,'start',start_byte,'end',end_byte,'locator',locator_json,'hash',evidence_sha256)
 FROM knowledge_assertion_evidence WHERE project_id = ? AND generation_id = ?
 ORDER BY assertion_id, evidence_kind, blob_hash, evidence_sha256`,
		`SELECT json_object('id',id,'left',left_assertion_id,'right',right_assertion_id,'reason',reason,'status',status)
 FROM knowledge_conflicts WHERE project_id = ? AND generation_id = ? ORDER BY id`,
		`SELECT json_object('id',id,'conclusion',conclusion_assertion_id,'ontology',ontology_id,'axiom',rule_axiom_id,'status',status)
 FROM knowledge_inferences WHERE project_id = ? AND generation_id = ? ORDER BY id`,
		`SELECT json_object('inference',inference_id,'ordinal',ordinal,'premise',premise_assertion_id)
 FROM knowledge_inference_proofs WHERE project_id = ? AND generation_id = ? ORDER BY inference_id, ordinal`,
		`SELECT json_object('id',id,'entity',entity_id,'class',class_key,'ontology',ontology_id,'axiom',rule_axiom_id,'status',status)
 FROM knowledge_type_inferences WHERE project_id = ? AND generation_id = ? ORDER BY id`,
		`SELECT json_object('inference',inference_id,'ordinal',ordinal,'kind',premise_kind,'entity',premise_entity_id,
 'class',premise_class_key,'assertion',premise_assertion_id,'type_inference',premise_type_inference_id)
 FROM knowledge_type_inference_proofs WHERE project_id = ? AND generation_id = ? ORDER BY inference_id, ordinal`,
		`SELECT json_object('id',id,'format',format,'blob',blob_hash,'dataset',dataset_sha256,'triples',triple_count)
 FROM knowledge_rdf_snapshots WHERE project_id = ? AND generation_id = ? ORDER BY id`,
	}
	for _, query := range queries {
		if err := hashKnowledgeRows(ctx, tx, digest, query, projectID, generationID); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func hashKnowledgeRows(ctx context.Context, tx *sql.Tx, digest hash.Hash, query string, args ...any) error {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return err
		}
		_, _ = digest.Write([]byte(value))
		_, _ = digest.Write([]byte{'\n'})
	}
	return rows.Err()
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 || value != strings.ToLower(value) {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}

const knowledgeGenerationSelect = `
SELECT project_id, id, ontology_id, contract_sha256, manifest_sha256, state,
       source_count, entity_count, assertion_count, error,
       created_at, validating_at, ready_at, retired_at, failed_at
FROM knowledge_generations`

func scanKnowledgeGeneration(row scanner) (KnowledgeGeneration, error) {
	var generation KnowledgeGeneration
	var created string
	var validating, ready, retired, failed sql.NullString
	if err := row.Scan(
		&generation.ProjectID, &generation.ID, &generation.OntologyID,
		&generation.ContractSHA256, &generation.ManifestSHA256, &generation.State,
		&generation.SourceCount, &generation.EntityCount, &generation.AssertionCount,
		&generation.Error, &created, &validating, &ready, &retired, &failed,
	); err != nil {
		return KnowledgeGeneration{}, err
	}
	var err error
	generation.CreatedAt, err = parseTime(created)
	if err != nil {
		return KnowledgeGeneration{}, err
	}
	if generation.ValidatingAt, err = nullableTime(validating); err != nil {
		return KnowledgeGeneration{}, err
	}
	if generation.ReadyAt, err = nullableTime(ready); err != nil {
		return KnowledgeGeneration{}, err
	}
	if generation.RetiredAt, err = nullableTime(retired); err != nil {
		return KnowledgeGeneration{}, err
	}
	generation.FailedAt, err = nullableTime(failed)
	return generation, err
}

const knowledgeHeadSelect = `
SELECT h.project_id, h.generation_id, h.knowledge_revision, h.status, h.error,
       h.activated_at, h.updated_at,
       g.project_id, g.id, g.ontology_id, g.contract_sha256, g.manifest_sha256, g.state,
       g.source_count, g.entity_count, g.assertion_count, g.error,
       g.created_at, g.validating_at, g.ready_at, g.retired_at, g.failed_at
FROM project_knowledge_heads h
JOIN knowledge_generations g ON g.project_id = h.project_id AND g.id = h.generation_id`

func scanKnowledgeHead(row scanner) (KnowledgeHead, error) {
	var head KnowledgeHead
	var activated, updated string
	var created string
	var validating, ready, retired, failed sql.NullString
	if err := row.Scan(
		&head.ProjectID, &head.GenerationID, &head.KnowledgeRevision, &head.Status,
		&head.Error, &activated, &updated,
		&head.Generation.ProjectID, &head.Generation.ID, &head.Generation.OntologyID,
		&head.Generation.ContractSHA256, &head.Generation.ManifestSHA256, &head.Generation.State,
		&head.Generation.SourceCount, &head.Generation.EntityCount, &head.Generation.AssertionCount,
		&head.Generation.Error, &created, &validating, &ready, &retired, &failed,
	); err != nil {
		return KnowledgeHead{}, err
	}
	var err error
	if head.ActivatedAt, err = parseTime(activated); err != nil {
		return KnowledgeHead{}, err
	}
	if head.UpdatedAt, err = parseTime(updated); err != nil {
		return KnowledgeHead{}, err
	}
	if head.Generation.CreatedAt, err = parseTime(created); err != nil {
		return KnowledgeHead{}, err
	}
	if head.Generation.ValidatingAt, err = nullableTime(validating); err != nil {
		return KnowledgeHead{}, err
	}
	if head.Generation.ReadyAt, err = nullableTime(ready); err != nil {
		return KnowledgeHead{}, err
	}
	if head.Generation.RetiredAt, err = nullableTime(retired); err != nil {
		return KnowledgeHead{}, err
	}
	head.Generation.FailedAt, err = nullableTime(failed)
	return head, err
}
