package research

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/engineering"
	"github.com/djkim0320/AetherOps/internal/store"
)

func TestGeneralSU2RemediationReconstructsOnlyExactGenericCases(t *testing.T) {
	runID := "run-general"
	attemptID := "stg-general"
	jobSpec := `{"operation":"su2_cfd","arguments":{"run_id":"` + runID + `","stage_attempt_id":"` + attemptID + `","case_id":"case_a","mesh_source":"material","mesh_id":"doc_mesh","mesh_sha256":"` + strings.Repeat("a", 64) + `","config_source":"","config_id":"","config_sha256":"","solver":"RANS","turbulence_model":"SST","config_overrides":{"ITER":"100","REYNOLDS_NUMBER":"1000000"},"output_files":["surface_csv"],"timeout_seconds":300}}`
	result := store.EngineeringResult{Job: store.EngineeringJob{
		ID: "eng-general", RunID: runID, StageAttemptID: attemptID, Operation: "su2_cfd",
		Status: "succeeded", ReceiptArtifactID: "art_0123456789abcdef0123456789abcdef", SpecJSON: jobSpec,
	}}
	plan, err := generalSU2CaseSetForRemediation(runID, []store.EngineeringResult{result})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Cases) != 1 || plan.Cases[0].ID != "case_a" || plan.Cases[0].Solver != "RANS" || plan.Cases[0].TurbulenceModel != "SST" {
		t.Fatalf("reconstructed generic SU2 plan = %+v", plan)
	}

	changed := result
	changed.Job.Operation = "removed_fixed_case"
	if _, err := generalSU2CaseSetForRemediation(runID, []store.EngineeringResult{changed}); err == nil {
		t.Fatal("non-generic engineering receipt was promoted into a general SU2 remediation")
	}
	if _, err := generalSU2CaseSetForRemediation(runID, []store.EngineeringResult{result, result}); err == nil {
		t.Fatal("duplicate generic SU2 case was accepted for remediation")
	}
}

func TestGeneralSU2AcceptanceMatchesActualStoredCaseIDContract(t *testing.T) {
	ctx := context.Background()
	engine, database, objects, run := openResearchTest(t, &protocolFixture{})
	var err error
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(ctx, run.ID, core.StageCollect, 0, "collector", "turn")
	if err != nil {
		t.Fatal(err)
	}
	spec := engineering.SU2CFDSpec{
		RunID: run.ID, StageAttemptID: attempt.ID, CaseID: "case_a",
		MeshSource: core.SU2InputMaterial, MeshID: "doc_mesh", MeshSHA256: strings.Repeat("a", 64),
		Solver: "EULER", TurbulenceModel: "NONE", ConfigOverrides: map[string]string{"ITER": "100"},
		OutputFiles: []string{"surface_csv"}, TimeoutSeconds: 300,
	}
	arguments, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	approval, err := database.CreateApproval(ctx, core.Approval{
		RunID: run.ID, StageAttemptID: attempt.ID, ThreadID: attempt.CodexThreadID, TurnID: "turn", ItemID: "su2-call",
		Kind: "item/mcpToolCall/requestApproval", Summary: "general SU2", Server: "aetherops_engineering", Tool: "su2_cfd",
		ArgumentsJSON: string(arguments), ArgumentsSHA256: sha256Hex(arguments), Risk: "external_side_effect", ExternalSideEffect: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.DecideApproval(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	storedSpec, err := json.Marshal(map[string]any{"operation": "su2_cfd", "arguments": json.RawMessage(arguments)})
	if err != nil {
		t.Fatal(err)
	}
	job, execute, err := database.BeginEngineeringJob(ctx, store.EngineeringJob{
		ProjectID: run.ProjectID, RunID: run.ID, StageAttemptID: attempt.ID, Operation: "su2_cfd",
		SpecJSON: string(storedSpec), SpecSHA256: sha256Hex(storedSpec), ToolComponent: "su2", ToolVersion: "8.5.0",
		ApprovalScopeHash: sha256Hex(arguments),
	})
	if err != nil || !execute {
		t.Fatalf("begin general SU2 job: execute=%v err=%v", execute, err)
	}
	receipt, err := objects.PutBytes([]byte(`{"operation":"su2_cfd","executed":true}`))
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := database.PublishArtifact(ctx, run.ID, attempt.ID, "engineering.su2_cfd.receipt", "application/json", receipt)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.CompleteEngineeringJob(ctx, job.ID, artifact.ID, []store.EngineeringJobArtifact{{
		ArtifactID: artifact.ID, Role: "receipt", FileName: "execution-receipt.json", MediaType: "application/json", BlobHash: receipt.Hash,
	}}); err != nil {
		t.Fatal(err)
	}
	source, err := core.EngineeringReceiptEvidenceSource(artifact.ID, "su2_cfd", artifact.BlobHash, artifact.CreatedAt)
	if err != nil {
		t.Fatal(err)
	}
	casePlan := core.SU2CasePlan{
		ID: spec.CaseID, MeshSource: spec.MeshSource, MeshID: spec.MeshID, MeshSHA256: spec.MeshSHA256,
		Solver: spec.Solver, TurbulenceModel: spec.TurbulenceModel, ConfigOverrides: spec.ConfigOverrides,
		OutputFiles: spec.OutputFiles, TimeoutSeconds: spec.TimeoutSeconds,
	}
	plan := core.ResearchPlan{SU2Cases: &core.SU2CaseSetPlan{Objective: "run exact case", Cases: []core.SU2CasePlan{casePlan}}}
	bundle := core.EvidenceBundle{Sources: []core.EvidenceSource{source}}
	if err := engine.verifyPlannedSU2Cases(ctx, run.ID, plan, bundle); err != nil {
		t.Fatalf("actual case_id receipt was rejected: %v", err)
	}
	tampered := plan
	set := *plan.SU2Cases
	set.Cases = append([]core.SU2CasePlan(nil), plan.SU2Cases.Cases...)
	set.Cases[0].MeshSHA256 = strings.Repeat("b", 64)
	tampered.SU2Cases = &set
	if err := engine.verifyPlannedSU2Cases(ctx, run.ID, tampered, bundle); err == nil {
		t.Fatal("changed planned mesh hash matched the stored general SU2 receipt")
	}
}
