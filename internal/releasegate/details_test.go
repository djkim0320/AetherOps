package releasegate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTypedDetailsRejectArbitraryNonEmptyJSON(t *testing.T) {
	for _, gateID := range []string{"local_source_tests", "live_quality_12"} {
		t.Run(gateID, func(t *testing.T) {
			root := t.TempDir()
			raw := []byte("{\"fabricated\":true}\n")
			digest := sha256.Sum256(raw)
			detailsSHA := hex.EncodeToString(digest[:])
			detailsName := gateID + ".details.json"
			if err := os.WriteFile(filepath.Join(root, detailsName), raw, 0o600); err != nil {
				t.Fatal(err)
			}
			receipt := typedTestReceipt(t, gateID, time.Now().UTC(), detailsName, detailsSHA)
			if err := receipt.Validate(); err != nil {
				t.Fatalf("test receipt must satisfy the outer contract: %v", err)
			}
			if err := verifyEvidenceDetails(filepath.Join(root, gateID+".receipt.json"), receipt); err == nil {
				t.Fatal("arbitrary non-empty JSON was accepted as typed release evidence")
			}
		})
	}
}

func TestLocalDetailsRequireActualRunnerCandidateAndEveryValidation(t *testing.T) {
	details, receipt := validLocalSchedulerDetails(t)
	raw := mustJSON(t, details)
	if err := validateLocalReleaseDetails(raw, receipt); err != nil {
		t.Fatalf("valid local details were rejected: %v", err)
	}

	details.ReleaseEligibleRunner = false
	if err := validateLocalReleaseDetails(mustJSON(t, details), receipt); err == nil {
		t.Fatal("diagnostic-only runner was accepted")
	}
	details.ReleaseEligibleRunner = true
	details.CandidateAfter.ExecutableSHA256 = strings.Repeat("f", 64)
	if err := validateLocalReleaseDetails(mustJSON(t, details), receipt); err == nil {
		t.Fatal("changed candidate was accepted")
	}
	details.CandidateAfter = details.CandidateBefore
	details.Validations[0].Passed = false
	details.Validations[0].Failure = "fabricated failure"
	if err := validateLocalReleaseDetails(mustJSON(t, details), receipt); err == nil {
		t.Fatal("failed local validation was accepted")
	}
}

func TestLocalDetailsRejectCommandAndSourceTreePlanMutation(t *testing.T) {
	base, receipt := validLocalSchedulerDetails(t)
	tests := []struct {
		name   string
		mutate func(*localReleaseDetails)
	}{
		{"retired_schema", func(value *localReleaseDetails) {
			value.Schema = "aetherops_local_release_evidence_details_v1"
		}},
		{"executable", func(value *localReleaseDetails) {
			value.Commands[0].Executable = filepath.Join(value.Commands[0].WorkingDir, "go.exe")
		}},
		{"arguments", func(value *localReleaseDetails) { value.Commands[1].Arguments[0] = "env" }},
		{"environment", func(value *localReleaseDetails) {
			value.Commands[1].Environment = []localEnvironmentVariable{{Name: "AETHEROPS_TEST", Value: "1"}}
		}},
		{"working_directory", func(value *localReleaseDetails) {
			value.Commands[2].WorkingDir = filepath.Join(value.Commands[2].WorkingDir, "other")
		}},
		{"timeout", func(value *localReleaseDetails) { value.Commands[2].Timeout = "7m0s" }},
		{"command_order", func(value *localReleaseDetails) {
			value.Commands[0], value.Commands[1] = value.Commands[1], value.Commands[0]
		}},
		{"source_digest", func(value *localReleaseDetails) { value.SourceTreeSHA256 = strings.Repeat("8", 64) }},
		{"source_file_count", func(value *localReleaseDetails) { value.SourceFileCount = 0 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var mutated localReleaseDetails
			if err := json.Unmarshal(mustJSON(t, base), &mutated); err != nil {
				t.Fatal(err)
			}
			test.mutate(&mutated)
			if err := validateLocalReleaseDetails(mustJSON(t, mutated), receipt); err == nil {
				t.Fatalf("mutated local release evidence was accepted: %s", test.name)
			}
		})
	}
}

func TestLiveDetailsRequireRunnerTwelveOfTwelveAndRunnerHashBinding(t *testing.T) {
	details, receipt := validLiveEvaluationDetails(t)
	if err := validateLiveEvaluationDetails(mustJSON(t, details), receipt); err != nil {
		t.Fatalf("valid live evaluation details were rejected: %v", err)
	}

	details.ExecutionSource = "manual"
	if err := validateLiveEvaluationDetails(mustJSON(t, details), receipt); err == nil {
		t.Fatal("manual evaluation source was accepted")
	}
	details.ExecutionSource = "release_eval_runner"
	details.ObservedPasses = 11
	if err := validateLiveEvaluationDetails(mustJSON(t, details), receipt); err == nil {
		t.Fatal("11-of-12 live evaluation was accepted")
	}
	details.ObservedPasses = 12
	details.RunnerReceiptSHA256 = strings.Repeat("9", 64)
	if err := validateLiveEvaluationDetails(mustJSON(t, details), receipt); err == nil {
		t.Fatal("runner receipt hash mismatch was accepted")
	}
}

func validLocalSchedulerDetails(t *testing.T) (localReleaseDetails, EvidenceReceipt) {
	t.Helper()
	build := testBuild("a")
	candidateID, err := CandidateID(build)
	if err != nil {
		t.Fatal(err)
	}
	prepared := time.Unix(1_800_000_000, 0).UTC()
	started := prepared.Add(time.Second)
	finished := started.Add(time.Minute)
	emptyDigest := sha256.Sum256(nil)
	emptySHA := hex.EncodeToString(emptyDigest[:])
	sourceRoot := t.TempDir()
	goExecutable := filepath.Join(sourceRoot, ".tools", "go1.26.5", "bin", "go.exe")
	contractPattern := "^(" + strings.Join(schedulerReleaseContractTests, "|") + ")$"
	environment := localEnvironmentDetails{
		OS: "windows-11", Architecture: "amd64", GoVersion: "go1.26.5",
		LogicalProcessors: 8, ProcessorIdentifier: "test-cpu", WindowsVersion: "10.0.26100",
	}
	commandPlan := []fixedLocalCommand{
		{ID: "go_version", Executable: goExecutable, Arguments: []string{"version"}, Timeout: "30s"},
		{ID: "scheduler_contracts", Executable: goExecutable, Arguments: []string{"test", "./internal/schedule", "-run", contractPattern, "-count=1", "-v", "-timeout=5m"}, Timeout: "6m0s"},
		{ID: "scheduler_forced_exit", Executable: goExecutable, Arguments: []string{"test", "./internal/schedule", "-run", "^TestServiceForcedTerminationBoundariesNeverDuplicateOccurrence$", "-count=1", "-v", "-timeout=5m"}, Timeout: "6m0s"},
	}
	commands := make([]localCommandObservation, 0, len(commandPlan))
	for index, specification := range commandPlan {
		commandStarted := started.Add(time.Duration(index) * time.Second)
		commands = append(commands, localCommandObservation{
			ID: specification.ID, Executable: specification.Executable, Arguments: specification.Arguments,
			WorkingDir: sourceRoot, Timeout: specification.Timeout, StartedAt: commandStarted,
			FinishedAt: commandStarted.Add(time.Second), ExitCode: 0,
			Stdout: localStreamObservation{SHA256: emptySHA}, Stderr: localStreamObservation{SHA256: emptySHA},
		})
	}
	_, expectedValidations, _ := expectedLocalDetailsContract("scheduler_recovery")
	validations := make([]localValidation, 0, len(expectedValidations))
	for id := range expectedValidations {
		validations = append(validations, localValidation{ID: id, Passed: true})
	}
	details := localReleaseDetails{
		Schema: localReleaseDetailsSchemaV2, GateID: "scheduler_recovery", ReleaseCandidateID: candidateID,
		LedgerSHA256: strings.Repeat("d", 64), LedgerPreparedAt: prepared,
		ObservationStartedAt: started, ObservationFinishedAt: finished,
		CandidateBefore: build, CandidateAfter: build, SourceTreeSHA256: strings.Repeat("7", 64), SourceFileCount: 42, Environment: environment,
		Commands: commands, Validations: validations, ReleaseEligibleRunner: true,
		EvidenceScope:         []string{"scheduler_recovery", "local_integration", "exact_candidate_binding", "actual_command_exit_and_output"},
		ExcludedReleaseClaims: []string{"overall_release_success", "live_service", "live_quality_12", "clean_vm", "production_update_feed", "incompatible_hardware"},
	}
	receipt := typedTestReceipt(t, "scheduler_recovery", finished, "scheduler.details.json", strings.Repeat("e", 64))
	receipt.Environment.IdentitySHA256 = localEnvironmentIdentity(environment)
	setTestSubject(&receipt, "prepared-ledger", details.LedgerSHA256)
	setTestSubject(&receipt, "local-gate-details", receipt.DetailsSHA256)
	setTestSubject(&receipt, "source-tree", details.SourceTreeSHA256)
	for _, command := range commands {
		setTestSubject(&receipt, "command_"+command.ID+"_stdout", emptySHA)
		setTestSubject(&receipt, "command_"+command.ID+"_stderr", emptySHA)
	}
	return details, receipt
}

func validLiveEvaluationDetails(t *testing.T) (liveEvaluationDetails, EvidenceReceipt) {
	t.Helper()
	build := testBuild("a")
	verified := time.Unix(1_800_000_000, 0).UTC()
	datasetSHA := strings.Repeat("6", 64)
	runnerSHA := strings.Repeat("7", 64)
	details := liveEvaluationDetails{
		Schema: liveEvaluationSchemaV3, ExecutionSource: "release_eval_runner", EvalRunSetID: "evalrs_test",
		RunnerReceiptSHA256: runnerSHA, DatasetName: "release-evaluation-v1", DatasetSHA256: datasetSHA,
		ProductBuild: build, RequiredCases: 12, RequiredPasses: 12, ObservedPasses: 12,
		Passed: true, VerifiedAt: verified, Results: make([]liveEvaluationCaseResult, 0, 12),
	}
	for index := 0; index < 12; index++ {
		details.Results = append(details.Results, liveEvaluationCaseResult{
			CaseID: fmt.Sprintf("case-%02d", index+1), RunID: fmt.Sprintf("run-%02d", index+1), Status: "succeeded",
			ResearchProfileVersion: "research_v2", RetrievalProfile: "hybrid_graph_v1",
			KnowledgeGenerationID: fmt.Sprintf("generation-%02d", index+1), MaterializedGenerationID: fmt.Sprintf("materialized-%02d", index+1),
			ReportSHA256: strings.Repeat("8", 64), ReviewSHA256: strings.Repeat("9", 64),
			CitationIntegrityPercent: 100, KnowledgeEvidenceIntegrityPercent: 100,
			Scores: liveReviewScores{4, 4, 4, 4, 4, 4}, AverageScore: 4, Passed: true,
		})
	}
	receipt := typedTestReceipt(t, "live_quality_12", verified, "live.details.json", strings.Repeat("e", 64))
	receipt.Environment.OS = "windows"
	setTestSubject(&receipt, "evaluation-dataset", datasetSHA)
	setTestSubject(&receipt, "release-eval-runner-receipt", runnerSHA)
	return details, receipt
}

func typedTestReceipt(t *testing.T, gateID string, observedAt time.Time, detailsPath, detailsSHA string) EvidenceReceipt {
	t.Helper()
	build := testBuild("a")
	candidateID, err := CandidateID(build)
	if err != nil {
		t.Fatal(err)
	}
	policy, ok := evidencePolicy(gateID)
	if !ok {
		t.Fatalf("missing evidence policy for %s", gateID)
	}
	requirement, ok := requirementForGate(gateID)
	if !ok {
		t.Fatalf("missing requirement for %s", gateID)
	}
	subjectValues := map[string]string{
		"aetherops.exe": build.ExecutableSHA256, "runtime-manifest.json": build.RuntimeManifestSHA256,
		"knowledge-sidecar-tree": build.KnowledgeSidecarTreeSHA256, policy.DetailsSubject: detailsSHA,
	}
	for _, name := range policy.RequiredSubjects {
		if _, exists := subjectValues[name]; !exists {
			subjectValues[name] = strings.Repeat("d", 64)
		}
	}
	subjects := make([]SubjectHash, 0, len(subjectValues))
	for name, digest := range subjectValues {
		subjects = append(subjects, SubjectHash{Name: name, SHA256: digest})
	}
	return EvidenceReceipt{
		Schema: EvidenceSchemaV1, GateID: gateID, EvidenceKind: requirement.RequiredEvidenceKind,
		ReleaseCandidateID: candidateID, ProductBuild: build,
		Producer:    Producer{Name: policy.ProducerName, Version: policy.ProducerVersion},
		Environment: Environment{Class: string(requirement.RequiredEvidenceKind), OS: "windows-11", Architecture: "amd64", IdentitySHA256: strings.Repeat("f", 64)},
		ObservedAt:  observedAt, Status: "passed", SubjectHashes: subjects,
		DetailsPath: detailsPath, DetailsSHA256: detailsSHA,
	}
}

func setTestSubject(receipt *EvidenceReceipt, name, digest string) {
	for index := range receipt.SubjectHashes {
		if receipt.SubjectHashes[index].Name == name {
			receipt.SubjectHashes[index].SHA256 = digest
			return
		}
	}
	receipt.SubjectHashes = append(receipt.SubjectHashes, SubjectHash{Name: name, SHA256: digest})
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
