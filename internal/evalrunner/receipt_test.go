package evalrunner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/core"
)

func TestLoadReceiptAcceptsOnlyStrictLiveRunnerProvenance(t *testing.T) {
	dataset := testDataset()
	build := testBuild()
	valid := validLiveReceipt()
	path := writeReceiptFixture(t, valid)
	loaded, err := LoadReceipt(path, dataset, build)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.SHA256 == "" || loaded.RunnerExecution().RunOrigin != RunOrigin || len(loaded.RunnerExecution().Mappings) != 12 {
		t.Fatalf("loaded runner receipt = %+v", loaded)
	}

	tests := []struct {
		name   string
		mutate func(*Receipt)
		want   string
	}{
		{name: "forged origin", mutate: func(receipt *Receipt) { receipt.RunOrigin = "manual" }, want: "provenance"},
		{name: "fixture class", mutate: func(receipt *Receipt) { receipt.EvidenceClass = EvidenceProtocolFixture }, want: "provenance"},
		{name: "claims release pass", mutate: func(receipt *Receipt) { receipt.ReleaseGatePassed = true }, want: "provenance"},
		{name: "ambiguous", mutate: func(receipt *Receipt) {
			receipt.Completeness.AmbiguousCases = 1
			receipt.Completeness.ProductTerminalCases = 11
		}, want: "unambiguous"},
		{name: "submission failure", mutate: func(receipt *Receipt) { receipt.Completeness.SubmissionFailures = 1 }, want: "unambiguous"},
		{name: "duplicate run", mutate: func(receipt *Receipt) { receipt.Cases[1].RunID = receipt.Cases[0].RunID }, want: "reuses run"},
		{name: "prompt mismatch", mutate: func(receipt *Receipt) { receipt.Cases[0].PromptSHA256 = strings.Repeat("f", 64) }, want: "exact dataset prompt"},
		{name: "case run set mismatch", mutate: func(receipt *Receipt) { receipt.Cases[0].EvalRunSetID = "evalrs_other" }, want: "case provenance"},
		{name: "pending approval", mutate: func(receipt *Receipt) {
			receipt.Cases[0].PendingApprovals = []ApprovalObservation{{ID: "approval", Status: "pending"}}
		}, want: "clean terminal"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := validLiveReceipt()
			test.mutate(&candidate)
			_, err := LoadReceipt(writeReceiptFixture(t, candidate), dataset, build)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("LoadReceipt error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestLoadReceiptRejectsDatasetBuildAndManualManifest(t *testing.T) {
	valid := validLiveReceipt()
	path := writeReceiptFixture(t, valid)
	dataset := testDataset()
	dataset.SHA256 = strings.Repeat("b", 64)
	if _, err := LoadReceipt(path, dataset, testBuild()); err == nil || !strings.Contains(err.Error(), "different evaluation dataset") {
		t.Fatalf("dataset mismatch error = %v", err)
	}
	build := testBuild()
	build.ExecutableSHA256 = strings.Repeat("9", 64)
	if _, err := LoadReceipt(path, testDataset(), build); err == nil || !strings.Contains(err.Error(), "different product build") {
		t.Fatalf("build mismatch error = %v", err)
	}
	manual := map[string]any{
		"schema": "aetherops_release_evaluation_execution_v3", "dataset_name": testDataset().Name,
		"dataset_sha256": testDataset().SHA256, "cases": []any{},
	}
	if _, err := LoadReceipt(writeArbitraryJSON(t, manual), testDataset(), testBuild()); err == nil {
		t.Fatal("manual execution manifest was accepted as a runner receipt")
	}
}

func validLiveReceipt() Receipt {
	dataset := testDataset()
	started := time.Date(2026, 8, 9, 1, 0, 0, 0, time.UTC)
	terminal := started.Add(2 * time.Hour)
	receipt := Receipt{
		Schema: ReceiptSchemaV1, RunOrigin: RunOrigin, EvidenceClass: EvidenceLiveProductAPI,
		ReleaseGatePassed: false, RequiresOfflineVerification: true, EligibleForOfflineVerification: true,
		EvalRunSetID: "evalrs_live", DatasetName: dataset.Name, DatasetSHA256: dataset.SHA256,
		ProductBuild: testBuild(), EndpointSHA256: strings.Repeat("4", 64),
		Target: Target{ProjectID: "project_eval"}, StartedAt: started, TerminalAt: terminal,
		Completeness: Completeness{
			ExpectedCases: 12, AccountedCases: 12, RunnerTerminalCases: 12,
			ProductTerminalCases: 12, AllProductRunsTerminal: true,
		},
		Cases: make([]CaseReceipt, len(dataset.Cases)),
	}
	for index, item := range dataset.Cases {
		caseStarted := started.Add(time.Duration(index+1) * time.Minute)
		caseTerminal := caseStarted.Add(time.Minute)
		receipt.Cases[index] = CaseReceipt{
			RunOrigin: RunOrigin, EvalRunSetID: receipt.EvalRunSetID,
			DatasetCaseID: item.ID, Mode: item.Mode, PromptSHA256: promptSHA256(item.Prompt()),
			State: CaseTerminal, RunID: "run_" + strings.ReplaceAll(item.ID, "-", "_"),
			ProductStatus: core.RunSucceeded, ProductRevision: 9,
			StartedAt: &caseStarted, TerminalAt: &caseTerminal,
		}
	}
	return receipt
}

func writeReceiptFixture(t *testing.T, receipt Receipt) string {
	t.Helper()
	return writeArbitraryJSON(t, receipt)
}

func writeArbitraryJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, '\n')
	path := filepath.Join(t.TempDir(), "receipt.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
