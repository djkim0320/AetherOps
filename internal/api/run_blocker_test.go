package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
)

func TestRunBlockerAPIExposesCrossSessionPredecessor(t *testing.T) {
	server, endpoint := startTestServer(t)
	ctx := context.Background()
	project, err := server.DB.CreateProject(ctx, "blocker api")
	if err != nil {
		t.Fatal(err)
	}
	older, err := server.DB.CreateRun(ctx, project.ID, "", "older", "thread-old")
	if err != nil {
		t.Fatal(err)
	}
	older, err = server.DB.TransitionRun(ctx, older.ID, older.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	older, err = server.DB.TransitionRun(ctx, older.ID, older.Revision, core.RunUncertain, "receipt mismatch")
	if err != nil {
		t.Fatal(err)
	}
	second, err := server.DB.CreateConversationSession(ctx, project.ID, "new conversation", core.RunConfiguration{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.DB.MarkConversationSessionProvisioning(ctx, second.ID); err != nil {
		t.Fatal(err)
	}
	threadID, err := server.DB.SetConversationSessionThreadIfEmpty(ctx, second.ID, "thread-new")
	if err != nil {
		t.Fatal(err)
	}
	newer, err := server.DB.CreateConversationRunConfigured(ctx, second.ID, "", "newer", threadID, core.RunConfiguration{})
	if err != nil {
		t.Fatal(err)
	}

	request, err := http.NewRequest(http.MethodGet, endpoint+"/api/v1/runs/"+newer.ID+"/blocker", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+server.Token())
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("blocker status = %d", response.StatusCode)
	}
	var payload struct {
		BlockingRun *core.Run `json:"blocking_run"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.BlockingRun == nil || payload.BlockingRun.ID != older.ID || payload.BlockingRun.ConversationSessionID == newer.ConversationSessionID {
		t.Fatalf("blocking run response = %+v", payload.BlockingRun)
	}
}
