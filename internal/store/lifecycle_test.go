package store

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/rag"
)

func TestForgetMemoryDocumentRequiresExactTitleAndCommitsBeforeCASDelete(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "memory lifecycle")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte("private pinned memory"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	document, err := db.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "Exact deletion title", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions, Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: "private pinned memory"}}, [][]float32{vector})
	if err != nil {
		t.Fatal(err)
	}
	beforeStatus, err := db.ProjectMemoryStatus(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ForgetMemoryDocument(ctx, project.ID, document.ID, "wrong title"); !errors.Is(err, ErrDeletionConfirmation) {
		t.Fatalf("wrong confirmation error = %v", err)
	}
	listed, err := db.MemoryDocuments(ctx, project.ID)
	if err != nil || len(listed) != 1 || listed[0].ID != document.ID {
		t.Fatalf("memory changed after rejected confirmation: %+v, %v", listed, err)
	}
	deleted, err := db.ForgetMemoryDocument(ctx, project.ID, document.ID, document.Title)
	if err != nil {
		t.Fatal(err)
	}
	if !deleted.Deleted || deleted.Forgotten || deleted.OrphanedBlobHash != receipt.Hash {
		t.Fatalf("memory deletion result = %+v", deleted)
	}
	afterStatus, err := db.ProjectMemoryStatus(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if afterStatus.MemoryRevision != beforeStatus.MemoryRevision+1 {
		t.Fatalf("memory deletion revision=%d, want %d", afterStatus.MemoryRevision, beforeStatus.MemoryRevision+1)
	}
	var documents, blobs int
	if err := db.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM documents WHERE id=?", document.ID).Scan(&documents); err != nil {
		t.Fatal(err)
	}
	if err := db.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM blobs WHERE hash=?", receipt.Hash).Scan(&blobs); err != nil {
		t.Fatal(err)
	}
	if documents != 0 || blobs != 0 {
		t.Fatalf("relational deletion did not commit: documents=%d blobs=%d", documents, blobs)
	}
	if _, err := objects.ReadVerified(receipt.Hash); err != nil {
		t.Fatalf("store removed CAS before caller cleanup: %v", err)
	}
	if err := objects.Delete(deleted.OrphanedBlobHash); err != nil {
		t.Fatal(err)
	}
}

func TestForgetGraphReferencedMemoryTombstonesProvenanceAndStalesHead(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "graph memory lifecycle")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte("graph adopted pinned memory"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[1] = 1
	document, err := db.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "Graph-backed memory", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions, Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: "graph adopted pinned memory"}}, [][]float32{vector})
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
	if _, err := db.SQL().ExecContext(ctx, `
INSERT INTO knowledge_extraction_batches(
  project_id,generation_id,id,document_id,source_kind,extractor_model,
  extractor_contract_sha256,status,created_at,updated_at
) VALUES(?,?,?,?,?,'',?,'queued',datetime('now'),datetime('now'))`,
		project.ID, generation.ID, "kbatch_lifecycle", document.ID, "pinned", strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	forgotten, err := db.ForgetMemoryDocument(ctx, project.ID, document.ID, document.Title)
	if err != nil {
		t.Fatal(err)
	}
	if !forgotten.Forgotten || forgotten.Deleted || !forgotten.RetainedForGraphProvenance ||
		!forgotten.KnowledgeGraphStale || forgotten.OrphanedBlobHash != "" {
		t.Fatalf("graph-backed deletion result = %+v", forgotten)
	}
	var status string
	var pinned, graphAdopt bool
	if err := db.SQL().QueryRowContext(ctx,
		"SELECT status,pinned,graph_adopt FROM documents WHERE id=?", document.ID,
	).Scan(&status, &pinned, &graphAdopt); err != nil {
		t.Fatal(err)
	}
	if status != "forgotten" || pinned || graphAdopt {
		t.Fatalf("tombstoned document state = %q pinned=%v graph=%v", status, pinned, graphAdopt)
	}
	listed, err := db.MemoryDocuments(ctx, project.ID)
	if err != nil || len(listed) != 0 {
		t.Fatalf("forgotten memory is still listed: %+v, %v", listed, err)
	}
	head, err := db.ActiveKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != "stale" {
		t.Fatalf("knowledge head status = %q", head.Status)
	}
	if _, err := objects.ReadVerified(receipt.Hash); err != nil {
		t.Fatalf("graph provenance CAS was removed: %v", err)
	}
}

func TestDeleteProjectRejectsActiveAndUncertainWork(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "busy project")
	if err != nil {
		t.Fatal(err)
	}
	run, err := db.CreateRun(ctx, project.ID, "", "do work", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.DeleteProject(ctx, project.ID); !errors.Is(err, ErrProjectBusy) {
		t.Fatalf("queued project deletion error = %v", err)
	}
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunCancelled, "cancelled before project deletion")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.DeleteProject(ctx, project.ID); err != nil {
		t.Fatalf("terminal project could not be deleted: %v", err)
	}
}

func TestDeleteProjectRejectsNonRunProjectMutations(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "non-run busy project")
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := db.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.DeleteProject(ctx, project.ID); !errors.Is(err, ErrProjectBusy) {
		t.Fatalf("building knowledge project deletion error = %v", err)
	}
	if err := db.DeleteBuildingKnowledgeGeneration(ctx, project.ID, candidate.ID, CoreOntologyContractSHA256); err != nil {
		t.Fatal(err)
	}
	session, err := db.DefaultConversationSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.MarkConversationSessionProvisioning(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.DeleteProject(ctx, project.ID); !errors.Is(err, ErrProjectBusy) {
		t.Fatalf("provisioning session project deletion error = %v", err)
	}
}

func TestStartupReconciliationFinishesInterruptedCASCleanup(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "startup CAS reconciliation")
	if err != nil {
		t.Fatal(err)
	}
	live, err := objects.PutBytes([]byte("reachable source"))
	if err != nil {
		t.Fatal(err)
	}
	orphaned, err := objects.PutBytes([]byte("registered before an interrupted adoption"))
	if err != nil {
		t.Fatal(err)
	}
	for _, receipt := range []cas.Receipt{live, orphaned} {
		if err := db.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
			t.Fatal(err)
		}
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	if _, err := db.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "reachable", BlobHash: live.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions, Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: "reachable source"}}, [][]float32{vector}); err != nil {
		t.Fatal(err)
	}
	stageInput, err := objects.PutBytes([]byte("durable stage input"))
	if err != nil {
		t.Fatal(err)
	}
	stageOutput, err := objects.PutBytes([]byte("durable stage output"))
	if err != nil {
		t.Fatal(err)
	}
	run, err := db.CreateRun(ctx, project.ID, "", "audit CAS reachability", "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := db.BeginStage(ctx, run.ID, core.StagePlan, 0, "thread", stageInput.Hash)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.CompleteStage(ctx, attempt.ID, stageOutput.Hash, ""); err != nil {
		t.Fatal(err)
	}
	registry, err := db.ReconcileBlobRegistry(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if registry.UnreferencedRowsRemoved != 1 {
		t.Fatalf("unreferenced registry rows removed = %d", registry.UnreferencedRowsRemoved)
	}
	if _, ok := registry.Reachable[live.Hash]; !ok {
		t.Fatal("reachable blob was omitted from the CAS keep set")
	}
	for _, hash := range []string{stageInput.Hash, stageOutput.Hash} {
		if _, ok := registry.Reachable[hash]; !ok {
			t.Fatalf("stage CAS hash %s was omitted from the audit keep set", hash)
		}
	}
	if _, ok := registry.Reachable[orphaned.Hash]; ok {
		t.Fatal("unreferenced blob remained in the CAS keep set")
	}
	reconciled, err := objects.Reconcile(ctx, registry.Reachable)
	if err != nil {
		t.Fatal(err)
	}
	if reconciled.OrphanedObjectsRemoved != 1 {
		t.Fatalf("orphaned CAS objects removed = %d", reconciled.OrphanedObjectsRemoved)
	}
	if _, err := objects.ReadVerified(live.Hash); err != nil {
		t.Fatalf("reachable CAS object was changed: %v", err)
	}
	for _, hash := range []string{stageInput.Hash, stageOutput.Hash} {
		if _, err := objects.ReadVerified(hash); err != nil {
			t.Fatalf("stage audit CAS object %s was changed: %v", hash, err)
		}
	}
	if _, err := objects.Path(orphaned.Hash); err == nil {
		t.Fatal("interrupted orphan CAS object survived startup reconciliation")
	}
}

func TestDeletionPreservesCASReferencedByAnotherProjectStage(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	projectA, err := db.CreateProject(ctx, "delete stage A")
	if err != nil {
		t.Fatal(err)
	}
	projectB, err := db.CreateProject(ctx, "delete stage B")
	if err != nil {
		t.Fatal(err)
	}
	shared, err := objects.PutBytes([]byte("shared stage and material CAS"))
	if err != nil {
		t.Fatal(err)
	}
	local, err := objects.PutBytes([]byte("project A stage only CAS"))
	if err != nil {
		t.Fatal(err)
	}
	for _, receipt := range []cas.Receipt{shared, local} {
		if err := db.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
			t.Fatal(err)
		}
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	document, err := db.IndexDocument(ctx, Document{
		ProjectID: projectA.ID, Title: "shared material", BlobHash: shared.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions, Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: "shared stage and material CAS"}}, [][]float32{vector})
	if err != nil {
		t.Fatal(err)
	}
	makeTerminalStage := func(projectID, inputHash, outputHash string) {
		t.Helper()
		run, err := db.CreateRun(ctx, projectID, "", "stage CAS reference", "")
		if err != nil {
			t.Fatal(err)
		}
		attempt, err := db.BeginStage(ctx, run.ID, core.StagePlan, 0, "thread", inputHash)
		if err != nil {
			t.Fatal(err)
		}
		if err := db.CompleteStage(ctx, attempt.ID, outputHash, ""); err != nil {
			t.Fatal(err)
		}
		if _, err := db.TransitionRun(ctx, run.ID, run.Revision, core.RunCancelled, "fixture terminal"); err != nil {
			t.Fatal(err)
		}
	}
	makeTerminalStage(projectA.ID, shared.Hash, local.Hash)
	makeTerminalStage(projectB.ID, shared.Hash, shared.Hash)

	deletion, err := db.ForgetMemoryDocument(ctx, projectA.ID, document.ID, document.Title)
	if err != nil {
		t.Fatal(err)
	}
	if deletion.OrphanedBlobHash != "" {
		t.Fatal("material deletion orphaned a blob still referenced by another project's stage")
	}
	orphans, err := db.DeleteProject(ctx, projectA.ID)
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(orphans, shared.Hash) || !slices.Contains(orphans, local.Hash) {
		t.Fatalf("project A orphan set = %v", orphans)
	}
	orphans, err = db.DeleteProject(ctx, projectB.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(orphans, shared.Hash) {
		t.Fatalf("final project deletion did not release shared stage CAS: %v", orphans)
	}
}

func TestMemoryMutationIsBlockedByResearchAndShadowBuild(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "stable memory revision")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte("stable memory"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	document, err := db.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "stable", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions, Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: "stable memory"}}, [][]float32{vector})
	if err != nil {
		t.Fatal(err)
	}
	before, err := db.ProjectMemoryStatus(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	run, err := db.CreateRun(ctx, project.ID, "", "hold memory revision", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.ValidateMemoryMutationAllowed(ctx, project.ID); !errors.Is(err, ErrMemoryMutationBlocked) {
		t.Fatalf("active run memory preflight error=%v", err)
	}
	if _, err := db.UpdatePinnedMaterialGraphAdopt(ctx, project.ID, document.ID, true); !errors.Is(err, ErrMemoryMutationBlocked) {
		t.Fatalf("active run graph-adopt mutation error=%v", err)
	}
	if _, err := db.ForgetMemoryDocument(ctx, project.ID, document.ID, document.Title); !errors.Is(err, ErrMemoryMutationBlocked) {
		t.Fatalf("active run memory deletion error=%v", err)
	}
	after, err := db.ProjectMemoryStatus(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.MemoryRevision != before.MemoryRevision {
		t.Fatalf("rejected mutations changed memory revision from %d to %d", before.MemoryRevision, after.MemoryRevision)
	}
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunCancelled, "test resolved")
	if err != nil {
		t.Fatal(err)
	}
	shadow, err := db.BeginShadowIndex(ctx, project.ID, rag.EmbeddingModel, rag.EmbeddingDimensions)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ForgetMemoryDocument(ctx, project.ID, document.ID, document.Title); !errors.Is(err, ErrMemoryMutationBlocked) {
		t.Fatalf("shadow-build memory deletion error=%v", err)
	}
	if err := db.FailShadowIndex(ctx, shadow.ID, "test resolves shadow build"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ForgetMemoryDocument(ctx, project.ID, document.ID, document.Title); err != nil {
		t.Fatalf("resolved project could not mutate memory: %v", err)
	}
}
