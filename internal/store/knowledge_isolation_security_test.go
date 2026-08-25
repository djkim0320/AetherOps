package store

import (
	"context"
	"testing"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/rag"
)

func TestKnowledgeProjectionRejectsCrossProjectCapabilitiesAndSources(t *testing.T) {
	database, objects := openTestDB(t)
	ctx := context.Background()
	projectA, err := database.CreateProject(ctx, "security project A")
	if err != nil {
		t.Fatal(err)
	}
	projectB, err := database.CreateProject(ctx, "security project B")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte("project A private source"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	documentA, err := database.IndexDocument(ctx, Document{
		ProjectID: projectA.ID, Title: "private source", BlobHash: receipt.Hash, Pinned: true,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
	}, []rag.Chunk{{Ordinal: 0, Text: "project A private source"}}, [][]float32{vector})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetDocumentGraphAdopt(ctx, projectA.ID, documentA.ID, true); err != nil {
		t.Fatal(err)
	}
	runA, err := database.CreateRun(ctx, projectA.ID, "", "foreign run", "thread-a")
	if err != nil {
		t.Fatal(err)
	}
	runA, err = database.TransitionRun(ctx, runA.ID, runA.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	attemptA, err := database.BeginStage(ctx, runA.ID, core.StagePlan, 0, "thread-a", "")
	if err != nil {
		t.Fatal(err)
	}
	artifactA, err := database.PublishArtifact(ctx, runA.ID, attemptA.ID, "plan", "text/plain", receipt)
	if err != nil {
		t.Fatal(err)
	}
	var chunkA, chunkHashA string
	if err := database.SQL().QueryRowContext(ctx,
		"SELECT id,text_hash FROM chunks WHERE document_id=?", documentA.ID).Scan(&chunkA, &chunkHashA); err != nil {
		t.Fatal(err)
	}
	candidateB, err := database.CreateKnowledgeGeneration(ctx, projectB.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	foreignCases := []KnowledgeExtractionBatch{
		{ID: "cross-document", DocumentID: documentA.ID, SourceKind: "pinned"},
		{ID: "cross-run", RunID: runA.ID, SourceKind: "report"},
		{ID: "cross-artifact", ArtifactID: artifactA.ID, SourceKind: "report"},
	}
	for _, batch := range foreignCases {
		batch.ProjectID = projectB.ID
		batch.GenerationID = candidateB.ID
		batch.ExtractorContractSHA256 = CoreOntologyContractSHA256
		batch.InputSHA256 = EmptyKnowledgeManifestSHA256
		if _, err := database.CreateKnowledgeExtractionBatch(ctx, batch); err == nil {
			t.Fatalf("cross-project extraction capability was accepted: %+v", batch)
		}
	}

	valid, err := database.CreateKnowledgeExtractionBatch(ctx, KnowledgeExtractionBatch{
		ProjectID: projectB.ID, GenerationID: candidateB.ID, ID: "update-guard",
		SourceKind: "backfill", ExtractorContractSHA256: CoreOntologyContractSHA256,
		InputSHA256: EmptyKnowledgeManifestSHA256,
	})
	if err != nil {
		t.Fatal(err)
	}
	for column, value := range map[string]string{
		"document_id": documentA.ID, "run_id": runA.ID, "artifact_id": artifactA.ID,
	} {
		if _, err := database.SQL().ExecContext(ctx,
			"UPDATE knowledge_extraction_batches SET "+column+"=? WHERE project_id=? AND generation_id=? AND id=?",
			value, projectB.ID, candidateB.ID, valid.ID); err == nil {
			t.Fatalf("cross-project extraction %s update was accepted", column)
		}
	}
	if _, err := database.SQL().ExecContext(ctx, `
INSERT INTO knowledge_sources(
  project_id,generation_id,chunk_id,blob_hash,source_kind,source_locator_json,text_hash,created_at
) VALUES(?,?,?,?, 'pinned','{}',?,CURRENT_TIMESTAMP)`,
		projectB.ID, candidateB.ID, chunkA, receipt.Hash, chunkHashA); err == nil {
		t.Fatal("project B accepted project A's graph-adopted chunk as a knowledge source")
	}
}
