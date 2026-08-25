package releasegate

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	managedruntime "github.com/djkim0320/AetherOps/internal/runtime"
)

func TestAttachProductionFeedEvidenceBindsExactPredecessorLedger(t *testing.T) {
	root := t.TempDir()
	details, receipt := validProductionFeedFixture(t)
	ledger, err := PrepareLedger(receipt.ProductBuild, details.LedgerPreparedAt)
	if err != nil {
		t.Fatal(err)
	}
	ledgerPath := root + `\ledger-r1.json`
	writeJSON(t, ledgerPath, ledger)
	_, ledgerSHA, err := LoadLedgerChain(ledgerPath)
	if err != nil {
		t.Fatal(err)
	}
	details.PreparedLedgerSHA256 = ledgerSHA
	details.PreparedLedgerRevision = ledger.Revision
	setProductionSubject(&receipt, "prepared-ledger", ledgerSHA)
	detailsRaw := marshalJSON(t, details)
	detailsDigest := sha256.Sum256(detailsRaw)
	detailsSHA := hex.EncodeToString(detailsDigest[:])
	receipt.DetailsSHA256 = detailsSHA
	setProductionSubject(&receipt, "production-feed-details", detailsSHA)
	detailsPath := root + `\production.details.json`
	receiptPath := root + `\production.receipt.json`
	writeJSON(t, detailsPath, details)
	writeJSON(t, receiptPath, receipt)
	if _, err := AttachEvidence(ledgerPath, receiptPath, root+`\ledger-r2.json`, receipt.ProductBuild, receipt.ObservedAt.Add(time.Minute)); err != nil {
		t.Fatalf("exact production feed predecessor binding rejected: %v", err)
	}
}

func TestProductionFeedDetailsRequireRealLifecycleContract(t *testing.T) {
	details, receipt := validProductionFeedFixture(t)
	raw, err := json.Marshal(details)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateProductionFeedDetails(raw, receipt); err != nil {
		t.Fatalf("valid typed production feed details rejected: %v", err)
	}
	if err := validateProductionFeedDetailsForLedger(raw, receipt, details.PreparedLedgerRevision, details.LedgerPreparedAt); err != nil {
		t.Fatalf("exact prepared-ledger revision rejected: %v", err)
	}
	if err := validateProductionFeedDetailsForLedger(raw, receipt, details.PreparedLedgerRevision+1, details.LedgerPreparedAt); err == nil {
		t.Fatal("wrong prepared-ledger revision was accepted")
	}
	mutations := []struct {
		name   string
		mutate func(*ProductionFeedDetails)
	}{
		{name: "fixture role", mutate: func(value *ProductionFeedDetails) { value.EvidenceLimits.FixtureRole = "unit-fixture" }},
		{name: "no restart boundary", mutate: func(value *ProductionFeedDetails) { value.Lifecycle.ManagerReopenedForRestart = false }},
		{name: "no updater activation", mutate: func(value *ProductionFeedDetails) { value.Lifecycle.UpdaterStartupActivation = false }},
		{name: "no TLS", mutate: func(value *ProductionFeedDetails) { value.Feed.TLSVersion = 0 }},
		{name: "no live browser", mutate: func(value *ProductionFeedDetails) { value.Lifecycle.BrowserProbe.Executed = false }},
		{name: "no cleanup", mutate: func(value *ProductionFeedDetails) { value.Lifecycle.TemporaryRuntimeRootRemoved = false }},
		{name: "no npm SRI", mutate: func(value *ProductionFeedDetails) { value.Components[1].NPMIntegrityVerified = false }},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			copy := details
			copy.Components = append([]ProductionFeedComponentObservation(nil), details.Components...)
			copy.EvidenceLimits.EvidenceScope = append([]string(nil), details.EvidenceLimits.EvidenceScope...)
			copy.EvidenceLimits.ExcludedClaims = append([]string(nil), details.EvidenceLimits.ExcludedClaims...)
			mutation.mutate(&copy)
			raw, err := json.Marshal(copy)
			if err != nil {
				t.Fatal(err)
			}
			if err := validateProductionFeedDetails(raw, receipt); err == nil {
				t.Fatal("non-production or incomplete observation was accepted")
			}
		})
	}
}

func TestProductionFeedReceiptUsesOnlyTrustedProducer(t *testing.T) {
	_, receipt := validProductionFeedFixture(t)
	if err := receipt.Validate(); err != nil {
		t.Fatalf("trusted production producer rejected: %v", err)
	}
	receipt.Producer.Name = "self-declared"
	if err := receipt.Validate(); err == nil || !strings.Contains(err.Error(), "not trusted") {
		t.Fatalf("self-declared production receipt accepted: %v", err)
	}
}

func validProductionFeedFixture(t *testing.T) (ProductionFeedDetails, EvidenceReceipt) {
	t.Helper()
	prepared := time.Date(2026, 8, 9, 1, 0, 0, 0, time.UTC)
	started := prepared.Add(time.Minute)
	stageStart := started.Add(time.Minute)
	stageFinish := stageStart.Add(2 * time.Minute)
	activationStart := stageFinish.Add(time.Minute)
	activationFinish := activationStart.Add(time.Minute)
	finished := activationFinish.Add(time.Minute)
	build := testBuild("a")
	candidateID, err := CandidateID(build)
	if err != nil {
		t.Fatal(err)
	}
	environment := ProductionFeedEnvironment{
		OS: "windows-11", Architecture: "amd64", GoVersion: "go1.26.5", LogicalProcessors: 8,
		ProcessorIdentifier: "test-cpu", WindowsVersion: "10.0.26100",
	}
	environmentID, err := ProductionFeedEnvironmentIdentity(environment)
	if err != nil {
		t.Fatal(err)
	}
	digest := func(letter string) string { return strings.Repeat(letter, 64) }
	versions := map[string]string{
		"node": managedruntime.PinnedNodeVersion, "codex": managedruntime.PinnedCodexVersion,
		"chrome-devtools-mcp": managedruntime.PinnedChromeDevtoolsMCPVersion,
		"oxigraph":            managedruntime.PinnedOxigraphVersion, "openvsp": managedruntime.PinnedOpenVSPVersion,
		"gmsh": managedruntime.PinnedGmshVersion, "xfoil": managedruntime.PinnedXFOILVersion,
		"su2": managedruntime.PinnedSU2Version,
	}
	order := []string{"node", "codex", "chrome-devtools-mcp", "oxigraph", "openvsp", "gmsh", "xfoil", "su2"}
	components := make([]ProductionFeedComponentObservation, 0, len(order))
	subjects := map[string]string{
		"aetherops.exe": build.ExecutableSHA256, "runtime-manifest.json": build.RuntimeManifestSHA256,
		"knowledge-sidecar-tree": build.KnowledgeSidecarTreeSHA256,
		"prepared-ledger":        digest("b"), "runtime-manifest-input": build.RuntimeManifestSHA256,
		"embedded-trust-diagnostic": digest("c"), "production-feed-envelope": digest("d"),
		"production-feed-payload": digest("e"), "production-feed-leaf-certificate": digest("f"),
		"embedded-trust-public-key": digest("4"), "production-feed-url": digest("3"),
		"runtime-active-pointer": digest("1"), "browser-endpoint": digest("2"),
	}
	for _, name := range order {
		npm := name == "codex" || name == "chrome-devtools-mcp" || name == "oxigraph"
		marker := sha256.Sum256([]byte("payload-" + name))
		payload := hex.EncodeToString(marker[:])
		tree := sha256.Sum256([]byte("tree-" + name))
		attestation := sha256.Sum256([]byte("attestation-" + name))
		component := ProductionFeedComponentObservation{
			Component: name, Version: versions[name], PayloadSHA256: payload,
			RuntimeTreeSHA256: hex.EncodeToString(tree[:]), AttestationSHA256: hex.EncodeToString(attestation[:]),
			NPMIntegrityVerified: npm, SignatureReauthenticated: true,
		}
		if npm {
			component.NPMPackage = "@example/" + name
			component.NPMIntegrity = "sha512-Zml4dHVyZQ=="
		}
		components = append(components, component)
		suffix := strings.ReplaceAll(name, "-", "_")
		subjects["runtime_payload_"+suffix] = component.PayloadSHA256
		subjects["runtime_tree_"+suffix] = component.RuntimeTreeSHA256
		subjects["artifact_attestation_"+suffix] = component.AttestationSHA256
	}
	probe := managedruntime.ProbeEvidence{Executed: true, Compatible: true, Observation: "actual protocol probe", ObservedAt: stageStart.Add(time.Minute)}
	details := ProductionFeedDetails{
		Schema: ProductionFeedDetailsSchemaV1, ReleaseCandidateID: candidateID,
		PreparedLedgerSHA256: subjects["prepared-ledger"], PreparedLedgerRevision: 7, LedgerPreparedAt: prepared,
		ObservationStartedAt: started, ObservationFinishedAt: finished,
		CandidateBefore: build, CandidateAfter: build, Environment: environment,
		Trust: ProductionFeedTrustObservation{
			DiagnosticSchema: "aetherops_runtime_update_trust_v2", BuildMode: "release", Configured: true, KeyID: "release-key-2026",
			FeedURLSHA256: digest("3"), PublicKeySHA256: digest("4"), DiagnosticOutputSHA256: subjects["embedded-trust-diagnostic"],
		},
		Feed: managedruntime.FeedObservation{
			Schema: managedruntime.FeedObservationSchemaV1, EnvelopeSHA256: subjects["production-feed-envelope"],
			SignedPayloadSHA256: subjects["production-feed-payload"], FeedURLSHA256: digest("3"),
			KeyID: "release-key-2026", IssuedAt: prepared, ExpiresAt: prepared.Add(24 * time.Hour),
			ReleaseID: "stable-20260809", TLSVersion: tls.VersionTLS13, TLSCipherSuite: tls.TLS_AES_128_GCM_SHA256,
			LeafCertificateSHA256: subjects["production-feed-leaf-certificate"],
		},
		Lifecycle: ProductionFeedLifecycleObservation{
			CandidateID: "stable-20260809", StageStartedAt: stageStart, StageFinishedAt: stageFinish,
			StatusAfterStage: "pending", PendingRestartID: "stable-20260809", ManagerReopenedForRestart: true,
			UpdaterStartupActivation: true,
			ActivationStartedAt:      activationStart, ActivationFinishedAt: activationFinish,
			StatusAfterActivation: "active", ActiveCandidateID: "stable-20260809",
			ActivePointerSHA256: subjects["runtime-active-pointer"], ProcessPathsReadback: true,
			BrowserEndpointSHA256: subjects["browser-endpoint"], IsolatedRuntimeRoot: true, TemporaryRuntimeRootRemoved: true,
			AppServerProbe: probe, BrowserProbe: probe,
		},
		Components: components,
		EvidenceLimits: ProductionFeedEvidenceLimits{
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
	raw, err := json.Marshal(details)
	if err != nil {
		t.Fatal(err)
	}
	detailsDigest := sha256.Sum256(raw)
	detailsSHA := hex.EncodeToString(detailsDigest[:])
	subjects["production-feed-details"] = detailsSHA
	receipt := EvidenceReceipt{
		Schema: EvidenceSchemaV1, GateID: "production_update_feed", EvidenceKind: EvidenceProductionFeed,
		ReleaseCandidateID: candidateID, ProductBuild: build,
		Producer:    Producer{Name: "cmd/productionfeedevidence", Version: "1"},
		Environment: Environment{Class: string(EvidenceProductionFeed), OS: "windows-11", Architecture: "amd64", IdentitySHA256: environmentID},
		ObservedAt:  finished, Status: "passed", DetailsPath: "production.details.json", DetailsSHA256: detailsSHA,
	}
	for name, hash := range subjects {
		receipt.SubjectHashes = append(receipt.SubjectHashes, SubjectHash{Name: name, SHA256: hash})
	}
	return details, receipt
}

func setProductionSubject(receipt *EvidenceReceipt, name, digest string) {
	for index := range receipt.SubjectHashes {
		if receipt.SubjectHashes[index].Name == name {
			receipt.SubjectHashes[index].SHA256 = digest
			return
		}
	}
	receipt.SubjectHashes = append(receipt.SubjectHashes, SubjectHash{Name: name, SHA256: digest})
}
