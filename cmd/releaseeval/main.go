package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/desktop"
	"github.com/djkim0320/Aether-claw/internal/evalgate"
	"github.com/djkim0320/Aether-claw/internal/evalrunner"
	"github.com/djkim0320/Aether-claw/internal/knowledge"
	"github.com/djkim0320/Aether-claw/internal/releasegate"
	managedruntime "github.com/djkim0320/Aether-claw/internal/runtime"
	"github.com/djkim0320/Aether-claw/internal/store"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "AetherOps release evaluation:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) (returnErr error) {
	flags := flag.NewFlagSet("releaseeval", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	mode := flags.String("mode", "verify", "prepare, verify, or verify-runner")
	datasetPath := flags.String("dataset", filepath.Join("evals", "research-v1.json"), "versioned evaluation dataset")
	executionPath := flags.String("execution", "", "prepared execution manifest with real run ids")
	runnerReceiptPath := flags.String("runner-receipt", "", "completed live releaseevalrunner receipt")
	dataRoot := flags.String("data-root", "", "AetherOps v2 data root; defaults to LOCALAPPDATA")
	outputPath := flags.String("out", "", "new output JSON path; existing files are never overwritten")
	evidenceOutputPath := flags.String("evidence-out", "", "new live_quality_12 release evidence path; verify-runner only")
	preparedLedgerPath := flags.String("prepared-ledger", "", "current prepared release ledger; required for verify-runner evidence")
	executablePath := flags.String("aetherops-exe", filepath.Join("build", "aetherops.exe"), "exact AetherOps executable used for evaluation")
	runtimeManifestPath := flags.String("runtime-manifest", "runtime-manifest.json", "exact managed-runtime manifest used for evaluation")
	knowledgeSidecarPath := flags.String("knowledge-sidecar", filepath.Join("build", "knowledge-sidecar", "index.cjs"), "exact Oxigraph sidecar script used for evaluation")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	selectedMode := strings.ToLower(strings.TrimSpace(*mode))
	if selectedMode == "verify-runner" && strings.TrimSpace(*preparedLedgerPath) == "" {
		return errors.New("-prepared-ledger is required in verify-runner mode")
	}
	dataset, err := evalgate.LoadDataset(strings.TrimSpace(*datasetPath))
	if err != nil {
		return err
	}
	build, err := evalgate.BindProductBuild(
		strings.TrimSpace(*executablePath), strings.TrimSpace(*runtimeManifestPath), strings.TrimSpace(*knowledgeSidecarPath),
	)
	if err != nil {
		return err
	}
	preparedLedgerSHA256 := ""
	if selectedMode == "verify-runner" {
		preparedLedgerSHA256, err = bindPreparedLedger(strings.TrimSpace(*preparedLedgerPath), build, "live_quality_12")
		if err != nil {
			return err
		}
	}
	switch selectedMode {
	case "prepare":
		manifest, err := evalgate.PrepareExecutionManifest(dataset, evalgateTimeNow(), build)
		if err != nil {
			return err
		}
		return evalgate.WriteJSONNew(strings.TrimSpace(*outputPath), manifest)
	case "verify", "verify-runner":
		runnerMode := strings.EqualFold(strings.TrimSpace(*mode), "verify-runner")
		if runnerMode {
			if strings.TrimSpace(*runnerReceiptPath) == "" || strings.TrimSpace(*evidenceOutputPath) == "" {
				return errors.New("-runner-receipt and -evidence-out are required in verify-runner mode")
			}
			if strings.TrimSpace(*executionPath) != "" {
				return errors.New("manual -execution cannot be combined with verify-runner")
			}
			if err := validateLiveEvidencePaths(strings.TrimSpace(*outputPath), strings.TrimSpace(*evidenceOutputPath)); err != nil {
				return err
			}
		} else {
			if strings.TrimSpace(*executionPath) == "" {
				return errors.New("-execution is required in verify mode")
			}
			if strings.TrimSpace(*runnerReceiptPath) != "" || strings.TrimSpace(*evidenceOutputPath) != "" {
				return errors.New("manual execution verification cannot emit live_quality_12 release evidence")
			}
		}
		lease, primary, err := desktop.AcquireInstanceLease("AetherOps.v2")
		if err != nil {
			return fmt.Errorf("acquire offline verification lease: %w", err)
		}
		if !primary {
			return errors.New("AetherOps is running; close it before release verification so SQLite/CAS evidence is immutable")
		}
		defer func() { returnErr = errors.Join(returnErr, lease.Close()) }()
		root, err := resolveDataRoot(strings.TrimSpace(*dataRoot))
		if err != nil {
			return err
		}
		database, err := store.OpenReadOnly(ctx, filepath.Join(root, "aetherops.db"))
		if err != nil {
			return err
		}
		defer database.Close()
		objects, err := cas.OpenReadOnly(filepath.Join(root, "objects"))
		if err != nil {
			return err
		}
		supervisor, err := desktop.NewProcessSupervisor()
		if err != nil {
			return fmt.Errorf("create release-verifier Job Object: %w", err)
		}
		defer func() { returnErr = errors.Join(returnErr, supervisor.Close()) }()
		sidecar, err := startVerifiedOxigraph(
			ctx, root, strings.TrimSpace(*runtimeManifestPath), strings.TrimSpace(*executablePath),
			strings.TrimSpace(*knowledgeSidecarPath), supervisor.Assign,
		)
		if err != nil {
			return err
		}
		defer func() { returnErr = errors.Join(returnErr, sidecar.Close()) }()
		verifier := evalgate.Verifier{DB: database, CAS: objects, Oxigraph: sidecar}
		var receipt evalgate.Receipt
		var runnerReceipt evalrunner.Receipt
		if runnerMode {
			runnerReceipt, err = evalrunner.LoadReceipt(strings.TrimSpace(*runnerReceiptPath), dataset, build)
			if err != nil {
				return err
			}
			receipt, err = verifier.VerifyRunnerExecution(ctx, dataset, runnerReceipt.RunnerExecution())
		} else {
			manifest, loadErr := evalgate.LoadExecutionManifest(strings.TrimSpace(*executionPath), dataset)
			if loadErr != nil {
				return loadErr
			}
			if manifest.ProductBuild != build {
				return errors.New("evaluation executable, runtime manifest, or knowledge sidecar differs from the prepared product build")
			}
			receipt, err = verifier.VerifyExecution(ctx, dataset, manifest)
		}
		if err != nil {
			return err
		}
		if err := evalgate.WriteJSONNew(strings.TrimSpace(*outputPath), receipt); err != nil {
			return err
		}
		if !receipt.Passed {
			return fmt.Errorf("release gate failed: %d/%d cases passed; failure receipt was written", receipt.ObservedPasses, receipt.RequiredPasses)
		}
		if runnerMode {
			currentLedgerSHA256, ledgerErr := bindPreparedLedger(strings.TrimSpace(*preparedLedgerPath), build, "live_quality_12")
			if ledgerErr != nil {
				return fmt.Errorf("reauthenticate prepared ledger after live evaluation: %w", ledgerErr)
			}
			if currentLedgerSHA256 != preparedLedgerSHA256 {
				return errors.New("prepared ledger changed during live evaluation")
			}
			evidence, err := liveQualityEvidence(dataset, receipt, runnerReceipt, strings.TrimSpace(*outputPath), preparedLedgerSHA256)
			if err != nil {
				return err
			}
			finalLedgerSHA256, ledgerErr := bindPreparedLedger(strings.TrimSpace(*preparedLedgerPath), build, "live_quality_12")
			if ledgerErr != nil {
				return fmt.Errorf("reauthenticate prepared ledger before live evidence emission: %w", ledgerErr)
			}
			if finalLedgerSHA256 != preparedLedgerSHA256 {
				return errors.New("prepared ledger changed before live evidence emission")
			}
			if err := evalgate.WriteJSONNew(strings.TrimSpace(*evidenceOutputPath), evidence); err != nil {
				return err
			}
		}
		return nil
	default:
		return fmt.Errorf("unsupported mode %q", *mode)
	}
}

func liveQualityEvidence(
	dataset evalgate.Dataset,
	receipt evalgate.Receipt,
	runnerReceipt evalrunner.Receipt,
	detailsPath string,
	preparedLedgerSHA256 string,
) (releasegate.EvidenceReceipt, error) {
	if err := runnerReceipt.ValidateLive(dataset, receipt.ProductBuild); err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	if !receipt.Passed || receipt.RequiredCases != 12 || receipt.ObservedPasses != 12 ||
		receipt.ExecutionSource != evalgate.RunnerExecutionSource || receipt.EvalRunSetID != runnerReceipt.EvalRunSetID ||
		receipt.RunnerReceiptSHA256 != runnerReceipt.SHA256 || !runnerReceipt.EligibleForOfflineVerification {
		return releasegate.EvidenceReceipt{}, errors.New("live_quality_12 evidence requires a passed verifier result bound to one eligible runner receipt")
	}
	if !validSHA256(preparedLedgerSHA256) {
		return releasegate.EvidenceReceipt{}, errors.New("live_quality_12 evidence requires a valid prepared ledger SHA-256")
	}
	detailsSHA256, err := hashRegularFile(detailsPath)
	if err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("hash release evaluation details: %w", err)
	}
	candidateID, err := releasegate.CandidateID(receipt.ProductBuild)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	environmentSHA256, err := liveRunnerEnvironmentSHA256(runnerReceipt)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	evidence := releasegate.EvidenceReceipt{
		Schema: releasegate.EvidenceSchemaV1, GateID: "live_quality_12",
		EvidenceKind: releasegate.EvidenceLiveEvaluation, ReleaseCandidateID: candidateID,
		ProductBuild: receipt.ProductBuild,
		Producer:     releasegate.Producer{Name: "cmd/releaseeval:verify-runner", Version: "1"},
		Environment: releasegate.Environment{
			Class: string(releasegate.EvidenceLiveEvaluation), OS: runtime.GOOS,
			Architecture: runtime.GOARCH, IdentitySHA256: environmentSHA256,
		},
		ObservedAt: receipt.VerifiedAt, Status: "passed",
		SubjectHashes: liveQualitySubjectHashes(receipt, runnerReceipt, detailsSHA256, preparedLedgerSHA256),
		DetailsPath:   filepath.Base(detailsPath),
		DetailsSHA256: detailsSHA256,
	}
	if err := evidence.Validate(); err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	return evidence, nil
}

func liveQualitySubjectHashes(
	receipt evalgate.Receipt,
	runnerReceipt evalrunner.Receipt,
	detailsSHA256 string,
	preparedLedgerSHA256 string,
) []releasegate.SubjectHash {
	return []releasegate.SubjectHash{
		{Name: "aetherops.exe", SHA256: receipt.ProductBuild.ExecutableSHA256},
		{Name: "runtime-manifest.json", SHA256: receipt.ProductBuild.RuntimeManifestSHA256},
		{Name: "knowledge-sidecar-tree", SHA256: receipt.ProductBuild.KnowledgeSidecarTreeSHA256},
		{Name: "evaluation-dataset", SHA256: receipt.DatasetSHA256},
		{Name: "release-eval-runner-receipt", SHA256: runnerReceipt.SHA256},
		{Name: "release-evaluation-details", SHA256: detailsSHA256},
		{Name: "prepared-ledger", SHA256: preparedLedgerSHA256},
	}
}

func bindPreparedLedger(path string, build evalgate.ProductBuildBinding, gateID string) (string, error) {
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

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}

func validateLiveEvidencePaths(detailsPath, evidencePath string) error {
	detailsAbsolute, err := filepath.Abs(detailsPath)
	if err != nil {
		return fmt.Errorf("resolve release evaluation details path: %w", err)
	}
	evidenceAbsolute, err := filepath.Abs(evidencePath)
	if err != nil {
		return fmt.Errorf("resolve live quality evidence path: %w", err)
	}
	detailsName := filepath.Base(detailsAbsolute)
	evidenceName := filepath.Base(evidenceAbsolute)
	if detailsName == "." || detailsName == string(filepath.Separator) ||
		evidenceName == "." || evidenceName == string(filepath.Separator) {
		return errors.New("release evaluation details and evidence require explicit file names")
	}
	if !strings.HasSuffix(detailsName, ".details.json") {
		return errors.New("verify-runner -out must end in .details.json")
	}
	if !strings.EqualFold(filepath.Dir(detailsAbsolute), filepath.Dir(evidenceAbsolute)) ||
		strings.EqualFold(detailsName, evidenceName) {
		return errors.New("verify-runner details and evidence outputs must be different direct siblings")
	}
	return nil
}

func liveRunnerEnvironmentSHA256(receipt evalrunner.Receipt) (string, error) {
	canonical, err := json.Marshal(struct {
		Domain         string            `json:"domain"`
		OS             string            `json:"os"`
		Architecture   string            `json:"architecture"`
		EvalRunSetID   string            `json:"eval_run_set_id"`
		EndpointSHA256 string            `json:"endpoint_sha256"`
		Target         evalrunner.Target `json:"target"`
		StartedAt      time.Time         `json:"started_at"`
		TerminalAt     time.Time         `json:"terminal_at"`
	}{
		Domain: "aetherops-live-quality-environment-v1", OS: runtime.GOOS, Architecture: runtime.GOARCH,
		EvalRunSetID: receipt.EvalRunSetID, EndpointSHA256: receipt.EndpointSHA256,
		Target: receipt.Target, StartedAt: receipt.StartedAt, TerminalAt: receipt.TerminalAt,
	})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

func hashRegularFile(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("details input is not a regular non-symlink file")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if int64(len(raw)) != info.Size() {
		return "", errors.New("details input changed while reading")
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func startVerifiedOxigraph(
	ctx context.Context,
	dataRoot, runtimeManifestPath, aetheropsExecutable, knowledgeSidecarPath string,
	assign func(int) error,
) (*knowledge.Sidecar, error) {
	manifest, err := managedruntime.LoadManifest(runtimeManifestPath)
	if err != nil {
		return nil, fmt.Errorf("load exact managed-runtime manifest: %w", err)
	}
	executable, err := filepath.Abs(aetheropsExecutable)
	if err != nil {
		return nil, err
	}
	var paths managedruntime.ProcessPaths
	var runtimeErrors []error
	for _, root := range []string{
		filepath.Join(dataRoot, "runtimes"),
		filepath.Join(filepath.Dir(executable), "runtime"),
	} {
		resolved, pathErr := managedruntime.ResolveProcessPathsReadOnly(root, manifest)
		if pathErr != nil {
			runtimeErrors = append(runtimeErrors, fmt.Errorf("resolve verified runtime %s: %w", root, pathErr))
			continue
		}
		paths = resolved
		break
	}
	if paths.NodeExecutable == "" || paths.OxigraphModuleDirectory == "" {
		return nil, fmt.Errorf("no verified Node/Oxigraph runtime is available: %w", errors.Join(runtimeErrors...))
	}
	entrypoint, err := filepath.Abs(knowledgeSidecarPath)
	if err != nil {
		return nil, err
	}
	expectedSidecar := filepath.Join(filepath.Dir(executable), "knowledge-sidecar", "index.cjs")
	if !strings.EqualFold(filepath.Clean(entrypoint), filepath.Clean(expectedSidecar)) {
		return nil, errors.New("knowledge sidecar must be the script packaged beside the evaluated AetherOps executable")
	}
	info, err := os.Lstat(entrypoint)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		if err == nil {
			err = errors.New("entrypoint is not a regular non-symlink file")
		}
		return nil, fmt.Errorf("verify packaged knowledge sidecar %s: %w", entrypoint, err)
	}
	sidecarEnvironment, err := knowledge.IsolatedSidecarEnvironment(append(
		os.Environ(), "AETHEROPS_OXIGRAPH_MODULE="+paths.OxigraphModuleDirectory,
	))
	if err != nil {
		return nil, err
	}
	return knowledge.StartSidecar(ctx, knowledge.SidecarConfig{
		Command: paths.NodeExecutable,
		Args:    []string{entrypoint},
		Dir:     filepath.Dir(entrypoint),
		Env:     sidecarEnvironment,
		AfterStart: func(command *exec.Cmd) error {
			if command.Process == nil {
				return errors.New("Oxigraph verifier sidecar process is unavailable")
			}
			return assign(command.Process.Pid)
		},
	})
}

var evalgateTimeNow = func() time.Time { return time.Now().UTC() }

func resolveDataRoot(explicit string) (string, error) {
	root := explicit
	if root == "" {
		localAppData := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
		if localAppData == "" {
			return "", errors.New("LOCALAPPDATA is unavailable and -data-root was not provided")
		}
		root = filepath.Join(localAppData, "AetherOps", "v2")
	}
	return filepath.Abs(root)
}
