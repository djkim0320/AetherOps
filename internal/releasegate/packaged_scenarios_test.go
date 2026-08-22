package releasegate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAttachEvidenceRejectsGenericPackagedScenarioDetails(t *testing.T) {
	root := t.TempDir()
	build := testBuild("a")
	preparedAt := time.Now().UTC().Add(-2 * time.Minute)
	receipt, receiptPath, detailsPath := writeValidPackagedEvidence(t, root, build, preparedAt.Add(time.Minute))
	var details PackagedBlackboxDetails
	detailsRaw, err := os.ReadFile(detailsPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := decodeStrict(detailsRaw, &details); err != nil {
		t.Fatal(err)
	}
	details.Scenarios[0].Details = json.RawMessage(`{"verified":true}`)
	detailsRaw = marshalJSON(t, details)
	if err := os.WriteFile(detailsPath, detailsRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(detailsRaw)
	receipt.DetailsSHA256 = hex.EncodeToString(digest[:])
	for index := range receipt.SubjectHashes {
		if receipt.SubjectHashes[index].Name == "packaged-blackbox-details" {
			receipt.SubjectHashes[index].SHA256 = receipt.DetailsSHA256
		}
	}
	writeJSONReplace(t, receiptPath, receipt)
	ledger, err := PrepareLedger(build, preparedAt)
	if err != nil {
		t.Fatal(err)
	}
	ledgerPath := filepath.Join(root, "ledger-r1.json")
	writeJSON(t, ledgerPath, ledger)
	if _, err := AttachEvidence(ledgerPath, receiptPath, filepath.Join(root, "ledger-r2.json"), build, time.Now().UTC()); err == nil {
		t.Fatal("generic packaged scenario details were attached as passing evidence")
	}
}

func validPackagedBlackboxScenarios(t *testing.T) []PackagedBlackboxScenario {
	t.Helper()
	encode := func(value any) json.RawMessage {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	return []PackagedBlackboxScenario{
		{
			ID: "forced_termination_recovery", Status: "passed", Details: encode(map[string]any{
				"actual_executable_forcibly_terminated": true, "fixture_process_exit_code": 93,
				"wal_bytes_before_packaged_recovery": int64(4096), "wal_bytes_after_idempotence_launch": int64(4096),
				"wal_checkpoint_executor": "release_harness_after_packaged_process_exit",
				"wal_checkpoint_busy":     0, "wal_checkpoint_log_frames": 4, "wal_checkpointed_frames": 4,
				"wal_bytes_after_truncate_checkpoint": int64(0), "database_integrity": "ok",
				"read_only_run_status": "interrupted", "side_effect_run_status": "uncertain",
				"external_thread_turn_identity_preserved": true, "duplicate_stage_attempts": 0,
				"duplicate_recovery_events": 0, "incomplete_curation_generation_removed": true,
				"orphaned_and_temporary_cas_removed": true, "reachable_cas_readback_verified": true,
				"second_start_state_unchanged": true, "second_start_crossed_reset_checkpoint": true,
			}),
		},
		{
			ID: "runtime_and_sidecar_tamper", Status: "passed", Details: encode(map[string]any{
				"runtime_actual_executable_exit_code": 1, "runtime_launch_blocked": true,
				"runtime_failure_contains_content_hash_mismatch": true, "sidecar_launch_attempted": false,
				"sidecar_prelaunch_candidate_identity_rejected": true, "source_candidate_unchanged": true,
			}),
		},
		{ID: "candidate_stability", Status: "passed", Details: encode(map[string]any{"candidate_reauthenticated_after_campaign": true})},
		{ID: "isolated_fixture_cleanup", Status: "passed", Details: encode(map[string]any{"temporary_root_removed": true})},
	}
}

func TestPackagedBlackboxRejectsGenericOrIncompleteScenarioProofs(t *testing.T) {
	root := t.TempDir()
	build := testBuild("a")
	_, receiptPath, detailsPath := writeValidPackagedEvidence(t, root, build, time.Now().UTC())
	receiptRaw, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	var receipt EvidenceReceipt
	if err := decodeStrict(receiptRaw, &receipt); err != nil {
		t.Fatal(err)
	}
	detailsRaw, err := os.ReadFile(detailsPath)
	if err != nil {
		t.Fatal(err)
	}
	var details PackagedBlackboxDetails
	if err := decodeStrict(detailsRaw, &details); err != nil {
		t.Fatal(err)
	}
	if err := validatePackagedBlackboxDetails(details, receipt); err != nil {
		t.Fatalf("valid packaged details rejected: %v", err)
	}

	generic := clonePackagedDetails(t, details)
	generic.Scenarios[0].Details = json.RawMessage(`{"verified":true}`)
	if err := validatePackagedBlackboxDetails(generic, receipt); err == nil {
		t.Fatal("generic non-empty scenario JSON was accepted")
	}

	required := map[string][]string{
		"forced_termination_recovery": {
			"actual_executable_forcibly_terminated", "fixture_process_exit_code",
			"wal_bytes_before_packaged_recovery", "wal_bytes_after_idempotence_launch",
			"wal_checkpoint_executor", "wal_checkpoint_busy", "wal_checkpoint_log_frames",
			"wal_checkpointed_frames", "wal_bytes_after_truncate_checkpoint", "database_integrity",
			"read_only_run_status", "side_effect_run_status", "external_thread_turn_identity_preserved",
			"duplicate_stage_attempts", "duplicate_recovery_events", "incomplete_curation_generation_removed",
			"orphaned_and_temporary_cas_removed", "reachable_cas_readback_verified",
			"second_start_state_unchanged", "second_start_crossed_reset_checkpoint",
		},
		"runtime_and_sidecar_tamper": {
			"runtime_actual_executable_exit_code", "runtime_launch_blocked",
			"runtime_failure_contains_content_hash_mismatch", "sidecar_launch_attempted",
			"sidecar_prelaunch_candidate_identity_rejected", "source_candidate_unchanged",
		},
		"candidate_stability":      {"candidate_reauthenticated_after_campaign"},
		"isolated_fixture_cleanup": {"temporary_root_removed"},
	}
	for scenarioID, fields := range required {
		for _, field := range fields {
			t.Run(scenarioID+"/missing_"+field, func(t *testing.T) {
				mutated := clonePackagedDetails(t, details)
				mutatePackagedScenario(t, &mutated, scenarioID, func(body map[string]any) { delete(body, field) })
				if err := validatePackagedBlackboxDetails(mutated, receipt); err == nil {
					t.Fatalf("missing required field %q was accepted", field)
				}
			})
		}
	}
	semanticCases := []struct {
		name, scenario, field string
		value                 any
	}{
		{"wrong fixture exit", "forced_termination_recovery", "fixture_process_exit_code", 0},
		{"duplicate stage", "forced_termination_recovery", "duplicate_stage_attempts", 1},
		{"duplicate recovery", "forced_termination_recovery", "duplicate_recovery_events", 1},
		{"wrong read status", "forced_termination_recovery", "read_only_run_status", "uncertain"},
		{"wrong side-effect status", "forced_termination_recovery", "side_effect_run_status", "interrupted"},
		{"incomplete checkpoint", "forced_termination_recovery", "wal_checkpointed_frames", 3},
		{"runtime launched", "runtime_and_sidecar_tamper", "runtime_launch_blocked", false},
		{"sidecar launched", "runtime_and_sidecar_tamper", "sidecar_launch_attempted", true},
		{"candidate not reauthenticated", "candidate_stability", "candidate_reauthenticated_after_campaign", false},
		{"temporary root retained", "isolated_fixture_cleanup", "temporary_root_removed", false},
	}
	for _, testCase := range semanticCases {
		t.Run(testCase.name, func(t *testing.T) {
			mutated := clonePackagedDetails(t, details)
			mutatePackagedScenario(t, &mutated, testCase.scenario, func(body map[string]any) { body[testCase.field] = testCase.value })
			if err := validatePackagedBlackboxDetails(mutated, receipt); err == nil {
				t.Fatalf("invalid %s=%v was accepted", testCase.field, testCase.value)
			}
		})
	}
}

func TestPackagedBlackboxRejectsNonDistinctTamperSubjects(t *testing.T) {
	root := t.TempDir()
	build := testBuild("a")
	_, receiptPath, detailsPath := writeValidPackagedEvidence(t, root, build, time.Now().UTC())
	var receipt EvidenceReceipt
	receiptRaw, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := decodeStrict(receiptRaw, &receipt); err != nil {
		t.Fatal(err)
	}
	var details PackagedBlackboxDetails
	detailsRaw, err := os.ReadFile(detailsPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := decodeStrict(detailsRaw, &details); err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]string{
		{"tamper_runtime_original_sha256", "tamper_runtime_mutated_sha256"},
		{"tamper_sidecar_original_sha256", "tamper_sidecar_mutated_sha256"},
	} {
		t.Run(strings.TrimPrefix(pair[0], "tamper_"), func(t *testing.T) {
			mutated := receipt
			mutated.SubjectHashes = append([]SubjectHash(nil), receipt.SubjectHashes...)
			original := ""
			for _, subject := range mutated.SubjectHashes {
				if subject.Name == pair[0] {
					original = subject.SHA256
				}
			}
			for index := range mutated.SubjectHashes {
				if mutated.SubjectHashes[index].Name == pair[1] {
					mutated.SubjectHashes[index].SHA256 = original
				}
			}
			if err := validatePackagedBlackboxDetails(details, mutated); err == nil {
				t.Fatal("identical original/mutated hashes were accepted")
			}
		})
	}
}

func clonePackagedDetails(t *testing.T, source PackagedBlackboxDetails) PackagedBlackboxDetails {
	t.Helper()
	raw, err := json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	var cloned PackagedBlackboxDetails
	if err := decodeStrict(raw, &cloned); err != nil {
		t.Fatal(err)
	}
	return cloned
}

func mutatePackagedScenario(t *testing.T, details *PackagedBlackboxDetails, scenarioID string, mutate func(map[string]any)) {
	t.Helper()
	for index := range details.Scenarios {
		if details.Scenarios[index].ID != scenarioID {
			continue
		}
		var body map[string]any
		if err := json.Unmarshal(details.Scenarios[index].Details, &body); err != nil {
			t.Fatal(err)
		}
		mutate(body)
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		details.Scenarios[index].Details = raw
		return
	}
	t.Fatalf("scenario %q was not found", scenarioID)
}
