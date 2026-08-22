package store

import (
	"context"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/core"
)

func TestApplicationIdleBlocksQueuedAndApprovalWork(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	idle, err := db.ApplicationIdle(ctx)
	if err != nil || !idle {
		t.Fatalf("empty application idle=%v err=%v", idle, err)
	}
	project, err := db.CreateProject(ctx, "idle-test")
	if err != nil {
		t.Fatal(err)
	}
	run, err := db.CreateRun(ctx, project.ID, "", "queued work", "")
	if err != nil {
		t.Fatal(err)
	}
	idle, err = db.ApplicationIdle(ctx)
	if err != nil || idle {
		t.Fatalf("queued run idle=%v err=%v", idle, err)
	}
	if _, err := db.TransitionRun(ctx, run.ID, run.Revision, core.RunCancelled, "test complete"); err != nil {
		t.Fatal(err)
	}
	idle, err = db.ApplicationIdle(ctx)
	if err != nil || !idle {
		t.Fatalf("terminal run idle=%v err=%v", idle, err)
	}
}
