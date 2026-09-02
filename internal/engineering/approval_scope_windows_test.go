//go:build windows && amd64

package engineering

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestTypedEngineeringArgumentsMatchCanonicalApprovalScope(t *testing.T) {
	typed := SU2CFDSpec{
		RunID: "run-scope", StageAttemptID: "attempt-scope",
		CaseID: "case_a", MeshSource: "material", MeshID: "doc_mesh",
		MeshSHA256: strings.Repeat("a", 64), ConfigSource: "", ConfigID: "", ConfigSHA256: "",
		Solver: "EULER", TurbulenceModel: "NONE",
		ConfigOverrides: map[string]string{"ITER": "80", "MACH_NUMBER": "0.3", "AOA": "2"},
		OutputFiles:     []string{"surface_csv"}, TimeoutSeconds: 600,
	}
	// This map has the shape produced when Codex approval parameters are
	// decoded before the typed MCP handler runs. Key order must not affect the
	// exact scope bytes or their SHA-256.
	approvalArguments := map[string]any{
		"case_id":          "case_a",
		"mesh_source":      "material",
		"mesh_id":          "doc_mesh",
		"mesh_sha256":      strings.Repeat("a", 64),
		"config_source":    "",
		"config_id":        "",
		"config_sha256":    "",
		"solver":           "EULER",
		"turbulence_model": "NONE",
		"config_overrides": map[string]any{"ITER": "80", "MACH_NUMBER": "0.3", "AOA": "2"},
		"output_files":     []any{"surface_csv"},
		"timeout_seconds":  float64(600),
		"stage_attempt_id": "attempt-scope",
		"run_id":           "run-scope",
	}
	typedJSON, err := canonicalJSON(typed)
	if err != nil {
		t.Fatal(err)
	}
	approvalJSON, err := canonicalJSON(approvalArguments)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(typedJSON, approvalJSON) {
		t.Fatalf("typed scope %s differs from approval scope %s", typedJSON, approvalJSON)
	}
	typedDigest := sha256.Sum256(typedJSON)
	approvalDigest := sha256.Sum256(approvalJSON)
	if typedDigest != approvalDigest {
		t.Fatalf("typed hash %s differs from approval hash %s",
			hex.EncodeToString(typedDigest[:]), hex.EncodeToString(approvalDigest[:]))
	}
}
