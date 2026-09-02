package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/djkim0320/AetherOps/internal/processutil"
)

// thread/read returns one JSONL response containing the requested display
// history. Keep a bounded but deliberately larger ceiling than ordinary RPCs;
// exceeding it is a visible protocol failure, never an empty-history fallback.
const maxJSONLMessageSize = 64 * 1024 * 1024

var ErrNoActiveTurn = errors.New("Codex thread has no active turn")

type wireMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`
}

type rpcResponse struct {
	result json.RawMessage
	err    error
}

type turnState struct {
	turn           TurnResult
	finalMessages  []string
	legacyMessages []string
	completed      bool
	done           chan struct{}
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

// Client owns exactly one Codex App Server child process and exactly one
// goroutine reads that process's stdout. It is safe for concurrent use.
type Client struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr lockedBuffer

	writeMu sync.Mutex
	stateMu sync.Mutex
	pending map[uint64]chan rpcResponse
	nextID  atomic.Uint64

	modelsMu sync.RWMutex
	models   []Model

	defaultsMu sync.RWMutex
	defaults   map[string]TurnOptions

	turnsMu sync.Mutex
	turns   map[string]*turnState

	usageMu sync.RWMutex
	usage   map[string]ThreadTokenUsage

	mcpElicitations mcpElicitationState

	eventInput chan Event
	events     chan Event
	done       chan struct{}
	finishOnce sync.Once
	closeOnce  sync.Once
	closing    atomic.Bool

	terminalErr error
	waitErr     error
}

// Start launches a local Codex App Server, performs initialize followed by the
// initialized notification, then validates the required model catalog. It
// never sends capabilities.experimentalApi or uses experimental methods.
func Start(ctx context.Context, config Config) (*Client, error) {
	command, args := processCommand(config)
	cmd := exec.Command(command, args...)
	processutil.ConfigureNoWindow(cmd)
	cmd.Dir = config.Dir
	if len(config.Env) != 0 {
		cmd.Env = mergeEnvironment(os.Environ(), config.Env)
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("create codex app-server stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("create codex app-server stdout: %w", err)
	}
	client := &Client{
		cmd:        cmd,
		stdin:      stdin,
		stdout:     stdout,
		pending:    make(map[uint64]chan rpcResponse),
		defaults:   make(map[string]TurnOptions),
		turns:      make(map[string]*turnState),
		usage:      make(map[string]ThreadTokenUsage),
		eventInput: make(chan Event, 32),
		events:     make(chan Event, 32),
		done:       make(chan struct{}),
	}
	cmd.Stderr = &client.stderr

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start codex app-server: %w", err)
	}
	if config.AfterStart != nil {
		if err := config.AfterStart(cmd.Process.Pid); err != nil {
			_ = cmd.Process.Kill()
			_, _ = cmd.Process.Wait()
			return nil, fmt.Errorf("supervise codex app-server: %w", err)
		}
	}
	go client.eventLoop()
	go client.readLoop()

	if err := client.initialize(ctx, config.ClientInfo); err != nil {
		client.closeAfterStartFailure()
		return nil, err
	}
	if err := client.EnsureRequiredModels(ctx); err != nil {
		client.closeAfterStartFailure()
		return nil, err
	}
	return client, nil
}

func mergeEnvironment(base, overrides []string) []string {
	keys := make(map[string]struct{}, len(overrides))
	for _, entry := range overrides {
		key, _, found := strings.Cut(entry, "=")
		if found {
			keys[strings.ToUpper(key)] = struct{}{}
		}
	}
	merged := make([]string, 0, len(base)+len(overrides))
	for _, entry := range base {
		key, _, found := strings.Cut(entry, "=")
		if found {
			if _, replaced := keys[strings.ToUpper(key)]; replaced {
				continue
			}
		}
		merged = append(merged, entry)
	}
	return append(merged, overrides...)
}

func processCommand(config Config) (string, []string) {
	if config.Command != "" {
		return config.Command, slices.Clone(config.Args)
	}
	if len(config.Args) != 0 {
		return "codex", slices.Clone(config.Args)
	}
	return "codex", []string{"app-server"}
}

func (c *Client) closeAfterStartFailure() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = c.Close(ctx)
}

func (c *Client) initialize(ctx context.Context, info ClientInfo) error {
	if info.Name == "" {
		info.Name = "aetherops"
	}
	if info.Title == "" {
		info.Title = "AetherOps"
	}
	if info.Version == "" {
		info.Version = "v2"
	}
	params := struct {
		ClientInfo ClientInfo `json:"clientInfo"`
	}{ClientInfo: info}
	if _, err := c.call(ctx, "initialize", params); err != nil {
		return fmt.Errorf("initialize codex app-server: %w", err)
	}
	if err := c.notify("initialized", struct{}{}); err != nil {
		return fmt.Errorf("send initialized notification: %w", err)
	}
	return nil
}

// EnsureRequiredModels reads model/list and requires the exact AetherOps
// combinations gpt-5.6-sol/xhigh and gpt-5.6-terra/high. It never chooses a
// replacement model or a weaker effort.
func (c *Client) EnsureRequiredModels(ctx context.Context) error {
	models, err := c.listModels(ctx)
	if err != nil {
		return err
	}
	for _, required := range RequiredModels {
		var candidate *Model
		for i := range models {
			if !models[i].Hidden && models[i].identifier() == required.Model {
				candidate = &models[i]
				break
			}
		}
		if candidate == nil {
			return fmt.Errorf("required Codex model %q is unavailable", required.Model)
		}
		if !candidate.SupportsEffort(required.Effort) {
			return fmt.Errorf("required Codex model %q does not support reasoning effort %q", required.Model, required.Effort)
		}
	}
	c.modelsMu.Lock()
	c.models = cloneModels(models)
	c.modelsMu.Unlock()
	return nil
}

// Models returns the most recently validated model catalog.
func (c *Client) Models() []Model {
	c.modelsMu.RLock()
	defer c.modelsMu.RUnlock()
	return cloneModels(c.models)
}

func cloneModels(models []Model) []Model {
	cloned := make([]Model, len(models))
	for i := range models {
		cloned[i] = models[i]
		cloned[i].SupportedReasoningEfforts = slices.Clone(models[i].SupportedReasoningEfforts)
		cloned[i].AdditionalSpeedTiers = slices.Clone(models[i].AdditionalSpeedTiers)
		cloned[i].ServiceTiers = slices.Clone(models[i].ServiceTiers)
	}
	return cloned
}

func (c *Client) listModels(ctx context.Context) ([]Model, error) {
	type listResult struct {
		Data       []modelWire `json:"data"`
		NextCursor *string     `json:"nextCursor"`
	}
	var all []Model
	var cursor *string
	seen := make(map[string]struct{})
	for {
		params := struct {
			Limit         int     `json:"limit"`
			IncludeHidden bool    `json:"includeHidden"`
			Cursor        *string `json:"cursor,omitempty"`
		}{Limit: 100, IncludeHidden: false, Cursor: cursor}
		raw, err := c.call(ctx, "model/list", params)
		if err != nil {
			return nil, fmt.Errorf("list Codex models: %w", err)
		}
		var page listResult
		if err := json.Unmarshal(raw, &page); err != nil {
			return nil, fmt.Errorf("decode Codex model list: %w", err)
		}
		for _, model := range page.Data {
			all = append(all, model.Model)
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			return all, nil
		}
		if _, ok := seen[*page.NextCursor]; ok {
			return nil, errors.New("Codex model list repeated a cursor")
		}
		seen[*page.NextCursor] = struct{}{}
		cursor = page.NextCursor
	}
}

type modelWire struct {
	Model Model `json:"-"`
}

func (w *modelWire) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID                        string             `json:"id"`
		Model                     string             `json:"model"`
		DisplayName               string             `json:"displayName"`
		Hidden                    bool               `json:"hidden"`
		DefaultReasoningEffort    string             `json:"defaultReasoningEffort"`
		SupportedReasoningEfforts []json.RawMessage  `json:"supportedReasoningEfforts"`
		AdditionalSpeedTiers      []string           `json:"additionalSpeedTiers"`
		ServiceTiers              []ModelServiceTier `json:"serviceTiers"`
		DefaultServiceTier        string             `json:"defaultServiceTier"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	w.Model = Model{
		ID:                     raw.ID,
		Model:                  raw.Model,
		DisplayName:            raw.DisplayName,
		Hidden:                 raw.Hidden,
		DefaultReasoningEffort: raw.DefaultReasoningEffort,
		AdditionalSpeedTiers:   slices.Clone(raw.AdditionalSpeedTiers),
		ServiceTiers:           slices.Clone(raw.ServiceTiers),
		DefaultServiceTier:     raw.DefaultServiceTier,
	}
	for _, encoded := range raw.SupportedReasoningEfforts {
		var effort ReasoningEffort
		if err := json.Unmarshal(encoded, &effort); err != nil {
			return fmt.Errorf("decode supported reasoning effort: %w", err)
		}
		if effort.ReasoningEffort == "" {
			return errors.New("empty supported reasoning effort")
		}
		w.Model.SupportedReasoningEfforts = append(w.Model.SupportedReasoningEfforts, effort)
	}
	return nil
}

// StartThread starts a new stable App Server thread and returns its id.
func (c *Client) StartThread(ctx context.Context, options ThreadOptions) (string, error) {
	if err := c.validateModel(options.Model, options.Effort); err != nil {
		return "", err
	}
	if len(options.OutputSchema) != 0 && !json.Valid(options.OutputSchema) {
		return "", errors.New("codex thread output schema is not valid JSON")
	}
	params := struct {
		Model          string         `json:"model,omitempty"`
		CWD            string         `json:"cwd,omitempty"`
		ApprovalPolicy string         `json:"approvalPolicy,omitempty"`
		Sandbox        string         `json:"sandbox,omitempty"`
		Personality    string         `json:"personality,omitempty"`
		ServiceName    string         `json:"serviceName,omitempty"`
		Config         map[string]any `json:"config,omitempty"`
	}{
		Model:          options.Model,
		CWD:            options.CWD,
		ApprovalPolicy: options.ApprovalPolicy,
		Sandbox:        options.Sandbox,
		Personality:    options.Personality,
		ServiceName:    options.ServiceName,
		Config:         options.Config,
	}
	raw, err := c.call(ctx, "thread/start", params)
	if err != nil {
		return "", fmt.Errorf("start Codex thread: %w", err)
	}
	threadID, err := decodeThreadID(raw)
	if err != nil {
		return "", err
	}
	c.defaultsMu.Lock()
	c.defaults[threadID] = TurnOptions{
		Model:          options.Model,
		Effort:         options.Effort,
		Prompt:         options.Prompt,
		OutputSchema:   slices.Clone(options.OutputSchema),
		CWD:            options.CWD,
		ApprovalPolicy: options.ApprovalPolicy,
		Personality:    options.Personality,
	}
	c.defaultsMu.Unlock()
	return threadID, nil
}

// ResumeThread reopens a persisted thread. It does not start or replay a turn.
func (c *Client) ResumeThread(ctx context.Context, threadID string) error {
	return c.ResumeThreadWithConfig(ctx, threadID, nil)
}

// ResumeThreadWithConfig reopens a persisted thread with stable session-layer
// configuration. App Server validates and applies the map; AetherOps uses this
// only for the bounded context-window profile.
func (c *Client) ResumeThreadWithConfig(ctx context.Context, threadID string, config map[string]any) error {
	if strings.TrimSpace(threadID) == "" {
		return errors.New("codex thread id is required")
	}
	params := struct {
		ThreadID string         `json:"threadId"`
		Config   map[string]any `json:"config,omitempty"`
	}{ThreadID: threadID, Config: config}
	raw, err := c.call(ctx, "thread/resume", params)
	if err != nil {
		return fmt.Errorf("resume Codex thread: %w", err)
	}
	if _, err := decodeThreadID(raw); err != nil {
		return err
	}
	return nil
}

// ReadThread returns the persisted display history for one App Server thread.
// It is read-only and never resumes, starts, or replays a turn.
func (c *Client) ReadThread(ctx context.Context, threadID string) (ThreadHistory, error) {
	threadID = strings.TrimSpace(threadID)
	if threadID == "" {
		return ThreadHistory{}, errors.New("codex thread id is required")
	}
	params := struct {
		ThreadID     string `json:"threadId"`
		IncludeTurns bool   `json:"includeTurns"`
	}{ThreadID: threadID, IncludeTurns: true}
	raw, err := c.call(ctx, "thread/read", params)
	if err != nil {
		return ThreadHistory{}, fmt.Errorf("read Codex thread: %w", err)
	}
	var response struct {
		Thread struct {
			ID    string `json:"id"`
			Turns []struct {
				ID          string `json:"id"`
				Status      string `json:"status"`
				StartedAt   *int64 `json:"startedAt"`
				CompletedAt *int64 `json:"completedAt"`
				Items       []struct {
					ID      string                 `json:"id"`
					Type    string                 `json:"type"`
					Text    string                 `json:"text"`
					Phase   string                 `json:"phase"`
					Content []ThreadHistoryContent `json:"content"`
				} `json:"items"`
			} `json:"turns"`
		} `json:"thread"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return ThreadHistory{}, fmt.Errorf("decode Codex thread history: %w", err)
	}
	if response.Thread.ID == "" {
		return ThreadHistory{}, errors.New("Codex thread history did not include an id")
	}
	if response.Thread.ID != threadID {
		return ThreadHistory{}, fmt.Errorf("Codex thread history returned unexpected id %q", response.Thread.ID)
	}
	history := ThreadHistory{ThreadID: response.Thread.ID, Turns: make([]ThreadHistoryTurn, 0, len(response.Thread.Turns))}
	for _, sourceTurn := range response.Thread.Turns {
		turn := ThreadHistoryTurn{
			ID: sourceTurn.ID, Status: sourceTurn.Status,
			StartedAt: sourceTurn.StartedAt, CompletedAt: sourceTurn.CompletedAt,
			Items: make([]ThreadHistoryItem, 0, len(sourceTurn.Items)),
		}
		for _, sourceItem := range sourceTurn.Items {
			turn.Items = append(turn.Items, ThreadHistoryItem{
				ID: sourceItem.ID, Type: sourceItem.Type, Text: sourceItem.Text,
				Phase: sourceItem.Phase, Content: sourceItem.Content,
			})
		}
		history.Turns = append(history.Turns, turn)
	}
	return history, nil
}

func decodeThreadID(raw json.RawMessage) (string, error) {
	var response struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return "", fmt.Errorf("decode Codex thread response: %w", err)
	}
	if response.Thread.ID == "" {
		return "", errors.New("Codex thread response did not include an id")
	}
	return response.Thread.ID, nil
}

// Turn starts one turn, collects final agentMessage items, and waits until the
// matching turn/completed notification arrives.
func (c *Client) Turn(ctx context.Context, threadID string, options TurnOptions) (TurnResult, error) {
	if strings.TrimSpace(threadID) == "" {
		return TurnResult{}, errors.New("codex thread id is required")
	}
	options = c.withThreadDefaults(threadID, options)
	if err := validateTurnOptions(options); err != nil {
		return TurnResult{}, err
	}
	if err := c.ValidateSelection(options.Model, options.Effort, options.ServiceTier); err != nil {
		return TurnResult{}, err
	}
	params := struct {
		ThreadID       string          `json:"threadId"`
		Input          []UserInput     `json:"input"`
		CWD            string          `json:"cwd,omitempty"`
		ApprovalPolicy string          `json:"approvalPolicy,omitempty"`
		SandboxPolicy  json.RawMessage `json:"sandboxPolicy,omitempty"`
		Model          string          `json:"model,omitempty"`
		Effort         string          `json:"effort,omitempty"`
		ServiceTier    string          `json:"serviceTier,omitempty"`
		Summary        string          `json:"summary,omitempty"`
		Personality    string          `json:"personality,omitempty"`
		OutputSchema   json.RawMessage `json:"outputSchema,omitempty"`
	}{
		ThreadID:       threadID,
		Input:          append([]UserInput{{Type: "text", Text: options.Prompt}}, options.Inputs...),
		CWD:            options.CWD,
		ApprovalPolicy: options.ApprovalPolicy,
		SandboxPolicy:  options.SandboxPolicy,
		Model:          options.Model,
		Effort:         options.Effort,
		ServiceTier:    options.ServiceTier,
		Summary:        options.Summary,
		Personality:    options.Personality,
		OutputSchema:   options.OutputSchema,
	}
	raw, err := c.call(ctx, "turn/start", params)
	if err != nil {
		return TurnResult{}, fmt.Errorf("start Codex turn: %w", err)
	}
	turnID, err := decodeTurnID(raw)
	if err != nil {
		return TurnResult{}, err
	}
	state := c.getTurnState(turnID, threadID)
	result, err := c.waitForTurn(ctx, state)
	if result.ThreadID == "" {
		result.ThreadID = threadID
	}
	if result.TurnID == "" {
		result.TurnID = turnID
	}
	if err != nil {
		return result, err
	}
	if result.Status != "completed" {
		return result, &TurnError{Result: result}
	}
	return result, nil
}

type textInput struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func decodeTurnID(raw json.RawMessage) (string, error) {
	var response struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return "", fmt.Errorf("decode Codex turn response: %w", err)
	}
	if response.Turn.ID == "" {
		return "", errors.New("Codex turn response did not include an id")
	}
	return response.Turn.ID, nil
}

func (c *Client) withThreadDefaults(threadID string, options TurnOptions) TurnOptions {
	c.defaultsMu.RLock()
	defaults, ok := c.defaults[threadID]
	c.defaultsMu.RUnlock()
	if !ok {
		return options
	}
	if options.Model == "" {
		options.Model = defaults.Model
	}
	if options.Effort == "" {
		options.Effort = defaults.Effort
	}
	if options.ServiceTier == "" {
		options.ServiceTier = defaults.ServiceTier
	}
	if options.Prompt == "" {
		options.Prompt = defaults.Prompt
	}
	if len(options.OutputSchema) == 0 {
		options.OutputSchema = slices.Clone(defaults.OutputSchema)
	}
	if options.CWD == "" {
		options.CWD = defaults.CWD
	}
	if options.ApprovalPolicy == "" {
		options.ApprovalPolicy = defaults.ApprovalPolicy
	}
	if options.Personality == "" {
		options.Personality = defaults.Personality
	}
	return options
}

func (c *Client) validateModel(model, effort string) error {
	if model == "" {
		if effort != "" {
			return errors.New("codex reasoning effort requires an explicit model")
		}
		return nil
	}
	c.modelsMu.RLock()
	models := cloneModels(c.models)
	c.modelsMu.RUnlock()
	if len(models) == 0 {
		return errors.New("Codex models have not been validated")
	}
	for _, candidate := range models {
		if !candidate.Hidden && candidate.identifier() == model {
			if effort != "" && !candidate.SupportsEffort(effort) {
				return fmt.Errorf("Codex model %q does not support reasoning effort %q", model, effort)
			}
			return nil
		}
	}
	return fmt.Errorf("Codex model %q is unavailable", model)
}

// ValidateSelection checks the exact catalog combination without selecting a
// replacement model, effort, or speed tier.
func (c *Client) ValidateSelection(model, effort, serviceTier string) error {
	if err := c.validateModel(model, effort); err != nil {
		return err
	}
	if serviceTier == "" || serviceTier == "default" {
		return nil
	}
	if serviceTier != "fast" {
		return fmt.Errorf("unsupported Codex service tier %q", serviceTier)
	}
	c.modelsMu.RLock()
	models := cloneModels(c.models)
	c.modelsMu.RUnlock()
	for _, candidate := range models {
		if !candidate.Hidden && candidate.identifier() == model {
			if !candidate.SupportsFast() {
				return fmt.Errorf("Codex model %q does not advertise Fast mode", model)
			}
			return nil
		}
	}
	return fmt.Errorf("Codex model %q is unavailable", model)
}

// InterruptTurn asks App Server to cancel an in-flight turn. Completion still
// arrives asynchronously as turn/completed with status "interrupted".
func (c *Client) InterruptTurn(ctx context.Context, threadID, turnID string) error {
	if strings.TrimSpace(threadID) == "" || strings.TrimSpace(turnID) == "" {
		return errors.New("codex thread id and turn id are required")
	}
	params := struct {
		ThreadID string `json:"threadId"`
		TurnID   string `json:"turnId"`
	}{ThreadID: threadID, TurnID: turnID}
	if _, err := c.call(ctx, "turn/interrupt", params); err != nil {
		return fmt.Errorf("interrupt Codex turn: %w", err)
	}
	return nil
}

// SteerThread appends text to the active in-flight turn on threadID. The
// expected turn id is read from the client's validated live-turn registry so a
// message can never be attached to a later turn by accident.
func (c *Client) SteerThread(ctx context.Context, threadID, message string) (string, error) {
	threadID = strings.TrimSpace(threadID)
	message = strings.TrimSpace(message)
	if threadID == "" {
		return "", errors.New("codex thread id is required")
	}
	if message == "" {
		return "", errors.New("Codex steering message is required")
	}
	turnID, ok := c.activeTurnID(threadID)
	if !ok {
		return "", ErrNoActiveTurn
	}
	params := struct {
		ThreadID       string      `json:"threadId"`
		Input          []textInput `json:"input"`
		ExpectedTurnID string      `json:"expectedTurnId"`
	}{
		ThreadID: threadID, Input: []textInput{{Type: "text", Text: message}}, ExpectedTurnID: turnID,
	}
	raw, err := c.call(ctx, "turn/steer", params)
	if err != nil {
		return "", fmt.Errorf("steer Codex turn: %w", err)
	}
	var response struct {
		TurnID string `json:"turnId"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return "", fmt.Errorf("decode Codex steer response: %w", err)
	}
	if response.TurnID == "" || response.TurnID != turnID {
		return "", fmt.Errorf("Codex steer response returned unexpected turn id %q", response.TurnID)
	}
	return response.TurnID, nil
}

func (c *Client) activeTurnID(threadID string) (string, bool) {
	c.turnsMu.Lock()
	defer c.turnsMu.Unlock()
	for turnID, state := range c.turns {
		if !state.completed && state.turn.ThreadID == threadID {
			return turnID, true
		}
	}
	return "", false
}

// InterruptAll interrupts every turn that has started but has not emitted a
// terminal completion. It is used by the browser manual-control and emergency
// stop paths; no turn is replayed or silently replaced.
func (c *Client) InterruptAll(ctx context.Context) error {
	type activeTurn struct {
		threadID string
		turnID   string
	}
	c.turnsMu.Lock()
	active := make([]activeTurn, 0, len(c.turns))
	for _, state := range c.turns {
		if !state.completed && state.turn.ThreadID != "" && state.turn.TurnID != "" {
			active = append(active, activeTurn{threadID: state.turn.ThreadID, turnID: state.turn.TurnID})
		}
	}
	c.turnsMu.Unlock()
	var errs []error
	for _, turn := range active {
		if err := c.InterruptTurn(ctx, turn.threadID, turn.turnID); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// StartDeviceCodeLogin starts the stable ChatGPT device-code login flow.
func (c *Client) StartDeviceCodeLogin(ctx context.Context) (DeviceCodeLogin, error) {
	params := struct {
		Type string `json:"type"`
	}{Type: "chatgptDeviceCode"}
	raw, err := c.call(ctx, "account/login/start", params)
	if err != nil {
		return DeviceCodeLogin{}, fmt.Errorf("start ChatGPT device-code login: %w", err)
	}
	var response struct {
		Type            string `json:"type"`
		LoginID         string `json:"loginId"`
		VerificationURL string `json:"verificationUrl"`
		UserCode        string `json:"userCode"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return DeviceCodeLogin{}, fmt.Errorf("decode ChatGPT device-code login: %w", err)
	}
	if response.Type != "chatgptDeviceCode" || response.LoginID == "" || response.VerificationURL == "" || response.UserCode == "" {
		return DeviceCodeLogin{}, errors.New("invalid ChatGPT device-code login response")
	}
	return DeviceCodeLogin{LoginID: response.LoginID, VerificationURL: response.VerificationURL, UserCode: response.UserCode}, nil
}

// ReadAccount reads the stable account/read surface without returning email,
// tokens, or any other account identifier. AetherOps accepts only a managed
// ChatGPT login as authenticated Codex state.
func (c *Client) ReadAccount(ctx context.Context, refreshToken bool) (AccountStatus, error) {
	params := struct {
		RefreshToken bool `json:"refreshToken"`
	}{RefreshToken: refreshToken}
	raw, err := c.call(ctx, "account/read", params)
	if err != nil {
		return AccountStatus{}, fmt.Errorf("read Codex account: %w", err)
	}
	var response struct {
		Account *struct {
			Type     string `json:"type"`
			PlanType string `json:"planType"`
		} `json:"account"`
		RequiresOpenAIAuth bool `json:"requiresOpenaiAuth"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return AccountStatus{}, fmt.Errorf("decode Codex account: %w", err)
	}
	status := AccountStatus{RequiresOpenAIAuth: response.RequiresOpenAIAuth}
	if response.Account == nil {
		return status, nil
	}
	status.AccountType = strings.TrimSpace(response.Account.Type)
	status.PlanType = strings.TrimSpace(response.Account.PlanType)
	status.ChatGPT = status.AccountType == "chatgpt"
	status.Authenticated = status.ChatGPT
	return status, nil
}

// CancelLogin cancels an in-progress device-code or browser login.
func (c *Client) CancelLogin(ctx context.Context, loginID string) error {
	if strings.TrimSpace(loginID) == "" {
		return errors.New("Codex login id is required")
	}
	params := struct {
		LoginID string `json:"loginId"`
	}{LoginID: loginID}
	if _, err := c.call(ctx, "account/login/cancel", params); err != nil {
		return fmt.Errorf("cancel Codex login: %w", err)
	}
	return nil
}

// Events delivers App Server notifications and server requests in arrival
// order. Callers must consume this channel while a turn may need approval.
func (c *Client) Events() <-chan Event { return c.events }

// ThreadUsage returns the latest validated context measurement for threadID.
// Notifications with missing context-window metadata remain available to the
// caller, which can explicitly render them as unavailable instead of guessing.
func (c *Client) ThreadUsage(threadID string) (ThreadTokenUsage, bool) {
	c.usageMu.RLock()
	defer c.usageMu.RUnlock()
	usage, ok := c.usage[strings.TrimSpace(threadID)]
	return usage, ok
}

// RespondApproval answers an App Server approval request using the stable,
// method-specific response envelope. A bare decision string is not a valid
// response for turn/start approval requests.
func (c *Client) RespondApproval(ctx context.Context, event Event, decision string) error {
	if !event.IsServerRequest() {
		return ErrNotServerRequest
	}
	if !event.IsApprovalRequest() {
		return ErrNotApprovalRequest
	}
	if decision != "accept" && decision != "decline" {
		return errors.New("Codex approval decision must be accept or decline")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	payload, err := approvalResponse(event, decision)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode Codex approval decision: %w", err)
	}
	return c.writeMessage(wireMessage{ID: cloneRaw(event.RequestID), Result: encoded})
}

func approvalResponse(event Event, decision string) (any, error) {
	switch event.Method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
		"item/mcpToolCall/requestApproval":
		return struct {
			Decision string `json:"decision"`
		}{Decision: decision}, nil
	case "item/permissions/requestApproval":
		// The permissions protocol represents denial as an empty grant. On
		// approval, grant only the exact permission profile requested by the
		// server and only for this turn; never synthesize broader authority.
		permissions := json.RawMessage(`{}`)
		if decision == "accept" {
			var params struct {
				Permissions json.RawMessage `json:"permissions"`
			}
			if err := json.Unmarshal(event.Params, &params); err != nil || len(params.Permissions) == 0 || !json.Valid(params.Permissions) {
				return nil, errors.New("Codex permissions approval request is invalid")
			}
			permissions = cloneRaw(params.Permissions)
		}
		return struct {
			Permissions json.RawMessage `json:"permissions"`
			Scope       string          `json:"scope"`
		}{Permissions: permissions, Scope: "turn"}, nil
	case mcpServerElicitationRequestMethod:
		if err := validateAugmentedMCPElicitation(event.Params); err != nil {
			return nil, fmt.Errorf("invalid Codex MCP elicitation approval: %w", err)
		}
		return mcpElicitationApprovalResponse(decision), nil
	default:
		return nil, fmt.Errorf("unsupported Codex approval method %q", event.Method)
	}
}

// Close terminates the child process. It intentionally does not restart the
// server and never replays any outstanding requests or turns.
func (c *Client) Close(ctx context.Context) error {
	c.closing.Store(true)
	c.closeOnce.Do(func() {
		c.writeMu.Lock()
		if c.stdin != nil {
			_ = c.stdin.Close()
		}
		c.writeMu.Unlock()
		if c.cmd != nil && c.cmd.Process != nil {
			_ = c.cmd.Process.Kill()
		}
	})
	select {
	case <-c.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Wait waits for the child process to exit. A caller-initiated Close returns
// nil; an unexpected exit returns its process or protocol error.
func (c *Client) Wait() error {
	<-c.done
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	return c.waitErr
}

func (c *Client) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("encode %s params: %w", method, err)
	}
	id := c.nextID.Add(1)
	responseCh := make(chan rpcResponse, 1)
	c.stateMu.Lock()
	if c.terminalErr != nil {
		err := c.terminalErr
		c.stateMu.Unlock()
		return nil, err
	}
	c.pending[id] = responseCh
	c.stateMu.Unlock()

	if err := c.writeMessage(wireMessage{ID: json.RawMessage(fmt.Sprintf("%d", id)), Method: method, Params: encoded}); err != nil {
		c.removePending(id, responseCh)
		return nil, err
	}
	select {
	case response := <-responseCh:
		if response.err != nil {
			return nil, response.err
		}
		return response.result, nil
	case <-ctx.Done():
		c.removePending(id, responseCh)
		return nil, ctx.Err()
	case <-c.done:
		c.removePending(id, responseCh)
		return nil, c.currentTerminalError()
	}
}

func (c *Client) removePending(id uint64, responseCh chan rpcResponse) {
	c.stateMu.Lock()
	if current, ok := c.pending[id]; ok && current == responseCh {
		delete(c.pending, id)
	}
	c.stateMu.Unlock()
}

func (c *Client) notify(method string, params any) error {
	encoded, err := json.Marshal(params)
	if err != nil {
		return fmt.Errorf("encode %s params: %w", method, err)
	}
	return c.writeMessage(wireMessage{Method: method, Params: encoded})
}

func (c *Client) writeMessage(message wireMessage) error {
	encoded, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("encode Codex JSONL message: %w", err)
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if terminal := c.currentTerminalError(); terminal != nil {
		return terminal
	}
	if c.stdin == nil {
		return ErrClosed
	}
	if _, err := c.stdin.Write(append(encoded, '\n')); err != nil {
		return fmt.Errorf("write Codex JSONL message: %w", err)
	}
	return nil
}

func (c *Client) currentTerminalError() error {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	return c.terminalErr
}

func (c *Client) readLoop() {
	scanner := bufio.NewScanner(c.stdout)
	scanner.Buffer(make([]byte, 64*1024), maxJSONLMessageSize)
	var protocolErr error
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		if !utf8.Valid(line) {
			protocolErr = errors.New("Codex JSONL message is not valid UTF-8")
			break
		}
		var message wireMessage
		if err := json.Unmarshal(line, &message); err != nil {
			protocolErr = fmt.Errorf("decode Codex JSONL message: %w", err)
			break
		}
		c.dispatch(message)
	}
	if err := scanner.Err(); err != nil && protocolErr == nil {
		protocolErr = fmt.Errorf("read Codex JSONL stdout: %w", err)
	}
	if protocolErr != nil && c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
	waitErr := c.cmd.Wait()
	if protocolErr != nil {
		waitErr = errors.Join(protocolErr, waitErr)
	}
	c.finish(waitErr)
}

func (c *Client) dispatch(message wireMessage) {
	if message.Method != "" {
		c.recordTurnEvent(message)
		c.recordMCPLifecycle(message)
		event := Event{
			Method:    message.Method,
			Params:    cloneRaw(message.Params),
			RequestID: cloneRaw(message.ID),
		}
		if event.IsServerRequest() && event.Method == mcpServerElicitationRequestMethod {
			prepared, ok := c.prepareMCPElicitation(event)
			if !ok {
				c.declineMCPElicitation(event)
				return
			}
			event = prepared
		} else if event.IsServerRequest() && !event.IsApprovalRequest() {
			// A server request cannot be treated like a notification: dropping it
			// leaves App Server waiting forever. AetherOps intentionally supports
			// only stable approval requests, so fail every other request promptly.
			_ = c.writeMessage(wireMessage{ID: cloneRaw(message.ID), Error: &RPCError{
				Code:    -32601,
				Message: "unsupported Codex server request: " + message.Method,
			}})
			return
		}
		c.queueEvent(event)
		return
	}
	if id, ok := parseRequestID(message.ID); ok {
		c.stateMu.Lock()
		responseCh, found := c.pending[id]
		if found {
			delete(c.pending, id)
		}
		c.stateMu.Unlock()
		if found {
			if message.Error != nil {
				responseCh <- rpcResponse{err: message.Error}
			} else {
				responseCh <- rpcResponse{result: cloneRaw(message.Result)}
			}
		}
	}
}

func parseRequestID(raw json.RawMessage) (uint64, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, false
	}
	var id uint64
	if err := json.Unmarshal(raw, &id); err != nil {
		return 0, false
	}
	return id, true
}

func (c *Client) recordTurnEvent(message wireMessage) {
	switch message.Method {
	case "turn/started":
		var payload struct {
			ThreadID string `json:"threadId"`
			Turn     struct {
				ID string `json:"id"`
			} `json:"turn"`
		}
		if json.Unmarshal(message.Params, &payload) != nil || payload.ThreadID == "" || payload.Turn.ID == "" {
			return
		}
		c.getTurnState(payload.Turn.ID, payload.ThreadID)
	case "thread/tokenUsage/updated":
		var payload struct {
			ThreadID   string `json:"threadId"`
			TurnID     string `json:"turnId"`
			TokenUsage struct {
				Total              TokenUsageBreakdown `json:"total"`
				Last               TokenUsageBreakdown `json:"last"`
				ModelContextWindow *int64              `json:"modelContextWindow"`
			} `json:"tokenUsage"`
		}
		if json.Unmarshal(message.Params, &payload) != nil || strings.TrimSpace(payload.ThreadID) == "" ||
			!validTokenUsage(payload.TokenUsage.Total) || !validTokenUsage(payload.TokenUsage.Last) ||
			(payload.TokenUsage.ModelContextWindow != nil && *payload.TokenUsage.ModelContextWindow <= 0) {
			return
		}
		usage := ThreadTokenUsage{
			ThreadID: payload.ThreadID, TurnID: payload.TurnID,
			Total: payload.TokenUsage.Total, Last: payload.TokenUsage.Last,
			ModelContextWindow: payload.TokenUsage.ModelContextWindow, UpdatedAt: time.Now().UTC(),
		}
		c.usageMu.Lock()
		c.usage[payload.ThreadID] = usage
		c.usageMu.Unlock()
	case "item/completed":
		var payload struct {
			ThreadID string `json:"threadId"`
			TurnID   string `json:"turnId"`
			Item     struct {
				Type  string  `json:"type"`
				Text  string  `json:"text"`
				Phase *string `json:"phase"`
			} `json:"item"`
		}
		if json.Unmarshal(message.Params, &payload) != nil || payload.TurnID == "" || payload.Item.Type != "agentMessage" {
			return
		}
		state := c.getTurnState(payload.TurnID, payload.ThreadID)
		c.turnsMu.Lock()
		state.turn.AgentMessages = append(state.turn.AgentMessages, payload.Item.Text)
		// Stable providers classify assistant messages as commentary or the
		// terminal final answer. Older providers may omit phase, so retain those
		// messages only as a compatibility fallback when no explicit final answer
		// exists. Unknown non-empty phases are preserved for display but never
		// enter the authoritative turn output.
		switch {
		case payload.Item.Phase == nil:
			state.legacyMessages = append(state.legacyMessages, payload.Item.Text)
		case *payload.Item.Phase == "final_answer":
			state.finalMessages = append(state.finalMessages, payload.Item.Text)
		case *payload.Item.Phase == "commentary":
			// Commentary is intentionally excluded from TurnResult.Text.
		default:
			// Fail closed for protocol phases outside the stable enum.
		}
		if len(state.finalMessages) != 0 {
			state.turn.Text = state.finalMessages[len(state.finalMessages)-1]
		} else {
			state.turn.Text = strings.Join(state.legacyMessages, "\n")
		}
		c.turnsMu.Unlock()
	case "turn/completed":
		var payload struct {
			ThreadID string `json:"threadId"`
			Turn     struct {
				ID     string          `json:"id"`
				Status string          `json:"status"`
				Error  json.RawMessage `json:"error"`
			} `json:"turn"`
		}
		if json.Unmarshal(message.Params, &payload) != nil || payload.Turn.ID == "" {
			return
		}
		state := c.getTurnState(payload.Turn.ID, payload.ThreadID)
		c.turnsMu.Lock()
		if state.turn.ThreadID == "" {
			state.turn.ThreadID = payload.ThreadID
		}
		state.turn.TurnID = payload.Turn.ID
		state.turn.Status = payload.Turn.Status
		state.turn.Error = cloneRaw(payload.Turn.Error)
		if !state.completed {
			state.completed = true
			close(state.done)
		}
		c.turnsMu.Unlock()
	}
}

func validTokenUsage(usage TokenUsageBreakdown) bool {
	return usage.TotalTokens >= 0 && usage.InputTokens >= 0 && usage.CachedInputTokens >= 0 &&
		usage.CacheWriteInputTokens >= 0 && usage.OutputTokens >= 0 && usage.ReasoningOutputTokens >= 0
}

func (c *Client) getTurnState(turnID, threadID string) *turnState {
	c.turnsMu.Lock()
	defer c.turnsMu.Unlock()
	if state, ok := c.turns[turnID]; ok {
		if state.turn.ThreadID == "" {
			state.turn.ThreadID = threadID
		}
		return state
	}
	state := &turnState{turn: TurnResult{ThreadID: threadID, TurnID: turnID}, done: make(chan struct{})}
	c.turns[turnID] = state
	return state
}

func (c *Client) waitForTurn(ctx context.Context, state *turnState) (TurnResult, error) {
	select {
	case <-state.done:
		return c.snapshotTurn(state), nil
	default:
	}
	select {
	case <-state.done:
		return c.snapshotTurn(state), nil
	case <-ctx.Done():
		interruptCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		interruptErr := c.InterruptTurn(interruptCtx, state.turn.ThreadID, state.turn.TurnID)
		cancel()
		return c.snapshotTurn(state), errors.Join(ctx.Err(), interruptErr)
	case <-c.done:
		select {
		case <-state.done:
			return c.snapshotTurn(state), nil
		default:
			return TurnResult{}, c.currentTerminalError()
		}
	}
}

func (c *Client) snapshotTurn(state *turnState) TurnResult {
	c.turnsMu.Lock()
	defer c.turnsMu.Unlock()
	result := state.turn
	result.AgentMessages = slices.Clone(state.turn.AgentMessages)
	result.Error = cloneRaw(state.turn.Error)
	return result
}

func (c *Client) queueEvent(event Event) {
	select {
	case <-c.done:
		return
	default:
	}
	select {
	case <-c.done:
		return
	case c.eventInput <- event:
	}
}

func (c *Client) eventLoop() {
	defer close(c.events)
	queue := make([]Event, 0, 32)
	ending := false
	for !ending || len(queue) != 0 {
		var out chan Event
		var next Event
		var done <-chan struct{}
		if len(queue) != 0 {
			out = c.events
			next = queue[0]
		}
		if !ending {
			done = c.done
		}
		select {
		case event := <-c.eventInput:
			queue = append(queue, event)
		case out <- next:
			queue = queue[1:]
		case <-done:
			ending = true
		}
	}
}

func (c *Client) finish(waitErr error) {
	c.finishOnce.Do(func() {
		c.clearAllMCPElicitations()
		c.stateMu.Lock()
		if c.closing.Load() {
			c.waitErr = nil
			c.terminalErr = ErrClosed
		} else {
			c.waitErr = waitErr
			if waitErr == nil {
				c.terminalErr = ErrProcessExited
			} else {
				stderr := strings.TrimSpace(c.stderr.String())
				if stderr == "" {
					c.terminalErr = fmt.Errorf("%w: %v", ErrProcessExited, waitErr)
				} else {
					c.terminalErr = fmt.Errorf("%w: %v: %s", ErrProcessExited, waitErr, stderr)
				}
			}
		}
		pending := c.pending
		c.pending = make(map[uint64]chan rpcResponse)
		terminal := c.terminalErr
		c.stateMu.Unlock()
		for _, responseCh := range pending {
			responseCh <- rpcResponse{err: terminal}
		}
		close(c.done)
	})
}

func cloneRaw(raw json.RawMessage) json.RawMessage {
	return slices.Clone(raw)
}
