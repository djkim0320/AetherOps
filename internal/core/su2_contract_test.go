package core

import (
	"encoding/json"
	"strings"
	"testing"
)

func validSU2MeshStudyPlan() ResearchPlan {
	return ResearchPlan{
		Question: "Run an actual NACA0012 SU2 mesh study", Mode: "engineering",
		Workstreams: []Workstream{{
			ID: "engineering", Question: "execute and compare every case",
			PreferredSourceKinds: []string{}, RequiredEvidence: []string{},
		}},
		SourceRequirements: []string{}, AcceptanceCriteria: []string{},
		SU2MeshStudy: &SU2MeshStudyPlan{
			Profile: SU2MeshStudyProfileV1, NACA: "0012", Mach: .8, AlphaDeg: 1.25,
			Iterations: 1000, MeshSizesM: []float64{.04, .025, .015},
			DomainProfile: SU2FixedDomainV1, Objective: SU2ObjectiveGridStudy,
			ReferenceComparison: "qualitative_context",
		},
	}
}

func TestSU2MeshStudyPlanClosesCapabilityMismatch(t *testing.T) {
	plan := validSU2MeshStudyPlan()
	if err := plan.Validate(); err != nil {
		t.Fatalf("valid SU2 study rejected: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*SU2MeshStudyPlan)
	}{
		{"unimplemented domain", func(value *SU2MeshStudyPlan) { value.DomainProfile = "farfield_20c" }},
		{"unsupported overlay", func(value *SU2MeshStudyPlan) { value.ReferenceComparison = "quantitative_overlay" }},
		{"unordered meshes", func(value *SU2MeshStudyPlan) { value.MeshSizesM = []float64{.04, .015, .025} }},
		{"too few meshes", func(value *SU2MeshStudyPlan) { value.MeshSizesM = []float64{.04, .02} }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := *plan.SU2MeshStudy
			candidate.MeshSizesM = append([]float64(nil), candidate.MeshSizesM...)
			test.mutate(&candidate)
			changed := plan
			changed.SU2MeshStudy = &candidate
			if err := changed.Validate(); err == nil {
				t.Fatal("invalid SU2 capability contract was accepted")
			}
		})
	}
	general := plan
	general.Mode = "general"
	if err := general.Validate(); err == nil {
		t.Fatal("general research accepted an SU2 execution contract")
	}
}

func TestPlanSchemaRequiresExplicitSU2ContractField(t *testing.T) {
	var schema map[string]any
	if err := json.Unmarshal(PlanSchema(), &schema); err != nil {
		t.Fatal(err)
	}
	required, ok := schema["required"].([]any)
	if !ok {
		t.Fatal("plan schema required array missing")
	}
	found := false
	for _, value := range required {
		found = found || value == "su2_mesh_study"
	}
	if !found {
		t.Fatal("plan schema does not require an explicit nullable SU2 contract")
	}
}

func TestEngineeringReviewRequiresStrongTaskCompleteness(t *testing.T) {
	verdict := ReviewVerdict{
		CitationIntegrityPercent: 100,
		KnowledgeIntegrity: &KnowledgeIntegrity{
			EvidenceIntegrityPercent: 100, UnsupportedAssertions: 0,
		},
		CriticalErrors: []string{}, RevisionRequests: []string{},
		Scores: ReviewScores{
			TaskFulfillment: 3, ClaimSupport: 5, SourceQuality: 4,
			Completeness: 3, ReasoningAndUncertainty: 5, ClarityAndReproducibility: 4,
		},
	}
	if passes, err := verdict.Passes(); err != nil || !passes {
		t.Fatalf("baseline gate changed unexpectedly: passes=%t err=%v", passes, err)
	}
	report := ReportManifest{EngineeringAssessment: &EngineeringAssessment{}}
	if passes, err := verdict.PassesForReport(report); err != nil || passes {
		t.Fatalf("weak engineering task/completeness passed: passes=%t err=%v", passes, err)
	}
	verdict.Scores.TaskFulfillment = 4
	verdict.Scores.Completeness = 4
	if passes, err := verdict.PassesForReport(report); err != nil || !passes {
		t.Fatalf("strong engineering review rejected: passes=%t err=%v", passes, err)
	}
}

func TestEngineeringAssessmentRejectsFailedHardGate(t *testing.T) {
	assessment := testEngineeringAssessment()
	assessment.Checks[0].Passed = false
	if err := assessment.Validate(); err == nil || !strings.Contains(err.Error(), "hard engineering") {
		t.Fatalf("failed hard gate error = %v", err)
	}
}

func testEngineeringAssessment() EngineeringAssessment {
	hashes := []string{
		strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64),
	}
	jobs := []string{"eng_case_a", "eng_case_b", "eng_case_c"}
	receipts := []string{
		"art_0123456789abcdef0123456789abcdef",
		"art_1123456789abcdef0123456789abcdef",
		"art_2123456789abcdef0123456789abcdef",
	}
	cases := make([]SU2CaseEvidence, 3)
	for index := range cases {
		cases[index] = SU2CaseEvidence{
			JobID: jobs[index], ReceiptArtifactID: receipts[index],
			ReceiptSHA256: hashes[index], MeshSizeM: .04 - float64(index)*.01,
			MeshNodes: 100, MeshVolumeElements: 200, AirfoilBoundaryElements: 20,
			CL: .3, CD: .02, ArtifactHashes: []string{hashes[index]},
		}
	}
	return EngineeringAssessment{
		Profile: SU2MeshStudyProfileV1, Outcome: EngineeringOutcomeConfirmed,
		OutcomeReason: "all checks passed", SU2Cases: cases,
		Checks: []EngineeringAcceptanceCheck{{
			ID: "integrity", Class: EngineeringGateHard, Passed: true,
			Detail: "verified", EvidenceHashes: hashes,
		}},
	}
}
