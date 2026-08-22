package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
)

const (
	mcpTestThread = "thread-mcp"
	mcpTestTurn   = "turn-mcp"
	mcpTestServer = "aetherops_engineering"
	mcpTestTool   = "engineering_capabilities"
)

var (
	mcpTestStartedArguments = json.RawMessage(`{"stage_attempt_id":"stage-1","nested":{"z":2,"a":[1,2]},"run_id":"run-1"}`)
	mcpTestMetaArguments    = json.RawMessage(`{"run_id":"run-1","nested":{"a":[1,2],"z":2},"stage_attempt_id":"stage-1"}`)
)

type mcpTestWriteCloser struct {
	mu sync.Mutex
	bytes.Buffer
}

func (writer *mcpTestWriteCloser) Write(data []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return writer.Buffer.Write(data)
}

func (writer *mcpTestWriteCloser) Close() error { return nil }

func (writer *mcpTestWriteCloser) messages(t *testing.T) []wireMessage {
	t.Helper()
	writer.mu.Lock()
	defer writer.mu.Unlock()
	lines := bytes.Split(bytes.TrimSpace(writer.Buffer.Bytes()), []byte{'\n'})
	if len(lines) == 1 && len(lines[0]) == 0 {
		return nil
	}
	messages := make([]wireMessage, 0, len(lines))
	for _, line := range lines {
		var message wireMessage
		if err := json.Unmarshal(line, &message); err != nil {
			t.Fatalf("decode captured client response %s: %v", line, err)
		}
		messages = append(messages, message)
	}
	return messages
}

func newMCPProtocolTestClient() (*Client, *mcpTestWriteCloser) {
	writer := &mcpTestWriteCloser{}
	return &Client{
		stdin:      writer,
		pending:    make(map[uint64]chan rpcResponse),
		defaults:   make(map[string]TurnOptions),
		turns:      make(map[string]*turnState),
		usage:      make(map[string]ThreadTokenUsage),
		eventInput: make(chan Event, 64),
		events:     make(chan Event, 64),
		done:       make(chan struct{}),
	}, writer
}

func mcpTestStartedMessage(itemID string, arguments json.RawMessage) wireMessage {
	return wireMessage{Method: "item/started", Params: mustMCPTestJSON(map[string]any{
		"threadId":    mcpTestThread,
		"turnId":      mcpTestTurn,
		"startedAtMs": int64(1),
		"item": map[string]any{
			"id": itemID, "type": "mcpToolCall", "server": mcpTestServer,
			"tool": mcpTestTool, "arguments": arguments, "status": "inProgress",
		},
	})}
}

func validMCPElicitationObject(arguments json.RawMessage) map[string]any {
	return map[string]any{
		"serverName": mcpTestServer,
		"threadId":   mcpTestThread,
		"turnId":     mcpTestTurn,
		"mode":       "form",
		"message":    `Allow the aetherops_engineering tool "engineering_capabilities"?`,
		"requestedSchema": map[string]any{
			"type": "object", "properties": map[string]any{},
		},
		"_meta": map[string]any{
			"codex_approval_kind": "mcp_tool_call",
			"persist":             []string{"session", "always"},
			"tool_description":    "Return verified bundled engineering executables and readiness.",
			"tool_params_display": "run_id=run-1, stage_attempt_id=stage-1",
			"tool_params":         arguments,
		},
	}
}

func mustMCPTestJSON(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return encoded
}

func drainMCPTestEvent(t *testing.T, client *Client, method string) Event {
	t.Helper()
	select {
	case event := <-client.eventInput:
		if event.Method != method {
			t.Fatalf("queued event method = %q, want %q", event.Method, method)
		}
		return event
	default:
		t.Fatalf("event %q was not queued", method)
		return Event{}
	}
}

func startMCPTestCall(t *testing.T, client *Client, itemID string, arguments json.RawMessage) {
	t.Helper()
	client.dispatch(mcpTestStartedMessage(itemID, arguments))
	drainMCPTestEvent(t, client, "item/started")
}

func dispatchMCPTestElicitation(client *Client, requestID json.RawMessage, object map[string]any) {
	client.dispatch(wireMessage{
		ID: requestID, Method: mcpServerElicitationRequestMethod, Params: mustMCPTestJSON(object),
	})
}

func assertMCPTestDecline(t *testing.T, client *Client, writer *mcpTestWriteCloser) {
	t.Helper()
	if len(client.eventInput) != 0 {
		t.Fatalf("invalid elicitation leaked %d event(s) to the approval router", len(client.eventInput))
	}
	messages := writer.messages(t)
	if len(messages) != 1 || messages[0].Error != nil {
		t.Fatalf("automatic decline messages = %#v, want one result", messages)
	}
	var response struct {
		Action  string `json:"action"`
		Content any    `json:"content"`
	}
	if err := json.Unmarshal(messages[0].Result, &response); err != nil {
		t.Fatal(err)
	}
	if response.Action != "decline" || response.Content != nil {
		t.Fatalf("automatic decline = %#v", response)
	}
}

func mcpTestStateCounts(client *Client) (int, int) {
	client.mcpElicitations.mu.Lock()
	defer client.mcpElicitations.mu.Unlock()
	return len(client.mcpElicitations.calls), len(client.mcpElicitations.requestBindings)
}

func TestStableMCPElicitationCorrelatesAndAugmentsExactToolCall(t *testing.T) {
	client, writer := newMCPProtocolTestClient()
	startMCPTestCall(t, client, "mcp-item-1", mcpTestStartedArguments)

	dispatchMCPTestElicitation(client, json.RawMessage(`0`), validMCPElicitationObject(mcpTestMetaArguments))
	approval := drainMCPTestEvent(t, client, mcpServerElicitationRequestMethod)
	if !approval.IsApprovalRequest() {
		t.Fatal("stable MCP elicitation was not classified as an approval request")
	}
	var params struct {
		ItemID    string          `json:"itemId"`
		Server    string          `json:"server"`
		Tool      string          `json:"tool"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(approval.Params, &params); err != nil {
		t.Fatal(err)
	}
	if params.ItemID != "mcp-item-1" || params.Server != mcpTestServer || params.Tool != mcpTestTool {
		t.Fatalf("augmented approval identity = %#v", params)
	}
	canonical, err := canonicalJSONObject(params.Arguments)
	if err != nil || canonical != mustCanonicalMCPTestJSON(t, mcpTestMetaArguments) {
		t.Fatalf("augmented arguments = %s, err=%v", params.Arguments, err)
	}

	if err := client.RespondApproval(context.Background(), approval, "accept"); err != nil {
		t.Fatal(err)
	}
	messages := writer.messages(t)
	if len(messages) != 1 || string(messages[0].ID) != "0" {
		t.Fatalf("approval wire messages = %#v", messages)
	}
	var response struct {
		Action  string         `json:"action"`
		Content map[string]any `json:"content"`
	}
	if err := json.Unmarshal(messages[0].Result, &response); err != nil {
		t.Fatal(err)
	}
	if response.Action != "accept" || response.Content == nil || len(response.Content) != 0 {
		t.Fatalf("accept response = %#v, want action accept and empty content object", response)
	}
}

func mustCanonicalMCPTestJSON(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	canonical, err := canonicalJSONObject(raw)
	if err != nil {
		t.Fatal(err)
	}
	return canonical
}

func TestMCPElicitationApprovalResponseEnvelopes(t *testing.T) {
	object := validMCPElicitationObject(mcpTestMetaArguments)
	object["itemId"] = "mcp-item-1"
	object["server"] = mcpTestServer
	object["tool"] = mcpTestTool
	object["arguments"] = mcpTestStartedArguments
	event := Event{Method: mcpServerElicitationRequestMethod, Params: mustMCPTestJSON(object)}
	for _, test := range []struct {
		decision string
		want     string
	}{
		{decision: "accept", want: `{"action":"accept","content":{}}`},
		{decision: "decline", want: `{"action":"decline","content":null}`},
	} {
		response, err := approvalResponse(event, test.decision)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(response)
		if err != nil {
			t.Fatal(err)
		}
		if string(encoded) != test.want {
			t.Fatalf("%s response = %s, want %s", test.decision, encoded, test.want)
		}
	}
}

func TestMCPElicitationFailsClosedForAmbiguousAndMismatchedCalls(t *testing.T) {
	tests := []struct {
		name  string
		setup func(*testing.T, *Client)
		edit  func(map[string]any)
	}{
		{name: "no candidate"},
		{
			name: "two identical candidates",
			setup: func(t *testing.T, client *Client) {
				startMCPTestCall(t, client, "mcp-item-1", mcpTestStartedArguments)
				startMCPTestCall(t, client, "mcp-item-2", mcpTestStartedArguments)
			},
		},
		{
			name:  "arguments mismatch",
			setup: func(t *testing.T, client *Client) { startMCPTestCall(t, client, "mcp-item-1", mcpTestStartedArguments) },
			edit: func(object map[string]any) {
				object["_meta"].(map[string]any)["tool_params"] = json.RawMessage(`{"run_id":"other","stage_attempt_id":"stage-1"}`)
			},
		},
		{
			name:  "server mismatch",
			setup: func(t *testing.T, client *Client) { startMCPTestCall(t, client, "mcp-item-1", mcpTestStartedArguments) },
			edit:  func(object map[string]any) { object["serverName"] = "other_server" },
		},
		{
			name:  "turn mismatch",
			setup: func(t *testing.T, client *Client) { startMCPTestCall(t, client, "mcp-item-1", mcpTestStartedArguments) },
			edit:  func(object map[string]any) { object["turnId"] = "other-turn" },
		},
		{
			name:  "thread mismatch",
			setup: func(t *testing.T, client *Client) { startMCPTestCall(t, client, "mcp-item-1", mcpTestStartedArguments) },
			edit:  func(object map[string]any) { object["threadId"] = "other-thread" },
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, writer := newMCPProtocolTestClient()
			if test.setup != nil {
				test.setup(t, client)
			}
			object := validMCPElicitationObject(mcpTestMetaArguments)
			if test.edit != nil {
				test.edit(object)
			}
			dispatchMCPTestElicitation(client, json.RawMessage(`17`), object)
			assertMCPTestDecline(t, client, writer)
		})
	}
}

func TestMCPElicitationSelectsUniqueStructuralArgumentMatch(t *testing.T) {
	client, _ := newMCPProtocolTestClient()
	startMCPTestCall(t, client, "mcp-item-other", json.RawMessage(`{"run_id":"other","stage_attempt_id":"stage-1"}`))
	startMCPTestCall(t, client, "mcp-item-exact", mcpTestStartedArguments)
	dispatchMCPTestElicitation(client, json.RawMessage(`18`), validMCPElicitationObject(mcpTestMetaArguments))
	approval := drainMCPTestEvent(t, client, mcpServerElicitationRequestMethod)
	var params struct {
		ItemID string `json:"itemId"`
	}
	if err := json.Unmarshal(approval.Params, &params); err != nil {
		t.Fatal(err)
	}
	if params.ItemID != "mcp-item-exact" {
		t.Fatalf("correlated item = %q, want exact structural match", params.ItemID)
	}
}

func TestMCPElicitationRejectsUnsupportedModeMetaSchemaAndSpoofedFields(t *testing.T) {
	tests := []struct {
		name string
		edit func(map[string]any)
	}{
		{name: "URL mode", edit: func(object map[string]any) { object["mode"] = "url"; object["url"] = "https://example.invalid" }},
		{name: "OpenAI form mode", edit: func(object map[string]any) { object["mode"] = "openai/form" }},
		{name: "unknown form mode", edit: func(object map[string]any) { object["mode"] = "future/form" }},
		{name: "missing meta", edit: func(object map[string]any) { delete(object, "_meta") }},
		{name: "wrong approval kind", edit: func(object map[string]any) { object["_meta"].(map[string]any)["codex_approval_kind"] = "command" }},
		{name: "missing tool params", edit: func(object map[string]any) { delete(object["_meta"].(map[string]any), "tool_params") }},
		{name: "non-object tool params", edit: func(object map[string]any) { object["_meta"].(map[string]any)["tool_params"] = []any{} }},
		{name: "schema with property", edit: func(object map[string]any) {
			object["requestedSchema"] = map[string]any{"type": "object", "properties": map[string]any{"approve": map[string]any{"type": "boolean"}}}
		}},
		{name: "schema extra keyword", edit: func(object map[string]any) {
			object["requestedSchema"] = map[string]any{"type": "object", "properties": map[string]any{}, "required": []any{}}
		}},
		{name: "schema wrong type", edit: func(object map[string]any) {
			object["requestedSchema"] = map[string]any{"type": "string", "properties": map[string]any{}}
		}},
		{name: "spoofed item id", edit: func(object map[string]any) { object["itemId"] = "attacker-item" }},
		{name: "spoofed server", edit: func(object map[string]any) { object["server"] = mcpTestServer }},
		{name: "spoofed tool", edit: func(object map[string]any) { object["tool"] = "su2_naca0012" }},
		{name: "spoofed arguments", edit: func(object map[string]any) { object["arguments"] = mcpTestStartedArguments }},
		{name: "spoofed MCP server alias", edit: func(object map[string]any) { object["mcpServer"] = "attacker" }},
		{name: "spoofed tool name alias", edit: func(object map[string]any) { object["toolName"] = "su2_naca0012" }},
		{name: "spoofed tool arguments alias", edit: func(object map[string]any) { object["toolArguments"] = map[string]any{} }},
		{name: "spoofed args alias", edit: func(object map[string]any) { object["args"] = map[string]any{} }},
		{name: "spoofed summary", edit: func(object map[string]any) { object["summary"] = "harmless read" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, writer := newMCPProtocolTestClient()
			startMCPTestCall(t, client, "mcp-item-1", mcpTestStartedArguments)
			object := validMCPElicitationObject(mcpTestMetaArguments)
			test.edit(object)
			dispatchMCPTestElicitation(client, json.RawMessage(`19`), object)
			assertMCPTestDecline(t, client, writer)
		})
	}
}

func TestMCPElicitationRejectsDuplicateJSONKeys(t *testing.T) {
	client, writer := newMCPProtocolTestClient()
	startMCPTestCall(t, client, "mcp-item-1", mcpTestStartedArguments)
	params := json.RawMessage(`{
		"serverName":"aetherops_engineering","serverName":"attacker",
		"threadId":"thread-mcp","turnId":"turn-mcp","mode":"form","message":"Allow the tool?",
		"requestedSchema":{"type":"object","properties":{}},
		"_meta":{"codex_approval_kind":"mcp_tool_call","tool_params":{"run_id":"run-1","nested":{"a":[1,2],"z":2},"stage_attempt_id":"stage-1"}}
	}`)
	client.dispatch(wireMessage{ID: json.RawMessage(`20`), Method: mcpServerElicitationRequestMethod, Params: params})
	assertMCPTestDecline(t, client, writer)
}

func TestMCPElicitationLifecycleCleanup(t *testing.T) {
	t.Run("item completed", func(t *testing.T) {
		client, _ := newMCPProtocolTestClient()
		startMCPTestCall(t, client, "mcp-item-1", mcpTestStartedArguments)
		client.dispatch(wireMessage{Method: "item/completed", Params: mustMCPTestJSON(map[string]any{
			"threadId": mcpTestThread, "turnId": mcpTestTurn, "completedAtMs": int64(2),
			"item": map[string]any{"id": "mcp-item-1", "type": "mcpToolCall", "server": mcpTestServer,
				"tool": mcpTestTool, "arguments": mcpTestStartedArguments, "status": "failed"},
		})})
		drainMCPTestEvent(t, client, "item/completed")
		if calls, bindings := mcpTestStateCounts(client); calls != 0 || bindings != 0 {
			t.Fatalf("state after item completion = %d calls, %d bindings", calls, bindings)
		}
	})

	t.Run("turn terminal", func(t *testing.T) {
		client, _ := newMCPProtocolTestClient()
		startMCPTestCall(t, client, "mcp-item-1", mcpTestStartedArguments)
		client.dispatch(wireMessage{Method: "turn/completed", Params: mustMCPTestJSON(map[string]any{
			"threadId": mcpTestThread,
			"turn":     map[string]any{"id": mcpTestTurn, "status": "interrupted", "error": nil},
		})})
		drainMCPTestEvent(t, client, "turn/completed")
		if calls, bindings := mcpTestStateCounts(client); calls != 0 || bindings != 0 {
			t.Fatalf("state after terminal turn = %d calls, %d bindings", calls, bindings)
		}
	})

	t.Run("server request resolved", func(t *testing.T) {
		client, _ := newMCPProtocolTestClient()
		startMCPTestCall(t, client, "mcp-item-1", mcpTestStartedArguments)
		dispatchMCPTestElicitation(client, json.RawMessage(`21`), validMCPElicitationObject(mcpTestMetaArguments))
		drainMCPTestEvent(t, client, mcpServerElicitationRequestMethod)
		if calls, bindings := mcpTestStateCounts(client); calls != 1 || bindings != 1 {
			t.Fatalf("bound state = %d calls, %d bindings", calls, bindings)
		}
		client.dispatch(wireMessage{Method: "serverRequest/resolved", Params: mustMCPTestJSON(map[string]any{
			"threadId": mcpTestThread, "requestId": 21,
		})})
		drainMCPTestEvent(t, client, "serverRequest/resolved")
		if calls, bindings := mcpTestStateCounts(client); calls != 0 || bindings != 0 {
			t.Fatalf("state after request resolution = %d calls, %d bindings", calls, bindings)
		}
	})

	t.Run("resolved thread mismatch is ignored", func(t *testing.T) {
		client, _ := newMCPProtocolTestClient()
		startMCPTestCall(t, client, "mcp-item-1", mcpTestStartedArguments)
		dispatchMCPTestElicitation(client, json.RawMessage(`22`), validMCPElicitationObject(mcpTestMetaArguments))
		drainMCPTestEvent(t, client, mcpServerElicitationRequestMethod)
		client.dispatch(wireMessage{Method: "serverRequest/resolved", Params: mustMCPTestJSON(map[string]any{
			"threadId": "other-thread", "requestId": 22,
		})})
		drainMCPTestEvent(t, client, "serverRequest/resolved")
		if calls, bindings := mcpTestStateCounts(client); calls != 1 || bindings != 1 {
			t.Fatalf("mismatched resolution changed state = %d calls, %d bindings", calls, bindings)
		}
	})
}

func TestMCPElicitationTrackerConcurrentLifecycle(t *testing.T) {
	client, _ := newMCPProtocolTestClient()
	const calls = 128
	var group sync.WaitGroup
	for index := 0; index < calls; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			itemID := fmt.Sprintf("mcp-item-%03d", index)
			client.recordMCPLifecycle(mcpTestStartedMessage(itemID, json.RawMessage(fmt.Sprintf(`{"index":%d}`, index))))
		}()
	}
	group.Wait()
	if tracked, _ := mcpTestStateCounts(client); tracked != calls {
		t.Fatalf("concurrently tracked calls = %d, want %d", tracked, calls)
	}
	for index := 0; index < calls; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			itemID := fmt.Sprintf("mcp-item-%03d", index)
			client.recordMCPLifecycle(wireMessage{Method: "item/completed", Params: mustMCPTestJSON(map[string]any{
				"threadId": mcpTestThread, "turnId": mcpTestTurn,
				"item": map[string]any{"id": itemID, "type": "mcpToolCall"},
			})})
		}()
	}
	group.Wait()
	if tracked, bindings := mcpTestStateCounts(client); tracked != 0 || bindings != 0 {
		t.Fatalf("concurrently cleaned state = %d calls, %d bindings", tracked, bindings)
	}
}

func TestMCPElicitationApprovalRejectsUnaugmentedOrTamperedEvent(t *testing.T) {
	object := validMCPElicitationObject(mcpTestMetaArguments)
	if _, err := approvalResponse(Event{Method: mcpServerElicitationRequestMethod, Params: mustMCPTestJSON(object)}, "accept"); err == nil {
		t.Fatal("unaugmented elicitation was accepted by approvalResponse")
	}
	object["itemId"] = "mcp-item-1"
	object["server"] = mcpTestServer
	object["tool"] = mcpTestTool
	object["arguments"] = json.RawMessage(`{"run_id":"tampered","stage_attempt_id":"stage-1"}`)
	if _, err := approvalResponse(Event{Method: mcpServerElicitationRequestMethod, Params: mustMCPTestJSON(object)}, "accept"); err == nil {
		t.Fatal("tampered elicitation arguments were accepted by approvalResponse")
	}
}
