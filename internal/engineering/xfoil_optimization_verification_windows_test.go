//go:build windows && amd64

package engineering

import (
	"context"
	"errors"
	"math"
	"os"
	"strings"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/core"
	managedruntime "github.com/djkim0320/Aether-claw/internal/runtime"
)

func optimizationScreeningSpec(
	fixture receiptServiceSecurityFixture, deflection float64,
) XFOILSpec {
	chord, hingeX, hingeY := .3, .7, 0.0
	targetCL, minimumCM := .8, -.2
	return XFOILSpec{
		RunID: fixture.run.ID, StageAttemptID: fixture.attempt.ID, NACA: "0015",
		Reynolds: 1e6, Mach: .1, AlphaStartDeg: -6, AlphaEndDeg: 18, AlphaStepDeg: .25,
		ExecutionPurpose:      XFOILPurposeScreening,
		OptimizationObjective: XFOILObjectiveMinimizeCDAtTargetCL,
		TargetCL:              &targetCL, MinimumCM: &minimumCM,
		FlapChordRatio: &chord, FlapHingeXOverC: &hingeX,
		FlapHingeYOverC: &hingeY, FlapDeflectionDeg: &deflection,
	}
}

func recordOptimizationScreening(
	t *testing.T,
	fixture receiptServiceSecurityFixture,
	spec XFOILSpec,
	samples []XFOILSample,
	failure error,
) (JobResult, error) {
	t.Helper()
	approveReceiptServiceJob(t, fixture, fixture.attempt, "xfoil_polar", spec)
	return fixture.service.execute(
		context.Background(), fixture.run.ID, fixture.attempt.ID,
		"xfoil_polar", "xfoil", managedruntime.PinnedXFOILVersion, spec,
		func(context.Context, string) (operationOutput, error) {
			if failure != nil {
				return operationOutput{}, failure
			}
			return operationOutput{
				metrics:   map[string]any{"samples": samples},
				exitCodes: []int{0}, numericallyValid: true,
			}, nil
		},
	)
}

func twoPointPolar(cd, cm float64) []XFOILSample {
	return []XFOILSample{
		{Alpha: 0, CL: .7, CD: cd - .001, CM: cm + .01},
		{Alpha: 2, CL: .9, CD: cd + .001, CM: cm - .01},
	}
}

func twoPointPolarAtTargetAlpha(targetAlpha, cd, cm float64) []XFOILSample {
	return []XFOILSample{
		{Alpha: targetAlpha - .5, CL: .7, CD: cd - .001, CM: cm + .01},
		{Alpha: targetAlpha + .5, CL: .9, CD: cd + .001, CM: cm - .01},
	}
}

func beginOptimizationVerificationAttempt(
	t *testing.T, fixture receiptServiceSecurityFixture,
) string {
	t.Helper()
	attempt, err := fixture.database.BeginStage(
		context.Background(), fixture.run.ID, core.StageCollect, core.EngineeringVerificationOrdinal,
		"verification-thread", "verification-turn",
	)
	if err != nil {
		t.Fatal(err)
	}
	return attempt.ID
}

func configureIndependentOptimizationVerification(spec *XFOILSpec) {
	panels := 240
	spec.PanelCount = &panels
	spec.AlphaStartDeg = .5
	spec.AlphaEndDeg = 1.5
	spec.AlphaStepDeg = .05
}

func TestXFOILOptimizationIdentityCanonicalizesExplicitDefaults(t *testing.T) {
	fixture := newReceiptServiceSecurityFixture(t)
	omitted := optimizationScreeningSpec(fixture, 15)
	explicit := optimizationScreeningSpec(fixture, 15)
	ncrit, iterations, panels := 9.0, 250, 160
	explicit.NCrit, explicit.Iterations, explicit.PanelCount = &ncrit, &iterations, &panels
	left, err := xfoilPhysicalIdentity(omitted)
	if err != nil {
		t.Fatal(err)
	}
	right, err := xfoilPhysicalIdentity(explicit)
	if err != nil {
		t.Fatal(err)
	}
	if string(left) != string(right) {
		t.Fatalf("omitted and explicit XFOIL defaults differ:\n%s\n%s", left, right)
	}
}

func TestIndependentXFOILRejectsWrongWinnerBeforeExecutionAndCountsFailures(t *testing.T) {
	fixture := newReceiptServiceSecurityFixture(t)
	loser, err := recordOptimizationScreening(
		t, fixture, optimizationScreeningSpec(fixture, 10), twoPointPolar(.021, -.10), nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	winner, err := recordOptimizationScreening(
		t, fixture, optimizationScreeningSpec(fixture, 15), twoPointPolar(.010, -.17), nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := recordOptimizationScreening(
		t, fixture, optimizationScreeningSpec(fixture, 20), nil, errors.New("solver did not converge"),
	); err == nil {
		t.Fatal("failed screening fixture unexpectedly succeeded")
	}
	verificationAttemptID := beginOptimizationVerificationAttempt(t, fixture)
	verification := optimizationScreeningSpec(fixture, 10)
	verification.StageAttemptID = verificationAttemptID
	verification.ExecutionPurpose = XFOILPurposeIndependentVerification
	verification.VerificationOfJobID = loser.JobID
	configureIndependentOptimizationVerification(&verification)

	before, err := fixture.database.ListRunEngineeringJobs(context.Background(), fixture.run.ID, "xfoil_polar")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.XFOILPolar(context.Background(), verification); err == nil ||
		!strings.Contains(err.Error(), "deterministic sweep winner") {
		t.Fatalf("nonwinner verification source was not rejected before execution: %v", err)
	}
	after, err := fixture.database.ListRunEngineeringJobs(context.Background(), fixture.run.ID, "xfoil_polar")
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("wrong winner created an engineering job before rejection: before=%d after=%d", len(before), len(after))
	}

	verification = optimizationScreeningSpec(fixture, 15)
	verification.StageAttemptID = verificationAttemptID
	verification.ExecutionPurpose = XFOILPurposeIndependentVerification
	verification.VerificationOfJobID = winner.JobID
	configureIndependentOptimizationVerification(&verification)
	contract, err := fixture.service.validateIndependentXFOIL(context.Background(), verification)
	if err != nil {
		t.Fatal(err)
	}
	if contract.WinnerJob.ID != winner.JobID || contract.ScreeningAttemptCount != 3 ||
		contract.ScreeningCandidateCount != 3 || contract.SucceededAttemptCount != 2 ||
		contract.FailedAttemptCount != 1 || math.Abs(contract.WinnerTarget.CD-.010) > 1e-12 {
		t.Fatalf("unexpected deterministic sweep contract: %+v", contract)
	}
}

func TestIndependentXFOILPreflightRejectionWithoutJobFailsNotUncertain(t *testing.T) {
	ctx := context.Background()
	fixture := newReceiptServiceSecurityFixture(t)
	loser, err := recordOptimizationScreening(
		t, fixture, optimizationScreeningSpec(fixture, 10), twoPointPolar(.021, -.10), nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := recordOptimizationScreening(
		t, fixture, optimizationScreeningSpec(fixture, 15), twoPointPolar(.010, -.17), nil,
	); err != nil {
		t.Fatal(err)
	}
	if err := fixture.database.CompleteStage(ctx, fixture.attempt.ID, "", ""); err != nil {
		t.Fatal(err)
	}
	verificationAttemptID := beginOptimizationVerificationAttempt(t, fixture)
	verification := optimizationScreeningSpec(fixture, 10)
	verification.StageAttemptID = verificationAttemptID
	verification.ExecutionPurpose = XFOILPurposeIndependentVerification
	verification.VerificationOfJobID = loser.JobID
	configureIndependentOptimizationVerification(&verification)
	approveReceiptServiceJob(t, fixture, core.StageAttempt{
		ID: verificationAttemptID, CodexThreadID: "verification-thread",
	}, "xfoil_polar", verification)

	if _, err := fixture.service.XFOILPolar(ctx, verification); err == nil ||
		!strings.Contains(err.Error(), "deterministic sweep winner") {
		t.Fatalf("wrong-winner preflight result = %v", err)
	}
	var jobs int
	var marked bool
	if err := fixture.database.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM engineering_jobs WHERE stage_attempt_id=?", verificationAttemptID,
	).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if err := fixture.database.SQL().QueryRowContext(ctx,
		"SELECT external_side_effects FROM stage_attempts WHERE id=?", verificationAttemptID,
	).Scan(&marked); err != nil {
		t.Fatal(err)
	}
	if jobs != 0 || marked {
		t.Fatalf("preflight rejection crossed admission boundary: jobs=%d marker=%v", jobs, marked)
	}
	quiesced, err := fixture.database.FailCollectStageAndQuiesceRun(
		ctx, verificationAttemptID, "", "independent verification preflight rejected",
	)
	if err != nil {
		t.Fatal(err)
	}
	if quiesced.Status != core.RunFailed {
		t.Fatalf("preflight rejection quiesced run as %s, want failed", quiesced.Status)
	}
}

func TestIndependentXFOILLiveEndpointQuantizationPreflightCreatesNoJob(t *testing.T) {
	const targetAlpha = -2.9813167259786475
	fixture := newReceiptServiceSecurityFixture(t)
	if _, err := recordOptimizationScreening(
		t, fixture, optimizationScreeningSpec(fixture, 10), twoPointPolarAtTargetAlpha(targetAlpha, .021, -.10), nil,
	); err != nil {
		t.Fatal(err)
	}
	winner, err := recordOptimizationScreening(
		t, fixture, optimizationScreeningSpec(fixture, 15), twoPointPolarAtTargetAlpha(targetAlpha, .010, -.17), nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	verification := optimizationScreeningSpec(fixture, 15)
	verification.StageAttemptID = beginOptimizationVerificationAttempt(t, fixture)
	verification.ExecutionPurpose = XFOILPurposeIndependentVerification
	verification.VerificationOfJobID = winner.JobID
	panels := 240
	verification.PanelCount = &panels
	verification.AlphaStartDeg = -3.48132
	verification.AlphaEndDeg = -2.48132
	verification.AlphaStepDeg = .05

	before, err := fixture.database.ListRunEngineeringJobs(context.Background(), fixture.run.ID, "xfoil_polar")
	if err != nil {
		t.Fatal(err)
	}
	contract, err := fixture.service.validateIndependentXFOIL(context.Background(), verification)
	if err != nil {
		t.Fatalf("live five-decimal verification range failed preflight: %v", err)
	}
	if math.Abs(contract.WinnerTarget.AlphaDeg-targetAlpha) > 1e-12 {
		t.Fatalf("fixture winner target alpha = %.17g, want %.17g", contract.WinnerTarget.AlphaDeg, targetAlpha)
	}
	afterAccepted, err := fixture.database.ListRunEngineeringJobs(context.Background(), fixture.run.ID, "xfoil_polar")
	if err != nil {
		t.Fatal(err)
	}
	if len(afterAccepted) != len(before) {
		t.Fatalf("preflight-only acceptance created a job: before=%d after=%d", len(before), len(afterAccepted))
	}

	verification.AlphaEndDeg = targetAlpha + XFOILVerificationHalfWindowDeg -
		XFOILVerificationBoundaryQuantizationDeg - 1e-7
	if _, err := fixture.service.validateIndependentXFOIL(context.Background(), verification); err == nil ||
		!strings.Contains(err.Error(), "target-local window") {
		t.Fatalf("range beyond endpoint quantization allowance passed preflight: %v", err)
	}
	afterRejected, err := fixture.database.ListRunEngineeringJobs(context.Background(), fixture.run.ID, "xfoil_polar")
	if err != nil {
		t.Fatal(err)
	}
	if len(afterRejected) != len(before) {
		t.Fatalf("rejected preflight created a job: before=%d after=%d", len(before), len(afterRejected))
	}
}

func TestIndependentXFOILCASVerifiesEverySucceededScreeningReceipt(t *testing.T) {
	fixture := newReceiptServiceSecurityFixture(t)
	first, err := recordOptimizationScreening(
		t, fixture, optimizationScreeningSpec(fixture, 10), twoPointPolar(.021, -.10), nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	winner, err := recordOptimizationScreening(
		t, fixture, optimizationScreeningSpec(fixture, 15), twoPointPolar(.010, -.17), nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	receiptHash := ""
	for _, artifact := range first.Artifacts {
		if artifact.Role == "receipt" {
			receiptHash = artifact.SHA256
			break
		}
	}
	if receiptHash == "" {
		t.Fatal("screening job has no receipt artifact")
	}
	receiptPath, err := fixture.objects.Path(receiptHash)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(receiptPath, []byte("tampered screening receipt"), 0o600); err != nil {
		t.Fatal(err)
	}
	verification := optimizationScreeningSpec(fixture, 15)
	verification.StageAttemptID = beginOptimizationVerificationAttempt(t, fixture)
	verification.ExecutionPurpose = XFOILPurposeIndependentVerification
	verification.VerificationOfJobID = winner.JobID
	configureIndependentOptimizationVerification(&verification)
	if _, err := fixture.service.validateIndependentXFOIL(context.Background(), verification); err == nil ||
		!strings.Contains(err.Error(), "CAS-verify screening receipt") {
		t.Fatalf("tampered nonwinner screening receipt was not CAS-verified: %v", err)
	}
}

func TestIndependentXFOILRejectsHeterogeneousSweepAndSourceSpecTamper(t *testing.T) {
	t.Run("heterogeneous", func(t *testing.T) {
		fixture := newReceiptServiceSecurityFixture(t)
		first, err := recordOptimizationScreening(
			t, fixture, optimizationScreeningSpec(fixture, 10), twoPointPolar(.021, -.10), nil,
		)
		if err != nil {
			t.Fatal(err)
		}
		different := optimizationScreeningSpec(fixture, 15)
		different.Reynolds = 2e6
		if _, err := recordOptimizationScreening(t, fixture, different, twoPointPolar(.010, -.17), nil); err != nil {
			t.Fatal(err)
		}
		verification := optimizationScreeningSpec(fixture, 10)
		verification.StageAttemptID = beginOptimizationVerificationAttempt(t, fixture)
		verification.ExecutionPurpose = XFOILPurposeIndependentVerification
		verification.VerificationOfJobID = first.JobID
		configureIndependentOptimizationVerification(&verification)
		if _, err := fixture.service.validateIndependentXFOIL(context.Background(), verification); err == nil ||
			!strings.Contains(err.Error(), "homogeneous") {
			t.Fatalf("heterogeneous sweep was accepted: %v", err)
		}
	})

	t.Run("source spec tamper", func(t *testing.T) {
		fixture := newReceiptServiceSecurityFixture(t)
		if _, err := recordOptimizationScreening(
			t, fixture, optimizationScreeningSpec(fixture, 10), twoPointPolar(.021, -.10), nil,
		); err != nil {
			t.Fatal(err)
		}
		winner, err := recordOptimizationScreening(
			t, fixture, optimizationScreeningSpec(fixture, 15), twoPointPolar(.010, -.17), nil,
		)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.database.SQL().ExecContext(
			context.Background(), `UPDATE engineering_jobs SET spec_json=spec_json || ' ' WHERE id=?`, winner.JobID,
		); err != nil {
			t.Fatal(err)
		}
		verification := optimizationScreeningSpec(fixture, 15)
		verification.StageAttemptID = beginOptimizationVerificationAttempt(t, fixture)
		verification.ExecutionPurpose = XFOILPurposeIndependentVerification
		verification.VerificationOfJobID = winner.JobID
		configureIndependentOptimizationVerification(&verification)
		if _, err := fixture.service.validateIndependentXFOIL(context.Background(), verification); err == nil ||
			!strings.Contains(err.Error(), "specification hash") {
			t.Fatalf("source SpecJSON tamper was accepted: %v", err)
		}
	})
}

func TestIndependentXFOILReadbackRejectsMismatchedSolverResult(t *testing.T) {
	fixture := newReceiptServiceSecurityFixture(t)
	if _, err := recordOptimizationScreening(
		t, fixture, optimizationScreeningSpec(fixture, 10), twoPointPolar(.021, -.10), nil,
	); err != nil {
		t.Fatal(err)
	}
	winner, err := recordOptimizationScreening(
		t, fixture, optimizationScreeningSpec(fixture, 15), twoPointPolar(.010, -.17), nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	verification := optimizationScreeningSpec(fixture, 15)
	verification.StageAttemptID = beginOptimizationVerificationAttempt(t, fixture)
	verification.ExecutionPurpose = XFOILPurposeIndependentVerification
	verification.VerificationOfJobID = winner.JobID
	configureIndependentOptimizationVerification(&verification)
	contract, err := fixture.service.validateIndependentXFOIL(context.Background(), verification)
	if err != nil {
		t.Fatal(err)
	}
	approveReceiptServiceJob(t, fixture, core.StageAttempt{
		ID: verification.StageAttemptID, CodexThreadID: "verification-thread",
	}, "xfoil_polar", verification)
	result, err := fixture.service.execute(
		context.Background(), fixture.run.ID, verification.StageAttemptID,
		"xfoil_polar", "xfoil", managedruntime.PinnedXFOILVersion, verification,
		func(context.Context, string) (operationOutput, error) {
			return operationOutput{
				metrics:   map[string]any{"samples": twoPointPolar(.012, -.17)},
				exitCodes: []int{0}, numericallyValid: true,
			}, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.validateIndependentXFOILReadback(
		context.Background(), verification, result, *contract,
	); err == nil || !strings.Contains(err.Error(), "exceed CD tolerance") {
		t.Fatalf("mismatched independent solver receipt was accepted: %v", err)
	}
}

func TestXFOILOptimizationContractAndStrictTargetAgreement(t *testing.T) {
	legacy := XFOILSpec{
		RunID: "run", StageAttemptID: "attempt", NACA: "0015",
		Reynolds: 1e6, Mach: .1, AlphaStartDeg: -6, AlphaEndDeg: 18, AlphaStepDeg: .25,
	}
	if err := validateXFOILSpec(legacy); err != nil {
		t.Fatalf("legacy single XFOIL request stopped working: %v", err)
	}
	screening := legacy
	screening.ExecutionPurpose = XFOILPurposeScreening
	if err := validateXFOILSpec(screening); err == nil || !strings.Contains(err.Error(), "target_cl") {
		t.Fatalf("explicit screening omitted its optimization contract: %v", err)
	}

	expected := xfoilTargetMetrics{
		AlphaDeg: 1, CL: .8, CD: .01, CM: -.17, FlapDeflectionDeg: 15, ConstraintSatisfied: true,
	}
	within := expected
	within.CD += 1e-10
	if err := requireXFOILExactTargetAgreement(expected, within); err != nil {
		t.Fatalf("strict numerical noise tolerance rejected an agreeing result: %v", err)
	}
	mismatch := expected
	mismatch.CD += 1e-5
	if err := requireXFOILExactTargetAgreement(expected, mismatch); err == nil {
		t.Fatal("materially different independent result was accepted")
	}

	// Multiple target-CL crossings are reduced deterministically: lowest CD,
	// then lowest alpha. This avoids dependence on receipt/map iteration order.
	target, found, err := interpolateXFOILTarget([]XFOILSample{
		{Alpha: 0, CL: .7, CD: .020, CM: -.1},
		{Alpha: 1, CL: .9, CD: .022, CM: -.1},
		{Alpha: 2, CL: .7, CD: .010, CM: -.1},
	}, .8)
	if err != nil || !found || math.Abs(target.CD-.016) > 1e-12 || math.Abs(target.AlphaDeg-1.5) > 1e-12 {
		t.Fatalf("deterministic multi-crossing interpolation = %+v found=%v err=%v", target, found, err)
	}
	if target.Interpolation.LeftIndex != 1 || target.Interpolation.RightIndex != 2 ||
		math.Abs(target.Interpolation.Fraction-.5) > 1e-12 ||
		target.Interpolation.LeftValueHash != xfoilSampleHash(target.Interpolation.Left) ||
		target.Interpolation.RightValueHash != xfoilSampleHash(target.Interpolation.Right) {
		t.Fatalf("interpolation lineage is incomplete: %+v", target.Interpolation)
	}
}
