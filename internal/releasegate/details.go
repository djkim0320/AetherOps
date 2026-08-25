package releasegate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"github.com/djkim0320/AetherOps/internal/gate0evidence"
)

const (
	localReleaseDetailsSchemaV2 = "aetherops_local_release_evidence_details_v2"
	liveEvaluationSchemaV3      = "aetherops_release_evaluation_v3"
	localEnvironmentDomain      = "aetherops-local-release-environment-v1\x00"
)

type localEnvironmentDetails struct {
	OS                  string `json:"os"`
	Architecture        string `json:"architecture"`
	GoVersion           string `json:"go_version"`
	LogicalProcessors   int    `json:"logical_processors"`
	ProcessorIdentifier string `json:"processor_identifier,omitempty"`
	WindowsVersion      string `json:"windows_version"`
}

type localStreamObservation struct {
	Bytes         int64  `json:"bytes"`
	CapturedBytes int    `json:"captured_bytes"`
	SHA256        string `json:"sha256"`
	Truncated     bool   `json:"truncated"`
	Text          string `json:"text"`
}

type localEnvironmentVariable struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type localCommandObservation struct {
	ID          string                     `json:"id"`
	Executable  string                     `json:"executable"`
	Arguments   []string                   `json:"arguments"`
	Environment []localEnvironmentVariable `json:"environment,omitempty"`
	WorkingDir  string                     `json:"working_directory"`
	Timeout     string                     `json:"timeout"`
	StartedAt   time.Time                  `json:"started_at"`
	FinishedAt  time.Time                  `json:"finished_at"`
	ExitCode    int                        `json:"exit_code"`
	StartError  string                     `json:"start_error,omitempty"`
	Stdout      localStreamObservation     `json:"stdout"`
	Stderr      localStreamObservation     `json:"stderr"`
}

type localValidation struct {
	ID      string `json:"id"`
	Passed  bool   `json:"passed"`
	Failure string `json:"failure,omitempty"`
}

type localReleaseDetails struct {
	Schema                string                        `json:"schema"`
	GateID                string                        `json:"gate_id"`
	ReleaseCandidateID    string                        `json:"release_candidate_id"`
	LedgerSHA256          string                        `json:"ledger_sha256"`
	LedgerPreparedAt      time.Time                     `json:"ledger_prepared_at"`
	ObservationStartedAt  time.Time                     `json:"observation_started_at"`
	ObservationFinishedAt time.Time                     `json:"observation_finished_at"`
	CandidateBefore       buildinfo.ProductBuildBinding `json:"candidate_before"`
	CandidateAfter        buildinfo.ProductBuildBinding `json:"candidate_after"`
	SourceTreeSHA256      string                        `json:"source_tree_sha256,omitempty"`
	SourceFileCount       int                           `json:"source_file_count,omitempty"`
	Environment           localEnvironmentDetails       `json:"environment"`
	Commands              []localCommandObservation     `json:"commands"`
	Validations           []localValidation             `json:"validations"`
	GateArtifact          json.RawMessage               `json:"gate_artifact,omitempty"`
	GateArtifactSHA256    string                        `json:"gate_artifact_sha256,omitempty"`
	ReleaseEligibleRunner bool                          `json:"release_eligible_runner"`
	EvidenceScope         []string                      `json:"evidence_scope"`
	ExcludedReleaseClaims []string                      `json:"excluded_release_claims"`
}

type liveReviewScores struct {
	TaskFulfillment           int `json:"task_fulfillment"`
	ClaimSupport              int `json:"claim_support"`
	SourceQuality             int `json:"source_quality"`
	Completeness              int `json:"completeness"`
	ReasoningAndUncertainty   int `json:"reasoning_and_uncertainty"`
	ClarityAndReproducibility int `json:"clarity_and_reproducibility"`
}

func (scores liveReviewScores) values() []int {
	return []int{
		scores.TaskFulfillment, scores.ClaimSupport, scores.SourceQuality,
		scores.Completeness, scores.ReasoningAndUncertainty, scores.ClarityAndReproducibility,
	}
}

type liveEvaluationCaseResult struct {
	CaseID                            string           `json:"case_id"`
	RunID                             string           `json:"run_id"`
	Status                            string           `json:"status"`
	ResearchProfileVersion            string           `json:"research_profile_version"`
	RetrievalProfile                  string           `json:"retrieval_profile"`
	KnowledgeGenerationID             string           `json:"knowledge_generation_id"`
	MaterializedGenerationID          string           `json:"materialized_generation_id,omitempty"`
	ReportSHA256                      string           `json:"report_sha256,omitempty"`
	ReviewSHA256                      string           `json:"review_sha256,omitempty"`
	CitationIntegrityPercent          int              `json:"citation_integrity_percent"`
	KnowledgeEvidenceIntegrityPercent int              `json:"knowledge_evidence_integrity_percent"`
	UnsupportedAssertions             int              `json:"unsupported_assertions"`
	CriticalErrorCount                int              `json:"critical_error_count"`
	Scores                            liveReviewScores `json:"scores"`
	AverageScore                      float64          `json:"average_score"`
	Passed                            bool             `json:"passed"`
	Failure                           string           `json:"failure,omitempty"`
}

type liveEvaluationDetails struct {
	Schema                  string                        `json:"schema"`
	ExecutionSource         string                        `json:"execution_source,omitempty"`
	EvalRunSetID            string                        `json:"eval_run_set_id,omitempty"`
	RunnerReceiptSHA256     string                        `json:"runner_receipt_sha256,omitempty"`
	DatasetName             string                        `json:"dataset_name"`
	DatasetSHA256           string                        `json:"dataset_sha256"`
	ExecutionManifestSHA256 string                        `json:"execution_manifest_sha256,omitempty"`
	ProductBuild            buildinfo.ProductBuildBinding `json:"product_build"`
	RequiredCases           int                           `json:"required_cases"`
	RequiredPasses          int                           `json:"required_passes"`
	ObservedPasses          int                           `json:"observed_passes"`
	Passed                  bool                          `json:"passed"`
	VerifiedAt              time.Time                     `json:"verified_at"`
	Results                 []liveEvaluationCaseResult    `json:"results"`
}

func validateLocalReleaseDetails(raw []byte, receipt EvidenceReceipt) error {
	var details localReleaseDetails
	if err := decodeStrict(raw, &details); err != nil {
		return fmt.Errorf("decode local release details: %w", err)
	}
	if details.Schema != localReleaseDetailsSchemaV2 || details.GateID != receipt.GateID ||
		details.ReleaseCandidateID != receipt.ReleaseCandidateID ||
		details.CandidateBefore != receipt.ProductBuild || details.CandidateAfter != receipt.ProductBuild ||
		!details.ReleaseEligibleRunner {
		return errors.New("local release details identity, candidate, or actual-runner contract is invalid")
	}
	if !validDigest(details.LedgerSHA256) || details.LedgerPreparedAt.IsZero() ||
		details.ObservationStartedAt.Before(details.LedgerPreparedAt) ||
		details.ObservationFinishedAt.Before(details.ObservationStartedAt) ||
		!details.ObservationFinishedAt.Equal(receipt.ObservedAt) {
		return errors.New("local release details observation window is invalid")
	}
	if details.Environment.OS != "windows-11" || details.Environment.Architecture != "amd64" ||
		strings.TrimSpace(details.Environment.GoVersion) == "" || details.Environment.LogicalProcessors < 1 ||
		!windows11Version(details.Environment.WindowsVersion) ||
		receipt.Environment.Class != string(EvidenceLocalIntegration) || receipt.Environment.OS != "windows-11" ||
		receipt.Environment.Architecture != "amd64" ||
		receipt.Environment.IdentitySHA256 != localEnvironmentIdentity(details.Environment) {
		return errors.New("local release details do not bind a complete Windows 11 x64 environment")
	}
	if !sameStringSet(details.EvidenceScope, []string{
		receipt.GateID, "local_integration", "exact_candidate_binding", "actual_command_exit_and_output",
	}) || !sameStringSet(details.ExcludedReleaseClaims, []string{
		"overall_release_success", "live_service", "live_quality_12", "clean_vm", "production_update_feed", "incompatible_hardware",
	}) {
		return errors.New("local release details evidence scope is incomplete or overclaims external gates")
	}
	subjects, err := receiptSubjectMap(receipt)
	if err != nil {
		return err
	}
	if subjects["prepared-ledger"] != details.LedgerSHA256 || subjects["local-gate-details"] != receipt.DetailsSHA256 {
		return errors.New("local release details are not bound to their prepared ledger and details file")
	}
	usesSourceTree := localGateUsesSourceTree(receipt.GateID)
	if usesSourceTree {
		if !validDigest(details.SourceTreeSHA256) || details.SourceFileCount < 1 ||
			subjects["source-tree"] != details.SourceTreeSHA256 {
			return errors.New("local release details do not bind a non-empty sealed source tree")
		}
	} else if details.SourceTreeSHA256 != "" || details.SourceFileCount != 0 || subjects["source-tree"] != "" {
		return errors.New("local release details unexpectedly bind a source tree")
	}
	expectedCommands, expectedValidations, ok := expectedLocalDetailsContract(receipt.GateID)
	if !ok || len(details.Commands) != len(expectedCommands) {
		return errors.New("local release details command set is invalid")
	}
	if err := validateFixedLocalCommandPlan(details); err != nil {
		return err
	}
	commands := make(map[string]localCommandObservation, len(details.Commands))
	for _, command := range details.Commands {
		if _, duplicate := commands[command.ID]; duplicate {
			return fmt.Errorf("local release command %q is duplicated", command.ID)
		}
		if _, expected := expectedCommands[command.ID]; !expected {
			return fmt.Errorf("local release command %q is not in the fixed gate plan", command.ID)
		}
		if !filepath.IsAbs(command.Executable) || !filepath.IsAbs(command.WorkingDir) ||
			command.StartError != "" || command.ExitCode != 0 || command.StartedAt.Before(details.ObservationStartedAt) ||
			command.FinishedAt.Before(command.StartedAt) || command.FinishedAt.After(details.ObservationFinishedAt) {
			return fmt.Errorf("local release command %q has invalid identity, result, or time bounds", command.ID)
		}
		if duration, parseErr := time.ParseDuration(command.Timeout); parseErr != nil || duration <= 0 {
			return fmt.Errorf("local release command %q has an invalid timeout", command.ID)
		}
		if err := validateLocalStream(command.Stdout, subjects["command_"+command.ID+"_stdout"]); err != nil {
			return fmt.Errorf("local release command %q stdout: %w", command.ID, err)
		}
		if err := validateLocalStream(command.Stderr, subjects["command_"+command.ID+"_stderr"]); err != nil {
			return fmt.Errorf("local release command %q stderr: %w", command.ID, err)
		}
		commands[command.ID] = command
	}
	if len(details.Validations) != len(expectedValidations) {
		return errors.New("local release details validation set is incomplete")
	}
	seenValidations := make(map[string]struct{}, len(details.Validations))
	for _, validation := range details.Validations {
		if _, expected := expectedValidations[validation.ID]; !expected || !validation.Passed || validation.Failure != "" {
			return fmt.Errorf("local release validation %q is unknown or did not pass", validation.ID)
		}
		if _, duplicate := seenValidations[validation.ID]; duplicate {
			return fmt.Errorf("local release validation %q is duplicated", validation.ID)
		}
		seenValidations[validation.ID] = struct{}{}
	}
	return validateLocalGateArtifact(details, commands, subjects)
}

func expectedLocalDetailsContract(gateID string) (map[string]struct{}, map[string]struct{}, bool) {
	commandIDs := []string{}
	validationIDs := []string{"command_observation_window", "actual_command_runner", "candidate_reauthenticated", "ledger_observation_window", "fixed_command_inputs_reauthenticated"}
	switch gateID {
	case "local_source_tests":
		commandIDs = []string{"go_version", "node_version", "npm_version", "local_source_tests"}
		validationIDs = append(validationIDs, "source_tree_reauthenticated", "fixed_go_1_26_5_windows_amd64", "fixed_node_24_19_0", "fixed_npm_11_17_0", "full_source_suite")
	case "gate0_windows_host":
		commandIDs = []string{"packaged_gate0"}
		validationIDs = append(validationIDs, "actual_packaged_windows_gate0", "isolated_temporary_root_removed")
	case "rag_50000":
		commandIDs = []string{"go_version", "rag_50000"}
		validationIDs = append(validationIDs, "source_tree_reauthenticated", "fixed_go_1_26_5_windows_amd64", "rag_50000_test_executed_not_skipped", "rag_50000_artifact", "isolated_temporary_root_removed")
	case "scheduler_recovery":
		commandIDs = []string{"go_version", "scheduler_contracts", "scheduler_forced_exit"}
		validationIDs = append(validationIDs, "source_tree_reauthenticated", "fixed_go_1_26_5_windows_amd64", "scheduler_dst_approval_restart_contracts", "scheduler_forced_exit_separate_process")
	default:
		return nil, nil, false
	}
	commands := make(map[string]struct{}, len(commandIDs))
	validations := make(map[string]struct{}, len(validationIDs)+len(commandIDs))
	for _, id := range commandIDs {
		commands[id] = struct{}{}
		validations["command_"+id+"_exit_zero"] = struct{}{}
	}
	for _, id := range validationIDs {
		validations[id] = struct{}{}
	}
	return commands, validations, true
}

type fixedLocalCommand struct {
	ID          string
	Executable  string
	Arguments   []string
	Environment []localEnvironmentVariable
	Timeout     string
}

var schedulerReleaseContractTests = []string{
	"TestScheduleParsing",
	"TestCoalesceMissed",
	"TestCronSkipsNonexistentDSTWallClock",
	"TestCronEnumeratesBothAutumnDSTWallClockOccurrences",
	"TestServiceCoalescesDowntimeAndDoesNotDuplicate",
	"TestServiceLongDowntimeCatchUpAdvancesInBoundedRestartSafePages",
	"TestServiceBlocksScheduleWhenMainThreadIsLost",
	"TestServiceAutumnDSTOccurrencesAreDistinctAndRestartSafe",
	"TestServiceCoalescesRepeatedAutumnDSTWallClockAfterDowntime",
	"TestServiceRestartAfterClaimAdvancesWithoutDuplicate",
	"TestServiceLeavesWaitingApprovalRunAndQueuesNextOccurrenceOnce",
	"TestServiceRestartExpiresWaitingApprovalAndQueuesNextOccurrenceOnce",
	"TestServiceBlocksScheduledRunWhileKnowledgeGraphIsStale",
}

func localGateUsesSourceTree(gateID string) bool {
	return gateID == "local_source_tests" || gateID == "rag_50000" || gateID == "scheduler_recovery"
}

func validateFixedLocalCommandPlan(details localReleaseDetails) error {
	if len(details.Commands) == 0 {
		return errors.New("local release command plan is empty")
	}
	sourceRoot := filepath.Clean(details.Commands[0].WorkingDir)
	if !filepath.IsAbs(sourceRoot) {
		return errors.New("local release command source root is not absolute")
	}
	for _, command := range details.Commands {
		if !strings.EqualFold(filepath.Clean(command.WorkingDir), sourceRoot) {
			return errors.New("local release commands do not share one fixed source root")
		}
	}

	goExecutable := filepath.Join(sourceRoot, ".tools", "go1.26.5", "bin", "go.exe")
	nodeRoot := filepath.Join(sourceRoot, ".runtime", "versions", "node", "24.19.0")
	nodeExecutable := filepath.Join(nodeRoot, "node.exe")
	npmCLI := filepath.Join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js")
	var expected []fixedLocalCommand
	switch details.GateID {
	case "local_source_tests":
		powerShell := details.Commands[3].Executable
		if !isWindowsPowerShellExecutable(powerShell) {
			return errors.New("local source test command does not use Windows PowerShell")
		}
		expected = []fixedLocalCommand{
			{ID: "go_version", Executable: goExecutable, Arguments: []string{"version"}, Timeout: "30s"},
			{ID: "node_version", Executable: nodeExecutable, Arguments: []string{"--version"}, Timeout: "30s"},
			{ID: "npm_version", Executable: nodeExecutable, Arguments: []string{npmCLI, "--version"}, Timeout: "30s"},
			{
				ID: "local_source_tests", Executable: powerShell,
				Arguments:   []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", filepath.Join(sourceRoot, "tools", "dev.ps1"), "test"},
				Environment: []localEnvironmentVariable{{Name: "PATH_PREPEND", Value: nodeRoot}}, Timeout: "30m0s",
			},
		}
	case "gate0_windows_host":
		command := details.Commands[0]
		if !strings.EqualFold(filepath.Base(command.Executable), "aetherops.exe") {
			return errors.New("Gate 0 command does not execute aetherops.exe")
		}
		if len(command.Environment) != 0 || len(command.Arguments) != 3 || command.Arguments[0] != "gate0" ||
			command.Arguments[1] != "--data-root" || !validLocalTemporaryRoot(command.Arguments[2]) {
			return errors.New("Gate 0 command does not use the fixed explicit isolated data root")
		}
		expected = []fixedLocalCommand{{
			ID: "packaged_gate0", Executable: command.Executable, Arguments: command.Arguments,
			Timeout: "2m0s",
		}}
	case "rag_50000":
		if len(details.Commands[1].Environment) != 2 ||
			details.Commands[1].Environment[0] != (localEnvironmentVariable{Name: "AETHEROPS_RUN_50K_RETRIEVAL_GATE", Value: "1"}) ||
			details.Commands[1].Environment[1].Name != "AETHEROPS_RETRIEVAL_RECEIPT" ||
			!validLocalGateArtifactPath(details.Commands[1].Environment[1].Value, "hybrid-graph-v1-50k-performance-v1.json") {
			return errors.New("50k retrieval command does not use the fixed isolated artifact environment")
		}
		expected = []fixedLocalCommand{
			{ID: "go_version", Executable: goExecutable, Arguments: []string{"version"}, Timeout: "30s"},
			{
				ID: "rag_50000", Executable: goExecutable,
				Arguments:   []string{"test", "./internal/store", "-run", "^TestHybridGraphV1FiftyThousandChunkReleaseGate$", "-count=1", "-v", "-timeout=20m"},
				Environment: details.Commands[1].Environment, Timeout: "25m0s",
			},
		}
	case "scheduler_recovery":
		contractPattern := "^(" + strings.Join(schedulerReleaseContractTests, "|") + ")$"
		expected = []fixedLocalCommand{
			{ID: "go_version", Executable: goExecutable, Arguments: []string{"version"}, Timeout: "30s"},
			{ID: "scheduler_contracts", Executable: goExecutable, Arguments: []string{"test", "./internal/schedule", "-run", contractPattern, "-count=1", "-v", "-timeout=5m"}, Timeout: "6m0s"},
			{ID: "scheduler_forced_exit", Executable: goExecutable, Arguments: []string{"test", "./internal/schedule", "-run", "^TestServiceForcedTerminationBoundariesNeverDuplicateOccurrence$", "-count=1", "-v", "-timeout=5m"}, Timeout: "6m0s"},
		}
	default:
		return errors.New("local release gate does not have a fixed command plan")
	}
	if len(details.Commands) != len(expected) {
		return errors.New("local release command count differs from the fixed plan")
	}
	for index, want := range expected {
		got := details.Commands[index]
		if got.ID != want.ID || !strings.EqualFold(filepath.Clean(got.Executable), filepath.Clean(want.Executable)) ||
			!reflect.DeepEqual(got.Arguments, want.Arguments) || !reflect.DeepEqual(got.Environment, want.Environment) || got.Timeout != want.Timeout {
			return fmt.Errorf("local release command %q executable, arguments, environment, order, or timeout differs from the fixed plan", got.ID)
		}
	}
	return nil
}

func isWindowsPowerShellExecutable(path string) bool {
	if !filepath.IsAbs(path) || !strings.EqualFold(filepath.Base(path), "powershell.exe") {
		return false
	}
	wantSuffix := filepath.Clean(filepath.Join("System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
	clean := filepath.Clean(path)
	return len(clean) > len(wantSuffix) && strings.EqualFold(clean[len(clean)-len(wantSuffix):], wantSuffix)
}

func validLocalTemporaryRoot(path string) bool {
	if !filepath.IsAbs(path) {
		return false
	}
	return strings.HasPrefix(strings.ToLower(filepath.Base(filepath.Clean(path))), strings.ToLower("AetherOps-Local-Release-Evidence-"))
}

func validLocalGateArtifactPath(path, name string) bool {
	return filepath.IsAbs(path) && strings.EqualFold(filepath.Base(filepath.Clean(path)), name) && validLocalTemporaryRoot(filepath.Dir(filepath.Clean(path)))
}

func validateLocalStream(stream localStreamObservation, subject string) error {
	if stream.Bytes < 0 || stream.CapturedBytes < 0 || int64(stream.CapturedBytes) > stream.Bytes ||
		stream.CapturedBytes != len([]byte(stream.Text)) || !validDigest(stream.SHA256) || stream.SHA256 != subject {
		return errors.New("stream byte counts or SHA-256 binding are invalid")
	}
	if stream.Truncated != (int64(stream.CapturedBytes) < stream.Bytes) {
		return errors.New("stream truncation flag does not match byte counts")
	}
	if !stream.Truncated {
		digest := sha256.Sum256([]byte(stream.Text))
		if hex.EncodeToString(digest[:]) != stream.SHA256 {
			return errors.New("complete stream text does not match its SHA-256")
		}
	}
	return nil
}

func validateLocalGateArtifact(details localReleaseDetails, commands map[string]localCommandObservation, subjects map[string]string) error {
	requiresArtifact := details.GateID == "gate0_windows_host" || details.GateID == "rag_50000"
	if !requiresArtifact {
		if len(details.GateArtifact) != 0 || details.GateArtifactSHA256 != "" {
			return errors.New("local gate unexpectedly contains a gate artifact")
		}
		if _, exists := subjects["gate_artifact"]; exists {
			return errors.New("local gate unexpectedly declares a gate artifact subject")
		}
		return nil
	}
	if len(details.GateArtifact) == 0 || !validDigest(details.GateArtifactSHA256) || subjects["gate_artifact"] != details.GateArtifactSHA256 {
		return errors.New("local gate artifact is absent or not bound to its subject hash")
	}
	if details.GateID == "gate0_windows_host" {
		stdout := strings.TrimSpace(commands["packaged_gate0"].Stdout.Text)
		digest := sha256.Sum256([]byte(stdout))
		if hex.EncodeToString(digest[:]) != details.GateArtifactSHA256 {
			return errors.New("Gate 0 artifact does not match the packaged command output")
		}
		var commandValue, artifactValue any
		if json.Unmarshal([]byte(stdout), &commandValue) != nil || json.Unmarshal(details.GateArtifact, &artifactValue) != nil ||
			!reflect.DeepEqual(commandValue, artifactValue) {
			return errors.New("Gate 0 artifact differs from the packaged command JSON")
		}
		return gate0evidence.Validate(details.GateArtifact, details.ObservationStartedAt, details.ObservationFinishedAt)
	}
	return validateRAGArtifactDetails(details.GateArtifact, details.LedgerPreparedAt)
}

func validateRAGArtifactDetails(raw []byte, preparedAt time.Time) error {
	return validateRAG50KArtifact(raw, preparedAt)
}

func localEnvironmentIdentity(environment localEnvironmentDetails) string {
	canonical, _ := json.Marshal(environment)
	digest := sha256.New()
	_, _ = digest.Write([]byte(localEnvironmentDomain))
	_, _ = digest.Write(canonical)
	return hex.EncodeToString(digest.Sum(nil))
}

func validateLiveEvaluationDetails(raw []byte, receipt EvidenceReceipt) error {
	var details liveEvaluationDetails
	if err := decodeStrict(raw, &details); err != nil {
		return fmt.Errorf("decode live evaluation details: %w", err)
	}
	if details.Schema != liveEvaluationSchemaV3 || details.ExecutionSource != "release_eval_runner" ||
		strings.TrimSpace(details.EvalRunSetID) == "" || strings.TrimSpace(details.DatasetName) == "" ||
		!validDigest(details.DatasetSHA256) || !validDigest(details.RunnerReceiptSHA256) ||
		details.ExecutionManifestSHA256 != "" || details.ProductBuild != receipt.ProductBuild ||
		details.RequiredCases != 12 || details.RequiredPasses != 12 || details.ObservedPasses != 12 ||
		!details.Passed || len(details.Results) != 12 || details.VerifiedAt.IsZero() || !details.VerifiedAt.Equal(receipt.ObservedAt) {
		return errors.New("live evaluation details do not represent one passed runner-bound 12-of-12 verification")
	}
	if receipt.Environment.Class != string(EvidenceLiveEvaluation) || receipt.Environment.OS != "windows" ||
		receipt.Environment.Architecture != "amd64" {
		return errors.New("live evaluation receipt does not identify the required Windows x64 product host")
	}
	subjects, err := receiptSubjectMap(receipt)
	if err != nil {
		return err
	}
	if subjects["evaluation-dataset"] != details.DatasetSHA256 ||
		subjects["release-eval-runner-receipt"] != details.RunnerReceiptSHA256 ||
		subjects["release-evaluation-details"] != receipt.DetailsSHA256 {
		return errors.New("live evaluation details are not bound to the dataset and runner receipt subjects")
	}
	caseIDs := make(map[string]struct{}, 12)
	runIDs := make(map[string]struct{}, 12)
	for _, result := range details.Results {
		if strings.TrimSpace(result.CaseID) == "" || strings.TrimSpace(result.RunID) == "" || result.Status != "succeeded" ||
			result.ResearchProfileVersion != "research_v2" || result.RetrievalProfile != "hybrid_graph_v1" ||
			strings.TrimSpace(result.KnowledgeGenerationID) == "" || strings.TrimSpace(result.MaterializedGenerationID) == "" ||
			!validDigest(result.ReportSHA256) || !validDigest(result.ReviewSHA256) ||
			result.CitationIntegrityPercent != 100 || result.KnowledgeEvidenceIntegrityPercent != 100 ||
			result.UnsupportedAssertions != 0 || result.CriticalErrorCount != 0 || !result.Passed || result.Failure != "" {
			return fmt.Errorf("live evaluation case %q does not satisfy the immutable research and integrity contract", result.CaseID)
		}
		if _, duplicate := caseIDs[result.CaseID]; duplicate {
			return fmt.Errorf("live evaluation case %q is duplicated", result.CaseID)
		}
		if _, duplicate := runIDs[result.RunID]; duplicate {
			return fmt.Errorf("live evaluation run %q is reused", result.RunID)
		}
		caseIDs[result.CaseID] = struct{}{}
		runIDs[result.RunID] = struct{}{}
		total := 0
		for _, score := range result.Scores.values() {
			if score < 3 || score > 5 {
				return fmt.Errorf("live evaluation case %q has an out-of-policy review axis", result.CaseID)
			}
			total += score
		}
		expectedAverage := math.Round(float64(total)/6*1000) / 1000
		if expectedAverage < 4 || math.Abs(result.AverageScore-expectedAverage) > 0.0001 {
			return fmt.Errorf("live evaluation case %q has an invalid average score", result.CaseID)
		}
	}
	return nil
}

func receiptSubjectMap(receipt EvidenceReceipt) (map[string]string, error) {
	result := make(map[string]string, len(receipt.SubjectHashes))
	for _, subject := range receipt.SubjectHashes {
		if _, duplicate := result[subject.Name]; duplicate {
			return nil, fmt.Errorf("release evidence subject %q is duplicated", subject.Name)
		}
		result[subject.Name] = subject.SHA256
	}
	return result, nil
}
