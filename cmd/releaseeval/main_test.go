package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/evalgate"
	"github.com/djkim0320/AetherOps/internal/evalrunner"
	"github.com/djkim0320/AetherOps/internal/releasegate"
)

func TestLiveQualityEvidenceRejectsManualOrFixtureProvenanceBeforeReadingDetails(t *testing.T) {
	dataset := releaseEvalTestDataset()
	build := releaseEvalTestBuild()
	verified := evalgate.Receipt{
		Passed: true, RequiredCases: 12, ObservedPasses: 12, ProductBuild: build,
		ExecutionSource: evalgate.RunnerExecutionSource, EvalRunSetID: "evalrs_test",
		RunnerReceiptSHA256: strings.Repeat("4", 64),
	}
	for _, runner := range []evalrunner.Receipt{
		{Schema: evalrunner.ReceiptSchemaV1, RunOrigin: "manual", EvidenceClass: evalrunner.EvidenceLiveProductAPI},
		{Schema: evalrunner.ReceiptSchemaV1, RunOrigin: evalrunner.RunOrigin, EvidenceClass: evalrunner.EvidenceProtocolFixture},
	} {
		if _, err := liveQualityEvidence(dataset, verified, runner, "does-not-exist.json", strings.Repeat("5", 64)); err == nil {
			t.Fatalf("manual/fixture runner provenance reached evidence creation: %+v", runner)
		}
	}
}

func TestVerifyRunnerRequiresPreparedLedgerBeforeLoadingInputs(t *testing.T) {
	err := run(context.Background(), []string{"-mode", "verify-runner"})
	if err == nil || !strings.Contains(err.Error(), "-prepared-ledger is required") {
		t.Fatalf("missing prepared ledger error = %v", err)
	}
}

func TestBindPreparedLedgerRequiresExactCandidateAndChangesWithLedger(t *testing.T) {
	root := t.TempDir()
	build := releaseEvalTestBuild()
	firstPath := filepath.Join(root, "ledger-r1.json")
	writeReleaseEvalPreparedLedger(t, firstPath, build, time.Now().UTC().Add(-time.Minute))
	firstSHA256, err := bindPreparedLedger(firstPath, build, "live_quality_12")
	if err != nil {
		t.Fatal(err)
	}
	if !validSHA256(firstSHA256) {
		t.Fatalf("prepared ledger SHA-256 = %q", firstSHA256)
	}

	mismatch := build
	mismatch.RuntimeManifestSHA256 = strings.Repeat("9", 64)
	if _, err := bindPreparedLedger(firstPath, mismatch, "live_quality_12"); err == nil {
		t.Fatal("prepared ledger from another product build was accepted")
	}

	secondPath := filepath.Join(root, "same-candidate-different-ledger.json")
	writeReleaseEvalPreparedLedger(t, secondPath, build, time.Now().UTC().Add(-2*time.Minute))
	secondSHA256, err := bindPreparedLedger(secondPath, build, "live_quality_12")
	if err != nil {
		t.Fatal(err)
	}
	if secondSHA256 == firstSHA256 {
		t.Fatal("different prepared ledgers for the same candidate produced the same binding")
	}
}

func TestLiveQualitySubjectsBindPreparedLedger(t *testing.T) {
	preparedLedgerSHA256 := strings.Repeat("5", 64)
	receipt := evalgate.Receipt{ProductBuild: releaseEvalTestBuild(), DatasetSHA256: strings.Repeat("a", 64)}
	runner := evalrunner.Receipt{SHA256: strings.Repeat("4", 64)}
	subjects := liveQualitySubjectHashes(receipt, runner, strings.Repeat("6", 64), preparedLedgerSHA256)
	seen := make(map[string]string, len(subjects))
	for _, subject := range subjects {
		seen[subject.Name] = subject.SHA256
	}
	if seen["prepared-ledger"] != preparedLedgerSHA256 {
		t.Fatalf("prepared-ledger subject = %q", seen["prepared-ledger"])
	}
}

func writeReleaseEvalPreparedLedger(t *testing.T, path string, build evalgate.ProductBuildBinding, preparedAt time.Time) {
	t.Helper()
	ledger, err := releasegate.PrepareLedger(build, preparedAt)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.MarshalIndent(ledger, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestValidateLiveEvidencePathsRequiresDetailsSibling(t *testing.T) {
	directory := t.TempDir()
	details := filepath.Join(directory, "live-quality.details.json")
	evidence := filepath.Join(directory, "live-quality.evidence.json")
	if err := validateLiveEvidencePaths(details, evidence); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name     string
		details  string
		evidence string
	}{
		{name: "details suffix", details: filepath.Join(directory, "details.json"), evidence: evidence},
		{name: "different directory", details: details, evidence: filepath.Join(t.TempDir(), "evidence.json")},
		{name: "same file", details: details, evidence: details},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := validateLiveEvidencePaths(test.details, test.evidence); err == nil {
				t.Fatal("invalid live evidence paths were accepted")
			}
		})
	}
}

func releaseEvalTestDataset() evalgate.Dataset {
	cases := make([]evalgate.Case, 0, 12)
	for index := 1; index <= 6; index++ {
		cases = append(cases, evalgate.Case{ID: fmt.Sprintf("general-%02d", index), Mode: "general", Question: "q", Requirements: []string{"r"}})
	}
	for index := 1; index <= 6; index++ {
		cases = append(cases, evalgate.Case{ID: fmt.Sprintf("engineering-%02d", index), Mode: "engineering", Question: "q", Requirements: []string{"r"}})
	}
	return evalgate.Dataset{
		Schema: evalgate.DatasetSchemaV1, Name: "test", SHA256: strings.Repeat("a", 64), Cases: cases,
		ReleaseGate: evalgate.ReleaseGate{RequiredCases: 12, RequiredPasses: 12, QualityPolicy: evalgate.QualityPolicy{
			CitationIntegrityPercent: 100, MinimumAverageScore: 4, MinimumAxisScore: 3,
		}},
	}
}

func releaseEvalTestBuild() evalgate.ProductBuildBinding {
	return evalgate.ProductBuildBinding{
		Version: evalgate.ReleaseProductVersion, ExecutableSHA256: strings.Repeat("1", 64),
		RuntimeManifestSHA256: strings.Repeat("2", 64), KnowledgeSidecarTreeSHA256: strings.Repeat("3", 64),
	}
}
