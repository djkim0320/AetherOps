// Package cleanvmevidence defines the fail-closed, production evidence
// contract for the clean Windows 11 installer and portable release gates.
// It never treats protocol fixtures or operator-authored prose as successful
// observations.
package cleanvmcontract

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
)

const (
	HostReferenceSchemaV1 = "aetherops_clean_vm_host_reference_v1"
	DetailsSchemaV1       = "aetherops_clean_vm_details_v1"
	ProducerName          = "cmd/cleanvmevidence"
	ProducerVersion       = "1"
	ScenarioInstaller     = "installer"
	ScenarioPortable      = "portable"
	MaxObservationBytes   = 8 << 20
)

var requiredCheckIDs = []string{
	"clean_baseline",
	"package_hash_manifest",
	"install_or_extract",
	"candidate_identity",
	"chatgpt_oauth",
	"research_succeeded",
	"solver_receipt",
	"rdf_import",
	"sparql_read",
	"graph_edit",
	"restart_readback",
	"update_candidate_quarantined",
	"uninstall_preserves_data_profile",
	"explicit_purge_removes_data_profile",
}

var artifactNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)

type HostReference struct {
	Schema                 string                        `json:"schema"`
	ReleaseCandidateID     string                        `json:"release_candidate_id"`
	ProductBuild           buildinfo.ProductBuildBinding `json:"product_build"`
	PreparedLedgerSHA256   string                        `json:"prepared_ledger_sha256"`
	PreparedLedgerRevision int                           `json:"prepared_ledger_revision"`
	PreparedLedgerAt       time.Time                     `json:"prepared_ledger_at"`
	SourceTreeSHA256       string                        `json:"source_tree_sha256"`
	SourceTreeFiles        int                           `json:"source_tree_files"`
	MachineIdentitySHA256  string                        `json:"machine_identity_sha256"`
	OS                     string                        `json:"os"`
	Architecture           string                        `json:"architecture"`
	WindowsVersion         string                        `json:"windows_version"`
	CapturedAt             time.Time                     `json:"captured_at"`
}

type VMEnvironment struct {
	OS                     string    `json:"os"`
	Architecture           string    `json:"architecture"`
	WindowsVersion         string    `json:"windows_version"`
	WindowsBuild           uint32    `json:"windows_build"`
	LogicalProcessors      int       `json:"logical_processors"`
	MachineIdentitySHA256  string    `json:"machine_identity_sha256"`
	CurrentUserSIDHash     string    `json:"current_user_sid_sha256"`
	VMDetected             bool      `json:"vm_detected"`
	VirtualizationEvidence []string  `json:"virtualization_evidence"`
	ObservedAt             time.Time `json:"observed_at"`
}

type PackageObservation struct {
	ManifestName          string                        `json:"manifest_name"`
	ManifestSHA256        string                        `json:"manifest_sha256"`
	InstallerName         string                        `json:"installer_name"`
	InstallerSHA256       string                        `json:"installer_sha256"`
	InstallerBytes        int64                         `json:"installer_bytes"`
	PortableName          string                        `json:"portable_name"`
	PortableSHA256        string                        `json:"portable_sha256"`
	PortableBytes         int64                         `json:"portable_bytes"`
	ObservedProductBuild  buildinfo.ProductBuildBinding `json:"observed_product_build"`
	InstallExitCode       int                           `json:"install_exit_code"`
	PackageCommandSHA256  string                        `json:"package_command_sha256"`
	PortableTraversalSafe bool                          `json:"portable_traversal_safe"`
	NoPreexistingProduct  bool                          `json:"no_preexisting_product"`
	NoPreexistingData     bool                          `json:"no_preexisting_data"`
	NoPreexistingProfile  bool                          `json:"no_preexisting_profile"`
}

type WorkflowObservation struct {
	RunnerReceiptSHA256    string    `json:"runner_receipt_sha256"`
	QualityReceiptSHA256   string    `json:"quality_receipt_sha256"`
	EvalRunSetID           string    `json:"eval_run_set_id"`
	ProjectIDHash          string    `json:"project_id_sha256"`
	ChatGPTAuthenticated   bool      `json:"chatgpt_authenticated"`
	SuccessfulResearchRuns int       `json:"successful_research_runs"`
	EngineeringRuns        int       `json:"engineering_runs"`
	SolverReceiptSHA256    string    `json:"solver_receipt_sha256"`
	RDFSnapshotSHA256      string    `json:"rdf_snapshot_sha256"`
	SPARQLResultSHA256     string    `json:"sparql_result_sha256"`
	GraphEditEventSHA256   string    `json:"graph_edit_event_sha256"`
	CASReadbackSHA256      string    `json:"cas_readback_sha256"`
	DatabaseSHA256         string    `json:"database_sha256"`
	StartedAt              time.Time `json:"started_at"`
	FinishedAt             time.Time `json:"finished_at"`
}

type RestartObservation struct {
	FirstPID             int       `json:"first_pid"`
	RestartedPID         int       `json:"restarted_pid"`
	DatabaseBeforeSHA256 string    `json:"database_before_sha256"`
	DatabaseAfterSHA256  string    `json:"database_after_sha256"`
	GraphHeadBefore      string    `json:"graph_head_before"`
	GraphHeadAfter       string    `json:"graph_head_after"`
	ProfileMarkerSHA256  string    `json:"profile_marker_sha256"`
	AuthenticatedAfter   bool      `json:"authenticated_after_restart"`
	GraphReadableAfter   bool      `json:"graph_readable_after_restart"`
	ObservedAt           time.Time `json:"observed_at"`
}

type UpdateQuarantineObservation struct {
	CandidateID             string    `json:"candidate_id"`
	CandidatePayloadSHA256  string    `json:"candidate_payload_sha256"`
	LastVerifiedRuntimeID   string    `json:"last_verified_runtime_id"`
	ActiveRuntimeAfter      string    `json:"active_runtime_after"`
	Status                  string    `json:"status"`
	WarningCode             string    `json:"warning_code"`
	WarningPersistedRestart bool      `json:"warning_persisted_restart"`
	NoAutomaticRetry        bool      `json:"no_automatic_retry"`
	ObservedAt              time.Time `json:"observed_at"`
}

type UninstallObservation struct {
	DefaultExitCode            int    `json:"default_exit_code"`
	ProgramRemoved             bool   `json:"program_removed"`
	DataPreserved              bool   `json:"data_preserved"`
	ProfilePreserved           bool   `json:"profile_preserved"`
	DataMarkerBeforeSHA256     string `json:"data_marker_before_sha256"`
	DataMarkerAfterSHA256      string `json:"data_marker_after_sha256"`
	ProfileMarkerBeforeSHA256  string `json:"profile_marker_before_sha256"`
	ProfileMarkerAfterSHA256   string `json:"profile_marker_after_sha256"`
	ReinstalledBeforePurge     bool   `json:"reinstalled_before_purge"`
	PurgeExitCode              int    `json:"purge_exit_code"`
	ProgramRemovedAfterPurge   bool   `json:"program_removed_after_purge"`
	DataRemovedAfterPurge      bool   `json:"data_removed_after_purge"`
	ProfileRemovedAfterPurge   bool   `json:"profile_removed_after_purge"`
	DefaultCommandSHA256       string `json:"default_command_sha256"`
	ExplicitPurgeCommandSHA256 string `json:"explicit_purge_command_sha256"`
}

type ObservationArtifact struct {
	Name     string `json:"name"`
	Filename string `json:"filename"`
	SHA256   string `json:"sha256"`
	Bytes    int64  `json:"bytes"`
}

type OperationalCheck struct {
	ID             string    `json:"id"`
	Executed       bool      `json:"executed"`
	Passed         bool      `json:"passed"`
	ObservedAt     time.Time `json:"observed_at"`
	ArtifactSHA256 string    `json:"artifact_sha256"`
	Evidence       string    `json:"evidence"`
	Blocker        string    `json:"blocker,omitempty"`
}

type Details struct {
	Schema                 string                        `json:"schema"`
	GateID                 string                        `json:"gate_id"`
	Scenario               string                        `json:"scenario"`
	ReleaseCandidateID     string                        `json:"release_candidate_id"`
	ProductBuild           buildinfo.ProductBuildBinding `json:"product_build"`
	PreparedLedgerSHA256   string                        `json:"prepared_ledger_sha256"`
	PreparedLedgerRevision int                           `json:"prepared_ledger_revision"`
	HostReferenceSHA256    string                        `json:"host_reference_sha256"`
	HostReferenceFilename  string                        `json:"host_reference_filename"`
	DatasetFilename        string                        `json:"dataset_filename"`
	RunnerReceiptFilename  string                        `json:"runner_receipt_filename"`
	QualityReceiptFilename string                        `json:"quality_receipt_filename"`
	SourceTreeSHA256       string                        `json:"source_tree_sha256"`
	Environment            VMEnvironment                 `json:"environment"`
	Package                PackageObservation            `json:"package"`
	Workflow               WorkflowObservation           `json:"workflow"`
	Restart                RestartObservation            `json:"restart"`
	UpdateQuarantine       UpdateQuarantineObservation   `json:"update_quarantine"`
	Uninstall              UninstallObservation          `json:"uninstall"`
	Artifacts              []ObservationArtifact         `json:"artifacts"`
	Checks                 []OperationalCheck            `json:"checks"`
	StartedAt              time.Time                     `json:"started_at"`
	FinishedAt             time.Time                     `json:"finished_at"`
	FixtureRole            string                        `json:"fixture_role"`
	CleanVMGateEligible    bool                          `json:"clean_vm_gate_eligible"`
	DoesNotProve           []string                      `json:"does_not_prove"`
}

func RequiredCheckIDs() []string { return append([]string(nil), requiredCheckIDs...) }

func (reference HostReference) Validate() error {
	if reference.Schema != HostReferenceSchemaV1 || reference.CapturedAt.IsZero() || reference.PreparedLedgerAt.IsZero() ||
		reference.CapturedAt.Before(reference.PreparedLedgerAt) || reference.PreparedLedgerRevision < 1 {
		return errors.New("clean VM host reference schema, revision, and timestamp are required")
	}
	if err := reference.ProductBuild.Validate(); err != nil {
		return fmt.Errorf("host reference product build: %w", err)
	}
	if !validDigest(reference.ReleaseCandidateID) || !validDigest(reference.PreparedLedgerSHA256) ||
		!validDigest(reference.SourceTreeSHA256) || reference.SourceTreeFiles <= 0 || !validDigest(reference.MachineIdentitySHA256) {
		return errors.New("clean VM host reference candidate, ledger, source seal, or machine identity is invalid")
	}
	if reference.OS != "windows-11" || reference.Architecture != "amd64" || strings.TrimSpace(reference.WindowsVersion) == "" {
		return errors.New("clean VM host reference must describe Windows 11 x64")
	}
	return nil
}

func (details Details) Validate(reference HostReference) error {
	if err := reference.Validate(); err != nil {
		return err
	}
	if details.Schema != DetailsSchemaV1 || details.GateID != gateIDForScenario(details.Scenario) ||
		details.ReleaseCandidateID != reference.ReleaseCandidateID || details.ProductBuild != reference.ProductBuild ||
		details.PreparedLedgerSHA256 != reference.PreparedLedgerSHA256 || details.PreparedLedgerRevision != reference.PreparedLedgerRevision ||
		details.SourceTreeSHA256 != reference.SourceTreeSHA256 || !validDigest(details.HostReferenceSHA256) {
		return errors.New("clean VM details are not bound to the host reference and exact candidate")
	}
	for _, name := range []string{details.HostReferenceFilename, details.DatasetFilename, details.RunnerReceiptFilename, details.QualityReceiptFilename} {
		if !siblingFilename(name) {
			return errors.New("clean VM authenticated input filename is not a direct sibling")
		}
	}
	if details.StartedAt.IsZero() || details.FinishedAt.IsZero() || !details.FinishedAt.After(details.StartedAt) ||
		details.StartedAt.Before(reference.CapturedAt) {
		return errors.New("clean VM campaign time bounds are invalid")
	}
	if details.FixtureRole != "none-production-observation" || !details.CleanVMGateEligible {
		return errors.New("fixture or ineligible clean VM observation cannot pass a release gate")
	}
	if err := validateEnvironment(details.Environment, reference, details.StartedAt, details.FinishedAt); err != nil {
		return err
	}
	if err := validatePackage(details.Package, details.ProductBuild); err != nil {
		return err
	}
	if err := validateWorkflow(details.Workflow, details.StartedAt, details.FinishedAt); err != nil {
		return err
	}
	if err := validateRestart(details.Restart, details.StartedAt, details.FinishedAt); err != nil {
		return err
	}
	if err := validateUpdate(details.UpdateQuarantine, details.StartedAt, details.FinishedAt); err != nil {
		return err
	}
	if err := validateUninstall(details.Uninstall); err != nil {
		return err
	}
	artifactHashes := make(map[string]string, len(details.Artifacts))
	artifactNames := make(map[string]struct{}, len(details.Artifacts))
	artifactFiles := make(map[string]struct{}, len(details.Artifacts))
	uniqueHashes := make(map[string]struct{}, len(details.Artifacts))
	for _, artifact := range details.Artifacts {
		if !artifactNamePattern.MatchString(artifact.Name) || strings.TrimSpace(artifact.Filename) == "" ||
			!validDigest(artifact.SHA256) || artifact.Bytes <= 0 || artifact.Bytes > MaxObservationBytes {
			return errors.New("clean VM observation artifact is incomplete")
		}
		if _, exists := artifactNames[artifact.Name]; exists {
			return fmt.Errorf("clean VM artifact name %q is duplicated", artifact.Name)
		}
		if _, exists := artifactFiles[strings.ToLower(artifact.Filename)]; exists {
			return fmt.Errorf("clean VM artifact filename %q is duplicated", artifact.Filename)
		}
		if _, exists := uniqueHashes[artifact.SHA256]; exists {
			return fmt.Errorf("clean VM artifact hash for %q is reused", artifact.Name)
		}
		artifactNames[artifact.Name] = struct{}{}
		artifactFiles[strings.ToLower(artifact.Filename)] = struct{}{}
		uniqueHashes[artifact.SHA256] = struct{}{}
		artifactHashes[artifact.Name] = artifact.SHA256
	}
	if len(details.Artifacts) != len(requiredCheckIDs) {
		return fmt.Errorf("clean VM campaign has %d artifacts, want exactly %d", len(details.Artifacts), len(requiredCheckIDs))
	}
	for _, id := range requiredCheckIDs {
		if _, ok := artifactNames[id]; !ok {
			return fmt.Errorf("clean VM campaign is missing observation artifact %q", id)
		}
	}
	if err := validateChecks(details.Checks, artifactHashes, details.StartedAt, details.FinishedAt); err != nil {
		return err
	}
	for id, digest := range map[string]string{
		"solver_receipt": details.Workflow.SolverReceiptSHA256,
		"rdf_import":     details.Workflow.RDFSnapshotSHA256,
		"sparql_read":    details.Workflow.SPARQLResultSHA256,
		"graph_edit":     details.Workflow.GraphEditEventSHA256,
	} {
		if artifactHashes[id] != digest {
			return fmt.Errorf("clean VM %s typed readback is not bound to its retained artifact", id)
		}
	}
	requiredLimits := []string{"live_service_gate", "live_quality_gate", "production_update_feed_gate", "incompatible_hardware_gate"}
	if !sameStringSet(details.DoesNotProve, requiredLimits) {
		return errors.New("clean VM evidence limits are incomplete")
	}
	return nil
}

func validateEnvironment(environment VMEnvironment, reference HostReference, started, finished time.Time) error {
	if environment.OS != "windows-11" || environment.Architecture != "amd64" || environment.WindowsBuild < 22000 ||
		strings.TrimSpace(environment.WindowsVersion) == "" || environment.LogicalProcessors < 1 ||
		!validDigest(environment.MachineIdentitySHA256) || !validDigest(environment.CurrentUserSIDHash) ||
		environment.MachineIdentitySHA256 == reference.MachineIdentitySHA256 || !environment.VMDetected ||
		len(environment.VirtualizationEvidence) == 0 || environment.ObservedAt.Before(started) || environment.ObservedAt.After(finished) {
		return errors.New("campaign does not prove a distinct virtualized Windows 11 x64 environment")
	}
	seen := map[string]struct{}{}
	for _, value := range environment.VirtualizationEvidence {
		value = strings.TrimSpace(value)
		if value == "" {
			return errors.New("virtualization evidence contains an empty signal")
		}
		if _, duplicate := seen[value]; duplicate {
			return errors.New("virtualization evidence contains a duplicate signal")
		}
		seen[value] = struct{}{}
	}
	return nil
}

func validatePackage(observation PackageObservation, build buildinfo.ProductBuildBinding) error {
	wantPrefix := "AetherOps-" + buildinfo.ReleaseProductVersion + "-windows-x64-"
	if observation.ManifestName != "SHA256SUMS.txt" || !validDigest(observation.ManifestSHA256) || !validDigest(observation.InstallerSHA256) ||
		!validDigest(observation.PortableSHA256) || !validDigest(observation.PackageCommandSHA256) ||
		observation.InstallerBytes <= 0 || observation.PortableBytes <= 0 ||
		observation.InstallerName != wantPrefix+"setup.exe" || observation.PortableName != wantPrefix+"portable.zip" ||
		observation.ObservedProductBuild != build || observation.InstallExitCode != 0 ||
		!observation.PortableTraversalSafe || !observation.NoPreexistingProduct ||
		!observation.NoPreexistingData || !observation.NoPreexistingProfile {
		return errors.New("clean VM package observation is incomplete or failed")
	}
	return nil
}

func validateWorkflow(value WorkflowObservation, started, finished time.Time) error {
	for _, digest := range []string{value.RunnerReceiptSHA256, value.QualityReceiptSHA256, value.ProjectIDHash,
		value.SolverReceiptSHA256, value.RDFSnapshotSHA256, value.SPARQLResultSHA256,
		value.GraphEditEventSHA256, value.CASReadbackSHA256, value.DatabaseSHA256} {
		if !validDigest(digest) {
			return errors.New("clean VM workflow has an invalid evidence digest")
		}
	}
	if strings.TrimSpace(value.EvalRunSetID) == "" || !value.ChatGPTAuthenticated ||
		value.SuccessfulResearchRuns < 12 || value.EngineeringRuns < 6 ||
		value.StartedAt.Before(started) || value.FinishedAt.After(finished) || !value.FinishedAt.After(value.StartedAt) {
		return errors.New("clean VM workflow did not prove live auth, research, engineering, and graph operations")
	}
	return nil
}

func validateRestart(value RestartObservation, started, finished time.Time) error {
	if value.FirstPID <= 0 || value.RestartedPID <= 0 || value.FirstPID == value.RestartedPID ||
		!validDigest(value.DatabaseBeforeSHA256) || !validDigest(value.DatabaseAfterSHA256) ||
		!validDigest(value.ProfileMarkerSHA256) || strings.TrimSpace(value.GraphHeadBefore) == "" ||
		value.GraphHeadBefore != value.GraphHeadAfter || !value.AuthenticatedAfter || !value.GraphReadableAfter ||
		value.ObservedAt.Before(started) || value.ObservedAt.After(finished) {
		return errors.New("clean VM restart readback is incomplete")
	}
	return nil
}

func validateUpdate(value UpdateQuarantineObservation, started, finished time.Time) error {
	if strings.TrimSpace(value.CandidateID) == "" || !validDigest(value.CandidatePayloadSHA256) ||
		strings.TrimSpace(value.LastVerifiedRuntimeID) == "" || value.ActiveRuntimeAfter != value.LastVerifiedRuntimeID ||
		value.Status != "quarantined" || strings.TrimSpace(value.WarningCode) == "" ||
		!value.WarningPersistedRestart || !value.NoAutomaticRetry ||
		value.ObservedAt.Before(started) || value.ObservedAt.After(finished) {
		return errors.New("clean VM update quarantine behavior is incomplete")
	}
	return nil
}

func validateUninstall(value UninstallObservation) error {
	for _, digest := range []string{value.DataMarkerBeforeSHA256, value.DataMarkerAfterSHA256,
		value.ProfileMarkerBeforeSHA256, value.ProfileMarkerAfterSHA256,
		value.DefaultCommandSHA256, value.ExplicitPurgeCommandSHA256} {
		if !validDigest(digest) {
			return errors.New("clean VM uninstall observation has an invalid digest")
		}
	}
	if value.DefaultExitCode != 0 || !value.ProgramRemoved || !value.DataPreserved || !value.ProfilePreserved ||
		value.DataMarkerBeforeSHA256 != value.DataMarkerAfterSHA256 ||
		value.ProfileMarkerBeforeSHA256 != value.ProfileMarkerAfterSHA256 ||
		!value.ReinstalledBeforePurge || value.PurgeExitCode != 0 || !value.ProgramRemovedAfterPurge ||
		!value.DataRemovedAfterPurge || !value.ProfileRemovedAfterPurge {
		return errors.New("clean VM uninstall did not prove default preservation and explicit purge")
	}
	return nil
}

func validateChecks(checks []OperationalCheck, artifacts map[string]string, started, finished time.Time) error {
	if len(checks) != len(requiredCheckIDs) {
		return fmt.Errorf("clean VM campaign has %d operational checks, want %d", len(checks), len(requiredCheckIDs))
	}
	want := make(map[string]struct{}, len(requiredCheckIDs))
	for _, id := range requiredCheckIDs {
		want[id] = struct{}{}
	}
	seen := make(map[string]struct{}, len(checks))
	for _, check := range checks {
		if _, required := want[check.ID]; !required {
			return fmt.Errorf("clean VM campaign contains unknown check %q", check.ID)
		}
		if _, duplicate := seen[check.ID]; duplicate {
			return fmt.Errorf("clean VM campaign duplicates check %q", check.ID)
		}
		seen[check.ID] = struct{}{}
		if !check.Executed || !check.Passed || strings.TrimSpace(check.Evidence) == "" ||
			strings.TrimSpace(check.Blocker) != "" || check.ObservedAt.Before(started) || check.ObservedAt.After(finished) {
			return fmt.Errorf("clean VM check %q was not a successful production observation", check.ID)
		}
		if artifacts[check.ID] != check.ArtifactSHA256 {
			return fmt.Errorf("clean VM check %q is not bound to a retained observation artifact", check.ID)
		}
	}
	return nil
}

func gateIDForScenario(scenario string) string {
	switch scenario {
	case ScenarioInstaller:
		return "clean_vm_installer"
	case ScenarioPortable:
		return "clean_vm_portable"
	default:
		return ""
	}
}

func validDigest(value string) bool {
	if len(value) != 64 || value != strings.ToLower(value) {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

func sameStringSet(actual, expected []string) bool {
	left := append([]string(nil), actual...)
	right := append([]string(nil), expected...)
	sort.Strings(left)
	sort.Strings(right)
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func siblingFilename(value string) bool {
	return value != "" && value != "." && value != ".." && !strings.ContainsAny(value, `/\\:`) && strings.TrimSpace(value) == value
}
