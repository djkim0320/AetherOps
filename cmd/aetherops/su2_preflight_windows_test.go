//go:build windows && amd64

package main

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/djkim0320/AetherOps/internal/su2host"
)

func TestWriteSU2HostPreflightEmitsNativeTypedReceipt(t *testing.T) {
	var output bytes.Buffer
	if err := writeSU2HostPreflight(&output); err != nil {
		t.Fatal(err)
	}
	var receipt su2host.CandidatePreflightReceipt
	decoder := json.NewDecoder(&output)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&receipt); err != nil {
		t.Fatal(err)
	}
	if err := receipt.Validate(); err != nil {
		t.Fatal(err)
	}
	if receipt.SU2ExecutionAttempted || receipt.Compatible != receipt.Observation.Compatible() {
		t.Fatalf("candidate command emitted an inconsistent receipt: %+v", receipt)
	}
}
