package research

import (
	"encoding/json"
	"fmt"
	"math"
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
	plan := core.SU2MeshStudyPlan{
		ExecutionMode: core.SU2ExecutionExecute, Profile: core.SU2MeshStudyProfileV1,
		NACA: "0012", Mach: .15, AlphaDeg: 5, Iterations: 1000,
		MeshSizesM: []float64{.04, .025, .015}, DomainProfile: core.SU2FixedDomainV1,
		Objective: core.SU2ObjectiveGridStudy, ReferenceComparison: "qualitative_context",
	}
	appendix := buildSU2AcceptanceAppendix(plan, assessment, testSU2Traces(assessment.SU2Cases))
	if !strings.Contains(appendix, "**inconclusive**") || !strings.Contains(appendix, "asymptotic_grid_trend") {
		t.Fatal("deterministic appendix omits outcome or failed gate")
	}
	for _, required := range []string{
		"Execution audit and exact reproduction", "aetherops-su2-rms-rho", "aetherops-su2-cl-history",
		"aetherops-su2-cd-history", "aetherops-su2-cl-grid", "aetherops-su2-cd-grid",
		"no interpolation, smoothing, or row removal", "data-source-sha256",
	} {
		if !strings.Contains(appendix, required) {
			t.Fatalf("deterministic appendix omits %q", required)
		}
	}
	if got := stripSU2AcceptanceAppendix("before\n" + appendix + "\nafter"); strings.Join(strings.Fields(got), " ") != "before after" {
		t.Fatalf("strip appendix = %q", got)
	}
}

func TestParseSU2HistoryTraceRequiresContiguousFiniteRows(t *testing.T) {
	data := []byte("\"Inner_Iter\",    \"rms[Rho]\"    ,       \"CL\"       ,       \"CD\"       \n0,-1,0.2,0.03\n1,-2,0.3,0.02\n")
	points, err := parseSU2HistoryTrace(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 2 || points[1].Iteration != 1 || points[1].RMSRho != -2 || points[1].CL != .3 || points[1].CD != .02 {
		t.Fatalf("history points = %+v", points)
	}
	if _, err := parseSU2HistoryTrace([]byte("\"Inner_Iter\",\"rms[Rho]\",\"CL\",\"CD\"\n0,-1,0.2,0.03\n2,-2,0.3,0.02\n")); err == nil {
		t.Fatal("non-contiguous SU2 history was accepted")
	}
}

func testSU2Traces(cases []core.SU2CaseEvidence) []su2CaseTrace {
	traces := make([]su2CaseTrace, len(cases))
	for index, item := range cases {
		hash := fmt.Sprintf("%064x", index+100)
		traces[index] = su2CaseTrace{
			JobID: item.JobID, MeshSizeM: item.MeshSizeM, SpecSHA256: hash,
			ToolVersion: "8.5.0", StartedAt: "2026-08-31T00:00:00Z", CompletedAt: "2026-08-31T00:00:01Z",
			HistoryHash: hash, ReceiptHash: item.ReceiptSHA256,
			HistoryPoint: []su2HistoryPoint{{Iteration: 0, RMSRho: -1, CL: item.CL - .01, CD: item.CD + .01}, {Iteration: 1, RMSRho: -7, CL: item.CL, CD: item.CD}},
		}
	}
	return traces
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
	if consistentVolumeRefinementRatios([]int{3015, 9834, 12262}) {
		t.Fatal("inconsistent realized cell-count ratios were accepted")
	}
	if !consistentVolumeRefinementRatios([]int{3000, 12000, 48000}) {
		t.Fatal("consistent realized two-dimensional refinement was rejected")
	}
}

func TestSU2AcceptanceRejectsNominalRefinementThatDidNotMaterialize(t *testing.T) {
	cases := []core.SU2CaseEvidence{
		testSU2Case(.12, .48, .017, true),
		testSU2Case(.06, .56, -.012, true),
		testSU2Case(.03, .58, -.026, true),
	}
	cases[0].MeshVolumeElements = 3015
	cases[1].MeshVolumeElements = 9834
	cases[2].MeshVolumeElements = 12262

	assessment := assessSU2Cases(cases)
	if assessment.Outcome != core.EngineeringOutcomeInconclusive {
		t.Fatalf("non-materialized refinement outcome = %q", assessment.Outcome)
	}
	for _, check := range assessment.Checks {
		if check.ID == "refinement_ratio_consistency" {
			if check.Passed {
				t.Fatal("nominal 2x mesh targets hid inconsistent realized cell-count ratios")
			}
			return
		}
	}
	t.Fatal("refinement ratio conclusion gate is missing")
}

func testSU2Case(meshSize, cl, cd float64, orthogonality bool) core.SU2CaseEvidence {
	key := int(meshSize * 1_000_000)
	hash := fmt.Sprintf("%064x", key)
	return core.SU2CaseEvidence{
		JobID: fmt.Sprintf("eng_case_%d", key), ReceiptArtifactID: fmt.Sprintf("art_%032x", key),
		ReceiptSHA256: hash, MeshSizeM: meshSize, MeshNodes: 5000,
		MeshVolumeElements: int(math.Round(10 / (meshSize * meshSize))), AirfoilBoundaryElements: 80,
		CL: cl, CD: cd, ResidualDropOrders: 7, CLLateStddev: 1e-6,
		CDLateStddev: 1e-7, OrthogonalityAvailable: orthogonality,
		UpperShockXOverC: .6, ArtifactHashes: []string{hash},
	}
}
