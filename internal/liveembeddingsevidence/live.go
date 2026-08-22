package liveembeddingsevidence

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/evalgate"
	"github.com/djkim0320/Aether-claw/internal/evalrunner"
	"github.com/djkim0320/Aether-claw/internal/releasegate"
	"github.com/djkim0320/Aether-claw/internal/securepath"
	"github.com/djkim0320/Aether-claw/internal/store"
)

type LiveConfig struct {
	CandidateExecutable string
	PreparedLedger      string
	DatasetPath         string
	RunnerReceipt       string
	SessionDescriptor   string
	Query               string
	JournalPath         string
}

type authenticatedInputs struct {
	Build      buildinfo.ProductBuildBinding
	Ledger     releasegate.Ledger
	LedgerSHA  string
	Runner     evalrunner.Receipt
	Descriptor evalrunner.SessionDescriptor
	Token      []byte
}

type httpDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// ObserveLive performs the two state-changing product calls exactly once.
// The protected token is held only in memory and zeroed before return.
func ObserveLive(ctx context.Context, config LiveConfig) (observation LiveObservation, returnErr error) {
	inputs, err := authenticateLiveInputs(config)
	if err != nil {
		return LiveObservation{}, err
	}
	defer evalrunner.ZeroToken(inputs.Token)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	client := &http.Client{
		Transport: transport, Timeout: 2 * time.Hour,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return observeLive(ctx, config, inputs, client)
}

func observeLive(ctx context.Context, config LiveConfig, inputs authenticatedInputs, client httpDoer) (LiveObservation, error) {
	query := strings.TrimSpace(config.Query)
	queryDigest := sha256.Sum256([]byte(query))
	querySHA := hex.EncodeToString(queryDigest[:])
	api := liveAPI{endpoint: inputs.Descriptor.Endpoint, token: inputs.Token, client: client}
	if err := api.preflight(ctx, inputs.Build); err != nil {
		return LiveObservation{}, err
	}
	documents, err := api.documents(ctx, inputs.Runner.Target.ProjectID)
	if err != nil {
		return LiveObservation{}, fmt.Errorf("read populated project memory: %w", err)
	}
	documentObservation, err := observeDocuments(documents)
	if err != nil {
		return LiveObservation{}, err
	}
	before, err := api.status(ctx, inputs.Runner.Target.ProjectID)
	if err != nil {
		return LiveObservation{}, fmt.Errorf("read pre-reindex memory status: %w", err)
	}
	binding := Binding{
		ProductBuild: inputs.Build, ReleaseCandidateID: inputs.Ledger.ReleaseCandidateID,
		PreparedLedgerSHA256: inputs.LedgerSHA, PreparedLedgerRevision: inputs.Ledger.Revision, LedgerPreparedAt: inputs.Ledger.PreparedAt,
		RunnerReceiptSHA256: inputs.Runner.SHA256, EvalRunSetID: inputs.Runner.EvalRunSetID, ProjectID: inputs.Runner.Target.ProjectID,
		EndpointSHA256: inputs.Runner.EndpointSHA256, QuerySHA256: querySHA, SessionStartedAt: inputs.Descriptor.StartedAt,
		RunnerTerminalAt: inputs.Runner.TerminalAt,
	}
	if err := validatePreparedMemory(binding, documentObservation, before); err != nil {
		return LiveObservation{}, err
	}
	if err := reauthenticateLiveInputs(config, inputs); err != nil {
		return LiveObservation{}, fmt.Errorf("reauthenticate immediately before live journal: %w", err)
	}
	journal, err := createJournal(config.JournalPath)
	if err != nil {
		return LiveObservation{}, fmt.Errorf("create new live journal: %w", err)
	}
	defer journal.close()
	now := time.Now().UTC()
	if err := journal.append(JournalRecord{State: StatePrepared, WrittenAt: now, Binding: &binding, Documents: &documentObservation, Before: &before}); err != nil {
		return LiveObservation{}, err
	}
	if err := journal.append(JournalRecord{State: StateReindexSubmitting, WrittenAt: time.Now().UTC()}); err != nil {
		return LiveObservation{}, err
	}
	index, responseHead, err := api.reindex(ctx, binding.ProjectID)
	if err != nil {
		state := StateReindexAmbiguous
		code := "REINDEX_OUTCOME_AMBIGUOUS"
		var definitive definitiveHTTPError
		if errors.As(err, &definitive) {
			state, code = StateReindexFailed, fmt.Sprintf("REINDEX_HTTP_%d", definitive.Status)
		}
		_ = journal.append(JournalRecord{State: state, WrittenAt: time.Now().UTC(), FailureCode: code})
		return LiveObservation{}, err
	}
	after, err := api.status(ctx, binding.ProjectID)
	if err != nil {
		_ = journal.append(JournalRecord{State: StateReindexAmbiguous, WrittenAt: time.Now().UTC(), FailureCode: "REINDEX_READBACK_AMBIGUOUS"})
		return LiveObservation{}, errors.New("reindex committed but exact status readback failed; journal is terminal and the POST must not be retried")
	}
	if responseHead.ActiveIndexID != after.ActiveIndexID || responseHead.MemoryRevision != after.MemoryRevision {
		_ = journal.append(JournalRecord{State: StateReindexAmbiguous, WrittenAt: time.Now().UTC(), FailureCode: "REINDEX_RESPONSE_READBACK_MISMATCH"})
		return LiveObservation{}, errors.New("reindex response and status readback differ; the POST must not be retried")
	}
	if err := validateReindexTransition(binding.ProjectID, before, index, after); err != nil {
		_ = journal.append(JournalRecord{State: StateReindexFailed, WrittenAt: time.Now().UTC(), FailureCode: "REINDEX_CONTRACT_REJECTED"})
		return LiveObservation{}, err
	}
	if err := journal.append(JournalRecord{State: StateReindexObserved, WrittenAt: time.Now().UTC(), Index: &index, After: &after}); err != nil {
		return LiveObservation{}, err
	}
	if err := journal.append(JournalRecord{State: StateSearchSubmitting, WrittenAt: time.Now().UTC()}); err != nil {
		return LiveObservation{}, err
	}
	search, err := api.search(ctx, binding.ProjectID, query)
	if err != nil {
		state := StateSearchAmbiguous
		code := "SEARCH_OUTCOME_AMBIGUOUS"
		var definitive definitiveHTTPError
		if errors.As(err, &definitive) {
			state, code = StateSearchFailed, fmt.Sprintf("SEARCH_HTTP_%d", definitive.Status)
		}
		_ = journal.append(JournalRecord{State: state, WrittenAt: time.Now().UTC(), FailureCode: code})
		return LiveObservation{}, err
	}
	if err := validateSearch(search, binding.ProjectID, binding.QuerySHA256, index.ID, after.MemoryRevision); err != nil {
		_ = journal.append(JournalRecord{State: StateSearchFailed, WrittenAt: time.Now().UTC(), FailureCode: "SEARCH_CONTRACT_REJECTED"})
		return LiveObservation{}, err
	}
	finished := time.Now().UTC()
	if err := journal.append(JournalRecord{State: StateLiveComplete, WrittenAt: finished, Search: &search}); err != nil {
		return LiveObservation{}, err
	}
	if err := journal.close(); err != nil {
		return LiveObservation{}, err
	}
	if err := reauthenticateLiveInputs(config, inputs); err != nil {
		return LiveObservation{}, fmt.Errorf("reauthenticate after live observation: %w", err)
	}
	return loadCompleteJournal(config.JournalPath)
}

func authenticateLiveInputs(config LiveConfig) (authenticatedInputs, error) {
	query := strings.TrimSpace(config.Query)
	if query == "" || len([]rune(query)) > 4096 {
		return authenticatedInputs{}, errors.New("a 1-4096 character exact search query is required")
	}
	build, err := AuthenticateCandidate(config.CandidateExecutable)
	if err != nil {
		return authenticatedInputs{}, err
	}
	ledger, ledgerSHA, err := releasegate.LoadLedgerChain(config.PreparedLedger)
	if err != nil || ledger.ProductBuild != build || !gateEmpty(ledger) {
		return authenticatedInputs{}, errors.New("prepared ledger is not the exact current empty live_embeddings_shadow ledger")
	}
	dataset, err := evalgate.LoadDataset(config.DatasetPath)
	if err != nil {
		return authenticatedInputs{}, err
	}
	runner, err := evalrunner.LoadReceipt(config.RunnerReceipt, dataset, build)
	if err != nil {
		return authenticatedInputs{}, err
	}
	if runner.Target.ProjectID == "" || runner.Target.SessionID != "" || runner.TerminalAt.Before(ledger.PreparedAt) {
		return authenticatedInputs{}, errors.New("live runner receipt must target one populated project after ledger preparation")
	}
	descriptor, token, err := evalrunner.LoadSessionDescriptor(config.SessionDescriptor, build)
	if err != nil {
		return authenticatedInputs{}, err
	}
	endpointDigest := sha256.Sum256([]byte(descriptor.Endpoint))
	if hex.EncodeToString(endpointDigest[:]) != runner.EndpointSHA256 || descriptor.StartedAt.After(runner.StartedAt) {
		evalrunner.ZeroToken(token)
		return authenticatedInputs{}, errors.New("protected session is not the exact live evaluation runner session")
	}
	return authenticatedInputs{Build: build, Ledger: ledger, LedgerSHA: ledgerSHA, Runner: runner, Descriptor: descriptor, Token: token}, nil
}

func reauthenticateLiveInputs(config LiveConfig, expected authenticatedInputs) error {
	build, err := AuthenticateCandidate(config.CandidateExecutable)
	if err != nil || build != expected.Build {
		return errors.New("candidate changed")
	}
	ledger, ledgerSHA, err := releasegate.LoadLedgerChain(config.PreparedLedger)
	if err != nil || ledgerSHA != expected.LedgerSHA || ledger.ProductBuild != expected.Build || ledger.Revision != expected.Ledger.Revision || !gateEmpty(ledger) {
		return errors.New("prepared ledger changed")
	}
	descriptor, token, err := evalrunner.LoadSessionDescriptor(config.SessionDescriptor, expected.Build)
	if err != nil {
		return err
	}
	defer evalrunner.ZeroToken(token)
	if descriptor != expected.Descriptor || len(token) != len(expected.Token) || subtle.ConstantTimeCompare(token, expected.Token) != 1 {
		return errors.New("protected live evaluation session changed")
	}
	return nil
}

func AuthenticateCandidate(executablePath string) (buildinfo.ProductBuildBinding, error) {
	executable, err := securepath.RegularPath(strings.TrimSpace(executablePath))
	if err != nil {
		return buildinfo.ProductBuildBinding{}, fmt.Errorf("authenticate candidate executable: %w", err)
	}
	if !strings.EqualFold(filepath.Base(executable), "aetherops.exe") {
		return buildinfo.ProductBuildBinding{}, errors.New("candidate executable must be named aetherops.exe")
	}
	directory := filepath.Dir(executable)
	manifest, err := securepath.RegularPathWithin(directory, "runtime-manifest.json")
	if err != nil {
		return buildinfo.ProductBuildBinding{}, err
	}
	sidecar, err := securepath.RegularPathWithin(directory, filepath.Join("knowledge-sidecar", "index.cjs"))
	if err != nil {
		return buildinfo.ProductBuildBinding{}, err
	}
	return buildinfo.BindProductBuild(executable, manifest, sidecar)
}

func gateEmpty(ledger releasegate.Ledger) bool {
	for _, row := range ledger.Evidence {
		if row.GateID == "live_embeddings_shadow" {
			return row.ReceiptPath == "" && row.ReceiptSHA256 == ""
		}
	}
	return false
}

func validatePreparedMemory(binding Binding, documents DocumentObservation, before store.ProjectMemoryHead) error {
	if documents.Count < 1 || !validateDigest(documents.SetSHA256) || before.ProjectID != binding.ProjectID || before.State != "ready" ||
		before.ActiveIndex == nil || before.ActiveIndexID == "" || before.ShadowIndexID != "" || before.Error != "" || before.ActiveIndex.State != "active" ||
		before.ActiveIndex.Model != "text-embedding-3-small" || before.ActiveIndex.Dimensions != 1536 {
		return errors.New("existing populated project does not have one ready supported active index")
	}
	return nil
}

func validateReindexTransition(projectID string, before store.ProjectMemoryHead, index store.EmbeddingIndex, after store.ProjectMemoryHead) error {
	if index.ProjectID != projectID || index.ID == "" || index.ID == before.ActiveIndexID || index.State != "active" ||
		index.Model != "text-embedding-3-small" || index.Dimensions != 1536 || index.CompletedAt == nil ||
		after.ProjectID != projectID || after.ActiveIndexID != index.ID || after.MemoryRevision != before.MemoryRevision+1 ||
		after.State != "ready" || after.Error != "" || after.ShadowIndexID != "" || after.ActiveIndex == nil || after.ActiveIndex.ID != index.ID {
		return errors.New("reindex did not produce an exact non-noop ready shadow transition")
	}
	return nil
}

type liveAPI struct {
	endpoint string
	token    []byte
	client   httpDoer
}

type definitiveHTTPError struct{ Status int }

func (err definitiveHTTPError) Error() string {
	return fmt.Sprintf("product API returned HTTP %d", err.Status)
}

func (api liveAPI) request(ctx context.Context, method, path string, body []byte, destination any) error {
	request, err := http.NewRequestWithContext(ctx, method, api.endpoint+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+string(api.token))
	request.Header.Set("Origin", api.endpoint)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := api.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return definitiveHTTPError{Status: response.StatusCode}
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
	if err != nil {
		return err
	}
	if len(raw) > 4<<20 {
		return errors.New("product API response exceeds the 4 MiB limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("product API response contains multiple JSON values")
		}
		return err
	}
	return nil
}

func (api liveAPI) preflight(ctx context.Context, build buildinfo.ProductBuildBinding) error {
	var response struct {
		Ready                   bool                          `json:"ready"`
		Version                 string                        `json:"version"`
		Platform                string                        `json:"platform"`
		ProductBuild            buildinfo.ProductBuildBinding `json:"product_build"`
		ModelOptions            json.RawMessage               `json:"model_options"`
		DefaultRunConfiguration json.RawMessage               `json:"default_run_configuration"`
		RuntimeUpdate           json.RawMessage               `json:"runtime_update,omitempty"`
		RuntimeWarnings         json.RawMessage               `json:"runtime_warnings,omitempty"`
		Warnings                json.RawMessage               `json:"warnings,omitempty"`
		Browser                 json.RawMessage               `json:"browser,omitempty"`
	}
	if err := api.request(ctx, http.MethodGet, "/api/v1/status", nil, &response); err != nil {
		return err
	}
	if !response.Ready || response.ProductBuild != build {
		return errors.New("authenticated product API build is not exact or ready")
	}
	return nil
}

func (api liveAPI) documents(ctx context.Context, projectID string) ([]store.MemoryDocument, error) {
	var response struct {
		Memory []store.MemoryDocument `json:"memory"`
	}
	err := api.request(ctx, http.MethodGet, "/api/v1/projects/"+url.PathEscape(projectID)+"/memory", nil, &response)
	return response.Memory, err
}

func (api liveAPI) status(ctx context.Context, projectID string) (store.ProjectMemoryHead, error) {
	var response struct {
		Memory store.ProjectMemoryHead `json:"memory"`
	}
	err := api.request(ctx, http.MethodGet, "/api/v1/projects/"+url.PathEscape(projectID)+"/memory/status", nil, &response)
	return response.Memory, err
}

func (api liveAPI) reindex(ctx context.Context, projectID string) (store.EmbeddingIndex, store.ProjectMemoryHead, error) {
	var response struct {
		Index  store.EmbeddingIndex    `json:"index"`
		Memory store.ProjectMemoryHead `json:"memory"`
	}
	err := api.request(ctx, http.MethodPost, "/api/v1/projects/"+url.PathEscape(projectID)+"/memory/reindex", []byte{}, &response)
	return response.Index, response.Memory, err
}

func (api liveAPI) search(ctx context.Context, projectID, query string) (SearchObservation, error) {
	body, err := json.Marshal(struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}{query, 12})
	if err != nil {
		return SearchObservation{}, err
	}
	var response struct {
		QuerySHA256 string                    `json:"query_sha256"`
		Memory      store.ProjectMemoryHead   `json:"memory"`
		Results     []store.GraphMemoryResult `json:"results"`
	}
	if err := api.request(ctx, http.MethodPost, "/api/v1/projects/"+url.PathEscape(projectID)+"/memory/search", body, &response); err != nil {
		return SearchObservation{}, err
	}
	observed := SearchObservation{QuerySHA256: response.QuerySHA256, Memory: response.Memory, Results: make([]SearchResultObservation, len(response.Results))}
	for index, result := range response.Results {
		digest := sha256.Sum256([]byte(result.Text))
		observed.Results[index] = SearchResultObservation{ChunkID: result.ChunkID, DocumentID: result.DocumentID, TextSHA256: hex.EncodeToString(digest[:]), Score: result.Score}
	}
	raw, err := json.Marshal(observed.Results)
	if err != nil {
		return SearchObservation{}, err
	}
	digest := sha256.Sum256(raw)
	observed.SetSHA256 = hex.EncodeToString(digest[:])
	return observed, nil
}

func observeDocuments(documents []store.MemoryDocument) (DocumentObservation, error) {
	if len(documents) < 1 {
		return DocumentObservation{}, errors.New("release evidence requires an existing populated project")
	}
	sorted := append([]store.MemoryDocument(nil), documents...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ID < sorted[j].ID })
	seen := make(map[string]struct{}, len(sorted))
	for _, document := range sorted {
		if document.ID == "" || document.ProjectID == "" || document.BlobHash == "" || document.Status != "ready" || document.Size < 1 {
			return DocumentObservation{}, errors.New("project memory contains an invalid ready document")
		}
		if _, duplicate := seen[document.ID]; duplicate {
			return DocumentObservation{}, errors.New("project memory duplicates a document")
		}
		seen[document.ID] = struct{}{}
	}
	raw, err := json.Marshal(sorted)
	if err != nil {
		return DocumentObservation{}, err
	}
	digest := sha256.Sum256(raw)
	return DocumentObservation{Count: len(sorted), SetSHA256: hex.EncodeToString(digest[:])}, nil
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
	return hex.EncodeToString(digest.Sum(nil)), nil
}
