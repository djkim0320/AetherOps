package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
)

type screeningDedupeFixture struct {
	database     *DB
	objects      *cas.Store
	run          core.Run
	first        core.StageAttempt
	second       core.StageAttempt
	verification core.StageAttempt
}

func newScreeningDedupeFixture(t *testing.T) screeningDedupeFixture {
	t.Helper()
	ctx := context.Background()
	database, objects := openTestDB(t)
	project, err := database.CreateProject(ctx, "XFOIL screening dedupe")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "screen candidates", "main-thread")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	first, err := database.BeginStage(ctx, run.ID, core.StageCollect, 0, "collector-0", "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := database.BeginStage(ctx, run.ID, core.StageCollect, 1, "collector-1", "")
	if err != nil {
		t.Fatal(err)
	}
	verification, err := database.BeginStage(
		ctx, run.ID, core.StageCollect, core.EngineeringVerificationOrdinal, "collector-verification", "",
	)
	if err != nil {
		t.Fatal(err)
	}
	return screeningDedupeFixture{
		database: database, objects: objects, run: run,
		first: first, second: second, verification: verification,
	}
}

func screeningApproval(t *testing.T, run core.Run, attempt core.StageAttempt, purpose string, deflection float64) core.Approval {
	t.Helper()
	arguments := map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID,
		"execution_purpose": purpose, "naca": "0015", "reynolds": 1_000_000,
		"mach": 0.1, "flap_deflection_deg": deflection,
		"optimization_objective": "minimize_cd_at_target_cl", "target_cl": 0.8,
		"minimum_cm": -0.2,
	}
	if purpose == "independent_verification" {
		arguments["verification_of_job_id"] = "eng_screening_source"
	}
	encoded, err := json.Marshal(arguments)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(encoded)
	return core.Approval{
		RunID: run.ID, StageAttemptID: attempt.ID,
		ThreadID: attempt.CodexThreadID, TurnID: "turn-" + attempt.ID, ItemID: "item-" + attempt.ID,
		Kind: "item/mcpToolCall/requestApproval", Summary: "XFOIL screening",
		Server: "aetherops_engineering", Tool: "xfoil_polar",
		ArgumentsJSON: string(encoded), ArgumentsSHA256: hex.EncodeToString(digest[:]),
		Risk: "external_side_effect", ExternalSideEffect: true,
	}
}

func beginScreeningDedupeJob(t *testing.T, fixture screeningDedupeFixture, approval core.Approval) EngineeringJob {
	t.Helper()
	specJSON := `{"arguments":` + approval.ArgumentsJSON + `,"operation":"xfoil_polar","tool_component":"xfoil","tool_version":"6.99"}`
	digest := sha256.Sum256([]byte(specJSON))
	job, execute, err := fixture.database.BeginEngineeringJob(context.Background(), EngineeringJob{
		ProjectID: fixture.run.ProjectID, RunID: fixture.run.ID, StageAttemptID: approval.StageAttemptID,
		Operation: "xfoil_polar", SpecJSON: specJSON, SpecSHA256: hex.EncodeToString(digest[:]),
		ToolComponent: "xfoil", ToolVersion: "6.99", ApprovalScopeHash: approval.ArgumentsSHA256,
	})
	if err != nil || !execute {
		t.Fatalf("begin screening job: execute=%v err=%v", execute, err)
	}
	return job
}

func TestCreateApprovalDeduplicatesEquivalentRunWideXFOILScreeningScopes(t *testing.T) {
	for _, test := range []struct {
		state       string
		wantBlocked bool
	}{
		{state: "pending", wantBlocked: true},
		{state: "approved", wantBlocked: true},
		{state: "running", wantBlocked: true},
		{state: "succeeded", wantBlocked: true},
		{state: "denied"},
		{state: "failed"},
	} {
		t.Run(test.state, func(t *testing.T) {
			ctx := context.Background()
			fixture := newScreeningDedupeFixture(t)
			first, err := fixture.database.CreateApproval(ctx, screeningApproval(t, fixture.run, fixture.first, "screening", 0))
			if err != nil {
				t.Fatal(err)
			}
			if test.state != "pending" {
				decision := "approved"
				if test.state == "denied" {
					decision = "denied"
				}
				first, err = fixture.database.DecideApproval(ctx, first.ID, decision)
				if err != nil {
					t.Fatal(err)
				}
			}
			if test.state == "running" || test.state == "succeeded" || test.state == "failed" {
				job := beginScreeningDedupeJob(t, fixture, first)
				switch test.state {
				case "failed":
					if err := fixture.database.FailEngineeringJob(ctx, job.ID, errors.New("solver failed")); err != nil {
						t.Fatal(err)
					}
				case "succeeded":
					receipt, err := fixture.objects.PutBytes([]byte(`{"schema":1,"executed":true}`))
					if err != nil {
						t.Fatal(err)
					}
					artifact, err := fixture.database.PublishArtifact(
						ctx, fixture.run.ID, fixture.first.ID, "engineering.xfoil_polar.receipt", "application/json", receipt,
					)
					if err != nil {
						t.Fatal(err)
					}
					if _, err := fixture.database.CompleteEngineeringJob(ctx, job.ID, artifact.ID, []EngineeringJobArtifact{{
						ArtifactID: artifact.ID, Role: "receipt", FileName: "execution-receipt.json",
						MediaType: "application/json", BlobHash: artifact.BlobHash,
					}}); err != nil {
						t.Fatal(err)
					}
				}
			}

			_, err = fixture.database.CreateApproval(ctx, screeningApproval(t, fixture.run, fixture.first, "screening", 0))
			if test.wantBlocked {
				if !errors.Is(err, ErrDuplicateEngineeringScreening) {
					t.Fatalf("duplicate %s scope error = %v", test.state, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("retry after %s was rejected: %v", test.state, err)
			}
		})
	}
}

func TestXFOILScreeningDedupePreservesDifferentCandidatesAndIndependentVerification(t *testing.T) {
	ctx := context.Background()
	fixture := newScreeningDedupeFixture(t)
	if _, err := fixture.database.CreateApproval(ctx, screeningApproval(t, fixture.run, fixture.first, "screening", 0)); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.database.CreateApproval(ctx, screeningApproval(t, fixture.run, fixture.first, "screening", 5)); err != nil {
		t.Fatalf("different screening candidate was rejected: %v", err)
	}
	if _, err := fixture.database.CreateApproval(
		ctx, screeningApproval(t, fixture.run, fixture.verification, "independent_verification", 0),
	); err != nil {
		t.Fatalf("independent verification was rejected as screening replay: %v", err)
	}
}

func TestXFOILScreeningRejectsEveryNonOwnerCollectorCandidate(t *testing.T) {
	ctx := context.Background()
	fixture := newScreeningDedupeFixture(t)
	_, err := fixture.database.CreateApproval(
		ctx, screeningApproval(t, fixture.run, fixture.second, "screening", 5),
	)
	if !errors.Is(err, ErrXFOILScreeningOwner) {
		t.Fatalf("non-owner screening error = %v", err)
	}
	if pending, listErr := fixture.database.ListPendingApprovals(ctx); listErr != nil || len(pending) != 0 {
		t.Fatalf("non-owner screening persisted approval: %+v, err=%v", pending, listErr)
	}
}
