package mcpserver

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
)

func TestLiveScholarlySearchMCP(t *testing.T) {
	if os.Getenv("AETHEROPS_LIVE_SCHOLARLY_TEST") != "1" {
		t.Skip("set AETHEROPS_LIVE_SCHOLARLY_TEST=1 to query the live scholarly providers")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	root := t.TempDir()
	database, err := store.Open(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	project, err := database.CreateProject(ctx, "live scholarly search")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "NACA airfoil boundary layer", "live-thread")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(ctx, run.ID, core.StagePlan, 0, "live-thread", "")
	if err != nil {
		t.Fatal(err)
	}
	arguments, err := json.Marshal(map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID,
		"query": "NACA airfoil boundary layer", "limit": 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	value, err := (&Server{DB: database, CAS: objects}).call(ctx, "scholarly_search", arguments)
	if err != nil {
		t.Fatal(err)
	}
	response, ok := value.(scholarlySearchResponse)
	if !ok {
		t.Fatalf("live MCP result type = %T", value)
	}
	if len(response.Results) == 0 {
		t.Fatal("live scholarly providers returned no merged candidates")
	}
	if len(response.Providers) != 3 {
		t.Fatalf("live provider reports = %#v", response.Providers)
	}
	for _, provider := range response.Providers {
		t.Logf("provider=%s status=%s count=%d", provider.Provider, provider.Status, provider.Count)
		if provider.Status != "ok" {
			t.Errorf("live provider failed: %#v", provider)
		}
	}
	for _, candidate := range response.Results {
		t.Logf("candidate=%s year=%d open_access=%t title=%q", candidate.ID, candidate.Year, candidate.OpenAccess, candidate.Title)
	}
}
