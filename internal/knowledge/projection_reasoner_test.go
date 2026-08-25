package knowledge

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/rag"
	"github.com/djkim0320/AetherOps/internal/store"
)

func TestProjectionReasonerAppliesSubPropertyToDatatypeLiteral(t *testing.T) {
	literal := `{"lexical_form":"42","datatype":"http://www.w3.org/2001/XMLSchema#decimal","language":"","unit":"","si_value":"","si_unit":""}`
	asserted := projectionStatement{
		ID: "asserted-literal", Subject: "measurement", Predicate: "specific_value", Literal: literal,
		Qualifiers: `{}`, Polarity: "affirmed", Status: "accepted", Confidence: 1,
	}
	evidence := map[string][]store.KnowledgeAssertionEvidenceRecord{
		asserted.ID: {{AssertionID: asserted.ID, EvidenceKind: "text_span", BlobHash: strings.Repeat("a", 64), EvidenceSHA256: strings.Repeat("b", 64)}},
	}
	projection, statements, err := deriveKnowledgeProjection(
		[]projectionStatement{asserted}, evidence, nil,
		[]projectionRule{{OntologyID: "ontology", AxiomID: "axiom-subproperty", Kind: "subproperty_of", From: "specific_value", To: "general_value"}},
		"ontology", 16,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(projection.Assertions) != 1 || len(projection.Inferences) != 1 || len(projection.Proofs) != 1 || len(statements) != 2 {
		t.Fatalf("datatype subPropertyOf projection is incomplete: assertions=%+v inferences=%+v proofs=%+v statements=%+v", projection.Assertions, projection.Inferences, projection.Proofs, statements)
	}
	derived := projection.Assertions[0]
	if derived.PredicateKey != "general_value" || string(derived.Literal) != literal || derived.ObjectEntityID != "" ||
		projection.Proofs[0].PremiseAssertionID != asserted.ID {
		t.Fatalf("datatype subPropertyOf conclusion lost literal/proof semantics: assertion=%+v proof=%+v", derived, projection.Proofs[0])
	}
}

func TestDeriveKnowledgeProjectionCarriesProofsAndEvidence(t *testing.T) {
	statements := []projectionStatement{
		{ID: "a1", Subject: "wing", Predicate: "part_of", ObjectEntity: "aircraft", Qualifiers: "{}", Polarity: "affirmed", Status: "accepted", Confidence: .9},
		{ID: "a2", Subject: "aircraft", Predicate: "part_of", ObjectEntity: "fleet", Qualifiers: "{}", Polarity: "affirmed", Status: "accepted", Confidence: .8},
	}
	evidence := map[string][]store.KnowledgeAssertionEvidenceRecord{
		"a1": {{EvidenceKind: "text_span", BlobHash: reasoningSHA256("blob-1"), ChunkID: "chunk-1", EvidenceSHA256: reasoningSHA256("span-1"), Locator: json.RawMessage(`{}`)}},
		"a2": {{EvidenceKind: "text_span", BlobHash: reasoningSHA256("blob-2"), ChunkID: "chunk-2", EvidenceSHA256: reasoningSHA256("span-2"), Locator: json.RawMessage(`{}`)}},
	}
	rules := []projectionRule{
		{OntologyID: "ont", AxiomID: "ax_subproperty", Kind: "subproperty_of", From: "part_of", To: "depends_on"},
		{OntologyID: "ont", AxiomID: "ax_transitive", Kind: "transitive", From: "part_of", To: "part_of"},
	}
	projection, all, err := deriveKnowledgeProjection(statements, evidence, nil, rules, "ont", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(projection.Inferences) == 0 || len(projection.Assertions) != len(projection.Inferences) {
		t.Fatalf("derived projection = %+v", projection)
	}
	var transitiveID string
	for _, assertion := range projection.Assertions {
		if assertion.SubjectEntityID == "wing" && assertion.PredicateKey == "part_of" && assertion.ObjectEntityID == "fleet" {
			transitiveID = assertion.ID
			if assertion.Confidence != .8 {
				t.Fatalf("transitive confidence = %v, want .8", assertion.Confidence)
			}
		}
	}
	if transitiveID == "" {
		t.Fatalf("transitive conclusion missing: %+v", all)
	}
	proofParents := map[string]bool{}
	for _, proof := range projection.Proofs {
		if proof.InferenceID == transitiveID {
			proofParents[proof.PremiseAssertionID] = true
		}
	}
	if !proofParents["a1"] || !proofParents["a2"] || len(proofParents) != 2 {
		t.Fatalf("transitive proof parents = %v", proofParents)
	}
	evidenceHashes := map[string]bool{}
	for _, record := range projection.Evidence {
		if record.AssertionID == transitiveID {
			evidenceHashes[record.EvidenceSHA256] = true
		}
	}
	if len(evidenceHashes) != 2 {
		t.Fatalf("transitive evidence inheritance = %v", evidenceHashes)
	}
}

func TestDeriveKnowledgeProjectionCarriesRDFSTypeProofs(t *testing.T) {
	statements := []projectionStatement{{
		ID: "a1", Subject: "wing", Predicate: "mounted_on", ObjectEntity: "aircraft",
		Qualifiers: "{}", Polarity: "affirmed", Status: "accepted", Confidence: 1,
	}}
	evidence := map[string][]store.KnowledgeAssertionEvidenceRecord{
		"a1": {{EvidenceKind: "text_span", BlobHash: reasoningSHA256("blob"), ChunkID: "chunk", EvidenceSHA256: reasoningSHA256("span"), Locator: json.RawMessage(`{}`)}},
	}
	rules := []projectionRule{
		{OntologyID: "ont", AxiomID: "ax_domain", Kind: "domain", From: "mounted_on", To: "component"},
		{OntologyID: "ont", AxiomID: "ax_range", Kind: "range", From: "mounted_on", To: "physical_system"},
		{OntologyID: "ont", AxiomID: "ax_component_thing", Kind: "subclass_of", From: "component", To: "thing"},
		{OntologyID: "ont", AxiomID: "ax_system_thing", Kind: "subclass_of", From: "physical_system", To: "thing"},
	}
	projection, _, err := deriveKnowledgeProjection(statements, evidence,
		[]projectionEntityClass{{EntityID: "wing", ClassKey: "component"}, {EntityID: "aircraft", ClassKey: "physical_system"}},
		rules, "ont", 100)
	if err != nil {
		t.Fatal(err)
	}
	// Domain/range conclusions duplicate the explicit types, while both
	// subclass conclusions must remain as persisted, proof-carrying rdf:type.
	if len(projection.TypeInferences) != 2 || len(projection.TypeProofs) != 2 {
		t.Fatalf("type projection = %+v / %+v", projection.TypeInferences, projection.TypeProofs)
	}
	for _, inference := range projection.TypeInferences {
		if inference.ClassKey != "thing" || inference.RuleAxiomID == "" {
			t.Fatalf("unexpected type inference: %+v", inference)
		}
	}
	for _, proof := range projection.TypeProofs {
		if proof.PremiseKind != "entity_class" || proof.PremiseEntityID == "" || proof.PremiseClassKey == "" {
			t.Fatalf("unexpected type proof: %+v", proof)
		}
	}
}

func TestDeriveKnowledgeProjectionDomainAndRangeCreateTypes(t *testing.T) {
	statements := []projectionStatement{{
		ID: "a1", Subject: "wing", Predicate: "mounted_on", ObjectEntity: "aircraft",
		Qualifiers: "{}", Polarity: "affirmed", Status: "accepted", Confidence: 1,
	}}
	rules := []projectionRule{
		{OntologyID: "ont", AxiomID: "ax_domain", Kind: "domain", From: "mounted_on", To: "component"},
		{OntologyID: "ont", AxiomID: "ax_range", Kind: "range", From: "mounted_on", To: "physical_system"},
	}
	projection, _, err := deriveKnowledgeProjection(statements, map[string][]store.KnowledgeAssertionEvidenceRecord{},
		[]projectionEntityClass{{EntityID: "wing", ClassKey: "thing"}, {EntityID: "aircraft", ClassKey: "thing"}},
		rules, "ont", 100)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, inference := range projection.TypeInferences {
		got[inference.EntityID] = inference.ClassKey
	}
	if got["wing"] != "component" || got["aircraft"] != "physical_system" {
		t.Fatalf("domain/range types = %v", got)
	}
	for _, proof := range projection.TypeProofs {
		if proof.PremiseKind != "assertion" || proof.PremiseAssertionID != "a1" {
			t.Fatalf("domain/range proof = %+v", proof)
		}
	}
}

func TestMaterializedRDFSTypesPersistWithProofsAndEnterSnapshot(t *testing.T) {
	ctx := context.Background()
	database, objects := openKnowledgeServiceTestStorage(t)
	project, err := database.CreateProject(ctx, "proof-carrying RDFS materialization")
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{DB: database, CAS: objects}
	ontologyValue, err := service.ImportOntology(ctx, project.ID, "engineering.ttl", "text/turtle", []byte(`
@prefix ex: <urn:test:> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
ex:Thing a rdfs:Class .
ex:Component a rdfs:Class ; rdfs:subClassOf ex:Thing .
ex:Vehicle a rdfs:Class ; rdfs:subClassOf ex:Thing .
ex:mountedOn a owl:ObjectProperty ; rdfs:domain ex:Component ; rdfs:range ex:Vehicle .`))
	if err != nil {
		t.Fatal(err)
	}
	ontologyID := ontologyValue.(map[string]any)["ontology_version_id"].(string)
	if _, err := service.ActivateOntology(ctx, project.ID, ontologyID); err != nil {
		t.Fatal(err)
	}

	const sourceText = "Wing is mounted on Aircraft. Strut is a component."
	receipt, err := objects.PutBytes([]byte(sourceText))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, receipt, "text/plain; charset=utf-8"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	document, err := database.IndexDocument(ctx, store.Document{
		ProjectID: project.ID, Title: "RDFS evidence", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions, Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: sourceText}}, [][]float32{vector})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetDocumentGraphAdopt(ctx, project.ID, document.ID, true); err != nil {
		t.Fatal(err)
	}
	var chunkID, textHash string
	if err := database.SQL().QueryRowContext(ctx, `SELECT id,text_hash FROM chunks WHERE document_id=?`, document.ID).Scan(&chunkID, &textHash); err != nil {
		t.Fatal(err)
	}
	generation, err := database.CreateKnowledgeGeneration(ctx, project.ID, ontologyID, ontologyValue.(map[string]any)["canonical_sha256"].(string))
	if err != nil {
		t.Fatal(err)
	}
	span := func(value string) store.KnowledgeMentionRecord {
		start := strings.Index(sourceText, value)
		return store.KnowledgeMentionRecord{ID: "men_" + strings.ToLower(value), EntityID: "ent_" + strings.ToLower(value), ChunkID: chunkID,
			StartByte: start, EndByte: start + len(value), ExcerptSHA256: knowledgeTestSHA(value)}
	}
	start, end := 0, len(sourceText)
	projection := store.KnowledgeProjection{
		Sources: []store.KnowledgeSourceRecord{{ChunkID: chunkID, BlobHash: receipt.Hash, SourceKind: "pinned", SourceLocator: json.RawMessage(`{"document":"RDFS evidence"}`), TextHash: textHash}},
		Entities: []store.KnowledgeEntityRecord{
			{ID: "ent_wing", ClassKey: "urn_test_thing", CanonicalName: "Wing", NormalizedName: "wing"},
			{ID: "ent_aircraft", ClassKey: "urn_test_thing", CanonicalName: "Aircraft", NormalizedName: "aircraft"},
			{ID: "ent_strut", ClassKey: "urn_test_component", CanonicalName: "Strut", NormalizedName: "strut"},
		},
		Mentions: []store.KnowledgeMentionRecord{span("Wing"), span("Aircraft"), span("Strut")},
		Assertions: []store.KnowledgeAssertionRecord{{
			ID: "ast_mounted", SubjectEntityID: "ent_wing", PredicateKey: "urn_test_mountedon", ObjectEntityID: "ent_aircraft",
			Qualifiers: json.RawMessage(`{}`), Polarity: "affirmed", Status: "accepted", Confidence: 1,
			AssertionKey: knowledgeTestSHA("ent_wing|urn_test_mountedon|ent_aircraft"),
		}},
		Evidence: []store.KnowledgeAssertionEvidenceRecord{{
			AssertionID: "ast_mounted", EvidenceKind: "text_span", BlobHash: receipt.Hash, ChunkID: chunkID,
			StartByte: &start, EndByte: &end, Locator: json.RawMessage(`{}`), EvidenceSHA256: knowledgeTestSHA(sourceText),
		}},
	}
	if err := database.AppendKnowledgeProjection(ctx, project.ID, generation.ID, projection); err != nil {
		t.Fatal(err)
	}
	_, loadedRules, _, err := service.loadProjectionRules(ctx, project.ID, generation.ID)
	if err != nil {
		t.Fatal(err)
	}
	customRules := 0
	for _, rule := range loadedRules {
		if rule.OntologyID == ontologyID {
			customRules++
		}
	}
	if customRules != 4 {
		t.Fatalf("loaded custom ontology rules = %d in %+v", customRules, loadedRules)
	}
	if err := service.materializeOntologyProjection(ctx, project.ID, generation.ID); err != nil {
		t.Fatal(err)
	}
	var typeCount, proofCount int
	if err := database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_type_inferences WHERE project_id=? AND generation_id=?`, project.ID, generation.ID).Scan(&typeCount); err != nil {
		t.Fatal(err)
	}
	if err := database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_type_inference_proofs WHERE project_id=? AND generation_id=?`, project.ID, generation.ID).Scan(&proofCount); err != nil {
		t.Fatal(err)
	}
	if typeCount != 3 || proofCount != 3 {
		t.Fatalf("persisted type projection counts = %d/%d, want 3/3", typeCount, proofCount)
	}
	var assertionPremises, entityClassPremises int
	if err := database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_type_inference_proofs WHERE project_id=? AND generation_id=? AND premise_kind='assertion'`, project.ID, generation.ID).Scan(&assertionPremises); err != nil {
		t.Fatal(err)
	}
	if err := database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_type_inference_proofs WHERE project_id=? AND generation_id=? AND premise_kind='entity_class'`, project.ID, generation.ID).Scan(&entityClassPremises); err != nil {
		t.Fatal(err)
	}
	if assertionPremises != 2 || entityClassPremises != 1 {
		t.Fatalf("proof premise kinds = assertion:%d entity_class:%d", assertionPremises, entityClassPremises)
	}
	snapshot, tripleCount, err := service.generationNQuads(ctx, project.ID, generation.ID, ontologyID)
	if err != nil {
		t.Fatal(err)
	}
	for _, classIRI := range []string{"urn:test:Component", "urn:test:Vehicle", "urn:test:Thing"} {
		if !strings.Contains(string(snapshot), "<"+rdfNS+"type> <"+classIRI+">") {
			t.Fatalf("snapshot omitted inferred class %s:\n%s", classIRI, snapshot)
		}
	}
	snapshotReceipt, err := objects.PutBytes(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, snapshotReceipt, "application/n-quads"); err != nil {
		t.Fatal(err)
	}
	if err := database.AppendKnowledgeProjection(ctx, project.ID, generation.ID, store.KnowledgeProjection{Snapshots: []store.KnowledgeRDFSnapshotRecord{{
		ID: "krdf_test", Format: "n-quads", BlobHash: snapshotReceipt.Hash, DatasetSHA256: snapshotReceipt.Hash, TripleCount: tripleCount,
	}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID, store.KnowledgeBuilding, store.KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID, store.KnowledgeValidating, store.KnowledgeReady, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL().ExecContext(ctx, `DELETE FROM knowledge_type_inferences WHERE project_id=? AND generation_id=?`, project.ID, generation.ID); err == nil {
		t.Fatal("ready generation allowed inferred type deletion")
	}
}

func TestDetectProjectionConflictsUsesQualifiersAndTime(t *testing.T) {
	start := time.Date(2026, 8, 8, 0, 0, 0, 0, time.UTC)
	middle := start.Add(time.Hour)
	end := start.Add(2 * time.Hour)
	statements := []projectionStatement{
		{ID: "left", Subject: "run", Predicate: "has_value", Literal: `{"value":1}`, Qualifiers: `{"condition":"cruise"}`, Polarity: "affirmed", Status: "accepted", ValidFrom: &start, ValidTo: &end},
		{ID: "right", Subject: "run", Predicate: "has_value", Literal: `{"value":2}`, Qualifiers: `{"condition":"cruise"}`, Polarity: "affirmed", Status: "accepted", ValidFrom: &middle, ValidTo: &end},
		{ID: "other-condition", Subject: "run", Predicate: "has_value", Literal: `{"value":3}`, Qualifiers: `{"condition":"landing"}`, Polarity: "affirmed", Status: "accepted", ValidFrom: &start, ValidTo: &end},
	}
	conflicts := detectProjectionConflicts(statements, map[string]bool{"has_value": true})
	if len(conflicts) != 1 || conflicts[0].LeftAssertionID != "left" || conflicts[0].RightAssertionID != "right" {
		t.Fatalf("qualifier-aware conflicts = %+v", conflicts)
	}
}
