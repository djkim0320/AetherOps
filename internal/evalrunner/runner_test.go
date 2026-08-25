package evalrunner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/evalgate"
)

const fixtureToken = "fixture_token_abcdefghijklmnopqrstuvwxyz0123456789"

type apiFixture struct {
	testing      *testing.T
	dataset      evalgate.Dataset
	build        evalgate.ProductBuildBinding
	target       Target
	token        string
	status       core.RunStatus
	ambiguous    bool
	emptyRunID   bool
	duplicateRun bool

	mu            sync.Mutex
	runs          map[string]core.Run
	postByCase    map[string]int
	decisionPosts atomic.Int64
	server        *httptest.Server
	afterRunRead  func()
	runReadOnce   sync.Once
	afterApproval func()
	approvalOnce  sync.Once
}

func newAPIFixture(t *testing.T, status core.RunStatus) *apiFixture {
	t.Helper()
	fixture := &apiFixture{
		testing: t, dataset: testDataset(), build: testBuild(), target: Target{ProjectID: "project_eval"},
		token: fixtureToken, status: status, runs: make(map[string]core.Run), postByCase: make(map[string]int),
	}
	fixture.server = httptest.NewServer(http.HandlerFunc(fixture.handle))
	t.Cleanup(fixture.server.Close)
	return fixture
}

func (fixture *apiFixture) handle(writer http.ResponseWriter, request *http.Request) {
	if request.Header.Get("Authorization") != "Bearer "+fixture.token || request.Header.Get("Origin") != fixture.server.URL {
		http.Error(writer, "unauthorized", http.StatusUnauthorized)
		return
	}
	switch {
	case request.Method == http.MethodGet && request.URL.Path == "/api/v1/status":
		writeFixtureJSON(writer, http.StatusOK, map[string]any{
			"ready": true, "version": "0.1.0-alpha.1", "platform": "windows/amd64",
			"product_build": fixture.build, "model_options": []any{}, "default_run_configuration": map[string]any{},
		})
	case request.Method == http.MethodPost && request.URL.Path == "/api/v1/projects/project_eval/runs":
		fixture.handleStart(writer, request)
	case request.Method == http.MethodGet && strings.HasPrefix(request.URL.Path, "/api/v1/runs/"):
		fixture.handleRun(writer, strings.TrimPrefix(request.URL.Path, "/api/v1/runs/"))
	case request.Method == http.MethodGet && request.URL.Path == "/api/v1/approvals":
		fixture.handleApprovals(writer)
	case request.Method == http.MethodPost && strings.Contains(request.URL.Path, "/api/v1/approvals/"):
		fixture.decisionPosts.Add(1)
		http.Error(writer, "runner must not decide approvals", http.StatusForbidden)
	default:
		http.NotFound(writer, request)
	}
}

func (fixture *apiFixture) handleStart(writer http.ResponseWriter, request *http.Request) {
	var body startRequest
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		fixture.testing.Errorf("decode start request: %v", err)
		http.Error(writer, "bad request", http.StatusBadRequest)
		return
	}
	caseID := ""
	for _, item := range fixture.dataset.Cases {
		if item.Prompt() == body.Query {
			caseID = item.ID
			break
		}
	}
	if caseID == "" {
		fixture.testing.Errorf("received non-dataset prompt")
		http.Error(writer, "unknown prompt", http.StatusBadRequest)
		return
	}
	fixture.mu.Lock()
	fixture.postByCase[caseID]++
	fixture.mu.Unlock()
	if body.Model != core.PlannerModel || body.ReasoningEffort != core.PlannerEffort || body.Speed != "standard" {
		fixture.testing.Errorf("unexpected run configuration: %+v", body)
	}
	if fixture.ambiguous {
		hijacker, ok := writer.(http.Hijacker)
		if !ok {
			fixture.testing.Error("httptest writer cannot hijack")
			return
		}
		connection, _, err := hijacker.Hijack()
		if err != nil {
			fixture.testing.Errorf("hijack: %v", err)
			return
		}
		_ = connection.Close()
		return
	}
	runID := "run_" + strings.ReplaceAll(caseID, "-", "_")
	if fixture.duplicateRun {
		runID = "run_duplicate"
	}
	if fixture.emptyRunID {
		runID = ""
	}
	now := time.Date(2026, 8, 9, 1, 2, 3, 0, time.UTC)
	run := core.Run{
		ID: runID, ProjectID: fixture.target.ProjectID, Question: body.Query,
		Status: fixture.currentStatus(), Revision: 1, ProductBuild: fixture.build,
		CreatedAt: now, UpdatedAt: now,
	}
	if runID != "" {
		fixture.mu.Lock()
		if _, exists := fixture.runs[runID]; !exists {
			fixture.runs[runID] = run
		}
		fixture.mu.Unlock()
	}
	writeFixtureJSON(writer, http.StatusAccepted, run)
}

func (fixture *apiFixture) handleRun(writer http.ResponseWriter, runID string) {
	fixture.mu.Lock()
	run, ok := fixture.runs[runID]
	if ok {
		run.Status = fixture.status
		run.Revision++
		run.UpdatedAt = run.UpdatedAt.Add(time.Minute)
		fixture.runs[runID] = run
	}
	fixture.mu.Unlock()
	if !ok {
		http.NotFound(writer, nil)
		return
	}
	writeFixtureJSON(writer, http.StatusOK, run)
	if fixture.afterRunRead != nil {
		fixture.runReadOnce.Do(fixture.afterRunRead)
	}
}

func (fixture *apiFixture) handleApprovals(writer http.ResponseWriter) {
	fixture.mu.Lock()
	approvals := make([]core.Approval, 0, len(fixture.runs))
	for runID := range fixture.runs {
		approvals = append(approvals, core.Approval{
			ID: "approval_" + runID, RunID: runID, Kind: "item/mcpToolCall/requestApproval",
			Summary: "operator decision required", Risk: "write", Status: "pending",
		})
	}
	fixture.mu.Unlock()
	writeFixtureJSON(writer, http.StatusOK, approvals)
	if fixture.afterApproval != nil {
		fixture.approvalOnce.Do(fixture.afterApproval)
	}
}

func (fixture *apiFixture) currentStatus() core.RunStatus {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	return fixture.status
}

func (fixture *apiFixture) setStatus(status core.RunStatus) {
	fixture.mu.Lock()
	fixture.status = status
	fixture.mu.Unlock()
}

func (fixture *apiFixture) posts() int {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	total := 0
	for _, count := range fixture.postByCase {
		total += count
	}
	return total
}

func (fixture *apiFixture) assertExactlyOnePostPerCase(t *testing.T) {
	t.Helper()
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if len(fixture.postByCase) != 12 {
		t.Fatalf("posted cases = %d, want 12", len(fixture.postByCase))
	}
	for caseID, count := range fixture.postByCase {
		if count != 1 {
			t.Fatalf("POST count for %s = %d, want 1", caseID, count)
		}
	}
}

func TestRunnerSubmitsEveryNotStartedCaseExactlyOnceAndFixtureCannotPassRelease(t *testing.T) {
	fixture := newAPIFixture(t, core.RunSucceeded)
	config := testConfig(t, fixture)
	receipt, err := Start(context.Background(), config)
	if !errors.Is(err, ErrRunSetIncomplete) {
		t.Fatalf("Start error = %v, want non-release fixture result", err)
	}
	fixture.assertExactlyOnePostPerCase(t)
	if receipt.ReleaseGatePassed || receipt.EligibleForOfflineVerification || !receipt.RequiresOfflineVerification {
		t.Fatalf("fixture receipt was represented as release evidence: %+v", receipt)
	}
	if receipt.Completeness.ProductTerminalCases != 12 || len(receipt.Cases) != 12 {
		t.Fatalf("receipt completeness = %+v cases=%d", receipt.Completeness, len(receipt.Cases))
	}
	journalRaw, err := os.ReadFile(config.JournalPath)
	if err != nil {
		t.Fatal(err)
	}
	outputRaw, err := os.ReadFile(config.OutputPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(journalRaw), fixture.token) || strings.Contains(string(outputRaw), fixture.token) {
		t.Fatal("token leaked into runner evidence")
	}
}

func TestRunnerResumeReconnectsStartedRunsWithoutPostingAgain(t *testing.T) {
	fixture := newAPIFixture(t, core.RunQueued)
	config := testConfig(t, fixture)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fixture.afterRunRead = cancel
	if _, err := Start(ctx, config); !errors.Is(err, context.Canceled) {
		t.Fatalf("Start error = %v, want cancellation after all STARTED events", err)
	}
	fixture.assertExactlyOnePostPerCase(t)
	fixture.setStatus(core.RunSucceeded)
	receipt, err := Resume(context.Background(), config)
	if !errors.Is(err, ErrRunSetIncomplete) {
		t.Fatalf("Resume error = %v", err)
	}
	fixture.assertExactlyOnePostPerCase(t)
	if receipt.Completeness.ProductTerminalCases != 12 {
		t.Fatalf("terminal cases = %d", receipt.Completeness.ProductTerminalCases)
	}
}

func TestRunnerRecordsAmbiguousSubmissionAndNeverRestartsIt(t *testing.T) {
	fixture := newAPIFixture(t, core.RunQueued)
	fixture.ambiguous = true
	config := testConfig(t, fixture)
	receipt, err := Start(context.Background(), config)
	if !errors.Is(err, ErrRunSetIncomplete) {
		t.Fatalf("Start error = %v", err)
	}
	fixture.assertExactlyOnePostPerCase(t)
	if receipt.Completeness.AmbiguousCases != 12 || receipt.Completeness.ProductTerminalCases != 0 {
		t.Fatalf("ambiguous completeness = %+v", receipt.Completeness)
	}
	config.OutputPath = filepath.Join(t.TempDir(), "resume-receipt.json")
	if _, err := Resume(context.Background(), config); !errors.Is(err, ErrRunSetIncomplete) {
		t.Fatalf("Resume error = %v", err)
	}
	fixture.assertExactlyOnePostPerCase(t)
}

func TestRunnerRecordsApprovalsWithoutPostingDecisions(t *testing.T) {
	fixture := newAPIFixture(t, core.RunWaitingApproval)
	config := testConfig(t, fixture)
	fixture.afterApproval = func() { fixture.setStatus(core.RunFailed) }
	if _, err := Start(context.Background(), config); !errors.Is(err, ErrRunSetIncomplete) {
		t.Fatalf("Start error = %v, want completed non-passing run set", err)
	}
	journalRaw, err := os.ReadFile(config.JournalPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(journalRaw), "operator decision required") {
		t.Fatal("pending approval was not persisted to the journal")
	}
	if fixture.decisionPosts.Load() != 0 {
		t.Fatalf("runner posted %d approval decisions", fixture.decisionPosts.Load())
	}
	config.OutputPath = filepath.Join(t.TempDir(), "approval-resume-receipt.json")
	if _, err := Resume(context.Background(), config); !errors.Is(err, ErrRunSetIncomplete) {
		t.Fatalf("Resume error = %v", err)
	}
	if fixture.decisionPosts.Load() != 0 {
		t.Fatalf("runner posted %d approval decisions after resume", fixture.decisionPosts.Load())
	}
}

func TestRunnerRejectsMissingDuplicateDatasetAndNonOverwritePaths(t *testing.T) {
	fixture := newAPIFixture(t, core.RunSucceeded)
	missing := testConfig(t, fixture)
	missing.Dataset.Cases = missing.Dataset.Cases[:11]
	if _, err := Start(context.Background(), missing); err == nil || !strings.Contains(err.Error(), "exactly 12") {
		t.Fatalf("missing dataset error = %v", err)
	}
	duplicate := testConfig(t, fixture)
	duplicate.Dataset.Cases[11].ID = duplicate.Dataset.Cases[0].ID
	duplicate.Dataset.Cases[11].Mode = duplicate.Dataset.Cases[0].Mode
	if _, err := Start(context.Background(), duplicate); err == nil || !strings.Contains(err.Error(), "duplicated") {
		t.Fatalf("duplicate dataset error = %v", err)
	}
	config := testConfig(t, fixture)
	if _, err := Start(context.Background(), config); !errors.Is(err, ErrRunSetIncomplete) {
		t.Fatalf("first Start error = %v", err)
	}
	if _, err := Start(context.Background(), config); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("journal overwrite error = %v", err)
	}
	if _, err := Resume(context.Background(), config); err == nil || !strings.Contains(err.Error(), "output already exists") {
		t.Fatalf("output overwrite error = %v", err)
	}
}

func TestRunnerRejectsDuplicateAndMissingRunIDsWithoutResubmission(t *testing.T) {
	for _, test := range []struct {
		name      string
		configure func(*apiFixture)
	}{
		{name: "duplicate", configure: func(fixture *apiFixture) { fixture.duplicateRun = true }},
		{name: "missing", configure: func(fixture *apiFixture) { fixture.emptyRunID = true }},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newAPIFixture(t, core.RunSucceeded)
			test.configure(fixture)
			config := testConfig(t, fixture)
			receipt, err := Start(context.Background(), config)
			if !errors.Is(err, ErrRunSetIncomplete) {
				t.Fatalf("Start error = %v", err)
			}
			fixture.assertExactlyOnePostPerCase(t)
			if receipt.Completeness.AmbiguousCases == 0 {
				t.Fatalf("invalid run ids were not marked ambiguous: %+v", receipt.Completeness)
			}
		})
	}
}

func TestTokenAndServerBodyAreRedacted(t *testing.T) {
	secret := "secret_token_abcdefghijklmnopqrstuvwxyz0123456789"
	var endpoint string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Origin") != endpoint {
			t.Errorf("origin = %q", request.Header.Get("Origin"))
		}
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte("reflected " + secret))
	}))
	defer server.Close()
	endpoint = server.URL
	directory := t.TempDir()
	tokenPath := filepath.Join(directory, "api.token")
	if err := os.WriteFile(tokenPath, []byte(secret+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	token, err := ReadTokenFile(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	defer ZeroToken(token)
	config := Config{
		Dataset: testDataset(), ProductBuild: testBuild(), Endpoint: endpoint, Token: token,
		Target: Target{ProjectID: "project_eval"}, JournalPath: filepath.Join(directory, "journal.jsonl"),
		OutputPath: filepath.Join(directory, "receipt.json"), PollInterval: time.Millisecond,
		EvidenceClass: EvidenceProtocolFixture,
	}
	_, err = Start(context.Background(), config)
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("redaction error = %v", err)
	}
	journalRaw, readErr := os.ReadFile(config.JournalPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if strings.Contains(string(journalRaw), secret) || strings.Contains(string(journalRaw), tokenPath) {
		t.Fatal("token value or token path leaked into journal")
	}
}

func TestPreflightRejectsDifferentProductBuildBeforeAnySubmission(t *testing.T) {
	fixture := newAPIFixture(t, core.RunSucceeded)
	config := testConfig(t, fixture)
	config.ProductBuild.ExecutableSHA256 = strings.Repeat("9", 64)
	_, err := Start(context.Background(), config)
	if err == nil || !strings.Contains(err.Error(), "different or unready product build") {
		t.Fatalf("preflight error = %v", err)
	}
	if fixture.posts() != 0 {
		t.Fatalf("preflight mismatch submitted %d runs", fixture.posts())
	}
}

func testConfig(t *testing.T, fixture *apiFixture) Config {
	t.Helper()
	directory := t.TempDir()
	dataset := fixture.dataset
	dataset.Cases = append([]evalgate.Case(nil), fixture.dataset.Cases...)
	return Config{
		Dataset: dataset, ProductBuild: fixture.build, Endpoint: fixture.server.URL,
		Token: []byte(fixture.token), Target: fixture.target,
		JournalPath: filepath.Join(directory, "journal.jsonl"), OutputPath: filepath.Join(directory, "receipt.json"),
		PollInterval: time.Millisecond, EvidenceClass: EvidenceProtocolFixture,
		NewRunSetID: func() (string, error) { return "evalrs_fixture", nil },
	}
}

func testDataset() evalgate.Dataset {
	cases := make([]evalgate.Case, 0, 12)
	for index := 1; index <= 6; index++ {
		cases = append(cases, evalgate.Case{
			ID: fmt.Sprintf("general-%02d", index), Mode: "general",
			Question: fmt.Sprintf("general question %d", index), Requirements: []string{"source-backed answer"},
		})
	}
	for index := 1; index <= 6; index++ {
		cases = append(cases, evalgate.Case{
			ID: fmt.Sprintf("engineering-%02d", index), Mode: "engineering",
			Question: fmt.Sprintf("engineering question %d", index), Requirements: []string{"reproducible evidence"},
		})
	}
	return evalgate.Dataset{
		Schema: evalgate.DatasetSchemaV1, Name: "runner-fixture", SHA256: strings.Repeat("a", 64),
		ReleaseGate: evalgate.ReleaseGate{
			RequiredCases: 12, RequiredPasses: 12,
			QualityPolicy: evalgate.QualityPolicy{
				CitationIntegrityPercent: 100, MaxCriticalErrors: 0,
				MinimumAverageScore: 4, MinimumAxisScore: 3,
			},
		},
		Cases: cases,
	}
}

func testBuild() evalgate.ProductBuildBinding {
	return evalgate.ProductBuildBinding{
		Version: evalgate.ReleaseProductVersion, ExecutableSHA256: strings.Repeat("1", 64),
		RuntimeManifestSHA256: strings.Repeat("2", 64), KnowledgeSidecarTreeSHA256: strings.Repeat("3", 64),
	}
}

func writeFixtureJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
