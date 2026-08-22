//go:build windows

// Command packagedblackbox runs release-only crash and tamper checks against
// the exact packaged AetherOps executable. It never uses the operator's normal
// AetherOps data directory: every product launch uses the explicit,
// ownership-marked release-evaluation data-root contract.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/desktop"
	"github.com/djkim0320/Aether-claw/internal/processutil"
	"github.com/djkim0320/Aether-claw/internal/releasegate"
	managedruntime "github.com/djkim0320/Aether-claw/internal/runtime"
	"github.com/djkim0320/Aether-claw/internal/store"
	"golang.org/x/sys/windows"
)

const (
	fixtureExitCode             = 93
	curationValidationContract  = "aetherops-curation-validation-v1"
	runtimeSetIdentityDomain    = "aetherops-packaged-runtime-set-v1\x00"
	environmentIdentityDomain   = "aetherops-packaged-blackbox-environment-v1\x00"
	defaultScenarioTimeout      = 90 * time.Second
	postDatabaseCrashDelay      = 1500 * time.Millisecond
	idempotenceObservationDelay = 2 * time.Second
)

var managedComponents = []managedruntime.Component{
	managedruntime.ComponentNode,
	managedruntime.ComponentCodex,
	managedruntime.ComponentChromeDevtoolsMCP,
	managedruntime.ComponentOxigraph,
	managedruntime.ComponentOpenVSP,
	managedruntime.ComponentGmsh,
	managedruntime.ComponentXFOIL,
	managedruntime.ComponentSU2,
}

type options struct {
	Executable     string
	PreparedLedger string
	Output         string
	KeepTemp       bool
	Timeout        time.Duration
}

type runtimeSeal struct {
	ActiveSHA256 string
	SetSHA256    string
	TreeSHA256   map[string]string
}

type scenarioResult struct {
	ID      string         `json:"id"`
	Status  string         `json:"status"`
	Details map[string]any `json:"details"`
}

type environmentEvidence struct {
	OS                  string `json:"os"`
	Architecture        string `json:"architecture"`
	GoVersion           string `json:"go_version"`
	LogicalProcessors   int    `json:"logical_processors"`
	ProcessorIdentifier string `json:"processor_identifier,omitempty"`
	WindowsVersion      string `json:"windows_version"`
}

type receiptDetails struct {
	Schema                string              `json:"schema"`
	ReleaseCandidateID    string              `json:"release_candidate_id"`
	CandidateExecutable   string              `json:"candidate_executable"`
	Environment           environmentEvidence `json:"environment"`
	IsolatedDataOnly      bool                `json:"isolated_data_only"`
	TemporaryRootRetained bool                `json:"temporary_root_retained"`
	TemporaryRoot         string              `json:"temporary_root,omitempty"`
	FixtureRole           string              `json:"fixture_role"`
	Scenarios             []scenarioResult    `json:"scenarios"`
	EvidenceLimits        map[string]any      `json:"evidence_limits"`
}

type recoveryFixture struct {
	ReadOnlyRunID       string `json:"read_only_run_id"`
	ReadOnlyAttemptID   string `json:"read_only_attempt_id"`
	SideEffectRunID     string `json:"side_effect_run_id"`
	SideEffectAttemptID string `json:"side_effect_attempt_id"`
	ScratchProjectID    string `json:"scratch_project_id"`
	ScratchGenerationID string `json:"scratch_generation_id"`
	ReachableBlobHash   string `json:"reachable_blob_hash"`
	OrphanBlobHash      string `json:"orphan_blob_hash"`
	TemporaryCASPath    string `json:"temporary_cas_path"`
}

type recoveryObservation struct {
	ReadOnlyRunStatus        string
	ReadOnlyAttemptStatus    string
	ReadOnlyThreadID         string
	ReadOnlyTurnID           string
	SideEffectRunStatus      string
	SideEffectAttemptStatus  string
	SideEffectThreadID       string
	SideEffectTurnID         string
	SideEffectMarked         bool
	ScratchGenerationCount   int
	ReadOnlyAttemptCount     int
	SideEffectAttemptCount   int
	ReadOnlyRecoveryEvents   int
	SideEffectRecoveryEvents int
}

type normalCoreReadiness struct {
	Schema        string                        `json:"schema"`
	Endpoint      string                        `json:"endpoint"`
	TokenFile     string                        `json:"token_file"`
	PID           int                           `json:"pid"`
	Mode          string                        `json:"mode"`
	BuildMode     string                        `json:"build_mode"`
	ProductBuild  buildinfo.ProductBuildBinding `json:"product_build"`
	StartedAt     time.Time                     `json:"started_at"`
	RuntimeReady  bool                          `json:"runtime_set_ready"`
	CodexReady    bool                          `json:"codex_initialize_model_list_ready"`
	OxigraphReady bool                          `json:"oxigraph_handshake_ready"`
	APIReady      bool                          `json:"api_ready"`
}

func main() {
	if len(os.Args) == 4 && os.Args[1] == "-internal-seed-recovery" {
		if err := seedRecoveryFixture(os.Args[2], os.Args[3]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		// This is an intentional fixture crash. SQLite and its WAL are left open
		// so the packaged executable, rather than the fixture, owns recovery.
		os.Exit(fixtureExitCode)
	}
	if err := run(context.Background(), os.Args[1:]); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "packagedblackbox:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) (returnErr error) {
	flags := flag.NewFlagSet("packagedblackbox", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var configuration options
	flags.StringVar(&configuration.Executable, "aetherops-exe", filepath.Join("build", "aetherops.exe"), "exact packaged AetherOps executable")
	flags.StringVar(&configuration.PreparedLedger, "prepared-ledger", "", "current prepared release ledger bound to this evidence")
	flags.StringVar(&configuration.Output, "out", filepath.Join("build", "packaged-blackbox-receipt.json"), "new receipt path")
	flags.BoolVar(&configuration.KeepTemp, "keep-temp", false, "retain isolated fixture roots after the run")
	flags.DurationVar(&configuration.Timeout, "timeout", defaultScenarioTimeout, "timeout per packaged process launch")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	if configuration.Timeout < 10*time.Second || configuration.Timeout > 5*time.Minute {
		return errors.New("timeout must be between 10s and 5m")
	}
	if strings.TrimSpace(configuration.PreparedLedger) == "" {
		return errors.New("-prepared-ledger is required")
	}

	executable, manifestPath, sidecarEntrypoint, runtimeRoot, err := candidatePaths(configuration.Executable)
	if err != nil {
		return err
	}
	build, runtimeIdentity, err := sealCandidate(executable, manifestPath, sidecarEntrypoint, runtimeRoot)
	if err != nil {
		return fmt.Errorf("seal exact release candidate: %w", err)
	}
	releaseCandidateID, err := releasegate.CandidateID(build)
	if err != nil {
		return err
	}
	preparedLedgerSHA256, err := bindPreparedLedger(configuration.PreparedLedger, build, "packaged_blackbox")
	if err != nil {
		return err
	}
	subjectHashes := map[string]string{
		"aetherops.exe":                 build.ExecutableSHA256,
		"runtime-manifest.json":         build.RuntimeManifestSHA256,
		"knowledge-sidecar-tree":        build.KnowledgeSidecarTreeSHA256,
		"prepared-ledger":               preparedLedgerSHA256,
		"runtime_active_pointer_sha256": runtimeIdentity.ActiveSHA256,
		"verified_runtime_set_sha256":   runtimeIdentity.SetSHA256,
	}
	for component, digest := range runtimeIdentity.TreeSHA256 {
		subjectHashes["runtime_tree_"+strings.ReplaceAll(component, "-", "_")+"_sha256"] = digest
	}

	temporaryRoot, err := os.MkdirTemp(filepath.Dir(executable), ".packaged-blackbox-run-*")
	if err != nil {
		return fmt.Errorf("create isolated black-box root: %w", err)
	}
	cleanup := true
	defer func() {
		if cleanup {
			returnErr = errors.Join(returnErr, removeBlackboxTemporary(temporaryRoot, filepath.Dir(executable)))
		}
	}()
	if !sameVolume(temporaryRoot, executable) {
		return errors.New("black-box temporary root must be on the candidate volume")
	}

	results := make([]scenarioResult, 0, 4)
	var campaignErr error
	crashResult, databaseHash, crashErr := runCrashRecoveryScenario(ctx, executable, temporaryRoot, configuration.Timeout)
	if crashErr != nil {
		campaignErr = errors.Join(campaignErr, crashErr)
		results = append(results, scenarioResult{ID: "forced_termination_recovery", Status: "failed", Details: map[string]any{"error": crashErr.Error()}})
	} else {
		results = append(results, crashResult)
		subjectHashes["recovered_database_sha256"] = databaseHash
	}

	tamperResult, tamperHashes, tamperErr := runTamperScenario(ctx, executable, build, temporaryRoot, configuration.Timeout)
	if tamperErr != nil {
		campaignErr = errors.Join(campaignErr, tamperErr)
		results = append(results, scenarioResult{ID: "runtime_and_sidecar_tamper", Status: "failed", Details: map[string]any{"error": tamperErr.Error()}})
	} else {
		results = append(results, tamperResult)
		for label, digest := range tamperHashes {
			subjectHashes[label] = digest
		}
	}
	finalBuild, finalRuntimeIdentity, stabilityErr := sealCandidate(executable, manifestPath, sidecarEntrypoint, runtimeRoot)
	if stabilityErr != nil || finalBuild != build || !sameRuntimeSeal(finalRuntimeIdentity, runtimeIdentity) {
		if stabilityErr == nil {
			stabilityErr = errors.New("candidate identity changed during the black-box campaign")
		}
		results = append(results, scenarioResult{
			ID: "candidate_stability", Status: "failed",
			Details: map[string]any{"error": stabilityErr.Error()},
		})
		campaignErr = errors.Join(campaignErr, stabilityErr)
	} else {
		results = append(results, scenarioResult{
			ID: "candidate_stability", Status: "passed",
			Details: map[string]any{"candidate_reauthenticated_after_campaign": true},
		})
	}
	if configuration.KeepTemp {
		results = append(results, scenarioResult{
			ID: "isolated_fixture_cleanup", Status: "failed",
			Details: map[string]any{"retained_for_diagnostics": true},
		})
		campaignErr = errors.Join(campaignErr, errors.New("-keep-temp evidence is diagnostic-only and cannot pass the release gate"))
		cleanup = false
	} else if cleanupErr := removeBlackboxTemporary(temporaryRoot, filepath.Dir(executable)); cleanupErr != nil {
		results = append(results, scenarioResult{
			ID: "isolated_fixture_cleanup", Status: "failed",
			Details: map[string]any{"error": cleanupErr.Error()},
		})
		campaignErr = errors.Join(campaignErr, cleanupErr)
	} else {
		cleanup = false
		results = append(results, scenarioResult{
			ID: "isolated_fixture_cleanup", Status: "passed",
			Details: map[string]any{"temporary_root_removed": true},
		})
	}

	allPassed := true
	for _, result := range results {
		allPassed = allPassed && result.Status == "passed"
	}
	status := "failed"
	if allPassed {
		status = "passed"
	}
	environment := currentEnvironment()
	if windows.RtlGetVersion().BuildNumber < 22000 {
		return fmt.Errorf("packaged black-box requires Windows 11, found %s", environment.WindowsVersion)
	}
	details := receiptDetails{
		Schema: "aetherops_packaged_blackbox_details_v1", ReleaseCandidateID: releaseCandidateID,
		CandidateExecutable: executable, Environment: environment, IsolatedDataOnly: true,
		TemporaryRootRetained: configuration.KeepTemp,
		FixtureRole:           "The helper only seeds failure/restart state and exits abruptly; it is never counted as a successful service path.",
		Scenarios:             results,
		EvidenceLimits: map[string]any{
			"packaged_blackbox_gate_eligible": allPassed,
			"external_gate_eligible":          false,
			"proves":                          []string{"local_packaged_executable", "crash_recovery", "runtime_tamper_rejection", "sidecar_prelaunch_identity_rejection"},
			"does_not_prove":                  []string{"live_service", "clean_vm", "incompatible_hardware", "production_signed_feed"},
		},
	}
	if configuration.KeepTemp {
		cleanup = false
		details.TemporaryRoot = temporaryRoot
	}
	currentLedgerSHA256, err := bindPreparedLedger(configuration.PreparedLedger, build, "packaged_blackbox")
	if err != nil {
		return fmt.Errorf("reauthenticate prepared ledger after black-box campaign: %w", err)
	}
	if currentLedgerSHA256 != preparedLedgerSHA256 {
		return errors.New("prepared ledger changed during the black-box campaign")
	}
	detailsPath := detailsPathForReceipt(configuration.Output)
	detailsRaw, err := json.MarshalIndent(details, "", "  ")
	if err != nil {
		return err
	}
	detailsRaw = append(detailsRaw, '\n')
	detailsDigest := sha256.Sum256(detailsRaw)
	detailsSHA256 := hex.EncodeToString(detailsDigest[:])
	if err := writeBytesNew(detailsPath, detailsRaw); err != nil {
		return fmt.Errorf("write packaged black-box details: %w", err)
	}
	subjectHashes["packaged-blackbox-details"] = detailsSHA256
	environmentSHA256, err := environmentIdentity(environment)
	if err != nil {
		return err
	}
	record := releasegate.EvidenceReceipt{
		Schema: releasegate.EvidenceSchemaV1, GateID: "packaged_blackbox",
		EvidenceKind:       releasegate.EvidencePackagedBlackbox,
		ReleaseCandidateID: releaseCandidateID, ProductBuild: build,
		Producer: releasegate.Producer{Name: "cmd/packagedblackbox", Version: "1"},
		Environment: releasegate.Environment{
			Class: string(releasegate.EvidencePackagedBlackbox), OS: "windows-11",
			Architecture: runtime.GOARCH, IdentitySHA256: environmentSHA256,
		},
		ObservedAt: time.Now().UTC(), Status: status,
		SubjectHashes: subjectHashList(subjectHashes), DetailsPath: filepath.Base(detailsPath), DetailsSHA256: detailsSHA256,
	}
	if err := record.Validate(); err != nil {
		return fmt.Errorf("validate packaged black-box evidence: %w", err)
	}
	finalLedgerSHA256, err := bindPreparedLedger(configuration.PreparedLedger, build, "packaged_blackbox")
	if err != nil {
		return fmt.Errorf("reauthenticate prepared ledger before evidence emission: %w", err)
	}
	if finalLedgerSHA256 != preparedLedgerSHA256 {
		return errors.New("prepared ledger changed before black-box evidence emission")
	}
	if err := writeJSONNew(configuration.Output, record); err != nil {
		return err
	}
	if !allPassed {
		return fmt.Errorf("one or more packaged black-box scenarios failed: %w", campaignErr)
	}
	fmt.Printf("packaged black-box evidence passed; receipt=%s details=%s candidate=%s\n", configuration.Output, detailsPath, releaseCandidateID)
	return nil
}

func bindPreparedLedger(path string, build buildinfo.ProductBuildBinding, gateID string) (string, error) {
	ledgerPath := strings.TrimSpace(path)
	if ledgerPath == "" {
		return "", errors.New("prepared ledger path is required")
	}
	ledger, digest, err := releasegate.LoadLedgerChain(ledgerPath)
	if err != nil {
		return "", fmt.Errorf("load current prepared ledger: %w", err)
	}
	if ledger.ProductBuild != build {
		return "", errors.New("prepared ledger is bound to a different product build")
	}
	if ledger.PreparedAt.After(time.Now().UTC()) {
		return "", errors.New("prepared ledger timestamp is in the future")
	}
	found := false
	for _, reference := range ledger.Evidence {
		if reference.GateID != gateID {
			continue
		}
		found = true
		if reference.ReceiptPath != "" || reference.ReceiptSHA256 != "" {
			return "", fmt.Errorf("prepared ledger already contains immutable evidence for %q", gateID)
		}
	}
	if !found {
		return "", fmt.Errorf("prepared ledger omits required gate %q", gateID)
	}
	return digest, nil
}

func candidatePaths(executablePath string) (string, string, string, string, error) {
	executable, err := filepath.Abs(strings.TrimSpace(executablePath))
	if err != nil || strings.TrimSpace(executablePath) == "" {
		return "", "", "", "", errors.New("candidate executable path is required")
	}
	info, err := os.Lstat(executable)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", "", "", "", errors.New("candidate executable is not a regular file")
	}
	directory := filepath.Dir(executable)
	return executable,
		filepath.Join(directory, "runtime-manifest.json"),
		filepath.Join(directory, "knowledge-sidecar", "index.cjs"),
		filepath.Join(directory, "runtime"), nil
}

func sealCandidate(executable, manifestPath, sidecarEntrypoint, runtimeRoot string) (buildinfo.ProductBuildBinding, runtimeSeal, error) {
	build, err := buildinfo.BindProductBuild(executable, manifestPath, sidecarEntrypoint)
	if err != nil {
		return buildinfo.ProductBuildBinding{}, runtimeSeal{}, err
	}
	manifest, err := managedruntime.LoadManifest(manifestPath)
	if err != nil {
		return buildinfo.ProductBuildBinding{}, runtimeSeal{}, err
	}
	if _, err := managedruntime.ResolveProcessPathsReadOnly(runtimeRoot, manifest); err != nil {
		return buildinfo.ProductBuildBinding{}, runtimeSeal{}, fmt.Errorf("authenticate packaged runtime: %w", err)
	}
	identity, err := sealRuntimeSet(runtimeRoot)
	if err != nil {
		return buildinfo.ProductBuildBinding{}, runtimeSeal{}, err
	}
	return build, identity, nil
}

func sealRuntimeSet(root string) (runtimeSeal, error) {
	activePath := filepath.Join(root, "active.json")
	activeHash, err := hashRegularFile(activePath)
	if err != nil {
		return runtimeSeal{}, err
	}
	var active managedruntime.ActiveState
	if err := decodeJSONFile(activePath, &active); err != nil {
		return runtimeSeal{}, err
	}
	outer := sha256.New()
	_, _ = io.WriteString(outer, runtimeSetIdentityDomain)
	_, _ = io.WriteString(outer, activeHash)
	trees := make(map[string]string, len(managedComponents))
	components := append([]managedruntime.Component(nil), managedComponents...)
	sort.Slice(components, func(i, j int) bool { return components[i] < components[j] })
	rootAbsolute, err := filepath.Abs(root)
	if err != nil {
		return runtimeSeal{}, err
	}
	rootPrefix := filepath.Clean(rootAbsolute) + string(os.PathSeparator)
	for _, component := range components {
		version, ok := active.Versions[component]
		if !ok || strings.TrimSpace(version) == "" {
			return runtimeSeal{}, fmt.Errorf("active runtime omits %s", component)
		}
		componentRoot := filepath.Join(rootAbsolute, "versions", string(component), version)
		if relative, present := active.ComponentRoots[component]; present {
			if filepath.IsAbs(relative) || strings.Contains(filepath.ToSlash(relative), "../") {
				return runtimeSeal{}, fmt.Errorf("unsafe runtime root for %s", component)
			}
			componentRoot = filepath.Join(rootAbsolute, filepath.FromSlash(relative))
		}
		componentRoot, err = filepath.Abs(componentRoot)
		if err != nil || !strings.HasPrefix(filepath.Clean(componentRoot)+string(os.PathSeparator), rootPrefix) {
			return runtimeSeal{}, fmt.Errorf("runtime root escaped candidate for %s", component)
		}
		var metadata managedruntime.VersionMetadata
		if err := decodeJSONFile(filepath.Join(componentRoot, "runtime.json"), &metadata); err != nil {
			return runtimeSeal{}, err
		}
		if metadata.Component != component || metadata.Version != version || len(metadata.TreeSHA256) != sha256.Size*2 {
			return runtimeSeal{}, fmt.Errorf("runtime metadata identity mismatch for %s", component)
		}
		trees[string(component)] = metadata.TreeSHA256
		_, _ = io.WriteString(outer, "\x00"+string(component)+"\x00"+version+"\x00"+metadata.TreeSHA256)
	}
	return runtimeSeal{ActiveSHA256: activeHash, SetSHA256: hex.EncodeToString(outer.Sum(nil)), TreeSHA256: trees}, nil
}

func runCrashRecoveryScenario(ctx context.Context, executable, root string, timeout time.Duration) (scenarioResult, string, error) {
	dataRoot := filepath.Join(root, "recovery-data")
	if err := os.MkdirAll(dataRoot, 0o700); err != nil {
		return scenarioResult{}, "", err
	}

	firstCtx, cancel := context.WithTimeout(ctx, timeout)
	err := launchUntil(firstCtx, executable, []string{"app"}, dataRoot, func() (bool, error) {
		info, statErr := os.Stat(filepath.Join(dataRoot, "aetherops.db"))
		return statErr == nil && info.Mode().IsRegular() && info.Size() > 0, nil
	}, postDatabaseCrashDelay)
	cancel()
	if err != nil {
		return scenarioResult{}, "", fmt.Errorf("force-terminate packaged executable after SQLite initialization: %w", err)
	}
	databasePath := filepath.Join(dataRoot, "aetherops.db")
	crashDatabase, err := store.OpenReadOnly(ctx, databasePath)
	if err != nil {
		return scenarioResult{}, "", fmt.Errorf("read crash-left packaged database: %w", err)
	}
	if err := crashDatabase.Close(); err != nil {
		return scenarioResult{}, "", fmt.Errorf("close crash-left packaged database: %w", err)
	}

	fixturePath := filepath.Join(root, "recovery-fixture.json")
	if err := runSeedHelper(dataRoot, fixturePath); err != nil {
		return scenarioResult{}, "", err
	}
	var fixture recoveryFixture
	if err := decodeJSONFile(fixturePath, &fixture); err != nil {
		return scenarioResult{}, "", err
	}
	walBefore, _ := fileSize(databasePath + "-wal")
	if walBefore <= 0 {
		return scenarioResult{}, "", errors.New("intentional fixture crash did not leave a WAL to recover")
	}

	recoveryCtx, cancelRecovery := context.WithTimeout(ctx, timeout)
	err = launchUntil(recoveryCtx, executable, []string{"app"}, dataRoot, func() (bool, error) {
		observation, observeErr := observeRecovery(recoveryCtx, databasePath, fixture)
		if observeErr != nil {
			return false, nil
		}
		return recoveryComplete(observation, fixture, dataRoot), nil
	}, 250*time.Millisecond)
	cancelRecovery()
	if err != nil {
		return scenarioResult{}, "", fmt.Errorf("packaged recovery launch: %w", err)
	}

	observation, err := observeRecovery(ctx, databasePath, fixture)
	if err != nil {
		return scenarioResult{}, "", err
	}
	if !recoveryComplete(observation, fixture, dataRoot) {
		return scenarioResult{}, "", fmt.Errorf("packaged recovery did not reach its fail-closed state: %+v", observation)
	}
	objects, err := cas.OpenReadOnly(filepath.Join(dataRoot, "objects"))
	if err != nil {
		return scenarioResult{}, "", err
	}
	if _, err := objects.ReadVerified(fixture.ReachableBlobHash); err != nil {
		return scenarioResult{}, "", fmt.Errorf("recovery removed reachable CAS input: %w", err)
	}
	if _, err := objects.Path(fixture.OrphanBlobHash); !errors.Is(err, os.ErrNotExist) {
		return scenarioResult{}, "", fmt.Errorf("orphaned CAS object survived packaged startup: %v", err)
	}

	idempotenceCtx, cancelIdempotence := context.WithTimeout(ctx, timeout)
	resetMarker := filepath.Join(dataRoot, "reset-internet-profile.pending")
	if err := writeDurableFileNew(resetMarker, []byte("AETHEROPS_RESET_INTERNET_PROFILE_V1\n")); err != nil {
		cancelIdempotence()
		return scenarioResult{}, "", err
	}
	err = launchUntil(idempotenceCtx, executable, []string{"app"}, dataRoot, func() (bool, error) {
		return fileMissing(resetMarker), nil
	}, idempotenceObservationDelay)
	cancelIdempotence()
	if err != nil {
		return scenarioResult{}, "", fmt.Errorf("second packaged recovery launch: %w", err)
	}
	second, err := observeRecovery(ctx, databasePath, fixture)
	if err != nil {
		return scenarioResult{}, "", err
	}
	if second != observation {
		return scenarioResult{}, "", fmt.Errorf("packaged recovery was not idempotent: first=%+v second=%+v", observation, second)
	}
	checkpointBusy, checkpointLogFrames, checkpointedFrames, err := checkpointIsolatedDatabase(ctx, databasePath)
	if err != nil {
		return scenarioResult{}, "", err
	}
	if checkpointBusy != 0 || checkpointLogFrames != checkpointedFrames {
		return scenarioResult{}, "", fmt.Errorf("isolated WAL checkpoint was incomplete: busy=%d log=%d checkpointed=%d", checkpointBusy, checkpointLogFrames, checkpointedFrames)
	}
	walAfterCheckpoint, existsAfterCheckpoint := fileSize(databasePath + "-wal")
	if existsAfterCheckpoint && walAfterCheckpoint != 0 {
		return scenarioResult{}, "", fmt.Errorf("isolated WAL remained %d bytes after truncate checkpoint", walAfterCheckpoint)
	}
	verifiedDatabase, err := store.OpenReadOnly(ctx, databasePath)
	if err != nil {
		return scenarioResult{}, "", fmt.Errorf("verify checkpointed isolated database: %w", err)
	}
	if err := verifiedDatabase.Close(); err != nil {
		return scenarioResult{}, "", err
	}
	databaseHash, err := hashRegularFile(databasePath)
	if err != nil {
		return scenarioResult{}, "", err
	}
	walAfter, _ := fileSize(databasePath + "-wal")
	return scenarioResult{
		ID: "forced_termination_recovery", Status: "passed",
		Details: map[string]any{
			"actual_executable_forcibly_terminated":   true,
			"fixture_process_exit_code":               fixtureExitCode,
			"wal_bytes_before_packaged_recovery":      walBefore,
			"wal_bytes_after_idempotence_launch":      walAfter,
			"wal_checkpoint_executor":                 "release_harness_after_packaged_process_exit",
			"wal_checkpoint_busy":                     checkpointBusy,
			"wal_checkpoint_log_frames":               checkpointLogFrames,
			"wal_checkpointed_frames":                 checkpointedFrames,
			"wal_bytes_after_truncate_checkpoint":     walAfterCheckpoint,
			"database_integrity":                      "ok",
			"read_only_run_status":                    observation.ReadOnlyRunStatus,
			"side_effect_run_status":                  observation.SideEffectRunStatus,
			"external_thread_turn_identity_preserved": true,
			"duplicate_stage_attempts":                0,
			"duplicate_recovery_events":               0,
			"incomplete_curation_generation_removed":  true,
			"orphaned_and_temporary_cas_removed":      true,
			"reachable_cas_readback_verified":         true,
			"second_start_state_unchanged":            true,
			"second_start_crossed_reset_checkpoint":   true,
		},
	}, databaseHash, nil
}

func checkpointIsolatedDatabase(ctx context.Context, databasePath string) (int, int, int, error) {
	database, err := store.Open(ctx, databasePath)
	if err != nil {
		return 0, 0, 0, err
	}
	var busy, logFrames, checkpointedFrames int
	if err := database.SQL().QueryRowContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)").Scan(
		&busy, &logFrames, &checkpointedFrames,
	); err != nil {
		_ = database.Close()
		return 0, 0, 0, err
	}
	if err := database.Close(); err != nil {
		return 0, 0, 0, err
	}
	return busy, logFrames, checkpointedFrames, nil
}

func runSeedHelper(dataRoot, fixturePath string) error {
	command := exec.Command(os.Args[0], "-internal-seed-recovery", dataRoot, fixturePath)
	processutil.ConfigureNoWindow(command)
	output, err := command.CombinedOutput()
	exitError, ok := err.(*exec.ExitError)
	if !ok || exitError.ExitCode() != fixtureExitCode {
		return fmt.Errorf("recovery fixture crash exit=%v output=%s", err, truncate(output, 4096))
	}
	return nil
}

func seedRecoveryFixture(dataRoot, fixturePath string) error {
	ctx := context.Background()
	database, err := store.Open(ctx, filepath.Join(dataRoot, "aetherops.db"))
	if err != nil {
		return err
	}
	objects, err := cas.Open(filepath.Join(dataRoot, "objects"))
	if err != nil {
		return err
	}
	reachable, err := objects.PutBytes([]byte("packaged black-box reachable stage input"))
	if err != nil {
		return err
	}
	if err := database.RegisterBlob(ctx, reachable, "application/octet-stream"); err != nil {
		return err
	}
	orphan, err := objects.PutBytes([]byte("packaged black-box orphan to reconcile"))
	if err != nil {
		return err
	}
	temporary := filepath.Join(dataRoot, "objects", "tmp", "blackbox-interrupted-write")
	if err := writeDurableFileNew(temporary, []byte("incomplete CAS temporary write")); err != nil {
		return err
	}

	createInFlight := func(name, thread, turn string, external bool) (core.Run, core.StageAttempt, error) {
		project, err := database.CreateProject(ctx, name)
		if err != nil {
			return core.Run{}, core.StageAttempt{}, err
		}
		if err := database.SetProjectMainThread(ctx, project.ID, thread); err != nil {
			return core.Run{}, core.StageAttempt{}, err
		}
		run, err := database.CreateRun(ctx, project.ID, "", "packaged forced termination", thread)
		if err != nil {
			return core.Run{}, core.StageAttempt{}, err
		}
		run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
		if err != nil {
			return core.Run{}, core.StageAttempt{}, err
		}
		attempt, err := database.BeginStage(ctx, run.ID, core.StagePlan, 0, thread, reachable.Hash)
		if err != nil {
			return core.Run{}, core.StageAttempt{}, err
		}
		if err := database.SetStageTurn(ctx, attempt.ID, thread, turn); err != nil {
			return core.Run{}, core.StageAttempt{}, err
		}
		if external {
			if err := database.MarkStageExternalSideEffects(ctx, attempt.ID); err != nil {
				return core.Run{}, core.StageAttempt{}, err
			}
		}
		return run, attempt, nil
	}
	readOnlyRun, readOnlyAttempt, err := createInFlight("blackbox read-only", "thread-read-only", "turn-read-only", false)
	if err != nil {
		return err
	}
	sideEffectRun, sideEffectAttempt, err := createInFlight("blackbox side-effect", "thread-side-effect", "turn-side-effect", true)
	if err != nil {
		return err
	}

	scratchProject, err := database.CreateProject(ctx, "blackbox interrupted curation")
	if err != nil {
		return err
	}
	contract := sha256.Sum256([]byte(curationValidationContract))
	scratch, err := database.CreateKnowledgeGeneration(ctx, scratchProject.ID, store.CoreOntologyID, hex.EncodeToString(contract[:]))
	if err != nil {
		return err
	}
	fixture := recoveryFixture{
		ReadOnlyRunID: readOnlyRun.ID, ReadOnlyAttemptID: readOnlyAttempt.ID,
		SideEffectRunID: sideEffectRun.ID, SideEffectAttemptID: sideEffectAttempt.ID,
		ScratchProjectID: scratchProject.ID, ScratchGenerationID: scratch.ID,
		ReachableBlobHash: reachable.Hash, OrphanBlobHash: orphan.Hash, TemporaryCASPath: temporary,
	}
	return writeJSONNew(fixturePath, fixture)
}

func observeRecovery(ctx context.Context, databasePath string, fixture recoveryFixture) (recoveryObservation, error) {
	database, err := store.OpenReadOnly(ctx, databasePath)
	if err != nil {
		return recoveryObservation{}, err
	}
	defer database.Close()
	var observed recoveryObservation
	if err := database.SQL().QueryRowContext(ctx, "SELECT status FROM runs WHERE id=?", fixture.ReadOnlyRunID).Scan(&observed.ReadOnlyRunStatus); err != nil {
		return recoveryObservation{}, err
	}
	if err := database.SQL().QueryRowContext(ctx, "SELECT status,codex_thread_id,codex_turn_id FROM stage_attempts WHERE id=?", fixture.ReadOnlyAttemptID).Scan(
		&observed.ReadOnlyAttemptStatus, &observed.ReadOnlyThreadID, &observed.ReadOnlyTurnID); err != nil {
		return recoveryObservation{}, err
	}
	if err := database.SQL().QueryRowContext(ctx, "SELECT status FROM runs WHERE id=?", fixture.SideEffectRunID).Scan(&observed.SideEffectRunStatus); err != nil {
		return recoveryObservation{}, err
	}
	if err := database.SQL().QueryRowContext(ctx, "SELECT status,codex_thread_id,codex_turn_id,external_side_effects FROM stage_attempts WHERE id=?", fixture.SideEffectAttemptID).Scan(
		&observed.SideEffectAttemptStatus, &observed.SideEffectThreadID, &observed.SideEffectTurnID, &observed.SideEffectMarked); err != nil {
		return recoveryObservation{}, err
	}
	queries := []struct {
		query string
		args  []any
		dest  *int
	}{
		{"SELECT COUNT(*) FROM knowledge_generations WHERE project_id=? AND id=?", []any{fixture.ScratchProjectID, fixture.ScratchGenerationID}, &observed.ScratchGenerationCount},
		{"SELECT COUNT(*) FROM stage_attempts WHERE run_id=?", []any{fixture.ReadOnlyRunID}, &observed.ReadOnlyAttemptCount},
		{"SELECT COUNT(*) FROM stage_attempts WHERE run_id=?", []any{fixture.SideEffectRunID}, &observed.SideEffectAttemptCount},
		{"SELECT COUNT(*) FROM run_events WHERE run_id=? AND kind='run.recovered'", []any{fixture.ReadOnlyRunID}, &observed.ReadOnlyRecoveryEvents},
		{"SELECT COUNT(*) FROM run_events WHERE run_id=? AND kind='run.recovered'", []any{fixture.SideEffectRunID}, &observed.SideEffectRecoveryEvents},
	}
	for _, query := range queries {
		if err := database.SQL().QueryRowContext(ctx, query.query, query.args...).Scan(query.dest); err != nil {
			return recoveryObservation{}, err
		}
	}
	return observed, nil
}

func recoveryComplete(observed recoveryObservation, fixture recoveryFixture, dataRoot string) bool {
	return observed.ReadOnlyRunStatus == string(core.RunInterrupted) &&
		observed.ReadOnlyAttemptStatus == string(core.RunInterrupted) &&
		observed.ReadOnlyThreadID == "thread-read-only" && observed.ReadOnlyTurnID == "turn-read-only" &&
		observed.SideEffectRunStatus == string(core.RunUncertain) &&
		observed.SideEffectAttemptStatus == string(core.RunUncertain) && observed.SideEffectMarked &&
		observed.SideEffectThreadID == "thread-side-effect" && observed.SideEffectTurnID == "turn-side-effect" &&
		observed.ScratchGenerationCount == 0 && observed.ReadOnlyAttemptCount == 1 && observed.SideEffectAttemptCount == 1 &&
		observed.ReadOnlyRecoveryEvents == 1 && observed.SideEffectRecoveryEvents == 1 &&
		fileMissing(fixture.TemporaryCASPath) &&
		fileMissing(filepath.Join(dataRoot, "objects", "sha256", fixture.OrphanBlobHash[:2], fixture.OrphanBlobHash))
}

func runTamperScenario(ctx context.Context, executable string, expected buildinfo.ProductBuildBinding, root string, timeout time.Duration) (scenarioResult, map[string]string, error) {
	candidateDirectory := filepath.Dir(executable)
	tamperedRoot := filepath.Join(root, "tampered-package")
	if err := os.Mkdir(tamperedRoot, 0o700); err != nil {
		return scenarioResult{}, nil, err
	}
	for _, relative := range []string{"aetherops.exe", "runtime-manifest.json"} {
		if err := copyRegularFile(filepath.Join(candidateDirectory, relative), filepath.Join(tamperedRoot, relative)); err != nil {
			return scenarioResult{}, nil, err
		}
	}
	for _, name := range []string{"index.cjs", "protocol.cjs", "worker.cjs"} {
		target := filepath.Join(tamperedRoot, "knowledge-sidecar", name)
		if err := copyRegularFile(filepath.Join(candidateDirectory, "knowledge-sidecar", name), target); err != nil {
			return scenarioResult{}, nil, err
		}
	}
	if err := mirrorTreeWithHardlinks(filepath.Join(candidateDirectory, "runtime"), filepath.Join(tamperedRoot, "runtime")); err != nil {
		return scenarioResult{}, nil, fmt.Errorf("mirror runtime for isolated tamper: %w", err)
	}

	originalRuntime := filepath.Join(candidateDirectory, "runtime", "versions", "oxigraph", managedruntime.PinnedOxigraphVersion, "node_modules", "oxigraph", "package.json")
	tamperedRuntime := filepath.Join(tamperedRoot, "runtime", "versions", "oxigraph", managedruntime.PinnedOxigraphVersion, "node_modules", "oxigraph", "package.json")
	originalRuntimeHash, err := hashRegularFile(originalRuntime)
	if err != nil {
		return scenarioResult{}, nil, err
	}
	if err := detachAndAppend(tamperedRuntime, []byte("\n ")); err != nil {
		return scenarioResult{}, nil, err
	}
	mutatedRuntimeHash, err := hashRegularFile(tamperedRuntime)
	if err != nil || mutatedRuntimeHash == originalRuntimeHash {
		return scenarioResult{}, nil, errors.New("runtime tamper did not change the isolated file hash")
	}
	if after, hashErr := hashRegularFile(originalRuntime); hashErr != nil || after != originalRuntimeHash {
		return scenarioResult{}, nil, errors.New("isolated runtime tamper changed the source candidate")
	}
	tamperData := filepath.Join(root, "tamper-data")
	commandCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	output, exitCode, runErr := launchToExit(commandCtx, filepath.Join(tamperedRoot, "aetherops.exe"), []string{"app"}, tamperData)
	if runErr == nil || exitCode == 0 {
		return scenarioResult{}, nil, errors.New("tampered packaged runtime was launched")
	}
	if !strings.Contains(strings.ToLower(string(output)), "content hash mismatch") {
		return scenarioResult{}, nil, fmt.Errorf("tampered runtime failed for an unexpected reason: %s", truncate(output, 4096))
	}

	tamperedSidecar := filepath.Join(tamperedRoot, "knowledge-sidecar", "protocol.cjs")
	originalSidecarHash, err := hashRegularFile(tamperedSidecar)
	if err != nil {
		return scenarioResult{}, nil, err
	}
	if err := detachAndAppend(tamperedSidecar, []byte("\n// packaged black-box tamper\n")); err != nil {
		return scenarioResult{}, nil, err
	}
	mutatedSidecarHash, err := hashRegularFile(tamperedSidecar)
	if err != nil || mutatedSidecarHash == originalSidecarHash {
		return scenarioResult{}, nil, errors.New("sidecar tamper did not change the isolated file hash")
	}
	actual, err := buildinfo.BindProductBuild(
		filepath.Join(tamperedRoot, "aetherops.exe"), filepath.Join(tamperedRoot, "runtime-manifest.json"),
		filepath.Join(tamperedRoot, "knowledge-sidecar", "index.cjs"),
	)
	if err != nil {
		return scenarioResult{}, nil, err
	}
	if err := requireCandidateIdentity(expected, actual); err == nil {
		return scenarioResult{}, nil, errors.New("tampered sidecar retained the sealed candidate identity")
	}
	return scenarioResult{
			ID: "runtime_and_sidecar_tamper", Status: "passed",
			Details: map[string]any{
				"runtime_actual_executable_exit_code":            exitCode,
				"runtime_launch_blocked":                         true,
				"runtime_failure_contains_content_hash_mismatch": true,
				"sidecar_launch_attempted":                       false,
				"sidecar_prelaunch_candidate_identity_rejected":  true,
				"source_candidate_unchanged":                     true,
			},
		}, map[string]string{
			"tamper_runtime_original_sha256": originalRuntimeHash,
			"tamper_runtime_mutated_sha256":  mutatedRuntimeHash,
			"tamper_sidecar_original_sha256": originalSidecarHash,
			"tamper_sidecar_mutated_sha256":  mutatedSidecarHash,
		}, nil
}

func requireCandidateIdentity(expected, actual buildinfo.ProductBuildBinding) error {
	if expected != actual {
		return errors.New("candidate product-build identity mismatch")
	}
	return nil
}

func launchUntil(ctx context.Context, executable string, arguments []string, dataRoot string, ready func() (bool, error), afterReady time.Duration) error {
	if err := ensureIsolatedDataRoot(dataRoot); err != nil {
		return err
	}
	supervisor, err := desktop.NewProcessSupervisor()
	if err != nil {
		return err
	}
	defer supervisor.Close()
	launchArguments, descriptorPath, err := releaseEvaluationArguments(arguments, dataRoot)
	if err != nil {
		return err
	}
	var expectedBuild buildinfo.ProductBuildBinding
	if descriptorPath != "" {
		executableRoot := filepath.Dir(executable)
		expectedBuild, err = buildinfo.BindProductBuild(
			executable, filepath.Join(executableRoot, "runtime-manifest.json"),
			filepath.Join(executableRoot, "knowledge-sidecar", "index.cjs"),
		)
		if err != nil {
			return fmt.Errorf("bind packaged readiness identity: %w", err)
		}
	}
	command := exec.Command(executable, launchArguments...)
	command.Env = isolatedEnvironment()
	processutil.ConfigureNoWindow(command)
	var output limitedBuffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Start(); err != nil {
		return err
	}
	if err := supervisor.Assign(command.Process.Pid); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		return err
	}
	exited := make(chan error, 1)
	go func() { exited <- command.Wait() }()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = command.Process.Kill()
			<-exited
			return fmt.Errorf("timed out: %w; output=%s", ctx.Err(), output.String())
		case waitErr := <-exited:
			return fmt.Errorf("candidate exited before observation: %v; output=%s", waitErr, output.String())
		case <-ticker.C:
			if descriptorPath != "" {
				readiness, readErr := readNormalCoreReadiness(descriptorPath, expectedBuild)
				if errors.Is(readErr, os.ErrNotExist) {
					continue
				}
				if readErr != nil {
					_ = command.Process.Kill()
					<-exited
					return readErr
				}
				if readiness.ProductBuild.ExecutableSHA256 == "" {
					continue
				}
			}
			ok, observeErr := ready()
			if observeErr != nil {
				_ = command.Process.Kill()
				<-exited
				return observeErr
			}
			if !ok {
				continue
			}
			timer := time.NewTimer(afterReady)
			select {
			case <-ctx.Done():
				timer.Stop()
				_ = command.Process.Kill()
				<-exited
				return ctx.Err()
			case waitErr := <-exited:
				timer.Stop()
				return fmt.Errorf("candidate exited before forced boundary: %v; output=%s", waitErr, output.String())
			case <-timer.C:
			}
			if err := command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				return err
			}
			<-exited
			return nil
		}
	}
}

func launchToExit(ctx context.Context, executable string, arguments []string, dataRoot string) ([]byte, int, error) {
	if err := ensureIsolatedDataRoot(dataRoot); err != nil {
		return nil, -1, err
	}
	supervisor, err := desktop.NewProcessSupervisor()
	if err != nil {
		return nil, -1, err
	}
	defer supervisor.Close()
	launchArguments, _, err := releaseEvaluationArguments(arguments, dataRoot)
	if err != nil {
		return nil, -1, err
	}
	command := exec.CommandContext(ctx, executable, launchArguments...)
	command.Env = isolatedEnvironment()
	processutil.ConfigureNoWindow(command)
	var output limitedBuffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Start(); err != nil {
		return nil, -1, err
	}
	if err := supervisor.Assign(command.Process.Pid); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		return nil, -1, err
	}
	err = command.Wait()
	exitCode := 0
	if err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			exitCode = exitError.ExitCode()
		} else {
			exitCode = -1
		}
	}
	return output.Bytes(), exitCode, err
}

func ensureIsolatedDataRoot(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil || strings.TrimSpace(path) == "" {
		return errors.New("isolated data root is required")
	}
	localAppData := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
	productionRoot := ""
	if localAppData != "" {
		productionRoot, _ = filepath.Abs(filepath.Join(localAppData, "AetherOps", "v2"))
	}
	productionPrefix := strings.TrimRight(filepath.Clean(productionRoot), `\/`) + string(os.PathSeparator)
	if strings.EqualFold(filepath.Clean(absolute), filepath.Clean(localAppData)) || filepath.Dir(absolute) == absolute ||
		productionRoot != "" && (strings.EqualFold(filepath.Clean(absolute), filepath.Clean(productionRoot)) ||
			strings.HasPrefix(strings.ToLower(filepath.Clean(absolute)+string(os.PathSeparator)), strings.ToLower(productionPrefix))) {
		return errors.New("refusing broad or production data root")
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("isolated data root is not a regular directory")
	}
	return nil
}

func isolatedEnvironment() []string {
	rejected := map[string]struct{}{
		"AETHEROPS_DEV": {}, "AETHEROPS_DATA_DIR": {},
		"AETHEROPS_RUNTIME_FEED_URL": {}, "AETHEROPS_RUNTIME_KEY_ID": {}, "AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64": {},
		"NODE_OPTIONS": {}, "NODE_PATH": {}, "HTTP_PROXY": {}, "HTTPS_PROXY": {}, "ALL_PROXY": {}, "NO_PROXY": {},
	}
	environment := make([]string, 0, len(os.Environ())+2)
	for _, item := range os.Environ() {
		name := item
		if index := strings.IndexByte(item, '='); index >= 0 {
			name = item[:index]
		}
		if _, remove := rejected[strings.ToUpper(name)]; !remove {
			environment = append(environment, item)
		}
	}
	return environment
}

func releaseEvaluationArguments(arguments []string, dataRoot string) ([]string, string, error) {
	if len(arguments) != 1 || arguments[0] != "app" {
		return append([]string(nil), arguments...), "", nil
	}
	descriptor := filepath.Join(filepath.Dir(dataRoot), fmt.Sprintf("readiness-%s-%d.json", filepath.Base(dataRoot), time.Now().UnixNano()))
	if _, err := os.Lstat(descriptor); !errors.Is(err, os.ErrNotExist) {
		return nil, "", errors.New("release-evaluation readiness output is not new")
	}
	return []string{"release-eval-session", "--descriptor", descriptor, "--data-root", dataRoot}, descriptor, nil
}

func readNormalCoreReadiness(path string, expectedBuild buildinfo.ProductBuildBinding) (normalCoreReadiness, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return normalCoreReadiness{}, err
	}
	var receipt normalCoreReadiness
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&receipt); err != nil {
		return normalCoreReadiness{}, fmt.Errorf("decode normal-core readiness: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return normalCoreReadiness{}, errors.New("normal-core readiness contains trailing JSON")
	}
	if receipt.Schema != "aetherops_release_eval_api_session_v2" || receipt.Mode != "normal" || receipt.BuildMode != "release" ||
		receipt.PID <= 0 || receipt.StartedAt.IsZero() || receipt.Endpoint == "" || receipt.TokenFile == "" ||
		receipt.ProductBuild != expectedBuild || !receipt.RuntimeReady || !receipt.CodexReady || !receipt.OxigraphReady || !receipt.APIReady {
		return normalCoreReadiness{}, errors.New("packaged process did not publish complete release normal-core readiness")
	}
	return receipt, nil
}

func mirrorTreeWithHardlinks(source, destination string) error {
	sourceAbsolute, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	destinationAbsolute, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	if !sameVolume(sourceAbsolute, destinationAbsolute) {
		return errors.New("hardlink mirror source and destination are on different volumes")
	}
	if _, err := os.Lstat(destinationAbsolute); !errors.Is(err, os.ErrNotExist) {
		return errors.New("hardlink mirror destination must not exist")
	}
	type link struct{ source, destination string }
	var links []link
	err = filepath.WalkDir(sourceAbsolute, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(sourceAbsolute, path)
		if err != nil {
			return err
		}
		target := filepath.Join(destinationAbsolute, relative)
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("candidate runtime contains a symlink")
		}
		if entry.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		if !entry.Type().IsRegular() {
			return errors.New("candidate runtime contains a non-regular file")
		}
		links = append(links, link{path, target})
		return nil
	})
	if err != nil {
		return err
	}
	workerCount := runtime.NumCPU()
	if workerCount < 1 {
		workerCount = 1
	}
	if workerCount > 16 {
		workerCount = 16
	}
	jobs := make(chan link)
	errorsOut := make(chan error, len(links))
	var workers sync.WaitGroup
	workers.Add(workerCount)
	for range workerCount {
		go func() {
			defer workers.Done()
			for item := range jobs {
				if err := os.Link(item.source, item.destination); err != nil {
					errorsOut <- fmt.Errorf("link %s: %w", item.source, err)
				}
			}
		}()
	}
	for _, item := range links {
		jobs <- item
	}
	close(jobs)
	workers.Wait()
	close(errorsOut)
	var joined error
	for err := range errorsOut {
		joined = errors.Join(joined, err)
	}
	return joined
}

func removeBlackboxTemporary(path, candidateDirectory string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	parent, err := filepath.Abs(candidateDirectory)
	if err != nil {
		return err
	}
	if !strings.EqualFold(filepath.Dir(absolute), filepath.Clean(parent)) ||
		!strings.HasPrefix(filepath.Base(absolute), ".packaged-blackbox-run-") {
		return errors.New("refusing to remove a path outside the exact black-box temporary layout")
	}
	info, err := os.Lstat(absolute)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("black-box temporary root is not a regular directory")
	}
	return os.RemoveAll(absolute)
}

func detachAndAppend(path string, suffix []byte) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	return writeDurableFileNew(path, append(data, suffix...))
}

func copyRegularFile(source, destination string) error {
	info, err := os.Lstat(source)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("copy source is not a regular file: %s", source)
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		_ = output.Close()
		if !committed {
			_ = os.Remove(destination)
		}
	}()
	written, err := io.Copy(output, input)
	if err != nil {
		return err
	}
	after, err := input.Stat()
	if err != nil || written != info.Size() || after.Size() != info.Size() ||
		!after.ModTime().Equal(info.ModTime()) || !os.SameFile(info, after) {
		return errors.New("copy source changed while reading")
	}
	if err := output.Sync(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	committed = true
	return nil
}

func writeDurableFileNew(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		_ = file.Close()
		if !committed {
			_ = os.Remove(path)
		}
	}()
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	committed = true
	return nil
}

func writeJSONNew(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	return writeBytesNew(absolute, data)
}

func writeBytesNew(path string, data []byte) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	return writeDurableFileNew(absolute, data)
}

func detailsPathForReceipt(path string) string {
	extension := filepath.Ext(path)
	if extension == "" {
		return path + ".details.json"
	}
	return strings.TrimSuffix(path, extension) + ".details.json"
}

func environmentIdentity(environment environmentEvidence) (string, error) {
	canonical, err := json.Marshal(environment)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	_, _ = io.WriteString(hash, environmentIdentityDomain)
	_, _ = hash.Write(canonical)
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func subjectHashList(hashes map[string]string) []releasegate.SubjectHash {
	names := make([]string, 0, len(hashes))
	for name := range hashes {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]releasegate.SubjectHash, 0, len(names))
	for _, name := range names {
		result = append(result, releasegate.SubjectHash{Name: name, SHA256: hashes[name]})
	}
	return result
}

func sameRuntimeSeal(left, right runtimeSeal) bool {
	if left.ActiveSHA256 != right.ActiveSHA256 || left.SetSHA256 != right.SetSHA256 ||
		len(left.TreeSHA256) != len(right.TreeSHA256) {
		return false
	}
	for component, digest := range left.TreeSHA256 {
		if right.TreeSHA256[component] != digest {
			return false
		}
	}
	return true
}

func decodeJSONFile(path string, destination any) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("JSON file contains trailing values")
	}
	return nil
}

func hashRegularFile(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("hash target is not a regular file: %s", path)
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	after, err := file.Stat()
	if err != nil || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return "", errors.New("file changed while hashing")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func currentEnvironment() environmentEvidence {
	version := windows.RtlGetVersion()
	return environmentEvidence{
		OS: runtime.GOOS, Architecture: runtime.GOARCH, GoVersion: runtime.Version(),
		LogicalProcessors: runtime.NumCPU(), ProcessorIdentifier: os.Getenv("PROCESSOR_IDENTIFIER"),
		WindowsVersion: fmt.Sprintf("%d.%d.%d", version.MajorVersion, version.MinorVersion, version.BuildNumber),
	}
}

func sameVolume(left, right string) bool {
	return strings.EqualFold(filepath.VolumeName(left), filepath.VolumeName(right))
}

func fileMissing(path string) bool {
	_, err := os.Lstat(path)
	return errors.Is(err, os.ErrNotExist)
}

func fileSize(path string) (int64, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, false
	}
	return info.Size(), true
}

func truncate(value []byte, limit int) string {
	if len(value) <= limit {
		return string(value)
	}
	return string(value[:limit]) + "..."
}

type limitedBuffer struct {
	buffer bytes.Buffer
}

func (buffer *limitedBuffer) Write(data []byte) (int, error) {
	const limit = 64 << 10
	original := len(data)
	remaining := limit - buffer.buffer.Len()
	if remaining > 0 {
		if len(data) > remaining {
			data = data[:remaining]
		}
		_, _ = buffer.buffer.Write(data)
	}
	return original, nil
}

func (buffer *limitedBuffer) Bytes() []byte  { return buffer.buffer.Bytes() }
func (buffer *limitedBuffer) String() string { return buffer.buffer.String() }
