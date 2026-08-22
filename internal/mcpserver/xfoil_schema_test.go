package mcpserver

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/engineering"
)

func TestSolverToolResultUsesBoundedCompactTextAndTypedStructuredContent(t *testing.T) {
	job := engineering.JobResult{
		JobID: "eng_0123456789abcdef0123456789abcdef", Operation: "xfoil_polar",
		Status: "succeeded", Executed: true, NumericallyValid: true,
		ReceiptArtifactID: "art_0123456789abcdef0123456789abcdef",
		SummaryMetrics:    map[string]any{"sample_count": 97, "target_cl": 0.8},
		Artifacts: []engineering.ArtifactResult{{
			ArtifactID: "art_fedcba9876543210fedcba9876543210", Role: "receipt",
			FileName:  strings.Repeat("large-model-hidden-field", 2048),
			MediaType: "application/json", SHA256: strings.Repeat("a", 64), Size: 123,
		}},
		Provenance: core.EvidenceSource{ID: "internal-provenance-must-not-be-json"},
		EvidenceHandles: []engineering.EvidenceHandle{{
			Kind: core.KnowledgeEvidenceEngineering, ArtifactHash: strings.Repeat("b", 64),
			JSONPointer: strings.Repeat("/hidden", 2048), ValueHash: strings.Repeat("c", 64),
		}},
	}
	result := toolResultFor("xfoil_polar", job)
	if result["isError"] != false {
		t.Fatalf("compact solver result failed: %+v", result)
	}
	content, ok := result["content"].([]map[string]any)
	if !ok || len(content) != 1 {
		t.Fatalf("solver text content = %#v", result["content"])
	}
	text, ok := content[0]["text"].(string)
	if !ok || len(text) == 0 || len(text) > maxEngineeringSolverTextBytes {
		t.Fatalf("solver text size = %d", len(text))
	}
	var compact map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &compact); err != nil {
		t.Fatal(err)
	}
	wantKeys := map[string]bool{
		"job_id": true, "operation": true, "status": true, "executed": true,
		"reused_result": true, "numerically_valid": true,
		"receipt_artifact_id": true, "summary_metrics": true,
	}
	if len(compact) != len(wantKeys) {
		t.Fatalf("compact solver fields = %v", compact)
	}
	for key := range compact {
		if !wantKeys[key] {
			t.Fatalf("compact solver text exposes %q", key)
		}
	}
	var receiptArtifactID string
	if err := json.Unmarshal(compact["receipt_artifact_id"], &receiptArtifactID); err != nil ||
		receiptArtifactID != job.ReceiptArtifactID {
		t.Fatalf("compact receipt artifact id = %q err=%v", receiptArtifactID, err)
	}
	structured, ok := result["structuredContent"].(engineering.JobResult)
	if !ok || !reflect.DeepEqual(structured, job) {
		t.Fatalf("typed structured content changed: %#v", result["structuredContent"])
	}
	encoded, err := json.Marshal(structured)
	if err != nil {
		t.Fatal(err)
	}
	encodedText := string(encoded)
	if strings.Contains(encodedText, `"provenance"`) || strings.Contains(encodedText, `"sha256"`) ||
		!strings.Contains(encodedText, `"cas_blob_sha256"`) ||
		!strings.Contains(encodedText, `"receipt_artifact_id"`) {
		t.Fatalf("structured solver wire contract = %s", encodedText)
	}
}

func TestEngineeringGetDefinitionAdvertisesBoundedCopyReadyEvidence(t *testing.T) {
	definitions := engineeringToolDefinitions(func(name, description string, extra map[string]any, required ...string) map[string]any {
		return map[string]any{"name": name, "description": description}
	})
	for _, definition := range definitions {
		if definition["name"] != "engineering_get" {
			continue
		}
		description := definition["description"].(string)
		for _, required := range []string{"summary_metrics", "evidence_handles", "copy-ready", "Raw solver arrays remain in CAS"} {
			if !strings.Contains(description, required) {
				t.Fatalf("engineering_get description omits %q: %s", required, description)
			}
		}
		return
	}
	t.Fatal("engineering_get tool definition is missing")
}

func TestXFOILToolDefinitionExposesSealedPlainFlapControls(t *testing.T) {
	definitions := engineeringToolDefinitions(func(name, description string, extra map[string]any, required ...string) map[string]any {
		return map[string]any{"name": name, "description": description, "properties": extra, "required": required}
	})
	var tool map[string]any
	for _, definition := range definitions {
		if definition["name"] == "xfoil_polar" {
			tool = definition
			break
		}
	}
	if tool == nil {
		t.Fatal("xfoil_polar tool definition is missing")
	}
	properties := tool["properties"].(map[string]any)
	for _, name := range []string{
		"flap_chord_ratio", "flap_hinge_x_over_c", "flap_hinge_y_over_c",
		"flap_deflection_deg", "ncrit", "iterations", "panel_count",
		"execution_purpose", "optimization_objective", "target_cl", "minimum_cm", "verification_of_job_id",
	} {
		if properties[name] == nil {
			t.Fatalf("xfoil_polar schema omits %s", name)
		}
	}
	if got := properties["ncrit"].(map[string]any)["default"]; got != 9 {
		t.Fatalf("ncrit default: got %v", got)
	}
	if got := properties["iterations"].(map[string]any)["default"]; got != 250 {
		t.Fatalf("iterations default: got %v", got)
	}
	if got := properties["panel_count"].(map[string]any)["default"]; got != 160 {
		t.Fatalf("panel_count default: got %v", got)
	}
	objective := properties["optimization_objective"].(map[string]any)["enum"].([]string)
	if len(objective) != 1 || objective[0] != "minimize_cd_at_target_cl" {
		t.Fatalf("optimization objective enum = %v", objective)
	}
	for _, required := range tool["required"].([]string) {
		if required == "flap_deflection_deg" || required == "ncrit" || required == "iterations" || required == "panel_count" ||
			required == "execution_purpose" || required == "optimization_objective" || required == "target_cl" || required == "minimum_cm" || required == "verification_of_job_id" {
			t.Fatalf("optional XFOIL control was made unconditionally required: %s", required)
		}
	}
}
