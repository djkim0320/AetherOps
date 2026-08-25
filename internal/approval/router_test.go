package approval

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/codex"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/dispatch"
	"github.com/djkim0320/AetherOps/internal/store"
)

type responseRecord struct {
	event    codex.Event
	decision string
}

type protocolFixture struct {
	events         chan codex.Event
	responses      []responseRecord
	err            error
	beforeResponse func() error
}

func (fixture *protocolFixture) Events() <-chan codex.Event { return fixture.events }

func (fixture *protocolFixture) RespondApproval(_ context.Context, event codex.Event, decision string) error {
	if fixture.beforeResponse != nil {
		if err := fixture.beforeResponse(); err != nil {
			return err
		}
	}
	fixture.responses = append(fixture.responses, responseRecord{event: event, decision: decision})
	return fixture.err
}

func activeRun(t *testing.T) (*store.DB, core.Run, core.StageAttempt) {
	t.Helper()
	ctx := context.Background()
	database, err := store.Open(ctx, filepath.Join(t.TempDir(), "approval.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	project, err := database.CreateProject(ctx, "approval")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "question", "thread-1")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(ctx, run.ID, core.StagePlan, 0, "thread-1", "")
	if err != nil {
		t.Fatal(err)
	}
	return database, run, attempt
}

func activeCollectRun(t *testing.T) (*store.DB, core.Run, core.StageAttempt) {
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
	attempt, err := database.BeginStage(ctx, run.ID, core.StageCollect, 0, "collector-thread", "")
	if err != nil {
		t.Fatal(err)
	}
	return database, run, attempt
}

func TestReadOnlyCommandIsAutomaticallyAllowed(t *testing.T) {
	database, _, _ := activeRun(t)
	fixture := &protocolFixture{}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	event := approvalEvent("item/commandExecution/requestApproval", map[string]any{
		"threadId": "thread-1", "turnId": "turn-1", "itemId": "item-1",
		"command": "rg --files internal", "reason": "list source files",
	})
	if err := router.handle(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	if len(fixture.responses) != 1 || fixture.responses[0].decision != "accept" {
		t.Fatalf("automatic response: %+v", fixture.responses)
	}
	approvals, err := database.ListPendingApprovals(context.Background())
	if err != nil || len(approvals) != 0 {
		t.Fatalf("read-only command created UI approval: %+v, %v", approvals, err)
	}
}

func TestCollectRejectsNetworkDownloadShellCommandsWithoutUIApproval(t *testing.T) {
	commands := []string{
		`powershell.exe -NoProfile -Command Invoke-WebRequest https://example.test/source`,
		`pwsh -Command "iwr https://example.test/source -OutFile source.html"`,
		`curl.exe -L https://example.test/source`,
		`cmd.exe /c wget https://example.test/source`,
		`python -c "import requests; requests.get('https://example.test/source')"`,
	}
	for _, command := range commands {
		t.Run(command, func(t *testing.T) {
			database, _, _ := activeCollectRun(t)
			fixture := &protocolFixture{}
			router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
			event := approvalEvent("item/commandExecution/requestApproval", map[string]any{
				"threadId": "collector-thread", "turnId": "turn-collect", "itemId": "item-download",
				"command": command, "reason": "download public evidence",
			})
			err := router.handle(context.Background(), event)
			if err == nil || !strings.Contains(err.Error(), "COLLECT rejects network download") {
				t.Fatalf("download command error = %v", err)
			}
			if pending, listErr := database.ListPendingApprovals(context.Background()); listErr != nil || len(pending) != 0 {
				t.Fatalf("blocked download command created an approval: %+v, %v", pending, listErr)
			}
			if len(fixture.responses) != 0 {
				t.Fatalf("direct handler crossed the response boundary: %+v", fixture.responses)
			}
		})
	}
}

func TestCollectNetworkDownloadRequestIsExplicitlyDeclinedByRouter(t *testing.T) {
	database, _, _ := activeCollectRun(t)
	fixture := &protocolFixture{events: make(chan codex.Event, 1)}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	fixture.events <- approvalEvent("item/commandExecution/requestApproval", map[string]any{
		"threadId": "collector-thread", "turnId": "turn-collect", "itemId": "item-download",
		"command": "powershell Invoke-WebRequest https://example.test/source", "reason": "download evidence",
	})
	close(fixture.events)
	err := router.Run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "approval event stream closed") {
		t.Fatalf("router termination error = %v", err)
	}
	if len(fixture.responses) != 1 || fixture.responses[0].decision != "decline" {
		t.Fatalf("blocked COLLECT download response = %+v", fixture.responses)
	}
	if pending, listErr := database.ListPendingApprovals(context.Background()); listErr != nil || len(pending) != 0 {
		t.Fatalf("declined COLLECT download created UI approval: %+v, %v", pending, listErr)
	}
}

func TestNetworkDownloadCommandOutsideCollectStillWaitsForUserApproval(t *testing.T) {
	database, _, _ := activeRun(t)
	fixture := &protocolFixture{}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	event := approvalEvent("item/commandExecution/requestApproval", map[string]any{
		"threadId": "thread-1", "turnId": "turn-1", "itemId": "item-1",
		"command": "powershell Invoke-WebRequest https://example.test/source", "reason": "user-requested download",
	})
	if err := router.handle(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	pending, err := database.ListPendingApprovals(context.Background())
	if err != nil || len(pending) != 1 {
		t.Fatalf("non-COLLECT command did not retain normal approval flow: %+v, %v", pending, err)
	}
}

func TestCollectStillRoutesTypedEngineeringSolverToUserApproval(t *testing.T) {
	database, run, attempt := activeCollectRun(t)
	fixture := &protocolFixture{}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	event := approvalEvent("item/mcpToolCall/requestApproval", map[string]any{
		"threadId": "collector-thread", "turnId": "turn-collect", "itemId": "item-xfoil",
		"serverName": "aetherops_engineering", "toolName": "xfoil_polar",
		"arguments": map[string]any{"run_id": run.ID, "stage_attempt_id": attempt.ID, "naca": "0015"},
	})
	if err := router.handle(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	pending, err := database.ListPendingApprovals(context.Background())
	if err != nil || len(pending) != 1 || pending[0].Tool != "xfoil_polar" {
		t.Fatalf("typed solver did not retain approval flow: %+v, %v", pending, err)
	}
}

func TestFileWriteWaitsForUIAndResumesOriginalStage(t *testing.T) {
	database, run, _ := activeRun(t)
	fixture := &protocolFixture{}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	event := approvalEvent("item/fileChange/requestApproval", map[string]any{
		"threadId": "thread-1", "turnId": "turn-1", "itemId": "item-1",
		"reason": "write outside AetherOps CAS",
	})
	if err := router.handle(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	pending, err := database.ListPendingApprovals(context.Background())
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending approvals: %+v, %v", pending, err)
	}
	run, err = database.Run(context.Background(), run.ID)
	if err != nil || run.Status != core.RunWaitingApproval {
		t.Fatalf("run status = %s, %v", run.Status, err)
	}
	approval, err := router.Decide(context.Background(), pending[0].ID, "approved")
	if err != nil {
		t.Fatal(err)
	}
	if approval.Status != "approved" || len(fixture.responses) != 1 || fixture.responses[0].decision != "accept" {
		t.Fatalf("decision result: %+v, responses=%+v", approval, fixture.responses)
	}
	run, err = database.Run(context.Background(), run.ID)
	if err != nil || run.Status != core.RunPlanning {
		t.Fatalf("run did not resume planning: %s, %v", run.Status, err)
	}
}

func TestDecisionRestoresRunBeforeResponseCanCompleteStage(t *testing.T) {
	ctx := context.Background()
	database, run, attempt := activeRun(t)
	fixture := &protocolFixture{}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	event := approvalEvent("item/fileChange/requestApproval", map[string]any{
		"threadId": "thread-1", "turnId": "turn-1", "itemId": "item-race",
		"reason": "exercise approval response ordering",
	})
	if err := router.handle(ctx, event); err != nil {
		t.Fatal(err)
	}
	pending, err := database.ListPendingApprovals(ctx)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending approvals: %+v, %v", pending, err)
	}
	fixture.beforeResponse = func() error {
		observed, err := database.Run(ctx, run.ID)
		if err != nil {
			return err
		}
		if observed.Status != core.RunPlanning {
			return fmt.Errorf("Codex response observed run in %s, want planning", observed.Status)
		}
		// A real App Server response may unblock the turn and complete its stage
		// before RespondApproval returns to Router.Decide.
		return database.CompleteStage(ctx, attempt.ID, "", "")
	}
	if _, err := router.Decide(ctx, pending[0].ID, "approved"); err != nil {
		t.Fatal(err)
	}
	stored, err := database.Run(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != core.RunPlanning {
		t.Fatalf("response-completion race left run in %s, want planning", stored.Status)
	}
	if len(fixture.responses) != 1 || fixture.responses[0].decision != "accept" {
		t.Fatalf("Codex response = %+v", fixture.responses)
	}
}

func TestApprovalResponseFailureAfterResumeFailsClosedUncertain(t *testing.T) {
	ctx := context.Background()
	database, run, _ := activeRun(t)
	responseFailure := errors.New("fixture approval response failed")
	fixture := &protocolFixture{err: responseFailure}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	event := approvalEvent("item/fileChange/requestApproval", map[string]any{
		"threadId": "thread-1", "turnId": "turn-1", "itemId": "item-response-failure",
		"reason": "write outside AetherOps CAS",
	})
	if err := router.handle(ctx, event); err != nil {
		t.Fatal(err)
	}
	pending, err := database.ListPendingApprovals(ctx)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending approvals: %+v, %v", pending, err)
	}
	if _, err := router.Decide(ctx, pending[0].ID, "approved"); !errors.Is(err, responseFailure) {
		t.Fatalf("approval response error = %v, want %v", err, responseFailure)
	}
	stored, err := database.Run(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != core.RunUncertain {
		t.Fatalf("failed approval response left run in %s, want uncertain", stored.Status)
	}
	attempts, err := database.ListStageAttempts(ctx, run.ID)
	if err != nil || len(attempts) != 1 || !attempts[0].ExternalSideEffects {
		t.Fatalf("approved external boundary was not retained: %+v, %v", attempts, err)
	}
}

func TestAutomaticChromeExternalActionRejectsTerminalRunBeforeAccept(t *testing.T) {
	for _, terminal := range []core.RunStatus{core.RunFailed, core.RunCancelled} {
		t.Run(string(terminal), func(t *testing.T) {
			ctx := context.Background()
			database, run, attempt := activeRun(t)
			var err error
			run, err = database.TransitionRun(ctx, run.ID, run.Revision, terminal, "fixture terminal")
			if err != nil {
				t.Fatal(err)
			}
			fixture := &protocolFixture{}
			router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
			event := approvalEvent("item/mcpToolCall/requestApproval", map[string]any{
				"threadId": "thread-1", "turnId": "turn-terminal", "itemId": "chrome-click",
				"serverName": "chrome_devtools", "toolName": "click",
				"arguments": map[string]any{"uid": "target"},
			})
			if err := router.handle(ctx, event); !errors.Is(err, store.ErrApprovalNotActive) {
				t.Fatalf("terminal automatic approval error = %v, want %v", err, store.ErrApprovalNotActive)
			}
			if len(fixture.responses) != 0 {
				t.Fatalf("terminal run received Codex response: %+v", fixture.responses)
			}
			attempts, err := database.ListStageAttempts(ctx, run.ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(attempts) != 1 || attempts[0].ID != attempt.ID || attempts[0].ExternalSideEffects {
				t.Fatalf("terminal automatic request crossed durable boundary: %+v", attempts)
			}
			stored, err := database.Run(ctx, run.ID)
			if err != nil || stored.Status != terminal {
				t.Fatalf("terminal state changed to %s, err=%v", stored.Status, err)
			}
		})
	}
}

func TestAutomaticChromeMarkerMakesCollectorFailureUncertain(t *testing.T) {
	ctx := context.Background()
	database, run, attempt := activeCollectRun(t)
	fixture := &protocolFixture{}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	event := approvalEvent("item/mcpToolCall/requestApproval", map[string]any{
		"threadId": attempt.CodexThreadID, "turnId": "turn-chrome", "itemId": "chrome-submit",
		"serverName": "chrome_devtools", "toolName": "click",
		"arguments": map[string]any{"uid": "submit"},
	})
	if err := router.handle(ctx, event); err != nil {
		t.Fatal(err)
	}
	if len(fixture.responses) != 1 || fixture.responses[0].decision != "accept" {
		t.Fatalf("automatic Chrome response = %+v", fixture.responses)
	}
	quiesced, err := database.FailCollectStageAndQuiesceRun(
		ctx, attempt.ID, "", "collector failed after Chrome action release",
	)
	if err != nil {
		t.Fatal(err)
	}
	if quiesced.ID != run.ID || quiesced.Status != core.RunUncertain {
		t.Fatalf("external collector failure = %+v, want uncertain", quiesced)
	}
	attempts, err := database.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var retained bool
	for _, storedAttempt := range attempts {
		if storedAttempt.ID == attempt.ID {
			retained = storedAttempt.ExternalSideEffects && storedAttempt.Status == "failed"
		}
	}
	if !retained {
		t.Fatalf("external boundary was not retained on failure: %+v", attempts)
	}
}

func TestAutomaticChromeAcceptRacingUserCancelFinishesUncertain(t *testing.T) {
	ctx := context.Background()
	database, run, attempt := activeRun(t)
	dispatcher := &dispatch.Dispatcher{DB: database}
	fixture := &protocolFixture{
		beforeResponse: func() error {
			cancelled, err := dispatcher.CancelRun(ctx, run.ID)
			if err != nil {
				return err
			}
			if cancelled.Status != core.RunUncertain {
				return fmt.Errorf("racing cancellation ended as %s, want uncertain", cancelled.Status)
			}
			return nil
		},
	}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	event := approvalEvent("item/mcpToolCall/requestApproval", map[string]any{
		"threadId": attempt.CodexThreadID, "turnId": "turn-race", "itemId": "chrome-submit",
		"serverName": "chrome_devtools", "toolName": "click",
		"arguments": map[string]any{"uid": "submit"},
	})
	if err := router.handle(ctx, event); err != nil {
		t.Fatal(err)
	}
	if len(fixture.responses) != 1 || fixture.responses[0].decision != "accept" {
		t.Fatalf("racing Chrome response = %+v", fixture.responses)
	}
	stored, err := database.Run(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != core.RunUncertain || stored.Error != "cancelled by user" {
		t.Fatalf("accept and cancellation coexisted without uncertainty: %+v", stored)
	}
}

func TestUserCancelBeforeAutomaticChromeRequestSendsOnlyDecline(t *testing.T) {
	ctx := context.Background()
	database, run, attempt := activeRun(t)
	dispatcher := &dispatch.Dispatcher{DB: database}
	cancelled, err := dispatcher.CancelRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cancelled.Status != core.RunCancelled {
		t.Fatalf("pre-authorization cancellation = %+v", cancelled)
	}
	fixture := &protocolFixture{events: make(chan codex.Event, 1)}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	fixture.events <- approvalEvent("item/mcpToolCall/requestApproval", map[string]any{
		"threadId": attempt.CodexThreadID, "turnId": "turn-late", "itemId": "chrome-submit",
		"serverName": "chrome_devtools", "toolName": "click",
		"arguments": map[string]any{"uid": "submit"},
	})
	close(fixture.events)
	if err := router.Run(ctx); err == nil || !strings.Contains(err.Error(), "approval event stream closed") {
		t.Fatalf("router termination error = %v", err)
	}
	if len(fixture.responses) != 1 || fixture.responses[0].decision != "decline" {
		t.Fatalf("cancelled request responses = %+v", fixture.responses)
	}
	attempts, err := database.ListStageAttempts(ctx, run.ID)
	if err != nil || len(attempts) != 1 || attempts[0].ExternalSideEffects {
		t.Fatalf("cancel-first request crossed marker boundary: %+v, %v", attempts, err)
	}
}

func TestAutomaticChromeResponseFailureDoesNotSendDeclineAndSurvivesCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	database, run, attempt := activeRun(t)
	responseFailure := errors.New("fixture automatic accept response failed")
	fixture := &protocolFixture{
		events: make(chan codex.Event, 1),
		err:    responseFailure,
		beforeResponse: func() error {
			cancel()
			return nil
		},
	}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	fixture.events <- approvalEvent("item/mcpToolCall/requestApproval", map[string]any{
		"threadId": attempt.CodexThreadID, "turnId": "turn-chrome", "itemId": "chrome-submit",
		"serverName": "chrome_devtools", "toolName": "click",
		"arguments": map[string]any{"uid": "submit"},
	})
	close(fixture.events)
	err := router.Run(ctx)
	if !errors.Is(err, responseFailure) {
		t.Fatalf("automatic response error = %v, want %v", err, responseFailure)
	}
	var attempted *responseAttemptedError
	if !errors.As(err, &attempted) || attempted.decision != "accept" {
		t.Fatalf("automatic response error was not marked attempted: %T %v", err, err)
	}
	if len(fixture.responses) != 1 || fixture.responses[0].decision != "accept" {
		t.Fatalf("router sent a contradictory response: %+v", fixture.responses)
	}
	stored, err := database.Run(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != core.RunUncertain || !strings.Contains(stored.Error, responseFailure.Error()) {
		t.Fatalf("cancelled response failure was not durably uncertain: %+v", stored)
	}
}

func TestMarkUncertainCASRetriesRevisionRaceAndPreservesTerminalWinner(t *testing.T) {
	cause := errors.New("approval response outcome unknown")
	t.Run("revision retry", func(t *testing.T) {
		state := core.Run{ID: "run-race", Status: core.RunPlanning, Revision: 1}
		transitionCalls := 0
		load := func(context.Context, string) (core.Run, error) { return state, nil }
		transition := func(
			_ context.Context, runID string, revision int64, next core.RunStatus, message string,
		) (core.Run, error) {
			transitionCalls++
			if runID != state.ID || next != core.RunUncertain || message != cause.Error() {
				t.Fatalf("unexpected uncertainty transition: id=%s next=%s message=%q", runID, next, message)
			}
			if transitionCalls == 1 {
				if revision != 1 {
					t.Fatalf("first revision = %d, want 1", revision)
				}
				state.Status = core.RunWaitingApproval
				state.Revision = 2
				return core.Run{}, errors.New("run revision conflict")
			}
			if revision != 2 {
				t.Fatalf("retried revision = %d, want 2", revision)
			}
			state.Status = core.RunUncertain
			state.Revision = 3
			state.Error = message
			return state, nil
		}
		if err := markUncertainCAS(context.Background(), state.ID, cause, load, transition); err != nil {
			t.Fatal(err)
		}
		if transitionCalls != 2 || state.Status != core.RunUncertain || state.Revision != 3 {
			t.Fatalf("revision race result: calls=%d state=%+v", transitionCalls, state)
		}
	})

	t.Run("terminal winner", func(t *testing.T) {
		state := core.Run{ID: "run-terminal-race", Status: core.RunPlanning, Revision: 1}
		transitionCalls := 0
		load := func(context.Context, string) (core.Run, error) { return state, nil }
		transition := func(
			_ context.Context, _ string, _ int64, _ core.RunStatus, _ string,
		) (core.Run, error) {
			transitionCalls++
			state.Status = core.RunFailed
			state.Revision = 2
			state.Error = "authoritative failure"
			return core.Run{}, errors.New("run revision conflict")
		}
		if err := markUncertainCAS(context.Background(), state.ID, cause, load, transition); err != nil {
			t.Fatal(err)
		}
		if transitionCalls != 1 || state.Status != core.RunFailed || state.Error != "authoritative failure" {
			t.Fatalf("terminal winner was overwritten: calls=%d state=%+v", transitionCalls, state)
		}
	})
}

func TestUnknownExternalMCPIsNotAutomaticallyAllowed(t *testing.T) {
	database, _, _ := activeRun(t)
	fixture := &protocolFixture{}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	event := approvalEvent("item/mcpToolCall/requestApproval", map[string]any{
		"threadId": "thread-1", "turnId": "turn-1", "itemId": "item-1",
		"serverName": "unclassified-external", "toolName": "do_something",
	})
	if err := router.handle(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	if len(fixture.responses) != 0 {
		t.Fatal("unknown external MCP was automatically approved")
	}
	pending, err := database.ListPendingApprovals(context.Background())
	if err != nil || len(pending) != 1 {
		t.Fatalf("unknown MCP did not create UI approval: %+v, %v", pending, err)
	}
}

func TestScholarlySearchMCPIsAutomaticallyAllowedWithoutSideEffectMarker(t *testing.T) {
	allowed, external := automaticPolicy("item/mcpToolCall/requestApproval", approvalRequest{
		Server: "aetherops_internal",
		Tool:   "scholarly_search",
	})
	if !allowed || external {
		t.Fatalf("scholarly_search policy = allowed %v, external %v", allowed, external)
	}
}

func TestManagedInternalToolCatalogIsAutomaticButExecutionRequiresApproval(t *testing.T) {
	allowed, external := automaticPolicy("item/mcpToolCall/requestApproval", approvalRequest{Server: "aetherops_internal", Tool: "tool_catalog"})
	if !allowed || external {
		t.Fatalf("tool_catalog policy = allowed %v, external %v", allowed, external)
	}
	allowed, external = automaticPolicy("item/mcpToolCall/requestApproval", approvalRequest{Server: "aetherops_internal", Tool: "tool_run"})
	if allowed || !external {
		t.Fatalf("tool_run policy = allowed %v, external %v", allowed, external)
	}
}

func TestTerminalCollectorFailureRejectsStaleApprovalWithoutRevivingRun(t *testing.T) {
	ctx := context.Background()
	database, run, attempt := activeRun(t)
	fixture := &protocolFixture{}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	event := approvalEvent("item/commandExecution/requestApproval", map[string]any{
		"threadId": "thread-1", "turnId": "turn-1", "itemId": "item-1",
		"command": "powershell -Command Invoke-WebRequest https://example.com/data",
		"reason":  "download evidence bytes",
	})
	if err := router.handle(ctx, event); err != nil {
		t.Fatal(err)
	}
	pending, err := database.ListPendingApprovals(ctx)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending approvals = %+v, %v", pending, err)
	}
	if err := database.CompleteStage(ctx, attempt.ID, "", "collector validation failed"); err != nil {
		t.Fatal(err)
	}
	run, err = database.Run(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunFailed, "collector validation failed")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := router.Decide(ctx, pending[0].ID, "approved"); !errors.Is(err, store.ErrApprovalNotActive) {
		t.Fatalf("stale approval decision error = %v, want %v", err, store.ErrApprovalNotActive)
	}
	if len(fixture.responses) != 0 {
		t.Fatalf("stale side-effect command was retransmitted to Codex: %+v", fixture.responses)
	}
	stored, err := database.Run(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != core.RunFailed {
		t.Fatalf("stale approval revived terminal run as %s", stored.Status)
	}
	if remaining, err := database.ListPendingApprovals(ctx); err != nil || len(remaining) != 0 {
		t.Fatalf("terminal run retained pending approvals: %+v, %v", remaining, err)
	}
}

func TestCollectorFailureRetirementBeatsLateExternalApprovalDecision(t *testing.T) {
	ctx := context.Background()
	database, run, attempt := activeRun(t)
	fixture := &protocolFixture{}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	event := approvalEvent("item/commandExecution/requestApproval", map[string]any{
		"threadId": "thread-1", "turnId": "turn-1", "itemId": "item-1",
		"command": "powershell -Command Invoke-WebRequest https://example.com/data",
		"reason":  "download evidence bytes",
	})
	if err := router.handle(ctx, event); err != nil {
		t.Fatal(err)
	}
	pending, err := database.ListPendingApprovals(ctx)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending approvals = %+v, %v", pending, err)
	}
	run, err = database.Run(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	// A sibling collector's non-context failure closes the run while the
	// approval-owning attempt is still unwinding from context cancellation.
	if _, err := database.TransitionRun(ctx, run.ID, run.Revision, core.RunFailed, "collector validation failed"); err != nil {
		t.Fatal(err)
	}
	if _, err := router.Decide(ctx, pending[0].ID, "approved"); !errors.Is(err, store.ErrApprovalNotActive) {
		t.Fatalf("late approval decision error = %v, want %v", err, store.ErrApprovalNotActive)
	}
	if len(fixture.responses) != 0 {
		t.Fatalf("late approval was sent to Codex: %+v", fixture.responses)
	}
	attempts, err := database.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 1 || attempts[0].ID != attempt.ID || attempts[0].ExternalSideEffects {
		t.Fatalf("late approval crossed the external side-effect boundary: %+v", attempts)
	}
}

func TestFailedCollectorBlocksApprovalBeforeRunTerminalTransition(t *testing.T) {
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
	approvalOwner, err := database.BeginStage(ctx, run.ID, core.StageCollect, 0, "collector-owner", "")
	if err != nil {
		t.Fatal(err)
	}
	failedCollector, err := database.BeginStage(ctx, run.ID, core.StageCollect, 1, "collector-failed", "")
	if err != nil {
		t.Fatal(err)
	}
	fixture := &protocolFixture{}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	event := approvalEvent("item/commandExecution/requestApproval", map[string]any{
		"threadId": "collector-owner", "turnId": "turn-owner", "itemId": "item-owner",
		"command": "powershell -Command Set-Content outside.txt data",
		"reason":  "write outside AetherOps CAS",
	})
	if err := router.handle(ctx, event); err != nil {
		t.Fatal(err)
	}
	pending, err := database.ListPendingApprovals(ctx)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending approvals = %+v, %v", pending, err)
	}
	// Reproduce the old pre-abort window: the validation failure is durable,
	// but the run has not yet reached its terminal transition.
	if err := database.CompleteStage(ctx, failedCollector.ID, "", "collector validation failed"); err != nil {
		t.Fatal(err)
	}
	if _, err := router.Decide(ctx, pending[0].ID, "approved"); !errors.Is(err, store.ErrApprovalNotActive) {
		t.Fatalf("approval over failed collector error = %v, want %v", err, store.ErrApprovalNotActive)
	}
	if len(fixture.responses) != 0 {
		t.Fatalf("approval over failed collector was sent to Codex: %+v", fixture.responses)
	}
	attempts, err := database.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, attempt := range attempts {
		if attempt.ID == approvalOwner.ID && attempt.ExternalSideEffects {
			t.Fatalf("approval over failed collector crossed side-effect boundary: %+v", attempt)
		}
	}
	pending, err = database.ListPendingApprovals(ctx)
	if err != nil || len(pending) != 0 {
		t.Fatalf("failed collector left an actionable approval: %+v, %v", pending, err)
	}
}

func TestRipgrepPreprocessorIsNotClassifiedReadOnly(t *testing.T) {
	if isStrictReadOnlyCommand("rg --pre malicious.exe needle .") {
		t.Fatal("ripgrep --pre command was classified as read-only")
	}
}

func TestChromeUploadIsRestrictedToConfiguredRoots(t *testing.T) {
	root := t.TempDir()
	allowed := filepath.Join(root, "project")
	if err := os.MkdirAll(allowed, 0o700); err != nil {
		t.Fatal(err)
	}
	inside := filepath.Join(allowed, "upload.txt")
	outside := filepath.Join(root, "outside.txt")
	if err := os.WriteFile(inside, []byte("inside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	router := &Router{AllowedUploadRoots: []string{allowed}}
	if err := router.validateUploadArguments(map[string]any{"filePath": inside}); err != nil {
		t.Fatalf("allowed upload was blocked: %v", err)
	}
	if err := router.validateUploadArguments(map[string]any{"filePath": outside}); err == nil {
		t.Fatal("upload outside configured roots was allowed")
	}
}

func TestPlanScopedXFOILMatrixAuthorizationIsExact(t *testing.T) {
	plan := core.ResearchPlan{
		Question: "XFOIL matrix", Mode: "engineering",
		Workstreams:        []core.Workstream{{ID: "solver", Question: "run XFOIL matrix", PreferredSourceKinds: []string{}, RequiredEvidence: []string{}}},
		SourceRequirements: []string{}, AcceptanceCriteria: []string{},
		XFOILScreening: &core.XFOILScreeningPlan{
			NACA: "0015", Reynolds: 200_000, Mach: .06,
			AlphaStartDeg: -4, AlphaEndDeg: 12, AlphaStepDeg: .25,
			FlapChordRatio: .2, FlapHingeXOverC: .8, FlapHingeYOverC: 0,
			CandidateDeflectionsDeg: []float64{-4, -2, 0, 2, 4}, NCrit: 9,
			Iterations: 200, PanelCount: 160, OptimizationObjective: "minimize_cd_at_target_cl",
			TargetCL: .25, MinimumCM: -.1,
			OperatingPoints: []core.XFOILOperatingPoint{
				{ID: "re200_cl025", Reynolds: 200_000, Mach: .06, NCrit: 9, TargetCL: .25, MinimumCM: -.1},
				{ID: "re350_cl040", Reynolds: 350_000, Mach: .06, NCrit: 9, TargetCL: .4, MinimumCM: -.1},
			},
		},
	}
	call := plannedXFOILApprovalArguments{
		RunID: "run_1", StageAttemptID: "stage_1", NACA: "0015", Reynolds: 350_000, Mach: .06,
		AlphaStartDeg: -4, AlphaEndDeg: 12, AlphaStepDeg: .25,
		FlapChordRatio: .2, FlapHingeXOverC: .8, FlapHingeYOverC: 0, FlapDeflectionDeg: 2,
		NCrit: 9, Iterations: 200, PanelCount: 160, ExecutionPurpose: "screening",
		OptimizationObjective: "minimize_cd_at_target_cl", TargetCL: .4, MinimumCM: -.1,
	}
	encoded, _ := json.Marshal(call)
	if !xfoilCallAuthorizedByPlan(plan, encoded, call.RunID, call.StageAttemptID) {
		t.Fatal("exact plan-authorized XFOIL matrix cell was rejected")
	}
	call.Reynolds = 400_000
	encoded, _ = json.Marshal(call)
	if xfoilCallAuthorizedByPlan(plan, encoded, call.RunID, call.StageAttemptID) {
		t.Fatal("unplanned Reynolds condition was authorized")
	}
	call.Reynolds = 350_000
	call.FlapDeflectionDeg = 6
	encoded, _ = json.Marshal(call)
	if xfoilCallAuthorizedByPlan(plan, encoded, call.RunID, call.StageAttemptID) {
		t.Fatal("unplanned flap candidate was authorized")
	}
}

func approvalEvent(method string, params map[string]any) codex.Event {
	encoded, _ := json.Marshal(params)
	return codex.Event{Method: method, Params: encoded, RequestID: json.RawMessage(`"request-1"`)}
}
