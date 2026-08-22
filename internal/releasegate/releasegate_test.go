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

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/releasetree"
)

func TestPreparedLedgerCannotTreatMissingExternalEvidenceAsPass(t *testing.T) {
	root := t.TempDir()
	build := testBuild("a")
	ledger, err := PrepareLedger(build, time.Unix(1_700_000_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	ledgerPath := filepath.Join(root, "ledger-r1.json")
	writeJSON(t, ledgerPath, ledger)
	receipt, err := Verify(ledgerPath, build, time.Unix(1_700_000_100, 0))
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Passed || receipt.PassedGates != 0 || receipt.RequiredGates != len(RequiredGates()) {
		t.Fatalf("empty evidence ledger passed: %+v", receipt)
	}
	for index, result := range receipt.Results {
		want := "not_evidenced"
		if RequiredGates()[index].External {
			want = "blocked_external"
		}
		if result.Status != want {
			t.Fatalf("gate %s status=%s, want %s", result.GateID, result.Status, want)
		}
	}
}

func TestSelfDeclaredReceiptsCannotPassTrustedProducerPolicy(t *testing.T) {
	build := testBuild("a")
	candidateID, err := CandidateID(build)
	if err != nil {
		t.Fatal(err)
	}
	external := EvidenceReceipt{
		Schema: EvidenceSchemaV1, GateID: "live_auth_exact_models", EvidenceKind: EvidenceLiveService,
		ReleaseCandidateID: candidateID, ProductBuild: build,
		Producer: Producer{Name: "self-declared", Version: "1"},
	}
	if err := external.Validate(); err == nil || !strings.Contains(err.Error(), "not trusted") {
		t.Fatalf("self-declared live producer was accepted: %v", err)
	}

	receipt, _, _ := writeValidPackagedEvidence(t, t.TempDir(), build, time.Now().UTC())
	receipt.Producer.Name = "self-declared"
	if err := receipt.Validate(); err == nil || !strings.Contains(err.Error(), "not trusted") {
		t.Fatalf("self-declared packaged producer was accepted: %v", err)
	}
}

func TestGateSpecificDetailsSubjectMustMatchDetailsDigest(t *testing.T) {
	build := testBuild("a")
	receipt, _, _ := writeValidPackagedEvidence(t, t.TempDir(), build, time.Now().UTC())
	for index := range receipt.SubjectHashes {
		if receipt.SubjectHashes[index].Name == "packaged-blackbox-details" {
			receipt.SubjectHashes[index].SHA256 = strings.Repeat("f", 64)
		}
	}
	if err := receipt.Validate(); err == nil || !strings.Contains(err.Error(), "details subject") {
		t.Fatalf("mismatched details subject was accepted: %v", err)
	}

	receipt, _, _ = writeValidPackagedEvidence(t, t.TempDir(), build, time.Now().UTC())
	filtered := receipt.SubjectHashes[:0]
	for _, subject := range receipt.SubjectHashes {
		if subject.Name != "packaged-blackbox-details" {
			filtered = append(filtered, subject)
		}
	}
	receipt.SubjectHashes = filtered
	if err := receipt.Validate(); err == nil || !strings.Contains(err.Error(), "missing required subject") {
		t.Fatalf("missing gate-specific subject was accepted: %v", err)
	}
}

func TestAttachEvidenceCreatesOneImmutableRevisionAndVerifiesReadback(t *testing.T) {
	root := t.TempDir()
	build := testBuild("a")
	preparedAt := time.Unix(1_700_000_000, 0).UTC()
	ledger, err := PrepareLedger(build, preparedAt)
	if err != nil {
		t.Fatal(err)
	}
	ledger1Path := filepath.Join(root, "ledger-r1.json")
	writeJSON(t, ledger1Path, ledger)
	ledger1Raw, err := os.ReadFile(ledger1Path)
	if err != nil {
		t.Fatal(err)
	}
	ledger1Digest := sha256.Sum256(ledger1Raw)
	_, receiptPath, detailsPath := writeValidPackagedEvidence(t, root, build, preparedAt.Add(time.Minute), hex.EncodeToString(ledger1Digest[:]))
	ledger2Path := filepath.Join(root, "ledger-r2.json")
	next, err := AttachEvidence(ledger1Path, receiptPath, ledger2Path, build, preparedAt.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if next.Revision != 2 || next.PreviousLedgerPath != filepath.Base(ledger1Path) {
		t.Fatalf("unexpected attached revision: %+v", next)
	}
	writeJSON(t, ledger2Path, next)
	admission, err := Verify(ledger2Path, build, preparedAt.Add(3*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if admission.Passed || admission.PassedGates != 1 || admission.Results[4].Status != "passed" {
		t.Fatalf("packaged evidence readback was not the sole passing gate: %+v", admission)
	}
	if _, err := AttachEvidence(ledger2Path, receiptPath, filepath.Join(root, "ledger-r3.json"), build, preparedAt.Add(4*time.Minute)); err == nil {
		t.Fatalf("replacement attachment was accepted: %v", err)
	}

	if err := os.WriteFile(detailsPath, []byte("{\"tampered\":true}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	admission, err = Verify(ledger2Path, build, preparedAt.Add(5*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if admission.Results[4].Status != "invalid_evidence" || !strings.Contains(admission.Results[4].Failure, "details SHA-256") {
		t.Fatalf("tampered details were not rejected: %+v", admission.Results[4])
	}
}

func TestLedgerChainRejectsManualMultiAttachAndPredecessorMutation(t *testing.T) {
	root := t.TempDir()
	build := testBuild("a")
	preparedAt := time.Unix(1_700_000_000, 0).UTC()
	ledger, err := PrepareLedger(build, preparedAt)
	if err != nil {
		t.Fatal(err)
	}
	ledger1Path := filepath.Join(root, "ledger-r1.json")
	writeJSON(t, ledger1Path, ledger)
	ledger1Raw, err := os.ReadFile(ledger1Path)
	if err != nil {
		t.Fatal(err)
	}
	ledger1Digest := sha256.Sum256(ledger1Raw)

	manual := ledger
	manual.Revision = 2
	manual.PreviousLedgerPath = filepath.Base(ledger1Path)
	manual.PreviousLedgerSHA256 = hex.EncodeToString(ledger1Digest[:])
	manual.Evidence = append([]EvidenceReference(nil), ledger.Evidence...)
	manual.Evidence[0].ReceiptPath, manual.Evidence[0].ReceiptSHA256 = "first.json", strings.Repeat("d", 64)
	manual.Evidence[1].ReceiptPath, manual.Evidence[1].ReceiptSHA256 = "second.json", strings.Repeat("e", 64)
	manualPath := filepath.Join(root, "ledger-manual.json")
	writeJSON(t, manualPath, manual)
	if _, _, err := LoadLedgerChain(manualPath); err == nil || !strings.Contains(err.Error(), "exactly 1") {
		t.Fatalf("manual multi-attach revision was accepted: %v", err)
	}

	_, receiptPath, _ := writeValidPackagedEvidence(t, root, build, preparedAt.Add(time.Minute), hex.EncodeToString(ledger1Digest[:]))
	valid, err := AttachEvidence(ledger1Path, receiptPath, filepath.Join(root, "ledger-r2.json"), build, preparedAt.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	validPath := filepath.Join(root, "ledger-r2.json")
	writeJSON(t, validPath, valid)
	ledger.PreparedAt = ledger.PreparedAt.Add(time.Second)
	writeJSONReplace(t, ledger1Path, ledger)
	if _, _, err := LoadLedgerChain(validPath); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("mutated predecessor was accepted: %v", err)
	}
}

func TestLocalEvidenceCannotBeReusedAgainstAnotherLedgerRevision(t *testing.T) {
	root := t.TempDir()
	build := testBuild("a")
	preparedAt := time.Unix(1_800_000_000, 0).UTC()
	ledger, err := PrepareLedger(build, preparedAt)
	if err != nil {
		t.Fatal(err)
	}
	ledger1Path := filepath.Join(root, "ledger-r1.json")
	writeJSON(t, ledger1Path, ledger)
	ledger1Raw, err := os.ReadFile(ledger1Path)
	if err != nil {
		t.Fatal(err)
	}
	ledger1Digest := sha256.Sum256(ledger1Raw)
	ledger1SHA := hex.EncodeToString(ledger1Digest[:])

	receiptPath := writeValidLocalSchedulerEvidence(t, root, strings.Repeat("9", 64), preparedAt, preparedAt.Add(time.Minute))
	if _, err := AttachEvidence(ledger1Path, receiptPath, filepath.Join(root, "ledger-rejected.json"), build, preparedAt.Add(2*time.Minute)); err == nil ||
		!strings.Contains(err.Error(), "exact current ledger revision") {
		t.Fatalf("local receipt from another same-candidate ledger was accepted: %v", err)
	}

	receiptRaw, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	receiptDigest := sha256.Sum256(receiptRaw)
	manual := ledger
	manual.Revision = 2
	manual.PreviousLedgerPath = filepath.Base(ledger1Path)
	manual.PreviousLedgerSHA256 = ledger1SHA
	for index := range manual.Evidence {
		if manual.Evidence[index].GateID == "scheduler_recovery" {
			manual.Evidence[index].ReceiptPath = filepath.Base(receiptPath)
			manual.Evidence[index].ReceiptSHA256 = hex.EncodeToString(receiptDigest[:])
		}
	}
	manualPath := filepath.Join(root, "ledger-manual-r2.json")
	writeJSON(t, manualPath, manual)
	admission, err := Verify(manualPath, build, preparedAt.Add(3*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	for _, result := range admission.Results {
		if result.GateID == "scheduler_recovery" {
			if result.Status != "invalid_evidence" || !strings.Contains(result.Failure, "immediately preceding") {
				t.Fatalf("manual chain reused the wrong prepared-ledger receipt: %+v", result)
			}
			return
		}
	}
	t.Fatal("scheduler gate result is absent")
}

func TestVerifyReauthenticatesCurrentLocalSourceTree(t *testing.T) {
	root := t.TempDir()
	build := testBuild("a")
	preparedAt := time.Unix(1_800_100_000, 0).UTC()
	ledger, err := PrepareLedger(build, preparedAt)
	if err != nil {
		t.Fatal(err)
	}
	ledger1Path := filepath.Join(root, "ledger-r1.json")
	writeJSON(t, ledger1Path, ledger)
	ledgerRaw, err := os.ReadFile(ledger1Path)
	if err != nil {
		t.Fatal(err)
	}
	ledgerDigest := sha256.Sum256(ledgerRaw)
	receiptPath := writeValidLocalSchedulerEvidence(t, root, hex.EncodeToString(ledgerDigest[:]), preparedAt, preparedAt.Add(time.Minute))
	ledger2, err := AttachEvidence(ledger1Path, receiptPath, filepath.Join(root, "ledger-r2.json"), build, preparedAt.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	ledger2Path := filepath.Join(root, "ledger-r2.json")
	writeJSON(t, ledger2Path, ledger2)
	admission, err := Verify(ledger2Path, build, preparedAt.Add(3*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if admission.Results[3].Status != "passed" {
		t.Fatalf("current source tree did not verify: %+v", admission.Results[3])
	}

	var receipt EvidenceReceipt
	receiptRaw, err := os.ReadFile(receiptPath)
	if err != nil || json.Unmarshal(receiptRaw, &receipt) != nil {
		t.Fatal("read scheduler receipt")
	}
	detailsRaw, err := os.ReadFile(filepath.Join(root, receipt.DetailsPath))
	if err != nil {
		t.Fatal(err)
	}
	var details localReleaseDetails
	if err := json.Unmarshal(detailsRaw, &details); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(details.Commands[0].WorkingDir, "README.md"), []byte("changed after evidence\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	admission, err = Verify(ledger2Path, build, preparedAt.Add(4*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if admission.Results[3].Status != "invalid_evidence" || !strings.Contains(admission.Results[3].Failure, "current release source tree differs") {
		t.Fatalf("stale local source evidence remained valid: %+v", admission.Results[3])
	}
}

func TestInitialLedgerRejectsEvidenceAndEscapingNames(t *testing.T) {
	ledger, err := PrepareLedger(testBuild("a"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	ledger.Evidence[0].ReceiptPath = "manual.json"
	ledger.Evidence[0].ReceiptSHA256 = strings.Repeat("d", 64)
	if err := ledger.Validate(); err == nil || !strings.Contains(err.Error(), "initial release ledger") {
		t.Fatalf("manually populated initial ledger was accepted: %v", err)
	}
	if _, err := resolveEvidencePath(t.TempDir(), `..\outside.json`); err == nil {
		t.Fatal("escaping evidence path was accepted")
	}
}

func writeValidPackagedEvidence(t *testing.T, root string, build buildinfo.ProductBuildBinding, observedAt time.Time, preparedLedgerSHA ...string) (EvidenceReceipt, string, string) {
	t.Helper()
	candidateID, err := CandidateID(build)
	if err != nil {
		t.Fatal(err)
	}
	environment := PackagedBlackboxEnvironment{
		OS: "windows", Architecture: "amd64", GoVersion: "go1.26.5", LogicalProcessors: 8,
		ProcessorIdentifier: "test-cpu", WindowsVersion: "10.0.26100",
	}
	environmentID, err := PackagedBlackboxEnvironmentIdentity(environment)
	if err != nil {
		t.Fatal(err)
	}
	details := PackagedBlackboxDetails{
		Schema: PackagedBlackboxDetailsSchemaV1, ReleaseCandidateID: candidateID,
		CandidateExecutable: filepath.Join(root, "aetherops.exe"), Environment: environment,
		IsolatedDataOnly: true, FixtureRole: "abrupt-exit recovery fixture only",
		Scenarios: validPackagedBlackboxScenarios(t),
		EvidenceLimits: PackagedBlackboxLimits{
			PackagedBlackboxGateEligible: true,
			Proves:                       []string{"local_packaged_executable", "crash_recovery", "runtime_tamper_rejection", "sidecar_prelaunch_identity_rejection"},
			DoesNotProve:                 []string{"live_service", "clean_vm", "incompatible_hardware", "production_signed_feed"},
		},
	}
	detailsPath := filepath.Join(root, "packaged.details.json")
	detailsRaw := marshalJSON(t, details)
	if err := os.WriteFile(detailsPath, detailsRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	detailsDigest := sha256.Sum256(detailsRaw)
	detailsSHA := hex.EncodeToString(detailsDigest[:])
	policy, ok := evidencePolicy("packaged_blackbox")
	if !ok {
		t.Fatal("packaged black-box policy is missing")
	}
	subjects := map[string]string{
		"aetherops.exe": build.ExecutableSHA256, "runtime-manifest.json": build.RuntimeManifestSHA256,
		"knowledge-sidecar-tree": build.KnowledgeSidecarTreeSHA256,
	}
	if len(preparedLedgerSHA) > 0 {
		subjects["prepared-ledger"] = preparedLedgerSHA[0]
	}
	for _, name := range policy.RequiredSubjects {
		if _, exists := subjects[name]; !exists {
			subjects[name] = strings.Repeat("d", 64)
		}
	}
	subjects["tamper_runtime_original_sha256"] = strings.Repeat("d", 64)
	subjects["tamper_runtime_mutated_sha256"] = strings.Repeat("e", 64)
	subjects["tamper_sidecar_original_sha256"] = strings.Repeat("f", 64)
	subjects["tamper_sidecar_mutated_sha256"] = strings.Repeat("1", 64)
	subjects[policy.DetailsSubject] = detailsSHA
	names := make([]string, 0, len(subjects))
	for name := range subjects {
		names = append(names, name)
	}
	sort.Strings(names)
	hashes := make([]SubjectHash, 0, len(names))
	for _, name := range names {
		hashes = append(hashes, SubjectHash{Name: name, SHA256: subjects[name]})
	}
	receipt := EvidenceReceipt{
		Schema: EvidenceSchemaV1, GateID: "packaged_blackbox", EvidenceKind: EvidencePackagedBlackbox,
		ReleaseCandidateID: candidateID, ProductBuild: build,
		Producer:    Producer{Name: policy.ProducerName, Version: policy.ProducerVersion},
		Environment: Environment{Class: string(EvidencePackagedBlackbox), OS: "windows-11", Architecture: "amd64", IdentitySHA256: environmentID},
		ObservedAt:  observedAt.UTC(), Status: "passed", SubjectHashes: hashes,
		DetailsPath: filepath.Base(detailsPath), DetailsSHA256: detailsSHA,
	}
	receiptPath := filepath.Join(root, "packaged.receipt.json")
	writeJSON(t, receiptPath, receipt)
	return receipt, receiptPath, detailsPath
}

func writeValidLocalSchedulerEvidence(t *testing.T, root, preparedLedgerSHA string, preparedAt, observedAt time.Time) string {
	t.Helper()
	details, receipt := validLocalSchedulerDetails(t)
	sourceRoot := details.Commands[0].WorkingDir
	for name := range releasetree.RootFiles() {
		value := name + "\n"
		if name == "go.mod" {
			value = "module github.com/djkim0320/Aether-claw\n"
		}
		if err := os.WriteFile(filepath.Join(sourceRoot, name), []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for name := range releasetree.RootDirectories() {
		if err := os.MkdirAll(filepath.Join(sourceRoot, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	sourceSeal, err := releasetree.Compute(sourceRoot)
	if err != nil {
		t.Fatal(err)
	}
	details.SourceTreeSHA256 = sourceSeal.SHA256
	details.SourceFileCount = sourceSeal.FileCount
	details.LedgerSHA256 = preparedLedgerSHA
	details.LedgerPreparedAt = preparedAt
	details.ObservationStartedAt = preparedAt.Add(time.Second)
	details.ObservationFinishedAt = observedAt
	for index := range details.Commands {
		details.Commands[index].StartedAt = details.ObservationStartedAt.Add(time.Duration(index) * time.Second)
		details.Commands[index].FinishedAt = details.Commands[index].StartedAt.Add(time.Second)
	}
	detailsRaw := marshalJSON(t, details)
	detailsDigest := sha256.Sum256(detailsRaw)
	detailsSHA := hex.EncodeToString(detailsDigest[:])
	detailsPath := filepath.Join(root, "scheduler.details.json")
	if err := os.WriteFile(detailsPath, detailsRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	receipt.ObservedAt = observedAt
	receipt.DetailsPath = filepath.Base(detailsPath)
	receipt.DetailsSHA256 = detailsSHA
	setTestSubject(&receipt, "prepared-ledger", preparedLedgerSHA)
	setTestSubject(&receipt, "local-gate-details", detailsSHA)
	setTestSubject(&receipt, "scheduler-recovery-receipt", detailsSHA)
	setTestSubject(&receipt, "source-tree", sourceSeal.SHA256)
	if err := receipt.Validate(); err != nil {
		t.Fatalf("constructed local scheduler receipt is invalid: %v", err)
	}
	receiptPath := filepath.Join(root, "scheduler.receipt.json")
	writeJSON(t, receiptPath, receipt)
	return receiptPath
}

func testBuild(prefix string) buildinfo.ProductBuildBinding {
	return buildinfo.ProductBuildBinding{
		Version: buildinfo.ReleaseProductVersion, ExecutableSHA256: strings.Repeat(prefix, 64),
		RuntimeManifestSHA256: strings.Repeat("b", 64), KnowledgeSidecarTreeSHA256: strings.Repeat("c", 64),
	}
}

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(marshalJSON(t, value)); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func writeJSONReplace(t *testing.T, path string, value any) {
	t.Helper()
	if err := os.WriteFile(path, marshalJSON(t, value), 0o600); err != nil {
		t.Fatal(err)
	}
}

func marshalJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return append(raw, '\n')
}
