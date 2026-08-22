package schedule

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/store"
)

type fixedClock struct{ now time.Time }

func (clock *fixedClock) Now() time.Time { return clock.now }

func TestServiceCoalescesDowntimeAndDoesNotDuplicate(t *testing.T) {
	ctx := context.Background()
	database, err := store.Open(ctx, filepath.Join(t.TempDir(), "scheduler.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	project, err := database.CreateProject(ctx, "schedule")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetProjectMainThread(ctx, project.ID, "thread-main"); err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	clock := &fixedClock{now: start}
	service := &Service{DB: database, Clock: clock}
	created, err := service.Create(ctx, core.Schedule{
		ProjectID: project.ID, Question: "scheduled question", Kind: "every",
		Expression: "1h", Timezone: "UTC", MainThreadID: "thread-main",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.NextRunAt == nil || !created.NextRunAt.Equal(start.Add(time.Hour)) {
		t.Fatalf("next occurrence = %v", created.NextRunAt)
	}
	clock.now = start.Add(30 * time.Hour)
	if err := service.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	runs, err := database.ListRuns(ctx, project.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || runs[0].ScheduleID != created.ID {
		t.Fatalf("coalesced runs: %+v", runs)
	}
	head, err := database.ActiveKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if runs[0].ResearchProfileVersion != core.CurrentResearchProfileVersion ||
		runs[0].RetrievalProfile != store.DefaultRetrievalProfile ||
		runs[0].KnowledgeGenerationID != head.GenerationID {
		t.Fatalf("scheduled run did not pin its research contract: %+v; head=%+v", runs[0], head)
	}
	if err := (&Service{DB: database, Clock: clock}).Tick(ctx); err != nil {
		t.Fatal(err)
	}
	runs, err = database.ListRuns(ctx, project.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 {
		t.Fatalf("restart duplicated scheduled run: %+v", runs)
	}
	var expired int
	if err := database.SQL().QueryRowContext(ctx, `
SELECT COUNT(*) FROM schedule_firings WHERE schedule_id = ? AND status = 'missed_expired'`,
		created.ID).Scan(&expired); err != nil {
		t.Fatal(err)
	}
	if expired != 5 {
		t.Fatalf("expired occurrence records = %d, want 5", expired)
	}
	var queuedAt string
	if err := database.SQL().QueryRowContext(ctx, `
SELECT scheduled_for FROM schedule_firings WHERE schedule_id = ? AND status = 'queued'`,
		created.ID).Scan(&queuedAt); err != nil {
		t.Fatal(err)
	}
	queuedOccurrence, err := time.Parse(time.RFC3339Nano, queuedAt)
	if err != nil {
		t.Fatal(err)
	}
	if !queuedOccurrence.Equal(start.Add(30 * time.Hour)) {
		t.Fatalf("coalesced occurrence = %s, want latest %s", queuedOccurrence, start.Add(30*time.Hour))
	}
	var totalFirings int
	if err := database.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM schedule_firings WHERE schedule_id = ?", created.ID,
	).Scan(&totalFirings); err != nil {
		t.Fatal(err)
	}
	if totalFirings != 6 {
		t.Fatalf("30-hour downtime firing ledger = %d rows, want five expired records plus one coalesced run", totalFirings)
	}
	assertNoDuplicateScheduleFirings(t, database, created.ID)
}

func TestServiceLongDowntimeCatchUpAdvancesInBoundedRestartSafePages(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "scheduler.db")
	database, err := store.Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	project, err := database.CreateProject(ctx, "bounded schedule catch-up")
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	if err := database.SetProjectMainThread(ctx, project.ID, "thread-main"); err != nil {
		database.Close()
		t.Fatal(err)
	}
	start := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	clock := &fixedClock{now: start}
	created, err := (&Service{DB: database, Clock: clock, maxOccurrences: 10}).Create(ctx, core.Schedule{
		ProjectID: project.ID, Question: "bounded catch-up", Kind: "every",
		Expression: "1h", Timezone: "UTC", MainThreadID: "thread-main",
	})
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	clock.now = start.Add(30 * time.Hour)
	if err := (&Service{DB: database, Clock: clock, maxOccurrences: 10}).Tick(ctx); err != nil {
		database.Close()
		t.Fatal(err)
	}
	assertScheduleCursor(t, database, project.ID, start.Add(10*time.Hour), start.Add(11*time.Hour))
	staleLast, staleNext := start.Add(5*time.Hour), start.Add(6*time.Hour)
	if err := database.UpdateScheduleTimes(ctx, created.ID, *created.NextRunAt, &staleLast, &staleNext); err != nil {
		database.Close()
		t.Fatal(err)
	}
	assertScheduleCursor(t, database, project.ID, start.Add(10*time.Hour), start.Add(11*time.Hour))
	if runs, err := database.ListRuns(ctx, project.ID, 100); err != nil || len(runs) != 0 {
		database.Close()
		t.Fatalf("intermediate catch-up page created a run: %+v, err=%v", runs, err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	database, err = store.Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	restarted := &Service{DB: database, Clock: clock, maxOccurrences: 10}
	if err := restarted.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	assertScheduleCursor(t, database, project.ID, start.Add(20*time.Hour), start.Add(21*time.Hour))
	if runs, err := database.ListRuns(ctx, project.ID, 100); err != nil || len(runs) != 0 {
		t.Fatalf("second intermediate catch-up page created a run: %+v, err=%v", runs, err)
	}
	if err := restarted.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if err := restarted.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	runs, err := database.ListRuns(ctx, project.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || runs[0].ScheduleID != created.ID {
		t.Fatalf("final catch-up page runs = %+v, want one", runs)
	}
	assertScheduleCursor(t, database, project.ID, start.Add(30*time.Hour), start.Add(31*time.Hour))
	var expired, queued, total int
	if err := database.SQL().QueryRowContext(ctx, `
SELECT COALESCE(SUM(status='missed_expired'),0),
       COALESCE(SUM(status='queued'),0), COUNT(*)
FROM schedule_firings WHERE schedule_id=?`, created.ID).Scan(&expired, &queued, &total); err != nil {
		t.Fatal(err)
	}
	if expired != 5 || queued != 1 || total != 6 {
		t.Fatalf("bounded 30-hour ledger = expired:%d queued:%d total:%d", expired, queued, total)
	}
	assertNoDuplicateScheduleFirings(t, database, created.ID)
}

func TestServiceBlocksScheduleWhenMainThreadIsLost(t *testing.T) {
	ctx := context.Background()
	database, err := store.Open(ctx, filepath.Join(t.TempDir(), "scheduler.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	project, err := database.CreateProject(ctx, "schedule")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetProjectMainThread(ctx, project.ID, "original-thread"); err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	clock := &fixedClock{now: start}
	service := &Service{DB: database, Clock: clock}
	_, err = service.Create(ctx, core.Schedule{
		ProjectID: project.ID, Question: "scheduled question", Kind: "every",
		Expression: "1h", Timezone: "UTC", MainThreadID: "original-thread",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetProjectMainThread(ctx, project.ID, "different-thread"); err != nil {
		t.Fatal(err)
	}
	clock.now = start.Add(time.Hour)
	if err := service.Tick(ctx); err == nil {
		t.Fatal("lost main thread did not block the schedule")
	}
	runs, err := database.ListRuns(ctx, project.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 0 {
		t.Fatalf("blocked schedule created runs: %+v", runs)
	}
}

func TestServiceAutumnDSTOccurrencesAreDistinctAndRestartSafe(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "scheduler.db")
	database, err := store.Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	project, err := database.CreateProject(ctx, "dst schedule")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetProjectMainThread(ctx, project.ID, "thread-main"); err != nil {
		t.Fatal(err)
	}

	clock := &fixedClock{now: time.Date(2026, 11, 1, 4, 0, 0, 0, time.UTC)}
	service := &Service{DB: database, Clock: clock}
	created, err := service.Create(ctx, core.Schedule{
		ProjectID: project.ID, Question: "repeated wall clock", Kind: "cron",
		Expression: "30 1 * * *", Timezone: "America/New_York", MainThreadID: "thread-main",
	})
	if err != nil {
		t.Fatal(err)
	}
	first := time.Date(2026, 11, 1, 5, 30, 0, 0, time.UTC)
	second := time.Date(2026, 11, 1, 6, 30, 0, 0, time.UTC)
	if created.NextRunAt == nil || !created.NextRunAt.Equal(first) {
		t.Fatalf("first repeated occurrence = %v, want %s", created.NextRunAt, first)
	}

	clock.now = first
	if err := service.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if err := (&Service{DB: database, Clock: clock}).Tick(ctx); err != nil {
		t.Fatal(err)
	}
	// Reopen the WAL database between the two UTC instants that share the
	// same 01:30 wall clock. The persisted cursor must retain the fold rather
	// than replaying the first occurrence or skipping the second.
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	database, err = store.Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	clock.now = second
	if err := (&Service{DB: database, Clock: clock}).Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if err := (&Service{DB: database, Clock: clock}).Tick(ctx); err != nil {
		t.Fatal(err)
	}

	runs, err := database.ListRuns(ctx, project.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 2 {
		t.Fatalf("repeated wall clock created %d runs, want two distinct instants: %+v", len(runs), runs)
	}
	rows, err := database.SQL().QueryContext(ctx, `
SELECT scheduled_for FROM schedule_firings
WHERE schedule_id = ? AND status = 'queued'
ORDER BY scheduled_for`, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var firings []time.Time
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		firing, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			t.Fatal(err)
		}
		firings = append(firings, firing)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(firings) != 2 || !firings[0].Equal(first) || !firings[1].Equal(second) {
		t.Fatalf("DST firing keys = %v, want [%s %s]", firings, first, second)
	}
	assertNoDuplicateScheduleFirings(t, database, created.ID)
}

func TestServiceCoalescesRepeatedAutumnDSTWallClockAfterDowntime(t *testing.T) {
	ctx := context.Background()
	database, err := store.Open(ctx, filepath.Join(t.TempDir(), "scheduler.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	project, err := database.CreateProject(ctx, "dst downtime")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetProjectMainThread(ctx, project.ID, "thread-main"); err != nil {
		t.Fatal(err)
	}
	clock := &fixedClock{now: time.Date(2026, 11, 1, 4, 0, 0, 0, time.UTC)}
	service := &Service{DB: database, Clock: clock}
	created, err := service.Create(ctx, core.Schedule{
		ProjectID: project.ID, Question: "coalesce repeated wall clock", Kind: "cron",
		Expression: "30 1 * * *", Timezone: "America/New_York", MainThreadID: "thread-main",
	})
	if err != nil {
		t.Fatal(err)
	}
	clock.now = time.Date(2026, 11, 1, 7, 0, 0, 0, time.UTC)
	if err := service.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if err := (&Service{DB: database, Clock: clock}).Tick(ctx); err != nil {
		t.Fatal(err)
	}
	runs, err := database.ListRuns(ctx, project.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 {
		t.Fatalf("downtime across repeated wall clock created %d runs: %+v", len(runs), runs)
	}
	var scheduledFor string
	if err := database.SQL().QueryRowContext(ctx, `
SELECT scheduled_for FROM schedule_firings WHERE schedule_id = ? AND status = 'queued'`,
		created.ID).Scan(&scheduledFor); err != nil {
		t.Fatal(err)
	}
	firing, err := time.Parse(time.RFC3339Nano, scheduledFor)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 11, 1, 6, 30, 0, 0, time.UTC)
	if !firing.Equal(want) {
		t.Fatalf("coalesced repeated wall clock = %s, want latest instant %s", firing, want)
	}
	assertNoDuplicateScheduleFirings(t, database, created.ID)
}

func TestServiceRestartAfterClaimAdvancesWithoutDuplicate(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "scheduler.db")
	database, err := store.Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	project, err := database.CreateProject(ctx, "crash window")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetProjectMainThread(ctx, project.ID, "thread-main"); err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	clock := &fixedClock{now: start}
	created, err := (&Service{DB: database, Clock: clock}).Create(ctx, core.Schedule{
		ProjectID: project.ID, Question: "claim then crash", Kind: "every",
		Expression: "1h", Timezone: "UTC", MainThreadID: "thread-main",
	})
	if err != nil {
		t.Fatal(err)
	}
	due := start.Add(time.Hour)
	if _, claimed, err := database.CreateScheduledRun(ctx, created, due); err != nil || !claimed {
		t.Fatalf("claim scheduled occurrence: claimed=%t err=%v", claimed, err)
	}
	// The firing commit succeeded, but the scheduler did not yet advance
	// schedules.next_run_at. Closing here reproduces that exact crash window.
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := store.Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	clock.now = due
	restarted := &Service{DB: reopened, Clock: clock}
	if err := restarted.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if err := restarted.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	runs, err := reopened.ListRuns(ctx, project.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 {
		t.Fatalf("restart duplicated claimed occurrence: %+v", runs)
	}
	schedules, err := reopened.ListSchedules(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(schedules) != 1 || schedules[0].NextRunAt == nil || !schedules[0].NextRunAt.Equal(start.Add(2*time.Hour)) {
		t.Fatalf("restart did not advance schedule cursor: %+v", schedules)
	}
	var firingCount int
	if err := reopened.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM schedule_firings WHERE schedule_id = ? AND scheduled_for = ?",
		created.ID, due.Format(time.RFC3339Nano),
	).Scan(&firingCount); err != nil {
		t.Fatal(err)
	}
	if firingCount != 1 {
		t.Fatalf("claimed occurrence rows = %d, want 1", firingCount)
	}
	assertNoDuplicateScheduleFirings(t, reopened, created.ID)
}

func TestServiceLeavesWaitingApprovalRunAndQueuesNextOccurrenceOnce(t *testing.T) {
	ctx := context.Background()
	database, err := store.Open(ctx, filepath.Join(t.TempDir(), "scheduler.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	project, err := database.CreateProject(ctx, "approval wait")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetProjectMainThread(ctx, project.ID, "thread-main"); err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	clock := &fixedClock{now: start}
	service := &Service{DB: database, Clock: clock}
	created, err := service.Create(ctx, core.Schedule{
		ProjectID: project.ID, Question: "approval wait", Kind: "every",
		Expression: "1h", Timezone: "UTC", MainThreadID: "thread-main",
	})
	if err != nil {
		t.Fatal(err)
	}
	clock.now = start.Add(time.Hour)
	if err := service.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	runs, err := database.ListRuns(ctx, project.ID, 100)
	if err != nil || len(runs) != 1 {
		t.Fatalf("first scheduled run: %+v, err=%v", runs, err)
	}
	waiting, err := database.TransitionRun(ctx, runs[0].ID, runs[0].Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(ctx, waiting.ID, core.StagePlan, 0, "thread-main", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetStageTurn(ctx, attempt.ID, "thread-main", "turn-approval"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.CreateApproval(ctx, core.Approval{
		RunID: waiting.ID, StageAttemptID: attempt.ID, ThreadID: "thread-main",
		TurnID: "turn-approval", Kind: "item/fileChange/requestApproval", Summary: "write approval",
	}); err != nil {
		t.Fatal(err)
	}
	waiting, err = database.TransitionRun(ctx, waiting.ID, waiting.Revision, core.RunWaitingApproval, "")
	if err != nil {
		t.Fatal(err)
	}

	clock.now = start.Add(2 * time.Hour)
	if err := service.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if err := (&Service{DB: database, Clock: clock}).Tick(ctx); err != nil {
		t.Fatal(err)
	}
	runs, err = database.ListRuns(ctx, project.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	statusCounts := map[core.RunStatus]int{}
	for _, run := range runs {
		statusCounts[run.Status]++
	}
	if len(runs) != 2 || statusCounts[core.RunWaitingApproval] != 1 || statusCounts[core.RunQueued] != 1 {
		t.Fatalf("approval wait scheduling state = %+v, runs=%+v", statusCounts, runs)
	}
	pending, err := database.ListPendingApprovals(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].RunID != waiting.ID {
		t.Fatalf("pending approval was changed by scheduler: %+v", pending)
	}
	var firingCount int
	if err := database.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM schedule_firings WHERE schedule_id = ? AND status = 'queued'", created.ID,
	).Scan(&firingCount); err != nil {
		t.Fatal(err)
	}
	if firingCount != 2 {
		t.Fatalf("approval wait schedule firing count = %d, want 2", firingCount)
	}
	assertNoDuplicateScheduleFirings(t, database, created.ID)
}

func TestServiceRestartExpiresWaitingApprovalAndQueuesNextOccurrenceOnce(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "scheduler.db")
	database, err := store.Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	project, err := database.CreateProject(ctx, "approval restart")
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	if err := database.SetProjectMainThread(ctx, project.ID, "thread-main"); err != nil {
		database.Close()
		t.Fatal(err)
	}
	start := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	clock := &fixedClock{now: start}
	service := &Service{DB: database, Clock: clock}
	created, err := service.Create(ctx, core.Schedule{
		ProjectID: project.ID, Question: "approval restart", Kind: "every",
		Expression: "1h", Timezone: "UTC", MainThreadID: "thread-main",
	})
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	clock.now = start.Add(time.Hour)
	if err := service.Tick(ctx); err != nil {
		database.Close()
		t.Fatal(err)
	}
	runs, err := database.ListRuns(ctx, project.ID, 100)
	if err != nil || len(runs) != 1 {
		database.Close()
		t.Fatalf("first scheduled run: %+v, err=%v", runs, err)
	}
	waiting, err := database.TransitionRun(ctx, runs[0].ID, runs[0].Revision, core.RunPlanning, "")
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(ctx, waiting.ID, core.StagePlan, 0, "thread-main", "")
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	if err := database.SetStageTurn(ctx, attempt.ID, "thread-main", "turn-approval"); err != nil {
		database.Close()
		t.Fatal(err)
	}
	if _, err := database.CreateApproval(ctx, core.Approval{
		RunID: waiting.ID, StageAttemptID: attempt.ID, ThreadID: "thread-main",
		TurnID: "turn-approval", Kind: "item/fileChange/requestApproval", Summary: "write approval",
	}); err != nil {
		database.Close()
		t.Fatal(err)
	}
	if _, err := database.TransitionRun(ctx, waiting.ID, waiting.Revision, core.RunWaitingApproval, ""); err != nil {
		database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	database, err = store.Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if recovered, err := database.RecoverInFlight(ctx); err != nil || recovered != 1 {
		t.Fatalf("waiting approval restart recovery = %d, err=%v", recovered, err)
	}
	if pending, err := database.ListPendingApprovals(ctx); err != nil || len(pending) != 0 {
		t.Fatalf("stale approval remained actionable: %+v, err=%v", pending, err)
	}
	clock.now = start.Add(2 * time.Hour)
	restarted := &Service{DB: database, Clock: clock}
	if err := restarted.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if err := restarted.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	runs, err = database.ListRuns(ctx, project.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	statusCounts := map[core.RunStatus]int{}
	for _, run := range runs {
		statusCounts[run.Status]++
	}
	if len(runs) != 2 || statusCounts[core.RunInterrupted] != 1 || statusCounts[core.RunQueued] != 1 {
		t.Fatalf("approval restart scheduling state = %+v, runs=%+v", statusCounts, runs)
	}
	var firingCount int
	if err := database.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM schedule_firings WHERE schedule_id=? AND status='queued'", created.ID,
	).Scan(&firingCount); err != nil {
		t.Fatal(err)
	}
	if firingCount != 2 {
		t.Fatalf("approval restart firing count = %d, want 2", firingCount)
	}
	assertNoDuplicateScheduleFirings(t, database, created.ID)
}

func assertScheduleCursor(t *testing.T, database *store.DB, projectID string, wantLast, wantNext time.Time) {
	t.Helper()
	schedules, err := database.ListSchedules(context.Background(), projectID)
	if err != nil {
		t.Fatal(err)
	}
	if len(schedules) != 1 || schedules[0].LastRunAt == nil || schedules[0].NextRunAt == nil ||
		!schedules[0].LastRunAt.Equal(wantLast) || !schedules[0].NextRunAt.Equal(wantNext) {
		t.Fatalf("schedule cursor = %+v, want last=%s next=%s", schedules, wantLast, wantNext)
	}
}

func assertNoDuplicateScheduleFirings(t *testing.T, database *store.DB, scheduleID string) {
	t.Helper()
	var total, distinct int
	if err := database.SQL().QueryRowContext(context.Background(), `
SELECT COUNT(*), COUNT(DISTINCT scheduled_for)
FROM schedule_firings WHERE schedule_id = ?`, scheduleID).Scan(&total, &distinct); err != nil {
		t.Fatal(err)
	}
	if total != distinct {
		t.Fatalf("schedule %s has %d firing rows but only %d distinct (schedule_id, scheduled_for) keys", scheduleID, total, distinct)
	}
}

func TestServiceBlocksScheduledRunWhileKnowledgeGraphIsStale(t *testing.T) {
	ctx := context.Background()
	database, err := store.Open(ctx, filepath.Join(t.TempDir(), "scheduler.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	project, err := database.CreateProject(ctx, "stale graph")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetProjectMainThread(ctx, project.ID, "thread-main"); err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	clock := &fixedClock{now: start}
	service := &Service{DB: database, Clock: clock}
	created, err := service.Create(ctx, core.Schedule{
		ProjectID: project.ID, Question: "must wait for graph", Kind: "every",
		Expression: "1h", Timezone: "UTC", MainThreadID: "thread-main",
	})
	if err != nil {
		t.Fatal(err)
	}
	head, err := database.ActiveKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.SetKnowledgeHeadStatus(
		ctx, project.ID, head.KnowledgeRevision, store.KnowledgeHeadStale, "curation pending",
	); err != nil {
		t.Fatal(err)
	}
	clock.now = start.Add(time.Hour)
	if err := service.Tick(ctx); err == nil {
		t.Fatal("stale knowledge graph did not block scheduled research")
	}
	runs, err := database.ListRuns(ctx, project.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 0 {
		t.Fatalf("stale graph created scheduled runs: %+v", runs)
	}
	var firingCount int
	if err := database.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM schedule_firings WHERE schedule_id = ?", created.ID,
	).Scan(&firingCount); err != nil {
		t.Fatal(err)
	}
	if firingCount != 0 {
		t.Fatalf("stale graph left a partial firing claim: %d", firingCount)
	}
	schedules, err := database.ListSchedules(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(schedules) != 1 || schedules[0].NextRunAt == nil || !schedules[0].NextRunAt.Equal(start.Add(time.Hour)) {
		t.Fatalf("blocked schedule cursor advanced unexpectedly: %+v", schedules)
	}
}
