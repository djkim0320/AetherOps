//go:build windows && amd64

// Package gate0windows owns the real Windows Gate 0 behavior harness. It
// deliberately composes production boundaries instead of translating unit
// test outcomes into a release artifact.
package gate0windows

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/browser"
	"github.com/djkim0320/AetherOps/internal/desktop"
	"github.com/djkim0320/AetherOps/internal/gate0evidence"
	"github.com/djkim0320/AetherOps/internal/integration"
	managedruntime "github.com/djkim0320/AetherOps/internal/runtime"
)

var requiredOperationalChecks = gate0evidence.RequiredOperationalCheckIDs()

type Options struct {
	Config                 desktop.Config
	RuntimePaths           managedruntime.ProcessPaths
	RuntimeResolutionError error
}

type runningHost struct {
	host *desktop.Host
	done chan error
}

type profileFootprint struct {
	Files int
	Bytes int64
}

type operationalBuilder struct {
	checks map[string]desktop.Gate0OperationalCheck
}

func newOperationalBuilder() *operationalBuilder {
	return &operationalBuilder{checks: make(map[string]desktop.Gate0OperationalCheck, len(requiredOperationalChecks))}
}

func (builder *operationalBuilder) pass(id, evidence string, observedAt time.Time) {
	if observedAt.IsZero() {
		observedAt = time.Now().UTC()
	}
	builder.checks[id] = desktop.Gate0OperationalCheck{
		ID: id, Executed: true, Passed: true, ObservedAt: observedAt, Evidence: strings.TrimSpace(evidence),
	}
}

func (builder *operationalBuilder) fail(id string, executed bool, blocker string) {
	builder.checks[id] = desktop.Gate0OperationalCheck{
		ID: id, Executed: executed, Passed: false, ObservedAt: time.Now().UTC(), Blocker: strings.TrimSpace(blocker),
	}
}

func (builder *operationalBuilder) report() desktop.Gate0OperationalReport {
	report := desktop.Gate0OperationalReport{Schema: gate0evidence.OperationalSchema, Compliant: true}
	for _, id := range requiredOperationalChecks {
		check, ok := builder.checks[id]
		if !ok {
			check = desktop.Gate0OperationalCheck{ID: id, Blocker: "required operational check was not executed"}
		}
		if !check.Executed || !check.Passed {
			report.Compliant = false
			blocker := check.Blocker
			if blocker == "" {
				blocker = "check did not pass"
			}
			report.Blockers = append(report.Blockers, id+": "+blocker)
		}
		report.Checks = append(report.Checks, check)
	}
	return report
}

// Run starts actual WebView2 hosts twice using the same profile directories,
// exercises the live DevTools MCP and Win32 behavior, and returns one typed
// artifact. Every failed or unavailable requirement remains a blocker.
func Run(ctx context.Context, options Options) (report desktop.Gate0Report, returnErr error) {
	builder := newOperationalBuilder()
	first, err := startHost(ctx, options.Config)
	if err != nil {
		return report, err
	}
	report, baseErr := first.host.Gate0(ctx)

	initialState := first.host.State()
	activated, activationErr := desktop.ActivateTrayForGate0(options.Config.ApplicationID)
	if activationErr == nil && activated {
		activationErr = waitFor(ctx, 3*time.Second, func() bool { return first.host.State().WindowVisible })
	}
	stateAfterActivation := first.host.State()
	if activationErr != nil {
		builder.fail("tray_restore", true, activationErr.Error())
	} else if initialState.WindowVisible {
		builder.fail("tray_restore", true, "Gate 0 host was not initially hidden")
	} else if !initialState.TrayInstalled || !stateAfterActivation.TrayInstalled || !stateAfterActivation.WindowVisible {
		builder.fail("tray_restore", true, fmt.Sprintf("tray/window state before=%+v after=%+v", initialState, stateAfterActivation))
	} else {
		builder.pass("tray_restore", "hidden native window retained a Shell_NotifyIcon tray entry and its registered native tray-click callback restored it", time.Time{})
	}

	nativeDiagnostic, nativeErr := first.host.NativeWindowDiagnostics(ctx)
	if nativeErr != nil {
		builder.fail("per_monitor_v2_dpi", true, nativeErr.Error())
	} else if !nativeDiagnostic.PerMonitorV2 || nativeDiagnostic.DPI == 0 || nativeDiagnostic.ClientWidth <= 0 || nativeDiagnostic.ClientHeight <= 0 {
		builder.fail("per_monitor_v2_dpi", true, fmt.Sprintf("native window diagnostic=%+v", nativeDiagnostic))
	} else {
		builder.pass("per_monitor_v2_dpi", fmt.Sprintf("GetDpiForWindow=%d client=%dx%d and GetWindowDpiAwarenessContext matched Per-Monitor v2", nativeDiagnostic.DPI, nativeDiagnostic.ClientWidth, nativeDiagnostic.ClientHeight), time.Time{})
	}

	if _, createErr := first.host.CreateTab(ctx, desktop.SurfaceInternet); createErr != nil {
		builder.fail("multi_tab", true, createErr.Error())
	} else if tabState := first.host.State(); tabState.TabCount < 3 {
		builder.fail("multi_tab", true, fmt.Sprintf("real WebView2 controller count=%d, want at least 3", tabState.TabCount))
	} else {
		builder.pass("multi_tab", fmt.Sprintf("real isolated WebView2 controller count=%d", first.host.State().TabCount), time.Time{})
	}

	imeDiagnostic := first.host.RunKoreanIMEGate0(ctx)
	if imeDiagnostic.Passed {
		builder.pass("korean_ime_input", fmt.Sprintf("installed locale=%s IME-open=%t physical keys=%q DOM readback=%q", imeDiagnostic.InputLocale, imeDiagnostic.IMEOpen, imeDiagnostic.PhysicalKeys, imeDiagnostic.Observed), time.Time{})
	} else {
		builder.fail("korean_ime_input", imeDiagnostic.Executed, imeDiagnostic.Failure)
	}

	endpoint := fmt.Sprintf("http://127.0.0.1:%d", report.Internet.CDPPort)
	var browserProbe managedruntime.StdioBrowserProbe
	var probeSupervisor *desktop.ProcessSupervisor
	if options.RuntimeResolutionError != nil {
		blocker := "resolve pinned managed runtime: " + options.RuntimeResolutionError.Error()
		builder.fail("devtools_mcp_control", false, blocker)
		builder.fail("manual_resume_reobservation", false, blocker)
	} else {
		probeSupervisor, err = desktop.NewProcessSupervisor()
		if err != nil {
			builder.fail("devtools_mcp_control", false, "create DevTools MCP Job Object: "+err.Error())
			builder.fail("manual_resume_reobservation", false, "create DevTools MCP Job Object: "+err.Error())
		} else {
			browserProbe = managedruntime.StdioBrowserProbe{
				Endpoint: endpoint, Timeout: 30 * time.Second, AfterStart: probeSupervisor.Assign,
				RequirePageSnapshot: true,
			}
			evidence, probeErr := browserProbe.ProbeBrowser(ctx, options.RuntimePaths)
			if probeErr != nil {
				builder.fail("devtools_mcp_control", true, probeErr.Error())
			} else if !evidence.Executed || !evidence.Compatible {
				builder.fail("devtools_mcp_control", true, fmt.Sprintf("incomplete DevTools MCP evidence=%+v", evidence))
			} else {
				builder.pass("devtools_mcp_control", evidence.Observation, evidence.ObservedAt)
			}

			controller, controllerErr := integration.NewBrowserController(first.host, nil, func(observeContext context.Context) error {
				observation, observeErr := browserProbe.ProbeBrowser(observeContext, options.RuntimePaths)
				if observeErr != nil {
					return observeErr
				}
				if !observation.Executed || !observation.Compatible {
					return fmt.Errorf("incomplete live re-observation evidence=%+v", observation)
				}
				return nil
			}, nil)
			if controllerErr != nil {
				builder.fail("manual_resume_reobservation", false, controllerErr.Error())
			} else if modeErr := controller.SetMode(ctx, "manual"); modeErr != nil {
				builder.fail("manual_resume_reobservation", true, "enter manual mode: "+modeErr.Error())
			} else if modeErr := controller.SetMode(ctx, "automatic"); modeErr != nil {
				builder.fail("manual_resume_reobservation", true, "resume automatic mode: "+modeErr.Error())
			} else {
				statusValue, statusErr := controller.Status(ctx)
				status, ok := statusValue.(map[string]any)
				observed, hasObservation := status["last_observed_at"].(time.Time)
				if statusErr != nil || !ok || !hasObservation || observed.IsZero() || first.host.State().ActiveSurface != desktop.SurfaceShell {
					builder.fail("manual_resume_reobservation", true, fmt.Sprintf("controller status=%v error=%v", statusValue, statusErr))
				} else {
					builder.pass("manual_resume_reobservation", "manual control paused automation; automatic resume called list_pages and take_snapshot before returning to the shell", observed)
				}
			}
		}
	}
	if probeSupervisor != nil {
		returnErr = errors.Join(returnErr, probeSupervisor.Close())
	}

	if emergencyErr := first.host.EmergencyStop(ctx); emergencyErr != nil {
		builder.fail("emergency_stop", true, emergencyErr.Error())
	} else {
		stopped := first.host.State()
		selectionErr := first.host.SelectSurface(ctx, desktop.SurfaceInternet)
		if !stopped.EmergencyStopped || stopped.ActiveSurface != desktop.SurfaceShell || stopped.TabCount != 1 || !errors.Is(selectionErr, desktop.ErrEmergencyStopped) {
			builder.fail("emergency_stop", true, fmt.Sprintf("state=%+v internet selection error=%v", stopped, selectionErr))
		} else if resetErr := first.host.ResetEmergencyStop(ctx); resetErr != nil {
			builder.fail("emergency_stop", true, "explicit emergency reset: "+resetErr.Error())
		} else if _, recreateErr := first.host.CreateTab(ctx, desktop.SurfaceInternet); recreateErr != nil {
			builder.fail("emergency_stop", true, "recreate internet environment after explicit reset: "+recreateErr.Error())
		} else {
			builder.pass("emergency_stop", "all internet controllers and the helper Job Object were terminated; shell remained and internet stayed blocked until explicit reset", time.Time{})
		}
	}

	network := browser.ProbeGate0NetworkBoundary(ctx)
	if network.PrivateHTTPBlocked && network.PrivateCONNECTBlocked && network.PrivateUpstreamUntouched && network.LinkLocalMetadataBlocked {
		builder.pass("private_network_block", "actual HTTP and CONNECT requests to loopback plus link-local metadata were rejected before the private listener accepted bytes", time.Time{})
	} else {
		builder.fail("private_network_block", network.Executed, strings.Join(network.Failures, "; "))
	}
	if network.DNSRebindingBlocked && network.RebindingUpstreamUntouched && network.DNSRebindingQueries >= 2 {
		builder.pass("dns_rebinding_block", fmt.Sprintf("actual UDP DNS responder changed public to private; proxy re-resolved %d times and the private listener accepted no bytes", network.DNSRebindingQueries), time.Time{})
	} else {
		builder.fail("dns_rebinding_block", network.Executed, strings.Join(network.Failures, "; "))
	}

	closeFirstErr := stopHost(first)
	shellBefore, shellBeforeErr := measureProfile(options.Config.ShellUserDataDir)
	internetBefore, internetBeforeErr := measureProfile(options.Config.InternetUserDataDir)
	if closeFirstErr != nil || shellBeforeErr != nil || internetBeforeErr != nil {
		builder.fail("profile_persistence", true, fmt.Sprintf("first close=%v shell=%v internet=%v", closeFirstErr, shellBeforeErr, internetBeforeErr))
	} else {
		second, secondErr := startReopenHost(ctx, options.Config, report.Internet.CDPPort)
		if secondErr != nil {
			builder.fail("profile_persistence", true, "reopen WebView2 environments with existing profiles: "+secondErr.Error())
		} else {
			secondReport, secondGateErr := second.host.Gate0(ctx)
			closeSecondErr := stopHost(second)
			shellAfter, shellAfterErr := measureProfile(options.Config.ShellUserDataDir)
			internetAfter, internetAfterErr := measureProfile(options.Config.InternetUserDataDir)
			if secondGateErr != nil || closeSecondErr != nil || shellAfterErr != nil || internetAfterErr != nil ||
				!secondReport.Shell.UserDataDirExists || !secondReport.Internet.UserDataDirExists ||
				shellBefore.Files == 0 || internetBefore.Files == 0 || shellAfter.Files == 0 || internetAfter.Files == 0 {
				builder.fail("profile_persistence", true, fmt.Sprintf("second gate=%v close=%v shell before=%+v after=%+v err=%v internet before=%+v after=%+v err=%v", secondGateErr, closeSecondErr, shellBefore, shellAfter, shellAfterErr, internetBefore, internetAfter, internetAfterErr))
			} else {
				builder.pass("profile_persistence", fmt.Sprintf("closed and reopened both actual WebView2 environments on the same UDFs; shell files %d→%d, internet files %d→%d", shellBefore.Files, shellAfter.Files, internetBefore.Files, internetAfter.Files), time.Time{})
			}
		}
	}

	operational := builder.report()
	report.Operational = operational
	for _, blocker := range operational.Blockers {
		report.Failures = append(report.Failures, "operational "+blocker)
	}
	report.Compliant = report.Compliant && operational.Compliant
	if !report.Compliant {
		returnErr = errors.Join(returnErr, baseErr, errors.New("full Windows Gate 0 operational checks failed"))
	} else {
		returnErr = errors.Join(returnErr, baseErr)
	}
	return report, returnErr
}

func startHost(ctx context.Context, config desktop.Config) (*runningHost, error) {
	host, err := desktop.NewHost(config)
	return startCreatedHost(ctx, host, err)
}

func startReopenHost(ctx context.Context, config desktop.Config, cdpPort int) (*runningHost, error) {
	host, err := desktop.NewGate0ReopenHost(config, cdpPort)
	return startCreatedHost(ctx, host, err)
}

func startCreatedHost(ctx context.Context, host *desktop.Host, err error) (*runningHost, error) {
	if err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()
	if err := host.WaitReady(ctx); err != nil {
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = host.Close(shutdown)
		cancel()
		select {
		case runErr := <-done:
			return nil, errors.Join(err, runErr)
		case <-time.After(5 * time.Second):
			return nil, errors.Join(err, errors.New("failed Gate 0 host did not stop"))
		}
	}
	return &runningHost{host: host, done: done}, nil
}

func stopHost(running *runningHost) error {
	if running == nil || running.host == nil {
		return nil
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	closeErr := running.host.Close(shutdown)
	cancel()
	select {
	case runErr := <-running.done:
		return errors.Join(closeErr, runErr)
	case <-time.After(10 * time.Second):
		return errors.Join(closeErr, errors.New("desktop host did not stop"))
	}
}

func waitFor(ctx context.Context, timeout time.Duration, condition func() bool) error {
	deadline := time.Now().Add(timeout)
	for !condition() {
		if time.Now().After(deadline) {
			return errors.New("timed out waiting for native window state")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
	return nil
}

func measureProfile(root string) (profileFootprint, error) {
	root = filepath.Clean(strings.TrimSpace(root))
	if !filepath.IsAbs(root) {
		return profileFootprint{}, errors.New("profile path must be absolute")
	}
	var footprint profileFootprint
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("profile contains symlink %q", path)
		}
		if entry.Type().IsRegular() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			footprint.Files++
			footprint.Bytes += info.Size()
		}
		return nil
	})
	return footprint, err
}
