package core

import (
	"encoding/json"
	"strings"
	"testing"
)

func validSU2CaseSetPlan() ResearchPlan {
	return ResearchPlan{
		Question: "Run exact project-owned SU2 cases", Mode: "engineering",
		Workstreams: []Workstream{{
			ID: "engineering", Question: "execute and compare every case",
			PreferredSourceKinds: []string{}, RequiredEvidence: []string{},
		}},
		SourceRequirements: []string{}, AcceptanceCriteria: []string{},
		SU2Cases: &SU2CaseSetPlan{
			Objective: "compare two user-provided meshes",
			Cases: []SU2CasePlan{{
				ID: "coarse", MeshSource: SU2InputMaterial, MeshID: "doc_mesh_coarse",
				MeshSHA256: strings.Repeat("a", 64), ConfigSource: "", ConfigID: "", ConfigSHA256: "",
				Solver: "EULER", TurbulenceModel: "NONE", ConfigOverrides: map[string]string{"ITER": "1000"},
				OutputFiles: []string{"surface_csv"}, TimeoutSeconds: 900,
			}},
		},
	}
}

func TestSU2CaseSetRequiresExactProjectOwnedInputsAndPhysics(t *testing.T) {
	plan := validSU2CaseSetPlan()
	if err := plan.Validate(); err != nil {
		t.Fatalf("valid SU2 case set rejected: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*SU2CasePlan)
	}{
		{"missing mesh hash", func(value *SU2CasePlan) { value.MeshSHA256 = "" }},
		{"unsupported solver", func(value *SU2CasePlan) { value.Solver = "MULTIPHYSICS" }},
		{"RANS without turbulence model", func(value *SU2CasePlan) { value.Solver, value.TurbulenceModel = "RANS", "NONE" }},
		{"unbound config locator", func(value *SU2CasePlan) { value.ConfigSource, value.ConfigID = "", "doc_cfg" }},
		{"duplicate output", func(value *SU2CasePlan) { value.OutputFiles = []string{"surface_csv", "surface_csv"} }},
		{"unbounded timeout", func(value *SU2CasePlan) { value.TimeoutSeconds = 7201 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := plan.SU2Cases.Cases[0]
			candidate.ConfigOverrides = map[string]string{"ITER": "1000"}
			candidate.OutputFiles = append([]string(nil), candidate.OutputFiles...)
			test.mutate(&candidate)
			changed := plan
			set := *plan.SU2Cases
			set.Cases = []SU2CasePlan{candidate}
			changed.SU2Cases = &set
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
		found = found || value == "su2_cases"
	}
	if !found {
		t.Fatal("plan schema does not require an explicit nullable SU2 contract")
	}
	text := string(PlanSchema())
	if !strings.Contains(text, `"case_id"`) || !strings.Contains(text, `"mesh_sha256"`) || !strings.Contains(text, `"config_overrides"`) ||
		strings.Contains(text, "su2_naca0012") || strings.Contains(text, "su2_mesh_study") {
		t.Fatal("plan schema does not expose only the project-owned general SU2 contract")
	}
}

func TestResearchPlanRejectsRemovedLegacySU2PresetContract(t *testing.T) {
	plan := validSU2CaseSetPlan()
	plan.SU2Cases = nil
	plan.SU2MeshStudy = &SU2MeshStudyPlan{}
	if err := plan.Validate(); err == nil || !strings.Contains(err.Error(), "legacy SU2 preset plans are not executable") {
		t.Fatalf("removed legacy SU2 contract error = %v", err)
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
