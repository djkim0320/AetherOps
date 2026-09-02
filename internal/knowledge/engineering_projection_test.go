package knowledge

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
)

func TestDeterministicEngineeringProjectionUsesVerifiedReceiptEvidence(t *testing.T) {
	ctx := context.Background()
	database, objects := openKnowledgeServiceTestStorage(t)
	project, err := database.CreateProject(ctx, "deterministic engineering graph")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "SU2 receipt graph", "main-thread")
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
	arguments := `{"case_id":"case_a","mesh_sha256":"` + knowledgeTestSHA("mesh") + `","solver":"EULER"}`
	approval, err := database.CreateApproval(ctx, core.Approval{
		RunID: run.ID, StageAttemptID: attempt.ID, ThreadID: attempt.CodexThreadID,
		TurnID: "collector-turn", ItemID: "solver-call",
		Kind: "item/mcpToolCall/requestApproval", Summary: "SU2 deterministic test",
		Server: "aetherops_engineering", Tool: "su2_cfd",
		ArgumentsJSON: arguments, ArgumentsSHA256: knowledgeTestSHA(arguments),
		Risk: "external_side_effect", ExternalSideEffect: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.DecideApproval(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	jobSpec := `{"arguments":{"case_id":"case_a","mesh_sha256":"` + knowledgeTestSHA("mesh") + `","solver":"EULER"},"operation":"su2_cfd","runtime_bundle_hash":"` + knowledgeTestSHA("runtime") + `","tool_component":"su2","tool_version":"8.5.0"}`
	job, execute, err := database.BeginEngineeringJob(ctx, store.EngineeringJob{
		ProjectID: project.ID, RunID: run.ID, StageAttemptID: attempt.ID,
		Operation: "su2_cfd", SpecJSON: jobSpec, SpecSHA256: knowledgeTestSHA(jobSpec),
		ToolComponent: "su2", ToolVersion: "8.5.0", ApprovalScopeHash: knowledgeTestSHA(arguments),
	})
	if err != nil || !execute {
		t.Fatalf("begin engineering job: execute=%v err=%v", execute, err)
	}
	now := time.Now().UTC()
	metrics := su2ProjectionTestMetrics()
	// Production receipts are deliberately human-readable. The decoded
	// RawMessage therefore contains whitespace that is absent from SpecJSON.
	// Projection validation must preserve the exact semantic identity without
	// mistaking this presentation-only indentation for a different job.
	receiptBytes, err := json.MarshalIndent(map[string]any{
		"schema": engineeringReceiptSchema, "job_id": job.ID, "run_id": run.ID,
		"stage_attempt_id": attempt.ID, "operation": job.Operation,
		"spec": json.RawMessage(jobSpec), "spec_sha256": job.SpecSHA256,
		"executables": []any{}, "threads": 4,
		"started_at": now.Add(-time.Second), "completed_at": now,
		"exit_codes": []int{0}, "executed": true, "numerically_valid": true,
		"metrics":   metrics,
		"artifacts": []any{},
	}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes(receiptBytes)
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := database.PublishArtifact(ctx, run.ID, attempt.ID,
		"engineering.su2_cfd.receipt", "application/json", receipt)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.CompleteEngineeringJob(ctx, job.ID, artifact.ID, []store.EngineeringJobArtifact{{
		ArtifactID: artifact.ID, Role: "receipt", FileName: "execution-receipt.json",
		MediaType: "application/json", BlobHash: receipt.Hash,
	}}); err != nil {
		t.Fatal(err)
	}
	candidate, err := database.CreateKnowledgeGeneration(ctx, project.ID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	projection, err := (&Service{DB: database, CAS: objects}).deterministicEngineeringProjection(ctx, run)
	if err != nil {
		t.Fatal(err)
	}
	if len(projection.Entities) != len(metrics)+1 || len(projection.Assertions) != len(metrics)*2 || len(projection.Evidence) != len(metrics)*2 {
		t.Fatalf("engineering projection counts: entities=%d assertions=%d evidence=%d",
			len(projection.Entities), len(projection.Assertions), len(projection.Evidence))
	}
	for _, evidence := range projection.Evidence {
		if evidence.EvidenceKind != "artifact_value" || evidence.BlobHash != receipt.Hash {
			t.Fatalf("unverified engineering evidence: %+v", evidence)
		}
	}
	if err := database.AppendKnowledgeProjection(ctx, project.ID, candidate.ID, projection); err != nil {
		t.Fatal(err)
	}
	if err := (&Service{DB: database, CAS: objects}).recordDeterministicEngineeringProjection(ctx, run, candidate); err != nil {
		t.Fatal(err)
	}
	var appliedBatches int
	if err := database.SQL().QueryRowContext(ctx, `
SELECT COUNT(*) FROM knowledge_extraction_batches
WHERE project_id=? AND generation_id=? AND run_id=? AND source_kind='engineering' AND status='applied'`,
		project.ID, candidate.ID, run.ID).Scan(&appliedBatches); err != nil {
		t.Fatal(err)
	}
	if appliedBatches != 1 {
		t.Fatalf("deterministic engineering applied batches = %d, want 1", appliedBatches)
	}
	appendKnowledgeServiceTestSnapshot(t, database, objects, project.ID, candidate.ID, store.CoreOntologyID)
	if _, err := database.TransitionKnowledgeGeneration(ctx, project.ID, candidate.ID,
		store.KnowledgeBuilding, store.KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionKnowledgeGeneration(ctx, project.ID, candidate.ID,
		store.KnowledgeValidating, store.KnowledgeReady, ""); err != nil {
		t.Fatalf("validated deterministic engineering projection: %v", err)
	}
}

func TestEngineeringMetricUnitContractRejectsUnknownAndNormalizesAngle(t *testing.T) {
	literal, _, err := engineeringMetricLiteral("new_sweep_deg", engineeringMetricContract{
		Kind: engineeringMetricAngle, Unit: "deg",
	}, json.RawMessage(`12.5`))
	if err != nil {
		t.Fatal(err)
	}
	if literal.LexicalForm != "12.5" || literal.Unit != "deg" || literal.SIUnit != "rad" || literal.SIValue == "" {
		t.Fatalf("angle literal = %+v", literal)
	}
	if err := literal.Validate(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := engineeringMetricLiteral("unexpected", engineeringMetricContract{}, json.RawMessage(`1`)); err == nil {
		t.Fatal("unsupported engineering metric contract was accepted")
	}
	length, _, err := engineeringMetricLiteral("surface_spacing_mean_m", engineeringMetricContract{
		Kind: engineeringMetricLength, Unit: "m",
	}, json.RawMessage(`0.025`))
	if err != nil || length.Datatype != core.KnowledgeDatatypeLength || length.Unit != "m" ||
		length.SIValue != "0.025" || length.SIUnit != "m" {
		t.Fatalf("length literal = %+v error=%v", length, err)
	}
	boolean, _, err := engineeringMetricLiteral("mesh_orientation_valid", engineeringMetricContract{
		Kind: engineeringMetricBoolean,
	}, json.RawMessage(`true`))
	if err != nil || boolean.LexicalForm != "true" || boolean.Datatype != "http://www.w3.org/2001/XMLSchema#boolean" {
		t.Fatalf("boolean literal = %+v error=%v", boolean, err)
	}
	if _, _, err := engineeringMetricLiteral("mesh_orientation_valid", engineeringMetricContract{
		Kind: engineeringMetricBoolean,
	}, json.RawMessage(`"true"`)); err == nil {
		t.Fatal("string-valued engineering boolean was accepted")
	}
}

func su2ProjectionTestMetrics() map[string]any {
	return map[string]any{
		"case_id": "case_a", "solver": "EULER", "turbulence_model": "NONE",
		"mesh_sha256": knowledgeTestSHA("mesh"), "effective_config_sha256": knowledgeTestSHA("config"),
		"mesh_dimension": 2, "mesh_nodes": 1000, "mesh_elements": 1900, "mesh_markers": 2,
		"history_rows": 50, "history_columns": 12, "final_iteration": 49,
		"converged": true, "termination_reason": "convergence_criteria_satisfied",
		"cl": json.Number("0.4125"), "cd": json.Number("0.01875"), "final_rms_density": json.Number("-8.1"),
	}
}

func TestEngineeringArtifactOnlyMetricContractChecksJSONShape(t *testing.T) {
	for name, test := range map[string]struct {
		value json.RawMessage
		kind  engineeringArtifactMetricKind
		valid bool
	}{
		"array":             {value: json.RawMessage(`[1,2]`), kind: engineeringArtifactMetricArray, valid: true},
		"object":            {value: json.RawMessage(`{"winner":15}`), kind: engineeringArtifactMetricObject, valid: true},
		"object as array":   {value: json.RawMessage(`[]`), kind: engineeringArtifactMetricObject},
		"array as object":   {value: json.RawMessage(`{}`), kind: engineeringArtifactMetricArray},
		"null object":       {value: json.RawMessage(`null`), kind: engineeringArtifactMetricObject},
		"unknown kind":      {value: json.RawMessage(`{}`), kind: engineeringArtifactMetricKind("scalar")},
		"malformed payload": {value: json.RawMessage(`{`), kind: engineeringArtifactMetricObject},
	} {
		t.Run(name, func(t *testing.T) {
			err := validateEngineeringArtifactOnlyMetric(test.value, test.kind)
			if (err == nil) != test.valid {
				t.Fatalf("valid=%v error=%v, want valid=%v", err == nil, err, test.valid)
			}
		})
	}
}
