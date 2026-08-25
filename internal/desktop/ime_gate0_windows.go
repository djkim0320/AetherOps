//go:build windows && amd64

package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"time"
	"unsafe"

	webview2 "github.com/djkim0320/AetherOps/internal/desktop/webview2"
	"golang.org/x/sys/windows"
)

const (
	koreanLanguageID  = 0x0412
	inputKeyboard     = 1
	keyEventKeyUp     = 0x0002
	virtualKeySpace   = 0x20
	virtualKeyCapital = 0x14
	virtualKeyHangul  = 0x15
)

var (
	imm32DLL                   = windows.NewLazySystemDLL("imm32.dll")
	procGetKeyboardLayout      = user32DLL.NewProc("GetKeyboardLayout")
	procGetKeyboardLayoutList  = user32DLL.NewProc("GetKeyboardLayoutList")
	procActivateKeyboardLayout = user32DLL.NewProc("ActivateKeyboardLayout")
	procGetForegroundWindow    = user32DLL.NewProc("GetForegroundWindow")
	procGetWindowThreadID      = user32DLL.NewProc("GetWindowThreadProcessId")
	procAttachThreadInput      = user32DLL.NewProc("AttachThreadInput")
	procBringWindowToTop       = user32DLL.NewProc("BringWindowToTop")
	procSetActiveWindow        = user32DLL.NewProc("SetActiveWindow")
	procSetFocus               = user32DLL.NewProc("SetFocus")
	procGetFocus               = user32DLL.NewProc("GetFocus")
	procSendInput              = user32DLL.NewProc("SendInput")
	procGetKeyState            = user32DLL.NewProc("GetKeyState")
	procImmGetContext          = imm32DLL.NewProc("ImmGetContext")
	procImmReleaseContext      = imm32DLL.NewProc("ImmReleaseContext")
	procImmGetOpenStatus       = imm32DLL.NewProc("ImmGetOpenStatus")
	procImmSetOpenStatus       = imm32DLL.NewProc("ImmSetOpenStatus")
)

type keyboardInput struct {
	VirtualKey uint16
	ScanCode   uint16
	Flags      uint32
	Time       uint32
	ExtraInfo  uintptr
}

type nativeInput struct {
	Type    uint32
	_       uint32
	Key     keyboardInput
	Padding [8]byte // INPUT's union is sized for MOUSEINPUT (32 bytes on x64).
}

// KoreanIMEDiagnostic is emitted only after input traverses Windows' active
// Korean IME and WebView2 returns the resulting DOM value. JavaScript is used
// to prepare and read the field, never to assign the tested value.
type KoreanIMEDiagnostic struct {
	Executed     bool   `json:"executed"`
	Passed       bool   `json:"passed"`
	InputLocale  string `json:"inputLocale,omitempty"`
	PhysicalKeys string `json:"physicalKeys,omitempty"`
	Expected     string `json:"expected,omitempty"`
	Observed     string `json:"observed,omitempty"`
	IMEOpen      bool   `json:"imeOpen"`
	Failure      string `json:"failure,omitempty"`
}

type scriptCompletion struct {
	result string
	err    error
}

type executeScriptHandler struct {
	done chan scriptCompletion
}

func (*executeScriptHandler) QueryInterface(_, _ uintptr) uintptr { return 0 }
func (*executeScriptHandler) AddRef() uintptr                     { return 1 }
func (*executeScriptHandler) Release() uintptr                    { return 1 }

func (handler *executeScriptHandler) ExecuteScriptCompleted(errorCode uintptr, result *uint16) uintptr {
	completion := scriptCompletion{}
	if int32(uint32(errorCode)) < 0 {
		completion.err = fmt.Errorf("WebView2 ExecuteScript callback: HRESULT 0x%08x", uint32(errorCode))
	} else if result == nil {
		completion.err = errors.New("WebView2 ExecuteScript returned a nil result")
	} else {
		completion.result = windows.UTF16PtrToString(result)
	}
	select {
	case handler.done <- completion:
	default:
	}
	return 0
}

func (host *Host) executeShellScript(ctx context.Context, script string) (string, error) {
	completion := &executeScriptHandler{done: make(chan scriptCompletion, 1)}
	native := webview2.NewICoreWebView2ExecuteScriptCompletedHandler(completion)
	err := host.invoke(ctx, func(host *Host) error {
		tab := host.firstReadyTabOnUI(SurfaceShell)
		if tab == nil || tab.webview == nil {
			return errors.New("ready shell WebView2 is unavailable")
		}
		// WebView2 owns a native pointer to this callback until completion.
		// Root both the ABI wrapper and implementation for the Host lifetime.
		host.callbackRoots = append(host.callbackRoots, completion, native)
		return tab.webview.ExecuteScript(script, native)
	})
	if err != nil {
		return "", err
	}
	select {
	case result := <-completion.done:
		return result.result, result.err
	case <-ctx.Done():
		return "", ctx.Err()
	case <-host.done:
		return "", ErrHostNotRunning
	}
}

type imeRestoreState struct {
	previousLayout uintptr
	previousWindow uintptr
	focusedWindow  uintptr
	inputContext   uintptr
	wasOpen        bool
	capsLockWasOn  bool
}

// RunKoreanIMEGate0 performs a real Korean IME composition against the shell
// WebView2. It fails closed when no Korean input locale is installed.
func (host *Host) RunKoreanIMEGate0(ctx context.Context) KoreanIMEDiagnostic {
	diagnostic := KoreanIMEDiagnostic{
		Expected:     "한글 입력",
		PhysicalKeys: "gksrmf dlqfur",
	}
	setup := `(() => {
		document.documentElement.lang = 'ko';
		document.body.innerHTML = '<label for="aetherops-ime">AetherOps Korean IME Gate 0</label><textarea id="aetherops-ime" autocomplete="off" spellcheck="false"></textarea>';
		const input = document.getElementById('aetherops-ime');
		input.value = '';
		input.focus();
		return document.activeElement === input;
	})()`
	result, err := host.executeShellScript(ctx, setup)
	if err != nil {
		diagnostic.Failure = fmt.Sprintf("prepare Korean IME WebView2 field: %v", err)
		return diagnostic
	}
	var focused bool
	if err := json.Unmarshal([]byte(result), &focused); err != nil || !focused {
		diagnostic.Failure = fmt.Sprintf("shell WebView2 input did not accept DOM focus (result %q)", result)
		return diagnostic
	}

	var restore imeRestoreState
	var selectedLayout uintptr
	err = host.invoke(ctx, func(host *Host) error {
		tab := host.firstReadyTabOnUI(SurfaceShell)
		if tab == nil || tab.controller == nil {
			return errors.New("ready shell WebView2 controller is unavailable")
		}
		if err := host.selectTabOnUI(tab); err != nil {
			return err
		}
		if err := host.showNativeWindowOnUI(); err != nil {
			return err
		}
		restore.previousWindow, _, _ = procGetForegroundWindow.Call()
		foregroundThread := uintptr(0)
		if restore.previousWindow != 0 {
			foregroundThread, _, _ = procGetWindowThreadID.Call(restore.previousWindow, 0)
		}
		currentThread := uintptr(windows.GetCurrentThreadId())
		attached := false
		if foregroundThread != 0 && foregroundThread != currentThread {
			result, _, attachErr := procAttachThreadInput.Call(currentThread, foregroundThread, 1)
			if result == 0 {
				return lastCallError("AttachThreadInput", attachErr)
			}
			attached = true
			defer procAttachThreadInput.Call(currentThread, foregroundThread, 0)
		}
		procBringWindowToTop.Call(host.hwnd)
		procSetActiveWindow.Call(host.hwnd)
		procSetFocus.Call(host.hwnd)
		foregroundResult, _, foregroundErr := procSetForegroundWin.Call(host.hwnd)
		if foregroundResult == 0 {
			return lastCallError("SetForegroundWindow", foregroundErr)
		}
		if err := tab.controller.MoveFocus(); err != nil {
			return err
		}
		foregroundWindow, _, _ := procGetForegroundWindow.Call()
		if foregroundWindow != host.hwnd {
			return fmt.Errorf("Gate 0 window did not become foreground (got 0x%X, want 0x%X, attached=%t)", foregroundWindow, host.hwnd, attached)
		}

		layout, layoutErr := findInstalledInputLocale(koreanLanguageID)
		if layoutErr != nil {
			return layoutErr
		}
		selectedLayout = layout
		restore.previousLayout, _, _ = procGetKeyboardLayout.Call(0)
		activated, _, activateErr := procActivateKeyboardLayout.Call(layout, 0)
		if activated == 0 {
			return lastCallError("ActivateKeyboardLayout(Korean)", activateErr)
		}

		restore.focusedWindow, _, _ = procGetFocus.Call()
		if restore.focusedWindow == 0 {
			return errors.New("WebView2 did not expose a focused native input window")
		}
		restore.inputContext, _, _ = procImmGetContext.Call(restore.focusedWindow)
		if restore.inputContext != 0 {
			open, _, _ := procImmGetOpenStatus.Call(restore.inputContext)
			restore.wasOpen = open != 0
			setOpen, _, setOpenErr := procImmSetOpenStatus.Call(restore.inputContext, 1)
			if setOpen == 0 {
				return lastCallError("ImmSetOpenStatus", setOpenErr)
			}
			open, _, _ = procImmGetOpenStatus.Call(restore.inputContext)
			diagnostic.IMEOpen = open != 0
		}

		caps, _, _ := procGetKeyState.Call(virtualKeyCapital)
		restore.capsLockWasOn = uint16(caps)&1 != 0
		if restore.capsLockWasOn {
			if err := sendVirtualKeys([]uint16{virtualKeyCapital}); err != nil {
				return fmt.Errorf("temporarily disable Caps Lock: %w", err)
			}
		}
		keyGroups := make([][]uint16, 1, 2)
		for _, character := range diagnostic.PhysicalKeys {
			if character == ' ' {
				if len(keyGroups[len(keyGroups)-1]) == 0 {
					return errors.New("Korean IME probe contains an empty word")
				}
				keyGroups = append(keyGroups, nil)
				continue
			}
			if character < 'a' || character > 'z' {
				return fmt.Errorf("unsupported physical key %q", character)
			}
			last := len(keyGroups) - 1
			keyGroups[last] = append(keyGroups[last], uint16(character-'a')+'A')
		}
		if len(keyGroups[len(keyGroups)-1]) == 0 {
			return errors.New("Korean IME probe contains an empty final word")
		}
		// Chromium commonly handles composition through TSF and exposes no
		// legacy IMM32 context. VK_HANGUL exercises the same user-visible
		// Korean/Latin mode transition before the physical Dubeolsik keys.
		// Deliver the toggle separately so the renderer's TSF thread commits
		// the mode transition before it receives the first character.
		if err := sendVirtualKeys([]uint16{virtualKeyHangul}); err != nil {
			return err
		}
		time.Sleep(150 * time.Millisecond)
		for index, keys := range keyGroups {
			if err := sendVirtualKeys(keys); err != nil {
				return err
			}
			if index+1 < len(keyGroups) {
				// A batched word+space+word sequence lets Chromium's TSF queue
				// apply the space after the following composition. Commit each
				// word first, then deliver the separator as a distinct input.
				time.Sleep(100 * time.Millisecond)
				if err := sendVirtualKeys([]uint16{virtualKeySpace}); err != nil {
					return err
				}
				time.Sleep(100 * time.Millisecond)
			}
		}
		return nil
	})
	if selectedLayout != 0 {
		diagnostic.InputLocale = fmt.Sprintf("0x%X", selectedLayout)
	}
	if err != nil {
		diagnostic.Failure = fmt.Sprintf("send Korean IME input: %v", err)
		host.restoreIMEProbe(ctx, restore)
		return diagnostic
	}
	diagnostic.Executed = true

	deadline := time.Now().Add(5 * time.Second)
	for {
		result, err = host.executeShellScript(ctx, `document.getElementById('aetherops-ime')?.value ?? null`)
		if err != nil {
			diagnostic.Failure = fmt.Sprintf("read Korean IME WebView2 field: %v", err)
			break
		}
		var observed *string
		if json.Unmarshal([]byte(result), &observed) == nil && observed != nil {
			diagnostic.Observed = *observed
			if diagnostic.Observed == diagnostic.Expected {
				diagnostic.IMEOpen = true // proven by composed Korean DOM output
				diagnostic.Passed = true
				break
			}
		}
		if time.Now().After(deadline) {
			diagnostic.Failure = fmt.Sprintf("Korean IME DOM readback was %q, want %q", diagnostic.Observed, diagnostic.Expected)
			break
		}
		select {
		case <-ctx.Done():
			diagnostic.Failure = ctx.Err().Error()
			break
		case <-time.After(50 * time.Millisecond):
		}
		if diagnostic.Failure != "" {
			break
		}
	}
	host.restoreIMEProbe(ctx, restore)
	return diagnostic
}

func (host *Host) restoreIMEProbe(ctx context.Context, restore imeRestoreState) {
	_ = host.invoke(ctx, func(_ *Host) error {
		if restore.inputContext != 0 {
			open := uintptr(0)
			if restore.wasOpen {
				open = 1
			}
			procImmSetOpenStatus.Call(restore.inputContext, open)
			procImmReleaseContext.Call(restore.focusedWindow, restore.inputContext)
		}
		if restore.previousLayout != 0 {
			procActivateKeyboardLayout.Call(restore.previousLayout, 0)
		}
		if restore.previousWindow != 0 {
			procSetForegroundWin.Call(restore.previousWindow)
		}
		if restore.capsLockWasOn {
			_ = sendVirtualKeys([]uint16{virtualKeyCapital})
		}
		return nil
	})
}

func findInstalledInputLocale(languageID uint16) (uintptr, error) {
	count, _, countErr := procGetKeyboardLayoutList.Call(0, 0)
	if count == 0 {
		return 0, lastCallError("GetKeyboardLayoutList(count)", countErr)
	}
	layouts := make([]uintptr, int(count))
	read, _, readErr := procGetKeyboardLayoutList.Call(count, uintptr(unsafe.Pointer(&layouts[0])))
	if read == 0 {
		return 0, lastCallError("GetKeyboardLayoutList", readErr)
	}
	for _, layout := range layouts[:int(read)] {
		if uint16(layout&0xffff) == languageID {
			return layout, nil
		}
	}
	return 0, fmt.Errorf("Korean input locale 0x%04X is not installed", languageID)
}

func sendVirtualKeys(keys []uint16) error {
	if len(keys) == 0 {
		return errors.New("no virtual keys supplied")
	}
	inputs := make([]nativeInput, 0, len(keys)*2)
	for _, key := range keys {
		inputs = append(inputs,
			nativeInput{Type: inputKeyboard, Key: keyboardInput{VirtualKey: key}},
			nativeInput{Type: inputKeyboard, Key: keyboardInput{VirtualKey: key, Flags: keyEventKeyUp}},
		)
	}
	sent, _, sendErr := procSendInput.Call(
		uintptr(len(inputs)),
		uintptr(unsafe.Pointer(&inputs[0])),
		unsafe.Sizeof(inputs[0]),
	)
	runtime.KeepAlive(inputs)
	if sent != uintptr(len(inputs)) {
		return fmt.Errorf("SendInput inserted %d of %d events: %w", sent, len(inputs), sendErr)
	}
	return nil
}
