package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/rag"
)

func openTestDB(t *testing.T) (*DB, *cas.Store) {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	db, err := Open(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	return db, objects
}

func appendTestKnowledgeSnapshot(t *testing.T, db *DB, objects *cas.Store, projectID, generationID, ontologyID string) {
	t.Helper()
	ctx := context.Background()
	data, tripleCount, err := db.KnowledgeNQuads(ctx, projectID, generationID, ontologyID)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes(data)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "application/n-quads"); err != nil {
		t.Fatal(err)
	}
	if err := db.AppendKnowledgeProjection(ctx, projectID, generationID, KnowledgeProjection{Snapshots: []KnowledgeRDFSnapshotRecord{{
		ID: "krdf_" + receipt.Hash[:24], Format: "n-quads", BlobHash: receipt.Hash,
		DatasetSHA256: receipt.Hash, TripleCount: tripleCount,
	}}}); err != nil {
		t.Fatal(err)
	}
}

func TestOpenAppliesDurabilityAndIntegrityPragmas(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	checks := map[string]string{
		"PRAGMA journal_mode": "wal",
		"PRAGMA synchronous":  "2",
		"PRAGMA foreign_keys": "1",
	}
	for query, expected := range checks {
		var value string
		if err := db.sql.QueryRowContext(ctx, query).Scan(&value); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
		if !strings.EqualFold(value, expected) {
			t.Fatalf("%s = %q, want %q", query, value, expected)
		}
	}
	var integrity string
	if err := db.sql.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil {
		t.Fatal(err)
	}
	if integrity != "ok" {
		t.Fatalf("integrity check: %s", integrity)
	}
}

func TestRenameProjectPreservesUnicodeName(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "Pro 초기 연구 - NACA 익형")
	if err != nil {
		t.Fatal(err)
	}
	const want = "Pro 검증 – NACA 최적화 복구"
	renamed, err := db.RenameProject(ctx, project.ID, "  "+want+"  ")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Name != want {
		t.Fatalf("renamed project = %q, want %q", renamed.Name, want)
	}
	stored, err := db.Project(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Name != want || !stored.UpdatedAt.After(project.UpdatedAt) {
		t.Fatalf("stored project after rename = %+v, original updated_at=%s", stored, project.UpdatedAt)
	}
}

func TestRunTransitionsAreOptimisticAndAudited(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "연구")
	if err != nil {
		t.Fatal(err)
	}
	run, err := db.CreateRun(ctx, project.ID, "", "질문", "")
	if err != nil {
		t.Fatal(err)
	}
	updated, err := db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != 1 || updated.Status != core.RunPlanning {
		t.Fatalf("unexpected transitioned run: %+v", updated)
	}
	if _, err := db.TransitionRun(ctx, run.ID, 0, core.RunCollecting, ""); err == nil {
		t.Fatal("stale revision transition unexpectedly succeeded")
	}
	if _, err := db.TransitionRun(ctx, run.ID, 1, core.RunSucceeded, ""); err == nil {
		t.Fatal("illegal transition unexpectedly succeeded")
	}
	events, err := db.EventsAfter(ctx, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Kind != "run.created" || events[1].Kind != "run.transition" {
		t.Fatalf("unexpected events: %+v", events)
	}
}

func TestRunTerminationAtomicallyRetiresPendingApprovals(t *testing.T) {
	for _, terminal := range []core.RunStatus{
		core.RunFailed,
		core.RunCancelled,
		core.RunInterrupted,
		core.RunUncertain,
	} {
		t.Run(string(terminal), func(t *testing.T) {
			db, _ := openTestDB(t)
			ctx := context.Background()
			project, err := db.CreateProject(ctx, "approval retirement")
			if err != nil {
				t.Fatal(err)
			}
			run, err := db.CreateRun(ctx, project.ID, "", "question", "thread")
			if err != nil {
				t.Fatal(err)
			}
			run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
			if err != nil {
				t.Fatal(err)
			}
			attempt, err := db.BeginStage(ctx, run.ID, core.StagePlan, 0, "thread", "")
			if err != nil {
				t.Fatal(err)
			}
			approval, err := db.CreateApproval(ctx, core.Approval{
				RunID: run.ID, StageAttemptID: attempt.ID,
				ThreadID: "thread", TurnID: "turn", ItemID: "item",
				Kind: "item/commandExecution/requestApproval", Summary: "side effect",
			})
			if err != nil {
				t.Fatal(err)
			}
			run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunWaitingApproval, "")
			if err != nil {
				t.Fatal(err)
			}
			run, err = db.TransitionRun(ctx, run.ID, run.Revision, terminal, "terminal")
			if err != nil {
				t.Fatal(err)
			}
			if run.Status != terminal {
				t.Fatalf("run status = %s, want %s", run.Status, terminal)
			}
			pending, err := db.ListPendingApprovals(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if len(pending) != 0 {
				t.Fatalf("terminal run retained pending approvals: %+v", pending)
			}
			if _, err := db.CreateApproval(ctx, core.Approval{
				RunID: run.ID, StageAttemptID: attempt.ID,
				ThreadID: "thread", TurnID: "late-turn", ItemID: "late-item",
				Kind: "item/commandExecution/requestApproval", Summary: "late request",
			}); !errors.Is(err, ErrApprovalNotActive) {
				t.Fatalf("late terminal approval error = %v, want %v", err, ErrApprovalNotActive)
			}
			if _, err := db.DecideActiveApproval(ctx, approval.ID, "approved"); !errors.Is(err, ErrApprovalNotActive) {
				t.Fatalf("retired approval decision error = %v, want %v", err, ErrApprovalNotActive)
			}
		})
	}
}

func TestRecoveryDistinguishesUncertainSideEffects(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "복구")
	if err != nil {
		t.Fatal(err)
	}
	makeActive := func(question string, sideEffects bool) core.Run {
		run, err := db.CreateRun(ctx, project.ID, "", question, "")
		if err != nil {
			t.Fatal(err)
		}
		run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
		if err != nil {
			t.Fatal(err)
		}
		attempt, err := db.BeginStage(ctx, run.ID, core.StagePlan, 0, "thread", "input")
		if err != nil {
			t.Fatal(err)
		}
		if sideEffects {
			if err := db.MarkStageExternalSideEffects(ctx, attempt.ID); err != nil {
				t.Fatal(err)
			}
		}
		return run
	}
	readOnly := makeActive("read", false)
	writeUnknown := makeActive("write", true)
	count, err := db.RecoverInFlight(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("recovered %d runs, want 2", count)
	}
	readOnly, err = db.Run(ctx, readOnly.ID)
	if err != nil {
		t.Fatal(err)
	}
	writeUnknown, err = db.Run(ctx, writeUnknown.ID)
	if err != nil {
		t.Fatal(err)
	}
	if readOnly.Status != core.RunInterrupted || writeUnknown.Status != core.RunUncertain {
		t.Fatalf("recovery statuses: %s, %s", readOnly.Status, writeUnknown.Status)
	}
}

func TestRecoveryTreatsCompletedSideEffectCheckpointAsInterrupted(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "completed side effect recovery")
	if err != nil {
		t.Fatal(err)
	}
	run, err := db.CreateRun(ctx, project.ID, "", "browse then crash", "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := db.BeginStage(ctx, run.ID, core.StagePlan, 0, "thread-side-effect", strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetStageTurn(ctx, attempt.ID, "thread-side-effect", "turn-side-effect"); err != nil {
		t.Fatal(err)
	}
	if err := db.MarkStageExternalSideEffects(ctx, attempt.ID); err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte(`{"checkpoint":"completed-side-effect"}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "application/json"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.PublishArtifact(ctx, run.ID, attempt.ID, "research.plan", "application/json", receipt); err != nil {
		t.Fatal(err)
	}
	if err := db.CompleteStage(ctx, attempt.ID, receipt.Hash, ""); err != nil {
		t.Fatal(err)
	}
	if recovered, err := db.RecoverInFlight(ctx); err != nil || recovered != 1 {
		t.Fatalf("recover completed side effect: count=%d err=%v", recovered, err)
	}
	recovered, err := db.Run(ctx, run.ID)
	if err != nil || recovered.Status != core.RunInterrupted {
		t.Fatalf("completed side-effect recovery status=%s err=%v", recovered.Status, err)
	}
}

func TestExplicitResumeArchivesInterruptedAttemptAndAllowsFreshAttempt(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "explicit retry")
	if err != nil {
		t.Fatal(err)
	}
	run, err := db.CreateRun(ctx, project.ID, "", "retry read", "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	first, err := db.BeginStage(ctx, run.ID, core.StagePlan, 0, "thread-old", strings.Repeat("b", 64))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetStageTurn(ctx, first.ID, "thread-old", "turn-old"); err != nil {
		t.Fatal(err)
	}
	if recovered, err := db.RecoverInFlight(ctx); err != nil || recovered != 1 {
		t.Fatalf("recover interrupted attempt: count=%d err=%v", recovered, err)
	}
	if err := db.PrepareInterruptedRunForResume(ctx, run.ID); err != nil {
		t.Fatal(err)
	}
	second, err := db.BeginStage(ctx, run.ID, core.StagePlan, 0, "thread-new", strings.Repeat("c", 64))
	if err != nil {
		t.Fatalf("fresh attempt after explicit resume: %v", err)
	}
	if second.ID == first.ID {
		t.Fatal("explicit resume reused the interrupted attempt identity")
	}
	attempts, err := db.ListStageAttempts(ctx, run.ID)
	if err != nil || len(attempts) != 2 {
		t.Fatalf("attempt audit=%+v err=%v", attempts, err)
	}
	if attempts[0].ID != first.ID || attempts[0].Status != "superseded" || attempts[0].Ordinal != 0 ||
		attempts[0].CodexThreadID != "thread-old" || attempts[0].CodexTurnID != "turn-old" {
		t.Fatalf("archived attempt lost audit identity: %+v", attempts[0])
	}
}

func TestPinnedDocumentHybridSearchAndVectorIntegrity(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "기억")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte("한국어 연구 evidence and engineering details"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := objects.ReadVerified(receipt.Hash); err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/plain; charset=utf-8"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	document, err := db.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "혼합 자료", BlobHash: receipt.Hash,
		EmbeddingModel: "text-embedding-3-small", EmbeddingDimensions: rag.EmbeddingDimensions,
		Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: "한국어 연구 evidence and engineering details"}}, [][]float32{vector})
	if err != nil {
		t.Fatal(err)
	}
	if document.Status != "ready" {
		t.Fatalf("document status = %s", document.Status)
	}
	results, err := db.SearchMemory(ctx, project.ID, "한국어 engineering", vector, 12)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Text == "" {
		t.Fatalf("unexpected results: %+v", results)
	}
	got, err := db.MemoryGet(ctx, project.ID, results[0].ChunkID)
	if err != nil || got.DocumentID != document.ID {
		t.Fatalf("memory get: %+v, %v", got, err)
	}

	corrupt := []byte{1, 2, 3, 4}
	sum := sha256.Sum256(corrupt)
	if _, err := db.sql.ExecContext(ctx,
		"UPDATE embeddings SET vector = ?, vector_hash = ? WHERE chunk_id = ?",
		corrupt, hex.EncodeToString(sum[:]), results[0].ChunkID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SearchMemory(ctx, project.ID, "한국어", vector, 12); err == nil {
		t.Fatal("corrupt vector unexpectedly degraded to lexical-only search")
	}
}

func TestUnpinnedDraftCannotEnterMemory(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "격리")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte("draft"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	_, err = db.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "draft", BlobHash: receipt.Hash,
		EmbeddingModel: "text-embedding-3-small", EmbeddingDimensions: rag.EmbeddingDimensions,
	}, []rag.Chunk{{Ordinal: 0, Text: "draft"}}, [][]float32{vector})
	if err == nil {
		t.Fatal("unpinned non-artifact draft unexpectedly entered memory")
	}
}

func TestShadowIndexActivatesOnlyAfterCompleteValidation(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "shadow")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte("shadow index evidence"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	oldVector := make([]float32, rag.EmbeddingDimensions)
	oldVector[0] = 1
	if _, err := db.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "shadow source", BlobHash: receipt.Hash,
		EmbeddingModel: "text-embedding-3-small", EmbeddingDimensions: rag.EmbeddingDimensions,
		Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: "shadow index evidence"}}, [][]float32{oldVector}); err != nil {
		t.Fatal(err)
	}
	oldIndex, err := db.ActiveEmbeddingIndex(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	shadow, err := db.BeginShadowIndex(ctx, project.ID, "text-embedding-3-small-reindexed", rag.EmbeddingDimensions)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ActivateShadowIndex(ctx, shadow.ID); err == nil {
		t.Fatal("incomplete shadow index activated")
	}
	active, err := db.ActiveEmbeddingIndex(ctx, project.ID)
	if err != nil || active.ID != oldIndex.ID {
		t.Fatalf("incomplete build changed active index: %+v, %v", active, err)
	}
	chunks, err := db.ShadowChunks(ctx, shadow.ID)
	if err != nil || len(chunks) != 1 {
		t.Fatalf("shadow chunks: %+v, %v", chunks, err)
	}
	newVector := make([]float32, rag.EmbeddingDimensions)
	newVector[1] = 1
	if err := db.AddShadowEmbeddings(ctx, shadow.ID, []string{chunks[0].ID}, [][]float32{newVector}); err != nil {
		t.Fatal(err)
	}
	activated, err := db.ActivateShadowIndex(ctx, shadow.ID)
	if err != nil {
		t.Fatal(err)
	}
	if activated.ID != shadow.ID || activated.State != "active" {
		t.Fatalf("activated index: %+v", activated)
	}
	active, err = db.ActiveEmbeddingIndex(ctx, project.ID)
	if err != nil || active.ID != shadow.ID {
		t.Fatalf("active index did not switch atomically: %+v, %v", active, err)
	}
	var retired string
	if err := db.SQL().QueryRowContext(ctx,
		"SELECT state FROM embedding_indexes WHERE id = ?", oldIndex.ID).Scan(&retired); err != nil {
		t.Fatal(err)
	}
	if retired != "retired" {
		t.Fatalf("previous index state = %s", retired)
	}
}

func TestBeginShadowIndexAllowsOnlyOneConcurrentBuildPerProject(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "one shadow writer")
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	errorsByWorker := make(chan error, 2)
	var workers sync.WaitGroup
	for range 2 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			_, beginErr := db.BeginShadowIndex(ctx, project.ID, rag.EmbeddingModel, rag.EmbeddingDimensions)
			errorsByWorker <- beginErr
		}()
	}
	close(start)
	workers.Wait()
	close(errorsByWorker)
	succeeded, rejected := 0, 0
	for beginErr := range errorsByWorker {
		switch {
		case beginErr == nil:
			succeeded++
		case errors.Is(beginErr, ErrShadowBuildInProgress):
			rejected++
		default:
			t.Fatalf("unexpected concurrent begin error: %v", beginErr)
		}
	}
	if succeeded != 1 || rejected != 1 {
		t.Fatalf("concurrent shadow begins: succeeded=%d rejected=%d", succeeded, rejected)
	}
	var building int
	if err := db.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM embedding_indexes WHERE project_id=? AND state='building'", project.ID,
	).Scan(&building); err != nil {
		t.Fatal(err)
	}
	if building != 1 {
		t.Fatalf("building shadow rows=%d, want 1", building)
	}
}

func TestRunCreationAndShadowBeginAreMutuallyExclusive(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "run shadow exclusion")
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		<-start
		_, runErr := db.CreateRun(ctx, project.ID, "", "research", "")
		results <- runErr
	}()
	go func() {
		defer workers.Done()
		<-start
		_, beginErr := db.BeginShadowIndex(ctx, project.ID, rag.EmbeddingModel, rag.EmbeddingDimensions)
		results <- beginErr
	}()
	close(start)
	workers.Wait()
	close(results)
	succeeded, blocked := 0, 0
	for operationErr := range results {
		switch {
		case operationErr == nil:
			succeeded++
		case errors.Is(operationErr, ErrMemoryRunInProgress), errors.Is(operationErr, ErrMemoryReindexInProgress):
			blocked++
		default:
			t.Fatalf("unexpected run/shadow race error: %v", operationErr)
		}
	}
	if succeeded != 1 || blocked != 1 {
		t.Fatalf("run/shadow race: succeeded=%d blocked=%d", succeeded, blocked)
	}
	var runs, shadows int
	if err := db.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE project_id=?", project.ID).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if err := db.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM embedding_indexes WHERE project_id=? AND state='building'", project.ID,
	).Scan(&shadows); err != nil {
		t.Fatal(err)
	}
	if runs+shadows != 1 {
		t.Fatalf("mutual exclusion ledger has runs=%d shadows=%d", runs, shadows)
	}
}

func TestScheduledRunIsBlockedByMemoryReindexInSameTransaction(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "scheduled shadow exclusion")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetProjectMainThread(ctx, project.ID, "thread-schedule"); err != nil {
		t.Fatal(err)
	}
	session, err := db.DefaultConversationSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	due := time.Now().UTC().Add(time.Minute)
	schedule, err := db.CreateSchedule(ctx, core.Schedule{
		ProjectID: project.ID, ConversationSessionID: session.ID, Question: "scheduled research",
		Kind: "at", Expression: due.Format(time.RFC3339), Timezone: "UTC", Enabled: true,
		NextRunAt: &due, MainThreadID: "thread-schedule",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.BeginShadowIndex(ctx, project.ID, rag.EmbeddingModel, rag.EmbeddingDimensions); err != nil {
		t.Fatal(err)
	}
	if _, claimed, err := db.CreateScheduledRun(ctx, schedule, due); !errors.Is(err, ErrMemoryReindexInProgress) || claimed {
		t.Fatalf("scheduled run during reindex: claimed=%v err=%v", claimed, err)
	}
	var firings int
	if err := db.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM schedule_firings WHERE schedule_id=? AND scheduled_for=?",
		schedule.ID, formatTime(due),
	).Scan(&firings); err != nil {
		t.Fatal(err)
	}
	if firings != 0 {
		t.Fatalf("blocked scheduled run left %d firing claims", firings)
	}
}

func TestOpenRecoversCompleteShadowWithoutEmbeddingRequest(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	databasePath := filepath.Join(root, "aetherops.db")
	db, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	project, err := db.CreateProject(ctx, "recover complete shadow")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte("complete shadow source"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	oldVector := make([]float32, rag.EmbeddingDimensions)
	oldVector[0] = 1
	if _, err := db.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "source", BlobHash: receipt.Hash, Pinned: true,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
	}, []rag.Chunk{{Ordinal: 0, Text: "complete shadow source"}}, [][]float32{oldVector}); err != nil {
		t.Fatal(err)
	}
	before, err := db.ProjectMemoryStatus(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	shadow, err := db.BeginShadowIndex(ctx, project.ID, rag.EmbeddingModel, rag.EmbeddingDimensions)
	if err != nil {
		t.Fatal(err)
	}
	chunks, err := db.ShadowChunks(ctx, shadow.ID)
	if err != nil || len(chunks) != 1 {
		t.Fatalf("shadow chunks=%+v err=%v", chunks, err)
	}
	newVector := make([]float32, rag.EmbeddingDimensions)
	newVector[1] = 1
	if err := db.AddShadowEmbeddings(ctx, shadow.ID, []string{chunks[0].ID}, [][]float32{newVector}); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	after, err := db.ProjectMemoryStatus(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.State != "ready" || after.ActiveIndexID != shadow.ID || after.ShadowIndexID != "" {
		t.Fatalf("recovered memory head=%+v", after)
	}
	if after.MemoryRevision != before.MemoryRevision+1 {
		t.Fatalf("recovered revision=%d, want %d", after.MemoryRevision, before.MemoryRevision+1)
	}
	corruptShadow, err := db.BeginShadowIndex(ctx, project.ID, rag.EmbeddingModel, rag.EmbeddingDimensions)
	if err != nil {
		t.Fatal(err)
	}
	chunks, err = db.ShadowChunks(ctx, corruptShadow.ID)
	if err != nil || len(chunks) != 1 {
		t.Fatalf("corrupt shadow chunks=%+v err=%v", chunks, err)
	}
	if err := db.AddShadowEmbeddings(ctx, corruptShadow.ID, []string{chunks[0].ID}, [][]float32{newVector}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx,
		"UPDATE embeddings SET vector_hash=? WHERE index_id=?", strings.Repeat("0", 64), corruptShadow.ID,
	); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	corruptStatus, err := db.ProjectMemoryStatus(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if corruptStatus.State != "failed" || corruptStatus.ActiveIndexID != shadow.ID ||
		corruptStatus.ShadowIndexID != "" || !strings.Contains(corruptStatus.Error, "integrity failed") {
		t.Fatalf("corrupt shadow recovery status=%+v", corruptStatus)
	}
	if corruptStatus.MemoryRevision != after.MemoryRevision {
		t.Fatalf("corrupt shadow advanced revision from %d to %d", after.MemoryRevision, corruptStatus.MemoryRevision)
	}
}

func TestOpenFailsIncompleteShadowAndPreservesActiveIndex(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	databasePath := filepath.Join(root, "aetherops.db")
	db, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	project, err := db.CreateProject(ctx, "reject incomplete shadow")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte("incomplete shadow source"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	if _, err := db.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "source", BlobHash: receipt.Hash, Pinned: true,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
	}, []rag.Chunk{{Ordinal: 0, Text: "incomplete shadow source"}}, [][]float32{vector}); err != nil {
		t.Fatal(err)
	}
	active, err := db.ActiveEmbeddingIndex(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	shadow, err := db.BeginShadowIndex(ctx, project.ID, rag.EmbeddingModel, rag.EmbeddingDimensions)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	status, err := db.ProjectMemoryStatus(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != "failed" || status.ActiveIndexID != active.ID || status.ShadowIndexID != "" || status.Error == "" {
		t.Fatalf("incomplete recovery status=%+v", status)
	}
	var shadowState string
	if err := db.SQL().QueryRowContext(ctx, "SELECT state FROM embedding_indexes WHERE id=?", shadow.ID).Scan(&shadowState); err != nil {
		t.Fatal(err)
	}
	if shadowState != "failed" {
		t.Fatalf("interrupted shadow state=%s", shadowState)
	}
}

func TestProjectDeletionReturnsOnlyUnreferencedCASObjects(t *testing.T) {
	db, objects := openTestDB(t)
	ctx := context.Background()
	first, err := db.CreateProject(ctx, "first")
	if err != nil {
		t.Fatal(err)
	}
	second, err := db.CreateProject(ctx, "second")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte("shared pinned source"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	for _, project := range []core.Project{first, second} {
		if _, err := db.IndexDocument(ctx, Document{
			ProjectID: project.ID, Title: "shared", BlobHash: receipt.Hash,
			EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
			Pinned: true,
		}, []rag.Chunk{{Ordinal: 0, Text: "shared pinned source"}}, [][]float32{vector}); err != nil {
			t.Fatal(err)
		}
	}
	orphans, err := db.DeleteProject(ctx, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(orphans) != 0 {
		t.Fatalf("shared blob marked orphaned: %v", orphans)
	}
	if _, err := objects.ReadVerified(receipt.Hash); err != nil {
		t.Fatalf("shared blob removed early: %v", err)
	}
	orphans, err = db.DeleteProject(ctx, second.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(orphans) != 1 || orphans[0] != receipt.Hash {
		t.Fatalf("final orphan set: %v", orphans)
	}
	if err := objects.Delete(receipt.Hash); err != nil {
		t.Fatal(err)
	}
	if _, err := objects.Path(receipt.Hash); err == nil {
		t.Fatal("orphaned CAS object still exists")
	}
}
