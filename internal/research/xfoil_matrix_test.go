package research

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/core"
)

type matrixRunnerFixture struct {
	materialized []string
	executed     []string
}

func (runner *matrixRunnerFixture) CanonicalXFOILScreeningArguments(_ string, _ string, _ core.XFOILScreeningPlan, point core.XFOILOperatingPoint, deflection float64) ([]byte, error) {
	key := fmt.Sprintf("%s/%g", point.ID, deflection)
	runner.materialized = append(runner.materialized, key)
	return json.Marshal(map[string]any{"cell": key})
}

func (runner *matrixRunnerFixture) RunXFOILScreeningCell(_ context.Context, _ string, _ string, _ core.XFOILScreeningPlan, point core.XFOILOperatingPoint, deflection float64) (string, error) {
	key := fmt.Sprintf("%s/%g", point.ID, deflection)
	runner.executed = append(runner.executed, key)
	return "art_0123456789abcdef0123456789abcdef", nil
}

type matrixAuthorizerFixture struct{ arguments [][]byte }

func (authorizer *matrixAuthorizerFixture) AuthorizeXFOILScreening(_ context.Context, _ core.Run, _ core.StageAttempt, arguments [][]byte) error {
	authorizer.arguments = append(authorizer.arguments, arguments...)
	return nil
}

func TestGoCoreMaterializesAndExecutesCompleteXFOILCartesianMatrix(t *testing.T) {
	fixture := newProtocolFixture(t, standardResponder(false))
	engine, database, _, run := openResearchTest(t, fixture)
	var err error
	run, err = database.TransitionRun(context.Background(), run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(context.Background(), run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(context.Background(), run.ID, core.StageCollect, core.EngineeringScreeningOwnerOrdinal, "", "")
	if err != nil {
		t.Fatal(err)
	}
	runner := &matrixRunnerFixture{}
	authorizer := &matrixAuthorizerFixture{}
	engine.xfoilRunner = runner
	engine.xfoilAuthorizer = authorizer
	plan := core.XFOILScreeningPlan{
		NACA: "2412", Reynolds: 1e6, Mach: .1, AlphaStartDeg: -4, AlphaEndDeg: 12, AlphaStepDeg: .5,
		FlapChordRatio: .25, FlapHingeXOverC: .75, CandidateDeflectionsDeg: []float64{0, 5, 10},
		NCrit: 9, Iterations: 200, PanelCount: 160,
		OptimizationObjective: "minimize_cd_at_target_cl", TargetCL: .8, MinimumCM: -.2,
		OperatingPoints: []core.XFOILOperatingPoint{
			{ID: "cruise", Reynolds: 1e6, Mach: .1, NCrit: 9, TargetCL: .8, MinimumCM: -.2},
			{ID: "climb", Reynolds: 8e5, Mach: .08, NCrit: 9, TargetCL: 1, MinimumCM: -.2},
		},
	}
	if err := engine.executePlannedXFOILScreening(context.Background(), run, attempt, plan); err != nil {
		t.Fatal(err)
	}
	want := []string{"cruise/0", "cruise/5", "cruise/10", "climb/0", "climb/5", "climb/10"}
	if fmt.Sprint(runner.materialized) != fmt.Sprint(want) || fmt.Sprint(runner.executed) != fmt.Sprint(want) {
		t.Fatalf("matrix materialized=%v executed=%v want=%v", runner.materialized, runner.executed, want)
	}
	if len(authorizer.arguments) != len(want) {
		t.Fatalf("authorized cells = %d, want %d", len(authorizer.arguments), len(want))
	}
}

func TestRevisionStructureRepairOnlyReusesExactStableMarker(t *testing.T) {
	previous := core.ReportManifest{
		EvidenceIDs: []string{"ws"},
		Citations:   []core.Citation{{Marker: "[8]", SourceIDs: []string{"src"}, ClaimIDs: []string{"claim"}}},
	}
	revised := core.ReportManifest{
		Citations: []core.Citation{{Marker: "[8]"}, {Marker: "[9]"}},
	}
	got := repairRevisedReportStructure(previous, revised)
	if len(got.Citations[0].SourceIDs) != 1 || len(got.Citations[0].ClaimIDs) != 1 {
		t.Fatalf("stable citation was not repaired: %+v", got.Citations[0])
	}
	if len(got.Citations[1].SourceIDs) != 0 || len(got.Citations[1].ClaimIDs) != 0 {
		t.Fatalf("new citation was guessed: %+v", got.Citations[1])
	}
	if len(got.EvidenceIDs) != 1 || got.EvidenceIDs[0] != "ws" {
		t.Fatalf("evidence ids were not preserved: %+v", got.EvidenceIDs)
	}
}
