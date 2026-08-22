//go:build windows && amd64

package releasegate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/su2host"
)

const (
	IncompatibleSU2HostDetailsSchemaV1 = "aetherops_incompatible_su2_host_details_v1"
	incompatibleSU2EnvironmentDomain   = "aetherops-incompatible-su2-environment-v1\x00"
)

type IncompatibleSU2Environment struct {
	OS                string `json:"os"`
	Architecture      string `json:"architecture"`
	WindowsVersion    string `json:"windows_version"`
	LogicalProcessors int    `json:"logical_processors"`
}

type IncompatibleSU2StreamObservation struct {
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
	Text   string `json:"text"`
}

type IncompatibleSU2CommandObservation struct {
	Executable       string                           `json:"executable"`
	Arguments        []string                         `json:"arguments"`
	WorkingDirectory string                           `json:"working_directory"`
	StartedAt        time.Time                        `json:"started_at"`
	FinishedAt       time.Time                        `json:"finished_at"`
	ExitCode         int                              `json:"exit_code"`
	StartError       string                           `json:"start_error,omitempty"`
	Stdout           IncompatibleSU2StreamObservation `json:"stdout"`
	Stderr           IncompatibleSU2StreamObservation `json:"stderr"`
}

type IncompatibleSU2HostDetails struct {
	Schema                string                            `json:"schema"`
	GateID                string                            `json:"gate_id"`
	ReleaseCandidateID    string                            `json:"release_candidate_id"`
	LedgerSHA256          string                            `json:"ledger_sha256"`
	LedgerRevision        int                               `json:"ledger_revision"`
	LedgerPreparedAt      time.Time                         `json:"ledger_prepared_at"`
	ObservationStartedAt  time.Time                         `json:"observation_started_at"`
	ObservationFinishedAt time.Time                         `json:"observation_finished_at"`
	CandidateExecutable   string                            `json:"candidate_executable"`
	CandidateBefore       buildinfo.ProductBuildBinding     `json:"candidate_before"`
	CandidateAfter        buildinfo.ProductBuildBinding     `json:"candidate_after"`
	Environment           IncompatibleSU2Environment        `json:"environment"`
	NativeObservation     su2host.Observation               `json:"native_observation"`
	CandidatePreflight    su2host.CandidatePreflightReceipt `json:"candidate_preflight"`
	Command               IncompatibleSU2CommandObservation `json:"command"`
	EvidenceScope         []string                          `json:"evidence_scope"`
	ExcludedReleaseClaims []string                          `json:"excluded_release_claims"`
}

func IncompatibleSU2EvidenceScope() []string {
	return []string{
		"incompatible_su2_host", "incompatible_hardware", "native_cpuid_xgetbv",
		"exact_candidate_preflight_rejection", "su2_execution_not_attempted",
	}
}

func IncompatibleSU2ExcludedClaims() []string {
	return []string{
		"overall_release_success", "compatible_host_behavior", "actual_su2_solver_execution",
		"performance_or_numerical_correctness",
	}
}

func IncompatibleSU2EnvironmentIdentity(environment IncompatibleSU2Environment, observation su2host.Observation) (string, error) {
	if err := observation.Validate(); err != nil {
		return "", err
	}
	canonical, err := json.Marshal(struct {
		Environment IncompatibleSU2Environment `json:"environment"`
		Observation su2host.Observation        `json:"observation"`
	}{environment, observation})
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	_, _ = hash.Write([]byte(incompatibleSU2EnvironmentDomain))
	_, _ = hash.Write(canonical)
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func ValidateIncompatibleSU2HostDetails(raw []byte, receipt EvidenceReceipt) error {
	return validateIncompatibleSU2HostDetailsForLedger(raw, receipt, 0, time.Time{})
}

func validateIncompatibleSU2HostDetailsForLedger(raw []byte, receipt EvidenceReceipt, preparedRevision int, preparedAt time.Time) error {
	var details IncompatibleSU2HostDetails
	if err := decodeStrict(raw, &details); err != nil {
		return fmt.Errorf("decode incompatible SU2 host details: %w", err)
	}
	if details.Schema != IncompatibleSU2HostDetailsSchemaV1 || details.GateID != "incompatible_su2_host" ||
		details.GateID != receipt.GateID || details.ReleaseCandidateID != receipt.ReleaseCandidateID ||
		details.CandidateBefore != receipt.ProductBuild || details.CandidateAfter != receipt.ProductBuild ||
		details.LedgerRevision < 1 || !validDigest(details.LedgerSHA256) ||
		!filepath.IsAbs(details.CandidateExecutable) || !strings.EqualFold(filepath.Ext(details.CandidateExecutable), ".exe") ||
		receipt.Status != "passed" {
		return errors.New("incompatible SU2 host details identity, ledger, or candidate contract is invalid")
	}
	if preparedRevision > 0 && details.LedgerRevision != preparedRevision {
		return errors.New("incompatible SU2 host details ledger revision does not match its attachment predecessor")
	}
	if !preparedAt.IsZero() && !details.LedgerPreparedAt.Equal(preparedAt) {
		return errors.New("incompatible SU2 host details ledger timestamp does not match its attachment chain")
	}
	if details.LedgerPreparedAt.IsZero() || details.ObservationStartedAt.Before(details.LedgerPreparedAt) ||
		details.ObservationFinishedAt.Before(details.ObservationStartedAt) ||
		!details.ObservationFinishedAt.Equal(receipt.ObservedAt) {
		return errors.New("incompatible SU2 host observation window is invalid")
	}
	if details.Environment.OS != "windows" || details.Environment.Architecture != "amd64" ||
		!windows11Version(details.Environment.WindowsVersion) || details.Environment.LogicalProcessors < 1 {
		return errors.New("incompatible SU2 host environment is not Windows 11 x64")
	}
	if err := details.NativeObservation.Validate(); err != nil {
		return err
	}
	if details.NativeObservation.Compatible() || len(details.NativeObservation.Missing()) == 0 ||
		details.NativeObservation.HypervisorPresent {
		return errors.New("compatible or virtualized hardware cannot satisfy the incompatible SU2 host gate")
	}
	if err := details.CandidatePreflight.Validate(); err != nil {
		return err
	}
	if details.CandidatePreflight.Compatible || details.CandidatePreflight.Decision != "rejected" ||
		details.CandidatePreflight.SU2ExecutionAttempted ||
		details.CandidatePreflight.ExecutableSHA256 != receipt.ProductBuild.ExecutableSHA256 ||
		details.CandidatePreflight.Observation != details.NativeObservation ||
		details.CandidatePreflight.ObservedAt.Before(details.Command.StartedAt) ||
		details.CandidatePreflight.ObservedAt.After(details.Command.FinishedAt) {
		return errors.New("candidate SU2 preflight did not reject the same native incompatible host before execution")
	}
	if !strings.EqualFold(filepath.Clean(details.Command.Executable), filepath.Clean(details.CandidateExecutable)) ||
		!reflect.DeepEqual(details.Command.Arguments, []string{"su2-host-preflight"}) ||
		!strings.EqualFold(filepath.Clean(details.Command.WorkingDirectory), filepath.Dir(filepath.Clean(details.CandidateExecutable))) ||
		details.Command.StartError != "" || details.Command.ExitCode != 0 ||
		details.Command.StartedAt.Before(details.ObservationStartedAt) ||
		details.Command.FinishedAt.Before(details.Command.StartedAt) ||
		details.Command.FinishedAt.After(details.ObservationFinishedAt) {
		return errors.New("candidate SU2 preflight command identity, result, or time bounds are invalid")
	}
	subjects, err := receiptSubjectMap(receipt)
	if err != nil {
		return err
	}
	if subjects["prepared-ledger"] != details.LedgerSHA256 ||
		subjects["incompatible-su2-host-details"] != receipt.DetailsSHA256 {
		return errors.New("incompatible SU2 details are not bound to their ledger and details subjects")
	}
	observationRaw, err := json.Marshal(details.NativeObservation)
	if err != nil {
		return err
	}
	observationDigest := sha256.Sum256(observationRaw)
	if subjects["native-cpuid-observation"] != hex.EncodeToString(observationDigest[:]) {
		return errors.New("native CPUID observation subject hash is invalid")
	}
	if err := validateIncompatibleSU2Stream(details.Command.Stdout, subjects["candidate-su2-preflight-stdout"]); err != nil {
		return fmt.Errorf("candidate SU2 preflight stdout: %w", err)
	}
	if err := validateIncompatibleSU2Stream(details.Command.Stderr, subjects["candidate-su2-preflight-stderr"]); err != nil {
		return fmt.Errorf("candidate SU2 preflight stderr: %w", err)
	}
	var commandReceipt su2host.CandidatePreflightReceipt
	if err := decodeStrict([]byte(details.Command.Stdout.Text), &commandReceipt); err != nil || commandReceipt != details.CandidatePreflight {
		return errors.New("candidate SU2 preflight stdout does not contain the exact typed receipt")
	}
	identity, err := IncompatibleSU2EnvironmentIdentity(details.Environment, details.NativeObservation)
	if err != nil || receipt.Environment.Class != string(EvidenceIncompatibleHardware) ||
		receipt.Environment.OS != "windows-11" || receipt.Environment.Architecture != "amd64" ||
		receipt.Environment.IdentitySHA256 != identity {
		return errors.New("incompatible SU2 host receipt environment identity is invalid")
	}
	if !reflect.DeepEqual(details.EvidenceScope, IncompatibleSU2EvidenceScope()) ||
		!reflect.DeepEqual(details.ExcludedReleaseClaims, IncompatibleSU2ExcludedClaims()) {
		return errors.New("incompatible SU2 host evidence scope is overstated or incomplete")
	}
	return nil
}

func validateIncompatibleSU2Stream(stream IncompatibleSU2StreamObservation, subject string) error {
	data := []byte(stream.Text)
	if stream.Bytes != int64(len(data)) || !validDigest(stream.SHA256) || stream.SHA256 != subject {
		return errors.New("stream size or SHA-256 subject binding is invalid")
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != stream.SHA256 {
		return errors.New("stream text does not match its SHA-256")
	}
	return nil
}
