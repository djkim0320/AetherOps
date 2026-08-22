package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/rag"
)

func TestEnsureEmptyKnowledgeGenerationIsIdempotent(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "empty knowledge")
	if err != nil {
		t.Fatal(err)
	}
	created, err := db.ActiveKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatalf("new project has no knowledge head: %v", err)
	}
	first, err := db.EnsureEmptyKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := db.EnsureEmptyKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if created.GenerationID != first.GenerationID || first.GenerationID != second.GenerationID ||
		second.KnowledgeRevision != 1 {
		t.Fatalf("empty generation was not created atomically or idempotently: created=%+v first=%+v second=%+v", created, first, second)
	}
	if first.Status != KnowledgeHeadReady || first.Generation.State != KnowledgeReady ||
		first.Generation.ManifestSHA256 != EmptyKnowledgeManifestSHA256 {
		t.Fatalf("unexpected empty knowledge head: %+v", first)
	}
	var migrationCount int
	if err := db.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM schema_migrations").Scan(&migrationCount); err != nil {
		t.Fatal(err)
	}
	if migrationCount != len(migrations) {
		t.Fatalf("schema migrations = %d, want %d", migrationCount, len(migrations))
	}
}

func TestCreateResearchRunBlocksStaleKnowledgeHead(t *testing.T) {
	ctx := context.Background()
	db, _ := openTestDB(t)
	project, err := db.CreateProject(ctx, "stale graph blocks research")
	if err != nil {
		t.Fatal(err)
	}
	head, err := db.ActiveKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetKnowledgeHeadStatus(ctx, project.ID, head.KnowledgeRevision, KnowledgeHeadStale, "rebuild required"); err != nil {
		t.Fatal(err)
	}
	session, err := db.DefaultConversationSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.MarkConversationSessionProvisioning(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	threadID, err := db.SetConversationSessionThreadIfEmpty(ctx, session.ID, "thread-stale")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreateConversationRunConfigured(ctx, session.ID, "", "must block", threadID, core.RunConfiguration{}); err == nil || !strings.Contains(err.Error(), "hybrid_graph_v1 research is blocked") {
		t.Fatalf("stale knowledge graph allowed research: %v", err)
	}
}

func TestMigrationSixBackfillsReadableKnowledgeHead(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "upgrade.db")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.ExecContext(ctx, `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`); err != nil {
		t.Fatal(err)
	}
	for index, migration := range []string{
		initialSchema, downloadsSchema, runConfigurationSchema, conversationSessionsSchema, engineeringSchema,
	} {
		if _, err := raw.ExecContext(ctx, migration); err != nil {
			t.Fatalf("apply fixture migration %d: %v", index+1, err)
		}
		sum := sha256.Sum256([]byte(migration))
		if _, err := raw.ExecContext(ctx,
			"INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)",
			index+1, hex.EncodeToString(sum[:]), formatTime(time.Now())); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := raw.ExecContext(ctx, `
INSERT INTO projects(id,name,main_thread_id,created_at,updated_at)
VALUES('prj_upgrade','upgrade','',?,?)`, formatTime(time.Now()), formatTime(time.Now())); err != nil {
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	head, err := db.ActiveKnowledgeGeneration(ctx, "prj_upgrade")
	if err != nil {
		t.Fatalf("migration 6 head timestamp is unreadable: %v", err)
	}
	if head.Generation.ManifestSHA256 != EmptyKnowledgeManifestSHA256 || head.Status != KnowledgeHeadReady {
		t.Fatalf("unexpected upgraded knowledge head: %+v", head)
	}
	snapshot, triples, err := db.KnowledgeNQuads(ctx, "prj_upgrade", head.GenerationID, head.Generation.OntologyID)
	if err != nil {
		t.Fatal(err)
	}
	if triples <= 0 || !strings.Contains(string(snapshot), "<urn:aetherops:core:Thing>") ||
		!strings.Contains(string(snapshot), "<http://www.w3.org/2002/07/owl#Class>") {
		t.Fatalf("migration-era empty head cannot deterministically reconstruct its ontology: triples=%d", triples)
	}
}

func TestKnowledgeGenerationValidatesAndSwapsAtomically(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "knowledge lifecycle")
	if err != nil {
		t.Fatal(err)
	}
	oldHead, err := db.EnsureEmptyKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	const text = "SU2 uses Gmsh"
	receipt, err := objects.PutBytes([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	document, err := db.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "solver provenance", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
		Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: text}}, [][]float32{vector})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetDocumentGraphAdopt(ctx, project.ID, document.ID, true); err != nil {
		t.Fatal(err)
	}
	var chunkID, textHash string
	if err := db.SQL().QueryRowContext(ctx,
		"SELECT id, text_hash FROM chunks WHERE document_id = ?", document.ID,
	).Scan(&chunkID, &textHash); err != nil {
		t.Fatal(err)
	}
	generation, err := db.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	sha := func(value string) string {
		sum := sha256.Sum256([]byte(value))
		return hex.EncodeToString(sum[:])
	}
	start, end := 0, len(text)
	projection := KnowledgeProjection{
		Sources: []KnowledgeSourceRecord{{
			ChunkID: chunkID, BlobHash: receipt.Hash, SourceKind: "pinned",
			SourceLocator: json.RawMessage(`{"document":"solver provenance"}`), TextHash: textHash,
		}},
		Entities: []KnowledgeEntityRecord{
			{ID: "ent_su2", ClassKey: "software", CanonicalName: "SU2", NormalizedName: "su2"},
			{ID: "ent_gmsh", ClassKey: "software", CanonicalName: "Gmsh", NormalizedName: "gmsh"},
		},
		Mentions: []KnowledgeMentionRecord{
			{ID: "men_su2", EntityID: "ent_su2", ChunkID: chunkID, StartByte: 0, EndByte: 3, ExcerptSHA256: sha("SU2")},
			{ID: "men_gmsh", EntityID: "ent_gmsh", ChunkID: chunkID, StartByte: 9, EndByte: 13, ExcerptSHA256: sha("Gmsh")},
		},
		Assertions: []KnowledgeAssertionRecord{{
			ID: "ast_uses", SubjectEntityID: "ent_su2", PredicateKey: "uses",
			ObjectEntityID: "ent_gmsh", Qualifiers: json.RawMessage(`{}`),
			Polarity: "affirmed", Status: "accepted", Confidence: 1,
			AssertionKey: sha("ent_su2|uses|ent_gmsh"),
		}},
		Evidence: []KnowledgeAssertionEvidenceRecord{{
			AssertionID: "ast_uses", EvidenceKind: "text_span", BlobHash: receipt.Hash,
			ChunkID: chunkID, StartByte: &start, EndByte: &end,
			Locator: json.RawMessage(`{}`), EvidenceSHA256: sha(text),
		}},
	}
	if err := db.AppendKnowledgeProjection(ctx, project.ID, generation.ID, projection); err != nil {
		t.Fatal(err)
	}
	appendTestKnowledgeSnapshot(t, db, objects, project.ID, generation.ID, CoreOntologyID)
	validating, err := db.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID,
		KnowledgeBuilding, KnowledgeValidating, "")
	if err != nil || validating.State != KnowledgeValidating {
		t.Fatalf("validating transition: %+v, %v", validating, err)
	}
	ready, err := db.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID,
		KnowledgeValidating, KnowledgeReady, "")
	if err != nil {
		t.Fatal(err)
	}
	if ready.State != KnowledgeReady || ready.SourceCount != 1 || ready.EntityCount != 2 ||
		ready.AssertionCount != 1 || !validSHA256(ready.ManifestSHA256) {
		t.Fatalf("validated generation: %+v", ready)
	}
	if _, err := db.SQL().ExecContext(ctx, `
UPDATE knowledge_generations SET state='retired', retired_at=?
WHERE project_id=? AND id=?`, formatTime(time.Now()), project.ID, generation.ID); err == nil {
		t.Fatal("non-active ready generation retired outside a head swap")
	}
	head, err := db.ActivateKnowledgeGeneration(ctx, project.ID, generation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if head.GenerationID != generation.ID || head.KnowledgeRevision != oldHead.KnowledgeRevision+1 ||
		head.Generation.State != KnowledgeReady {
		t.Fatalf("active knowledge head: %+v", head)
	}
	retired, err := db.KnowledgeGeneration(ctx, project.ID, oldHead.GenerationID)
	if err != nil || retired.State != KnowledgeRetired || retired.RetiredAt == nil {
		t.Fatalf("previous generation was not retired: %+v, %v", retired, err)
	}
	if _, err := db.SQL().ExecContext(ctx, `
INSERT INTO knowledge_entities(
  project_id, generation_id, id, class_key, canonical_name, normalized_name,
  description, identity_key, created_at
) VALUES(?, ?, 'late', 'concept', 'late', 'late', '', '', CURRENT_TIMESTAMP)`,
		project.ID, generation.ID); err == nil {
		t.Fatal("ready generation accepted a late entity")
	}
}

func TestKnowledgeGenerationRejectsDuplicateAssertionKeys(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "duplicate assertion validation")
	if err != nil {
		t.Fatal(err)
	}
	const text = "SU2 uses Gmsh"
	receipt, err := objects.PutBytes([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	document, err := db.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "duplicate assertion source", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
		Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: text}}, [][]float32{vector})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetDocumentGraphAdopt(ctx, project.ID, document.ID, true); err != nil {
		t.Fatal(err)
	}
	var chunkID, textHash string
	if err := db.SQL().QueryRowContext(ctx,
		"SELECT id, text_hash FROM chunks WHERE document_id = ?", document.ID,
	).Scan(&chunkID, &textHash); err != nil {
		t.Fatal(err)
	}
	generation, err := db.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	sha := func(value string) string {
		sum := sha256.Sum256([]byte(value))
		return hex.EncodeToString(sum[:])
	}
	start, end := 0, len(text)
	assertionKey := sha("ent_su2|uses|ent_gmsh")
	projection := KnowledgeProjection{
		Sources: []KnowledgeSourceRecord{{
			ChunkID: chunkID, BlobHash: receipt.Hash, SourceKind: "pinned",
			SourceLocator: json.RawMessage(`{"document":"duplicate assertion source"}`), TextHash: textHash,
		}},
		Entities: []KnowledgeEntityRecord{
			{ID: "ent_su2", ClassKey: "software", CanonicalName: "SU2", NormalizedName: "su2"},
			{ID: "ent_gmsh", ClassKey: "software", CanonicalName: "Gmsh", NormalizedName: "gmsh"},
		},
		Mentions: []KnowledgeMentionRecord{
			{ID: "men_su2", EntityID: "ent_su2", ChunkID: chunkID, StartByte: 0, EndByte: 3, ExcerptSHA256: sha("SU2")},
			{ID: "men_gmsh", EntityID: "ent_gmsh", ChunkID: chunkID, StartByte: 9, EndByte: 13, ExcerptSHA256: sha("Gmsh")},
		},
		Assertions: []KnowledgeAssertionRecord{
			{ID: "ast_uses_1", SubjectEntityID: "ent_su2", PredicateKey: "uses", ObjectEntityID: "ent_gmsh", Qualifiers: json.RawMessage(`{}`), Polarity: "affirmed", Status: "accepted", Confidence: 1, AssertionKey: assertionKey},
			{ID: "ast_uses_2", SubjectEntityID: "ent_su2", PredicateKey: "uses", ObjectEntityID: "ent_gmsh", Qualifiers: json.RawMessage(`{}`), Polarity: "affirmed", Status: "accepted", Confidence: 1, AssertionKey: assertionKey},
		},
		Evidence: []KnowledgeAssertionEvidenceRecord{
			{AssertionID: "ast_uses_1", EvidenceKind: "text_span", BlobHash: receipt.Hash, ChunkID: chunkID, StartByte: &start, EndByte: &end, Locator: json.RawMessage(`{}`), EvidenceSHA256: sha(text)},
			{AssertionID: "ast_uses_2", EvidenceKind: "text_span", BlobHash: receipt.Hash, ChunkID: chunkID, StartByte: &start, EndByte: &end, Locator: json.RawMessage(`{}`), EvidenceSHA256: sha(text)},
		},
	}
	if err := db.AppendKnowledgeProjection(ctx, project.ID, generation.ID, projection); err != nil {
		t.Fatal(err)
	}
	appendTestKnowledgeSnapshot(t, db, objects, project.ID, generation.ID, CoreOntologyID)
	if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID,
		KnowledgeBuilding, KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID,
		KnowledgeValidating, KnowledgeReady, ""); err == nil || !strings.Contains(err.Error(), "duplicate assertion keys") {
		t.Fatalf("duplicate assertion keys reached ready state: %v", err)
	}
	unchanged, err := db.KnowledgeGeneration(ctx, project.ID, generation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.State != KnowledgeValidating {
		t.Fatalf("failed duplicate validation changed generation state: %s", unchanged.State)
	}
}

func TestKnowledgeCompositeIsolationAndAppendOnlyCuration(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	first, err := db.CreateProject(ctx, "first")
	if err != nil {
		t.Fatal(err)
	}
	second, err := db.CreateProject(ctx, "second")
	if err != nil {
		t.Fatal(err)
	}
	firstHead, err := db.EnsureEmptyKnowledgeGeneration(ctx, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.EnsureEmptyKnowledgeGeneration(ctx, second.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `
INSERT INTO knowledge_entities(
  project_id, generation_id, id, class_key, canonical_name, normalized_name,
  description, identity_key, created_at
) VALUES(?, ?, 'cross', 'concept', 'cross', 'cross', '', '', CURRENT_TIMESTAMP)`,
		second.ID, firstHead.GenerationID); err == nil {
		t.Fatal("cross-project generation reference was accepted")
	}
	building, err := db.CreateKnowledgeGeneration(ctx, first.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `
INSERT INTO knowledge_entities(
  project_id, generation_id, id, class_key, canonical_name, normalized_name,
  description, identity_key, created_at
) VALUES(?, ?, 'movable', 'concept', 'movable', 'movable', '', '', CURRENT_TIMESTAMP)`,
		first.ID, building.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `
UPDATE knowledge_entities SET generation_id=?
WHERE project_id=? AND generation_id=? AND id='movable'`,
		firstHead.GenerationID, first.ID, building.ID); err == nil {
		t.Fatal("building projection row moved into a ready generation")
	}
	if _, err := db.SQL().ExecContext(ctx, `
UPDATE knowledge_generations SET state='retired', retired_at=?
WHERE project_id=? AND id=?`, formatTime(time.Now()), first.ID, firstHead.GenerationID); err == nil {
		t.Fatal("active ready generation retired without a head swap")
	}
	if _, err := db.SQL().ExecContext(ctx,
		"DELETE FROM project_knowledge_heads WHERE project_id=?", first.ID); err == nil {
		t.Fatal("active knowledge head was deleted outside project deletion")
	}
	firstEvent, err := db.AppendKnowledgeCuration(ctx, first.ID, firstHead.GenerationID,
		"pin_entity", "user", json.RawMessage(`{"entity_id":"manual"}`))
	if err != nil {
		t.Fatal(err)
	}
	secondEvent, err := db.AppendKnowledgeCuration(ctx, first.ID, firstHead.GenerationID,
		"add_alias", "user", json.RawMessage(`{"alias":"에스유투","entity_id":"manual"}`))
	if err != nil {
		t.Fatal(err)
	}
	if secondEvent.PreviousEventSHA256 != firstEvent.EventSHA256 {
		t.Fatalf("curation hash chain was not linked: %+v", secondEvent)
	}
	if _, err := db.SQL().ExecContext(ctx,
		"UPDATE knowledge_curation_events SET actor = 'tampered' WHERE id = ?", firstEvent.ID); err == nil {
		t.Fatal("curation event update was accepted")
	}
	if _, err := db.SQL().ExecContext(ctx,
		"DELETE FROM knowledge_curation_events WHERE id = ?", firstEvent.ID); err == nil {
		t.Fatal("curation event deletion was accepted")
	}
	head, err := db.ActiveKnowledgeGeneration(ctx, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if head.KnowledgeRevision != firstHead.KnowledgeRevision+2 {
		t.Fatalf("knowledge revision = %d, want %d", head.KnowledgeRevision, firstHead.KnowledgeRevision+2)
	}
	stale, err := db.SetKnowledgeHeadStatus(ctx, first.ID, head.KnowledgeRevision,
		KnowledgeHeadStale, "new adopted material is awaiting projection")
	if err != nil || stale.Status != KnowledgeHeadStale || stale.Error == "" {
		t.Fatalf("stale knowledge head: %+v, %v", stale, err)
	}
	if err := db.DeleteBuildingKnowledgeGeneration(ctx, first.ID, building.ID, CoreOntologyContractSHA256); err != nil {
		t.Fatalf("remove deliberately unfinished test generation: %v", err)
	}
	if _, err := db.DeleteProject(ctx, first.ID); err != nil {
		t.Fatalf("project deletion could not cascade an immutable graph: %v", err)
	}
}

func TestCurationMemoBlobParticipatesInCASReferenceAccounting(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "curation memo")
	if err != nil {
		t.Fatal(err)
	}
	head, err := db.ActiveKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	missingPayload, err := json.Marshal(map[string]any{
		"entity_id":        "manual",
		"memo_blob_hash":   strings.Repeat("0", 64),
		"memo_document_id": "doc_missing",
		"memo_start_byte":  0,
		"memo_end_byte":    1,
		"memo_span_sha256": strings.Repeat("0", 64),
		"memo_chunks": []map[string]any{{
			"chunk_id": "chk_missing", "start_byte": 0, "end_byte": 1,
			"span_sha256": strings.Repeat("0", 64),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AppendKnowledgeCuration(ctx, project.ID, head.GenerationID,
		"pin_entity", "user", missingPayload); err == nil || !strings.Contains(err.Error(), "not registered") {
		t.Fatalf("unregistered curation memo was accepted: %v", err)
	}
	if _, err := db.AppendKnowledgeCuration(ctx, project.ID, head.GenerationID,
		"pin_entity", "user", json.RawMessage(`{"entity_id":"manual","memo":"unbound raw memo"}`)); err == nil || !strings.Contains(err.Error(), "server-verified CAS binding") {
		t.Fatalf("raw curation memo bypassed CAS provenance: %v", err)
	}
	receipt, err := objects.PutBytes([]byte("evidence-backed curation memo"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/plain; charset=utf-8"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	document, err := db.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "Pinned curation memo", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions, Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: "evidence-backed curation memo"}}, [][]float32{vector})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.MarkCurationMemoDocument(ctx, project.ID, document.ID, receipt.Hash); err != nil {
		t.Fatal(err)
	}
	var chunkID, chunkHash string
	if err := db.SQL().QueryRowContext(ctx, `SELECT id,text_hash FROM chunks WHERE document_id=?`, document.ID).Scan(&chunkID, &chunkHash); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{
		"entity_id":        "manual",
		"memo_blob_hash":   receipt.Hash,
		"memo_document_id": document.ID,
		"memo_start_byte":  0,
		"memo_end_byte":    receipt.Size,
		"memo_span_sha256": receipt.Hash,
		"memo_chunks": []map[string]any{{
			"chunk_id": chunkID, "start_byte": 0, "end_byte": len("evidence-backed curation memo"),
			"span_sha256": chunkHash,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	other, err := db.CreateProject(ctx, "other curation memo project")
	if err != nil {
		t.Fatal(err)
	}
	otherHead, err := db.ActiveKnowledgeGeneration(ctx, other.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AppendKnowledgeCuration(ctx, other.ID, otherHead.GenerationID,
		"pin_entity", "user", payload); err == nil || !strings.Contains(err.Error(), "does not belong") {
		t.Fatalf("cross-project curation memo document was accepted: %v", err)
	}
	var tampered map[string]any
	if err := json.Unmarshal(payload, &tampered); err != nil {
		t.Fatal(err)
	}
	tampered["memo_span_sha256"] = strings.Repeat("1", 64)
	tamperedPayload, _ := json.Marshal(tampered)
	if _, err := db.AppendKnowledgeCuration(ctx, project.ID, head.GenerationID,
		"pin_entity", "user", tamperedPayload); err == nil {
		t.Fatal("curation memo CAS hash/span mismatch was accepted")
	}
	if err := json.Unmarshal(payload, &tampered); err != nil {
		t.Fatal(err)
	}
	tamperedChunks := tampered["memo_chunks"].([]any)
	tamperedChunks[0].(map[string]any)["end_byte"] = float64(len("evidence-backed curation memo") - 1)
	tamperedPayload, _ = json.Marshal(tampered)
	if _, err := db.AppendKnowledgeCuration(ctx, project.ID, head.GenerationID,
		"pin_entity", "user", tamperedPayload); err == nil || !strings.Contains(err.Error(), "span") {
		t.Fatalf("curation memo chunk span mismatch was accepted: %v", err)
	}
	if _, err := db.AppendKnowledgeCuration(ctx, project.ID, head.GenerationID,
		"pin_entity", "user", payload); err != nil {
		t.Fatal(err)
	}
	stale, err := db.ActiveKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stale.Status != KnowledgeHeadStale {
		t.Fatalf("curation ledger append left knowledge head %s instead of stale", stale.Status)
	}
	tx, err := db.SQL().BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	references, err := blobReferenceCount(ctx, tx, receipt.Hash)
	_ = tx.Rollback()
	if err != nil {
		t.Fatal(err)
	}
	if references != 2 {
		t.Fatalf("curation memo CAS references = %d, want 2 (pinned document plus ledger)", references)
	}
	orphans, err := db.DeleteProject(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(orphans) != 1 || orphans[0] != receipt.Hash {
		t.Fatalf("project deletion orphan set = %v, want [%s]", orphans, receipt.Hash)
	}
}

func TestKnowledgeValidationRejectsUnsupportedOrUnprovenRows(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "invalid")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.EnsureEmptyKnowledgeGeneration(ctx, project.ID); err != nil {
		t.Fatal(err)
	}
	generation, err := db.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `
INSERT INTO knowledge_entities(
  project_id, generation_id, id, class_key, canonical_name, normalized_name,
  description, identity_key, created_at
) VALUES(?, ?, 'unsupported', 'model_generated_class', 'unsupported', 'unsupported', '', '', CURRENT_TIMESTAMP)`,
		project.ID, generation.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID,
		KnowledgeBuilding, KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID,
		KnowledgeValidating, KnowledgeReady, ""); err == nil {
		t.Fatal("unsupported, unmentioned entity reached ready state")
	}
}

func TestProjectOntologyHasSingleActiveVersionAndResolvesCoreImport(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "ontology extension")
	if err != nil {
		t.Fatal(err)
	}
	putOntologyBlob := func(content string) string {
		t.Helper()
		receipt, err := objects.PutBytes([]byte(content))
		if err != nil {
			t.Fatal(err)
		}
		if err := db.RegisterBlob(ctx, receipt, "text/turtle"); err != nil {
			t.Fatal(err)
		}
		return receipt.Hash
	}
	firstBlob := putOntologyBlob("<urn:project:first> <urn:version> \"1\" .")
	secondBlob := putOntologyBlob("<urn:project:second> <urn:version> \"2\" .")
	insertOntology := func(ontologyID, version, blobHash string) {
		t.Helper()
		if _, err := db.SQL().ExecContext(ctx, `
INSERT INTO ontology_versions(
  id, project_id, semantic_version, source_blob_hash, canonical_blob_hash,
  canonical_sha256, triple_count, state, created_at, activated_at, retired_at
) VALUES(?, ?, ?, ?, ?, ?, 1, 'draft', ?, NULL, NULL)`,
			ontologyID, project.ID, version, blobHash, blobHash, blobHash, formatTime(time.Now())); err != nil {
			t.Fatal(err)
		}
		if _, err := db.SQL().ExecContext(ctx, `
INSERT INTO ontology_imports(ontology_id, imported_ontology_id, required, created_at)
VALUES(?, ?, 1, ?)`, ontologyID, CoreOntologyID, formatTime(time.Now())); err != nil {
			t.Fatal(err)
		}
	}
	insertOntology("ont_project_v1", "1.0.0", firstBlob)
	if _, err := db.SQL().ExecContext(ctx, `
UPDATE ontology_versions SET state='active', activated_at=? WHERE id='ont_project_v1'`,
		formatTime(time.Now())); err != nil {
		t.Fatal(err)
	}
	otherProject, err := db.CreateProject(ctx, "same ontology contract")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `
INSERT INTO ontology_versions(
  id, project_id, semantic_version, source_blob_hash, canonical_blob_hash,
  canonical_sha256, triple_count, state, created_at, activated_at, retired_at
) VALUES('ont_other_v1', ?, '1.0.0', ?, ?, ?, 1, 'active', ?, ?, NULL)`,
		otherProject.ID, firstBlob, firstBlob, firstBlob, formatTime(time.Now()), formatTime(time.Now())); err != nil {
		t.Fatalf("the same canonical ontology could not be isolated per project: %v", err)
	}
	insertOntology("ont_project_v2", "2.0.0", secondBlob)
	if _, err := db.SQL().ExecContext(ctx, `
UPDATE ontology_versions SET state='active', activated_at=? WHERE id='ont_project_v2'`,
		formatTime(time.Now())); err == nil {
		t.Fatal("project accepted two active ontology versions")
	}

	const text = "SU2"
	receipt, err := objects.PutBytes([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	document, err := db.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "core import", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
		Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: text}}, [][]float32{vector})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetDocumentGraphAdopt(ctx, project.ID, document.ID, true); err != nil {
		t.Fatal(err)
	}
	var chunkID, textHash string
	if err := db.SQL().QueryRowContext(ctx,
		"SELECT id,text_hash FROM chunks WHERE document_id=?", document.ID,
	).Scan(&chunkID, &textHash); err != nil {
		t.Fatal(err)
	}
	sha := sha256.Sum256([]byte(text))
	spanHash := hex.EncodeToString(sha[:])
	start, end := 0, len(text)
	generation, err := db.CreateKnowledgeGeneration(ctx, project.ID, "ont_project_v1", firstBlob)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AppendKnowledgeProjection(ctx, project.ID, generation.ID, KnowledgeProjection{
		Sources: []KnowledgeSourceRecord{{
			ChunkID: chunkID, BlobHash: receipt.Hash, SourceKind: "pinned",
			SourceLocator: json.RawMessage(`{"document":"core import"}`), TextHash: textHash,
		}},
		Entities: []KnowledgeEntityRecord{{
			ID: "ent_su2", ClassKey: "software", CanonicalName: "SU2", NormalizedName: "su2",
		}},
		Mentions: []KnowledgeMentionRecord{{
			ID: "men_su2", EntityID: "ent_su2", ChunkID: chunkID,
			StartByte: start, EndByte: end, ExcerptSHA256: spanHash,
		}},
		Assertions: []KnowledgeAssertionRecord{{
			ID: "ast_self", SubjectEntityID: "ent_su2", PredicateKey: "depends_on",
			ObjectEntityID: "ent_su2", Qualifiers: json.RawMessage(`{}`),
			Polarity: "affirmed", Status: "accepted", Confidence: 1,
			AssertionKey: spanHash,
		}},
		Evidence: []KnowledgeAssertionEvidenceRecord{{
			AssertionID: "ast_self", EvidenceKind: "text_span", BlobHash: receipt.Hash,
			ChunkID: chunkID, StartByte: &start, EndByte: &end,
			Locator: json.RawMessage(`{}`), EvidenceSHA256: spanHash,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	appendTestKnowledgeSnapshot(t, db, objects, project.ID, generation.ID, "ont_project_v1")
	if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID,
		KnowledgeBuilding, KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID,
		KnowledgeValidating, KnowledgeReady, ""); err != nil {
		t.Fatalf("core import terms were not resolved: %v", err)
	}
	if _, err := db.ActivateKnowledgeGeneration(ctx, project.ID, generation.ID); err != nil {
		t.Fatal(err)
	}
	expanded, err := db.expandKnowledgeAssertions(ctx, project.ID, generation.ID, "ont_project_v1", []string{"ent_su2"})
	if err != nil {
		t.Fatal(err)
	}
	if len(expanded) != 1 || expanded[0] != "ast_self" {
		t.Fatalf("directly imported core expandable predicate was not resolved: %v", expanded)
	}
	if _, err := db.DeleteProject(ctx, project.ID); err != nil {
		t.Fatalf("project ontology graph could not be deleted with its project: %v", err)
	}
}
