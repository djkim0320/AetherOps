//go:build windows && amd64

package engineering

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSU2DeterministicAnalysis(t *testing.T) {
	directory := t.TempDir()
	historyPath := filepath.Join(directory, "history.csv")
	var history strings.Builder
	history.WriteString(`"Inner_Iter","CL","CD","rms[Rho]"` + "\n")
	for index := 0; index < 60; index++ {
		fmt.Fprintf(&history, "%d,%.9f,%.9f,%.9f\n", index, .31+float64(index)*1e-4,
			.012+float64(index)*2e-5, -.7-float64(index)*.13)
	}
	writeTestFile(t, historyPath, history.String())
	historyMetrics, err := parseSU2History(historyPath)
	if err != nil {
		t.Fatal(err)
	}
	if historyMetrics["late_window_iterations"] != 50 || historyMetrics["iterations"] != 60 {
		t.Fatalf("history window/count = %v/%v", historyMetrics["late_window_iterations"], historyMetrics["iterations"])
	}
	if got := historyMetrics["residual_drop_orders"].(float64); math.Abs(got-7.67) > 1e-9 {
		t.Fatalf("residual drop = %.12g", got)
	}
	if got := historyMetrics["cl_late_range"].(float64); math.Abs(got-.0049) > 1e-9 {
		t.Fatalf("CL late range = %.12g", got)
	}

	meshPath := filepath.Join(directory, "case.su2")
	writeTestFile(t, meshPath, "NDIME= 2\nNELEM= 120\nNPOIN= 80\nNMARK= 2\nMARKER_TAG= airfoil\nMARKER_ELEMS= 40\nMARKER_TAG= farfield\nMARKER_ELEMS= 20\n")
	meshMetrics, err := parseSU2MeshMetrics(meshPath)
	if err != nil || meshMetrics["mesh_nodes"] != 80 || meshMetrics["mesh_volume_elements"] != 120 ||
		meshMetrics["airfoil_boundary_elements"] != 40 || meshMetrics["farfield_boundary_elements"] != 20 {
		t.Fatalf("mesh metrics=%v err=%v", meshMetrics, err)
	}

	logPath := filepath.Join(directory, "su2.log")
	writeTestFile(t, logPath, `All volume elements are correctly oriented.
| Orthogonality Angle (deg.) | 77.2 | 89.9 |
| CV Face Area Aspect Ratio | 1.003 | 5.73 |
| CV Sub-Volume Ratio | 1 | 3.21 |
`)
	logMetrics, err := parseSU2LogMetrics(logPath)
	if err != nil || logMetrics["mesh_orientation_valid"] != true || logMetrics["orthogonality_available"] != true || logMetrics["orthogonality_min_deg"] != 77.2 {
		t.Fatalf("log metrics=%v err=%v", logMetrics, err)
	}
	writeTestFile(t, logPath, `All volume elements are correctly oriented.
| Orthogonality Angle (deg.) | nan | nan |
| CV Face Area Aspect Ratio | 1.003 | 5.73 |
| CV Sub-Volume Ratio | 1 | 3.21 |
`)
	logMetrics, err = parseSU2LogMetrics(logPath)
	if err != nil || logMetrics["mesh_orientation_valid"] != true || logMetrics["orthogonality_available"] != false {
		t.Fatalf("nan orthogonality metrics=%v err=%v", logMetrics, err)
	}
	if _, exists := logMetrics["orthogonality_min_deg"]; exists {
		t.Fatalf("nan orthogonality must not produce a numeric value: %v", logMetrics)
	}

	surfacePath := filepath.Join(directory, "surface_flow.csv")
	var surface strings.Builder
	surface.WriteString(`"PointID","x","y","Density","Momentum_x","Momentum_y","Energy"` + "\n")
	pointID := 0
	for _, row := range []struct{ x, y, cp float64 }{
		{.1, .02, 0}, {.3, .04, -.1}, {.6, .03, -1.2}, {.8, .01, -1.1},
		{.1, -.02, 0}, {.3, -.04, .05}, {.6, -.03, .1}, {.8, -.01, .3},
	} {
		pressure := 101325.0 + row.cp*(.5*1.4*101325.0*.8*.8)
		energy := pressure / (.4)
		fmt.Fprintf(&surface, "%d,%.9f,%.9f,1.2,0,0,%.12f\n", pointID, row.x, row.y, energy)
		pointID++
	}
	writeTestFile(t, surfacePath, surface.String())
	surfaceMetrics, err := parseSU2SurfaceMetrics(surfacePath, SU2Spec{Mach: .8})
	if err != nil {
		t.Fatal(err)
	}
	if surfaceMetrics["surface_points"] != 8 || math.Abs(surfaceMetrics["upper_shock_x_over_c"].(float64)-.45) > 1e-12 ||
		math.Abs(surfaceMetrics["lower_shock_x_over_c"].(float64)-.7) > 1e-12 {
		t.Fatalf("surface metrics=%v", surfaceMetrics)
	}
}

func TestSU2AnalysisFailsClosedOnMissingProof(t *testing.T) {
	directory := t.TempDir()
	meshPath := filepath.Join(directory, "bad.su2")
	writeTestFile(t, meshPath, "NELEM= 1\nNPOIN= 1\n")
	if _, err := parseSU2MeshMetrics(meshPath); err == nil || !strings.Contains(err.Error(), "airfoil_boundary_elements") {
		t.Fatalf("incomplete mesh error=%v", err)
	}
	logPath := filepath.Join(directory, "bad.log")
	writeTestFile(t, logPath, "no orientation proof")
	if _, err := parseSU2LogMetrics(logPath); err == nil || !strings.Contains(err.Error(), "orientation") {
		t.Fatalf("incomplete log error=%v", err)
	}
}

func writeTestFile(t *testing.T, path, value string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
		t.Fatal(err)
	}
}
