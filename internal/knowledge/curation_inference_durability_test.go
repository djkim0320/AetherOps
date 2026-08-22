package knowledge

import (
	"context"
	"encoding/json"
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
	curationCrashHelperEnv   = "AETHEROPS_CURATION_CRASH_HELPER"
	curationCrashDBEnv       = "AETHEROPS_CURATION_CRASH_DATABASE"
	curationCrashCASEnv      = "AETHEROPS_CURATION_CRASH_CAS"
	curationCrashProjectEnv  = "AETHEROPS_CURATION_CRASH_PROJECT"
	curationCrashBoundaryEnv = "AETHEROPS_CURATION_CRASH_BOUNDARY"
	curationCrashExitCode    = 99
)

func TestCurationAndInferenceForcedTerminationRebuildsOnce(t *testing.T) {
	for _, boundary := range []string{"rebuild_after_curation_apply", "rebuild_after_inference"} {
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
			project, err := database.CreateProject(ctx, "curation durability "+boundary)
			if err != nil {
				database.Close()
				t.Fatal(err)
			}
			indexer := &memory.Service{DB: database, CAS: objects, Embedder: curationMemoEmbeddingProtocol{}}
			editService := &Service{DB: database, CAS: objects, Memory: indexer}
			edit := json.RawMessage(`{
				"kind":"add_entity",
				"memo":"A manually curated measurement used for forced termination validation.",
				"entity":{"id":"manual-measurement","class_key":"measurement","canonical_name":"Manual measurement"}
			}`)
			if _, err := editService.ApplyEdit(ctx, project.ID, edit); err != nil {
				database.Close()
				t.Fatal(err)
			}
			if err := database.Close(); err != nil {
				t.Fatal(err)
			}

			runCurationCrashHelper(t, databasePath, casPath, project.ID, boundary, node, repositoryRoot, sidecarEntry, oxigraphModule)

			reopened, err := store.Open(ctx, databasePath)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			sidecar := startRecoveryTestSidecar(t, ctx)
			defer sidecar.Close()
			service := &Service{DB: reopened, CAS: objects, Sidecar: sidecar}
			if _, err := service.Rebuild(ctx, project.ID); err != nil {
				t.Fatalf("recover deterministic rebuild after %s: %v", boundary, err)
			}
			head, err := reopened.ActiveKnowledgeGeneration(ctx, project.ID)
			if err != nil {
				t.Fatal(err)
			}
			if head.Status != store.KnowledgeHeadReady || head.Generation.State != store.KnowledgeReady {
				t.Fatalf("curation/inference recovery after %s head=%+v", boundary, head)
			}
			var events, entities, typeInferences, proofs, incomplete, nonActiveReady, extractionBatches int
			if err := reopened.SQL().QueryRowContext(ctx,
				"SELECT COUNT(*) FROM knowledge_curation_events WHERE project_id=?", project.ID).Scan(&events); err != nil {
				t.Fatal(err)
			}
			if err := reopened.SQL().QueryRowContext(ctx, `
SELECT COUNT(*) FROM knowledge_entities
WHERE project_id=? AND generation_id=? AND id='manual-measurement'`, project.ID, head.GenerationID).Scan(&entities); err != nil {
				t.Fatal(err)
			}
			if err := reopened.SQL().QueryRowContext(ctx, `
SELECT COUNT(*) FROM knowledge_type_inferences
WHERE project_id=? AND generation_id=? AND entity_id='manual-measurement'`, project.ID, head.GenerationID).Scan(&typeInferences); err != nil {
				t.Fatal(err)
			}
			if err := reopened.SQL().QueryRowContext(ctx, `
SELECT COUNT(*)
FROM knowledge_type_inference_proofs p
JOIN knowledge_type_inferences i ON i.project_id=p.project_id AND i.generation_id=p.generation_id AND i.id=p.inference_id
WHERE i.project_id=? AND i.generation_id=? AND i.entity_id='manual-measurement'`, project.ID, head.GenerationID).Scan(&proofs); err != nil {
				t.Fatal(err)
			}
			if err := reopened.SQL().QueryRowContext(ctx, `
SELECT
  SUM(CASE WHEN state IN('building','validating') THEN 1 ELSE 0 END),
  SUM(CASE WHEN state='ready' AND id<>? THEN 1 ELSE 0 END)
FROM knowledge_generations WHERE project_id=?`, head.GenerationID, project.ID).Scan(&incomplete, &nonActiveReady); err != nil {
				t.Fatal(err)
			}
			if err := reopened.SQL().QueryRowContext(ctx,
				"SELECT COUNT(*) FROM knowledge_extraction_batches WHERE project_id=?", project.ID).Scan(&extractionBatches); err != nil {
				t.Fatal(err)
			}
			if events != 1 || entities != 1 || typeInferences < 1 || proofs < typeInferences || incomplete != 0 || nonActiveReady != 0 || extractionBatches != 0 {
				t.Fatalf("curation/inference lineage after %s: events=%d entities=%d inferences=%d proofs=%d incomplete=%d non_active_ready=%d extraction_batches=%d",
					boundary, events, entities, typeInferences, proofs, incomplete, nonActiveReady, extractionBatches)
			}
			var snapshotHash, datasetHash string
			if err := reopened.SQL().QueryRowContext(ctx, `
SELECT blob_hash,dataset_sha256 FROM knowledge_rdf_snapshots
WHERE project_id=? AND generation_id=?`, project.ID, head.GenerationID).Scan(&snapshotHash, &datasetHash); err != nil {
				t.Fatal(err)
			}
			if snapshotHash == "" || snapshotHash != datasetHash {
				t.Fatalf("curation/inference snapshot after %s hash=%q dataset=%q", boundary, snapshotHash, datasetHash)
			}
			if _, err := objects.ReadVerified(snapshotHash); err != nil {
				t.Fatalf("curation/inference RDF CAS readback after %s: %v", boundary, err)
			}
		})
	}
}

func runCurationCrashHelper(t *testing.T, databasePath, casPath, projectID, boundary, node, repositoryRoot, sidecarEntry, oxigraphModule string) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestCurationForcedExitHelper$", "-test.count=1")
	command.Env = append(os.Environ(),
		curationCrashHelperEnv+"=1",
		curationCrashDBEnv+"="+databasePath,
		curationCrashCASEnv+"="+casPath,
		curationCrashProjectEnv+"="+projectID,
		curationCrashBoundaryEnv+"="+boundary,
		knowledgeAdoptionCrashNodeEnv+"="+node,
		knowledgeAdoptionCrashSidecarEnv+"="+sidecarEntry,
		knowledgeAdoptionCrashRootEnv+"="+repositoryRoot,
		knowledgeAdoptionCrashOxigraphEnv+"="+oxigraphModule,
	)
	output, err := command.CombinedOutput()
	exitError, ok := err.(*exec.ExitError)
	if !ok || exitError.ExitCode() != curationCrashExitCode {
		t.Fatalf("curation crash helper boundary %s exit=%v output=%s", boundary, err, output)
	}
}

func TestCurationForcedExitHelper(t *testing.T) {
	if os.Getenv(curationCrashHelperEnv) != "1" {
		return
	}
	if err := executeCurationCrashBoundary(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Exit(3)
}

func executeCurationCrashBoundary() error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	database, err := store.Open(ctx, os.Getenv(curationCrashDBEnv))
	if err != nil {
		return err
	}
	objects, err := cas.Open(os.Getenv(curationCrashCASEnv))
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
	boundary := os.Getenv(curationCrashBoundaryEnv)
	service := &Service{
		DB: database, CAS: objects, Sidecar: sidecar,
		durabilityTestCheckpoint: func(name string) {
			if name == boundary {
				os.Exit(curationCrashExitCode)
			}
		},
	}
	if _, err := service.Rebuild(ctx, os.Getenv(curationCrashProjectEnv)); err != nil {
		return err
	}
	return fmt.Errorf("curation durability checkpoint %q was not reached", boundary)
}
