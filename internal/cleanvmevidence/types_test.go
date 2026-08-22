package cleanvmevidence

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/evalrunner"
)

func TestDetailsRejectsIneligibleOrIncompleteCampaigns(t *testing.T) {
	reference, baseline := rejectionFixture()
	tests := []struct {
		name   string
		mutate func(*Details)
		want   string
	}{
		{"same_build_host", func(value *Details) { value.Environment.MachineIdentitySHA256 = reference.MachineIdentitySHA256 }, "distinct virtualized"},
		{"not_vm", func(value *Details) { value.Environment.VMDetected = false }, "distinct virtualized"},
		{"fixture", func(value *Details) { value.FixtureRole = "protocol-fixture" }, "fixture or ineligible"},
		{"missing_check", func(value *Details) { value.Checks = value.Checks[:len(value.Checks)-1] }, "operational checks"},
		{"failed_check", func(value *Details) { value.Checks[0].Passed = false }, "not a successful production"},
		{"unretained_check", func(value *Details) { value.Checks[0].ArtifactSHA256 = strings.Repeat("f", 64) }, "retained observation"},
		{"no_auth", func(value *Details) { value.Workflow.ChatGPTAuthenticated = false }, "live auth"},
		{"partial_eval", func(value *Details) { value.Workflow.SuccessfulResearchRuns = 11 }, "live auth"},
		{"no_graph_restart", func(value *Details) { value.Restart.GraphReadableAfter = false }, "restart readback"},
		{"update_retry", func(value *Details) { value.UpdateQuarantine.NoAutomaticRetry = false }, "update quarantine"},
		{"default_deleted_data", func(value *Details) { value.Uninstall.DataPreserved = false }, "default preservation"},
		{"purge_kept_profile", func(value *Details) { value.Uninstall.ProfileRemovedAfterPurge = false }, "explicit purge"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := cloneDetails(t, baseline)
			test.mutate(&value)
			if err := value.Validate(reference); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("rejection error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestHostReferenceRejectsRawOrIncompleteIdentityBinding(t *testing.T) {
	reference, _ := rejectionFixture()
	for name, mutate := range map[string]func(*HostReference){
		"schema": func(value *HostReference) { value.Schema = "retired" },
		"ledger": func(value *HostReference) { value.PreparedLedgerSHA256 = "MachineGuid=secret" },
		"source": func(value *HostReference) { value.SourceTreeFiles = 0 },
		"os":     func(value *HostReference) { value.OS = "windows-10" },
	} {
		t.Run(name, func(t *testing.T) {
			value := reference
			mutate(&value)
			if err := value.Validate(); err == nil {
				t.Fatal("invalid host reference was accepted")
			}
		})
	}
}

func TestPackageManifestRejectsAdditionalOrChangedArtifacts(t *testing.T) {
	root := t.TempDir()
	installer := filepath.Join(root, "setup.exe")
	portable := filepath.Join(root, "portable.zip")
	if err := os.WriteFile(installer, []byte("installer"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(portable, []byte("portable"), 0o600); err != nil {
		t.Fatal(err)
	}
	installerHash, _, _ := hashRegularFile(installer, 1024)
	portableHash, _, _ := hashRegularFile(portable, 1024)
	for name, content := range map[string]string{
		"extra":     installerHash + "  setup.exe\n" + portableHash + "  portable.zip\n" + strings.Repeat("a", 64) + "  extra.bin\n",
		"changed":   strings.Repeat("b", 64) + "  setup.exe\n" + portableHash + "  portable.zip\n",
		"duplicate": installerHash + "  setup.exe\n" + installerHash + "  setup.exe\n",
	} {
		t.Run(name, func(t *testing.T) {
			manifest := filepath.Join(root, name+".txt")
			if err := os.WriteFile(manifest, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := verifyPackageManifest(manifest, installer, installerHash, portable, portableHash); err == nil {
				t.Fatal("invalid package manifest was accepted")
			}
		})
	}
}

func TestPortableBindingRejectsTraversalBeforeCandidateReadback(t *testing.T) {
	path := filepath.Join(t.TempDir(), "portable.zip")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	entry, err := writer.Create("../escape.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write([]byte("escape")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := bindPortableBuild(path); err == nil || !strings.Contains(err.Error(), "unsafe path") {
		t.Fatalf("traversal rejection = %v", err)
	}
}

func TestTypedWorkflowArtifactsRejectSelfDeclaredSuccess(t *testing.T) {
	runner := evalrunner.Receipt{Cases: []evalrunner.CaseReceipt{{DatasetCaseID: "engineering-01", RunID: "run-1"}}}
	for name, validate := range map[string]func() error{
		"solver": func() error {
			return validateSolverReceipt([]byte(`{"schema":1,"job_id":"job","run_id":"run-1","stage_attempt_id":"attempt","operation":"su2_naca0012","spec":{},"spec_sha256":"`+strings.Repeat("a", 64)+`","executables":[],"threads":4,"started_at":"2026-08-09T00:00:00Z","completed_at":"2026-08-09T00:01:00Z","exit_codes":[0,0],"executed":true,"numerically_valid":true,"metrics":{"cl":0.3},"artifacts":[]}`), runner)
		},
		"rdf": func() error {
			return validateRDFSnapshotReceipt([]byte(`{"id":"snapshot","blob_hash":"` + strings.Repeat("a", 64) + `","dataset_sha256":"` + strings.Repeat("a", 64) + `","triple_count":0}`))
		},
		"sparql": func() error {
			return validateSPARQLResult([]byte(`{"query_form":"SELECT","complete":false,"result":{"head":{}}}`))
		},
		"graph": func() error {
			return validateGraphEditEvent([]byte(`{"sequence":1,"id":"event","project_id":"project","generation_id":"generation","kind":"add_entity","actor":"model","payload":{},"payload_sha256":"`+strings.Repeat("b", 64)+`","event_sha256":"`+strings.Repeat("c", 64)+`","created_at":"2026-08-09T00:00:00Z"}`), sha256Hex([]byte("project")))
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := validate(); err == nil {
				t.Fatal("self-declared or incomplete typed artifact was accepted")
			}
		})
	}
}

func rejectionFixture() (HostReference, Details) {
	now := time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC)
	digest := func(char string) string { return strings.Repeat(char, 64) }
	build := buildinfo.ProductBuildBinding{
		Version: buildinfo.ReleaseProductVersion, ExecutableSHA256: digest("1"),
		RuntimeManifestSHA256: digest("2"), KnowledgeSidecarTreeSHA256: digest("3"),
	}
	reference := HostReference{
		Schema: HostReferenceSchemaV1, ReleaseCandidateID: digest("4"), ProductBuild: build,
		PreparedLedgerSHA256: digest("5"), PreparedLedgerRevision: 7, PreparedLedgerAt: now.Add(-time.Minute), SourceTreeSHA256: digest("6"),
		SourceTreeFiles: 100, MachineIdentitySHA256: digest("7"), OS: "windows-11", Architecture: "amd64",
		WindowsVersion: "10.0.26100", CapturedAt: now,
	}
	artifacts := make([]ObservationArtifact, len(requiredCheckIDs))
	checks := make([]OperationalCheck, len(requiredCheckIDs))
	for index, id := range requiredCheckIDs {
		hash := strings.Repeat(fmt.Sprintf("%x", index+1), 64)
		artifacts[index] = ObservationArtifact{Name: id, Filename: id + ".json", SHA256: hash, Bytes: 100}
		checks[index] = OperationalCheck{ID: id, Executed: true, Passed: true, ObservedAt: now.Add(2 * time.Hour), ArtifactSHA256: hash, Evidence: "typed direct observation"}
	}
	artifactHash := func(id string) string {
		for _, artifact := range artifacts {
			if artifact.Name == id {
				return artifact.SHA256
			}
		}
		panic("missing fixture artifact")
	}
	details := Details{
		Schema: DetailsSchemaV1, GateID: "clean_vm_installer", Scenario: ScenarioInstaller,
		ReleaseCandidateID: reference.ReleaseCandidateID, ProductBuild: build,
		PreparedLedgerSHA256: reference.PreparedLedgerSHA256, PreparedLedgerRevision: reference.PreparedLedgerRevision,
		HostReferenceSHA256: digest("8"), HostReferenceFilename: "host-reference.json", DatasetFilename: "research-v1.json",
		RunnerReceiptFilename: "runner.json", QualityReceiptFilename: "quality.json", SourceTreeSHA256: reference.SourceTreeSHA256,
		Environment: VMEnvironment{OS: "windows-11", Architecture: "amd64", WindowsVersion: "10.0.26100", WindowsBuild: 26100,
			LogicalProcessors: 4, MachineIdentitySHA256: digest("9"), CurrentUserSIDHash: digest("a"), VMDetected: true,
			VirtualizationEvidence: []string{"firmware:microsoft-hyper-v"}, ObservedAt: now.Add(time.Hour)},
		Package: PackageObservation{ManifestName: "SHA256SUMS.txt", ManifestSHA256: digest("b"), InstallerName: "AetherOps-0.1.0-alpha.1-windows-x64-setup.exe", InstallerSHA256: digest("c"), InstallerBytes: 100,
			PortableName: "AetherOps-0.1.0-alpha.1-windows-x64-portable.zip", PortableSHA256: digest("d"), PortableBytes: 100, ObservedProductBuild: build,
			InstallExitCode: 0, PackageCommandSHA256: digest("e"), PortableTraversalSafe: true,
			NoPreexistingProduct: true, NoPreexistingData: true, NoPreexistingProfile: true},
		Workflow: WorkflowObservation{RunnerReceiptSHA256: digest("f"), QualityReceiptSHA256: digest("0"), EvalRunSetID: "eval-1",
			ProjectIDHash: digest("1"), ChatGPTAuthenticated: true, SuccessfulResearchRuns: 12, EngineeringRuns: 6,
			SolverReceiptSHA256: artifactHash("solver_receipt"), RDFSnapshotSHA256: artifactHash("rdf_import"), SPARQLResultSHA256: artifactHash("sparql_read"),
			GraphEditEventSHA256: artifactHash("graph_edit"), CASReadbackSHA256: digest("6"), DatabaseSHA256: digest("7"),
			StartedAt: now.Add(time.Hour), FinishedAt: now.Add(3 * time.Hour)},
		Restart: RestartObservation{FirstPID: 100, RestartedPID: 101, DatabaseBeforeSHA256: digest("8"), DatabaseAfterSHA256: digest("9"),
			GraphHeadBefore: "generation-1", GraphHeadAfter: "generation-1", ProfileMarkerSHA256: digest("a"),
			AuthenticatedAfter: true, GraphReadableAfter: true, ObservedAt: now.Add(3 * time.Hour)},
		UpdateQuarantine: UpdateQuarantineObservation{CandidateID: "broken-runtime", CandidatePayloadSHA256: digest("b"),
			LastVerifiedRuntimeID: "stable-1", ActiveRuntimeAfter: "stable-1", Status: "quarantined", WarningCode: "candidate_probe_failed",
			WarningPersistedRestart: true, NoAutomaticRetry: true, ObservedAt: now.Add(4 * time.Hour)},
		Uninstall: UninstallObservation{DefaultExitCode: 0, ProgramRemoved: true, DataPreserved: true, ProfilePreserved: true,
			DataMarkerBeforeSHA256: digest("c"), DataMarkerAfterSHA256: digest("c"), ProfileMarkerBeforeSHA256: digest("d"), ProfileMarkerAfterSHA256: digest("d"),
			ReinstalledBeforePurge: true, PurgeExitCode: 0, ProgramRemovedAfterPurge: true, DataRemovedAfterPurge: true,
			ProfileRemovedAfterPurge: true, DefaultCommandSHA256: digest("e"), ExplicitPurgeCommandSHA256: digest("f")},
		Artifacts: artifacts, Checks: checks, StartedAt: now.Add(30 * time.Minute), FinishedAt: now.Add(5 * time.Hour),
		FixtureRole: "none-production-observation", CleanVMGateEligible: true,
		DoesNotProve: []string{"live_service_gate", "live_quality_gate", "production_update_feed_gate", "incompatible_hardware_gate"},
	}
	return reference, details
}

func cloneDetails(t *testing.T, value Details) Details {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var clone Details
	if err := json.Unmarshal(raw, &clone); err != nil {
		t.Fatal(err)
	}
	return clone
}
