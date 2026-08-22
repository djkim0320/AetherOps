package mcpserver

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/browser"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/store"
	"github.com/djkim0320/Aether-claw/internal/toolstudio"
)

// This opt-in test is a real public-network integration check. It is excluded
// from ordinary deterministic test runs but is used for release rehearsals;
// no HTTP fixture or synthetic success response is accepted.
func TestLiveManagedInternalToolGET(t *testing.T) {
	if os.Getenv("AETHEROPS_LIVE_MANAGED_TOOL") != "1" {
		t.Skip("set AETHEROPS_LIVE_MANAGED_TOOL=1 for the live public HTTPS test")
	}
	db, err := store.Open(t.Context(), filepath.Join(t.TempDir(), "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	project, err := db.CreateProject(t.Context(), "live managed tool")
	if err != nil {
		t.Fatal(err)
	}
	run, err := db.CreateRun(t.Context(), project.ID, "", "read live weather JSON", "thread")
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
	manifest := `{"schema":"aetherops_tool_package_v1","name":"open-meteo","description":"Open-Meteo forecast","tools":[{"name":"forecast","description":"Read current temperature","input_schema":{"type":"object","properties":{"latitude":{"type":"number"},"longitude":{"type":"number"},"current":{"type":"string"}},"required":["latitude","longitude","current"],"additionalProperties":false},"action":{"type":"http_json_get","base_url":"https://api.open-meteo.com/v1/forecast","query_map":{"latitude":"latitude","longitude":"longitude","current":"current"}}}]}`
	service := &toolstudio.Service{DB: db}
	pkg, err := service.Propose(t.Context(), project.ID, "", "", toolstudio.Proposal{Kind: "mcp", Name: "open-meteo", DisplayName: "Open-Meteo", Description: "Reads public forecast JSON.", Version: "1.0.0", Files: []toolstudio.ProposalFile{{Path: "mcp.json", Content: manifest}}})
	if err != nil {
		t.Fatal(err)
	}
	pkg, err = service.Activate(t.Context(), project.ID, pkg.ID)
	if err != nil {
		t.Fatal(err)
	}
	input, _ := json.Marshal(map[string]any{"run_id": run.ID, "stage_attempt_id": attempt.ID, "latitude": 37.5665, "longitude": 126.978, "current": "temperature_2m"})
	result, err := executeManagedTool(t.Context(), db, browser.Policy{}, pkg.ID, "forecast", input)
	if err != nil {
		t.Fatal(err)
	}
	response, ok := result.(map[string]any)
	if !ok || response["source_url"] == "" || response["evidence_required"] != true {
		t.Fatalf("unexpected live managed tool result: %#v", result)
	}
	data, ok := response["data"].(map[string]any)
	if !ok || data["current"] == nil {
		t.Fatalf("live Open-Meteo response lacks current data: %#v", data)
	}
}
