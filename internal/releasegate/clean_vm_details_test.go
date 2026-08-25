package releasegate

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"github.com/djkim0320/AetherOps/internal/cleanvmcontract"
)

func TestCleanVMDetailsRejectWrongImmediatePredecessorAndSubjects(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*cleanVMVerifierFixture)
		want   string
	}{
		{"ledger_revision", func(value *cleanVMVerifierFixture) { value.preparedRevision++ }, "immediate attachment predecessor"},
		{"ledger_timestamp", func(value *cleanVMVerifierFixture) { value.preparedAt = value.preparedAt.Add(time.Second) }, "ledger timestamp"},
		{"prepared_ledger_subject", func(value *cleanVMVerifierFixture) {
			setTestSubject(&value.receipt, "prepared-ledger", strings.Repeat("f", 64))
		}, "subject set"},
		{"missing_observation_subject", func(value *cleanVMVerifierFixture) {
			for index, subject := range value.receipt.SubjectHashes {
				if subject.Name == "clean-vm-observation-graph_edit" {
					value.receipt.SubjectHashes = append(value.receipt.SubjectHashes[:index], value.receipt.SubjectHashes[index+1:]...)
					return
				}
			}
		}, "subject set"},
		{"excessive_subject", func(value *cleanVMVerifierFixture) {
			value.receipt.SubjectHashes = append(value.receipt.SubjectHashes, SubjectHash{Name: "manual-success", SHA256: strings.Repeat("e", 64)})
		}, "subject set"},
		{"different_host_reference", func(value *cleanVMVerifierFixture) {
			if err := os.WriteFile(filepath.Join(value.directory, value.details.HostReferenceFilename), []byte("{}\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		}, "build-host reference hash"},
		{"installer_changed", func(value *cleanVMVerifierFixture) {
			if err := os.WriteFile(filepath.Join(value.directory, value.details.Package.InstallerName), []byte("tampered-installer"), 0o600); err != nil {
				t.Fatal(err)
			}
		}, "changed after observation"},
		{"observation_changed", func(value *cleanVMVerifierFixture) {
			for _, artifact := range value.details.Artifacts {
				if artifact.Name == "solver_receipt" {
					if err := os.WriteFile(filepath.Join(value.directory, artifact.Filename), []byte("tampered-observation"), 0o600); err != nil {
						t.Fatal(err)
					}
					return
				}
			}
		}, "changed after observation"},
		{"environment_identity", func(value *cleanVMVerifierFixture) {
			value.receipt.Environment.IdentitySHA256 = strings.Repeat("0", 64)
		}, "environment identity"},
		{"reused_observation_file", func(value *cleanVMVerifierFixture) {
			value.details.Artifacts[1].Filename = value.details.Artifacts[0].Filename
			value.replaceDetails(t)
		}, "filename"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCleanVMVerifierFixture(t, cleanvmcontract.ScenarioInstaller)
			test.mutate(&fixture)
			err := validateCleanVMDetailsForLedger(
				fixture.raw, fixture.receipt, fixture.preparedRevision, fixture.preparedAt, fixture.directory,
			)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("clean VM mutation error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestCleanVMPolicyRejectsWrongProducerAndIncompleteSubjectSet(t *testing.T) {
	for _, gateID := range []string{"clean_vm_installer", "clean_vm_portable"} {
		t.Run(gateID, func(t *testing.T) {
			fixture := newCleanVMVerifierFixture(t, strings.TrimPrefix(gateID, "clean_vm_"))
			wrongProducer := fixture.receipt
			wrongProducer.Producer.Name = "manual"
			if err := wrongProducer.Validate(); err == nil || !strings.Contains(err.Error(), "producer") {
				t.Fatalf("wrong producer validation = %v", err)
			}
			missing := fixture.receipt
			missing.SubjectHashes = missing.SubjectHashes[:len(missing.SubjectHashes)-1]
			if err := missing.Validate(); err == nil || !strings.Contains(err.Error(), "missing required subject") {
				t.Fatalf("missing subject validation = %v", err)
			}
		})
	}
}

type cleanVMVerifierFixture struct {
	directory        string
	details          cleanvmcontract.Details
	raw              []byte
	receipt          EvidenceReceipt
	preparedRevision int
	preparedAt       time.Time
}

func (fixture *cleanVMVerifierFixture) replaceDetails(t *testing.T) {
	t.Helper()
	fixture.raw = mustJSON(t, fixture.details)
	digest := sha256.Sum256(fixture.raw)
	fixture.receipt.DetailsSHA256 = hex.EncodeToString(digest[:])
	setTestSubject(&fixture.receipt, "clean-vm-details", fixture.receipt.DetailsSHA256)
}

func newCleanVMVerifierFixture(t *testing.T, scenario string) cleanVMVerifierFixture {
	t.Helper()
	directory := t.TempDir()
	preparedAt := time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC)
	digest := func(char string) string { return strings.Repeat(char, 64) }
	build := buildinfo.ProductBuildBinding{
		Version: buildinfo.ReleaseProductVersion, ExecutableSHA256: digest("1"),
		RuntimeManifestSHA256: digest("2"), KnowledgeSidecarTreeSHA256: digest("3"),
	}
	candidateID, err := CandidateID(build)
	if err != nil {
		t.Fatal(err)
	}
	reference := cleanvmcontract.HostReference{
		Schema: cleanvmcontract.HostReferenceSchemaV1, ReleaseCandidateID: candidateID, ProductBuild: build,
		PreparedLedgerSHA256: digest("4"), PreparedLedgerRevision: 7, PreparedLedgerAt: preparedAt,
		SourceTreeSHA256: digest("5"), SourceTreeFiles: 100, MachineIdentitySHA256: digest("6"),
		OS: "windows-11", Architecture: "amd64", WindowsVersion: "10.0.26100", CapturedAt: preparedAt.Add(time.Minute),
	}
	referenceRaw := mustJSON(t, reference)
	referenceHash := sha256String(referenceRaw)
	writeFixtureFile(t, directory, "host-reference.json", referenceRaw)

	packageFiles := map[string][]byte{
		"AetherOps-0.1.0-alpha.1-windows-x64-setup.exe":    []byte("installer-package"),
		"AetherOps-0.1.0-alpha.1-windows-x64-portable.zip": []byte("portable-package"),
		"SHA256SUMS.txt":   []byte("package-manifest"),
		"research-v1.json": []byte("dataset"), "runner.json": []byte("runner"), "quality.json": []byte("quality"),
	}
	fileHash := map[string]string{}
	for name, raw := range packageFiles {
		writeFixtureFile(t, directory, name, raw)
		fileHash[name] = sha256String(raw)
	}

	started := preparedAt.Add(2 * time.Minute)
	finished := preparedAt.Add(12 * time.Minute)
	artifacts := make([]cleanvmcontract.ObservationArtifact, 0, len(cleanvmcontract.RequiredCheckIDs()))
	checks := make([]cleanvmcontract.OperationalCheck, 0, len(cleanvmcontract.RequiredCheckIDs()))
	artifactHashes := map[string]string{}
	for index, id := range cleanvmcontract.RequiredCheckIDs() {
		name := id + ".json"
		raw := []byte("observation:" + id + "\n")
		writeFixtureFile(t, directory, name, raw)
		hash := sha256String(raw)
		artifactHashes[id] = hash
		artifacts = append(artifacts, cleanvmcontract.ObservationArtifact{Name: id, Filename: name, SHA256: hash, Bytes: int64(len(raw))})
		checks = append(checks, cleanvmcontract.OperationalCheck{
			ID: id, Executed: true, Passed: true, ObservedAt: started.Add(time.Duration(index+1) * time.Second),
			ArtifactSHA256: hash, Evidence: "direct-product-and-filesystem-observation",
		})
	}
	gateID := "clean_vm_" + scenario
	details := cleanvmcontract.Details{
		Schema: cleanvmcontract.DetailsSchemaV1, GateID: gateID, Scenario: scenario,
		ReleaseCandidateID: candidateID, ProductBuild: build,
		PreparedLedgerSHA256: reference.PreparedLedgerSHA256, PreparedLedgerRevision: reference.PreparedLedgerRevision,
		HostReferenceSHA256: referenceHash, HostReferenceFilename: "host-reference.json", DatasetFilename: "research-v1.json",
		RunnerReceiptFilename: "runner.json", QualityReceiptFilename: "quality.json", SourceTreeSHA256: reference.SourceTreeSHA256,
		Environment: cleanvmcontract.VMEnvironment{
			OS: "windows-11", Architecture: "amd64", WindowsVersion: "10.0.26100", WindowsBuild: 26100,
			LogicalProcessors: 4, MachineIdentitySHA256: digest("7"), CurrentUserSIDHash: digest("8"),
			VMDetected: true, VirtualizationEvidence: []string{"firmware:microsoft-hyper-v"}, ObservedAt: started,
		},
		Package: cleanvmcontract.PackageObservation{
			ManifestName: "SHA256SUMS.txt", ManifestSHA256: fileHash["SHA256SUMS.txt"],
			InstallerName: "AetherOps-0.1.0-alpha.1-windows-x64-setup.exe", InstallerSHA256: fileHash["AetherOps-0.1.0-alpha.1-windows-x64-setup.exe"], InstallerBytes: int64(len(packageFiles["AetherOps-0.1.0-alpha.1-windows-x64-setup.exe"])),
			PortableName: "AetherOps-0.1.0-alpha.1-windows-x64-portable.zip", PortableSHA256: fileHash["AetherOps-0.1.0-alpha.1-windows-x64-portable.zip"], PortableBytes: int64(len(packageFiles["AetherOps-0.1.0-alpha.1-windows-x64-portable.zip"])),
			ObservedProductBuild: build, InstallExitCode: 0, PackageCommandSHA256: digest("9"), PortableTraversalSafe: true,
			NoPreexistingProduct: true, NoPreexistingData: true, NoPreexistingProfile: true,
		},
		Workflow: cleanvmcontract.WorkflowObservation{
			RunnerReceiptSHA256: fileHash["runner.json"], QualityReceiptSHA256: fileHash["quality.json"], EvalRunSetID: "eval-set",
			ProjectIDHash: digest("a"), ChatGPTAuthenticated: true, SuccessfulResearchRuns: 12, EngineeringRuns: 6,
			SolverReceiptSHA256: artifactHashes["solver_receipt"], RDFSnapshotSHA256: artifactHashes["rdf_import"],
			SPARQLResultSHA256: artifactHashes["sparql_read"], GraphEditEventSHA256: artifactHashes["graph_edit"],
			CASReadbackSHA256: digest("b"), DatabaseSHA256: digest("c"), StartedAt: started, FinishedAt: finished.Add(-time.Minute),
		},
		Restart: cleanvmcontract.RestartObservation{
			FirstPID: 100, RestartedPID: 101, DatabaseBeforeSHA256: digest("d"), DatabaseAfterSHA256: digest("e"),
			GraphHeadBefore: "generation", GraphHeadAfter: "generation", ProfileMarkerSHA256: digest("f"),
			AuthenticatedAfter: true, GraphReadableAfter: true, ObservedAt: finished.Add(-45 * time.Second),
		},
		UpdateQuarantine: cleanvmcontract.UpdateQuarantineObservation{
			CandidateID: "broken", CandidatePayloadSHA256: digest("0"), LastVerifiedRuntimeID: "stable", ActiveRuntimeAfter: "stable",
			Status: "quarantined", WarningCode: "probe_failed", WarningPersistedRestart: true, NoAutomaticRetry: true,
			ObservedAt: finished.Add(-30 * time.Second),
		},
		Uninstall: cleanvmcontract.UninstallObservation{
			DefaultExitCode: 0, ProgramRemoved: true, DataPreserved: true, ProfilePreserved: true,
			DataMarkerBeforeSHA256: digest("1"), DataMarkerAfterSHA256: digest("1"),
			ProfileMarkerBeforeSHA256: digest("2"), ProfileMarkerAfterSHA256: digest("2"),
			ReinstalledBeforePurge: true, PurgeExitCode: 0, ProgramRemovedAfterPurge: true,
			DataRemovedAfterPurge: true, ProfileRemovedAfterPurge: true,
			DefaultCommandSHA256: digest("3"), ExplicitPurgeCommandSHA256: digest("4"),
		},
		Artifacts: artifacts, Checks: checks, StartedAt: started, FinishedAt: finished,
		FixtureRole: "none-production-observation", CleanVMGateEligible: true,
		DoesNotProve: []string{"live_service_gate", "live_quality_gate", "production_update_feed_gate", "incompatible_hardware_gate"},
	}
	detailsRaw := mustJSON(t, details)
	detailsSHA := sha256String(detailsRaw)
	writeFixtureFile(t, directory, "clean.details.json", detailsRaw)

	wantSubjects := map[string]string{
		"aetherops.exe": build.ExecutableSHA256, "runtime-manifest.json": build.RuntimeManifestSHA256,
		"knowledge-sidecar-tree": build.KnowledgeSidecarTreeSHA256, "prepared-ledger": reference.PreparedLedgerSHA256,
		"source-tree": reference.SourceTreeSHA256, "clean-vm-details": detailsSHA, "build-host-reference": referenceHash,
		"installer-package": details.Package.InstallerSHA256, "portable-package": details.Package.PortableSHA256,
		"package-sha256-manifest": details.Package.ManifestSHA256, "evaluation-dataset": fileHash["research-v1.json"],
		"release-eval-runner-receipt": details.Workflow.RunnerReceiptSHA256,
		"release-evaluation-details":  details.Workflow.QualityReceiptSHA256,
	}
	for _, artifact := range artifacts {
		wantSubjects["clean-vm-observation-"+artifact.Name] = artifact.SHA256
	}
	subjects := make([]SubjectHash, 0, len(wantSubjects))
	for name, hash := range wantSubjects {
		subjects = append(subjects, SubjectHash{Name: name, SHA256: hash})
	}
	receipt := EvidenceReceipt{
		Schema: EvidenceSchemaV1, GateID: gateID, EvidenceKind: EvidenceCleanVM,
		ReleaseCandidateID: candidateID, ProductBuild: build,
		Producer: Producer{Name: cleanvmcontract.ProducerName, Version: cleanvmcontract.ProducerVersion},
		Environment: Environment{Class: string(EvidenceCleanVM), OS: "windows-11", Architecture: "amd64",
			IdentitySHA256: cleanVMEnvironmentIdentity(details.Environment, reference.MachineIdentitySHA256, scenario)},
		ObservedAt: finished, Status: "passed", SubjectHashes: subjects,
		DetailsPath: "clean.details.json", DetailsSHA256: detailsSHA,
	}
	return cleanVMVerifierFixture{
		directory: directory, details: details, raw: detailsRaw, receipt: receipt,
		preparedRevision: reference.PreparedLedgerRevision, preparedAt: preparedAt,
	}
}

func writeFixtureFile(t *testing.T, directory, name string, raw []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(directory, name), raw, 0o600); err != nil {
		t.Fatal(err)
	}
}
