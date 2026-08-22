package engineering

import (
	"strings"
	"testing"
)

func verificationContractSpec(purpose string) XFOILSpec {
	chord, hingeX, hingeY, deflection := .3, .7, 0.0, 15.0
	targetCL, minimumCM := .8, -.2
	return XFOILSpec{
		RunID: "run", StageAttemptID: "attempt", NACA: "0015",
		Reynolds: 1e6, Mach: .1, AlphaStartDeg: -6, AlphaEndDeg: 18, AlphaStepDeg: .25,
		ExecutionPurpose: purpose, OptimizationObjective: XFOILObjectiveMinimizeCDAtTargetCL,
		TargetCL: &targetCL, MinimumCM: &minimumCM,
		FlapChordRatio: &chord, FlapHingeXOverC: &hingeX,
		FlapHingeYOverC: &hingeY, FlapDeflectionDeg: &deflection,
	}
}

func independentVerificationContractSpec() (XFOILSpec, XFOILSpec) {
	screening := verificationContractSpec(XFOILPurposeScreening)
	verification := verificationContractSpec(XFOILPurposeIndependentVerification)
	verification.RunID = "run"
	verification.StageAttemptID = "verification-attempt"
	verification.VerificationOfJobID = "screening-job"
	panels := 240
	verification.PanelCount = &panels
	verification.AlphaStartDeg = .5
	verification.AlphaEndDeg = 1.5
	verification.AlphaStepDeg = .05
	return screening, verification
}

func TestIndependentXFOILContractRejectsReusedScreeningResolution(t *testing.T) {
	screening := verificationContractSpec(XFOILPurposeScreening)
	reused := verificationContractSpec(XFOILPurposeIndependentVerification)
	reused.VerificationOfJobID = "screening-job"
	panels := 160
	reused.PanelCount = &panels
	if err := ValidateIndependentXFOILContract(screening, reused, 1); err == nil ||
		!strings.Contains(err.Error(), "panel_count=240") {
		t.Fatalf("160-panel full-sweep verification was not rejected: %v", err)
	}
}

func TestIndependentXFOILContractAcceptsRefinedLocalAndExpandedRange(t *testing.T) {
	screening, verification := independentVerificationContractSpec()
	if err := ValidateIndependentXFOILContract(screening, verification, 1); err != nil {
		t.Fatalf("240-panel local 0.05 verification was rejected: %v", err)
	}
	verification.AlphaStartDeg = -6
	verification.AlphaEndDeg = 18
	if err := ValidateIndependentXFOILContract(screening, verification, 1); err != nil {
		t.Fatalf("legitimate expanded-range verification was rejected: %v", err)
	}
}

func TestIndependentXFOILContractAllowsOnlyBoundedEndpointQuantization(t *testing.T) {
	const targetAlpha = -2.9813167259786475
	screening, verification := independentVerificationContractSpec()
	// Reproduces the live model's five-decimal request. The upper endpoint is
	// 3.2740213525e-6 degrees inside the exact target+0.5 boundary.
	verification.AlphaStartDeg = -3.48132
	verification.AlphaEndDeg = -2.48132
	if err := ValidateIndependentXFOILContract(screening, verification, targetAlpha); err != nil {
		t.Fatalf("five-decimal boundary quantization was rejected: %v", err)
	}

	localStart := targetAlpha - XFOILVerificationHalfWindowDeg
	localEnd := targetAlpha + XFOILVerificationHalfWindowDeg
	verification.AlphaStartDeg = localStart + XFOILVerificationBoundaryQuantizationDeg
	verification.AlphaEndDeg = localEnd - XFOILVerificationBoundaryQuantizationDeg
	if err := ValidateIndependentXFOILContract(screening, verification, targetAlpha); err != nil {
		t.Fatalf("exact boundary quantization allowance was rejected: %v", err)
	}

	verification.AlphaStartDeg = localStart + XFOILVerificationBoundaryQuantizationDeg + 1e-7
	verification.AlphaEndDeg = localEnd
	if err := ValidateIndependentXFOILContract(screening, verification, targetAlpha); err == nil ||
		!strings.Contains(err.Error(), "target-local window") {
		t.Fatalf("start endpoint beyond quantization allowance was accepted: %v", err)
	}
	verification.AlphaStartDeg = localStart
	verification.AlphaEndDeg = localEnd - XFOILVerificationBoundaryQuantizationDeg - 1e-7
	if err := ValidateIndependentXFOILContract(screening, verification, targetAlpha); err == nil ||
		!strings.Contains(err.Error(), "target-local window") {
		t.Fatalf("end endpoint beyond quantization allowance was accepted: %v", err)
	}
}

func TestIndependentXFOILContractRejectsInvariantAndLocalWindowDrift(t *testing.T) {
	screening, verification := independentVerificationContractSpec()
	verification.Reynolds = 2e6
	if err := ValidateIndependentXFOILContract(screening, verification, 1); err == nil ||
		!strings.Contains(err.Error(), "invariant") {
		t.Fatalf("changed Reynolds number was accepted: %v", err)
	}
	_, verification = independentVerificationContractSpec()
	verification.AlphaStartDeg = .6
	if err := ValidateIndependentXFOILContract(screening, verification, 1); err == nil ||
		!strings.Contains(err.Error(), "target-local window") {
		t.Fatalf("incomplete target-local window was accepted: %v", err)
	}
}

func TestIndependentXFOILPracticalAgreement(t *testing.T) {
	if !XFOILIndependentTargetsAgree(.8, .01, -.17, .8, .0105, -.16) {
		t.Fatal("boundary values of the practical CD/CM criterion were rejected")
	}
	if XFOILIndependentTargetsAgree(.8, .01, -.17, .8, .0105001, -.16) {
		t.Fatal("drag outside the practical criterion was accepted")
	}
	if XFOILIndependentTargetsAgree(.8, .02, -.17, .8, .021001, -.17) {
		t.Fatal("drag outside the 5-percent branch was accepted")
	}
	if XFOILIndependentTargetsAgree(.8, .01, -.17, .8, .01, -.1599) {
		t.Fatal("pitching moment outside the practical criterion was accepted")
	}
}
