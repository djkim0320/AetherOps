//go:build windows && amd64

package engineering

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestTypedEngineeringArgumentsMatchCanonicalApprovalScope(t *testing.T) {
	typed := SU2Spec{
		RunID: "run-scope", StageAttemptID: "attempt-scope",
		Mach: 0.3, AlphaDeg: 2, Iterations: 80, MeshSizeM: 0.08,
	}
	// This map has the shape produced when Codex approval parameters are
	// decoded before the typed MCP handler runs. Key order must not affect the
	// exact scope bytes or their SHA-256.
	approvalArguments := map[string]any{
		"mesh_size_m":      0.08,
		"iterations":       float64(80),
		"alpha_deg":        float64(2),
		"mach":             0.3,
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
