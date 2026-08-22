package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenReadOnlyChecksMigrationLedgerAndRejectsWrites(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "aetherops.db")
	database, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	project, err := database.CreateProject(ctx, "read only evidence")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	readOnly, err := OpenReadOnly(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := readOnly.Project(ctx, project.ID)
	if err != nil || loaded.ID != project.ID {
		t.Fatalf("read-only project = %+v, %v", loaded, err)
	}
	if _, err := readOnly.SQL().ExecContext(ctx, "DELETE FROM projects WHERE id=?", project.ID); err == nil {
		t.Fatal("read-only database accepted a write")
	}
	if err := readOnly.Close(); err != nil {
		t.Fatal(err)
	}

	missing := filepath.Join(t.TempDir(), "missing.db")
	if _, err := OpenReadOnly(ctx, missing); !os.IsNotExist(err) {
		t.Fatalf("missing read-only database error = %v", err)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("read-only open created a database: %v", err)
	}
}

func TestOpenReadOnlyRejectsTamperedMigrationChecksum(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "tampered.db")
	database, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL().ExecContext(ctx, "UPDATE schema_migrations SET checksum='tampered' WHERE version=1"); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenReadOnly(ctx, path); err == nil {
		t.Fatal("read-only release verifier accepted a tampered migration ledger")
	}
}

func TestOpenReadOnlyRejectsForeignKeyCorruption(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "foreign-key-corrupt.db")
	database, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	database.SQL().SetMaxOpenConns(1)
	if _, err := database.SQL().ExecContext(ctx, "PRAGMA foreign_keys=OFF"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL().ExecContext(ctx, `
INSERT INTO stage_attempts(
 id,run_id,stage,ordinal,status,created_at,updated_at
) VALUES('stage_orphan','missing_run','plan',0,'failed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenReadOnly(ctx, path); err == nil {
		t.Fatal("read-only release verifier accepted foreign-key corruption")
	}
}
