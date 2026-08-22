//go:build windows && amd64

package engineering

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestXFOILPlainFlap97PointContractAndBatch(t *testing.T) {
	chord, hingeX, hingeY, deflection := .3, .7, 0.0, 30.0
	ncrit, iterations, panels := 9.0, 250, 160
	spec := XFOILSpec{
		RunID: "run", StageAttemptID: "attempt", NACA: "0015",
		Reynolds: 1e6, Mach: .1, AlphaStartDeg: -6, AlphaEndDeg: 18, AlphaStepDeg: .25,
		FlapChordRatio: &chord, FlapHingeXOverC: &hingeX,
		FlapHingeYOverC: &hingeY, FlapDeflectionDeg: &deflection,
		NCrit: &ncrit, Iterations: &iterations, PanelCount: &panels,
	}
	settings, err := normalizedXFOILSettings(spec)
	if err != nil {
		t.Fatal(err)
	}
	if got := len(settings.AlphaGrid); got != 97 {
		t.Fatalf("97-point alpha grid: got %d", got)
	}
	input := xfoilInput(spec, settings)
	for _, required := range []string{
		"NACA 0015\nXYCM 0.25 0\nGDES\nFLAP 0.7 0 30\nEXEC\n",
		"PPAR\nN 160\n\n\nPSAV geometry.dat\nOPER\n",
		"VISC 1000000\nMACH 0.1\nVPAR\nN 9\n\nITER 250\n",
		"PACC\npolar.txt\n\nASEQ -6 18 0.25\nPACC\n\nQUIT\n",
	} {
		if !strings.Contains(input, required) {
			t.Fatalf("XFOIL input omits required sequence %q:\n%s", required, input)
		}
	}
}

func TestXFOILPlainFlapValidationFailsClosed(t *testing.T) {
	base := XFOILSpec{RunID: "run", StageAttemptID: "attempt", NACA: "0015",
		Reynolds: 1e6, Mach: .1, AlphaStartDeg: -6, AlphaEndDeg: 18, AlphaStepDeg: .25}
	chord, hingeX, hingeY, deflection := .25, .7, 0.0, 5.0
	base.FlapChordRatio = &chord
	base.FlapHingeXOverC = &hingeX
	base.FlapHingeYOverC = &hingeY
	base.FlapDeflectionDeg = &deflection
	if err := validateXFOILSpec(base); err == nil || !strings.Contains(err.Error(), "must equal") {
		t.Fatalf("inconsistent flap chord must fail, got %v", err)
	}

	base.FlapChordRatio = nil
	if err := validateXFOILSpec(base); err == nil || !strings.Contains(err.Error(), "supplied together") {
		t.Fatalf("partial flap contract must fail, got %v", err)
	}

	chord = .3
	base.FlapChordRatio = &chord
	hingeY = .2
	if err := validateXFOILSpec(base); err == nil || !strings.Contains(err.Error(), "strictly inside") {
		t.Fatalf("hinge outside airfoil must fail, got %v", err)
	}

	base.FlapChordRatio, base.FlapHingeXOverC = nil, nil
	base.FlapHingeYOverC, base.FlapDeflectionDeg = nil, nil
	base.AlphaStepDeg = .26
	if err := validateXFOILSpec(base); err == nil || !strings.Contains(err.Error(), "integer multiple") {
		t.Fatalf("non-integral alpha grid must fail, got %v", err)
	}
}

func TestXFOILCandidateApprovalHashesIncludeDeflection(t *testing.T) {
	chord, hingeX, hingeY := .3, .7, 0.0
	seen := make(map[[sha256.Size]byte]float64)
	for _, angle := range []float64{0, 5, 10, 15, 20, 25, 30} {
		deflection := angle
		spec := XFOILSpec{
			RunID: "run", StageAttemptID: "attempt", NACA: "0015",
			Reynolds: 1e6, Mach: .1, AlphaStartDeg: -6, AlphaEndDeg: 18, AlphaStepDeg: .25,
			FlapChordRatio: &chord, FlapHingeXOverC: &hingeX,
			FlapHingeYOverC: &hingeY, FlapDeflectionDeg: &deflection,
		}
		encoded, err := canonicalJSON(spec)
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(encoded)
		if previous, duplicate := seen[digest]; duplicate {
			t.Fatalf("deflections %.1f and %.1f have the same approval hash", previous, angle)
		}
		seen[digest] = angle
	}
}

func TestXFOILPolarParserAndPointStatuses(t *testing.T) {
	polar := `
  alpha    CL        CD       CDp       CM     Top_Xtr  Bot_Xtr
 ------ -------- --------- --------- -------- -------- --------
  0.000   0.3500   0.01000   0.00400  -0.0500   0.8000   0.7000
  2.000   0.5500   0.01200   0.00500  -0.0600   0.7500   0.6500
`
	path := filepath.Join(t.TempDir(), "polar.txt")
	if err := os.WriteFile(path, []byte(polar), 0o600); err != nil {
		t.Fatal(err)
	}
	samples, err := parseXFOILPolar(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) != 2 || samples[0].CM != -.05 || samples[1].CDPressure != .005 ||
		samples[0].TopTransitionX != .8 || samples[1].BottomTransitionX != .65 {
		t.Fatalf("unexpected parsed XFOIL rows: %+v", samples)
	}
	points, err := classifyXFOILPoints([]float64{0, 1, 2, 3}, samples,
		"       a = 1.000      CL = 0.4\n VISCAL:  Convergence failed\n")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"converged", "nonconverged", "converged", "missing"}
	for index := range want {
		if points[index].Status != want[index] {
			t.Fatalf("point %d status: got %q want %q (%+v)", index, points[index].Status, want[index], points)
		}
	}
}

func TestXFOILPolarParserClampsPrintedTransitionBoundary(t *testing.T) {
	polar := `
  alpha    CL        CD       CDp       CM     Top_Xtr  Bot_Xtr
 ------ -------- --------- --------- -------- -------- --------
  0.000   0.3500   0.01000   0.00400  -0.0500  -0.0001   1.0001
`
	path := filepath.Join(t.TempDir(), "polar.txt")
	if err := os.WriteFile(path, []byte(polar), 0o600); err != nil {
		t.Fatal(err)
	}
	samples, err := parseXFOILPolar(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) != 1 || samples[0].TopTransitionX != 0 || samples[0].BottomTransitionX != 1 {
		t.Fatalf("printed transition boundary was not clamped: %+v", samples)
	}
}

func TestXFOILPolarParserRejectsMalformedNumericRows(t *testing.T) {
	for name, body := range map[string]string{
		"short":      "0.000 0.3 0.01\n",
		"duplicate":  "0.000 0.3 0.01 0.004 -0.05 0.8 0.7\n0.000 0.4 0.02 0.005 -0.04 0.7 0.6\n",
		"transition": "0.000 0.3 0.01 0.004 -0.05 1.2 0.7\n",
		"nonfinite":  "0.000 NaN 0.01 0.004 -0.05 0.8 0.7\n",
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "polar.txt")
			header := "  alpha CL CD CDp CM Top_Xtr Bot_Xtr\n  ------ -------- -------- -------- -------- -------- --------\n"
			if err := os.WriteFile(path, []byte(header+body), 0o600); err != nil {
				t.Fatal(err)
			}
			if samples, err := parseXFOILPolar(path); err == nil {
				t.Fatalf("malformed polar unexpectedly parsed: %s", fmt.Sprint(samples))
			}
		})
	}
}

// TestRealXFOILPlainFlap97PointBatch is opt-in and executes the pinned binary
// directly. It verifies the exact generated stdin contract and real seven-column
// polar output; it never substitutes a solver fixture for a successful run.
func TestRealXFOILPlainFlap97PointBatch(t *testing.T) {
	executable := os.Getenv("AETHEROPS_E2E_XFOIL")
	if executable == "" {
		t.Skip("real managed XFOIL path is not configured")
	}
	chord, hingeX, hingeY, deflection := .3, .7, 0.0, 30.0
	ncrit, iterations, panels := 9.0, 250, 160
	spec := XFOILSpec{
		RunID: "real-run", StageAttemptID: "real-attempt", NACA: "0015",
		Reynolds: 1e6, Mach: .1, AlphaStartDeg: -6, AlphaEndDeg: 18, AlphaStepDeg: .25,
		FlapChordRatio: &chord, FlapHingeXOverC: &hingeX,
		FlapHingeYOverC: &hingeY, FlapDeflectionDeg: &deflection,
		NCrit: &ncrit, Iterations: &iterations, PanelCount: &panels,
	}
	settings, err := normalizedXFOILSettings(spec)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	directory := t.TempDir()
	command := exec.CommandContext(ctx, executable)
	command.Dir = directory
	command.Stdin = strings.NewReader(xfoilInput(spec, settings))
	started := time.Now()
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("real XFOIL failed: %v\n%s", err, string(output))
	}
	samples, err := parseXFOILPolar(filepath.Join(directory, "polar.txt"))
	if err != nil {
		t.Fatalf("parse real XFOIL polar: %v", err)
	}
	points, err := classifyXFOILPoints(settings.AlphaGrid, samples, string(output))
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) != 97 || len(points) != 97 {
		t.Fatalf("real XFOIL point count: samples=%d statuses=%d", len(samples), len(points))
	}
	for index, point := range points {
		if point.Status != xfoilPointConverged {
			t.Fatalf("real XFOIL point %d: %+v", index, point)
		}
	}
	if info, err := os.Stat(filepath.Join(directory, "geometry.dat")); err != nil || info.Size() == 0 {
		t.Fatalf("real XFOIL did not save analyzed geometry: %v", err)
	}
	binaryHash, err := hashFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("real XFOIL PASS version=6.99 sha256=%s duration=%s rows=%d alpha=[%.3f,%.3f] CL=[%.4f,%.4f] CD=[%.5f,%.5f] CM=[%.4f,%.4f]",
		binaryHash, time.Since(started).Round(time.Millisecond), len(samples),
		samples[0].Alpha, samples[len(samples)-1].Alpha,
		samples[0].CL, samples[len(samples)-1].CL,
		samples[0].CD, samples[len(samples)-1].CD,
		samples[0].CM, samples[len(samples)-1].CM)
}
