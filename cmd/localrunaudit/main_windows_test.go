//go:build windows && amd64

package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/evalgate"
)

func TestParseOptionsRequiresExplicitAuditIdentity(t *testing.T) {
	for _, arguments := range [][]string{
		nil,
		{"-data-root", `C:\data`, "-project-id", "project"},
		{"-data-root", `C:\data`, "-project-id", "project", "-run-id", "run", "extra"},
	} {
		if _, err := parseOptions(arguments, &bytes.Buffer{}); err == nil {
			t.Fatalf("parseOptions(%q) accepted an incomplete or positional invocation", arguments)
		}
	}
	options, err := parseOptions([]string{
		"-data-root", ` C:\data `, "-project-id", " project ", "-run-id", " run ",
	}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if options.DataRoot != `C:\data` || options.ProjectID != "project" || options.RunID != "run" {
		t.Fatalf("parsed options = %+v", options)
	}
}

func TestResolveExistingDataRootRejectsNonDirectory(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing")
	if _, err := resolveExistingDataRoot(missing); err == nil {
		t.Fatal("missing data root was accepted")
	}
	file := filepath.Join(t.TempDir(), "not-a-directory")
	if err := osWriteTestFile(file); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveExistingDataRoot(file); err == nil {
		t.Fatal("file data root was accepted")
	}
}

func TestRequiredXFOILProofRejectsIncompleteCampaign(t *testing.T) {
	proof := evalgate.XFOILOptimizationProof{
		Required: true, Objective: "minimize_cd_at_target_cl", TargetCL: 0.8, MinimumCM: -0.2,
		ScreeningAttemptCount: 7, ScreeningCandidateCount: 7,
		SucceededScreeningAttemptCount: 6, FailedScreeningAttemptCount: 1,
	}
	if _, _, err := verifyRequiredXFOILCampaign(nil, nil, coreRunForRejectedProof(), proof); err == nil ||
		!strings.Contains(err.Error(), "7+1") {
		t.Fatalf("incomplete XFOIL campaign error = %v", err)
	}
}
