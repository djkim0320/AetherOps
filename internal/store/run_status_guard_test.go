package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
)

func TestRunStatusTriggersRejectRawInvalidWritesAndAllowNormalTransition(t *testing.T) {
	database, _ := openTestDB(t)
	ctx := context.Background()
	project, err := database.CreateProject(ctx, "run status guard")
	if err != nil {
		t.Fatal(err)
	}
	now := formatTime(time.Now())
	if _, err := database.SQL().ExecContext(ctx, `
INSERT INTO runs(id,project_id,question,status,created_at,updated_at)
VALUES('run_raw_invalid',?,'invalid insert','not_a_run_status',?,?)`, project.ID, now, now); err == nil || !strings.Contains(err.Error(), "invalid run status") {
		t.Fatalf("raw invalid run insert was not rejected by the database: %v", err)
	}
	var inserted int
	if err := database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE id='run_raw_invalid'").Scan(&inserted); err != nil {
		t.Fatal(err)
	}
	if inserted != 0 {
		t.Fatal("failed raw insert left a run row behind")
	}

	run, err := database.CreateRun(ctx, project.ID, "", "valid transition", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL().ExecContext(ctx, "UPDATE runs SET status='not_a_run_status' WHERE id=?", run.ID); err == nil || !strings.Contains(err.Error(), "invalid run status") {
		t.Fatalf("raw invalid run update was not rejected by the database: %v", err)
	}
	afterRejectedUpdate, err := database.Run(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if afterRejectedUpdate.Status != core.RunQueued || afterRejectedUpdate.Revision != run.Revision {
		t.Fatalf("rejected update changed authoritative run state: %+v", afterRejectedUpdate)
	}
	transitioned, err := database.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatalf("normal queued-to-planning transition was blocked: %v", err)
	}
	if transitioned.Status != core.RunPlanning || transitioned.Revision != run.Revision+1 {
		t.Fatalf("unexpected normal transition result: %+v", transitioned)
	}
	allowed := []core.RunStatus{
		core.RunQueued, core.RunPlanning, core.RunCollecting, core.RunSynthesizing,
		core.RunReviewing, core.RunRevising, core.RunWaitingApproval, core.RunSucceeded,
		core.RunQualityFailed, core.RunFailed, core.RunCancelled, core.RunInterrupted, core.RunUncertain,
	}
	for _, status := range allowed {
		if _, err := database.SQL().ExecContext(ctx, "UPDATE runs SET status=? WHERE id=?", status, run.ID); err != nil {
			t.Fatalf("database status domain omitted %q: %v", status, err)
		}
		var stored string
		if err := database.SQL().QueryRowContext(ctx, "SELECT status FROM runs WHERE id=?", run.ID).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		if stored != string(status) {
			t.Fatalf("stored run status = %q, want %q", stored, status)
		}
	}
}

func TestRunStatusMigrationRejectsLegacyInvalidRowsAtomically(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "invalid-run-status.db")
	database, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	project, err := database.CreateProject(ctx, "legacy invalid status")
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "legacy row", "")
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.ExecContext(ctx, `
DROP TRIGGER runs_status_insert_guard;
DROP TRIGGER runs_status_update_guard;
DELETE FROM schema_migrations WHERE version=12;
UPDATE runs SET status='legacy_invalid' WHERE id=?;`, run.ID); err != nil {
		raw.Close()
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	if reopened, err := Open(ctx, path); err == nil {
		reopened.Close()
		t.Fatal("migration 12 accepted a legacy invalid run status")
	} else if !strings.Contains(err.Error(), "apply database migration 12") {
		t.Fatalf("unexpected migration preflight error: %v", err)
	}

	raw, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	var migrationRows, triggerRows, preflightTables int
	if err := raw.QueryRowContext(ctx, "SELECT COUNT(*) FROM schema_migrations WHERE version=12").Scan(&migrationRows); err != nil {
		t.Fatal(err)
	}
	if err := raw.QueryRowContext(ctx, `
SELECT COUNT(*) FROM sqlite_master
WHERE type='trigger' AND name IN('runs_status_insert_guard','runs_status_update_guard')`).Scan(&triggerRows); err != nil {
		t.Fatal(err)
	}
	if err := raw.QueryRowContext(ctx, `
SELECT COUNT(*) FROM sqlite_master
WHERE type='table' AND name='migration_12_run_status_preflight'`).Scan(&preflightTables); err != nil {
		t.Fatal(err)
	}
	if migrationRows != 0 || triggerRows != 0 || preflightTables != 0 {
		t.Fatalf("failed migration 12 partially activated: ledger=%d triggers=%d preflight_tables=%d", migrationRows, triggerRows, preflightTables)
	}
}
