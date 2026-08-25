//go:build windows && amd64

// Package desktop contains the Windows 11 x64 desktop host. It deliberately
// uses the WebView2 COM surface directly: the shell and internet surfaces are
// different CoreWebView2 environments and must never share a profile.
package desktop

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	webview2 "github.com/djkim0320/AetherOps/internal/desktop/webview2"
	"github.com/wailsapp/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

var (
	// ErrHostNotRunning means an operation was requested before Run completed
	// native window initialisation or after the message loop stopped.
	ErrHostNotRunning = errors.New("desktop host is not running")
	// ErrEmergencyStopped prevents an internet tab or supervised process from
	// being created until ResetEmergencyStop is explicitly called.
	ErrEmergencyStopped = errors.New("internet surface is emergency-stopped")
	// ErrRequiredWebView2Capability is returned instead of weakening a security
	// control when the installed WebView2 Runtime does not expose it.
	ErrRequiredWebView2Capability = errors.New("required WebView2 security capability is unavailable")
	// ErrUIThreadWait prevents a deadlock when a caller tries to wait for an
	// asynchronous controller creation on the Win32 UI thread.
	ErrUIThreadWait = errors.New("operation cannot wait on the Win32 UI thread")
)

// Surface identifies a WebView2 trust boundary.
type Surface uint8

const (
	SurfaceShell Surface = iota + 1
	SurfaceInternet
)

func (surface Surface) String() string {
	switch surface {
	case SurfaceShell:
		return "shell"
	case SurfaceInternet:
		return "internet"
	default:
		return "unknown"
	}
}

// TabID identifies a controller. Tabs from the same surface share only that
// surface's environment; internet tabs never use the shell environment.
type TabID uint64

// Config contains only the inputs that are safe to make configurable. Browser
// arguments are intentionally not accepted from callers, because arbitrary
// flags could silently weaken the internet boundary.
type Config struct {
	ApplicationID       string
	WindowTitle         string
	ShellUserDataDir    string
	InternetUserDataDir string
	InternetProxyURL    string
	DownloadDir         string
	ShellURL            string
	InternetURL         string
	InitialSurface      Surface
	StartHidden         bool
}

type environmentPlan struct {
	surface     Surface
	userDataDir string
	browserArgs string
	cdpPort     int
}

// HostState is safe to read from non-UI goroutines.
type HostState struct {
	ActiveSurface    Surface
	ActiveTab        TabID
	EmergencyStopped bool
	WindowVisible    bool
	TrayInstalled    bool
	TabCount         int
}

// Host owns one Win32 UI thread, both isolated WebView2 environments, and a
// Job Object used for externally launched helper processes.
type Host struct {
	mu sync.RWMutex

	config       Config
	shellPlan    environmentPlan
	internetPlan environmentPlan

	uiThreadID uint32
	hwnd       uintptr
	running    bool
	closing    bool
	runErr     error

	commands chan *uiCommand
	ready    chan struct{}
	done     chan struct{}
	readyErr error
	readySet sync.Once
	doneSet  sync.Once

	shellEnvironment      *webview2.ICoreWebView2Environment
	internetEnvironment   *webview2.ICoreWebView2Environment
	shellEnvironmentCB    *environmentCreateHandler
	internetEnvironmentCB *environmentCreateHandler

	tabs      map[TabID]*tab
	nextTabID TabID
	activeTab TabID

	initialShellTab    TabID
	initialInternetTab TabID
	gateStarted        bool

	emergencyStopped bool
	windowVisible    bool
	trayInstalled    bool
	// callbackRoots keeps native callback objects alive after a tab is closed
	// until the host itself has fully left the STA. Controller creation is
	// asynchronous, so a completion callback may arrive after cancellation.
	callbackRoots []any

	supervisor *ProcessSupervisor
}

type uiCommand struct {
	apply func(*Host) error
	done  chan error
}

type tab struct {
	id      TabID
	surface Surface
	initial bool

	ready     chan struct{}
	readyOnce sync.Once
	readyErr  error
	complete  bool

	controller *webview2.ICoreWebView2Controller
	webview    *webview2.ICoreWebView2

	controllerCB       *controllerCreateHandler
	controllerHandler  *webview2.ICoreWebView2CreateCoreWebView2ControllerCompletedHandler
	navigationCB       *navigationFilterHandler
	navigationHandler  *webview2.ICoreWebView2NavigationStartingEventHandler
	newWindowCB        *newWindowBlockHandler
	newWindowHandler   *webview2.ICoreWebView2NewWindowRequestedEventHandler
	permissionCB       *permissionDenyHandler
	permissionHandler  *webview2.ICoreWebView2PermissionRequestedEventHandler
	acceleratorCB      *acceleratorEscapeHandler
	acceleratorHandler *webview2.ICoreWebView2AcceleratorKeyPressedEventHandler

	navigationToken     webview2.EventRegistrationToken
	newWindowToken      webview2.EventRegistrationToken
	permissionToken     webview2.EventRegistrationToken
	acceleratorToken    webview2.EventRegistrationToken
	hasNavigationToken  bool
	hasNewWindowToken   bool
	hasPermissionToken  bool
	hasAcceleratorToken bool
}

// NewHost validates the static security boundary but does not create a window
// or a WebView2 process. Run performs those effects on one locked STA thread.
func NewHost(config Config) (*Host, error) {
	return newHost(config, 0)
}

// NewGate0ReopenHost recreates a host with the same already-randomized CDP
// port. It exists only for the in-process profile-persistence diagnostic:
// WebView2 can keep its browser process alive briefly after all COM references
// are released and rejects a second environment with different options.
func NewGate0ReopenHost(config Config, existingRandomCDPPort int) (*Host, error) {
	if existingRandomCDPPort < 49152 || existingRandomCDPPort > 65535 {
		return nil, errors.New("Gate 0 reopen CDP port must be in the dynamic range")
	}
	return newHost(config, existingRandomCDPPort)
}

func newHost(config Config, existingRandomCDPPort int) (*Host, error) {
	normalized, shellPlan, internetPlan, err := normalizeConfig(config, existingRandomCDPPort)
	if err != nil {
		return nil, err
	}
	return &Host{
		config:       normalized,
		shellPlan:    shellPlan,
		internetPlan: internetPlan,
		commands:     make(chan *uiCommand, 64),
		ready:        make(chan struct{}),
		done:         make(chan struct{}),
		tabs:         make(map[TabID]*tab),
	}, nil
}

func normalizeConfig(config Config, existingRandomCDPPort int) (Config, environmentPlan, environmentPlan, error) {
	config.ApplicationID = strings.TrimSpace(config.ApplicationID)
	if config.ApplicationID == "" {
		return Config{}, environmentPlan{}, environmentPlan{}, errors.New("application ID is required")
	}
	if config.WindowTitle == "" {
		config.WindowTitle = config.ApplicationID
	}
	if config.InitialSurface == 0 {
		config.InitialSurface = SurfaceShell
	}
	if config.InitialSurface != SurfaceShell && config.InitialSurface != SurfaceInternet {
		return Config{}, environmentPlan{}, environmentPlan{}, fmt.Errorf("invalid initial surface %d", config.InitialSurface)
	}

	var err error
	config.ShellUserDataDir, err = normalizeAbsolutePath(config.ShellUserDataDir, "shell user data directory")
	if err != nil {
		return Config{}, environmentPlan{}, environmentPlan{}, err
	}
	config.InternetUserDataDir, err = normalizeAbsolutePath(config.InternetUserDataDir, "internet user data directory")
	if err != nil {
		return Config{}, environmentPlan{}, environmentPlan{}, err
	}
	if strings.EqualFold(config.ShellUserDataDir, config.InternetUserDataDir) {
		return Config{}, environmentPlan{}, environmentPlan{}, errors.New("shell and internet user data directories must be different")
	}
	if config.InternetURL != "" {
		if err := validateInternetURL(config.InternetURL); err != nil {
			return Config{}, environmentPlan{}, environmentPlan{}, fmt.Errorf("invalid internet URL: %w", err)
		}
	}
	proxyURL, err := validateLoopbackProxyURL(config.InternetProxyURL)
	if err != nil {
		return Config{}, environmentPlan{}, environmentPlan{}, err
	}
	config.InternetProxyURL = proxyURL
	config.DownloadDir, err = normalizeAbsolutePath(config.DownloadDir, "internet download directory")
	if err != nil {
		return Config{}, environmentPlan{}, environmentPlan{}, err
	}

	port := existingRandomCDPPort
	if port == 0 {
		port, err = chooseRandomLoopbackPort()
		if err != nil {
			return Config{}, environmentPlan{}, environmentPlan{}, fmt.Errorf("choose random CDP port: %w", err)
		}
	}
	shellPlan := environmentPlan{
		surface:     SurfaceShell,
		userDataDir: config.ShellUserDataDir,
		// An empty argument list is intentional. The loader additionally clears
		// WebView2 environment-variable overrides before environment creation.
		browserArgs: "",
	}
	internetPlan := environmentPlan{
		surface:     SurfaceInternet,
		userDataDir: config.InternetUserDataDir,
		cdpPort:     port,
		browserArgs: fmt.Sprintf("--remote-debugging-address=127.0.0.1 --remote-debugging-port=%d --proxy-server=%s --proxy-bypass-list=<-loopback> --download-default-directory=\"%s\" --disable-extensions", port, proxyURL, config.DownloadDir),
	}
	return config, shellPlan, internetPlan, nil
}

func validateLoopbackProxyURL(rawURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.Port() == "" || parsed.User != nil || parsed.Path != "" {
		return "", errors.New("internet proxy must be an explicit http://127.0.0.1:port endpoint")
	}
	return parsed.String(), nil
}

func normalizeAbsolutePath(path, label string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", fmt.Errorf("%s is required", label)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", label, err)
	}
	return filepath.Clean(abs), nil
}

// chooseRandomLoopbackPort only selects an unused port at configuration time;
// Chromium owns the actual bind later. Gate 0 verifies the live local endpoint
// after WebView2 creates the internet controller.
func chooseRandomLoopbackPort() (int, error) {
	for range 64 {
		var randomBytes [4]byte
		if _, err := rand.Read(randomBytes[:]); err != nil {
			return 0, err
		}
		port := 49152 + int(binary.LittleEndian.Uint32(randomBytes[:])%16384)
		listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: port})
		if err != nil {
			continue
		}
		_ = listener.Close()
		return port, nil
	}
	return 0, errors.New("could not reserve a candidate loopback port")
}

// Run creates the Win32 window, starts the two asynchronous environments, and
// owns the message loop until Close, context cancellation, or a fatal Gate 0
// failure. It must be called exactly once for a Host.
func (host *Host) Run(ctx context.Context) (err error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err = requireWindows11(); err != nil {
		host.finishRun(err)
		return err
	}
	if err = ctx.Err(); err != nil {
		host.finishRun(err)
		return err
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if err = windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED); err != nil {
		err = fmt.Errorf("initialise STA COM apartment: %w", err)
		host.finishRun(err)
		return err
	}
	defer windows.CoUninitialize()
	defer func() { host.finishRun(err) }()

	host.mu.Lock()
	if host.running || host.closing || host.uiThreadID != 0 {
		host.mu.Unlock()
		return errors.New("desktop host Run may only be called once")
	}
	host.uiThreadID = windows.GetCurrentThreadId()
	host.mu.Unlock()

	if err = host.createNativeWindow(); err != nil {
		return err
	}
	if host.supervisor, err = newProcessSupervisor(); err != nil {
		return fmt.Errorf("create Windows Job Object supervisor: %w", err)
	}

	host.mu.Lock()
	host.running = true
	host.mu.Unlock()

	if err = host.beginEnvironments(); err != nil {
		return err
	}

	go host.watchContext(ctx)
	err = host.runMessageLoop()
	return err
}

func requireWindows11() error {
	major, _, build := windows.RtlGetNtVersionNumbers()
	if major != 10 || build < 22000 {
		return fmt.Errorf("Windows 11 x64 is required (detected NT %d build %d)", major, build)
	}
	return nil
}

func (host *Host) watchContext(ctx context.Context) {
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = host.Close(shutdownCtx)
	case <-host.done:
	}
}

// Ready is closed once initial shell and internet controllers have been
// created and the live Gate 0 check has succeeded or failed.
func (host *Host) Ready() <-chan struct{} {
	return host.ready
}

// WaitReady waits for the one-time startup result.
func (host *Host) WaitReady(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-host.ready:
		host.mu.RLock()
		defer host.mu.RUnlock()
		return host.readyErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (host *Host) signalReady(err error) {
	host.readySet.Do(func() {
		host.mu.Lock()
		host.readyErr = err
		host.mu.Unlock()
		close(host.ready)
	})
}

func (host *Host) finishRun(loopErr error) {
	// finishRun is always reached on the UI thread after STA initialization, or
	// before startup when no native resources have been acquired.
	if host.onUIThread() {
		_ = host.shutdownOnUI()
		host.mu.RLock()
		hwnd := host.hwnd
		host.mu.RUnlock()
		// beginEnvironments can fail before the message loop begins. In that
		// case the native window/tray must still be removed explicitly.
		if _, stillRegistered := windowHosts.Load(hwnd); stillRegistered {
			_ = destroyNativeWindow(hwnd)
		}
	}

	host.mu.Lock()
	if loopErr != nil && host.runErr == nil {
		host.runErr = loopErr
	}
	finalErr := host.runErr
	host.running = false
	host.closing = true
	host.uiThreadID = 0
	host.hwnd = 0
	host.mu.Unlock()

	host.signalReady(finalErr)
	host.failPendingCommands(ErrHostNotRunning)
	host.doneSet.Do(func() { close(host.done) })
}

func (host *Host) failPendingCommands(err error) {
	for {
		select {
		case command := <-host.commands:
			if command != nil {
				command.done <- err
			}
		default:
			return
		}
	}
}

func (host *Host) onUIThread() bool {
	host.mu.RLock()
	threadID := host.uiThreadID
	host.mu.RUnlock()
	return threadID != 0 && windows.GetCurrentThreadId() == threadID
}

func (host *Host) invoke(ctx context.Context, apply func(*Host) error) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if host.onUIThread() {
		return apply(host)
	}

	host.mu.RLock()
	running := host.running
	closing := host.closing
	hwnd := host.hwnd
	host.mu.RUnlock()
	if !running || closing || hwnd == 0 {
		return ErrHostNotRunning
	}

	command := &uiCommand{apply: apply, done: make(chan error, 1)}
	select {
	case host.commands <- command:
	case <-ctx.Done():
		return ctx.Err()
	case <-host.done:
		return ErrHostNotRunning
	}
	if err := postHostCommand(hwnd); err != nil {
		return err
	}
	select {
	case err := <-command.done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-host.done:
		return ErrHostNotRunning
	}
}

func (host *Host) drainCommandsOnUI() {
	for {
		select {
		case command := <-host.commands:
			if command == nil {
				continue
			}
			err := command.apply(host)
			command.done <- err
		default:
			return
		}
	}
}

// State returns the current manually controlled surface state.
func (host *Host) State() HostState {
	host.mu.RLock()
	defer host.mu.RUnlock()
	state := HostState{
		ActiveTab:        host.activeTab,
		EmergencyStopped: host.emergencyStopped,
		WindowVisible:    host.windowVisible,
		TrayInstalled:    host.trayInstalled,
		TabCount:         len(host.tabs),
	}
	if active := host.tabs[host.activeTab]; active != nil {
		state.ActiveSurface = active.surface
	}
	return state
}

// CreateTab creates one controller in the selected existing environment and
// waits until WebView2 calls its real completion handler. It may not be called
// from the native UI thread because controller creation is asynchronous.
func (host *Host) CreateTab(ctx context.Context, surface Surface) (TabID, error) {
	if host.onUIThread() {
		return 0, ErrUIThreadWait
	}
	var created *tab
	err := host.invoke(ctx, func(host *Host) error {
		var err error
		created, err = host.createTabOnUI(surface, false)
		return err
	})
	if err != nil {
		return 0, err
	}
	select {
	case <-created.ready:
		if created.readyErr != nil {
			return 0, created.readyErr
		}
		return created.id, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-host.done:
		return 0, ErrHostNotRunning
	}
}

// SelectSurface is the explicit manual surface switch. It never creates a new
// tab or re-enables an emergency-stopped internet surface.
func (host *Host) SelectSurface(ctx context.Context, surface Surface) error {
	return host.invoke(ctx, func(host *Host) error {
		if surface != SurfaceShell && surface != SurfaceInternet {
			return fmt.Errorf("invalid surface %d", surface)
		}
		if surface == SurfaceInternet && host.emergencyStopped {
			return ErrEmergencyStopped
		}
		tab := host.firstReadyTabOnUI(surface)
		if tab == nil {
			return fmt.Errorf("no ready %s tab", surface)
		}
		return host.selectTabOnUI(tab)
	})
}

// Navigate changes a tab only after applying the internet URL boundary.
func (host *Host) Navigate(ctx context.Context, id TabID, rawURL string) error {
	return host.invoke(ctx, func(host *Host) error {
		host.mu.RLock()
		tab := host.tabs[id]
		host.mu.RUnlock()
		if tab == nil || tab.webview == nil {
			return fmt.Errorf("unknown or unready tab %d", id)
		}
		if tab.surface == SurfaceInternet {
			if host.emergencyStopped {
				return ErrEmergencyStopped
			}
			if err := validateInternetURL(rawURL); err != nil {
				return err
			}
		}
		return tab.webview.Navigate(rawURL)
	})
}

// EmergencyStop closes every internet controller, stops its in-flight
// navigation, hides the internet surface, and destroys the current Job Object
// so all supervised helper process trees are terminated by Windows.
func (host *Host) EmergencyStop(ctx context.Context) error {
	return host.invoke(ctx, func(host *Host) error {
		host.mu.Lock()
		host.emergencyStopped = true
		internetTabs := make([]*tab, 0)
		for _, candidate := range host.tabs {
			if candidate.surface == SurfaceInternet {
				internetTabs = append(internetTabs, candidate)
			}
		}
		supervisor := host.supervisor
		host.supervisor = nil
		host.mu.Unlock()

		var errs []error
		for _, candidate := range internetTabs {
			if candidate.webview != nil {
				errs = append(errs, candidate.webview.Stop())
			}
			errs = append(errs, host.closeTabOnUI(candidate))
			host.completeTabOnUI(candidate, ErrEmergencyStopped)
		}
		if supervisor != nil {
			errs = append(errs, supervisor.Close())
		}
		if shellTab := host.firstReadyTabOnUI(SurfaceShell); shellTab != nil {
			errs = append(errs, host.selectTabOnUI(shellTab))
		}
		return errors.Join(errs...)
	})
}

// ResetEmergencyStop is deliberately separate from EmergencyStop. It creates
// a fresh Job Object before allowing later manual internet-tab creation.
func (host *Host) ResetEmergencyStop(ctx context.Context) error {
	return host.invoke(ctx, func(host *Host) error {
		host.mu.RLock()
		stopped := host.emergencyStopped
		host.mu.RUnlock()
		if !stopped {
			return nil
		}
		supervisor, err := newProcessSupervisor()
		if err != nil {
			return fmt.Errorf("recreate Windows Job Object supervisor: %w", err)
		}
		host.mu.Lock()
		host.supervisor = supervisor
		host.emergencyStopped = false
		host.mu.Unlock()
		return nil
	})
}

// StartSupervised launches a helper only under the Host Job Object. It never
// returns a successfully started process that was not assigned to the Job.
func (host *Host) StartSupervised(name string, args ...string) (*SupervisedProcess, error) {
	host.mu.RLock()
	supervisor := host.supervisor
	running := host.running
	stopped := host.emergencyStopped
	host.mu.RUnlock()
	if !running || supervisor == nil {
		return nil, ErrHostNotRunning
	}
	if stopped {
		return nil, ErrEmergencyStopped
	}
	return supervisor.Start(name, args...)
}

// Close terminates the desktop host. A regular WM_CLOSE only hides the window
// to the tray; this method is the explicit terminal shutdown path.
func (host *Host) Close(ctx context.Context) error {
	host.mu.RLock()
	running := host.running
	host.mu.RUnlock()
	if !running {
		return nil
	}
	return host.invoke(ctx, func(host *Host) error {
		err := host.shutdownOnUI()
		if destroyErr := destroyNativeWindow(host.hwnd); destroyErr != nil {
			err = errors.Join(err, destroyErr)
		}
		return err
	})
}

func (host *Host) beginEnvironments() error {
	if err := os.MkdirAll(host.shellPlan.userDataDir, 0o700); err != nil {
		return fmt.Errorf("create shell user data directory: %w", err)
	}
	if err := os.MkdirAll(host.internetPlan.userDataDir, 0o700); err != nil {
		return fmt.Errorf("create internet user data directory: %w", err)
	}
	if err := os.MkdirAll(host.config.DownloadDir, 0o700); err != nil {
		return fmt.Errorf("create isolated download directory: %w", err)
	}

	host.shellEnvironmentCB = &environmentCreateHandler{host: host, surface: SurfaceShell}
	if err := webviewloader.CreateCoreWebView2EnvironmentWithOptions(
		host.shellEnvironmentCB,
		webviewloader.WithUserDataFolder(host.shellPlan.userDataDir),
		webviewloader.WithAdditionalBrowserArguments(host.shellPlan.browserArgs),
		webviewloader.WithAllowSingleSignOnUsingOSPrimaryAccount(false),
		webviewloader.WithExclusiveUserDataFolderAccess(true),
	); err != nil {
		return fmt.Errorf("create shell WebView2 environment: %w", err)
	}

	host.internetEnvironmentCB = &environmentCreateHandler{host: host, surface: SurfaceInternet}
	if err := webviewloader.CreateCoreWebView2EnvironmentWithOptions(
		host.internetEnvironmentCB,
		webviewloader.WithUserDataFolder(host.internetPlan.userDataDir),
		webviewloader.WithAdditionalBrowserArguments(host.internetPlan.browserArgs),
		webviewloader.WithAllowSingleSignOnUsingOSPrimaryAccount(false),
		webviewloader.WithExclusiveUserDataFolderAccess(true),
	); err != nil {
		return fmt.Errorf("create internet WebView2 environment: %w", err)
	}
	return nil
}

type environmentCreateHandler struct {
	host    *Host
	surface Surface
}

func (handler *environmentCreateHandler) EnvironmentCompleted(result webviewloader.HRESULT, created *webviewloader.ICoreWebView2Environment) webviewloader.HRESULT {
	if handler.host == nil || !handler.host.onUIThread() {
		if handler.host != nil {
			handler.host.signalReady(errors.New("WebView2 environment callback was not delivered on the STA UI thread"))
		}
		return 0
	}
	if result != 0 || created == nil {
		err := fmt.Errorf("create %s WebView2 environment: HRESULT 0x%08x", handler.surface, uint32(result))
		handler.host.abortOnUI(err)
		return 0
	}

	// webviewloader owns the callback reference and releases it after this
	// method returns. Retain the interface for the Host lifetime first.
	environment := (*webview2.ICoreWebView2Environment)(unsafe.Pointer(created))
	environment.AddRef()
	if err := handler.host.environmentCreatedOnUI(handler.surface, environment); err != nil {
		releaseCOM(environment)
		handler.host.abortOnUI(err)
	}
	return 0
}

func (host *Host) environmentCreatedOnUI(surface Surface, environment *webview2.ICoreWebView2Environment) error {
	host.mu.Lock()
	switch surface {
	case SurfaceShell:
		if host.shellEnvironment != nil {
			host.mu.Unlock()
			return errors.New("shell WebView2 environment was created twice")
		}
		host.shellEnvironment = environment
	case SurfaceInternet:
		if host.internetEnvironment != nil {
			host.mu.Unlock()
			return errors.New("internet WebView2 environment was created twice")
		}
		host.internetEnvironment = environment
	default:
		host.mu.Unlock()
		return fmt.Errorf("unknown environment surface %d", surface)
	}
	host.mu.Unlock()

	_, err := host.createTabOnUI(surface, true)
	return err
}

func (host *Host) createTabOnUI(surface Surface, initial bool) (*tab, error) {
	if surface != SurfaceShell && surface != SurfaceInternet {
		return nil, fmt.Errorf("invalid surface %d", surface)
	}
	host.mu.RLock()
	stopped := host.emergencyStopped
	var environment *webview2.ICoreWebView2Environment
	if surface == SurfaceShell {
		environment = host.shellEnvironment
	} else {
		environment = host.internetEnvironment
	}
	host.mu.RUnlock()
	if surface == SurfaceInternet && stopped {
		return nil, ErrEmergencyStopped
	}
	if environment == nil {
		return nil, fmt.Errorf("%s WebView2 environment is not ready", surface)
	}

	host.mu.Lock()
	host.nextTabID++
	created := &tab{
		id:      host.nextTabID,
		surface: surface,
		initial: initial,
		ready:   make(chan struct{}),
	}
	host.tabs[created.id] = created
	if initial {
		if surface == SurfaceShell {
			host.initialShellTab = created.id
		} else {
			host.initialInternetTab = created.id
		}
	}
	host.mu.Unlock()

	callback := &controllerCreateHandler{host: host, tabID: created.id}
	created.controllerCB = callback
	created.controllerHandler = webview2.NewICoreWebView2CreateCoreWebView2ControllerCompletedHandler(callback)
	if err := environment.CreateCoreWebView2Controller(webview2.HWND(host.hwnd), created.controllerHandler); err != nil {
		_ = host.closeTabOnUI(created)
		host.completeTabOnUI(created, err)
		return created, err
	}
	return created, nil
}

type controllerCreateHandler struct {
	host  *Host
	tabID TabID
}

func (*controllerCreateHandler) QueryInterface(_, _ uintptr) uintptr { return 0 }
func (*controllerCreateHandler) AddRef() uintptr                     { return 1 }
func (*controllerCreateHandler) Release() uintptr                    { return 1 }

func (handler *controllerCreateHandler) CreateCoreWebView2ControllerCompleted(result uintptr, controller *webview2.ICoreWebView2Controller) uintptr {
	if handler.host == nil || !handler.host.onUIThread() {
		return hresultFromError(errors.New("WebView2 controller callback was not delivered on the STA UI thread"))
	}
	if err := handler.host.controllerCreatedOnUI(handler.tabID, result, controller); err != nil {
		return hresultFromError(err)
	}
	return 0
}

func (host *Host) controllerCreatedOnUI(id TabID, result uintptr, controller *webview2.ICoreWebView2Controller) error {
	host.mu.RLock()
	created := host.tabs[id]
	host.mu.RUnlock()
	if created == nil {
		return fmt.Errorf("controller completion for unknown tab %d", id)
	}
	if int32(result) < 0 || controller == nil {
		err := fmt.Errorf("create %s controller: HRESULT 0x%08x", created.surface, uint32(result))
		host.failTabOnUI(created, err)
		return err
	}

	controller.AddRef()
	created.controller = controller
	core, err := controller.GetCoreWebView2()
	if err != nil {
		host.failTabOnUI(created, fmt.Errorf("get %s CoreWebView2: %w", created.surface, err))
		return err
	}
	created.webview = core
	if err := host.configureTabOnUI(created); err != nil {
		host.failTabOnUI(created, err)
		return err
	}
	if err := created.controller.PutIsVisible(false); err != nil {
		host.failTabOnUI(created, fmt.Errorf("hide unselected %s tab: %w", created.surface, err))
		return err
	}

	initialURL := ""
	if created.surface == SurfaceShell {
		initialURL = host.config.ShellURL
	} else {
		initialURL = host.config.InternetURL
	}
	if initialURL != "" {
		if created.surface == SurfaceInternet {
			if err := validateInternetURL(initialURL); err != nil {
				host.failTabOnUI(created, err)
				return err
			}
		}
		if err := created.webview.Navigate(initialURL); err != nil {
			host.failTabOnUI(created, fmt.Errorf("navigate initial %s tab: %w", created.surface, err))
			return err
		}
	}
	host.completeTabOnUI(created, nil)
	host.maybeStartInitialGateOnUI()
	return nil
}

func (host *Host) configureTabOnUI(created *tab) error {
	settings, err := created.webview.GetSettings()
	if err != nil {
		return fmt.Errorf("get %s settings: %w", created.surface, err)
	}
	defer releaseCOM(settings)

	// Neither surface receives a host object. In particular, the internet
	// surface never gets a native bridge, web-message listener, injected script,
	// or AddHostObjectToScript call.
	if err := settings.PutAreHostObjectsAllowed(false); err != nil {
		return fmt.Errorf("disable %s host objects: %w", created.surface, err)
	}
	if err := settings.PutIsWebMessageEnabled(false); err != nil {
		return fmt.Errorf("disable %s web messages: %w", created.surface, err)
	}

	created.navigationCB = &navigationFilterHandler{surface: created.surface}
	created.navigationHandler = webview2.NewICoreWebView2NavigationStartingEventHandler(created.navigationCB)
	navigationToken, err := created.webview.AddNavigationStarting(created.navigationHandler)
	if err != nil {
		return fmt.Errorf("register %s navigation filter: %w", created.surface, err)
	}
	created.navigationToken = navigationToken
	created.hasNavigationToken = true

	created.newWindowCB = &newWindowBlockHandler{}
	created.newWindowHandler = webview2.NewICoreWebView2NewWindowRequestedEventHandler(created.newWindowCB)
	newWindowToken, err := created.webview.AddNewWindowRequested(created.newWindowHandler)
	if err != nil {
		return fmt.Errorf("register %s popup blocker: %w", created.surface, err)
	}
	created.newWindowToken = newWindowToken
	created.hasNewWindowToken = true

	if created.surface != SurfaceInternet {
		return nil
	}

	if err := settings.PutAreDevToolsEnabled(false); err != nil {
		return fmt.Errorf("disable internet DevTools UI: %w", err)
	}
	if err := settings.PutAreDefaultContextMenusEnabled(false); err != nil {
		return fmt.Errorf("disable internet context menus: %w", err)
	}
	if err := settings.PutAreDefaultScriptDialogsEnabled(false); err != nil {
		return fmt.Errorf("disable internet script dialogs: %w", err)
	}
	if err := settings.PutIsStatusBarEnabled(false); err != nil {
		return fmt.Errorf("disable internet status bar: %w", err)
	}

	settings4 := settings.GetICoreWebView2Settings4()
	if settings4 == nil {
		return fmt.Errorf("%w: ICoreWebView2Settings4 (password/autofill controls)", ErrRequiredWebView2Capability)
	}
	defer releaseCOM(settings4)
	if err := settings4.PutIsPasswordAutosaveEnabled(false); err != nil {
		return fmt.Errorf("disable internet password autosave: %w", err)
	}
	if err := settings4.PutIsGeneralAutofillEnabled(false); err != nil {
		return fmt.Errorf("disable internet general autofill: %w", err)
	}

	created.permissionCB = &permissionDenyHandler{}
	created.permissionHandler = webview2.NewICoreWebView2PermissionRequestedEventHandler(created.permissionCB)
	permissionToken, err := created.webview.AddPermissionRequested(created.permissionHandler)
	if err != nil {
		return fmt.Errorf("register internet permission deny handler: %w", err)
	}
	created.permissionToken = permissionToken
	created.hasPermissionToken = true

	// Escape is owned by the native host while an internet controller has
	// focus. This recovery path does not expose a bridge or message channel to
	// internet content: WebView2 raises the controller event directly.
	created.acceleratorCB = &acceleratorEscapeHandler{host: host}
	created.acceleratorHandler = webview2.NewICoreWebView2AcceleratorKeyPressedEventHandler(created.acceleratorCB)
	acceleratorToken, err := created.controller.AddAcceleratorKeyPressed(created.acceleratorHandler)
	if err != nil {
		return fmt.Errorf("register internet Escape recovery handler: %w", err)
	}
	created.acceleratorToken = acceleratorToken
	created.hasAcceleratorToken = true
	return nil
}

const virtualKeyEscape uint32 = 0x1b

func shouldRecoverShellFromAccelerator(kind webview2.COREWEBVIEW2_KEY_EVENT_KIND, virtualKey uint32) bool {
	if virtualKey != virtualKeyEscape {
		return false
	}
	return kind == webview2.COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN ||
		kind == webview2.COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
}

type acceleratorEscapeHandler struct {
	host *Host
}

func (*acceleratorEscapeHandler) QueryInterface(_, _ uintptr) uintptr { return 0 }
func (*acceleratorEscapeHandler) AddRef() uintptr                     { return 1 }
func (*acceleratorEscapeHandler) Release() uintptr                    { return 1 }

func (handler *acceleratorEscapeHandler) AcceleratorKeyPressed(_ *webview2.ICoreWebView2Controller, args *webview2.ICoreWebView2AcceleratorKeyPressedEventArgs) uintptr {
	if handler == nil || handler.host == nil || !handler.host.onUIThread() {
		return hresultFromError(errors.New("WebView2 accelerator callback was not delivered on the STA UI thread"))
	}
	if args == nil {
		return hresultFromError(errors.New("nil WebView2 accelerator arguments"))
	}
	kind, err := args.GetKeyEventKind()
	if err != nil {
		return hresultFromError(err)
	}
	virtualKey, err := args.GetVirtualKey()
	if err != nil {
		return hresultFromError(err)
	}
	if !shouldRecoverShellFromAccelerator(kind, virtualKey) {
		return 0
	}
	// Mark Escape handled before returning to WebView2, then defer the actual
	// controller switch through the native message queue. Windowed WebView2
	// invokes this callback synchronously while its browser process is blocked.
	if err := args.PutHandled(true); err != nil {
		return hresultFromError(err)
	}
	handler.host.mu.RLock()
	hwnd := handler.host.hwnd
	handler.host.mu.RUnlock()
	if err := postHostReturnToShell(hwnd); err != nil {
		return hresultFromError(err)
	}
	return 0
}

type permissionDenyHandler struct{}

func (*permissionDenyHandler) QueryInterface(_, _ uintptr) uintptr { return 0 }
func (*permissionDenyHandler) AddRef() uintptr                     { return 1 }
func (*permissionDenyHandler) Release() uintptr                    { return 1 }

func (*permissionDenyHandler) PermissionRequested(_ *webview2.ICoreWebView2, args *webview2.ICoreWebView2PermissionRequestedEventArgs) uintptr {
	if args == nil {
		return hresultFromError(errors.New("nil WebView2 permission arguments"))
	}
	if err := args.PutState(webview2.COREWEBVIEW2_PERMISSION_STATE_DENY); err != nil {
		return hresultFromError(err)
	}
	return 0
}

type newWindowBlockHandler struct{}

func (*newWindowBlockHandler) QueryInterface(_, _ uintptr) uintptr { return 0 }
func (*newWindowBlockHandler) AddRef() uintptr                     { return 1 }
func (*newWindowBlockHandler) Release() uintptr                    { return 1 }

func (*newWindowBlockHandler) NewWindowRequested(_ *webview2.ICoreWebView2, args *webview2.ICoreWebView2NewWindowRequestedEventArgs) uintptr {
	if args == nil {
		return hresultFromError(errors.New("nil WebView2 new-window arguments"))
	}
	if err := args.PutHandled(true); err != nil {
		return hresultFromError(err)
	}
	return 0
}

type navigationFilterHandler struct {
	surface Surface
}

func (*navigationFilterHandler) QueryInterface(_, _ uintptr) uintptr { return 0 }
func (*navigationFilterHandler) AddRef() uintptr                     { return 1 }
func (*navigationFilterHandler) Release() uintptr                    { return 1 }

func (handler *navigationFilterHandler) NavigationStarting(_ *webview2.ICoreWebView2, args *webview2.ICoreWebView2NavigationStartingEventArgs) uintptr {
	if args == nil {
		return hresultFromError(errors.New("nil WebView2 navigation arguments"))
	}
	rawURL, err := args.GetUri()
	if err != nil {
		return hresultFromError(err)
	}
	if handler.surface == SurfaceInternet && validateInternetURL(rawURL) != nil {
		if err := args.PutCancel(true); err != nil {
			return hresultFromError(err)
		}
	}
	return 0
}

func (host *Host) failTabOnUI(created *tab, err error) {
	_ = host.closeTabOnUI(created)
	host.completeTabOnUI(created, err)
	if created.initial {
		host.abortOnUI(err)
	}
}

func (host *Host) completeTabOnUI(created *tab, err error) {
	created.readyOnce.Do(func() {
		created.readyErr = err
		created.complete = true
		close(created.ready)
	})
}

func (host *Host) maybeStartInitialGateOnUI() {
	host.mu.RLock()
	shell := host.tabs[host.initialShellTab]
	internet := host.tabs[host.initialInternetTab]
	ready := shell != nil && internet != nil && shell.complete && internet.complete && shell.readyErr == nil && internet.readyErr == nil && !host.gateStarted
	host.mu.RUnlock()
	if !ready {
		return
	}
	host.mu.Lock()
	if host.gateStarted {
		host.mu.Unlock()
		return
	}
	host.gateStarted = true
	host.mu.Unlock()

	go func() {
		gateContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, err := host.Gate0(gateContext)
		if err != nil {
			_ = host.invoke(context.Background(), func(host *Host) error {
				host.abortOnUI(fmt.Errorf("Gate 0 failed: %w", err))
				return nil
			})
			return
		}
		if err := host.invoke(context.Background(), func(host *Host) error {
			if initial := host.firstReadyTabOnUI(host.config.InitialSurface); initial != nil {
				if err := host.selectTabOnUI(initial); err != nil {
					return err
				}
			}
			if !host.config.StartHidden {
				return host.showNativeWindowOnUI()
			}
			return nil
		}); err != nil {
			host.signalReady(err)
			return
		}
		host.signalReady(nil)
	}()
}

func (host *Host) firstReadyTabOnUI(surface Surface) *tab {
	host.mu.RLock()
	defer host.mu.RUnlock()
	for _, candidate := range host.tabs {
		if candidate.surface == surface && candidate.complete && candidate.readyErr == nil && candidate.controller != nil {
			return candidate
		}
	}
	return nil
}

func (host *Host) selectTabOnUI(selected *tab) error {
	if selected == nil || selected.controller == nil {
		return errors.New("selected tab is not ready")
	}
	host.mu.RLock()
	tabs := make([]*tab, 0, len(host.tabs))
	for _, candidate := range host.tabs {
		tabs = append(tabs, candidate)
	}
	host.mu.RUnlock()

	var errs []error
	for _, candidate := range tabs {
		if candidate.controller == nil {
			continue
		}
		errs = append(errs, candidate.controller.PutIsVisible(candidate.id == selected.id))
	}
	if err := errors.Join(errs...); err != nil {
		return fmt.Errorf("switch active tab: %w", err)
	}
	host.mu.Lock()
	host.activeTab = selected.id
	host.mu.Unlock()
	return host.resizeActiveTabOnUI()
}

func (host *Host) closeTabOnUI(closing *tab) error {
	if closing == nil {
		return nil
	}
	host.mu.Lock()
	if current := host.tabs[closing.id]; current == closing {
		delete(host.tabs, closing.id)
		if host.activeTab == closing.id {
			host.activeTab = 0
		}
	}
	host.mu.Unlock()

	var errs []error
	if closing.controller != nil && closing.hasAcceleratorToken {
		errs = append(errs, closing.controller.RemoveAcceleratorKeyPressed(closing.acceleratorToken))
	}
	if closing.webview != nil {
		if closing.hasPermissionToken {
			errs = append(errs, closing.webview.RemovePermissionRequested(closing.permissionToken))
		}
		if closing.hasNewWindowToken {
			errs = append(errs, closing.webview.RemoveNewWindowRequested(closing.newWindowToken))
		}
		if closing.hasNavigationToken {
			errs = append(errs, closing.webview.RemoveNavigationStarting(closing.navigationToken))
		}
	}
	if closing.controller != nil {
		errs = append(errs, closing.controller.Close())
	}
	releaseCOM(closing.webview)
	releaseCOM(closing.controller)
	closing.webview = nil
	closing.controller = nil
	host.mu.Lock()
	for _, callback := range []any{
		closing.controllerHandler,
		closing.navigationHandler,
		closing.newWindowHandler,
		closing.permissionHandler,
		closing.acceleratorHandler,
	} {
		if callback != nil {
			host.callbackRoots = append(host.callbackRoots, callback)
		}
	}
	host.mu.Unlock()
	closing.controllerHandler = nil
	closing.navigationHandler = nil
	closing.newWindowHandler = nil
	closing.permissionHandler = nil
	closing.acceleratorHandler = nil
	return errors.Join(errs...)
}

func (host *Host) shutdownOnUI() error {
	host.mu.Lock()
	if host.closing {
		host.mu.Unlock()
		return nil
	}
	host.closing = true
	tabs := make([]*tab, 0, len(host.tabs))
	for _, candidate := range host.tabs {
		tabs = append(tabs, candidate)
	}
	supervisor := host.supervisor
	host.supervisor = nil
	shellEnvironment := host.shellEnvironment
	internetEnvironment := host.internetEnvironment
	host.shellEnvironment = nil
	host.internetEnvironment = nil
	host.mu.Unlock()

	var errs []error
	for _, candidate := range tabs {
		errs = append(errs, host.closeTabOnUI(candidate))
		host.completeTabOnUI(candidate, ErrHostNotRunning)
	}
	if supervisor != nil {
		errs = append(errs, supervisor.Close())
	}
	errs = append(errs, host.removeTrayOnUI())
	releaseCOM(shellEnvironment)
	releaseCOM(internetEnvironment)
	return errors.Join(errs...)
}

func (host *Host) abortOnUI(err error) {
	host.mu.Lock()
	if host.runErr == nil {
		host.runErr = err
	}
	hwnd := host.hwnd
	host.mu.Unlock()
	_ = host.shutdownOnUI()
	_ = destroyNativeWindow(hwnd)
}

func validateInternetURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("blocked URL scheme %q", parsed.Scheme)
	}
	if parsed.User != nil {
		return errors.New("URLs containing credentials are blocked")
	}
	host := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(parsed.Hostname())), ".")
	if host == "" {
		return errors.New("URL host is empty")
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return errors.New("loopback host is blocked")
	}
	if address, parseErr := netip.ParseAddr(host); parseErr == nil {
		address = address.Unmap()
		if address.IsLoopback() || address.IsPrivate() || address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() || address.IsMulticast() || address.IsUnspecified() {
			return fmt.Errorf("non-public address %s is blocked", address)
		}
	}
	return nil
}

func releaseCOM[T any](value *T) {
	if value == nil {
		return
	}
	unknown := (*webview2.IUnknown)(unsafe.Pointer(value))
	if unknown.Vtbl != nil {
		unknown.Vtbl.CallRelease(unsafe.Pointer(value))
	}
}

func hresultFromError(err error) uintptr {
	if err == nil {
		return 0
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return uintptr(errno)
	}
	// E_FAIL. The generated callback API uses uintptr rather than HRESULT.
	return uintptr(0x80004005)
}
