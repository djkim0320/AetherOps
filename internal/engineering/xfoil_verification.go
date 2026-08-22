package engineering

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
)

const (
	// Independent verification deliberately changes the numerical resolution
	// while preserving the selected aerodynamic subject. These constants are
	// part of the deterministic XFOIL optimization contract and are shared by
	// the live service and the offline release verifier.
	XFOILVerificationMinimumPanelCount = 240
	XFOILVerificationPanelScale        = 1.5
	XFOILVerificationPanelRoundTo      = 10
	XFOILVerificationHalfWindowDeg     = 0.5
	XFOILVerificationMaximumStepDeg    = 0.05
	// Models commonly serialize the CAS-derived target alpha to five decimal
	// places. Permit only that bounded endpoint quantization when checking
	// containment; this is intentionally separate from generic floating-point
	// comparison tolerance and does not relax any physical or grid invariant.
	XFOILVerificationBoundaryQuantizationDeg = 5e-6

	XFOILVerificationCDAbsoluteTolerance = 0.0005
	XFOILVerificationCDRelativeTolerance = 0.05
	XFOILVerificationCMTolerance         = 0.01
)

// RequiredXFOILVerificationPanelCount derives the one allowed verification
// panel count from the screening setup. It rounds a 50% increase upward to a
// multiple of ten, applies the 240-panel floor, and never exceeds the XFOIL
// adapter's 300-panel envelope. A screening run that already consumes the
// envelope cannot claim an independent panel-convergence check.
func RequiredXFOILVerificationPanelCount(screening XFOILSpec) (int, error) {
	panels := 160
	if screening.PanelCount != nil {
		panels = *screening.PanelCount
	}
	if panels < 80 || panels > 300 {
		return 0, errors.New("screening panel_count is outside the supported 80..300 envelope")
	}
	scaled := math.Ceil(float64(panels)*XFOILVerificationPanelScale/
		XFOILVerificationPanelRoundTo) * XFOILVerificationPanelRoundTo
	required := int(scaled)
	if required < XFOILVerificationMinimumPanelCount {
		required = XFOILVerificationMinimumPanelCount
	}
	if required > 300 {
		required = 300
	}
	if required <= panels {
		return 0, fmt.Errorf("screening panel_count=%d leaves no independent verification resolution within the 300-panel envelope", panels)
	}
	return required, nil
}

// ValidateIndependentXFOILContract separates invariant aerodynamic inputs
// from the numerical sampling that must change for an independent run. The
// requested range may be wider than the preferred local window; this keeps an
// explicitly expanded bracket valid when a local target-CL bracket is known to
// be inadequate, while still rejecting a reused coarse screening grid.
func ValidateIndependentXFOILContract(screening, verification XFOILSpec, targetAlphaDeg float64) error {
	if screening.ExecutionPurpose != XFOILPurposeScreening ||
		verification.ExecutionPurpose != XFOILPurposeIndependentVerification {
		return errors.New("independent XFOIL contract requires screening and independent_verification purposes")
	}
	if !xfoilContractFinite(targetAlphaDeg) {
		return errors.New("independent XFOIL contract requires a finite screening target alpha")
	}
	screeningSubject, err := xfoilVerificationSubjectIdentity(screening)
	if err != nil {
		return fmt.Errorf("normalize screening subject: %w", err)
	}
	verificationSubject, err := xfoilVerificationSubjectIdentity(verification)
	if err != nil {
		return fmt.Errorf("normalize verification subject: %w", err)
	}
	if !bytes.Equal(screeningSubject, verificationSubject) {
		return errors.New("independent XFOIL verification changes an invariant aerodynamic, flap, transition, iteration, objective, target, or constraint input")
	}

	requiredPanels, err := RequiredXFOILVerificationPanelCount(screening)
	if err != nil {
		return err
	}
	verificationPanels := 160
	if verification.PanelCount != nil {
		verificationPanels = *verification.PanelCount
	}
	if verificationPanels != requiredPanels {
		return fmt.Errorf("independent XFOIL verification requires panel_count=%d, got %d", requiredPanels, verificationPanels)
	}

	maximumStep := math.Min(screening.AlphaStepDeg, XFOILVerificationMaximumStepDeg)
	if verification.AlphaStepDeg > maximumStep+xfoilContractTolerance(maximumStep) {
		return fmt.Errorf("independent XFOIL verification requires alpha_step_deg<=%.12g, got %.12g", maximumStep, verification.AlphaStepDeg)
	}
	localStart := math.Max(-15, targetAlphaDeg-XFOILVerificationHalfWindowDeg)
	localEnd := math.Min(20, targetAlphaDeg+XFOILVerificationHalfWindowDeg)
	if verification.AlphaStartDeg > localStart+XFOILVerificationBoundaryQuantizationDeg ||
		verification.AlphaEndDeg < localEnd-XFOILVerificationBoundaryQuantizationDeg {
		return fmt.Errorf("independent XFOIL verification alpha range [%.12g, %.12g] must contain the target-local window [%.12g, %.12g]",
			verification.AlphaStartDeg, verification.AlphaEndDeg, localStart, localEnd)
	}
	return nil
}

// XFOILIndependentTargetsAgree implements the user-visible practical
// verification criterion. Target CL must remain exact, drag may differ by the
// larger of 0.0005 and 5%, and pitching moment may differ by at most 0.01.
func XFOILIndependentTargetsAgree(expectedCL, expectedCD, expectedCM, actualCL, actualCD, actualCM float64) bool {
	if !xfoilContractFinite(expectedCL, expectedCD, expectedCM, actualCL, actualCD, actualCM) {
		return false
	}
	clTolerance := 1e-8 * math.Max(1, math.Max(math.Abs(expectedCL), math.Abs(actualCL)))
	if math.Abs(expectedCL-actualCL) > clTolerance {
		return false
	}
	cdTolerance := math.Max(XFOILVerificationCDAbsoluteTolerance,
		XFOILVerificationCDRelativeTolerance*math.Abs(expectedCD))
	return math.Abs(expectedCD-actualCD) <= cdTolerance+xfoilContractTolerance(cdTolerance) &&
		math.Abs(expectedCM-actualCM) <= XFOILVerificationCMTolerance+xfoilContractTolerance(XFOILVerificationCMTolerance)
}

func xfoilVerificationSubjectIdentity(spec XFOILSpec) ([]byte, error) {
	if err := normalizeXFOILVerificationIdentityDefaults(&spec); err != nil {
		return nil, err
	}
	spec.RunID = ""
	spec.StageAttemptID = ""
	spec.ExecutionPurpose = ""
	spec.VerificationOfJobID = ""
	spec.AlphaStartDeg = 0
	spec.AlphaEndDeg = 0
	spec.AlphaStepDeg = 0
	spec.PanelCount = nil
	return json.Marshal(spec)
}

func xfoilContractTolerance(value float64) float64 {
	return 1e-10 * math.Max(1, math.Abs(value))
}

func normalizeXFOILVerificationIdentityDefaults(spec *XFOILSpec) error {
	if spec == nil || spec.NACA == "" || !xfoilContractFinite(
		spec.Reynolds, spec.Mach, spec.AlphaStartDeg, spec.AlphaEndDeg, spec.AlphaStepDeg,
	) || spec.AlphaEndDeg <= spec.AlphaStartDeg || spec.AlphaStepDeg <= 0 {
		return errors.New("XFOIL verification identity contains invalid core inputs")
	}
	if spec.NCrit == nil {
		value := 9.0
		spec.NCrit = &value
	}
	if spec.Iterations == nil {
		value := 250
		spec.Iterations = &value
	}
	if !xfoilContractFinite(*spec.NCrit) || *spec.NCrit < 1 || *spec.NCrit > 14 ||
		*spec.Iterations < 50 || *spec.Iterations > 500 {
		return errors.New("XFOIL verification identity contains invalid transition or iteration settings")
	}
	if spec.FlapChordRatio == nil || spec.FlapHingeXOverC == nil ||
		spec.FlapHingeYOverC == nil || spec.FlapDeflectionDeg == nil ||
		spec.TargetCL == nil || spec.MinimumCM == nil ||
		!xfoilContractFinite(*spec.FlapChordRatio, *spec.FlapHingeXOverC, *spec.FlapHingeYOverC,
			*spec.FlapDeflectionDeg, *spec.TargetCL, *spec.MinimumCM) {
		return errors.New("XFOIL verification identity requires finite flap, target, and constraint inputs")
	}
	if spec.FlapDeflectionDeg != nil && *spec.FlapDeflectionDeg == 0 {
		zero := 0.0
		spec.FlapDeflectionDeg = &zero
	}
	return nil
}

func xfoilContractFinite(values ...float64) bool {
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
	}
	return true
}
