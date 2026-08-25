package research

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
)

func TestEngineeringScreeningPolicyHasOneOwnerAndKeepsOtherCollectorsPublicOnly(t *testing.T) {
	ownerPolicy, ownerRole := engineeringPolicyForCollector(core.EngineeringScreeningOwnerOrdinal)
	if ownerRole != engineeringScreeningOwnerRole ||
		!strings.Contains(ownerPolicy, "single deterministic owner") ||
		!strings.Contains(ownerPolicy, "complete research plan") ||
		!strings.Contains(ownerPolicy, "every requested su2_naca0012 mesh_size_m case") ||
		!strings.Contains(ownerPolicy, "every XFOIL execution_purpose=screening job") {
		t.Fatalf("owner policy = role %q policy %q", ownerRole, ownerPolicy)
	}
	for _, ordinal := range []int{1, 2} {
		policy, role := engineeringPolicyForCollector(ordinal)
		if role != engineeringScreeningReadRole ||
			!strings.Contains(policy, "not the engineering solver owner") ||
			!strings.Contains(policy, "Do not call su2_naca0012") ||
			!strings.Contains(policy, "Continue the assigned public-source research in parallel") {
			t.Fatalf("collector %d policy = role %q policy %q", ordinal, role, policy)
		}
	}
}

func TestValidateXFOILScreeningCoverageRequiresOneCompleteAttemptScopedBundle(t *testing.T) {
	source := func(id string) core.EvidenceSource {
		return mustEngineeringSource(t, id, strings.Repeat("a", 64), time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC))
	}
	const receiptA = "art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const receiptB = "art_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	complete := core.EvidenceBundle{Sources: []core.EvidenceSource{source(receiptA), source(receiptB)}}
	records := []xfoilScreeningCoverageRecord{
		{JobID: "job-a", Ordinal: core.EngineeringScreeningOwnerOrdinal, Status: "succeeded", ReceiptArtifactID: receiptA},
		{JobID: "job-b", Ordinal: core.EngineeringScreeningOwnerOrdinal, Status: "succeeded", ReceiptArtifactID: receiptB},
	}
	if err := validateXFOILScreeningCoverage(core.EngineeringScreeningOwnerOrdinal, records, complete); err != nil {
		t.Fatalf("complete owner coverage rejected: %v", err)
	}

	missing := complete
	missing.Sources = missing.Sources[:1]
	if err := validateXFOILScreeningCoverage(core.EngineeringScreeningOwnerOrdinal, records, missing); err == nil ||
		!strings.Contains(err.Error(), "omits receipt "+receiptB) {
		t.Fatalf("missing receipt error = %v", err)
	}

	failed := append([]xfoilScreeningCoverageRecord(nil), records...)
	failed[1].Status = "failed"
	if err := validateXFOILScreeningCoverage(core.EngineeringScreeningOwnerOrdinal, failed, complete); err == nil ||
		!strings.Contains(err.Error(), "partial sweep") {
		t.Fatalf("partial sweep error = %v", err)
	}

	nonOwner := append([]xfoilScreeningCoverageRecord(nil), records...)
	nonOwner[0].Ordinal = 1
	if err := validateXFOILScreeningCoverage(1, nonOwner, core.EvidenceBundle{}); err == nil ||
		!strings.Contains(err.Error(), "want owner ordinal") {
		t.Fatalf("non-owner job error = %v", err)
	}

	if err := validateXFOILScreeningCoverage(1, nil, core.EvidenceBundle{}); err != nil {
		t.Fatalf("public-only collector rejected: %v", err)
	}
}

func TestPlannedXFOILScreeningCoverageIsExactAndFailClosed(t *testing.T) {
	plan := testXFOILScreeningPlan(0, 5, 10)
	makeArguments := func(attemptID string, deflection float64) plannedXFOILArguments {
		value := func(value float64) *float64 { return &value }
		integer := func(value int) *int { return &value }
		return plannedXFOILArguments{
			RunID: "run_exact", StageAttemptID: attemptID,
			NACA: "0015", Reynolds: value(1_000_000), Mach: value(.1),
			AlphaStartDeg: value(-6), AlphaEndDeg: value(18), AlphaStepDeg: value(.25),
			ExecutionPurpose: "screening", OptimizationObjective: "minimize_cd_at_target_cl",
			TargetCL: value(.8), MinimumCM: value(-.2),
			FlapChordRatio: value(.3), FlapHingeXOverC: value(.7), FlapHingeYOverC: value(0),
			FlapDeflectionDeg: value(deflection), NCrit: value(9),
			Iterations: integer(200), PanelCount: integer(160),
		}
	}
	record := func(id, attemptID, receiptArtifactID string, deflection float64) plannedXFOILScreeningRecord {
		return plannedXFOILScreeningRecord{
			JobID: id, AttemptID: attemptID, Ordinal: core.EngineeringScreeningOwnerOrdinal,
			StageStatus: "in_progress", Status: "succeeded", ReceiptArtifactID: receiptArtifactID,
			Arguments: makeArguments(attemptID, deflection),
		}
	}
	records := []plannedXFOILScreeningRecord{
		record("zero", "attempt_owner", "art_00000000000000000000000000000000", 0),
		record("five", "attempt_owner", "art_55555555555555555555555555555555", 5),
		record("ten", "attempt_owner", "art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 10),
	}
	bundle := core.EvidenceBundle{}
	for index, item := range records {
		bundle.Sources = append(bundle.Sources, mustEngineeringSource(
			t, item.ReceiptArtifactID, strings.Repeat(string(rune('a'+index)), 64),
			time.Date(2026, 8, 12, 0, index, 0, 0, time.UTC),
		))
	}
	if err := validatePlannedXFOILScreeningCoverage("run_exact", plan, records, bundle); err != nil {
		t.Fatalf("exact planned screening sweep rejected: %v", err)
	}

	tests := []struct {
		name   string
		plan   *core.XFOILScreeningPlan
		mutate func([]plannedXFOILScreeningRecord) []plannedXFOILScreeningRecord
		want   string
	}{
		{name: "zero jobs", plan: plan, mutate: func([]plannedXFOILScreeningRecord) []plannedXFOILScreeningRecord { return nil }, want: "omits planned flap deflection"},
		{name: "partial set", plan: plan, mutate: func(rows []plannedXFOILScreeningRecord) []plannedXFOILScreeningRecord { return rows[:2] }, want: "omits planned flap deflection 10"},
		{name: "duplicate candidate", plan: plan, mutate: func(rows []plannedXFOILScreeningRecord) []plannedXFOILScreeningRecord {
			duplicate := record("five_again", "attempt_owner", "art_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 5)
			return append(rows, duplicate)
		}, want: "duplicate flap deflection 5"},
		{name: "additional candidate", plan: plan, mutate: func(rows []plannedXFOILScreeningRecord) []plannedXFOILScreeningRecord {
			return append(rows, record("twenty", "attempt_owner", "art_cccccccccccccccccccccccccccccccc", 20))
		}, want: "unplanned flap deflection 20"},
		{name: "changed shared condition", plan: plan, mutate: func(rows []plannedXFOILScreeningRecord) []plannedXFOILScreeningRecord {
			changed := *rows[1].Arguments.NCrit + 1
			rows[1].Arguments.NCrit = &changed
			return rows
		}, want: "differs from the immutable plan contract"},
		{name: "omitted explicit zero", plan: plan, mutate: func(rows []plannedXFOILScreeningRecord) []plannedXFOILScreeningRecord {
			rows[0].Arguments.FlapHingeYOverC = nil
			return rows
		}, want: "differs from the immutable plan contract"},
		{name: "failed job", plan: plan, mutate: func(rows []plannedXFOILScreeningRecord) []plannedXFOILScreeningRecord {
			rows[2].Status = "failed"
			rows[2].ReceiptArtifactID = ""
			return rows
		}, want: "partial sweeps are rejected"},
		{name: "receipt-less succeeded job", plan: plan, mutate: func(rows []plannedXFOILScreeningRecord) []plannedXFOILScreeningRecord {
			rows[2].ReceiptArtifactID = ""
			return rows
		}, want: "receipt-less"},
		{name: "wrong owner", plan: plan, mutate: func(rows []plannedXFOILScreeningRecord) []plannedXFOILScreeningRecord {
			rows[0].Ordinal = 1
			return rows
		}, want: "want owner ordinal 0"},
		{name: "cross-attempt split", plan: plan, mutate: func(rows []plannedXFOILScreeningRecord) []plannedXFOILScreeningRecord {
			rows[2].AttemptID = "attempt_other"
			rows[2].Arguments.StageAttemptID = "attempt_other"
			return rows
		}, want: "span owner attempts"},
		{name: "failed owner stage", plan: plan, mutate: func(rows []plannedXFOILScreeningRecord) []plannedXFOILScreeningRecord {
			rows[1].StageStatus = "failed"
			return rows
		}, want: "belongs to failed owner attempt"},
		{name: "no plan authorization", plan: nil, mutate: func(rows []plannedXFOILScreeningRecord) []plannedXFOILScreeningRecord { return rows }, want: "without a structured plan contract"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			copied := make([]plannedXFOILScreeningRecord, len(records))
			copy(copied, records)
			for index := range copied {
				copied[index].Arguments = makeArguments(copied[index].AttemptID, *records[index].Arguments.FlapDeflectionDeg)
			}
			err := validatePlannedXFOILScreeningCoverage("run_exact", test.plan, test.mutate(copied), bundle)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want substring %q", err, test.want)
			}
		})
	}
}

func TestPlannedXFOILScreeningCoverageAcceptsBoundedOperatingPointMatrix(t *testing.T) {
	plan := testXFOILScreeningPlan(-2, 0, 2)
	plan.OperatingPoints = []core.XFOILOperatingPoint{
		{ID: "re200_cl025", Reynolds: 200_000, Mach: .055, NCrit: 9, TargetCL: .25, MinimumCM: -.2},
		{ID: "re350_cl040", Reynolds: 350_000, Mach: .065, NCrit: 9, TargetCL: .4, MinimumCM: -.2},
	}
	value := func(value float64) *float64 { return &value }
	integer := func(value int) *int { return &value }
	records := make([]plannedXFOILScreeningRecord, 0, 6)
	bundle := core.EvidenceBundle{}
	for pointIndex, point := range plan.OperatingPoints {
		for candidateIndex, deflection := range plan.CandidateDeflectionsDeg {
			id := fmt.Sprintf("matrix_%d_%d", pointIndex, candidateIndex)
			receiptID := fmt.Sprintf("art_%032x", pointIndex*10+candidateIndex+1)
			records = append(records, plannedXFOILScreeningRecord{
				JobID: id, AttemptID: "attempt_matrix", Ordinal: core.EngineeringScreeningOwnerOrdinal,
				StageStatus: "in_progress", Status: "succeeded", ReceiptArtifactID: receiptID,
				Arguments: plannedXFOILArguments{
					RunID: "run_matrix", StageAttemptID: "attempt_matrix", NACA: plan.NACA,
					Reynolds: value(point.Reynolds), Mach: value(point.Mach), NCrit: value(point.NCrit),
					TargetCL: value(point.TargetCL), MinimumCM: value(point.MinimumCM),
					AlphaStartDeg: value(plan.AlphaStartDeg), AlphaEndDeg: value(plan.AlphaEndDeg),
					AlphaStepDeg: value(plan.AlphaStepDeg), FlapChordRatio: value(plan.FlapChordRatio),
					FlapHingeXOverC: value(plan.FlapHingeXOverC), FlapHingeYOverC: value(plan.FlapHingeYOverC),
					FlapDeflectionDeg: value(deflection), Iterations: integer(plan.Iterations), PanelCount: integer(plan.PanelCount),
					ExecutionPurpose: "screening", OptimizationObjective: plan.OptimizationObjective,
				},
			})
			bundle.Sources = append(bundle.Sources, mustEngineeringSource(
				t, receiptID, fmt.Sprintf("%064x", pointIndex*10+candidateIndex+1),
				time.Date(2026, 8, 21, 0, pointIndex, candidateIndex, 0, time.UTC),
			))
		}
	}
	if err := validatePlannedXFOILScreeningCoverage("run_matrix", plan, records, bundle); err != nil {
		t.Fatalf("bounded operating-point matrix rejected: %v", err)
	}
	if err := validatePlannedXFOILScreeningCoverage("run_matrix", plan, records[:len(records)-1], bundle); err == nil ||
		!strings.Contains(err.Error(), "omits planned flap deflection") {
		t.Fatalf("partial matrix error = %v", err)
	}
}
