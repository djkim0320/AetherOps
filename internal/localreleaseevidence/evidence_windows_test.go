//go:build windows

package localreleaseevidence

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/gate0evidence"
	"github.com/djkim0320/Aether-claw/internal/releasegate"
)

type diagnosticRunner struct {
	exitCode int
	stdout   string
	stderr   string
	calls    []commandSpec
}

func (*diagnosticRunner) ReleaseEvidenceEligible() bool { return false }

func skipHostedCIReleaseEvidence(t *testing.T) {
	t.Helper()
	if os.Getenv("CI") != "" {
		t.Skip("release evidence requires the pinned project-local Go toolchain and packaged candidate layout")
	}
}

func (runner *diagnosticRunner) Run(_ context.Context, _ string, specification commandSpec) CommandObservation {
	runner.calls = append(runner.calls, specification)
	return CommandObservation{
		ExitCode: runner.exitCode,
		Stdout:   boundedObservation(runner.stdout),
		Stderr:   boundedObservation(runner.stderr),
	}
}

func TestInjectedGate0RunnerCannotMintPassingEvidence(t *testing.T) {
	skipHostedCIReleaseEvidence(t)
	configuration, _, _ := localEvidenceFixture(t, GateWindowsHost)
	runner := &diagnosticRunner{stdout: validGate0FixtureJSON(t)}
	now := time.Now().UTC()
	receipt, err := generate(context.Background(), configuration, runner, func() time.Time { return now })
	if !errors.Is(err, ErrGateFailed) {
		t.Fatalf("injected runner result error=%v, want gate failure", err)
	}
	if receipt.Status != "failed" || receipt.GateID != GateWindowsHost {
		t.Fatalf("injected runner minted unexpected receipt: %+v", receipt)
	}
	if err := receipt.Validate(); err != nil {
		t.Fatalf("failure receipt is not structurally valid: %v", err)
	}
	if len(runner.calls) != 1 || runner.calls[0].ID != "packaged_gate0" ||
		filepath.Base(runner.calls[0].Executable) != "aetherops.exe" ||
		len(runner.calls[0].Arguments) != 3 || runner.calls[0].Arguments[0] != "gate0" ||
		runner.calls[0].Arguments[1] != "--data-root" || runner.calls[0].Arguments[2] == "" ||
		len(runner.calls[0].Environment) != 0 {
		t.Fatalf("Gate 0 command was not fixed to packaged executable: %+v", runner.calls)
	}
	details := readDetailsFixture(t, configuration.OutputPath)
	if details.ReleaseEligibleRunner {
		t.Fatal("diagnostic runner was represented as release eligible")
	}
	foundFailure := false
	for _, validation := range details.Validations {
		if validation.ID == "actual_command_runner" && !validation.Passed {
			foundFailure = true
		}
	}
	if !foundFailure {
		t.Fatalf("details omitted injected-runner failure: %+v", details.Validations)
	}
	wantSubject := requiredGateSubjectName(GateWindowsHost)
	foundSubject := false
	for _, subject := range receipt.SubjectHashes {
		if subject.Name == wantSubject && subject.SHA256 == receipt.DetailsSHA256 {
			foundSubject = true
		}
	}
	if !foundSubject || receipt.DetailsPath != filepath.Base(detailsPathForReceipt(configuration.OutputPath)) {
		t.Fatalf("receipt omitted fixed gate/details binding: %+v", receipt)
	}

	if _, err := generate(context.Background(), configuration, runner, func() time.Time { return now }); err == nil {
		t.Fatal("existing receipt/details were overwritten")
	}
}

func TestFailureOutputIsBoundedButHashesEveryByte(t *testing.T) {
	skipHostedCIReleaseEvidence(t)
	configuration, _, _ := localEvidenceFixture(t, GateLocalSourceTests)
	stdout := strings.Repeat("source-test-output", (maxCapturedStreamBytes/len("source-test-output"))+100)
	stderr := strings.Repeat("failure", 100)
	runner := &diagnosticRunner{exitCode: 7, stdout: stdout, stderr: stderr}
	now := time.Now().UTC()
	receipt, err := generate(context.Background(), configuration, runner, func() time.Time { return now })
	if !errors.Is(err, ErrGateFailed) || receipt.Status != "failed" {
		t.Fatalf("failed command result=%+v err=%v", receipt, err)
	}
	details := readDetailsFixture(t, configuration.OutputPath)
	if len(details.Commands) != 4 {
		t.Fatalf("local source command count=%d, want 4", len(details.Commands))
	}
	var observation CommandObservation
	for _, command := range details.Commands {
		if command.ID == "local_source_tests" {
			observation = command
		}
	}
	if observation.ID != "local_source_tests" || !observation.Stdout.Truncated ||
		observation.Stdout.CapturedBytes != maxCapturedStreamBytes || observation.Stdout.Bytes != int64(len(stdout)) {
		t.Fatalf("stdout was not bounded with total length preserved: %+v", observation.Stdout)
	}
	wantHash := sha256.Sum256([]byte(stdout))
	if observation.Stdout.SHA256 != hex.EncodeToString(wantHash[:]) {
		t.Fatalf("bounded stdout hash=%s, want full-stream hash", observation.Stdout.SHA256)
	}
	wantPowerShell, err := windowsPowerShellPath()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(observation.Executable, wantPowerShell) ||
		!containsArguments(observation.Arguments, "-File", filepath.Join(mustWorkingDirectory(t), "tools", "dev.ps1"), "test") {
		t.Fatalf("local source gate did not run fixed tools/dev.ps1 test: %+v", observation)
	}
}

func TestCandidateMismatchStopsBeforeCommandAndOutput(t *testing.T) {
	skipHostedCIReleaseEvidence(t)
	configuration, _, executable := localEvidenceFixture(t, GateScheduler)
	if err := os.WriteFile(executable, []byte("mutated candidate"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &diagnosticRunner{exitCode: 0}
	if _, err := generate(context.Background(), configuration, runner, time.Now); err == nil || !strings.Contains(err.Error(), "different packaged candidate") {
		t.Fatalf("candidate mismatch error=%v", err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("candidate mismatch still ran commands: %+v", runner.calls)
	}
	if _, err := os.Stat(configuration.OutputPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("candidate mismatch created output: %v", err)
	}
}

func TestCandidateAndOutputPathsRejectFrankenbuildOrUnattachableLayout(t *testing.T) {
	skipHostedCIReleaseEvidence(t)
	configuration, _, _ := localEvidenceFixture(t, GateScheduler)
	outsideManifest := filepath.Join(t.TempDir(), "runtime-manifest.json")
	if err := os.WriteFile(outsideManifest, []byte("unrelated manifest"), 0o600); err != nil {
		t.Fatal(err)
	}
	configuration.RuntimeManifestPath = outsideManifest
	if _, _, _, err := absoluteCandidatePaths(configuration); err == nil || !strings.Contains(err.Error(), "sibling layout") {
		t.Fatalf("Frankenbuild candidate paths were accepted: %v", err)
	}

	configuration, _, _ = localEvidenceFixture(t, GateScheduler)
	_, goExecutable, _, err := validateSourceRoot()
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := validateOutputPaths(
		filepath.Join(t.TempDir(), "detached-receipt.json"), configuration.LedgerPath,
		configuration.AetherOpsExecutablePath, configuration.RuntimeManifestPath,
		configuration.KnowledgeSidecarEntrypoint, goExecutable,
	); err == nil || !strings.Contains(err.Error(), "sibling") {
		t.Fatalf("receipt outside the append-ledger directory was accepted: %v", err)
	}
}

func TestFixedGatePlansCannotAcceptArbitraryCommands(t *testing.T) {
	root := filepath.Clean(`C:\reviewed\AetherOps`)
	goExecutable := filepath.Join(root, ".tools", "go1.26.5", "bin", "go.exe")
	powerShell := filepath.Clean(`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`)
	candidate := filepath.Join(root, "build", "aetherops.exe")
	temporary := filepath.Join(os.TempDir(), "AetherOps-Local-Release-Evidence-plan")

	local, err := fixedGatePlan(GateLocalSourceTests, root, goExecutable, powerShell, candidate, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(local.Commands) != 4 || local.Commands[3].Executable != powerShell ||
		!containsArguments(local.Commands[3].Arguments, "-File", filepath.Join(root, "tools", "dev.ps1"), "test") ||
		!hasEnvironment(local.Commands[3], "PATH_PREPEND", filepath.Join(root, ".runtime", "versions", "node", "24.19.0")) {
		t.Fatalf("unexpected local source command: %+v", local.Commands)
	}
	rag, err := fixedGatePlan(GateRAG50000, root, goExecutable, powerShell, candidate, temporary)
	if err != nil {
		t.Fatal(err)
	}
	if len(rag.Commands) != 2 || rag.Commands[1].ID != "rag_50000" ||
		!hasEnvironment(rag.Commands[1], "AETHEROPS_RUN_50K_RETRIEVAL_GATE", "1") ||
		!hasEnvironment(rag.Commands[1], "AETHEROPS_RETRIEVAL_RECEIPT", rag.GateArtifactPath) {
		t.Fatalf("50k command omitted fixed opt-in environment: %+v", rag)
	}
	scheduler, err := fixedGatePlan(GateScheduler, root, goExecutable, powerShell, candidate, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(scheduler.Commands) != 3 || scheduler.Commands[1].ID != "scheduler_contracts" || scheduler.Commands[2].ID != "scheduler_forced_exit" ||
		strings.Contains(strings.Join(scheduler.Commands[1].Arguments, " "), "ForcedTermination") ||
		!strings.Contains(strings.Join(scheduler.Commands[2].Arguments, " "), "ForcedTermination") {
		t.Fatalf("scheduler forced-exit command was not separated: %+v", scheduler.Commands)
	}
	if _, err := fixedGatePlan("arbitrary_gate", root, goExecutable, powerShell, candidate, temporary); err == nil {
		t.Fatal("arbitrary gate was accepted")
	}
}

func TestFixedEnvironmentRemovesGateAndGoInjection(t *testing.T) {
	t.Setenv("AETHEROPS_SCHEDULER_CRASH_HELPER", "1")
	t.Setenv("AETHEROPS_RUN_50K_RETRIEVAL_GATE", "malicious")
	t.Setenv("GOFLAGS", "-run=Nothing")
	t.Setenv("GOWORK", `C:\outside\go.work`)
	environment := fixedCommandEnvironment([]EnvironmentVariable{{Name: "AETHEROPS_RUN_50K_RETRIEVAL_GATE", Value: "1"}})
	joined := strings.Join(environment, "\n")
	if strings.Contains(joined, "AETHEROPS_SCHEDULER_CRASH_HELPER=") || strings.Contains(joined, "malicious") || strings.Contains(joined, "-run=Nothing") ||
		!strings.Contains(joined, "AETHEROPS_RUN_50K_RETRIEVAL_GATE=1") || !strings.Contains(joined, "GOENV=off") || !strings.Contains(joined, "GOWORK=off") {
		t.Fatalf("fixed command environment retained injection: %s", joined)
	}
}

func localEvidenceFixture(t *testing.T, gateID string) (Config, buildinfo.ProductBuildBinding, string) {
	t.Helper()
	root := t.TempDir()
	executable := filepath.Join(root, "candidate", "aetherops.exe")
	manifest := filepath.Join(root, "candidate", "runtime-manifest.json")
	sidecarRoot := filepath.Join(root, "candidate", "knowledge-sidecar")
	for path, content := range map[string]string{
		executable:                              "candidate executable",
		manifest:                                "candidate manifest",
		filepath.Join(sidecarRoot, "index.cjs"): "index",
		filepath.Join(sidecarRoot, "protocol.cjs"): "protocol",
		filepath.Join(sidecarRoot, "worker.cjs"):   "worker",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	build, err := buildinfo.BindProductBuild(executable, manifest, filepath.Join(sidecarRoot, "index.cjs"))
	if err != nil {
		t.Fatal(err)
	}
	ledger, err := releasegate.PrepareLedger(build, time.Now().UTC().Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	ledgerPath := filepath.Join(root, "release-ledger-r1.json")
	raw, err := marshalJSON(ledger)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ledgerPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return Config{
		GateID: gateID, LedgerPath: ledgerPath, OutputPath: filepath.Join(root, gateID+".json"),
		AetherOpsExecutablePath: executable, RuntimeManifestPath: manifest,
		KnowledgeSidecarEntrypoint: filepath.Join(sidecarRoot, "index.cjs"),
	}, build, executable
}

func validGate0FixtureJSON(t *testing.T) string {
	t.Helper()
	observedAt := time.Now().UTC()
	report := gate0evidence.Artifact{RuntimeVersion: "fixture-runtime", Compliant: true}
	report.Shell = gate0evidence.Environment{UserDataDir: `C:\\fixture\\shell`, UserDataDirExists: true, CDPDisabledByConfiguration: true}
	report.Internet = gate0evidence.Environment{UserDataDir: `C:\\fixture\\internet`, UserDataDirExists: true, CDPPort: 12345, CDPLoopbackConfigured: true, CDPEndpointLive: true, DownloadDir: `C:\\fixture\\downloads`, DownloadDirExists: true, DownloadIsolationConfigured: true}
	report.Security = gate0evidence.Security{WebMessagesDisabled: true, HostObjectsDisabled: true, DevToolsUIDisabled: true, PasswordAutosaveDisabled: true, GeneralAutofillDisabled: true, PermissionDenyHandlerInstalled: true, NativeBridgeAbsentByConstruction: true}
	report.Operational = gate0evidence.OperationalReport{Schema: gate0evidence.OperationalSchema, Compliant: true}
	for _, id := range []string{"devtools_mcp_control", "multi_tab", "korean_ime_input", "per_monitor_v2_dpi", "tray_restore", "profile_persistence", "emergency_stop", "manual_resume_reobservation", "private_network_block", "dns_rebinding_block"} {
		report.Operational.Checks = append(report.Operational.Checks, gate0evidence.OperationalCheck{ID: id, Executed: true, Passed: true, ObservedAt: observedAt, Evidence: "actual fixture observation"})
	}
	raw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func readDetailsFixture(t *testing.T, receiptPath string) Details {
	t.Helper()
	raw, err := os.ReadFile(detailsPathForReceipt(receiptPath))
	if err != nil {
		t.Fatal(err)
	}
	var details Details
	if err := json.Unmarshal(raw, &details); err != nil {
		t.Fatal(err)
	}
	return details
}

func boundedObservation(value string) StreamObservation {
	stream := newBoundedStream(maxCapturedStreamBytes)
	_, _ = stream.Write([]byte(value))
	return stream.Observation()
}

func TestRemoveTemporaryGateRootRequiresExactPrefixAndRemovesTree(t *testing.T) {
	root, err := os.MkdirTemp("", "AetherOps-Local-Release-Evidence-")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "webview2", "internet"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "webview2", "internet", "profile.db"), []byte("test"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := removeTemporaryGateRoot(root); err != nil {
		t.Fatalf("remove validated local gate root: %v", err)
	}
	if _, err := os.Lstat(root); !os.IsNotExist(err) {
		t.Fatalf("local gate root still exists: %v", err)
	}
	if err := removeTemporaryGateRoot(t.TempDir()); err == nil {
		t.Fatal("unexpected temporary directory name was accepted")
	}
}

func containsArguments(arguments []string, expected ...string) bool {
	joined := strings.Join(arguments, "\x00")
	return strings.Contains(joined, strings.Join(expected, "\x00"))
}

func hasEnvironment(specification commandSpec, name, value string) bool {
	for _, item := range specification.Environment {
		if item.Name == name && item.Value == value {
			return true
		}
	}
	return false
}

func windowsPowerShellPath() (string, error) {
	_, _, path, err := validateSourceRoot()
	return path, err
}

func mustWorkingDirectory(t *testing.T) string {
	t.Helper()
	root, _, _, err := validateSourceRoot()
	if err != nil {
		t.Fatal(err)
	}
	return root
}
