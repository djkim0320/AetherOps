package store

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/core"
)

const (
	researchCrashHelperEnv   = "AETHEROPS_RESEARCH_CRASH_HELPER"
	researchCrashDatabaseEnv = "AETHEROPS_RESEARCH_CRASH_DATABASE"
	researchCrashRunEnv      = "AETHEROPS_RESEARCH_CRASH_RUN"
	researchCrashExternalEnv = "AETHEROPS_RESEARCH_CRASH_EXTERNAL"
	researchIntentionalExit  = 94
)

// TestResearchForcedTerminationNeverAutomaticallyReplaysStage crosses a real
// process boundary. The helper commits the external thread/turn identity and
// then calls os.Exit without closing SQLite, matching an abrupt application
// termination after a Codex turn has started.
func TestResearchForcedTerminationNeverAutomaticallyReplaysStage(t *testing.T) {
	for _, testCase := range []struct {
		name       string
		external   bool
		wantStatus core.RunStatus
	}{
		{name: "read_only", wantStatus: core.RunInterrupted},
		{name: "external_side_effect", external: true, wantStatus: core.RunUncertain},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			ctx := context.Background()
			databasePath := filepath.Join(t.TempDir(), "research-crash.db")
			database, err := Open(ctx, databasePath)
			if err != nil {
				t.Fatal(err)
			}
			project, err := database.CreateProject(ctx, "forced termination "+testCase.name)
			if err != nil {
				database.Close()
				t.Fatal(err)
			}
			run, err := database.CreateRun(ctx, project.ID, "", "forced termination", "")
			if err != nil {
				database.Close()
				t.Fatal(err)
			}
			run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
			if err != nil {
				database.Close()
				t.Fatal(err)
			}
			if err := database.Close(); err != nil {
				t.Fatal(err)
			}

			runResearchCrashHelper(t, databasePath, run.ID, testCase.external)

			reopened, err := Open(ctx, databasePath)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			recovered, err := reopened.RecoverInFlight(ctx)
			if err != nil || recovered != 1 {
				t.Fatalf("recover after forced termination = %d, %v", recovered, err)
			}
			if repeated, err := reopened.RecoverInFlight(ctx); err != nil || repeated != 0 {
				t.Fatalf("repeated recovery = %d, %v", repeated, err)
			}
			storedRun, err := reopened.Run(ctx, run.ID)
			if err != nil {
				t.Fatal(err)
			}
			if storedRun.Status != testCase.wantStatus {
				t.Fatalf("recovered status = %s, want %s", storedRun.Status, testCase.wantStatus)
			}
			attempts, err := reopened.ListStageAttempts(ctx, run.ID)
			if err != nil || len(attempts) != 1 {
				t.Fatalf("attempts after automatic recovery = %+v, %v", attempts, err)
			}
			if attempts[0].CodexThreadID != "thread-before-exit" || attempts[0].CodexTurnID != "turn-before-exit" ||
				attempts[0].Status != string(testCase.wantStatus) || attempts[0].ExternalSideEffects != testCase.external {
				t.Fatalf("recovered attempt lost durable identity: %+v", attempts[0])
			}

			if testCase.external {
				if err := reopened.PrepareInterruptedRunForResume(ctx, run.ID); err == nil {
					t.Fatal("uncertain external-side-effect turn was authorized for replay")
				}
				return
			}
			if err := reopened.PrepareInterruptedRunForResume(ctx, run.ID); err != nil {
				t.Fatal(err)
			}
			fresh, err := reopened.BeginStage(ctx, run.ID, core.StagePlan, 0, "thread-after-explicit-resume", strings.Repeat("b", 64))
			if err != nil {
				t.Fatalf("explicit read-only resume: %v", err)
			}
			attempts, err = reopened.ListStageAttempts(ctx, run.ID)
			if err != nil || len(attempts) != 2 || fresh.ID == attempts[0].ID {
				t.Fatalf("explicit resume attempt audit = %+v, %v", attempts, err)
			}
			if attempts[0].Status != "superseded" || attempts[0].CodexTurnID != "turn-before-exit" {
				t.Fatalf("explicit resume overwrote prior turn audit: %+v", attempts[0])
			}
		})
	}
}

func runResearchCrashHelper(t *testing.T, databasePath, runID string, external bool) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestResearchForcedExitHelper$", "-test.count=1")
	command.Env = append(os.Environ(),
		researchCrashHelperEnv+"=1",
		researchCrashDatabaseEnv+"="+databasePath,
		researchCrashRunEnv+"="+runID,
		fmt.Sprintf("%s=%t", researchCrashExternalEnv, external),
	)
	output, err := command.CombinedOutput()
	exitError, ok := err.(*exec.ExitError)
	if !ok || exitError.ExitCode() != researchIntentionalExit {
		t.Fatalf("research crash helper exit=%v output=%s", err, output)
	}
}

func TestResearchForcedExitHelper(t *testing.T) {
	if os.Getenv(researchCrashHelperEnv) != "1" {
		return
	}
	if err := executeResearchCrashBoundary(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Exit(researchIntentionalExit)
}

func executeResearchCrashBoundary() error {
	ctx := context.Background()
	database, err := Open(ctx, os.Getenv(researchCrashDatabaseEnv))
	if err != nil {
		return err
	}
	attempt, err := database.BeginStage(
		ctx,
		os.Getenv(researchCrashRunEnv),
		core.StagePlan,
		0,
		"thread-before-exit",
		strings.Repeat("a", 64),
	)
	if err != nil {
		return err
	}
	if err := database.SetStageTurn(ctx, attempt.ID, "thread-before-exit", "turn-before-exit"); err != nil {
		return err
	}
	if os.Getenv(researchCrashExternalEnv) == "true" {
		if err := database.MarkStageExternalSideEffects(ctx, attempt.ID); err != nil {
			return err
		}
	}
	// Deliberately leave SQLite and its WAL open for os.Exit.
	return nil
}
