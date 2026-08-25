//go:build windows

package localreleaseevidence

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"github.com/djkim0320/AetherOps/internal/gate0evidence"
	"github.com/djkim0320/AetherOps/internal/processutil"
	"github.com/djkim0320/AetherOps/internal/releasegate"
	"golang.org/x/sys/windows"
)

const (
	detailsIdentityDomain    = "aetherops-local-release-environment-v1\x00"
	maximumGateArtifactBytes = 4 << 20
	temporaryCleanupWindow   = 15 * time.Second
)

type commandRunner interface {
	Run(context.Context, string, commandSpec) CommandObservation
	ReleaseEvidenceEligible() bool
}

type realCommandRunner struct{}

// Generate is the only production entrypoint. It always uses the operating
// system command runner; injected runners are confined to same-package tests.
func Generate(ctx context.Context, config Config) (releasegate.EvidenceReceipt, error) {
	return generate(ctx, config, realCommandRunner{}, time.Now)
}

func generate(
	ctx context.Context,
	config Config,
	runner commandRunner,
	clock func() time.Time,
) (releasegate.EvidenceReceipt, error) {
	if ctx == nil {
		return releasegate.EvidenceReceipt{}, errors.New("context is required")
	}
	if runner == nil || clock == nil {
		return releasegate.EvidenceReceipt{}, errors.New("command runner and clock are required")
	}
	gateID := strings.TrimSpace(config.GateID)
	if !isAllowedGate(gateID) {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("gate %q is not a fixed local release gate", gateID)
	}
	sourceRoot, goExecutable, powerShellExecutable, err := validateSourceRoot()
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	ledger, ledgerSHA256, err := releasegate.LoadLedgerChain(strings.TrimSpace(config.LedgerPath))
	if err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("load prepared release ledger: %w", err)
	}
	gateRowEmpty := false
	for _, reference := range ledger.Evidence {
		if reference.GateID == gateID {
			gateRowEmpty = reference.ReceiptPath == "" && reference.ReceiptSHA256 == ""
			break
		}
	}
	if !gateRowEmpty {
		return releasegate.EvidenceReceipt{}, errors.New("prepared release ledger already contains evidence for this gate")
	}
	observationStarted := clock().UTC()
	if observationStarted.Before(ledger.PreparedAt) {
		return releasegate.EvidenceReceipt{}, errors.New("local gate observation cannot start before ledger prepared_at")
	}

	candidateExecutable, runtimeManifest, sidecarEntrypoint, err := absoluteCandidatePaths(config)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	candidateBefore, err := buildinfo.BindProductBuild(candidateExecutable, runtimeManifest, sidecarEntrypoint)
	if err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("bind exact packaged candidate before observation: %w", err)
	}
	if candidateBefore != ledger.ProductBuild {
		return releasegate.EvidenceReceipt{}, errors.New("prepared ledger is bound to a different packaged candidate")
	}
	releaseCandidateID, err := releasegate.CandidateID(candidateBefore)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	if releaseCandidateID != ledger.ReleaseCandidateID {
		return releasegate.EvidenceReceipt{}, errors.New("prepared ledger candidate id does not match packaged build")
	}
	environment, environmentSHA256, err := localEnvironment()
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}

	outputPath, detailsPath, err := validateOutputPaths(
		config.OutputPath, config.LedgerPath, candidateExecutable, runtimeManifest, sidecarEntrypoint, goExecutable,
	)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	detailsOutput, receiptOutput, err := reserveOutputs(detailsPath, outputPath)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	defer detailsOutput.Close()
	defer receiptOutput.Close()

	temporaryRoot := ""
	if gateID == GateWindowsHost || gateID == GateRAG50000 {
		temporaryRoot, err = os.MkdirTemp("", "AetherOps-Local-Release-Evidence-*")
		if err != nil {
			return releasegate.EvidenceReceipt{}, fmt.Errorf("create isolated local gate root: %w", err)
		}
	}
	plan, err := fixedGatePlan(gateID, sourceRoot, goExecutable, powerShellExecutable, candidateExecutable, temporaryRoot)
	if err != nil {
		if temporaryRoot != "" {
			_ = os.RemoveAll(temporaryRoot)
		}
		return releasegate.EvidenceReceipt{}, err
	}
	commandSubjectHashes, err := sealGateCommandInputs(gateID, sourceRoot, goExecutable, powerShellExecutable)
	if err != nil {
		if temporaryRoot != "" {
			_ = os.RemoveAll(temporaryRoot)
		}
		return releasegate.EvidenceReceipt{}, fmt.Errorf("seal fixed gate command inputs: %w", err)
	}
	sourceBefore := sourceTreeSeal{}
	if gateUsesSourceTree(gateID) {
		sourceBefore, err = sealSourceTree(sourceRoot)
		if err != nil {
			if temporaryRoot != "" {
				_ = os.RemoveAll(temporaryRoot)
			}
			return releasegate.EvidenceReceipt{}, fmt.Errorf("seal release source tree: %w", err)
		}
	}

	observations := make([]CommandObservation, 0, len(plan.Commands))
	validations := make([]Validation, 0, len(plan.Commands)+16)
	for _, specification := range plan.Commands {
		if ctx.Err() != nil {
			validations = append(validations, failedValidation("command_"+specification.ID, ctx.Err()))
			break
		}
		before := clock().UTC()
		observation := runner.Run(ctx, sourceRoot, specification)
		after := clock().UTC()
		observation.ID = specification.ID
		observation.Executable = specification.Executable
		observation.Arguments = append([]string(nil), specification.Arguments...)
		observation.Environment = append([]EnvironmentVariable(nil), specification.Environment...)
		observation.WorkingDir = sourceRoot
		observation.Timeout = specification.Timeout.String()
		if observation.StartedAt.IsZero() {
			observation.StartedAt = before
		}
		if observation.FinishedAt.IsZero() {
			observation.FinishedAt = after
		}
		observations = append(observations, observation)
		validationID := "command_" + specification.ID + "_exit_zero"
		if commandPassed(observation) {
			validations = append(validations, Validation{ID: validationID, Passed: true})
		} else {
			failure := fmt.Sprintf("exit_code=%d", observation.ExitCode)
			if observation.StartError != "" {
				failure += " start_error=" + observation.StartError
			}
			validations = append(validations, Validation{ID: validationID, Failure: failure})
		}
	}
	commandTimesValid := len(observations) == len(plan.Commands)
	for _, observation := range observations {
		commandTimesValid = commandTimesValid && !observation.StartedAt.Before(ledger.PreparedAt) &&
			!observation.FinishedAt.Before(observation.StartedAt)
	}
	validations = append(validations, Validation{
		ID: "command_observation_window", Passed: commandTimesValid,
		Failure: failureUnless(commandTimesValid, "one or more command observations are outside the prepared ledger window"),
	})

	gateArtifact, gateArtifactSHA256, gateValidations := validateGateResult(gateID, observations, plan.GateArtifactPath, ledger.PreparedAt)
	validations = append(validations, gateValidations...)
	if runner.ReleaseEvidenceEligible() {
		validations = append(validations, Validation{ID: "actual_command_runner", Passed: true})
	} else {
		validations = append(validations, Validation{ID: "actual_command_runner", Failure: "injected runner is diagnostic-only"})
	}

	if temporaryRoot != "" {
		if cleanupErr := removeTemporaryGateRoot(temporaryRoot); cleanupErr != nil {
			validations = append(validations, failedValidation("isolated_temporary_root_removed", cleanupErr))
		} else {
			validations = append(validations, Validation{ID: "isolated_temporary_root_removed", Passed: true})
		}
	}

	candidateAfter, candidateErr := buildinfo.BindProductBuild(candidateExecutable, runtimeManifest, sidecarEntrypoint)
	if candidateErr != nil {
		validations = append(validations, failedValidation("candidate_reauthenticated", candidateErr))
	} else if candidateAfter != candidateBefore || candidateAfter != ledger.ProductBuild {
		validations = append(validations, Validation{ID: "candidate_reauthenticated", Failure: "packaged candidate changed during observation"})
	} else {
		validations = append(validations, Validation{ID: "candidate_reauthenticated", Passed: true})
	}
	observationFinished := clock().UTC()
	if observationFinished.Before(ledger.PreparedAt) || observationFinished.Before(observationStarted) {
		validations = append(validations, Validation{ID: "ledger_observation_window", Failure: "observation timestamp precedes prepared ledger"})
	} else {
		validations = append(validations, Validation{ID: "ledger_observation_window", Passed: true})
	}
	commandInputsAfter, sealErr := sealGateCommandInputs(gateID, sourceRoot, goExecutable, powerShellExecutable)
	if sealErr != nil {
		validations = append(validations, failedValidation("fixed_command_inputs_reauthenticated", sealErr))
	} else if !equalStringMap(commandSubjectHashes, commandInputsAfter) {
		validations = append(validations, Validation{ID: "fixed_command_inputs_reauthenticated", Failure: "fixed command input changed during observation"})
	} else {
		validations = append(validations, Validation{ID: "fixed_command_inputs_reauthenticated", Passed: true})
	}
	if gateUsesSourceTree(gateID) {
		sourceAfter, sourceErr := sealSourceTree(sourceRoot)
		switch {
		case sourceErr != nil:
			validations = append(validations, failedValidation("source_tree_reauthenticated", sourceErr))
		case sourceAfter != sourceBefore:
			validations = append(validations, Validation{ID: "source_tree_reauthenticated", Failure: "release source tree changed during observation"})
		default:
			validations = append(validations, Validation{ID: "source_tree_reauthenticated", Passed: true})
		}
		commandSubjectHashes["source-tree"] = sourceBefore.SHA256
	}

	details := Details{
		Schema: DetailsSchemaV2, GateID: gateID, ReleaseCandidateID: releaseCandidateID,
		LedgerSHA256: ledgerSHA256, LedgerPreparedAt: ledger.PreparedAt,
		ObservationStartedAt: observationStarted, ObservationFinishedAt: observationFinished,
		CandidateBefore: candidateBefore, CandidateAfter: candidateAfter,
		SourceTreeSHA256: sourceBefore.SHA256, SourceFileCount: sourceBefore.FileCount,
		Environment: environment, Commands: observations, Validations: validations,
		GateArtifact: gateArtifact, GateArtifactSHA256: gateArtifactSHA256,
		ReleaseEligibleRunner: runner.ReleaseEvidenceEligible(),
		EvidenceScope:         []string{gateID, "local_integration", "exact_candidate_binding", "actual_command_exit_and_output"},
		ExcludedReleaseClaims: []string{
			"overall_release_success", "live_service", "live_quality_12", "clean_vm", "production_update_feed", "incompatible_hardware",
		},
	}
	detailsRaw, err := marshalJSON(details)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	detailsDigest := sha256.Sum256(detailsRaw)
	detailsSHA256 := hex.EncodeToString(detailsDigest[:])

	subjectHashes := map[string]string{
		"aetherops.exe":          candidateBefore.ExecutableSHA256,
		"runtime-manifest.json":  candidateBefore.RuntimeManifestSHA256,
		"knowledge-sidecar-tree": candidateBefore.KnowledgeSidecarTreeSHA256,
		"prepared-ledger":        ledgerSHA256,
		"local-gate-details":     detailsSHA256,
	}
	for name, digest := range commandSubjectHashes {
		subjectHashes[name] = digest
	}
	for _, observation := range observations {
		subjectHashes["command_"+observation.ID+"_stdout"] = observation.Stdout.SHA256
		subjectHashes["command_"+observation.ID+"_stderr"] = observation.Stderr.SHA256
	}
	if gateArtifactSHA256 != "" {
		subjectHashes["gate_artifact"] = gateArtifactSHA256
	}
	subjectHashes[requiredGateSubjectName(gateID)] = detailsSHA256

	passed := validationsPassed(validations)
	status := "failed"
	if passed {
		status = "passed"
	}
	receipt := releasegate.EvidenceReceipt{
		Schema: releasegate.EvidenceSchemaV1, GateID: gateID,
		EvidenceKind:       releasegate.EvidenceLocalIntegration,
		ReleaseCandidateID: releaseCandidateID, ProductBuild: candidateBefore,
		Producer: releasegate.Producer{Name: ProducerName, Version: ProducerVersion},
		Environment: releasegate.Environment{
			Class: string(releasegate.EvidenceLocalIntegration), OS: "windows-11",
			Architecture: runtime.GOARCH, IdentitySHA256: environmentSHA256,
		},
		ObservedAt: observationFinished, Status: status,
		SubjectHashes: subjectHashList(subjectHashes), DetailsPath: filepath.Base(detailsPath), DetailsSHA256: detailsSHA256,
	}
	if err := receipt.Validate(); err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("validate local release evidence receipt: %w", err)
	}
	if err := detailsOutput.WriteAll(detailsRaw); err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("write local gate details: %w", err)
	}
	receiptRaw, err := marshalJSON(receipt)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	if err := receiptOutput.WriteAll(receiptRaw); err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("write local gate receipt: %w", err)
	}
	if !passed {
		return receipt, fmt.Errorf("%w: %s", ErrGateFailed, validationFailures(validations))
	}
	return receipt, nil
}

func (realCommandRunner) ReleaseEvidenceEligible() bool { return true }

func (realCommandRunner) Run(parent context.Context, workingDirectory string, specification commandSpec) CommandObservation {
	started := time.Now().UTC()
	commandContext, cancel := context.WithTimeout(parent, specification.Timeout)
	defer cancel()
	command := exec.CommandContext(commandContext, specification.Executable, specification.Arguments...)
	command.Dir = workingDirectory
	command.Env = fixedCommandEnvironment(specification.Environment)
	processutil.ConfigureNoWindow(command)
	stdout := newBoundedStream(maxCapturedStreamBytes)
	stderr := newBoundedStream(maxCapturedStreamBytes)
	command.Stdout = stdout
	command.Stderr = stderr
	exitCode := -1
	startError := ""
	err := command.Run()
	if err == nil {
		exitCode = 0
	} else {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			exitCode = exitError.ExitCode()
		} else {
			startError = err.Error()
		}
		if commandContext.Err() != nil {
			startError = commandContext.Err().Error()
		}
	}
	return CommandObservation{
		StartedAt: started, FinishedAt: time.Now().UTC(), ExitCode: exitCode, StartError: startError,
		Stdout: stdout.Observation(), Stderr: stderr.Observation(),
	}
}

func validateGateResult(gateID string, observations []CommandObservation, artifactPath string, preparedAt time.Time) (json.RawMessage, string, []Validation) {
	byID := make(map[string]CommandObservation, len(observations))
	for _, observation := range observations {
		byID[observation.ID] = observation
	}
	validations := make([]Validation, 0, 16)
	if gateID != GateWindowsHost {
		goVersion := strings.TrimSpace(byID["go_version"].Stdout.Text)
		if commandPassed(byID["go_version"]) && !byID["go_version"].Stdout.Truncated && goVersion == "go version go1.26.5 windows/amd64" {
			validations = append(validations, Validation{ID: "fixed_go_1_26_5_windows_amd64", Passed: true})
		} else {
			validations = append(validations, Validation{ID: "fixed_go_1_26_5_windows_amd64", Failure: "unexpected go version output"})
		}
	}
	switch gateID {
	case GateLocalSourceTests:
		nodeVersion := commandPassed(byID["node_version"]) && !byID["node_version"].Stdout.Truncated &&
			strings.TrimSpace(byID["node_version"].Stdout.Text) == "v24.19.0"
		npmVersion := commandPassed(byID["npm_version"]) && !byID["npm_version"].Stdout.Truncated &&
			strings.TrimSpace(byID["npm_version"].Stdout.Text) == "11.17.0"
		validations = append(validations,
			Validation{ID: "fixed_node_24_19_0", Passed: nodeVersion, Failure: failureUnless(nodeVersion, "unexpected managed Node.js version output")},
			Validation{ID: "fixed_npm_11_17_0", Passed: npmVersion, Failure: failureUnless(npmVersion, "unexpected managed npm version output")},
		)
		return nil, "", append(validations, Validation{
			ID: "full_source_suite", Passed: commandPassed(byID["local_source_tests"]),
			Failure: failureUnless(commandPassed(byID["local_source_tests"]), "full Go source suite did not pass"),
		})
	case GateWindowsHost:
		raw := []byte(strings.TrimSpace(byID["packaged_gate0"].Stdout.Text))
		report, err := validateGate0Report(raw, byID["packaged_gate0"])
		if err != nil {
			validations = append(validations, failedValidation("actual_packaged_windows_gate0", err))
			return nil, "", validations
		}
		digest := sha256.Sum256(raw)
		validations = append(validations, Validation{ID: "actual_packaged_windows_gate0", Passed: true})
		return report, hex.EncodeToString(digest[:]), validations
	case GateRAG50000:
		observation := byID["rag_50000"]
		if outputProvesTestRan(observation, "TestHybridGraphV1FiftyThousandChunkReleaseGate") {
			validations = append(validations, Validation{ID: "rag_50000_test_executed_not_skipped", Passed: true})
		} else {
			validations = append(validations, Validation{ID: "rag_50000_test_executed_not_skipped", Failure: "50k test did not emit a non-skipped PASS"})
		}
		raw, err := readRegularLimit(artifactPath, maximumGateArtifactBytes)
		if err != nil {
			validations = append(validations, failedValidation("rag_50000_artifact", err))
			return nil, "", validations
		}
		artifact, err := validateRAGArtifact(raw, preparedAt)
		if err != nil {
			validations = append(validations, failedValidation("rag_50000_artifact", err))
			return nil, "", validations
		}
		digest := sha256.Sum256(raw)
		validations = append(validations, Validation{ID: "rag_50000_artifact", Passed: true})
		return artifact, hex.EncodeToString(digest[:]), validations
	case GateScheduler:
		contracts := byID["scheduler_contracts"]
		allContracts := commandPassed(contracts) && !contracts.Stdout.Truncated
		for _, testName := range schedulerContractTests {
			allContracts = allContracts && outputProvesTestRan(contracts, testName)
		}
		validations = append(validations, Validation{
			ID: "scheduler_dst_approval_restart_contracts", Passed: allContracts,
			Failure: failureUnless(allContracts, "one or more fixed scheduler contract tests did not emit PASS"),
		})
		forced := outputProvesTestRan(byID["scheduler_forced_exit"], "TestServiceForcedTerminationBoundariesNeverDuplicateOccurrence")
		validations = append(validations, Validation{
			ID: "scheduler_forced_exit_separate_process", Passed: forced,
			Failure: failureUnless(forced, "scheduler forced-exit boundary test did not emit a non-skipped PASS"),
		})
		return nil, "", validations
	default:
		return nil, "", append(validations, Validation{ID: "fixed_gate", Failure: "unsupported gate"})
	}
}

func validateGate0Report(raw []byte, observation CommandObservation) (json.RawMessage, error) {
	if !commandPassed(observation) {
		return nil, errors.New("packaged Gate 0 command did not exit successfully")
	}
	if observation.Stdout.Truncated || len(raw) == 0 {
		return nil, errors.New("packaged Gate 0 output is absent or truncated")
	}
	if err := gate0evidence.Validate(raw, observation.StartedAt, observation.FinishedAt); err != nil {
		return nil, fmt.Errorf("validate packaged Gate 0 report: %w", err)
	}
	return append(json.RawMessage(nil), raw...), nil
}

type ragArtifact struct {
	SchemaVersion string `json:"schema_version"`
	GeneratedAt   string `json:"generated_at"`
	Dataset       struct {
		ChunkCount int `json:"chunk_count"`
	} `json:"dataset"`
	Correctness struct {
		MulticoreExactSearch bool `json:"multicore_exact_search"`
	} `json:"correctness"`
	Failures []string `json:"failures"`
	Passed   bool     `json:"passed"`
}

func validateRAGArtifact(raw []byte, preparedAt time.Time) (json.RawMessage, error) {
	var artifact ragArtifact
	if err := json.Unmarshal(raw, &artifact); err != nil {
		return nil, fmt.Errorf("decode 50k performance artifact: %w", err)
	}
	generatedAt, err := time.Parse(time.RFC3339Nano, artifact.GeneratedAt)
	if err != nil {
		return nil, errors.New("50k performance artifact generated_at is invalid")
	}
	if artifact.SchemaVersion != "hybrid_graph_v1_50k_performance_v1" ||
		artifact.Dataset.ChunkCount != 50_000 || !artifact.Correctness.MulticoreExactSearch ||
		!artifact.Passed || len(artifact.Failures) != 0 || generatedAt.Before(preparedAt) {
		return nil, errors.New("50k performance artifact does not satisfy the fixed release contract")
	}
	return append(json.RawMessage(nil), raw...), nil
}

func fixedCommandEnvironment(additions []EnvironmentVariable) []string {
	result := make([]string, 0, len(os.Environ())+len(additions)+3)
	overrides := make(map[string]EnvironmentVariable, len(additions))
	pathPrepend := ""
	for _, addition := range additions {
		if strings.EqualFold(addition.Name, "PATH_PREPEND") {
			pathPrepend = addition.Value
			continue
		}
		overrides[strings.ToUpper(addition.Name)] = addition
	}
	existingPath := ""
	for _, entry := range os.Environ() {
		name := entry
		value := ""
		if index := strings.IndexByte(entry, '='); index >= 0 {
			name = entry[:index]
			value = entry[index+1:]
		}
		upper := strings.ToUpper(name)
		if upper == "PATH" {
			existingPath = value
			if pathPrepend != "" {
				continue
			}
		}
		if _, replaced := overrides[upper]; replaced {
			continue
		}
		if strings.HasPrefix(upper, "AETHEROPS_") {
			continue
		}
		switch upper {
		case "GOENV", "GOFLAGS", "GOMAXPROCS", "GOMOD", "GOTOOLCHAIN", "GOWORK":
			continue
		}
		result = append(result, entry)
	}
	result = append(result, "GOENV=off", "GOFLAGS=", "GOTOOLCHAIN=local", "GOWORK=off")
	if pathPrepend != "" {
		result = append(result, "PATH="+prependPath(pathPrepend, existingPath))
	}
	overrideNames := make([]string, 0, len(overrides))
	for name := range overrides {
		overrideNames = append(overrideNames, name)
	}
	sort.Strings(overrideNames)
	for _, name := range overrideNames {
		addition := overrides[name]
		result = append(result, addition.Name+"="+addition.Value)
	}
	return result
}

func validateSourceRoot() (string, string, string, error) {
	root, err := os.Getwd()
	if err != nil {
		return "", "", "", err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return "", "", "", err
	}
	for {
		module, moduleErr := readRegularLimit(filepath.Join(root, "go.mod"), 1<<20)
		if moduleErr == nil && strings.HasPrefix(string(module), "module github.com/djkim0320/AetherOps\n") {
			break
		}
		parent := filepath.Dir(root)
		if parent == root {
			return "", "", "", errors.New("current directory is not within the AetherOps source root")
		}
		root = parent
	}
	goExecutable := filepath.Join(root, ".tools", "go1.26.5", "bin", "go.exe")
	if _, err := hashRegularFile(goExecutable); err != nil {
		return "", "", "", fmt.Errorf("verify fixed Go 1.26.5 executable: %w", err)
	}
	windowsDirectory, err := windows.GetWindowsDirectory()
	if err != nil {
		return "", "", "", fmt.Errorf("resolve Windows directory: %w", err)
	}
	powerShellExecutable := filepath.Join(windowsDirectory, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if _, err := hashRegularFile(powerShellExecutable); err != nil {
		return "", "", "", fmt.Errorf("verify fixed Windows PowerShell executable: %w", err)
	}
	return root, goExecutable, powerShellExecutable, nil
}

func sealGateCommandInputs(gateID, sourceRoot, goExecutable, powerShellExecutable string) (map[string]string, error) {
	paths := map[string]string{}
	if gateID != GateWindowsHost {
		paths["go1.26.5.exe"] = goExecutable
	}
	if gateID == GateLocalSourceTests {
		paths["windows-powershell.exe"] = powerShellExecutable
		paths["tools-dev.ps1"] = filepath.Join(sourceRoot, "tools", "dev.ps1")
		nodeRoot := filepath.Join(sourceRoot, ".runtime", "versions", "node", "24.19.0")
		paths["node-24.19.0.exe"] = filepath.Join(nodeRoot, "node.exe")
		paths["npm-11.17.0.cmd"] = filepath.Join(nodeRoot, "npm.cmd")
		paths["npm-11.17.0-cli.js"] = filepath.Join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js")
	}
	result := make(map[string]string, len(paths))
	for name, path := range paths {
		digest, err := hashRegularFile(path)
		if err != nil {
			return nil, fmt.Errorf("hash %s: %w", name, err)
		}
		result[name] = digest
	}
	return result, nil
}

func equalStringMap(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
}

func gateUsesSourceTree(gateID string) bool {
	return gateID == GateLocalSourceTests || gateID == GateRAG50000 || gateID == GateScheduler
}

func absoluteCandidatePaths(config Config) (string, string, string, error) {
	values := []string{
		strings.TrimSpace(config.AetherOpsExecutablePath),
		strings.TrimSpace(config.RuntimeManifestPath),
		strings.TrimSpace(config.KnowledgeSidecarEntrypoint),
	}
	for _, value := range values {
		if value == "" {
			return "", "", "", errors.New("all exact packaged candidate paths are required")
		}
	}
	absolute := make([]string, len(values))
	for index, value := range values {
		resolved, err := filepath.Abs(value)
		if err != nil {
			return "", "", "", err
		}
		absolute[index] = resolved
	}
	if !strings.EqualFold(filepath.Base(absolute[0]), "aetherops.exe") {
		return "", "", "", errors.New("packaged candidate executable must be named aetherops.exe")
	}
	expectedManifest := filepath.Join(filepath.Dir(absolute[0]), "runtime-manifest.json")
	expectedSidecar := filepath.Join(filepath.Dir(absolute[0]), "knowledge-sidecar", "index.cjs")
	if !samePath(absolute[1], expectedManifest) || !samePath(absolute[2], expectedSidecar) {
		return "", "", "", errors.New("packaged candidate manifest and sidecar must use the fixed executable-sibling layout")
	}
	resolved := make([]string, len(absolute))
	for index, value := range absolute {
		actual, resolveErr := filepath.EvalSymlinks(value)
		if resolveErr != nil {
			return "", "", "", fmt.Errorf("resolve packaged candidate path: %w", resolveErr)
		}
		resolved[index], resolveErr = filepath.Abs(actual)
		if resolveErr != nil {
			return "", "", "", resolveErr
		}
	}
	if !samePath(resolved[1], filepath.Join(filepath.Dir(resolved[0]), "runtime-manifest.json")) ||
		!samePath(resolved[2], filepath.Join(filepath.Dir(resolved[0]), "knowledge-sidecar", "index.cjs")) {
		return "", "", "", errors.New("packaged candidate resolves outside the fixed executable-sibling layout")
	}
	return absolute[0], absolute[1], absolute[2], nil
}

func localEnvironment() (EnvironmentDetails, string, error) {
	version := windows.RtlGetVersion()
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" || version.BuildNumber < 22000 {
		return EnvironmentDetails{}, "", errors.New("local release evidence requires an actual Windows 11 x64 host")
	}
	environment := EnvironmentDetails{
		OS: "windows-11", Architecture: runtime.GOARCH, GoVersion: runtime.Version(),
		LogicalProcessors: runtime.NumCPU(), ProcessorIdentifier: os.Getenv("PROCESSOR_IDENTIFIER"),
		WindowsVersion: fmt.Sprintf("%d.%d.%d", version.MajorVersion, version.MinorVersion, version.BuildNumber),
	}
	canonical, err := json.Marshal(environment)
	if err != nil {
		return EnvironmentDetails{}, "", err
	}
	digest := sha256.New()
	_, _ = io.WriteString(digest, detailsIdentityDomain)
	_, _ = digest.Write(canonical)
	return environment, hex.EncodeToString(digest.Sum(nil)), nil
}

func isAllowedGate(gateID string) bool {
	switch gateID {
	case GateLocalSourceTests, GateWindowsHost, GateRAG50000, GateScheduler:
		return true
	default:
		return false
	}
}

func requiredGateSubjectName(gateID string) string {
	switch gateID {
	case GateLocalSourceTests:
		return "local-source-test-receipt"
	case GateWindowsHost:
		return "gate0-windows-host-receipt"
	case GateRAG50000:
		return "rag-50000-receipt"
	case GateScheduler:
		return "scheduler-recovery-receipt"
	default:
		return "invalid-local-gate-receipt"
	}
}

type reservedOutput struct {
	path string
	file *os.File
}

func reserveOutputs(detailsPath, receiptPath string) (*reservedOutput, *reservedOutput, error) {
	details, err := reserveOutput(detailsPath)
	if err != nil {
		return nil, nil, fmt.Errorf("reserve local gate details: %w", err)
	}
	receipt, err := reserveOutput(receiptPath)
	if err != nil {
		_ = details.Close()
		_ = os.Remove(details.path)
		return nil, nil, fmt.Errorf("reserve local gate receipt: %w", err)
	}
	return details, receipt, nil
}

func reserveOutput(path string) (*reservedOutput, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	return &reservedOutput{path: path, file: file}, nil
}

func (output *reservedOutput) WriteAll(data []byte) error {
	if output == nil || output.file == nil {
		return errors.New("output was not reserved")
	}
	written, err := output.file.Write(data)
	if err != nil {
		return err
	}
	if written != len(data) {
		return io.ErrShortWrite
	}
	if err := output.file.Sync(); err != nil {
		return err
	}
	return output.Close()
}

func (output *reservedOutput) Close() error {
	if output == nil || output.file == nil {
		return nil
	}
	err := output.file.Close()
	output.file = nil
	return err
}

func validateOutputPaths(output, ledger, executable, manifest, sidecar, goExecutable string) (string, string, error) {
	if strings.TrimSpace(output) == "" {
		return "", "", errors.New("new output path is required")
	}
	receiptPath, err := filepath.Abs(output)
	if err != nil {
		return "", "", err
	}
	ledgerPath, err := filepath.Abs(ledger)
	if err != nil {
		return "", "", err
	}
	if !strings.EqualFold(filepath.Ext(receiptPath), ".json") || !samePath(filepath.Dir(receiptPath), filepath.Dir(ledgerPath)) {
		return "", "", errors.New("evidence receipt must be a new JSON sibling of the prepared ledger")
	}
	detailsPath := detailsPathForReceipt(receiptPath)
	protected := []string{ledger, executable, manifest, sidecar, goExecutable}
	for _, value := range protected {
		absolute, pathErr := filepath.Abs(value)
		if pathErr != nil {
			return "", "", pathErr
		}
		if samePath(receiptPath, absolute) || samePath(detailsPath, absolute) {
			return "", "", errors.New("evidence output overlaps a protected input")
		}
	}
	sidecarDirectory, err := filepath.Abs(filepath.Dir(sidecar))
	if err != nil {
		return "", "", err
	}
	if pathWithin(receiptPath, sidecarDirectory) || pathWithin(detailsPath, sidecarDirectory) {
		return "", "", errors.New("evidence output cannot modify the bound sidecar tree")
	}
	return receiptPath, detailsPath, nil
}

func detailsPathForReceipt(path string) string {
	extension := filepath.Ext(path)
	if extension == "" {
		return path + ".details.json"
	}
	return strings.TrimSuffix(path, extension) + ".details.json"
}

func pathWithin(path, directory string) bool {
	relative, err := filepath.Rel(directory, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func samePath(left, right string) bool {
	return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
}

func removeTemporaryGateRoot(root string) error {
	clean := filepath.Clean(root)
	if !strings.HasPrefix(filepath.Base(clean), "AetherOps-Local-Release-Evidence-") || samePath(clean, os.TempDir()) {
		return errors.New("refused to remove an unexpected local gate path")
	}
	parent, err := filepath.Abs(filepath.Dir(clean))
	if err != nil {
		return err
	}
	temporaryParent, err := filepath.Abs(os.TempDir())
	if err != nil {
		return err
	}
	if !samePath(parent, temporaryParent) {
		return errors.New("local gate root is outside the operating-system temporary directory")
	}
	// WebView2 may keep profile database handles alive for a short period after
	// the owning desktop process and its controller have stopped. The evidence
	// runner must still prove complete isolation cleanup, so retry the exact
	// validated temp root instead of accepting a leftover or weakening the gate.
	deadline := time.Now().Add(temporaryCleanupWindow)
	delay := 25 * time.Millisecond
	var lastErr error
	for {
		if err := os.RemoveAll(clean); err != nil {
			lastErr = err
		} else if _, err := os.Lstat(clean); os.IsNotExist(err) {
			return nil
		} else if err != nil {
			lastErr = err
		} else {
			lastErr = errors.New("temporary gate root still exists after removal")
		}
		if !time.Now().Before(deadline) {
			return lastErr
		}
		time.Sleep(delay)
		if delay < 250*time.Millisecond {
			delay *= 2
			if delay > 250*time.Millisecond {
				delay = 250 * time.Millisecond
			}
		}
	}
}

func readRegularLimit(path string, maximum int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 0 || info.Size() > maximum {
		return nil, errors.New("input is not a bounded regular non-symlink file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(info, opened) {
		return nil, errors.New("input changed while opening")
	}
	raw, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) != opened.Size() || len(raw) > int(maximum) {
		return nil, errors.New("input changed while reading")
	}
	return raw, nil
}

func hashRegularFile(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("subject is not a regular non-symlink file")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	written, err := io.Copy(digest, file)
	if err != nil {
		return "", err
	}
	if written != info.Size() {
		return "", errors.New("subject changed while hashing")
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

type boundedStream struct {
	digest hash.Hash
	buffer bytes.Buffer
	total  int64
	limit  int
}

func newBoundedStream(limit int) *boundedStream {
	return &boundedStream{digest: sha256.New(), limit: limit}
}

func (stream *boundedStream) Write(value []byte) (int, error) {
	_, _ = stream.digest.Write(value)
	stream.total += int64(len(value))
	remaining := stream.limit - stream.buffer.Len()
	if remaining > 0 {
		retained := value
		if len(retained) > remaining {
			retained = retained[:remaining]
		}
		_, _ = stream.buffer.Write(retained)
	}
	return len(value), nil
}

func (stream *boundedStream) Observation() StreamObservation {
	return StreamObservation{
		Bytes: stream.total, CapturedBytes: stream.buffer.Len(),
		SHA256: hex.EncodeToString(stream.digest.Sum(nil)), Truncated: stream.total > int64(stream.buffer.Len()),
		Text: stream.buffer.String(),
	}
}

func marshalJSON(value any) ([]byte, error) {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(raw, '\n'), nil
}

func subjectHashList(values map[string]string) []releasegate.SubjectHash {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]releasegate.SubjectHash, 0, len(names))
	for _, name := range names {
		result = append(result, releasegate.SubjectHash{Name: name, SHA256: values[name]})
	}
	return result
}

func validationsPassed(values []Validation) bool {
	if len(values) == 0 {
		return false
	}
	for _, value := range values {
		if !value.Passed {
			return false
		}
	}
	return true
}

func validationFailures(values []Validation) string {
	failures := make([]string, 0)
	for _, value := range values {
		if !value.Passed {
			failures = append(failures, value.ID+": "+value.Failure)
		}
	}
	return strings.Join(failures, "; ")
}

func failedValidation(id string, err error) Validation {
	failure := "unknown failure"
	if err != nil {
		failure = err.Error()
	}
	return Validation{ID: id, Failure: failure}
}

func failureUnless(passed bool, failure string) string {
	if passed {
		return ""
	}
	return failure
}
