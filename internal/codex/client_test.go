package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const helperEnabledEnv = "AETHEROPS_CODEX_HELPER"

func TestCodexAppServerHelper(t *testing.T) {
	if os.Getenv(helperEnabledEnv) != "1" {
		return
	}
	if err := runAppServerHelper(os.Getenv("AETHEROPS_CODEX_HELPER_MODE"), helperConcurrentCount()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Exit(0)
}

func TestProtocolLifecycleModelsThreadTurnAndDeviceLogin(t *testing.T) {
	client := startHelperClient(t, "normal", 0)
	models := client.Models()
	if len(models) != 2 {
		t.Fatalf("validated model count = %d, want 2", len(models))
	}
	if !models[0].SupportsEffort(SolEffort) || !models[1].SupportsEffort(TerraEffort) {
		t.Fatalf("required model efforts were not retained: %#v", models)
	}
	if !models[0].SupportsFast() || !models[1].SupportsFast() {
		t.Fatalf("advertised Fast modes were not retained: %#v", models)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := client.EnsureRequiredModels(ctx); err != nil {
		t.Fatal(err)
	}
	account, err := client.ReadAccount(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if !account.Authenticated || !account.ChatGPT || account.AccountType != "chatgpt" ||
		account.PlanType != "pro" || !account.RequiresOpenAIAuth {
		t.Fatalf("unexpected non-secret account status: %#v", account)
	}
	threadID, err := client.StartThread(ctx, ThreadOptions{
		Model:       SolModel,
		Effort:      SolEffort,
		CWD:         "D:/AI/AetherOps/AetherOps v2",
		ServiceName: "lifecycle",
		Config: map[string]any{
			"model_context_window":           int64(1_000_000),
			"model_auto_compact_token_limit": int64(900_000),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if threadID != "thr-lifecycle" {
		t.Fatalf("thread id = %q", threadID)
	}
	if err := client.ResumeThreadWithConfig(ctx, threadID, map[string]any{
		"model_context_window":           int64(1_000_000),
		"model_auto_compact_token_limit": int64(900_000),
	}); err != nil {
		t.Fatal(err)
	}
	history, err := client.ReadThread(ctx, threadID)
	if err != nil {
		t.Fatal(err)
	}
	if history.ThreadID != threadID || len(history.Turns) != 1 || len(history.Turns[0].Items) != 3 {
		t.Fatalf("unexpected thread history: %#v", history)
	}
	if history.Turns[0].Items[0].Type != "userMessage" || history.Turns[0].Items[2].Phase != "final_answer" {
		t.Fatalf("thread history lost display item fields: %#v", history.Turns[0].Items)
	}

	result, err := client.Turn(ctx, threadID, TurnOptions{
		Model:        SolModel,
		Effort:       SolEffort,
		ServiceTier:  "fast",
		Prompt:       "schema",
		OutputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ThreadID != threadID || result.TurnID != "turn-thr-lifecycle" || result.Status != "completed" {
		t.Fatalf("unexpected turn result: %#v", result)
	}
	if result.Text != "final schema" {
		t.Fatalf("turn text = %q", result.Text)
	}
	usage, ok := client.ThreadUsage(threadID)
	if !ok || usage.ModelContextWindow == nil {
		t.Fatal("thread context usage was not retained")
	}
	if usage.Last.TotalTokens != 24000 || *usage.ModelContextWindow != 200000 {
		t.Fatalf("unexpected thread context usage: %#v", usage)
	}

	login, err := client.StartDeviceCodeLogin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if login.LoginID != "login-1" || login.UserCode != "ABCD-1234" || login.VerificationURL != "https://auth.openai.com/codex/device" {
		t.Fatalf("unexpected device code response: %#v", login)
	}
}

func TestConcurrentRequestIDDispatch(t *testing.T) {
	const calls = 12
	client := startHelperClient(t, "normal", calls)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	type result struct {
		index    int
		threadID string
		err      error
	}
	results := make(chan result, calls)
	var group sync.WaitGroup
	for i := range calls {
		group.Add(1)
		go func() {
			defer group.Done()
			serviceName := fmt.Sprintf("concurrent-%d", i)
			threadID, err := client.StartThread(ctx, ThreadOptions{Model: SolModel, Effort: SolEffort, ServiceName: serviceName})
			results <- result{index: i, threadID: threadID, err: err}
		}()
	}
	group.Wait()
	close(results)
	for outcome := range results {
		if outcome.err != nil {
			t.Fatalf("concurrent request %d: %v", outcome.index, outcome.err)
		}
		want := fmt.Sprintf("thr-concurrent-%d", outcome.index)
		if outcome.threadID != want {
			t.Fatalf("concurrent request %d got %q, want %q", outcome.index, outcome.threadID, want)
		}
	}
}

func TestApprovalEventAndTurnInterrupt(t *testing.T) {
	client := startHelperClient(t, "normal", 0)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	threadID, err := client.StartThread(ctx, ThreadOptions{Model: TerraModel, Effort: TerraEffort, ServiceName: "approval"})
	if err != nil {
		t.Fatal(err)
	}

	type turnOutcome struct {
		result TurnResult
		err    error
	}
	approvalDone := make(chan turnOutcome, 1)
	go func() {
		result, err := client.Turn(ctx, threadID, TurnOptions{Model: TerraModel, Effort: TerraEffort, Prompt: "needs approval"})
		approvalDone <- turnOutcome{result: result, err: err}
	}()

	approval := waitForEvent(t, client.Events(), func(event Event) bool {
		return event.IsApprovalRequest()
	})
	if approval.Method != "item/commandExecution/requestApproval" {
		t.Fatalf("approval method = %q", approval.Method)
	}
	if err := client.RespondApproval(ctx, approval, "accept"); err != nil {
		t.Fatal(err)
	}
	completed := <-approvalDone
	if completed.err != nil {
		t.Fatal(completed.err)
	}
	if completed.result.Text != "approved response" {
		t.Fatalf("approval turn text = %q", completed.result.Text)
	}

	heldDone := make(chan turnOutcome, 1)
	go func() {
		result, err := client.Turn(ctx, threadID, TurnOptions{Model: TerraModel, Effort: TerraEffort, Prompt: "hold"})
		heldDone <- turnOutcome{result: result, err: err}
	}()
	started := waitForEvent(t, client.Events(), func(event Event) bool {
		return event.Method == "turn/started"
	})
	var startedParams struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := json.Unmarshal(started.Params, &startedParams); err != nil {
		t.Fatal(err)
	}
	steeredTurnID, err := client.SteerThread(ctx, threadID, "focus on the newest evidence")
	if err != nil {
		t.Fatal(err)
	}
	if steeredTurnID != startedParams.Turn.ID {
		t.Fatalf("steered turn id = %q, want %q", steeredTurnID, startedParams.Turn.ID)
	}
	if err := client.InterruptTurn(ctx, threadID, startedParams.Turn.ID); err != nil {
		t.Fatal(err)
	}
	interrupted := <-heldDone
	if interrupted.result.Status != "interrupted" {
		t.Fatalf("interrupted turn status = %q", interrupted.result.Status)
	}
	var turnErr *TurnError
	if !errors.As(interrupted.err, &turnErr) {
		t.Fatalf("interrupt error = %v, want TurnError", interrupted.err)
	}
}

func TestApprovalResponseUsesStableMethodSpecificEnvelope(t *testing.T) {
	tests := []struct {
		name     string
		event    Event
		decision string
		want     string
	}{
		{
			name:     "command approval",
			event:    Event{Method: "item/commandExecution/requestApproval"},
			decision: "accept",
			want:     `{"decision":"accept"}`,
		},
		{
			name: "permissions approval",
			event: Event{
				Method: "item/permissions/requestApproval",
				Params: json.RawMessage(`{"permissions":{"network":{"enabled":true}}}`),
			},
			decision: "accept",
			want:     `{"permissions":{"network":{"enabled":true}},"scope":"turn"}`,
		},
		{
			name: "permissions decline",
			event: Event{
				Method: "item/permissions/requestApproval",
				Params: json.RawMessage(`{"permissions":{"network":{"enabled":true}}}`),
			},
			decision: "decline",
			want:     `{"permissions":{},"scope":"turn"}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response, err := approvalResponse(test.event, test.decision)
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(response)
			if err != nil {
				t.Fatal(err)
			}
			if string(encoded) != test.want {
				t.Fatalf("response = %s, want %s", encoded, test.want)
			}
		})
	}
}

func TestTurnResultUsesOnlyFinalAnswerWhenCommentaryContainsJSON(t *testing.T) {
	client := startHelperClient(t, "normal", 0)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	threadID, err := client.StartThread(ctx, ThreadOptions{
		Model: TerraModel, Effort: TerraEffort, ServiceName: "phased-output",
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.Turn(ctx, threadID, TurnOptions{
		Model: TerraModel, Effort: TerraEffort, Prompt: "commentary JSON then final JSON",
	})
	if err != nil {
		t.Fatal(err)
	}
	wantCommentary := `{"status":"collecting","sources":[]}`
	wantFinal := `{"workstream_id":"wind_tunnel_benchmark","summary":"captured","claims":[],"sources":[],"limitations":[]}`
	if result.Text != wantFinal {
		t.Fatalf("authoritative turn text = %q, want only final answer %q", result.Text, wantFinal)
	}
	if len(result.AgentMessages) != 2 || result.AgentMessages[0] != wantCommentary || result.AgentMessages[1] != wantFinal {
		t.Fatalf("display messages were not preserved: %#v", result.AgentMessages)
	}
}

func TestTurnResultPhaseCompatibilityAndUnknownPhaseFailClosed(t *testing.T) {
	tests := []struct {
		name         string
		prompt       string
		wantText     string
		wantMessages []string
	}{
		{
			name: "missing phase preserves legacy provider output", prompt: "legacy unphased output",
			wantText: "legacy final", wantMessages: []string{"legacy final"},
		},
		{
			name: "null phase preserves legacy provider output", prompt: "legacy null-phased output",
			wantText: "legacy null final", wantMessages: []string{"legacy null final"},
		},
		{
			name: "unknown phase is display only", prompt: "unknown phased output",
			wantText: "", wantMessages: []string{"future output"},
		},
		{
			name: "explicit final overrides earlier unphased output", prompt: "legacy then explicit final",
			wantText: "explicit final", wantMessages: []string{"legacy maybe-final", "explicit final"},
		},
		{
			name: "latest explicit final supersedes an earlier pre-completion final", prompt: "multiple explicit finals",
			wantText: "replacement final", wantMessages: []string{"superseded final", "replacement final"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := startHelperClient(t, "normal", 0)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			threadID, err := client.StartThread(ctx, ThreadOptions{
				Model: TerraModel, Effort: TerraEffort, ServiceName: "phase-compatibility",
			})
			if err != nil {
				t.Fatal(err)
			}
			result, err := client.Turn(ctx, threadID, TurnOptions{
				Model: TerraModel, Effort: TerraEffort, Prompt: test.prompt,
			})
			if err != nil {
				t.Fatal(err)
			}
			if result.Text != test.wantText || !slices.Equal(result.AgentMessages, test.wantMessages) {
				t.Fatalf("result = text %q messages %#v, want %q %#v", result.Text, result.AgentMessages, test.wantText, test.wantMessages)
			}
		})
	}
}

func TestUnsupportedServerRequestFailsFast(t *testing.T) {
	client := startHelperClient(t, "normal", 0)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	threadID, err := client.StartThread(ctx, ThreadOptions{Model: TerraModel, Effort: TerraEffort, ServiceName: "unsupported-request"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.Turn(ctx, threadID, TurnOptions{Model: TerraModel, Effort: TerraEffort, Prompt: "unsupported server request"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "unsupported request rejected" {
		t.Fatalf("turn text = %q", result.Text)
	}
}

func TestTurnContextDeadlineInterruptsHeldProtocolTurn(t *testing.T) {
	client := startHelperClient(t, "normal", 0)
	setupCtx, setupCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer setupCancel()
	threadID, err := client.StartThread(setupCtx, ThreadOptions{Model: TerraModel, Effort: TerraEffort, ServiceName: "deadline"})
	if err != nil {
		t.Fatal(err)
	}

	turnCtx, turnCancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer turnCancel()
	result, err := client.Turn(turnCtx, threadID, TurnOptions{Model: TerraModel, Effort: TerraEffort, Prompt: "hold"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("turn error = %v, want context deadline exceeded", err)
	}
	if result.ThreadID != threadID || result.TurnID == "" {
		t.Fatalf("deadline turn checkpoint = %q/%q, want %q/non-empty", result.ThreadID, result.TurnID, threadID)
	}
}

func TestMissingRequiredModelFailsWithoutReplacement(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err := Start(ctx, helperConfig("missing-model", 0))
	if err == nil {
		t.Fatal("Start succeeded with a missing required model effort")
	}
	if !strings.Contains(err.Error(), TerraModel) || !strings.Contains(err.Error(), TerraEffort) {
		t.Fatalf("missing-model error = %v", err)
	}
}

func TestUnexpectedExitFailsRequestsAndNeverReplays(t *testing.T) {
	client := startHelperClient(t, "crash", 0)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _ = client.StartThread(ctx, ThreadOptions{Model: SolModel, Effort: SolEffort, ServiceName: "crash"})
	if err := client.Wait(); err == nil {
		t.Fatal("Wait returned nil after helper process crash")
	}
	_, err := client.StartThread(ctx, ThreadOptions{Model: SolModel, Effort: SolEffort, ServiceName: "second"})
	if !errors.Is(err, ErrProcessExited) {
		t.Fatalf("post-crash request error = %v, want ErrProcessExited", err)
	}
}

func TestUnicodeRoundTripAndInvalidUTF8JSONLProtocolFailure(t *testing.T) {
	client := startHelperClient(t, "normal", 0)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	threadID, err := client.StartThread(ctx, ThreadOptions{Model: SolModel, Effort: SolEffort, ServiceName: "unicode"})
	if err != nil {
		t.Fatal(err)
	}
	const prompt = "한글과 emoji 😀 – 왕복"
	result, err := client.Turn(ctx, threadID, TurnOptions{Model: SolModel, Effort: SolEffort, Prompt: prompt})
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "final "+prompt {
		t.Fatalf("unicode result = %q", result.Text)
	}

	result, err = client.Turn(ctx, threadID, TurnOptions{Model: SolModel, Effort: SolEffort, Prompt: "invalid UTF-8 output"})
	if err == nil || !strings.Contains(err.Error(), "Codex JSONL message is not valid UTF-8") {
		t.Fatalf("invalid UTF-8 turn result=%+v error=%v", result, err)
	}
	if result.Text != "" || len(result.AgentMessages) != 0 {
		t.Fatalf("invalid UTF-8 returned partial assistant output: %+v", result)
	}
}

func TestCloseTerminatesChildWithoutRestart(t *testing.T) {
	client := startHelperClient(t, "normal", 0)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := client.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := client.Wait(); err != nil {
		t.Fatalf("Wait after Close = %v", err)
	}
	_, err := client.StartDeviceCodeLogin(ctx)
	if !errors.Is(err, ErrClosed) {
		t.Fatalf("request after Close = %v, want ErrClosed", err)
	}
}

func TestEnvironmentOverridesExistingCodexHome(t *testing.T) {
	merged := mergeEnvironment(
		[]string{"PATH=C:\\Windows", "CODEX_HOME=C:\\Users\\legacy", "Other=value"},
		[]string{"CODEX_HOME=C:\\AetherOps\\v2\\codex-home"},
	)
	var codexHomes []string
	for _, entry := range merged {
		if strings.HasPrefix(strings.ToUpper(entry), "CODEX_HOME=") {
			codexHomes = append(codexHomes, entry)
		}
	}
	if len(codexHomes) != 1 || codexHomes[0] != "CODEX_HOME=C:\\AetherOps\\v2\\codex-home" {
		t.Fatalf("merged CODEX_HOME entries: %v", codexHomes)
	}
}

func startHelperClient(t *testing.T, mode string, concurrent int) *Client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	client, err := Start(ctx, helperConfig(mode, concurrent))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer closeCancel()
		if err := client.Close(closeCtx); err != nil {
			t.Errorf("close helper client: %v", err)
		}
	})
	return client
}

func helperConfig(mode string, concurrent int) Config {
	return Config{
		Command: os.Args[0],
		Args:    []string{"-test.run=^TestCodexAppServerHelper$", "--"},
		Env: []string{
			helperEnabledEnv + "=1",
			"AETHEROPS_CODEX_HELPER_MODE=" + mode,
			"AETHEROPS_CODEX_HELPER_CONCURRENT=" + strconv.Itoa(concurrent),
		},
		ClientInfo: ClientInfo{Name: "aetherops-test", Title: "AetherOps Protocol Test", Version: "1"},
	}
}

func waitForEvent(t *testing.T, events <-chan Event, matches func(Event) bool) Event {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		select {
		case event, ok := <-events:
			if !ok {
				t.Fatal("event stream closed before expected event")
			}
			if matches(event) {
				return event
			}
		case <-timer.C:
			t.Fatal("timed out waiting for App Server event")
		}
	}
}

type helperMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`
}

type helperServer struct {
	writer  *bufio.Writer
	writeMu sync.Mutex

	phase       int
	mode        string
	concurrent  int
	starts      []helperMessage
	held        map[string]string
	turnCounts  map[string]int
	approval    *helperApproval
	unsupported *helperApproval
}

type helperApproval struct {
	RequestID string
	ThreadID  string
	TurnID    string
}

func runAppServerHelper(mode string, concurrent int) error {
	server := &helperServer{
		writer:     bufio.NewWriter(os.Stdout),
		mode:       mode,
		concurrent: concurrent,
		held:       make(map[string]string),
		turnCounts: make(map[string]int),
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), maxJSONLMessageSize)
	for scanner.Scan() {
		var message helperMessage
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			return fmt.Errorf("helper decode input: %w", err)
		}
		if err := server.handle(message); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func helperConcurrentCount() int {
	value, err := strconv.Atoi(os.Getenv("AETHEROPS_CODEX_HELPER_CONCURRENT"))
	if err != nil {
		return 0
	}
	return value
}

func (s *helperServer) handle(message helperMessage) error {
	if message.Method == "" {
		return s.handleClientResponse(message)
	}
	if message.Method == "initialize" {
		if s.phase != 0 {
			return errors.New("helper received initialize more than once")
		}
		var params map[string]json.RawMessage
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		if _, found := params["capabilities"]; found {
			return errors.New("client opted into experimental capabilities")
		}
		if len(params["clientInfo"]) == 0 {
			return errors.New("initialize was missing clientInfo")
		}
		var clientInfo struct {
			Name    string `json:"name"`
			Title   string `json:"title"`
			Version string `json:"version"`
		}
		if err := json.Unmarshal(params["clientInfo"], &clientInfo); err != nil {
			return err
		}
		if clientInfo.Name == "" || clientInfo.Title == "" || clientInfo.Version == "" {
			return fmt.Errorf("initialize clientInfo used an invalid stable shape: %#v", clientInfo)
		}
		s.phase = 1
		return s.respond(message.ID, map[string]any{"userAgent": "test"})
	}
	if message.Method == "initialized" {
		if s.phase != 1 {
			return errors.New("initialized notification arrived before initialize response")
		}
		s.phase = 2
		return nil
	}
	if s.phase != 2 {
		return fmt.Errorf("received %s before initialized", message.Method)
	}

	switch message.Method {
	case "model/list":
		return s.handleModelList(message)
	case "account/read":
		var params struct {
			RefreshToken bool `json:"refreshToken"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		if params.RefreshToken {
			return errors.New("account/read unexpectedly requested a token refresh")
		}
		return s.respond(message.ID, map[string]any{
			"account":            map[string]any{"type": "chatgpt", "email": "must-not-be-returned@example.invalid", "planType": "pro"},
			"requiresOpenaiAuth": true,
		})
	case "thread/start":
		return s.handleThreadStart(message)
	case "thread/resume":
		var params struct {
			ThreadID string         `json:"threadId"`
			Config   map[string]any `json:"config"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		if params.ThreadID == "thr-lifecycle" {
			if err := validateLongContextWireConfig(params.Config); err != nil {
				return fmt.Errorf("thread/resume context config: %w", err)
			}
		}
		return s.respond(message.ID, map[string]any{"thread": map[string]any{"id": params.ThreadID}})
	case "thread/read":
		var params struct {
			ThreadID     string `json:"threadId"`
			IncludeTurns bool   `json:"includeTurns"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		if params.ThreadID == "" || !params.IncludeTurns {
			return fmt.Errorf("invalid thread/read params: %#v", params)
		}
		startedAt, completedAt := int64(1_700_000_000), int64(1_700_000_001)
		return s.respond(message.ID, map[string]any{"thread": map[string]any{
			"id": params.ThreadID,
			"turns": []any{map[string]any{
				"id": "turn-history", "status": "completed", "startedAt": startedAt, "completedAt": completedAt,
				"items": []any{
					map[string]any{"id": "user-history", "type": "userMessage", "content": []any{map[string]any{"type": "text", "text": "hello"}}},
					map[string]any{"id": "commentary-history", "type": "agentMessage", "text": "working", "phase": "commentary"},
					map[string]any{"id": "agent-history", "type": "agentMessage", "text": "done", "phase": "final_answer"},
				},
			}},
		}})
	case "turn/start":
		return s.handleTurnStart(message)
	case "turn/steer":
		var params struct {
			ThreadID       string      `json:"threadId"`
			Input          []textInput `json:"input"`
			ExpectedTurnID string      `json:"expectedTurnId"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		if s.held[params.ExpectedTurnID] != params.ThreadID || len(params.Input) != 1 ||
			params.Input[0].Type != "text" || params.Input[0].Text != "focus on the newest evidence" {
			return fmt.Errorf("invalid turn/steer params: %#v", params)
		}
		return s.respond(message.ID, map[string]any{"turnId": params.ExpectedTurnID})
	case "turn/interrupt":
		var params struct {
			ThreadID string `json:"threadId"`
			TurnID   string `json:"turnId"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		if _, held := s.held[params.TurnID]; !held {
			return fmt.Errorf("interrupt for unknown turn %q", params.TurnID)
		}
		delete(s.held, params.TurnID)
		if err := s.respond(message.ID, map[string]any{}); err != nil {
			return err
		}
		return s.completeTurn(params.ThreadID, params.TurnID, "", "interrupted")
	case "account/login/start":
		var params struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		if params.Type != "chatgptDeviceCode" {
			return fmt.Errorf("unexpected login type %q", params.Type)
		}
		if err := s.respond(message.ID, map[string]any{
			"type": "chatgptDeviceCode", "loginId": "login-1",
			"verificationUrl": "https://auth.openai.com/codex/device", "userCode": "ABCD-1234",
		}); err != nil {
			return err
		}
		return s.notify("account/login/completed", map[string]any{"loginId": "login-1", "success": true, "error": nil})
	case "account/login/cancel":
		return s.respond(message.ID, map[string]any{})
	default:
		return fmt.Errorf("unexpected helper method %q", message.Method)
	}
}

func (s *helperServer) handleModelList(message helperMessage) error {
	var params struct {
		Limit         int  `json:"limit"`
		IncludeHidden bool `json:"includeHidden"`
	}
	if err := json.Unmarshal(message.Params, &params); err != nil {
		return err
	}
	if params.Limit < 2 || params.IncludeHidden {
		return fmt.Errorf("invalid stable model/list params: %#v", params)
	}
	terraEffort := TerraEffort
	if s.mode == "missing-model" {
		terraEffort = "medium"
	}
	return s.respond(message.ID, map[string]any{
		"data": []map[string]any{
			{"id": SolModel, "model": SolModel, "displayName": "GPT-5.6 Sol", "hidden": false, "defaultReasoningEffort": SolEffort, "supportedReasoningEfforts": []map[string]string{{"reasoningEffort": SolEffort}}, "additionalSpeedTiers": []string{"fast"}, "serviceTiers": []map[string]string{{"id": "priority", "name": "Fast"}}},
			{"id": TerraModel, "model": TerraModel, "displayName": "GPT-5.6 Terra", "hidden": false, "defaultReasoningEffort": TerraEffort, "supportedReasoningEfforts": []map[string]string{{"reasoningEffort": terraEffort}}, "additionalSpeedTiers": []string{"fast"}, "serviceTiers": []map[string]string{{"id": "priority", "name": "Fast"}}},
		},
		"nextCursor": nil,
	})
}

func (s *helperServer) handleThreadStart(message helperMessage) error {
	if s.mode == "crash" {
		os.Exit(17)
	}
	if s.concurrent > 0 {
		s.starts = append(s.starts, message)
		if len(s.starts) != s.concurrent {
			return nil
		}
		for i := len(s.starts) - 1; i >= 0; i-- {
			if err := s.respondThread(s.starts[i]); err != nil {
				return err
			}
		}
		return nil
	}
	return s.respondThread(message)
}

func (s *helperServer) respondThread(message helperMessage) error {
	var params struct {
		Model       string         `json:"model"`
		ServiceName string         `json:"serviceName"`
		Config      map[string]any `json:"config"`
	}
	if err := json.Unmarshal(message.Params, &params); err != nil {
		return err
	}
	if params.Model != "" && params.Model != SolModel && params.Model != TerraModel {
		return fmt.Errorf("unexpected thread model %q", params.Model)
	}
	if params.ServiceName == "" {
		params.ServiceName = "start"
	}
	if params.ServiceName == "lifecycle" {
		if err := validateLongContextWireConfig(params.Config); err != nil {
			return fmt.Errorf("thread/start context config: %w", err)
		}
	}
	return s.respond(message.ID, map[string]any{"thread": map[string]any{"id": "thr-" + params.ServiceName}})
}

func validateLongContextWireConfig(config map[string]any) error {
	window, windowOK := config["model_context_window"].(float64)
	compact, compactOK := config["model_auto_compact_token_limit"].(float64)
	if len(config) != 2 || !windowOK || !compactOK || window != 1_000_000 || compact != 900_000 {
		return fmt.Errorf("unexpected long-context config: %#v", config)
	}
	return nil
}

func (s *helperServer) handleTurnStart(message helperMessage) error {
	var params struct {
		ThreadID     string          `json:"threadId"`
		Input        []textInput     `json:"input"`
		OutputSchema json.RawMessage `json:"outputSchema"`
		Model        string          `json:"model"`
		Effort       string          `json:"effort"`
		ServiceTier  string          `json:"serviceTier"`
	}
	if err := json.Unmarshal(message.Params, &params); err != nil {
		return err
	}
	if params.ThreadID == "" || len(params.Input) != 1 {
		return errors.New("turn/start missing threadId or text input")
	}
	if (params.Model == SolModel && params.Effort != SolEffort) || (params.Model == TerraModel && params.Effort != TerraEffort) {
		return fmt.Errorf("turn/start did not preserve model effort: %s/%s", params.Model, params.Effort)
	}
	if params.ServiceTier != "" && params.ServiceTier != "default" && params.ServiceTier != "fast" {
		return fmt.Errorf("turn/start has unsupported service tier %q", params.ServiceTier)
	}
	prompt := params.Input[0].Text
	if prompt == "schema" && len(params.OutputSchema) == 0 {
		return errors.New("turn/start dropped outputSchema")
	}
	if prompt == "schema" && params.ServiceTier != "fast" {
		return fmt.Errorf("turn/start dropped Fast service tier: %q", params.ServiceTier)
	}
	s.turnCounts[params.ThreadID]++
	turnID := "turn-" + params.ThreadID
	if s.turnCounts[params.ThreadID] > 1 {
		turnID += "-" + strconv.Itoa(s.turnCounts[params.ThreadID])
	}
	if err := s.respond(message.ID, map[string]any{"turn": map[string]any{"id": turnID, "status": "inProgress", "items": []any{}}}); err != nil {
		return err
	}
	if err := s.notify("turn/started", map[string]any{"threadId": params.ThreadID, "turn": map[string]any{"id": turnID, "status": "inProgress"}}); err != nil {
		return err
	}
	switch prompt {
	case "invalid UTF-8 output":
		return s.sendInvalidUTF8JSONL()
	case "needs approval":
		s.approval = &helperApproval{RequestID: "approval-1", ThreadID: params.ThreadID, TurnID: turnID}
		return s.serverRequest("approval-1", "item/commandExecution/requestApproval", map[string]any{
			"threadId": params.ThreadID, "turnId": turnID, "itemId": "item-approval", "reason": "test approval",
		})
	case "unsupported server request":
		s.unsupported = &helperApproval{RequestID: "unsupported-1", ThreadID: params.ThreadID, TurnID: turnID}
		return s.serverRequest("unsupported-1", "item/tool/call", map[string]any{
			"threadId": params.ThreadID, "turnId": turnID, "tool": "deferred-test",
		})
	case "hold":
		s.held[turnID] = params.ThreadID
		return nil
	case "commentary JSON then final JSON":
		if err := s.agentMessage(params.ThreadID, turnID, `{"status":"collecting","sources":[]}`, "commentary"); err != nil {
			return err
		}
		if err := s.agentMessage(params.ThreadID, turnID, `{"workstream_id":"wind_tunnel_benchmark","summary":"captured","claims":[],"sources":[],"limitations":[]}`, "final_answer"); err != nil {
			return err
		}
		return s.completeTurn(params.ThreadID, turnID, "", "completed")
	case "legacy unphased output":
		if err := s.agentMessage(params.ThreadID, turnID, "legacy final", ""); err != nil {
			return err
		}
		return s.completeTurn(params.ThreadID, turnID, "", "completed")
	case "legacy null-phased output":
		if err := s.notify("item/completed", map[string]any{
			"threadId": params.ThreadID, "turnId": turnID,
			"item": map[string]any{
				"id": "item-" + turnID, "type": "agentMessage", "text": "legacy null final", "phase": nil,
			},
		}); err != nil {
			return err
		}
		return s.completeTurn(params.ThreadID, turnID, "", "completed")
	case "unknown phased output":
		if err := s.agentMessage(params.ThreadID, turnID, "future output", "future_phase"); err != nil {
			return err
		}
		return s.completeTurn(params.ThreadID, turnID, "", "completed")
	case "legacy then explicit final":
		if err := s.agentMessage(params.ThreadID, turnID, "legacy maybe-final", ""); err != nil {
			return err
		}
		if err := s.agentMessage(params.ThreadID, turnID, "explicit final", "final_answer"); err != nil {
			return err
		}
		return s.completeTurn(params.ThreadID, turnID, "", "completed")
	case "multiple explicit finals":
		if err := s.agentMessage(params.ThreadID, turnID, "superseded final", "final_answer"); err != nil {
			return err
		}
		if err := s.agentMessage(params.ThreadID, turnID, "replacement final", "final_answer"); err != nil {
			return err
		}
		return s.completeTurn(params.ThreadID, turnID, "", "completed")
	default:
		return s.completeTurn(params.ThreadID, turnID, "final "+prompt, "completed")
	}
}

func (s *helperServer) handleClientResponse(message helperMessage) error {
	if s.unsupported != nil && string(message.ID) == strconv.Quote(s.unsupported.RequestID) {
		if message.Error == nil || message.Error.Code != -32601 || !strings.Contains(message.Error.Message, "item/tool/call") {
			return fmt.Errorf("unsupported request response = %#v, want method-not-found error", message.Error)
		}
		unsupported := s.unsupported
		s.unsupported = nil
		return s.completeTurn(unsupported.ThreadID, unsupported.TurnID, "unsupported request rejected", "completed")
	}
	if s.approval == nil || string(message.ID) != strconv.Quote(s.approval.RequestID) {
		return fmt.Errorf("unexpected client response id %s", message.ID)
	}
	var response struct {
		Decision string `json:"decision"`
	}
	if err := json.Unmarshal(message.Result, &response); err != nil {
		return err
	}
	if response.Decision != "accept" {
		return fmt.Errorf("approval decision = %q, want accept", response.Decision)
	}
	approval := s.approval
	s.approval = nil
	if err := s.notify("serverRequest/resolved", map[string]any{"threadId": approval.ThreadID, "requestId": approval.RequestID}); err != nil {
		return err
	}
	return s.completeTurn(approval.ThreadID, approval.TurnID, "approved response", "completed")
}

func (s *helperServer) completeTurn(threadID, turnID, text, status string) error {
	if text != "" {
		if err := s.agentMessage(threadID, turnID, text, ""); err != nil {
			return err
		}
	}
	if err := s.notify("thread/tokenUsage/updated", map[string]any{
		"threadId": threadID, "turnId": turnID,
		"tokenUsage": map[string]any{
			"total":              map[string]any{"totalTokens": 36000, "inputTokens": 30000, "cachedInputTokens": 12000, "cacheWriteInputTokens": 0, "outputTokens": 5000, "reasoningOutputTokens": 1000},
			"last":               map[string]any{"totalTokens": 24000, "inputTokens": 20000, "cachedInputTokens": 8000, "cacheWriteInputTokens": 0, "outputTokens": 3000, "reasoningOutputTokens": 1000},
			"modelContextWindow": 200000,
		},
	}); err != nil {
		return err
	}
	return s.notify("turn/completed", map[string]any{
		"threadId": threadID,
		"turn":     map[string]any{"id": turnID, "status": status, "error": nil},
	})
}

func (s *helperServer) agentMessage(threadID, turnID, text, phase string) error {
	item := map[string]any{"id": "item-" + turnID, "type": "agentMessage", "text": text}
	if phase != "" {
		item["phase"] = phase
	}
	return s.notify("item/completed", map[string]any{
		"threadId": threadID, "turnId": turnID, "item": item,
	})
}

func (s *helperServer) respond(id json.RawMessage, result any) error {
	return s.send(struct {
		ID     json.RawMessage `json:"id"`
		Result any             `json:"result"`
	}{ID: id, Result: result})
}

func (s *helperServer) notify(method string, params any) error {
	return s.send(struct {
		Method string `json:"method"`
		Params any    `json:"params"`
	}{Method: method, Params: params})
}

func (s *helperServer) serverRequest(id, method string, params any) error {
	return s.send(struct {
		ID     string `json:"id"`
		Method string `json:"method"`
		Params any    `json:"params"`
	}{ID: id, Method: method, Params: params})
}

func (s *helperServer) send(value any) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := json.NewEncoder(s.writer).Encode(value); err != nil {
		return err
	}
	return s.writer.Flush()
}

func (s *helperServer) sendInvalidUTF8JSONL() error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if _, err := s.writer.WriteString(`{"method":"item/completed","params":{"text":"`); err != nil {
		return err
	}
	if err := s.writer.WriteByte(0xff); err != nil {
		return err
	}
	if _, err := s.writer.WriteString("\"}}\n"); err != nil {
		return err
	}
	return s.writer.Flush()
}
