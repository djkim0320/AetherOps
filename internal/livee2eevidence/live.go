package livee2eevidence

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
	"math"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/evalgate"
	"github.com/djkim0320/AetherOps/internal/evalrunner"
	"github.com/djkim0320/AetherOps/internal/knowledge"
	"github.com/djkim0320/AetherOps/internal/livee2econtract"
	"github.com/djkim0320/AetherOps/internal/releasegate"
	"github.com/djkim0320/AetherOps/internal/securepath"
	"github.com/djkim0320/AetherOps/internal/store"
)

type LiveConfig struct {
	CandidateExecutable string
	PreparedLedger      string
	DatasetPath         string
	RunnerReceipt       string
	EvaluationReceipt   string
	SessionDescriptor   string
	JournalPath         string
	PollInterval        time.Duration
	HTTPClient          *http.Client
}

type authenticatedInputs struct {
	Build         buildinfo.ProductBuildBinding
	Ledger        releasegate.Ledger
	LedgerSHA256  string
	Dataset       evalgate.Dataset
	Runner        evalrunner.Receipt
	Evaluation    evalgate.Receipt
	EvaluationSHA string
	Descriptor    evalrunner.SessionDescriptor
	DescriptorSHA string
	Token         []byte
}

func ObserveLive(ctx context.Context, config LiveConfig) (result LiveObservation, returnErr error) {
	inputs, err := authenticateLiveInputs(config)
	if err != nil {
		return LiveObservation{}, err
	}
	defer evalrunner.ZeroToken(inputs.Token)
	writer, err := createJournal(config.JournalPath)
	if err != nil {
		return LiveObservation{}, err
	}
	defer func() { returnErr = errors.Join(returnErr, writer.close()) }()
	promptDigest := sha256.Sum256([]byte(ResearchPrompt))
	observationEndpointDigest := sha256.Sum256([]byte(inputs.Descriptor.Endpoint))
	binding := livee2econtract.Binding{
		ProductBuild: inputs.Build, ReleaseCandidateID: inputs.Ledger.ReleaseCandidateID,
		PreparedLedgerSHA256: inputs.LedgerSHA256, PreparedLedgerRevision: inputs.Ledger.Revision,
		LedgerPreparedAt: inputs.Ledger.PreparedAt, RunnerReceiptSHA256: inputs.Runner.SHA256,
		EvaluationSHA256: inputs.EvaluationSHA, EvalRunSetID: inputs.Runner.EvalRunSetID,
		DatasetSHA256: inputs.Dataset.SHA256, RunnerEndpointSHA256: inputs.Runner.EndpointSHA256,
		EvaluationVerifiedAt:               inputs.Evaluation.VerifiedAt,
		ObservationSessionDescriptorSHA256: inputs.DescriptorSHA,
		ObservationEndpointSHA256:          hex.EncodeToString(observationEndpointDigest[:]),
		ObservationSessionStartedAt:        inputs.Descriptor.StartedAt,
		ProjectID:                          inputs.Runner.Target.ProjectID, PromptSHA256: hex.EncodeToString(promptDigest[:]),
	}
	if err := writer.append(JournalRecord{State: StatePrepared, Binding: &binding}); err != nil {
		return LiveObservation{}, err
	}
	client := liveAPI{endpoint: inputs.Descriptor.Endpoint, token: inputs.Token, client: config.HTTPClient}
	if client.client == nil {
		client.client = &http.Client{Timeout: 45 * time.Second}
	}
	if err := client.preflight(ctx, inputs.Build); err != nil {
		return LiveObservation{}, err
	}
	if err := reauthenticateLiveInputs(config, inputs); err != nil {
		return LiveObservation{}, err
	}
	if err := writer.append(JournalRecord{State: StateBrowserObserving}); err != nil {
		return LiveObservation{}, err
	}
	browser, err := client.browserObservation(ctx)
	if err != nil {
		return LiveObservation{}, fmt.Errorf("observe live WebView2 through DevTools MCP: %w", err)
	}
	if err := writer.append(JournalRecord{State: StateBrowserObserved, Browser: &browser}); err != nil {
		return LiveObservation{}, err
	}
	if err := reauthenticateLiveInputs(config, inputs); err != nil {
		return LiveObservation{}, err
	}
	if err := writer.append(JournalRecord{State: StateRunSubmitting}); err != nil {
		return LiveObservation{}, err
	}
	run, ambiguous, err := client.startRun(ctx, inputs.Runner.Target, ResearchPrompt)
	if err != nil {
		if ambiguous {
			return LiveObservation{}, errors.New("research submission outcome is ambiguous; this journal can never be retried")
		}
		return LiveObservation{}, err
	}
	poll := config.PollInterval
	if poll <= 0 {
		poll = 2 * time.Second
	}
	for !core.IsTerminal(run.Status) {
		select {
		case <-ctx.Done():
			return LiveObservation{}, ctx.Err()
		case <-time.After(poll):
		}
		run, err = client.run(ctx, run.ID)
		if err != nil {
			return LiveObservation{}, err
		}
	}
	runObservation := livee2econtract.RunObservation{
		RunID: run.ID, ProjectID: run.ProjectID, ConversationSessionID: run.ConversationSessionID,
		ReportArtifactID: run.ReportArtifactID,
		Status:           string(run.Status), Revision: run.Revision, CreatedAt: run.CreatedAt, TerminalAt: run.UpdatedAt,
	}
	if err := writer.append(JournalRecord{State: StateRunObserved, Run: &runObservation}); err != nil {
		return LiveObservation{}, err
	}
	if run.Status != core.RunSucceeded {
		return LiveObservation{}, fmt.Errorf("end-to-end research terminated as %s", run.Status)
	}
	if err := reauthenticateLiveInputs(config, inputs); err != nil {
		return LiveObservation{}, err
	}
	status, err := client.knowledgeStatus(ctx, run.ProjectID)
	if err != nil || !status.Ready || status.Generation.ID == "" {
		return LiveObservation{}, errors.New("successful run did not leave a ready project knowledge generation")
	}
	if err := writer.append(JournalRecord{State: StateSPARQLSubmitting}); err != nil {
		return LiveObservation{}, err
	}
	sparql, ambiguous, err := client.sparql(ctx, run.ProjectID, status.Generation.ID)
	if err != nil {
		if ambiguous {
			return LiveObservation{}, errors.New("SPARQL POST outcome is ambiguous; this journal can never be retried")
		}
		return LiveObservation{}, err
	}
	if err := writer.append(JournalRecord{State: StateSPARQLObserved, SPARQL: &sparql}); err != nil {
		return LiveObservation{}, err
	}
	entityID, err := client.firstEntity(ctx, run.ProjectID)
	if err != nil {
		return LiveObservation{}, err
	}
	if err := reauthenticateLiveInputs(config, inputs); err != nil {
		return LiveObservation{}, err
	}
	if err := writer.append(JournalRecord{State: StateEditSubmitting}); err != nil {
		return LiveObservation{}, err
	}
	curation, ambiguous, err := client.pinEntity(ctx, run.ProjectID, entityID, run.ID)
	if err != nil {
		if ambiguous {
			return LiveObservation{}, errors.New("Knowledge editor POST outcome is ambiguous; this journal can never be retried")
		}
		return LiveObservation{}, err
	}
	if curation.GenerationID != status.Generation.ID {
		return LiveObservation{}, errors.New("Knowledge editor response changed project generation identity")
	}
	if err := reauthenticateLiveInputs(config, inputs); err != nil {
		return LiveObservation{}, err
	}
	if err := writer.append(JournalRecord{State: StateLiveComplete, Curation: &curation}); err != nil {
		return LiveObservation{}, err
	}
	if err := writer.close(); err != nil {
		return LiveObservation{}, err
	}
	return LoadCompletedJournal(config.JournalPath)
}

func AuthenticateCandidate(executablePath string) (buildinfo.ProductBuildBinding, error) {
	executable, err := securepath.RegularPath(strings.TrimSpace(executablePath))
	if err != nil || !strings.EqualFold(filepath.Base(executable), "aetherops.exe") {
		return buildinfo.ProductBuildBinding{}, errors.New("candidate must be a regular aetherops.exe")
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

func authenticateLiveInputs(config LiveConfig) (authenticatedInputs, error) {
	build, err := AuthenticateCandidate(config.CandidateExecutable)
	if err != nil {
		return authenticatedInputs{}, err
	}
	ledger, ledgerSHA, err := releasegate.LoadLedgerChain(config.PreparedLedger)
	if err != nil || ledger.ProductBuild != build || !gateEmpty(ledger, "live_end_to_end") {
		return authenticatedInputs{}, errors.New("prepared ledger is not the exact current empty live_end_to_end ledger")
	}
	dataset, err := evalgate.LoadDataset(config.DatasetPath)
	if err != nil {
		return authenticatedInputs{}, err
	}
	runner, err := evalrunner.LoadReceipt(config.RunnerReceipt, dataset, build)
	if err != nil || runner.Target.ProjectID == "" || runner.Target.SessionID != "" || runner.TerminalAt.Before(ledger.PreparedAt) {
		return authenticatedInputs{}, errors.New("runner receipt is not a completed real project-scoped live execution for this ledger")
	}
	evaluation, evaluationSHA, err := loadEvaluation(config.EvaluationReceipt)
	if err != nil || validateEvaluation(evaluation, runner, dataset, build) != nil {
		return authenticatedInputs{}, errors.New("evaluation receipt is not the completed real 12/12 runner verification")
	}
	descriptor, token, err := evalrunner.LoadSessionDescriptor(config.SessionDescriptor, build)
	if err != nil {
		return authenticatedInputs{}, err
	}
	descriptorSHA, err := hashRegular(config.SessionDescriptor)
	if err != nil {
		evalrunner.ZeroToken(token)
		return authenticatedInputs{}, err
	}
	if descriptor.StartedAt.Before(evaluation.VerifiedAt) {
		evalrunner.ZeroToken(token)
		return authenticatedInputs{}, errors.New("observation session must start at or after offline evaluation verification")
	}
	return authenticatedInputs{Build: build, Ledger: ledger, LedgerSHA256: ledgerSHA, Dataset: dataset,
		Runner: runner, Evaluation: evaluation, EvaluationSHA: evaluationSHA, Descriptor: descriptor,
		DescriptorSHA: descriptorSHA, Token: token}, nil
}

func reauthenticateLiveInputs(config LiveConfig, expected authenticatedInputs) error {
	build, err := AuthenticateCandidate(config.CandidateExecutable)
	if err != nil || build != expected.Build {
		return errors.New("candidate changed during live observation")
	}
	ledger, ledgerSHA, err := releasegate.LoadLedgerChain(config.PreparedLedger)
	if err != nil || ledgerSHA != expected.LedgerSHA256 || ledger.ProductBuild != expected.Build ||
		ledger.Revision != expected.Ledger.Revision || !gateEmpty(ledger, "live_end_to_end") {
		return errors.New("prepared ledger changed during live observation")
	}
	descriptor, token, err := evalrunner.LoadSessionDescriptor(config.SessionDescriptor, expected.Build)
	if err != nil {
		return err
	}
	defer evalrunner.ZeroToken(token)
	if descriptor != expected.Descriptor || len(token) != len(expected.Token) || subtle.ConstantTimeCompare(token, expected.Token) != 1 {
		return errors.New("protected release session changed during live observation")
	}
	return nil
}

func gateEmpty(ledger releasegate.Ledger, gateID string) bool {
	for _, row := range ledger.Evidence {
		if row.GateID == gateID {
			return row.ReceiptPath == "" && row.ReceiptSHA256 == ""
		}
	}
	return false
}

func loadEvaluation(path string) (evalgate.Receipt, string, error) {
	raw, err := securepath.ReadRegular(strings.TrimSpace(path), 4<<20)
	if err != nil {
		return evalgate.Receipt{}, "", err
	}
	var receipt evalgate.Receipt
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&receipt); err != nil {
		return evalgate.Receipt{}, "", err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return evalgate.Receipt{}, "", errors.New("evaluation receipt contains trailing JSON")
	}
	digest := sha256.Sum256(raw)
	return receipt, hex.EncodeToString(digest[:]), nil
}

func validateEvaluation(receipt evalgate.Receipt, runner evalrunner.Receipt, dataset evalgate.Dataset, build buildinfo.ProductBuildBinding) error {
	if receipt.Schema != evalgate.ReceiptSchemaV3 || !receipt.Passed || receipt.RequiredCases != 12 ||
		receipt.RequiredPasses != 12 || receipt.ObservedPasses != 12 || len(receipt.Results) != 12 ||
		receipt.ExecutionSource != evalgate.RunnerExecutionSource || receipt.EvalRunSetID != runner.EvalRunSetID ||
		receipt.RunnerReceiptSHA256 != runner.SHA256 || receipt.DatasetName != dataset.Name ||
		receipt.DatasetSHA256 != dataset.SHA256 || receipt.ProductBuild != build || receipt.VerifiedAt.Before(runner.TerminalAt) {
		return errors.New("evaluation receipt identity or pass count is invalid")
	}
	runs := make(map[string]string, len(runner.Cases))
	for _, item := range runner.Cases {
		runs[item.DatasetCaseID] = item.RunID
	}
	seen := make(map[string]bool, 12)
	for _, result := range receipt.Results {
		if !result.Passed || result.Status != core.RunSucceeded || runs[result.CaseID] != result.RunID || seen[result.CaseID] ||
			result.CitationIntegrityPercent != 100 || result.KnowledgeEvidenceIntegrityPercent != 100 ||
			result.UnsupportedAssertions != 0 || result.CriticalErrorCount != 0 || result.AverageScore < 4 {
			return errors.New("evaluation case result is not a strict pass")
		}
		scoreTotal := 0
		for _, score := range result.Scores.Values() {
			if score < 3 || score > 5 {
				return errors.New("evaluation case result has an out-of-contract review score")
			}
			scoreTotal += score
		}
		if math.Abs(result.AverageScore-float64(scoreTotal)/6) > 0.0001 {
			return errors.New("evaluation case average does not match its review axes")
		}
		seen[result.CaseID] = true
	}
	return nil
}

func hashRegular(path string) (string, error) {
	raw, err := securepath.ReadRegular(strings.TrimSpace(path), 4<<20)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

type liveAPI struct {
	endpoint string
	token    []byte
	client   interface {
		Do(*http.Request) (*http.Response, error)
	}
}

func (api liveAPI) request(ctx context.Context, method, path string, body []byte, expected int) ([]byte, bool, error) {
	request, err := http.NewRequestWithContext(ctx, method, api.endpoint+path, bytes.NewReader(body))
	if err != nil {
		return nil, false, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+string(api.token))
	request.Header.Set("Origin", api.endpoint)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := api.client.Do(request)
	if err != nil {
		return nil, method == http.MethodPost, err
	}
	defer response.Body.Close()
	if response.StatusCode != expected {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return nil, false, fmt.Errorf("product API %s %s returned HTTP %d", method, path, response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
	if err != nil || len(raw) > 4<<20 {
		return nil, method == http.MethodPost, errors.New("product API response was unreadable or oversized")
	}
	if !json.Valid(raw) {
		return nil, method == http.MethodPost, errors.New("product API response is not JSON")
	}
	return raw, false, nil
}

func (api liveAPI) preflight(ctx context.Context, build buildinfo.ProductBuildBinding) error {
	raw, _, err := api.request(ctx, http.MethodGet, "/api/v1/status", nil, http.StatusOK)
	if err != nil {
		return err
	}
	var status struct {
		Ready        bool                          `json:"ready"`
		ProductBuild buildinfo.ProductBuildBinding `json:"product_build"`
	}
	if json.Unmarshal(raw, &status) != nil || !status.Ready || status.ProductBuild != build {
		return errors.New("authenticated API does not belong to the exact ready product build")
	}
	return nil
}

func (api liveAPI) browserObservation(ctx context.Context) (livee2econtract.BrowserObservation, error) {
	raw, _, err := api.request(ctx, http.MethodGet, "/api/v1/release-evidence/browser-observation", nil, http.StatusOK)
	if err != nil {
		return livee2econtract.BrowserObservation{}, err
	}
	var source struct {
		Executed    bool      `json:"executed"`
		Compatible  bool      `json:"compatible"`
		Observation string    `json:"observation"`
		ObservedAt  time.Time `json:"observedAt"`
	}
	if err := json.Unmarshal(raw, &source); err != nil || !source.Executed || !source.Compatible || source.ObservedAt.IsZero() {
		return livee2econtract.BrowserObservation{}, errors.New("browser observation response is invalid")
	}
	return livee2econtract.BrowserObservation(source), nil
}

func (api liveAPI) startRun(ctx context.Context, target evalrunner.Target, prompt string) (core.Run, bool, error) {
	body, _ := json.Marshal(map[string]string{"query": prompt, "model": core.PlannerModel, "reasoning_effort": core.PlannerEffort, "speed": "standard"})
	path := "/api/v1/projects/" + url.PathEscape(target.ProjectID) + "/runs"
	raw, ambiguous, err := api.request(ctx, http.MethodPost, path, body, http.StatusAccepted)
	if err != nil {
		return core.Run{}, ambiguous, err
	}
	var run core.Run
	if err := json.Unmarshal(raw, &run); err != nil || run.ID == "" {
		return core.Run{}, true, errors.New("accepted research response lacks a trustworthy run")
	}
	return run, false, nil
}

func (api liveAPI) run(ctx context.Context, runID string) (core.Run, error) {
	raw, _, err := api.request(ctx, http.MethodGet, "/api/v1/runs/"+url.PathEscape(runID), nil, http.StatusOK)
	if err != nil {
		return core.Run{}, err
	}
	var run core.Run
	err = json.Unmarshal(raw, &run)
	return run, err
}

func (api liveAPI) knowledgeStatus(ctx context.Context, projectID string) (knowledge.Status, error) {
	raw, _, err := api.request(ctx, http.MethodGet, "/api/v1/projects/"+url.PathEscape(projectID)+"/knowledge/status", nil, http.StatusOK)
	if err != nil {
		return knowledge.Status{}, err
	}
	var status knowledge.Status
	err = json.Unmarshal(raw, &status)
	return status, err
}

func (api liveAPI) sparql(ctx context.Context, projectID, generationID string) (livee2econtract.SPARQLObservation, bool, error) {
	body, _ := json.Marshal(map[string]any{"query": SPARQLQuery, "max_rows": 1})
	path := "/api/v1/projects/" + url.PathEscape(projectID) + "/knowledge/sparql"
	raw, ambiguous, err := api.request(ctx, http.MethodPost, path, body, http.StatusOK)
	if err != nil {
		return livee2econtract.SPARQLObservation{}, ambiguous, err
	}
	var result core.SPARQLResult
	if err := json.Unmarshal(raw, &result); err != nil || result.QueryForm != "SELECT" || !result.Complete || len(result.Result) == 0 {
		return livee2econtract.SPARQLObservation{}, true, errors.New("SPARQL response is incomplete")
	}
	queryDigest := sha256.Sum256([]byte(SPARQLQuery))
	resultDigest := sha256.Sum256(raw)
	return livee2econtract.SPARQLObservation{GenerationID: generationID,
		QuerySHA256: hex.EncodeToString(queryDigest[:]), ResultSHA256: hex.EncodeToString(resultDigest[:]),
		QueryForm: result.QueryForm, Complete: result.Complete, ResponseBytes: len(raw)}, false, nil
}

func (api liveAPI) firstEntity(ctx context.Context, projectID string) (string, error) {
	path := "/api/v1/projects/" + url.PathEscape(projectID) + "/knowledge/subgraph?mode=instance&max_nodes=1&max_edges=1"
	raw, _, err := api.request(ctx, http.MethodGet, path, nil, http.StatusOK)
	if err != nil {
		return "", err
	}
	var graph knowledge.Subgraph
	if err := json.Unmarshal(raw, &graph); err != nil || len(graph.Nodes) != 1 {
		return "", errors.New("ready project graph has no entity for safe pin mutation")
	}
	id, _ := graph.Nodes[0]["id"].(string)
	if strings.TrimSpace(id) == "" {
		return "", errors.New("project graph entity id is invalid")
	}
	return id, nil
}

func (api liveAPI) pinEntity(ctx context.Context, projectID, entityID, runID string) (livee2econtract.CurationObservation, bool, error) {
	memo := "AetherOps live_end_to_end verification pin for run " + runID + ". This memo records only the safe editor round-trip and makes no new factual claim."
	body, _ := json.Marshal(map[string]any{"kind": "pin_entity", "entity_id": entityID, "memo": memo})
	path := "/api/v1/projects/" + url.PathEscape(projectID) + "/knowledge/edits"
	raw, ambiguous, err := api.request(ctx, http.MethodPost, path, body, http.StatusCreated)
	if err != nil {
		return livee2econtract.CurationObservation{}, ambiguous, err
	}
	var response struct {
		Event store.KnowledgeCurationEvent `json:"event"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return livee2econtract.CurationObservation{}, true, err
	}
	var payload struct {
		EntityID     string `json:"entity_id"`
		MemoBlobHash string `json:"memo_blob_hash"`
	}
	if err := json.Unmarshal(response.Event.Payload, &payload); err != nil || payload.EntityID != entityID || !validDigest(payload.MemoBlobHash) {
		return livee2econtract.CurationObservation{}, true, errors.New("Knowledge editor did not return the persisted safe pin event")
	}
	return livee2econtract.CurationObservation{
		EventID: response.Event.ID, Sequence: response.Event.Sequence, GenerationID: response.Event.GenerationID,
		Kind: response.Event.Kind, PayloadSHA256: response.Event.PayloadSHA256, EventSHA256: response.Event.EventSHA256,
		MemoBlobSHA256: payload.MemoBlobHash, EntityID: payload.EntityID,
	}, false, nil
}

func init() {
	// Compile-time guard against accidentally accepting a non-SELECT query in
	// the fixed live evidence path.
	if !strings.HasPrefix(SPARQLQuery, "SELECT ") {
		panic("live end-to-end SPARQL query must remain SELECT-only")
	}
}
