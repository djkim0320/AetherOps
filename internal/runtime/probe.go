package runtime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/processutil"
)

// AppServerProbe exercises the actual candidate Codex App Server command.
type AppServerProbe interface {
	ProbeAppServer(context.Context, Command) (ProbeEvidence, error)
}

// BrowserProbe must exercise the candidate Chrome DevTools MCP command against
// the application's real browser/CDP environment. Its implementation belongs
// at the browser supervisor boundary, where the live browser endpoint is
// available; this package intentionally supplies no fake browser fallback.
type BrowserProbe interface {
	ProbeBrowser(context.Context, ProcessPaths) (ProbeEvidence, error)
}

// BrowserProbeFunc adapts a real browser-supervisor probe into BrowserProbe.
// Unit tests may inject it to exercise lifecycle policy, but that is not an
// end-to-end release assertion.
type BrowserProbeFunc func(context.Context, ProcessPaths) (ProbeEvidence, error)

func (f BrowserProbeFunc) ProbeBrowser(ctx context.Context, paths ProcessPaths) (ProbeEvidence, error) {
	return f(ctx, paths)
}

// StdioBrowserProbe launches the candidate Chrome DevTools MCP against the
// already-live internet WebView2 CDP endpoint. It completes the MCP handshake,
// discovers list_pages, and calls it; a process launch or version string alone
// is not compatibility evidence.
type StdioBrowserProbe struct {
	Endpoint            string
	Timeout             time.Duration
	AfterStart          func(int) error
	RequirePageSnapshot bool
}

func (probe StdioBrowserProbe) ProbeBrowser(ctx context.Context, paths ProcessPaths) (ProbeEvidence, error) {
	endpoint, err := url.Parse(probe.Endpoint)
	if err != nil || endpoint.Scheme != "http" || endpoint.Hostname() != "127.0.0.1" || endpoint.Port() == "" || endpoint.User != nil || endpoint.Path != "" {
		return ProbeEvidence{}, errors.New("browser compatibility probe requires an explicit IPv4 loopback CDP endpoint")
	}
	if paths.ChromeDevtoolsMCP.Path == "" {
		return ProbeEvidence{}, errors.New("candidate Chrome DevTools MCP command path is empty")
	}
	timeout := probe.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	probeContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	arguments := append(append([]string(nil), paths.ChromeDevtoolsMCP.Args...),
		"--browser-url="+probe.Endpoint, "--no-usage-statistics")
	process := exec.CommandContext(probeContext, paths.ChromeDevtoolsMCP.Path, arguments...)
	processutil.ConfigureNoWindow(process)
	stdin, err := process.StdinPipe()
	if err != nil {
		return ProbeEvidence{}, err
	}
	stdout, err := process.StdoutPipe()
	if err != nil {
		return ProbeEvidence{}, err
	}
	process.Stderr = io.Discard
	if err := process.Start(); err != nil {
		return ProbeEvidence{}, fmt.Errorf("start candidate Chrome DevTools MCP: %w", err)
	}
	if probe.AfterStart != nil {
		if err := probe.AfterStart(process.Process.Pid); err != nil {
			_ = process.Process.Kill()
			_ = process.Wait()
			return ProbeEvidence{}, fmt.Errorf("supervise candidate Chrome DevTools MCP: %w", err)
		}
	}
	defer func() {
		_ = stdin.Close()
		if process.Process != nil {
			_ = process.Process.Kill()
		}
		_ = process.Wait()
	}()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	initialize := map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize",
		"params": map[string]any{
			"protocolVersion": "2025-06-18", "capabilities": map[string]any{},
			"clientInfo": map[string]string{"name": "aetherops-runtime-probe", "version": "v2"},
		},
	}
	if _, err := mcpRequest(stdin, scanner, initialize, 1); err != nil {
		return ProbeEvidence{}, fmt.Errorf("initialize candidate Chrome DevTools MCP: %w", err)
	}
	if err := writeJSONLine(stdin, map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}); err != nil {
		return ProbeEvidence{}, err
	}
	result, err := mcpRequest(stdin, scanner,
		map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": map[string]any{}}, 2)
	if err != nil {
		return ProbeEvidence{}, fmt.Errorf("list candidate Chrome DevTools MCP tools: %w", err)
	}
	var toolsResult struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(result, &toolsResult); err != nil {
		return ProbeEvidence{}, fmt.Errorf("decode candidate Chrome DevTools MCP tools: %w", err)
	}
	found := false
	foundSnapshot := false
	for _, tool := range toolsResult.Tools {
		if tool.Name == "list_pages" {
			found = true
		}
		if tool.Name == "take_snapshot" {
			foundSnapshot = true
		}
	}
	if !found {
		return ProbeEvidence{}, errors.New("candidate Chrome DevTools MCP does not expose list_pages")
	}
	if probe.RequirePageSnapshot && !foundSnapshot {
		return ProbeEvidence{}, errors.New("candidate Chrome DevTools MCP does not expose take_snapshot")
	}
	result, err = mcpRequest(stdin, scanner, map[string]any{
		"jsonrpc": "2.0", "id": 3, "method": "tools/call",
		"params": map[string]any{"name": "list_pages", "arguments": map[string]any{}},
	}, 3)
	if err != nil {
		return ProbeEvidence{}, fmt.Errorf("call candidate Chrome DevTools MCP list_pages: %w", err)
	}
	if len(bytes.TrimSpace(result)) == 0 || string(bytes.TrimSpace(result)) == "null" {
		return ProbeEvidence{}, errors.New("candidate Chrome DevTools MCP list_pages returned no result")
	}
	if err := validateBrowserObservationResult(result, "list_pages"); err != nil {
		return ProbeEvidence{}, err
	}
	observation := "initialized candidate Chrome DevTools MCP and called list_pages against live internet WebView2 CDP"
	if probe.RequirePageSnapshot {
		result, err = mcpRequest(stdin, scanner, map[string]any{
			"jsonrpc": "2.0", "id": 4, "method": "tools/call",
			"params": map[string]any{"name": "take_snapshot", "arguments": map[string]any{}},
		}, 4)
		if err != nil {
			return ProbeEvidence{}, fmt.Errorf("call candidate Chrome DevTools MCP take_snapshot: %w", err)
		}
		if err := validateBrowserObservationResult(result, "take_snapshot"); err != nil {
			return ProbeEvidence{}, err
		}
		observation = "re-observed live internet WebView2 with list_pages and take_snapshot through Chrome DevTools MCP"
	}
	return ProbeEvidence{
		Executed: true, Compatible: true,
		Observation: observation,
		ObservedAt:  time.Now().UTC(),
	}, nil
}

func validateBrowserObservationResult(result json.RawMessage, tool string) error {
	if len(bytes.TrimSpace(result)) == 0 || string(bytes.TrimSpace(result)) == "null" {
		return fmt.Errorf("candidate Chrome DevTools MCP %s returned no result", tool)
	}
	var callResult struct {
		IsError bool              `json:"isError"`
		Content []json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(result, &callResult); err != nil {
		return fmt.Errorf("decode candidate Chrome DevTools MCP %s result: %w", tool, err)
	}
	if callResult.IsError {
		return fmt.Errorf("candidate Chrome DevTools MCP %s reported an error", tool)
	}
	if len(callResult.Content) == 0 {
		return fmt.Errorf("candidate Chrome DevTools MCP %s returned no observation content", tool)
	}
	return nil
}

func mcpRequest(stdin io.Writer, scanner *bufio.Scanner, request any, id int) (json.RawMessage, error) {
	if err := writeJSONLine(stdin, request); err != nil {
		return nil, err
	}
	for scanner.Scan() {
		var message struct {
			ID     json.RawMessage `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			continue
		}
		if strings.TrimSpace(string(message.ID)) != fmt.Sprintf("%d", id) {
			continue
		}
		if len(message.Error) != 0 && string(bytes.TrimSpace(message.Error)) != "null" {
			return nil, fmt.Errorf("MCP request %d returned an error", id)
		}
		if len(message.Result) == 0 {
			return nil, fmt.Errorf("MCP request %d returned no result", id)
		}
		return append(json.RawMessage(nil), message.Result...), nil
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return nil, errors.New("candidate MCP exited before responding")
}

func writeJSONLine(writer io.Writer, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = writer.Write(append(encoded, '\n'))
	return err
}

// LiveCompatibilityProbe composes a real JSON-RPC App Server initialization
// handshake with a browser-specific MCP/CDP probe. Browser is mandatory;
// AppServer defaults to StdioAppServerProbe, never a version-string check.
type LiveCompatibilityProbe struct {
	AppServer AppServerProbe
	Browser   BrowserProbe
	Timeout   time.Duration
}

func (p LiveCompatibilityProbe) Probe(ctx context.Context, paths ProcessPaths) (ProbeReport, error) {
	if p.Browser == nil {
		return ProbeReport{}, errors.New("live browser compatibility probe is required")
	}
	appServer := p.AppServer
	if appServer == nil {
		appServer = StdioAppServerProbe{Timeout: p.Timeout}
	}
	appEvidence, err := appServer.ProbeAppServer(ctx, paths.CodexAppServer)
	if err != nil {
		return ProbeReport{}, fmt.Errorf("probe candidate App Server: %w", err)
	}
	browserEvidence, err := p.Browser.ProbeBrowser(ctx, paths)
	if err != nil {
		return ProbeReport{}, fmt.Errorf("probe candidate browser/MCP compatibility: %w", err)
	}
	report := ProbeReport{AppServer: appEvidence, Browser: browserEvidence}
	if err := validateProbeReport(report); err != nil {
		return ProbeReport{}, err
	}
	return report, nil
}

// RequiredAppServerModel is one exact model/effort pair that a candidate
// App Server must advertise before the runtime can be staged.
type RequiredAppServerModel struct {
	Model  string
	Effort string
}

// StdioAppServerProbe performs an actual process launch, stable JSON-RPC
// initialize/initialized handshake, and complete model/list readback. It does
// not use Codex experimental APIs or accept a substitute model/effort.
type StdioAppServerProbe struct {
	Timeout        time.Duration
	AfterStart     func(int) error
	Env            []string
	RequiredModels []RequiredAppServerModel
}

func (p StdioAppServerProbe) ProbeAppServer(ctx context.Context, command Command) (ProbeEvidence, error) {
	if command.Path == "" {
		return ProbeEvidence{}, errors.New("candidate App Server command path is empty")
	}
	timeout := p.Timeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	probeContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	process := exec.CommandContext(probeContext, command.Path, command.Args...)
	processutil.ConfigureNoWindow(process)
	process.Env = mergeProbeEnvironment(os.Environ(), p.Env)
	stdin, err := process.StdinPipe()
	if err != nil {
		return ProbeEvidence{}, err
	}
	stdout, err := process.StdoutPipe()
	if err != nil {
		return ProbeEvidence{}, err
	}
	process.Stderr = io.Discard
	if err := process.Start(); err != nil {
		return ProbeEvidence{}, fmt.Errorf("start candidate App Server: %w", err)
	}
	if p.AfterStart != nil {
		if err := p.AfterStart(process.Process.Pid); err != nil {
			_ = process.Process.Kill()
			_ = process.Wait()
			return ProbeEvidence{}, fmt.Errorf("supervise candidate App Server: %w", err)
		}
	}
	defer func() {
		_ = stdin.Close()
		if process.Process != nil {
			_ = process.Process.Kill()
		}
		_ = process.Wait()
	}()

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	initialize := map[string]any{
		"id":     1,
		"method": "initialize",
		"params": map[string]any{
			"clientInfo": map[string]string{
				"name":    "aetherops-runtime-probe",
				"title":   "AetherOps runtime probe",
				"version": "v2",
			},
		},
	}
	if _, err := appServerRequest(stdin, scanner, initialize, 1); err != nil {
		return ProbeEvidence{}, fmt.Errorf("initialize candidate App Server: %w", err)
	}
	if err := writeJSONLine(stdin, map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
		return ProbeEvidence{}, fmt.Errorf("write App Server initialized notification: %w", err)
	}
	if err := probeRequiredAppServerModels(stdin, scanner, p.RequiredModels); err != nil {
		return ProbeEvidence{}, err
	}
	return ProbeEvidence{
		Executed:    true,
		Compatible:  true,
		Observation: "initialized candidate App Server and verified all required model/list model-effort pairs",
		ObservedAt:  time.Now().UTC(),
	}, nil
}

func appServerRequest(stdin io.Writer, scanner *bufio.Scanner, request any, id int) (json.RawMessage, error) {
	if err := writeJSONLine(stdin, request); err != nil {
		return nil, err
	}
	for scanner.Scan() {
		var message struct {
			ID     json.RawMessage `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			continue
		}
		if string(bytes.TrimSpace(message.ID)) != fmt.Sprintf("%d", id) {
			continue
		}
		if len(message.Error) != 0 && string(bytes.TrimSpace(message.Error)) != "null" {
			return nil, fmt.Errorf("candidate App Server request %d returned an error", id)
		}
		if len(message.Result) == 0 || string(bytes.TrimSpace(message.Result)) == "null" {
			return nil, fmt.Errorf("candidate App Server request %d returned no result", id)
		}
		return append(json.RawMessage(nil), message.Result...), nil
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read candidate App Server stdout: %w", err)
	}
	return nil, errors.New("candidate App Server exited before responding")
}

func probeRequiredAppServerModels(
	stdin io.Writer,
	scanner *bufio.Scanner,
	required []RequiredAppServerModel,
) error {
	if len(required) == 0 {
		return errors.New("candidate App Server probe requires an explicit model contract")
	}
	type modelEntry struct {
		ID                        string `json:"id"`
		Hidden                    bool   `json:"hidden"`
		SupportedReasoningEfforts []struct {
			ReasoningEffort string `json:"reasoningEffort"`
		} `json:"supportedReasoningEfforts"`
	}
	type modelPage struct {
		Data       []modelEntry `json:"data"`
		NextCursor *string      `json:"nextCursor"`
	}
	available := make(map[string]map[string]struct{})
	seenCursors := make(map[string]struct{})
	cursor := ""
	requestID := 2
	for {
		params := map[string]any{"limit": 100, "includeHidden": false}
		if cursor != "" {
			params["cursor"] = cursor
		}
		result, err := appServerRequest(stdin, scanner, map[string]any{
			"id": requestID, "method": "model/list", "params": params,
		}, requestID)
		if err != nil {
			return fmt.Errorf("list candidate App Server models: %w", err)
		}
		var page modelPage
		if err := json.Unmarshal(result, &page); err != nil {
			return fmt.Errorf("decode candidate App Server model/list: %w", err)
		}
		for _, model := range page.Data {
			if model.Hidden || strings.TrimSpace(model.ID) == "" {
				continue
			}
			efforts := available[model.ID]
			if efforts == nil {
				efforts = make(map[string]struct{})
				available[model.ID] = efforts
			}
			for _, effort := range model.SupportedReasoningEfforts {
				if effort.ReasoningEffort != "" {
					efforts[effort.ReasoningEffort] = struct{}{}
				}
			}
		}
		if page.NextCursor == nil || strings.TrimSpace(*page.NextCursor) == "" {
			break
		}
		next := strings.TrimSpace(*page.NextCursor)
		if _, duplicate := seenCursors[next]; duplicate {
			return errors.New("candidate App Server model/list repeated a cursor")
		}
		seenCursors[next] = struct{}{}
		cursor = next
		requestID++
	}
	seenRequired := make(map[string]struct{}, len(required))
	for _, model := range required {
		modelID := strings.TrimSpace(model.Model)
		effort := strings.TrimSpace(model.Effort)
		if modelID == "" || effort == "" {
			return errors.New("candidate App Server model contract contains an empty model or effort")
		}
		key := modelID + "\x00" + effort
		if _, duplicate := seenRequired[key]; duplicate {
			return errors.New("candidate App Server model contract repeats a model-effort pair")
		}
		seenRequired[key] = struct{}{}
		if _, ok := available[modelID][effort]; !ok {
			return fmt.Errorf("candidate App Server is missing required model %q reasoning effort %q", modelID, effort)
		}
	}
	return nil
}

func mergeProbeEnvironment(base, overrides []string) []string {
	result := append([]string(nil), base...)
	for _, override := range overrides {
		separator := strings.IndexByte(override, '=')
		if separator <= 0 {
			continue
		}
		key := override[:separator]
		filtered := result[:0]
		for _, existing := range result {
			existingSeparator := strings.IndexByte(existing, '=')
			if existingSeparator > 0 && strings.EqualFold(existing[:existingSeparator], key) {
				continue
			}
			filtered = append(filtered, existing)
		}
		result = append(filtered, override)
	}
	return result
}
