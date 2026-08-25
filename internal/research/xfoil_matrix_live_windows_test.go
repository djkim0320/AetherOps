//go:build windows && amd64

package research

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/approval"
	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/engineering"
	managedruntime "github.com/djkim0320/AetherOps/internal/runtime"
	"github.com/djkim0320/AetherOps/internal/store"
)

// TestRealGoOwnedXFOILMatrix is opt-in because it crosses the real bundled
// solver boundary. It exercises the exact production ownership chain:
// Go PLAN materialization -> one visible approval -> exact child scopes ->
// project FIFO solver jobs -> SQLite/CAS receipts.
func TestRealGoOwnedXFOILMatrix(t *testing.T) {
	paths := managedruntime.ProcessPaths{
		OpenVSPScriptExecutable: os.Getenv("AETHEROPS_E2E_OPENVSP"),
		VSPAEROExecutable:       os.Getenv("AETHEROPS_E2E_VSPAERO"),
		VSPAEROOptExecutable:    os.Getenv("AETHEROPS_E2E_VSPAERO_OPT"),
		GmshExecutable:          os.Getenv("AETHEROPS_E2E_GMSH"),
		XFOILExecutable:         os.Getenv("AETHEROPS_E2E_XFOIL"),
		SU2CFDExecutable:        os.Getenv("AETHEROPS_E2E_SU2"),
	}
	for _, path := range []string{paths.OpenVSPScriptExecutable, paths.VSPAEROExecutable, paths.GmshExecutable, paths.XFOILExecutable, paths.SU2CFDExecutable} {
		if path == "" {
			t.Skip("complete real managed engineering runtime paths are not configured")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	root := t.TempDir()
	database, err := store.Open(ctx, filepath.Join(root, "matrix.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	project, err := database.CreateProject(ctx, "real core-owned matrix")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "real six-cell XFOIL matrix", "main-thread")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(ctx, run.ID, core.StageCollect, core.EngineeringScreeningOwnerOrdinal, "", "")
	if err != nil {
		t.Fatal(err)
	}
	service, err := engineering.New(engineering.Config{DB: database, CAS: objects, WorkspaceRoot: filepath.Join(root, "workspace"), Runtime: paths})
	if err != nil {
		t.Fatal(err)
	}
	authorizer := &approval.CoreAuthorizer{DB: database}
	engine := &Engine{db: database, cas: objects, xfoilRunner: service, xfoilAuthorizer: authorizer}
	plan := core.XFOILScreeningPlan{
		NACA: "2412", Reynolds: 1e6, Mach: .1, AlphaStartDeg: -4, AlphaEndDeg: 12, AlphaStepDeg: .5,
		FlapChordRatio: .25, FlapHingeXOverC: .75, FlapHingeYOverC: 0,
		CandidateDeflectionsDeg: []float64{0, 5, 10}, NCrit: 9, Iterations: 200, PanelCount: 160,
		OptimizationObjective: "minimize_cd_at_target_cl", TargetCL: .8, MinimumCM: -.3,
		OperatingPoints: []core.XFOILOperatingPoint{
			{ID: "cruise", Reynolds: 1e6, Mach: .1, NCrit: 9, TargetCL: .8, MinimumCM: -.3},
			{ID: "climb", Reynolds: 800_000, Mach: .08, NCrit: 9, TargetCL: 1, MinimumCM: -.3},
		},
	}
	approvalErr := make(chan error, 1)
	go func() {
		deadline := time.NewTimer(30 * time.Second)
		defer deadline.Stop()
		for {
			pending, err := database.ListPendingApprovals(ctx)
			if err != nil {
				approvalErr <- err
				return
			}
			if len(pending) == 1 && authorizer.Owns(pending[0].ID) {
				_, err = authorizer.Decide(ctx, pending[0].ID, "approved")
				approvalErr <- err
				return
			}
			select {
			case <-deadline.C:
				approvalErr <- context.DeadlineExceeded
				return
			case <-time.After(10 * time.Millisecond):
			}
		}
	}()
	if err := engine.executePlannedXFOILScreening(ctx, run, attempt, plan); err != nil {
		t.Fatal(err)
	}
	if err := <-approvalErr; err != nil {
		t.Fatal(err)
	}
	results, err := database.ListRunEngineeringResults(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 6 {
		t.Fatalf("real matrix jobs = %d, want 6", len(results))
	}
	for _, result := range results {
		if result.Job.Status != "succeeded" || result.Job.ReceiptArtifactID == "" {
			t.Fatalf("real matrix job is not receipt-backed: %+v", result.Job)
		}
	}
}
