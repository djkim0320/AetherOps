//go:build windows && amd64

package toolstudio

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/desktop"
	"github.com/djkim0320/AetherOps/internal/store"
)

// This is the real success-path rehearsal for autonomous portable tooling.
// It downloads the official jq Windows asset, verifies GitHub's published
// digest, probes the executable, runs a declarative adapter, and proves that
// the exact duplicate invocation is read from CAS instead of executed twice.
func TestLiveApprovedPortableJQInstallAndInvoke(t *testing.T) {
	if os.Getenv("AETHEROPS_LIVE_PORTABLE_TOOL") != "1" {
		t.Skip("set AETHEROPS_LIVE_PORTABLE_TOOL=1 for the official jq integration test")
	}
	root := t.TempDir()
	database, err := store.Open(t.Context(), filepath.Join(root, "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	supervisor, err := desktop.NewProcessSupervisor()
	if err != nil {
		t.Fatal(err)
	}
	defer supervisor.Close()
	project, err := database.CreateProject(t.Context(), "portable jq live test")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(t.Context(), project.ID, "", "normalize JSON with an approved CLI", "thread")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(t.Context(), run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(t.Context(), run.ID, core.StagePlan, 0, "thread", "")
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{
		DB: database, CAS: objects,
		InstallRoot:    filepath.Join(root, "tools", "versions"),
		QuarantineRoot: filepath.Join(root, "tools", "quarantine"),
		AssignProcess:  supervisor.Assign,
	}
	manifest := map[string]any{
		"schema": "aetherops_tool_package_v2", "name": "jq-portable",
		"description": "Official jq Windows JSON processor",
		"distribution": map[string]any{
			"type":                   "portable_exe",
			"url":                    "https://github.com/jqlang/jq/releases/download/jq-1.8.2/jq-windows-amd64.exe",
			"allowed_redirect_hosts": []string{"release-assets.githubusercontent.com"},
			"sha256":                 "a6fc67fedaf9128a3309a1e2ebb8b986aeccf70122ee46d2cb4849e423f0c627",
			"size_bytes":             1035264, "publisher": "jqlang/jq",
			"source_url": "https://jqlang.org/", "license_spdx": "MIT",
			"entrypoint": "jq.exe",
			"probe":      map[string]any{"argv": []string{"--version"}, "stdout_contains": "jq-1.8.2"},
		},
		"permissions": map[string]any{
			"native_code": true, "same_windows_user": true,
			"os_network_sandboxed": false, "os_filesystem_sandboxed": false,
		},
		"tools": []any{map[string]any{
			"name": "identity", "description": "Return one input string as JSON",
			"input_schema": map[string]any{
				"type": "object", "properties": map[string]any{"value": map[string]any{"type": "string"}},
				"required": []string{"value"}, "additionalProperties": false,
			},
			"action": map[string]any{
				"type": "portable_cli", "executable": "jq.exe",
				"argv":            []any{map[string]any{"literal": "-n"}, map[string]any{"literal": "--arg"}, map[string]any{"literal": "value"}, map[string]any{"input": "value"}, map[string]any{"literal": "$value"}},
				"stdin":           map[string]any{"mode": "none"},
				"output":          map[string]any{"format": "json", "max_bytes": 1048576},
				"timeout_seconds": 20,
			},
		}},
	}
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	pkg, err := service.ProposeForStage(t.Context(), run.ID, attempt.ID, Proposal{
		Kind: "mcp", Name: "jq-portable", DisplayName: "jq Portable",
		Description: "Official jq portable JSON utility.", Version: "1.8.2",
		Files: []ProposalFile{{Path: "mcp.json", Content: string(manifestJSON)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	approval, err := ExpectedInstallApproval(pkg)
	if err != nil {
		t.Fatal(err)
	}
	installed, err := service.InstallForStage(t.Context(), run.ID, attempt.ID, approval)
	if err != nil {
		t.Fatal(err)
	}
	if installed.State != "active" || installed.Installation == nil || installed.Installation.State != "ready" {
		t.Fatalf("portable package was not ready: %+v", installed)
	}
	result, err := service.RunPortableForStage(t.Context(), run.ID, attempt.ID, installed.ID, "identity", map[string]any{"value": "AetherOps"})
	if err != nil {
		t.Fatal(err)
	}
	first := result.(map[string]any)
	if first["data"] != "AetherOps" || first["cached"] != false {
		t.Fatalf("unexpected jq result: %#v", first)
	}
	repeated, err := service.RunPortableForStage(t.Context(), run.ID, attempt.ID, installed.ID, "identity", map[string]any{"value": "AetherOps"})
	if err != nil {
		t.Fatal(err)
	}
	second := repeated.(map[string]any)
	if second["data"] != "AetherOps" || second["cached"] != true || second["invocation_id"] != first["invocation_id"] {
		t.Fatalf("duplicate invocation was not read back: first=%#v second=%#v", first, second)
	}
}
