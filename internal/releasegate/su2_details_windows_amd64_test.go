//go:build windows && amd64

package releasegate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/su2host"
)

func TestIncompatibleSU2EvidenceBindsImmediateLedgerRevision(t *testing.T) {
	for _, test := range []struct {
		name     string
		revision int
		wantPass bool
	}{{"immediate_revision", 1, true}, {"fabricated_revision", 2, false}} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			preparedAt := time.Unix(1_700_000_000, 0).UTC()
			build := testBuild("7")
			ledger, err := PrepareLedger(build, preparedAt)
			if err != nil {
				t.Fatal(err)
			}
			ledgerPath := filepath.Join(root, "ledger-r1.json")
			writeJSON(t, ledgerPath, ledger)
			ledgerRaw, err := os.ReadFile(ledgerPath)
			if err != nil {
				t.Fatal(err)
			}
			details, receipt := validIncompatibleSU2Details(t)
			details.LedgerSHA256 = testSHA(ledgerRaw)
			details.LedgerRevision = test.revision
			details.LedgerPreparedAt = preparedAt
			details.ObservationStartedAt = preparedAt.Add(time.Second)
			details.Command.StartedAt = preparedAt.Add(2 * time.Second)
			details.CandidatePreflight.ObservedAt = preparedAt.Add(3 * time.Second)
			details.Command.FinishedAt = preparedAt.Add(4 * time.Second)
			details.ObservationFinishedAt = preparedAt.Add(5 * time.Second)
			rebindIncompatibleSU2TestReceipt(t, &details, &receipt)
			detailsPath := filepath.Join(root, "incompatible.details.json")
			receiptPath := filepath.Join(root, "incompatible.receipt.json")
			if err := os.WriteFile(detailsPath, mustJSON(t, details), 0o600); err != nil {
				t.Fatal(err)
			}
			writeJSON(t, receiptPath, receipt)
			_, err = AttachEvidence(ledgerPath, receiptPath, filepath.Join(root, "ledger-r2.json"), build, preparedAt.Add(time.Minute))
			if test.wantPass && err != nil {
				t.Fatalf("immediate-revision evidence was rejected: %v", err)
			}
			if !test.wantPass && err == nil {
				t.Fatal("evidence that fabricated its prepared ledger revision was attached")
			}
		})
	}
}

func TestIncompatibleSU2DetailsRequireNativeRejectionAndNoExecution(t *testing.T) {
	details, receipt := validIncompatibleSU2Details(t)
	if err := validateIncompatibleSU2HostDetailsForLedger(mustJSON(t, details), receipt, details.LedgerRevision, details.LedgerPreparedAt); err != nil {
		t.Fatalf("valid typed incompatible-host details were rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*IncompatibleSU2HostDetails, *EvidenceReceipt)
	}{
		{"candidate_execution_attempted", func(value *IncompatibleSU2HostDetails, _ *EvidenceReceipt) {
			value.CandidatePreflight.SU2ExecutionAttempted = true
		}},
		{"candidate_hash", func(value *IncompatibleSU2HostDetails, _ *EvidenceReceipt) {
			value.CandidatePreflight.ExecutableSHA256 = strings.Repeat("f", 64)
		}},
		{"candidate_observation", func(value *IncompatibleSU2HostDetails, _ *EvidenceReceipt) {
			value.CandidatePreflight.Observation.ProcessorSignature++
		}},
		{"prepared_ledger_subject", func(_ *IncompatibleSU2HostDetails, value *EvidenceReceipt) {
			for index := range value.SubjectHashes {
				if value.SubjectHashes[index].Name == "prepared-ledger" {
					value.SubjectHashes[index].SHA256 = strings.Repeat("f", 64)
				}
			}
		}},
		{"prepared_ledger_revision", func(value *IncompatibleSU2HostDetails, _ *EvidenceReceipt) {
			value.LedgerRevision++
		}},
		{"prepared_ledger_timestamp", func(value *IncompatibleSU2HostDetails, _ *EvidenceReceipt) {
			value.LedgerPreparedAt = value.LedgerPreparedAt.Add(time.Second)
		}},
		{"compatible_host", func(value *IncompatibleSU2HostDetails, _ *EvidenceReceipt) {
			value.NativeObservation.Leaf7EBX |= 1 << 5
			value.NativeObservation.AVX2 = true
			value.CandidatePreflight.Observation = value.NativeObservation
			value.CandidatePreflight.Compatible = true
			value.CandidatePreflight.Decision = "allowed"
		}},
		{"virtualized_feature_mask", func(value *IncompatibleSU2HostDetails, _ *EvidenceReceipt) {
			value.NativeObservation.Leaf1ECX |= 1 << 31
			value.NativeObservation.HypervisorPresent = true
			value.CandidatePreflight.Observation = value.NativeObservation
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mutatedDetails := details
			mutatedReceipt := receipt
			mutatedReceipt.SubjectHashes = append([]SubjectHash(nil), receipt.SubjectHashes...)
			test.mutate(&mutatedDetails, &mutatedReceipt)
			if err := validateIncompatibleSU2HostDetailsForLedger(
				mustJSON(t, mutatedDetails), mutatedReceipt, details.LedgerRevision, details.LedgerPreparedAt,
			); err == nil {
				t.Fatal("mutated incompatible-host evidence was accepted")
			}
		})
	}
}

func TestIncompatibleSU2DetailsStrictlyRejectUnknownFields(t *testing.T) {
	details, receipt := validIncompatibleSU2Details(t)
	raw := mustJSON(t, details)
	raw = append(raw[:len(raw)-1], []byte(`,"fabricated":true}`)...)
	if err := ValidateIncompatibleSU2HostDetails(raw, receipt); err == nil {
		t.Fatal("unknown incompatible-host detail field was accepted")
	}
}

func validIncompatibleSU2Details(t *testing.T) (IncompatibleSU2HostDetails, EvidenceReceipt) {
	t.Helper()
	build := testBuild("7")
	candidateID, err := CandidateID(build)
	if err != nil {
		t.Fatal(err)
	}
	leaf1 := uint32((1 << 12) | (1 << 26) | (1 << 27) | (1 << 28))
	leaf7 := uint32((1 << 3) | (1 << 8)) // Deliberately lacks AVX2.
	native := su2host.Observation{
		Schema: su2host.ObservationSchemaV1, VendorID: "AuthenticAMD", MaximumBasicLeaf: 7,
		ProcessorSignature: 0x00a70f52, Leaf1ECX: leaf1, Leaf7EBX: leaf7, XCR0: 6,
		AVX: true, AVX2: false, FMA: true, BMI1: true, BMI2: true, XSAVE: true, OSXSAVE: true,
		XMMStateEnabled: true, YMMStateEnabled: true,
	}
	if err := native.Validate(); err != nil {
		t.Fatal(err)
	}
	start := time.Unix(1_700_000_000, 0).UTC()
	preflight := su2host.CandidatePreflightReceipt{
		Schema: su2host.CandidatePreflightSchemaV1, ObservedAt: start.Add(2 * time.Second),
		ExecutableSHA256: build.ExecutableSHA256, PreflightFunction: su2host.PreflightFunctionV1,
		Observation: native, Compatible: false, Decision: "rejected", SU2ExecutionAttempted: false,
	}
	preflightRaw, err := json.Marshal(preflight)
	if err != nil {
		t.Fatal(err)
	}
	preflightRaw = append(preflightRaw, '\n')
	stderr := []byte{}
	environment := IncompatibleSU2Environment{
		OS: "windows", Architecture: "amd64", WindowsVersion: "10.0.26100", LogicalProcessors: 8,
	}
	details := IncompatibleSU2HostDetails{
		Schema: IncompatibleSU2HostDetailsSchemaV1, GateID: "incompatible_su2_host",
		ReleaseCandidateID: candidateID, LedgerSHA256: strings.Repeat("8", 64), LedgerRevision: 4,
		LedgerPreparedAt: start, ObservationStartedAt: start.Add(time.Second), ObservationFinishedAt: start.Add(4 * time.Second),
		CandidateExecutable: filepath.Join(`C:\AetherOps`, "aetherops.exe"), CandidateBefore: build, CandidateAfter: build,
		Environment: environment, NativeObservation: native, CandidatePreflight: preflight,
		Command: IncompatibleSU2CommandObservation{
			Executable: filepath.Join(`C:\AetherOps`, "aetherops.exe"), Arguments: []string{"su2-host-preflight"},
			WorkingDirectory: `C:\AetherOps`, StartedAt: start.Add(time.Second), FinishedAt: start.Add(3 * time.Second), ExitCode: 0,
			Stdout: IncompatibleSU2StreamObservation{Bytes: int64(len(preflightRaw)), SHA256: testSHA(preflightRaw), Text: string(preflightRaw)},
			Stderr: IncompatibleSU2StreamObservation{Bytes: 0, SHA256: testSHA(stderr), Text: ""},
		},
		EvidenceScope: IncompatibleSU2EvidenceScope(), ExcludedReleaseClaims: IncompatibleSU2ExcludedClaims(),
	}
	detailsRaw := mustJSON(t, details)
	detailsDigest := sha256.Sum256(detailsRaw)
	observationRaw, _ := json.Marshal(native)
	identity, err := IncompatibleSU2EnvironmentIdentity(environment, native)
	if err != nil {
		t.Fatal(err)
	}
	receipt := EvidenceReceipt{
		Schema: EvidenceSchemaV1, GateID: "incompatible_su2_host", EvidenceKind: EvidenceIncompatibleHardware,
		ReleaseCandidateID: candidateID, ProductBuild: build, Producer: Producer{Name: "cmd/su2hostevidence", Version: "1"},
		Environment: Environment{Class: string(EvidenceIncompatibleHardware), OS: "windows-11", Architecture: "amd64", IdentitySHA256: identity},
		ObservedAt:  details.ObservationFinishedAt, Status: "passed", DetailsPath: "incompatible.details.json",
		DetailsSHA256: hex.EncodeToString(detailsDigest[:]),
	}
	receipt.SubjectHashes = []SubjectHash{
		{Name: "aetherops.exe", SHA256: build.ExecutableSHA256},
		{Name: "runtime-manifest.json", SHA256: build.RuntimeManifestSHA256},
		{Name: "knowledge-sidecar-tree", SHA256: build.KnowledgeSidecarTreeSHA256},
		{Name: "prepared-ledger", SHA256: details.LedgerSHA256},
		{Name: "incompatible-su2-host-details", SHA256: receipt.DetailsSHA256},
		{Name: "native-cpuid-observation", SHA256: testSHA(observationRaw)},
		{Name: "candidate-su2-preflight-stdout", SHA256: details.Command.Stdout.SHA256},
		{Name: "candidate-su2-preflight-stderr", SHA256: details.Command.Stderr.SHA256},
	}
	sort.Slice(receipt.SubjectHashes, func(left, right int) bool {
		return receipt.SubjectHashes[left].Name < receipt.SubjectHashes[right].Name
	})
	if err := receipt.Validate(); err != nil {
		t.Fatal(err)
	}
	return details, receipt
}

func rebindIncompatibleSU2TestReceipt(t *testing.T, details *IncompatibleSU2HostDetails, receipt *EvidenceReceipt) {
	t.Helper()
	preflightRaw, err := json.Marshal(details.CandidatePreflight)
	if err != nil {
		t.Fatal(err)
	}
	preflightRaw = append(preflightRaw, '\n')
	details.Command.Stdout = IncompatibleSU2StreamObservation{
		Bytes: int64(len(preflightRaw)), SHA256: testSHA(preflightRaw), Text: string(preflightRaw),
	}
	receipt.ObservedAt = details.ObservationFinishedAt
	receipt.DetailsPath = "incompatible.details.json"
	detailsRaw := mustJSON(t, details)
	receipt.DetailsSHA256 = testSHA(detailsRaw)
	setTestSubject(receipt, "prepared-ledger", details.LedgerSHA256)
	setTestSubject(receipt, "incompatible-su2-host-details", receipt.DetailsSHA256)
	setTestSubject(receipt, "candidate-su2-preflight-stdout", details.Command.Stdout.SHA256)
}

func testSHA(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}
