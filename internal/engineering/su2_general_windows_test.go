//go:build windows && amd64

package engineering

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validGeneralSU2Spec() SU2CFDSpec {
	return SU2CFDSpec{
		RunID: "run_general", StageAttemptID: "attempt_general", CaseID: "case_one",
		MeshSource: "material", MeshID: "doc_mesh", MeshSHA256: strings.Repeat("a", 64),
		Solver: "EULER", TurbulenceModel: "NONE",
		ConfigOverrides: map[string]string{
			"ITER": "100", "MACH_NUMBER": "0.3", "AOA": "2",
			"MARKER_EULER": "( wall )", "MARKER_FAR": "( farfield )",
		},
		OutputFiles: []string{"surface_csv"}, TimeoutSeconds: 600,
	}
}

func TestGeneralSU2ConfigRewritesAllManagedPathsAndHasNoPreset(t *testing.T) {
	spec := validGeneralSU2Spec()
	source := []byte(`
SOLVER= EULER
KIND_TURB_MODEL= NONE
MATH_PROBLEM= DIRECT
MESH_FILENAME= ../../private/other.su2
MESH_FORMAT= SU2
RESTART_SOL= NO
RESTART_FILENAME= C:\outside\restart.dat
SURFACE_FILENAME= outside_surface
OUTPUT_FILES= ( PARAVIEW )
ITER= 80
`)
	result, err := normalizedGeneralSU2Config(spec, source)
	if err != nil {
		t.Fatal(err)
	}
	text := string(result)
	for _, required := range []string{
		"SOLVER= EULER", "MESH_FILENAME= mesh.su2", "RESTART_SOL= NO",
		"SURFACE_FILENAME= surface_flow", "OUTPUT_FILES= (SURFACE_CSV)", "ITER= 100",
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("normalized config omits %q:\n%s", required, text)
		}
	}
	for _, forbidden := range []string{"NACA0012", "../../private", `C:\outside`, "outside_surface", "PARAVIEW )"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("normalized config retained unmanaged value %q:\n%s", forbidden, text)
		}
	}
}

func TestGeneralSU2ConfigRejectsExternalFilesManagedOverridesAndPhysicsMismatch(t *testing.T) {
	spec := validGeneralSU2Spec()
	tests := []struct {
		name   string
		source string
		mutate func(*SU2CFDSpec)
	}{
		{name: "external inlet file", source: "INLET_FILENAME= secret.dat\nITER=100\n"},
		{name: "solver mismatch", source: "SOLVER= RANS\nITER=100\n"},
		{name: "restart input", source: "RESTART_SOL= YES\nITER=100\n"},
		{name: "managed override", mutate: func(value *SU2CFDSpec) { value.ConfigOverrides["MESH_FILENAME"] = "mesh.su2" }},
		{name: "path in value", mutate: func(value *SU2CFDSpec) { value.ConfigOverrides["CUSTOM_OUTPUTS"] = "../outside" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := spec
			candidate.ConfigOverrides = make(map[string]string, len(spec.ConfigOverrides)+1)
			for key, value := range spec.ConfigOverrides {
				candidate.ConfigOverrides[key] = value
			}
			if test.mutate != nil {
				test.mutate(&candidate)
			}
			if _, err := normalizedGeneralSU2Config(candidate, []byte(test.source)); err == nil {
				t.Fatal("unsafe or conflicting SU2 configuration was accepted")
			}
		})
	}
}

func TestGeneralSU2SpecRequiresExplicitRANSModel(t *testing.T) {
	spec := validGeneralSU2Spec()
	spec.Solver = "RANS"
	if err := validateSU2CFDSpec(spec); err == nil {
		t.Fatal("RANS without a turbulence model was accepted")
	}
	spec.TurbulenceModel = "SST"
	if err := validateSU2CFDSpec(spec); err != nil {
		t.Fatalf("explicit RANS/SST case rejected: %v", err)
	}
}

func TestGeneralSU2MeshAndHistoryInspectionArePhysicsNeutral(t *testing.T) {
	root := t.TempDir()
	meshPath := filepath.Join(root, "mesh.su2")
	if err := os.WriteFile(meshPath, []byte("NDIME= 3\nNELEM= 12\nNPOIN= 20\nNMARK= 4\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	mesh, err := inspectGeneralSU2Mesh(meshPath)
	if err != nil || mesh.Dimension != 3 || mesh.Elements != 12 || mesh.Nodes != 20 || mesh.Markers != 4 {
		t.Fatalf("generic mesh metrics = %+v err=%v", mesh, err)
	}
	historyPath := filepath.Join(root, "history.csv")
	if err := os.WriteFile(historyPath, []byte(`"Time_Iter", "Inner_Iter", "rms[Rho]", "CL", "CD", "Heat_Flux"
0, 0, -1.0, 0.1, 0.02, 12.5
0, 120, -4.0, 0.3, 0.03, 15.0
`), 0o600); err != nil {
		t.Fatal(err)
	}
	history, err := parseGeneralSU2History(historyPath)
	if err != nil || history.Rows != 2 || history.Columns != 6 || history.FinalIteration == nil || *history.FinalIteration != 120 {
		t.Fatalf("generic history = %+v err=%v", history, err)
	}
	if value, ok := genericHistoryValue(history.FinalValues, "CL"); !ok || value != .3 {
		t.Fatalf("generic final CL = %v, %v", value, ok)
	}
}

func TestGeneralSU2HistoryMetricSelectionPrefersExactColumn(t *testing.T) {
	values := map[string]float64{"RMSRHO": -8.0, "RMSRHOU": -6.0, "RMSRHOV": -5.0}
	for range 100 {
		value, ok := genericHistoryValue(values, "RMS_DENSITY", "RMSRHO", "RMS_DENS")
		if !ok || value != -8.0 {
			t.Fatalf("density residual selection = %v, %v", value, ok)
		}
	}
}

func TestGeneralSU2OutputCollectionRejectsEmptyRequiredArtifact(t *testing.T) {
	root := t.TempDir()
	for name, content := range map[string]string{
		"mesh.su2": "NDIME=2\n", "case.cfg": "ITER=1\n", "history.csv": "ITER\n0\n", "su2.log": "",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := collectGeneralSU2Outputs(root, "", nil); err == nil || !strings.Contains(err.Error(), "non-empty regular file") {
		t.Fatalf("empty required output error = %v", err)
	}
}
