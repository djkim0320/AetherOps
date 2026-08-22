package store

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestKnowledgeTypeInferenceValidationRejectsSemanticMismatch(t *testing.T) {
	ctx := context.Background()
	db, _ := openTestDB(t)
	project, err := db.CreateProject(ctx, "invalid type proof")
	if err != nil {
		t.Fatal(err)
	}
	generation, err := db.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AppendKnowledgeProjection(ctx, project.ID, generation.ID, KnowledgeProjection{
		Entities: []KnowledgeEntityRecord{{ID: "solver", ClassKey: "software", CanonicalName: "Solver", NormalizedName: "solver"}},
		TypeInferences: []KnowledgeTypeInferenceRecord{{
			ID: "bad_type", EntityID: "solver", ClassKey: "thing", OntologyID: CoreOntologyID,
			RuleAxiomID: "ax_subclass_component", Status: "accepted",
		}},
		TypeProofs: []KnowledgeTypeInferenceProofRecord{{
			InferenceID: "bad_type", Ordinal: 0, PremiseKind: "entity_class",
			PremiseEntityID: "solver", PremiseClassKey: "software",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	tx, err := db.SQL().BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := validateKnowledgeTypeInferenceProofs(ctx, tx, project.ID, generation.ID); err == nil || !strings.Contains(err.Error(), "invalid entity-class premise") {
		t.Fatalf("semantic type-proof mismatch was accepted: %v", err)
	}
}

func TestKnowledgeTypeInferenceValidationRejectsProofCycle(t *testing.T) {
	ctx := context.Background()
	db, objects := openTestDB(t)
	project, err := db.CreateProject(ctx, "cyclic type proof")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte("cyclic ontology"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/turtle"); err != nil {
		t.Fatal(err)
	}
	now := formatTime(time.Now())
	if _, err := db.SQL().ExecContext(ctx, `
INSERT INTO ontology_versions(id,project_id,semantic_version,source_blob_hash,canonical_blob_hash,canonical_sha256,triple_count,state,created_at)
VALUES('ont_cycle',?,'1',?,?,?,4,'draft',?)`, project.ID, receipt.Hash, receipt.Hash, receipt.Hash, now); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"a", "b"} {
		if _, err := db.SQL().ExecContext(ctx, `
INSERT INTO ontology_terms(ontology_id,term_key,iri,kind,label,created_at)
VALUES('ont_cycle',?,?, 'class',?,?)`, key, "urn:cycle:"+key, strings.ToUpper(key), now); err != nil {
			t.Fatal(err)
		}
	}
	for _, axiom := range []struct{ id, from, to string }{{"a_to_b", "a", "b"}, {"b_to_a", "b", "a"}} {
		if _, err := db.SQL().ExecContext(ctx, `
INSERT INTO ontology_axioms(ontology_id,id,axiom_type,subject_key,object_key,created_at)
VALUES('ont_cycle',?,'subclass_of',?,?,?)`, axiom.id, axiom.from, axiom.to, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.SQL().ExecContext(ctx, `
INSERT INTO ontology_imports(ontology_id,imported_ontology_id,required,created_at)
VALUES('ont_cycle',?,1,?)`, CoreOntologyID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `UPDATE ontology_versions SET state='active',activated_at=? WHERE id='ont_cycle'`, now); err != nil {
		t.Fatal(err)
	}
	generation, err := db.CreateKnowledgeGeneration(ctx, project.ID, "ont_cycle", receipt.Hash)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AppendKnowledgeProjection(ctx, project.ID, generation.ID, KnowledgeProjection{
		Entities: []KnowledgeEntityRecord{{ID: "entity", ClassKey: "a", CanonicalName: "Entity", NormalizedName: "entity"}},
		TypeInferences: []KnowledgeTypeInferenceRecord{
			{ID: "infer_b", EntityID: "entity", ClassKey: "b", OntologyID: "ont_cycle", RuleAxiomID: "a_to_b", Status: "accepted"},
			{ID: "infer_a", EntityID: "entity", ClassKey: "a", OntologyID: "ont_cycle", RuleAxiomID: "b_to_a", Status: "accepted"},
		},
		TypeProofs: []KnowledgeTypeInferenceProofRecord{
			{InferenceID: "infer_b", Ordinal: 0, PremiseKind: "type_inference", PremiseTypeInferenceID: "infer_a"},
			{InferenceID: "infer_a", Ordinal: 0, PremiseKind: "type_inference", PremiseTypeInferenceID: "infer_b"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	tx, err := db.SQL().BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := validateKnowledgeTypeInferenceProofs(ctx, tx, project.ID, generation.ID); err == nil || !strings.Contains(err.Error(), "proof cycle") {
		t.Fatalf("cyclic type proof was accepted: %v", err)
	}
}

func TestKnowledgeSnapshotBindingRejectsUnrelatedCASDataset(t *testing.T) {
	ctx := context.Background()
	db, objects := openTestDB(t)
	project, err := db.CreateProject(ctx, "snapshot binding")
	if err != nil {
		t.Fatal(err)
	}
	generation, err := db.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	unrelated, err := objects.PutBytes([]byte("<urn:other> <urn:leaks> <urn:data> .\n"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, unrelated, "application/n-quads"); err != nil {
		t.Fatal(err)
	}
	if err := db.AppendKnowledgeProjection(ctx, project.ID, generation.ID, KnowledgeProjection{
		Entities:  []KnowledgeEntityRecord{{ID: "local", ClassKey: "concept", CanonicalName: "Local", NormalizedName: "local"}},
		Snapshots: []KnowledgeRDFSnapshotRecord{{ID: "wrong", Format: "n-quads", BlobHash: unrelated.Hash, DatasetSHA256: unrelated.Hash, TripleCount: 1}},
	}); err != nil {
		t.Fatal(err)
	}
	tx, err := db.SQL().BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := validateKnowledgeSnapshotBinding(ctx, tx, project.ID, generation.ID, CoreOntologyID, knowledgeCounts{entities: 1}); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("unrelated RDF dataset was accepted: %v", err)
	}
}
