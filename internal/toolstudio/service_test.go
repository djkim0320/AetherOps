package toolstudio

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/store"
)

func TestSkillProposalRequiresSafeAuditableBundleAndExplicitActivation(t *testing.T) {
	db, err := store.Open(t.Context(), filepath.Join(t.TempDir(), "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	project, err := db.CreateProject(t.Context(), "tools")
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{DB: db}
	pkg, err := service.Propose(t.Context(), project.ID, "", "", Proposal{
		Kind: "skill", Name: "airfoil-check", DisplayName: "Airfoil Check", Description: "Checks airfoil inputs.", Version: "1.0.0",
		Files: []ProposalFile{{Path: "SKILL.md", Content: "---\nname: airfoil-check\ndescription: Check airfoil inputs\n---\nUse only verified project evidence."}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if pkg.State != "pending_approval" || pkg.RequiresRestart {
		t.Fatalf("unexpected proposal state: %+v", pkg)
	}
	pkg, err = service.Activate(t.Context(), project.ID, pkg.ID)
	if err != nil {
		t.Fatal(err)
	}
	if pkg.State != "active" || pkg.RequiresRestart {
		t.Fatalf("unexpected active package: %+v", pkg)
	}
	current, err := service.Get(t.Context(), project.ID, pkg.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.RequiresRestart || len(current.Files) != 1 || current.Files[0].Content == "" {
		t.Fatal("active internal skill did not retain its verified content")
	}
}

func TestPortableManifestApprovalCoversPayloadAdapterAndNativePermissions(t *testing.T) {
	manifest := `{"schema":"aetherops_tool_package_v2","name":"json-check","description":"Portable JSON check","distribution":{"type":"portable_exe","url":"https://downloads.example.com/json-check.exe","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size_bytes":1024,"publisher":"Example","source_url":"https://example.com/json-check","license_spdx":"MIT","entrypoint":"json-check.exe","probe":{"argv":["--version"],"stdout_contains":"1.0.0"}},"permissions":{"native_code":true,"same_windows_user":true,"os_network_sandboxed":false,"os_filesystem_sandboxed":false},"tools":[{"name":"check","description":"Check JSON","input_schema":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":false},"action":{"type":"portable_cli","executable":"json-check.exe","argv":[{"literal":"--value"},{"input":"value"}],"stdin":{"mode":"none"},"output":{"format":"json","max_bytes":1048576},"timeout_seconds":10}}]}`
	pkg, err := ValidateProposal("project", "", "", Proposal{
		Kind: "mcp", Name: "json-check", DisplayName: "JSON Check", Description: "Checks JSON with an approved CLI.", Version: "1.0.0",
		Files: []ProposalFile{{Path: "mcp.json", Content: manifest}},
	})
	if err != nil {
		t.Fatal(err)
	}
	pkg.ID = "tool_0123456789abcdef0123456789abcdef"
	approval, err := ExpectedInstallApproval(pkg)
	if err != nil {
		t.Fatal(err)
	}
	if approval.PayloadSHA256 != strings.Repeat("a", 64) || !approval.AcceptSameUserNativeCode || approval.ApprovalSHA256 == "" {
		t.Fatalf("unexpected portable approval: %+v", approval)
	}
	changed := strings.Replace(manifest, `"timeout_seconds":10`, `"timeout_seconds":11`, 1)
	changedPkg, err := ValidateProposal("project", "", "", Proposal{
		Kind: "mcp", Name: "json-check", DisplayName: "JSON Check", Description: "Checks JSON with an approved CLI.", Version: "1.0.1",
		Files: []ProposalFile{{Path: "mcp.json", Content: changed}},
	})
	if err != nil {
		t.Fatal(err)
	}
	changedPkg.ID = pkg.ID
	changedApproval, err := ExpectedInstallApproval(changedPkg)
	if err != nil {
		t.Fatal(err)
	}
	if approval.ApprovalSHA256 == changedApproval.ApprovalSHA256 {
		t.Fatal("adapter change reused the prior install approval identity")
	}
	unsafe := strings.Replace(manifest, `"entrypoint":"json-check.exe"`, `"entrypoint":"setup.msi"`, 1)
	if _, _, err := ParseManifest(unsafe); err == nil {
		t.Fatal("installer entrypoint was accepted as a portable CLI")
	}
}

func TestPortableZIPRejectsTraversalAndCaseCollisions(t *testing.T) {
	writeArchive := func(name string, entries []string) string {
		t.Helper()
		path := filepath.Join(t.TempDir(), name)
		file, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		writer := zip.NewWriter(file)
		for _, entry := range entries {
			part, err := writer.Create(entry)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = part.Write(bytes.Repeat([]byte{1}, 16))
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		return path
	}
	if err := extractPortableZIP(writeArchive("traversal.zip", []string{"../escape.exe"}), t.TempDir()); err == nil {
		t.Fatal("ZIP traversal entry was accepted")
	}
	if err := extractPortableZIP(writeArchive("collision.zip", []string{"bin/tool.exe", "BIN/TOOL.EXE"}), t.TempDir()); err == nil {
		t.Fatal("case-colliding ZIP entries were accepted")
	}
}

func TestProposalRejectsTraversalAndExecutableMCP(t *testing.T) {
	_, err := ValidateProposal("prj", "", "", Proposal{Kind: "skill", Name: "bad", DisplayName: "Bad", Description: "Bad path", Version: "1.0.0", Files: []ProposalFile{{Path: "../SKILL.md", Content: "---\ndescription: bad\n---"}}})
	if err == nil {
		t.Fatal("path traversal was accepted")
	}
	_, err = ValidateProposal("prj", "", "", Proposal{Kind: "skill", Name: "bad", DisplayName: "Bad", Description: "Bad front matter", Version: "1.0.0", Files: []ProposalFile{{Path: "SKILL.md", Content: "---`nname: bad`ndescription: fake`n---`nbody"}}})
	if err == nil {
		t.Fatal("literal backtick-n front matter was accepted")
	}
	_, err = ValidateProposal("prj", "", "", Proposal{Kind: "skill", Name: "bad", DisplayName: "Bad", Description: "Mismatched name", Version: "1.0.0", Files: []ProposalFile{{Path: "SKILL.md", Content: "---\nname: another\ndescription: mismatch\n---\nbody"}}})
	if err == nil {
		t.Fatal("mismatched SKILL.md name was accepted")
	}
	_, err = ValidateProposal("prj", "", "", Proposal{Kind: "mcp", Name: "unsafe", DisplayName: "Unsafe", Description: "Executes code", Version: "1.0.0", Files: []ProposalFile{{Path: "mcp.json", Content: `{"schema":"aetherops_tool_package_v1","name":"unsafe","description":"unsafe","tools":[{"name":"run","description":"run","input_schema":{"type":"object","properties":{},"additionalProperties":false},"action":{"type":"command","base_url":"https://example.com"}}]}`}}})
	if err == nil {
		t.Fatal("executable MCP action was accepted")
	}
}

func TestManifestAcceptsOnlyDeclarativePublicHTTPSShape(t *testing.T) {
	raw := `{"schema":"aetherops_tool_package_v1","name":"weather-api","description":"Weather JSON","tools":[{"name":"forecast","description":"Read forecast","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false},"action":{"type":"http_json_get","base_url":"https://api.example.com/v1/forecast","query_map":{"city":"q"}}}]}`
	manifest, canonical, err := ParseManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Tools) != 1 || canonical == "" {
		t.Fatalf("manifest was not parsed/canonicalized: %s", canonical)
	}
	bad := strings.Replace(raw, "https://api.example.com", "http://127.0.0.1", 1)
	if _, _, err := ParseManifest(bad); err == nil {
		t.Fatal("plaintext/local MCP URL was accepted")
	}
}
