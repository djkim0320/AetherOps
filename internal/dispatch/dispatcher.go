package dispatch

import (
	"context"
	"errors"
	"strings"
	"sync"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
)

const MaxConcurrentRuns = 2

type Executor interface {
	Execute(context.Context, string) error
	Steer(context.Context, string, string) error
}

type MainThreadProtocol interface {
	CreateMainThread(context.Context, string, core.RunConfiguration) (string, error)
	Chat(context.Context, string, string, core.ChatMode, string, string, core.RunConfiguration) (core.ChatReply, error)
	ChatHistory(context.Context, string) (core.ChatHistory, error)
}

type RunConfigurationValidator interface {
	ValidateRunConfiguration(context.Context, core.RunConfiguration) error
}

type queueItem struct {
	runID     string
	projectID string
	sessionID string
}

type Dispatcher struct {
	DB             *store.DB
	Executor       Executor
	Threads        MainThreadProtocol
	Configurations RunConfigurationValidator

	ctx    context.Context
	cancel context.CancelFunc
	wake   chan struct{}
	done   chan struct{}

	mu             sync.Mutex
	conversationMu sync.Mutex
	conversations  map[string]*sync.Mutex
	wg             sync.WaitGroup
	queue          []queueItem
	queued         map[string]bool
	activeProjects map[string]bool
	activeSessions map[string]bool
	activeCancels  map[string]context.CancelFunc
	closed         bool
}

func (dispatcher *Dispatcher) Start(ctx context.Context) error {
	if dispatcher.DB == nil || dispatcher.Executor == nil {
		return errors.New("dispatcher database and executor are required")
	}
	dispatcher.mu.Lock()
	if dispatcher.ctx != nil {
		dispatcher.mu.Unlock()
		return errors.New("dispatcher is already started")
	}
	dispatcher.ctx, dispatcher.cancel = context.WithCancel(ctx)
	dispatcher.wake = make(chan struct{}, 1)
	dispatcher.done = make(chan struct{})
	dispatcher.queued = make(map[string]bool)
	dispatcher.activeProjects = make(map[string]bool)
	dispatcher.activeSessions = make(map[string]bool)
	dispatcher.activeCancels = make(map[string]context.CancelFunc)
	dispatcher.mu.Unlock()

	queued, err := dispatcher.DB.ListRunsByStatus(ctx, core.RunQueued)
	if err != nil {
		dispatcher.cancel()
		return err
	}
	for _, run := range queued {
		dispatcher.enqueue(run)
	}
	go dispatcher.loop()
	dispatcher.signal()
	return nil
}

// ReloadQueued picks up runs inserted transactionally by the scheduler after
// the dispatcher started. enqueue de-duplicates active and already queued ids.
func (dispatcher *Dispatcher) ReloadQueued(ctx context.Context) error {
	queued, err := dispatcher.DB.ListRunsByStatus(ctx, core.RunQueued)
	if err != nil {
		return err
	}
	for _, run := range queued {
		dispatcher.enqueue(run)
	}
	return nil
}

func (dispatcher *Dispatcher) Shutdown(ctx context.Context) error {
	dispatcher.mu.Lock()
	if dispatcher.ctx == nil {
		dispatcher.mu.Unlock()
		return nil
	}
	dispatcher.closed = true
	for _, cancel := range dispatcher.activeCancels {
		cancel()
	}
	dispatcher.cancel()
	done := dispatcher.done
	dispatcher.mu.Unlock()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (dispatcher *Dispatcher) StartRun(ctx context.Context, projectID, question string, configuration core.RunConfiguration) (core.Run, error) {
	session, err := dispatcher.DB.DefaultConversationSession(ctx, projectID)
	if err != nil {
		return core.Run{}, err
	}
	return dispatcher.StartSessionRun(ctx, session.ID, question, configuration)
}

func (dispatcher *Dispatcher) StartSessionRun(ctx context.Context, sessionID, question string, configuration core.RunConfiguration) (core.Run, error) {
	return dispatcher.startSessionRun(ctx, sessionID, question, "", configuration)
}

func (dispatcher *Dispatcher) StartPlannedSessionRun(ctx context.Context, sessionID, planCycleID string, configuration core.RunConfiguration) (core.Run, error) {
	return dispatcher.startSessionRun(ctx, sessionID, "", planCycleID, configuration)
}

func (dispatcher *Dispatcher) startSessionRun(ctx context.Context, sessionID, question, planCycleID string, configuration core.RunConfiguration) (core.Run, error) {
	conversation := dispatcher.sessionConversation(sessionID)
	conversation.Lock()
	defer conversation.Unlock()
	if dispatcher.Configurations == nil {
		return core.Run{}, errors.New("run model configuration validator is not configured")
	}
	if err := dispatcher.Configurations.ValidateRunConfiguration(ctx, configuration); err != nil {
		return core.Run{}, err
	}
	if err := dispatcher.DB.UpdateConversationSessionSettings(ctx, sessionID, configuration); err != nil {
		return core.Run{}, err
	}
	session, err := dispatcher.ensureSessionThread(ctx, sessionID, configuration)
	if err != nil {
		return core.Run{}, err
	}
	var run core.Run
	if planCycleID != "" {
		run, err = dispatcher.DB.CreatePlannedConversationRunConfigured(ctx, session.ID, planCycleID, session.CodexThreadID, configuration)
	} else {
		run, err = dispatcher.DB.CreateConversationRunConfigured(ctx, session.ID, "", question, session.CodexThreadID, configuration)
	}
	if err != nil {
		return core.Run{}, err
	}
	if !dispatcher.enqueue(run) {
		return core.Run{}, errors.New("dispatcher is stopped")
	}
	return run, nil
}

func (dispatcher *Dispatcher) ChatProject(
	ctx context.Context,
	projectID, message string,
	mode core.ChatMode,
	planCycleID string,
	configuration core.RunConfiguration,
) (core.ChatReply, error) {
	session, err := dispatcher.DB.DefaultConversationSession(ctx, projectID)
	if err != nil {
		return core.ChatReply{}, err
	}
	return dispatcher.ChatSession(ctx, session.ID, message, mode, planCycleID, configuration)
}

func (dispatcher *Dispatcher) ChatSession(
	ctx context.Context,
	sessionID, message string,
	mode core.ChatMode,
	planCycleID string,
	configuration core.RunConfiguration,
) (core.ChatReply, error) {
	conversation := dispatcher.sessionConversation(sessionID)
	conversation.Lock()
	defer conversation.Unlock()
	if dispatcher.Threads == nil || dispatcher.Configurations == nil {
		return core.ChatReply{}, errors.New("project chat protocol is not configured")
	}
	if err := mode.Validate(); err != nil {
		return core.ChatReply{}, err
	}
	if err := dispatcher.Configurations.ValidateRunConfiguration(ctx, configuration); err != nil {
		return core.ChatReply{}, err
	}
	if dispatcher.sessionHasResearchWork(sessionID) {
		return core.ChatReply{}, core.ErrProjectResearchActive
	}
	if err := dispatcher.DB.UpdateConversationSessionSettings(ctx, sessionID, configuration); err != nil {
		return core.ChatReply{}, err
	}
	session, err := dispatcher.ensureSessionThread(ctx, sessionID, configuration)
	if err != nil {
		return core.ChatReply{}, err
	}
	planObjective := ""
	if mode == core.ChatModePlan {
		cycle, err := dispatcher.DB.RequireActiveConversationPlanCycle(ctx, sessionID, planCycleID)
		if err != nil {
			return core.ChatReply{}, err
		}
		planObjective = cycle.Objective
	}
	reply, err := dispatcher.Threads.Chat(
		ctx, session.CodexThreadID, strings.TrimSpace(message), mode, planCycleID, planObjective, configuration,
	)
	if err != nil {
		return core.ChatReply{}, err
	}
	reply.ProjectID = session.ProjectID
	reply.ConversationSessionID = session.ID
	return reply, nil
}

// ChatHistorySession reads a display projection while holding the same
// per-session lock as ChatSession, so a late history response cannot race a
// newly submitted turn.
func (dispatcher *Dispatcher) ChatHistorySession(ctx context.Context, sessionID string) (core.ChatHistory, error) {
	conversation := dispatcher.sessionConversation(sessionID)
	conversation.Lock()
	defer conversation.Unlock()
	if dispatcher.Threads == nil {
		return core.ChatHistory{}, errors.New("project chat protocol is not configured")
	}
	session, err := dispatcher.DB.ConversationSession(ctx, sessionID)
	if err != nil {
		return core.ChatHistory{}, err
	}
	if session.CodexThreadID == "" {
		return core.ChatHistory{
			ConversationSessionID: session.ID,
			Messages:              []core.ChatHistoryMessage{},
		}, nil
	}
	history, err := dispatcher.Threads.ChatHistory(ctx, session.CodexThreadID)
	if err != nil {
		return core.ChatHistory{}, err
	}
	history.ConversationSessionID = session.ID
	return history, nil
}

func (dispatcher *Dispatcher) ensureSessionThread(ctx context.Context, sessionID string, configuration core.RunConfiguration) (core.ConversationSession, error) {
	session, err := dispatcher.DB.ConversationSession(ctx, sessionID)
	if err != nil {
		return core.ConversationSession{}, err
	}
	if session.CodexThreadID != "" {
		return session, nil
	}
	if session.Status == "creation_unknown" || session.Status == "provisioning" {
		return core.ConversationSession{}, store.ErrConversationSessionCreationUnknown
	}
	if dispatcher.Threads == nil {
		return core.ConversationSession{}, errors.New("main Codex thread protocol is not configured")
	}
	session, err = dispatcher.DB.MarkConversationSessionProvisioning(ctx, sessionID)
	if err != nil {
		return core.ConversationSession{}, err
	}
	created, err := dispatcher.Threads.CreateMainThread(ctx, sessionID, configuration)
	if err != nil {
		markErr := dispatcher.DB.MarkConversationSessionCreationUnknown(ctx, sessionID)
		return core.ConversationSession{}, errors.Join(err, markErr)
	}
	session.CodexThreadID, err = dispatcher.DB.SetConversationSessionThreadIfEmpty(ctx, sessionID, created)
	if err != nil {
		markErr := dispatcher.DB.MarkConversationSessionCreationUnknown(ctx, sessionID)
		return core.ConversationSession{}, errors.Join(err, markErr)
	}
	session.Status = "active"
	return session, err
}

func (dispatcher *Dispatcher) sessionConversation(sessionID string) *sync.Mutex {
	dispatcher.conversationMu.Lock()
	defer dispatcher.conversationMu.Unlock()
	if dispatcher.conversations == nil {
		dispatcher.conversations = make(map[string]*sync.Mutex)
	}
	if dispatcher.conversations[sessionID] == nil {
		dispatcher.conversations[sessionID] = &sync.Mutex{}
	}
	return dispatcher.conversations[sessionID]
}

func (dispatcher *Dispatcher) sessionHasResearchWork(sessionID string) bool {
	dispatcher.mu.Lock()
	defer dispatcher.mu.Unlock()
	if dispatcher.activeSessions[sessionID] {
		return true
	}
	for _, item := range dispatcher.queue {
		if item.sessionID == sessionID {
			return true
		}
	}
	return false
}

func (dispatcher *Dispatcher) ResumeRun(ctx context.Context, runID string) (core.Run, error) {
	run, err := dispatcher.DB.Run(ctx, runID)
	if err != nil {
		return core.Run{}, err
	}
	if run.Status != core.RunInterrupted {
		return core.Run{}, errors.New("only interrupted runs can be resumed")
	}
	if err := dispatcher.DB.PrepareInterruptedRunForResume(ctx, run.ID); err != nil {
		return core.Run{}, err
	}
	if !dispatcher.enqueue(run) {
		return core.Run{}, errors.New("dispatcher is stopped")
	}
	return run, nil
}

func (dispatcher *Dispatcher) SteerRun(ctx context.Context, runID, message string) (core.Run, error) {
	message = strings.TrimSpace(message)
	if message == "" {
		return core.Run{}, errors.New("steering message is required")
	}
	run, err := dispatcher.DB.Run(ctx, runID)
	if err != nil {
		return core.Run{}, err
	}
	dispatcher.mu.Lock()
	active := dispatcher.activeCancels[runID] != nil
	dispatcher.mu.Unlock()
	if !active || core.IsTerminal(run.Status) || run.Status == core.RunQueued || run.Status == core.RunInterrupted || run.Status == core.RunUncertain {
		return core.Run{}, errors.New("run has no active turn to steer")
	}
	if err := dispatcher.Executor.Steer(ctx, runID, message); err != nil {
		return core.Run{}, err
	}
	return dispatcher.DB.Run(ctx, runID)
}

func (dispatcher *Dispatcher) CancelRun(ctx context.Context, runID string) (core.Run, error) {
	dispatcher.mu.Lock()
	if dispatcher.queued[runID] {
		for index, item := range dispatcher.queue {
			if item.runID == runID {
				dispatcher.queue = append(dispatcher.queue[:index], dispatcher.queue[index+1:]...)
				break
			}
		}
		delete(dispatcher.queued, runID)
	}
	if cancel := dispatcher.activeCancels[runID]; cancel != nil {
		cancel()
	}
	dispatcher.mu.Unlock()
	return dispatcher.DB.QuiesceRun(ctx, runID, core.RunCancelled, "cancelled by user")
}

func (dispatcher *Dispatcher) DiscardRun(ctx context.Context, runID string) (core.Run, error) {
	run, err := dispatcher.DB.Run(ctx, runID)
	if err != nil {
		return core.Run{}, err
	}
	if run.Status != core.RunInterrupted && run.Status != core.RunUncertain {
		return core.Run{}, errors.New("only interrupted or uncertain runs can be discarded")
	}
	updated, err := dispatcher.DB.TransitionRun(ctx, run.ID, run.Revision, core.RunCancelled, "discarded by user")
	if err == nil {
		dispatcher.signal()
	}
	return updated, err
}

func (dispatcher *Dispatcher) enqueue(run core.Run) bool {
	dispatcher.mu.Lock()
	defer dispatcher.mu.Unlock()
	if dispatcher.closed || dispatcher.ctx == nil || dispatcher.queued[run.ID] || dispatcher.activeCancels[run.ID] != nil {
		return false
	}
	dispatcher.queue = append(dispatcher.queue, queueItem{runID: run.ID, projectID: run.ProjectID, sessionID: run.ConversationSessionID})
	dispatcher.queued[run.ID] = true
	dispatcher.signalLocked()
	return true
}

func (dispatcher *Dispatcher) loop() {
	defer func() {
		dispatcher.wg.Wait()
		close(dispatcher.done)
	}()
	for {
		select {
		case <-dispatcher.ctx.Done():
			return
		case <-dispatcher.wake:
		}
		for dispatcher.startOne() {
		}
	}
}

func (dispatcher *Dispatcher) startOne() bool {
	dispatcher.mu.Lock()
	defer dispatcher.mu.Unlock()
	if dispatcher.closed || len(dispatcher.activeCancels) >= MaxConcurrentRuns {
		return false
	}
	selected := -1
	for index, item := range dispatcher.queue {
		if dispatcher.activeProjects[item.projectID] {
			continue
		}
		blocked, err := dispatcher.DB.HasEarlierUnresolvedRun(dispatcher.ctx, item.runID)
		if err != nil || blocked {
			continue
		}
		selected = index
		break
	}
	if selected < 0 {
		return false
	}
	item := dispatcher.queue[selected]
	dispatcher.queue = append(dispatcher.queue[:selected], dispatcher.queue[selected+1:]...)
	delete(dispatcher.queued, item.runID)
	runContext, cancel := context.WithCancel(dispatcher.ctx)
	dispatcher.activeProjects[item.projectID] = true
	dispatcher.activeSessions[item.sessionID] = true
	dispatcher.activeCancels[item.runID] = cancel
	dispatcher.wg.Add(1)
	go dispatcher.execute(runContext, item)
	return true
}

func (dispatcher *Dispatcher) execute(ctx context.Context, item queueItem) {
	defer dispatcher.wg.Done()
	err := dispatcher.Executor.Execute(ctx, item.runID)
	dispatcher.mu.Lock()
	delete(dispatcher.activeCancels, item.runID)
	delete(dispatcher.activeProjects, item.projectID)
	delete(dispatcher.activeSessions, item.sessionID)
	closed := dispatcher.closed
	dispatcher.mu.Unlock()
	if err != nil && !closed {
		dispatcher.finishErroredRun(item.runID, err)
	}
	dispatcher.signal()
}

func (dispatcher *Dispatcher) finishErroredRun(runID string, executionError error) {
	ctx := context.Background()
	requested := core.RunFailed
	message := executionError.Error()
	if errors.Is(executionError, context.Canceled) {
		requested = core.RunCancelled
		message = "cancelled"
	}
	_, _ = dispatcher.DB.QuiesceRun(ctx, runID, requested, message)
}

func (dispatcher *Dispatcher) signal() {
	dispatcher.mu.Lock()
	defer dispatcher.mu.Unlock()
	dispatcher.signalLocked()
}

func (dispatcher *Dispatcher) signalLocked() {
	select {
	case dispatcher.wake <- struct{}{}:
	default:
	}
}
