package releasegate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"github.com/djkim0320/AetherOps/internal/codex"
	"github.com/djkim0320/AetherOps/internal/core"
)

const (
	LiveAuthExactModelsDetailsSchemaV1 = "aetherops_live_auth_exact_models_details_v1"
	LiveAuthExactModelsProducerName    = "cmd/liveauthevidence"
	LiveAuthExactModelsProducerVersion = "1"
	liveAuthEnvironmentDomain          = "aetherops-live-auth-exact-models-environment-v1\x00"
)

type LiveAuthEnvironment struct {
	OS                string `json:"os"`
	Architecture      string `json:"architecture"`
	WindowsVersion    string `json:"windows_version"`
	LogicalProcessors int    `json:"logical_processors"`
}

type LiveAuthAPIObservation struct {
	Method         string    `json:"method"`
	Path           string    `json:"path"`
	StartedAt      time.Time `json:"started_at"`
	FinishedAt     time.Time `json:"finished_at"`
	HTTPStatus     int       `json:"http_status"`
	MediaType      string    `json:"media_type"`
	ResponseBytes  int64     `json:"response_bytes"`
	ResponseSHA256 string    `json:"response_sha256"`
	ParsedSHA256   string    `json:"parsed_sha256"`
}

type LiveAuthDefaultRunConfiguration struct {
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoning_effort"`
	Speed           string `json:"speed"`
}

type LiveAuthProductStatus struct {
	Ready                   bool                            `json:"ready"`
	Version                 string                          `json:"version"`
	Platform                string                          `json:"platform"`
	ProductBuild            buildinfo.ProductBuildBinding   `json:"product_build"`
	ModelOptions            []core.ModelOption              `json:"model_options"`
	DefaultRunConfiguration LiveAuthDefaultRunConfiguration `json:"default_run_configuration"`
}

type LiveAuthRequiredSelection struct {
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoning_effort"`
	Speed           string `json:"speed"`
}

type LiveAuthExactModelsDetails struct {
	Schema                  string                        `json:"schema"`
	GateID                  string                        `json:"gate_id"`
	ReleaseCandidateID      string                        `json:"release_candidate_id"`
	LedgerSHA256            string                        `json:"ledger_sha256"`
	LedgerRevision          int                           `json:"ledger_revision"`
	LedgerPreparedAt        time.Time                     `json:"ledger_prepared_at"`
	ObservationStartedAt    time.Time                     `json:"observation_started_at"`
	ObservationFinishedAt   time.Time                     `json:"observation_finished_at"`
	CandidateExecutable     string                        `json:"candidate_executable"`
	CandidateBefore         buildinfo.ProductBuildBinding `json:"candidate_before"`
	CandidateAfter          buildinfo.ProductBuildBinding `json:"candidate_after"`
	SessionEndpoint         string                        `json:"session_endpoint"`
	SessionPID              int                           `json:"session_pid"`
	SessionStartedAt        time.Time                     `json:"session_started_at"`
	SessionDescriptorSHA256 string                        `json:"session_descriptor_sha256"`
	SessionFilesProtected   bool                          `json:"session_files_protected"`
	SessionReauthenticated  bool                          `json:"session_reauthenticated"`
	LedgerReauthenticated   bool                          `json:"ledger_reauthenticated"`
	ProcessExecutableSHA256 string                        `json:"process_executable_sha256"`
	Environment             LiveAuthEnvironment           `json:"environment"`
	AccountRequest          LiveAuthAPIObservation        `json:"account_request"`
	StatusRequest           LiveAuthAPIObservation        `json:"status_request"`
	Account                 codex.AccountStatus           `json:"account"`
	Status                  LiveAuthProductStatus         `json:"status"`
	RequiredSelections      []LiveAuthRequiredSelection   `json:"required_selections"`
	EvidenceScope           []string                      `json:"evidence_scope"`
	ExcludedReleaseClaims   []string                      `json:"excluded_release_claims"`
}

func LiveAuthRequiredSelections() []LiveAuthRequiredSelection {
	return []LiveAuthRequiredSelection{
		{Model: core.PlannerModel, ReasoningEffort: core.PlannerEffort, Speed: "standard"},
		{Model: core.CollectorModel, ReasoningEffort: core.CollectorEffort, Speed: "standard"},
	}
}

func LiveAuthEvidenceScope() []string {
	return []string{
		"live_auth_exact_models", "live_service", "authenticated_chatgpt_account",
		"exact_model_catalog", "standard_service_tier", "exact_packaged_product_process",
	}
}

func LiveAuthExcludedClaims() []string {
	return []string{
		"overall_release_success", "successful_model_turn", "embedding_api_access",
		"quality_12_pass", "clean_vm_installation", "production_update_feed",
	}
}

func LiveAuthEnvironmentIdentity(
	environment LiveAuthEnvironment, endpoint string, processID int, processExecutableSHA256 string,
) (string, error) {
	if environment.OS != "windows" || environment.Architecture != "amd64" ||
		!windows11Version(environment.WindowsVersion) || environment.LogicalProcessors < 1 ||
		!validLiveAuthLoopbackEndpoint(endpoint) || processID <= 0 || !validDigest(processExecutableSHA256) {
		return "", errors.New("live auth environment identity input is invalid")
	}
	canonical, err := json.Marshal(struct {
		Environment             LiveAuthEnvironment `json:"environment"`
		Endpoint                string              `json:"endpoint"`
		ProcessID               int                 `json:"process_id"`
		ProcessExecutableSHA256 string              `json:"process_executable_sha256"`
	}{environment, endpoint, processID, processExecutableSHA256})
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	_, _ = hash.Write([]byte(liveAuthEnvironmentDomain))
	_, _ = hash.Write(canonical)
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// ValidateLiveAuthExactModelsEvidence is intentionally independent of the
// releasegate policy/dispatch switch. It lets the production producer and
// mutation tests share one typed verifier until the gate is coordinated into
// the global admission policy.
func ValidateLiveAuthExactModelsEvidence(raw []byte, receipt EvidenceReceipt) error {
	return ValidateLiveAuthExactModelsEvidenceForLedger(raw, receipt, 0, time.Time{})
}

func ValidateLiveAuthExactModelsEvidenceForLedger(
	raw []byte, receipt EvidenceReceipt, preparedRevision int, preparedAt time.Time,
) error {
	if receipt.Schema != EvidenceSchemaV1 || receipt.GateID != "live_auth_exact_models" ||
		receipt.EvidenceKind != EvidenceLiveService || receipt.Producer != (Producer{
		Name: LiveAuthExactModelsProducerName, Version: LiveAuthExactModelsProducerVersion,
	}) || receipt.Status != "passed" || receipt.ObservedAt.IsZero() {
		return errors.New("live auth evidence outer identity or producer is invalid")
	}
	if err := receipt.ProductBuild.Validate(); err != nil {
		return err
	}
	candidateID, err := CandidateID(receipt.ProductBuild)
	if err != nil || receipt.ReleaseCandidateID != candidateID {
		return errors.New("live auth evidence candidate id does not match its product build")
	}
	if _, err := secureDetailsName(receipt.DetailsPath); err != nil || !validDigest(receipt.DetailsSHA256) {
		return errors.New("live auth evidence details sibling is invalid")
	}
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:]) != receipt.DetailsSHA256 {
		return errors.New("live auth evidence details hash does not match its typed body")
	}
	var details LiveAuthExactModelsDetails
	if err := decodeStrict(raw, &details); err != nil {
		return fmt.Errorf("decode live auth exact-model details: %w", err)
	}
	if details.Schema != LiveAuthExactModelsDetailsSchemaV1 || details.GateID != receipt.GateID ||
		details.ReleaseCandidateID != receipt.ReleaseCandidateID || details.CandidateBefore != receipt.ProductBuild ||
		details.CandidateAfter != receipt.ProductBuild || details.ProcessExecutableSHA256 != receipt.ProductBuild.ExecutableSHA256 ||
		details.LedgerRevision < 1 || !validDigest(details.LedgerSHA256) || !validDigest(details.SessionDescriptorSHA256) ||
		!filepath.IsAbs(details.CandidateExecutable) || !strings.EqualFold(filepath.Base(details.CandidateExecutable), "aetherops.exe") ||
		!details.SessionFilesProtected || !details.SessionReauthenticated || !details.LedgerReauthenticated {
		return errors.New("live auth details candidate, ledger, process, or protected-session identity is invalid")
	}
	if preparedRevision > 0 && details.LedgerRevision != preparedRevision {
		return errors.New("live auth details ledger revision does not match its immediate attachment predecessor")
	}
	if !preparedAt.IsZero() && !details.LedgerPreparedAt.Equal(preparedAt) {
		return errors.New("live auth details ledger timestamp does not match its attachment chain")
	}
	if details.LedgerPreparedAt.IsZero() || details.ObservationStartedAt.Before(details.LedgerPreparedAt) ||
		details.ObservationFinishedAt.Before(details.ObservationStartedAt) ||
		!details.ObservationFinishedAt.Equal(receipt.ObservedAt) || details.SessionStartedAt.IsZero() ||
		details.SessionStartedAt.After(details.ObservationStartedAt) || details.SessionPID <= 0 {
		return errors.New("live auth evidence observation or process session window is invalid")
	}
	if err := validateLiveAuthObservation(details.AccountRequest, "/api/v1/auth/codex/status", details.ObservationStartedAt, details.ObservationFinishedAt); err != nil {
		return fmt.Errorf("Codex account observation: %w", err)
	}
	if err := validateLiveAuthObservation(details.StatusRequest, "/api/v1/status", details.ObservationStartedAt, details.ObservationFinishedAt); err != nil {
		return fmt.Errorf("product status observation: %w", err)
	}
	if details.StatusRequest.StartedAt.Before(details.AccountRequest.FinishedAt) {
		return errors.New("live auth API observations are not one ordered readback")
	}
	if !details.Account.Authenticated || !details.Account.ChatGPT || details.Account.AccountType != "chatgpt" ||
		strings.TrimSpace(details.Account.PlanType) == "" || details.Account.PlanType != strings.TrimSpace(details.Account.PlanType) ||
		!details.Account.RequiresOpenAIAuth {
		return errors.New("Codex account readback is not an authenticated managed ChatGPT account")
	}
	if err := validateLiveAuthProductStatus(details.Status, receipt.ProductBuild); err != nil {
		return err
	}
	if !reflect.DeepEqual(details.RequiredSelections, LiveAuthRequiredSelections()) ||
		!reflect.DeepEqual(details.EvidenceScope, LiveAuthEvidenceScope()) ||
		!reflect.DeepEqual(details.ExcludedReleaseClaims, LiveAuthExcludedClaims()) {
		return errors.New("live auth required selections or evidence scope are invalid")
	}
	accountParsedSHA, err := canonicalSHA256(details.Account)
	if err != nil || details.AccountRequest.ParsedSHA256 != accountParsedSHA {
		return errors.New("Codex account parsed response hash is invalid")
	}
	statusParsedSHA, err := canonicalSHA256(details.Status)
	if err != nil || details.StatusRequest.ParsedSHA256 != statusParsedSHA {
		return errors.New("product status parsed response hash is invalid")
	}
	identity, err := LiveAuthEnvironmentIdentity(
		details.Environment, details.SessionEndpoint, details.SessionPID, details.ProcessExecutableSHA256,
	)
	if err != nil || receipt.Environment != (Environment{
		Class: string(EvidenceLiveService), OS: "windows-11", Architecture: "amd64", IdentitySHA256: identity,
	}) {
		return errors.New("live auth evidence environment and process identity is invalid")
	}
	subjects, err := receiptSubjectMap(receipt)
	if err != nil {
		return err
	}
	wantSubjects := map[string]string{
		"aetherops.exe":                  receipt.ProductBuild.ExecutableSHA256,
		"runtime-manifest.json":          receipt.ProductBuild.RuntimeManifestSHA256,
		"knowledge-sidecar-tree":         receipt.ProductBuild.KnowledgeSidecarTreeSHA256,
		"prepared-ledger":                details.LedgerSHA256,
		"live-auth-exact-models-details": receipt.DetailsSHA256,
		"release-session-descriptor":     details.SessionDescriptorSHA256,
		"auth-codex-status-response":     details.AccountRequest.ResponseSHA256,
		"product-status-response":        details.StatusRequest.ResponseSHA256,
	}
	if !reflect.DeepEqual(subjects, wantSubjects) {
		return errors.New("live auth evidence subject set is incomplete, excessive, or mismatched")
	}
	return nil
}

func validateLiveAuthObservation(observation LiveAuthAPIObservation, path string, started, finished time.Time) error {
	if observation.Method != "GET" || observation.Path != path || observation.HTTPStatus != 200 ||
		observation.MediaType != "application/json" || observation.ResponseBytes <= 0 ||
		observation.ResponseBytes > 512<<10 || !validDigest(observation.ResponseSHA256) ||
		!validDigest(observation.ParsedSHA256) || observation.StartedAt.Before(started) ||
		observation.FinishedAt.Before(observation.StartedAt) || observation.FinishedAt.After(finished) {
		return errors.New("authenticated API method, path, response, hash, or time bounds are invalid")
	}
	return nil
}

func validateLiveAuthProductStatus(status LiveAuthProductStatus, build buildinfo.ProductBuildBinding) error {
	if !status.Ready || status.Version != buildinfo.ReleaseProductVersion || status.Platform != "windows/amd64" ||
		status.ProductBuild != build || status.DefaultRunConfiguration != (LiveAuthDefaultRunConfiguration{
		Model: core.PlannerModel, ReasoningEffort: core.PlannerEffort, Speed: "standard",
	}) || len(status.ModelOptions) < 2 {
		return errors.New("live product status is unready or does not expose the exact build/default standard profile")
	}
	options := make(map[string]core.ModelOption, len(status.ModelOptions))
	for _, option := range status.ModelOptions {
		if strings.TrimSpace(option.ID) == "" || option.ID != strings.TrimSpace(option.ID) ||
			strings.TrimSpace(option.DisplayName) == "" {
			return errors.New("live product model catalog contains an incomplete model option")
		}
		if _, duplicate := options[option.ID]; duplicate {
			return fmt.Errorf("live product model catalog duplicates %q", option.ID)
		}
		if duplicateStrings(option.SupportedReasoningEfforts) || duplicateStrings(option.SupportedSpeeds) {
			return fmt.Errorf("live product model option %q duplicates an effort or speed", option.ID)
		}
		options[option.ID] = option
	}
	for _, selection := range LiveAuthRequiredSelections() {
		option, ok := options[selection.Model]
		if !ok || !containsString(option.SupportedReasoningEfforts, selection.ReasoningEffort) ||
			!containsString(option.SupportedSpeeds, selection.Speed) {
			return fmt.Errorf("live product model catalog lacks exact %s/%s/%s support", selection.Model, selection.ReasoningEffort, selection.Speed)
		}
	}
	return nil
}

func canonicalSHA256(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func duplicateStrings(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value == "" || value != strings.TrimSpace(value) {
			return true
		}
		if _, duplicate := seen[value]; duplicate {
			return true
		}
		seen[value] = struct{}{}
	}
	return false
}

func secureDetailsName(name string) (string, error) {
	if filepath.Base(name) != name || strings.ContainsAny(name, `\\/:`) || !strings.HasSuffix(name, ".details.json") {
		return "", errors.New("details name is not a direct safe sibling")
	}
	return name, nil
}

func validLiveAuthLoopbackEndpoint(endpoint string) bool {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
		return false
	}
	host, portText, err := net.SplitHostPort(parsed.Host)
	if err != nil || host != "127.0.0.1" {
		return false
	}
	port, err := strconv.Atoi(portText)
	return err == nil && port >= 1 && port <= 65535 && endpoint == "http://127.0.0.1:"+strconv.Itoa(port)
}
