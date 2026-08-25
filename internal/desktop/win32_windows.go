//go:build windows && amd64

package desktop

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	webview2 "github.com/djkim0320/AetherOps/internal/desktop/webview2"
	"golang.org/x/sys/windows"
)

const (
	wmDestroy    = 0x0002
	wmSize       = 0x0005
	wmClose      = 0x0010
	wmKeyDown    = 0x0100
	wmSysKeyDown = 0x0104
	wmApp        = 0x8000

	wmHostCommand       = wmApp + 41
	wmHostTray          = wmApp + 42
	wmHostActivate      = wmApp + 43
	wmHostReturnToShell = wmApp + 44

	wmLButtonUp     = 0x0202
	wmLButtonDblClk = 0x0203
	wmRButtonUp     = 0x0205

	wsOverlappedWindow = 0x00CF0000
	cwUseDefault       = 0x80000000

	dwmwaUseImmersiveDarkMode = 20
	dwmwaBorderColor          = 34
	dwmwaCaptionColor         = 35
	dwmwaTextColor            = 36

	nimAdd         = 0x00000000
	nimDelete      = 0x00000002
	nifMessage     = 0x00000001
	nifIcon        = 0x00000002
	nifTip         = 0x00000004
	idiAetherOps   = 1
	idiArrow       = 32512
	mfString       = 0x00000000
	tpmRightButton = 0x0002
	tpmReturnCmd   = 0x0100
	trayMenuExitID = 1001
)

var (
	user32DLL   = windows.NewLazySystemDLL("user32.dll")
	shell32DLL  = windows.NewLazySystemDLL("shell32.dll")
	kernel32DLL = windows.NewLazySystemDLL("kernel32.dll")
	dwmapiDLL   = windows.NewLazySystemDLL("dwmapi.dll")

	procRegisterClassExW     = user32DLL.NewProc("RegisterClassExW")
	procCreateWindowExW      = user32DLL.NewProc("CreateWindowExW")
	procDefWindowProcW       = user32DLL.NewProc("DefWindowProcW")
	procGetMessageW          = user32DLL.NewProc("GetMessageW")
	procTranslateMessage     = user32DLL.NewProc("TranslateMessage")
	procDispatchMessageW     = user32DLL.NewProc("DispatchMessageW")
	procPostMessageW         = user32DLL.NewProc("PostMessageW")
	procPostQuitMessage      = user32DLL.NewProc("PostQuitMessage")
	procCreatePopupMenu      = user32DLL.NewProc("CreatePopupMenu")
	procAppendMenuW          = user32DLL.NewProc("AppendMenuW")
	procTrackPopupMenu       = user32DLL.NewProc("TrackPopupMenu")
	procDestroyMenu          = user32DLL.NewProc("DestroyMenu")
	procGetCursorPos         = user32DLL.NewProc("GetCursorPos")
	procShowWindow           = user32DLL.NewProc("ShowWindow")
	procFindWindowW          = user32DLL.NewProc("FindWindowW")
	procSetForegroundWin     = user32DLL.NewProc("SetForegroundWindow")
	procDestroyWindow        = user32DLL.NewProc("DestroyWindow")
	procGetClientRect        = user32DLL.NewProc("GetClientRect")
	procGetDpiForWindow      = user32DLL.NewProc("GetDpiForWindow")
	procGetWindowDPIContext  = user32DLL.NewProc("GetWindowDpiAwarenessContext")
	procGetThreadDPIContext  = user32DLL.NewProc("GetThreadDpiAwarenessContext")
	procAreDPIContextsEqual  = user32DLL.NewProc("AreDpiAwarenessContextsEqual")
	procSetProcessDPIContext = user32DLL.NewProc("SetProcessDpiAwarenessContext")
	procLoadIconW            = user32DLL.NewProc("LoadIconW")
	procLoadCursorW          = user32DLL.NewProc("LoadCursorW")
	procGetModuleHandleW     = kernel32DLL.NewProc("GetModuleHandleW")
	procShellNotifyIconW     = shell32DLL.NewProc("Shell_NotifyIconW")
	procShellExecuteW        = shell32DLL.NewProc("ShellExecuteW")
	procDwmSetWindowAttr     = dwmapiDLL.NewProc("DwmSetWindowAttribute")

	nativeWindowProc = windows.NewCallback(windowProc)
	windowHosts      sync.Map // map[uintptr]*Host
	dpiAwarenessOnce sync.Once
	dpiAwarenessErr  error
)

const dpiAwarenessContextPerMonitorV2 = ^uintptr(3) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4)

// OpenExternalURL opens a verified HTTPS URL with the user's default browser
// through ShellExecuteW. It does not invoke cmd.exe, PowerShell, or a shell
// command line.
func OpenExternalURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return errors.New("external URL must be an HTTPS URL without credentials")
	}
	operation, err := windows.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	target, err := windows.UTF16PtrFromString(parsed.String())
	if err != nil {
		return err
	}
	result, _, _ := procShellExecuteW.Call(
		0,
		uintptr(unsafe.Pointer(operation)),
		uintptr(unsafe.Pointer(target)),
		0,
		0,
		1, // SW_SHOWNORMAL
	)
	runtime.KeepAlive(operation)
	runtime.KeepAlive(target)
	if result <= 32 {
		return fmt.Errorf("open external URL failed with ShellExecuteW code %d", result)
	}
	return nil
}

type winPoint struct {
	X int32
	Y int32
}

type winRect struct {
	Left   int32
	Top    int32
	Right  int32
	Bottom int32
}

type winMessage struct {
	HWnd     uintptr
	Message  uint32
	_        uint32
	WParam   uintptr
	LParam   uintptr
	Time     uint32
	Pt       winPoint
	LPrivate uint32
}

type winClassEx struct {
	CbSize     uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSmall  uintptr
}

// NativeWindowDiagnostic contains values queried from the actual HWND. A
// non-zero DPI alone is not treated as proof of DPI awareness; the window's
// awareness context must also be Per-Monitor v2.
type NativeWindowDiagnostic struct {
	DPI           uint32 `json:"dpi"`
	ClientWidth   int32  `json:"clientWidth"`
	ClientHeight  int32  `json:"clientHeight"`
	PerMonitorV2  bool   `json:"perMonitorV2"`
	TrayInstalled bool   `json:"trayInstalled"`
	WindowVisible bool   `json:"windowVisible"`
}

// notifyIconDataW matches the Windows 11 NOTIFYICONDATAW layout. Shell_NotifyIconW
// copies it during NIM_ADD, so the structure does not need to outlive the call.
type notifyIconDataW struct {
	CbSize           uint32
	HWnd             uintptr
	UID              uint32
	UFlags           uint32
	UCallbackMessage uint32
	HIcon            uintptr
	SzTip            [128]uint16
	DwState          uint32
	DwStateMask      uint32
	SzInfo           [256]uint16
	UVersion         uint32
	SzInfoTitle      [64]uint16
	DwInfoFlags      uint32
	GuidItem         windows.GUID
	HBalloonIcon     uintptr
}

func (host *Host) createNativeWindow() error {
	if err := ensurePerMonitorV2DPI(); err != nil {
		return err
	}
	instance, _, callErr := procGetModuleHandleW.Call(0)
	if instance == 0 {
		return lastCallError("GetModuleHandleW", callErr)
	}
	className, err := windows.UTF16PtrFromString("AetherOps.DesktopHost." + host.config.ApplicationID)
	if err != nil {
		return err
	}
	title, err := windows.UTF16PtrFromString(host.config.WindowTitle)
	if err != nil {
		return err
	}
	icon, _, iconErr := procLoadIconW.Call(instance, uintptr(idiAetherOps))
	if icon == 0 {
		return lastCallError("LoadIconW(AetherOps)", iconErr)
	}
	cursor, _, cursorErr := procLoadCursorW.Call(0, uintptr(idiArrow))
	if cursor == 0 {
		return lastCallError("LoadCursorW", cursorErr)
	}

	class := winClassEx{
		CbSize:     uint32(unsafe.Sizeof(winClassEx{})),
		WndProc:    nativeWindowProc,
		Instance:   instance,
		Icon:       icon,
		Cursor:     cursor,
		Background: 6, // COLOR_WINDOW + 1
		ClassName:  className,
		IconSmall:  icon,
	}
	atom, _, registerErr := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&class)))
	if atom == 0 && !errors.Is(registerErr, syscall.Errno(1410)) { // ERROR_CLASS_ALREADY_EXISTS
		return lastCallError("RegisterClassExW", registerErr)
	}

	hwnd, _, createErr := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		uintptr(wsOverlappedWindow),
		uintptr(cwUseDefault),
		uintptr(cwUseDefault),
		1280,
		800,
		0,
		0,
		instance,
		0,
	)
	if hwnd == 0 {
		return lastCallError("CreateWindowExW", createErr)
	}
	if err := applyDarkWindowChrome(hwnd); err != nil {
		_ = destroyNativeWindow(hwnd)
		return err
	}
	host.mu.Lock()
	host.hwnd = hwnd
	host.mu.Unlock()
	windowHosts.Store(hwnd, host)
	if err := host.installTrayOnUI(icon); err != nil {
		windowHosts.Delete(hwnd)
		_ = destroyNativeWindow(hwnd)
		return err
	}
	return nil
}

func ensurePerMonitorV2DPI() error {
	dpiAwarenessOnce.Do(func() {
		current, _, currentErr := procGetThreadDPIContext.Call()
		if current != 0 && dpiContextsEqual(current, dpiAwarenessContextPerMonitorV2) {
			return
		}
		result, _, setErr := procSetProcessDPIContext.Call(dpiAwarenessContextPerMonitorV2)
		if result == 0 {
			// The process context can only be set once. Accept an already-set
			// process only when the effective thread context is exactly PMv2.
			current, _, _ = procGetThreadDPIContext.Call()
			if current != 0 && dpiContextsEqual(current, dpiAwarenessContextPerMonitorV2) {
				return
			}
			dpiAwarenessErr = lastCallError("SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)", setErr)
			if current == 0 && currentErr != nil && !errors.Is(currentErr, windows.ERROR_SUCCESS) {
				dpiAwarenessErr = errors.Join(dpiAwarenessErr, currentErr)
			}
			return
		}
		current, _, _ = procGetThreadDPIContext.Call()
		if current == 0 || !dpiContextsEqual(current, dpiAwarenessContextPerMonitorV2) {
			dpiAwarenessErr = errors.New("process accepted Per-Monitor v2 DPI configuration but the effective thread context differs")
		}
	})
	return dpiAwarenessErr
}

func dpiContextsEqual(left, right uintptr) bool {
	result, _, _ := procAreDPIContextsEqual.Call(left, right)
	return result != 0
}

// NativeWindowDiagnostics queries the real host window on its STA UI thread.
func (host *Host) NativeWindowDiagnostics(ctx context.Context) (NativeWindowDiagnostic, error) {
	var diagnostic NativeWindowDiagnostic
	err := host.invoke(ctx, func(host *Host) error {
		host.mu.RLock()
		hwnd := host.hwnd
		diagnostic.TrayInstalled = host.trayInstalled
		diagnostic.WindowVisible = host.windowVisible
		host.mu.RUnlock()
		if hwnd == 0 {
			return ErrHostNotRunning
		}
		dpi, _, dpiErr := procGetDpiForWindow.Call(hwnd)
		if dpi == 0 {
			return lastCallError("GetDpiForWindow", dpiErr)
		}
		diagnostic.DPI = uint32(dpi)
		awareness, _, awarenessErr := procGetWindowDPIContext.Call(hwnd)
		if awareness == 0 {
			return lastCallError("GetWindowDpiAwarenessContext", awarenessErr)
		}
		diagnostic.PerMonitorV2 = dpiContextsEqual(awareness, dpiAwarenessContextPerMonitorV2)
		var bounds winRect
		result, _, rectErr := procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&bounds)))
		if result == 0 {
			return lastCallError("GetClientRect", rectErr)
		}
		diagnostic.ClientWidth = bounds.Right - bounds.Left
		diagnostic.ClientHeight = bounds.Bottom - bounds.Top
		return nil
	})
	return diagnostic, err
}

// ActivateExistingWindow restores the already-running desktop host identified
// by applicationID. It is called before startup work so launching the EXE a
// second time behaves like opening the tray app instead of creating another
// core process.
func ActivateExistingWindow(applicationID string) (bool, error) {
	className, err := windows.UTF16PtrFromString("AetherOps.DesktopHost." + applicationID)
	if err != nil {
		return false, err
	}
	hwnd, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(className)), 0)
	if hwnd == 0 {
		return false, nil
	}
	result, _, callErr := procPostMessageW.Call(hwnd, uintptr(wmHostActivate), 0, 0)
	if result == 0 {
		return false, lastCallError("PostMessageW(WM_HOST_ACTIVATE)", callErr)
	}
	return true, nil
}

// ActivateTrayForGate0 posts the exact callback message registered with
// Shell_NotifyIconW. It is intentionally diagnostic-only; production tray
// interaction is normally generated by Explorer from a real pointer click.
func ActivateTrayForGate0(applicationID string) (bool, error) {
	className, err := windows.UTF16PtrFromString("AetherOps.DesktopHost." + applicationID)
	if err != nil {
		return false, err
	}
	hwnd, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(className)), 0)
	if hwnd == 0 {
		return false, nil
	}
	result, _, callErr := procPostMessageW.Call(hwnd, uintptr(wmHostTray), 0, uintptr(wmLButtonUp))
	if result == 0 {
		return false, lastCallError("PostMessageW(WM_HOST_TRAY)", callErr)
	}
	return true, nil
}

func applyDarkWindowChrome(hwnd uintptr) error {
	darkMode := int32(1)
	captionColor := colorRef(10, 16, 32) // #0a1020
	borderColor := colorRef(38, 51, 74)  // #26334a
	textColor := colorRef(231, 237, 248) // #e7edf8
	attributes := []struct {
		id    uint32
		value *uint32
	}{
		{id: dwmwaUseImmersiveDarkMode, value: (*uint32)(unsafe.Pointer(&darkMode))},
		{id: dwmwaCaptionColor, value: &captionColor},
		{id: dwmwaBorderColor, value: &borderColor},
		{id: dwmwaTextColor, value: &textColor},
	}
	for _, attribute := range attributes {
		result, _, _ := procDwmSetWindowAttr.Call(
			hwnd,
			uintptr(attribute.id),
			uintptr(unsafe.Pointer(attribute.value)),
			unsafe.Sizeof(*attribute.value),
		)
		if int32(result) < 0 {
			return fmt.Errorf("DwmSetWindowAttribute(%d): HRESULT 0x%08x", attribute.id, uint32(result))
		}
	}
	return nil
}

func colorRef(red, green, blue uint8) uint32 {
	return uint32(red) | uint32(green)<<8 | uint32(blue)<<16
}

func (host *Host) runMessageLoop() error {
	for {
		var message winMessage
		result, _, callErr := procGetMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) == -1 {
			return lastCallError("GetMessageW", callErr)
		}
		if result == 0 {
			return nil
		}
		// WebView2 normally reports Escape through AcceleratorKeyPressed. The
		// parent can still own focus immediately after a surface switch, though,
		// so consume the same key from the host UI thread before dispatch too.
		if isShellRecoveryKey(message.Message, message.WParam) && host.returnToShellFromNativeInputOnUI() {
			continue
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func isShellRecoveryKey(message uint32, wParam uintptr) bool {
	return (message == wmKeyDown || message == wmSysKeyDown) && uint32(wParam) == virtualKeyEscape
}

func (host *Host) returnToShellFromNativeInputOnUI() bool {
	host.mu.RLock()
	active := host.tabs[host.activeTab]
	host.mu.RUnlock()
	if active == nil || active.surface != SurfaceInternet {
		return false
	}
	shellTab := host.firstReadyTabOnUI(SurfaceShell)
	if shellTab == nil {
		return false
	}
	return host.selectTabOnUI(shellTab) == nil
}

func windowProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	if value, found := windowHosts.Load(hwnd); found {
		host := value.(*Host)
		switch message {
		case wmSize:
			_ = host.resizeActiveTabOnUI()
			return 0
		case wmClose:
			// Normal close minimizes the product to the tray. Explicit shutdown
			// goes through Host.Close and destroys the window.
			_ = host.hideNativeWindowOnUI()
			return 0
		case wmDestroy:
			windowHosts.Delete(hwnd)
			procPostQuitMessage.Call(0)
			return 0
		case wmHostCommand:
			host.drainCommandsOnUI()
			return 0
		case wmHostTray:
			if uint32(lParam) == wmRButtonUp {
				command, err := host.showTrayMenuOnUI(hwnd)
				if err == nil && command == trayMenuExitID {
					host.exitOnUI()
				}
				return 0
			}
			if uint32(lParam) == wmLButtonUp || uint32(lParam) == wmLButtonDblClk {
				if host.State().WindowVisible {
					_ = host.hideNativeWindowOnUI()
				} else {
					_ = host.showNativeWindowOnUI()
				}
			}
			return 0
		case wmHostActivate:
			_ = host.showNativeWindowOnUI()
			procSetForegroundWin.Call(hwnd)
			return 0
		case wmKeyDown, wmSysKeyDown:
			if isShellRecoveryKey(message, wParam) && host.returnToShellFromNativeInputOnUI() {
				return 0
			}
		case wmHostReturnToShell:
			_ = host.returnToShellFromNativeInputOnUI()
			return 0
		}
	}
	result, _, _ := procDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
	return result
}

func postHostCommand(hwnd uintptr) error {
	result, _, callErr := procPostMessageW.Call(hwnd, uintptr(wmHostCommand), 0, 0)
	if result == 0 {
		return lastCallError("PostMessageW", callErr)
	}
	return nil
}

func postHostReturnToShell(hwnd uintptr) error {
	if hwnd == 0 {
		return ErrHostNotRunning
	}
	result, _, callErr := procPostMessageW.Call(hwnd, uintptr(wmHostReturnToShell), 0, 0)
	if result == 0 {
		return lastCallError("PostMessageW(WM_HOST_RETURN_TO_SHELL)", callErr)
	}
	return nil
}

func destroyNativeWindow(hwnd uintptr) error {
	if hwnd == 0 {
		return nil
	}
	result, _, callErr := procDestroyWindow.Call(hwnd)
	if result == 0 {
		return lastCallError("DestroyWindow", callErr)
	}
	return nil
}

func (host *Host) resizeActiveTabOnUI() error {
	host.mu.RLock()
	hwnd := host.hwnd
	active := host.tabs[host.activeTab]
	host.mu.RUnlock()
	if hwnd == 0 || active == nil || active.controller == nil {
		return nil
	}
	var rect winRect
	result, _, callErr := procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&rect)))
	if result == 0 {
		return lastCallError("GetClientRect", callErr)
	}
	return active.controller.PutBounds(webview2.RECT{Left: rect.Left, Top: rect.Top, Right: rect.Right, Bottom: rect.Bottom})
}

func (host *Host) showNativeWindowOnUI() error {
	host.mu.RLock()
	hwnd := host.hwnd
	active := host.tabs[host.activeTab]
	host.mu.RUnlock()
	if hwnd == 0 {
		return ErrHostNotRunning
	}
	procShowWindow.Call(hwnd, uintptr(9)) // SW_RESTORE
	host.mu.Lock()
	host.windowVisible = true
	host.mu.Unlock()
	if active == nil || active.controller == nil {
		return host.resizeActiveTabOnUI()
	}

	// Rebind the controller's composition surface on every tray restore. A
	// WebView2 controller that stayed visible while its parent HWND was hidden
	// can otherwise restore as a white client area after prolonged occlusion.
	// Keep the sequence on the UI thread and always attempt to make the active
	// controller visible again, even if an earlier refresh step fails.
	var errs []error
	errs = append(errs, active.controller.PutIsVisible(false))
	errs = append(errs, host.resizeActiveTabOnUI())
	errs = append(errs, active.controller.NotifyParentWindowPositionChanged())
	errs = append(errs, active.controller.PutIsVisible(true))
	if err := errors.Join(errs...); err != nil {
		return fmt.Errorf("restore WebView2 surface: %w", err)
	}
	return nil
}

func (host *Host) hideNativeWindowOnUI() error {
	host.mu.RLock()
	hwnd := host.hwnd
	host.mu.RUnlock()
	if hwnd == 0 {
		return ErrHostNotRunning
	}
	procShowWindow.Call(hwnd, 0) // SW_HIDE
	host.mu.Lock()
	host.windowVisible = false
	host.mu.Unlock()
	return nil
}

func (host *Host) installTrayOnUI(icon uintptr) error {
	host.mu.RLock()
	hwnd := host.hwnd
	title := host.config.WindowTitle
	host.mu.RUnlock()
	var data notifyIconDataW
	data.CbSize = uint32(unsafe.Sizeof(data))
	data.HWnd = hwnd
	data.UID = 1
	data.UFlags = nifMessage | nifIcon | nifTip
	data.UCallbackMessage = wmHostTray
	data.HIcon = icon
	tooltip, err := windows.UTF16FromString(title)
	if err != nil {
		return err
	}
	copy(data.SzTip[:], tooltip)
	result, _, callErr := procShellNotifyIconW.Call(nimAdd, uintptr(unsafe.Pointer(&data)))
	if result == 0 {
		return lastCallError("Shell_NotifyIconW(NIM_ADD)", callErr)
	}
	host.mu.Lock()
	host.trayInstalled = true
	host.mu.Unlock()
	return nil
}

func (host *Host) removeTrayOnUI() error {
	host.mu.Lock()
	installed := host.trayInstalled
	host.trayInstalled = false
	hwnd := host.hwnd
	host.mu.Unlock()
	if !installed || hwnd == 0 {
		return nil
	}
	data := notifyIconDataW{CbSize: uint32(unsafe.Sizeof(notifyIconDataW{})), HWnd: hwnd, UID: 1}
	result, _, callErr := procShellNotifyIconW.Call(nimDelete, uintptr(unsafe.Pointer(&data)))
	if result == 0 {
		return lastCallError("Shell_NotifyIconW(NIM_DELETE)", callErr)
	}
	return nil
}

func (host *Host) showTrayMenuOnUI(hwnd uintptr) (uintptr, error) {
	menu, _, menuErr := procCreatePopupMenu.Call()
	if menu == 0 {
		return 0, lastCallError("CreatePopupMenu", menuErr)
	}
	defer procDestroyMenu.Call(menu)
	label, err := windows.UTF16PtrFromString("Exit AetherOps")
	if err != nil {
		return 0, err
	}
	result, _, appendErr := procAppendMenuW.Call(
		menu, uintptr(mfString), uintptr(trayMenuExitID), uintptr(unsafe.Pointer(label)),
	)
	runtime.KeepAlive(label)
	if result == 0 {
		return 0, lastCallError("AppendMenuW", appendErr)
	}
	var point winPoint
	result, _, cursorErr := procGetCursorPos.Call(uintptr(unsafe.Pointer(&point)))
	if result == 0 {
		return 0, lastCallError("GetCursorPos", cursorErr)
	}
	procSetForegroundWin.Call(hwnd)
	command, _, trackErr := procTrackPopupMenu.Call(
		menu,
		uintptr(tpmRightButton|tpmReturnCmd),
		uintptr(int64(point.X)),
		uintptr(int64(point.Y)),
		0,
		hwnd,
		0,
	)
	if command == 0 && trackErr != nil && !errors.Is(trackErr, windows.ERROR_SUCCESS) {
		return 0, lastCallError("TrackPopupMenu", trackErr)
	}
	return command, nil
}

func (host *Host) exitOnUI() {
	host.mu.RLock()
	hwnd := host.hwnd
	host.mu.RUnlock()
	err := host.shutdownOnUI()
	if destroyErr := destroyNativeWindow(hwnd); destroyErr != nil {
		err = errors.Join(err, destroyErr)
	}
	if err != nil {
		host.mu.Lock()
		if host.runErr == nil {
			host.runErr = err
		}
		host.mu.Unlock()
	}
}

func lastCallError(operation string, callErr error) error {
	if callErr != nil && !errors.Is(callErr, windows.ERROR_SUCCESS) {
		return fmt.Errorf("%s: %w", operation, callErr)
	}
	return fmt.Errorf("%s failed", operation)
}
