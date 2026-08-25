package approval

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
	"github.com/djkim0320/AetherOps/internal/toolstudio"
)

func TestApprovedPortableToolRunRequiresExactStageGrant(t *testing.T) {
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
	project, err := database.CreateProject(t.Context(), "portable grant")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(t.Context(), project.ID, "", "use exact approved tool", "thread")
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
	payload := []byte("approved portable payload")
	payloadDigest := sha256.Sum256(payload)
	payloadHash := hex.EncodeToString(payloadDigest[:])
	manifest := map[string]any{
		"schema": "aetherops_tool_package_v2", "name": "portable-check", "description": "Portable grant check",
		"distribution": map[string]any{
			"type": "portable_exe", "url": "https://downloads.example.com/check.exe",
			"sha256": payloadHash, "size_bytes": len(payload), "publisher": "Example Publisher",
			"source_url": "https://example.com/check", "license_spdx": "MIT", "entrypoint": "check.exe",
			"probe": map[string]any{"argv": []string{"--version"}},
		},
		"permissions": map[string]any{"native_code": true, "same_windows_user": true, "os_network_sandboxed": false, "os_filesystem_sandboxed": false},
		"tools": []any{map[string]any{
			"name": "check", "description": "Check one value",
			"input_schema": map[string]any{"type": "object", "properties": map[string]any{"value": map[string]any{"type": "string"}}, "required": []string{"value"}, "additionalProperties": false},
			"action":       map[string]any{"type": "portable_cli", "executable": "check.exe", "argv": []any{map[string]any{"input": "value"}}, "stdin": map[string]any{"mode": "none"}, "output": map[string]any{"format": "text", "max_bytes": 1024}, "timeout_seconds": 10},
		}},
	}
	manifestBytes, _ := json.Marshal(manifest)
	service := &toolstudio.Service{DB: database}
	pkg, err := service.ProposeForStage(t.Context(), run.ID, attempt.ID, toolstudio.Proposal{
		Kind: "mcp", Name: "portable-check", DisplayName: "Portable Check", Description: "Checks exact grants.", Version: "1.0.0",
		Files: []toolstudio.ProposalFile{{Path: "mcp.json", Content: string(manifestBytes)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	approval, err := toolstudio.ExpectedInstallApproval(pkg)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(t.Context(), receipt, "application/vnd.aetherops.portable-tool"); err != nil {
		t.Fatal(err)
	}
	installation, _, err := database.BeginToolInstallation(t.Context(), core.ToolInstallation{
		PackageID: pkg.ID, ProjectID: project.ID, PackageSHA256: pkg.PackageSHA256,
		ApprovalSHA256: approval.ApprovalSHA256, ExpectedPayloadSHA256: payloadHash,
	})
	if err != nil {
		t.Fatal(err)
	}
	size := receipt.Size
	installation, err = database.UpdateToolInstallation(t.Context(), installation.ID, "downloading", store.ToolInstallationUpdate{State: "verifying", PayloadBlobHash: receipt.Hash, PayloadSizeBytes: &size})
	if err != nil {
		t.Fatal(err)
	}
	installation, err = database.UpdateToolInstallation(t.Context(), installation.ID, "verifying", store.ToolInstallationUpdate{State: "installing"})
	if err != nil {
		t.Fatal(err)
	}
	installation, err = database.UpdateToolInstallation(t.Context(), installation.ID, "installing", store.ToolInstallationUpdate{State: "probing"})
	if err != nil {
		t.Fatal(err)
	}
	installation, err = database.CompleteToolInstallation(t.Context(), installation.ID, strings.Repeat("1", 64), "check.exe", "")
	if err != nil {
		t.Fatal(err)
	}
	pkg, err = database.ActivateToolPackage(t.Context(), project.ID, pkg.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.CreateToolStageGrant(t.Context(), core.ToolStageGrant{
		ProjectID: project.ID, RunID: run.ID, StageAttemptID: attempt.ID,
		PackageID: pkg.ID, InstallationID: installation.ID, PackageSHA256: pkg.PackageSHA256,
		ApprovalSHA256: approval.ApprovalSHA256,
	}); err != nil {
		t.Fatal(err)
	}
	arguments, _ := json.Marshal(map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID, "package_id": pkg.ID,
		"tool": "check", "input": map[string]any{"value": "ok"},
	})
	router := &Router{DB: database}
	granted, err := router.approvedPortableToolRun(t.Context(), "item/mcpToolCall/requestApproval", approvalRequest{
		Server: "aetherops_internal", Tool: "tool_run",
	}, attempt, string(arguments))
	if err != nil || !granted {
		t.Fatalf("exact stage grant was not recognized: granted=%v err=%v", granted, err)
	}
	var changed map[string]any
	_ = json.Unmarshal(arguments, &changed)
	changed["stage_attempt_id"] = "attempt_other"
	changedJSON, _ := json.Marshal(changed)
	granted, err = router.approvedPortableToolRun(t.Context(), "item/mcpToolCall/requestApproval", approvalRequest{
		Server: "aetherops_internal", Tool: "tool_run",
	}, attempt, string(changedJSON))
	if err != nil || granted {
		t.Fatalf("cross-attempt grant was accepted: granted=%v err=%v", granted, err)
	}
}
