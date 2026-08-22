package main

import (
	"strings"
	"testing"
)

func TestRunRejectsIncompleteAndUnknownCommands(t *testing.T) {
	for _, args := range [][]string{nil, {"unknown"}, {"capture-host"}, {"finalize"}} {
		if err := run(args); err == nil {
			t.Fatalf("args %v were accepted", args)
		}
	}
}

func TestFinalizeNeverAcceptsFixtureShortcutFlag(t *testing.T) {
	err := run([]string{"finalize", "-fixture", "passed"})
	if err == nil || !strings.Contains(err.Error(), "flag provided but not defined") {
		t.Fatalf("fixture shortcut error = %v", err)
	}
}
