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
	memoryShadowCrashHelperEnv  = "AETHEROPS_MEMORY_SHADOW_CRASH_HELPER"
	memoryShadowCrashDBEnv      = "AETHEROPS_MEMORY_SHADOW_CRASH_DATABASE"
	memoryShadowCrashModeEnv    = "AETHEROPS_MEMORY_SHADOW_CRASH_MODE"
	memoryShadowCrashProjectEnv = "AETHEROPS_MEMORY_SHADOW_CRASH_PROJECT"
	memoryShadowCrashExitCode   = 96
)

func TestMemoryShadowSwapForcedTerminationIsAtomic(t *testing.T) {
	for _, mode := range []string{"before_swap", "after_swap"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			root := t.TempDir()
			databasePath := filepath.Join(root, "aetherops.db")
			objects, err := cas.Open(filepath.Join(root, "cas"))
			if err != nil {
				t.Fatal(err)
			}
			database, err := Open(ctx, databasePath)
			if err != nil {
				t.Fatal(err)
			}
			project, err := database.CreateProject(ctx, "forced shadow swap "+mode)
			if err != nil {
				database.Close()
				t.Fatal(err)
			}
			payload := []byte("durable embedding shadow source")
			receipt, err := objects.PutBytes(payload)
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
				ProjectID: project.ID, Title: "shadow source", BlobHash: receipt.Hash, Pinned: true,
				EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
			}, []rag.Chunk{{Ordinal: 0, Text: string(payload)}}, [][]float32{vector}); err != nil {
				database.Close()
				t.Fatal(err)
			}
			before, err := database.ProjectMemoryStatus(ctx, project.ID)
			if err != nil {
				database.Close()
				t.Fatal(err)
			}
			if err := database.Close(); err != nil {
				t.Fatal(err)
			}

			runMemoryShadowCrashHelper(t, databasePath, project.ID, mode)

			reopened, err := Open(ctx, databasePath)
			if err != nil {
				t.Fatal(err)
			}
			after, err := reopened.ProjectMemoryStatus(ctx, project.ID)
			if err != nil {
				reopened.Close()
				t.Fatal(err)
			}
			if after.State != "ready" || after.ShadowIndexID != "" || after.ActiveIndexID == "" || after.ActiveIndexID == before.ActiveIndexID {
				reopened.Close()
				t.Fatalf("non-atomic shadow recovery after %s: before=%+v after=%+v", mode, before, after)
			}
			if after.MemoryRevision != before.MemoryRevision+1 {
				reopened.Close()
				t.Fatalf("shadow recovery after %s advanced revision %d -> %d, want exactly one", mode, before.MemoryRevision, after.MemoryRevision)
			}
			var active, building, retired, embeddings int
			if err := reopened.SQL().QueryRowContext(ctx, `
SELECT
  SUM(CASE WHEN state='active' THEN 1 ELSE 0 END),
  SUM(CASE WHEN state='building' THEN 1 ELSE 0 END),
  SUM(CASE WHEN state='retired' THEN 1 ELSE 0 END)
FROM embedding_indexes WHERE project_id=?`, project.ID).Scan(&active, &building, &retired); err != nil {
				reopened.Close()
				t.Fatal(err)
			}
			if err := reopened.SQL().QueryRowContext(ctx,
				"SELECT COUNT(*) FROM embeddings WHERE index_id=?", after.ActiveIndexID).Scan(&embeddings); err != nil {
				reopened.Close()
				t.Fatal(err)
			}
			if active != 1 || building != 0 || retired != 1 || embeddings != 1 {
				reopened.Close()
				t.Fatalf("shadow lineage after %s: active=%d building=%d retired=%d embeddings=%d", mode, active, building, retired, embeddings)
			}
			if _, err := objects.ReadVerified(receipt.Hash); err != nil {
				reopened.Close()
				t.Fatalf("shared CAS readback after %s: %v", mode, err)
			}
			if err := reopened.Close(); err != nil {
				t.Fatal(err)
			}

			second, err := Open(ctx, databasePath)
			if err != nil {
				t.Fatal(err)
			}
			defer second.Close()
			stable, err := second.ProjectMemoryStatus(ctx, project.ID)
			if err != nil {
				t.Fatal(err)
			}
			if stable.ActiveIndexID != after.ActiveIndexID || stable.MemoryRevision != after.MemoryRevision {
				t.Fatalf("second restart replayed shadow activation after %s: first=%+v second=%+v", mode, after, stable)
			}
		})
	}
}

func runMemoryShadowCrashHelper(t *testing.T, databasePath, projectID, mode string) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestMemoryShadowForcedExitHelper$", "-test.count=1")
	command.Env = append(os.Environ(),
		memoryShadowCrashHelperEnv+"=1",
		memoryShadowCrashDBEnv+"="+databasePath,
		memoryShadowCrashProjectEnv+"="+projectID,
		memoryShadowCrashModeEnv+"="+mode,
	)
	output, err := command.CombinedOutput()
	exitError, ok := err.(*exec.ExitError)
	if !ok || exitError.ExitCode() != memoryShadowCrashExitCode {
		t.Fatalf("memory shadow crash helper mode %s exit=%v output=%s", mode, err, output)
	}
}

func TestMemoryShadowForcedExitHelper(t *testing.T) {
	if os.Getenv(memoryShadowCrashHelperEnv) != "1" {
		return
	}
	if err := executeMemoryShadowCrashBoundary(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Exit(memoryShadowCrashExitCode)
}

func executeMemoryShadowCrashBoundary() error {
	ctx := context.Background()
	database, err := Open(ctx, os.Getenv(memoryShadowCrashDBEnv))
	if err != nil {
		return err
	}
	shadow, err := database.BeginShadowIndex(ctx, os.Getenv(memoryShadowCrashProjectEnv), rag.EmbeddingModel, rag.EmbeddingDimensions)
	if err != nil {
		return err
	}
	chunks, err := database.ShadowChunks(ctx, shadow.ID)
	if err != nil {
		return err
	}
	if len(chunks) != 1 {
		return fmt.Errorf("shadow helper chunks=%d, want 1", len(chunks))
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[1] = 1
	if err := database.AddShadowEmbeddings(ctx, shadow.ID, []string{chunks[0].ID}, [][]float32{vector}); err != nil {
		return err
	}
	switch os.Getenv(memoryShadowCrashModeEnv) {
	case "before_swap":
		return nil
	case "after_swap":
		_, err = database.ActivateShadowIndex(ctx, shadow.ID)
		return err
	default:
		return fmt.Errorf("unknown memory shadow crash mode %q", os.Getenv(memoryShadowCrashModeEnv))
	}
}
