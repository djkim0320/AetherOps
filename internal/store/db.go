package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	_ "modernc.org/sqlite"
)

type DB struct {
	sql          *sql.DB
	buildMu      sync.RWMutex
	productBuild buildinfo.ProductBuildBinding
}

var ErrNotFound = sql.ErrNoRows

// SetProductBuildBinding configures the immutable build identity copied to
// every subsequently-created research run. Product startup calls this only
// after all packaged inputs have been located and hashed. Reconfiguration to a
// different build is rejected so one process cannot issue mixed provenance.
func (db *DB) SetProductBuildBinding(binding buildinfo.ProductBuildBinding) error {
	if err := binding.Validate(); err != nil {
		return fmt.Errorf("validate product build binding: %w", err)
	}
	db.buildMu.Lock()
	defer db.buildMu.Unlock()
	if !db.productBuild.IsZero() && db.productBuild != binding {
		return errors.New("product build binding is already configured")
	}
	db.productBuild = binding
	return nil
}

func (db *DB) productBuildBinding() buildinfo.ProductBuildBinding {
	db.buildMu.RLock()
	defer db.buildMu.RUnlock()
	return db.productBuild
}

// ProductBuildBinding returns the immutable identity of the executable and
// packaged inputs serving this DB. Research execution uses it to reject a
// queued or interrupted run created by another build before any model turn or
// external action can be started.
func (db *DB) ProductBuildBinding() buildinfo.ProductBuildBinding {
	return db.productBuildBinding()
}

var migrations = []string{
	initialSchema,
	downloadsSchema,
	runConfigurationSchema,
	conversationSessionsSchema,
	engineeringSchema,
	knowledgeGraphSchema,
	knowledgeTypeInferenceSchema,
	releaseAuditSchema,
	memoryShadowLifecycleSchema,
	releaseBuildProvenanceSchema,
	stageAttemptRetrySchema,
	runStatusDomainSchema,
	curationMemoProvenanceSchema,
	legacyRunKnowledgeBackfillSchema,
	conversationPlanCyclesSchema,
	toolStudioSchema,
	conversationContextProfileSchema,
}

func Open(ctx context.Context, path string) (*DB, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
		return nil, err
	}
	databasePath := filepath.ToSlash(absolute)
	if runtime.GOOS == "windows" && !strings.HasPrefix(databasePath, "/") {
		databasePath = "/" + databasePath
	}
	databaseURL := &url.URL{Scheme: "file", Path: databasePath}
	query := databaseURL.Query()
	for _, pragma := range []string{
		"busy_timeout(5000)",
		"foreign_keys(1)",
		"journal_mode(WAL)",
		"synchronous(FULL)",
	} {
		query.Add("_pragma", pragma)
	}
	// Every database/sql transaction in this store is a mutation boundary. An
	// immediate transaction acquires SQLite's single WAL writer slot before any
	// capability reads, preventing concurrent collectors from deadlocking while
	// upgrading deferred read transactions to writers.
	query.Set("_txlock", "immediate")
	databaseURL.RawQuery = query.Encode()
	connection, err := sql.Open("sqlite", databaseURL.String())
	if err != nil {
		return nil, err
	}
	maxConnections := runtime.NumCPU()
	if maxConnections < 4 {
		maxConnections = 4
	}
	if maxConnections > 16 {
		maxConnections = 16
	}
	connection.SetMaxOpenConns(maxConnections)
	connection.SetMaxIdleConns(maxConnections)
	connection.SetConnMaxLifetime(0)
	db := &DB{sql: connection}
	if err := db.migrate(ctx); err != nil {
		_ = connection.Close()
		return nil, err
	}
	if _, err := db.RecoverShadowIndexes(ctx); err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("recover interrupted memory shadow indexes: %w", err)
	}
	// A process exit after thread/start but before the thread id commit has an
	// unknown external outcome. Never retry that request automatically.
	if _, err := connection.ExecContext(ctx, `
UPDATE conversation_sessions
SET status = 'creation_unknown', revision = revision + 1, updated_at = ?
WHERE status = 'provisioning' AND deleted_at IS NULL`, formatTime(time.Now())); err != nil {
		_ = connection.Close()
		return nil, err
	}
	if err := connection.PingContext(ctx); err != nil {
		_ = connection.Close()
		return nil, err
	}
	return db, nil
}

// OpenWorker opens the already-initialized product database for a supervised
// MCP worker. Workers need the same read/write capability as the primary app,
// but they must never apply migrations or run process-start recovery. In
// particular, starting a required MCP server during Codex thread/start must
// not reinterpret the primary app's in-flight session provisioning as a
// crashed process.
func OpenWorker(ctx context.Context, path string) (*DB, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("AetherOps database is not a regular file")
	}
	databasePath := filepath.ToSlash(absolute)
	if runtime.GOOS == "windows" && !strings.HasPrefix(databasePath, "/") {
		databasePath = "/" + databasePath
	}
	databaseURL := &url.URL{Scheme: "file", Path: databasePath}
	query := databaseURL.Query()
	query.Set("mode", "rw")
	for _, pragma := range []string{
		"busy_timeout(5000)",
		"foreign_keys(1)",
		"journal_mode(WAL)",
		"synchronous(FULL)",
	} {
		query.Add("_pragma", pragma)
	}
	query.Set("_txlock", "immediate")
	databaseURL.RawQuery = query.Encode()
	connection, err := sql.Open("sqlite", databaseURL.String())
	if err != nil {
		return nil, err
	}
	maxConnections := runtime.NumCPU()
	if maxConnections < 4 {
		maxConnections = 4
	}
	if maxConnections > 16 {
		maxConnections = 16
	}
	connection.SetMaxOpenConns(maxConnections)
	connection.SetMaxIdleConns(maxConnections)
	connection.SetConnMaxLifetime(0)
	if err := verifyMigrationChecksums(ctx, connection); err != nil {
		_ = connection.Close()
		return nil, err
	}
	if err := connection.PingContext(ctx); err != nil {
		_ = connection.Close()
		return nil, err
	}
	return &DB{sql: connection}, nil
}

// OpenReadOnly opens an existing product database without creating files,
// applying migrations, or running startup recovery. Release verification uses
// this path so observing durable evidence cannot change that evidence.
func OpenReadOnly(ctx context.Context, path string) (*DB, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("AetherOps database is not a regular file")
	}
	databasePath := filepath.ToSlash(absolute)
	if runtime.GOOS == "windows" && !strings.HasPrefix(databasePath, "/") {
		databasePath = "/" + databasePath
	}
	databaseURL := &url.URL{Scheme: "file", Path: databasePath}
	query := databaseURL.Query()
	query.Set("mode", "ro")
	for _, pragma := range []string{"busy_timeout(5000)", "foreign_keys(1)", "query_only(1)"} {
		query.Add("_pragma", pragma)
	}
	databaseURL.RawQuery = query.Encode()
	connection, err := sql.Open("sqlite", databaseURL.String())
	if err != nil {
		return nil, err
	}
	maxConnections := runtime.NumCPU()
	if maxConnections < 1 {
		maxConnections = 1
	}
	if maxConnections > 16 {
		maxConnections = 16
	}
	connection.SetMaxOpenConns(maxConnections)
	connection.SetMaxIdleConns(maxConnections)
	db := &DB{sql: connection}
	if err := verifyMigrationChecksums(ctx, connection); err != nil {
		_ = connection.Close()
		return nil, err
	}
	var integrity string
	if err := connection.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("verify database integrity: %w", err)
	}
	if integrity != "ok" {
		_ = connection.Close()
		return nil, fmt.Errorf("database integrity check failed: %s", integrity)
	}
	var foreignTable string
	var foreignRowID int64
	var foreignParent string
	var foreignConstraint int
	foreignErr := connection.QueryRowContext(ctx, "PRAGMA foreign_key_check").Scan(
		&foreignTable, &foreignRowID, &foreignParent, &foreignConstraint,
	)
	if foreignErr == nil {
		_ = connection.Close()
		return nil, fmt.Errorf(
			"database foreign-key check failed: table=%s rowid=%d parent=%s constraint=%d",
			foreignTable, foreignRowID, foreignParent, foreignConstraint,
		)
	}
	if !errors.Is(foreignErr, sql.ErrNoRows) {
		_ = connection.Close()
		return nil, fmt.Errorf("verify database foreign keys: %w", foreignErr)
	}
	if err := connection.PingContext(ctx); err != nil {
		_ = connection.Close()
		return nil, err
	}
	return db, nil
}

func (db *DB) Close() error {
	return db.sql.Close()
}

func (db *DB) SQL() *sql.DB {
	return db.sql
}

func (db *DB) migrate(ctx context.Context) error {
	if _, err := db.sql.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
)`); err != nil {
		return err
	}
	// Refuse a database written by a newer AetherOps before applying any known
	// migration. Silently opening it would let an older executable mutate a
	// schema whose invariants it cannot understand.
	rows, err := db.sql.QueryContext(ctx, "SELECT version FROM schema_migrations ORDER BY version")
	if err != nil {
		return err
	}
	for rows.Next() {
		var version int
		if err := rows.Scan(&version); err != nil {
			_ = rows.Close()
			return err
		}
		if version < 1 || version > len(migrations) {
			_ = rows.Close()
			return fmt.Errorf("database migration ledger contains unsupported version %d; this AetherOps supports through %d", version, len(migrations))
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for index, migration := range migrations {
		version := index + 1
		sum := sha256.Sum256([]byte(migration))
		checksum := hex.EncodeToString(sum[:])
		var existing string
		err := db.sql.QueryRowContext(ctx, "SELECT checksum FROM schema_migrations WHERE version = ?", version).Scan(&existing)
		if err == nil {
			if existing != checksum {
				return fmt.Errorf("database migration %d checksum mismatch", version)
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		transaction, err := db.sql.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := transaction.ExecContext(ctx, migration); err != nil {
			_ = transaction.Rollback()
			return fmt.Errorf("apply database migration %d: %w", version, err)
		}
		if _, err := transaction.ExecContext(ctx,
			"INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(?, ?, ?)",
			version, checksum, formatTime(time.Now())); err != nil {
			_ = transaction.Rollback()
			return err
		}
		if err := transaction.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func verifyMigrationChecksums(ctx context.Context, connection *sql.DB) error {
	rows, err := connection.QueryContext(ctx, "SELECT version, checksum FROM schema_migrations ORDER BY version")
	if err != nil {
		return fmt.Errorf("read database migration ledger: %w", err)
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		var version int
		var checksum string
		if err := rows.Scan(&version, &checksum); err != nil {
			return err
		}
		seen++
		if version != seen || version < 1 || version > len(migrations) {
			return fmt.Errorf("database migration ledger contains unexpected version %d", version)
		}
		sum := sha256.Sum256([]byte(migrations[version-1]))
		if checksum != hex.EncodeToString(sum[:]) {
			return fmt.Errorf("database migration %d checksum mismatch", version)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if seen != len(migrations) {
		return fmt.Errorf("database migration ledger has %d versions, want %d", seen, len(migrations))
	}
	return nil
}

func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

func parseTime(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err == nil {
		return parsed, nil
	}
	// SQLite's CURRENT_TIMESTAMP is used inside checksum-protected migrations
	// and emits UTC without an RFC 3339 separator or zone suffix.
	return time.ParseInLocation("2006-01-02 15:04:05", value, time.UTC)
}

func nullableTime(value sql.NullString) (*time.Time, error) {
	if !value.Valid || strings.TrimSpace(value.String) == "" {
		return nil, nil
	}
	parsed, err := parseTime(value.String)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}
