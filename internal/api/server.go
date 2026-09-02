package api

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	memoryindex "github.com/djkim0320/AetherOps/internal/memory"
	"github.com/djkim0320/AetherOps/internal/store"
	"github.com/djkim0320/AetherOps/internal/toolstudio"
)

const maxRequestBytes = 28 << 20

const (
	maxChatAttachments     = 4
	maxChatAttachmentBytes = 10 << 20
	maxChatAttachmentTotal = 20 << 20
)

type RunController interface {
	StartRun(context.Context, string, string, core.RunConfiguration) (core.Run, error)
	StartSessionRun(context.Context, string, string, core.RunConfiguration) (core.Run, error)
	StartPlannedSessionRun(context.Context, string, string, core.RunConfiguration) (core.Run, error)
	SteerRun(context.Context, string, string) (core.Run, error)
	CancelRun(context.Context, string) (core.Run, error)
	ResumeRun(context.Context, string) (core.Run, error)
	DiscardRun(context.Context, string) (core.Run, error)
}

type ChatController interface {
	ChatProject(context.Context, string, string, []core.ChatAttachment, core.ChatMode, string, core.RunConfiguration) (core.ChatReply, error)
	ChatSession(context.Context, string, string, []core.ChatAttachment, core.ChatMode, string, core.RunConfiguration) (core.ChatReply, error)
}

type ChatHistoryProvider interface {
	ChatHistorySession(context.Context, string) (core.ChatHistory, error)
}

type ModelCatalog interface {
	ModelOptions() []core.ModelOption
	ValidateRunConfiguration(context.Context, core.RunConfiguration) error
}

type ContextUsageProvider interface {
	ContextWindowUsage(context.Context, string) (core.ContextWindowUsage, bool)
}

type ProjectCreator interface {
	CreateProject(context.Context, string) (core.Project, error)
}

type MemoryController interface {
	MemoryStatus(context.Context, string) (store.ProjectMemoryHead, error)
	ReindexProject(context.Context, string) (store.EmbeddingIndex, error)
	SearchProject(context.Context, string, string, int) ([]store.GraphMemoryResult, error)
}

type BrowserController interface {
	Status(context.Context) (any, error)
	EmergencyStop(context.Context) error
	SetMode(context.Context, string) error
	ResetProfile(context.Context) (any, error)
}

type CredentialStore interface {
	SetOpenAIAPIKey([]byte) error
	OpenAIAPIKey() ([]byte, error)
}

type DeviceLogin interface {
	StartDeviceLogin(context.Context) (any, error)
}

type CodexAccountReader interface {
	ReadCodexAccount(context.Context) (any, error)
}

type ApprovalController interface {
	Decide(context.Context, string, string) (core.Approval, error)
}

type ScheduleController interface {
	Create(context.Context, core.Schedule) (core.Schedule, error)
}

type Server struct {
	DB              *store.DB
	CAS             *cas.Store
	Runs            RunController
	Chat            ChatController
	ChatHistory     ChatHistoryProvider
	Models          ModelCatalog
	ContextUsage    ContextUsageProvider
	ProjectCreator  ProjectCreator
	Memory          MemoryController
	Browser         BrowserController
	Credentials     CredentialStore
	Login           DeviceLogin
	CodexAccount    CodexAccountReader
	ApprovalDecider ApprovalController
	ToolStudio      interface {
		List(context.Context, string) ([]core.ToolPackage, error)
		Get(context.Context, string, string) (core.ToolPackage, error)
		Propose(context.Context, string, string, string, toolstudio.Proposal) (core.ToolPackage, error)
		Activate(context.Context, string, string) (core.ToolPackage, error)
		Disable(context.Context, string, string) (core.ToolPackage, error)
	}
	Scheduler       ScheduleController
	Knowledge       KnowledgeController
	Shell           http.Handler
	OpenAIKeyStored func()
	OpenExternalURL func(string) error
	RuntimeWarnings []string
	RuntimeState    func() (any, []string)
	// ReleaseBrowserObservation is configured only for an explicitly requested
	// protected release-evaluation session. It performs a real, read-only
	// Chrome DevTools MCP observation against the live internet WebView2.
	ReleaseBrowserObservation func(context.Context) (any, error)
	ProductBuild              buildinfo.ProductBuildBinding

	mu       sync.RWMutex
	token    string
	endpoint string
	http     *http.Server
	listener net.Listener
}

func (server *Server) Start(ctx context.Context) (string, error) {
	if server.DB == nil || server.CAS == nil {
		return "", errors.New("API storage is not configured")
	}
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	endpoint := "http://" + listener.Addr().String()
	server.mu.Lock()
	server.token = token
	server.endpoint = endpoint
	server.listener = listener
	server.http = &http.Server{
		Handler:           server.securityHeaders(server.routes()),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	httpServer := server.http
	server.mu.Unlock()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()
	go func() {
		if serveErr := httpServer.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			// The owning application observes health through Status and process exit.
			_ = listener.Close()
		}
	}()
	return endpoint, nil
}

func (server *Server) Shutdown(ctx context.Context) error {
	server.mu.RLock()
	httpServer := server.http
	server.mu.RUnlock()
	if httpServer == nil {
		return nil
	}
	return httpServer.Shutdown(ctx)
}

func (server *Server) Token() string {
	server.mu.RLock()
	defer server.mu.RUnlock()
	return server.token
}

func (server *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/status", server.handleStatus)
	mux.HandleFunc("/api/v1/projects", server.handleProjects)
	mux.HandleFunc("/api/v1/projects/", server.handleProjectPath)
	mux.HandleFunc("/api/v1/sessions/", server.handleSessionPath)
	mux.HandleFunc("/api/v1/runs/", server.handleRunPath)
	mux.HandleFunc("/api/v1/artifacts/", server.handleArtifact)
	mux.HandleFunc("/api/v1/events", server.handleEvents)
	mux.HandleFunc("/api/v1/approvals", server.handleApprovals)
	mux.HandleFunc("/api/v1/approvals/", server.handleApprovalPath)
	mux.HandleFunc("/api/v1/schedules", server.handleSchedules)
	mux.HandleFunc("/api/v1/schedules/", server.handleSchedulePath)
	mux.HandleFunc("/api/v1/browser", server.handleBrowserStatus)
	mux.HandleFunc("/api/v1/browser/emergency-stop", server.handleEmergencyStop)
	mux.HandleFunc("/api/v1/browser/mode", server.handleBrowserMode)
	mux.HandleFunc("/api/v1/browser/profile-reset", server.handleBrowserProfileReset)
	mux.HandleFunc("/api/v1/settings", server.handleSettings)
	mux.HandleFunc("/api/v1/settings/openai-api-key", server.handleOpenAIKey)
	mux.HandleFunc("/api/v1/auth/codex/device-code", server.handleDeviceLogin)
	mux.HandleFunc("/api/v1/auth/codex/status", server.handleCodexAccountStatus)
	mux.HandleFunc("/api/v1/auth/codex/open-login", server.handleOpenCodexLogin)
	mux.HandleFunc("/api/v1/release-evidence/browser-observation", server.handleReleaseBrowserObservation)
	if server.Shell != nil {
		mux.Handle("/", server.Shell)
	}
	return server.authenticateAPI(mux)
}

func (server *Server) handleReleaseBrowserObservation(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet || server.ReleaseBrowserObservation == nil {
		http.NotFound(writer, request)
		return
	}
	observation, err := server.ReleaseBrowserObservation(request.Context())
	if err != nil {
		writeInternal(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, observation)
}

func (server *Server) authenticateAPI(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasPrefix(request.URL.Path, "/api/v1/") {
			server.mu.RLock()
			token, endpoint := server.token, server.endpoint
			server.mu.RUnlock()
			provided := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
			if len(provided) != len(token) || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
				writeError(writer, http.StatusUnauthorized, "unauthorized", "AetherOps access token is missing or invalid")
				return
			}
			if origin := request.Header.Get("Origin"); origin != "" && origin != endpoint {
				writeError(writer, http.StatusForbidden, "origin_rejected", "request origin is not the AetherOps shell")
				return
			}
		}
		next.ServeHTTP(writer, request)
	})
}

func (server *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("Referrer-Policy", "no-referrer")
		writer.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		writer.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'")
		next.ServeHTTP(writer, request)
	})
}

func (server *Server) handleStatus(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(writer)
		return
	}
	payload := map[string]any{
		"ready": server.Runs != nil, "version": "0.1.0-alpha.1", "platform": "windows/amd64",
		"model_options": []core.ModelOption{},
		"default_run_configuration": map[string]string{
			"model": core.PlannerModel, "reasoning_effort": core.PlannerEffort, "speed": "standard",
		},
	}
	if !server.ProductBuild.IsZero() {
		payload["product_build"] = server.ProductBuild
	}
	if server.Models != nil {
		payload["model_options"] = server.Models.ModelOptions()
	}
	runtimeWarnings := append([]string(nil), server.RuntimeWarnings...)
	if server.RuntimeState != nil {
		runtimeState, dynamicWarnings := server.RuntimeState()
		if runtimeState != nil {
			payload["runtime_update"] = runtimeState
		}
		runtimeWarnings = append(runtimeWarnings, dynamicWarnings...)
	}
	if len(runtimeWarnings) > 0 {
		payload["runtime_warnings"] = runtimeWarnings
	}
	if server.Browser != nil {
		browserStatus, err := server.Browser.Status(request.Context())
		if err != nil {
			payload["warnings"] = []string{"브라우저 상태를 확인하지 못했습니다"}
		} else {
			payload["browser"] = browserStatus
		}
	}
	writeJSON(writer, http.StatusOK, payload)
}

func (server *Server) handleProjects(writer http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		projects, err := server.DB.ListProjects(request.Context())
		if err != nil {
			writeInternal(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, projects)
	case http.MethodPost:
		if server.ProjectCreator == nil {
			writeError(writer, http.StatusServiceUnavailable, "project_creation_unavailable", "verified ontology runtime is required to create a project")
			return
		}
		var body struct {
			Name string `json:"name"`
		}
		if err := decodeJSON(request, &body); err != nil {
			writeError(writer, http.StatusBadRequest, "invalid_request", "프로젝트 이름을 입력해 주세요")
			return
		}
		name, valid := normalizedProjectName(body.Name)
		if !valid {
			writeError(writer, http.StatusBadRequest, "invalid_project_name", "프로젝트 이름은 1~120자여야 하며 손상된 문자를 포함할 수 없습니다")
			return
		}
		project, err := server.ProjectCreator.CreateProject(request.Context(), name)
		if err != nil {
			writeInternal(writer, err)
			return
		}
		writeJSON(writer, http.StatusCreated, project)
	default:
		methodNotAllowed(writer)
	}
}

func (server *Server) handleProjectPath(writer http.ResponseWriter, request *http.Request) {
	parts := pathParts(strings.TrimPrefix(request.URL.Path, "/api/v1/projects/"))
	if len(parts) >= 2 && parts[1] == "tools" {
		server.handleProjectTools(writer, request, parts)
		return
	}
	if len(parts) >= 2 && parts[1] == "knowledge" {
		server.handleKnowledgePath(writer, request, parts)
		return
	}
	if len(parts) == 1 && request.Method == http.MethodPatch {
		var body struct {
			Name string `json:"name"`
		}
		if err := decodeJSON(request, &body); err != nil {
			writeError(writer, http.StatusBadRequest, "invalid_request", "프로젝트 이름을 입력해 주세요")
			return
		}
		name, valid := normalizedProjectName(body.Name)
		if !valid {
			writeError(writer, http.StatusBadRequest, "invalid_project_name", "프로젝트 이름은 1~120자여야 하며 손상된 문자를 포함할 수 없습니다")
			return
		}
		project, err := server.DB.RenameProject(request.Context(), parts[0], name)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, project)
		return
	}
	if len(parts) == 1 && request.Method == http.MethodDelete {
		var body struct {
			ProjectID   string `json:"project_id"`
			ConfirmName string `json:"confirm_name"`
		}
		if err := decodeJSON(request, &body); err != nil || body.ProjectID != parts[0] || body.ConfirmName == "" {
			writeError(writer, http.StatusBadRequest, "invalid_deletion_confirmation", "project_id and the exact project name are required")
			return
		}
		project, err := server.DB.Project(request.Context(), parts[0])
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		if body.ConfirmName != project.Name {
			writeError(writer, http.StatusConflict, "deletion_confirmation_mismatch", "the project name confirmation does not match")
			return
		}
		orphaned, err := server.DB.DeleteProject(request.Context(), parts[0])
		if err != nil {
			if errors.Is(err, store.ErrProjectBusy) {
				writeError(writer, http.StatusConflict, "project_busy", "finish or explicitly resolve active runs, approvals, session provisioning, engineering work, memory indexing, and knowledge materialization before deleting the project")
				return
			}
			writeStoreError(writer, err)
			return
		}
		// Never unlink CAS objects on a live writer path. A same-hash object can
		// be adopted by another request after the relational commit; deleting it
		// here would leave that new reference dangling. The single-instance
		// startup reconciliation runs before writers and removes these orphans.
		removed, cleanupPending := 0, len(orphaned)
		writeJSON(writer, http.StatusOK, map[string]any{
			"deleted": true, "cas_objects_removed": removed, "cas_cleanup_pending": cleanupPending,
		})
		return
	}
	if len(parts) == 2 && parts[1] == "memory" && request.Method == http.MethodGet {
		documents, err := server.DB.MemoryDocuments(request.Context(), parts[0])
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"memory": documents})
		return
	}
	if len(parts) == 3 && parts[1] == "memory" && parts[2] == "status" && request.Method == http.MethodGet {
		if server.Memory == nil {
			writeError(writer, http.StatusServiceUnavailable, "memory_unavailable", "memory status is unavailable")
			return
		}
		status, err := server.Memory.MemoryStatus(request.Context(), parts[0])
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"memory": status})
		return
	}
	if len(parts) == 3 && parts[1] == "memory" && parts[2] == "reindex" && request.Method == http.MethodPost {
		if server.Memory == nil {
			writeError(writer, http.StatusServiceUnavailable, "memory_reindex_unavailable", "memory reindexing is unavailable")
			return
		}
		index, err := server.Memory.ReindexProject(request.Context(), parts[0])
		if err != nil {
			switch {
			case errors.Is(err, memoryindex.ErrReindexUnavailable):
				writeError(writer, http.StatusServiceUnavailable, "memory_reindex_unavailable", "the embeddings runtime is not configured")
			case errors.Is(err, store.ErrShadowBuildInProgress):
				writeError(writer, http.StatusConflict, "memory_reindex_in_progress", err.Error())
			case errors.Is(err, store.ErrMemoryRunInProgress):
				writeError(writer, http.StatusConflict, "memory_reindex_blocked", err.Error())
			default:
				writeStoreError(writer, err)
			}
			return
		}
		status, err := server.Memory.MemoryStatus(request.Context(), parts[0])
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"index": index, "memory": status})
		return
	}
	if len(parts) == 3 && parts[1] == "memory" && parts[2] == "search" && request.Method == http.MethodPost {
		if server.Memory == nil {
			writeError(writer, http.StatusServiceUnavailable, "memory_search_unavailable", "memory search is unavailable")
			return
		}
		var body struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		if err := decodeJSON(request, &body); err != nil {
			writeError(writer, http.StatusBadRequest, "invalid_request", "a strict memory search request is required")
			return
		}
		body.Query = strings.TrimSpace(body.Query)
		if body.Query == "" || len([]rune(body.Query)) > 4096 || body.Limit < 1 || body.Limit > 12 {
			writeError(writer, http.StatusBadRequest, "invalid_request", "query must contain 1-4096 characters and limit must be 1-12")
			return
		}
		results, err := server.Memory.SearchProject(request.Context(), parts[0], body.Query, body.Limit)
		if err != nil {
			if errors.Is(err, memoryindex.ErrReindexUnavailable) {
				writeError(writer, http.StatusServiceUnavailable, "memory_search_unavailable", "the embeddings runtime is not configured")
				return
			}
			if errors.Is(err, store.ErrKnowledgeGraphUnavailable) {
				writeError(writer, http.StatusServiceUnavailable, "knowledge_graph_unavailable", err.Error())
				return
			}
			writeStoreError(writer, err)
			return
		}
		status, err := server.Memory.MemoryStatus(request.Context(), parts[0])
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		digest := sha256.Sum256([]byte(body.Query))
		writeJSON(writer, http.StatusOK, map[string]any{
			"query_sha256": hex.EncodeToString(digest[:]), "memory": status, "results": results,
		})
		return
	}
	if len(parts) == 3 && parts[1] == "memory" && request.Method == http.MethodDelete {
		var body struct {
			DocumentID   string `json:"document_id"`
			ConfirmTitle string `json:"confirm_title"`
		}
		if err := decodeJSON(request, &body); err != nil || body.DocumentID != parts[2] || body.ConfirmTitle == "" {
			writeError(writer, http.StatusBadRequest, "invalid_deletion_confirmation", "document_id and the exact memory title are required")
			return
		}
		result, err := server.DB.ForgetMemoryDocument(request.Context(), parts[0], parts[2], body.ConfirmTitle)
		if err != nil {
			if errors.Is(err, store.ErrDeletionConfirmation) {
				writeError(writer, http.StatusConflict, "deletion_confirmation_mismatch", "the memory title confirmation does not match")
				return
			}
			if errors.Is(err, store.ErrMemoryMutationBlocked) {
				writeError(writer, http.StatusConflict, "memory_mutation_blocked", err.Error())
				return
			}
			writeStoreError(writer, err)
			return
		}
		removed := false
		cleanupPending := result.OrphanedBlobHash != ""
		writeJSON(writer, http.StatusOK, map[string]any{
			"deleted": result.Deleted, "forgotten": result.Forgotten,
			"retained_for_graph_provenance": result.RetainedForGraphProvenance,
			"knowledge_graph_stale":         result.KnowledgeGraphStale,
			"cas_object_removed":            removed,
			"cas_cleanup_pending":           cleanupPending,
		})
		return
	}
	if len(parts) == 2 && parts[1] == "chat" && request.Method == http.MethodPost {
		server.handleChat(writer, request, parts[0], false)
		return
	}
	if len(parts) == 2 && parts[1] == "sessions" {
		switch request.Method {
		case http.MethodGet:
			sessions, err := server.DB.ListConversationSessions(request.Context(), parts[0])
			if err != nil {
				writeStoreError(writer, err)
				return
			}
			writeJSON(writer, http.StatusOK, sessions)
		case http.MethodPost:
			var body struct {
				Title string `json:"title"`
			}
			if err := decodeJSON(request, &body); err != nil {
				writeError(writer, http.StatusBadRequest, "invalid_request", "대화 정보를 확인해 주세요")
				return
			}
			if !validConversationSessionTitle(body.Title) {
				writeError(writer, http.StatusBadRequest, "invalid_session_title", "대화 이름은 80자 이하여야 하며 손상된 문자를 포함할 수 없습니다")
				return
			}
			session, err := server.DB.CreateConversationSession(request.Context(), parts[0], body.Title, core.RunConfiguration{})
			if err != nil {
				writeStoreError(writer, err)
				return
			}
			writeJSON(writer, http.StatusCreated, session)
		default:
			methodNotAllowed(writer)
		}
		return
	}
	if len(parts) == 2 && parts[1] == "context-usage" && request.Method == http.MethodGet {
		project, err := server.DB.Project(request.Context(), parts[0])
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		if project.MainThreadID == "" || server.ContextUsage == nil {
			writeJSON(writer, http.StatusOK, core.ContextWindowUsage{Available: false})
			return
		}
		usage, available := server.ContextUsage.ContextWindowUsage(request.Context(), project.MainThreadID)
		if !available {
			writeJSON(writer, http.StatusOK, core.ContextWindowUsage{Available: false, ThreadID: project.MainThreadID})
			return
		}
		writeJSON(writer, http.StatusOK, usage)
		return
	}
	if len(parts) != 2 || parts[1] != "runs" {
		http.NotFound(writer, request)
		return
	}
	projectID := parts[0]
	switch request.Method {
	case http.MethodGet:
		runs, err := server.DB.ListRuns(request.Context(), projectID, 100)
		if err != nil {
			writeInternal(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, runs)
	case http.MethodPost:
		if server.Runs == nil {
			writeError(writer, http.StatusServiceUnavailable, "runner_unavailable", "연구 실행기가 준비되지 않았습니다")
			return
		}
		var body struct {
			Query           string `json:"query"`
			Model           string `json:"model"`
			ReasoningEffort string `json:"reasoning_effort"`
			Speed           string `json:"speed"`
			ContextProfile  string `json:"context_profile"`
		}
		if err := decodeJSON(request, &body); err != nil || strings.TrimSpace(body.Query) == "" {
			writeError(writer, http.StatusBadRequest, "invalid_request", "연구 질문을 입력해 주세요")
			return
		}
		if server.Models == nil {
			writeError(writer, http.StatusServiceUnavailable, "model_catalog_unavailable", "모델 설정을 아직 불러오지 못했습니다")
			return
		}
		serviceTier := ""
		switch body.Speed {
		case "standard":
			serviceTier = core.ServiceTierDefault
		case "fast":
			serviceTier = core.ServiceTierFast
		default:
			writeError(writer, http.StatusBadRequest, "invalid_speed", "속도는 기본 또는 빠름 중에서 선택해 주세요")
			return
		}
		configuration := core.RunConfiguration{
			Model: strings.TrimSpace(body.Model), ReasoningEffort: strings.TrimSpace(body.ReasoningEffort),
			ServiceTier: serviceTier, ContextProfile: strings.TrimSpace(body.ContextProfile),
		}
		if err := server.Models.ValidateRunConfiguration(request.Context(), configuration); err != nil {
			writeError(writer, http.StatusBadRequest, "invalid_model_configuration", err.Error())
			return
		}
		if !server.requireCodexLogin(writer, request) {
			return
		}
		run, err := server.Runs.StartRun(request.Context(), projectID, strings.TrimSpace(body.Query), configuration)
		if errors.Is(err, store.ErrConversationSessionCreationUnknown) {
			writeError(writer, http.StatusConflict, "session_thread_uncertain", "이 대화의 Codex 스레드 생성 결과가 불확실합니다. 새 대화를 만들어 계속해 주세요")
			return
		}
		if err != nil {
			writeInternal(writer, err)
			return
		}
		writeJSON(writer, http.StatusAccepted, run)
	default:
		methodNotAllowed(writer)
	}
}

func (server *Server) handleProjectTools(writer http.ResponseWriter, request *http.Request, parts []string) {
	if server.ToolStudio == nil {
		writeError(writer, http.StatusServiceUnavailable, "tool_studio_unavailable", "Tool Studio is unavailable")
		return
	}
	projectID := parts[0]
	if len(parts) == 2 {
		switch request.Method {
		case http.MethodGet:
			packages, err := server.ToolStudio.List(request.Context(), projectID)
			if err != nil {
				writeStoreError(writer, err)
				return
			}
			writeJSON(writer, http.StatusOK, map[string]any{"tools": packages})
		case http.MethodPost:
			var proposal toolstudio.Proposal
			if err := decodeJSONLimited(request, &proposal, 2<<20); err != nil {
				writeError(writer, http.StatusBadRequest, "invalid_tool_package", err.Error())
				return
			}
			pkg, err := server.ToolStudio.Propose(request.Context(), projectID, "", "", proposal)
			if err != nil {
				writeError(writer, http.StatusBadRequest, "invalid_tool_package", err.Error())
				return
			}
			writeJSON(writer, http.StatusCreated, pkg)
		default:
			methodNotAllowed(writer)
		}
		return
	}
	if len(parts) == 4 && request.Method == http.MethodPost {
		var pkg core.ToolPackage
		var err error
		switch parts[3] {
		case "activate":
			pkg, err = server.ToolStudio.Activate(request.Context(), projectID, parts[2])
		case "disable":
			pkg, err = server.ToolStudio.Disable(request.Context(), projectID, parts[2])
		default:
			methodNotAllowed(writer)
			return
		}
		if err != nil {
			writeError(writer, http.StatusConflict, "tool_package_transition_failed", err.Error())
			return
		}
		writeJSON(writer, http.StatusOK, pkg)
		return
	}
	if len(parts) == 3 && request.Method == http.MethodGet {
		pkg, err := server.ToolStudio.Get(request.Context(), projectID, parts[2])
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, pkg)
		return
	}
	methodNotAllowed(writer)
}

func normalizedProjectName(raw string) (string, bool) {
	name := strings.TrimSpace(raw)
	return name, name != "" && utf8.ValidString(name) &&
		!strings.ContainsRune(name, utf8.RuneError) && utf8.RuneCountInString(name) <= 120
}

func (server *Server) requireCodexLogin(writer http.ResponseWriter, request *http.Request) bool {
	if server.CodexAccount == nil {
		return true
	}
	value, err := server.CodexAccount.ReadCodexAccount(request.Context())
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "codex_account_unavailable", "Codex 로그인 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요")
		return false
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "codex_account_unavailable", "Codex 로그인 상태 응답을 확인하지 못했습니다")
		return false
	}
	var status struct {
		Authenticated bool `json:"authenticated"`
		ChatGPT       bool `json:"chatgpt"`
	}
	if err := json.Unmarshal(encoded, &status); err != nil {
		writeError(writer, http.StatusServiceUnavailable, "codex_account_unavailable", "Codex 로그인 상태 응답을 확인하지 못했습니다")
		return false
	}
	if !status.Authenticated || !status.ChatGPT {
		writeError(writer, http.StatusUnauthorized, "codex_login_required", "Codex 로그인이 필요합니다. 설정에서 장치 로그인을 완료해 주세요")
		return false
	}
	return true
}

func (server *Server) handleChat(writer http.ResponseWriter, request *http.Request, targetID string, sessionScoped bool) {
	if server.Chat == nil {
		writeError(writer, http.StatusServiceUnavailable, "chat_unavailable", "Codex 채팅이 준비되지 않았습니다")
		return
	}
	var body struct {
		Message         string        `json:"message"`
		Mode            core.ChatMode `json:"mode"`
		Model           string        `json:"model"`
		ReasoningEffort string        `json:"reasoning_effort"`
		Speed           string        `json:"speed"`
		ContextProfile  string        `json:"context_profile"`
		PlanCycleID     string        `json:"plan_cycle_id"`
		Attachments     []struct {
			Name      string `json:"name"`
			MediaType string `json:"media_type"`
			Data      string `json:"data"`
		} `json:"attachments"`
	}
	if err := decodeJSON(request, &body); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request", "채팅 메시지 형식을 확인해 주세요")
		return
	}
	body.Message = strings.TrimSpace(body.Message)
	if (!validUserFacingText(body.Message, 64*1024) && body.Message != "") || (body.Message == "" && len(body.Attachments) == 0) {
		writeError(writer, http.StatusBadRequest, "invalid_chat_message", "메시지를 1자 이상 64KB 이하로 입력해 주세요")
		return
	}
	attachments, err := validatedChatAttachments(body.Attachments)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_chat_attachment", err.Error())
		return
	}
	if body.Mode == "" {
		body.Mode = core.ChatModeConversation
	}
	if err := body.Mode.Validate(); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_chat_mode", "채팅 모드는 일반 또는 계획만 사용할 수 있습니다")
		return
	}
	body.PlanCycleID = strings.TrimSpace(body.PlanCycleID)
	planSessionID := targetID
	if body.Mode == core.ChatModePlan && !sessionScoped {
		session, err := server.DB.DefaultConversationSession(request.Context(), targetID)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		planSessionID = session.ID
	}
	if body.Mode == core.ChatModePlan {
		if body.PlanCycleID == "" {
			writeError(writer, http.StatusConflict, "plan_cycle_required", "계획 모드를 시작한 뒤 답변을 보내 주세요")
			return
		}
		if _, err := server.DB.RequireActiveConversationPlanCycle(request.Context(), planSessionID, body.PlanCycleID); err != nil {
			writeError(writer, http.StatusConflict, "plan_cycle_not_active", "이 계획은 더 이상 현재 계획이 아닙니다. /plan으로 새 계획을 시작해 주세요")
			return
		}
	} else if body.PlanCycleID != "" {
		writeError(writer, http.StatusBadRequest, "unexpected_plan_cycle", "일반 대화에는 계획 사이클을 지정할 수 없습니다")
		return
	}
	if server.Models == nil {
		writeError(writer, http.StatusServiceUnavailable, "model_catalog_unavailable", "모델 설정을 아직 불러오지 못했습니다")
		return
	}
	serviceTier := core.ServiceTierDefault
	switch body.Speed {
	case "standard":
	case "fast":
		serviceTier = core.ServiceTierFast
	default:
		writeError(writer, http.StatusBadRequest, "invalid_speed", "속도는 기본 또는 빠름 중에서 선택해 주세요")
		return
	}
	configuration := core.RunConfiguration{
		Model: strings.TrimSpace(body.Model), ReasoningEffort: strings.TrimSpace(body.ReasoningEffort), ServiceTier: serviceTier,
		ContextProfile: strings.TrimSpace(body.ContextProfile),
	}
	if err := server.Models.ValidateRunConfiguration(request.Context(), configuration); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_model_configuration", err.Error())
		return
	}
	if !server.requireCodexLogin(writer, request) {
		return
	}
	var reply core.ChatReply
	if sessionScoped {
		reply, err = server.Chat.ChatSession(request.Context(), targetID, body.Message, attachments, body.Mode, body.PlanCycleID, configuration)
	} else {
		reply, err = server.Chat.ChatProject(request.Context(), targetID, body.Message, attachments, body.Mode, body.PlanCycleID, configuration)
	}
	if errors.Is(err, core.ErrProjectResearchActive) {
		writeError(writer, http.StatusConflict, "research_active", "연구가 진행 중입니다. 현재 실행에는 Ctrl+Enter로 지시를 보내세요")
		return
	}
	if errors.Is(err, store.ErrConversationSessionCreationUnknown) {
		writeError(writer, http.StatusConflict, "session_thread_uncertain", "이 대화의 Codex 스레드 생성 결과가 불확실합니다. 새 대화를 만들어 계속해 주세요")
		return
	}
	if err != nil {
		writeInternal(writer, err)
		return
	}
	if body.Mode == core.ChatModePlan {
		reply.PlanCycleID = body.PlanCycleID
		if reply.PlanReady {
			if _, err := server.DB.CompleteConversationPlanCycle(request.Context(), planSessionID, body.PlanCycleID, reply.Text); err != nil {
				writeError(writer, http.StatusConflict, "plan_cycle_completion_conflict", "계획 완료 상태를 저장하지 못했습니다. /plan으로 새 계획을 시작해 주세요")
				return
			}
		}
	}
	writeJSON(writer, http.StatusOK, reply)
}

func validatedChatAttachments(values []struct {
	Name      string `json:"name"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
}) ([]core.ChatAttachment, error) {
	if len(values) > maxChatAttachments {
		return nil, fmt.Errorf("첨부 파일은 한 번에 %d개까지 추가할 수 있습니다", maxChatAttachments)
	}
	attachments := make([]core.ChatAttachment, 0, len(values))
	total := 0
	for _, value := range values {
		name := strings.TrimSpace(value.Name)
		if name == "" || name != filepath.Base(name) || !validUserFacingText(name, 255) {
			return nil, errors.New("첨부 파일 이름이 올바르지 않습니다")
		}
		decoded, err := base64.StdEncoding.DecodeString(value.Data)
		if err != nil || len(decoded) == 0 {
			return nil, fmt.Errorf("%s 파일 데이터를 읽을 수 없습니다", name)
		}
		if len(decoded) > maxChatAttachmentBytes {
			return nil, fmt.Errorf("%s 파일은 10MB를 초과합니다", name)
		}
		total += len(decoded)
		if total > maxChatAttachmentTotal {
			return nil, errors.New("첨부 파일 전체 크기는 20MB를 초과할 수 없습니다")
		}
		mediaType := strings.ToLower(strings.TrimSpace(strings.Split(value.MediaType, ";")[0]))
		ext := strings.ToLower(filepath.Ext(name))
		if imageType, ok := allowedChatImage(mediaType, decoded); ok {
			attachments = append(attachments, core.ChatAttachment{
				Name: name, MediaType: imageType, Kind: "image",
				Content: "data:" + imageType + ";base64," + base64.StdEncoding.EncodeToString(decoded),
			})
			continue
		}
		if documentType, ok := allowedChatDocument(mediaType, ext, decoded); ok {
			attachments = append(attachments, core.ChatAttachment{
				Name: name, MediaType: documentType, Kind: "document",
				Content: base64.StdEncoding.EncodeToString(decoded),
			})
			continue
		}
		if !allowedChatText(mediaType, ext) || !utf8.Valid(decoded) || bytes.IndexByte(decoded, 0) >= 0 || strings.ContainsRune(string(decoded), '\uFFFD') {
			return nil, fmt.Errorf("%s 형식은 지원하지 않습니다. 텍스트·코드·PDF·DOCX·XLSX·PPTX 또는 PNG/JPEG/GIF/WebP 파일을 사용하세요", name)
		}
		attachments = append(attachments, core.ChatAttachment{
			Name: name, MediaType: mediaType, Kind: "text", Content: string(decoded),
		})
	}
	return attachments, nil
}

func allowedChatDocument(mediaType, ext string, data []byte) (string, bool) {
	if ext == ".pdf" {
		return "application/pdf", len(data) >= 5 && string(data[:5]) == "%PDF-" &&
			(mediaType == "application/pdf" || mediaType == "" || mediaType == "application/octet-stream")
	}
	expected := map[string]struct{ mediaType, marker string }{
		".docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document", "word/document.xml"},
		".xlsx": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xl/workbook.xml"},
		".pptx": {"application/vnd.openxmlformats-officedocument.presentationml.presentation", "ppt/presentation.xml"},
	}
	document, ok := expected[ext]
	if !ok || (mediaType != document.mediaType && mediaType != "" && mediaType != "application/octet-stream") {
		return "", false
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", false
	}
	hasContentTypes, hasMarker := false, false
	for _, file := range reader.File {
		hasContentTypes = hasContentTypes || file.Name == "[Content_Types].xml"
		hasMarker = hasMarker || file.Name == document.marker
	}
	return document.mediaType, hasContentTypes && hasMarker
}

func allowedChatImage(mediaType string, data []byte) (string, bool) {
	detected := strings.ToLower(strings.Split(http.DetectContentType(data), ";")[0])
	allowed := map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}
	return detected, allowed[mediaType] && detected == mediaType
}

func allowedChatText(mediaType, ext string) bool {
	if strings.HasPrefix(mediaType, "text/") {
		return true
	}
	if mediaType == "application/json" || mediaType == "application/xml" || mediaType == "application/javascript" {
		return true
	}
	allowedExtensions := map[string]bool{
		".txt": true, ".md": true, ".markdown": true, ".csv": true, ".tsv": true,
		".json": true, ".jsonl": true, ".xml": true, ".yaml": true, ".yml": true,
		".js": true, ".jsx": true, ".ts": true, ".tsx": true, ".css": true, ".html": true,
		".py": true, ".go": true, ".rs": true, ".java": true, ".c": true, ".h": true,
		".cpp": true, ".hpp": true, ".cs": true, ".sql": true, ".sh": true, ".ps1": true,
	}
	return allowedExtensions[ext] && (mediaType == "" || mediaType == "application/octet-stream")
}

func (server *Server) handleSessionPath(writer http.ResponseWriter, request *http.Request) {
	parts := pathParts(strings.TrimPrefix(request.URL.Path, "/api/v1/sessions/"))
	if len(parts) == 1 {
		sessionID := parts[0]
		switch request.Method {
		case http.MethodPatch:
			var body struct {
				Title string `json:"title"`
			}
			if err := decodeJSON(request, &body); err != nil {
				writeError(writer, http.StatusBadRequest, "invalid_request", "대화 이름을 확인해 주세요")
				return
			}
			if !validConversationSessionTitle(body.Title) {
				writeError(writer, http.StatusBadRequest, "invalid_session_title", "대화 이름은 80자 이하여야 하며 손상된 문자를 포함할 수 없습니다")
				return
			}
			session, err := server.DB.RenameConversationSession(request.Context(), sessionID, body.Title)
			if err != nil {
				writeStoreError(writer, err)
				return
			}
			writeJSON(writer, http.StatusOK, session)
		case http.MethodDelete:
			err := server.DB.DeleteConversationSession(request.Context(), sessionID)
			switch {
			case errors.Is(err, store.ErrConversationSessionBusy):
				writeError(writer, http.StatusConflict, "session_research_active", "진행 중이거나 복구가 필요한 연구가 연결된 대화는 삭제할 수 없습니다")
			case errors.Is(err, store.ErrConversationSessionScheduled):
				writeError(writer, http.StatusConflict, "session_schedule_active", "활성 일정이 연결된 대화는 삭제할 수 없습니다")
			case errors.Is(err, store.ErrLastConversationSession):
				writeError(writer, http.StatusConflict, "last_session", "프로젝트에는 대화가 하나 이상 있어야 합니다")
			case err != nil:
				writeStoreError(writer, err)
			default:
				writer.WriteHeader(http.StatusNoContent)
			}
		default:
			methodNotAllowed(writer)
		}
		return
	}
	if len(parts) != 2 {
		http.NotFound(writer, request)
		return
	}
	sessionID := parts[0]
	switch parts[1] {
	case "plan-cycle":
		switch request.Method {
		case http.MethodGet:
			cycle, err := server.DB.LatestConversationPlanCycle(request.Context(), sessionID)
			if errors.Is(err, store.ErrNotFound) {
				writeJSON(writer, http.StatusOK, map[string]any{"plan_cycle": nil})
				return
			}
			if err != nil {
				writeStoreError(writer, err)
				return
			}
			writeJSON(writer, http.StatusOK, map[string]any{"plan_cycle": cycle})
		case http.MethodPost:
			var body struct {
				Objective string `json:"objective"`
			}
			if err := decodeJSON(request, &body); err != nil {
				writeError(writer, http.StatusBadRequest, "invalid_request", "계획 목표를 확인해 주세요")
				return
			}
			body.Objective = strings.TrimSpace(body.Objective)
			if !validUserFacingText(body.Objective, 64*1024) {
				writeError(writer, http.StatusBadRequest, "invalid_plan_objective", "계획 목표는 1자 이상 64KB 이하여야 하며 손상된 문자를 포함할 수 없습니다")
				return
			}
			cycle, err := server.DB.BeginConversationPlanCycle(request.Context(), sessionID, body.Objective)
			if err != nil {
				writeStoreError(writer, err)
				return
			}
			writeJSON(writer, http.StatusCreated, map[string]any{"plan_cycle": cycle})
		default:
			methodNotAllowed(writer)
		}
	case "planned-runs":
		if request.Method != http.MethodPost {
			methodNotAllowed(writer)
			return
		}
		server.handlePlannedSessionRunStart(writer, request, sessionID)
	case "chat":
		switch request.Method {
		case http.MethodPost:
			server.handleChat(writer, request, sessionID, true)
		case http.MethodGet:
			if server.ChatHistory == nil {
				writeError(writer, http.StatusServiceUnavailable, "chat_history_unavailable", "Codex 대화 기록을 불러올 수 없습니다")
				return
			}
			history, err := server.ChatHistory.ChatHistorySession(request.Context(), sessionID)
			if err != nil {
				writeInternal(writer, err)
				return
			}
			writeJSON(writer, http.StatusOK, history)
		default:
			methodNotAllowed(writer)
		}
	case "context-usage":
		if request.Method != http.MethodGet {
			methodNotAllowed(writer)
			return
		}
		session, err := server.DB.ConversationSession(request.Context(), sessionID)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		if session.CodexThreadID == "" || server.ContextUsage == nil {
			writeJSON(writer, http.StatusOK, core.ContextWindowUsage{Available: false})
			return
		}
		usage, available := server.ContextUsage.ContextWindowUsage(request.Context(), session.CodexThreadID)
		if !available {
			writeJSON(writer, http.StatusOK, core.ContextWindowUsage{Available: false, ThreadID: session.CodexThreadID})
			return
		}
		writeJSON(writer, http.StatusOK, usage)
	case "runs":
		switch request.Method {
		case http.MethodGet:
			runs, err := server.DB.ListConversationRuns(request.Context(), sessionID, 100)
			if err != nil {
				writeStoreError(writer, err)
				return
			}
			writeJSON(writer, http.StatusOK, runs)
		case http.MethodPost:
			server.handleSessionRunStart(writer, request, sessionID)
		default:
			methodNotAllowed(writer)
		}
	default:
		http.NotFound(writer, request)
	}
}

func (server *Server) handleSessionRunStart(writer http.ResponseWriter, request *http.Request, sessionID string) {
	if server.Runs == nil {
		writeError(writer, http.StatusServiceUnavailable, "runner_unavailable", "연구 실행기가 준비되지 않았습니다")
		return
	}
	var body struct {
		Query           string `json:"query"`
		Model           string `json:"model"`
		ReasoningEffort string `json:"reasoning_effort"`
		Speed           string `json:"speed"`
		ContextProfile  string `json:"context_profile"`
	}
	if err := decodeJSON(request, &body); err != nil || strings.TrimSpace(body.Query) == "" {
		writeError(writer, http.StatusBadRequest, "invalid_request", "연구 질문을 입력해 주세요")
		return
	}
	if server.Models == nil {
		writeError(writer, http.StatusServiceUnavailable, "model_catalog_unavailable", "모델 설정을 아직 불러오지 못했습니다")
		return
	}
	serviceTier := core.ServiceTierDefault
	switch body.Speed {
	case "standard":
	case "fast":
		serviceTier = core.ServiceTierFast
	default:
		writeError(writer, http.StatusBadRequest, "invalid_speed", "속도는 기본 또는 빠름 중에서 선택해 주세요")
		return
	}
	configuration := core.RunConfiguration{
		Model: strings.TrimSpace(body.Model), ReasoningEffort: strings.TrimSpace(body.ReasoningEffort),
		ServiceTier: serviceTier, ContextProfile: strings.TrimSpace(body.ContextProfile),
	}
	if err := server.Models.ValidateRunConfiguration(request.Context(), configuration); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_model_configuration", err.Error())
		return
	}
	if !server.requireCodexLogin(writer, request) {
		return
	}
	run, err := server.Runs.StartSessionRun(request.Context(), sessionID, strings.TrimSpace(body.Query), configuration)
	if errors.Is(err, store.ErrConversationSessionCreationUnknown) {
		writeError(writer, http.StatusConflict, "session_thread_uncertain", "이 대화의 Codex 스레드 생성 결과가 불확실합니다. 새 대화를 만들어 계속해 주세요")
		return
	}
	if err != nil {
		writeInternal(writer, err)
		return
	}
	writeJSON(writer, http.StatusAccepted, run)
}

func (server *Server) handlePlannedSessionRunStart(writer http.ResponseWriter, request *http.Request, sessionID string) {
	if server.Runs == nil {
		writeError(writer, http.StatusServiceUnavailable, "runner_unavailable", "연구 실행기가 준비되지 않았습니다")
		return
	}
	var body struct {
		PlanCycleID     string `json:"plan_cycle_id"`
		Model           string `json:"model"`
		ReasoningEffort string `json:"reasoning_effort"`
		Speed           string `json:"speed"`
		ContextProfile  string `json:"context_profile"`
	}
	if err := decodeJSON(request, &body); err != nil || strings.TrimSpace(body.PlanCycleID) == "" {
		writeError(writer, http.StatusBadRequest, "invalid_request", "완료된 계획을 선택해 주세요")
		return
	}
	if server.Models == nil {
		writeError(writer, http.StatusServiceUnavailable, "model_catalog_unavailable", "모델 설정을 아직 불러오지 못했습니다")
		return
	}
	serviceTier := core.ServiceTierDefault
	switch body.Speed {
	case "standard":
	case "fast":
		serviceTier = core.ServiceTierFast
	default:
		writeError(writer, http.StatusBadRequest, "invalid_speed", "속도는 기본 또는 빠름 중에서 선택해 주세요")
		return
	}
	configuration := core.RunConfiguration{
		Model: strings.TrimSpace(body.Model), ReasoningEffort: strings.TrimSpace(body.ReasoningEffort),
		ServiceTier: serviceTier, ContextProfile: strings.TrimSpace(body.ContextProfile),
	}
	if err := server.Models.ValidateRunConfiguration(request.Context(), configuration); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_model_configuration", err.Error())
		return
	}
	if !server.requireCodexLogin(writer, request) {
		return
	}
	run, err := server.Runs.StartPlannedSessionRun(request.Context(), sessionID, strings.TrimSpace(body.PlanCycleID), configuration)
	switch {
	case errors.Is(err, store.ErrPlanCycleNotReady), errors.Is(err, store.ErrPlanCycleSuperseded):
		writeError(writer, http.StatusConflict, "plan_cycle_not_ready", "최신 계획이 완료되지 않았거나 이미 연구에 사용되었습니다")
		return
	case errors.Is(err, store.ErrConversationSessionCreationUnknown):
		writeError(writer, http.StatusConflict, "session_thread_uncertain", "이 대화의 Codex 스레드 생성 결과가 불확실합니다. 새 대화를 만들어 계속해 주세요")
		return
	case err != nil:
		writeInternal(writer, err)
		return
	}
	writeJSON(writer, http.StatusAccepted, map[string]any{"run": run, "plan_cycle_id": body.PlanCycleID})
}

func (server *Server) handleRunPath(writer http.ResponseWriter, request *http.Request) {
	parts := pathParts(strings.TrimPrefix(request.URL.Path, "/api/v1/runs/"))
	if len(parts) == 0 {
		http.NotFound(writer, request)
		return
	}
	runID := parts[0]
	if len(parts) == 1 && request.Method == http.MethodGet {
		run, err := server.DB.Run(request.Context(), runID)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, run)
		return
	}
	if len(parts) == 2 && parts[1] == "artifacts" && request.Method == http.MethodGet {
		artifacts, err := server.DB.ListArtifacts(request.Context(), runID)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, artifacts)
		return
	}
	if len(parts) == 2 && parts[1] == "blocker" && request.Method == http.MethodGet {
		blocking, err := server.DB.EarlierUnresolvedRun(request.Context(), runID)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"blocking_run": blocking})
		return
	}
	if len(parts) != 2 || request.Method != http.MethodPost || server.Runs == nil {
		methodNotAllowed(writer)
		return
	}
	var run core.Run
	var err error
	switch parts[1] {
	case "steer":
		var body struct {
			Message string `json:"message"`
		}
		if decodeErr := decodeJSON(request, &body); decodeErr != nil {
			writeError(writer, http.StatusBadRequest, "invalid_request", "스티어링 메시지 형식을 확인해 주세요")
			return
		}
		body.Message = strings.TrimSpace(body.Message)
		if !validUserFacingText(body.Message, 64*1024) {
			writeError(writer, http.StatusBadRequest, "invalid_steering_message", "스티어링 메시지를 1자 이상 64KB 이하로 입력해 주세요")
			return
		}
		run, err = server.Runs.SteerRun(request.Context(), runID, body.Message)
		if err != nil {
			writeError(writer, http.StatusConflict, "steer_unavailable", "현재 진행 중인 Codex 턴에 메시지를 보낼 수 없습니다")
			return
		}
		writeJSON(writer, http.StatusAccepted, run)
		return
	case "cancel":
		run, err = server.Runs.CancelRun(request.Context(), runID)
	case "resume":
		run, err = server.Runs.ResumeRun(request.Context(), runID)
	case "discard":
		run, err = server.Runs.DiscardRun(request.Context(), runID)
	default:
		http.NotFound(writer, request)
		return
	}
	if err != nil {
		writeInternal(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, run)
}

func (server *Server) handleArtifact(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(writer)
		return
	}
	artifactID := strings.TrimPrefix(request.URL.Path, "/api/v1/artifacts/")
	artifact, err := server.DB.Artifact(request.Context(), artifactID)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	metadata, err := server.DB.BlobMetadata(request.Context(), artifact.BlobHash)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	path, err := server.CAS.Path(artifact.BlobHash)
	if err != nil {
		writeInternal(writer, err)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeInternal(writer, err)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != metadata.Size {
		writeInternal(writer, errors.New("artifact size does not match verified metadata"))
		return
	}
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil || hex.EncodeToString(hasher.Sum(nil)) != artifact.BlobHash {
		writeInternal(writer, errors.New("CAS readback hash mismatch"))
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		writeInternal(writer, err)
		return
	}
	mediaType := safeMediaType(metadata.MediaType)
	filename := artifactDownloadName(artifact, mediaType)
	writer.Header().Set("Content-Type", mediaType)
	writer.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-SHA256", artifact.BlobHash)
	http.ServeContent(writer, request, filename, metadata.CreatedAt, file)
}

func safeMediaType(value string) string {
	mediaType, parameters, err := mime.ParseMediaType(strings.TrimSpace(value))
	if err != nil || mediaType == "" {
		return "application/octet-stream"
	}
	if _, present := parameters["charset"]; !present &&
		(mediaType == "application/json" || strings.HasPrefix(mediaType, "text/")) {
		parameters["charset"] = "utf-8"
	}
	return mime.FormatMediaType(mediaType, parameters)
}

func artifactDownloadName(artifact store.Artifact, mediaType string) string {
	if parsed, _, err := mime.ParseMediaType(mediaType); err == nil && parsed != "" {
		mediaType = parsed
	}
	kind := strings.Trim(strings.Map(func(character rune) rune {
		switch {
		case character >= 'a' && character <= 'z':
			return character
		case character >= 'A' && character <= 'Z':
			return character
		case character >= '0' && character <= '9':
			return character
		case character == '.', character == '-', character == '_':
			return character
		default:
			return '-'
		}
	}, artifact.Kind), ".-_")
	if kind == "" {
		kind = "artifact"
	}
	name := artifact.ID + "-" + kind
	lower := strings.ToLower(name)
	for _, extension := range []string{".vsp3", ".msh", ".su2", ".restart", ".docx", ".json", ".csv", ".txt", ".md"} {
		if strings.HasSuffix(lower, extension) {
			return name
		}
	}
	switch mediaType {
	case "application/json":
		return name + ".json"
	case "text/csv":
		return name + ".csv"
	case "text/markdown":
		return name + ".md"
	case "text/plain":
		return name + ".txt"
	case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		return name + ".docx"
	default:
		return name + ".bin"
	}
}

func (server *Server) handleEvents(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(writer)
		return
	}
	after, _ := strconv.ParseInt(request.URL.Query().Get("after"), 10, 64)
	flusher, ok := writer.(http.Flusher)
	if !ok {
		writeError(writer, http.StatusInternalServerError, "stream_unavailable", "SSE streaming is unavailable")
		return
	}
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-cache, no-transform")
	writer.Header().Set("X-Accel-Buffering", "no")
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		events, err := server.DB.EventsAfter(request.Context(), after, 200)
		if err != nil {
			return
		}
		for _, event := range events {
			encoded, err := json.Marshal(event)
			if err != nil {
				return
			}
			_, _ = fmt.Fprintf(writer, "id: %d\nevent: run_event\ndata: %s\n\n", event.Sequence, encoded)
			after = event.Sequence
		}
		if len(events) > 0 {
			flusher.Flush()
		}
		select {
		case <-request.Context().Done():
			return
		case <-ticker.C:
			_, _ = io.WriteString(writer, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

func (server *Server) handleApprovals(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(writer)
		return
	}
	approvals, err := server.DB.ListPendingApprovals(request.Context())
	if err != nil {
		writeInternal(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, approvals)
}

func (server *Server) handleApprovalPath(writer http.ResponseWriter, request *http.Request) {
	parts := pathParts(strings.TrimPrefix(request.URL.Path, "/api/v1/approvals/"))
	if request.Method != http.MethodPost || len(parts) != 2 || parts[1] != "decision" {
		methodNotAllowed(writer)
		return
	}
	var body struct {
		Decision string `json:"decision"`
	}
	if err := decodeJSON(request, &body); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request", "승인 결정을 확인할 수 없습니다")
		return
	}
	if server.ApprovalDecider == nil {
		writeError(writer, http.StatusServiceUnavailable, "approval_unavailable", "승인 처리기가 준비되지 않았습니다")
		return
	}
	approval, err := server.ApprovalDecider.Decide(request.Context(), parts[0], body.Decision)
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, approval)
}

func (server *Server) handleSchedules(writer http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		schedules, err := server.DB.ListSchedules(request.Context(), request.URL.Query().Get("project_id"))
		if err != nil {
			writeInternal(writer, err)
			return
		}
		if schedules == nil {
			schedules = []core.Schedule{}
		}
		writeJSON(writer, http.StatusOK, schedules)
	case http.MethodPost:
		if server.Scheduler == nil {
			writeError(writer, http.StatusServiceUnavailable, "scheduler_unavailable", "일정 실행기가 준비되지 않았습니다")
			return
		}
		var body struct {
			ProjectID             string `json:"project_id"`
			ConversationSessionID string `json:"conversation_session_id"`
			Question              string `json:"question"`
			Kind                  string `json:"kind"`
			Expression            string `json:"expression"`
			Timezone              string `json:"timezone"`
		}
		if err := decodeJSON(request, &body); err != nil {
			writeError(writer, http.StatusBadRequest, "invalid_request", "일정 정보를 확인할 수 없습니다")
			return
		}
		var session core.ConversationSession
		var err error
		if body.ConversationSessionID == "" {
			session, err = server.DB.DefaultConversationSession(request.Context(), body.ProjectID)
		} else {
			session, err = server.DB.ConversationSession(request.Context(), body.ConversationSessionID)
		}
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		if session.ProjectID != body.ProjectID {
			writeError(writer, http.StatusBadRequest, "session_project_mismatch", "선택한 대화가 이 프로젝트에 속하지 않습니다")
			return
		}
		if session.CodexThreadID == "" {
			writeError(writer, http.StatusConflict, "main_thread_required", "이 대화에서 채팅이나 연구를 한 번 시작한 뒤 일정을 만들 수 있습니다")
			return
		}
		created, err := server.Scheduler.Create(request.Context(), core.Schedule{
			ProjectID: body.ProjectID, ConversationSessionID: session.ID,
			Question: strings.TrimSpace(body.Question),
			Kind:     body.Kind, Expression: body.Expression, Timezone: body.Timezone,
			MainThreadID: session.CodexThreadID,
		})
		if err != nil {
			writeError(writer, http.StatusBadRequest, "invalid_schedule", err.Error())
			return
		}
		writeJSON(writer, http.StatusCreated, created)
	default:
		methodNotAllowed(writer)
	}
}

func (server *Server) handleSchedulePath(writer http.ResponseWriter, request *http.Request) {
	parts := pathParts(strings.TrimPrefix(request.URL.Path, "/api/v1/schedules/"))
	if len(parts) == 1 && request.Method == http.MethodDelete {
		if err := server.DB.DeleteSchedule(request.Context(), parts[0]); err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]bool{"deleted": true})
		return
	}
	if len(parts) == 2 && parts[1] == "enabled" && request.Method == http.MethodPost {
		var body struct {
			Enabled bool `json:"enabled"`
		}
		if err := decodeJSON(request, &body); err != nil {
			writeError(writer, http.StatusBadRequest, "invalid_request", "일정 상태를 확인할 수 없습니다")
			return
		}
		schedule, err := server.DB.SetScheduleEnabled(request.Context(), parts[0], body.Enabled)
		if err != nil {
			writeStoreError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, schedule)
		return
	}
	methodNotAllowed(writer)
}

func (server *Server) handleBrowserStatus(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet || server.Browser == nil {
		methodNotAllowed(writer)
		return
	}
	status, err := server.Browser.Status(request.Context())
	if err != nil {
		writeInternal(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, status)
}

func (server *Server) handleEmergencyStop(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || server.Browser == nil {
		methodNotAllowed(writer)
		return
	}
	if err := server.Browser.EmergencyStop(request.Context()); err != nil {
		writeInternal(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]bool{"stopped": true})
}

func (server *Server) handleBrowserMode(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || server.Browser == nil {
		methodNotAllowed(writer)
		return
	}
	var body struct {
		Mode string `json:"mode"`
	}
	if err := decodeJSON(request, &body); err != nil || (body.Mode != "automatic" && body.Mode != "manual") {
		writeError(writer, http.StatusBadRequest, "invalid_request", "브라우저 모드는 automatic 또는 manual이어야 합니다")
		return
	}
	if err := server.Browser.SetMode(request.Context(), body.Mode); err != nil {
		writeInternal(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"mode": body.Mode})
}

func (server *Server) handleBrowserProfileReset(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || server.Browser == nil {
		methodNotAllowed(writer)
		return
	}
	var body struct {
		Confirmation string `json:"confirmation"`
	}
	if err := decodeJSON(request, &body); err != nil || body.Confirmation != "RESET INTERNET PROFILE" {
		writeError(writer, http.StatusBadRequest, "invalid_profile_reset_confirmation", "type RESET INTERNET PROFILE to confirm")
		return
	}
	result, err := server.Browser.ResetProfile(request.Context())
	if err != nil {
		writeInternal(writer, err)
		return
	}
	writeJSON(writer, http.StatusAccepted, result)
}

func (server *Server) handleSettings(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(writer)
		return
	}
	configured := false
	if server.Credentials != nil {
		if key, err := server.Credentials.OpenAIAPIKey(); err == nil && len(key) > 0 {
			configured = true
			for index := range key {
				key[index] = 0
			}
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"openai_api_key_configured": configured})
}

func (server *Server) handleOpenAIKey(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || server.Credentials == nil {
		methodNotAllowed(writer)
		return
	}
	var body struct {
		APIKey string `json:"api_key"`
	}
	if err := decodeJSON(request, &body); err != nil || strings.TrimSpace(body.APIKey) == "" {
		writeError(writer, http.StatusBadRequest, "invalid_request", "OpenAI API 키를 입력해 주세요")
		return
	}
	secret := []byte(strings.TrimSpace(body.APIKey))
	err := server.Credentials.SetOpenAIAPIKey(secret)
	for index := range secret {
		secret[index] = 0
	}
	body.APIKey = ""
	if err != nil {
		writeInternal(writer, err)
		return
	}
	if server.OpenAIKeyStored != nil {
		server.OpenAIKeyStored()
	}
	writeJSON(writer, http.StatusOK, map[string]bool{"configured": true})
}

func (server *Server) handleDeviceLogin(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		methodNotAllowed(writer)
		return
	}
	if server.Login == nil {
		writeError(writer, http.StatusServiceUnavailable, "runtime_unavailable", "Codex 관리 런타임이 준비되지 않았습니다")
		return
	}
	result, err := server.Login.StartDeviceLogin(request.Context())
	if err != nil {
		writeInternal(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, result)
}

func (server *Server) handleCodexAccountStatus(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(writer)
		return
	}
	if server.CodexAccount == nil {
		writeError(writer, http.StatusServiceUnavailable, "codex_account_unavailable", "Codex account status is unavailable")
		return
	}
	status, err := server.CodexAccount.ReadCodexAccount(request.Context())
	if err != nil {
		writeInternal(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, status)
}

func (server *Server) handleOpenCodexLogin(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		methodNotAllowed(writer)
		return
	}
	if server.OpenExternalURL == nil {
		writeError(writer, http.StatusServiceUnavailable, "external_browser_unavailable", "기본 브라우저를 열 수 없습니다")
		return
	}
	var body struct {
		URL string `json:"url"`
	}
	if err := decodeJSON(request, &body); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request", "로그인 주소를 확인할 수 없습니다")
		return
	}
	loginURL, err := validateCodexLoginURL(body.URL)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_login_url", err.Error())
		return
	}
	if err := server.OpenExternalURL(loginURL); err != nil {
		writeInternal(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]bool{"opened": true})
}

func validateCodexLoginURL(rawURL string) (string, error) {
	if len(rawURL) == 0 || len(rawURL) > 2048 {
		return "", errors.New("Codex 로그인 주소가 올바르지 않습니다")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" ||
		!strings.EqualFold(strings.TrimSuffix(parsed.Hostname(), "."), "auth.openai.com") {
		return "", errors.New("OpenAI 공식 로그인 주소만 열 수 있습니다")
	}
	return parsed.String(), nil
}

func pathParts(path string) []string {
	items := strings.Split(strings.Trim(path, "/"), "/")
	if len(items) == 1 && items[0] == "" {
		return nil
	}
	return items
}

func decodeJSON(request *http.Request, target any) error {
	return decodeJSONLimited(request, target, maxRequestBytes)
}

func decodeJSONLimited(request *http.Request, target any, maxBytes int64) error {
	defer request.Body.Close()
	if maxBytes <= 0 {
		return errors.New("request body size limit must be positive")
	}
	encoded, err := io.ReadAll(io.LimitReader(request.Body, maxBytes+1))
	if err != nil {
		return fmt.Errorf("read request body: %w", err)
	}
	if int64(len(encoded)) > maxBytes {
		return errors.New("request body exceeds size limit")
	}
	if !utf8.Valid(encoded) {
		return errors.New("request body is not valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("request body must contain one JSON value")
	}
	return nil
}

func validUserFacingText(value string, maxBytes int) bool {
	return value != "" && len(value) <= maxBytes && utf8.ValidString(value) &&
		!strings.ContainsRune(value, utf8.RuneError)
}

func validConversationSessionTitle(value string) bool {
	value = strings.TrimSpace(value)
	return value == "" || (validUserFacingText(value, 80*utf8.UTFMax) && utf8.RuneCountInString(value) <= 80)
}

func randomToken() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, code, message string) {
	writeJSON(writer, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func writeInternal(writer http.ResponseWriter, _ error) {
	writeError(writer, http.StatusInternalServerError, "internal_error", "요청을 처리하지 못했습니다")
}

func writeStoreError(writer http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(writer, http.StatusNotFound, "not_found", "요청한 항목을 찾지 못했습니다")
		return
	}
	writeInternal(writer, err)
}

func methodNotAllowed(writer http.ResponseWriter) {
	writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "지원하지 않는 요청 방식입니다")
}
