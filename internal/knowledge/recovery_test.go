package knowledge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/id"
	"github.com/djkim0320/AetherOps/internal/memory"
	"github.com/djkim0320/AetherOps/internal/rag"
	"github.com/djkim0320/AetherOps/internal/store"
)

// crashBoundaryEmbeddingProtocol is used only to reproduce the external
// embedding request boundary around a real SQLite/CAS restart. Knowledge
// validation itself is performed by the pinned, real Oxigraph sidecar.
type crashBoundaryEmbeddingProtocol struct {
	calls  int
	inputs int
}

type failingCrashBoundaryEmbeddingProtocol struct {
	calls int
}

func (protocol *failingCrashBoundaryEmbeddingProtocol) Embed(context.Context, []string) ([][]float32, error) {
	protocol.calls++
	return nil, errors.New("crash-boundary embedding service unavailable")
}

func (protocol *crashBoundaryEmbeddingProtocol) Embed(_ context.Context, inputs []string) ([][]float32, error) {
	protocol.calls++
	protocol.inputs += len(inputs)
	vectors := make([][]float32, len(inputs))
	for index := range inputs {
		vectors[index] = make([]float32, rag.EmbeddingDimensions)
		vectors[index][index%rag.EmbeddingDimensions] = 1
	}
	return vectors, nil
}

type successfulRunCrashFixture struct {
	databasePath     string
	objects          *cas.Store
	projectID        string
	runID            string
	reportArtifactID string
	reportBlobHash   string
	evidenceBlobHash string
}

func TestSuccessfulRunAdoptionRecoveryCrashBoundaries(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	sidecar := startRecoveryTestSidecar(t, ctx)
	defer sidecar.Close()

	t.Run("after success commit", func(t *testing.T) {
		fixture, database := createSuccessfulRunCrashFixture(t, ctx)
		if err := database.Close(); err != nil {
			t.Fatal(err)
		}
		database = reopenRecoveryDatabase(t, ctx, fixture.databasePath)
		defer database.Close()
		embedder := &crashBoundaryEmbeddingProtocol{}
		service := recoveryTestService(database, fixture.objects, embedder, sidecar)
		result, err := service.RecoverSuccessfulRunAdoptions(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if result.Pending != 1 || result.Recovered != 1 || result.Failed != 0 {
			t.Fatalf("unexpected recovery result: %+v", result)
		}
		if embedder.calls == 0 || embedder.inputs != 2 {
			t.Fatalf("expected one real recovery index pass over report and evidence, calls=%d inputs=%d", embedder.calls, embedder.inputs)
		}
		assertRecoveredRunKnowledge(t, ctx, database, fixture, 1)

		calls := embedder.calls
		second, err := service.RecoverSuccessfulRunAdoptions(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if second.Pending != 0 || second.Recovered != 0 || embedder.calls != calls {
			t.Fatalf("restart idempotency failed: result=%+v embedding calls=%d want %d", second, embedder.calls, calls)
		}
	})

	t.Run("after memory indexing commit", func(t *testing.T) {
		fixture, database := createSuccessfulRunCrashFixture(t, ctx)
		initialEmbedder := &crashBoundaryEmbeddingProtocol{}
		indexer := &memory.Service{DB: database, CAS: fixture.objects, Embedder: initialEmbedder}
		if err := indexer.IndexRun(ctx, fixture.runID); err != nil {
			t.Fatal(err)
		}
		beforeDocuments := recoveryTableCount(t, ctx, database, "documents")
		beforeEmbeddings := recoveryTableCount(t, ctx, database, "embeddings")
		if err := database.Close(); err != nil {
			t.Fatal(err)
		}
		database = reopenRecoveryDatabase(t, ctx, fixture.databasePath)
		defer database.Close()
		restartEmbedder := &crashBoundaryEmbeddingProtocol{}
		service := recoveryTestService(database, fixture.objects, restartEmbedder, sidecar)
		result, err := service.RecoverSuccessfulRunAdoptions(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if result.Pending != 1 || result.Recovered != 1 || result.Failed != 0 {
			t.Fatalf("unexpected recovery result: %+v", result)
		}
		if restartEmbedder.calls != 0 || restartEmbedder.inputs != 0 {
			t.Fatalf("committed documents were embedded again: calls=%d inputs=%d", restartEmbedder.calls, restartEmbedder.inputs)
		}
		if got := recoveryTableCount(t, ctx, database, "documents"); got != beforeDocuments {
			t.Fatalf("document count changed across indexed crash recovery: got %d want %d", got, beforeDocuments)
		}
		if got := recoveryTableCount(t, ctx, database, "embeddings"); got != beforeEmbeddings {
			t.Fatalf("embedding count changed across indexed crash recovery: got %d want %d", got, beforeEmbeddings)
		}
		assertRecoveredRunKnowledge(t, ctx, database, fixture, 1)
	})

	t.Run("after applied batch before head swap", func(t *testing.T) {
		fixture, database := createSuccessfulRunCrashFixture(t, ctx)
		initialEmbedder := &crashBoundaryEmbeddingProtocol{}
		indexer := &memory.Service{DB: database, CAS: fixture.objects, Embedder: initialEmbedder}
		if err := indexer.IndexRun(ctx, fixture.runID); err != nil {
			t.Fatal(err)
		}
		head, err := database.ActiveKnowledgeGeneration(ctx, fixture.projectID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := database.SetKnowledgeHeadStatus(ctx, fixture.projectID, head.KnowledgeRevision,
			store.KnowledgeHeadStale, "crash fixture: patch application started"); err != nil {
			t.Fatal(err)
		}
		candidate, err := database.CreateKnowledgeGeneration(ctx, fixture.projectID,
			store.CoreOntologyID, store.CoreOntologyContractSHA256)
		if err != nil {
			t.Fatal(err)
		}
		batchID, err := id.New("kext")
		if err != nil {
			t.Fatal(err)
		}
		batch, err := database.CreateKnowledgeExtractionBatch(ctx, store.KnowledgeExtractionBatch{
			ProjectID: fixture.projectID, GenerationID: candidate.ID, ID: batchID,
			RunID: fixture.runID, ArtifactID: fixture.reportArtifactID, SourceKind: "report",
			ExtractorContractSHA256: store.CoreOntologyContractSHA256,
			InputSHA256:             fixture.reportBlobHash,
		})
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		if _, err := database.SQL().ExecContext(ctx, `
UPDATE knowledge_extraction_batches
SET status='applied',output_sha256=?,patch_blob_hash=?,updated_at=?,completed_at=?
WHERE project_id=? AND generation_id=? AND id=? AND status='queued'`,
			fixture.reportBlobHash, fixture.reportBlobHash, now, now,
			fixture.projectID, candidate.ID, batch.ID); err != nil {
			t.Fatal(err)
		}
		beforeDocuments := recoveryTableCount(t, ctx, database, "documents")
		beforeEmbeddings := recoveryTableCount(t, ctx, database, "embeddings")
		if err := database.Close(); err != nil {
			t.Fatal(err)
		}
		database = reopenRecoveryDatabase(t, ctx, fixture.databasePath)
		defer database.Close()
		restartEmbedder := &crashBoundaryEmbeddingProtocol{}
		service := recoveryTestService(database, fixture.objects, restartEmbedder, sidecar)
		result, err := service.RecoverSuccessfulRunAdoptions(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if result.Pending != 1 || result.Recovered != 1 || result.Failed != 0 || result.QuarantinedCandidates != 1 {
			t.Fatalf("unexpected crash-candidate recovery result: %+v", result)
		}
		if restartEmbedder.calls != 0 {
			t.Fatalf("indexed crash state repeated embeddings: %d calls", restartEmbedder.calls)
		}
		generation, err := database.KnowledgeGeneration(ctx, fixture.projectID, candidate.ID)
		if err != nil {
			t.Fatal(err)
		}
		if generation.State != store.KnowledgeFailed {
			t.Fatalf("incomplete applied candidate state=%s, want failed", generation.State)
		}
		if got := recoveryTableCount(t, ctx, database, "documents"); got != beforeDocuments {
			t.Fatalf("documents duplicated after applied-batch crash: got %d want %d", got, beforeDocuments)
		}
		if got := recoveryTableCount(t, ctx, database, "embeddings"); got != beforeEmbeddings {
			t.Fatalf("embeddings duplicated after applied-batch crash: got %d want %d", got, beforeEmbeddings)
		}
		assertRecoveredRunKnowledge(t, ctx, database, fixture, 1)
		var ignoredFailed, usable int
		if err := database.SQL().QueryRowContext(ctx, `
SELECT
  SUM(CASE WHEN g.state='failed' THEN 1 ELSE 0 END),
  SUM(CASE WHEN g.state IN ('ready','retired') THEN 1 ELSE 0 END)
FROM knowledge_extraction_batches b
JOIN knowledge_generations g ON g.project_id=b.project_id AND g.id=b.generation_id
WHERE b.project_id=? AND b.run_id=? AND b.source_kind='report' AND b.status='applied'`,
			fixture.projectID, fixture.runID).Scan(&ignoredFailed, &usable); err != nil {
			t.Fatal(err)
		}
		if ignoredFailed != 1 || usable != 1 {
			t.Fatalf("applied lineage counts failed=%d usable=%d, want 1/1", ignoredFailed, usable)
		}
	})
}

func TestSuccessfulRunRecoveryPreservesProjectFIFOOnFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sidecar := startRecoveryTestSidecar(t, ctx)
	defer sidecar.Close()
	fixture, database := createSuccessfulRunCrashFixture(t, ctx)
	defer database.Close()
	secondRunID := appendSuccessfulRunToCrashFixture(t, ctx, database, fixture)
	failing := &failingCrashBoundaryEmbeddingProtocol{}
	indexer := &memory.Service{DB: database, CAS: fixture.objects, Embedder: failing}
	service := &Service{DB: database, CAS: fixture.objects, Memory: indexer, Sidecar: sidecar}
	result, err := service.RecoverSuccessfulRunAdoptions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Pending != 2 || result.Recovered != 0 || result.Failed != 2 {
		t.Fatalf("unexpected FIFO failure result: %+v", result)
	}
	if failing.calls != 2 {
		// IndexRun deliberately attempts both adopted materials of the first run
		// and aggregates their failures; four calls would mean the second run
		// overtook it.
		t.Fatalf("later run overtook the failed project head: embedding calls=%d, want 2", failing.calls)
	}
	if len(result.Failures) != 2 || !strings.Contains(result.Failures[1], secondRunID) ||
		!strings.Contains(result.Failures[1], "project FIFO stopped") {
		t.Fatalf("later FIFO run was not durably deferred: %+v", result.Failures)
	}
	head, err := database.ActiveKnowledgeGeneration(ctx, fixture.projectID)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != store.KnowledgeHeadStale {
		t.Fatalf("failed FIFO recovery exposed a current graph: %+v", head)
	}
}

func TestAdoptRunUsesAppliedHistoryAcrossRebuildLineage(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	sidecar := startRecoveryTestSidecar(t, ctx)
	defer sidecar.Close()
	fixture, database := createSuccessfulRunCrashFixture(t, ctx)
	defer database.Close()
	embedder := &crashBoundaryEmbeddingProtocol{}
	service := recoveryTestService(database, fixture.objects, embedder, sidecar)
	if result, err := service.RecoverSuccessfulRunAdoptions(ctx); err != nil || result.Recovered != 1 {
		t.Fatalf("initial recovery: result=%+v err=%v", result, err)
	}
	if _, err := service.Rebuild(ctx, fixture.projectID); err != nil {
		t.Fatal(err)
	}
	var generationsBefore, batchesBefore int
	if err := database.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM knowledge_generations WHERE project_id=?", fixture.projectID).Scan(&generationsBefore); err != nil {
		t.Fatal(err)
	}
	if err := database.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM knowledge_extraction_batches WHERE project_id=? AND run_id=? AND status='applied'",
		fixture.projectID, fixture.runID).Scan(&batchesBefore); err != nil {
		t.Fatal(err)
	}
	if err := service.AdoptRun(ctx, fixture.runID); err != nil {
		t.Fatal(err)
	}
	var generationsAfter, batchesAfter int
	if err := database.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM knowledge_generations WHERE project_id=?", fixture.projectID).Scan(&generationsAfter); err != nil {
		t.Fatal(err)
	}
	if err := database.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM knowledge_extraction_batches WHERE project_id=? AND run_id=? AND status='applied'",
		fixture.projectID, fixture.runID).Scan(&batchesAfter); err != nil {
		t.Fatal(err)
	}
	if generationsAfter != generationsBefore || batchesBefore != 1 || batchesAfter != batchesBefore {
		t.Fatalf("lineage idempotency failed: generations %d->%d batches %d->%d",
			generationsBefore, generationsAfter, batchesBefore, batchesAfter)
	}
}

func startRecoveryTestSidecar(t *testing.T, ctx context.Context) *Sidecar {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is not available for the real Oxigraph recovery test")
	}
	repositoryRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	entrypoint := filepath.Join(repositoryRoot, "tools", "knowledge-sidecar", "index.cjs")
	oxigraphModule := filepath.Join(repositoryRoot, "tools", "knowledge-sidecar", "node_modules", "oxigraph")
	if _, err := os.Stat(filepath.Join(oxigraphModule, "package.json")); err != nil {
		t.Skip("the pinned Oxigraph 0.5.9 package is not installed")
	}
	environment := append(os.Environ(), "AETHEROPS_OXIGRAPH_MODULE="+oxigraphModule)
	sidecar, err := StartSidecar(ctx, SidecarConfig{
		Command: node, Args: []string{entrypoint}, Dir: repositoryRoot, Env: environment,
	})
	if err != nil {
		t.Fatal(err)
	}
	return sidecar
}

func createSuccessfulRunCrashFixture(t *testing.T, ctx context.Context) (successfulRunCrashFixture, *store.DB) {
	t.Helper()
	root := t.TempDir()
	databasePath := filepath.Join(root, "aetherops.db")
	database := reopenRecoveryDatabase(t, ctx, databasePath)
	objects, err := cas.Open(filepath.Join(root, "cas"))
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	project, err := database.CreateProject(ctx, "successful run crash recovery")
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	session, err := database.DefaultConversationSession(ctx, project.ID)
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	if _, err := database.MarkConversationSessionProvisioning(ctx, session.ID); err != nil {
		database.Close()
		t.Fatal(err)
	}
	threadID, err := database.SetConversationSessionThreadIfEmpty(ctx, session.ID, "thread-recovery")
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	run, err := database.CreateConversationRunConfigured(ctx, session.ID, "", "Does SU2 depend on itself?", threadID, core.RunConfiguration{})
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	for _, status := range []core.RunStatus{core.RunPlanning, core.RunCollecting, core.RunSynthesizing} {
		run, err = database.TransitionRun(ctx, run.ID, run.Revision, status, "")
		if err != nil {
			database.Close()
			t.Fatal(err)
		}
	}
	evidenceBytes := []byte("SU2 depends on SU2")
	evidenceReceipt, err := objects.PutBytes(evidenceBytes)
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, evidenceReceipt, "text/plain"); err != nil {
		database.Close()
		t.Fatal(err)
	}
	spanSum := sha256.Sum256(evidenceBytes)
	report := core.ReportManifest{
		Title: "SU2 dependency", AnswerMarkdown: "SU2 dependency report",
		Citations: []core.Citation{}, EvidenceIDs: []string{}, ArtifactHashes: []string{}, Uncertainties: []string{},
		KnowledgePatch: core.KnowledgePatch{
			SchemaVersion: core.KnowledgePatchSchemaV1, UnitRegistryVersion: core.CurrentUnitRegistryVersion,
			Entities: []core.KnowledgeEntity{{
				ID: "su2", Type: "software", CanonicalName: "SU2", Aliases: []core.KnowledgeAlias{},
			}},
			Assertions: []core.KnowledgeAssertion{{
				ID: "su2_self_dependency", SubjectEntityID: "su2", Predicate: "depends_on", ObjectEntityID: "su2",
				Qualifiers: []core.KnowledgeQualifier{}, Evidence: []core.KnowledgeEvidenceRef{{
					Kind: core.KnowledgeEvidenceText, SourceID: "source-su2", ClaimID: "claim-su2",
					BlobHash: evidenceReceipt.Hash, ByteStart: 0, ByteEnd: int64(len(evidenceBytes)),
					SpanHash: hex.EncodeToString(spanSum[:]),
				}},
			}},
		},
	}
	reportBytes, err := json.Marshal(report)
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	reportReceipt, err := objects.PutBytes(reportBytes)
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, reportReceipt, "application/json"); err != nil {
		database.Close()
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	attemptID, err := id.New("stg")
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	artifactID, err := id.New("art")
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	evidenceID, err := id.New("evd")
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	if _, err := database.SQL().ExecContext(ctx, `
INSERT INTO stage_attempts(id,run_id,stage,ordinal,status,codex_thread_id,codex_turn_id,input_artifact_hash,output_artifact_hash,external_side_effects,error,created_at,updated_at)
VALUES(?,?,'synthesize',0,'completed','','','','',0,'',?,?)`, attemptID, run.ID, now, now); err != nil {
		database.Close()
		t.Fatal(err)
	}
	if _, err := database.SQL().ExecContext(ctx, `
INSERT INTO artifacts(id,run_id,stage_attempt_id,kind,blob_hash,adopted,created_at)
VALUES(?, ?, ?, 'research.report', ?, 0, ?)`, artifactID, run.ID, attemptID, reportReceipt.Hash, now); err != nil {
		database.Close()
		t.Fatal(err)
	}
	if _, err := database.SQL().ExecContext(ctx, `
INSERT INTO evidence(id,run_id,stage_attempt_id,source_url,title,publisher,blob_hash,captured_at,adopted)
VALUES(?,? ,?,'https://example.invalid/su2','SU2 source','',?,?,0)`, evidenceID, run.ID, attemptID, evidenceReceipt.Hash, now); err != nil {
		database.Close()
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunReviewing, "")
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	run, err = database.SucceedRun(ctx, run.ID, run.Revision)
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	head, err := database.ActiveKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	if head.Status != store.KnowledgeHeadStale {
		database.Close()
		t.Fatalf("successful run commit left the previous graph apparently current: %+v", head)
	}
	return successfulRunCrashFixture{
		databasePath: databasePath, objects: objects, projectID: project.ID, runID: run.ID,
		reportArtifactID: artifactID, reportBlobHash: reportReceipt.Hash, evidenceBlobHash: evidenceReceipt.Hash,
	}, database
}

func appendSuccessfulRunToCrashFixture(t *testing.T, ctx context.Context, database *store.DB, fixture successfulRunCrashFixture) string {
	t.Helper()
	// Reproduce a legacy/pre-recovery database that accumulated more than one
	// successful run for a project before knowledge adoption was introduced.
	head, err := database.ActiveKnowledgeGeneration(ctx, fixture.projectID)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != store.KnowledgeHeadReady {
		if _, err := database.SetKnowledgeHeadStatus(ctx, fixture.projectID, head.KnowledgeRevision,
			store.KnowledgeHeadReady, ""); err != nil {
			t.Fatal(err)
		}
	}
	session, err := database.DefaultConversationSession(ctx, fixture.projectID)
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateConversationRunConfigured(ctx, session.ID, "", "Second FIFO research", session.CodexThreadID, core.RunConfiguration{})
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []core.RunStatus{core.RunPlanning, core.RunCollecting, core.RunSynthesizing} {
		run, err = database.TransitionRun(ctx, run.ID, run.Revision, status, "")
		if err != nil {
			t.Fatal(err)
		}
	}
	attemptID, err := id.New("stg")
	if err != nil {
		t.Fatal(err)
	}
	artifactID, err := id.New("art")
	if err != nil {
		t.Fatal(err)
	}
	evidenceID, err := id.New("evd")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := database.SQL().ExecContext(ctx, `
INSERT INTO stage_attempts(id,run_id,stage,ordinal,status,codex_thread_id,codex_turn_id,input_artifact_hash,output_artifact_hash,external_side_effects,error,created_at,updated_at)
VALUES(?,?,'synthesize',0,'completed','','','','',0,'',?,?)`, attemptID, run.ID, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL().ExecContext(ctx, `
INSERT INTO artifacts(id,run_id,stage_attempt_id,kind,blob_hash,adopted,created_at)
VALUES(?,?,?,'research.report',?,0,?)`, artifactID, run.ID, attemptID, fixture.reportBlobHash, now); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL().ExecContext(ctx, `
INSERT INTO evidence(id,run_id,stage_attempt_id,source_url,title,publisher,blob_hash,captured_at,adopted)
VALUES(?,?,?,'https://example.invalid/su2-second','SU2 second source','',?,?,0)`,
		evidenceID, run.ID, attemptID, fixture.evidenceBlobHash, now); err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunReviewing, "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.SucceedRun(ctx, run.ID, run.Revision)
	if err != nil {
		t.Fatal(err)
	}
	return run.ID
}

func reopenRecoveryDatabase(t *testing.T, ctx context.Context, path string) *store.DB {
	t.Helper()
	database, err := store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	return database
}

func recoveryTestService(database *store.DB, objects *cas.Store, embedder memory.Embedder, sidecar *Sidecar) *Service {
	indexer := &memory.Service{DB: database, CAS: objects, Embedder: embedder}
	return &Service{DB: database, CAS: objects, Memory: indexer, Sidecar: sidecar}
}

func recoveryTableCount(t *testing.T, ctx context.Context, database *store.DB, table string) int {
	t.Helper()
	allowed := map[string]bool{"documents": true, "embeddings": true}
	if !allowed[table] {
		t.Fatalf("unsupported recovery count table %q", table)
	}
	var count int
	if err := database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM "+table).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func assertRecoveredRunKnowledge(t *testing.T, ctx context.Context, database *store.DB, fixture successfulRunCrashFixture, wantApplied int) {
	t.Helper()
	run, err := database.Run(ctx, fixture.runID)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != core.RunSucceeded {
		t.Fatalf("recovery retroactively changed successful run: %s", run.Status)
	}
	head, err := database.ActiveKnowledgeGeneration(ctx, fixture.projectID)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != store.KnowledgeHeadReady || head.Generation.State != store.KnowledgeReady {
		t.Fatalf("recovered head is not ready: %+v", head)
	}
	var applied int
	if err := database.SQL().QueryRowContext(ctx, `
SELECT COUNT(*)
FROM knowledge_extraction_batches b
JOIN knowledge_generations g ON g.project_id=b.project_id AND g.id=b.generation_id
WHERE b.project_id=? AND b.run_id=? AND b.source_kind='report' AND b.status='applied'
  AND g.state IN ('ready','retired')`, fixture.projectID, fixture.runID).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if applied != wantApplied {
		t.Fatalf("usable applied batch count=%d, want %d", applied, wantApplied)
	}
	pending, err := database.PendingSucceededRunAdoptions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range pending {
		if strings.EqualFold(item.RunID, fixture.runID) {
			t.Fatalf("recovered run remains pending: %+v", item)
		}
	}
}
