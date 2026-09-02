package integration

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type CodexMCPConfig struct {
	CodexHome           string
	AetherOpsExecutable string
	InternetCDPEndpoint string
	EvaluationDataRoot  string
}

// WriteCodexMCPConfig replaces only the dedicated AetherOps CODEX_HOME
// configuration. It never reads or merges the user's normal Codex settings.
func WriteCodexMCPConfig(config CodexMCPConfig) error {
	for label, value := range map[string]string{
		"Codex home":            config.CodexHome,
		"AetherOps executable":  config.AetherOpsExecutable,
		"internet CDP endpoint": config.InternetCDPEndpoint,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", label)
		}
	}
	if !strings.HasPrefix(config.InternetCDPEndpoint, "http://127.0.0.1:") {
		return errors.New("internet CDP endpoint must use an explicit IPv4 loopback address")
	}
	if err := os.MkdirAll(config.CodexHome, 0o700); err != nil {
		return err
	}
	internalArgs := []string{"mcp"}
	engineeringArgs := []string{"engineering-mcp"}
	chromeArgs := []string{"chrome-mcp", "--browser-url=" + config.InternetCDPEndpoint, "--no-usage-statistics"}
	if strings.TrimSpace(config.EvaluationDataRoot) != "" {
		root, err := filepath.Abs(strings.TrimSpace(config.EvaluationDataRoot))
		if err != nil || !filepath.IsAbs(root) {
			return errors.New("evaluation data root must be an absolute path")
		}
		internalArgs = append(internalArgs, "--data-root", root)
		engineeringArgs = append(engineeringArgs, "--data-root", root)
		chromeArgs = append(chromeArgs, "--data-root", root)
	}
	lines := []string{
		"cli_auth_credentials_store = \"keyring\"",
		"",
		"[features]",
		// The stable code-mode host owns configured MCP clients inside App
		// Server. AetherOps deliberately does not implement the experimental
		// dynamicTools/item/tool/call client-hosted execution surface.
		"code_mode_host = true",
		"",
		"[mcp_servers.aetherops_internal]",
		"command = " + strconv.Quote(config.AetherOpsExecutable),
		"args = " + tomlStringArray(internalArgs),
		"enabled = true",
		"required = true",
		// Every MCP call is surfaced through the stable App Server approval
		// request so AetherOps remains the single policy and audit authority.
		// The router immediately accepts this deliberately small internal surface.
		"default_tools_approval_mode = \"prompt\"",
		"enabled_tools = " + tomlStringArray([]string{
			"memory_search", "memory_get", "scholarly_search", "evidence_capture",
			"artifact_publish_plan", "artifact_publish_evidence",
			"artifact_publish_report", "artifact_publish_review",
			"knowledge_sparql", "knowledge_get", "tool_package_propose", "tool_catalog", "tool_get", "tool_run",
		}),
		"startup_timeout_sec = 30",
		"tool_timeout_sec = 120",
		"",
		"[mcp_servers.aetherops_engineering]",
		"command = " + strconv.Quote(config.AetherOpsExecutable),
		"args = " + tomlStringArray(engineeringArgs),
		"enabled = true",
		"required = true",
		// Real solver calls must surface a stable App Server MCP approval. The
		// router automatically accepts the read-only capability probe and sends
		// exact solver arguments to the user for a durable scoped decision.
		"default_tools_approval_mode = \"prompt\"",
		"enabled_tools = " + tomlStringArray([]string{
			"engineering_capabilities", "engineering_inputs", "engineering_get", "openvsp_wing_aero",
			"openvsp_modify_wing", "gmsh_wing_mesh", "xfoil_polar",
			"su2_cfd",
		}),
		"startup_timeout_sec = 15",
		"tool_timeout_sec = 900",
		"",
		"[mcp_servers.chrome_devtools]",
		"command = " + strconv.Quote(config.AetherOpsExecutable),
		"args = " + tomlStringArray(chromeArgs),
		"enabled = true",
		"required = true",
		// Browser actions are governed by the isolated internet WebView2. They
		// still pass through the router so the owning stage is marked as having
		// crossed an external side-effect boundary before automatic acceptance.
		"default_tools_approval_mode = \"prompt\"",
		"startup_timeout_sec = 20",
		"tool_timeout_sec = 120",
		"",
	}
	content := strings.Join(lines, "\n")
	path := filepath.Join(config.CodexHome, "config.toml")
	temporary, err := os.CreateTemp(config.CodexHome, "config-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return err
	}
	if _, err := temporary.WriteString(content); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		_ = os.Remove(path)
		if replaceErr := os.Rename(temporaryPath, path); replaceErr != nil {
			return errors.Join(err, replaceErr)
		}
	}
	committed = true
	return nil
}

func tomlStringArray(values []string) string {
	quoted := make([]string, len(values))
	for index, value := range values {
		quoted[index] = strconv.Quote(value)
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}
