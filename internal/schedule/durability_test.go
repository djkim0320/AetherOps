package schedule

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/store"
)

const (
	schedulerCrashHelperEnvironment = "AETHEROPS_SCHEDULER_CRASH_HELPER"
	schedulerCrashDatabaseEnv       = "AETHEROPS_SCHEDULER_CRASH_DATABASE"
	schedulerCrashModeEnv           = "AETHEROPS_SCHEDULER_CRASH_MODE"
	schedulerCrashProjectEnv        = "AETHEROPS_SCHEDULER_CRASH_PROJECT"
	schedulerCrashScheduleEnv       = "AETHEROPS_SCHEDULER_CRASH_SCHEDULE"
	schedulerCrashOccurrenceEnv     = "AETHEROPS_SCHEDULER_CRASH_OCCURRENCE"
	schedulerIntentionalExitCode    = 93
)

// TestServiceForcedTerminationBoundariesNeverDuplicateOccurrence uses the
// test binary as a separate AetherOps process. os.Exit deliberately bypasses
// every defer so SQLite sees an actual process exit, not a test rollback.
func TestServiceForcedTerminationBoundariesNeverDuplicateOccurrence(t *testing.T) {
	for _, mode := range []string{"before_claim_commit", "after_claim_commit_before_cursor"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			databasePath := filepath.Join(t.TempDir(), "scheduler-crash.db")
			database, err := store.Open(ctx, databasePath)
			if err != nil {
				t.Fatal(err)
			}
			project, err := database.CreateProject(ctx, "forced termination "+mode)
			if err != nil {
				database.Close()
				t.Fatal(err)
			}
			if err := database.SetProjectMainThread(ctx, project.ID, "thread-main"); err != nil {
				database.Close()
				t.Fatal(err)
			}
			start := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
			clock := &fixedClock{now: start}
			created, err := (&Service{DB: database, Clock: clock}).Create(ctx, core.Schedule{
				ProjectID: project.ID, Question: "forced termination", Kind: "every",
				Expression: "1h", Timezone: "UTC", MainThreadID: "thread-main",
			})
			if err != nil {
				database.Close()
				t.Fatal(err)
			}
			due := start.Add(time.Hour)
			if err := database.Close(); err != nil {
				t.Fatal(err)
			}

			runSchedulerCrashHelper(t, databasePath, mode, project.ID, created.ID, due)

			reopened, err := store.Open(ctx, databasePath)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			clock.now = due
			restarted := &Service{DB: reopened, Clock: clock}
			if err := restarted.Tick(ctx); err != nil {
				t.Fatal(err)
			}
			if err := restarted.Tick(ctx); err != nil {
				t.Fatal(err)
			}

			runs, err := reopened.ListRuns(ctx, project.ID, 100)
			if err != nil {
				t.Fatal(err)
			}
			if len(runs) != 1 || runs[0].ScheduleID != created.ID {
				t.Fatalf("forced termination boundary %s created runs %+v, want exactly one", mode, runs)
			}
			var firingCount, queuedCount, claimingCount int
			if err := reopened.SQL().QueryRowContext(ctx, `
SELECT COUNT(*),
       COALESCE(SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END),0),
       COALESCE(SUM(CASE WHEN status='claiming' THEN 1 ELSE 0 END),0)
FROM schedule_firings WHERE schedule_id=? AND scheduled_for=?`,
				created.ID, due.Format(time.RFC3339Nano)).Scan(&firingCount, &queuedCount, &claimingCount); err != nil {
				t.Fatal(err)
			}
			if firingCount != 1 || queuedCount != 1 || claimingCount != 0 {
				t.Fatalf("forced termination boundary %s firing state = total:%d queued:%d claiming:%d", mode, firingCount, queuedCount, claimingCount)
			}
			assertNoDuplicateScheduleFirings(t, reopened, created.ID)
			schedules, err := reopened.ListSchedules(ctx, project.ID)
			if err != nil {
				t.Fatal(err)
			}
			wantNext := start.Add(2 * time.Hour)
			if len(schedules) != 1 || schedules[0].NextRunAt == nil || !schedules[0].NextRunAt.Equal(wantNext) {
				t.Fatalf("forced termination boundary %s cursor = %+v, want %s", mode, schedules, wantNext)
			}
		})
	}
}

func runSchedulerCrashHelper(t *testing.T, databasePath, mode, projectID, scheduleID string, occurrence time.Time) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestSchedulerForcedExitHelper$", "-test.count=1")
	command.Env = append(os.Environ(),
		schedulerCrashHelperEnvironment+"=1",
		schedulerCrashDatabaseEnv+"="+databasePath,
		schedulerCrashModeEnv+"="+mode,
		schedulerCrashProjectEnv+"="+projectID,
		schedulerCrashScheduleEnv+"="+scheduleID,
		schedulerCrashOccurrenceEnv+"="+occurrence.Format(time.RFC3339Nano),
	)
	output, err := command.CombinedOutput()
	exitError, ok := err.(*exec.ExitError)
	if !ok || exitError.ExitCode() != schedulerIntentionalExitCode {
		t.Fatalf("scheduler crash helper mode %s exit=%v output=%s", mode, err, output)
	}
}

// TestSchedulerForcedExitHelper is entered only by
// TestServiceForcedTerminationBoundariesNeverDuplicateOccurrence.
func TestSchedulerForcedExitHelper(t *testing.T) {
	if os.Getenv(schedulerCrashHelperEnvironment) != "1" {
		return
	}
	if err := executeSchedulerCrashBoundary(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Exit(schedulerIntentionalExitCode)
}

func executeSchedulerCrashBoundary() error {
	ctx := context.Background()
	database, err := store.Open(ctx, os.Getenv(schedulerCrashDatabaseEnv))
	if err != nil {
		return err
	}
	occurrence, err := time.Parse(time.RFC3339Nano, os.Getenv(schedulerCrashOccurrenceEnv))
	if err != nil {
		return err
	}
	mode := os.Getenv(schedulerCrashModeEnv)
	switch mode {
	case "before_claim_commit":
		transaction, err := database.SQL().BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		result, err := transaction.ExecContext(ctx, `
INSERT INTO schedule_firings(schedule_id,scheduled_for,run_id,status,created_at)
VALUES(?,?,NULL,'claiming',?)`, os.Getenv(schedulerCrashScheduleEnv),
			occurrence.Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano))
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count != 1 {
			return fmt.Errorf("uncommitted claim rows=%d, want 1", count)
		}
		// Deliberately leave the transaction and DB open for os.Exit.
		return nil
	case "after_claim_commit_before_cursor":
		schedules, err := database.ListSchedules(ctx, os.Getenv(schedulerCrashProjectEnv))
		if err != nil {
			return err
		}
		if len(schedules) != 1 || schedules[0].ID != os.Getenv(schedulerCrashScheduleEnv) {
			return fmt.Errorf("crash helper schedule mismatch: %+v", schedules)
		}
		_, claimed, err := database.CreateScheduledRun(ctx, schedules[0], occurrence)
		if err != nil {
			return err
		}
		if !claimed {
			return fmt.Errorf("crash helper could not claim occurrence %s", occurrence)
		}
		// CreateScheduledRun committed, but schedules.next_run_at is still due.
		return nil
	default:
		return fmt.Errorf("unknown scheduler crash mode %q", mode)
	}
}
