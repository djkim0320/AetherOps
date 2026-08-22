//go:build windows

package main

import (
	"context"
	"strings"
	"testing"
)

func TestProductionFeedProducerRequiresExternalInputsBeforeNetworkWork(t *testing.T) {
	err := run(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "is required") {
		t.Fatalf("missing external inputs did not fail closed: %v", err)
	}
}
