package store

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/core"
)

func TestConversationPlanCyclePairsLatestObjectiveAndPlanExactlyOnce(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "durable plan")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetProjectMainThread(ctx, project.ID, "thread-plan"); err != nil {
		t.Fatal(err)
	}
	session, err := db.DefaultConversationSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	old, err := db.BeginConversationPlanCycle(ctx, session.ID, "과거 목표")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteConversationPlanCycle(ctx, session.ID, old.ID, "# 목표\n과거 계획"); err != nil {
		t.Fatal(err)
	}
	objective := "NACA 0015 플랩을 비교한다.\n\nRe=1,000,000과 XFOIL 조건을 지킨다."
	latest, err := db.BeginConversationPlanCycle(ctx, session.ID, objective)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreatePlannedConversationRunConfigured(ctx, session.ID, old.ID, "thread-plan", core.RunConfiguration{}); !errors.Is(err, ErrPlanCycleNotReady) {
		t.Fatalf("superseded cycle start error = %v", err)
	}
	finalPlan := "# 목표\n현재 목표\n\n# 실행 단계\n- 실제 XFOIL 선별"
	if _, err := db.CompleteConversationPlanCycle(ctx, session.ID, latest.ID, finalPlan); err != nil {
		t.Fatal(err)
	}
	run, err := db.CreatePlannedConversationRunConfigured(ctx, session.ID, latest.ID, "thread-plan", core.RunConfiguration{})
	if err != nil {
		t.Fatal(err)
	}
	wantQuestion := "계획 모드에서 합의된 실행 계획:\n" + finalPlan
	if run.Question != wantQuestion || strings.Contains(run.Question, "과거") || strings.Contains(run.Question, objective) {
		t.Fatalf("planned run question = %q", run.Question)
	}
	consumed, err := db.ConversationPlanCycle(ctx, session.ID, latest.ID)
	if err != nil {
		t.Fatal(err)
	}
	if consumed.Status != "consumed" || consumed.RunID != run.ID || consumed.ConsumedAt == nil || consumed.Objective != objective {
		t.Fatalf("consumed cycle = %+v", consumed)
	}
	if _, err := db.CreatePlannedConversationRunConfigured(ctx, session.ID, latest.ID, "thread-plan", core.RunConfiguration{}); !errors.Is(err, ErrPlanCycleNotReady) {
		t.Fatalf("duplicate planned run error = %v", err)
	}
}

func TestConversationPlanCycleTextPreservesUnicodeAndRejectsDamage(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "unicode plan")
	if err != nil {
		t.Fatal(err)
	}
	session, err := db.DefaultConversationSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, damaged := range []string{"손상된 목표 \uFFFD", "invalid \xff"} {
		if _, err := db.BeginConversationPlanCycle(ctx, session.ID, damaged); err == nil {
			t.Fatalf("accepted damaged objective %q", damaged)
		}
	}
	const objective = "한글 목표와 emoji 😀 – 보존"
	cycle, err := db.BeginConversationPlanCycle(ctx, session.ID, objective)
	if err != nil {
		t.Fatal(err)
	}
	if cycle.Objective != objective {
		t.Fatalf("objective = %q, want %q", cycle.Objective, objective)
	}
	for _, damaged := range []string{"손상된 계획 \uFFFD", "invalid \xff"} {
		if _, err := db.CompleteConversationPlanCycle(ctx, session.ID, cycle.ID, damaged); err == nil {
			t.Fatalf("accepted damaged final plan %q", damaged)
		}
	}
	const finalPlan = "# 계획 😀\n\n- 실제 검증 🛩️"
	ready, err := db.CompleteConversationPlanCycle(ctx, session.ID, cycle.ID, finalPlan)
	if err != nil {
		t.Fatal(err)
	}
	if ready.FinalPlan != finalPlan {
		t.Fatalf("final plan = %q, want %q", ready.FinalPlan, finalPlan)
	}
}

func TestConversationPlanCyclesSurviveRestartAndProjectDeletion(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "plan-restart.db")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	project, err := db.CreateProject(ctx, "restart plan")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetProjectMainThread(ctx, project.ID, "thread-restart"); err != nil {
		t.Fatal(err)
	}
	session, err := db.DefaultConversationSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	cycle, err := db.BeginConversationPlanCycle(ctx, session.ID, "재시작 뒤에도 유지할 목표")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteConversationPlanCycle(ctx, session.ID, cycle.ID, "# 목표\n재시작 검증"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	restored, err := db.LatestConversationPlanCycle(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if restored.ID != cycle.ID || restored.Status != "ready" || restored.Objective != cycle.Objective {
		t.Fatalf("restored cycle = %+v", restored)
	}
	run, err := db.CreatePlannedConversationRunConfigured(ctx, session.ID, cycle.ID, "thread-restart", core.RunConfiguration{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.TransitionRun(ctx, run.ID, run.Revision, core.RunCancelled, "test completed"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, "DELETE FROM conversation_plan_cycles WHERE id=?", cycle.ID); err == nil || !strings.Contains(err.Error(), "append-only") {
		t.Fatalf("direct plan cycle deletion was not blocked: %v", err)
	}
	if _, err := db.DeleteProject(ctx, project.ID); err != nil {
		t.Fatalf("project deletion did not cascade consumed plan cycle: %v", err)
	}
	var cycles int
	if err := db.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM conversation_plan_cycles WHERE conversation_session_id=?", session.ID).Scan(&cycles); err != nil {
		t.Fatal(err)
	}
	if cycles != 0 {
		t.Fatalf("project deletion left %d plan cycles", cycles)
	}
}
