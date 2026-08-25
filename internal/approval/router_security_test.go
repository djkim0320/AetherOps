package approval

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/codex"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
)

type engineeringReplayRouterFixture struct {
	database  *store.DB
	run       core.Run
	attempt   core.StageAttempt
	arguments map[string]any
}

func newEngineeringReplayRouterFixture(t *testing.T, jobStatus string) engineeringReplayRouterFixture {
	t.Helper()
	ctx := context.Background()
	database, run, planAttempt := activeRun(t)
	if err := database.CompleteStage(ctx, planAttempt.ID, "", ""); err != nil {
		t.Fatal(err)
	}
	var err error
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(ctx, run.ID, core.StageCollect, 0, "thread-replay", "")
	if err != nil {
		t.Fatal(err)
	}
	arguments := map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID,
		"naca": "0012", "reynolds": 1_000_000, "mach": 0.1,
		"alpha_start_deg": -2, "alpha_end_deg": 4, "alpha_step_deg": 1,
	}
	if jobStatus == "" {
		return engineeringReplayRouterFixture{database: database, run: run, attempt: attempt, arguments: arguments}
	}
	argumentBytes, err := json.Marshal(arguments)
	if err != nil {
		t.Fatal(err)
	}
	argumentDigest := sha256.Sum256(argumentBytes)
	argumentHash := hex.EncodeToString(argumentDigest[:])
	approval, err := database.CreateApproval(ctx, core.Approval{
		RunID: run.ID, StageAttemptID: attempt.ID,
		ThreadID: attempt.CodexThreadID, TurnID: "turn-original", ItemID: "solver-original",
		Kind: "item/mcpToolCall/requestApproval", Summary: "original XFOIL execution",
		Server: "aetherops_engineering", Tool: "xfoil_polar",
		ArgumentsJSON: string(argumentBytes), ArgumentsSHA256: argumentHash,
		Risk: "external_side_effect", ExternalSideEffect: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.DecideApproval(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	specBytes, err := json.Marshal(map[string]any{
		"arguments": json.RawMessage(argumentBytes), "operation": "xfoil_polar",
		"runtime_bundle_hash": strings.Repeat("b", 64),
		"tool_component":      "xfoil", "tool_version": "6.99",
	})
	if err != nil {
		t.Fatal(err)
	}
	specDigest := sha256.Sum256(specBytes)
	job, execute, err := database.BeginEngineeringJob(ctx, store.EngineeringJob{
		ProjectID: run.ProjectID, RunID: run.ID, StageAttemptID: attempt.ID,
		Operation: "xfoil_polar", SpecJSON: string(specBytes),
		SpecSHA256: hex.EncodeToString(specDigest[:]), ToolComponent: "xfoil",
		ToolVersion: "6.99", ApprovalScopeHash: argumentHash,
	})
	if err != nil || !execute {
		t.Fatalf("begin replay fixture job: execute=%v err=%v", execute, err)
	}
	switch jobStatus {
	case "running":
	case "failed":
		if err := database.FailEngineeringJob(ctx, job.ID, errors.New("solver failed")); err != nil {
			t.Fatal(err)
		}
	case "succeeded":
		receipt := cas.Receipt{Hash: strings.Repeat("a", 64), Size: 1}
		artifact, err := database.PublishArtifact(
			ctx, run.ID, attempt.ID, "engineering.xfoil_polar.receipt", "application/json", receipt,
		)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := database.CompleteEngineeringJob(ctx, job.ID, artifact.ID, []store.EngineeringJobArtifact{{
			ArtifactID: artifact.ID, Role: "receipt", FileName: "execution-receipt.json",
			MediaType: "application/json", BlobHash: artifact.BlobHash,
		}}); err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatalf("unknown replay fixture status %q", jobStatus)
	}
	return engineeringReplayRouterFixture{database: database, run: run, attempt: attempt, arguments: arguments}
}

func TestEngineeringSolverApprovalOnlyAutoAcceptsExactSucceededReplay(t *testing.T) {
	for _, test := range []struct {
		name          string
		jobStatus     string
		changeArgs    bool
		wantAutoReply bool
	}{
		{name: "new", jobStatus: ""},
		{name: "running", jobStatus: "running"},
		{name: "failed", jobStatus: "failed"},
		{name: "different arguments", jobStatus: "succeeded", changeArgs: true},
		{name: "exact succeeded replay", jobStatus: "succeeded", wantAutoReply: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			value := newEngineeringReplayRouterFixture(t, test.jobStatus)
			arguments := make(map[string]any, len(value.arguments))
			for key, item := range value.arguments {
				arguments[key] = item
			}
			if test.changeArgs {
				arguments["alpha_end_deg"] = 5
			}
			var approvalsBefore, jobsBefore int
			if err := value.database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM approvals").Scan(&approvalsBefore); err != nil {
				t.Fatal(err)
			}
			if err := value.database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM engineering_jobs").Scan(&jobsBefore); err != nil {
				t.Fatal(err)
			}
			client := &protocolFixture{}
			router := &Router{DB: value.database, Client: client, pending: make(map[string]pendingApproval)}
			event := approvalEvent("item/mcpToolCall/requestApproval", map[string]any{
				"threadId": value.attempt.CodexThreadID, "turnId": "turn-replay", "itemId": "solver-replay",
				"serverName": "aetherops_engineering", "toolName": "xfoil_polar",
				"arguments": arguments, "reason": "run exact XFOIL scope",
			})
			if err := router.handle(ctx, event); err != nil {
				t.Fatal(err)
			}
			pending, err := value.database.ListPendingApprovals(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var approvalsAfter, jobsAfter int
			if err := value.database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM approvals").Scan(&approvalsAfter); err != nil {
				t.Fatal(err)
			}
			if err := value.database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM engineering_jobs").Scan(&jobsAfter); err != nil {
				t.Fatal(err)
			}
			if jobsAfter != jobsBefore {
				t.Fatalf("approval routing changed engineering jobs: before=%d after=%d", jobsBefore, jobsAfter)
			}
			if test.wantAutoReply {
				if len(client.responses) != 1 || client.responses[0].decision != "accept" {
					t.Fatalf("completed replay response = %+v", client.responses)
				}
				if len(pending) != 0 || approvalsAfter != approvalsBefore {
					t.Fatalf("completed replay created approval: pending=%+v before=%d after=%d", pending, approvalsBefore, approvalsAfter)
				}
				return
			}
			if len(client.responses) != 0 || len(pending) != 1 || approvalsAfter != approvalsBefore+1 {
				t.Fatalf("non-completed scope bypassed UI: responses=%+v pending=%+v before=%d after=%d",
					client.responses, pending, approvalsBefore, approvalsAfter)
			}
		})
	}
}

func TestExactEngineeringReplayResponseFailureIsNotFollowedByDecline(t *testing.T) {
	ctx := context.Background()
	value := newEngineeringReplayRouterFixture(t, "succeeded")
	responseFailure := errors.New("fixture replay accept response failed")
	client := &protocolFixture{events: make(chan codex.Event, 1), err: responseFailure}
	router := &Router{DB: value.database, Client: client, pending: make(map[string]pendingApproval)}
	client.events <- approvalEvent("item/mcpToolCall/requestApproval", map[string]any{
		"threadId": value.attempt.CodexThreadID, "turnId": "turn-replay", "itemId": "solver-replay",
		"serverName": "aetherops_engineering", "toolName": "xfoil_polar",
		"arguments": value.arguments, "reason": "reuse exact completed XFOIL scope",
	})
	close(client.events)
	err := router.Run(ctx)
	if !errors.Is(err, responseFailure) {
		t.Fatalf("replay response error = %v, want %v", err, responseFailure)
	}
	var attempted *responseAttemptedError
	if !errors.As(err, &attempted) || attempted.decision != "accept" {
		t.Fatalf("replay response error was not marked attempted: %T %v", err, err)
	}
	if len(client.responses) != 1 || client.responses[0].decision != "accept" {
		t.Fatalf("replay received contradictory responses: %+v", client.responses)
	}
	stored, err := value.database.Run(ctx, value.run.ID)
	if err != nil || stored.Status != core.RunCollecting {
		t.Fatalf("read-only replay response changed run to %s, err=%v", stored.Status, err)
	}
}

func TestEquivalentXFOILScreeningAcrossCollectorsIsAutomaticallyDeclined(t *testing.T) {
	ctx := context.Background()
	database, run, planAttempt := activeRun(t)
	if err := database.CompleteStage(ctx, planAttempt.ID, "", ""); err != nil {
		t.Fatal(err)
	}
	var err error
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	first, err := database.BeginStage(ctx, run.ID, core.StageCollect, 0, "collector-screening-0", "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := database.BeginStage(ctx, run.ID, core.StageCollect, 1, "collector-screening-1", "")
	if err != nil {
		t.Fatal(err)
	}
	arguments := func(attempt core.StageAttempt) map[string]any {
		return map[string]any{
			"run_id": run.ID, "stage_attempt_id": attempt.ID,
			"execution_purpose": "screening", "naca": "0015", "reynolds": 1_000_000,
			"mach": 0.1, "flap_deflection_deg": 10,
			"optimization_objective": "minimize_cd_at_target_cl", "target_cl": 0.8,
			"minimum_cm": -0.2,
		}
	}
	client := &protocolFixture{events: make(chan codex.Event, 1)}
	router := &Router{DB: database, Client: client, pending: make(map[string]pendingApproval)}
	firstEvent := approvalEvent("item/mcpToolCall/requestApproval", map[string]any{
		"threadId": first.CodexThreadID, "turnId": "turn-screening-0", "itemId": "xfoil-screening-0",
		"serverName": "aetherops_engineering", "toolName": "xfoil_polar",
		"arguments": arguments(first), "reason": "screen candidate",
	})
	if err := router.handle(ctx, firstEvent); err != nil {
		t.Fatal(err)
	}
	client.events <- approvalEvent("item/mcpToolCall/requestApproval", map[string]any{
		"threadId": second.CodexThreadID, "turnId": "turn-screening-1", "itemId": "xfoil-screening-1",
		"serverName": "aetherops_engineering", "toolName": "xfoil_polar",
		"arguments": arguments(second), "reason": "duplicate candidate",
	})
	close(client.events)
	if err := router.Run(ctx); err == nil || !strings.Contains(err.Error(), "approval event stream closed") {
		t.Fatalf("router termination error = %v", err)
	}
	if len(client.responses) != 1 || client.responses[0].decision != "decline" {
		t.Fatalf("duplicate screening response = %+v", client.responses)
	}
	pending, err := database.ListPendingApprovals(ctx)
	if err != nil || len(pending) != 1 || pending[0].StageAttemptID != first.ID {
		t.Fatalf("duplicate screening changed pending approvals: %+v, %v", pending, err)
	}
	var approvalCount, jobCount int
	if err := database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM approvals").Scan(&approvalCount); err != nil {
		t.Fatal(err)
	}
	if err := database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM engineering_jobs").Scan(&jobCount); err != nil {
		t.Fatal(err)
	}
	if approvalCount != 1 || jobCount != 0 {
		t.Fatalf("duplicate screening crossed durable boundary: approvals=%d jobs=%d", approvalCount, jobCount)
	}
}

func TestEngineeringApprovalPersistsCanonicalExactScopeBeforeExecution(t *testing.T) {
	database, run, _ := activeRun(t)
	fixture := &protocolFixture{}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	arguments := map[string]any{
		"stage_attempt_id": "attempt-1",
		"run_id":           run.ID,
		"iterations":       80,
		"mach":             0.3,
	}
	event := approvalEvent("item/mcpToolCall/requestApproval", map[string]any{
		"threadId": "thread-1", "turnId": "turn-1", "itemId": "solver-1",
		"serverName": "aetherops_engineering", "toolName": "su2_naca0012",
		"arguments": arguments, "reason": "run typed SU2 analysis",
	})
	if err := router.handle(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	pending, err := database.ListPendingApprovals(context.Background())
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending engineering approval = %+v, err=%v", pending, err)
	}
	expectedJSON, err := json.Marshal(arguments)
	if err != nil {
		t.Fatal(err)
	}
	expectedDigest := sha256.Sum256(expectedJSON)
	expectedHash := hex.EncodeToString(expectedDigest[:])
	approval := pending[0]
	if approval.Server != "aetherops_engineering" || approval.Tool != "su2_naca0012" ||
		approval.ArgumentsJSON != string(expectedJSON) || approval.ArgumentsSHA256 != expectedHash ||
		approval.Risk != "external_side_effect" || !approval.ExternalSideEffect {
		t.Fatalf("approval scope was not exact: %+v, expected JSON=%s hash=%s", approval, expectedJSON, expectedHash)
	}
	attempts, err := database.ListStageAttempts(context.Background(), run.ID)
	if err != nil || len(attempts) != 1 || attempts[0].ExternalSideEffects {
		t.Fatalf("side-effect boundary was marked before user approval: %+v, err=%v", attempts, err)
	}
	if _, err := router.Decide(context.Background(), approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	attempts, err = database.ListStageAttempts(context.Background(), run.ID)
	if err != nil || len(attempts) != 1 || attempts[0].ExternalSideEffects {
		t.Fatalf("app-owned solver approval crossed the execution boundary before admission: %+v, err=%v", attempts, err)
	}
	if len(fixture.responses) != 1 || fixture.responses[0].decision != "accept" {
		t.Fatalf("Codex approval response = %+v", fixture.responses)
	}
	if recovered, err := database.RecoverInFlight(context.Background()); err != nil || recovered != 1 {
		t.Fatalf("recover approved solver without admission: count=%d err=%v", recovered, err)
	}
	run, err = database.Run(context.Background(), run.ID)
	if err != nil || run.Status != core.RunInterrupted {
		t.Fatalf("approved solver without a job recovered as %s, err=%v", run.Status, err)
	}
}

func TestEngineeringApprovalResponseFailureWithoutAdmissionRecoversInterrupted(t *testing.T) {
	ctx := context.Background()
	database, run, attempt := activeCollectRun(t)
	responseFailure := errors.New("fixture engineering approval response failed")
	fixture := &protocolFixture{err: responseFailure}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	arguments := map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID,
		"mach": 0.3, "alpha_deg": 2, "iterations": 80, "mesh_size_m": 0.05,
	}
	event := approvalEvent("item/mcpToolCall/requestApproval", map[string]any{
		"threadId": attempt.CodexThreadID, "turnId": "turn-solver-response-failure",
		"itemId": "solver-response-failure", "serverName": "aetherops_engineering",
		"toolName": "su2_naca0012", "arguments": arguments,
	})
	if err := router.handle(ctx, event); err != nil {
		t.Fatal(err)
	}
	pending, err := database.ListPendingApprovals(ctx)
	if err != nil || len(pending) != 1 || !pending[0].ExternalSideEffect {
		t.Fatalf("pending engineering approval = %+v, err=%v", pending, err)
	}
	if _, err := router.Decide(ctx, pending[0].ID, "approved"); !errors.Is(err, responseFailure) {
		t.Fatalf("engineering approval response error = %v, want %v", err, responseFailure)
	}
	var jobs int
	if err := database.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM engineering_jobs WHERE stage_attempt_id=?", attempt.ID,
	).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	var marked bool
	if err := database.SQL().QueryRowContext(ctx,
		"SELECT external_side_effects FROM stage_attempts WHERE id=?", attempt.ID,
	).Scan(&marked); err != nil {
		t.Fatal(err)
	}
	if marked || jobs != 0 {
		t.Fatalf("unknown response without admission crossed boundary: marker=%v jobs=%d", marked, jobs)
	}
	if recovered, err := database.RecoverInFlight(ctx); err != nil || recovered != 1 {
		t.Fatalf("recover response failure without admission: count=%d err=%v", recovered, err)
	}
	stored, err := database.Run(ctx, run.ID)
	if err != nil || stored.Status != core.RunInterrupted {
		t.Fatalf("response failure without admission recovered as %+v, err=%v", stored, err)
	}
}

func TestEngineeringApprovalResponseFailureAfterAdmissionRecoversUncertain(t *testing.T) {
	ctx := context.Background()
	database, run, attempt := activeCollectRun(t)
	responseFailure := errors.New("fixture engineering approval response outcome unknown")
	arguments := map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID,
		"mach": 0.3, "alpha_deg": 2, "iterations": 80, "mesh_size_m": 0.05,
	}
	argumentBytes, err := json.Marshal(arguments)
	if err != nil {
		t.Fatal(err)
	}
	argumentDigest := sha256.Sum256(argumentBytes)
	argumentHash := hex.EncodeToString(argumentDigest[:])
	specJSON := `{"arguments":` + string(argumentBytes) + `,"operation":"su2_naca0012","runtime_bundle_hash":"fixture","tool_component":"su2","tool_version":"1"}`
	specDigest := sha256.Sum256([]byte(specJSON))
	var admitted store.EngineeringJob
	fixture := &protocolFixture{err: responseFailure}
	fixture.beforeResponse = func() error {
		var execute bool
		var beginErr error
		admitted, execute, beginErr = database.BeginEngineeringJob(ctx, store.EngineeringJob{
			ProjectID: run.ProjectID, RunID: run.ID, StageAttemptID: attempt.ID,
			Operation: "su2_naca0012", SpecJSON: specJSON,
			SpecSHA256: hex.EncodeToString(specDigest[:]), ToolComponent: "su2",
			ToolVersion: "1", ApprovalScopeHash: argumentHash,
		})
		if beginErr != nil {
			return beginErr
		}
		if !execute {
			return errors.New("fixture engineering job was not admitted")
		}
		return nil
	}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	event := approvalEvent("item/mcpToolCall/requestApproval", map[string]any{
		"threadId": attempt.CodexThreadID, "turnId": "turn-admitted-response-failure",
		"itemId": "admitted-response-failure", "serverName": "aetherops_engineering",
		"toolName": "su2_naca0012", "arguments": arguments,
	})
	if err := router.handle(ctx, event); err != nil {
		t.Fatal(err)
	}
	pending, err := database.ListPendingApprovals(ctx)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending engineering approval = %+v, err=%v", pending, err)
	}
	if _, err := router.Decide(ctx, pending[0].ID, "approved"); !errors.Is(err, responseFailure) {
		t.Fatalf("admitted approval response error = %v, want %v", err, responseFailure)
	}
	var marked bool
	if err := database.SQL().QueryRowContext(ctx,
		"SELECT external_side_effects FROM stage_attempts WHERE id=?", attempt.ID,
	).Scan(&marked); err != nil {
		t.Fatal(err)
	}
	if !marked || admitted.Status != "running" {
		t.Fatalf("admission did not atomically retain the boundary: marker=%v job=%+v", marked, admitted)
	}
	if recovered, err := database.RecoverInFlight(ctx); err != nil || recovered != 1 {
		t.Fatalf("recover admitted response failure: count=%d err=%v", recovered, err)
	}
	storedRun, err := database.Run(ctx, run.ID)
	if err != nil || storedRun.Status != core.RunUncertain {
		t.Fatalf("admitted response failure recovered as %+v, err=%v", storedRun, err)
	}
	storedJob, err := database.EngineeringJob(ctx, admitted.ID)
	if err != nil || storedJob.Status != "uncertain" {
		t.Fatalf("admitted job recovery = %+v, err=%v", storedJob, err)
	}
}

func TestEngineeringAutomaticPolicyUsesExactServerAndToolScope(t *testing.T) {
	for _, method := range []string{"item/mcpToolCall/requestApproval", "mcpServer/elicitation/request"} {
		for _, tool := range []string{"engineering_capabilities", "engineering_get"} {
			allowed, external := automaticPolicy(method, approvalRequest{
				Server: "aetherops_engineering", Tool: tool,
			})
			if !allowed || external {
				t.Fatalf("%s exact read-only %s policy = allowed %v external %v", method, tool, allowed, external)
			}
		}
		allowed, external := false, false
		for _, request := range []approvalRequest{
			{Server: "aetherops_engineering_evil", Tool: "engineering_capabilities"},
			{Server: "aetherops_engineering", Tool: "engineering_capabilities_evil"},
			{Server: "aetherops_internal", Tool: "engineering_capabilities"},
		} {
			allowed, external = automaticPolicy(method, request)
			if allowed || !external {
				t.Fatalf("%s spoofed capability scope was auto-approved: %+v", method, request)
			}
		}
		allowed, external = automaticPolicy(method, approvalRequest{
			Server: "aetherops_engineering", Tool: "su2_naca0012",
		})
		if allowed || !external {
			t.Fatalf("%s solver execution policy = allowed %v external %v", method, allowed, external)
		}
	}
}

func TestStableMCPElicitationPersistsCanonicalEngineeringApprovalKind(t *testing.T) {
	database, run, _ := activeRun(t)
	fixture := &protocolFixture{}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	arguments := map[string]any{
		"run_id": run.ID, "stage_attempt_id": "attempt-1", "reynolds": 1_000_000,
	}
	event := approvalEvent("mcpServer/elicitation/request", map[string]any{
		"threadId": "thread-1", "turnId": "turn-1", "itemId": "solver-elicitation-1",
		"serverName": "aetherops_engineering", "toolName": "xfoil_polar",
		"arguments": arguments, "message": "Allow the exact XFOIL polar run?",
	})
	if err := router.handle(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	pending, err := database.ListPendingApprovals(context.Background())
	if err != nil || len(pending) != 1 {
		t.Fatalf("stable MCP elicitation approval = %+v, err=%v", pending, err)
	}
	if pending[0].Kind != "item/mcpToolCall/requestApproval" ||
		pending[0].Server != "aetherops_engineering" || pending[0].Tool != "xfoil_polar" ||
		pending[0].Summary != "Allow the exact XFOIL polar run?" {
		t.Fatalf("elicitation was not normalized to the durable approval contract: %+v", pending[0])
	}
}

func TestKnowledgeReadToolsAreAutomaticOnlyOnExactInternalServer(t *testing.T) {
	method := "item/mcpToolCall/requestApproval"
	for _, tool := range []string{"knowledge_sparql", "knowledge_get"} {
		allowed, external := automaticPolicy(method, approvalRequest{
			Server: "aetherops_internal", Tool: tool,
		})
		if !allowed || external {
			t.Fatalf("internal %s policy = allowed %v external %v", tool, allowed, external)
		}
		for _, server := range []string{"external", "aetherops_internal_evil", ""} {
			allowed, external = automaticPolicy(method, approvalRequest{Server: server, Tool: tool})
			if allowed || !external {
				t.Fatalf("%s on spoofed server %q was auto-approved", tool, server)
			}
		}
	}
}

func TestEngineeringVerificationApprovalAllowlistIsServerEnforced(t *testing.T) {
	ctx := context.Background()
	database, run, planAttempt := activeRun(t)
	if err := database.CompleteStage(ctx, planAttempt.ID, "", ""); err != nil {
		t.Fatal(err)
	}
	var err error
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	verification, err := database.BeginStage(ctx, run.ID, core.StageCollect, core.EngineeringVerificationOrdinal, "thread-verification", "")
	if err != nil {
		t.Fatal(err)
	}
	fixture := &protocolFixture{}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}

	event := func(server, tool string, arguments map[string]any) codex.Event {
		return approvalEvent("item/mcpToolCall/requestApproval", map[string]any{
			"threadId": "thread-verification", "turnId": "turn-verification", "itemId": tool,
			"serverName": server, "toolName": tool, "arguments": arguments,
		})
	}
	identity := map[string]any{"run_id": run.ID, "stage_attempt_id": verification.ID}
	if err := router.handle(ctx, event("chrome_devtools", "navigate_page", identity)); err == nil {
		t.Fatal("verification attempt accepted a browser approval")
	}
	if err := router.handle(ctx, event("aetherops_engineering", "gmsh_wing_mesh", identity)); err == nil {
		t.Fatal("verification attempt accepted another solver")
	}
	wrongXFOIL := map[string]any{"run_id": run.ID, "stage_attempt_id": verification.ID, "execution_purpose": "screening"}
	if err := router.handle(ctx, event("aetherops_engineering", "xfoil_polar", wrongXFOIL)); err == nil {
		t.Fatal("verification attempt accepted a non-independent XFOIL approval")
	}
	getArguments := map[string]any{"run_id": run.ID, "stage_attempt_id": verification.ID, "job_id": "job-screening"}
	if err := router.handle(ctx, event("aetherops_engineering", "engineering_get", getArguments)); err != nil {
		t.Fatal(err)
	}
	if len(fixture.responses) != 1 || fixture.responses[0].decision != "accept" {
		t.Fatalf("engineering_get response = %+v", fixture.responses)
	}
	verificationArguments := map[string]any{
		"run_id": run.ID, "stage_attempt_id": verification.ID,
		"execution_purpose": "independent_verification", "verification_of_job_id": "job-screening",
	}
	if err := router.handle(ctx, event("aetherops_engineering", "xfoil_polar", verificationArguments)); err != nil {
		t.Fatal(err)
	}
	pending, err := database.ListPendingApprovals(ctx)
	if err != nil || len(pending) != 1 || pending[0].Tool != "xfoil_polar" {
		t.Fatalf("verification approval = %+v, err=%v", pending, err)
	}
}
