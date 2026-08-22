//go:build windows && amd64

package integration

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/desktop"
)

func newStoppedBrowserController(t *testing.T, schedule func() error) *BrowserController {
	t.Helper()
	root := t.TempDir()
	host, err := desktop.NewHost(desktop.Config{
		ApplicationID:       "AetherOps.lifecycle.test",
		ShellUserDataDir:    filepath.Join(root, "shell"),
		InternetUserDataDir: filepath.Join(root, "internet"),
		InternetProxyURL:    "http://127.0.0.1:47891",
		DownloadDir:         filepath.Join(root, "downloads"),
		InitialSurface:      desktop.SurfaceShell,
	})
	if err != nil {
		t.Fatal(err)
	}
	controller, err := NewBrowserController(host, nil, nil, schedule)
	if err != nil {
		t.Fatal(err)
	}
	return controller
}

func TestAutomationResumeFailsClosedWithoutFreshObservation(t *testing.T) {
	controller := newStoppedBrowserController(t, func() error { return nil })
	controller.mode = "manual"
	if err := controller.SetMode(context.Background(), "automatic"); err == nil || !strings.Contains(err.Error(), "re-observation") {
		t.Fatalf("automatic resume without observer error = %v", err)
	}
	if controller.mode != "manual" {
		t.Fatalf("failed observation changed mode to %q", controller.mode)
	}
}

func TestAutomationResumeKeepsManualModeWhenObservationFails(t *testing.T) {
	controller := newStoppedBrowserController(t, func() error { return nil })
	controller.mode = "manual"
	controller.ReobserveAutomation = func(context.Context) error { return errors.New("snapshot unavailable") }
	if err := controller.SetMode(context.Background(), "automatic"); err == nil || !strings.Contains(err.Error(), "snapshot unavailable") {
		t.Fatalf("failed observation error = %v", err)
	}
	if controller.mode != "manual" {
		t.Fatalf("failed observation changed mode to %q", controller.mode)
	}
}

func TestProfileResetIsNotScheduledUntilInternetUseStops(t *testing.T) {
	scheduled := 0
	controller := newStoppedBrowserController(t, func() error {
		scheduled++
		return nil
	})
	if _, err := controller.ResetProfile(context.Background()); !errors.Is(err, desktop.ErrHostNotRunning) {
		t.Fatalf("reset on stopped host error = %v", err)
	}
	if scheduled != 0 {
		t.Fatal("profile reset marker was written before the browser host stopped safely")
	}
}

func TestPendingProfileResetBlocksAutomationResume(t *testing.T) {
	controller := newStoppedBrowserController(t, func() error { return nil })
	controller.profileResetPending = true
	if err := controller.SetMode(context.Background(), "automatic"); err == nil || !strings.Contains(err.Error(), "restart") {
		t.Fatalf("automatic mode with pending reset error = %v", err)
	}
}
