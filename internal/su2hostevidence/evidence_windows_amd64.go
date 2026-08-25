//go:build windows && amd64

// Package su2hostevidence is the sole trusted producer for the external
// incompatible_su2_host release gate. It can succeed only on a physically
// incompatible Windows x64 host observed through native CPUID and XGETBV.
package su2hostevidence

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"github.com/djkim0320/AetherOps/internal/desktop"
	"github.com/djkim0320/AetherOps/internal/processutil"
	"github.com/djkim0320/AetherOps/internal/releasegate"
	"github.com/djkim0320/AetherOps/internal/securepath"
	"github.com/djkim0320/AetherOps/internal/su2host"
	"golang.org/x/sys/windows"
)

const (
	ProducerName          = "cmd/su2hostevidence"
	ProducerVersion       = "1"
	GateID                = "incompatible_su2_host"
	maxCommandOutputBytes = 64 << 10
)

var ErrHostCompatible = errors.New("native host is SU2-compatible; incompatible_su2_host remains pending")
var ErrVirtualizedHost = errors.New("CPUID reports a hypervisor; incompatible_su2_host requires a non-virtualized hardware observation")

// Config intentionally contains paths only. CPU features, command arguments,
// result status, and observation time are never injectable.
type Config struct {
	LedgerPath                 string
	OutputPath                 string
	AetherOpsExecutablePath    string
	RuntimeManifestPath        string
	KnowledgeSidecarEntrypoint string
}

func Generate(ctx context.Context, config Config) (releasegate.EvidenceReceipt, error) {
	if ctx == nil {
		return releasegate.EvidenceReceipt{}, errors.New("context is required")
	}
	if err := ctx.Err(); err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	startedAt := time.Now().UTC()
	observation, err := su2host.ObserveNative()
	if err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("observe native incompatible host: %w", err)
	}
	// Check this before resolving or reserving any output. A compatible host is
	// expected to leave the external gate pending, with no diagnostic receipt
	// that could later be mistaken for passing evidence.
	if observation.Compatible() {
		return releasegate.EvidenceReceipt{}, ErrHostCompatible
	}
	if observation.HypervisorPresent {
		return releasegate.EvidenceReceipt{}, ErrVirtualizedHost
	}
	if windows.RtlGetVersion().BuildNumber < 22000 {
		return releasegate.EvidenceReceipt{}, errors.New("incompatible_su2_host requires a real Windows 11 x64 host")
	}

	ledgerPath, outputPath, detailsPath, executablePath, manifestPath, sidecarPath, err := absolutePaths(config)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	ledgerBefore, ledgerSHA256, err := releasegate.LoadLedgerChain(ledgerPath)
	if err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("load complete prepared ledger chain: %w", err)
	}
	if !gateRowEmpty(ledgerBefore) {
		return releasegate.EvidenceReceipt{}, errors.New("current ledger revision already contains incompatible SU2 host evidence")
	}
	candidateBefore, err := buildinfo.BindProductBuild(executablePath, manifestPath, sidecarPath)
	if err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("bind exact candidate before observation: %w", err)
	}
	if candidateBefore != ledgerBefore.ProductBuild {
		return releasegate.EvidenceReceipt{}, errors.New("current ledger revision is bound to a different product candidate")
	}
	candidateID, err := releasegate.CandidateID(candidateBefore)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	if candidateID != ledgerBefore.ReleaseCandidateID {
		return releasegate.EvidenceReceipt{}, errors.New("current ledger candidate id does not match its exact product build")
	}
	if startedAt.Before(ledgerBefore.PreparedAt) {
		return releasegate.EvidenceReceipt{}, errors.New("native incompatible-host observation predates ledger preparation")
	}

	commandObservation, candidatePreflight, err := runCandidatePreflight(ctx, executablePath)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	if candidatePreflight.Compatible || candidatePreflight.Decision != "rejected" ||
		candidatePreflight.SU2ExecutionAttempted || candidatePreflight.Observation != observation ||
		candidatePreflight.ExecutableSHA256 != candidateBefore.ExecutableSHA256 {
		return releasegate.EvidenceReceipt{}, errors.New("exact candidate did not fail closed on the independently observed incompatible host")
	}

	candidateAfter, err := buildinfo.BindProductBuild(executablePath, manifestPath, sidecarPath)
	if err != nil || candidateAfter != candidateBefore {
		if err == nil {
			err = errors.New("candidate identity changed during native preflight")
		}
		return releasegate.EvidenceReceipt{}, err
	}
	ledgerAfter, ledgerAfterSHA256, err := releasegate.LoadLedgerChain(ledgerPath)
	if err != nil || ledgerAfterSHA256 != ledgerSHA256 || !reflect.DeepEqual(ledgerAfter, ledgerBefore) || !gateRowEmpty(ledgerAfter) {
		if err == nil {
			err = errors.New("prepared ledger chain or current revision changed during native preflight")
		}
		return releasegate.EvidenceReceipt{}, err
	}
	finishedAt := time.Now().UTC()
	environment := currentEnvironment()
	identity, err := releasegate.IncompatibleSU2EnvironmentIdentity(environment, observation)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	details := releasegate.IncompatibleSU2HostDetails{
		Schema: releasegate.IncompatibleSU2HostDetailsSchemaV1, GateID: GateID,
		ReleaseCandidateID: candidateID, LedgerSHA256: ledgerSHA256, LedgerRevision: ledgerBefore.Revision,
		LedgerPreparedAt: ledgerBefore.PreparedAt, ObservationStartedAt: startedAt, ObservationFinishedAt: finishedAt,
		CandidateExecutable: executablePath, CandidateBefore: candidateBefore, CandidateAfter: candidateAfter,
		Environment: environment, NativeObservation: observation, CandidatePreflight: candidatePreflight,
		Command: commandObservation, EvidenceScope: releasegate.IncompatibleSU2EvidenceScope(),
		ExcludedReleaseClaims: releasegate.IncompatibleSU2ExcludedClaims(),
	}
	detailsRaw, err := marshalJSON(details)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	detailsSHA256 := hashBytes(detailsRaw)
	observationRaw, err := json.Marshal(observation)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	subjects := map[string]string{
		"aetherops.exe":                  candidateBefore.ExecutableSHA256,
		"runtime-manifest.json":          candidateBefore.RuntimeManifestSHA256,
		"knowledge-sidecar-tree":         candidateBefore.KnowledgeSidecarTreeSHA256,
		"prepared-ledger":                ledgerSHA256,
		"incompatible-su2-host-details":  detailsSHA256,
		"native-cpuid-observation":       hashBytes(observationRaw),
		"candidate-su2-preflight-stdout": commandObservation.Stdout.SHA256,
		"candidate-su2-preflight-stderr": commandObservation.Stderr.SHA256,
	}
	receipt := releasegate.EvidenceReceipt{
		Schema: releasegate.EvidenceSchemaV1, GateID: GateID,
		EvidenceKind: releasegate.EvidenceIncompatibleHardware, ReleaseCandidateID: candidateID,
		ProductBuild: candidateBefore, Producer: releasegate.Producer{Name: ProducerName, Version: ProducerVersion},
		Environment: releasegate.Environment{
			Class: string(releasegate.EvidenceIncompatibleHardware), OS: "windows-11",
			Architecture: "amd64", IdentitySHA256: identity,
		},
		ObservedAt: finishedAt, Status: "passed", SubjectHashes: subjectHashList(subjects),
		DetailsPath: filepath.Base(detailsPath), DetailsSHA256: detailsSHA256,
	}
	if err := receipt.Validate(); err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("validate incompatible SU2 host receipt: %w", err)
	}
	if err := releasegate.ValidateIncompatibleSU2HostDetails(detailsRaw, receipt); err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("validate incompatible SU2 host details: %w", err)
	}
	// Reauthenticate the exact candidate and complete ledger chain immediately
	// before the first persistent output is created.
	finalCandidate, err := buildinfo.BindProductBuild(executablePath, manifestPath, sidecarPath)
	if err != nil || finalCandidate != candidateBefore {
		return releasegate.EvidenceReceipt{}, errors.New("candidate identity changed before evidence commit")
	}
	finalLedger, finalLedgerSHA256, err := releasegate.LoadLedgerChain(ledgerPath)
	if err != nil || finalLedgerSHA256 != ledgerSHA256 || !reflect.DeepEqual(finalLedger, ledgerBefore) || !gateRowEmpty(finalLedger) {
		return releasegate.EvidenceReceipt{}, errors.New("ledger chain or current revision changed before evidence commit")
	}
	receiptRaw, err := marshalJSON(receipt)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	if err := writeNewPair(detailsPath, detailsRaw, outputPath, receiptRaw); err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	return receipt, nil
}

func absolutePaths(config Config) (ledger, output, details, executable, manifest, sidecar string, err error) {
	values := []*string{&ledger, &output, &executable, &manifest, &sidecar}
	inputs := []string{config.LedgerPath, config.OutputPath, config.AetherOpsExecutablePath, config.RuntimeManifestPath, config.KnowledgeSidecarEntrypoint}
	for index, input := range inputs {
		if strings.TrimSpace(input) == "" {
			return "", "", "", "", "", "", errors.New("ledger, output, executable, runtime manifest, and sidecar paths are required")
		}
		absolute, absoluteErr := filepath.Abs(input)
		if absoluteErr != nil {
			return "", "", "", "", "", "", absoluteErr
		}
		*values[index] = filepath.Clean(absolute)
	}
	if !strings.EqualFold(filepath.Ext(executable), ".exe") || filepath.Base(sidecar) != "index.cjs" {
		return "", "", "", "", "", "", errors.New("candidate executable or sidecar entrypoint identity is invalid")
	}
	if !strings.EqualFold(filepath.Dir(output), filepath.Dir(ledger)) {
		return "", "", "", "", "", "", errors.New("evidence receipt must be a direct sibling of the current ledger")
	}
	if _, siblingErr := securepath.SiblingName(filepath.Base(output)); siblingErr != nil {
		return "", "", "", "", "", "", fmt.Errorf("evidence receipt sibling name: %w", siblingErr)
	}
	extension := filepath.Ext(output)
	if extension == "" {
		details = output + ".details.json"
	} else {
		details = strings.TrimSuffix(output, extension) + ".details.json"
	}
	if _, siblingErr := securepath.SiblingName(filepath.Base(details)); siblingErr != nil {
		return "", "", "", "", "", "", fmt.Errorf("evidence details sibling name: %w", siblingErr)
	}
	paths := []string{ledger, output, details, executable, manifest, sidecar}
	for left := range paths {
		for right := left + 1; right < len(paths); right++ {
			if strings.EqualFold(paths[left], paths[right]) {
				return "", "", "", "", "", "", errors.New("release evidence paths must be distinct")
			}
		}
	}
	return ledger, output, details, executable, manifest, sidecar, nil
}

func gateRowEmpty(ledger releasegate.Ledger) bool {
	for _, reference := range ledger.Evidence {
		if reference.GateID == GateID {
			return reference.ReceiptPath == "" && reference.ReceiptSHA256 == ""
		}
	}
	return false
}

func runCandidatePreflight(ctx context.Context, executable string) (releasegate.IncompatibleSU2CommandObservation, su2host.CandidatePreflightReceipt, error) {
	startedAt := time.Now().UTC()
	command := exec.CommandContext(ctx, executable, "su2-host-preflight")
	command.Dir = filepath.Dir(executable)
	processutil.ConfigureNoWindow(command)
	stdout := &boundedBuffer{limit: maxCommandOutputBytes}
	stderr := &boundedBuffer{limit: maxCommandOutputBytes}
	command.Stdout, command.Stderr = stdout, stderr
	supervisor, err := desktop.NewProcessSupervisor()
	if err != nil {
		return releasegate.IncompatibleSU2CommandObservation{}, su2host.CandidatePreflightReceipt{}, err
	}
	defer supervisor.Close()
	startError := command.Start()
	if startError == nil {
		if err := supervisor.Assign(command.Process.Pid); err != nil {
			_ = command.Process.Kill()
			_ = command.Wait()
			startError = fmt.Errorf("assign candidate preflight to Job Object: %w", err)
		}
	}
	exitCode := -1
	if startError == nil {
		waitErr := command.Wait()
		exitCode = 0
		if waitErr != nil {
			var exitError *exec.ExitError
			if errors.As(waitErr, &exitError) {
				exitCode = exitError.ExitCode()
			}
			startError = waitErr
		}
	}
	finishedAt := time.Now().UTC()
	observation := releasegate.IncompatibleSU2CommandObservation{
		Executable: executable, Arguments: []string{"su2-host-preflight"}, WorkingDirectory: filepath.Dir(executable),
		StartedAt: startedAt, FinishedAt: finishedAt, ExitCode: exitCode,
		Stdout: streamObservation(stdout.Bytes()), Stderr: streamObservation(stderr.Bytes()),
	}
	if startError != nil {
		observation.StartError = startError.Error()
		return observation, su2host.CandidatePreflightReceipt{}, fmt.Errorf("run exact candidate SU2 preflight: %w", startError)
	}
	if stdout.overflow || stderr.overflow {
		return observation, su2host.CandidatePreflightReceipt{}, errors.New("candidate SU2 preflight output exceeded the fixed audit limit")
	}
	var receipt su2host.CandidatePreflightReceipt
	if err := decodeStrict(stdout.Bytes(), &receipt); err != nil {
		return observation, su2host.CandidatePreflightReceipt{}, fmt.Errorf("decode exact candidate SU2 preflight: %w", err)
	}
	if err := receipt.Validate(); err != nil {
		return observation, su2host.CandidatePreflightReceipt{}, err
	}
	return observation, receipt, nil
}

func currentEnvironment() releasegate.IncompatibleSU2Environment {
	version := windows.RtlGetVersion()
	return releasegate.IncompatibleSU2Environment{
		OS: "windows", Architecture: runtime.GOARCH,
		WindowsVersion:    fmt.Sprintf("%d.%d.%d", version.MajorVersion, version.MinorVersion, version.BuildNumber),
		LogicalProcessors: runtime.NumCPU(),
	}
}

func streamObservation(data []byte) releasegate.IncompatibleSU2StreamObservation {
	return releasegate.IncompatibleSU2StreamObservation{Bytes: int64(len(data)), SHA256: hashBytes(data), Text: string(data)}
}

func subjectHashList(subjects map[string]string) []releasegate.SubjectHash {
	names := make([]string, 0, len(subjects))
	for name := range subjects {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]releasegate.SubjectHash, 0, len(names))
	for _, name := range names {
		result = append(result, releasegate.SubjectHash{Name: name, SHA256: subjects[name]})
	}
	return result
}

func marshalJSON(value any) ([]byte, error) {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(raw, '\n'), nil
}

func decodeStrict(raw []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("JSON contains trailing values")
	}
	return nil
}

func hashBytes(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func writeNewPair(detailsPath string, details []byte, receiptPath string, receipt []byte) (returnErr error) {
	if err := os.MkdirAll(filepath.Dir(receiptPath), 0o755); err != nil {
		return err
	}
	detailsFile, err := os.OpenFile(detailsPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("reserve incompatible SU2 details: %w", err)
	}
	receiptFile, err := os.OpenFile(receiptPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		_ = detailsFile.Close()
		_ = os.Remove(detailsPath)
		return fmt.Errorf("reserve incompatible SU2 receipt: %w", err)
	}
	committed := false
	defer func() {
		_ = detailsFile.Close()
		_ = receiptFile.Close()
		if !committed {
			returnErr = errors.Join(returnErr, os.Remove(detailsPath), os.Remove(receiptPath))
		}
	}()
	if written, err := detailsFile.Write(details); err != nil {
		return err
	} else if written != len(details) {
		return io.ErrShortWrite
	}
	if err := detailsFile.Sync(); err != nil {
		return err
	}
	if written, err := receiptFile.Write(receipt); err != nil {
		return err
	} else if written != len(receipt) {
		return io.ErrShortWrite
	}
	if err := receiptFile.Sync(); err != nil {
		return err
	}
	if err := errors.Join(detailsFile.Close(), receiptFile.Close()); err != nil {
		return err
	}
	committed = true
	return nil
}

type boundedBuffer struct {
	buffer   bytes.Buffer
	limit    int
	overflow bool
}

func (buffer *boundedBuffer) Write(data []byte) (int, error) {
	original := len(data)
	remaining := buffer.limit - buffer.buffer.Len()
	if remaining < len(data) {
		buffer.overflow = true
	}
	if remaining > 0 {
		if len(data) > remaining {
			data = data[:remaining]
		}
		_, _ = buffer.buffer.Write(data)
	}
	return original, nil
}

func (buffer *boundedBuffer) Bytes() []byte { return buffer.buffer.Bytes() }
