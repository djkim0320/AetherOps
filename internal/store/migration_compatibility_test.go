package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func TestEverySupportedMigrationPrefixUpgradesToCurrent(t *testing.T) {
	ctx := context.Background()
	for prefix := 1; prefix < len(migrations); prefix++ {
		prefix := prefix
		t.Run(fmt.Sprintf("v%d", prefix), func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(t.TempDir(), "upgrade.db")
			raw, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := raw.ExecContext(ctx, `CREATE TABLE schema_migrations (
				version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
			)`); err != nil {
				raw.Close()
				t.Fatal(err)
			}
			for index, migration := range migrations[:prefix] {
				if _, err := raw.ExecContext(ctx, migration); err != nil {
					raw.Close()
					t.Fatalf("apply fixture migration %d: %v", index+1, err)
				}
				digest := sha256.Sum256([]byte(migration))
				if _, err := raw.ExecContext(ctx,
					"INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)",
					index+1, hex.EncodeToString(digest[:]), formatTime(time.Now())); err != nil {
					raw.Close()
					t.Fatal(err)
				}
			}
			if err := raw.Close(); err != nil {
				t.Fatal(err)
			}
			database, err := Open(ctx, path)
			if err != nil {
				t.Fatalf("upgrade supported migration prefix: %v", err)
			}
			defer database.Close()
			var count int
			if err := database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM schema_migrations").Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != len(migrations) {
				t.Fatalf("migration count=%d, want %d", count, len(migrations))
			}
		})
	}
}

func TestWritableOpenRejectsDatabaseFromNewerAetherOps(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "future.db")
	database, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	future := len(migrations) + 1
	if _, err := raw.ExecContext(ctx,
		"INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)",
		future, strings.Repeat("f", 64), formatTime(time.Now())); err != nil {
		raw.Close()
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(ctx, path)
	if err == nil {
		reopened.Close()
		t.Fatal("older AetherOps accepted a database with a future migration")
	}
	if !strings.Contains(err.Error(), fmt.Sprintf("unsupported version %d", future)) {
		t.Fatalf("future migration error=%v", err)
	}
}
