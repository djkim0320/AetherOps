package store

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/rag"
)

const (
	casCrashHelperEnv      = "AETHEROPS_CAS_CRASH_HELPER"
	casCrashDatabaseEnv    = "AETHEROPS_CAS_CRASH_DATABASE"
	casCrashProjectEnv     = "AETHEROPS_CAS_CRASH_PROJECT"
	casIntentionalExitCode = 95
)

// TestProjectDeletionForcedTerminationDefersCASCleanupToStartup proves that a
// process exit after the authoritative SQLite deletion cannot lose a newly
// adopted same-hash object. The file remains until the next single-writer
// startup reconciliation computes reachability and removes it.
func TestProjectDeletionForcedTerminationDefersCASCleanupToStartup(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	databasePath := filepath.Join(root, "aetherops.db")
	casPath := filepath.Join(root, "objects")
	database, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	objects, err := cas.Open(casPath)
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	project, err := database.CreateProject(ctx, "forced deletion CAS cleanup")
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte("CAS object retained across deletion crash boundary"))
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, receipt, "text/plain; charset=utf-8"); err != nil {
		database.Close()
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	if _, err := database.IndexDocument(ctx, Document{
		ProjectID: project.ID, Title: "deletion crash material", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions, Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: "CAS object retained across deletion crash boundary"}}, [][]float32{vector}); err != nil {
		database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	runCASDeletionCrashHelper(t, databasePath, project.ID)
	if _, err := objects.ReadVerified(receipt.Hash); err != nil {
		t.Fatalf("project deletion performed unsafe online CAS cleanup: %v", err)
	}

	reopened, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	registry, err := reopened.ReconcileBlobRegistry(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, reachable := registry.Reachable[receipt.Hash]; reachable {
		t.Fatal("deleted project's blob remained reachable during startup reconciliation")
	}
	reconciled, err := objects.Reconcile(ctx, registry.Reachable)
	if err != nil {
		t.Fatal(err)
	}
	if reconciled.OrphanedObjectsRemoved != 1 {
		t.Fatalf("startup CAS cleanup removed %d objects, want 1", reconciled.OrphanedObjectsRemoved)
	}
	if _, err := objects.Path(receipt.Hash); !os.IsNotExist(err) {
		t.Fatalf("orphaned object survived startup reconciliation: %v", err)
	}
}

func runCASDeletionCrashHelper(t *testing.T, databasePath, projectID string) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestCASDeletionForcedExitHelper$", "-test.count=1")
	command.Env = append(os.Environ(),
		casCrashHelperEnv+"=1",
		casCrashDatabaseEnv+"="+databasePath,
		casCrashProjectEnv+"="+projectID,
	)
	output, err := command.CombinedOutput()
	exitError, ok := err.(*exec.ExitError)
	if !ok || exitError.ExitCode() != casIntentionalExitCode {
		t.Fatalf("CAS deletion crash helper exit=%v output=%s", err, output)
	}
}

func TestCASDeletionForcedExitHelper(t *testing.T) {
	if os.Getenv(casCrashHelperEnv) != "1" {
		return
	}
	database, err := Open(context.Background(), os.Getenv(casCrashDatabaseEnv))
	if err == nil {
		_, err = database.DeleteProject(context.Background(), os.Getenv(casCrashProjectEnv))
	}
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	// Deliberately do not close SQLite and do not touch CAS. The next startup
	// owns physical cleanup after it recomputes the complete reference set.
	os.Exit(casIntentionalExitCode)
}
