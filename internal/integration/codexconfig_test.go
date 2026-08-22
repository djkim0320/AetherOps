package integration

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestDedicatedCodexConfigPinsCredentialStoreAndMCPCommands(t *testing.T) {
	root := t.TempDir()
	err := WriteCodexMCPConfig(CodexMCPConfig{
		CodexHome: root, AetherOpsExecutable: `C:\Program Files\AetherOps\aetherops.exe`,
		InternetCDPEndpoint: "http://127.0.0.1:54321",
	})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	config := string(data)
	for _, required := range []string{
		`cli_auth_credentials_store = "keyring"`,
		"[features]", "code_mode_host = true",
		"[mcp_servers.aetherops_internal]", "[mcp_servers.aetherops_engineering]", "[mcp_servers.chrome_devtools]",
		`enabled_tools = ["memory_search", "memory_get", "scholarly_search", "evidence_capture", "artifact_publish_plan", "artifact_publish_evidence", "artifact_publish_report", "artifact_publish_review", "knowledge_sparql", "knowledge_get", "tool_package_propose", "tool_catalog", "tool_get", "tool_run"]`,
		`enabled_tools = ["engineering_capabilities", "engineering_get", "openvsp_wing_aero", "openvsp_modify_wing", "gmsh_wing_mesh", "xfoil_polar", "su2_naca0012"]`,
		`args = ["engineering-mcp"]`,
		`args = ["chrome-mcp", "--browser-url=http://127.0.0.1:54321", "--no-usage-statistics"]`, "required = true",
	} {
		if !strings.Contains(config, required) {
			t.Fatalf("dedicated Codex config is missing %q:\n%s", required, config)
		}
	}
	if strings.Contains(config, "code_mode_host = false") {
		t.Fatalf("dedicated Codex config disabled stable App Server MCP ownership:\n%s", config)
	}
	if strings.Contains(config, `default_tools_approval_mode = "auto"`) ||
		strings.Contains(config, `default_tools_approval_mode = "approve"`) {
		t.Fatalf("MCP calls must not bypass the App Server approval router:\n%s", config)
	}
	if got := strings.Count(config, `default_tools_approval_mode = "prompt"`); got != 3 {
		t.Fatalf("all three MCP servers must route through stable approvals, got %d:\n%s", got, config)
	}
}

func TestDedicatedCodexConfigRejectsNonLoopbackCDP(t *testing.T) {
	err := WriteCodexMCPConfig(CodexMCPConfig{
		CodexHome: t.TempDir(), AetherOpsExecutable: `C:\AetherOps\aetherops.exe`,
		InternetCDPEndpoint: "http://0.0.0.0:9222",
	})
	if err == nil {
		t.Fatal("non-loopback CDP endpoint was accepted")
	}
}

func TestDedicatedCodexConfigBindsEvaluationChildrenToExplicitDataRoot(t *testing.T) {
	home := t.TempDir()
	dataRoot := filepath.Join(t.TempDir(), "evaluation-data")
	if err := WriteCodexMCPConfig(CodexMCPConfig{
		CodexHome: home, AetherOpsExecutable: `C:\Program Files\AetherOps\aetherops.exe`,
		InternetCDPEndpoint: "http://127.0.0.1:9333", EvaluationDataRoot: dataRoot,
	}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	if strings.Count(content, strconv.Quote(dataRoot)) != 3 || strings.Contains(content, "AETHEROPS_DATA_DIR") {
		t.Fatalf("evaluation MCP data-root binding is incomplete: %s", content)
	}
}
