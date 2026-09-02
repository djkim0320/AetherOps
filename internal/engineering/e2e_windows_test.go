//go:build windows && amd64

package engineering

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	managedruntime "github.com/djkim0320/AetherOps/internal/runtime"
	"github.com/djkim0320/AetherOps/internal/store"
)

// TestRealBundledEngineeringAdapters is deliberately opt-in because it runs
// the real third-party solvers. Release verification invokes it with paths
// from the sealed managed runtime; normal unit tests never substitute fakes.
func TestRealBundledEngineeringAdapters(t *testing.T) {
	paths := managedruntime.ProcessPaths{
		OpenVSPScriptExecutable: os.Getenv("AETHEROPS_E2E_OPENVSP"),
		VSPAEROExecutable:       os.Getenv("AETHEROPS_E2E_VSPAERO"),
		VSPAEROOptExecutable:    os.Getenv("AETHEROPS_E2E_VSPAERO_OPT"),
		GmshExecutable:          os.Getenv("AETHEROPS_E2E_GMSH"),
		XFOILExecutable:         os.Getenv("AETHEROPS_E2E_XFOIL"),
		SU2CFDExecutable:        os.Getenv("AETHEROPS_E2E_SU2"),
	}
	for name, value := range map[string]string{
		"OpenVSP": paths.OpenVSPScriptExecutable, "VSPAERO": paths.VSPAEROExecutable,
		"Gmsh": paths.GmshExecutable, "XFOIL": paths.XFOILExecutable, "SU2": paths.SU2CFDExecutable,
	} {
		if value == "" {
			t.Skipf("real managed %s path is not configured", name)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	root := os.Getenv("AETHEROPS_E2E_WORKSPACE")
	if root == "" {
		root = t.TempDir()
	} else {
		absoluteRoot, pathErr := filepath.Abs(root)
		if pathErr != nil {
			t.Fatal(pathErr)
		}
		root = absoluteRoot
		if err := os.MkdirAll(root, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("real engineering E2E workspace: %s", root)
	database, err := store.Open(ctx, filepath.Join(root, "e2e.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	project, err := database.CreateProject(ctx, "real engineering e2e")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "real aerodynamic tool verification", "main-thread")
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
	service, err := New(Config{DB: database, CAS: objects, WorkspaceRoot: filepath.Join(root, "workspace"), Runtime: paths})
	if err != nil {
		t.Fatal(err)
	}
	approve := func(tool string, arguments any) {
		t.Helper()
		encoded, err := canonicalJSON(arguments)
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(encoded)
		approval, err := database.CreateApproval(ctx, core.Approval{
			RunID: run.ID, StageAttemptID: attempt.ID, ThreadID: "collector-thread",
			TurnID: "collector-turn", ItemID: tool, Kind: "item/mcpToolCall/requestApproval",
			Summary: "real solver e2e", Server: "aetherops_engineering", Tool: tool,
			ArgumentsJSON: string(encoded), ArgumentsSHA256: hex.EncodeToString(digest[:]),
			Risk: "external_side_effect", ExternalSideEffect: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := database.DecideApproval(ctx, approval.ID, "approved"); err != nil {
			t.Fatal(err)
		}
	}
	logResult := func(name string, started time.Time, result JobResult, expectedThreads int) {
		t.Helper()
		receiptSHA256 := "missing"
		for _, artifact := range result.Artifacts {
			if artifact.Role == "receipt" {
				receiptSHA256 = artifact.SHA256
				break
			}
		}
		if receiptSHA256 == "missing" {
			t.Fatalf("%s result contains no execution receipt", name)
		}
		receiptBytes, err := objects.ReadVerified(receiptSHA256)
		if err != nil {
			t.Fatalf("%s receipt CAS readback: %v", name, err)
		}
		var receipt executionReceipt
		if err := json.Unmarshal(receiptBytes, &receipt); err != nil {
			t.Fatalf("%s receipt JSON: %v", name, err)
		}
		if receipt.Operation != result.Operation || receipt.Threads != expectedThreads {
			t.Fatalf("%s receipt operation/threads = %s/%d, want %s/%d",
				name, receipt.Operation, receipt.Threads, result.Operation, expectedThreads)
		}
		t.Logf("%s PASS duration=%s job=%s receipt_sha256=%s metrics=%v artifacts=%d",
			name, time.Since(started).Round(time.Millisecond), result.JobID,
			receiptSHA256, result.Metrics, len(result.Artifacts))
	}

	wing := WingSpec{RunID: run.ID, StageAttemptID: attempt.ID, SemiSpanM: 5,
		RootChordM: 2, TaperRatio: .5, SweepDeg: 10, Mach: .1,
		AlphaStartDeg: 0, AlphaEndDeg: 4, AlphaPoints: 3}
	approve("openvsp_wing_aero", wing)
	stageStarted := time.Now()
	wingResult, err := service.OpenVSPWingAero(ctx, wing)
	if err != nil || !wingResult.NumericallyValid {
		t.Fatalf("real OpenVSP/VSPAERO: valid=%v err=%v", wingResult.NumericallyValid, err)
	}
	logResult("OpenVSP/VSPAERO", stageStarted, wingResult, service.threads)
	modelID := ""
	for _, artifact := range wingResult.Artifacts {
		if artifact.Role == "model" {
			modelID = artifact.ArtifactID
		}
	}
	if modelID == "" {
		t.Fatal("OpenVSP result contains no model artifact")
	}
	modify := ModifyWingSpec{RunID: run.ID, StageAttemptID: attempt.ID, SourceArtifactID: modelID, NewSweepDeg: 15}
	approve("openvsp_modify_wing", modify)
	stageStarted = time.Now()
	modifyResult, err := service.OpenVSPModifyWing(ctx, modify)
	if err != nil || !modifyResult.NumericallyValid {
		t.Fatalf("real OpenVSP modification: valid=%v err=%v", modifyResult.NumericallyValid, err)
	}
	logResult("OpenVSP modification", stageStarted, modifyResult, service.threads)
	mesh := MeshSpec{RunID: run.ID, StageAttemptID: attempt.ID, SemiSpanM: 5,
		RootChordM: 2, TaperRatio: .5, SweepDeg: 15, MeshSizeM: .25}
	approve("gmsh_wing_mesh", mesh)
	stageStarted = time.Now()
	meshResult, err := service.GmshWingMesh(ctx, mesh)
	if err != nil || !meshResult.NumericallyValid {
		t.Fatalf("real Gmsh: valid=%v err=%v", meshResult.NumericallyValid, err)
	}
	logResult("Gmsh", stageStarted, meshResult, service.threads)
	xfoil := XFOILSpec{RunID: run.ID, StageAttemptID: attempt.ID, NACA: "0012",
		Reynolds: 1e6, Mach: .1, AlphaStartDeg: 0, AlphaEndDeg: 4, AlphaStepDeg: 2}
	approve("xfoil_polar", xfoil)
	stageStarted = time.Now()
	xfoilResult, err := service.XFOILPolar(ctx, xfoil)
	if err != nil || !xfoilResult.NumericallyValid {
		t.Fatalf("real XFOIL: valid=%v err=%v", xfoilResult.NumericallyValid, err)
	}
	logResult("XFOIL", stageStarted, xfoilResult, 1)
	flapChord, flapHingeX, flapHingeY, flapDeflection := .3, .7, 0.0, 30.0
	ncrit, xfoilIterations, panelCount := 9.0, 250, 160
	flapXFOIL := XFOILSpec{
		RunID: run.ID, StageAttemptID: attempt.ID, NACA: "0015",
		Reynolds: 1e6, Mach: .1, AlphaStartDeg: -6, AlphaEndDeg: 18, AlphaStepDeg: .25,
		FlapChordRatio: &flapChord, FlapHingeXOverC: &flapHingeX,
		FlapHingeYOverC: &flapHingeY, FlapDeflectionDeg: &flapDeflection,
		NCrit: &ncrit, Iterations: &xfoilIterations, PanelCount: &panelCount,
	}
	approve("xfoil_polar", flapXFOIL)
	stageStarted = time.Now()
	flapResult, err := service.XFOILPolar(ctx, flapXFOIL)
	if err != nil || !flapResult.NumericallyValid {
		t.Fatalf("real XFOIL sealed plain flap: valid=%v err=%v", flapResult.NumericallyValid, err)
	}
	samples, samplesOK := flapResult.Metrics["samples"].([]XFOILSample)
	points, pointsOK := flapResult.Metrics["points"].([]XFOILPointStatus)
	if !samplesOK || !pointsOK || len(samples) != 97 || len(points) != 97 {
		t.Fatalf("real XFOIL flap must return 97 typed samples and statuses: samples=%T/%d points=%T/%d",
			flapResult.Metrics["samples"], len(samples), flapResult.Metrics["points"], len(points))
	}
	for index, point := range points {
		if point.Status != xfoilPointConverged {
			t.Fatalf("real XFOIL flap point %d did not converge: %+v", index, point)
		}
	}
	for index, sample := range samples {
		if math.IsNaN(sample.CM) || math.IsInf(sample.CM, 0) {
			t.Fatalf("real XFOIL flap sample %d has invalid quarter-chord CM: %+v", index, sample)
		}
	}
	roles := make(map[string]bool)
	for _, artifact := range flapResult.Artifacts {
		roles[artifact.Role] = true
	}
	if !roles["geometry"] || !roles["polar"] || !roles["normalized"] || !roles["receipt"] {
		t.Fatalf("real XFOIL flap result omits required artifacts: %v", roles)
	}
	logResult("XFOIL sealed plain flap", stageStarted, flapResult, 1)
	t.Logf("XFOIL sealed plain flap PASS duration=%s job=%s samples=%d alpha=[%.3f,%.3f] CM=[%.4f,%.4f]",
		time.Since(stageStarted).Round(time.Millisecond), flapResult.JobID, len(samples),
		samples[0].Alpha, samples[len(samples)-1].Alpha, samples[0].CM, samples[len(samples)-1].CM)
	su2InputDir := filepath.Join(root, "su2-general-input")
	if err := os.MkdirAll(su2InputDir, 0o700); err != nil {
		t.Fatal(err)
	}
	geoPath := filepath.Join(su2InputDir, "fixture.geo")
	meshPath := filepath.Join(su2InputDir, "fixture.su2")
	if err := os.WriteFile(geoPath, []byte(realSU2E2EGeo(.02)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := service.runCommand(ctx, su2InputDir, paths.GmshExecutable, "", nil,
		geoPath, "-2", "-format", "su2", "-o", meshPath); err != nil {
		t.Fatalf("prepare real general SU2 mesh: %v", err)
	}
	meshFile, err := os.Open(meshPath)
	if err != nil {
		t.Fatal(err)
	}
	meshReceipt, putErr := objects.PutReader(meshFile)
	closeErr := meshFile.Close()
	if err := errors.Join(putErr, closeErr); err != nil {
		t.Fatal(err)
	}
	meshArtifact, err := database.PublishArtifact(ctx, run.ID, attempt.ID,
		"engineering.test.general_su2_mesh", "application/vnd.su2.mesh", meshReceipt)
	if err != nil {
		t.Fatal(err)
	}
	su2 := SU2CFDSpec{
		RunID: run.ID, StageAttemptID: attempt.ID, CaseID: "real_euler_airfoil",
		MeshSource: core.SU2InputArtifact, MeshID: meshArtifact.ID, MeshSHA256: meshReceipt.Hash,
		Solver: "EULER", TurbulenceModel: "NONE", OutputFiles: []string{"surface_csv", "restart_ascii"},
		TimeoutSeconds: 720,
		ConfigOverrides: map[string]string{
			"ITER": "250", "MACH_NUMBER": "0.8", "AOA": "1.25",
			"FREESTREAM_PRESSURE": "101325.0", "FREESTREAM_TEMPERATURE": "288.15",
			"REF_ORIGIN_MOMENT_X": "0.25", "REF_ORIGIN_MOMENT_Y": "0.0", "REF_ORIGIN_MOMENT_Z": "0.0",
			"REF_LENGTH": "1.0", "REF_AREA": "1.0", "MARKER_EULER": "( airfoil )",
			"MARKER_FAR": "( farfield )", "MARKER_MONITORING": "( airfoil )", "MARKER_PLOTTING": "( airfoil )",
			"NUM_METHOD_GRAD": "WEIGHTED_LEAST_SQUARES", "CFL_NUMBER": "1e3", "CFL_ADAPT": "NO",
			"CONV_NUM_METHOD_FLOW": "JST", "JST_SENSOR_COEFF": "( 0.5, 0.02 )", "MUSCL_FLOW": "NO",
			"TIME_DISCRE_FLOW": "EULER_IMPLICIT", "LINEAR_SOLVER": "FGMRES", "LINEAR_SOLVER_PREC": "ILU",
			"LINEAR_SOLVER_ERROR": "1E-10", "LINEAR_SOLVER_ITER": "10", "MGLEVEL": "3", "MGCYCLE": "W_CYCLE",
			"MG_PRE_SMOOTH": "( 1, 2, 3, 3 )", "MG_POST_SMOOTH": "( 0, 0, 0, 0 )",
			"MG_CORRECTION_SMOOTH": "( 0, 0, 0, 0 )", "MG_DAMP_RESTRICTION": "1.0",
			"MG_DAMP_PROLONGATION": "1.0", "CONV_FIELD": "RMS_DENSITY", "CONV_RESIDUAL_MINVAL": "-8",
			"CONV_STARTITER": "10", "SCREEN_OUTPUT": "( INNER_ITER, RMS_DENSITY, LIFT, DRAG )",
			"HISTORY_OUTPUT": "( ITER, RMS_RES, AERO_COEFF )",
		},
	}
	approve("su2_cfd", su2)
	stageStarted = time.Now()
	su2Result, err := service.SU2CFD(ctx, su2)
	if err != nil || !su2Result.NumericallyValid {
		t.Fatalf("real SU2: valid=%v err=%v", su2Result.NumericallyValid, err)
	}
	cl, clOK := su2Result.Metrics["cl"].(float64)
	cd, cdOK := su2Result.Metrics["cd"].(float64)
	if !clOK || !cdOK || cl <= 0 || cd <= 0 {
		t.Fatalf("real transonic SU2 requires positive lift and drag: CL=%v CD=%v", su2Result.Metrics["cl"], su2Result.Metrics["cd"])
	}
	finalIteration, iterationOK := su2Result.Metrics["final_iteration"].(int)
	if !iterationOK || finalIteration <= 0 {
		t.Fatalf("real SU2 final iteration was not recovered from the nested history counters: %v", su2Result.Metrics["final_iteration"])
	}
	logResult("SU2", stageStarted, su2Result, service.threads)
}

func realSU2E2EGeo(meshSize float64) string {
	const pointsPerSide = 40
	var builder strings.Builder
	builder.WriteString("SetFactory(\"OpenCASCADE\");\n")
	pointID := 1
	for index := 0; index <= pointsPerSide; index++ {
		x := .5 * (1 + math.Cos(math.Pi*float64(index)/pointsPerSide))
		y := realSU2E2EThickness(x)
		if index == 0 || index == pointsPerSide {
			y = 0
		}
		fmt.Fprintf(&builder, "Point(%d)={%s,%s,0,%s};\n", pointID, formatNumber(x), formatNumber(y), formatNumber(meshSize))
		pointID++
	}
	for index := 1; index < pointsPerSide; index++ {
		x := .5 * (1 - math.Cos(math.Pi*float64(index)/pointsPerSide))
		fmt.Fprintf(&builder, "Point(%d)={%s,%s,0,%s};\n", pointID, formatNumber(x),
			formatNumber(-realSU2E2EThickness(x)), formatNumber(meshSize))
		pointID++
	}
	last := pointID - 1
	farSize := math.Max(meshSize*8, .5)
	fmt.Fprintf(&builder, "Spline(1)={1:%d,1};\n", last)
	for _, point := range [][2]float64{{-10, -10}, {15, -10}, {15, 10}, {-10, 10}} {
		fmt.Fprintf(&builder, "Point(%d)={%s,%s,0,%s};\n", pointID, formatNumber(point[0]), formatNumber(point[1]), formatNumber(farSize))
		pointID++
	}
	firstFar := last + 1
	fmt.Fprintf(&builder, "Line(2)={%d,%d}; Line(3)={%d,%d}; Line(4)={%d,%d}; Line(5)={%d,%d};\n",
		firstFar, firstFar+1, firstFar+1, firstFar+2, firstFar+2, firstFar+3, firstFar+3, firstFar)
	builder.WriteString("Curve Loop(1)={1}; Curve Loop(2)={2,3,4,5}; Plane Surface(1)={2,1};\n")
	builder.WriteString("Physical Curve(\"airfoil\")={1}; Physical Curve(\"farfield\")={2,3,4,5}; Physical Surface(\"fluid\")={1};\n")
	builder.WriteString("Mesh.Algorithm=6; Mesh.Optimize=1;\n")
	return builder.String()
}

func realSU2E2EThickness(x float64) float64 {
	return 5 * .12 * (.2969*math.Sqrt(x) - .126*x - .3516*x*x + .2843*x*x*x - .1036*x*x*x*x)
}

func TestOpenVSPPathBudgetFailsClosed(t *testing.T) {
	if err := requireOpenVSPPathBudget(`C:\AetherOps\v2\workspace`, "wing_aero.vspscript"); err != nil {
		t.Fatalf("normal managed workspace path was rejected: %v", err)
	}
	longDirectory := `C:\` + strings.Repeat("a", 250)
	err := requireOpenVSPPathBudget(longDirectory, "wing_aero.vspscript")
	if err == nil || !strings.Contains(err.Error(), "MAX_PATH") {
		t.Fatalf("legacy OpenVSP path must fail with an explanatory MAX_PATH error, got %v", err)
	}
}
