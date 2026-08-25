package knowledge

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/memory"
	"github.com/djkim0320/AetherOps/internal/rag"
	"github.com/djkim0320/AetherOps/internal/store"
)

type curationMemoEmbeddingProtocol struct{}

func (curationMemoEmbeddingProtocol) Embed(_ context.Context, inputs []string) ([][]float32, error) {
	vectors := make([][]float32, len(inputs))
	for index, input := range inputs {
		vector := make([]float32, rag.EmbeddingDimensions)
		vector[0] = float32(len([]byte(input)))
		vector[1] = 1
		vectors[index] = vector
	}
	return vectors, nil
}

type curationPreflightFixture struct {
	service      *Service
	database     *store.DB
	projectID    string
	generationID string
	evidenceHash string
}

func newCurationPreflightFixture(t *testing.T, duplicateAfterMerge bool) curationPreflightFixture {
	t.Helper()
	ctx := context.Background()
	database, objects := openKnowledgeServiceTestStorage(t)
	project, err := database.CreateProject(ctx, "curation preflight")
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
		ProjectID: project.ID, Title: "curation evidence", BlobHash: receipt.Hash,
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
	spanHash := knowledgeTestSHA("measured value")
	start, end := 0, len("measured value")
	entities := []store.KnowledgeEntityRecord{{
		ID: "left", ClassKey: "measurement", CanonicalName: "Left", NormalizedName: "left",
	}}
	mentions := []store.KnowledgeMentionRecord{{
		ID: "mention-left", EntityID: "left", ChunkID: chunkID,
		StartByte: start, EndByte: end, ExcerptSHA256: spanHash,
	}}
	assertions := []store.KnowledgeAssertionRecord{{
		ID: "left-value", SubjectEntityID: "left", PredicateKey: "has_value",
		Literal:    json.RawMessage(`{"lexical_form":"1","datatype":"http://www.w3.org/2001/XMLSchema#decimal","language":"","unit":"","si_value":"","si_unit":""}`),
		Qualifiers: json.RawMessage(`{}`), Polarity: "affirmed", Status: "accepted", Confidence: 1,
		AssertionKey: knowledgeTestSHA("left-value-active"),
	}}
	evidence := []store.KnowledgeAssertionEvidenceRecord{{
		AssertionID: "left-value", EvidenceKind: "text_span", BlobHash: receipt.Hash,
		ChunkID: chunkID, StartByte: &start, EndByte: &end, Locator: json.RawMessage(`{}`), EvidenceSHA256: spanHash,
	}}
	if duplicateAfterMerge {
		rightStart, rightEnd := len("measured "), len("measured value")
		entities = append(entities, store.KnowledgeEntityRecord{
			ID: "right", ClassKey: "measurement", CanonicalName: "Right", NormalizedName: "right",
		})
		mentions = append(mentions, store.KnowledgeMentionRecord{
			ID: "mention-right", EntityID: "right", ChunkID: chunkID,
			StartByte: rightStart, EndByte: rightEnd, ExcerptSHA256: knowledgeTestSHA("value"),
		})
		assertions = append(assertions, store.KnowledgeAssertionRecord{
			ID: "right-value", SubjectEntityID: "right", PredicateKey: "has_value",
			Literal:    json.RawMessage(`{"lexical_form":"1","datatype":"http://www.w3.org/2001/XMLSchema#decimal","language":"","unit":"","si_value":"","si_unit":""}`),
			Qualifiers: json.RawMessage(`{}`), Polarity: "affirmed", Status: "accepted", Confidence: 1,
			AssertionKey: knowledgeTestSHA("right-value-active"),
		})
		evidence = append(evidence, store.KnowledgeAssertionEvidenceRecord{
			AssertionID: "right-value", EvidenceKind: "text_span", BlobHash: receipt.Hash,
			ChunkID: chunkID, StartByte: &start, EndByte: &end, Locator: json.RawMessage(`{}`), EvidenceSHA256: spanHash,
		})
	}
	if err := database.AppendKnowledgeProjection(ctx, project.ID, generation.ID, store.KnowledgeProjection{
		Sources: []store.KnowledgeSourceRecord{{
			ChunkID: chunkID, BlobHash: receipt.Hash, SourceKind: "pinned",
			SourceLocator: json.RawMessage(`{"document_id":"curation"}`), TextHash: chunkHash,
		}},
		Entities: entities, Mentions: mentions, Assertions: assertions, Evidence: evidence,
	}); err != nil {
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
	indexer := &memory.Service{DB: database, CAS: objects, Embedder: curationMemoEmbeddingProtocol{}}
	return curationPreflightFixture{
		service: &Service{DB: database, CAS: objects, Memory: indexer}, database: database,
		projectID: project.ID, generationID: generation.ID, evidenceHash: spanHash,
	}
}

func TestApplyEditRejectsInvalidGraphBeforeAppendOnlyLedger(t *testing.T) {
	ctx := context.Background()
	fixture := newCurationPreflightFixture(t, false)
	headBefore, err := fixture.database.ActiveKnowledgeGeneration(ctx, fixture.projectID)
	if err != nil {
		t.Fatal(err)
	}
	payload := json.RawMessage(`{"kind":"add_entity","evidence_ids":["` + fixture.evidenceHash + `"],"entity":{"id":"poison","class_key":"does_not_exist","canonical_name":"Poison"}}`)
	if _, err := fixture.service.ApplyEdit(ctx, fixture.projectID, payload); err == nil || !strings.Contains(err.Error(), "unknown ontology class") {
		t.Fatalf("invalid ontology edit error = %v", err)
	}
	var events, scratch int
	if err := fixture.database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM knowledge_curation_events WHERE project_id=?", fixture.projectID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if err := fixture.database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM knowledge_generations WHERE project_id=? AND contract_sha256=?", fixture.projectID, curationValidationContractSHA256()).Scan(&scratch); err != nil {
		t.Fatal(err)
	}
	headAfter, err := fixture.database.ActiveKnowledgeGeneration(ctx, fixture.projectID)
	if err != nil {
		t.Fatal(err)
	}
	if events != 0 || scratch != 0 || headAfter.KnowledgeRevision != headBefore.KnowledgeRevision || headAfter.Status != store.KnowledgeHeadReady {
		t.Fatalf("failed edit mutated durable state: events=%d scratch=%d before=%+v after=%+v", events, scratch, headBefore, headAfter)
	}
}

func TestApplyEditAppendsOnceOnlyAfterDryRun(t *testing.T) {
	ctx := context.Background()
	fixture := newCurationPreflightFixture(t, false)
	payload := json.RawMessage(`{"kind":"add_alias","evidence_ids":["` + fixture.evidenceHash + `"],"entity_id":"left","alias":"왼쪽 측정값","language":"ko"}`)
	if _, err := fixture.service.ApplyEdit(ctx, fixture.projectID, payload); err != nil {
		t.Fatal(err)
	}
	var events, scratch int
	if err := fixture.database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM knowledge_curation_events WHERE project_id=?", fixture.projectID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if err := fixture.database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM knowledge_generations WHERE project_id=? AND contract_sha256=?", fixture.projectID, curationValidationContractSHA256()).Scan(&scratch); err != nil {
		t.Fatal(err)
	}
	head, err := fixture.database.ActiveKnowledgeGeneration(ctx, fixture.projectID)
	if err != nil {
		t.Fatal(err)
	}
	if events != 1 || scratch != 0 || head.Status != store.KnowledgeHeadStale {
		t.Fatalf("valid edit result: events=%d scratch=%d head=%+v", events, scratch, head)
	}
}

func TestApplyEditMemoOnlyFactsMaterializeDeterministicProvenance(t *testing.T) {
	ctx := context.Background()
	fixture := newCurationPreflightFixture(t, false)
	entityEdit := json.RawMessage(`{
		"kind":"add_entity",
		"memo":"사용자가 확인한 수동 측정값입니다.",
		"entity":{"id":"manual-measurement","class_key":"measurement","canonical_name":"Manual measurement"}
	}`)
	if _, err := fixture.service.ApplyEdit(ctx, fixture.projectID, entityEdit); err != nil {
		t.Fatalf("memo-only entity edit: %v", err)
	}
	assertionEdit := json.RawMessage(`{
		"kind":"add_assertion",
		"memo":"수동 측정 결과는 42입니다.",
		"assertion":{"id":"manual-value","subject_entity_id":"manual-measurement","predicate_key":"has_value",
		"object_literal":{"lexical_form":"42","datatype":"http://www.w3.org/2001/XMLSchema#decimal","language":"","unit":"","si_value":"","si_unit":""},
		"qualifiers":{},"polarity":"affirmed","confidence":1}
	}`)
	if _, err := fixture.service.ApplyEdit(ctx, fixture.projectID, assertionEdit); err != nil {
		t.Fatalf("memo-only assertion edit: %v", err)
	}
	var events, memoDocuments int
	if err := fixture.database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_curation_events WHERE project_id=?`, fixture.projectID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if err := fixture.database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM documents WHERE project_id=? AND curation_memo=1 AND pinned=1 AND status='ready'`, fixture.projectID).Scan(&memoDocuments); err != nil {
		t.Fatal(err)
	}
	head, err := fixture.database.ActiveKnowledgeGeneration(ctx, fixture.projectID)
	if err != nil {
		t.Fatal(err)
	}
	if events != 2 || memoDocuments != 2 || head.Status != store.KnowledgeHeadStale {
		t.Fatalf("memo curation durable state events=%d documents=%d head=%+v", events, memoDocuments, head)
	}

	type materialized struct {
		nquads, mentionID, evidence string
		sources, evidenceCount      int
	}
	materialize := func() materialized {
		candidate, err := fixture.database.CreateKnowledgeGeneration(ctx, fixture.projectID, store.CoreOntologyID, curationValidationContractSHA256())
		if err != nil {
			t.Fatal(err)
		}
		defer func() {
			if err := fixture.database.DeleteBuildingKnowledgeGeneration(ctx, fixture.projectID, candidate.ID, curationValidationContractSHA256()); err != nil {
				t.Fatal(err)
			}
		}()
		if err := fixture.service.copyActiveProjection(ctx, fixture.projectID, head.Generation, candidate); err != nil {
			t.Fatal(err)
		}
		conflicts, err := fixture.service.applyPendingCuration(ctx, fixture.projectID, head.GenerationID, candidate.ID)
		if err != nil || len(conflicts) != 0 {
			t.Fatalf("apply memo curation conflicts=%v err=%v", conflicts, err)
		}
		if err := fixture.service.rekeyKnowledgeAssertions(ctx, fixture.projectID, candidate.ID); err != nil {
			t.Fatal(err)
		}
		if err := fixture.service.materializeOntologyProjection(ctx, fixture.projectID, candidate.ID); err != nil {
			t.Fatal(err)
		}
		if err := fixture.service.validateCurationCandidate(ctx, fixture.projectID, candidate.ID, store.CoreOntologyID); err != nil {
			t.Fatal(err)
		}
		nquads, _, err := fixture.service.generationNQuads(ctx, fixture.projectID, candidate.ID, store.CoreOntologyID)
		if err != nil {
			t.Fatal(err)
		}
		result := materialized{nquads: string(nquads)}
		if err := fixture.database.SQL().QueryRowContext(ctx, `SELECT id FROM knowledge_mentions WHERE project_id=? AND generation_id=? AND entity_id='manual-measurement'`, fixture.projectID, candidate.ID).Scan(&result.mentionID); err != nil {
			t.Fatal(err)
		}
		if err := fixture.database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_sources WHERE project_id=? AND generation_id=? AND json_extract(source_locator_json,'$.curation_memo')=1`, fixture.projectID, candidate.ID).Scan(&result.sources); err != nil {
			t.Fatal(err)
		}
		if err := fixture.database.SQL().QueryRowContext(ctx, `SELECT COUNT(*),MIN(evidence_sha256) FROM knowledge_assertion_evidence WHERE project_id=? AND generation_id=? AND assertion_id='manual-value' AND source_id LIKE 'curation_memo:%'`, fixture.projectID, candidate.ID).Scan(&result.evidenceCount, &result.evidence); err != nil {
			t.Fatal(err)
		}
		items, err := fixture.service.assertionEvidence(ctx, fixture.projectID, candidate.ID, "manual-value", "", true)
		if err != nil || len(items) == 0 || items[0].Excerpt == "" {
			t.Fatalf("memo evidence readback items=%+v err=%v", items, err)
		}
		return result
	}
	first, second := materialize(), materialize()
	if first != second || first.sources != 2 || first.evidenceCount != 1 || first.mentionID == "" || first.evidence == "" {
		t.Fatalf("memo materialization is not deterministic/complete: first=%+v second=%+v", first, second)
	}
}

func TestApplyEditMemoFailuresNeverAppendOrExposeGraphState(t *testing.T) {
	ctx := context.Background()
	fixture := newCurationPreflightFixture(t, false)
	blank := json.RawMessage(`{"kind":"add_entity","memo":"  \n\t ","entity":{"id":"blank","class_key":"measurement","canonical_name":"Blank"}}`)
	if _, err := fixture.service.ApplyEdit(ctx, fixture.projectID, blank); err == nil {
		t.Fatal("blank memo-only graph edit was accepted")
	}
	invalid := json.RawMessage(`{"kind":"add_entity","memo":"This memo is pinned before semantic validation.","entity":{"id":"invalid","class_key":"missing_class","canonical_name":"Invalid"}}`)
	if _, err := fixture.service.ApplyEdit(ctx, fixture.projectID, invalid); err == nil || !strings.Contains(err.Error(), "unknown ontology class") {
		t.Fatalf("invalid memo edit error=%v", err)
	}
	var events, memoDocuments int
	if err := fixture.database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_curation_events WHERE project_id=?`, fixture.projectID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if err := fixture.database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM documents WHERE project_id=? AND curation_memo=1`, fixture.projectID).Scan(&memoDocuments); err != nil {
		t.Fatal(err)
	}
	head, err := fixture.database.ActiveKnowledgeGeneration(ctx, fixture.projectID)
	if err != nil {
		t.Fatal(err)
	}
	if events != 0 || memoDocuments != 1 || head.Status != store.KnowledgeHeadReady {
		t.Fatalf("failed memo edit exposed graph state events=%d pinned_memos=%d head=%+v", events, memoDocuments, head)
	}
}

func TestApplyEditMemoOnlySplitUsesPinnedMemoForEveryNewEntity(t *testing.T) {
	ctx := context.Background()
	fixture := newCurationPreflightFixture(t, false)
	payload := json.RawMessage(`{
		"kind":"split_entity","memo":"Left was manually separated into two measurements.",
		"source_entity_id":"left",
		"new_entities":[
			{"id":"left-a","class_key":"measurement","canonical_name":"Left A"},
			{"id":"left-b","class_key":"measurement","canonical_name":"Left B"}
		],
		"assertion_assignments":[{"assertion_id":"left-value","subject_entity_id":"left-a"}]
	}`)
	if _, err := fixture.service.ApplyEdit(ctx, fixture.projectID, payload); err != nil {
		t.Fatalf("memo-only split: %v", err)
	}
	var events int
	if err := fixture.database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_curation_events WHERE project_id=? AND kind='split_entity'`, fixture.projectID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 1 {
		t.Fatalf("memo-only split event count=%d", events)
	}
}

func TestApplyEditRejectsMergeThatCreatesDuplicateAssertion(t *testing.T) {
	ctx := context.Background()
	fixture := newCurationPreflightFixture(t, true)
	payload := json.RawMessage(`{"kind":"merge_entities","evidence_ids":["` + fixture.evidenceHash + `"],"survivor_id":"left","merged_ids":["right"]}`)
	if _, err := fixture.service.ApplyEdit(ctx, fixture.projectID, payload); err == nil || !strings.Contains(err.Error(), "duplicate semantic assertions") {
		t.Fatalf("duplicate merge error = %v", err)
	}
	var events int
	if err := fixture.database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM knowledge_curation_events WHERE project_id=?", fixture.projectID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 0 {
		t.Fatalf("duplicate merge poisoned curation ledger: %d events", events)
	}
}

func TestRecoverCurationValidationCandidatesOnlyDeletesExactBuildingContract(t *testing.T) {
	ctx := context.Background()
	fixture := newCurationPreflightFixture(t, false)
	left, err := fixture.database.CreateKnowledgeGeneration(ctx, fixture.projectID, store.CoreOntologyID, curationValidationContractSHA256())
	if err != nil {
		t.Fatal(err)
	}
	other, err := fixture.database.CreateKnowledgeGeneration(ctx, fixture.projectID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	removed, err := fixture.service.RecoverCurationValidationCandidates(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed=%d, want 1", removed)
	}
	var leftCount, otherCount int
	_ = fixture.database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM knowledge_generations WHERE project_id=? AND id=?", fixture.projectID, left.ID).Scan(&leftCount)
	_ = fixture.database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM knowledge_generations WHERE project_id=? AND id=?", fixture.projectID, other.ID).Scan(&otherCount)
	if leftCount != 0 || otherCount != 1 {
		t.Fatalf("recovery scope left=%d other=%d", leftCount, otherCount)
	}
}

func TestApplyEditRejectsConcurrentProjectMutation(t *testing.T) {
	ctx := context.Background()
	fixture := newCurationPreflightFixture(t, false)
	release, err := fixture.service.acquireKnowledgeMutation(fixture.projectID, "test holder")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	payload := json.RawMessage(`{"kind":"add_alias","evidence_ids":["` + fixture.evidenceHash + `"],"entity_id":"left","alias":"blocked"}`)
	if _, err := fixture.service.ApplyEdit(ctx, fixture.projectID, payload); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("concurrent mutation error = %v", err)
	}
}

func TestActivateOntologyRejectsConcurrentProjectMutation(t *testing.T) {
	ctx := context.Background()
	fixture := newCurationPreflightFixture(t, false)
	release, err := fixture.service.acquireKnowledgeMutation(fixture.projectID, "test holder")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if _, err := fixture.service.ActivateOntology(ctx, fixture.projectID, store.CoreOntologyID); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("concurrent ontology activation error = %v", err)
	}
}
