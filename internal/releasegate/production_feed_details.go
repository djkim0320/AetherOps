package releasegate

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	managedruntime "github.com/djkim0320/AetherOps/internal/runtime"
)

const (
	ProductionFeedDetailsSchemaV1   = "aetherops_production_update_feed_details_v1"
	productionFeedEnvironmentDomain = "aetherops-production-feed-environment-v1\x00"
)

var productionReleaseIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

type ProductionFeedEnvironment struct {
	OS                  string `json:"os"`
	Architecture        string `json:"architecture"`
	GoVersion           string `json:"go_version"`
	LogicalProcessors   int    `json:"logical_processors"`
	ProcessorIdentifier string `json:"processor_identifier,omitempty"`
	WindowsVersion      string `json:"windows_version"`
}

type ProductionFeedTrustObservation struct {
	DiagnosticSchema       string `json:"diagnostic_schema"`
	Configured             bool   `json:"configured"`
	KeyID                  string `json:"key_id"`
	FeedURLSHA256          string `json:"feed_url_sha256"`
	PublicKeySHA256        string `json:"public_key_sha256"`
	DiagnosticOutputSHA256 string `json:"diagnostic_output_sha256"`
	BuildMode              string `json:"build_mode"`
}

type ProductionFeedComponentObservation struct {
	Component                string `json:"component"`
	Version                  string `json:"version"`
	PayloadSHA256            string `json:"payload_sha256"`
	RuntimeTreeSHA256        string `json:"runtime_tree_sha256"`
	AttestationSHA256        string `json:"attestation_sha256"`
	NPMPackage               string `json:"npm_package,omitempty"`
	NPMIntegrity             string `json:"npm_integrity,omitempty"`
	NPMIntegrityVerified     bool   `json:"npm_integrity_verified"`
	SignatureReauthenticated bool   `json:"signature_reauthenticated"`
}

type ProductionFeedLifecycleObservation struct {
	CandidateID                 string                       `json:"candidate_id"`
	StageStartedAt              time.Time                    `json:"stage_started_at"`
	StageFinishedAt             time.Time                    `json:"stage_finished_at"`
	StatusAfterStage            string                       `json:"status_after_stage"`
	PendingRestartID            string                       `json:"pending_restart_id"`
	ManagerReopenedForRestart   bool                         `json:"manager_reopened_for_restart"`
	UpdaterStartupActivation    bool                         `json:"updater_startup_activation"`
	ActivationStartedAt         time.Time                    `json:"activation_started_at"`
	ActivationFinishedAt        time.Time                    `json:"activation_finished_at"`
	StatusAfterActivation       string                       `json:"status_after_activation"`
	ActiveCandidateID           string                       `json:"active_candidate_id"`
	ActivePointerSHA256         string                       `json:"active_pointer_sha256"`
	ProcessPathsReadback        bool                         `json:"process_paths_readback"`
	BrowserEndpointSHA256       string                       `json:"browser_endpoint_sha256"`
	IsolatedRuntimeRoot         bool                         `json:"isolated_runtime_root"`
	TemporaryRuntimeRootRemoved bool                         `json:"temporary_runtime_root_removed"`
	AppServerProbe              managedruntime.ProbeEvidence `json:"app_server_probe"`
	BrowserProbe                managedruntime.ProbeEvidence `json:"browser_probe"`
}

type ProductionFeedEvidenceLimits struct {
	ReleaseGateEligible bool     `json:"release_gate_eligible"`
	FixtureRole         string   `json:"fixture_role"`
	EvidenceScope       []string `json:"evidence_scope"`
	ExcludedClaims      []string `json:"excluded_claims"`
}

// ProductionFeedDetails is emitted only by the production feed evidence
// executable after a public-host system-TLS fetch, real downloads, live
// compatibility probes, and a second Manager instance activating the pending
// candidate. Unit fixtures are not eligible to construct a passing receipt.
type ProductionFeedDetails struct {
	Schema                 string                               `json:"schema"`
	ReleaseCandidateID     string                               `json:"release_candidate_id"`
	PreparedLedgerSHA256   string                               `json:"prepared_ledger_sha256"`
	PreparedLedgerRevision int                                  `json:"prepared_ledger_revision"`
	LedgerPreparedAt       time.Time                            `json:"ledger_prepared_at"`
	ObservationStartedAt   time.Time                            `json:"observation_started_at"`
	ObservationFinishedAt  time.Time                            `json:"observation_finished_at"`
	CandidateBefore        buildinfo.ProductBuildBinding        `json:"candidate_before"`
	CandidateAfter         buildinfo.ProductBuildBinding        `json:"candidate_after"`
	Environment            ProductionFeedEnvironment            `json:"environment"`
	Trust                  ProductionFeedTrustObservation       `json:"trust"`
	Feed                   managedruntime.FeedObservation       `json:"feed"`
	Lifecycle              ProductionFeedLifecycleObservation   `json:"lifecycle"`
	Components             []ProductionFeedComponentObservation `json:"components"`
	EvidenceLimits         ProductionFeedEvidenceLimits         `json:"evidence_limits"`
}

func ProductionFeedEnvironmentIdentity(environment ProductionFeedEnvironment) (string, error) {
	canonical, err := json.Marshal(environment)
	if err != nil {
		return "", err
	}
	digest := sha256.New()
	_, _ = io.WriteString(digest, productionFeedEnvironmentDomain)
	_, _ = digest.Write(canonical)
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func validateProductionFeedDetails(raw []byte, receipt EvidenceReceipt) error {
	return validateProductionFeedDetailsForLedger(raw, receipt, 0, time.Time{})
}

func validateProductionFeedDetailsForLedger(raw []byte, receipt EvidenceReceipt, preparedRevision int, preparedAt time.Time) error {
	var details ProductionFeedDetails
	if err := decodeStrict(raw, &details); err != nil {
		return fmt.Errorf("decode production update feed details: %w", err)
	}
	if details.Schema != ProductionFeedDetailsSchemaV1 ||
		details.ReleaseCandidateID != receipt.ReleaseCandidateID ||
		details.CandidateBefore != receipt.ProductBuild || details.CandidateAfter != receipt.ProductBuild ||
		!validDigest(details.PreparedLedgerSHA256) || details.PreparedLedgerRevision < 1 || details.LedgerPreparedAt.IsZero() ||
		details.ObservationStartedAt.Before(details.LedgerPreparedAt) ||
		details.ObservationFinishedAt.Before(details.ObservationStartedAt) ||
		!details.ObservationFinishedAt.Equal(receipt.ObservedAt) {
		return errors.New("production update feed details identity or observation window is invalid")
	}
	if preparedRevision != 0 && (details.PreparedLedgerRevision != preparedRevision || !details.LedgerPreparedAt.Equal(preparedAt)) {
		return errors.New("production update feed details do not match the exact prepared ledger revision")
	}
	identity, err := ProductionFeedEnvironmentIdentity(details.Environment)
	if err != nil || details.Environment.OS != "windows-11" || details.Environment.Architecture != "amd64" ||
		strings.TrimSpace(details.Environment.GoVersion) == "" || details.Environment.LogicalProcessors < 1 ||
		!windows11Version(details.Environment.WindowsVersion) ||
		receipt.Environment.Class != string(EvidenceProductionFeed) || receipt.Environment.OS != "windows-11" ||
		receipt.Environment.Architecture != "amd64" || receipt.Environment.IdentitySHA256 != identity {
		return errors.New("production update feed details do not bind a complete Windows 11 x64 environment")
	}
	subjects, err := receiptSubjectMap(receipt)
	if err != nil {
		return err
	}
	if subjects["prepared-ledger"] != details.PreparedLedgerSHA256 ||
		subjects["production-feed-details"] != receipt.DetailsSHA256 ||
		subjects["runtime-manifest-input"] != receipt.ProductBuild.RuntimeManifestSHA256 {
		return errors.New("production update feed receipt is not bound to its prepared ledger, details, and manifest")
	}
	if err := validateProductionFeedTrust(details, subjects); err != nil {
		return err
	}
	if err := validateProductionFeedLifecycle(details, subjects); err != nil {
		return err
	}
	if err := validateProductionFeedComponents(details.Components, subjects); err != nil {
		return err
	}
	if !details.EvidenceLimits.ReleaseGateEligible || details.EvidenceLimits.FixtureRole != "none" ||
		!sameStringSet(details.EvidenceLimits.EvidenceScope, []string{
			"production_update_feed", "embedded_ed25519_trust", "public_https_system_trust",
			"signed_stable_feed", "actual_artifact_download", "hash_signature_and_sri_verification",
			"live_app_server_and_browser_probe", "pending_then_restart_activation",
		}) || !sameStringSet(details.EvidenceLimits.ExcludedClaims, []string{
		"overall_release_success", "live_auth_exact_models", "live_embeddings_shadow", "live_end_to_end",
		"live_quality_12", "clean_vm_installer", "clean_vm_portable", "incompatible_su2_host",
	}) {
		return errors.New("production update feed evidence limits are incomplete or overclaim another gate")
	}
	return nil
}

func validateProductionFeedTrust(details ProductionFeedDetails, subjects map[string]string) error {
	trust := details.Trust
	feed := details.Feed
	if trust.DiagnosticSchema != "aetherops_runtime_update_trust_v2" || trust.BuildMode != "release" || !trust.Configured ||
		strings.TrimSpace(trust.KeyID) == "" || !validDigest(trust.FeedURLSHA256) ||
		!validDigest(trust.PublicKeySHA256) || !validDigest(trust.DiagnosticOutputSHA256) ||
		feed.Schema != managedruntime.FeedObservationSchemaV1 || feed.KeyID != trust.KeyID ||
		feed.FeedURLSHA256 != trust.FeedURLSHA256 || feed.ReleaseID != details.Lifecycle.CandidateID ||
		!validDigest(feed.EnvelopeSHA256) || !validDigest(feed.SignedPayloadSHA256) ||
		!validDigest(feed.LeafCertificateSHA256) || feed.IssuedAt.IsZero() || feed.ExpiresAt.IsZero() ||
		!feed.ExpiresAt.After(feed.IssuedAt) || feed.TLSVersion < tls.VersionTLS12 || feed.TLSCipherSuite == 0 {
		return errors.New("production update feed trust, signed envelope, or TLS observation is invalid")
	}
	if subjects["embedded-trust-diagnostic"] != trust.DiagnosticOutputSHA256 ||
		subjects["embedded-trust-public-key"] != trust.PublicKeySHA256 ||
		subjects["production-feed-url"] != trust.FeedURLSHA256 ||
		subjects["production-feed-envelope"] != feed.EnvelopeSHA256 ||
		subjects["production-feed-payload"] != feed.SignedPayloadSHA256 ||
		subjects["production-feed-leaf-certificate"] != feed.LeafCertificateSHA256 {
		return errors.New("production update feed cryptographic subjects do not match typed details")
	}
	return nil
}

func validateProductionFeedLifecycle(details ProductionFeedDetails, subjects map[string]string) error {
	lifecycle := details.Lifecycle
	if !productionReleaseIDPattern.MatchString(lifecycle.CandidateID) ||
		lifecycle.StatusAfterStage != string(managedruntime.CandidatePending) ||
		lifecycle.PendingRestartID != lifecycle.CandidateID || !lifecycle.ManagerReopenedForRestart ||
		!lifecycle.UpdaterStartupActivation ||
		lifecycle.StageStartedAt.Before(details.ObservationStartedAt) ||
		lifecycle.StageFinishedAt.Before(lifecycle.StageStartedAt) ||
		lifecycle.ActivationStartedAt.Before(lifecycle.StageFinishedAt) ||
		lifecycle.ActivationFinishedAt.Before(lifecycle.ActivationStartedAt) ||
		lifecycle.ActivationFinishedAt.After(details.ObservationFinishedAt) ||
		lifecycle.StatusAfterActivation != string(managedruntime.CandidateActive) ||
		lifecycle.ActiveCandidateID != lifecycle.CandidateID || !validDigest(lifecycle.ActivePointerSHA256) ||
		!lifecycle.ProcessPathsReadback || !validDigest(lifecycle.BrowserEndpointSHA256) ||
		!lifecycle.IsolatedRuntimeRoot || !lifecycle.TemporaryRuntimeRootRemoved ||
		subjects["runtime-active-pointer"] != lifecycle.ActivePointerSHA256 ||
		subjects["browser-endpoint"] != lifecycle.BrowserEndpointSHA256 {
		return errors.New("production update feed pending-to-restart activation contract is invalid")
	}
	for name, probe := range map[string]managedruntime.ProbeEvidence{
		"App Server": lifecycle.AppServerProbe, "browser": lifecycle.BrowserProbe,
	} {
		if !probe.Executed || !probe.Compatible || strings.TrimSpace(probe.Observation) == "" ||
			probe.ObservedAt.Before(lifecycle.StageStartedAt) || probe.ObservedAt.After(lifecycle.StageFinishedAt) {
			return fmt.Errorf("production update feed %s compatibility probe is invalid", name)
		}
	}
	return nil
}

func validateProductionFeedComponents(components []ProductionFeedComponentObservation, subjects map[string]string) error {
	pinned := map[string]string{
		"node": managedruntime.PinnedNodeVersion, "codex": managedruntime.PinnedCodexVersion,
		"chrome-devtools-mcp": managedruntime.PinnedChromeDevtoolsMCPVersion,
		"oxigraph":            managedruntime.PinnedOxigraphVersion, "openvsp": managedruntime.PinnedOpenVSPVersion,
		"gmsh": managedruntime.PinnedGmshVersion, "xfoil": managedruntime.PinnedXFOILVersion,
		"su2": managedruntime.PinnedSU2Version,
	}
	seen := make(map[string]struct{}, len(components))
	for _, component := range components {
		version, known := pinned[component.Component]
		if !known || component.Version != version {
			return fmt.Errorf("production update feed component %q is unknown or has the wrong pinned version", component.Component)
		}
		if _, duplicate := seen[component.Component]; duplicate {
			return fmt.Errorf("production update feed component %q is duplicated", component.Component)
		}
		seen[component.Component] = struct{}{}
		if !validDigest(component.PayloadSHA256) || !validDigest(component.RuntimeTreeSHA256) ||
			!validDigest(component.AttestationSHA256) || !component.SignatureReauthenticated {
			return fmt.Errorf("production update feed component %q lacks hash or signature evidence", component.Component)
		}
		npm := component.Component == "codex" || component.Component == "chrome-devtools-mcp" || component.Component == "oxigraph"
		if npm != (strings.TrimSpace(component.NPMPackage) != "" && strings.TrimSpace(component.NPMIntegrity) != "" && component.NPMIntegrityVerified) {
			return fmt.Errorf("production update feed component %q has an invalid npm SRI contract", component.Component)
		}
		name := strings.ReplaceAll(component.Component, "-", "_")
		if subjects["runtime_payload_"+name] != component.PayloadSHA256 ||
			subjects["runtime_tree_"+name] != component.RuntimeTreeSHA256 ||
			subjects["artifact_attestation_"+name] != component.AttestationSHA256 {
			return fmt.Errorf("production update feed component %q subjects do not match typed details", component.Component)
		}
	}
	if len(seen) != len(pinned) {
		return errors.New("production update feed details omit a managed runtime component")
	}
	return nil
}
