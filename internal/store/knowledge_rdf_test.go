package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/rag"
)

func TestKnowledgeNQuadsCarriesSchemaReificationAndTypedValues(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "canonical RDF")
	if err != nil {
		t.Fatal(err)
	}
	generation, err := db.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AppendKnowledgeProjection(ctx, project.ID, generation.ID, KnowledgeProjection{
		Entities: []KnowledgeEntityRecord{{
			ID: "measurement", ClassKey: "measurement", CanonicalName: "Lift coefficient", NormalizedName: "lift coefficient",
		}},
		Assertions: []KnowledgeAssertionRecord{{
			ID: "value", SubjectEntityID: "measurement", PredicateKey: "has_value",
			Literal:    json.RawMessage(`{"lexical_form":"12.5","datatype":"http://www.w3.org/2001/XMLSchema#decimal","language":"","unit":"","si_value":"","si_unit":""}`),
			Qualifiers: json.RawMessage(`{}`), Polarity: "affirmed", Status: "accepted", Confidence: 1,
			AssertionKey: strings.Repeat("a", 64),
		}},
	}); err != nil {
		t.Fatal(err)
	}

	data, triples, err := db.KnowledgeNQuads(ctx, project.ID, generation.ID, CoreOntologyID)
	if err != nil {
		t.Fatal(err)
	}
	if triples == 0 {
		t.Fatal("canonical RDF snapshot is empty")
	}
	snapshot := string(data)
	for _, required := range []string{
		"<http://www.w3.org/2000/01/rdf-schema#subClassOf> <urn:aetherops:core:Thing>",
		"<urn:aetherops:core:hasValue> \"12.5\"^^<http://www.w3.org/2001/XMLSchema#decimal>",
		"<http://www.w3.org/1999/02/22-rdf-syntax-ns#subject>",
		"<http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate> <urn:aetherops:core:hasValue>",
		"<http://www.w3.org/1999/02/22-rdf-syntax-ns#object> \"12.5\"^^<http://www.w3.org/2001/XMLSchema#decimal>",
		"<urn:aetherops:core:hasValue> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#FunctionalProperty>",
	} {
		if !strings.Contains(snapshot, required) {
			t.Fatalf("canonical RDF snapshot omitted %q:\n%s", required, snapshot)
		}
	}
}

func TestRequiredSnapshotReceiptAndOntologyBindingFailClosed(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "required materialization receipt")
	if err != nil {
		t.Fatal(err)
	}
	head, err := db.ActiveKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.VerifyKnowledgeSnapshot(ctx, project.ID, head.GenerationID, objects); err == nil {
		t.Fatal("snapshotless logical empty project head was accepted as readable")
	}
	if _, err := db.KnowledgeSnapshotReceipt(ctx, project.ID, head.GenerationID); err == nil {
		t.Fatal("strict applied-generation receipt accepted a snapshotless empty head")
	}
	ontology, err := db.KnowledgeGenerationOntologyReceipt(ctx, project.ID, head.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	if ontology.OntologyID != CoreOntologyID || ontology.CanonicalSHA256 == "" {
		t.Fatalf("unexpected ontology receipt: %+v", ontology)
	}
}

func TestKnowledgeGenerationRetentionDetectsDroppedProjectionRows(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "retained graph lineage")
	if err != nil {
		t.Fatal(err)
	}
	sourceReceipt, err := objects.PutBytes([]byte("retained source"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, sourceReceipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	chunks := rag.ChunkText("retained source", rag.DefaultChunkRunes, rag.DefaultOverlapRunes)
	vectors := make([][]float32, len(chunks))
	for index := range vectors {
		vectors[index] = make([]float32, rag.EmbeddingDimensions)
		vectors[index][0] = 1
	}
	document, err := db.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "Retained source", BlobHash: sourceReceipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions, Pinned: true,
	}, chunks, vectors)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `UPDATE documents SET graph_adopt=1 WHERE id=?`, document.ID); err != nil {
		t.Fatal(err)
	}
	var chunkID, textHash string
	if err := db.SQL().QueryRowContext(ctx, `SELECT id,text_hash FROM chunks WHERE document_id=?`, document.ID).Scan(&chunkID, &textHash); err != nil {
		t.Fatal(err)
	}
	source := KnowledgeSourceRecord{
		ChunkID: chunkID, BlobHash: sourceReceipt.Hash, SourceKind: "evidence",
		SourceLocator: json.RawMessage(`{"run_id":"retention"}`), TextHash: textHash,
	}
	ancestor, err := db.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AppendKnowledgeProjection(ctx, project.ID, ancestor.ID, KnowledgeProjection{Sources: []KnowledgeSourceRecord{source}}); err != nil {
		t.Fatal(err)
	}
	appendTestKnowledgeSnapshot(t, db, objects, project.ID, ancestor.ID, CoreOntologyID)
	if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, ancestor.ID, KnowledgeBuilding, KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, ancestor.ID, KnowledgeValidating, KnowledgeReady, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ActivateKnowledgeGeneration(ctx, project.ID, ancestor.ID); err != nil {
		t.Fatal(err)
	}

	descendant, err := db.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AppendKnowledgeProjection(ctx, project.ID, descendant.ID, KnowledgeProjection{Sources: []KnowledgeSourceRecord{source}}); err != nil {
		t.Fatal(err)
	}
	appendTestKnowledgeSnapshot(t, db, objects, project.ID, descendant.ID, CoreOntologyID)
	if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, descendant.ID, KnowledgeBuilding, KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, descendant.ID, KnowledgeValidating, KnowledgeReady, ""); err != nil {
		t.Fatal(err)
	}
	if err := db.VerifyKnowledgeGenerationRetention(ctx, project.ID, ancestor.ID, descendant.ID); err != nil {
		t.Fatalf("identical descendant projection was rejected: %v", err)
	}

	dropped, err := db.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	appendTestKnowledgeSnapshot(t, db, objects, project.ID, dropped.ID, CoreOntologyID)
	if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, dropped.ID, KnowledgeBuilding, KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, dropped.ID, KnowledgeValidating, KnowledgeReady, ""); err != nil {
		t.Fatal(err)
	}
	if err := db.VerifyKnowledgeGenerationRetention(ctx, project.ID, ancestor.ID, dropped.ID); err == nil || !strings.Contains(err.Error(), "source") {
		t.Fatalf("dropped ancestor projection was not rejected: %v", err)
	}
}
