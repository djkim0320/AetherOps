package core

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestStageExecutionContractHashMatchesV11Literal(t *testing.T) {
	want := fmt.Sprintf("%x", sha256.Sum256([]byte(StageExecutionContractV11)))
	if StageExecutionContractSHA256 != want {
		t.Fatalf("stage execution contract hash = %q, want %q", StageExecutionContractSHA256, want)
	}
}

func TestEngineeringReceiptArtifactIDUsesExactStoreGrammar(t *testing.T) {
	valid := "art_0123456789abcdef0123456789abcdef"
	if !IsEngineeringReceiptArtifactID(valid) {
		t.Fatalf("valid receipt artifact id %q was rejected", valid)
	}
	for name, value := range map[string]string{
		"CAS SHA-256":   strings.Repeat("a", 64),
		"forged label":  "art_forged_receipt",
		"uppercase hex": "art_0123456789ABCDEF0123456789abcdef",
	} {
		t.Run(name, func(t *testing.T) {
			if IsEngineeringReceiptArtifactID(value) {
				t.Fatalf("non-artifact identity %q was accepted", value)
			}
		})
	}
}

func TestKnowledgeEvidenceRefRejectsMixedOrInventedEngineeringEvidence(t *testing.T) {
	valid := KnowledgeEvidenceRef{
		Kind: KnowledgeEvidenceEngineering, ArtifactHash: strings.Repeat("a", 64),
		JSONPointer: "/metrics/cd", ValueHash: strings.Repeat("b", 64),
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid engineering evidence rejected: %v", err)
	}
	mixed := valid
	mixed.SourceID = "source"
	if err := mixed.Validate(); err == nil || !strings.Contains(err.Error(), "contains text fields") {
		t.Fatalf("mixed engineering/text evidence error = %v", err)
	}
	emptyHash := valid
	emptyHash.ValueHash = ""
	if err := emptyHash.Validate(); err == nil || !strings.Contains(err.Error(), "valid artifact and value hashes") {
		t.Fatalf("empty engineering value hash error = %v", err)
	}
}

func TestRunStateMachine(t *testing.T) {
	valid := [][2]RunStatus{
		{RunQueued, RunPlanning},
		{RunQueued, RunFailed},
		{RunPlanning, RunCollecting},
		{RunCollecting, RunSynthesizing},
		{RunSynthesizing, RunReviewing},
		{RunReviewing, RunRevising},
		{RunRevising, RunReviewing},
		{RunReviewing, RunSucceeded},
	}
	for _, pair := range valid {
		if !CanTransition(pair[0], pair[1]) {
			t.Fatalf("expected transition %s -> %s", pair[0], pair[1])
		}
	}
	if CanTransition(RunSucceeded, RunPlanning) {
		t.Fatal("terminal run must not restart implicitly")
	}
}

func TestEngineeringReceiptEvidenceSourceUsesClosedURN(t *testing.T) {
	captured := time.Date(2026, time.August, 10, 4, 0, 0, 123, time.UTC)
	source, err := EngineeringReceiptEvidenceSource(
		"art_0123456789abcdef0123456789abcdef", "xfoil_polar", strings.Repeat("a", 64), captured,
	)
	if err != nil {
		t.Fatal(err)
	}
	artifactID, ok := EngineeringReceiptArtifactID(source)
	if !ok || artifactID != source.ID {
		t.Fatalf("receipt URN did not round-trip: %+v", source)
	}
	bundle := EvidenceBundle{
		WorkstreamID: "engineering", Summary: "verified",
		Claims:  []EvidenceClaim{{ID: "claim", Statement: "computed", SourceIDs: []string{source.ID}}},
		Sources: []EvidenceSource{source}, Limitations: []string{},
	}
	if err := bundle.Validate("engineering"); err != nil {
		t.Fatal(err)
	}
	mutated := source
	mutated.ID = "art_other"
	if _, ok := EngineeringReceiptArtifactID(mutated); ok {
		t.Fatal("mismatched receipt URN and source id was accepted")
	}
	bundle.Sources[0] = mutated
	if err := bundle.Validate("engineering"); err == nil {
		t.Fatal("mismatched receipt source passed bundle validation")
	}
	custom := source
	custom.URL = "urn:example:engineering-receipt:" + custom.ID
	if _, ok := EngineeringReceiptArtifactID(custom); ok {
		t.Fatal("arbitrary receipt URN namespace was accepted")
	}
}

func TestResearchPlanValidatesStructuredXFOILScreeningContract(t *testing.T) {
	plan := ResearchPlan{
		Question: "optimize a flap", Mode: "engineering",
		Workstreams: []Workstream{{
			ID: "engineering", Question: "screen candidates",
			PreferredSourceKinds: []string{}, RequiredEvidence: []string{},
		}},
		SourceRequirements: []string{}, AcceptanceCriteria: []string{},
		XFOILScreening: &XFOILScreeningPlan{
			NACA: "0015", Reynolds: 1_000_000, Mach: .1,
			AlphaStartDeg: -6, AlphaEndDeg: 18, AlphaStepDeg: .25,
			FlapChordRatio: .3, FlapHingeXOverC: .7, FlapHingeYOverC: 0,
			CandidateDeflectionsDeg: []float64{0, 5, 10, 15, 20, 25, 30},
			NCrit:                   9, Iterations: 200, PanelCount: 160,
			OptimizationObjective: "minimize_cd_at_target_cl", TargetCL: .8, MinimumCM: -.2,
		},
	}
	if err := plan.Validate(); err != nil {
		t.Fatalf("valid structured screening plan rejected: %v", err)
	}
	matrix := *plan.XFOILScreening
	matrix.OperatingPoints = []XFOILOperatingPoint{
		{ID: "re200_cl025", Reynolds: 200_000, Mach: .055, NCrit: 9, TargetCL: .25, MinimumCM: -.2},
		{ID: "re350_cl040", Reynolds: 350_000, Mach: .065, NCrit: 9, TargetCL: .4, MinimumCM: -.2},
	}
	matrix.CandidateDeflectionsDeg = []float64{-4, -2, 0, 2, 4}
	plan.XFOILScreening = &matrix
	if err := plan.Validate(); err != nil {
		t.Fatalf("valid declarative screening matrix rejected: %v", err)
	}
	duplicatePoint := matrix
	duplicatePoint.OperatingPoints = append([]XFOILOperatingPoint(nil), matrix.OperatingPoints...)
	duplicatePoint.OperatingPoints[1] = duplicatePoint.OperatingPoints[0]
	duplicatePoint.OperatingPoints[1].ID = "same_condition"
	plan.XFOILScreening = &duplicatePoint
	if err := plan.Validate(); err == nil {
		t.Fatal("duplicate numerical operating point was accepted under another id")
	}
	overflow := matrix
	overflow.OperatingPoints = append(overflow.OperatingPoints, overflow.OperatingPoints...)
	overflow.OperatingPoints = append(overflow.OperatingPoints, overflow.OperatingPoints...)
	overflow.OperatingPoints = append(overflow.OperatingPoints, overflow.OperatingPoints...)
	overflow.OperatingPoints = append(overflow.OperatingPoints, XFOILOperatingPoint{ID: "overflow", Reynolds: 400_000, Mach: .07, NCrit: 9, TargetCL: .5, MinimumCM: -.2})
	plan.XFOILScreening = &overflow
	if err := plan.Validate(); err == nil {
		t.Fatal("oversized declarative screening matrix was accepted")
	}
	duplicate := *plan.XFOILScreening
	duplicate.OperatingPoints = nil
	duplicate.CandidateDeflectionsDeg = []float64{0, -0.0}
	plan.XFOILScreening = &duplicate
	if err := plan.Validate(); err == nil {
		t.Fatal("duplicate signed-zero screening candidates were accepted")
	}
	plan.Mode = "general"
	if err := plan.Validate(); err == nil {
		t.Fatal("general research mode accepted an XFOIL screening contract")
	}
}

func TestResearchPlanRejectsUncontractedXFOILWork(t *testing.T) {
	plan := ResearchPlan{
		Question: "compare E387 and SD7062 with XFOIL", Mode: "engineering",
		Workstreams: []Workstream{{ID: "solver", Question: "run the requested polar comparison"}},
	}
	if err := plan.Validate(); err == nil || !strings.Contains(err.Error(), "xfoil_screening") {
		t.Fatalf("uncontracted XFOIL plan error = %v", err)
	}
	plan.Question = "compare public airfoil literature"
	if err := plan.Validate(); err != nil {
		t.Fatalf("non-XFOIL engineering plan rejected: %v", err)
	}
}

func TestResearchPlanAllowsExplicitlyExcludedXFOILWithoutScreening(t *testing.T) {
	plan := ResearchPlan{
		Question: "Run a three-grid NACA0012 study with SU2.\n제외: XFOIL 최적화와 형상 변경", Mode: "engineering",
		Workstreams: []Workstream{{
			ID: "solver", Question: "Run SU2 only; do not use XFOIL for the requested comparison",
		}},
		SourceRequirements: []string{"Use public SU2 validation sources without XFOIL"},
		AcceptanceCriteria: []string{"XFOIL is out of scope for this SU2 mesh study"},
	}
	if err := plan.Validate(); err != nil {
		t.Fatalf("SU2 plan with explicit XFOIL exclusion rejected: %v", err)
	}

	plan.Workstreams = append(plan.Workstreams, Workstream{
		ID: "polar", Question: "Run XFOIL polar comparison for the same airfoil",
	})
	if err := plan.Validate(); err == nil || !strings.Contains(err.Error(), "xfoil_screening") {
		t.Fatalf("positive XFOIL work hidden beside an exclusion was accepted: %v", err)
	}

	plan.Workstreams = []Workstream{{
		ID: "polar", Question: "Run XFOIL and exclude outlier points from the reported polar",
	}}
	if err := plan.Validate(); err == nil || !strings.Contains(err.Error(), "xfoil_screening") {
		t.Fatalf("positive XFOIL work with an unrelated exclusion was accepted: %v", err)
	}
}

func TestResearchPlanAllowsXFOILBulletInsideExcludedMarkdownSection(t *testing.T) {
	plan := ResearchPlan{
		Question: "Run a three-grid NACA0012 study with SU2.\n# \uC81C\uC678 \uBC94\uC704\n- \uD615\uC0C1 \uCD5C\uC801\uD654, \uD50C\uB7A9, XFOIL \uBE44\uAD50\n# \uC644\uB8CC \uAE30\uC900\n- Use actual SU2 receipts.",
		Mode:     "engineering",
		Workstreams: []Workstream{{
			ID: "solver", Question: "Run the requested SU2 grid study",
		}},
	}
	if err := plan.Validate(); err != nil {
		t.Fatalf("excluded Markdown XFOIL bullet rejected: %v", err)
	}

	plan.Question += "\n# \uCD94\uAC00 \uC2E4\uD589\n- Run XFOIL for a polar comparison."
	if err := plan.Validate(); err == nil || !strings.Contains(err.Error(), "xfoil_screening") {
		t.Fatalf("positive XFOIL work after excluded section was accepted: %v", err)
	}
}

func TestReviewGate(t *testing.T) {
	passing := ReviewVerdict{
		CitationIntegrityPercent: 100,
		KnowledgeIntegrity: &KnowledgeIntegrity{
			EvidenceIntegrityPercent: 100,
			UnsupportedAssertions:    0,
		},
		Scores: ReviewScores{
			TaskFulfillment: 4, ClaimSupport: 4, SourceQuality: 4,
			Completeness: 4, ReasoningAndUncertainty: 4, ClarityAndReproducibility: 4,
		},
	}
	ok, err := passing.Passes()
	if err != nil || !ok {
		t.Fatalf("expected pass, got ok=%v err=%v", ok, err)
	}
	withoutKnowledge := passing
	withoutKnowledge.KnowledgeIntegrity = nil
	if _, err := withoutKnowledge.Passes(); err == nil {
		t.Fatal("review verdict without knowledge_integrity was accepted")
	}
	passing.Scores.SourceQuality = 2
	ok, err = passing.Passes()
	if err != nil || ok {
		t.Fatalf("single score below three must fail, got ok=%v err=%v", ok, err)
	}
}

func TestRecoveryDoesNotReplayExternalSideEffects(t *testing.T) {
	if got := RecoveryStatus(StageCollect, true); got != RunUncertain {
		t.Fatalf("got %s", got)
	}
	if got := RecoveryStatus(StagePlan, false); got != RunInterrupted {
		t.Fatalf("got %s", got)
	}
}

func TestEvidenceAndReportCitationIntegrity(t *testing.T) {
	hash := strings.Repeat("a", 64)
	bundle := EvidenceBundle{
		WorkstreamID: "w1", Summary: "summary",
		Sources: []EvidenceSource{{ID: "s1", URL: "https://example.com/source", Title: "source", CapturedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), BlobHash: hash}},
		Claims:  []EvidenceClaim{{ID: "c1", Statement: "claim", SourceIDs: []string{"s1"}}},
	}
	if err := bundle.Validate("w1"); err != nil {
		t.Fatal(err)
	}
	report := ReportManifest{
		Title: "report", AnswerMarkdown: "answer [1]",
		Citations:      []Citation{{Marker: "[1]", SourceIDs: []string{"s1"}, ClaimIDs: []string{"c1"}}},
		EvidenceIDs:    []string{"w1"},
		ArtifactHashes: []string{hash},
		KnowledgePatch: KnowledgePatch{
			SchemaVersion: KnowledgePatchSchemaV1, UnitRegistryVersion: CurrentUnitRegistryVersion,
			Entities: []KnowledgeEntity{}, Assertions: []KnowledgeAssertion{},
		},
	}
	if err := report.Validate([]EvidenceBundle{bundle}); err != nil {
		t.Fatal(err)
	}
	report.Citations[0].SourceIDs[0] = "unknown"
	if err := report.Validate([]EvidenceBundle{bundle}); err == nil {
		t.Fatal("report citation to unknown source was accepted")
	}

	report.Citations[0].SourceIDs[0] = "s1"
	second := bundle
	second.WorkstreamID = "w2"
	if err := report.Validate([]EvidenceBundle{bundle, second}); err == nil {
		t.Fatal("ambiguous cross-workstream source and claim ids were accepted")
	}
	second.Sources = []EvidenceSource{{ID: "s2", URL: "https://example.com/source-2", Title: "source 2", CapturedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), BlobHash: hash}}
	second.Claims = []EvidenceClaim{{ID: "c2", Statement: "claim 2", SourceIDs: []string{"s2"}}}
	if err := report.Validate([]EvidenceBundle{bundle, second}); err == nil {
		t.Fatal("report that omitted one collected evidence bundle was accepted")
	}
}

func TestEvidenceBundleRejectsPlaceholderCaptureTimes(t *testing.T) {
	hash := strings.Repeat("a", 64)
	base := EvidenceBundle{
		WorkstreamID: "w1",
		Summary:      "summary",
		Sources: []EvidenceSource{{
			ID: "s1", URL: "https://example.com/source", Title: "source",
			CapturedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), BlobHash: hash,
		}},
		Claims: []EvidenceClaim{{ID: "c1", Statement: "claim", SourceIDs: []string{"s1"}}},
	}
	for _, capturedAt := range []time.Time{
		time.Time{},
		time.Unix(0, 0).UTC(),
		time.Date(1999, 12, 31, 23, 59, 59, 0, time.UTC),
	} {
		bundle := base
		bundle.Sources = append([]EvidenceSource(nil), base.Sources...)
		bundle.Sources[0].CapturedAt = capturedAt
		if err := bundle.Validate("w1"); err == nil || !strings.Contains(err.Error(), "invalid capture time") {
			t.Fatalf("placeholder capture time %s was accepted: %v", capturedAt, err)
		}
	}
	placeholderHash := base
	placeholderHash.Sources = append([]EvidenceSource(nil), base.Sources...)
	placeholderHash.Sources[0].BlobHash = strings.Repeat("0", 64)
	if err := placeholderHash.Validate("w1"); err == nil || !strings.Contains(err.Error(), "invalid blob hash") {
		t.Fatalf("all-zero evidence hash was accepted: %v", err)
	}
}

func TestReviewGateRejectsUnsupportedKnowledge(t *testing.T) {
	verdict := ReviewVerdict{
		CitationIntegrityPercent: 100,
		KnowledgeIntegrity: &KnowledgeIntegrity{
			EvidenceIntegrityPercent: 100,
			UnsupportedAssertions:    1,
		},
		Scores: ReviewScores{
			TaskFulfillment: 4, ClaimSupport: 4, SourceQuality: 4,
			Completeness: 4, ReasoningAndUncertainty: 4, ClarityAndReproducibility: 4,
		},
	}
	passes, err := verdict.Passes()
	if err != nil || passes {
		t.Fatalf("unsupported knowledge assertion passed: ok=%v err=%v", passes, err)
	}
	verdict.KnowledgeIntegrity.UnsupportedAssertions = 0
	verdict.KnowledgeIntegrity.EvidenceIntegrityPercent = 99
	passes, err = verdict.Passes()
	if err != nil || passes {
		t.Fatalf("incomplete knowledge evidence passed: ok=%v err=%v", passes, err)
	}
}
