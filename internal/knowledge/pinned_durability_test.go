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
	"github.com/djkim0320/Aether-claw/internal/rag"
	"github.com/djkim0320/Aether-claw/internal/store"
)

const (
	pinnedCrashHelperEnv   = "AETHEROPS_PINNED_CRASH_HELPER"
	pinnedCrashDBEnv       = "AETHEROPS_PINNED_CRASH_DATABASE"
	pinnedCrashCASEnv      = "AETHEROPS_PINNED_CRASH_CAS"
	pinnedCrashProjectEnv  = "AETHEROPS_PINNED_CRASH_PROJECT"
	pinnedCrashBoundaryEnv = "AETHEROPS_PINNED_CRASH_BOUNDARY"
	pinnedCrashExitCode    = 98
)

func TestPinnedExtractionSnapshotAndHeadForcedTermination(t *testing.T) {
	for _, boundary := range []string{
		"pinned_after_snapshot_publish",
		"pinned_before_head_swap",
		"pinned_after_head_swap",
	} {
		t.Run(boundary, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			node, repositoryRoot, sidecarEntry, oxigraphModule := knowledgeDurabilityRuntime(t)
			root := t.TempDir()
			databasePath := filepath.Join(root, "aetherops.db")
			casPath := filepath.Join(root, "cas")
			objects, err := cas.Open(casPath)
			if err != nil {
				t.Fatal(err)
			}
			database, err := store.Open(ctx, databasePath)
			if err != nil {
				t.Fatal(err)
			}
			project, err := database.CreateProject(ctx, "pinned durability "+boundary)
			if err != nil {
				database.Close()
				t.Fatal(err)
			}
			payload := []byte("SU2 depends on SU2.")
			receipt, err := objects.PutBytes(payload)
			if err != nil {
				database.Close()
				t.Fatal(err)
			}
			if err := database.RegisterBlob(ctx, receipt, "text/plain; charset=utf-8"); err != nil {
				database.Close()
				t.Fatal(err)
			}
			chunks := rag.ChunkText(string(payload), rag.DefaultChunkRunes, rag.DefaultOverlapRunes)
			vectors := [][]float32{make([]float32, rag.EmbeddingDimensions)}
			vectors[0][0] = 1
			document, err := database.IndexDocument(ctx, store.Document{
				ProjectID: project.ID, Title: "pinned source", BlobHash: receipt.Hash,
				EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions, Pinned: true,
			}, chunks, vectors)
			if err != nil {
				database.Close()
				t.Fatal(err)
			}
			if _, err := database.UpdatePinnedMaterialGraphAdopt(ctx, project.ID, document.ID, true); err != nil {
				database.Close()
				t.Fatal(err)
			}
			if err := database.Close(); err != nil {
				t.Fatal(err)
			}

			runPinnedCrashHelper(t, databasePath, casPath, project.ID, boundary, node, repositoryRoot, sidecarEntry, oxigraphModule)

			reopened, err := store.Open(ctx, databasePath)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			head, err := reopened.ActiveKnowledgeGeneration(ctx, project.ID)
			if err != nil {
				t.Fatal(err)
			}
			recoveryProtocol := &extractionProtocolFixture{}
			if head.Status != store.KnowledgeHeadReady {
				sidecar := startRecoveryTestSidecar(t, ctx)
				defer sidecar.Close()
				service := &Service{DB: reopened, CAS: objects, Sidecar: sidecar, Extraction: recoveryProtocol}
				result, err := service.Rebuild(ctx, project.ID)
				if err != nil {
					t.Fatalf("recover pinned rebuild after %s: %v", boundary, err)
				}
				if result == nil {
					t.Fatalf("recover pinned rebuild after %s returned no result", boundary)
				}
			}
			if len(recoveryProtocol.turns) != 0 {
				t.Fatalf("pinned recovery after %s repeated %d model turns", boundary, len(recoveryProtocol.turns))
			}
			head, err = reopened.ActiveKnowledgeGeneration(ctx, project.ID)
			if err != nil {
				t.Fatal(err)
			}
			if head.Status != store.KnowledgeHeadReady || head.Generation.State != store.KnowledgeReady {
				t.Fatalf("pinned recovery after %s head=%+v", boundary, head)
			}
			var incomplete, batchCount, distinctThreads, distinctTurns, snapshots int
			if err := reopened.SQL().QueryRowContext(ctx, `
SELECT SUM(CASE WHEN state IN('building','validating') THEN 1 ELSE 0 END)
FROM knowledge_generations WHERE project_id=?`, project.ID).Scan(&incomplete); err != nil {
				t.Fatal(err)
			}
			if err := reopened.SQL().QueryRowContext(ctx, `
SELECT COUNT(*),COUNT(DISTINCT codex_thread_id),COUNT(DISTINCT codex_turn_id)
FROM knowledge_extraction_batches
WHERE project_id=? AND generation_id=? AND status='applied' AND source_kind IN('pinned','backfill')`,
				project.ID, head.GenerationID).Scan(&batchCount, &distinctThreads, &distinctTurns); err != nil {
				t.Fatal(err)
			}
			if err := reopened.SQL().QueryRowContext(ctx,
				"SELECT COUNT(*) FROM knowledge_rdf_snapshots WHERE project_id=? AND generation_id=?",
				project.ID, head.GenerationID).Scan(&snapshots); err != nil {
				t.Fatal(err)
			}
			if incomplete != 0 || batchCount != 2 || distinctThreads != 2 || distinctTurns != 2 || snapshots != 1 {
				t.Fatalf("pinned lineage after %s: incomplete=%d batches=%d threads=%d turns=%d snapshots=%d",
					boundary, incomplete, batchCount, distinctThreads, distinctTurns, snapshots)
			}
			var snapshotHash string
			if err := reopened.SQL().QueryRowContext(ctx,
				"SELECT blob_hash FROM knowledge_rdf_snapshots WHERE project_id=? AND generation_id=?",
				project.ID, head.GenerationID).Scan(&snapshotHash); err != nil {
				t.Fatal(err)
			}
			if _, err := objects.ReadVerified(snapshotHash); err != nil {
				t.Fatalf("pinned RDF CAS readback after %s: %v", boundary, err)
			}
		})
	}
}

func runPinnedCrashHelper(t *testing.T, databasePath, casPath, projectID, boundary, node, repositoryRoot, sidecarEntry, oxigraphModule string) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestPinnedForcedExitHelper$", "-test.count=1")
	command.Env = append(os.Environ(),
		pinnedCrashHelperEnv+"=1",
		pinnedCrashDBEnv+"="+databasePath,
		pinnedCrashCASEnv+"="+casPath,
		pinnedCrashProjectEnv+"="+projectID,
		pinnedCrashBoundaryEnv+"="+boundary,
		knowledgeAdoptionCrashNodeEnv+"="+node,
		knowledgeAdoptionCrashSidecarEnv+"="+sidecarEntry,
		knowledgeAdoptionCrashRootEnv+"="+repositoryRoot,
		knowledgeAdoptionCrashOxigraphEnv+"="+oxigraphModule,
	)
	output, err := command.CombinedOutput()
	exitError, ok := err.(*exec.ExitError)
	if !ok || exitError.ExitCode() != pinnedCrashExitCode {
		t.Fatalf("pinned crash helper boundary %s exit=%v output=%s", boundary, err, output)
	}
}

func TestPinnedForcedExitHelper(t *testing.T) {
	if os.Getenv(pinnedCrashHelperEnv) != "1" {
		return
	}
	if err := executePinnedCrashBoundary(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Exit(3)
}

func executePinnedCrashBoundary() error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	database, err := store.Open(ctx, os.Getenv(pinnedCrashDBEnv))
	if err != nil {
		return err
	}
	objects, err := cas.Open(os.Getenv(pinnedCrashCASEnv))
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
	boundary := os.Getenv(pinnedCrashBoundaryEnv)
	service := &Service{
		DB: database, CAS: objects, Sidecar: sidecar, Extraction: &extractionProtocolFixture{},
		durabilityTestCheckpoint: func(name string) {
			if name == boundary {
				os.Exit(pinnedCrashExitCode)
			}
		},
	}
	if _, err := service.Rebuild(ctx, os.Getenv(pinnedCrashProjectEnv)); err != nil {
		return err
	}
	return fmt.Errorf("pinned durability checkpoint %q was not reached", boundary)
}
