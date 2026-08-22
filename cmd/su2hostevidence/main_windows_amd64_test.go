//go:build windows && amd64

package main

import (
	"context"
	"testing"
)

func TestRunRequiresLedgerAndOutput(t *testing.T) {
	if err := run(context.Background(), nil); err == nil {
		t.Fatal("SU2 host evidence command accepted missing ledger and output")
	}
	if err := run(context.Background(), []string{"-ledger", "ledger.json", "-out", "receipt.json", "extra"}); err == nil {
		t.Fatal("SU2 host evidence command accepted positional command injection")
	}
}
