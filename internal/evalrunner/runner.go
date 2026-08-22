package evalrunner

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/evalgate"
)

func Start(ctx context.Context, config Config) (Receipt, error) {
	return execute(ctx, config, false)
}

func Resume(ctx context.Context, config Config) (Receipt, error) {
	return execute(ctx, config, true)
}

func execute(ctx context.Context, config Config, resume bool) (receipt Receipt, returnErr error) {
	if err := config.validate(); err != nil {
		return Receipt{}, err
	}
	endpoint, err := normalizeEndpoint(config.Endpoint)
	if err != nil {
		return Receipt{}, err
	}
	client, err := newAPIClient(config, endpoint)
	if err != nil {
		return Receipt{}, err
	}
	var log *journal
	if resume {
		log, err = openJournal(config, endpoint)
	} else {
		log, err = createJournal(config, endpoint)
	}
	if err != nil {
		return Receipt{}, err
	}
	defer func() { returnErr = errors.Join(returnErr, log.Close()) }()
	if err := client.preflight(ctx, config.ProductBuild); err != nil {
		return Receipt{}, err
	}
	if err := resolveCrashSubmitting(log, config); err != nil {
		return Receipt{}, err
	}
	if err := submitNotStarted(ctx, log, client, config); err != nil {
		return Receipt{}, err
	}
	interval := config.PollInterval
	if interval == 0 {
		interval = 2 * time.Second
	}
	for {
		if runnerComplete(log.state) {
			receipt = buildReceipt(log.state, config)
			if err := writeJSONNew(config.OutputPath, receipt); err != nil {
				return Receipt{}, err
			}
			if !receipt.EligibleForOfflineVerification {
				return receipt, ErrRunSetIncomplete
			}
			return receipt, nil
		}
		if err := pollStarted(ctx, log, client, config); err != nil {
			if ctx.Err() != nil {
				return Receipt{}, ctx.Err()
			}
			return Receipt{}, err
		}
		if runnerComplete(log.state) {
			continue
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return Receipt{}, ctx.Err()
		case <-timer.C:
		}
	}
}

func resolveCrashSubmitting(log *journal, config Config) error {
	now := runnerNow(config)
	for _, item := range config.Dataset.Cases {
		snapshot := log.state.Cases[item.ID]
		if snapshot.Event.State != CaseSubmitting {
			continue
		}
		event := snapshot.Event
		event.State = CaseAmbiguous
		event.FailureCode = "submission_interrupted_after_durable_intent"
		if err := log.appendEvent(event, now); err != nil {
			return err
		}
	}
	return nil
}

func submitNotStarted(ctx context.Context, log *journal, client *apiClient, config Config) error {
	usedRuns := make(map[string]string)
	for caseID, snapshot := range log.state.Cases {
		if snapshot.Event.RunID != "" {
			usedRuns[snapshot.Event.RunID] = caseID
		}
	}
	for _, item := range config.Dataset.Cases {
		snapshot := log.state.Cases[item.ID]
		if snapshot.Event.State != CaseNotStarted {
			continue
		}
		now := runnerNow(config)
		intent := snapshot.Event
		intent.State = CaseSubmitting
		if err := log.appendEvent(intent, now); err != nil {
			return err
		}
		run, ambiguous, err := client.startRun(ctx, config.Target, item.Prompt())
		now = runnerNow(config)
		if err != nil {
			event := intent
			if ambiguous {
				event.State = CaseAmbiguous
				event.FailureCode = "submission_outcome_ambiguous"
			} else {
				event.State = CaseSubmissionFailed
				event.FailureCode = "submission_rejected"
			}
			if appendErr := log.appendEvent(event, now); appendErr != nil {
				return errors.Join(err, appendErr)
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			continue
		}
		startedAt := run.CreatedAt.UTC()
		if startedAt.IsZero() {
			startedAt = now
		}
		if priorCase, duplicate := usedRuns[run.ID]; duplicate {
			event := intent
			event.State = CaseAmbiguous
			event.RunID = run.ID
			event.StartedAt = &startedAt
			event.FailureCode = "duplicate_run_id"
			if err := log.appendEvent(event, now); err != nil {
				return err
			}
			_ = priorCase
			continue
		}
		if err := validateRunBinding(run, item, config); err != nil {
			event := intent
			event.State = CaseAmbiguous
			event.RunID = run.ID
			event.StartedAt = &startedAt
			event.FailureCode = "accepted_run_binding_mismatch"
			if appendErr := log.appendEvent(event, now); appendErr != nil {
				return errors.Join(err, appendErr)
			}
			continue
		}
		usedRuns[run.ID] = item.ID
		event := intent
		event.State = CaseStarted
		event.RunID = run.ID
		event.ProductStatus = run.Status
		event.ProductRevision = run.Revision
		event.StartedAt = &startedAt
		if observedTerminal(run.Status) {
			terminalAt := run.UpdatedAt.UTC()
			if terminalAt.IsZero() {
				terminalAt = now
			}
			event.State = CaseTerminal
			event.TerminalAt = &terminalAt
		}
		if err := log.appendEvent(event, now); err != nil {
			return err
		}
	}
	return nil
}

func pollStarted(ctx context.Context, log *journal, client *apiClient, config Config) error {
	for _, item := range config.Dataset.Cases {
		snapshot := log.state.Cases[item.ID]
		if snapshot.Event.State != CaseStarted {
			continue
		}
		run, err := client.run(ctx, snapshot.Event.RunID)
		if err != nil {
			return err
		}
		if err := validateRunBinding(run, item, config); err != nil {
			return err
		}
		if run.ID != snapshot.Event.RunID {
			return errors.New("run status readback changed the durable run id")
		}
		event := snapshot.Event
		event.ProductStatus = run.Status
		event.ProductRevision = run.Revision
		event.PendingApprovals = nil
		if run.Status == core.RunWaitingApproval {
			approvals, err := client.approvals(ctx, run.ID)
			if err != nil {
				return err
			}
			event.PendingApprovals = approvals
		}
		now := runnerNow(config)
		if observedTerminal(run.Status) {
			event.State = CaseTerminal
			terminalAt := run.UpdatedAt.UTC()
			if terminalAt.IsZero() {
				terminalAt = now
			}
			event.TerminalAt = &terminalAt
		}
		if eventsEqual(snapshot.Event, event) {
			continue
		}
		if err := log.appendEvent(event, now); err != nil {
			return err
		}
	}
	return nil
}

func validateRunBinding(run core.Run, item evalgate.Case, config Config) error {
	if run.ProductBuild != config.ProductBuild {
		return errors.New("run product build differs from the packaged evaluation build")
	}
	if run.Question != item.Prompt() {
		return errors.New("run question differs from the exact evaluation prompt")
	}
	if config.Target.ProjectID != "" && run.ProjectID != config.Target.ProjectID {
		return errors.New("run belongs to a different project")
	}
	if config.Target.SessionID != "" && run.ConversationSessionID != config.Target.SessionID {
		return errors.New("run belongs to a different conversation session")
	}
	return nil
}

func eventsEqual(left, right caseEvent) bool {
	if left.State != right.State || left.RunID != right.RunID || left.ProductStatus != right.ProductStatus ||
		left.ProductRevision != right.ProductRevision || left.FailureCode != right.FailureCode ||
		!timesEqual(left.StartedAt, right.StartedAt) || !timesEqual(left.TerminalAt, right.TerminalAt) ||
		len(left.PendingApprovals) != len(right.PendingApprovals) {
		return false
	}
	for index := range left.PendingApprovals {
		if left.PendingApprovals[index] != right.PendingApprovals[index] {
			return false
		}
	}
	return true
}

func timesEqual(left, right *time.Time) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.Equal(*right)
}

func runnerComplete(state journalState) bool {
	for _, snapshot := range state.Cases {
		switch snapshot.Event.State {
		case CaseTerminal, CaseAmbiguous, CaseSubmissionFailed:
		default:
			return false
		}
	}
	return len(state.Cases) == 12
}

func buildReceipt(state journalState, config Config) Receipt {
	terminalAt := runnerNow(config)
	receipt := Receipt{
		Schema: ReceiptSchemaV1, RunOrigin: RunOrigin, EvidenceClass: state.Header.EvidenceClass,
		ReleaseGatePassed: false, RequiresOfflineVerification: true,
		EvalRunSetID: state.Header.EvalRunSetID, DatasetName: state.Header.DatasetName,
		DatasetSHA256: state.Header.DatasetSHA256, ProductBuild: state.Header.ProductBuild,
		EndpointSHA256: state.Header.EndpointSHA256,
		Target:         state.Header.Target, StartedAt: state.Header.StartedAt, TerminalAt: terminalAt,
		Completeness: Completeness{ExpectedCases: 12, AccountedCases: len(state.Cases)},
		Cases:        make([]CaseReceipt, 0, len(state.Cases)),
	}
	ordered := make([]caseRegistration, len(state.Header.Cases))
	copy(ordered, state.Header.Cases)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].CaseID < ordered[j].CaseID })
	for _, registration := range ordered {
		snapshot := state.Cases[registration.CaseID]
		event := snapshot.Event
		item := CaseReceipt{
			RunOrigin: RunOrigin, EvalRunSetID: state.Header.EvalRunSetID,
			DatasetCaseID: registration.CaseID, Mode: registration.Mode,
			PromptSHA256: registration.PromptSHA256, State: event.State,
			RunID: event.RunID, ProductStatus: event.ProductStatus,
			ProductRevision: event.ProductRevision, StartedAt: event.StartedAt,
			TerminalAt: event.TerminalAt, PendingApprovals: event.PendingApprovals,
			FailureCode: event.FailureCode,
		}
		receipt.Cases = append(receipt.Cases, item)
		switch event.State {
		case CaseTerminal:
			receipt.Completeness.RunnerTerminalCases++
			receipt.Completeness.ProductTerminalCases++
		case CaseAmbiguous:
			receipt.Completeness.RunnerTerminalCases++
			receipt.Completeness.AmbiguousCases++
		case CaseSubmissionFailed:
			receipt.Completeness.RunnerTerminalCases++
			receipt.Completeness.SubmissionFailures++
		}
	}
	receipt.Completeness.AllProductRunsTerminal = receipt.Completeness.ProductTerminalCases == 12
	receipt.EligibleForOfflineVerification = state.Header.EvidenceClass == EvidenceLiveProductAPI &&
		receipt.Completeness.AllProductRunsTerminal && receipt.Completeness.AccountedCases == 12
	return receipt
}

func runnerNow(config Config) time.Time {
	if config.Now != nil {
		return config.Now().UTC()
	}
	return time.Now().UTC()
}
