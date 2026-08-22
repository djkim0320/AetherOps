package mcpserver

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/browser"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/store"
	"github.com/djkim0320/Aether-claw/internal/toolstudio"
)

func TestManagedMCPRejectsCrossProjectStageBeforeNetwork(t *testing.T) {
	db, err := store.Open(t.Context(), filepath.Join(t.TempDir(), "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	owner, err := db.CreateProject(t.Context(), "owner")
	if err != nil {
		t.Fatal(err)
	}
	other, err := db.CreateProject(t.Context(), "other")
	if err != nil {
		t.Fatal(err)
	}
	service := &toolstudio.Service{DB: db}
	manifestRaw := `{"schema":"aetherops_tool_package_v1","name":"weather-api","description":"Weather","tools":[{"name":"forecast","description":"Read forecast","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false},"action":{"type":"http_json_get","base_url":"https://api.example.com/v1/forecast","query_map":{"city":"q"}}}]}`
	pkg, err := service.Propose(t.Context(), owner.ID, "", "", toolstudio.Proposal{Kind: "mcp", Name: "weather-api", DisplayName: "Weather API", Description: "Reads weather JSON.", Version: "1.0.0", Files: []toolstudio.ProposalFile{{Path: "mcp.json", Content: manifestRaw}}})
	if err != nil {
		t.Fatal(err)
	}
	pkg, err = service.Activate(t.Context(), owner.ID, pkg.ID)
	if err != nil {
		t.Fatal(err)
	}
	if pkg.RequiresRestart {
		t.Fatal("approved internal MCP incorrectly requires restart")
	}
	catalog, err := managedToolCatalog(t.Context(), db, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog) != 1 {
		t.Fatalf("internal tool catalog = %+v", catalog)
	}
	run, err := db.CreateRun(t.Context(), other.ID, "", "question", "thread")
	if err != nil {
		t.Fatal(err)
	}
	run, err = db.TransitionRun(t.Context(), run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := db.BeginStage(t.Context(), run.ID, core.StagePlan, 0, "thread", "")
	if err != nil {
		t.Fatal(err)
	}
	active, err := db.ActiveToolPackageByID(t.Context(), pkg.ID)
	if err != nil {
		t.Fatal(err)
	}
	manifest, _, err := toolstudio.ParseManifest(active.ManifestJSON)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"run_id": run.ID, "stage_attempt_id": attempt.ID, "city": "Seoul"})
	_, err = callManagedTool(t.Context(), db, browser.Policy{}, active, manifest, "forecast", raw)
	if err == nil {
		t.Fatal("managed MCP accepted a cross-project stage capability")
	}
}
