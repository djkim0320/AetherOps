//go:build windows && amd64

package integration

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/djkim0320/Aether-claw/internal/desktop"
)

// BrowserController keeps the human/automation mode explicit. The callback
// interrupts the active browser action before control is handed to the user.
type BrowserController struct {
	Host                 *desktop.Host
	PauseAutomation      func(context.Context) error
	ReobserveAutomation  func(context.Context) error
	ScheduleProfileReset func() error

	mu                  sync.RWMutex
	mode                string
	profileResetPending bool
	lastObservedAt      time.Time
}

func NewBrowserController(
	host *desktop.Host,
	pause func(context.Context) error,
	reobserve func(context.Context) error,
	scheduleProfileReset func() error,
) (*BrowserController, error) {
	if host == nil {
		return nil, errors.New("desktop host is required")
	}
	return &BrowserController{
		Host: host, PauseAutomation: pause, ReobserveAutomation: reobserve,
		ScheduleProfileReset: scheduleProfileReset, mode: "automatic",
	}, nil
}

func (controller *BrowserController) Status(_ context.Context) (any, error) {
	state := controller.Host.State()
	controller.mu.RLock()
	mode := controller.mode
	profileResetPending := controller.profileResetPending
	lastObservedAt := controller.lastObservedAt
	controller.mu.RUnlock()
	var lastObservation any
	if !lastObservedAt.IsZero() {
		lastObservation = lastObservedAt
	}
	status := "ready"
	if state.EmergencyStopped {
		status = "emergency_stopped"
	}
	return map[string]any{
		"mode": mode, "status": status, "active_surface": state.ActiveSurface.String(),
		"tab_count": state.TabCount, "window_visible": state.WindowVisible,
		"emergency_stopped":     state.EmergencyStopped,
		"profile_reset_pending": profileResetPending,
		"last_observed_at":      lastObservation,
	}, nil
}

func (controller *BrowserController) EmergencyStop(ctx context.Context) error {
	if controller.PauseAutomation != nil {
		if err := controller.PauseAutomation(ctx); err != nil {
			return err
		}
	}
	controller.mu.Lock()
	controller.mode = "manual"
	controller.mu.Unlock()
	return controller.Host.EmergencyStop(ctx)
}

func (controller *BrowserController) SetMode(ctx context.Context, mode string) error {
	controller.mu.RLock()
	profileResetPending := controller.profileResetPending
	currentMode := controller.mode
	controller.mu.RUnlock()
	if mode == "automatic" && profileResetPending {
		return errors.New("internet profile reset is pending; restart AetherOps before re-enabling automation")
	}
	switch mode {
	case "manual":
		if controller.PauseAutomation != nil {
			if err := controller.PauseAutomation(ctx); err != nil {
				return err
			}
		}
		if err := controller.Host.SelectSurface(ctx, desktop.SurfaceInternet); err != nil && !errors.Is(err, desktop.ErrEmergencyStopped) {
			return err
		}
	case "automatic":
		if controller.Host.State().EmergencyStopped {
			if err := controller.Host.ResetEmergencyStop(ctx); err != nil {
				return err
			}
			if _, err := controller.Host.CreateTab(ctx, desktop.SurfaceInternet); err != nil {
				return err
			}
		}
		if currentMode != "automatic" {
			if controller.ReobserveAutomation == nil {
				return errors.New("browser automation cannot resume until live page re-observation is available")
			}
			if err := controller.ReobserveAutomation(ctx); err != nil {
				return errors.Join(errors.New("browser automation remains paused because live page re-observation failed"), err)
			}
			controller.mu.Lock()
			controller.lastObservedAt = time.Now().UTC()
			controller.mu.Unlock()
		}
		if err := controller.Host.SelectSurface(ctx, desktop.SurfaceShell); err != nil {
			return err
		}
	default:
		return errors.New("browser mode must be automatic or manual")
	}
	controller.mu.Lock()
	controller.mode = mode
	controller.mu.Unlock()
	return nil
}

// ResetProfile first stops automation and releases every internet controller.
// The profile directory itself is deleted only on the next application start,
// before a new WebView2 environment can acquire it.
func (controller *BrowserController) ResetProfile(ctx context.Context) (any, error) {
	if controller.ScheduleProfileReset == nil {
		return nil, errors.New("internet profile reset is not configured")
	}
	if err := controller.EmergencyStop(ctx); err != nil {
		return nil, err
	}
	if err := controller.ScheduleProfileReset(); err != nil {
		return nil, err
	}
	controller.mu.Lock()
	controller.profileResetPending = true
	controller.mode = "manual"
	controller.mu.Unlock()
	return map[string]any{
		"scheduled":        true,
		"restart_required": true,
		"scope":            "aetherops_internet_webview2_profile",
	}, nil
}
