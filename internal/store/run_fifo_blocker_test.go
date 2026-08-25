package store

import (
	"context"
	"testing"

	"github.com/djkim0320/AetherOps/internal/core"
)

func TestEarlierUnresolvedRunFindsCrossSessionFIFOBlocker(t *testing.T) {
	database, _ := openTestDB(t)
	ctx := context.Background()
	project, err := database.CreateProject(ctx, "cross-session fifo")
	if err != nil {
		t.Fatal(err)
	}
	older, err := database.CreateRun(ctx, project.ID, "", "older uncertain work", "thread-old")
	if err != nil {
		t.Fatal(err)
	}
	older, err = database.TransitionRun(ctx, older.ID, older.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	older, err = database.TransitionRun(ctx, older.ID, older.Revision, core.RunUncertain, "receipt mismatch")
	if err != nil {
		t.Fatal(err)
	}
	second, err := database.CreateConversationSession(ctx, project.ID, "new conversation", core.RunConfiguration{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.MarkConversationSessionProvisioning(ctx, second.ID); err != nil {
		t.Fatal(err)
	}
	threadID, err := database.SetConversationSessionThreadIfEmpty(ctx, second.ID, "thread-new")
	if err != nil {
		t.Fatal(err)
	}
	newer, err := database.CreateConversationRunConfigured(ctx, second.ID, "", "new queued work", threadID, core.RunConfiguration{})
	if err != nil {
		t.Fatal(err)
	}

	blocking, err := database.EarlierUnresolvedRun(ctx, newer.ID)
	if err != nil {
		t.Fatal(err)
	}
	if blocking == nil || blocking.ID != older.ID || blocking.ConversationSessionID == newer.ConversationSessionID || blocking.Status != core.RunUncertain {
		t.Fatalf("blocking run = %+v, want cross-session uncertain %s", blocking, older.ID)
	}
	if blocked, err := database.HasEarlierUnresolvedRun(ctx, newer.ID); err != nil || !blocked {
		t.Fatalf("HasEarlierUnresolvedRun = %v, %v", blocked, err)
	}

	if _, err := database.TransitionRun(ctx, older.ID, older.Revision, core.RunCancelled, "discarded by user"); err != nil {
		t.Fatal(err)
	}
	blocking, err = database.EarlierUnresolvedRun(ctx, newer.ID)
	if err != nil {
		t.Fatal(err)
	}
	if blocking != nil {
		t.Fatalf("terminal predecessor remained a blocker: %+v", blocking)
	}
}
