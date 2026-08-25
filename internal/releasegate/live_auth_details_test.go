package releasegate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/codex"
	"github.com/djkim0320/AetherOps/internal/core"
)

func TestLiveAuthExactModelsTypedVerifierRejectsSubstitutionAndMutation(t *testing.T) {
	details, receipt := validLiveAuthEvidenceFixture(t)
	raw := mustJSON(t, details)
	if err := ValidateLiveAuthExactModelsEvidenceForLedger(raw, receipt, details.LedgerRevision, details.LedgerPreparedAt); err != nil {
		t.Fatalf("valid verifier contract fixture was rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*LiveAuthExactModelsDetails, *EvidenceReceipt)
	}{
		{"not_authenticated", func(value *LiveAuthExactModelsDetails, _ *EvidenceReceipt) { value.Account.Authenticated = false }},
		{"not_chatgpt", func(value *LiveAuthExactModelsDetails, _ *EvidenceReceipt) { value.Account.ChatGPT = false }},
		{"api_key_account", func(value *LiveAuthExactModelsDetails, _ *EvidenceReceipt) { value.Account.AccountType = "apiKey" }},
		{"missing_plan", func(value *LiveAuthExactModelsDetails, _ *EvidenceReceipt) { value.Account.PlanType = "" }},
		{"unmanaged_auth", func(value *LiveAuthExactModelsDetails, _ *EvidenceReceipt) { value.Account.RequiresOpenAIAuth = false }},
		{"sol_substitute", func(value *LiveAuthExactModelsDetails, _ *EvidenceReceipt) {
			value.Status.ModelOptions[0].ID = "gpt-5.6"
		}},
		{"sol_wrong_effort", func(value *LiveAuthExactModelsDetails, _ *EvidenceReceipt) {
			value.Status.ModelOptions[0].SupportedReasoningEfforts = []string{"high"}
		}},
		{"terra_no_standard", func(value *LiveAuthExactModelsDetails, _ *EvidenceReceipt) {
			value.Status.ModelOptions[1].SupportedSpeeds = []string{"fast"}
		}},
		{"duplicate_model", func(value *LiveAuthExactModelsDetails, _ *EvidenceReceipt) {
			value.Status.ModelOptions[1].ID = core.PlannerModel
		}},
		{"fast_default", func(value *LiveAuthExactModelsDetails, _ *EvidenceReceipt) {
			value.Status.DefaultRunConfiguration.Speed = "fast"
		}},
		{"wrong_loopback", func(value *LiveAuthExactModelsDetails, _ *EvidenceReceipt) {
			value.SessionEndpoint = "http://localhost:43123"
		}},
		{"wrong_process_hash", func(value *LiveAuthExactModelsDetails, _ *EvidenceReceipt) {
			value.ProcessExecutableSHA256 = strings.Repeat("f", 64)
		}},
		{"response_subject", func(_ *LiveAuthExactModelsDetails, value *EvidenceReceipt) {
			setTestSubject(value, "product-status-response", strings.Repeat("f", 64))
		}},
		{"extra_subject", func(_ *LiveAuthExactModelsDetails, value *EvidenceReceipt) {
			value.SubjectHashes = append(value.SubjectHashes, SubjectHash{Name: "unreviewed", SHA256: strings.Repeat("e", 64)})
		}},
		{"producer", func(_ *LiveAuthExactModelsDetails, value *EvidenceReceipt) { value.Producer.Name = "self-declared" }},
		{"prepared_revision", func(value *LiveAuthExactModelsDetails, _ *EvidenceReceipt) { value.LedgerRevision++ }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mutatedDetails := cloneLiveAuthDetails(t, details)
			mutatedReceipt := receipt
			mutatedReceipt.SubjectHashes = append([]SubjectHash(nil), receipt.SubjectHashes...)
			test.mutate(&mutatedDetails, &mutatedReceipt)
			mutatedRaw := mustJSON(t, mutatedDetails)
			mutatedReceipt.DetailsSHA256 = testDigest(mutatedRaw)
			setTestSubject(&mutatedReceipt, "live-auth-exact-models-details", mutatedReceipt.DetailsSHA256)
			if err := ValidateLiveAuthExactModelsEvidenceForLedger(
				mutatedRaw, mutatedReceipt, details.LedgerRevision, details.LedgerPreparedAt,
			); err == nil {
				t.Fatal("mutated live auth evidence was accepted")
			}
		})
	}
}

func TestLiveAuthExactModelsVerifierRejectsUnknownDetailsField(t *testing.T) {
	details, receipt := validLiveAuthEvidenceFixture(t)
	raw := mustJSON(t, details)
	raw = append(raw[:len(raw)-1], []byte(`,"token":"must-not-be-accepted"}`)...)
	receipt.DetailsSHA256 = testDigest(raw)
	setTestSubject(&receipt, "live-auth-exact-models-details", receipt.DetailsSHA256)
	if err := ValidateLiveAuthExactModelsEvidence(raw, receipt); err == nil {
		t.Fatal("unknown live auth details field was accepted")
	}
}

func validLiveAuthEvidenceFixture(t *testing.T) (LiveAuthExactModelsDetails, EvidenceReceipt) {
	t.Helper()
	build := testBuild("6")
	candidateID, err := CandidateID(build)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Unix(1_700_000_000, 0).UTC()
	environment := LiveAuthEnvironment{OS: "windows", Architecture: "amd64", WindowsVersion: "10.0.26100", LogicalProcessors: 8}
	account := codex.AccountStatus{
		Authenticated: true, ChatGPT: true, AccountType: "chatgpt", PlanType: "pro", RequiresOpenAIAuth: true,
	}
	status := LiveAuthProductStatus{
		Ready: true, Version: build.Version, Platform: "windows/amd64", ProductBuild: build,
		ModelOptions: []core.ModelOption{
			{ID: core.PlannerModel, DisplayName: "5.6 Sol", DefaultReasoningEffort: core.PlannerEffort, SupportedReasoningEfforts: []string{"high", core.PlannerEffort}, SupportedSpeeds: []string{"standard", "fast"}},
			{ID: core.CollectorModel, DisplayName: "5.6 Terra", DefaultReasoningEffort: core.CollectorEffort, SupportedReasoningEfforts: []string{core.CollectorEffort}, SupportedSpeeds: []string{"standard"}},
		},
		DefaultRunConfiguration: LiveAuthDefaultRunConfiguration{Model: core.PlannerModel, ReasoningEffort: core.PlannerEffort, Speed: "standard"},
	}
	accountSHA, _ := canonicalSHA256(account)
	statusSHA, _ := canonicalSHA256(status)
	details := LiveAuthExactModelsDetails{
		Schema: LiveAuthExactModelsDetailsSchemaV1, GateID: "live_auth_exact_models", ReleaseCandidateID: candidateID,
		LedgerSHA256: strings.Repeat("8", 64), LedgerRevision: 3, LedgerPreparedAt: start,
		ObservationStartedAt: start.Add(time.Second), ObservationFinishedAt: start.Add(6 * time.Second),
		CandidateExecutable: filepath.Join(`C:\AetherOps`, "aetherops.exe"), CandidateBefore: build, CandidateAfter: build,
		SessionEndpoint: "http://127.0.0.1:43123", SessionPID: 4312, SessionStartedAt: start.Add(-time.Minute),
		SessionDescriptorSHA256: strings.Repeat("7", 64), SessionFilesProtected: true, SessionReauthenticated: true,
		LedgerReauthenticated: true, ProcessExecutableSHA256: build.ExecutableSHA256, Environment: environment,
		AccountRequest: LiveAuthAPIObservation{
			Method: "GET", Path: "/api/v1/auth/codex/status", StartedAt: start.Add(2 * time.Second),
			FinishedAt: start.Add(3 * time.Second), HTTPStatus: 200, MediaType: "application/json",
			ResponseBytes: 120, ResponseSHA256: strings.Repeat("4", 64), ParsedSHA256: accountSHA,
		},
		StatusRequest: LiveAuthAPIObservation{
			Method: "GET", Path: "/api/v1/status", StartedAt: start.Add(4 * time.Second),
			FinishedAt: start.Add(5 * time.Second), HTTPStatus: 200, MediaType: "application/json",
			ResponseBytes: 512, ResponseSHA256: strings.Repeat("5", 64), ParsedSHA256: statusSHA,
		},
		Account: account, Status: status, RequiredSelections: LiveAuthRequiredSelections(),
		EvidenceScope: LiveAuthEvidenceScope(), ExcludedReleaseClaims: LiveAuthExcludedClaims(),
	}
	raw := mustJSON(t, details)
	identity, err := LiveAuthEnvironmentIdentity(environment, details.SessionEndpoint, details.SessionPID, build.ExecutableSHA256)
	if err != nil {
		t.Fatal(err)
	}
	receipt := EvidenceReceipt{
		Schema: EvidenceSchemaV1, GateID: details.GateID, EvidenceKind: EvidenceLiveService,
		ReleaseCandidateID: candidateID, ProductBuild: build,
		Producer:    Producer{Name: LiveAuthExactModelsProducerName, Version: LiveAuthExactModelsProducerVersion},
		Environment: Environment{Class: string(EvidenceLiveService), OS: "windows-11", Architecture: "amd64", IdentitySHA256: identity},
		ObservedAt:  details.ObservationFinishedAt, Status: "passed", DetailsPath: "live-auth.details.json", DetailsSHA256: testDigest(raw),
		SubjectHashes: []SubjectHash{
			{Name: "aetherops.exe", SHA256: build.ExecutableSHA256},
			{Name: "runtime-manifest.json", SHA256: build.RuntimeManifestSHA256},
			{Name: "knowledge-sidecar-tree", SHA256: build.KnowledgeSidecarTreeSHA256},
			{Name: "prepared-ledger", SHA256: details.LedgerSHA256},
			{Name: "live-auth-exact-models-details", SHA256: testDigest(raw)},
			{Name: "release-session-descriptor", SHA256: details.SessionDescriptorSHA256},
			{Name: "auth-codex-status-response", SHA256: details.AccountRequest.ResponseSHA256},
			{Name: "product-status-response", SHA256: details.StatusRequest.ResponseSHA256},
		},
	}
	return details, receipt
}

func cloneLiveAuthDetails(t *testing.T, source LiveAuthExactModelsDetails) LiveAuthExactModelsDetails {
	t.Helper()
	raw := mustJSON(t, source)
	var result LiveAuthExactModelsDetails
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func testDigest(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}
