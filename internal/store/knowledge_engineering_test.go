package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/djkim0320/AetherOps/internal/rag"
)

func TestKnowledgeValidationAllowsArtifactBackedEngineeringEntityWithoutTextMention(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "engineering-only provenance")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte(`{"value":123}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "application/json"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	document, err := db.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "solver result", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
		Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: `{"value":123}`}}, [][]float32{vector})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetDocumentGraphAdopt(ctx, project.ID, document.ID, true); err != nil {
		t.Fatal(err)
	}
	generation, err := db.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	valueSum := sha256.Sum256([]byte("123"))
	valueHash := hex.EncodeToString(valueSum[:])
	assertionSum := sha256.Sum256([]byte("observation-value"))
	startAssertionKey := hex.EncodeToString(assertionSum[:])
	if err := db.AppendKnowledgeProjection(ctx, project.ID, generation.ID, KnowledgeProjection{
		Entities: []KnowledgeEntityRecord{{
			ID: "observation", ClassKey: "measurement", CanonicalName: "Lift coefficient",
			NormalizedName: "lift coefficient",
		}},
		Assertions: []KnowledgeAssertionRecord{{
			ID: "observation_value", SubjectEntityID: "observation", PredicateKey: "has_value",
			Literal:    json.RawMessage(`{"datatype":"number","lexical_form":"123","language":"","unit":"","si_value":"","si_unit":""}`),
			Qualifiers: json.RawMessage(`{}`), Polarity: "affirmed", Status: "accepted",
			Confidence: 1, AssertionKey: startAssertionKey,
		}},
		Evidence: []KnowledgeAssertionEvidenceRecord{{
			AssertionID: "observation_value", EvidenceKind: "artifact_value", BlobHash: receipt.Hash,
			Locator:        json.RawMessage(`{"json_pointer":"/value","value_hash":"` + valueHash + `"}`),
			EvidenceSHA256: valueHash,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	appendTestKnowledgeSnapshot(t, db, objects, project.ID, generation.ID, CoreOntologyID)
	if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID,
		KnowledgeBuilding, KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID,
		KnowledgeValidating, KnowledgeReady, ""); err != nil {
		t.Fatalf("artifact-backed engineering entity was rejected without a synthetic text mention: %v", err)
	}

	// Artifact provenance is correlated through the assertion participants; an
	// unrelated engineering assertion must not bless an orphan entity.
	invalid, err := db.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AppendKnowledgeProjection(ctx, project.ID, invalid.ID, KnowledgeProjection{
		Entities: []KnowledgeEntityRecord{
			{ID: "observation", ClassKey: "measurement", CanonicalName: "Lift coefficient", NormalizedName: "lift coefficient"},
			{ID: "orphan", ClassKey: "measurement", CanonicalName: "Unproven result", NormalizedName: "unproven result"},
		},
		Assertions: []KnowledgeAssertionRecord{{
			ID: "observation_value", SubjectEntityID: "observation", PredicateKey: "has_value",
			Literal:    json.RawMessage(`{"datatype":"number","lexical_form":"123","language":"","unit":"","si_value":"","si_unit":""}`),
			Qualifiers: json.RawMessage(`{}`), Polarity: "affirmed", Status: "accepted",
			Confidence: 1, AssertionKey: startAssertionKey,
		}},
		Evidence: []KnowledgeAssertionEvidenceRecord{{
			AssertionID: "observation_value", EvidenceKind: "artifact_value", BlobHash: receipt.Hash,
			Locator:        json.RawMessage(`{"json_pointer":"/value","value_hash":"` + valueHash + `"}`),
			EvidenceSHA256: valueHash,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, invalid.ID,
		KnowledgeBuilding, KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, invalid.ID,
		KnowledgeValidating, KnowledgeReady, ""); err == nil {
		t.Fatal("unrelated artifact evidence incorrectly proved an orphan engineering entity")
	}
}
