package knowledge

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/rag"
	"github.com/djkim0320/Aether-claw/internal/store"
)

func TestAssertionUpdateIsAtomicTypedAndEvidenceBacked(t *testing.T) {
	ctx := context.Background()
	database, objects := openKnowledgeServiceTestStorage(t)
	project, err := database.CreateProject(ctx, "assertion editor")
	if err != nil {
		t.Fatal(err)
	}
	generation, err := database.CreateKnowledgeGeneration(ctx, project.ID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte(`{"left":1,"right":2}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, receipt, "application/json"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	document, err := database.IndexDocument(ctx, store.Document{
		ProjectID: project.ID, Title: "curation evidence", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions, Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: `{"left":1,"right":2}`}}, [][]float32{vector})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetDocumentGraphAdopt(ctx, project.ID, document.ID, true); err != nil {
		t.Fatal(err)
	}
	leftEvidence, rightEvidence := knowledgeTestSHA("left evidence"), knowledgeTestSHA("right evidence")
	literal := json.RawMessage(`{"lexical_form":"1","datatype":"http://www.w3.org/2001/XMLSchema#decimal","language":"","unit":"","si_value":"","si_unit":""}`)
	if err := database.AppendKnowledgeProjection(ctx, project.ID, generation.ID, store.KnowledgeProjection{
		Entities: []store.KnowledgeEntityRecord{
			{ID: "left", ClassKey: "measurement", CanonicalName: "Left", NormalizedName: "left"},
			{ID: "right", ClassKey: "measurement", CanonicalName: "Right", NormalizedName: "right"},
		},
		Assertions: []store.KnowledgeAssertionRecord{
			{ID: "left-value", SubjectEntityID: "left", PredicateKey: "has_value", Literal: literal, Qualifiers: json.RawMessage(`{}`), Polarity: "affirmed", Status: "accepted", Confidence: 1, AssertionKey: knowledgeTestSHA("left assertion")},
			{ID: "right-value", SubjectEntityID: "right", PredicateKey: "has_value", Literal: literal, Qualifiers: json.RawMessage(`{}`), Polarity: "affirmed", Status: "accepted", Confidence: 1, AssertionKey: knowledgeTestSHA("right assertion")},
		},
		Evidence: []store.KnowledgeAssertionEvidenceRecord{
			{AssertionID: "left-value", EvidenceKind: "artifact_value", BlobHash: receipt.Hash, Locator: json.RawMessage(`{"json_pointer":"/left","value_hash":"` + leftEvidence + `"}`), EvidenceSHA256: leftEvidence},
			{AssertionID: "right-value", EvidenceKind: "artifact_value", BlobHash: receipt.Hash, Locator: json.RawMessage(`{"json_pointer":"/right","value_hash":"` + rightEvidence + `"}`), EvidenceSHA256: rightEvidence},
		},
	}); err != nil {
		t.Fatal(err)
	}
	service := &Service{DB: database, CAS: objects}
	update := json.RawMessage(`{
		"assertion_id":"left-value",
		"evidence_ids":["` + rightEvidence + `"],
		"assertion":{
			"object_literal":{"lexical_form":"1.5","datatype":"aetherops:pressure","language":"","unit":"MPa","si_value":"1500000","si_unit":"Pa"},
			"qualifiers":{"flight_condition":{"entity_id":"right"}},
			"valid_time":{"start":"2026-01-01T00:00:00Z","end":"2026-12-31T23:59:59Z"},
			"polarity":"affirmed","status":"disputed","confidence":0.75
		}
	}`)
	if err := service.applyCurationEvent(ctx, project.ID, generation.ID, "update_assertion", update); err != nil {
		t.Fatal(err)
	}
	var storedLiteral, qualifiers, status, validFrom, validTo string
	var confidence float64
	if err := database.SQL().QueryRowContext(ctx, `
SELECT literal_json,qualifiers_json,status,confidence,valid_from,valid_to
FROM knowledge_assertions WHERE project_id=? AND generation_id=? AND id='left-value'`, project.ID, generation.ID).Scan(
		&storedLiteral, &qualifiers, &status, &confidence, &validFrom, &validTo,
	); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(storedLiteral, `"si_value":"1500000"`) || !strings.Contains(qualifiers, `"entity_id":"right"`) || status != "disputed" || confidence != .75 ||
		validFrom != "2026-01-01T00:00:00.000000000Z" || validTo != "2026-12-31T23:59:59.000000000Z" {
		t.Fatalf("updated assertion was not persisted exactly: literal=%s qualifiers=%s status=%s confidence=%v interval=%s/%s", storedLiteral, qualifiers, status, confidence, validFrom, validTo)
	}
	var oldEvidence, newEvidence int
	if err := database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_assertion_evidence WHERE project_id=? AND generation_id=? AND assertion_id='left-value' AND evidence_sha256=?`, project.ID, generation.ID, leftEvidence).Scan(&oldEvidence); err != nil {
		t.Fatal(err)
	}
	if err := database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_assertion_evidence WHERE project_id=? AND generation_id=? AND assertion_id='left-value' AND evidence_sha256=?`, project.ID, generation.ID, rightEvidence).Scan(&newEvidence); err != nil {
		t.Fatal(err)
	}
	if oldEvidence != 0 || newEvidence != 1 {
		t.Fatalf("evidence replacement = old:%d new:%d, want 0/1", oldEvidence, newEvidence)
	}

	if _, err := database.SQL().ExecContext(ctx, `UPDATE knowledge_assertions SET valid_from=?,valid_to=? WHERE project_id=? AND generation_id=? AND id='left-value'`,
		"2026-01-01T09:00:00+09:00", "2027-01-01T08:59:59+09:00", project.ID, generation.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.applyCurationEvent(ctx, project.ID, generation.ID, "update_assertion",
		json.RawMessage(`{"assertion_id":"left-value","assertion":{"confidence":0.8}}`)); err != nil {
		t.Fatal(err)
	}
	if err := database.SQL().QueryRowContext(ctx, `SELECT valid_from,valid_to FROM knowledge_assertions WHERE project_id=? AND generation_id=? AND id='left-value'`, project.ID, generation.ID).Scan(&validFrom, &validTo); err != nil {
		t.Fatal(err)
	}
	if validFrom != "2026-01-01T00:00:00.000000000Z" || validTo != "2026-12-31T23:59:59.000000000Z" {
		t.Fatalf("untouched legacy interval was not canonicalized: %s/%s", validFrom, validTo)
	}
	if parsed, err := core.ParseKnowledgeTimeBoundary(validFrom); err != nil || parsed == nil {
		t.Fatalf("canonical curation time is unreadable: %v / %v", parsed, err)
	}

	for name, invalidLiteral := range map[string]string{
		"unsupported unit": `{"lexical_form":"1","datatype":"aetherops:length","language":"","unit":"inch","si_value":"0.0254","si_unit":"m"}`,
		"non-finite":       `{"lexical_form":"NaN","datatype":"aetherops:length","language":"","unit":"m","si_value":"0","si_unit":"m"}`,
		"missing fields":   `{"lexical_form":"1","datatype":"number"}`,
	} {
		t.Run(name, func(t *testing.T) {
			payload := json.RawMessage(`{"assertion_id":"left-value","assertion":{"object_literal":` + invalidLiteral + `}}`)
			if err := service.applyCurationEvent(ctx, project.ID, generation.ID, "update_assertion", payload); err == nil {
				t.Fatalf("invalid typed literal was accepted: %s", invalidLiteral)
			}
			var after string
			if err := database.SQL().QueryRowContext(ctx, `SELECT literal_json FROM knowledge_assertions WHERE project_id=? AND generation_id=? AND id='left-value'`, project.ID, generation.ID).Scan(&after); err != nil {
				t.Fatal(err)
			}
			if after != storedLiteral {
				t.Fatalf("failed update partially changed the assertion: before=%s after=%s", storedLiteral, after)
			}
		})
	}
}
