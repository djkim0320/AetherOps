package research

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/core"
)

func TestCanonicalReportOutputPersistsCoreEngineeringAssessment(t *testing.T) {
	assessment := assessSU2Cases([]core.SU2CaseEvidence{
		testSU2Case(.04, .3272906638, .0159997543, true),
		testSU2Case(.025, .3202724368, .007235146316, false),
		testSU2Case(.015, .3249697271, .01179089922, false),
	})
	report := core.ReportManifest{
		Title:                 "SU2 grid study",
		AnswerMarkdown:        "model-authored body",
		EngineeringAssessment: &assessment,
	}
	encoded, err := canonicalReportOutput(&report)(json.RawMessage(`{"title":"raw model output"}`))
	if err != nil {
		t.Fatal(err)
	}
	var durable core.ReportManifest
	if err := json.Unmarshal(encoded, &durable); err != nil {
		t.Fatal(err)
	}
	if durable.Title != report.Title || durable.EngineeringAssessment == nil {
		t.Fatalf("durable report lost core-owned fields: %+v", durable)
	}
	if durable.EngineeringAssessment.Outcome != core.EngineeringOutcomeInconclusive {
		t.Fatalf("durable assessment outcome = %q", durable.EngineeringAssessment.Outcome)
	}
}

func TestSU2AcceptanceClassifiesCompletedButNonconvergentStudy(t *testing.T) {
	cases := []core.SU2CaseEvidence{
		testSU2Case(.04, .3272906638, .0159997543, true),
		testSU2Case(.025, .3202724368, .007235146316, false),
		testSU2Case(.015, .3249697271, .01179089922, false),
	}
	assessment := assessSU2Cases(cases)
	if assessment.Outcome != core.EngineeringOutcomeInconclusive {
		t.Fatalf("nonmonotonic study outcome = %q", assessment.Outcome)
	}
	failed := make(map[string]bool)
	for _, check := range assessment.Checks {
		if !check.Passed {
			failed[check.ID] = true
		}
	}
	if !failed["mesh_quality_observability"] || !failed["asymptotic_grid_trend"] {
		t.Fatalf("missing expected conclusion failures: %+v", failed)
	}
	if err := assessment.Validate(); err != nil {
		t.Fatalf("honest inconclusive assessment rejected: %v", err)
	}
	appendix := buildSU2AcceptanceAppendix(assessment)
	if !strings.Contains(appendix, "**inconclusive**") || !strings.Contains(appendix, "asymptotic_grid_trend") {
		t.Fatal("deterministic appendix omits outcome or failed gate")
	}
	if got := stripSU2AcceptanceAppendix("before\n" + appendix + "\nafter"); strings.Join(strings.Fields(got), " ") != "before after" {
		t.Fatalf("strip appendix = %q", got)
	}
}

func TestSU2AcceptanceConfirmsOnlyAsymptoticObservableStudy(t *testing.T) {
	cases := []core.SU2CaseEvidence{
		testSU2Case(.04, .30, .020, true),
		testSU2Case(.025, .32, .015, true),
		testSU2Case(.015, .33, .013, true),
	}
	assessment := assessSU2Cases(cases)
	if assessment.Outcome != core.EngineeringOutcomeConfirmed {
		t.Fatalf("asymptotic study outcome = %q reason=%s", assessment.Outcome, assessment.OutcomeReason)
	}
	for _, check := range assessment.Checks {
		if !check.Passed {
			t.Fatalf("confirmed study has failed check %+v", check)
		}
	}
}

func TestSU2TrendAndRefinementRulesFailClosed(t *testing.T) {
	if asymptoticMonotonicTrend([]float64{1, .9, .95}) {
		t.Fatal("oscillating values accepted as asymptotic")
	}
	if asymptoticMonotonicTrend([]float64{1, .9, .7}) {
		t.Fatal("growing successive difference accepted as asymptotic")
	}
	if consistentRefinementRatios([]float64{.04, .03, .01}) {
		t.Fatal("inconsistent refinement ratios were accepted")
	}
	if !consistentRefinementRatios([]float64{.04, .025, .015}) {
		t.Fatal("actual bounded refinement ratios were rejected")
	}
}

func testSU2Case(meshSize, cl, cd float64, orthogonality bool) core.SU2CaseEvidence {
	key := int(meshSize * 1_000_000)
	hash := fmt.Sprintf("%064x", key)
	return core.SU2CaseEvidence{
		JobID: fmt.Sprintf("eng_case_%d", key), ReceiptArtifactID: fmt.Sprintf("art_%032x", key),
		ReceiptSHA256: hash, MeshSizeM: meshSize, MeshNodes: 5000,
		MeshVolumeElements: 10000, AirfoilBoundaryElements: 80,
		CL: cl, CD: cd, ResidualDropOrders: 7, CLLateStddev: 1e-6,
		CDLateStddev: 1e-7, OrthogonalityAvailable: orthogonality,
		UpperShockXOverC: .6, ArtifactHashes: []string{hash},
	}
}
