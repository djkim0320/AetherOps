package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
)

func TestEngineeringInputsAreHashBoundAndProjectIsolated(t *testing.T) {
	ctx := context.Background()
	database, objects := openTestDB(t)
	projectA, err := database.CreateProject(ctx, "engineering input A")
	if err != nil {
		t.Fatal(err)
	}
	projectB, err := database.CreateProject(ctx, "engineering input B")
	if err != nil {
		t.Fatal(err)
	}
	runA, err := database.CreateRun(ctx, projectA.ID, "", "general SU2", "thread-a")
	if err != nil {
		t.Fatal(err)
	}
	runA, err = database.TransitionRun(ctx, runA.ID, runA.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	runA, err = database.TransitionRun(ctx, runA.ID, runA.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(ctx, runA.ID, core.StageCollect, 0, "collector", "turn")
	if err != nil {
		t.Fatal(err)
	}
	meshReceipt, err := objects.PutBytes([]byte("NDIME=2\nNELEM=1\nNPOIN=3\nNMARK=1\n"))
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := database.PublishArtifact(ctx, runA.ID, attempt.ID,
		"engineering.input.mesh", "application/vnd.su2.mesh", meshReceipt)
	if err != nil {
		t.Fatal(err)
	}
	configReceipt, err := objects.PutBytes([]byte("ITER=100\nMARKER_FAR=( farfield )\n"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, configReceipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	now := formatTime(time.Now().UTC())
	if _, err := database.SQL().ExecContext(ctx, `
INSERT INTO documents(id,project_id,artifact_id,title,blob_hash,status,embedding_model,
 embedding_dimensions,pinned,graph_adopt,created_at,updated_at)
VALUES('doc_su2_cfg',?,NULL,'case.cfg',?,'ready','text-embedding-3-small',1536,1,0,?,?)`,
		projectA.ID, configReceipt.Hash, now, now); err != nil {
		t.Fatal(err)
	}

	inputs, err := database.ListEngineeringInputs(ctx, projectA.ID, runA.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(inputs) != 2 {
		t.Fatalf("engineering inputs = %+v", inputs)
	}
	if _, err := database.ResolveEngineeringInput(ctx, projectA.ID, runA.ID,
		EngineeringInputArtifact, artifact.ID, meshReceipt.Hash); err != nil {
		t.Fatalf("current-run artifact rejected: %v", err)
	}
	if _, err := database.ResolveEngineeringInput(ctx, projectA.ID, runA.ID,
		EngineeringInputMaterial, "doc_su2_cfg", configReceipt.Hash); err != nil {
		t.Fatalf("pinned material rejected: %v", err)
	}
	if _, err := database.ResolveEngineeringInput(ctx, projectA.ID, runA.ID,
		EngineeringInputArtifact, artifact.ID, strings.Repeat("f", 64)); err == nil {
		t.Fatal("changed approved input hash was accepted")
	}
	if _, err := database.ResolveEngineeringInput(ctx, projectB.ID, runA.ID,
		EngineeringInputArtifact, artifact.ID, meshReceipt.Hash); err == nil {
		t.Fatal("cross-project engineering input was exposed")
	}
	if _, err := database.ListEngineeringInputs(ctx, projectB.ID, runA.ID); err == nil {
		t.Fatal("cross-project run/input listing was exposed")
	}
}
