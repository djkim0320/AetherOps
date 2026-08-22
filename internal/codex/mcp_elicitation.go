package codex

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"sync"
)

const mcpServerElicitationRequestMethod = "mcpServer/elicitation/request"

type mcpToolCallIdentity struct {
	threadID string
	turnID   string
	itemID   string
}

type trackedMCPToolCall struct {
	identity           mcpToolCallIdentity
	server             string
	tool               string
	arguments          json.RawMessage
	canonicalArguments string
	approvalRequestKey string
}

type mcpElicitationState struct {
	mu              sync.Mutex
	calls           map[mcpToolCallIdentity]trackedMCPToolCall
	requestBindings map[string]mcpToolCallIdentity
}

type parsedMCPElicitation struct {
	object                  map[string]json.RawMessage
	threadID                string
	turnID                  string
	server                  string
	canonicalToolParameters string
}

func (c *Client) recordMCPLifecycle(message wireMessage) {
	switch message.Method {
	case "item/started":
		var payload struct {
			ThreadID string `json:"threadId"`
			TurnID   string `json:"turnId"`
			Item     struct {
				ID        string          `json:"id"`
				Type      string          `json:"type"`
				Server    string          `json:"server"`
				Tool      string          `json:"tool"`
				Arguments json.RawMessage `json:"arguments"`
			} `json:"item"`
		}
		if json.Unmarshal(message.Params, &payload) != nil || payload.Item.Type != "mcpToolCall" ||
			payload.ThreadID == "" || payload.TurnID == "" || payload.Item.ID == "" ||
			payload.Item.Server == "" || payload.Item.Tool == "" {
			return
		}
		canonical, err := canonicalJSONObject(payload.Item.Arguments)
		if err != nil {
			return
		}
		call := trackedMCPToolCall{
			identity: mcpToolCallIdentity{
				threadID: payload.ThreadID,
				turnID:   payload.TurnID,
				itemID:   payload.Item.ID,
			},
			server:             payload.Item.Server,
			tool:               payload.Item.Tool,
			arguments:          cloneRaw(payload.Item.Arguments),
			canonicalArguments: canonical,
		}
		c.mcpElicitations.track(call)
	case "item/completed":
		var payload struct {
			ThreadID string `json:"threadId"`
			TurnID   string `json:"turnId"`
			Item     struct {
				ID   string `json:"id"`
				Type string `json:"type"`
			} `json:"item"`
		}
		if json.Unmarshal(message.Params, &payload) == nil && payload.Item.Type == "mcpToolCall" &&
			payload.ThreadID != "" && payload.TurnID != "" && payload.Item.ID != "" {
			c.mcpElicitations.removeCall(mcpToolCallIdentity{
				threadID: payload.ThreadID,
				turnID:   payload.TurnID,
				itemID:   payload.Item.ID,
			})
		}
	case "turn/completed":
		var payload struct {
			ThreadID string `json:"threadId"`
			Turn     struct {
				ID string `json:"id"`
			} `json:"turn"`
		}
		if json.Unmarshal(message.Params, &payload) == nil && payload.ThreadID != "" && payload.Turn.ID != "" {
			c.mcpElicitations.removeTurn(payload.ThreadID, payload.Turn.ID)
		}
	case "serverRequest/resolved":
		var payload struct {
			ThreadID  string          `json:"threadId"`
			RequestID json.RawMessage `json:"requestId"`
		}
		if json.Unmarshal(message.Params, &payload) != nil || payload.ThreadID == "" {
			return
		}
		requestKey, ok := mcpRequestIDKey(payload.RequestID)
		if ok {
			c.mcpElicitations.removeRequest(requestKey, payload.ThreadID)
		}
	}
}

func (state *mcpElicitationState) track(call trackedMCPToolCall) {
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.calls == nil {
		state.calls = make(map[mcpToolCallIdentity]trackedMCPToolCall)
	}
	if previous, found := state.calls[call.identity]; found {
		if previous.server == call.server && previous.tool == call.tool &&
			previous.canonicalArguments == call.canonicalArguments {
			return
		}
		state.removeCallLocked(call.identity)
		return
	}
	state.calls[call.identity] = call
}

func (state *mcpElicitationState) uniqueUnboundCall(
	threadID, turnID, server, canonicalArguments, requestKey string,
) (trackedMCPToolCall, bool) {
	state.mu.Lock()
	defer state.mu.Unlock()
	if _, duplicateRequest := state.requestBindings[requestKey]; duplicateRequest {
		return trackedMCPToolCall{}, false
	}
	var match trackedMCPToolCall
	matches := 0
	for _, call := range state.calls {
		if call.identity.threadID != threadID || call.identity.turnID != turnID ||
			call.server != server || call.canonicalArguments != canonicalArguments {
			continue
		}
		match = call
		matches++
		if matches > 1 {
			return trackedMCPToolCall{}, false
		}
	}
	if matches != 1 || match.approvalRequestKey != "" {
		return trackedMCPToolCall{}, false
	}
	if state.requestBindings == nil {
		state.requestBindings = make(map[string]mcpToolCallIdentity)
	}
	match.approvalRequestKey = requestKey
	state.calls[match.identity] = match
	state.requestBindings[requestKey] = match.identity
	return match, true
}

func (state *mcpElicitationState) removeCall(identity mcpToolCallIdentity) {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.removeCallLocked(identity)
}

func (state *mcpElicitationState) removeCallLocked(identity mcpToolCallIdentity) {
	call, found := state.calls[identity]
	if !found {
		return
	}
	delete(state.calls, identity)
	if call.approvalRequestKey != "" {
		delete(state.requestBindings, call.approvalRequestKey)
	}
}

func (state *mcpElicitationState) removeTurn(threadID, turnID string) {
	state.mu.Lock()
	defer state.mu.Unlock()
	for identity := range state.calls {
		if identity.threadID == threadID && identity.turnID == turnID {
			state.removeCallLocked(identity)
		}
	}
}

func (state *mcpElicitationState) removeRequest(requestKey, threadID string) {
	state.mu.Lock()
	defer state.mu.Unlock()
	identity, found := state.requestBindings[requestKey]
	if !found || identity.threadID != threadID {
		return
	}
	state.removeCallLocked(identity)
}

func (state *mcpElicitationState) clear() {
	state.mu.Lock()
	state.calls = nil
	state.requestBindings = nil
	state.mu.Unlock()
}

func (c *Client) prepareMCPElicitation(event Event) (Event, bool) {
	parsed, err := parseMCPElicitation(event.Params, false)
	if err != nil {
		return Event{}, false
	}
	requestKey, ok := mcpRequestIDKey(event.RequestID)
	if !ok {
		return Event{}, false
	}
	call, ok := c.mcpElicitations.uniqueUnboundCall(
		parsed.threadID,
		parsed.turnID,
		parsed.server,
		parsed.canonicalToolParameters,
		requestKey,
	)
	if !ok {
		return Event{}, false
	}
	parsed.object["itemId"], _ = json.Marshal(call.identity.itemID)
	parsed.object["server"], _ = json.Marshal(call.server)
	parsed.object["tool"], _ = json.Marshal(call.tool)
	parsed.object["arguments"] = cloneRaw(call.arguments)
	params, err := json.Marshal(parsed.object)
	if err != nil {
		c.mcpElicitations.removeRequest(requestKey, parsed.threadID)
		return Event{}, false
	}
	event.Params = params
	return event, true
}

func parseMCPElicitation(raw json.RawMessage, augmented bool) (parsedMCPElicitation, error) {
	object, err := decodeJSONObject(raw)
	if err != nil {
		return parsedMCPElicitation{}, errors.New("elicitation params must be a unique-key JSON object")
	}
	for _, reserved := range []string{"itemId", "server", "tool", "arguments"} {
		_, found := object[reserved]
		if found != augmented {
			if augmented {
				return parsedMCPElicitation{}, fmt.Errorf("augmented elicitation is missing %s", reserved)
			}
			return parsedMCPElicitation{}, fmt.Errorf("untrusted elicitation contains reserved field %s", reserved)
		}
	}
	for _, alias := range []string{
		"mcpServer", "toolName", "toolArguments", "args", "reason", "summary",
	} {
		if _, found := object[alias]; found {
			return parsedMCPElicitation{}, fmt.Errorf("elicitation contains forbidden approval alias %s", alias)
		}
	}
	mode, err := requiredJSONString(object, "mode")
	if err != nil || mode != "form" {
		return parsedMCPElicitation{}, errors.New("elicitation mode must be form")
	}
	threadID, err := requiredJSONString(object, "threadId")
	if err != nil || threadID == "" {
		return parsedMCPElicitation{}, errors.New("elicitation threadId is required")
	}
	turnID, err := requiredJSONString(object, "turnId")
	if err != nil || turnID == "" {
		return parsedMCPElicitation{}, errors.New("elicitation turnId is required")
	}
	server, err := requiredJSONString(object, "serverName")
	if err != nil || server == "" {
		return parsedMCPElicitation{}, errors.New("elicitation serverName is required")
	}
	message, err := requiredJSONString(object, "message")
	if err != nil || message == "" {
		return parsedMCPElicitation{}, errors.New("elicitation message is required")
	}
	if err := validateEmptyObjectSchema(object["requestedSchema"]); err != nil {
		return parsedMCPElicitation{}, err
	}
	meta, err := decodeJSONObject(object["_meta"])
	if err != nil {
		return parsedMCPElicitation{}, errors.New("elicitation _meta must be a unique-key JSON object")
	}
	kind, err := requiredJSONString(meta, "codex_approval_kind")
	if err != nil || kind != "mcp_tool_call" {
		return parsedMCPElicitation{}, errors.New("elicitation approval kind must be mcp_tool_call")
	}
	canonicalToolParameters, err := canonicalJSONObject(meta["tool_params"])
	if err != nil {
		return parsedMCPElicitation{}, errors.New("elicitation tool_params must be a unique-key JSON object")
	}
	return parsedMCPElicitation{
		object:                  object,
		threadID:                threadID,
		turnID:                  turnID,
		server:                  server,
		canonicalToolParameters: canonicalToolParameters,
	}, nil
}

func validateAugmentedMCPElicitation(raw json.RawMessage) error {
	parsed, err := parseMCPElicitation(raw, true)
	if err != nil {
		return err
	}
	itemID, err := requiredJSONString(parsed.object, "itemId")
	if err != nil || itemID == "" {
		return errors.New("elicitation itemId is required")
	}
	server, err := requiredJSONString(parsed.object, "server")
	if err != nil || server != parsed.server {
		return errors.New("elicitation server does not match serverName")
	}
	tool, err := requiredJSONString(parsed.object, "tool")
	if err != nil || tool == "" {
		return errors.New("elicitation tool is required")
	}
	arguments, err := canonicalJSONObject(parsed.object["arguments"])
	if err != nil || arguments != parsed.canonicalToolParameters {
		return errors.New("elicitation arguments do not match tool_params")
	}
	return nil
}

func validateEmptyObjectSchema(raw json.RawMessage) error {
	schema, err := decodeJSONObject(raw)
	if err != nil || len(schema) != 2 {
		return errors.New("elicitation requestedSchema must be the empty object schema")
	}
	typeName, err := requiredJSONString(schema, "type")
	if err != nil || typeName != "object" {
		return errors.New("elicitation requestedSchema type must be object")
	}
	properties, err := decodeJSONObject(schema["properties"])
	if err != nil || len(properties) != 0 {
		return errors.New("elicitation requestedSchema properties must be empty")
	}
	return nil
}

func requiredJSONString(object map[string]json.RawMessage, key string) (string, error) {
	raw, found := object[key]
	if !found {
		return "", fmt.Errorf("missing %s", key)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("%s must be a string", key)
	}
	return value, nil
}

func canonicalJSONObject(raw json.RawMessage) (string, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return "", err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func decodeJSONObject(raw json.RawMessage) (map[string]json.RawMessage, error) {
	if len(raw) == 0 {
		return nil, io.ErrUnexpectedEOF
	}
	if err := validateUniqueJSONKeys(raw); err != nil {
		return nil, err
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return nil, errors.New("JSON value is not an object")
	}
	return object, nil
}

func validateUniqueJSONKeys(raw json.RawMessage) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := consumeUniqueJSONValue(decoder); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON value has trailing data")
		}
		return err
	}
	return nil
}

func consumeUniqueJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is not a string")
			}
			if _, duplicate := seen[key]; duplicate {
				return fmt.Errorf("duplicate JSON object key %q", key)
			}
			seen[key] = struct{}{}
			if err := consumeUniqueJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim('}') {
			return errors.New("unterminated JSON object")
		}
	case '[':
		for decoder.More() {
			if err := consumeUniqueJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim(']') {
			return errors.New("unterminated JSON array")
		}
	default:
		return errors.New("unexpected JSON delimiter")
	}
	return nil
}

func mcpRequestIDKey(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return "s:" + text, text != ""
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) != nil {
		return "", false
	}
	number, ok := value.(json.Number)
	if !ok {
		return "", false
	}
	integer, err := strconv.ParseInt(number.String(), 10, 64)
	if err != nil {
		return "", false
	}
	return "i:" + strconv.FormatInt(integer, 10), true
}

func mcpElicitationApprovalResponse(decision string) any {
	response := struct {
		Action  string `json:"action"`
		Content any    `json:"content"`
	}{Action: decision}
	if decision == "accept" {
		response.Content = map[string]any{}
	}
	return response
}

func (c *Client) declineMCPElicitation(event Event) {
	payload, err := json.Marshal(mcpElicitationApprovalResponse("decline"))
	if err != nil {
		return
	}
	_ = c.writeMessage(wireMessage{ID: cloneRaw(event.RequestID), Result: payload})
}

func (c *Client) clearAllMCPElicitations() {
	c.mcpElicitations.clear()
}
