// Package codex implements the stable stdio JSONL subset of Codex App Server
// used by AetherOps. It deliberately does not opt into experimental APIs.
package codex

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	SolModel    = "gpt-5.6-sol"
	SolEffort   = "xhigh"
	TerraModel  = "gpt-5.6-terra"
	TerraEffort = "high"
)

var (
	// ErrClosed is returned when a request is attempted after Close.
	ErrClosed = errors.New("codex app-server client is closed")
	// ErrProcessExited is returned to outstanding and future requests when the
	// app-server exits. The client never restarts the process or retransmits a
	// request after this error.
	ErrProcessExited = errors.New("codex app-server process exited")
	// ErrNotServerRequest is returned when a caller tries to respond to a
	// notification rather than a server-initiated request.
	ErrNotServerRequest = errors.New("codex event is not a server request")
	// ErrNotApprovalRequest is returned when RespondApproval is given a server
	// request that is not an approval request.
	ErrNotApprovalRequest = errors.New("codex event is not an approval request")
)

// RequiredModel is a model and reasoning-effort combination AetherOps needs.
type RequiredModel struct {
	Model  string
	Effort string
}

// RequiredModels is the exact catalog contract. AetherOps does not select a
// substitute model or effort when one of these entries is unavailable.
var RequiredModels = []RequiredModel{
	{Model: SolModel, Effort: SolEffort},
	{Model: TerraModel, Effort: TerraEffort},
}

// Config controls the local Codex App Server child process. With an empty
// Command and Args, Start launches "codex app-server".
type Config struct {
	Command    string
	Args       []string
	Dir        string
	Env        []string
	ClientInfo ClientInfo
	AfterStart func(processID int) error
}

// ClientInfo identifies this integration in Codex App Server initialization.
type ClientInfo struct {
	Name    string `json:"name"`
	Title   string `json:"title"`
	Version string `json:"version"`
}

// Model is one entry returned by model/list.
type Model struct {
	ID                        string
	Model                     string
	DisplayName               string
	Hidden                    bool
	DefaultReasoningEffort    string
	SupportedReasoningEfforts []ReasoningEffort
	AdditionalSpeedTiers      []string
	ServiceTiers              []ModelServiceTier
	DefaultServiceTier        string
}

// ModelServiceTier is one model-advertised service tier from model/list.
type ModelServiceTier struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// ReasoningEffort describes an effort selectable for a model.
type ReasoningEffort struct {
	ReasoningEffort string
	Description     string
}

// SupportsEffort reports whether the catalog explicitly lists effort for m.
func (m Model) SupportsEffort(effort string) bool {
	for _, supported := range m.SupportedReasoningEfforts {
		if supported.ReasoningEffort == effort {
			return true
		}
	}
	return false
}

// SupportsFast reports catalog-advertised Fast availability. Newer catalogs
// expose the logical "fast" speed and the underlying "priority" tier; either
// explicit signal is accepted, but absence is treated as unsupported.
func (m Model) SupportsFast() bool {
	for _, speed := range m.AdditionalSpeedTiers {
		if speed == "fast" {
			return true
		}
	}
	for _, tier := range m.ServiceTiers {
		if tier.ID == "fast" || tier.ID == "priority" {
			return true
		}
	}
	return false
}

func (m Model) identifier() string {
	return m.ID
}

// ThreadOptions configures thread/start. Model is sent to App Server; Effort,
// Prompt, and OutputSchema are retained as defaults for Turn so orchestration
// code can keep all stage settings in one value. App Server accepts effort and
// output schemas on turn/start, not thread/start.
type ThreadOptions struct {
	Model        string
	Effort       string
	Prompt       string
	OutputSchema json.RawMessage

	CWD            string
	ApprovalPolicy string
	Sandbox        string
	Personality    string
	ServiceName    string
	Config         map[string]any
}

// TurnOptions configures turn/start. Prompt becomes one stable text input.
// OutputSchema is copied directly to App Server when present.
type TurnOptions struct {
	Model        string
	Effort       string
	ServiceTier  string
	Prompt       string
	OutputSchema json.RawMessage

	CWD            string
	ApprovalPolicy string
	SandboxPolicy  json.RawMessage
	Summary        string
	Personality    string
}

// TurnResult is returned after App Server emits turn/completed. Text contains
// the latest explicit final_answer item. A steering message can arrive in the
// narrow interval after an earlier final answer but before turn/completed; in
// that case the later final answer supersedes the earlier one. When a legacy
// provider emits no phases, Text falls back to its unphased messages.
// AgentMessages preserves every completed assistant message, including
// commentary and superseded finals, for display and audit consumers.
type TurnResult struct {
	ThreadID      string
	TurnID        string
	Text          string
	AgentMessages []string
	Status        string
	Error         json.RawMessage
}

// ThreadHistory is the narrow, display-only subset of thread/read used to
// rebuild the chat surface after an application restart. The App Server stays
// authoritative for conversation content; AetherOps does not copy it into its
// own database.
type ThreadHistory struct {
	ThreadID string
	Turns    []ThreadHistoryTurn
}

type ThreadHistoryTurn struct {
	ID          string
	Status      string
	StartedAt   *int64
	CompletedAt *int64
	Items       []ThreadHistoryItem
}

type ThreadHistoryItem struct {
	ID      string
	Type    string
	Text    string
	Phase   string
	Content []ThreadHistoryContent
}

type ThreadHistoryContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// TokenUsageBreakdown is the stable camelCase payload emitted by Codex App
// Server for one token-usage scope.
type TokenUsageBreakdown struct {
	TotalTokens           int64 `json:"totalTokens"`
	InputTokens           int64 `json:"inputTokens"`
	CachedInputTokens     int64 `json:"cachedInputTokens"`
	CacheWriteInputTokens int64 `json:"cacheWriteInputTokens"`
	OutputTokens          int64 `json:"outputTokens"`
	ReasoningOutputTokens int64 `json:"reasoningOutputTokens"`
}

// ThreadTokenUsage is the stable thread/tokenUsage/updated notification
// retained for one Codex thread. Last is the active context measurement;
// Total is cumulative usage and must not be used as context-window pressure.
type ThreadTokenUsage struct {
	ThreadID           string              `json:"threadId"`
	TurnID             string              `json:"turnId"`
	Total              TokenUsageBreakdown `json:"-"`
	Last               TokenUsageBreakdown `json:"-"`
	ModelContextWindow *int64              `json:"-"`
	UpdatedAt          time.Time           `json:"-"`
}

// Event is a notification or server-initiated request emitted by App Server.
// RequestID is set only for server requests. Params is the untouched protocol
// payload so callers can render approval requests without losing fields.
type Event struct {
	Method    string
	Params    json.RawMessage
	RequestID json.RawMessage
}

// IsServerRequest reports whether this event has an id which must be answered.
func (e Event) IsServerRequest() bool {
	return len(e.RequestID) != 0 && string(e.RequestID) != "null"
}

// IsApprovalRequest reports whether the event is an App Server approval flow.
func (e Event) IsApprovalRequest() bool {
	return e.IsServerRequest() && (strings.HasSuffix(e.Method, "/requestApproval") ||
		e.Method == mcpServerElicitationRequestMethod)
}

// DeviceCodeLogin is the user-facing information returned by the stable
// account/login/start chatgptDeviceCode flow.
type DeviceCodeLogin struct {
	LoginID         string
	VerificationURL string
	UserCode        string
}

// AccountStatus is the non-secret subset of the stable account/read result
// used by AetherOps. The product requires ChatGPT OAuth for Codex execution;
// API-key and externally managed token modes are never treated as equivalent.
type AccountStatus struct {
	Authenticated      bool   `json:"authenticated"`
	ChatGPT            bool   `json:"chatgpt"`
	AccountType        string `json:"account_type,omitempty"`
	PlanType           string `json:"plan_type,omitempty"`
	RequiresOpenAIAuth bool   `json:"requires_openai_auth"`
}

// RPCError is an App Server JSON-RPC error response.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("codex app-server rpc error %d: %s", e.Code, e.Message)
}

// TurnError means App Server completed a turn with a non-completed status.
// Result remains available to callers together with this error.
type TurnError struct {
	Result TurnResult
}

func (e *TurnError) Error() string {
	if len(e.Result.Error) != 0 && string(e.Result.Error) != "null" {
		return fmt.Sprintf("codex turn %s %s: %s", e.Result.TurnID, e.Result.Status, string(e.Result.Error))
	}
	return fmt.Sprintf("codex turn %s %s", e.Result.TurnID, e.Result.Status)
}

func validateTurnOptions(options TurnOptions) error {
	if strings.TrimSpace(options.Prompt) == "" {
		return errors.New("codex turn prompt is required")
	}
	if len(options.OutputSchema) != 0 && !json.Valid(options.OutputSchema) {
		return errors.New("codex turn output schema is not valid JSON")
	}
	if len(options.SandboxPolicy) != 0 && !json.Valid(options.SandboxPolicy) {
		return errors.New("codex turn sandbox policy is not valid JSON")
	}
	return nil
}
