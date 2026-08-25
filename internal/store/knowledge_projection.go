package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
)

type KnowledgeSourceRecord struct {
	ChunkID       string          `json:"chunk_id"`
	BlobHash      string          `json:"blob_hash"`
	SourceKind    string          `json:"source_kind"`
	SourceLocator json.RawMessage `json:"source_locator"`
	TextHash      string          `json:"text_hash"`
}

type KnowledgeEntityRecord struct {
	ID             string `json:"id"`
	ClassKey       string `json:"class_key"`
	CanonicalName  string `json:"canonical_name"`
	NormalizedName string `json:"normalized_name"`
	Description    string `json:"description,omitempty"`
	IdentityKey    string `json:"identity_key,omitempty"`
}

type KnowledgeAliasRecord struct {
	EntityID        string `json:"entity_id"`
	Alias           string `json:"alias"`
	NormalizedAlias string `json:"normalized_alias"`
	Language        string `json:"language,omitempty"`
}

type KnowledgeMentionRecord struct {
	ID            string `json:"id"`
	EntityID      string `json:"entity_id"`
	ChunkID       string `json:"chunk_id"`
	StartByte     int    `json:"start_byte"`
	EndByte       int    `json:"end_byte"`
	ExcerptSHA256 string `json:"excerpt_sha256"`
}

type KnowledgeAssertionRecord struct {
	ID              string          `json:"id"`
	SubjectEntityID string          `json:"subject_entity_id"`
	PredicateKey    string          `json:"predicate_key"`
	ObjectEntityID  string          `json:"object_entity_id,omitempty"`
	Literal         json.RawMessage `json:"literal,omitempty"`
	Qualifiers      json.RawMessage `json:"qualifiers"`
	Polarity        string          `json:"polarity"`
	ValidFrom       *time.Time      `json:"valid_from,omitempty"`
	ValidTo         *time.Time      `json:"valid_to,omitempty"`
	Status          string          `json:"status"`
	Confidence      float64         `json:"confidence"`
	AssertionKey    string          `json:"assertion_key"`
}

type KnowledgeAssertionEvidenceRecord struct {
	AssertionID    string          `json:"assertion_id"`
	EvidenceKind   string          `json:"evidence_kind"`
	BlobHash       string          `json:"blob_hash"`
	ChunkID        string          `json:"chunk_id,omitempty"`
	ClaimID        string          `json:"claim_id,omitempty"`
	SourceID       string          `json:"source_id,omitempty"`
	StartByte      *int            `json:"start_byte,omitempty"`
	EndByte        *int            `json:"end_byte,omitempty"`
	Locator        json.RawMessage `json:"locator"`
	EvidenceSHA256 string          `json:"evidence_sha256"`
}

type KnowledgeConflictRecord struct {
	ID               string `json:"id"`
	LeftAssertionID  string `json:"left_assertion_id"`
	RightAssertionID string `json:"right_assertion_id"`
	Reason           string `json:"reason"`
	Status           string `json:"status"`
}

type KnowledgeInferenceRecord struct {
	ID                    string `json:"id"`
	ConclusionAssertionID string `json:"conclusion_assertion_id"`
	OntologyID            string `json:"ontology_id"`
	RuleAxiomID           string `json:"rule_axiom_id"`
	Status                string `json:"status"`
}

type KnowledgeInferenceProofRecord struct {
	InferenceID        string `json:"inference_id"`
	Ordinal            int    `json:"ordinal"`
	PremiseAssertionID string `json:"premise_assertion_id"`
}

type KnowledgeTypeInferenceRecord struct {
	ID          string `json:"id"`
	EntityID    string `json:"entity_id"`
	ClassKey    string `json:"class_key"`
	OntologyID  string `json:"ontology_id"`
	RuleAxiomID string `json:"rule_axiom_id"`
	Status      string `json:"status"`
}

type KnowledgeTypeInferenceProofRecord struct {
	InferenceID            string `json:"inference_id"`
	Ordinal                int    `json:"ordinal"`
	PremiseKind            string `json:"premise_kind"`
	PremiseEntityID        string `json:"premise_entity_id,omitempty"`
	PremiseClassKey        string `json:"premise_class_key,omitempty"`
	PremiseAssertionID     string `json:"premise_assertion_id,omitempty"`
	PremiseTypeInferenceID string `json:"premise_type_inference_id,omitempty"`
}

type KnowledgeRDFSnapshotRecord struct {
	ID            string `json:"id"`
	Format        string `json:"format"`
	BlobHash      string `json:"blob_hash"`
	DatasetSHA256 string `json:"dataset_sha256"`
	TripleCount   int    `json:"triple_count"`
}

type KnowledgeProjection struct {
	Sources        []KnowledgeSourceRecord             `json:"sources"`
	Entities       []KnowledgeEntityRecord             `json:"entities"`
	Aliases        []KnowledgeAliasRecord              `json:"aliases"`
	Mentions       []KnowledgeMentionRecord            `json:"mentions"`
	Assertions     []KnowledgeAssertionRecord          `json:"assertions"`
	Evidence       []KnowledgeAssertionEvidenceRecord  `json:"evidence"`
	Conflicts      []KnowledgeConflictRecord           `json:"conflicts"`
	Inferences     []KnowledgeInferenceRecord          `json:"inferences"`
	Proofs         []KnowledgeInferenceProofRecord     `json:"proofs"`
	TypeInferences []KnowledgeTypeInferenceRecord      `json:"type_inferences"`
	TypeProofs     []KnowledgeTypeInferenceProofRecord `json:"type_proofs"`
	Snapshots      []KnowledgeRDFSnapshotRecord        `json:"snapshots"`
}

// AppendKnowledgeProjection writes one validated patch as a single mutation
// boundary. It deliberately has no upsert behavior: duplicate application must
// fail rather than silently alter an existing generation.
func (db *DB) AppendKnowledgeProjection(
	ctx context.Context,
	projectID, generationID string,
	projection KnowledgeProjection,
) error {
	if projectID == "" || generationID == "" {
		return errors.New("knowledge project and generation are required")
	}
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var state KnowledgeGenerationState
	if err := tx.QueryRowContext(ctx, `
SELECT state FROM knowledge_generations WHERE project_id = ? AND id = ?`,
		projectID, generationID).Scan(&state); err != nil {
		return err
	}
	if state != KnowledgeBuilding {
		return errors.New("knowledge projection can be appended only while building")
	}
	now := formatTime(time.Now())
	for _, source := range projection.Sources {
		locator, err := normalizedJSONObject(source.SourceLocator)
		if err != nil {
			return fmt.Errorf("knowledge source %s locator: %w", source.ChunkID, err)
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO knowledge_sources(
  project_id, generation_id, chunk_id, blob_hash, source_kind,
  source_locator_json, text_hash, created_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
			projectID, generationID, source.ChunkID, source.BlobHash, source.SourceKind,
			locator, source.TextHash, now); err != nil {
			return fmt.Errorf("insert knowledge source %s: %w", source.ChunkID, err)
		}
	}
	for _, entity := range projection.Entities {
		if entity.ID == "" || entity.ClassKey == "" || strings.TrimSpace(entity.CanonicalName) == "" || entity.NormalizedName == "" {
			return errors.New("knowledge entity id, class, canonical name, and normalized name are required")
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO knowledge_entities(
  project_id, generation_id, id, class_key, canonical_name, normalized_name,
  description, identity_key, created_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			projectID, generationID, entity.ID, entity.ClassKey, entity.CanonicalName,
			entity.NormalizedName, entity.Description, entity.IdentityKey, now); err != nil {
			return fmt.Errorf("insert knowledge entity %s: %w", entity.ID, err)
		}
	}
	for _, alias := range projection.Aliases {
		if alias.EntityID == "" || strings.TrimSpace(alias.Alias) == "" || alias.NormalizedAlias == "" {
			return errors.New("knowledge alias entity, text, and normalized text are required")
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO knowledge_aliases(
  project_id, generation_id, entity_id, alias, normalized_alias, language, created_at
) VALUES(?, ?, ?, ?, ?, ?, ?)`,
			projectID, generationID, alias.EntityID, alias.Alias, alias.NormalizedAlias,
			alias.Language, now); err != nil {
			return fmt.Errorf("insert knowledge alias for %s: %w", alias.EntityID, err)
		}
	}
	for _, mention := range projection.Mentions {
		if mention.ID == "" || mention.EntityID == "" || mention.ChunkID == "" || !validSHA256(mention.ExcerptSHA256) {
			return errors.New("knowledge mention id, entity, chunk, and excerpt SHA-256 are required")
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO knowledge_mentions(
  project_id, generation_id, id, entity_id, chunk_id,
  start_byte, end_byte, excerpt_sha256, created_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			projectID, generationID, mention.ID, mention.EntityID, mention.ChunkID,
			mention.StartByte, mention.EndByte, mention.ExcerptSHA256, now); err != nil {
			return fmt.Errorf("insert knowledge mention %s: %w", mention.ID, err)
		}
	}
	for _, assertion := range projection.Assertions {
		qualifiers, err := normalizedJSONObject(assertion.Qualifiers)
		if err != nil {
			return fmt.Errorf("knowledge assertion %s qualifiers: %w", assertion.ID, err)
		}
		literal := ""
		if len(assertion.Literal) != 0 {
			if !json.Valid(assertion.Literal) {
				return fmt.Errorf("knowledge assertion %s literal is invalid JSON", assertion.ID)
			}
			literal = string(assertion.Literal)
		}
		if assertion.ID == "" || assertion.SubjectEntityID == "" || assertion.PredicateKey == "" || !validSHA256(assertion.AssertionKey) {
			return errors.New("knowledge assertion id, subject, predicate, and key are required")
		}
		validFrom, validTo := "", ""
		if assertion.ValidFrom != nil {
			validFrom = core.CanonicalKnowledgeTime(*assertion.ValidFrom)
		}
		if assertion.ValidTo != nil {
			validTo = core.CanonicalKnowledgeTime(*assertion.ValidTo)
		}
		if _, _, err := core.CanonicalKnowledgeInterval(validFrom, validTo); err != nil {
			return fmt.Errorf("knowledge assertion %s validity: %w", assertion.ID, err)
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO knowledge_assertions(
  project_id, generation_id, id, subject_entity_id, predicate_key,
  object_entity_id, literal_json, qualifiers_json, polarity,
  valid_from, valid_to, status, confidence, assertion_key, created_at
) VALUES(?, ?, ?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			projectID, generationID, assertion.ID, assertion.SubjectEntityID, assertion.PredicateKey,
			assertion.ObjectEntityID, literal, qualifiers, assertion.Polarity,
			nullableKnowledgeTime(validFrom), nullableKnowledgeTime(validTo),
			assertion.Status, assertion.Confidence, assertion.AssertionKey, now); err != nil {
			return fmt.Errorf("insert knowledge assertion %s: %w", assertion.ID, err)
		}
	}
	for _, evidence := range projection.Evidence {
		locator, err := normalizedJSONObject(evidence.Locator)
		if err != nil {
			return fmt.Errorf("knowledge assertion %s evidence locator: %w", evidence.AssertionID, err)
		}
		if evidence.AssertionID == "" || evidence.BlobHash == "" || !validSHA256(evidence.EvidenceSHA256) {
			return errors.New("knowledge evidence assertion, blob, and evidence SHA-256 are required")
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO knowledge_assertion_evidence(
  project_id, generation_id, assertion_id, evidence_kind, blob_hash, chunk_id,
  claim_id, source_id, start_byte, end_byte, locator_json, evidence_sha256, created_at
) VALUES(?, ?, ?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?, ?, ?)`,
			projectID, generationID, evidence.AssertionID, evidence.EvidenceKind,
			evidence.BlobHash, evidence.ChunkID, evidence.ClaimID, evidence.SourceID,
			nullableInt(evidence.StartByte), nullableInt(evidence.EndByte), locator,
			evidence.EvidenceSHA256, now); err != nil {
			return fmt.Errorf("insert knowledge evidence for %s: %w", evidence.AssertionID, err)
		}
	}
	for _, conflict := range projection.Conflicts {
		if conflict.ID == "" || conflict.LeftAssertionID == "" || conflict.RightAssertionID == "" || strings.TrimSpace(conflict.Reason) == "" {
			return errors.New("knowledge conflict id, assertions, and reason are required")
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO knowledge_conflicts(
  project_id, generation_id, id, left_assertion_id, right_assertion_id,
  reason, status, created_at, resolved_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
			projectID, generationID, conflict.ID, conflict.LeftAssertionID,
			conflict.RightAssertionID, conflict.Reason, conflict.Status, now); err != nil {
			return fmt.Errorf("insert knowledge conflict %s: %w", conflict.ID, err)
		}
	}
	for _, inference := range projection.Inferences {
		if inference.ID == "" || inference.ConclusionAssertionID == "" || inference.OntologyID == "" || inference.RuleAxiomID == "" {
			return errors.New("knowledge inference id, conclusion, ontology, and rule are required")
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO knowledge_inferences(
  project_id, generation_id, id, conclusion_assertion_id,
  ontology_id, rule_axiom_id, status, created_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
			projectID, generationID, inference.ID, inference.ConclusionAssertionID,
			inference.OntologyID, inference.RuleAxiomID, inference.Status, now); err != nil {
			return fmt.Errorf("insert knowledge inference %s: %w", inference.ID, err)
		}
	}
	for _, proof := range projection.Proofs {
		if proof.InferenceID == "" || proof.PremiseAssertionID == "" {
			return errors.New("knowledge inference proof requires inference and premise")
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO knowledge_inference_proofs(
  project_id, generation_id, inference_id, ordinal, premise_assertion_id, created_at
) VALUES(?, ?, ?, ?, ?, ?)`,
			projectID, generationID, proof.InferenceID, proof.Ordinal,
			proof.PremiseAssertionID, now); err != nil {
			return fmt.Errorf("insert knowledge inference proof %s: %w", proof.InferenceID, err)
		}
	}
	for _, inference := range projection.TypeInferences {
		if inference.ID == "" || inference.EntityID == "" || inference.ClassKey == "" ||
			inference.OntologyID == "" || inference.RuleAxiomID == "" {
			return errors.New("knowledge type inference requires id, entity, class, ontology, and rule")
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO knowledge_type_inferences(
  project_id, generation_id, id, entity_id, class_key,
  ontology_id, rule_axiom_id, status, created_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`, projectID, generationID, inference.ID,
			inference.EntityID, inference.ClassKey, inference.OntologyID,
			inference.RuleAxiomID, inference.Status, now); err != nil {
			return fmt.Errorf("insert knowledge type inference %s: %w", inference.ID, err)
		}
	}
	for _, proof := range projection.TypeProofs {
		if proof.InferenceID == "" || proof.PremiseKind == "" {
			return errors.New("knowledge type inference proof requires inference and premise kind")
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO knowledge_type_inference_proofs(
  project_id, generation_id, inference_id, ordinal, premise_kind,
  premise_entity_id, premise_class_key, premise_assertion_id,
  premise_type_inference_id, created_at
) VALUES(?, ?, ?, ?, ?, NULLIF(?, ''), ?, NULLIF(?, ''), NULLIF(?, ''), ?)`,
			projectID, generationID, proof.InferenceID, proof.Ordinal, proof.PremiseKind,
			proof.PremiseEntityID, proof.PremiseClassKey, proof.PremiseAssertionID,
			proof.PremiseTypeInferenceID, now); err != nil {
			return fmt.Errorf("insert knowledge type inference proof %s: %w", proof.InferenceID, err)
		}
	}
	for _, snapshot := range projection.Snapshots {
		if snapshot.ID == "" || snapshot.BlobHash == "" || !validSHA256(snapshot.DatasetSHA256) {
			return errors.New("knowledge RDF snapshot id, blob, and dataset SHA-256 are required")
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO knowledge_rdf_snapshots(
  project_id, generation_id, id, format, blob_hash, dataset_sha256, triple_count, created_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
			projectID, generationID, snapshot.ID, snapshot.Format, snapshot.BlobHash,
			snapshot.DatasetSHA256, snapshot.TripleCount, now); err != nil {
			return fmt.Errorf("insert knowledge RDF snapshot %s: %w", snapshot.ID, err)
		}
	}
	return tx.Commit()
}

func normalizedJSONObject(value json.RawMessage) (string, error) {
	if len(value) == 0 {
		return "{}", nil
	}
	var object map[string]any
	if err := json.Unmarshal(value, &object); err != nil {
		return "", errors.New("value must be a JSON object")
	}
	if object == nil {
		return "", errors.New("value must be a JSON object")
	}
	encoded, err := json.Marshal(object)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func nullableKnowledgeTime(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullableInt(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

type KnowledgeExtractionBatch struct {
	ProjectID               string          `json:"project_id"`
	GenerationID            string          `json:"generation_id"`
	ID                      string          `json:"id"`
	DocumentID              string          `json:"document_id,omitempty"`
	RunID                   string          `json:"run_id,omitempty"`
	ArtifactID              string          `json:"artifact_id,omitempty"`
	SourceKind              string          `json:"source_kind"`
	ExtractorModel          string          `json:"extractor_model,omitempty"`
	ExtractorContractSHA256 string          `json:"extractor_contract_sha256"`
	Status                  string          `json:"status"`
	CodexThreadID           string          `json:"codex_thread_id,omitempty"`
	CodexTurnID             string          `json:"codex_turn_id,omitempty"`
	InputSHA256             string          `json:"input_sha256,omitempty"`
	OutputSHA256            string          `json:"output_sha256,omitempty"`
	PatchBlobHash           string          `json:"patch_blob_hash,omitempty"`
	SourceLocator           json.RawMessage `json:"source_locator,omitempty"`
	Error                   string          `json:"error,omitempty"`
	CreatedAt               time.Time       `json:"created_at"`
	UpdatedAt               time.Time       `json:"updated_at"`
	CompletedAt             *time.Time      `json:"completed_at,omitempty"`
}

func (db *DB) CreateKnowledgeExtractionBatch(ctx context.Context, batch KnowledgeExtractionBatch) (KnowledgeExtractionBatch, error) {
	if batch.ProjectID == "" || batch.GenerationID == "" || batch.ID == "" ||
		batch.SourceKind == "" || !validSHA256(batch.ExtractorContractSHA256) {
		return KnowledgeExtractionBatch{}, errors.New("knowledge extraction batch identity, source, and contract are required")
	}
	now := time.Now().UTC()
	if len(batch.SourceLocator) == 0 {
		batch.SourceLocator = json.RawMessage(`{}`)
	}
	var locator map[string]any
	if err := json.Unmarshal(batch.SourceLocator, &locator); err != nil || locator == nil {
		return KnowledgeExtractionBatch{}, errors.New("knowledge extraction source locator must be one JSON object")
	}
	canonicalLocator, err := json.Marshal(locator)
	if err != nil {
		return KnowledgeExtractionBatch{}, err
	}
	batch.SourceLocator = canonicalLocator
	batch.Status, batch.CreatedAt, batch.UpdatedAt = "queued", now, now
	_, err = db.sql.ExecContext(ctx, `
INSERT INTO knowledge_extraction_batches(
  project_id, generation_id, id, document_id, run_id, artifact_id, source_kind,
  extractor_model, extractor_contract_sha256, status, codex_thread_id, codex_turn_id,
  input_sha256, output_sha256, patch_blob_hash, error, created_at, updated_at, completed_at,
  source_locator_json
) VALUES(?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?, 'queued',
         '', '', NULLIF(?, ''), '', NULL, '', ?, ?, NULL, ?)`,
		batch.ProjectID, batch.GenerationID, batch.ID, batch.DocumentID, batch.RunID,
		batch.ArtifactID, batch.SourceKind, batch.ExtractorModel,
		batch.ExtractorContractSHA256, batch.InputSHA256, formatTime(now), formatTime(now), string(batch.SourceLocator))
	if err != nil {
		return KnowledgeExtractionBatch{}, err
	}
	return batch, nil
}

type KnowledgeExtractionBatchUpdate struct {
	CodexThreadID string
	CodexTurnID   string
	OutputSHA256  string
	PatchBlobHash string
	Error         string
}

// TransitionKnowledgeExtractionBatch applies one compare-and-swap state
// transition while its shadow generation is still mutable. Thread/turn ids
// are preserved as soon as they become durable; hashes must already refer to
// registered CAS objects. A missed expected state is always an error so a
// restarted extraction cannot silently duplicate a model turn.
func (db *DB) TransitionKnowledgeExtractionBatch(
	ctx context.Context,
	projectID, generationID, batchID, expected, next string,
	update KnowledgeExtractionBatchUpdate,
) error {
	if projectID == "" || generationID == "" || batchID == "" {
		return errors.New("knowledge extraction batch identity is required")
	}
	allowed := map[string]map[string]bool{
		"queued":     {"extracting": true, "reviewing": true, "interrupted": true, "failed": true},
		"extracting": {"validated": true, "interrupted": true, "failed": true},
		"reviewing":  {"validated": true, "interrupted": true, "failed": true},
		"validated":  {"applied": true, "interrupted": true, "failed": true},
	}
	if !allowed[expected][next] {
		return fmt.Errorf("invalid knowledge extraction transition %s -> %s", expected, next)
	}
	if update.OutputSHA256 != "" && !validSHA256(update.OutputSHA256) {
		return errors.New("knowledge extraction output SHA-256 is invalid")
	}
	if update.PatchBlobHash != "" && !validSHA256(update.PatchBlobHash) {
		return errors.New("knowledge extraction patch blob hash is invalid")
	}
	terminal := next == "applied" || next == "interrupted" || next == "failed"
	now := formatTime(time.Now().UTC())
	completed := any(nil)
	if terminal {
		completed = now
	}
	result, err := db.sql.ExecContext(ctx, `
UPDATE knowledge_extraction_batches
SET status=?,
    codex_thread_id=CASE WHEN ?='' THEN codex_thread_id ELSE ? END,
    codex_turn_id=CASE WHEN ?='' THEN codex_turn_id ELSE ? END,
    output_sha256=CASE WHEN ?='' THEN output_sha256 ELSE ? END,
    patch_blob_hash=CASE WHEN ?='' THEN patch_blob_hash ELSE ? END,
    error=?,updated_at=?,completed_at=?
WHERE project_id=? AND generation_id=? AND id=? AND status=?`,
		next,
		update.CodexThreadID, update.CodexThreadID,
		update.CodexTurnID, update.CodexTurnID,
		update.OutputSHA256, update.OutputSHA256,
		update.PatchBlobHash, update.PatchBlobHash,
		update.Error, now, completed,
		projectID, generationID, batchID, expected,
	)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err != nil {
			return err
		}
		return errors.New("knowledge extraction batch state changed concurrently")
	}
	return nil
}

func ensureBuildingGeneration(ctx context.Context, tx *sql.Tx, projectID, generationID string) error {
	var state string
	if err := tx.QueryRowContext(ctx, `
SELECT state FROM knowledge_generations WHERE project_id = ? AND id = ?`,
		projectID, generationID).Scan(&state); err != nil {
		return err
	}
	if state != string(KnowledgeBuilding) {
		return errors.New("knowledge generation is not building")
	}
	return nil
}
