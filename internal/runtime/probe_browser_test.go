package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestStdioBrowserProbeCompletesMCPListPages(t *testing.T) {
	assigned := false
	probe := StdioBrowserProbe{
		Endpoint: "http://127.0.0.1:54321", Timeout: 5 * time.Second,
		AfterStart: func(pid int) error {
			assigned = pid > 0
			return nil
		},
	}
	evidence, err := probe.ProbeBrowser(context.Background(), ProcessPaths{
		ChromeDevtoolsMCP: Command{
			Path: os.Args[0], Args: []string{"-test.run=^TestRuntimeBrowserProbeHelper$", "--", "browser-probe-helper"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !assigned || !evidence.Executed || !evidence.Compatible || evidence.Observation == "" {
		t.Fatalf("browser probe evidence = %#v assigned=%v", evidence, assigned)
	}
}

func TestStdioBrowserProbeCanRequireFreshPageSnapshot(t *testing.T) {
	probe := StdioBrowserProbe{
		Endpoint: "http://127.0.0.1:54321", Timeout: 5 * time.Second,
		RequirePageSnapshot: true,
	}
	evidence, err := probe.ProbeBrowser(context.Background(), ProcessPaths{
		ChromeDevtoolsMCP: Command{
			Path: os.Args[0], Args: []string{"-test.run=^TestRuntimeBrowserProbeHelper$", "--", "browser-probe-helper"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !evidence.Executed || !evidence.Compatible || evidence.Observation != "re-observed live internet WebView2 with list_pages and take_snapshot through Chrome DevTools MCP" {
		t.Fatalf("page re-observation evidence = %#v", evidence)
	}
}

func TestStdioBrowserProbeRejectsMissingFreshPageSnapshot(t *testing.T) {
	probe := StdioBrowserProbe{
		Endpoint: "http://127.0.0.1:54321", Timeout: 5 * time.Second,
		RequirePageSnapshot: true,
	}
	_, err := probe.ProbeBrowser(context.Background(), ProcessPaths{
		ChromeDevtoolsMCP: Command{
			Path: os.Args[0], Args: []string{"-test.run=^TestRuntimeBrowserProbeHelper$", "--", "browser-probe-helper-no-snapshot"},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "does not expose take_snapshot") {
		t.Fatalf("candidate without take_snapshot was accepted: %v", err)
	}
}

func TestStdioBrowserProbeRejectsNonLoopbackEndpoint(t *testing.T) {
	probe := StdioBrowserProbe{Endpoint: "http://192.168.1.5:9222"}
	if _, err := probe.ProbeBrowser(context.Background(), ProcessPaths{}); err == nil {
		t.Fatal("browser runtime probe accepted a non-loopback CDP endpoint")
	}
}

func TestRuntimeBrowserProbeHelper(t *testing.T) {
	withSnapshot := slices.Contains(os.Args, "browser-probe-helper")
	withoutSnapshot := slices.Contains(os.Args, "browser-probe-helper-no-snapshot")
	if !withSnapshot && !withoutSnapshot {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var request struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil || request.ID == 0 {
			continue
		}
		var result any
		switch request.Method {
		case "initialize":
			result = map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "serverInfo": map[string]string{"name": "test-devtools"}}
		case "tools/list":
			tools := []map[string]any{{"name": "list_pages", "inputSchema": map[string]any{"type": "object"}}}
			if withSnapshot {
				tools = append(tools, map[string]any{"name": "take_snapshot", "inputSchema": map[string]any{"type": "object"}})
			}
			result = map[string]any{"tools": tools}
		case "tools/call":
			result = map[string]any{"content": []map[string]string{{"type": "text", "text": "1: about:blank"}}, "isError": false}
		default:
			result = map[string]any{}
		}
		_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
	}
	os.Exit(0)
}
