package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	memoryindex "github.com/djkim0320/AetherOps/internal/memory"
	"github.com/djkim0320/AetherOps/internal/rag"
	schedulepkg "github.com/djkim0320/AetherOps/internal/schedule"
	"github.com/djkim0320/AetherOps/internal/store"
)

type modelCatalogFixture struct{}

type contextUsageFixture struct{}

type browserLifecycleFixture struct {
	resetCalls int
}

type memoryControllerFixture struct {
	status       store.ProjectMemoryHead
	reindex      store.EmbeddingIndex
	statusErr    error
	reindexErr   error
	reindexCalls int
	search       []store.GraphMemoryResult
	searchErr    error
	searchCalls  int
}

func (fixture *memoryControllerFixture) MemoryStatus(context.Context, string) (store.ProjectMemoryHead, error) {
	return fixture.status, fixture.statusErr
}

func (fixture *memoryControllerFixture) ReindexProject(context.Context, string) (store.EmbeddingIndex, error) {
	fixture.reindexCalls++
	return fixture.reindex, fixture.reindexErr
}

func (fixture *memoryControllerFixture) SearchProject(_ context.Context, _ string, _ string, _ int) ([]store.GraphMemoryResult, error) {
	fixture.searchCalls++
	return fixture.search, fixture.searchErr
}

func (*browserLifecycleFixture) Status(context.Context) (any, error) {
	return map[string]any{"status": "ready"}, nil
}
func (*browserLifecycleFixture) EmergencyStop(context.Context) error   { return nil }
func (*browserLifecycleFixture) SetMode(context.Context, string) error { return nil }
func (fixture *browserLifecycleFixture) ResetProfile(context.Context) (any, error) {
	fixture.resetCalls++
	return map[string]any{"scheduled": true, "restart_required": true}, nil
}

func (contextUsageFixture) ContextWindowUsage(_ context.Context, threadID string) (core.ContextWindowUsage, bool) {
	if threadID != "thread-context" {
		return core.ContextWindowUsage{}, false
	}
	return core.ContextWindowUsage{Available: true, ThreadID: threadID, TurnID: "turn-context", CurrentTokens: 25000, ContextWindow: 200000, UsedPercent: 12.5}, true
}

func (modelCatalogFixture) ModelOptions() []core.ModelOption {
	return []core.ModelOption{{
		ID: core.PlannerModel, DisplayName: "GPT-5.6 Sol", DefaultReasoningEffort: core.PlannerEffort,
		SupportedReasoningEfforts: []string{core.PlannerEffort}, SupportedSpeeds: []string{"standard", "fast"},
	}}
}

func (modelCatalogFixture) ValidateRunConfiguration(_ context.Context, configuration core.RunConfiguration) error {
	if err := configuration.Validate(); err != nil {
		return err
	}
	if configuration.Model != core.PlannerModel || configuration.ReasoningEffort != core.PlannerEffort {
		return errors.New("unsupported test model configuration")
	}
	return nil
}

type runControllerFixture struct {
	configuration  core.RunConfiguration
	steeredRunID   string
	steeredMessage string
	plannedSession string
	plannedCycle   string
}

type directTestProjectCreator struct {
	db *store.DB
}

func (creator directTestProjectCreator) CreateProject(ctx context.Context, name string) (core.Project, error) {
	return creator.db.CreateProject(ctx, name)
}

type chatControllerFixture struct {
	projectID     string
	message       string
	mode          core.ChatMode
	configuration core.RunConfiguration
	reply         core.ChatReply
}

type chatHistoryFixture struct {
	sessionID string
}

func (fixture *chatHistoryFixture) ChatHistorySession(_ context.Context, sessionID string) (core.ChatHistory, error) {
	fixture.sessionID = sessionID
	return core.ChatHistory{
		ConversationSessionID: sessionID, ThreadID: "thread-history",
		Messages: []core.ChatHistoryMessage{{
			ID: "message-history", TurnID: "turn-history", Role: "assistant",
			Text: "복구된 답변", Mode: core.ChatModeConversation,
		}},
	}, nil
}

func (fixture *chatControllerFixture) ChatProject(
	_ context.Context,
	projectID, message string,
	mode core.ChatMode,
	_ string,
	configuration core.RunConfiguration,
) (core.ChatReply, error) {
	fixture.projectID = projectID
	fixture.message = message
	fixture.mode = mode
	fixture.configuration = configuration
	reply := fixture.reply
	if reply.Text == "" {
		reply.Text = "계획 답변"
	}
	reply.ProjectID, reply.ThreadID, reply.TurnID, reply.Mode = projectID, "thread-chat", "turn-chat", mode
	return reply, nil
}

func (fixture *chatControllerFixture) ChatSession(
	ctx context.Context,
	sessionID, message string,
	mode core.ChatMode,
	planCycleID string,
	configuration core.RunConfiguration,
) (core.ChatReply, error) {
	return fixture.ChatProject(ctx, sessionID, message, mode, planCycleID, configuration)
}

func (fixture *runControllerFixture) SteerRun(_ context.Context, runID, message string) (core.Run, error) {
	fixture.steeredRunID = runID
	fixture.steeredMessage = message
	return core.Run{ID: runID, Status: core.RunCollecting}, nil
}

func (fixture *runControllerFixture) StartRun(_ context.Context, projectID, question string, configuration core.RunConfiguration) (core.Run, error) {
	fixture.configuration = configuration
	return core.Run{ID: "run-picker", ProjectID: projectID, Question: question, Status: core.RunQueued,
		Model: configuration.Model, ReasoningEffort: configuration.ReasoningEffort, ServiceTier: configuration.ServiceTier}, nil
}
func (fixture *runControllerFixture) StartSessionRun(_ context.Context, sessionID, question string, configuration core.RunConfiguration) (core.Run, error) {
	fixture.configuration = configuration
	return core.Run{ID: "run-picker", ConversationSessionID: sessionID, Question: question, Status: core.RunQueued,
		Model: configuration.Model, ReasoningEffort: configuration.ReasoningEffort, ServiceTier: configuration.ServiceTier}, nil
}
func (fixture *runControllerFixture) StartPlannedSessionRun(_ context.Context, sessionID, planCycleID string, configuration core.RunConfiguration) (core.Run, error) {
	fixture.configuration = configuration
	fixture.plannedSession = sessionID
	fixture.plannedCycle = planCycleID
	return core.Run{ID: "run-planned", ConversationSessionID: sessionID, Question: planCycleID, Status: core.RunQueued,
		Model: configuration.Model, ReasoningEffort: configuration.ReasoningEffort, ServiceTier: configuration.ServiceTier}, nil
}
func (*runControllerFixture) CancelRun(context.Context, string) (core.Run, error) {
	return core.Run{}, nil
}
func (*runControllerFixture) ResumeRun(context.Context, string) (core.Run, error) {
	return core.Run{}, nil
}
func (*runControllerFixture) DiscardRun(context.Context, string) (core.Run, error) {
	return core.Run{}, nil
}

func startTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	root := t.TempDir()
	database, err := store.Open(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{DB: database, CAS: objects, ProjectCreator: directTestProjectCreator{db: database}}
	endpoint, err := server.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer shutdownCancel()
		_ = server.Shutdown(shutdownCtx)
	})
	return server, endpoint
}

func TestReleaseBrowserObservationIsAuthenticatedAndDisabledByDefault(t *testing.T) {
	server, endpoint := startTestServer(t)
	client := &http.Client{Timeout: 3 * time.Second}
	request := func(token string) *http.Request {
		req, err := http.NewRequest(http.MethodGet, endpoint+"/api/v1/release-evidence/browser-observation", nil)
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Origin", endpoint)
		}
		return req
	}
	response, err := client.Do(request(""))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated release observation status = %d", response.StatusCode)
	}
	response, err = client.Do(request(server.Token()))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("ordinary product session exposed release observation: %d", response.StatusCode)
	}
	server.ReleaseBrowserObservation = func(context.Context) (any, error) {
		return map[string]any{"executed": true, "observation": "Chrome DevTools MCP list_pages take_snapshot"}, nil
	}
	response, err = client.Do(request(server.Token()))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("protected release observation status = %d", response.StatusCode)
	}
	var body map[string]any
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["executed"] != true {
		t.Fatalf("unexpected release observation: %+v", body)
	}
}

func TestMutationsRequireTokenAndShellOrigin(t *testing.T) {
	server, endpoint := startTestServer(t)
	client := &http.Client{Timeout: 3 * time.Second}
	makeRequest := func(token, origin string) *http.Request {
		request, err := http.NewRequest(http.MethodPost, endpoint+"/api/v1/projects",
			bytes.NewBufferString(`{"name":"새 프로젝트"}`))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		if origin != "" {
			request.Header.Set("Origin", origin)
		}
		return request
	}
	response, err := client.Do(makeRequest("", ""))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("without token status = %d", response.StatusCode)
	}
	response, err = client.Do(makeRequest(server.Token(), "https://attacker.invalid"))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign origin status = %d", response.StatusCode)
	}
	response, err = client.Do(makeRequest(server.Token(), endpoint))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("valid shell mutation status = %d", response.StatusCode)
	}
	var project map[string]any
	if err := json.NewDecoder(response.Body).Decode(&project); err != nil {
		t.Fatal(err)
	}
	if project["name"] != "새 프로젝트" {
		t.Fatalf("unexpected project: %+v", project)
	}
}

func TestProjectCreationRequiresVerifiedKnowledgeInitializer(t *testing.T) {
	ctx := context.Background()
	database, err := store.Open(ctx, filepath.Join(t.TempDir(), "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	server := &Server{DB: database}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/projects", strings.NewReader(`{"name":"blocked setup project"}`))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.handleProjects(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), "project_creation_unavailable") {
		t.Fatalf("setup-mode project creation was not blocked: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var projects int
	if err := database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM projects").Scan(&projects); err != nil {
		t.Fatal(err)
	}
	if projects != 0 {
		t.Fatalf("blocked project creation mutated storage: %d projects", projects)
	}
}

func TestProjectRenamePreservesKoreanNameAndRejectsInvalidNames(t *testing.T) {
	server, _ := startTestServer(t)
	ctx := context.Background()
	project, err := server.DB.CreateProject(ctx, "Pro 초기 연구 - NACA 익형")
	if err != nil {
		t.Fatal(err)
	}
	request := func(name string) *httptest.ResponseRecorder {
		t.Helper()
		payload, err := json.Marshal(map[string]string{"name": name})
		if err != nil {
			t.Fatal(err)
		}
		recorder := httptest.NewRecorder()
		server.handleProjectPath(recorder, httptest.NewRequest(http.MethodPatch,
			"/api/v1/projects/"+project.ID, bytes.NewReader(payload)))
		return recorder
	}
	const want = "Pro 검증 – NACA 최적화 복구"
	response := request("  " + want + "  ")
	if response.Code != http.StatusOK {
		t.Fatalf("rename status=%d body=%s", response.Code, response.Body.String())
	}
	var renamed core.Project
	if err := json.Unmarshal(response.Body.Bytes(), &renamed); err != nil {
		t.Fatal(err)
	}
	if renamed.Name != want {
		t.Fatalf("renamed project = %q, want %q", renamed.Name, want)
	}
	if response := request("   "); response.Code != http.StatusBadRequest {
		t.Fatalf("empty rename status=%d body=%s", response.Code, response.Body.String())
	}
	if response := request(strings.Repeat("가", 121)); response.Code != http.StatusBadRequest {
		t.Fatalf("overlong rename status=%d body=%s", response.Code, response.Body.String())
	}
	if response := request("손상된 이름 \uFFFD"); response.Code != http.StatusBadRequest {
		t.Fatalf("replacement-character rename status=%d body=%s", response.Code, response.Body.String())
	}
	stored, err := server.DB.Project(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Name != want {
		t.Fatalf("rejected rename mutated project: %q", stored.Name)
	}
}

func TestDecodeJSONPreservesUnicodeAndRejectsInvalidUTF8(t *testing.T) {
	type payload struct {
		Message string `json:"message"`
	}
	const want = "한글 메시지 😀 – 왕복"
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"message":"`+want+`"}`))
	var decoded payload
	if err := decodeJSON(request, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Message != want {
		t.Fatalf("decoded message = %q, want %q", decoded.Message, want)
	}

	damaged := append([]byte(`{"message":"손상 `), byte(0xff))
	damaged = append(damaged, []byte(`"}`)...)
	request = httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(damaged))
	if err := decodeJSON(request, &decoded); err == nil || !strings.Contains(err.Error(), "valid UTF-8") {
		t.Fatalf("invalid UTF-8 decode error = %v", err)
	}
}

func TestSessionAndPlanAPIsPreserveUnicodeAndRejectReplacementCharacters(t *testing.T) {
	server, _ := startTestServer(t)
	ctx := context.Background()
	project, err := server.DB.CreateProject(ctx, "unicode API")
	if err != nil {
		t.Fatal(err)
	}
	defaultSession, err := server.DB.DefaultConversationSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}

	create := httptest.NewRecorder()
	server.handleProjectPath(create, httptest.NewRequest(http.MethodPost,
		"/api/v1/projects/"+project.ID+"/sessions", strings.NewReader(`{"title":"대화 😀 – 생성"}`)))
	if create.Code != http.StatusCreated {
		t.Fatalf("unicode session create status=%d body=%s", create.Code, create.Body.String())
	}
	var created core.ConversationSession
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Title != "대화 😀 – 생성" {
		t.Fatalf("created title = %q", created.Title)
	}

	rename := httptest.NewRecorder()
	server.handleSessionPath(rename, httptest.NewRequest(http.MethodPatch,
		"/api/v1/sessions/"+created.ID, strings.NewReader(`{"title":"이름 🛩️"}`)))
	if rename.Code != http.StatusOK {
		t.Fatalf("unicode session rename status=%d body=%s", rename.Code, rename.Body.String())
	}
	damagedCreate := httptest.NewRecorder()
	server.handleProjectPath(damagedCreate, httptest.NewRequest(http.MethodPost,
		"/api/v1/projects/"+project.ID+"/sessions", strings.NewReader(`{"title":"손상 \ufffd"}`)))
	if damagedCreate.Code != http.StatusBadRequest {
		t.Fatalf("damaged session create status=%d body=%s", damagedCreate.Code, damagedCreate.Body.String())
	}
	damagedRename := httptest.NewRecorder()
	server.handleSessionPath(damagedRename, httptest.NewRequest(http.MethodPatch,
		"/api/v1/sessions/"+created.ID, strings.NewReader(`{"title":"손상 \ufffd"}`)))
	if damagedRename.Code != http.StatusBadRequest {
		t.Fatalf("damaged session rename status=%d body=%s", damagedRename.Code, damagedRename.Body.String())
	}
	stored, err := server.DB.ConversationSession(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Title != "이름 🛩️" {
		t.Fatalf("damaged rename mutated title to %q", stored.Title)
	}

	plan := httptest.NewRecorder()
	server.handleSessionPath(plan, httptest.NewRequest(http.MethodPost,
		"/api/v1/sessions/"+defaultSession.ID+"/plan-cycle", strings.NewReader(`{"objective":"목표 😀 – 보존"}`)))
	if plan.Code != http.StatusCreated {
		t.Fatalf("unicode plan objective status=%d body=%s", plan.Code, plan.Body.String())
	}
	damagedPlan := httptest.NewRecorder()
	server.handleSessionPath(damagedPlan, httptest.NewRequest(http.MethodPost,
		"/api/v1/sessions/"+defaultSession.ID+"/plan-cycle", strings.NewReader(`{"objective":"손상 \ufffd"}`)))
	if damagedPlan.Code != http.StatusBadRequest {
		t.Fatalf("damaged plan objective status=%d body=%s", damagedPlan.Code, damagedPlan.Body.String())
	}
}

func TestProjectDeletionRequiresExactIdentityConfirmation(t *testing.T) {
	server, _ := startTestServer(t)
	ctx := context.Background()
	project, err := server.DB.CreateProject(ctx, "Delete exactly this project")
	if err != nil {
		t.Fatal(err)
	}
	request := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		server.handleProjectPath(recorder,
			httptest.NewRequest(http.MethodDelete, "/api/v1/projects/"+project.ID, strings.NewReader(body)))
		return recorder
	}
	if response := request(`{"project_id":"` + project.ID + `","confirm_name":"wrong"}`); response.Code != http.StatusConflict {
		t.Fatalf("wrong confirmation status=%d body=%s", response.Code, response.Body.String())
	}
	if _, err := server.DB.Project(ctx, project.ID); err != nil {
		t.Fatalf("rejected confirmation deleted project: %v", err)
	}
	if response := request(`{"project_id":"different","confirm_name":"Delete exactly this project"}`); response.Code != http.StatusBadRequest {
		t.Fatalf("mismatched path id status=%d body=%s", response.Code, response.Body.String())
	}
	if response := request(`{"project_id":"` + project.ID + `","confirm_name":"Delete exactly this project"}`); response.Code != http.StatusOK {
		t.Fatalf("confirmed deletion status=%d body=%s", response.Code, response.Body.String())
	}
	if _, err := server.DB.Project(ctx, project.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("confirmed project still exists: %v", err)
	}
}

func TestProjectDeletionRejectsQueuedRun(t *testing.T) {
	server, _ := startTestServer(t)
	ctx := context.Background()
	project, err := server.DB.CreateProject(ctx, "Busy project")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.DB.CreateRun(ctx, project.ID, "", "queued", ""); err != nil {
		t.Fatal(err)
	}
	body := `{"project_id":"` + project.ID + `","confirm_name":"Busy project"}`
	recorder := httptest.NewRecorder()
	server.handleProjectPath(recorder,
		httptest.NewRequest(http.MethodDelete, "/api/v1/projects/"+project.ID, strings.NewReader(body)))
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), "project_busy") {
		t.Fatalf("busy deletion status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := server.DB.Project(ctx, project.ID); err != nil {
		t.Fatalf("busy project was deleted: %v", err)
	}
}

func TestProjectDeletionReportsDeferredCASCleanupAfterRelationalCommit(t *testing.T) {
	server, _ := startTestServer(t)
	ctx := context.Background()
	project, err := server.DB.CreateProject(ctx, "deferred CAS cleanup")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := server.CAS.PutBytes([]byte("project-owned source"))
	if err != nil {
		t.Fatal(err)
	}
	if err := server.DB.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	if _, err := server.DB.IndexDocument(ctx, store.Document{
		ProjectID: project.ID, Title: "owned", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions, Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: "project-owned source"}}, [][]float32{vector}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(receipt.Path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(receipt.Path, 0o700); err != nil {
		t.Fatal(err)
	}
	body := `{"project_id":"` + project.ID + `","confirm_name":"deferred CAS cleanup"}`
	recorder := httptest.NewRecorder()
	server.handleProjectPath(recorder,
		httptest.NewRequest(http.MethodDelete, "/api/v1/projects/"+project.ID, strings.NewReader(body)))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"cas_cleanup_pending":1`) {
		t.Fatalf("deferred cleanup status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := server.DB.Project(ctx, project.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("relational project deletion was not committed: %v", err)
	}
}

func TestBrowserProfileResetRequiresExplicitPhrase(t *testing.T) {
	fixture := &browserLifecycleFixture{}
	server := &Server{Browser: fixture}
	call := func(body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		server.handleBrowserProfileReset(recorder,
			httptest.NewRequest(http.MethodPost, "/api/v1/browser/profile-reset", strings.NewReader(body)))
		return recorder
	}
	if response := call(`{"confirmation":"reset"}`); response.Code != http.StatusBadRequest {
		t.Fatalf("weak confirmation status=%d body=%s", response.Code, response.Body.String())
	}
	if fixture.resetCalls != 0 {
		t.Fatal("invalid confirmation reached browser controller")
	}
	response := call(`{"confirmation":"RESET INTERNET PROFILE"}`)
	if response.Code != http.StatusAccepted || fixture.resetCalls != 1 {
		t.Fatalf("confirmed reset status=%d calls=%d body=%s", response.Code, fixture.resetCalls, response.Body.String())
	}
}

func TestMemoryDeletionRequiresExactDocumentAndTitle(t *testing.T) {
	server, _ := startTestServer(t)
	ctx := context.Background()
	project, err := server.DB.CreateProject(ctx, "memory api")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := server.CAS.PutBytes([]byte("memory API source"))
	if err != nil {
		t.Fatal(err)
	}
	if err := server.DB.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	document, err := server.DB.IndexDocument(ctx, store.Document{
		ProjectID: project.ID, Title: "Delete this memory", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions, Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: "memory API source"}}, [][]float32{vector})
	if err != nil {
		t.Fatal(err)
	}
	call := func(body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		server.handleProjectPath(recorder,
			httptest.NewRequest(http.MethodDelete, "/api/v1/projects/"+project.ID+"/memory/"+document.ID, strings.NewReader(body)))
		return recorder
	}
	if response := call(`{"document_id":"different","confirm_title":"Delete this memory"}`); response.Code != http.StatusBadRequest {
		t.Fatalf("mismatched document status=%d body=%s", response.Code, response.Body.String())
	}
	if response := call(`{"document_id":"` + document.ID + `","confirm_title":"wrong"}`); response.Code != http.StatusConflict {
		t.Fatalf("wrong title status=%d body=%s", response.Code, response.Body.String())
	}
	response := call(`{"document_id":"` + document.ID + `","confirm_title":"Delete this memory"}`)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"cas_cleanup_pending":true`) ||
		!strings.Contains(response.Body.String(), `"cas_object_removed":false`) {
		t.Fatalf("confirmed memory deletion status=%d body=%s", response.Code, response.Body.String())
	}
	if _, err := server.CAS.ReadVerified(receipt.Hash); err != nil {
		t.Fatalf("online deletion removed CAS before startup reconciliation: %v", err)
	}
	other, err := server.DB.CreateProject(ctx, "same hash adopter")
	if err != nil {
		t.Fatal(err)
	}
	if err := server.DB.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	if _, err := server.DB.IndexDocument(ctx, store.Document{
		ProjectID: other.ID, Title: "same hash", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions, Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: "memory API source"}}, [][]float32{vector}); err != nil {
		t.Fatal(err)
	}
	registry, err := server.DB.ReconcileBlobRegistry(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.CAS.Reconcile(ctx, registry.Reachable); err != nil {
		t.Fatal(err)
	}
	if _, err := server.CAS.ReadVerified(receipt.Hash); err != nil {
		t.Fatalf("startup reconciliation removed concurrently re-adopted CAS: %v", err)
	}
}

func TestMemoryStatusAndReindexRoutesUseConfiguredController(t *testing.T) {
	fixture := &memoryControllerFixture{
		status: store.ProjectMemoryHead{
			ProjectID: "prj_memory", ActiveIndexID: "idx_new", MemoryRevision: 4, State: "ready",
		},
		reindex: store.EmbeddingIndex{ID: "idx_new", ProjectID: "prj_memory", State: "active"},
	}
	server := &Server{Memory: fixture}
	statusRecorder := httptest.NewRecorder()
	server.handleProjectPath(statusRecorder,
		httptest.NewRequest(http.MethodGet, "/api/v1/projects/prj_memory/memory/status", nil))
	if statusRecorder.Code != http.StatusOK || !strings.Contains(statusRecorder.Body.String(), `"memory_revision":4`) {
		t.Fatalf("memory status code=%d body=%s", statusRecorder.Code, statusRecorder.Body.String())
	}
	reindexRecorder := httptest.NewRecorder()
	server.handleProjectPath(reindexRecorder,
		httptest.NewRequest(http.MethodPost, "/api/v1/projects/prj_memory/memory/reindex", nil))
	if reindexRecorder.Code != http.StatusOK || fixture.reindexCalls != 1 ||
		!strings.Contains(reindexRecorder.Body.String(), `"id":"idx_new"`) {
		t.Fatalf("memory reindex code=%d calls=%d body=%s", reindexRecorder.Code, fixture.reindexCalls, reindexRecorder.Body.String())
	}
}

func TestMemorySearchRouteReturnsQueryDigestAndActiveHead(t *testing.T) {
	fixture := &memoryControllerFixture{
		status: store.ProjectMemoryHead{ProjectID: "prj_memory", ActiveIndexID: "idx_new", MemoryRevision: 5, State: "ready"},
		search: []store.GraphMemoryResult{{MemoryResult: store.MemoryResult{ChunkID: "chk_1", DocumentID: "doc_1", Title: "source", Text: "exact result", Score: 0.5}}},
	}
	server := &Server{}
	server.Memory = fixture
	recorder := httptest.NewRecorder()
	server.handleProjectPath(recorder, httptest.NewRequest(http.MethodPost,
		"/api/v1/projects/prj_memory/memory/search", strings.NewReader(`{"query":"exact query","limit":12}`)))
	if recorder.Code != http.StatusOK || fixture.searchCalls != 1 ||
		!strings.Contains(recorder.Body.String(), `"query_sha256":"382a3aa4e4212f03dfe6584350f40bc3772f5c3544e10373375ee6c70083e5db"`) ||
		!strings.Contains(recorder.Body.String(), `"active_index_id":"idx_new"`) {
		t.Fatalf("memory search code=%d calls=%d body=%s", recorder.Code, fixture.searchCalls, recorder.Body.String())
	}
}

func TestMemorySearchRouteSurfacesFailClosedGraphBlock(t *testing.T) {
	fixture := &memoryControllerFixture{searchErr: fmt.Errorf("%w: knowledge graph is stale/ready", store.ErrKnowledgeGraphUnavailable)}
	server := &Server{Memory: fixture}
	recorder := httptest.NewRecorder()
	server.handleProjectPath(recorder, httptest.NewRequest(http.MethodPost,
		"/api/v1/projects/prj_memory/memory/search", strings.NewReader(`{"query":"exact query","limit":12}`)))
	if recorder.Code != http.StatusServiceUnavailable || fixture.searchCalls != 1 ||
		!strings.Contains(recorder.Body.String(), `"code":"knowledge_graph_unavailable"`) {
		t.Fatalf("graph block code=%d calls=%d body=%s", recorder.Code, fixture.searchCalls, recorder.Body.String())
	}
}

func TestMemorySearchRouteRejectsNonCanonicalRequestsBeforeEmbedding(t *testing.T) {
	for _, body := range []string{
		`{"query":"exact query","limit":0}`,
		`{"query":"exact query","limit":13}`,
		`{"query":"exact query","limit":12,"fallback":"lexical"}`,
	} {
		fixture := &memoryControllerFixture{}
		server := &Server{Memory: fixture}
		recorder := httptest.NewRecorder()
		server.handleProjectPath(recorder, httptest.NewRequest(http.MethodPost,
			"/api/v1/projects/prj_memory/memory/search", strings.NewReader(body)))
		if recorder.Code != http.StatusBadRequest || fixture.searchCalls != 0 {
			t.Fatalf("non-canonical body accepted: code=%d calls=%d body=%s", recorder.Code, fixture.searchCalls, recorder.Body.String())
		}
	}
}

func TestMemoryReindexReportsConcurrentBuild(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		code string
	}{
		{name: "shadow", err: store.ErrShadowBuildInProgress, code: "memory_reindex_in_progress"},
		{name: "research", err: store.ErrMemoryRunInProgress, code: "memory_reindex_blocked"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := &memoryControllerFixture{reindexErr: test.err}
			server := &Server{Memory: fixture}
			recorder := httptest.NewRecorder()
			server.handleProjectPath(recorder,
				httptest.NewRequest(http.MethodPost, "/api/v1/projects/prj_memory/memory/reindex", nil))
			if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), test.code) {
				t.Fatalf("blocked reindex code=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestSetupMemoryControllerReturnsStatusButRejectsReindex(t *testing.T) {
	server, _ := startTestServer(t)
	ctx := context.Background()
	project, err := server.DB.CreateProject(ctx, "setup memory")
	if err != nil {
		t.Fatal(err)
	}
	server.Memory = &memoryindex.Service{DB: server.DB}
	statusRecorder := httptest.NewRecorder()
	server.handleProjectPath(statusRecorder,
		httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+project.ID+"/memory/status", nil))
	if statusRecorder.Code != http.StatusOK || !strings.Contains(statusRecorder.Body.String(), `"state":"empty"`) {
		t.Fatalf("setup memory status code=%d body=%s", statusRecorder.Code, statusRecorder.Body.String())
	}
	reindexRecorder := httptest.NewRecorder()
	server.handleProjectPath(reindexRecorder,
		httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+project.ID+"/memory/reindex", nil))
	if reindexRecorder.Code != http.StatusServiceUnavailable ||
		!strings.Contains(reindexRecorder.Body.String(), "memory_reindex_unavailable") {
		t.Fatalf("setup memory reindex code=%d body=%s", reindexRecorder.Code, reindexRecorder.Body.String())
	}
}

func TestServerBindsLoopbackAndReturnsSecurityHeaders(t *testing.T) {
	server, endpoint := startTestServer(t)
	server.RuntimeWarnings = []string{"managed runtime is unavailable"}
	server.RuntimeState = func() (any, []string) {
		return map[string]any{"configured": false, "channel": "stable"}, []string{"runtime trust root is not configured"}
	}
	unauthorized, err := (&http.Client{Timeout: 3 * time.Second}).Get(endpoint + "/api/v1/status")
	if err != nil {
		t.Fatal(err)
	}
	unauthorized.Body.Close()
	if unauthorized.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated read status = %d", unauthorized.StatusCode)
	}
	request, err := http.NewRequest(http.MethodGet, endpoint+"/api/v1/status", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+server.Token())
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status endpoint = %d", response.StatusCode)
	}
	var status map[string]any
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if ready, _ := status["ready"].(bool); ready {
		t.Fatal("server without a run controller reported ready")
	}
	warnings, ok := status["runtime_warnings"].([]any)
	if !ok || len(warnings) != 2 {
		t.Fatalf("runtime warnings = %#v", status["runtime_warnings"])
	}
	update, ok := status["runtime_update"].(map[string]any)
	if !ok || update["configured"] != false || update["channel"] != "stable" {
		t.Fatalf("runtime update state = %#v", status["runtime_update"])
	}
	if response.Header.Get("Content-Security-Policy") == "" || response.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("security headers are missing")
	}
	if !strings.HasPrefix(endpoint, "http://127.0.0.1:") {
		t.Fatalf("server did not bind IPv4 loopback: %s", endpoint)
	}
}

func TestArtifactDownloadStreamsVerifiedBinaryWithHashHeaders(t *testing.T) {
	server, endpoint := startTestServer(t)
	ctx := context.Background()
	project, err := server.DB.CreateProject(ctx, "engineering")
	if err != nil {
		t.Fatal(err)
	}
	run, err := server.DB.CreateRun(ctx, project.ID, "", "mesh", "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = server.DB.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := server.DB.BeginStage(ctx, run.ID, core.StagePlan, 0, "thread-artifact", "input")
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte{0x00, 0x01, 0x02, 0xff, 'S', 'U', '2'}
	receipt, err := server.CAS.PutBytes(payload)
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := server.DB.PublishArtifact(ctx, run.ID, attempt.ID, "engineering.mesh.su2", "application/octet-stream", receipt)
	if err != nil {
		t.Fatal(err)
	}

	request, err := http.NewRequest(http.MethodGet, endpoint+"/api/v1/artifacts/"+artifact.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+server.Token())
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("artifact status = %d", response.StatusCode)
	}
	if got := response.Header.Get("X-Content-SHA256"); got != receipt.Hash {
		t.Fatalf("X-Content-SHA256 = %q, want %q", got, receipt.Hash)
	}
	if got := response.Header.Get("Content-Type"); got != "application/octet-stream" {
		t.Fatalf("Content-Type = %q", got)
	}
	disposition := response.Header.Get("Content-Disposition")
	if !strings.Contains(disposition, "attachment") || !strings.Contains(disposition, ".su2") {
		t.Fatalf("Content-Disposition = %q", disposition)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", response.Header.Get("Cache-Control"))
	}
	actual, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, payload) {
		t.Fatalf("artifact payload = %v, want %v", actual, payload)
	}
}

func TestArtifactDownloadDeclaresUTF8ForKoreanJSON(t *testing.T) {
	server, endpoint := startTestServer(t)
	ctx := context.Background()
	project, err := server.DB.CreateProject(ctx, "한글 연구")
	if err != nil {
		t.Fatal(err)
	}
	run, err := server.DB.CreateRun(ctx, project.ID, "", "최적화 결과", "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = server.DB.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := server.DB.BeginStage(ctx, run.ID, core.StagePlan, 0, "thread-korean-artifact", "input")
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{"title":"날개 최적화","status":"성공"}`)
	receipt, err := server.CAS.PutBytes(payload)
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := server.DB.PublishArtifact(ctx, run.ID, attempt.ID, "research.report", "application/json", receipt)
	if err != nil {
		t.Fatal(err)
	}

	request, err := http.NewRequest(http.MethodGet, endpoint+"/api/v1/artifacts/"+artifact.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+server.Token())
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("artifact status = %d", response.StatusCode)
	}
	if got := response.Header.Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if disposition := response.Header.Get("Content-Disposition"); !strings.Contains(disposition, ".json") {
		t.Fatalf("Content-Disposition = %q", disposition)
	}
	actual, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, payload) {
		t.Fatalf("artifact payload = %q, want %q", actual, payload)
	}
}

func TestArtifactDownloadNameUsesWordExtensionForRenderedReport(t *testing.T) {
	artifact := store.Artifact{ID: "art_report", Kind: "research.report.document"}
	name := artifactDownloadName(artifact, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	if name != "art_report-research.report.document.docx" {
		t.Fatalf("Word report download name = %q", name)
	}
}

func TestDeviceLoginReportsUnavailableRuntime(t *testing.T) {
	server, endpoint := startTestServer(t)
	request, err := http.NewRequest(http.MethodPost, endpoint+"/api/v1/auth/codex/device-code", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+server.Token())
	request.Header.Set("Origin", endpoint)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("device login status = %d", response.StatusCode)
	}
}

type codexAccountFixture struct {
	value any
	err   error
}

func (fixture codexAccountFixture) ReadCodexAccount(context.Context) (any, error) {
	return fixture.value, fixture.err
}

func TestCodexAccountStatusUsesAuthenticatedStableReadback(t *testing.T) {
	server, endpoint := startTestServer(t)
	server.CodexAccount = codexAccountFixture{value: map[string]any{
		"authenticated": true, "chatgpt": true, "account_type": "chatgpt", "plan_type": "pro",
		"requires_openai_auth": true,
	}}
	request, err := http.NewRequest(http.MethodGet, endpoint+"/api/v1/auth/codex/status", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+server.Token())
	request.Header.Set("Origin", endpoint)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("Codex account status = %d", response.StatusCode)
	}
	var status map[string]any
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status["authenticated"] != true || status["chatgpt"] != true || status["account_type"] != "chatgpt" || status["plan_type"] != "pro" {
		t.Fatalf("unexpected Codex account status: %#v", status)
	}
}

func TestChatRejectsMissingCodexLoginBeforeStartingATurn(t *testing.T) {
	server, endpoint := startTestServer(t)
	chat := &chatControllerFixture{}
	server.Chat = chat
	server.Models = modelCatalogFixture{}
	server.CodexAccount = codexAccountFixture{value: map[string]any{
		"authenticated": false, "chatgpt": false, "requires_openai_auth": true,
	}}
	body, err := json.Marshal(map[string]string{
		"message": "로그인 상태를 확인해 줘", "mode": "chat", "model": core.PlannerModel,
		"reasoning_effort": core.PlannerEffort, "speed": "standard",
	})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, endpoint+"/api/v1/sessions/session-no-login/chat", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+server.Token())
	request.Header.Set("Origin", endpoint)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("chat without Codex login status = %d", response.StatusCode)
	}
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Error.Code != "codex_login_required" {
		t.Fatalf("chat without Codex login code = %q", payload.Error.Code)
	}
	if chat.message != "" {
		t.Fatalf("chat turn started before login: %q", chat.message)
	}
}

func TestOpenCodexLoginUsesOnlyOfficialURL(t *testing.T) {
	server, endpoint := startTestServer(t)
	var opened string
	server.OpenExternalURL = func(rawURL string) error {
		opened = rawURL
		return nil
	}
	request := func(rawURL string) *http.Response {
		t.Helper()
		body, err := json.Marshal(map[string]string{"url": rawURL})
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequest(http.MethodPost, endpoint+"/api/v1/auth/codex/open-login", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+server.Token())
		req.Header.Set("Origin", endpoint)
		response, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}

	response := request("https://auth.openai.com/codex/device?user_code=ABCD")
	response.Body.Close()
	if response.StatusCode != http.StatusOK || opened != "https://auth.openai.com/codex/device?user_code=ABCD" {
		t.Fatalf("official login URL result: status=%d opened=%q", response.StatusCode, opened)
	}
	opened = ""
	response = request("https://attacker.invalid/login")
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest || opened != "" {
		t.Fatalf("untrusted login URL result: status=%d opened=%q", response.StatusCode, opened)
	}
}

func TestRunPickerCatalogAndSelectionReachController(t *testing.T) {
	server, endpoint := startTestServer(t)
	runs := &runControllerFixture{}
	server.Runs = runs
	server.Models = modelCatalogFixture{}
	project, err := server.DB.CreateProject(context.Background(), "picker")
	if err != nil {
		t.Fatal(err)
	}

	requestBody, err := json.Marshal(map[string]string{
		"query": "research", "model": core.PlannerModel,
		"reasoning_effort": core.PlannerEffort, "speed": "fast",
	})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, endpoint+"/api/v1/projects/"+project.ID+"/runs", bytes.NewReader(requestBody))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+server.Token())
	request.Header.Set("Origin", endpoint)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("create run status = %d", response.StatusCode)
	}
	if runs.configuration.ServiceTier != core.ServiceTierFast || runs.configuration.Model != core.PlannerModel || runs.configuration.ReasoningEffort != core.PlannerEffort {
		t.Fatalf("controller configuration = %+v", runs.configuration)
	}

	statusRequest, err := http.NewRequest(http.MethodGet, endpoint+"/api/v1/status", nil)
	if err != nil {
		t.Fatal(err)
	}
	statusRequest.Header.Set("Authorization", "Bearer "+server.Token())
	statusResponse, err := (&http.Client{Timeout: 3 * time.Second}).Do(statusRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer statusResponse.Body.Close()
	var status map[string]any
	if err := json.NewDecoder(statusResponse.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	options, ok := status["model_options"].([]any)
	if !ok || len(options) != 1 {
		t.Fatalf("model options = %#v", status["model_options"])
	}
}

func TestRunSteerForwardsMessageToController(t *testing.T) {
	server, endpoint := startTestServer(t)
	runs := &runControllerFixture{}
	server.Runs = runs
	body, err := json.Marshal(map[string]string{"message": "근거의 반대 사례도 확인해 줘"})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, endpoint+"/api/v1/runs/run-live/steer", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+server.Token())
	request.Header.Set("Origin", endpoint)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("steer status = %d", response.StatusCode)
	}
	if runs.steeredRunID != "run-live" || runs.steeredMessage != "근거의 반대 사례도 확인해 줘" {
		t.Fatalf("steer forwarded run=%q message=%q", runs.steeredRunID, runs.steeredMessage)
	}
}

func TestChatAndSteeringPreserveUnicodeAndRejectReplacementCharacters(t *testing.T) {
	server, endpoint := startTestServer(t)
	chat := &chatControllerFixture{}
	runs := &runControllerFixture{}
	server.Chat = chat
	server.Models = modelCatalogFixture{}
	server.Runs = runs
	client := &http.Client{Timeout: 3 * time.Second}
	requestJSON := func(path string, body any) *http.Response {
		t.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		request, err := http.NewRequest(http.MethodPost, endpoint+path, bytes.NewReader(encoded))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+server.Token())
		request.Header.Set("Origin", endpoint)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}

	const chatMessage = "한글 대화와 emoji 😀 – 그대로"
	response := requestJSON("/api/v1/sessions/ses-unicode/chat", map[string]string{
		"message": chatMessage, "mode": "chat", "model": core.PlannerModel,
		"reasoning_effort": core.PlannerEffort, "speed": "standard", "context_profile": core.ContextProfileLong1M,
	})
	response.Body.Close()
	if response.StatusCode != http.StatusOK || chat.message != chatMessage || chat.configuration.ContextProfile != core.ContextProfileLong1M {
		t.Fatalf("unicode chat status=%d forwarded=%q", response.StatusCode, chat.message)
	}
	response = requestJSON("/api/v1/sessions/ses-unicode/chat", map[string]string{
		"message": "손상된 대화 \uFFFD", "mode": "chat", "model": core.PlannerModel,
		"reasoning_effort": core.PlannerEffort, "speed": "standard",
	})
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest || chat.message != chatMessage {
		t.Fatalf("damaged chat status=%d forwarded=%q", response.StatusCode, chat.message)
	}

	const steeringMessage = "새 근거를 확인해 줘 🛩️"
	response = requestJSON("/api/v1/runs/run-unicode/steer", map[string]string{"message": steeringMessage})
	response.Body.Close()
	if response.StatusCode != http.StatusAccepted || runs.steeredMessage != steeringMessage {
		t.Fatalf("unicode steering status=%d forwarded=%q", response.StatusCode, runs.steeredMessage)
	}
	response = requestJSON("/api/v1/runs/run-unicode/steer", map[string]string{"message": "손상된 지시 \uFFFD"})
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest || runs.steeredMessage != steeringMessage {
		t.Fatalf("damaged steering status=%d forwarded=%q", response.StatusCode, runs.steeredMessage)
	}
}

func TestProjectChatForwardsPlanModeWithoutStartingRun(t *testing.T) {
	server, endpoint := startTestServer(t)
	project, err := server.DB.CreateProject(context.Background(), "plan chat")
	if err != nil {
		t.Fatal(err)
	}
	session, err := server.DB.DefaultConversationSession(context.Background(), project.ID)
	if err != nil {
		t.Fatal(err)
	}
	cycle, err := server.DB.BeginConversationPlanCycle(context.Background(), session.ID, "시장 범위를 정한다")
	if err != nil {
		t.Fatal(err)
	}
	chat := &chatControllerFixture{}
	server.Chat = chat
	server.Models = modelCatalogFixture{}
	body, err := json.Marshal(map[string]string{
		"message": "시장 범위부터 정하자", "mode": "plan", "model": core.PlannerModel,
		"reasoning_effort": core.PlannerEffort, "speed": "fast", "plan_cycle_id": cycle.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, endpoint+"/api/v1/sessions/"+session.ID+"/chat", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+server.Token())
	request.Header.Set("Origin", endpoint)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("chat status = %d", response.StatusCode)
	}
	if chat.projectID != session.ID || chat.message != "시장 범위부터 정하자" || chat.mode != core.ChatModePlan {
		t.Fatalf("chat forwarded project=%q message=%q mode=%q", chat.projectID, chat.message, chat.mode)
	}
	if chat.configuration.ServiceTier != core.ServiceTierFast {
		t.Fatalf("chat service tier = %q", chat.configuration.ServiceTier)
	}
	var reply core.ChatReply
	if err := json.NewDecoder(response.Body).Decode(&reply); err != nil {
		t.Fatal(err)
	}
	if reply.Text != "계획 답변" || reply.TurnID != "turn-chat" {
		t.Fatalf("chat reply = %+v", reply)
	}
}

func TestSessionPlanCycleAPIPersistsReadyPlanAndStartsByOpaqueID(t *testing.T) {
	server, endpoint := startTestServer(t)
	project, err := server.DB.CreateProject(context.Background(), "plan api")
	if err != nil {
		t.Fatal(err)
	}
	session, err := server.DB.DefaultConversationSession(context.Background(), project.ID)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Timeout: 3 * time.Second}
	requestJSON := func(path string, body any) *http.Response {
		t.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		request, err := http.NewRequest(http.MethodPost, endpoint+path, bytes.NewReader(encoded))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+server.Token())
		request.Header.Set("Origin", endpoint)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	response := requestJSON("/api/v1/sessions/"+session.ID+"/plan-cycle", map[string]string{
		"objective": "일반 채팅 여러 문장의 요구사항 snapshot",
	})
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("begin plan cycle status = %d", response.StatusCode)
	}
	var started struct {
		PlanCycle core.ConversationPlanCycle `json:"plan_cycle"`
	}
	if err := json.NewDecoder(response.Body).Decode(&started); err != nil {
		t.Fatal(err)
	}
	chat := &chatControllerFixture{reply: core.ChatReply{Text: "# 목표\n실제 목표\n\n# 완료 기준\n검증", PlanReady: true}}
	server.Chat = chat
	server.Models = modelCatalogFixture{}
	response = requestJSON("/api/v1/sessions/"+session.ID+"/chat", map[string]string{
		"message": "선택 답변", "mode": "plan", "plan_cycle_id": started.PlanCycle.ID,
		"model": core.PlannerModel, "reasoning_effort": core.PlannerEffort, "speed": "standard",
	})
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("ready plan chat status = %d", response.StatusCode)
	}
	ready, err := server.DB.LatestConversationPlanCycle(context.Background(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ready.ID != started.PlanCycle.ID || ready.Status != "ready" || ready.FinalPlan != chat.reply.Text {
		t.Fatalf("ready plan cycle = %+v", ready)
	}
	runs := &runControllerFixture{}
	server.Runs = runs
	response = requestJSON("/api/v1/sessions/"+session.ID+"/planned-runs", map[string]string{
		"plan_cycle_id": ready.ID, "model": core.PlannerModel,
		"reasoning_effort": core.PlannerEffort, "speed": "standard",
	})
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("planned run status = %d", response.StatusCode)
	}
	if runs.plannedSession != session.ID || runs.plannedCycle != ready.ID {
		t.Fatalf("planned run forwarded session=%q cycle=%q", runs.plannedSession, runs.plannedCycle)
	}
}

func TestSessionChatGETReturnsCodexOwnedHistoryProjection(t *testing.T) {
	server, endpoint := startTestServer(t)
	project, err := server.DB.CreateProject(context.Background(), "history")
	if err != nil {
		t.Fatal(err)
	}
	session, err := server.DB.DefaultConversationSession(context.Background(), project.ID)
	if err != nil {
		t.Fatal(err)
	}
	history := &chatHistoryFixture{}
	server.ChatHistory = history
	request, err := http.NewRequest(http.MethodGet, endpoint+"/api/v1/sessions/"+session.ID+"/chat", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+server.Token())
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("chat history status = %d", response.StatusCode)
	}
	var payload core.ChatHistory
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if history.sessionID != session.ID || payload.ThreadID != "thread-history" || len(payload.Messages) != 1 || payload.Messages[0].Text != "복구된 답변" {
		t.Fatalf("chat history fixture=%+v payload=%+v", history, payload)
	}
}

func TestProjectContextUsageReturnsMainThreadMeasurement(t *testing.T) {
	server, endpoint := startTestServer(t)
	server.ContextUsage = contextUsageFixture{}
	project, err := server.DB.CreateProject(context.Background(), "context")
	if err != nil {
		t.Fatal(err)
	}
	if err := server.DB.SetProjectMainThread(context.Background(), project.ID, "thread-context"); err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodGet, endpoint+"/api/v1/projects/"+project.ID+"/context-usage", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+server.Token())
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("context usage status = %d", response.StatusCode)
	}
	var usage core.ContextWindowUsage
	if err := json.NewDecoder(response.Body).Decode(&usage); err != nil {
		t.Fatal(err)
	}
	if !usage.Available || usage.CurrentTokens != 25000 || usage.ContextWindow != 200000 {
		t.Fatalf("context usage = %+v", usage)
	}
}

func TestScheduleAPIUsesValidatedScheduler(t *testing.T) {
	server, endpoint := startTestServer(t)
	ctx := context.Background()
	project, err := server.DB.CreateProject(ctx, "scheduled")
	if err != nil {
		t.Fatal(err)
	}
	if err := server.DB.SetProjectMainThread(ctx, project.ID, "thread-main"); err != nil {
		t.Fatal(err)
	}
	server.Scheduler = &schedulepkg.Service{DB: server.DB}
	body, err := json.Marshal(map[string]any{
		"project_id": project.ID, "question": "daily research", "kind": "every",
		"expression": "24h", "timezone": "Asia/Seoul",
	})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, endpoint+"/api/v1/schedules", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+server.Token())
	request.Header.Set("Origin", endpoint)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("create schedule status = %d", response.StatusCode)
	}
	request, err = http.NewRequest(http.MethodGet, endpoint+"/api/v1/schedules", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+server.Token())
	response, err = (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var schedules []map[string]any
	if err := json.NewDecoder(response.Body).Decode(&schedules); err != nil {
		t.Fatal(err)
	}
	if len(schedules) != 1 || schedules[0]["project_id"] != project.ID {
		t.Fatalf("unexpected schedules: %+v", schedules)
	}
}

func TestScheduleAPIEncodesAnEmptyListAsJSONArray(t *testing.T) {
	server, endpoint := startTestServer(t)
	request, err := http.NewRequest(http.MethodGet, endpoint+"/api/v1/schedules", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+server.Token())
	request.Header.Set("Origin", endpoint)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("empty schedule list status = %d", response.StatusCode)
	}
	var schedules []core.Schedule
	if err := json.NewDecoder(response.Body).Decode(&schedules); err != nil {
		t.Fatal(err)
	}
	if schedules == nil || len(schedules) != 0 {
		t.Fatalf("empty schedule list = %#v", schedules)
	}
}
