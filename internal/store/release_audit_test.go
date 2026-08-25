package store

import (
	"context"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"github.com/djkim0320/AetherOps/internal/core"
)

func TestStageExecutionReceiptAndRunResearchContractAreImmutable(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	binding := buildinfo.ProductBuildBinding{
		Version: buildinfo.ReleaseProductVersion, ExecutableSHA256: strings.Repeat("1", 64),
		RuntimeManifestSHA256: strings.Repeat("2", 64), KnowledgeSidecarTreeSHA256: strings.Repeat("3", 64),
	}
	if err := db.SetProductBuildBinding(binding); err != nil {
		t.Fatal(err)
	}
	project, err := db.CreateProject(ctx, "release audit")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetProjectMainThread(ctx, project.ID, "main-thread"); err != nil {
		t.Fatal(err)
	}
	run, err := db.CreateRunConfigured(ctx, project.ID, "", "audit question", "main-thread", core.RunConfiguration{
		Model: core.PlannerModel, ReasoningEffort: core.PlannerEffort, ServiceTier: core.ServiceTierDefault,
	})
	if err != nil {
		t.Fatal(err)
	}
	inputHash := strings.Repeat("a", 64)
	outputHash := strings.Repeat("b", 64)
	attempt, err := db.BeginStage(ctx, run.ID, core.StagePlan, 0, run.MainThreadID, inputHash)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetStageTurn(ctx, attempt.ID, run.MainThreadID, "turn-1"); err != nil {
		t.Fatal(err)
	}
	receipt := StageExecutionReceipt{
		StageAttemptID: attempt.ID, RunID: run.ID, ResearchProfileVersion: run.ResearchProfileVersion,
		Model: core.PlannerModel, ReasoningEffort: core.PlannerEffort, ServiceTier: core.ServiceTierDefault,
		CodexThreadID: run.MainThreadID, CodexTurnID: "turn-1",
		InputSHA256: inputHash, OutputSHA256: outputHash,
		ExecutionContractSHA256: core.StageExecutionContractSHA256,
		ProductBuild:            run.ProductBuild,
	}
	mismatched := receipt
	mismatched.ProductBuild.ExecutableSHA256 = strings.Repeat("4", 64)
	if err := db.CompleteStageWithExecution(ctx, attempt.ID, outputHash, mismatched); err == nil {
		t.Fatal("stage receipt from a different product build was accepted")
	}
	if err := db.CompleteStageWithExecution(ctx, attempt.ID, outputHash, receipt); err != nil {
		t.Fatal(err)
	}
	stored, err := db.StageExecutionReceipt(ctx, attempt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.OutputSHA256 != outputHash || stored.CodexTurnID != "turn-1" || stored.ProductBuild != binding || stored.CompletedAt.IsZero() {
		t.Fatalf("unexpected stored receipt: %+v", stored)
	}
	if _, err := db.SQL().ExecContext(ctx,
		"UPDATE stage_execution_receipts SET model=? WHERE stage_attempt_id=?", core.CollectorModel, attempt.ID); err == nil {
		t.Fatal("immutable stage execution receipt accepted an update")
	}
	if _, err := db.SQL().ExecContext(ctx,
		"DELETE FROM stage_execution_receipts WHERE stage_attempt_id=?", attempt.ID); err == nil {
		t.Fatal("immutable stage execution receipt accepted a delete")
	}
	if _, err := db.SQL().ExecContext(ctx,
		"UPDATE runs SET retrieval_profile='hybrid_v1' WHERE id=?", run.ID); err == nil {
		t.Fatal("immutable run retrieval profile accepted an update")
	}
	if _, err := db.SQL().ExecContext(ctx,
		"UPDATE runs SET executable_sha256=? WHERE id=?", strings.Repeat("5", 64), run.ID); err == nil {
		t.Fatal("immutable run product build accepted an update")
	}
}

func TestStageExecutionReceiptMustMatchActiveAttempt(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "release audit mismatch")
	if err != nil {
		t.Fatal(err)
	}
	run, err := db.CreateRun(ctx, project.ID, "", "audit question", "main-thread")
	if err != nil {
		t.Fatal(err)
	}
	inputHash := strings.Repeat("c", 64)
	outputHash := strings.Repeat("d", 64)
	attempt, err := db.BeginStage(ctx, run.ID, core.StagePlan, 0, "main-thread", inputHash)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetStageTurn(ctx, attempt.ID, "main-thread", "turn-1"); err != nil {
		t.Fatal(err)
	}
	err = db.CompleteStageWithExecution(ctx, attempt.ID, outputHash, StageExecutionReceipt{
		StageAttemptID: attempt.ID, RunID: run.ID, ResearchProfileVersion: run.ResearchProfileVersion,
		Model: core.PlannerModel, ReasoningEffort: core.PlannerEffort, ServiceTier: core.ServiceTierDefault,
		CodexThreadID: "main-thread", CodexTurnID: "wrong-turn",
		InputSHA256: inputHash, OutputSHA256: outputHash,
		ExecutionContractSHA256: core.StageExecutionContractSHA256,
	})
	if err == nil {
		t.Fatal("mismatched stage execution receipt was accepted")
	}
	var count int
	if scanErr := db.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM stage_execution_receipts WHERE stage_attempt_id=?", attempt.ID).Scan(&count); scanErr != nil {
		t.Fatal(scanErr)
	}
	if count != 0 {
		t.Fatalf("failed receipt transaction left %d durable rows", count)
	}
}
