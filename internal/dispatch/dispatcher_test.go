package dispatch

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
)

type acceptingConfigurationValidator struct{}

func (acceptingConfigurationValidator) ValidateRunConfiguration(_ context.Context, configuration core.RunConfiguration) error {
	return configuration.Validate()
}

type idleExecutor struct{}

func (idleExecutor) Execute(context.Context, string) error       { return nil }
func (idleExecutor) Steer(context.Context, string, string) error { return nil }

type chatProtocolFixture struct {
	createdSessionID string
	threadID         string
	message          string
	mode             core.ChatMode
}

func (fixture *chatProtocolFixture) CreateMainThread(_ context.Context, sessionID string, _ core.RunConfiguration) (string, error) {
	fixture.createdSessionID = sessionID
	return "thread-chat", nil
}

func (fixture *chatProtocolFixture) Chat(
	_ context.Context,
	threadID, message string,
	mode core.ChatMode,
	_ string,
	configuration core.RunConfiguration,
) (core.ChatReply, error) {
	fixture.threadID = threadID
	fixture.message = message
	fixture.mode = mode
	return core.ChatReply{ThreadID: threadID, TurnID: "turn-chat", Mode: mode, Text: "reply", Model: configuration.Model}, nil
}

func (fixture *chatProtocolFixture) ChatHistory(_ context.Context, threadID string) (core.ChatHistory, error) {
	fixture.threadID = threadID
	return core.ChatHistory{
		ThreadID: threadID,
		Messages: []core.ChatHistoryMessage{{ID: "message-1", TurnID: "turn-chat", Role: "assistant", Text: "reply", Mode: core.ChatModeConversation}},
	}, nil
}

type blockingExecutor struct {
	db       *store.DB
	started  chan executionStart
	releases map[string]chan struct{}

	mu        sync.Mutex
	active    int
	maxActive int
	steered   map[string][]string
}

func (executor *blockingExecutor) Steer(_ context.Context, runID, message string) error {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	if executor.releases[runID] == nil {
		return errors.New("run is not active")
	}
	executor.steered[runID] = append(executor.steered[runID], message)
	return nil
}

type executionStart struct {
	runID     string
	projectID string
}

func (executor *blockingExecutor) Execute(ctx context.Context, runID string) error {
	run, err := executor.db.Run(ctx, runID)
	if err != nil {
		return err
	}
	executor.mu.Lock()
	executor.active++
	release := make(chan struct{})
	executor.releases[runID] = release
	if executor.active > executor.maxActive {
		executor.maxActive = executor.active
	}
	executor.mu.Unlock()
	defer func() {
		executor.mu.Lock()
		executor.active--
		executor.mu.Unlock()
	}()
	executor.started <- executionStart{runID: runID, projectID: run.ProjectID}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-release:
		return nil
	}
}

func (executor *blockingExecutor) release(runID string) {
	executor.mu.Lock()
	release := executor.releases[runID]
	executor.mu.Unlock()
	close(release)
}

func activeDispatchRun(t *testing.T) (*store.DB, core.Run, core.StageAttempt) {
	t.Helper()
	ctx := context.Background()
	database, err := store.Open(ctx, filepath.Join(t.TempDir(), "dispatcher-boundary.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	project, err := database.CreateProject(ctx, "dispatcher boundary")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "boundary", "thread-boundary")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(ctx, run.ID, core.StagePlan, 0, "thread-boundary", "")
	if err != nil {
		t.Fatal(err)
	}
	return database, run, attempt
}

func TestCancelRunSerializesWithAutomaticExternalAuthorization(t *testing.T) {
	t.Run("marker first", func(t *testing.T) {
		ctx := context.Background()
		database, run, attempt := activeDispatchRun(t)
		approval, err := database.CreateApproval(ctx, core.Approval{
			RunID: run.ID, StageAttemptID: attempt.ID,
			ThreadID: attempt.CodexThreadID, TurnID: "turn-pending", ItemID: "item-pending",
			Kind: "item/fileChange/requestApproval", Summary: "pending action",
		})
		if err != nil {
			t.Fatal(err)
		}
		run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunWaitingApproval, "")
		if err != nil {
			t.Fatal(err)
		}
		if err := database.MarkActiveStageExternalSideEffects(ctx, attempt.ID); err != nil {
			t.Fatal(err)
		}
		dispatcher := &Dispatcher{DB: database}
		cancelled, err := dispatcher.CancelRun(ctx, run.ID)
		if err != nil {
			t.Fatal(err)
		}
		if cancelled.Status != core.RunUncertain || cancelled.Error != "cancelled by user" {
			t.Fatalf("marked cancellation = %+v, want uncertain", cancelled)
		}
		pending, err := database.ListPendingApprovals(ctx)
		if err != nil || len(pending) != 0 {
			t.Fatalf("quiescence retained pending approvals: %+v, %v", pending, err)
		}
		if decided, err := database.DecideActiveApproval(ctx, approval.ID, "approved"); !errors.Is(err, store.ErrApprovalNotActive) || decided.Status != "denied" {
			t.Fatalf("retired approval remained actionable: approval=%+v err=%v", decided, err)
		}
	})

	t.Run("cancel first", func(t *testing.T) {
		ctx := context.Background()
		database, run, attempt := activeDispatchRun(t)
		dispatcher := &Dispatcher{DB: database}
		cancelled, err := dispatcher.CancelRun(ctx, run.ID)
		if err != nil {
			t.Fatal(err)
		}
		if cancelled.Status != core.RunCancelled {
			t.Fatalf("unmarked cancellation = %+v, want cancelled", cancelled)
		}
		if err := database.MarkActiveStageExternalSideEffects(ctx, attempt.ID); !errors.Is(err, store.ErrApprovalNotActive) {
			t.Fatalf("terminal run accepted late external marker: %v", err)
		}
		attempts, err := database.ListStageAttempts(ctx, run.ID)
		if err != nil || len(attempts) != 1 || attempts[0].ExternalSideEffects {
			t.Fatalf("late authorization crossed marker boundary: %+v, %v", attempts, err)
		}
	})
}

func TestFinishErroredRunUsesSafeTerminalization(t *testing.T) {
	t.Run("external marker", func(t *testing.T) {
		ctx := context.Background()
		database, run, attempt := activeDispatchRun(t)
		if err := database.MarkActiveStageExternalSideEffects(ctx, attempt.ID); err != nil {
			t.Fatal(err)
		}
		dispatcher := &Dispatcher{DB: database}
		dispatcher.finishErroredRun(run.ID, errors.New("executor failed after external release"))
		stored, err := database.Run(ctx, run.ID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.Status != core.RunUncertain || stored.Error != "executor failed after external release" {
			t.Fatalf("marked executor failure = %+v, want uncertain", stored)
		}
	})

	t.Run("no marker", func(t *testing.T) {
		ctx := context.Background()
		database, run, _ := activeDispatchRun(t)
		dispatcher := &Dispatcher{DB: database}
		dispatcher.finishErroredRun(run.ID, errors.New("ordinary executor failure"))
		stored, err := database.Run(ctx, run.ID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.Status != core.RunFailed || stored.Error != "ordinary executor failure" {
			t.Fatalf("unmarked executor failure = %+v, want failed", stored)
		}
	})
}

func TestDispatcherLimitsGlobalRunsAndSerializesProjects(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	database, err := store.Open(ctx, filepath.Join(t.TempDir(), "dispatcher.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	projectA, err := database.CreateProject(ctx, "A")
	if err != nil {
		t.Fatal(err)
	}
	projectB, err := database.CreateProject(ctx, "B")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetProjectMainThread(ctx, projectA.ID, "thread-a"); err != nil {
		t.Fatal(err)
	}
	if err := database.SetProjectMainThread(ctx, projectB.ID, "thread-b"); err != nil {
		t.Fatal(err)
	}
	executor := &blockingExecutor{
		db: database, started: make(chan executionStart, 4), releases: make(map[string]chan struct{}), steered: make(map[string][]string),
	}
	dispatcher := &Dispatcher{DB: database, Executor: executor, Configurations: acceptingConfigurationValidator{}}
	if err := dispatcher.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		shutdown, stop := context.WithTimeout(context.Background(), 3*time.Second)
		defer stop()
		_ = dispatcher.Shutdown(shutdown)
	})
	configuration := core.RunConfiguration{Model: core.PlannerModel, ReasoningEffort: core.PlannerEffort, ServiceTier: core.ServiceTierDefault}
	runA1, err := dispatcher.StartRun(ctx, projectA.ID, "A1", configuration)
	if err != nil {
		t.Fatal(err)
	}
	runA2, err := dispatcher.StartRun(ctx, projectA.ID, "A2", configuration)
	if err != nil {
		t.Fatal(err)
	}
	runB, err := dispatcher.StartRun(ctx, projectB.ID, "B", configuration)
	if err != nil {
		t.Fatal(err)
	}
	first := waitStart(t, executor.started)
	second := waitStart(t, executor.started)
	if first.projectID == second.projectID {
		t.Fatalf("same project ran concurrently: %+v, %+v", first, second)
	}
	steerRun, err := database.Run(ctx, first.runID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionRun(ctx, steerRun.ID, steerRun.Revision, core.RunPlanning, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := dispatcher.SteerRun(ctx, first.runID, "check the counter-evidence"); err != nil {
		t.Fatal(err)
	}
	executor.mu.Lock()
	steered := append([]string(nil), executor.steered[first.runID]...)
	executor.mu.Unlock()
	if len(steered) != 1 || steered[0] != "check the counter-evidence" {
		t.Fatalf("steering messages = %#v", steered)
	}
	select {
	case third := <-executor.started:
		t.Fatalf("third run exceeded global limit: %+v", third)
	case <-time.After(100 * time.Millisecond):
	}
	finishedA1, err := database.Run(ctx, runA1.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionRun(ctx, finishedA1.ID, finishedA1.Revision, core.RunCancelled, "fixture completed"); err != nil {
		t.Fatal(err)
	}
	executor.release(runA1.ID)
	third := waitStart(t, executor.started)
	if third.runID != runA2.ID {
		t.Fatalf("project FIFO started %s, want %s", third.runID, runA2.ID)
	}
	executor.release(runA2.ID)
	executor.release(runB.ID)
	executor.mu.Lock()
	maxActive := executor.maxActive
	executor.mu.Unlock()
	if maxActive > MaxConcurrentRuns {
		t.Fatalf("max active = %d", maxActive)
	}
}

func TestDispatcherDoesNotBypassOlderInterruptedRunAfterRestart(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	database, err := store.Open(ctx, filepath.Join(t.TempDir(), "restart-fifo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	project, err := database.CreateProject(ctx, "restart FIFO")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetProjectMainThread(ctx, project.ID, "thread-fifo"); err != nil {
		t.Fatal(err)
	}
	older, err := database.CreateRun(ctx, project.ID, "", "older", "thread-fifo")
	if err != nil {
		t.Fatal(err)
	}
	older, err = database.TransitionRun(ctx, older.ID, older.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	older, err = database.TransitionRun(ctx, older.ID, older.Revision, core.RunInterrupted, "restart")
	if err != nil {
		t.Fatal(err)
	}
	newer, err := database.CreateRun(ctx, project.ID, "", "newer", "thread-fifo")
	if err != nil {
		t.Fatal(err)
	}
	executor := &blockingExecutor{db: database, started: make(chan executionStart, 2), releases: make(map[string]chan struct{}), steered: make(map[string][]string)}
	dispatcher := &Dispatcher{DB: database, Executor: executor, Configurations: acceptingConfigurationValidator{}}
	if err := dispatcher.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		shutdown, stop := context.WithTimeout(context.Background(), 3*time.Second)
		defer stop()
		_ = dispatcher.Shutdown(shutdown)
	})
	select {
	case started := <-executor.started:
		t.Fatalf("newer run bypassed unresolved predecessor: %+v", started)
	case <-time.After(100 * time.Millisecond):
	}
	if _, err := dispatcher.DiscardRun(ctx, older.ID); err != nil {
		t.Fatal(err)
	}
	started := waitStart(t, executor.started)
	if started.runID != newer.ID {
		t.Fatalf("started %s after resolving predecessor, want %s", started.runID, newer.ID)
	}
	executor.release(newer.ID)
}

func TestProjectChatUsesMainThreadWithoutCreatingResearchRun(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	database, err := store.Open(ctx, filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	project, err := database.CreateProject(ctx, "chat")
	if err != nil {
		t.Fatal(err)
	}
	protocol := &chatProtocolFixture{}
	dispatcher := &Dispatcher{
		DB: database, Executor: idleExecutor{}, Threads: protocol, Configurations: acceptingConfigurationValidator{},
	}
	if err := dispatcher.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		shutdown, stop := context.WithTimeout(context.Background(), 3*time.Second)
		defer stop()
		_ = dispatcher.Shutdown(shutdown)
	})
	configuration := core.RunConfiguration{Model: core.PlannerModel, ReasoningEffort: core.PlannerEffort, ServiceTier: core.ServiceTierDefault}
	reply, err := dispatcher.ChatProject(ctx, project.ID, "scope the research", core.ChatModePlan, "pln_test", configuration)
	if err != nil {
		t.Fatal(err)
	}
	if reply.Text != "reply" || reply.ProjectID != project.ID || protocol.threadID != "thread-chat" || protocol.mode != core.ChatModePlan {
		t.Fatalf("chat reply=%+v protocol=%+v", reply, protocol)
	}
	storedProject, err := database.Project(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	session, err := database.DefaultConversationSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if storedProject.MainThreadID != "thread-chat" || protocol.createdSessionID != session.ID || reply.ConversationSessionID != session.ID {
		t.Fatalf("main thread=%q created session=%q reply session=%q", storedProject.MainThreadID, protocol.createdSessionID, reply.ConversationSessionID)
	}
	runs, err := database.ListRuns(ctx, project.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 0 {
		t.Fatalf("chat created %d research runs", len(runs))
	}
	history, err := dispatcher.ChatHistorySession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if history.ConversationSessionID != session.ID || history.ThreadID != "thread-chat" || len(history.Messages) != 1 {
		t.Fatalf("chat history=%+v", history)
	}
}

func TestUnprovisionedSessionHistoryIsExplicitlyEmpty(t *testing.T) {
	ctx := context.Background()
	database, err := store.Open(ctx, filepath.Join(t.TempDir(), "empty-history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	project, err := database.CreateProject(ctx, "empty history")
	if err != nil {
		t.Fatal(err)
	}
	session, err := database.DefaultConversationSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	dispatcher := &Dispatcher{DB: database, Threads: &chatProtocolFixture{}}
	history, err := dispatcher.ChatHistorySession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if history.ConversationSessionID != session.ID || history.ThreadID != "" || history.Messages == nil || len(history.Messages) != 0 {
		t.Fatalf("empty chat history=%+v", history)
	}
}

func waitStart(t *testing.T, started <-chan executionStart) executionStart {
	t.Helper()
	select {
	case value := <-started:
		return value
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for execution start")
		return executionStart{}
	}
}
