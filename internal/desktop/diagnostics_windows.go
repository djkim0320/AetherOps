//go:build windows && amd64

package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	webview2 "github.com/djkim0320/AetherOps/internal/desktop/webview2"
	"github.com/wailsapp/go-webview2/webviewloader"
)

// EnvironmentDiagnostic reports a real environment boundary. A CDP port is
// intentionally reported only for the internet environment.
type EnvironmentDiagnostic struct {
	UserDataDir                 string `json:"userDataDir"`
	UserDataDirExists           bool   `json:"userDataDirExists"`
	CDPPort                     int    `json:"cdpPort,omitempty"`
	CDPDisabledByConfiguration  bool   `json:"cdpDisabledByConfiguration"`
	CDPLoopbackConfigured       bool   `json:"cdpLoopbackConfigured"`
	CDPEndpointLive             bool   `json:"cdpEndpointLive"`
	DownloadDir                 string `json:"downloadDir,omitempty"`
	DownloadDirExists           bool   `json:"downloadDirExists"`
	DownloadIsolationConfigured bool   `json:"downloadIsolationConfigured"`
}

// InternetSecurityDiagnostic separates settings actually queried from the
// construction invariant that no internet bridge registration exists. WebView2
// exposes no API for enumerating all host objects, so that last invariant is
// intentionally labelled as construction-checked rather than runtime-probed.
type InternetSecurityDiagnostic struct {
	WebMessagesDisabled              bool `json:"webMessagesDisabled"`
	HostObjectsDisabled              bool `json:"hostObjectsDisabled"`
	DevToolsUIDisabled               bool `json:"devToolsUIDisabled"`
	PasswordAutosaveDisabled         bool `json:"passwordAutosaveDisabled"`
	GeneralAutofillDisabled          bool `json:"generalAutofillDisabled"`
	PermissionDenyHandlerInstalled   bool `json:"permissionDenyHandlerInstalled"`
	NativeBridgeAbsentByConstruction bool `json:"nativeBridgeAbsentByConstruction"`
	NativeBridgeRuntimeEnumerable    bool `json:"nativeBridgeRuntimeEnumerable"`
}

// Gate0OperationalCheck records one required product behavior. Executed is
// distinct from Passed so a missing external prerequisite cannot be mistaken
// for an observed failure or a successful test.
type Gate0OperationalCheck struct {
	ID         string    `json:"id"`
	Executed   bool      `json:"executed"`
	Passed     bool      `json:"passed"`
	ObservedAt time.Time `json:"observedAt,omitempty"`
	Evidence   string    `json:"evidence,omitempty"`
	Blocker    string    `json:"blocker,omitempty"`
}

// Gate0OperationalReport is the actual Windows behavior portion of Gate 0.
// The fixed check IDs make omissions visible to both humans and release tools.
type Gate0OperationalReport struct {
	Schema    string                  `json:"schema"`
	Checks    []Gate0OperationalCheck `json:"checks"`
	Blockers  []string                `json:"blockers,omitempty"`
	Compliant bool                    `json:"compliant"`
}

// Gate0Report contains the host's pre-navigation boundary diagnostics.
type Gate0Report struct {
	RuntimeVersion string                     `json:"runtimeVersion"`
	Shell          EnvironmentDiagnostic      `json:"shell"`
	Internet       EnvironmentDiagnostic      `json:"internet"`
	Security       InternetSecurityDiagnostic `json:"security"`
	Operational    Gate0OperationalReport     `json:"operational"`
	Limitations    []string                   `json:"limitations,omitempty"`
	Failures       []string                   `json:"failures,omitempty"`
	Compliant      bool                       `json:"compliant"`
}

// Gate0 runs on the UI thread and queries every public WebView2 setting used
// to defend the internet boundary. A failed required check returns both its
// partial report and an error; it is never silently downgraded.
func (host *Host) Gate0(ctx context.Context) (Gate0Report, error) {
	var report Gate0Report
	err := host.invoke(ctx, func(host *Host) error {
		report = host.gate0OnUI()
		if !report.Compliant {
			return errors.New("Gate 0 compliance checks failed")
		}
		return nil
	})
	return report, err
}

func (host *Host) gate0OnUI() Gate0Report {
	report := Gate0Report{
		Shell: EnvironmentDiagnostic{
			UserDataDir:                host.shellPlan.userDataDir,
			CDPDisabledByConfiguration: !strings.Contains(host.shellPlan.browserArgs, "remote-debugging-port"),
		},
		Internet: EnvironmentDiagnostic{
			UserDataDir:                 host.internetPlan.userDataDir,
			CDPPort:                     host.internetPlan.cdpPort,
			CDPLoopbackConfigured:       strings.Contains(host.internetPlan.browserArgs, "--remote-debugging-address=127.0.0.1"),
			DownloadDir:                 host.config.DownloadDir,
			DownloadIsolationConfigured: strings.Contains(host.internetPlan.browserArgs, "--download-default-directory="),
		},
		Limitations: []string{
			"WebView2 exposes no public API to enumerate an environment's effective browser command line; shell CDP absence is configuration-verified, not process-command-line-enumerated.",
			"WebView2 exposes no public API to enumerate registered host objects; the internet native-bridge result is enforced by construction and settings, not enumerated at runtime.",
		},
	}
	if version, err := webviewloader.GetAvailableCoreWebView2BrowserVersionString(""); err != nil {
		report.Failures = append(report.Failures, fmt.Sprintf("read installed WebView2 Runtime version: %v", err))
	} else {
		report.RuntimeVersion = version
		if version == "" {
			report.Failures = append(report.Failures, "installed WebView2 Runtime version is empty")
		}
	}
	if _, err := os.Stat(report.Shell.UserDataDir); err == nil {
		report.Shell.UserDataDirExists = true
	} else {
		report.Failures = append(report.Failures, fmt.Sprintf("shell user data directory: %v", err))
	}
	if _, err := os.Stat(report.Internet.UserDataDir); err == nil {
		report.Internet.UserDataDirExists = true
	} else {
		report.Failures = append(report.Failures, fmt.Sprintf("internet user data directory: %v", err))
	}
	if _, err := os.Stat(report.Internet.DownloadDir); err == nil {
		report.Internet.DownloadDirExists = true
	} else {
		report.Failures = append(report.Failures, fmt.Sprintf("internet download directory: %v", err))
	}
	if !report.Internet.DownloadIsolationConfigured {
		report.Failures = append(report.Failures, "internet download isolation is not configured")
	}
	if !report.Shell.CDPDisabledByConfiguration {
		report.Failures = append(report.Failures, "shell environment contains a remote-debugging argument")
	}
	if report.Internet.CDPPort == 0 || !report.Internet.CDPLoopbackConfigured {
		report.Failures = append(report.Failures, "internet environment lacks a loopback CDP configuration")
	}

	host.mu.RLock()
	shell := host.tabs[host.initialShellTab]
	internet := host.tabs[host.initialInternetTab]
	host.mu.RUnlock()
	if shell == nil || shell.webview == nil {
		report.Failures = append(report.Failures, "shell CoreWebView2 is unavailable")
	} else if err := appendShellSettings(&report, shell.webview); err != nil {
		report.Failures = append(report.Failures, err.Error())
	}
	if internet == nil || internet.webview == nil {
		report.Failures = append(report.Failures, "internet CoreWebView2 is unavailable")
	} else if err := appendInternetSettings(&report, internet); err != nil {
		report.Failures = append(report.Failures, err.Error())
	}

	if report.Internet.CDPPort != 0 {
		live, err := probeLocalCDP(report.Internet.CDPPort)
		report.Internet.CDPEndpointLive = live
		if err != nil {
			report.Failures = append(report.Failures, fmt.Sprintf("probe internet CDP endpoint: %v", err))
		}
	}
	report.Compliant = len(report.Failures) == 0 &&
		report.Shell.CDPDisabledByConfiguration &&
		report.Internet.CDPLoopbackConfigured &&
		report.Internet.CDPEndpointLive &&
		report.Internet.DownloadDirExists &&
		report.Internet.DownloadIsolationConfigured &&
		report.Security.WebMessagesDisabled &&
		report.Security.HostObjectsDisabled &&
		report.Security.DevToolsUIDisabled &&
		report.Security.PasswordAutosaveDisabled &&
		report.Security.GeneralAutofillDisabled &&
		report.Security.PermissionDenyHandlerInstalled &&
		report.Security.NativeBridgeAbsentByConstruction
	return report
}

func appendShellSettings(report *Gate0Report, core *webview2.ICoreWebView2) error {
	settings, err := core.GetSettings()
	if err != nil {
		return fmt.Errorf("read shell settings: %w", err)
	}
	defer releaseCOM(settings)
	webMessages, err := settings.GetIsWebMessageEnabled()
	if err != nil {
		return fmt.Errorf("read shell web-message setting: %w", err)
	}
	if webMessages {
		return errors.New("shell web-message setting is unexpectedly enabled")
	}
	return nil
}

func appendInternetSettings(report *Gate0Report, internet *tab) error {
	settings, err := internet.webview.GetSettings()
	if err != nil {
		return fmt.Errorf("read internet settings: %w", err)
	}
	defer releaseCOM(settings)
	webMessages, err := settings.GetIsWebMessageEnabled()
	if err != nil {
		return fmt.Errorf("read internet web-message setting: %w", err)
	}
	hostObjects, err := settings.GetAreHostObjectsAllowed()
	if err != nil {
		return fmt.Errorf("read internet host-object setting: %w", err)
	}
	devTools, err := settings.GetAreDevToolsEnabled()
	if err != nil {
		return fmt.Errorf("read internet DevTools setting: %w", err)
	}
	report.Security.WebMessagesDisabled = !webMessages
	report.Security.HostObjectsDisabled = !hostObjects
	report.Security.DevToolsUIDisabled = !devTools
	report.Security.PermissionDenyHandlerInstalled = internet.permissionCB != nil && internet.hasPermissionToken
	report.Security.NativeBridgeAbsentByConstruction = true
	report.Security.NativeBridgeRuntimeEnumerable = false

	settings4 := settings.GetICoreWebView2Settings4()
	if settings4 == nil {
		return fmt.Errorf("%w: ICoreWebView2Settings4 is unavailable during Gate 0", ErrRequiredWebView2Capability)
	}
	defer releaseCOM(settings4)
	passwordAutosave, err := settings4.GetIsPasswordAutosaveEnabled()
	if err != nil {
		return fmt.Errorf("read internet password-autosave setting: %w", err)
	}
	generalAutofill, err := settings4.GetIsGeneralAutofillEnabled()
	if err != nil {
		return fmt.Errorf("read internet general-autofill setting: %w", err)
	}
	report.Security.PasswordAutosaveDisabled = !passwordAutosave
	report.Security.GeneralAutofillDisabled = !generalAutofill

	var failures []error
	if webMessages {
		failures = append(failures, errors.New("internet web-message setting remains enabled"))
	}
	if hostObjects {
		failures = append(failures, errors.New("internet host-object setting remains enabled"))
	}
	if devTools {
		failures = append(failures, errors.New("internet DevTools UI setting remains enabled"))
	}
	if passwordAutosave {
		failures = append(failures, errors.New("internet password-autosave setting remains enabled"))
	}
	if generalAutofill {
		failures = append(failures, errors.New("internet general-autofill setting remains enabled"))
	}
	if !report.Security.PermissionDenyHandlerInstalled {
		failures = append(failures, errors.New("internet permission deny handler is not installed"))
	}
	return errors.Join(failures...)
}

func probeLocalCDP(port int) (bool, error) {
	client := &http.Client{
		Timeout:   1200 * time.Millisecond,
		Transport: &http.Transport{Proxy: nil},
	}
	response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/json/version", port))
	if err != nil {
		return false, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false, fmt.Errorf("unexpected HTTP status %s", response.Status)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if err != nil {
		return false, err
	}
	var version struct {
		Browser              string `json:"Browser"`
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.Unmarshal(body, &version); err != nil {
		return false, fmt.Errorf("decode /json/version: %w", err)
	}
	if version.Browser == "" || version.WebSocketDebuggerURL == "" {
		return false, errors.New("/json/version did not contain a CDP browser endpoint")
	}
	return true, nil
}
