package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
)

type engineeringReceiptSecurityFixture struct {
	database        *DB
	objects         *cas.Store
	run             core.Run
	attempt         core.StageAttempt
	job             EngineeringJob
	receiptArtifact Artifact
	source          core.EvidenceSource
}

func completedEngineeringReceiptSecurityFixture(t *testing.T) engineeringReceiptSecurityFixture {
	t.Helper()
	ctx := context.Background()
	database, objects := openTestDB(t)
	project, err := database.CreateProject(ctx, "engineering receipt provenance")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "receipt provenance", "main-thread")
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
	attempt, err := database.BeginStage(ctx, run.ID, core.StageCollect, 0, "collector-thread", "collector-turn")
	if err != nil {
		t.Fatal(err)
	}
	const operation = "xfoil_polar"
	const arguments = `{"alpha_end_deg":4,"alpha_start_deg":0,"alpha_step_deg":2,"mach":0.1,"naca":"0012","reynolds":1000000}`
	approveEngineeringScope(t, database, run, attempt, "aetherops_engineering", operation, arguments)
	job := engineeringJobFor(run, attempt, operation, sha256Text(arguments))
	job.ToolComponent = "xfoil"
	job, execute, err := database.BeginEngineeringJob(ctx, job)
	if err != nil || !execute {
		t.Fatalf("begin receipt job: execute=%v err=%v", execute, err)
	}
	receipt, err := objects.PutBytes([]byte(`{"schema":1,"executed":true,"numerically_valid":true}`))
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := database.PublishArtifact(ctx, run.ID, attempt.ID,
		"engineering.xfoil_polar.receipt", "application/json", receipt)
	if err != nil {
		t.Fatal(err)
	}
	job, err = database.CompleteEngineeringJob(ctx, job.ID, artifact.ID, []EngineeringJobArtifact{{
		ArtifactID: artifact.ID,
		Role:       "receipt",
		FileName:   "execution-receipt.json",
		MediaType:  "application/json",
		BlobHash:   artifact.BlobHash,
	}})
	if err != nil {
		t.Fatal(err)
	}
	source, err := core.EngineeringReceiptEvidenceSource(
		artifact.ID, operation, artifact.BlobHash, artifact.CreatedAt,
	)
	if err != nil {
		t.Fatal(err)
	}
	return engineeringReceiptSecurityFixture{
		database: database, objects: objects, run: run, attempt: attempt, job: job,
		receiptArtifact: artifact, source: source,
	}
}

func engineeringSecurityRun(t *testing.T) (*DB, core.Run, core.StageAttempt) {
	t.Helper()
	database, _ := openTestDB(t)
	ctx := context.Background()
	project, err := database.CreateProject(ctx, "engineering security")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "solver scope", "main-thread")
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
	attempt, err := database.BeginStage(ctx, run.ID, core.StageCollect, 0, "collector-thread", "collector-turn")
	if err != nil {
		t.Fatal(err)
	}
	return database, run, attempt
}

func sha256Text(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func approveEngineeringScope(
	t *testing.T, database *DB, run core.Run, attempt core.StageAttempt,
	server, tool, argumentsJSON string,
) core.Approval {
	t.Helper()
	approval, err := database.CreateApproval(context.Background(), core.Approval{
		RunID: run.ID, StageAttemptID: attempt.ID,
		ThreadID: attempt.CodexThreadID, TurnID: "collector-turn", ItemID: "solver-call",
		Kind: "item/mcpToolCall/requestApproval", Summary: "typed engineering solver",
		Server: server, Tool: tool, ArgumentsJSON: argumentsJSON,
		ArgumentsSHA256: sha256Text(argumentsJSON), Risk: "external_side_effect",
		ExternalSideEffect: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	approval, err = database.DecideApproval(context.Background(), approval.ID, "approved")
	if err != nil {
		t.Fatal(err)
	}
	return approval
}

func engineeringJobFor(
	run core.Run, attempt core.StageAttempt, operation, approvalScopeHash string,
) EngineeringJob {
	specJSON := `{"arguments":{"mach":0.3},"operation":"` + operation + `","tool_version":"1"}`
	return EngineeringJob{
		ProjectID: run.ProjectID, RunID: run.ID, StageAttemptID: attempt.ID,
		Operation: operation, SpecJSON: specJSON, SpecSHA256: sha256Text(specJSON),
		ToolComponent: "su2", ToolVersion: "1", ApprovalScopeHash: approvalScopeHash,
	}
}

func stageHasExternalSideEffects(t *testing.T, database *DB, attemptID string) bool {
	t.Helper()
	var marked bool
	if err := database.SQL().QueryRowContext(context.Background(),
		"SELECT external_side_effects FROM stage_attempts WHERE id=?", attemptID,
	).Scan(&marked); err != nil {
		t.Fatal(err)
	}
	return marked
}

func TestEngineeringServiceOwnsExternalBoundaryOnlyForCanonicalSurface(t *testing.T) {
	base := core.Approval{
		Kind: "item/mcpToolCall/requestApproval", Server: "aetherops_engineering",
		ExternalSideEffect: true,
	}
	for _, tool := range []string{
		"openvsp_wing_aero", "openvsp_modify_wing", "gmsh_wing_mesh", "xfoil_polar", "su2_naca0012",
	} {
		approval := base
		approval.Tool = tool
		if !EngineeringServiceOwnsExternalBoundary(approval) {
			t.Fatalf("canonical app-owned engineering tool %q did not own its boundary", tool)
		}
	}
	for _, mutate := range []func(*core.Approval){
		func(approval *core.Approval) { approval.Kind = "mcpServer/elicitation/request" },
		func(approval *core.Approval) { approval.Server = "aetherops-engineering" },
		func(approval *core.Approval) { approval.Server = "aetherops_engineering_evil" },
		func(approval *core.Approval) { approval.Tool = "XFOIL_POLAR" },
		func(approval *core.Approval) { approval.Tool = "unknown_solver" },
		func(approval *core.Approval) { approval.ExternalSideEffect = false },
	} {
		approval := base
		approval.Tool = "xfoil_polar"
		mutate(&approval)
		if EngineeringServiceOwnsExternalBoundary(approval) {
			t.Fatalf("noncanonical approval delegated its boundary: %+v", approval)
		}
	}
}

func TestSucceededEngineeringJobForApprovalScopeIsExactAndCompleted(t *testing.T) {
	ctx := context.Background()
	completed := completedEngineeringReceiptSecurityFixture(t)
	job, found, err := completed.database.SucceededEngineeringJobForApprovalScope(
		ctx, completed.run.ID, completed.attempt.ID, completed.job.Operation,
		completed.job.ApprovalScopeHash,
	)
	if err != nil || !found || job.ID != completed.job.ID {
		t.Fatalf("exact completed replay = %+v, found=%v err=%v", job, found, err)
	}
	for _, test := range []struct {
		name, runID, attemptID, operation, scope string
	}{
		{"different run", "run_missing", completed.attempt.ID, completed.job.Operation, completed.job.ApprovalScopeHash},
		{"different attempt", completed.run.ID, "stg_missing", completed.job.Operation, completed.job.ApprovalScopeHash},
		{"different operation", completed.run.ID, completed.attempt.ID, "su2_naca0012", completed.job.ApprovalScopeHash},
		{"different arguments", completed.run.ID, completed.attempt.ID, completed.job.Operation, strings.Repeat("f", 64)},
	} {
		t.Run(test.name, func(t *testing.T) {
			if unexpected, ok, lookupErr := completed.database.SucceededEngineeringJobForApprovalScope(
				ctx, test.runID, test.attemptID, test.operation, test.scope,
			); lookupErr != nil || ok {
				t.Fatalf("non-exact replay matched %+v, found=%v err=%v", unexpected, ok, lookupErr)
			}
		})
	}

	database, run, attempt := engineeringSecurityRun(t)
	const operation = "xfoil_polar"
	const arguments = `{"mach":0.1,"naca":"0012"}`
	approveEngineeringScope(t, database, run, attempt, "aetherops_engineering", operation, arguments)
	running, execute, err := database.BeginEngineeringJob(
		ctx, engineeringJobFor(run, attempt, operation, sha256Text(arguments)),
	)
	if err != nil || !execute {
		t.Fatalf("begin running replay fixture: execute=%v err=%v", execute, err)
	}
	if unexpected, found, lookupErr := database.SucceededEngineeringJobForApprovalScope(
		ctx, run.ID, attempt.ID, operation, sha256Text(arguments),
	); lookupErr != nil || found {
		t.Fatalf("running job matched completed replay: %+v found=%v err=%v", unexpected, found, lookupErr)
	}
	if err := database.FailEngineeringJob(ctx, running.ID, errors.New("solver failed")); err != nil {
		t.Fatal(err)
	}
	if unexpected, found, lookupErr := database.SucceededEngineeringJobForApprovalScope(
		ctx, run.ID, attempt.ID, operation, sha256Text(arguments),
	); lookupErr != nil || found {
		t.Fatalf("failed job matched completed replay: %+v found=%v err=%v", unexpected, found, lookupErr)
	}
	if _, _, err := database.SucceededEngineeringJobForApprovalScope(ctx, "", attempt.ID, operation, sha256Text(arguments)); err == nil {
		t.Fatal("incomplete replay scope was accepted")
	}
}

func TestCreateApprovalRequiresExactArgumentsSHA256(t *testing.T) {
	database, run, attempt := engineeringSecurityRun(t)
	validJSON := `{"alpha_deg":2,"mach":0.3}`
	base := core.Approval{
		RunID: run.ID, StageAttemptID: attempt.ID,
		ThreadID: attempt.CodexThreadID, TurnID: "collector-turn", ItemID: "solver-call",
		Kind: "item/mcpToolCall/requestApproval", Summary: "scope",
		Server: "aetherops_engineering", Tool: "su2_naca0012",
		ArgumentsJSON: validJSON, ArgumentsSHA256: sha256Text(validJSON),
		Risk: "external_side_effect", ExternalSideEffect: true,
	}
	if _, err := database.CreateApproval(context.Background(), base); err != nil {
		t.Fatalf("valid exact scope was rejected: %v", err)
	}

	wrongHash := base
	wrongHash.ID = ""
	wrongHash.ArgumentsSHA256 = strings.Repeat("0", 64)
	if _, err := database.CreateApproval(context.Background(), wrongHash); err == nil {
		t.Fatal("arguments JSON with a mismatched SHA-256 was stored")
	}

	invalidJSON := base
	invalidJSON.ID = ""
	invalidJSON.ArgumentsJSON = `{"mach":`
	invalidJSON.ArgumentsSHA256 = sha256Text(invalidJSON.ArgumentsJSON)
	if _, err := database.CreateApproval(context.Background(), invalidJSON); err == nil {
		t.Fatal("invalid arguments JSON was stored")
	}

	missingPair := base
	missingPair.ID = ""
	missingPair.ArgumentsSHA256 = ""
	if _, err := database.CreateApproval(context.Background(), missingPair); err == nil {
		t.Fatal("arguments JSON without its SHA-256 was stored")
	}
}

func TestBeginEngineeringJobRequiresExactServerToolAndArgumentsScope(t *testing.T) {
	const operation = "su2_naca0012"
	const arguments = `{"alpha_deg":2,"mach":0.3}`
	tests := []struct {
		name              string
		server            string
		tool              string
		approvedArguments string
		wantAuthorized    bool
	}{
		{name: "exact", server: "aetherops_engineering", tool: operation, approvedArguments: arguments, wantAuthorized: true},
		{name: "wrong server", server: "unclassified_external", tool: operation, approvedArguments: arguments},
		{name: "server alias is not canonical", server: "aetherops-engineering", tool: operation, approvedArguments: arguments},
		{name: "wrong tool", server: "aetherops_engineering", tool: "gmsh_wing_mesh", approvedArguments: arguments},
		{name: "wrong tool case", server: "aetherops_engineering", tool: "SU2_NACA0012", approvedArguments: arguments},
		{name: "wrong arguments hash", server: "aetherops_engineering", tool: operation, approvedArguments: `{"alpha_deg":3,"mach":0.3}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			database, run, attempt := engineeringSecurityRun(t)
			approval := approveEngineeringScope(t, database, run, attempt, test.server, test.tool, test.approvedArguments)
			if stageHasExternalSideEffects(t, database, attempt.ID) {
				t.Fatal("approval alone crossed the app-owned engineering execution boundary")
			}
			job := engineeringJobFor(run, attempt, operation, sha256Text(arguments))
			stored, execute, err := database.BeginEngineeringJob(context.Background(), job)
			if !test.wantAuthorized {
				if err == nil || execute {
					t.Fatalf("out-of-scope approval authorized execution: job=%+v approval=%+v", stored, approval)
				}
				if stageHasExternalSideEffects(t, database, attempt.ID) {
					t.Fatal("rejected engineering admission left a side-effect marker")
				}
				var count int
				if err := database.SQL().QueryRowContext(context.Background(),
					"SELECT COUNT(*) FROM engineering_jobs WHERE stage_attempt_id=?", attempt.ID,
				).Scan(&count); err != nil || count != 0 {
					t.Fatalf("rejected admission jobs=%d err=%v", count, err)
				}
				return
			}
			if err != nil || !execute {
				t.Fatalf("exact approval did not authorize execution: execute=%v err=%v", execute, err)
			}
			if stored.ApprovalID != approval.ID || stored.ApprovalScopeHash != sha256Text(arguments) {
				t.Fatalf("job approval binding = %+v, approval=%+v", stored, approval)
			}
			if !stageHasExternalSideEffects(t, database, attempt.ID) || stored.Status != "running" {
				t.Fatalf("running job and side-effect marker were not committed together: %+v", stored)
			}
		})
	}
}

func TestEngineeringJobIsAtMostOnceAndRecoveryIsUncertain(t *testing.T) {
	database, run, attempt := engineeringSecurityRun(t)
	const operation = "su2_naca0012"
	const arguments = `{"alpha_deg":2,"mach":0.3}`
	approveEngineeringScope(t, database, run, attempt, "aetherops_engineering", operation, arguments)
	if stageHasExternalSideEffects(t, database, attempt.ID) {
		t.Fatal("engineering approval crossed the boundary before job admission")
	}
	job := engineeringJobFor(run, attempt, operation, sha256Text(arguments))
	started, execute, err := database.BeginEngineeringJob(context.Background(), job)
	if err != nil || !execute {
		t.Fatalf("start engineering job: execute=%v err=%v", execute, err)
	}
	if !stageHasExternalSideEffects(t, database, attempt.ID) {
		t.Fatal("engineering admission did not mark its stage")
	}
	if duplicate, duplicateExecute, duplicateErr := database.BeginEngineeringJob(context.Background(), job); duplicateErr == nil || duplicateExecute {
		t.Fatalf("running job was duplicated: job=%+v execute=%v err=%v", duplicate, duplicateExecute, duplicateErr)
	}
	var count int
	if err := database.SQL().QueryRowContext(context.Background(), `
SELECT COUNT(*) FROM engineering_jobs
WHERE run_id = ? AND stage_attempt_id = ? AND operation = ? AND spec_sha256 = ?`,
		run.ID, attempt.ID, operation, job.SpecSHA256).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("stored identical engineering jobs = %d, want 1", count)
	}

	recovered, err := database.RecoverInFlight(context.Background())
	if err != nil || recovered != 1 {
		t.Fatalf("recover in-flight: count=%d err=%v", recovered, err)
	}
	run, err = database.Run(context.Background(), run.ID)
	if err != nil || run.Status != core.RunUncertain {
		t.Fatalf("run recovery status = %s, err=%v", run.Status, err)
	}
	recoveredJob, err := database.EngineeringJob(context.Background(), started.ID)
	if err != nil || recoveredJob.Status != "uncertain" {
		t.Fatalf("engineering recovery status = %s, err=%v", recoveredJob.Status, err)
	}
	attempts, err := database.ListStageAttempts(context.Background(), run.ID)
	if err != nil || len(attempts) != 1 || attempts[0].Status != string(core.RunUncertain) || !attempts[0].ExternalSideEffects {
		t.Fatalf("stage recovery = %+v, err=%v", attempts, err)
	}
	if duplicate, duplicateExecute, duplicateErr := database.BeginEngineeringJob(context.Background(), job); duplicateErr == nil || duplicateExecute {
		t.Fatalf("uncertain job was retried: job=%+v execute=%v err=%v", duplicate, duplicateExecute, duplicateErr)
	}
}

func TestEngineeringAdmissionRejectsInactiveOrFailedCollectWithoutMarkerOrJob(t *testing.T) {
	for _, test := range []struct {
		name    string
		prepare func(*testing.T, *DB, core.Run, core.StageAttempt)
	}{
		{
			name: "cancelled run",
			prepare: func(t *testing.T, database *DB, run core.Run, _ core.StageAttempt) {
				if _, err := database.QuiesceRun(context.Background(), run.ID, core.RunCancelled, "cancel before solver admission"); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "failed sibling collector",
			prepare: func(t *testing.T, database *DB, run core.Run, _ core.StageAttempt) {
				sibling, err := database.BeginStage(context.Background(), run.ID, core.StageCollect, 1, "failed-sibling", "")
				if err != nil {
					t.Fatal(err)
				}
				if err := database.CompleteStage(context.Background(), sibling.ID, "", "sibling validation failed"); err != nil {
					t.Fatal(err)
				}
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			database, run, attempt := engineeringSecurityRun(t)
			const operation = "su2_naca0012"
			const arguments = `{"alpha_deg":2,"mach":0.3}`
			approveEngineeringScope(t, database, run, attempt, "aetherops_engineering", operation, arguments)
			test.prepare(t, database, run, attempt)
			if _, execute, err := database.BeginEngineeringJob(context.Background(),
				engineeringJobFor(run, attempt, operation, sha256Text(arguments)),
			); !errors.Is(err, ErrApprovalNotActive) || execute {
				t.Fatalf("inactive engineering admission: execute=%v err=%v", execute, err)
			}
			if stageHasExternalSideEffects(t, database, attempt.ID) {
				t.Fatal("inactive engineering admission left a side-effect marker")
			}
			var jobs int
			if err := database.SQL().QueryRowContext(context.Background(),
				"SELECT COUNT(*) FROM engineering_jobs WHERE stage_attempt_id=?", attempt.ID,
			).Scan(&jobs); err != nil || jobs != 0 {
				t.Fatalf("inactive engineering admission jobs=%d err=%v", jobs, err)
			}
		})
	}
}

func TestEngineeringReceiptEvidenceIsBoundToExactRunAttemptAndMetadata(t *testing.T) {
	fixture := completedEngineeringReceiptSecurityFixture(t)
	ctx := context.Background()

	if err := fixture.database.VerifyEvidenceSources(ctx, fixture.run.ID, []core.EvidenceSource{fixture.source}); err != nil {
		t.Fatalf("exact run-owned receipt provenance was rejected: %v", err)
	}
	if err := fixture.database.VerifyEvidenceSourcesForAttempt(
		ctx, fixture.run.ID, fixture.attempt.ID, []core.EvidenceSource{fixture.source},
	); err != nil {
		t.Fatalf("exact attempt-owned receipt provenance was rejected: %v", err)
	}
	if err := fixture.database.VerifyEvidenceSourcesForCollector(
		ctx, fixture.run.ID, 0, []core.EvidenceSource{fixture.source},
	); err != nil {
		t.Fatalf("exact collector-owned receipt provenance was rejected: %v", err)
	}

	otherAttempt, err := fixture.database.BeginStage(
		ctx, fixture.run.ID, core.StageCollect, 1, "other-collector-thread", "other-collector-turn",
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.database.VerifyEvidenceSourcesForAttempt(
		ctx, fixture.run.ID, otherAttempt.ID, []core.EvidenceSource{fixture.source},
	); err == nil {
		t.Fatal("receipt provenance crossed its collector-attempt boundary")
	}
	if err := fixture.database.VerifyEvidenceSourcesForCollector(
		ctx, fixture.run.ID, 1, []core.EvidenceSource{fixture.source},
	); err == nil {
		t.Fatal("receipt provenance crossed its logical collector boundary")
	}

	otherProject, err := fixture.database.CreateProject(ctx, "other receipt project")
	if err != nil {
		t.Fatal(err)
	}
	otherRun, err := fixture.database.CreateRun(ctx, otherProject.ID, "", "other run", "other-main")
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.database.VerifyEvidenceSources(
		ctx, otherRun.ID, []core.EvidenceSource{fixture.source},
	); err == nil {
		t.Fatal("receipt provenance crossed its run and project boundary")
	}

	mutations := map[string]func(core.EvidenceSource) core.EvidenceSource{
		"source id": func(source core.EvidenceSource) core.EvidenceSource {
			source.ID = "art_wrong"
			return source
		},
		"receipt URL": func(source core.EvidenceSource) core.EvidenceSource {
			source.URL = "urn:aetherops:engineering-receipt:art_wrong"
			return source
		},
		"title": func(source core.EvidenceSource) core.EvidenceSource {
			source.Title = "AetherOps engineering receipt: different_operation"
			return source
		},
		"publisher": func(source core.EvidenceSource) core.EvidenceSource {
			source.Publisher = "untrusted runtime"
			return source
		},
		"blob hash": func(source core.EvidenceSource) core.EvidenceSource {
			source.BlobHash = strings.Repeat("f", 64)
			return source
		},
		"capture time": func(source core.EvidenceSource) core.EvidenceSource {
			source.CapturedAt = source.CapturedAt.Add(time.Nanosecond)
			return source
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			tampered := mutate(fixture.source)
			if err := fixture.database.VerifyEvidenceSources(
				ctx, fixture.run.ID, []core.EvidenceSource{tampered},
			); err == nil {
				t.Fatalf("tampered engineering receipt %s was accepted", name)
			}
		})
	}
}

func TestEngineeringReceiptArtifactIDRehydratesExactImmutableMetadata(t *testing.T) {
	fixture := completedEngineeringReceiptSecurityFixture(t)
	ctx := context.Background()

	rehydrated, err := fixture.database.EngineeringReceiptEvidenceForCollector(
		ctx, fixture.run.ID, 0, fixture.receiptArtifact.ID,
	)
	if err != nil {
		t.Fatalf("rehydrate exact collector receipt: %v", err)
	}
	if rehydrated != fixture.source {
		t.Fatalf("rehydrated receipt changed immutable metadata:\n got %+v\nwant %+v", rehydrated, fixture.source)
	}

	// This reproduces the real 10-degree XFOIL failure shape: the assistant
	// retained a valid 64-character lowercase hash but transcribed different
	// opaque bytes. The store must ignore no model hash because the collector
	// contract supplies only the artifact id, while the legacy complete-source
	// verifier must continue rejecting the mutation.
	mutated := fixture.source
	mutated.BlobHash = strings.Repeat("a", 62) + "a3"
	if mutated.BlobHash == fixture.source.BlobHash || len(mutated.BlobHash) != 64 {
		t.Fatal("test did not construct a format-valid mutated hash")
	}
	if err := fixture.database.VerifyEvidenceSourcesForCollector(
		ctx, fixture.run.ID, 0, []core.EvidenceSource{mutated},
	); err == nil || !strings.Contains(err.Error(), "does not match its immutable receipt metadata") {
		t.Fatalf("mutated complete receipt metadata error = %v", err)
	}
	if rehydrated.BlobHash != fixture.receiptArtifact.BlobHash {
		t.Fatalf("rehydrated hash = %s, want receipt hash %s", rehydrated.BlobHash, fixture.receiptArtifact.BlobHash)
	}
}

func TestEngineeringReceiptArtifactIDRehydrationRejectsCrossAttemptAndForgedID(t *testing.T) {
	fixture := completedEngineeringReceiptSecurityFixture(t)
	ctx := context.Background()
	otherAttempt, err := fixture.database.BeginStage(
		ctx, fixture.run.ID, core.StageCollect, 1, "other-collector-thread", "other-collector-turn",
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.database.EngineeringReceiptEvidenceForCollector(
		ctx, fixture.run.ID, otherAttempt.Ordinal, fixture.receiptArtifact.ID,
	); err == nil || !strings.Contains(err.Error(), "not a succeeded run-owned collect receipt") {
		t.Fatalf("cross-attempt receipt rehydration error = %v", err)
	}
	if _, err := fixture.database.EngineeringReceiptEvidenceForCollector(
		ctx, fixture.run.ID, 0, "art_forged_receipt",
	); err == nil || !strings.Contains(err.Error(), "artifact id is invalid") {
		t.Fatalf("forged artifact id rehydration error = %v", err)
	}
	if _, err := fixture.database.EngineeringReceiptEvidenceForCollector(
		ctx, fixture.run.ID, 0, "urn:aetherops:engineering-receipt:"+fixture.receiptArtifact.ID,
	); err == nil || !strings.Contains(err.Error(), "artifact id is invalid") {
		t.Fatalf("model-supplied receipt URL was accepted as artifact id: %v", err)
	}
}

func TestEngineeringReceiptReuseRequiresExplicitAttemptScopedAuthorization(t *testing.T) {
	fixture := completedEngineeringReceiptSecurityFixture(t)
	ctx := context.Background()
	readbackAttempt, err := fixture.database.BeginStage(
		ctx, fixture.run.ID, core.StageCollect, 1, "readback-thread", "readback-turn",
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.database.EngineeringReceiptEvidenceForCollector(
		ctx, fixture.run.ID, readbackAttempt.Ordinal, fixture.receiptArtifact.ID,
	); err == nil {
		t.Fatal("prior receipt crossed attempts before the Go core authorized readback")
	}
	result := EngineeringResult{Job: fixture.job, Artifacts: []EngineeringJobArtifact{{
		ArtifactID: fixture.receiptArtifact.ID,
		Role:       "receipt",
		FileName:   "execution-receipt.json",
		MediaType:  "application/json",
		BlobHash:   fixture.receiptArtifact.BlobHash,
	}}}
	if err := fixture.database.AuthorizeEngineeringReceiptReuses(
		ctx, fixture.run.ID, readbackAttempt.ID, []EngineeringResult{result},
	); err != nil {
		t.Fatalf("authorize immutable receipt readback: %v", err)
	}
	readbackOnly, err := fixture.database.EngineeringReceiptReadbackOnly(ctx, fixture.run.ID, readbackAttempt.ID)
	if err != nil || !readbackOnly {
		t.Fatalf("readback-only scope = %t, err=%v", readbackOnly, err)
	}
	rehydrated, err := fixture.database.EngineeringReceiptEvidenceForCollector(
		ctx, fixture.run.ID, readbackAttempt.Ordinal, fixture.receiptArtifact.ID,
	)
	if err != nil {
		t.Fatalf("explicitly authorized receipt readback failed: %v", err)
	}
	if rehydrated != fixture.source {
		t.Fatalf("readback changed immutable source: got %+v want %+v", rehydrated, fixture.source)
	}
	if err := fixture.database.VerifyEvidenceSourcesForCollector(
		ctx, fixture.run.ID, readbackAttempt.Ordinal, []core.EvidenceSource{rehydrated},
	); err != nil {
		t.Fatalf("authorized receipt failed collector verification: %v", err)
	}
}

func TestEngineeringReceiptEvidenceRejectsNonReceiptAndIncompleteJob(t *testing.T) {
	fixture := completedEngineeringReceiptSecurityFixture(t)
	ctx := context.Background()

	// A distinct registered artifact from the same run and attempt is not a
	// receipt merely because a model wraps it in the closed receipt URN shape.
	dataReceipt, err := fixture.objects.PutBytes([]byte("not the receipt"))
	if err != nil {
		t.Fatal(err)
	}
	otherArtifact, err := fixture.database.PublishArtifact(
		ctx, fixture.run.ID, fixture.attempt.ID,
		"engineering.xfoil_polar.result", "application/json", dataReceipt,
	)
	if err != nil {
		t.Fatal(err)
	}
	nonReceipt, err := core.EngineeringReceiptEvidenceSource(
		otherArtifact.ID, fixture.job.Operation, otherArtifact.BlobHash, otherArtifact.CreatedAt,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.database.VerifyEvidenceSources(
		ctx, fixture.run.ID, []core.EvidenceSource{nonReceipt},
	); err == nil {
		t.Fatal("ordinary run artifact was accepted as an engineering receipt")
	}

	const pendingArguments = `{"mesh_size_m":0.25}`
	approveEngineeringScope(t, fixture.database, fixture.run, fixture.attempt,
		"aetherops_engineering", "gmsh_wing_mesh", pendingArguments)
	pending := engineeringJobFor(
		fixture.run, fixture.attempt, "gmsh_wing_mesh", sha256Text(pendingArguments),
	)
	pending.ToolComponent = "gmsh"
	pending, execute, err := fixture.database.BeginEngineeringJob(ctx, pending)
	if err != nil || !execute {
		t.Fatalf("begin incomplete job: execute=%v err=%v", execute, err)
	}
	pendingSource, err := core.EngineeringReceiptEvidenceSource(
		fixture.receiptArtifact.ID, pending.Operation,
		fixture.receiptArtifact.BlobHash, fixture.receiptArtifact.CreatedAt,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.database.VerifyEvidenceSources(
		ctx, fixture.run.ID, []core.EvidenceSource{pendingSource},
	); err == nil {
		t.Fatal("a running engineering job was accepted as completed receipt provenance")
	}
}
