//go:build windows && amd64

package desktop

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	webview2 "github.com/djkim0320/Aether-claw/internal/desktop/webview2"
	"github.com/wailsapp/go-webview2/webviewloader"
)

func TestNewHostSeparatesProfilesAndCDP(t *testing.T) {
	root := t.TempDir()
	host, err := NewHost(Config{
		ApplicationID:       "AetherOps.Test",
		ShellUserDataDir:    filepath.Join(root, "shell"),
		InternetUserDataDir: filepath.Join(root, "internet"),
		InternetProxyURL:    "http://127.0.0.1:49151",
		DownloadDir:         filepath.Join(root, "downloads"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.EqualFold(host.shellPlan.userDataDir, host.internetPlan.userDataDir) {
		t.Fatal("shell and internet profiles were not isolated")
	}
	if strings.Contains(host.shellPlan.browserArgs, "remote-debugging") {
		t.Fatalf("shell unexpectedly has CDP arguments: %q", host.shellPlan.browserArgs)
	}
	if host.internetPlan.cdpPort < 49152 || host.internetPlan.cdpPort > 65535 {
		t.Fatalf("internet CDP port is outside the dynamic range: %d", host.internetPlan.cdpPort)
	}
	if !strings.Contains(host.internetPlan.browserArgs, "--remote-debugging-address=127.0.0.1") || !strings.Contains(host.internetPlan.browserArgs, "--remote-debugging-port=") {
		t.Fatalf("internet CDP is not explicitly constrained to loopback: %q", host.internetPlan.browserArgs)
	}
	reopened, err := NewGate0ReopenHost(host.config, host.internetPlan.cdpPort)
	if err != nil {
		t.Fatalf("create Gate 0 profile-reopen host: %v", err)
	}
	if reopened.internetPlan.cdpPort != host.internetPlan.cdpPort || reopened.internetPlan.browserArgs != host.internetPlan.browserArgs {
		t.Fatalf("Gate 0 reopen changed WebView2 environment options: first=%q second=%q", host.internetPlan.browserArgs, reopened.internetPlan.browserArgs)
	}
}

func TestNewHostRejectsSharedProfiles(t *testing.T) {
	root := t.TempDir()
	_, err := NewHost(Config{
		ApplicationID:       "AetherOps.Test",
		ShellUserDataDir:    root,
		InternetUserDataDir: root,
		InternetProxyURL:    "http://127.0.0.1:49151",
		DownloadDir:         filepath.Join(root, "downloads"),
	})
	if err == nil {
		t.Fatal("expected identical shell and internet profiles to be rejected")
	}
}

func TestColorRefUsesWindowsBGRLayout(t *testing.T) {
	if got, want := colorRef(0x0a, 0x10, 0x20), uint32(0x0020100a); got != want {
		t.Fatalf("colorRef = 0x%08x, want 0x%08x", got, want)
	}
}

func TestInternetURLPolicyBlocksLocalAndNonHTTP(t *testing.T) {
	for _, rawURL := range []string{
		"file:///C:/Windows/System32/",
		"http://127.0.0.1/",
		"http://localhost/",
		"http://10.0.0.1/",
	} {
		if err := validateInternetURL(rawURL); err == nil {
			t.Fatalf("expected %q to be blocked", rawURL)
		}
	}
	if err := validateInternetURL("https://example.com/"); err != nil {
		t.Fatalf("expected public HTTPS URL to be allowed: %v", err)
	}
}

func TestShellRecoveryAcceleratorPolicy(t *testing.T) {
	for _, test := range []struct {
		name       string
		kind       webview2.COREWEBVIEW2_KEY_EVENT_KIND
		virtualKey uint32
		want       bool
	}{
		{name: "Escape key down", kind: webview2.COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, virtualKey: virtualKeyEscape, want: true},
		{name: "Escape system key down", kind: webview2.COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN, virtualKey: virtualKeyEscape, want: true},
		{name: "Escape key up", kind: webview2.COREWEBVIEW2_KEY_EVENT_KIND_KEY_UP, virtualKey: virtualKeyEscape, want: false},
		{name: "other key", kind: webview2.COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, virtualKey: 'A', want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := shouldRecoverShellFromAccelerator(test.kind, test.virtualKey); got != test.want {
				t.Fatalf("shouldRecoverShellFromAccelerator(%d, %#x) = %t, want %t", test.kind, test.virtualKey, got, test.want)
			}
		})
	}
}

func TestShellRecoveryNativeKeyPolicy(t *testing.T) {
	for _, test := range []struct {
		name    string
		message uint32
		wParam  uintptr
		want    bool
	}{
		{name: "Escape key down", message: wmKeyDown, wParam: uintptr(virtualKeyEscape), want: true},
		{name: "Escape system key down", message: wmSysKeyDown, wParam: uintptr(virtualKeyEscape), want: true},
		{name: "other key", message: wmKeyDown, wParam: 'A', want: false},
		{name: "other message", message: wmSize, wParam: uintptr(virtualKeyEscape), want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := isShellRecoveryKey(test.message, test.wParam); got != test.want {
				t.Fatalf("isShellRecoveryKey(%#x, %#x) = %t, want %t", test.message, test.wParam, got, test.want)
			}
		})
	}
}

// This is intentionally an actual Windows runtime check rather than a mock.
// The desktop host is unsupported when the installed Evergreen WebView2 x64
// runtime cannot be located and loaded.
func TestInstalledWebView2RuntimeAvailable(t *testing.T) {
	version, err := webviewloader.GetAvailableCoreWebView2BrowserVersionString("")
	if err != nil {
		t.Fatalf("load installed WebView2 runtime: %v", err)
	}
	if strings.TrimSpace(version) == "" {
		t.Fatal("installed WebView2 runtime version is empty")
	}
}

func TestHostStartupGate0AndShutdown(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Skip("Gate 0 requires a real interactive Windows host with the Korean IME installed")
	}
	root, err := os.MkdirTemp("", "AetherOps-WebView2-Integration-")
	if err != nil {
		t.Fatal(err)
	}
	defer removeIntegrationProfile(t, root)
	host, err := NewHost(Config{
		ApplicationID:       "AetherOps.DesktopIntegration",
		WindowTitle:         "AetherOps Desktop Integration",
		ShellUserDataDir:    filepath.Join(root, "shell"),
		InternetUserDataDir: filepath.Join(root, "internet"),
		InternetProxyURL:    "http://127.0.0.1:49151",
		DownloadDir:         filepath.Join(root, "downloads"),
		StartHidden:         true,
	})
	if err != nil {
		t.Fatal(err)
	}

	runContext, cancelRun := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelRun()
	runDone := make(chan error, 1)
	go func() { runDone <- host.Run(runContext) }()

	if err := host.WaitReady(runContext); err != nil {
		cancelRun()
		select {
		case <-runDone:
		case <-time.After(5 * time.Second):
		}
		t.Fatalf("start real Win32/WebView2 host and Gate 0: %v", err)
	}
	activated, err := ActivateTrayForGate0("AetherOps.DesktopIntegration")
	if err != nil {
		t.Fatalf("activate existing hidden host: %v", err)
	}
	if !activated {
		t.Fatal("existing hidden host was not found")
	}
	activationDeadline := time.Now().Add(3 * time.Second)
	for !host.State().WindowVisible && time.Now().Before(activationDeadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !host.State().WindowVisible {
		t.Fatal("existing hidden host was not restored")
	}
	if !host.State().TrayInstalled {
		t.Fatal("real native tray icon was not installed")
	}
	nativeDiagnostic, err := host.NativeWindowDiagnostics(runContext)
	if err != nil {
		t.Fatalf("query native DPI/tray diagnostics: %v", err)
	}
	if !nativeDiagnostic.PerMonitorV2 || nativeDiagnostic.DPI == 0 || nativeDiagnostic.ClientWidth <= 0 || nativeDiagnostic.ClientHeight <= 0 {
		t.Fatalf("native window is not usable Per-Monitor v2: %+v", nativeDiagnostic)
	}
	imeDiagnostic := host.RunKoreanIMEGate0(runContext)
	if !imeDiagnostic.Passed {
		t.Fatalf("real Korean IME input did not round-trip through WebView2: %+v", imeDiagnostic)
	}

	if _, err := host.CreateTab(runContext, SurfaceInternet); err != nil {
		t.Fatalf("create a second real internet tab: %v", err)
	}
	if err := host.SelectSurface(runContext, SurfaceInternet); err != nil {
		t.Fatalf("manually select internet surface: %v", err)
	}
	if state := host.State(); state.ActiveSurface != SurfaceInternet || state.TabCount < 3 {
		t.Fatalf("unexpected multi-tab state after internet selection: %#v", state)
	}
	host.mu.RLock()
	hwnd := host.hwnd
	host.mu.RUnlock()
	if err := postHostReturnToShell(hwnd); err != nil {
		t.Fatalf("post native Escape recovery: %v", err)
	}
	recoveryDeadline := time.Now().Add(3 * time.Second)
	for host.State().ActiveSurface != SurfaceShell && time.Now().Before(recoveryDeadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if state := host.State(); state.ActiveSurface != SurfaceShell {
		t.Fatalf("native Escape recovery did not restore shell surface: %#v", state)
	}
	if err := host.SelectSurface(runContext, SurfaceInternet); err != nil {
		t.Fatalf("reselect internet surface after native recovery: %v", err)
	}
	if err := host.EmergencyStop(runContext); err != nil {
		t.Fatalf("emergency-stop real internet surface: %v", err)
	}
	if state := host.State(); !state.EmergencyStopped || state.ActiveSurface != SurfaceShell || state.TabCount != 1 {
		t.Fatalf("unexpected emergency-stop state: %#v", state)
	}
	if err := host.SelectSurface(runContext, SurfaceInternet); !errors.Is(err, ErrEmergencyStopped) {
		t.Fatalf("internet surface must remain blocked after emergency stop, got: %v", err)
	}
	if err := host.ResetEmergencyStop(runContext); err != nil {
		t.Fatalf("reset emergency stop: %v", err)
	}
	if _, err := host.CreateTab(runContext, SurfaceInternet); err != nil {
		t.Fatalf("create internet tab after explicit reset: %v", err)
	}

	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	if err := host.Close(shutdownContext); err != nil {
		t.Fatalf("close real Win32/WebView2 host: %v", err)
	}
	select {
	case err := <-runDone:
		if err != nil {
			t.Fatalf("real Win32/WebView2 host returned: %v", err)
		}
	case <-shutdownContext.Done():
		t.Fatal("real Win32/WebView2 host did not stop")
	}
}

func removeIntegrationProfile(t *testing.T, root string) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for {
		if err := os.RemoveAll(root); err == nil || os.IsNotExist(err) {
			return
		}
		if time.Now().After(deadline) {
			t.Logf("could not yet remove WebView2 integration profile %q", root)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}
