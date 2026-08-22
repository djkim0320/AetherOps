package research

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/store"
)

type evidenceQualityFixture struct {
	engine  *Engine
	db      *store.DB
	run     core.Run
	attempt core.StageAttempt
	plan    core.ResearchPlan
	bundle  core.EvidenceBundle
}

func newEvidenceQualityFixture(t *testing.T, content []byte) evidenceQualityFixture {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	database, err := store.Open(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	project, err := database.CreateProject(ctx, "evidence quality")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "verify evidence", "main-thread")
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
	attempt, err := database.BeginStage(ctx, run.ID, core.StageCollect, 0, "collector-thread", "")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes(content)
	if err != nil {
		t.Fatal(err)
	}
	captured, err := database.CaptureEvidence(
		ctx, run.ID, attempt.ID, "https://example.test/source", "source title", "publisher",
		"text/plain; charset=utf-8", receipt,
	)
	if err != nil {
		t.Fatal(err)
	}
	source := core.EvidenceSource{
		ID: "source", URL: captured.SourceURL, Title: captured.Title, Publisher: captured.Publisher,
		CapturedAt: captured.CapturedAt, BlobHash: captured.BlobHash,
	}
	return evidenceQualityFixture{
		engine: &Engine{db: database, cas: objects}, db: database, run: run, attempt: attempt,
		plan: core.ResearchPlan{
			Question: "verify evidence", Mode: "general",
			Workstreams:        []core.Workstream{{ID: "workstream", Question: "collect primary evidence"}},
			SourceRequirements: []string{}, AcceptanceCriteria: []string{},
		},
		bundle: core.EvidenceBundle{
			WorkstreamID: "workstream", Summary: "evidence",
			Claims:  []core.EvidenceClaim{{ID: "claim", Statement: "claim", SourceIDs: []string{source.ID}}},
			Sources: []core.EvidenceSource{source}, Limitations: []string{},
		},
	}
}

func TestCollectorCASReadbackRejectsJunkAndShellWrapperEvidence(t *testing.T) {
	tests := []struct {
		name    string
		content []byte
		want    string
	}{
		{name: "one byte", content: []byte("x"), want: "too small"},
		{name: "thirty one bytes", content: []byte(strings.Repeat("x", 31)), want: "too small"},
		{name: "shell wrapper", content: []byte("Exit code: 0\nWall time: 1.4 seconds\nOutput:\n<html>source</html>"), want: "shell tool wrapper"},
		{name: "source bytes", content: []byte("<html><body>verified source bytes</body></html>")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newEvidenceQualityFixture(t, test.content)
			err := fixture.engine.verifyEvidenceSources(
				context.Background(), fixture.run.ID, 0, fixture.bundle,
			)
			if test.want == "" {
				if err != nil {
					t.Fatalf("valid evidence was rejected: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("collector validation error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestPassingReviewCheckpointCannotBypassLegacyJunkEvidenceReadback(t *testing.T) {
	ctx := context.Background()
	fixture := newEvidenceQualityFixture(t, []byte("x"))
	if err := fixture.db.CompleteStage(ctx, fixture.attempt.ID, "", ""); err != nil {
		t.Fatal(err)
	}
	var err error
	fixture.run, err = fixture.db.TransitionRun(ctx, fixture.run.ID, fixture.run.Revision, core.RunSynthesizing, "")
	if err != nil {
		t.Fatal(err)
	}
	fixture.run, err = fixture.db.TransitionRun(ctx, fixture.run.ID, fixture.run.Revision, core.RunReviewing, "")
	if err != nil {
		t.Fatal(err)
	}
	completed, err := fixture.engine.runReviewCycles(
		ctx, fixture.run, fixture.plan, []core.EvidenceBundle{fixture.bundle}, core.ReportManifest{}, 0,
		map[int]core.ReviewVerdict{0: testVerdict(true)}, map[int]core.ReportManifest{},
	)
	if err == nil || !strings.Contains(err.Error(), "verify review evidence integrity") ||
		!strings.Contains(err.Error(), "too small") {
		t.Fatalf("review gate error = %v", err)
	}
	if completed.Status != core.RunFailed {
		t.Fatalf("legacy junk evidence reached passing review status %s", completed.Status)
	}
}
