package knowledge

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/memory"
	"github.com/djkim0320/Aether-claw/internal/store"
)

const (
	knowledgeAdoptionCrashHelperEnv   = "AETHEROPS_KNOWLEDGE_ADOPTION_CRASH_HELPER"
	knowledgeAdoptionCrashDBEnv       = "AETHEROPS_KNOWLEDGE_ADOPTION_CRASH_DATABASE"
	knowledgeAdoptionCrashCASEnv      = "AETHEROPS_KNOWLEDGE_ADOPTION_CRASH_CAS"
	knowledgeAdoptionCrashRunEnv      = "AETHEROPS_KNOWLEDGE_ADOPTION_CRASH_RUN"
	knowledgeAdoptionCrashBoundaryEnv = "AETHEROPS_KNOWLEDGE_ADOPTION_CRASH_BOUNDARY"
	knowledgeAdoptionCrashNodeEnv     = "AETHEROPS_KNOWLEDGE_ADOPTION_CRASH_NODE"
	knowledgeAdoptionCrashSidecarEnv  = "AETHEROPS_KNOWLEDGE_ADOPTION_CRASH_SIDECAR"
	knowledgeAdoptionCrashRootEnv     = "AETHEROPS_KNOWLEDGE_ADOPTION_CRASH_ROOT"
	knowledgeAdoptionCrashOxigraphEnv = "AETHEROPS_KNOWLEDGE_ADOPTION_CRASH_OXIGRAPH"
	knowledgeAdoptionCrashExitCode    = 97
)

func TestSuccessfulRunKnowledgeAdoptionForcedTerminationBoundaries(t *testing.T) {
	for _, boundary := range []string{
		"run_before_snapshot_publish",
		"run_after_snapshot_publish",
		"run_before_head_swap",
		"run_after_head_swap",
	} {
		t.Run(boundary, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			node, repositoryRoot, sidecarEntry, oxigraphModule := knowledgeDurabilityRuntime(t)
			fixture, database := createSuccessfulRunCrashFixture(t, ctx)
			if err := database.Close(); err != nil {
				t.Fatal(err)
			}

			runKnowledgeAdoptionCrashHelper(t, fixture, boundary, node, repositoryRoot, sidecarEntry, oxigraphModule)

			reopened := reopenRecoveryDatabase(t, ctx, fixture.databasePath)
			defer reopened.Close()
			sidecar := startRecoveryTestSidecar(t, ctx)
			defer sidecar.Close()
			embedder := &crashBoundaryEmbeddingProtocol{}
			service := recoveryTestService(reopened, fixture.objects, embedder, sidecar)
			if _, err := service.RecoverSuccessfulRunAdoptions(ctx); err != nil {
				t.Fatalf("recover adoption after %s: %v", boundary, err)
			}
			if embedder.calls != 0 || embedder.inputs != 0 {
				t.Fatalf("recovery after %s repeated committed embeddings: calls=%d inputs=%d", boundary, embedder.calls, embedder.inputs)
			}

			head, err := reopened.ActiveKnowledgeGeneration(ctx, fixture.projectID)
			if err != nil {
				t.Fatal(err)
			}
			if head.Status != store.KnowledgeHeadReady || head.Generation.State != store.KnowledgeReady {
				t.Fatalf("recovery after %s did not expose exactly one ready head: %+v", boundary, head)
			}
			var incomplete, nonActiveReady, usableApplied, stageAttempts int
			if err := reopened.SQL().QueryRowContext(ctx, `
SELECT
  SUM(CASE WHEN state IN ('building','validating') THEN 1 ELSE 0 END),
  SUM(CASE WHEN state='ready' AND id<>? THEN 1 ELSE 0 END)
FROM knowledge_generations WHERE project_id=?`, head.GenerationID, fixture.projectID).Scan(&incomplete, &nonActiveReady); err != nil {
				t.Fatal(err)
			}
			if err := reopened.SQL().QueryRowContext(ctx, `
SELECT COUNT(*)
FROM knowledge_extraction_batches b
JOIN knowledge_generations g ON g.project_id=b.project_id AND g.id=b.generation_id
WHERE b.project_id=? AND b.run_id=? AND b.source_kind='report' AND b.status='applied'
  AND g.state IN ('ready','retired')`, fixture.projectID, fixture.runID).Scan(&usableApplied); err != nil {
				t.Fatal(err)
			}
			if err := reopened.SQL().QueryRowContext(ctx,
				"SELECT COUNT(*) FROM stage_attempts WHERE run_id=?", fixture.runID).Scan(&stageAttempts); err != nil {
				t.Fatal(err)
			}
			if incomplete != 0 || nonActiveReady != 0 || usableApplied != 1 || stageAttempts != 1 {
				t.Fatalf("recovery lineage after %s: incomplete=%d non_active_ready=%d usable_applied=%d stage_attempts=%d",
					boundary, incomplete, nonActiveReady, usableApplied, stageAttempts)
			}

			var snapshotHash, snapshotBlob string
			var snapshots, tripleCount int
			if err := reopened.SQL().QueryRowContext(ctx, `
SELECT COUNT(*),COALESCE(MIN(dataset_sha256),''),COALESCE(MIN(blob_hash),''),COALESCE(MIN(triple_count),0)
FROM knowledge_rdf_snapshots WHERE project_id=? AND generation_id=?`,
				fixture.projectID, head.GenerationID).Scan(&snapshots, &snapshotHash, &snapshotBlob, &tripleCount); err != nil {
				t.Fatal(err)
			}
			if snapshots != 1 || snapshotHash == "" || snapshotHash != snapshotBlob || tripleCount <= 0 {
				t.Fatalf("active snapshot after %s: count=%d hash=%q blob=%q triples=%d", boundary, snapshots, snapshotHash, snapshotBlob, tripleCount)
			}
			if _, err := fixture.objects.ReadVerified(snapshotBlob); err != nil {
				t.Fatalf("active RDF CAS readback after %s: %v", boundary, err)
			}

			beforeGenerations := knowledgeDurabilityCount(t, ctx, reopened, "knowledge_generations")
			beforeBatches := knowledgeDurabilityCount(t, ctx, reopened, "knowledge_extraction_batches")
			if second, err := service.RecoverSuccessfulRunAdoptions(ctx); err != nil || second.Recovered != 0 {
				t.Fatalf("second recovery after %s: result=%+v err=%v", boundary, second, err)
			}
			if knowledgeDurabilityCount(t, ctx, reopened, "knowledge_generations") != beforeGenerations ||
				knowledgeDurabilityCount(t, ctx, reopened, "knowledge_extraction_batches") != beforeBatches {
				t.Fatalf("second recovery after %s duplicated generation or applied lineage", boundary)
			}
		})
	}
}

func knowledgeDurabilityCount(t *testing.T, ctx context.Context, database *store.DB, table string) int {
	t.Helper()
	if table != "knowledge_generations" && table != "knowledge_extraction_batches" {
		t.Fatalf("unsupported knowledge durability count table %q", table)
	}
	var count int
	if err := database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM "+table).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func knowledgeDurabilityRuntime(t *testing.T) (node, repositoryRoot, sidecarEntry, oxigraphModule string) {
	t.Helper()
	var err error
	node, err = exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is not available for the real Oxigraph durability test")
	}
	repositoryRoot, err = filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	sidecarEntry = filepath.Join(repositoryRoot, "tools", "knowledge-sidecar", "index.cjs")
	oxigraphModule = filepath.Join(repositoryRoot, "tools", "knowledge-sidecar", "node_modules", "oxigraph")
	if _, err := os.Stat(filepath.Join(oxigraphModule, "package.json")); err != nil {
		t.Skip("pinned Oxigraph 0.5.9 is not installed")
	}
	return node, repositoryRoot, sidecarEntry, oxigraphModule
}

func runKnowledgeAdoptionCrashHelper(
	t *testing.T,
	fixture successfulRunCrashFixture,
	boundary, node, repositoryRoot, sidecarEntry, oxigraphModule string,
) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestKnowledgeAdoptionForcedExitHelper$", "-test.count=1")
	command.Env = append(os.Environ(),
		knowledgeAdoptionCrashHelperEnv+"=1",
		knowledgeAdoptionCrashDBEnv+"="+fixture.databasePath,
		knowledgeAdoptionCrashCASEnv+"="+filepath.Join(filepath.Dir(fixture.databasePath), "cas"),
		knowledgeAdoptionCrashRunEnv+"="+fixture.runID,
		knowledgeAdoptionCrashBoundaryEnv+"="+boundary,
		knowledgeAdoptionCrashNodeEnv+"="+node,
		knowledgeAdoptionCrashSidecarEnv+"="+sidecarEntry,
		knowledgeAdoptionCrashRootEnv+"="+repositoryRoot,
		knowledgeAdoptionCrashOxigraphEnv+"="+oxigraphModule,
	)
	output, err := command.CombinedOutput()
	exitError, ok := err.(*exec.ExitError)
	if !ok || exitError.ExitCode() != knowledgeAdoptionCrashExitCode {
		t.Fatalf("knowledge adoption crash helper boundary %s exit=%v output=%s", boundary, err, output)
	}
}

func TestKnowledgeAdoptionForcedExitHelper(t *testing.T) {
	if os.Getenv(knowledgeAdoptionCrashHelperEnv) != "1" {
		return
	}
	if err := executeKnowledgeAdoptionCrashBoundary(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Exit(3)
}

func executeKnowledgeAdoptionCrashBoundary() error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	database, err := store.Open(ctx, os.Getenv(knowledgeAdoptionCrashDBEnv))
	if err != nil {
		return err
	}
	objects, err := cas.Open(os.Getenv(knowledgeAdoptionCrashCASEnv))
	if err != nil {
		return err
	}
	sidecar, err := StartSidecar(ctx, SidecarConfig{
		Command: os.Getenv(knowledgeAdoptionCrashNodeEnv),
		Args:    []string{os.Getenv(knowledgeAdoptionCrashSidecarEnv)},
		Dir:     os.Getenv(knowledgeAdoptionCrashRootEnv),
		Env:     append(os.Environ(), "AETHEROPS_OXIGRAPH_MODULE="+os.Getenv(knowledgeAdoptionCrashOxigraphEnv)),
	})
	if err != nil {
		return err
	}
	embedder := &crashBoundaryEmbeddingProtocol{}
	indexer := &memory.Service{DB: database, CAS: objects, Embedder: embedder}
	if err := indexer.IndexRun(ctx, os.Getenv(knowledgeAdoptionCrashRunEnv)); err != nil {
		return err
	}
	boundary := os.Getenv(knowledgeAdoptionCrashBoundaryEnv)
	service := &Service{
		DB: database, CAS: objects, Memory: indexer, Sidecar: sidecar,
		durabilityTestCheckpoint: func(name string) {
			if name == boundary {
				os.Exit(knowledgeAdoptionCrashExitCode)
			}
		},
	}
	if err := service.AdoptRun(ctx, os.Getenv(knowledgeAdoptionCrashRunEnv)); err != nil {
		return err
	}
	return fmt.Errorf("knowledge adoption durability checkpoint %q was not reached", boundary)
}
