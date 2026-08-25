//go:build windows

// Package productionfeed executes the external production signed-feed release
// gate. Its production path deliberately has no injectable HTTP transport or
// compatibility callback: it uses system TLS, public port 443 destinations,
// the real candidate App Server, and the real browser MCP/CDP endpoint.
package productionfeed

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"golang.org/x/sys/windows"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"github.com/djkim0320/AetherOps/internal/codex"
	"github.com/djkim0320/AetherOps/internal/processutil"
	"github.com/djkim0320/AetherOps/internal/releasegate"
	managedruntime "github.com/djkim0320/AetherOps/internal/runtime"
	"github.com/djkim0320/AetherOps/internal/securepath"
)

const trustConfigSchemaV1 = "aetherops_production_feed_trust_v1"

type TrustConfig struct {
	Schema          string `json:"schema"`
	FeedURL         string `json:"feed_url"`
	KeyID           string `json:"key_id"`
	PublicKeyBase64 string `json:"public_key_base64"`
}

type Config struct {
	CandidateExecutable string
	PreparedLedger      string
	TrustConfigPath     string
	BrowserEndpoint     string
	CodexHome           string
	AfterStart          func(int) error
}

type Result struct {
	Details       releasegate.ProductionFeedDetails
	SubjectHashes map[string]string
	EnvironmentID string
}

type candidateBinding struct {
	Build           buildinfo.ProductBuildBinding
	Executable      string
	RuntimeManifest string
	Sidecar         string
}

type runtimeTrustDiagnostic struct {
	Schema          string `json:"schema"`
	Configured      bool   `json:"configured"`
	KeyID           string `json:"key_id,omitempty"`
	FeedURLSHA256   string `json:"feed_url_sha256,omitempty"`
	PublicKeySHA256 string `json:"public_key_sha256,omitempty"`
	BuildMode       string `json:"build_mode"`
}

// AuthenticateCandidate returns the exact immutable product binding used by
// the producer. It is exported so the command can re-authenticate immediately
// before publishing its receipt without exposing any mutable internal state.
func AuthenticateCandidate(executable string) (buildinfo.ProductBuildBinding, error) {
	binding, err := bindCandidate(executable)
	if err != nil {
		return buildinfo.ProductBuildBinding{}, err
	}
	return binding.Build, nil
}

func Run(ctx context.Context, config Config) (Result, error) {
	if ctx == nil {
		return Result{}, errors.New("production feed context is required")
	}
	if config.AfterStart == nil {
		return Result{}, errors.New("production feed live probes require Job Object supervision")
	}
	now := time.Now
	startedAt := now().UTC()
	binding, err := bindCandidate(config.CandidateExecutable)
	if err != nil {
		return Result{}, err
	}
	ledger, ledgerSHA256, err := releasegate.LoadLedgerChain(config.PreparedLedger)
	if err != nil {
		return Result{}, fmt.Errorf("authenticate prepared ledger: %w", err)
	}
	if ledger.ProductBuild != binding.Build {
		return Result{}, errors.New("prepared ledger and candidate executable identify different product builds")
	}
	if !productionFeedGateEmpty(ledger) {
		return Result{}, errors.New("prepared ledger production_update_feed row is absent or already evidenced")
	}
	trustConfig, trustRoot, err := loadTrustConfig(config.TrustConfigPath)
	if err != nil {
		return Result{}, err
	}
	if err := validateProductionFeedURL(trustConfig.FeedURL); err != nil {
		return Result{}, err
	}
	diagnostic, diagnosticRaw, err := runEmbeddedTrustDiagnostic(ctx, binding.Executable)
	if err != nil {
		return Result{}, err
	}
	trustObservation, err := authenticateEmbeddedTrust(diagnostic, diagnosticRaw, trustConfig, trustRoot)
	if err != nil {
		return Result{}, err
	}
	browserEndpoint, browserEndpointSHA256, err := validateBrowserEndpoint(config.BrowserEndpoint)
	if err != nil {
		return Result{}, err
	}
	codexHome, err := regularDirectory(config.CodexHome)
	if err != nil {
		return Result{}, fmt.Errorf("authenticate dedicated CODEX_HOME: %w", err)
	}
	manifest, err := managedruntime.LoadManifest(binding.RuntimeManifest)
	if err != nil {
		return Result{}, fmt.Errorf("load exact candidate runtime manifest: %w", err)
	}
	httpClient := productionHTTPClient()
	feedClient := &managedruntime.FeedClient{URL: trustConfig.FeedURL, TrustRoot: trustRoot, HTTPClient: httpClient}
	release, feedObservation, err := feedClient.FetchObserved(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("fetch actual production signed stable feed: %w", err)
	}

	runtimeRoot, err := os.MkdirTemp("", "aetherops-production-feed-")
	if err != nil {
		return Result{}, fmt.Errorf("create isolated runtime root: %w", err)
	}
	if _, err := regularDirectory(runtimeRoot); err != nil {
		_ = os.RemoveAll(runtimeRoot)
		return Result{}, fmt.Errorf("authenticate isolated runtime root: %w", err)
	}
	removed := false
	defer func() {
		if !removed {
			_ = os.RemoveAll(runtimeRoot)
		}
	}()
	options := managedruntime.Options{
		HTTPClient: httpClient, SignatureVerifier: trustRoot.SignatureVerifier(),
		CompatibilityProbe: managedruntime.LiveCompatibilityProbe{
			Timeout: 2 * time.Minute,
			AppServer: managedruntime.StdioAppServerProbe{
				Timeout: 2 * time.Minute, AfterStart: config.AfterStart,
				Env: []string{"CODEX_HOME=" + codexHome},
				RequiredModels: []managedruntime.RequiredAppServerModel{
					{Model: codex.SolModel, Effort: codex.SolEffort},
					{Model: codex.TerraModel, Effort: codex.TerraEffort},
				},
			},
			Browser: managedruntime.StdioBrowserProbe{
				Endpoint: browserEndpoint, Timeout: 2 * time.Minute, AfterStart: config.AfterStart,
				RequirePageSnapshot: true,
			},
		},
	}
	manager, err := managedruntime.Open(runtimeRoot, manifest, options)
	if err != nil {
		return Result{}, fmt.Errorf("open isolated production runtime manager: %w", err)
	}
	stageStartedAt := now().UTC()
	candidate, err := manager.Stage(ctx, release)
	if err != nil {
		return Result{}, fmt.Errorf("download, attest, SRI-check, and probe production runtime: %w", err)
	}
	stageFinishedAt := now().UTC()
	if candidate.Status != managedruntime.CandidatePending || candidate.ID != release.ID || candidate.Probe == nil {
		return Result{}, errors.New("production runtime did not reach one probe-backed pending state")
	}
	status, err := manager.Status()
	if err != nil || status.Active != nil || len(status.Candidates) != 1 || status.Candidates[0].ID != candidate.ID || status.Candidates[0].Status != managedruntime.CandidatePending {
		return Result{}, errors.New("production runtime pending-state readback is invalid")
	}
	components, componentSubjects, err := componentObservations(release, candidate)
	if err != nil {
		return Result{}, err
	}

	// A new Manager instance over the same durable root is the explicit restart
	// boundary. Stage and activation can never occur through one Manager value.
	restarted, err := managedruntime.Open(runtimeRoot, manifest, options)
	if err != nil {
		return Result{}, fmt.Errorf("reopen production runtime manager for restart activation: %w", err)
	}
	activationStartedAt := now().UTC()
	restartedUpdater := &managedruntime.Updater{Manager: restarted, Feed: feedClient}
	if err := restartedUpdater.ActivateOnStartup(ctx); err != nil {
		return Result{}, fmt.Errorf("activate production runtime through startup updater after restart boundary: %w", err)
	}
	active, err := restarted.Active()
	if err != nil {
		return Result{}, fmt.Errorf("read production runtime activated through startup updater: %w", err)
	}
	activationFinishedAt := now().UTC()
	if active.CandidateID != candidate.ID || active.Channel != "stable" {
		return Result{}, errors.New("production runtime active pointer identifies the wrong candidate")
	}
	if _, err := restarted.ProcessPaths(); err != nil {
		return Result{}, fmt.Errorf("read back activated production process paths: %w", err)
	}
	afterStatus, err := restarted.Status()
	if err != nil || afterStatus.Active == nil || afterStatus.Active.CandidateID != candidate.ID || len(afterStatus.Candidates) != 1 || afterStatus.Candidates[0].Status != managedruntime.CandidateActive {
		return Result{}, errors.New("production runtime active-state readback is invalid")
	}
	activePointerSHA256, err := hashRegularFile(restarted.Layout().Active)
	if err != nil {
		return Result{}, fmt.Errorf("hash activated runtime pointer: %w", err)
	}
	if err := os.RemoveAll(runtimeRoot); err != nil {
		return Result{}, fmt.Errorf("remove isolated production runtime root: %w", err)
	}
	if _, err := os.Lstat(runtimeRoot); !errors.Is(err, os.ErrNotExist) {
		return Result{}, errors.New("isolated production runtime root remains after cleanup")
	}
	removed = true

	afterBinding, err := bindCandidate(binding.Executable)
	if err != nil {
		return Result{}, fmt.Errorf("re-authenticate exact release candidate: %w", err)
	}
	if afterBinding != binding {
		return Result{}, errors.New("release candidate changed during production feed observation")
	}
	currentLedger, currentLedgerSHA256, err := releasegate.LoadLedgerChain(config.PreparedLedger)
	if err != nil || currentLedgerSHA256 != ledgerSHA256 || currentLedger.ProductBuild != ledger.ProductBuild || !productionFeedGateEmpty(currentLedger) {
		return Result{}, errors.New("prepared ledger changed during production feed observation")
	}
	finishedAt := now().UTC()
	environment := currentEnvironment()
	environmentID, err := releasegate.ProductionFeedEnvironmentIdentity(environment)
	if err != nil {
		return Result{}, err
	}
	details := releasegate.ProductionFeedDetails{
		Schema: releasegate.ProductionFeedDetailsSchemaV1, ReleaseCandidateID: ledger.ReleaseCandidateID,
		PreparedLedgerSHA256: ledgerSHA256, PreparedLedgerRevision: ledger.Revision, LedgerPreparedAt: ledger.PreparedAt,
		ObservationStartedAt: startedAt, ObservationFinishedAt: finishedAt,
		CandidateBefore: binding.Build, CandidateAfter: afterBinding.Build, Environment: environment,
		Trust: trustObservation, Feed: feedObservation, Components: components,
		Lifecycle: releasegate.ProductionFeedLifecycleObservation{
			CandidateID: candidate.ID, StageStartedAt: stageStartedAt, StageFinishedAt: stageFinishedAt,
			StatusAfterStage: string(managedruntime.CandidatePending), PendingRestartID: candidate.ID,
			ManagerReopenedForRestart: true, UpdaterStartupActivation: true, ActivationStartedAt: activationStartedAt,
			ActivationFinishedAt: activationFinishedAt, StatusAfterActivation: string(managedruntime.CandidateActive),
			ActiveCandidateID: active.CandidateID, ActivePointerSHA256: activePointerSHA256,
			ProcessPathsReadback: true, BrowserEndpointSHA256: browserEndpointSHA256,
			IsolatedRuntimeRoot: true, TemporaryRuntimeRootRemoved: true,
			AppServerProbe: candidate.Probe.AppServer, BrowserProbe: candidate.Probe.Browser,
		},
		EvidenceLimits: releasegate.ProductionFeedEvidenceLimits{
			ReleaseGateEligible: true, FixtureRole: "none",
			EvidenceScope: []string{
				"production_update_feed", "embedded_ed25519_trust", "public_https_system_trust",
				"signed_stable_feed", "actual_artifact_download", "hash_signature_and_sri_verification",
				"live_app_server_and_browser_probe", "pending_then_restart_activation",
			},
			ExcludedClaims: []string{
				"overall_release_success", "live_auth_exact_models", "live_embeddings_shadow", "live_end_to_end",
				"live_quality_12", "clean_vm_installer", "clean_vm_portable", "incompatible_su2_host",
			},
		},
	}
	subjects := map[string]string{
		"aetherops.exe":          binding.Build.ExecutableSHA256,
		"runtime-manifest.json":  binding.Build.RuntimeManifestSHA256,
		"knowledge-sidecar-tree": binding.Build.KnowledgeSidecarTreeSHA256,
		"prepared-ledger":        ledgerSHA256, "runtime-manifest-input": binding.Build.RuntimeManifestSHA256,
		"embedded-trust-diagnostic":        trustObservation.DiagnosticOutputSHA256,
		"embedded-trust-public-key":        trustObservation.PublicKeySHA256,
		"production-feed-url":              trustObservation.FeedURLSHA256,
		"production-feed-envelope":         feedObservation.EnvelopeSHA256,
		"production-feed-payload":          feedObservation.SignedPayloadSHA256,
		"production-feed-leaf-certificate": feedObservation.LeafCertificateSHA256,
		"runtime-active-pointer":           activePointerSHA256, "browser-endpoint": browserEndpointSHA256,
	}
	for name, digest := range componentSubjects {
		subjects[name] = digest
	}
	return Result{Details: details, SubjectHashes: subjects, EnvironmentID: environmentID}, nil
}

func productionFeedGateEmpty(ledger releasegate.Ledger) bool {
	for _, reference := range ledger.Evidence {
		if reference.GateID == "production_update_feed" {
			return reference.ReceiptPath == "" && reference.ReceiptSHA256 == ""
		}
	}
	return false
}

func bindCandidate(executablePath string) (candidateBinding, error) {
	executable, err := securepath.RegularPath(strings.TrimSpace(executablePath))
	if err != nil {
		return candidateBinding{}, fmt.Errorf("authenticate candidate executable: %w", err)
	}
	if !strings.EqualFold(filepath.Base(executable), "aetherops.exe") {
		return candidateBinding{}, errors.New("candidate executable must be named aetherops.exe")
	}
	directory := filepath.Dir(executable)
	manifest, err := securepath.RegularPathWithin(directory, "runtime-manifest.json")
	if err != nil {
		return candidateBinding{}, fmt.Errorf("authenticate sibling runtime manifest: %w", err)
	}
	sidecar, err := securepath.RegularPathWithin(directory, filepath.Join("knowledge-sidecar", "index.cjs"))
	if err != nil {
		return candidateBinding{}, fmt.Errorf("authenticate sibling knowledge sidecar: %w", err)
	}
	build, err := buildinfo.BindProductBuild(executable, manifest, sidecar)
	if err != nil {
		return candidateBinding{}, err
	}
	return candidateBinding{Build: build, Executable: executable, RuntimeManifest: manifest, Sidecar: sidecar}, nil
}

func loadTrustConfig(path string) (TrustConfig, managedruntime.TrustRoot, error) {
	raw, err := securepath.ReadRegular(strings.TrimSpace(path), 16<<10)
	if err != nil {
		return TrustConfig{}, managedruntime.TrustRoot{}, fmt.Errorf("read production feed trust config: %w", err)
	}
	var config TrustConfig
	if err := decodeStrict(raw, &config); err != nil {
		return TrustConfig{}, managedruntime.TrustRoot{}, fmt.Errorf("decode production feed trust config: %w", err)
	}
	if config.Schema != trustConfigSchemaV1 || config.FeedURL != strings.TrimSpace(config.FeedURL) ||
		config.KeyID != strings.TrimSpace(config.KeyID) || config.PublicKeyBase64 != strings.TrimSpace(config.PublicKeyBase64) {
		return TrustConfig{}, managedruntime.TrustRoot{}, errors.New("production feed trust config schema or canonical strings are invalid")
	}
	root, err := managedruntime.ParseTrustRoot(config.KeyID, config.PublicKeyBase64)
	if err != nil {
		return TrustConfig{}, managedruntime.TrustRoot{}, err
	}
	return config, root, nil
}

func authenticateEmbeddedTrust(diagnostic runtimeTrustDiagnostic, raw []byte, config TrustConfig, root managedruntime.TrustRoot) (releasegate.ProductionFeedTrustObservation, error) {
	feedDigest := sha256.Sum256([]byte(config.FeedURL))
	keyDigest := sha256.Sum256(root.PublicKey)
	outputDigest := sha256.Sum256(raw)
	if diagnostic.Schema != "aetherops_runtime_update_trust_v2" || diagnostic.BuildMode != "release" || !diagnostic.Configured ||
		diagnostic.KeyID != config.KeyID || diagnostic.FeedURLSHA256 != hex.EncodeToString(feedDigest[:]) ||
		diagnostic.PublicKeySHA256 != hex.EncodeToString(keyDigest[:]) {
		return releasegate.ProductionFeedTrustObservation{}, errors.New("candidate embedded runtime trust does not exactly match production trust config")
	}
	return releasegate.ProductionFeedTrustObservation{
		DiagnosticSchema: diagnostic.Schema, Configured: true, KeyID: diagnostic.KeyID,
		FeedURLSHA256: diagnostic.FeedURLSHA256, PublicKeySHA256: diagnostic.PublicKeySHA256,
		BuildMode:              diagnostic.BuildMode,
		DiagnosticOutputSHA256: hex.EncodeToString(outputDigest[:]),
	}, nil
}

func runEmbeddedTrustDiagnostic(ctx context.Context, executable string) (runtimeTrustDiagnostic, []byte, error) {
	probeContext, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := exec.CommandContext(probeContext, executable, "runtime-trust-diagnostic")
	processutil.ConfigureNoWindow(command)
	command.Env = sanitizedEnvironment(os.Environ())
	var stdout, stderr boundedBuffer
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err != nil {
		return runtimeTrustDiagnostic{}, nil, fmt.Errorf("candidate embedded trust diagnostic failed: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	if stdout.Overflowed() || stderr.Overflowed() {
		return runtimeTrustDiagnostic{}, nil, errors.New("candidate embedded trust diagnostic exceeded its output limit")
	}
	raw := append([]byte(nil), stdout.Bytes()...)
	var diagnostic runtimeTrustDiagnostic
	if err := decodeStrict(raw, &diagnostic); err != nil {
		return runtimeTrustDiagnostic{}, nil, fmt.Errorf("decode candidate embedded trust diagnostic: %w", err)
	}
	return diagnostic, raw, nil
}

func componentObservations(release managedruntime.Release, candidate managedruntime.Candidate) ([]releasegate.ProductionFeedComponentObservation, map[string]string, error) {
	artifacts := make(map[managedruntime.Component]managedruntime.Artifact, len(release.Artifacts))
	for _, artifact := range release.Artifacts {
		artifacts[artifact.Component] = artifact
	}
	order := []managedruntime.Component{
		managedruntime.ComponentNode, managedruntime.ComponentCodex, managedruntime.ComponentChromeDevtoolsMCP,
		managedruntime.ComponentOxigraph, managedruntime.ComponentOpenVSP, managedruntime.ComponentGmsh,
		managedruntime.ComponentXFOIL, managedruntime.ComponentSU2,
	}
	observations := make([]releasegate.ProductionFeedComponentObservation, 0, len(order))
	subjects := make(map[string]string, len(order)*3)
	for _, component := range order {
		artifact, artifactOK := artifacts[component]
		metadata, metadataOK := candidate.Components[component]
		if !artifactOK || !metadataOK || artifact.Version != metadata.Version || artifact.SHA256 != metadata.SHA256 ||
			!bytes.Equal(artifact.Signature, metadata.Signature) || metadata.TreeSHA256 == "" {
			return nil, nil, fmt.Errorf("production runtime component %q metadata changed between feed and pending state", component)
		}
		attestationDigest := sha256.Sum256(artifact.Signature)
		npm := artifact.NPMIntegrity != ""
		observation := releasegate.ProductionFeedComponentObservation{
			Component: string(component), Version: metadata.Version, PayloadSHA256: metadata.SHA256,
			RuntimeTreeSHA256: metadata.TreeSHA256, AttestationSHA256: hex.EncodeToString(attestationDigest[:]),
			NPMPackage: artifact.NPMPackage, NPMIntegrity: artifact.NPMIntegrity,
			NPMIntegrityVerified: npm, SignatureReauthenticated: true,
		}
		observations = append(observations, observation)
		name := strings.ReplaceAll(string(component), "-", "_")
		subjects["runtime_payload_"+name] = observation.PayloadSHA256
		subjects["runtime_tree_"+name] = observation.RuntimeTreeSHA256
		subjects["artifact_attestation_"+name] = observation.AttestationSHA256
	}
	return observations, subjects, nil
}

func validateProductionFeedURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || parsed.Path == "" {
		return errors.New("production feed must be a canonical HTTPS URL without credentials or fragment")
	}
	if parsed.Port() != "" && parsed.Port() != "443" {
		return errors.New("production feed must use the public HTTPS port 443")
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return errors.New("production feed must use a non-local DNS hostname")
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return errors.New("production feed must use a DNS hostname, not an IP literal")
	}
	return nil
}

func validateBrowserEndpoint(raw string) (string, string, error) {
	canonical := strings.TrimSpace(raw)
	parsed, err := url.Parse(canonical)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.Port() == "" ||
		parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || canonical != parsed.String() {
		return "", "", errors.New("browser endpoint must be a canonical http://127.0.0.1:<port> CDP endpoint")
	}
	digest := sha256.Sum256([]byte(canonical))
	return canonical, hex.EncodeToString(digest[:]), nil
}

func productionHTTPClient() *http.Client {
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil || port != "443" {
			return nil, errors.New("production runtime network destination must use TCP port 443")
		}
		if _, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
			return nil, errors.New("production runtime network destination must use a DNS hostname")
		}
		addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil || len(addresses) == 0 {
			return nil, fmt.Errorf("resolve production runtime host %q: %w", host, err)
		}
		var failures []error
		for _, resolved := range addresses {
			address, ok := netip.AddrFromSlice(resolved.IP)
			if !ok || !publicAddress(address.Unmap()) {
				return nil, fmt.Errorf("production runtime host %q resolved to a non-public address", host)
			}
			connection, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(address.String(), port))
			if dialErr == nil {
				return connection, nil
			}
			failures = append(failures, dialErr)
		}
		return nil, fmt.Errorf("connect production runtime host %q: %w", host, errors.Join(failures...))
	}
	return &http.Client{Transport: transport, Timeout: 2 * time.Hour}
}

func publicAddress(address netip.Addr) bool {
	if !address.IsValid() || !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() ||
		address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() || address.IsUnspecified() {
		return false
	}
	reserved := []netip.Prefix{
		netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
		netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
		netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
		netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"),
		netip.MustParsePrefix("2001:db8::/32"),
	}
	for _, prefix := range reserved {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

func regularDirectory(path string) (string, error) {
	absolute, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(absolute, `\\`) || filepath.VolumeName(absolute) == "" {
		return "", errors.New("directory must be on a local Windows volume")
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("path is not a regular directory")
	}
	if err := rejectReparseComponents(absolute); err != nil {
		return "", err
	}
	return absolute, nil
}

func rejectReparseComponents(path string) error {
	volume := filepath.VolumeName(path)
	current := volume + string(filepath.Separator)
	remainder := strings.TrimPrefix(path, current)
	for _, component := range strings.Split(remainder, string(filepath.Separator)) {
		if component == "" {
			continue
		}
		current = filepath.Join(current, component)
		pointer, err := windows.UTF16PtrFromString(current)
		if err != nil {
			return err
		}
		attributes, err := windows.GetFileAttributes(pointer)
		if err != nil {
			return err
		}
		if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("directory path contains a Windows reparse point")
		}
	}
	return nil
}

func currentEnvironment() releasegate.ProductionFeedEnvironment {
	version := windows.RtlGetVersion()
	return releasegate.ProductionFeedEnvironment{
		OS: "windows-11", Architecture: runtime.GOARCH, GoVersion: runtime.Version(),
		LogicalProcessors: runtime.NumCPU(), ProcessorIdentifier: os.Getenv("PROCESSOR_IDENTIFIER"),
		WindowsVersion: fmt.Sprintf("%d.%d.%d", version.MajorVersion, version.MinorVersion, version.BuildNumber),
	}
}

func hashRegularFile(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("hash target is not a regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(info, after) || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return "", errors.New("hash target changed during observation")
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func sanitizedEnvironment(environment []string) []string {
	blocked := map[string]struct{}{
		"AETHEROPS_DEV": {}, "AETHEROPS_RUNTIME_FEED_URL": {}, "AETHEROPS_RUNTIME_KEY_ID": {},
		"AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64": {},
	}
	clean := make([]string, 0, len(environment))
	for _, entry := range environment {
		name := entry
		if index := strings.IndexByte(entry, '='); index >= 0 {
			name = entry[:index]
		}
		if _, remove := blocked[strings.ToUpper(name)]; !remove {
			clean = append(clean, entry)
		}
	}
	return clean
}

func decodeStrict(raw []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains multiple values")
		}
		return err
	}
	return nil
}

type boundedBuffer struct {
	buffer   bytes.Buffer
	overflow bool
}

func (buffer *boundedBuffer) Write(data []byte) (int, error) {
	const limit = 64 << 10
	original := len(data)
	remaining := limit - buffer.buffer.Len()
	if remaining > 0 {
		if len(data) > remaining {
			data = data[:remaining]
		}
		_, _ = buffer.buffer.Write(data)
	}
	if original > remaining {
		buffer.overflow = true
	}
	return original, nil
}

func (buffer *boundedBuffer) Bytes() []byte    { return buffer.buffer.Bytes() }
func (buffer *boundedBuffer) String() string   { return buffer.buffer.String() }
func (buffer *boundedBuffer) Overflowed() bool { return buffer.overflow }
