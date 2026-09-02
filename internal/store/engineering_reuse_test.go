package store

import (
	"context"
	"testing"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
)

func TestRemediationEngineeringResultsSelectsSealedGeneralSU2Cycle(t *testing.T) {
	ctx := context.Background()
	database, objects := openTestDB(t)
	project, err := database.CreateProject(ctx, "general SU2 remediation readback")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "general CFD", "main-thread")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	completeReuseTestStage(t, database, objects, run, core.StagePlan, 0, "research.plan")
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	collect, err := database.BeginStage(ctx, run.ID, core.StageCollect, 0, "collector", "")
	if err != nil {
		t.Fatal(err)
	}
	const arguments = `{"case_id":"case_a"}`
	approveEngineeringScope(t, database, run, collect, "aetherops_engineering", "su2_cfd", arguments)
	jobInput := engineeringJobFor(run, collect, "su2_cfd", sha256Text(arguments))
	jobInput.SpecJSON = `{"operation":"su2_cfd","arguments":{"run_id":"` + run.ID + `","stage_attempt_id":"` + collect.ID + `","case_id":"case_a","mesh_source":"material","mesh_id":"doc_mesh","mesh_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","config_source":"","config_id":"","config_sha256":"","solver":"EULER","turbulence_model":"NONE","config_overrides":{"ITER":"100"},"output_files":["surface_csv"],"timeout_seconds":300}}`
	jobInput.SpecSHA256 = sha256Text(jobInput.SpecJSON)
	job, execute, err := database.BeginEngineeringJob(ctx, jobInput)
	if err != nil || !execute {
		t.Fatalf("begin general SU2 job: execute=%v err=%v", execute, err)
	}
	receipt, err := objects.PutBytes([]byte(`{"schema":1,"operation":"su2_cfd"}`))
	if err != nil {
		t.Fatal(err)
	}
	receiptArtifact, err := database.PublishArtifact(ctx, run.ID, collect.ID,
		"engineering.su2_cfd.receipt", "application/json", receipt)
	if err != nil {
		t.Fatal(err)
	}
	job, err = database.CompleteEngineeringJob(ctx, job.ID, receiptArtifact.ID, []EngineeringJobArtifact{{
		ArtifactID: receiptArtifact.ID, Role: "receipt", FileName: "execution-receipt.json",
		MediaType: "application/json", BlobHash: receiptArtifact.BlobHash,
	}})
	if err != nil {
		t.Fatal(err)
	}
	collectOutput, err := objects.PutBytes([]byte(`{"workstream_id":"engineering"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.PublishArtifact(ctx, run.ID, collect.ID, "research.evidence", "application/json", collectOutput); err != nil {
		t.Fatal(err)
	}
	if err := database.CompleteStage(ctx, collect.ID, collectOutput.Hash, ""); err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunSynthesizing, "")
	if err != nil {
		t.Fatal(err)
	}
	completeReuseTestStage(t, database, objects, run, core.StageSynthesize, 0, "research.report")
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunReviewing, "")
	if err != nil {
		t.Fatal(err)
	}
	completeReuseTestStage(t, database, objects, run, core.StageReview, 0, "research.review")

	_, remediation, err := database.PrepareResearchRemediation(ctx, run.ID, run.Revision, 0, core.ReviewVerdict{
		RemediationAction: core.ReviewRemediationReplan,
		RevisionRequests:  []string{"revalidate the exact CFD receipt"},
		RemediationTasks: []core.ReviewRemediationTask{{
			Objective: "read the prior generic receipt", RequiresEngineering: true,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	results, err := database.RemediationEngineeringResults(ctx, run.ID, "su2_cfd", remediation.Cycle)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Job.ID != job.ID || results[0].Job.ReceiptArtifactID != receiptArtifact.ID {
		t.Fatalf("sealed general SU2 results = %+v", results)
	}
	active, err := database.ListRunEngineeringJobs(ctx, run.ID, "su2_cfd")
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 0 {
		t.Fatalf("sealed SU2 job leaked into the active cycle: %+v", active)
	}
}

func completeReuseTestStage(
	t *testing.T,
	database *DB,
	objects *cas.Store,
	run core.Run,
	stage core.Stage,
	ordinal int,
	kind string,
) {
	t.Helper()
	attempt, err := database.BeginStage(context.Background(), run.ID, stage, ordinal, string(stage)+"-thread", "")
	if err != nil {
		t.Fatal(err)
	}
	output, err := objects.PutBytes([]byte(`{"ok":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.PublishArtifact(context.Background(), run.ID, attempt.ID, kind, "application/json", output); err != nil {
		t.Fatal(err)
	}
	if err := database.CompleteStage(context.Background(), attempt.ID, output.Hash, ""); err != nil {
		t.Fatal(err)
	}
}
