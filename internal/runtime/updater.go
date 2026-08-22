package runtime

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"
)

type IdleCheck func(context.Context) (bool, error)

// UpdateStatus is the read-only product state exposed to the loopback API. A
// missing trust root is explicit; it is never represented as a successful
// check or as use of an unverified fallback.
type UpdateStatus struct {
	Configured       bool       `json:"configured"`
	Channel          string     `json:"channel"`
	FeedHost         string     `json:"feed_host,omitempty"`
	DisabledReason   string     `json:"disabled_reason,omitempty"`
	LastError        string     `json:"last_error,omitempty"`
	LastAttemptAt    *time.Time `json:"last_attempt_at,omitempty"`
	PendingRestartID string     `json:"pending_restart_id,omitempty"`
	ActivatedID      string     `json:"activated_id,omitempty"`
	Runtime          Status     `json:"runtime"`
}

// Updater connects the durable Manager to the signed stable feed. It stages
// only while the application is idle and activates only a candidate that was
// already pending when this process started.
type Updater struct {
	Manager        *Manager
	Feed           *FeedClient
	Idle           IdleCheck
	DisabledReason string
	PollInterval   time.Duration

	mu               sync.RWMutex
	lastError        string
	lastAttemptAt    *time.Time
	pendingRestartID string
	activatedID      string
}

func (updater *Updater) configured() bool {
	return updater != nil && updater.Manager != nil && updater.Feed != nil && updater.DisabledReason == ""
}

// ActivateOnStartup must be called before runtime paths are resolved. It never
// activates a candidate staged later by this same process.
func (updater *Updater) ActivateOnStartup(ctx context.Context) error {
	if updater == nil || updater.Manager == nil {
		return errors.New("runtime updater manager is required")
	}
	if !updater.configured() {
		return nil
	}
	if _, err := updater.Manager.QuarantineInterruptedCandidates(); err != nil {
		return updater.fail("interrupted-candidate-recovery-failed", "updater", err)
	}
	status, err := updater.Manager.Status()
	if err != nil {
		return updater.fail("runtime-status-invalid", "updater", err)
	}
	var pending []Candidate
	for _, candidate := range status.Candidates {
		if candidate.Status == CandidatePending {
			pending = append(pending, candidate)
		}
	}
	if len(pending) == 0 {
		return nil
	}
	if len(pending) != 1 {
		return updater.fail("multiple-pending-candidates", "updater",
			fmt.Errorf("found %d pending runtime candidates; activation refused", len(pending)))
	}
	active, err := updater.Manager.ActivatePending(ctx, pending[0].ID)
	if err != nil {
		return updater.fail("pending-runtime-activation-failed", pending[0].ID, err)
	}
	updater.mu.Lock()
	updater.activatedID = active.CandidateID
	updater.pendingRestartID = ""
	updater.lastError = ""
	updater.mu.Unlock()
	return nil
}

// Run performs a due check immediately and then re-evaluates once per minute
// by default. CheckDue itself supplies the durable 24-hour guard.
func (updater *Updater) Run(ctx context.Context) error {
	if updater == nil || updater.Manager == nil {
		return errors.New("runtime updater manager is required")
	}
	if !updater.configured() {
		<-ctx.Done()
		return nil
	}
	interval := updater.PollInterval
	if interval <= 0 {
		interval = time.Minute
	}
	_ = updater.CheckIfDue(ctx)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			_ = updater.CheckIfDue(ctx)
		}
	}
}

func (updater *Updater) CheckIfDue(ctx context.Context) (returnErr error) {
	if updater == nil || updater.Manager == nil {
		return errors.New("runtime updater manager is required")
	}
	if !updater.configured() {
		return nil
	}
	idle := true
	var err error
	if updater.Idle != nil {
		idle, err = updater.Idle(ctx)
		if err != nil {
			return updater.fail("idle-check-failed", "updater", err)
		}
	}
	now := time.Now().UTC()
	if updater.Feed.Now != nil {
		now = updater.Feed.Now().UTC()
	}
	due, err := updater.Manager.CheckDue(now, idle)
	if err != nil {
		return updater.fail("update-check-state-invalid", "updater", err)
	}
	if !due {
		return nil
	}
	updater.mu.Lock()
	attempt := now
	updater.lastAttemptAt = &attempt
	updater.mu.Unlock()
	defer func() {
		if recordErr := updater.Manager.RecordCheck(now); recordErr != nil {
			returnErr = errors.Join(returnErr, updater.fail("update-check-record-failed", "updater", recordErr))
		}
	}()
	release, err := updater.Feed.Fetch(ctx)
	if err != nil {
		return updater.fail("stable-feed-check-failed", "updater", err)
	}
	status, err := updater.Manager.Status()
	if err != nil {
		return updater.fail("runtime-status-invalid", release.ID, err)
	}
	for _, candidate := range status.Candidates {
		if candidate.ID != release.ID {
			continue
		}
		switch candidate.Status {
		case CandidatePending:
			updater.mu.Lock()
			updater.pendingRestartID = candidate.ID
			updater.lastError = ""
			updater.mu.Unlock()
			return nil
		case CandidateActive:
			updater.mu.Lock()
			updater.activatedID = candidate.ID
			updater.lastError = ""
			updater.mu.Unlock()
			return nil
		default:
			return updater.fail("interrupted-runtime-candidate", candidate.ID,
				fmt.Errorf("runtime candidate %s is %s; automatic resubmission refused", candidate.ID, candidate.Status))
		}
	}
	quarantined, err := updater.Manager.CandidateQuarantined(release.ID)
	if err != nil {
		return updater.fail("quarantined-candidate-state-invalid", release.ID, err)
	}
	if quarantined {
		return updater.fail("quarantined-runtime-candidate", release.ID,
			fmt.Errorf("runtime candidate %s is already quarantined; automatic resubmission refused", release.ID))
	}
	if updater.Idle != nil {
		stillIdle, idleErr := updater.Idle(ctx)
		if idleErr != nil {
			return updater.fail("idle-recheck-failed", release.ID, idleErr)
		}
		if !stillIdle {
			return nil
		}
	}
	candidate, err := updater.Manager.Stage(ctx, release)
	if err != nil {
		updater.setLastError(err)
		return err
	}
	updater.mu.Lock()
	updater.pendingRestartID = candidate.ID
	updater.lastError = ""
	updater.mu.Unlock()
	return nil
}

func (updater *Updater) Snapshot() UpdateStatus {
	status := UpdateStatus{Channel: "stable"}
	if updater == nil {
		status.DisabledReason = "runtime updater is unavailable"
		return status
	}
	status.Configured = updater.configured()
	status.DisabledReason = strings.TrimSpace(updater.DisabledReason)
	if updater.Feed != nil {
		if parsed, err := url.Parse(updater.Feed.URL); err == nil {
			status.FeedHost = parsed.Host
		}
	}
	durablePendingID := ""
	durableActivatedID := ""
	if updater.Manager != nil {
		if runtimeStatus, err := updater.Manager.Status(); err == nil {
			status.Runtime = runtimeStatus
			if runtimeStatus.Active != nil {
				durableActivatedID = runtimeStatus.Active.CandidateID
			}
			for _, candidate := range runtimeStatus.Candidates {
				if candidate.Status == CandidatePending {
					if durablePendingID == "" {
						durablePendingID = candidate.ID
					} else {
						// Multiple pending candidates are an invalid activation
						// state. ActivateOnStartup records the actionable warning;
						// do not present either one as the unique restart target.
						durablePendingID = ""
						break
					}
				}
			}
			if runtimeStatus.LastCheckedAt != nil {
				checkedAt := *runtimeStatus.LastCheckedAt
				status.LastAttemptAt = &checkedAt
			}
		} else if status.DisabledReason == "" {
			status.DisabledReason = "runtime state is unreadable: " + err.Error()
		}
	}
	updater.mu.RLock()
	status.LastError = updater.lastError
	status.PendingRestartID = updater.pendingRestartID
	status.ActivatedID = updater.activatedID
	if status.PendingRestartID == "" {
		status.PendingRestartID = durablePendingID
	}
	if status.ActivatedID == "" {
		status.ActivatedID = durableActivatedID
	}
	if updater.lastAttemptAt != nil {
		copy := *updater.lastAttemptAt
		status.LastAttemptAt = &copy
	}
	updater.mu.RUnlock()
	return status
}

func (updater *Updater) Warnings() []string {
	status := updater.Snapshot()
	warnings := make([]string, 0, len(status.Runtime.Warnings)+2)
	if status.DisabledReason != "" {
		warnings = append(warnings, status.DisabledReason)
	}
	if status.LastError != "" {
		warnings = append(warnings, "관리 런타임 업데이트 확인 실패: "+status.LastError)
	}
	for _, warning := range status.Runtime.Warnings {
		warnings = append(warnings, fmt.Sprintf("관리 런타임 경고 [%s]: %s", warning.Code, warning.Message))
	}
	return warnings
}

func (updater *Updater) fail(code, candidateID string, err error) error {
	if err == nil {
		return nil
	}
	updater.setLastError(err)
	message := "Managed runtime updater failed closed: " + err.Error()
	if updater.Manager != nil {
		return errors.Join(err, updater.Manager.RecordWarning(code, candidateID, message))
	}
	return err
}

func (updater *Updater) setLastError(err error) {
	updater.mu.Lock()
	defer updater.mu.Unlock()
	if err == nil {
		updater.lastError = ""
		return
	}
	updater.lastError = err.Error()
}
