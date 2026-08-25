package research

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
)

func TestCanonicalizeEvidenceClaimIDsScopesStableIDsByRunAndWorkstream(t *testing.T) {
	bundleA := core.EvidenceBundle{
		WorkstreamID: "a", Summary: "summary",
		Claims:      []core.EvidenceClaim{{ID: "claim-1", Statement: "supported", SourceIDs: []string{"source-a"}}},
		Sources:     []core.EvidenceSource{{ID: "source-a", URL: "https://example.test/a", Title: "a", CapturedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), BlobHash: strings.Repeat("a", 64)}},
		Limitations: []string{},
	}
	bundleB := bundleA
	bundleB.WorkstreamID = "b"
	bundleB.Sources = []core.EvidenceSource{{ID: "source-b", URL: "https://example.test/b", Title: "b", CapturedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), BlobHash: strings.Repeat("b", 64)}}
	bundleB.Claims = []core.EvidenceClaim{{ID: "claim-1", Statement: "supported", SourceIDs: []string{"source-b"}}}

	first, err := canonicalizeEvidenceClaimIDs("run-1", bundleA)
	if err != nil {
		t.Fatal(err)
	}
	repeated, err := canonicalizeEvidenceClaimIDs("run-1", first)
	if err != nil {
		t.Fatal(err)
	}
	second, err := canonicalizeEvidenceClaimIDs("run-1", bundleB)
	if err != nil {
		t.Fatal(err)
	}
	wantDigest := sha256.Sum256([]byte("run-1\x00a\x00claim-1"))
	want := fmt.Sprintf("ecl_%x", wantDigest)
	if first.Claims[0].ID != want || repeated.Claims[0].ID != want {
		t.Fatalf("canonical id/restart stability = %q/%q, want %q", first.Claims[0].ID, repeated.Claims[0].ID, want)
	}
	if second.Claims[0].ID == want {
		t.Fatal("same raw claim id collided across workstreams")
	}
	if first.Claims[0].SourceIDs[0] != "source-a" || second.Claims[0].SourceIDs[0] != "source-b" {
		t.Fatal("trusted source handles were rewritten")
	}
	if err := validateGlobalEvidenceIdentity([]core.EvidenceBundle{first, second}); err != nil {
		t.Fatalf("distinct canonical claims failed global validation: %v", err)
	}
}

func TestKnowledgePatchOntologyContractRejectsInventedTermsAndValueKinds(t *testing.T) {
	contract := ontologyPatchContract{
		OntologyID: "ontology-test",
		Classes:    []ontologyPatchTerm{{Key: "experiment", Kind: "class"}},
		Properties: []ontologyPatchTerm{
			{Key: "has_result", Kind: "object_property", ValueKind: "entity"},
			{Key: "has_value", Kind: "datatype_property", ValueKind: "number"},
		},
	}
	valid := core.KnowledgePatch{
		Entities:   []core.KnowledgeEntity{{ID: "run", Type: "experiment"}, {ID: "result", Type: "experiment"}},
		Assertions: []core.KnowledgeAssertion{{ID: "relation", Predicate: "has_result", ObjectEntityID: "result"}},
	}
	if err := validateKnowledgePatchOntologyContract(valid, contract); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*core.KnowledgePatch){
		"invented class":    func(p *core.KnowledgePatch) { p.Entities[0].Type = "XFOILResult" },
		"invented property": func(p *core.KnowledgePatch) { p.Assertions[0].Predicate = "aetherops:target_cl" },
		"literal as entity": func(p *core.KnowledgePatch) { p.Assertions[0].Predicate = "has_value" },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := valid
			candidate.Entities = append([]core.KnowledgeEntity(nil), valid.Entities...)
			candidate.Assertions = append([]core.KnowledgeAssertion(nil), valid.Assertions...)
			mutate(&candidate)
			if err := validateKnowledgePatchOntologyContract(candidate, contract); err == nil {
				t.Fatal("invalid ontology patch was accepted")
			}
		})
	}
}

func TestReportSchemaSpecializesOntologyEnums(t *testing.T) {
	contract := ontologyPatchContract{
		OntologyID: "ontology-test",
		Classes:    []ontologyPatchTerm{{Key: "experiment", Kind: "class"}, {Key: "measurement", Kind: "class"}},
		Properties: []ontologyPatchTerm{{Key: "has_result", Kind: "object_property", ValueKind: "entity"}},
	}
	schema, err := reportSchemaForEvidenceAndOntology([]core.EvidenceBundle{{WorkstreamID: "workstream"}}, contract)
	if err != nil {
		t.Fatal(err)
	}
	text := string(schema)
	for _, required := range []string{`"enum":["experiment","measurement"]`, `"enum":["has_result"]`} {
		if !strings.Contains(text, required) {
			t.Fatalf("specialized schema does not contain %s: %s", required, text)
		}
	}
}

func TestGlobalEvidenceIdentityRejectsLegacyAndCanonicalCollisions(t *testing.T) {
	legacy := core.EvidenceBundle{
		WorkstreamID: "legacy", Summary: "summary",
		Claims:      []core.EvidenceClaim{{ID: "claim-1", Statement: "supported", SourceIDs: []string{"source-a"}}},
		Sources:     []core.EvidenceSource{{ID: "source-a", URL: "https://example.test/a", Title: "a", CapturedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), BlobHash: strings.Repeat("a", 64)}},
		Limitations: []string{},
	}
	legacyCollision := legacy
	legacyCollision.WorkstreamID = "legacy-other"
	legacyCollision.Sources = []core.EvidenceSource{{ID: "source-c", URL: "https://example.test/c", Title: "c", CapturedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), BlobHash: strings.Repeat("c", 64)}}
	legacyCollision.Claims = []core.EvidenceClaim{{ID: "claim-1", Statement: "also supported", SourceIDs: []string{"source-c"}}}
	if err := validateGlobalEvidenceIdentity([]core.EvidenceBundle{legacy, legacyCollision}); err == nil || !strings.Contains(err.Error(), "not canonical") {
		t.Fatalf("legacy evidence identity error = %v", err)
	}
	canonical, err := canonicalizeEvidenceClaimIDs("run-1", legacy)
	if err != nil {
		t.Fatal(err)
	}
	collision := canonical
	collision.WorkstreamID = "other"
	collision.Sources = []core.EvidenceSource{{ID: "source-b", URL: "https://example.test/b", Title: "b", CapturedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), BlobHash: strings.Repeat("b", 64)}}
	collision.Claims = append([]core.EvidenceClaim(nil), canonical.Claims...)
	collision.Claims[0].SourceIDs = append([]string(nil), canonical.Claims[0].SourceIDs...)
	collision.Claims[0].SourceIDs = []string{"source-b"}
	if err := validateGlobalEvidenceIdentity([]core.EvidenceBundle{canonical, collision}); err == nil || !strings.Contains(err.Error(), "duplicate evidence claim id") {
		t.Fatalf("canonical collision error = %v", err)
	}
}

func TestCollectorRawEvidenceRejectsReservedCanonicalClaimNamespace(t *testing.T) {
	output := collectorEvidenceOutput{
		WorkstreamID: "a", Summary: "summary",
		Claims:                        []core.EvidenceClaim{{ID: "ecl_" + strings.Repeat("a", 64), Statement: "supported", SourceIDs: []string{"source-a"}}},
		Sources:                       []core.EvidenceSource{{ID: "source-a", URL: "https://example.test/a", Title: "a", CapturedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), BlobHash: strings.Repeat("a", 64)}},
		EngineeringReceiptArtifactIDs: []string{}, Limitations: []string{},
	}
	if err := validateCollectorEvidenceOutput(output, "a"); err == nil || !strings.Contains(err.Error(), "reserved canonical namespace") {
		t.Fatalf("reserved raw claim id error = %v", err)
	}
}

func TestValidateEvidenceBundleAcceptsClosedEngineeringReceiptWithoutExternalURL(t *testing.T) {
	source, err := core.EngineeringReceiptEvidenceSource(
		"art_0123456789abcdef0123456789abcdef",
		"xfoil_polar",
		strings.Repeat("a", 64),
		time.Date(2026, time.August, 12, 8, 36, 23, 0, time.UTC),
	)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(source.URL)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme == "http" || parsed.Scheme == "https" {
		t.Fatalf("engineering receipt unexpectedly uses an external URL: %q", source.URL)
	}
	bundle := evidenceBundleForValidation(source)
	if err := validateEvidenceBundle(bundle, bundle.WorkstreamID); err != nil {
		t.Fatalf("closed engineering receipt was rejected: %v", err)
	}
	if err := bundle.Validate(bundle.WorkstreamID); err != nil {
		t.Fatalf("research and core validators disagree: %v", err)
	}
}

func TestCollectorEvidenceOutputReferencesEngineeringReceiptByOpaqueArtifactIDOnly(t *testing.T) {
	const artifactID = "art_c5aaceab749bfca36db1ddd6e6f87bd9"
	output := collectorEvidenceOutput{
		WorkstreamID: "engineering",
		Summary:      "actual XFOIL receipt reference",
		Claims: []core.EvidenceClaim{{
			ID: "claim", Statement: "10 degree flap result", SourceIDs: []string{artifactID},
		}},
		Sources:                       []core.EvidenceSource{},
		EngineeringReceiptArtifactIDs: []string{artifactID},
		Limitations:                   []string{},
	}
	if err := validateCollectorEvidenceOutput(output, "engineering"); err != nil {
		t.Fatalf("opaque engineering receipt reference was rejected: %v", err)
	}

	// A model must not be able to smuggle a complete receipt object, including
	// a plausible-looking but mutated 64-character SHA-256, through sources.
	output.Sources = []core.EvidenceSource{{
		ID:         artifactID,
		URL:        "urn:aetherops:engineering-receipt:" + artifactID,
		Title:      "AetherOps engineering receipt: xfoil_polar",
		Publisher:  "AetherOps engineering runtime",
		CapturedAt: time.Date(2026, time.August, 12, 9, 49, 7, 381765200, time.UTC),
		BlobHash:   "b1dc4d2ed5d28616a9159cfbc2e9bba8ecf1e2b6cf67fb0d13f7a330c24501a3",
	}}
	output.EngineeringReceiptArtifactIDs = []string{}
	if err := validateCollectorEvidenceOutput(output, "engineering"); err == nil ||
		!strings.Contains(err.Error(), "must be referenced only through engineering_receipt_artifact_ids") {
		t.Fatalf("model-authored engineering receipt object error = %v", err)
	}
}

func TestCollectorEvidenceOutputRejectsCASHashAndMalformedReceiptIDs(t *testing.T) {
	for name, artifactID := range map[string]string{
		"CAS SHA-256":   strings.Repeat("a", 64),
		"forged label":  "art_forged_receipt",
		"uppercase hex": "art_0123456789ABCDEF0123456789abcdef",
	} {
		t.Run(name, func(t *testing.T) {
			output := collectorEvidenceOutput{
				WorkstreamID: "engineering", Summary: "invalid receipt identity",
				Claims: []core.EvidenceClaim{{
					ID: "claim", Statement: "computed result", SourceIDs: []string{artifactID},
				}},
				Sources: []core.EvidenceSource{}, EngineeringReceiptArtifactIDs: []string{artifactID},
				Limitations: []string{},
			}
			if err := validateCollectorEvidenceOutput(output, "engineering"); err == nil ||
				!strings.Contains(err.Error(), "artifact id") {
				t.Fatalf("receipt identity %q error = %v", artifactID, err)
			}
		})
	}
}

func TestCollectorEvidenceOutputRejectsDuplicateEngineeringReceiptArtifactIDs(t *testing.T) {
	const artifactID = "art_c5aaceab749bfca36db1ddd6e6f87bd9"
	output := collectorEvidenceOutput{
		WorkstreamID: "engineering",
		Summary:      "actual XFOIL receipt reference",
		Claims: []core.EvidenceClaim{{
			ID: "claim", Statement: "10 degree flap result", SourceIDs: []string{artifactID},
		}},
		Sources:                       []core.EvidenceSource{},
		EngineeringReceiptArtifactIDs: []string{artifactID, artifactID},
		Limitations:                   []string{},
	}
	if err := validateCollectorEvidenceOutput(output, "engineering"); err == nil ||
		!strings.Contains(err.Error(), "duplicate evidence source id") {
		t.Fatalf("duplicate engineering receipt artifact ids error = %v", err)
	}
}

func TestValidateEvidenceBundleRequiresPublicURLOrClosedReceiptURN(t *testing.T) {
	capturedAt := time.Date(2026, time.August, 12, 8, 36, 23, 0, time.UTC)
	validPublic := core.EvidenceSource{
		ID: "public", URL: "https://example.com/source", Title: "Public source",
		CapturedAt: capturedAt, BlobHash: strings.Repeat("b", 64),
	}
	if err := validateEvidenceBundle(evidenceBundleForValidation(validPublic), "engineering"); err != nil {
		t.Fatalf("valid public evidence was rejected: %v", err)
	}

	tests := []struct {
		name   string
		source core.EvidenceSource
	}{
		{
			name: "missing public URL",
			source: core.EvidenceSource{
				ID: "public", Title: "Public source", CapturedAt: capturedAt,
				BlobHash: strings.Repeat("b", 64),
			},
		},
		{
			name: "denied engineering call placeholder",
			source: core.EvidenceSource{
				ID: "denied-xfoil-call", Title: "XFOIL call was denied", CapturedAt: capturedAt,
				BlobHash: strings.Repeat("b", 64),
			},
		},
		{
			name: "artifact-shaped id without closed receipt URN",
			source: core.EvidenceSource{
				ID:        "art_0123456789abcdef0123456789abcdef",
				Title:     "AetherOps engineering receipt: xfoil_polar",
				Publisher: "AetherOps engineering runtime", CapturedAt: capturedAt,
				BlobHash: strings.Repeat("b", 64),
			},
		},
		{
			name: "forged receipt namespace",
			source: core.EvidenceSource{
				ID:        "art_0123456789abcdef0123456789abcdef",
				URL:       "urn:example:engineering-receipt:art_0123456789abcdef0123456789abcdef",
				Title:     "AetherOps engineering receipt: xfoil_polar",
				Publisher: "AetherOps engineering runtime", CapturedAt: capturedAt,
				BlobHash: strings.Repeat("b", 64),
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateEvidenceBundle(evidenceBundleForValidation(test.source), "engineering")
			if err == nil || !strings.Contains(err.Error(), "a denied or failed tool call is not evidence") {
				t.Fatalf("validation error = %v, want strict locator rejection", err)
			}
		})
	}
}

func evidenceBundleForValidation(source core.EvidenceSource) core.EvidenceBundle {
	return core.EvidenceBundle{
		WorkstreamID: "engineering",
		Summary:      "validated provenance",
		Claims: []core.EvidenceClaim{{
			ID: "claim", Statement: "computed result", SourceIDs: []string{source.ID},
		}},
		Sources:     []core.EvidenceSource{source},
		Limitations: []string{},
	}
}

func TestDecodeStrictStillRejectsMultipleSchemaValidJSONValues(t *testing.T) {
	raw := json.RawMessage(
		`{"workstream_id":"ws","summary":"first","claims":[],"sources":[],"limitations":[]}` +
			"\n" +
			`{"workstream_id":"ws","summary":"second","claims":[],"sources":[],"limitations":[]}`,
	)
	if _, err := decodeStrict[core.EvidenceBundle](raw); err == nil ||
		!strings.Contains(err.Error(), "multiple JSON values") {
		t.Fatalf("decodeStrict error = %v, want multiple JSON values rejection", err)
	}
}

func TestStripStageCapabilityIdentityRemovesPlanAttemptLeakage(t *testing.T) {
	plan := core.ResearchPlan{
		Question: "에어포일 최적화",
		Mode:     "engineering",
		Workstreams: []core.Workstream{{
			ID: "aero", Question: "해석 자료와 풍동자료를 비교한다",
			PreferredSourceKinds: []string{"공식 문서", "run_id=run_0123456789abcdef0123456789abcdef 사용"},
			RequiredEvidence:     []string{"raw polar", "stage_attempt_id=stg_0123456789abcdef0123456789abcdef"},
		}},
		SourceRequirements: []string{
			"UIUC 원자료를 사용한다",
			"모든 도구 호출에는 run_id=run_0123456789abcdef0123456789abcdef 및 stage_attempt_id=stg_0123456789abcdef0123456789abcdef를 사용한다",
		},
		AcceptanceCriteria: []string{"재현 가능해야 한다", "stg_0123456789abcdef0123456789abcdef를 보존한다"},
	}
	normalized, err := stripStageCapabilityIdentity(plan)
	if err != nil {
		t.Fatal(err)
	}
	if len(normalized.SourceRequirements) != 1 || normalized.SourceRequirements[0] != "UIUC 원자료를 사용한다" {
		t.Fatalf("source requirements retained capability identity: %#v", normalized.SourceRequirements)
	}
	if len(normalized.AcceptanceCriteria) != 1 || len(normalized.Workstreams[0].PreferredSourceKinds) != 1 || len(normalized.Workstreams[0].RequiredEvidence) != 1 {
		t.Fatalf("nested capability identity was not stripped: %+v", normalized)
	}
	if err := validateResearchPlan(normalized); err != nil {
		t.Fatalf("normalized plan is invalid: %v", err)
	}
}

func TestStripStageCapabilityIdentityRejectsWorkstreamAuthority(t *testing.T) {
	plan := core.ResearchPlan{Question: "q", Mode: "general", Workstreams: []core.Workstream{{
		ID: "ws", Question: "stg_0123456789abcdef0123456789abcdef 권한으로 조사한다",
	}}, SourceRequirements: []string{}, AcceptanceCriteria: []string{}}
	if _, err := stripStageCapabilityIdentity(plan); err == nil {
		t.Fatal("workstream question with a stage capability identity was accepted")
	}
}

func TestEngineeringEvidenceValueUsesExactJSONPointer(t *testing.T) {
	reference := core.KnowledgeEvidenceRef{JSONPointer: "/runs/0/lift~1drag"}
	value, err := engineeringEvidenceValue([]byte(`{"runs":[{"lift/drag":12.50}]}`), reference)
	if err != nil {
		t.Fatal(err)
	}
	if number, ok := value.(json.Number); !ok || number.String() != "12.50" {
		t.Fatalf("JSON pointer value = %#v", value)
	}
	if _, err := engineeringEvidenceValue([]byte(`{"runs":[]}`), reference); err == nil {
		t.Fatal("out-of-range JSON pointer was accepted")
	}
}

func TestEngineeringEvidenceValueUsesOneBasedCSVRecords(t *testing.T) {
	reference := core.KnowledgeEvidenceRef{CSVRow: 2}
	value, err := engineeringEvidenceValue([]byte("name,value\nlift,12.5\n"), reference)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(value, []string{"lift", "12.5"}) {
		t.Fatalf("CSV value = %#v", value)
	}
	reference.CSVRow = 3
	if _, err := engineeringEvidenceValue([]byte("name,value\nlift,12.5\n"), reference); err == nil {
		t.Fatal("missing CSV row was accepted")
	}
}
