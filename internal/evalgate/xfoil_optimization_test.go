package evalgate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/engineering"
	managedruntime "github.com/djkim0320/AetherOps/internal/runtime"
	"github.com/djkim0320/AetherOps/internal/store"
)

type evaluationOptimizationFixture struct {
	database     *store.DB
	objects      *cas.Store
	run          core.Run
	screening    core.StageAttempt
	verification core.StageAttempt
	runtimeHash  string
}

func newEvaluationOptimizationFixture(t *testing.T) evaluationOptimizationFixture {
	t.Helper()
	ctx := context.Background()
	database, objects := openEvaluationStore(t)
	project, err := database.CreateProject(ctx, "offline XFOIL optimization")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "optimize flap", "main-thread")
	if err != nil {
		t.Fatal(err)
	}
	screening, err := database.BeginStage(ctx, run.ID, core.StageCollect, 0, "screening-thread", "")
	if err != nil {
		t.Fatal(err)
	}
	verification, err := database.BeginStage(ctx, run.ID, core.StageCollect,
		core.EngineeringVerificationOrdinal, "verification-thread", "")
	if err != nil {
		t.Fatal(err)
	}
	return evaluationOptimizationFixture{
		database: database, objects: objects, run: run, screening: screening,
		verification: verification, runtimeHash: strings.Repeat("a", 64),
	}
}

func evaluationOptimizationSpec(
	fixture evaluationOptimizationFixture, attempt core.StageAttempt, deflection float64, purpose, sourceJobID string,
) engineering.XFOILSpec {
	chord, hingeX, hingeY := .3, .7, 0.0
	targetCL, minimumCM := .8, -.2
	spec := engineering.XFOILSpec{
		RunID: fixture.run.ID, StageAttemptID: attempt.ID, NACA: "0015",
		Reynolds: 1e6, Mach: .1, AlphaStartDeg: -6, AlphaEndDeg: 18, AlphaStepDeg: .25,
		ExecutionPurpose: purpose, VerificationOfJobID: sourceJobID,
		OptimizationObjective: engineering.XFOILObjectiveMinimizeCDAtTargetCL,
		TargetCL:              &targetCL, MinimumCM: &minimumCM,
		FlapChordRatio: &chord, FlapHingeXOverC: &hingeX,
		FlapHingeYOverC: &hingeY, FlapDeflectionDeg: &deflection,
	}
	if purpose == engineering.XFOILPurposeIndependentVerification {
		panels := 240
		spec.PanelCount = &panels
		spec.AlphaStartDeg = .5
		spec.AlphaEndDeg = 1.5
		spec.AlphaStepDeg = .05
	}
	return spec
}

func evaluationTwoPointPolar(cd, cm float64) []engineering.XFOILSample {
	return []engineering.XFOILSample{
		{Alpha: 0, CL: .7, CD: cd - .001, CM: cm + .01},
		{Alpha: 2, CL: .9, CD: cd + .001, CM: cm - .01},
	}
}

func recordEvaluationXFOILJob(
	t *testing.T,
	fixture evaluationOptimizationFixture,
	jobID string,
	spec engineering.XFOILSpec,
	status string,
	samples []engineering.XFOILSample,
	verificationMetric map[string]any,
) store.EngineeringJob {
	t.Helper()
	ctx := context.Background()
	arguments, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	specBytes, err := json.Marshal(map[string]any{
		"arguments": json.RawMessage(arguments), "operation": "xfoil_polar",
		"runtime_bundle_hash": fixture.runtimeHash, "tool_component": "xfoil",
		"tool_version": managedruntime.PinnedXFOILVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	specDigest := sha256.Sum256(specBytes)
	specHash := fmt.Sprintf("%x", specDigest)
	now := time.Now().UTC()
	nowText := now.Format(time.RFC3339Nano)
	approvalID := "apr_" + jobID
	if _, err := fixture.database.SQL().ExecContext(ctx, `
INSERT INTO approvals(id,run_id,thread_id,turn_id,item_id,kind,summary,status,created_at,updated_at,
 stage_attempt_id,server,tool,arguments_json,arguments_sha256,risk,external_side_effect)
VALUES(?,?,?,?,?,'item/mcpToolCall/requestApproval','offline fixture','approved',?,?,?,
 'aetherops_engineering','xfoil_polar','{}',?,'external_side_effect',1)`,
		approvalID, fixture.run.ID, "thread-"+jobID, "turn-"+jobID, "item-"+jobID,
		nowText, nowText, spec.StageAttemptID, strings.Repeat("c", 64)); err != nil {
		t.Fatal(err)
	}
	receiptArtifactID := ""
	var receiptHash string
	if status == "succeeded" {
		metrics := map[string]any{"samples": samples}
		if spec.ExecutionPurpose != "" {
			targetCL, minimumCM, deflection := 0.0, 0.0, 0.0
			if spec.TargetCL != nil {
				targetCL = *spec.TargetCL
			}
			if spec.MinimumCM != nil {
				minimumCM = *spec.MinimumCM
			}
			if spec.FlapDeflectionDeg != nil {
				deflection = *spec.FlapDeflectionDeg
			}
			target, found, err := interpolateEvaluationXFOILTarget(samples, targetCL)
			if err != nil {
				t.Fatal(err)
			}
			optimization := map[string]any{
				"objective": spec.OptimizationObjective, "target_cl": targetCL,
				"minimum_cm": minimumCM, "target_reached": found,
			}
			if found {
				target.FlapDeflectionDeg = deflection
				target.ConstraintSatisfied = target.CM >= minimumCM
				optimization["target_metrics"] = target
			}
			metrics["optimization"] = optimization
			if verificationMetric != nil {
				metrics["optimization_verification"] = verificationMetric
			}
		}
		receiptBytes, err := json.Marshal(map[string]any{
			"schema": 1, "job_id": jobID, "run_id": fixture.run.ID,
			"stage_attempt_id": spec.StageAttemptID, "operation": "xfoil_polar",
			"spec": json.RawMessage(specBytes), "spec_sha256": specHash,
			"executables": []map[string]any{{
				"component": "xfoil", "version": managedruntime.PinnedXFOILVersion,
				"sha256": strings.Repeat("d", 64), "argv": []string{"xfoil.exe"},
			}},
			"threads": 1, "started_at": now, "completed_at": now.Add(time.Second),
			"exit_codes": []int{0}, "executed": true, "numerically_valid": true,
			"metrics": metrics, "artifacts": []any{},
		})
		if err != nil {
			t.Fatal(err)
		}
		receipt, err := fixture.objects.PutBytes(receiptBytes)
		if err != nil {
			t.Fatal(err)
		}
		artifact, err := fixture.database.PublishArtifact(ctx, fixture.run.ID, spec.StageAttemptID,
			"engineering.xfoil_polar.receipt", "application/json", receipt)
		if err != nil {
			t.Fatal(err)
		}
		receiptArtifactID, receiptHash = artifact.ID, artifact.BlobHash
	}
	completed := any(nil)
	if status == "succeeded" || status == "failed" {
		completed = nowText
	}
	if _, err := fixture.database.SQL().ExecContext(ctx, `
INSERT INTO engineering_jobs(id,project_id,run_id,stage_attempt_id,operation,spec_json,spec_sha256,
 tool_component,tool_version,approval_id,approval_scope_hash,status,receipt_artifact_id,error,
 created_at,started_at,completed_at,updated_at)
VALUES(?,?,?,?, 'xfoil_polar',?,?, 'xfoil',?,?,?, ?,NULLIF(?,''),?, ?,?,?,?)`,
		jobID, fixture.run.ProjectID, fixture.run.ID, spec.StageAttemptID, string(specBytes), specHash,
		managedruntime.PinnedXFOILVersion, approvalID, strings.Repeat("e", 64), status,
		receiptArtifactID, map[bool]string{true: "solver failed"}[status == "failed"],
		nowText, nowText, completed, nowText); err != nil {
		t.Fatal(err)
	}
	if status == "succeeded" {
		if _, err := fixture.database.SQL().ExecContext(ctx, `
INSERT INTO engineering_job_artifacts(job_id,artifact_id,role,file_name,media_type,blob_hash)
VALUES(?,?,'receipt','execution-receipt.json','application/json',?)`,
			jobID, receiptArtifactID, receiptHash); err != nil {
			t.Fatal(err)
		}
	}
	job, err := fixture.database.EngineeringJob(ctx, jobID)
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func standardEvaluationVerificationMetric(failed int, winnerJobID string, winnerDeflection float64) map[string]any {
	return map[string]any{
		"screening_attempt_count": 3, "screening_candidate_count": 3,
		"succeeded_screening_attempt_count": 2, "failed_screening_attempt_count": failed,
		"winner_job_id": winnerJobID, "winner_flap_deflection_deg": winnerDeflection,
		"agreement": "pass",
	}
}

func buildEvaluationOptimizationSweep(
	t *testing.T, mutate func(*engineering.XFOILSpec, *engineering.XFOILSpec, *engineering.XFOILSpec, *map[string]any, *[]engineering.XFOILSample),
) (evaluationOptimizationFixture, error) {
	t.Helper()
	fixture := newEvaluationOptimizationFixture(t)
	loser := evaluationOptimizationSpec(fixture, fixture.screening, 10, engineering.XFOILPurposeScreening, "")
	winner := evaluationOptimizationSpec(fixture, fixture.screening, 15, engineering.XFOILPurposeScreening, "")
	failed := evaluationOptimizationSpec(fixture, fixture.screening, 20, engineering.XFOILPurposeScreening, "")
	verification := evaluationOptimizationSpec(fixture, fixture.verification, 15,
		engineering.XFOILPurposeIndependentVerification, "eng_winner")
	verificationSamples := evaluationTwoPointPolar(.010, -.17)
	metric := standardEvaluationVerificationMetric(1, "eng_winner", 15)
	if mutate != nil {
		mutate(&loser, &winner, &verification, &metric, &verificationSamples)
	}
	// The lowest-CD raw candidate is intentionally infeasible. The deterministic
	// winner must be the minimum-CD member of the feasible set, not the raw set.
	recordEvaluationXFOILJob(t, fixture, "eng_loser", loser, "succeeded", evaluationTwoPointPolar(.005, -.30), nil)
	recordEvaluationXFOILJob(t, fixture, "eng_winner", winner, "succeeded", evaluationTwoPointPolar(.010, -.17), nil)
	recordEvaluationXFOILJob(t, fixture, "eng_failed", failed, "failed", nil, nil)
	recordEvaluationXFOILJob(t, fixture, "eng_verify", verification, "succeeded", verificationSamples, metric)
	_, err := VerifyXFOILOptimization(context.Background(), fixture.database, fixture.objects, fixture.run.ID)
	return fixture, err
}

func TestVerifyXFOILOptimizationRecomputesWinnerAndCanonicalDefaults(t *testing.T) {
	fixture, err := buildEvaluationOptimizationSweep(t, func(
		_ *engineering.XFOILSpec, winner, verification *engineering.XFOILSpec,
		metric *map[string]any, _ *[]engineering.XFOILSample,
	) {
		ncrit, iterations, panels := 9.0, 250, 160
		winner.NCrit, winner.Iterations, winner.PanelCount = &ncrit, &iterations, &panels
		verification.NCrit, verification.Iterations = nil, nil
		verificationPanels := 240
		verification.PanelCount = &verificationPanels
		negativeZero, positiveZero := math.Copysign(0, -1), 0.0
		winner.FlapDeflectionDeg, verification.FlapDeflectionDeg = &negativeZero, &positiveZero
		(*metric)["winner_flap_deflection_deg"] = 0.0
	})
	if err != nil {
		t.Fatal(err)
	}
	proof, err := VerifyXFOILOptimization(context.Background(), fixture.database, fixture.objects, fixture.run.ID)
	if err != nil || !proof.Required || proof.WinnerJobID != "eng_winner" ||
		proof.VerificationJobID != "eng_verify" || proof.FailedScreeningAttemptCount != 1 ||
		proof.WinnerTarget.CD != .010 || !evaluationDigest(proof.WinnerReceiptBlobSHA256) ||
		!evaluationDigest(proof.VerificationReceiptBlobSHA256) ||
		proof.WinnerPhysicalArgumentsSHA256 == proof.VerificationPhysicalSHA256 {
		t.Fatalf("unexpected independently recomputed proof: %+v err=%v", proof, err)
	}
}

func TestVerifyXFOILOptimizationRejectsMixedRuntimeSweep(t *testing.T) {
	fixture := newEvaluationOptimizationFixture(t)
	loser := evaluationOptimizationSpec(fixture, fixture.screening, 10, engineering.XFOILPurposeScreening, "")
	winner := evaluationOptimizationSpec(fixture, fixture.screening, 15, engineering.XFOILPurposeScreening, "")
	failed := evaluationOptimizationSpec(fixture, fixture.screening, 20, engineering.XFOILPurposeScreening, "")
	verification := evaluationOptimizationSpec(fixture, fixture.verification, 15,
		engineering.XFOILPurposeIndependentVerification, "eng_winner")
	recordEvaluationXFOILJob(t, fixture, "eng_loser", loser, "succeeded", evaluationTwoPointPolar(.021, -.10), nil)
	otherRuntime := fixture
	otherRuntime.runtimeHash = strings.Repeat("b", 64)
	recordEvaluationXFOILJob(t, otherRuntime, "eng_winner", winner, "succeeded", evaluationTwoPointPolar(.010, -.17), nil)
	recordEvaluationXFOILJob(t, fixture, "eng_failed", failed, "failed", nil, nil)
	recordEvaluationXFOILJob(t, otherRuntime, "eng_verify", verification, "succeeded",
		evaluationTwoPointPolar(.010, -.17), standardEvaluationVerificationMetric(1, "eng_winner", 15))
	_, err := VerifyXFOILOptimization(context.Background(), fixture.database, fixture.objects, fixture.run.ID)
	if err == nil || !strings.Contains(err.Error(), "homogeneous runtime bundle") {
		t.Fatalf("mixed-runtime screening sweep was accepted: %v", err)
	}
}

func TestVerifyXFOILOptimizationRejectsContractAndResultDrift(t *testing.T) {
	tests := []struct {
		name   string
		want   string
		mutate func(*engineering.XFOILSpec, *engineering.XFOILSpec, *engineering.XFOILSpec, *map[string]any, *[]engineering.XFOILSample)
	}{
		{"nonwinner source", "not deterministic feasible minimum-CD winner", func(_, _ *engineering.XFOILSpec, verification *engineering.XFOILSpec, _ *map[string]any, _ *[]engineering.XFOILSample) {
			verification.VerificationOfJobID = "eng_loser"
			*verification.FlapDeflectionDeg = 10
		}},
		{"heterogeneous sweep", "homogeneous", func(_, winner *engineering.XFOILSpec, _ *engineering.XFOILSpec, _ *map[string]any, _ *[]engineering.XFOILSample) {
			winner.Reynolds = 2e6
		}},
		{"missing contract", "optimization contract", func(_, winner *engineering.XFOILSpec, _ *engineering.XFOILSpec, _ *map[string]any, _ *[]engineering.XFOILSample) {
			winner.MinimumCM = nil
		}},
		{"changed target", "homogeneous", func(_, winner *engineering.XFOILSpec, _ *engineering.XFOILSpec, _ *map[string]any, _ *[]engineering.XFOILSample) {
			value := .85
			winner.TargetCL = &value
		}},
		{"failed count bypass", "counts", func(_, _ *engineering.XFOILSpec, _ *engineering.XFOILSpec, metric *map[string]any, _ *[]engineering.XFOILSample) {
			(*metric)["failed_screening_attempt_count"] = 0
		}},
		{"target disagreement", "target metrics disagree", func(_, _ *engineering.XFOILSpec, _ *engineering.XFOILSpec, _ *map[string]any, samples *[]engineering.XFOILSample) {
			*samples = evaluationTwoPointPolar(.012, -.17)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := buildEvaluationOptimizationSweep(t, test.mutate)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("invalid optimization evidence was accepted: %v", err)
			}
		})
	}
}

func TestVerifyXFOILOptimizationKeepsLegacySingleExecution(t *testing.T) {
	fixture := newEvaluationOptimizationFixture(t)
	legacy := engineering.XFOILSpec{
		RunID: fixture.run.ID, StageAttemptID: fixture.screening.ID, NACA: "0012",
		Reynolds: 1e6, Mach: .1, AlphaStartDeg: -2, AlphaEndDeg: 4, AlphaStepDeg: 2,
	}
	recordEvaluationXFOILJob(t, fixture, "eng_legacy", legacy, "succeeded", evaluationTwoPointPolar(.01, -.1), nil)
	proof, err := VerifyXFOILOptimization(context.Background(), fixture.database, fixture.objects, fixture.run.ID)
	if err != nil || proof.Required {
		t.Fatalf("legacy single XFOIL execution was rejected: %+v err=%v", proof, err)
	}
}
