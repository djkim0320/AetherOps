package core

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"
)

func TestOutputSchemasRequireEveryObjectProperty(t *testing.T) {
	schemas := map[string]json.RawMessage{
		"plan":            PlanSchema(),
		"evidence":        EvidenceSchema(),
		"knowledge_patch": KnowledgePatchSchema(),
		"report":          ReportSchema(),
		"review":          ReviewSchema(),
	}
	for name, raw := range schemas {
		t.Run(name, func(t *testing.T) {
			var schema any
			if err := json.Unmarshal(raw, &schema); err != nil {
				t.Fatal(err)
			}
			assertStrictRequiredProperties(t, "$", schema)
		})
	}
}

func TestModelOutputSchemasAvoidUnsupportedUniqueItems(t *testing.T) {
	schemas := map[string]json.RawMessage{
		"plan":            PlanSchema(),
		"evidence":        EvidenceSchema(),
		"knowledge_patch": KnowledgePatchSchema(),
		"report":          ReportSchema(),
		"review":          ReviewSchema(),
	}
	for name, schema := range schemas {
		if bytes.Contains(schema, []byte(`"uniqueItems"`)) {
			t.Fatalf("%s model output schema contains unsupported uniqueItems", name)
		}
	}
}

func TestReviewSchemaDefinesScoreDirection(t *testing.T) {
	var schema map[string]any
	if err := json.Unmarshal(ReviewSchema(), &schema); err != nil {
		t.Fatal(err)
	}
	properties := schema["properties"].(map[string]any)
	scores := properties["scores"].(map[string]any)["properties"].(map[string]any)
	for name, raw := range scores {
		field := raw.(map[string]any)
		if description, _ := field["description"].(string); description != "1 is worst and 5 is best." {
			t.Fatalf("score %s description = %q", name, description)
		}
	}
}

func TestReviewSchemaRequiresFreshResearchForEveryFailure(t *testing.T) {
	var schema map[string]any
	if err := json.Unmarshal(ReviewSchema(), &schema); err != nil {
		t.Fatal(err)
	}
	properties := schema["properties"].(map[string]any)
	actions := properties["remediation_action"].(map[string]any)["enum"].([]any)
	want := []any{"none", "additional_research", "replan"}
	if len(actions) != len(want) {
		t.Fatalf("remediation actions = %#v", actions)
	}
	for index := range want {
		if actions[index] != want[index] {
			t.Fatalf("remediation actions = %#v, want %#v", actions, want)
		}
	}
	for _, action := range actions {
		if action == "report_revision" {
			t.Fatal("current REVIEW schema permits a report-only failure loop")
		}
	}
	taskSchema := properties["remediation_tasks"].(map[string]any)["items"].(map[string]any)
	taskProperties := taskSchema["properties"].(map[string]any)
	if _, exists := taskProperties["requires_new_solver_execution"]; !exists {
		t.Fatal("review remediation task cannot distinguish receipt readback from a new solver execution")
	}
	required := taskSchema["required"].([]any)
	found := false
	for _, name := range required {
		if name == "requires_new_solver_execution" {
			found = true
		}
	}
	if !found {
		t.Fatal("requires_new_solver_execution is optional in the REVIEW response schema")
	}
}

func TestReportSchemaForEvidenceIDsConstrainsVocabularyAndCardinality(t *testing.T) {
	raw, err := ReportSchemaForEvidenceIDs([]string{"collector-a", "engineering-verification"})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(`"uniqueItems"`)) {
		t.Fatal("constrained report schema contains unsupported uniqueItems")
	}
	var schema map[string]any
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatal(err)
	}
	property := schema["properties"].(map[string]any)["evidence_ids"].(map[string]any)
	if property["minItems"] != float64(2) || property["maxItems"] != float64(2) {
		t.Fatalf("evidence_ids cardinality = %#v", property)
	}
	enum := property["items"].(map[string]any)["enum"].([]any)
	if len(enum) != 2 || enum[0] != "collector-a" || enum[1] != "engineering-verification" {
		t.Fatalf("evidence_ids enum = %#v", enum)
	}
	assertStrictRequiredProperties(t, "$", schema)
}

func TestReportSchemaForEvidenceIDsRejectsInvalidIdentitySets(t *testing.T) {
	for name, ids := range map[string][]string{
		"empty":     nil,
		"blank":     {"collector-a", " "},
		"duplicate": {"collector-a", "collector-a"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ReportSchemaForEvidenceIDs(ids); err == nil {
				t.Fatal("invalid evidence identity set was accepted")
			}
		})
	}
}

func TestKnowledgeEvidenceSchemaUsesExclusiveStrictShapes(t *testing.T) {
	var schema map[string]any
	if err := json.Unmarshal(KnowledgePatchSchema(), &schema); err != nil {
		t.Fatal(err)
	}
	properties := schema["properties"].(map[string]any)
	assertions := properties["assertions"].(map[string]any)["items"].(map[string]any)
	assertionProperties := assertions["properties"].(map[string]any)
	evidence := assertionProperties["evidence"].(map[string]any)["items"].(map[string]any)
	branches, ok := evidence["anyOf"].([]any)
	if !ok || len(branches) != 3 {
		t.Fatalf("knowledge evidence branches = %#v, want text, engineering JSON, engineering CSV", evidence["anyOf"])
	}
	wantProperties := []map[string]bool{
		{"kind": true, "source_id": true, "claim_id": true, "blob_hash": true, "byte_start": true, "byte_end": true, "span_hash": true},
		{"kind": true, "artifact_hash": true, "json_pointer": true, "value_hash": true},
		{"kind": true, "artifact_hash": true, "csv_row": true, "value_hash": true},
	}
	for index, rawBranch := range branches {
		branch := rawBranch.(map[string]any)
		if branch["additionalProperties"] != false {
			t.Fatalf("branch %d permits additional properties", index)
		}
		branchProperties := branch["properties"].(map[string]any)
		if len(branchProperties) != len(wantProperties[index]) {
			t.Fatalf("branch %d properties = %#v", index, branchProperties)
		}
		for name := range branchProperties {
			if !wantProperties[index][name] {
				t.Fatalf("branch %d unexpectedly contains %q", index, name)
			}
		}
		kind := branchProperties["kind"].(map[string]any)["const"]
		wantKind := any(KnowledgeEvidenceEngineering)
		if index == 0 {
			wantKind = KnowledgeEvidenceText
		}
		if kind != wantKind {
			t.Fatalf("branch %d kind = %#v, want %#v", index, kind, wantKind)
		}
		for _, hashName := range []string{"blob_hash", "span_hash", "artifact_hash", "value_hash"} {
			property, exists := branchProperties[hashName].(map[string]any)
			if exists && property["pattern"] != "^[a-f0-9]{64}$" {
				t.Fatalf("branch %d %s permits a non-SHA256 value: %#v", index, hashName, property["pattern"])
			}
		}
	}
}

func assertStrictRequiredProperties(t *testing.T, path string, node any) {
	t.Helper()
	switch value := node.(type) {
	case map[string]any:
		properties, hasProperties := value["properties"].(map[string]any)
		if hasProperties && value["type"] == "object" {
			requiredValues, ok := value["required"].([]any)
			if !ok {
				t.Fatalf("%s object does not declare required", path)
			}
			required := make(map[string]bool, len(requiredValues))
			for _, item := range requiredValues {
				name, ok := item.(string)
				if !ok {
					t.Fatalf("%s required contains a non-string value", path)
				}
				required[name] = true
			}
			for name := range properties {
				if !required[name] {
					t.Fatalf("%s property %q is missing from required", path, name)
				}
			}
		}
		for name, child := range value {
			assertStrictRequiredProperties(t, fmt.Sprintf("%s.%s", path, name), child)
		}
	case []any:
		for index, child := range value {
			assertStrictRequiredProperties(t, fmt.Sprintf("%s[%d]", path, index), child)
		}
	}
}
