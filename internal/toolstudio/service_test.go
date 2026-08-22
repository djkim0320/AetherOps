package toolstudio

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/store"
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
