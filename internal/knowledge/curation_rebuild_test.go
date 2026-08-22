package knowledge

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/rag"
	"github.com/djkim0320/Aether-claw/internal/store"
)

func TestPendingConflictCurationIsAppliedAfterConflictRecalculation(t *testing.T) {
	ctx := context.Background()
	database, objects := openKnowledgeServiceTestStorage(t)
	project, err := database.CreateProject(ctx, "conflict curation")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte("measured value"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, receipt, "text/plain; charset=utf-8"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	document, err := database.IndexDocument(ctx, store.Document{
		ProjectID: project.ID, Title: "measurement", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions, Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: "measured value"}}, [][]float32{vector})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetDocumentGraphAdopt(ctx, project.ID, document.ID, true); err != nil {
		t.Fatal(err)
	}
	var chunkID, chunkHash string
	if err := database.SQL().QueryRowContext(ctx, "SELECT id,text_hash FROM chunks WHERE document_id=?", document.ID).Scan(&chunkID, &chunkHash); err != nil {
		t.Fatal(err)
	}
	generation, err := database.CreateKnowledgeGeneration(ctx, project.ID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	start, end := 0, len("measured value")
	spanHash := knowledgeTestSHA("measured value")
	projection := store.KnowledgeProjection{
		Sources: []store.KnowledgeSourceRecord{{
			ChunkID: chunkID, BlobHash: receipt.Hash, SourceKind: "pinned",
			SourceLocator: json.RawMessage(`{"document_id":"measurement"}`), TextHash: chunkHash,
		}},
		Entities: []store.KnowledgeEntityRecord{{
			ID: "measurement", ClassKey: "measurement", CanonicalName: "Measurement", NormalizedName: "measurement",
		}},
		Mentions: []store.KnowledgeMentionRecord{{
			ID: "mention", EntityID: "measurement", ChunkID: chunkID,
			StartByte: start, EndByte: end, ExcerptSHA256: spanHash,
		}},
		Assertions: []store.KnowledgeAssertionRecord{
			{ID: "value-left", SubjectEntityID: "measurement", PredicateKey: "has_value", Literal: json.RawMessage(`{"lexical_form":"1","datatype":"http://www.w3.org/2001/XMLSchema#decimal","language":"","unit":"","si_value":"","si_unit":""}`), Qualifiers: json.RawMessage(`{"condition":{"literal":{"lexical_form":"cruise","datatype":"http://www.w3.org/2001/XMLSchema#string","language":"","unit":"","si_value":"","si_unit":""}}}`), Polarity: "affirmed", Status: "accepted", Confidence: 1, AssertionKey: knowledgeTestSHA("left")},
			{ID: "value-right", SubjectEntityID: "measurement", PredicateKey: "has_value", Literal: json.RawMessage(`{"lexical_form":"2","datatype":"http://www.w3.org/2001/XMLSchema#decimal","language":"","unit":"","si_value":"","si_unit":""}`), Qualifiers: json.RawMessage(`{"condition":{"literal":{"lexical_form":"cruise","datatype":"http://www.w3.org/2001/XMLSchema#string","language":"","unit":"","si_value":"","si_unit":""}}}`), Polarity: "affirmed", Status: "accepted", Confidence: 1, AssertionKey: knowledgeTestSHA("right")},
		},
		Evidence: []store.KnowledgeAssertionEvidenceRecord{
			{AssertionID: "value-left", EvidenceKind: "text_span", BlobHash: receipt.Hash, ChunkID: chunkID, StartByte: &start, EndByte: &end, Locator: json.RawMessage(`{}`), EvidenceSHA256: spanHash},
			{AssertionID: "value-right", EvidenceKind: "text_span", BlobHash: receipt.Hash, ChunkID: chunkID, StartByte: &start, EndByte: &end, Locator: json.RawMessage(`{}`), EvidenceSHA256: spanHash},
		},
		Conflicts: []store.KnowledgeConflictRecord{{
			ID: "conflict-stable", LeftAssertionID: "value-left", RightAssertionID: "value-right",
			Reason: "functional values disagree", Status: "open",
		}},
	}
	if err := database.AppendKnowledgeProjection(ctx, project.ID, generation.ID, projection); err != nil {
		t.Fatal(err)
	}
	appendKnowledgeServiceTestSnapshot(t, database, objects, project.ID, generation.ID, store.CoreOntologyID)
	if _, err := database.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID, store.KnowledgeBuilding, store.KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID, store.KnowledgeValidating, store.KnowledgeReady, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ActivateKnowledgeGeneration(ctx, project.ID, generation.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.AppendKnowledgeCuration(ctx, project.ID, generation.ID, "resolve_conflict", "user", json.RawMessage(`{"conflict_id":"conflict-stable"}`)); err != nil {
		t.Fatal(err)
	}
	target, err := database.CreateKnowledgeGeneration(ctx, project.ID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{DB: database, CAS: objects}
	if err := service.copyActiveProjection(ctx, project.ID, generation, target); err != nil {
		t.Fatal(err)
	}
	pending, err := service.applyPendingCuration(ctx, project.ID, generation.ID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].Kind != "resolve_conflict" {
		t.Fatalf("pending conflict curation = %+v", pending)
	}
	var status string
	if err := database.SQL().QueryRowContext(ctx, "SELECT status FROM knowledge_conflicts WHERE project_id=? AND generation_id=? AND id='conflict-stable'", project.ID, target.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "open" {
		t.Fatalf("conflict resolution applied before reasoning: %s", status)
	}
	if err := service.rekeyKnowledgeAssertions(ctx, project.ID, target.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.materializeOntologyProjection(ctx, project.ID, target.ID); err != nil {
		t.Fatal(err)
	}
	for _, event := range pending {
		if err := service.applyCurationEvent(ctx, project.ID, target.ID, event.Kind, event.Payload); err != nil {
			t.Fatal(err)
		}
	}
	if err := database.SQL().QueryRowContext(ctx, "SELECT status FROM knowledge_conflicts WHERE project_id=? AND generation_id=? AND id='conflict-stable'", project.ID, target.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "resolved" {
		t.Fatalf("conflict resolution after reasoning = %s, want resolved", status)
	}
}
