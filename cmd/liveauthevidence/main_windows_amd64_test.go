//go:build windows && amd64

package main

import (
	"context"
	"testing"
)

func TestRunRequiresOnlyProtectedDescriptorWorkflowInputs(t *testing.T) {
	if err := run(context.Background(), nil); err == nil {
		t.Fatal("live auth evidence command accepted missing required inputs")
	}
	if err := run(context.Background(), []string{"-ledger", "ledger.json", "-out", "receipt.json", "-descriptor", "session.json", "extra"}); err == nil {
		t.Fatal("live auth evidence command accepted positional injection")
	}
}
