package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

const (
	migrationCrashHelperEnv = "AETHEROPS_MIGRATION_CRASH_HELPER"
	migrationCrashDBEnv     = "AETHEROPS_MIGRATION_CRASH_DATABASE"
	migrationCrashModeEnv   = "AETHEROPS_MIGRATION_CRASH_MODE"
	migrationCrashExitCode  = 100
)

func TestMigrationChecksumCommitForcedTerminationIsAtomic(t *testing.T) {
	if len(migrations) < 2 {
		t.Fatal("migration durability test requires at least two migrations")
	}
	for _, mode := range []string{"before_commit", "after_commit"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			databasePath := filepath.Join(t.TempDir(), "migration-crash.db")
			createMigrationPrefixForCrash(t, ctx, databasePath, len(migrations)-1)

			runMigrationCrashHelper(t, databasePath, mode)

			raw, err := sql.Open("sqlite", databasePath)
			if err != nil {
				t.Fatal(err)
			}
			var ledgerCount int
			if err := raw.QueryRowContext(ctx, "SELECT COUNT(*) FROM schema_migrations").Scan(&ledgerCount); err != nil {
				raw.Close()
				t.Fatal(err)
			}
			wantBeforeOpen := len(migrations)
			if mode == "before_commit" {
				wantBeforeOpen--
			}
			if ledgerCount != wantBeforeOpen {
				raw.Close()
				t.Fatalf("migration ledger after %s crash=%d, want %d", mode, ledgerCount, wantBeforeOpen)
			}
			var integrity string
			if err := raw.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil {
				raw.Close()
				t.Fatal(err)
			}
			if integrity != "ok" {
				raw.Close()
				t.Fatalf("SQLite integrity after %s crash=%q", mode, integrity)
			}
			if err := raw.Close(); err != nil {
				t.Fatal(err)
			}

			database, err := Open(ctx, databasePath)
			if err != nil {
				t.Fatalf("product reopen after %s migration crash: %v", mode, err)
			}
			if err := verifyMigrationChecksums(ctx, database.SQL()); err != nil {
				database.Close()
				t.Fatalf("migration checksum verification after %s: %v", mode, err)
			}
			var total, distinctVersions, distinctChecksums int
			if err := database.SQL().QueryRowContext(ctx, `
SELECT COUNT(*),COUNT(DISTINCT version),COUNT(DISTINCT checksum) FROM schema_migrations`).Scan(
				&total, &distinctVersions, &distinctChecksums,
			); err != nil {
				database.Close()
				t.Fatal(err)
			}
			if total != len(migrations) || distinctVersions != len(migrations) || distinctChecksums != len(migrations) {
				database.Close()
				t.Fatalf("migration lineage after %s: total=%d versions=%d checksums=%d want=%d",
					mode, total, distinctVersions, distinctChecksums, len(migrations))
			}
			if err := database.Close(); err != nil {
				t.Fatal(err)
			}

			second, err := Open(ctx, databasePath)
			if err != nil {
				t.Fatal(err)
			}
			defer second.Close()
			if err := verifyMigrationChecksums(ctx, second.SQL()); err != nil {
				t.Fatal(err)
			}
			if err := second.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM schema_migrations").Scan(&total); err != nil {
				t.Fatal(err)
			}
			if total != len(migrations) {
				t.Fatalf("second restart after %s replayed migration: count=%d want=%d", mode, total, len(migrations))
			}
		})
	}
}

func createMigrationPrefixForCrash(t *testing.T, ctx context.Context, databasePath string, prefix int) {
	t.Helper()
	raw, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	for _, pragma := range []string{"PRAGMA journal_mode=WAL", "PRAGMA foreign_keys=ON", "PRAGMA synchronous=FULL"} {
		if _, err := raw.ExecContext(ctx, pragma); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := raw.ExecContext(ctx, `CREATE TABLE schema_migrations (
		version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
	)`); err != nil {
		t.Fatal(err)
	}
	for index, migration := range migrations[:prefix] {
		transaction, err := raw.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := transaction.ExecContext(ctx, migration); err != nil {
			transaction.Rollback()
			t.Fatalf("apply prefix migration %d: %v", index+1, err)
		}
		digest := sha256.Sum256([]byte(migration))
		if _, err := transaction.ExecContext(ctx,
			"INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)",
			index+1, hex.EncodeToString(digest[:]), formatTime(time.Now())); err != nil {
			transaction.Rollback()
			t.Fatal(err)
		}
		if err := transaction.Commit(); err != nil {
			t.Fatal(err)
		}
	}
}

func runMigrationCrashHelper(t *testing.T, databasePath, mode string) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestMigrationForcedExitHelper$", "-test.count=1")
	command.Env = append(os.Environ(),
		migrationCrashHelperEnv+"=1",
		migrationCrashDBEnv+"="+databasePath,
		migrationCrashModeEnv+"="+mode,
	)
	output, err := command.CombinedOutput()
	exitError, ok := err.(*exec.ExitError)
	if !ok || exitError.ExitCode() != migrationCrashExitCode {
		t.Fatalf("migration crash helper mode %s exit=%v output=%s", mode, err, output)
	}
}

func TestMigrationForcedExitHelper(t *testing.T) {
	if os.Getenv(migrationCrashHelperEnv) != "1" {
		return
	}
	if err := executeMigrationCrashBoundary(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Exit(migrationCrashExitCode)
}

func executeMigrationCrashBoundary() error {
	ctx := context.Background()
	raw, err := sql.Open("sqlite", os.Getenv(migrationCrashDBEnv))
	if err != nil {
		return err
	}
	for _, pragma := range []string{"PRAGMA journal_mode=WAL", "PRAGMA foreign_keys=ON", "PRAGMA synchronous=FULL"} {
		if _, err := raw.ExecContext(ctx, pragma); err != nil {
			return err
		}
	}
	transaction, err := raw.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	last := len(migrations) - 1
	if _, err := transaction.ExecContext(ctx, migrations[last]); err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(migrations[last]))
	if _, err := transaction.ExecContext(ctx,
		"INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)",
		last+1, hex.EncodeToString(digest[:]), formatTime(time.Now())); err != nil {
		return err
	}
	switch os.Getenv(migrationCrashModeEnv) {
	case "before_commit":
		return nil
	case "after_commit":
		return transaction.Commit()
	default:
		return fmt.Errorf("unknown migration crash mode %q", os.Getenv(migrationCrashModeEnv))
	}
}
