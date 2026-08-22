package approval

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/core"
)

func TestCoreAuthorizerExpandsOneVisibleDecisionIntoExactCellScopes(t *testing.T) {
	for _, decision := range []string{"approved", "denied"} {
		t.Run(decision, func(t *testing.T) {
			database, run, attempt := activeCollectRun(t)
			authorizer := &CoreAuthorizer{DB: database}
			arguments := [][]byte{
				testScreeningArguments(run.ID, attempt.ID, 0),
				testScreeningArguments(run.ID, attempt.ID, 5),
			}
			result := make(chan error, 1)
			go func() {
				result <- authorizer.AuthorizeXFOILScreening(context.Background(), run, attempt, arguments)
			}()

			var visible core.Approval
			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) {
				pending, err := database.ListPendingApprovals(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				if len(pending) == 1 {
					visible = pending[0]
					break
				}
				time.Sleep(5 * time.Millisecond)
			}
			if visible.ID == "" || !authorizer.Owns(visible.ID) {
				t.Fatal("core matrix approval did not become visible")
			}
			if _, err := authorizer.Decide(context.Background(), visible.ID, decision); err != nil {
				t.Fatal(err)
			}
			err := <-result
			if decision == "denied" {
				if !errors.Is(err, ErrPlannedEngineeringDenied) {
					t.Fatalf("denial error = %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			var approved int
			if err := database.SQL().QueryRowContext(context.Background(),
				"SELECT COUNT(*) FROM approvals WHERE run_id=? AND status='approved'", run.ID,
			).Scan(&approved); err != nil {
				t.Fatal(err)
			}
			want := 2
			if decision == "denied" {
				want = 0
			}
			if approved != want {
				t.Fatalf("approved exact scopes = %d, want %d", approved, want)
			}
		})
	}
}

func testScreeningArguments(runID, attemptID string, deflection float64) []byte {
	return []byte(fmt.Sprintf(`{"run_id":%q,"stage_attempt_id":%q,"naca":"2412","reynolds":1000000,"mach":0.1,"alpha_start_deg":-4,"alpha_end_deg":12,"alpha_step_deg":0.5,"flap_chord_ratio":0.25,"flap_hinge_x_over_c":0.75,"flap_hinge_y_over_c":0,"flap_deflection_deg":%g,"ncrit":9,"iterations":200,"panel_count":160,"execution_purpose":"screening","optimization_objective":"minimize_cd_at_target_cl","target_cl":0.8,"minimum_cm":-0.2}`, runID, attemptID, deflection))
}

func TestDeniedEngineeringToolRetryQuiescesCollectorInsteadOfLooping(t *testing.T) {
	database, run, attempt := activeCollectRun(t)
	raw := testScreeningArguments(run.ID, attempt.ID, 0)
	digest := sha256.Sum256(raw)
	denied, err := database.CreateApproval(context.Background(), core.Approval{
		RunID: run.ID, StageAttemptID: attempt.ID, ThreadID: "collector-thread", TurnID: "turn-1",
		Kind: "item/mcpToolCall/requestApproval", Server: "aetherops_engineering", Tool: "xfoil_polar",
		ArgumentsJSON: string(raw), ArgumentsSHA256: hex.EncodeToString(digest[:]), ExternalSideEffect: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.DecideApproval(context.Background(), denied.ID, "denied"); err != nil {
		t.Fatal(err)
	}
	var arguments map[string]any
	if err := json.Unmarshal(raw, &arguments); err != nil {
		t.Fatal(err)
	}
	fixture := &protocolFixture{}
	router := &Router{DB: database, Client: fixture, pending: make(map[string]pendingApproval)}
	event := approvalEvent("item/mcpToolCall/requestApproval", map[string]any{
		"threadId": "collector-thread", "turnId": "turn-2", "itemId": "item-2",
		"server": "aetherops_engineering", "tool": "xfoil_polar", "arguments": arguments,
	})
	if err := router.handle(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	if len(fixture.responses) != 1 || fixture.responses[0].decision != "decline" {
		t.Fatalf("retry response = %+v", fixture.responses)
	}
	completed, err := database.Run(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != core.RunFailed {
		t.Fatalf("retried denied solver left run %s, want failed", completed.Status)
	}
}
