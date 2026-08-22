//go:build windows && amd64

// Package webview2 is the deliberately small WebView2 COM ABI surface used by
// the desktop host. It avoids generated callbacks with non-word Go arguments,
// which are rejected by Go 1.26's Windows callback ABI. Every callback below
// uses only uintptr values at the ABI boundary.
package webview2

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	sOK          = uintptr(0)
	eFail        = uintptr(0x80004005)
	eNoInterface = uintptr(0x80004002)
)

// HWND is the Win32 parent-window handle accepted by WebView2.
type HWND uintptr

// EventRegistrationToken is the ABI-stable token returned by WebView2 event
// registration methods.
type EventRegistrationToken struct {
	Value int64
}

type COREWEBVIEW2_PERMISSION_STATE int32

const (
	COREWEBVIEW2_PERMISSION_STATE_DEFAULT COREWEBVIEW2_PERMISSION_STATE = iota
	COREWEBVIEW2_PERMISSION_STATE_ALLOW
	COREWEBVIEW2_PERMISSION_STATE_DENY
)

// IUnknown is the shared prefix of every WebView2 interface.
type IUnknown struct {
	Vtbl *IUnknownVtbl
}

type IUnknownVtbl struct {
	QueryInterface uintptr
	AddRef         uintptr
	Release        uintptr
}

// CallRelease releases a COM reference whose concrete type begins with an
// IUnknown vtable pointer.
func (v *IUnknownVtbl) CallRelease(this unsafe.Pointer) uint32 {
	if v == nil || v.Release == 0 || this == nil {
		return 0
	}
	result, _, _ := syscall.SyscallN(v.Release, uintptr(this))
	runtime.KeepAlive(this)
	return uint32(result)
}

// Release is provided for loader-owned interface references.
func (i *IUnknown) Release() uintptr {
	if i == nil || i.Vtbl == nil {
		return 0
	}
	return uintptr(i.Vtbl.CallRelease(unsafe.Pointer(i)))
}

func comProc(this unsafe.Pointer, index uintptr) uintptr {
	if this == nil {
		return 0
	}
	vtable := *(*unsafe.Pointer)(this)
	if vtable == nil {
		return 0
	}
	return *(*uintptr)(unsafe.Add(vtable, index*unsafe.Sizeof(uintptr(0))))
}

func callCOM(this unsafe.Pointer, index uintptr, args ...uintptr) (uintptr, error) {
	procedure := comProc(this, index)
	if procedure == 0 {
		return 0, fmt.Errorf("WebView2 COM method %d is unavailable", index)
	}
	parameters := make([]uintptr, 1, len(args)+1)
	parameters[0] = uintptr(this)
	parameters = append(parameters, args...)
	result, _, lastErr := syscall.SyscallN(procedure, parameters...)
	runtime.KeepAlive(this)
	return result, lastErr
}

func hresultError(operation string, result uintptr) error {
	if int32(uint32(result)) >= 0 {
		return nil
	}
	return fmt.Errorf("%s: HRESULT 0x%08x", operation, uint32(result))
}

func callHRESULT(this unsafe.Pointer, index uintptr, operation string, args ...uintptr) error {
	result, err := callCOM(this, index, args...)
	if err != nil {
		// COM conveys operation failure through HRESULT. callCOM returns a
		// non-syscall error only when the vtable entry itself is unavailable;
		// Windows last-error is otherwise undefined for a COM method.
		if _, isLastError := err.(syscall.Errno); !isLastError {
			return fmt.Errorf("%s: %w", operation, err)
		}
	}
	return hresultError(operation, result)
}

func boolWord(value bool) uintptr {
	if value {
		return 1
	}
	return 0
}

func getBool(this unsafe.Pointer, index uintptr, operation string) (bool, error) {
	var result int32
	if err := callHRESULT(this, index, operation, uintptr(unsafe.Pointer(&result))); err != nil {
		return false, err
	}
	return result != 0, nil
}

func putBool(this unsafe.Pointer, index uintptr, operation string, value bool) error {
	return callHRESULT(this, index, operation, boolWord(value))
}

// ICoreWebView2Environment is the environment used to create controllers.
type ICoreWebView2Environment struct {
	Vtbl *IUnknownVtbl
}

func (i *ICoreWebView2Environment) AddRef() uintptr {
	if i == nil || i.Vtbl == nil || i.Vtbl.AddRef == 0 {
		return 0
	}
	result, _, _ := syscall.SyscallN(i.Vtbl.AddRef, uintptr(unsafe.Pointer(i)))
	runtime.KeepAlive(i)
	return result
}

// CreateCoreWebView2Controller creates a controller asynchronously. HWND is
// passed by value, as required by the native WebView2 ABI.
func (i *ICoreWebView2Environment) CreateCoreWebView2Controller(parent HWND, handler *ICoreWebView2CreateCoreWebView2ControllerCompletedHandler) error {
	if i == nil || handler == nil {
		return fmt.Errorf("create WebView2 controller: nil environment or completion handler")
	}
	return callHRESULT(unsafe.Pointer(i), 3, "CreateCoreWebView2Controller", uintptr(parent), uintptr(unsafe.Pointer(handler)))
}

// ICoreWebView2Controller owns the visual controller hosted by an HWND.
type ICoreWebView2Controller struct {
	Vtbl *IUnknownVtbl
}

type RECT struct {
	Left   int32
	Top    int32
	Right  int32
	Bottom int32
}

func (i *ICoreWebView2Controller) AddRef() uintptr {
	if i == nil || i.Vtbl == nil || i.Vtbl.AddRef == 0 {
		return 0
	}
	result, _, _ := syscall.SyscallN(i.Vtbl.AddRef, uintptr(unsafe.Pointer(i)))
	runtime.KeepAlive(i)
	return result
}

func (i *ICoreWebView2Controller) PutIsVisible(visible bool) error {
	if i == nil {
		return fmt.Errorf("set controller visibility: nil controller")
	}
	return putBool(unsafe.Pointer(i), 4, "ICoreWebView2Controller.put_IsVisible", visible)
}

func (i *ICoreWebView2Controller) PutBounds(bounds RECT) error {
	if i == nil {
		return fmt.Errorf("set controller bounds: nil controller")
	}
	// RECT is a 16-byte value and is passed indirectly under the x64 Windows
	// ABI, matching ICoreWebView2Controller::put_Bounds.
	return callHRESULT(unsafe.Pointer(i), 6, "ICoreWebView2Controller.put_Bounds", uintptr(unsafe.Pointer(&bounds)))
}

// MoveFocus places keyboard focus inside the WebView2 controller. Gate 0 uses
// this to exercise the real Windows IME path rather than assigning a DOM value
// from JavaScript and calling that an input test.
func (i *ICoreWebView2Controller) MoveFocus() error {
	if i == nil {
		return fmt.Errorf("move controller focus: nil controller")
	}
	// COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC is zero. MoveFocus is the
	// twelfth method in the stable ICoreWebView2Controller vtable.
	return callHRESULT(unsafe.Pointer(i), 12, "ICoreWebView2Controller.MoveFocus", 0)
}

// NotifyParentWindowPositionChanged tells the WebView2 composition host to
// resynchronize with its HWND after the parent has been restored or moved.
// Without this notification an occluded controller can remain as a blank
// surface after Windows has kept the tray application hidden for a long time.
func (i *ICoreWebView2Controller) NotifyParentWindowPositionChanged() error {
	if i == nil {
		return fmt.Errorf("notify parent window position changed: nil controller")
	}
	return callHRESULT(
		unsafe.Pointer(i),
		23,
		"ICoreWebView2Controller.NotifyParentWindowPositionChanged",
	)
}

func (i *ICoreWebView2Controller) AddAcceleratorKeyPressed(handler *ICoreWebView2AcceleratorKeyPressedEventHandler) (EventRegistrationToken, error) {
	if i == nil || handler == nil {
		return EventRegistrationToken{}, fmt.Errorf("ICoreWebView2Controller.add_AcceleratorKeyPressed: nil controller or handler")
	}
	var token EventRegistrationToken
	if err := callHRESULT(
		unsafe.Pointer(i),
		19,
		"ICoreWebView2Controller.add_AcceleratorKeyPressed",
		uintptr(unsafe.Pointer(handler)),
		uintptr(unsafe.Pointer(&token)),
	); err != nil {
		return EventRegistrationToken{}, err
	}
	return token, nil
}

func (i *ICoreWebView2Controller) RemoveAcceleratorKeyPressed(token EventRegistrationToken) error {
	if i == nil {
		return nil
	}
	// EventRegistrationToken is an 8-byte value and is passed directly in the
	// x64 ABI, not as a pointer to a Go stack value.
	return callHRESULT(
		unsafe.Pointer(i),
		20,
		"ICoreWebView2Controller.remove_AcceleratorKeyPressed",
		uintptr(token.Value),
	)
}

func (i *ICoreWebView2Controller) Close() error {
	if i == nil {
		return nil
	}
	return callHRESULT(unsafe.Pointer(i), 24, "ICoreWebView2Controller.Close")
}

func (i *ICoreWebView2Controller) GetCoreWebView2() (*ICoreWebView2, error) {
	if i == nil {
		return nil, fmt.Errorf("get CoreWebView2: nil controller")
	}
	var result *ICoreWebView2
	if err := callHRESULT(unsafe.Pointer(i), 25, "ICoreWebView2Controller.get_CoreWebView2", uintptr(unsafe.Pointer(&result))); err != nil {
		return nil, err
	}
	if result == nil {
		return nil, fmt.Errorf("ICoreWebView2Controller.get_CoreWebView2 returned nil")
	}
	return result, nil
}

// ICoreWebView2 is the browser surface.
type ICoreWebView2 struct {
	Vtbl *IUnknownVtbl
}

func (i *ICoreWebView2) GetSettings() (*ICoreWebView2Settings, error) {
	if i == nil {
		return nil, fmt.Errorf("get settings: nil CoreWebView2")
	}
	var result *ICoreWebView2Settings
	if err := callHRESULT(unsafe.Pointer(i), 3, "ICoreWebView2.get_Settings", uintptr(unsafe.Pointer(&result))); err != nil {
		return nil, err
	}
	if result == nil {
		return nil, fmt.Errorf("ICoreWebView2.get_Settings returned nil")
	}
	return result, nil
}

func (i *ICoreWebView2) Navigate(uri string) error {
	if i == nil {
		return fmt.Errorf("navigate: nil CoreWebView2")
	}
	value, err := windows.UTF16PtrFromString(uri)
	if err != nil {
		return err
	}
	return callHRESULT(unsafe.Pointer(i), 5, "ICoreWebView2.Navigate", uintptr(unsafe.Pointer(value)))
}

// ExecuteScript evaluates JavaScript in the current top-level document. The
// completion callback receives WebView2's JSON-encoded result verbatim.
func (i *ICoreWebView2) ExecuteScript(script string, handler *ICoreWebView2ExecuteScriptCompletedHandler) error {
	if i == nil || handler == nil {
		return fmt.Errorf("execute script: nil CoreWebView2 or completion handler")
	}
	value, err := windows.UTF16PtrFromString(script)
	if err != nil {
		return err
	}
	return callHRESULT(
		unsafe.Pointer(i),
		29,
		"ICoreWebView2.ExecuteScript",
		uintptr(unsafe.Pointer(value)),
		uintptr(unsafe.Pointer(handler)),
	)
}

func (i *ICoreWebView2) Stop() error {
	if i == nil {
		return nil
	}
	return callHRESULT(unsafe.Pointer(i), 43, "ICoreWebView2.Stop")
}

func (i *ICoreWebView2) AddNavigationStarting(handler *ICoreWebView2NavigationStartingEventHandler) (EventRegistrationToken, error) {
	return i.addEvent(7, "ICoreWebView2.add_NavigationStarting", unsafe.Pointer(handler))
}

func (i *ICoreWebView2) RemoveNavigationStarting(token EventRegistrationToken) error {
	return i.removeEvent(8, "ICoreWebView2.remove_NavigationStarting", token)
}

func (i *ICoreWebView2) AddPermissionRequested(handler *ICoreWebView2PermissionRequestedEventHandler) (EventRegistrationToken, error) {
	return i.addEvent(23, "ICoreWebView2.add_PermissionRequested", unsafe.Pointer(handler))
}

func (i *ICoreWebView2) RemovePermissionRequested(token EventRegistrationToken) error {
	return i.removeEvent(24, "ICoreWebView2.remove_PermissionRequested", token)
}

func (i *ICoreWebView2) AddNewWindowRequested(handler *ICoreWebView2NewWindowRequestedEventHandler) (EventRegistrationToken, error) {
	return i.addEvent(44, "ICoreWebView2.add_NewWindowRequested", unsafe.Pointer(handler))
}

func (i *ICoreWebView2) RemoveNewWindowRequested(token EventRegistrationToken) error {
	return i.removeEvent(45, "ICoreWebView2.remove_NewWindowRequested", token)
}

func (i *ICoreWebView2) addEvent(index uintptr, operation string, handler unsafe.Pointer) (EventRegistrationToken, error) {
	if i == nil || handler == nil {
		return EventRegistrationToken{}, fmt.Errorf("%s: nil CoreWebView2 or handler", operation)
	}
	var token EventRegistrationToken
	if err := callHRESULT(unsafe.Pointer(i), index, operation, uintptr(handler), uintptr(unsafe.Pointer(&token))); err != nil {
		return EventRegistrationToken{}, err
	}
	return token, nil
}

func (i *ICoreWebView2) removeEvent(index uintptr, operation string, token EventRegistrationToken) error {
	if i == nil {
		return nil
	}
	// EventRegistrationToken is an 8-byte value and is passed directly in the
	// x64 ABI, not as a pointer to a Go stack value.
	return callHRESULT(unsafe.Pointer(i), index, operation, uintptr(token.Value))
}

// GetICoreWebView2Settings4 probes the extension interface exposed by the
// settings COM object. A nil result means the installed runtime does not
// expose the required password/autofill capability.
func (i *ICoreWebView2Settings) GetICoreWebView2Settings4() *ICoreWebView2Settings4 {
	if i == nil {
		return nil
	}
	var result *ICoreWebView2Settings4
	hr, err := callCOM(
		unsafe.Pointer(i),
		0,
		uintptr(unsafe.Pointer(&iidCoreWebView2Settings4)),
		uintptr(unsafe.Pointer(&result)),
	)
	if err != nil {
		if _, isLastError := err.(syscall.Errno); !isLastError {
			return nil
		}
	}
	if int32(uint32(hr)) < 0 {
		return nil
	}
	return result
}

// ICoreWebView2Settings contains the public security switches applied to a
// newly created CoreWebView2 instance.
type ICoreWebView2Settings struct {
	Vtbl *IUnknownVtbl
}

func (i *ICoreWebView2Settings) GetIsWebMessageEnabled() (bool, error) {
	return getBool(unsafe.Pointer(i), 5, "ICoreWebView2Settings.get_IsWebMessageEnabled")
}

func (i *ICoreWebView2Settings) PutIsWebMessageEnabled(value bool) error {
	return putBool(unsafe.Pointer(i), 6, "ICoreWebView2Settings.put_IsWebMessageEnabled", value)
}

func (i *ICoreWebView2Settings) GetAreDefaultScriptDialogsEnabled() (bool, error) {
	return getBool(unsafe.Pointer(i), 7, "ICoreWebView2Settings.get_AreDefaultScriptDialogsEnabled")
}

func (i *ICoreWebView2Settings) PutAreDefaultScriptDialogsEnabled(value bool) error {
	return putBool(unsafe.Pointer(i), 8, "ICoreWebView2Settings.put_AreDefaultScriptDialogsEnabled", value)
}

func (i *ICoreWebView2Settings) GetIsStatusBarEnabled() (bool, error) {
	return getBool(unsafe.Pointer(i), 9, "ICoreWebView2Settings.get_IsStatusBarEnabled")
}

func (i *ICoreWebView2Settings) PutIsStatusBarEnabled(value bool) error {
	return putBool(unsafe.Pointer(i), 10, "ICoreWebView2Settings.put_IsStatusBarEnabled", value)
}

func (i *ICoreWebView2Settings) GetAreDevToolsEnabled() (bool, error) {
	return getBool(unsafe.Pointer(i), 11, "ICoreWebView2Settings.get_AreDevToolsEnabled")
}

func (i *ICoreWebView2Settings) PutAreDevToolsEnabled(value bool) error {
	return putBool(unsafe.Pointer(i), 12, "ICoreWebView2Settings.put_AreDevToolsEnabled", value)
}

func (i *ICoreWebView2Settings) GetAreDefaultContextMenusEnabled() (bool, error) {
	return getBool(unsafe.Pointer(i), 13, "ICoreWebView2Settings.get_AreDefaultContextMenusEnabled")
}

func (i *ICoreWebView2Settings) PutAreDefaultContextMenusEnabled(value bool) error {
	return putBool(unsafe.Pointer(i), 14, "ICoreWebView2Settings.put_AreDefaultContextMenusEnabled", value)
}

func (i *ICoreWebView2Settings) GetAreHostObjectsAllowed() (bool, error) {
	return getBool(unsafe.Pointer(i), 15, "ICoreWebView2Settings.get_AreHostObjectsAllowed")
}

func (i *ICoreWebView2Settings) PutAreHostObjectsAllowed(value bool) error {
	return putBool(unsafe.Pointer(i), 16, "ICoreWebView2Settings.put_AreHostObjectsAllowed", value)
}

// ICoreWebView2Settings4 exposes password and general autofill controls.
type ICoreWebView2Settings4 struct {
	Vtbl *IUnknownVtbl
}

func (i *ICoreWebView2Settings4) GetIsPasswordAutosaveEnabled() (bool, error) {
	return getBool(unsafe.Pointer(i), 3, "ICoreWebView2Settings4.get_IsPasswordAutosaveEnabled")
}

func (i *ICoreWebView2Settings4) PutIsPasswordAutosaveEnabled(value bool) error {
	return putBool(unsafe.Pointer(i), 4, "ICoreWebView2Settings4.put_IsPasswordAutosaveEnabled", value)
}

func (i *ICoreWebView2Settings4) GetIsGeneralAutofillEnabled() (bool, error) {
	return getBool(unsafe.Pointer(i), 5, "ICoreWebView2Settings4.get_IsGeneralAutofillEnabled")
}

func (i *ICoreWebView2Settings4) PutIsGeneralAutofillEnabled(value bool) error {
	return putBool(unsafe.Pointer(i), 6, "ICoreWebView2Settings4.put_IsGeneralAutofillEnabled", value)
}

type ICoreWebView2PermissionRequestedEventArgs struct {
	Vtbl *IUnknownVtbl
}

func (i *ICoreWebView2PermissionRequestedEventArgs) PutState(value COREWEBVIEW2_PERMISSION_STATE) error {
	if i == nil {
		return fmt.Errorf("set permission state: nil event arguments")
	}
	return callHRESULT(unsafe.Pointer(i), 7, "ICoreWebView2PermissionRequestedEventArgs.put_State", uintptr(uint32(value)))
}

type ICoreWebView2NewWindowRequestedEventArgs struct {
	Vtbl *IUnknownVtbl
}

func (i *ICoreWebView2NewWindowRequestedEventArgs) PutHandled(value bool) error {
	if i == nil {
		return fmt.Errorf("set new-window handled: nil event arguments")
	}
	return putBool(unsafe.Pointer(i), 6, "ICoreWebView2NewWindowRequestedEventArgs.put_Handled", value)
}

type ICoreWebView2NavigationStartingEventArgs struct {
	Vtbl *IUnknownVtbl
}

func (i *ICoreWebView2NavigationStartingEventArgs) GetUri() (string, error) {
	if i == nil {
		return "", fmt.Errorf("get navigation URI: nil event arguments")
	}
	var value *uint16
	if err := callHRESULT(unsafe.Pointer(i), 3, "ICoreWebView2NavigationStartingEventArgs.get_Uri", uintptr(unsafe.Pointer(&value))); err != nil {
		return "", err
	}
	if value == nil {
		return "", fmt.Errorf("ICoreWebView2NavigationStartingEventArgs.get_Uri returned nil")
	}
	defer windows.CoTaskMemFree(unsafe.Pointer(value))
	return windows.UTF16PtrToString(value), nil
}

func (i *ICoreWebView2NavigationStartingEventArgs) PutCancel(value bool) error {
	if i == nil {
		return fmt.Errorf("cancel navigation: nil event arguments")
	}
	return putBool(unsafe.Pointer(i), 8, "ICoreWebView2NavigationStartingEventArgs.put_Cancel", value)
}

// COREWEBVIEW2_KEY_EVENT_KIND matches the stable Win32 WebView2 enum.
type COREWEBVIEW2_KEY_EVENT_KIND uint32

const (
	COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN        COREWEBVIEW2_KEY_EVENT_KIND = 0
	COREWEBVIEW2_KEY_EVENT_KIND_KEY_UP          COREWEBVIEW2_KEY_EVENT_KIND = 1
	COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN COREWEBVIEW2_KEY_EVENT_KIND = 2
	COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_UP   COREWEBVIEW2_KEY_EVENT_KIND = 3
)

// ICoreWebView2AcceleratorKeyPressedEventArgs contains the native accelerator
// event. The host uses it only to reserve Escape as a recovery path from the
// isolated internet surface.
type ICoreWebView2AcceleratorKeyPressedEventArgs struct {
	Vtbl *IUnknownVtbl
}

func (i *ICoreWebView2AcceleratorKeyPressedEventArgs) GetKeyEventKind() (COREWEBVIEW2_KEY_EVENT_KIND, error) {
	if i == nil {
		return 0, errors.New("get accelerator key event kind: nil arguments")
	}
	var result COREWEBVIEW2_KEY_EVENT_KIND
	if err := callHRESULT(
		unsafe.Pointer(i),
		3,
		"ICoreWebView2AcceleratorKeyPressedEventArgs.get_KeyEventKind",
		uintptr(unsafe.Pointer(&result)),
	); err != nil {
		return 0, err
	}
	return result, nil
}

func (i *ICoreWebView2AcceleratorKeyPressedEventArgs) GetVirtualKey() (uint32, error) {
	if i == nil {
		return 0, errors.New("get accelerator virtual key: nil arguments")
	}
	var result uint32
	if err := callHRESULT(
		unsafe.Pointer(i),
		4,
		"ICoreWebView2AcceleratorKeyPressedEventArgs.get_VirtualKey",
		uintptr(unsafe.Pointer(&result)),
	); err != nil {
		return 0, err
	}
	return result, nil
}

func (i *ICoreWebView2AcceleratorKeyPressedEventArgs) PutHandled(value bool) error {
	if i == nil {
		return errors.New("set accelerator handled state: nil arguments")
	}
	return putBool(unsafe.Pointer(i), 8, "ICoreWebView2AcceleratorKeyPressedEventArgs.put_Handled", value)
}

// IUnknownImpl is the callback contract used by WebView2 event handlers.
// It matches the public Go callback shape while the ABI wrapper below keeps
// every Windows callback parameter to a single machine word.
type IUnknownImpl interface {
	QueryInterface(refiid, object uintptr) uintptr
	AddRef() uintptr
	Release() uintptr
}

type ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerImpl interface {
	IUnknownImpl
	CreateCoreWebView2ControllerCompleted(errorCode uintptr, result *ICoreWebView2Controller) uintptr
}

type ICoreWebView2PermissionRequestedEventHandlerImpl interface {
	IUnknownImpl
	PermissionRequested(sender *ICoreWebView2, args *ICoreWebView2PermissionRequestedEventArgs) uintptr
}

type ICoreWebView2NewWindowRequestedEventHandlerImpl interface {
	IUnknownImpl
	NewWindowRequested(sender *ICoreWebView2, args *ICoreWebView2NewWindowRequestedEventArgs) uintptr
}

type ICoreWebView2NavigationStartingEventHandlerImpl interface {
	IUnknownImpl
	NavigationStarting(sender *ICoreWebView2, args *ICoreWebView2NavigationStartingEventArgs) uintptr
}

type ICoreWebView2AcceleratorKeyPressedEventHandlerImpl interface {
	IUnknownImpl
	AcceleratorKeyPressed(sender *ICoreWebView2Controller, args *ICoreWebView2AcceleratorKeyPressedEventArgs) uintptr
}

type ICoreWebView2ExecuteScriptCompletedHandlerImpl interface {
	IUnknownImpl
	ExecuteScriptCompleted(errorCode uintptr, result *uint16) uintptr
}

type callbackVtbl struct {
	QueryInterface uintptr
	AddRef         uintptr
	Release        uintptr
	Invoke         uintptr
}

type ICoreWebView2ExecuteScriptCompletedHandler struct {
	Vtbl *callbackVtbl
	impl ICoreWebView2ExecuteScriptCompletedHandlerImpl
}

var executeScriptCompletedVTable = callbackVtbl{
	QueryInterface: windows.NewCallback(executeScriptCompletedQueryInterface),
	AddRef:         windows.NewCallback(executeScriptCompletedAddRef),
	Release:        windows.NewCallback(executeScriptCompletedRelease),
	Invoke:         windows.NewCallback(executeScriptCompletedInvoke),
}

func NewICoreWebView2ExecuteScriptCompletedHandler(impl ICoreWebView2ExecuteScriptCompletedHandlerImpl) *ICoreWebView2ExecuteScriptCompletedHandler {
	return &ICoreWebView2ExecuteScriptCompletedHandler{Vtbl: &executeScriptCompletedVTable, impl: impl}
}

func executeScriptCompletedQueryInterface(this unsafe.Pointer, riid *windows.GUID, output *uintptr) uintptr {
	return callbackQueryInterface(this, riid, output)
}

func executeScriptCompletedAddRef(this unsafe.Pointer) uintptr {
	handler := (*ICoreWebView2ExecuteScriptCompletedHandler)(this)
	if handler == nil || handler.impl == nil {
		return 1
	}
	return handler.impl.AddRef()
}

func executeScriptCompletedRelease(this unsafe.Pointer) uintptr {
	handler := (*ICoreWebView2ExecuteScriptCompletedHandler)(this)
	if handler == nil || handler.impl == nil {
		return 1
	}
	return handler.impl.Release()
}

func executeScriptCompletedInvoke(this unsafe.Pointer, errorCode uintptr, result *uint16) uintptr {
	handler := (*ICoreWebView2ExecuteScriptCompletedHandler)(this)
	if handler == nil || handler.impl == nil {
		return eFail
	}
	return handler.impl.ExecuteScriptCompleted(errorCode, result)
}

// QueryInterface returns the callback itself. WebView2 only queries the
// event interface supplied to registration (or IUnknown); returning this COM
// view prevents a null-success response and keeps the callback rooted by Host.
func callbackQueryInterface(this unsafe.Pointer, _ *windows.GUID, output *uintptr) uintptr {
	if output == nil {
		return eFail
	}
	*output = uintptr(this)
	return sOK
}

type ICoreWebView2CreateCoreWebView2ControllerCompletedHandler struct {
	Vtbl *callbackVtbl
	impl ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerImpl
}

var controllerCompletedVTable = callbackVtbl{
	QueryInterface: windows.NewCallback(controllerCompletedQueryInterface),
	AddRef:         windows.NewCallback(controllerCompletedAddRef),
	Release:        windows.NewCallback(controllerCompletedRelease),
	Invoke:         windows.NewCallback(controllerCompletedInvoke),
}

func NewICoreWebView2CreateCoreWebView2ControllerCompletedHandler(impl ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerImpl) *ICoreWebView2CreateCoreWebView2ControllerCompletedHandler {
	return &ICoreWebView2CreateCoreWebView2ControllerCompletedHandler{Vtbl: &controllerCompletedVTable, impl: impl}
}

func controllerCompletedQueryInterface(this unsafe.Pointer, riid *windows.GUID, output *uintptr) uintptr {
	return callbackQueryInterface(this, riid, output)
}

func controllerCompletedAddRef(this unsafe.Pointer) uintptr {
	handler := (*ICoreWebView2CreateCoreWebView2ControllerCompletedHandler)(this)
	if handler == nil || handler.impl == nil {
		return 1
	}
	return handler.impl.AddRef()
}

func controllerCompletedRelease(this unsafe.Pointer) uintptr {
	handler := (*ICoreWebView2CreateCoreWebView2ControllerCompletedHandler)(this)
	if handler == nil || handler.impl == nil {
		return 1
	}
	return handler.impl.Release()
}

func controllerCompletedInvoke(this unsafe.Pointer, errorCode uintptr, result *ICoreWebView2Controller) uintptr {
	handler := (*ICoreWebView2CreateCoreWebView2ControllerCompletedHandler)(this)
	if handler == nil || handler.impl == nil {
		return eFail
	}
	return handler.impl.CreateCoreWebView2ControllerCompleted(errorCode, result)
}

type ICoreWebView2PermissionRequestedEventHandler struct {
	Vtbl *callbackVtbl
	impl ICoreWebView2PermissionRequestedEventHandlerImpl
}

var permissionRequestedVTable = callbackVtbl{
	QueryInterface: windows.NewCallback(permissionRequestedQueryInterface),
	AddRef:         windows.NewCallback(permissionRequestedAddRef),
	Release:        windows.NewCallback(permissionRequestedRelease),
	Invoke:         windows.NewCallback(permissionRequestedInvoke),
}

func NewICoreWebView2PermissionRequestedEventHandler(impl ICoreWebView2PermissionRequestedEventHandlerImpl) *ICoreWebView2PermissionRequestedEventHandler {
	return &ICoreWebView2PermissionRequestedEventHandler{Vtbl: &permissionRequestedVTable, impl: impl}
}

func permissionRequestedQueryInterface(this unsafe.Pointer, riid *windows.GUID, output *uintptr) uintptr {
	return callbackQueryInterface(this, riid, output)
}

func permissionRequestedAddRef(this unsafe.Pointer) uintptr {
	handler := (*ICoreWebView2PermissionRequestedEventHandler)(this)
	if handler == nil || handler.impl == nil {
		return 1
	}
	return handler.impl.AddRef()
}

func permissionRequestedRelease(this unsafe.Pointer) uintptr {
	handler := (*ICoreWebView2PermissionRequestedEventHandler)(this)
	if handler == nil || handler.impl == nil {
		return 1
	}
	return handler.impl.Release()
}

func permissionRequestedInvoke(this unsafe.Pointer, sender *ICoreWebView2, args *ICoreWebView2PermissionRequestedEventArgs) uintptr {
	handler := (*ICoreWebView2PermissionRequestedEventHandler)(this)
	if handler == nil || handler.impl == nil {
		return eFail
	}
	return handler.impl.PermissionRequested(sender, args)
}

type ICoreWebView2NewWindowRequestedEventHandler struct {
	Vtbl *callbackVtbl
	impl ICoreWebView2NewWindowRequestedEventHandlerImpl
}

var newWindowRequestedVTable = callbackVtbl{
	QueryInterface: windows.NewCallback(newWindowRequestedQueryInterface),
	AddRef:         windows.NewCallback(newWindowRequestedAddRef),
	Release:        windows.NewCallback(newWindowRequestedRelease),
	Invoke:         windows.NewCallback(newWindowRequestedInvoke),
}

func NewICoreWebView2NewWindowRequestedEventHandler(impl ICoreWebView2NewWindowRequestedEventHandlerImpl) *ICoreWebView2NewWindowRequestedEventHandler {
	return &ICoreWebView2NewWindowRequestedEventHandler{Vtbl: &newWindowRequestedVTable, impl: impl}
}

func newWindowRequestedQueryInterface(this unsafe.Pointer, riid *windows.GUID, output *uintptr) uintptr {
	return callbackQueryInterface(this, riid, output)
}

func newWindowRequestedAddRef(this unsafe.Pointer) uintptr {
	handler := (*ICoreWebView2NewWindowRequestedEventHandler)(this)
	if handler == nil || handler.impl == nil {
		return 1
	}
	return handler.impl.AddRef()
}

func newWindowRequestedRelease(this unsafe.Pointer) uintptr {
	handler := (*ICoreWebView2NewWindowRequestedEventHandler)(this)
	if handler == nil || handler.impl == nil {
		return 1
	}
	return handler.impl.Release()
}

func newWindowRequestedInvoke(this unsafe.Pointer, sender *ICoreWebView2, args *ICoreWebView2NewWindowRequestedEventArgs) uintptr {
	handler := (*ICoreWebView2NewWindowRequestedEventHandler)(this)
	if handler == nil || handler.impl == nil {
		return eFail
	}
	return handler.impl.NewWindowRequested(sender, args)
}

type ICoreWebView2NavigationStartingEventHandler struct {
	Vtbl *callbackVtbl
	impl ICoreWebView2NavigationStartingEventHandlerImpl
}

var navigationStartingVTable = callbackVtbl{
	QueryInterface: windows.NewCallback(navigationStartingQueryInterface),
	AddRef:         windows.NewCallback(navigationStartingAddRef),
	Release:        windows.NewCallback(navigationStartingRelease),
	Invoke:         windows.NewCallback(navigationStartingInvoke),
}

func NewICoreWebView2NavigationStartingEventHandler(impl ICoreWebView2NavigationStartingEventHandlerImpl) *ICoreWebView2NavigationStartingEventHandler {
	return &ICoreWebView2NavigationStartingEventHandler{Vtbl: &navigationStartingVTable, impl: impl}
}

func navigationStartingQueryInterface(this unsafe.Pointer, riid *windows.GUID, output *uintptr) uintptr {
	return callbackQueryInterface(this, riid, output)
}

func navigationStartingAddRef(this unsafe.Pointer) uintptr {
	handler := (*ICoreWebView2NavigationStartingEventHandler)(this)
	if handler == nil || handler.impl == nil {
		return 1
	}
	return handler.impl.AddRef()
}

func navigationStartingRelease(this unsafe.Pointer) uintptr {
	handler := (*ICoreWebView2NavigationStartingEventHandler)(this)
	if handler == nil || handler.impl == nil {
		return 1
	}
	return handler.impl.Release()
}

func navigationStartingInvoke(this unsafe.Pointer, sender *ICoreWebView2, args *ICoreWebView2NavigationStartingEventArgs) uintptr {
	handler := (*ICoreWebView2NavigationStartingEventHandler)(this)
	if handler == nil || handler.impl == nil {
		return eFail
	}
	return handler.impl.NavigationStarting(sender, args)
}

type ICoreWebView2AcceleratorKeyPressedEventHandler struct {
	Vtbl *callbackVtbl
	impl ICoreWebView2AcceleratorKeyPressedEventHandlerImpl
}

var acceleratorKeyPressedVTable = callbackVtbl{
	QueryInterface: windows.NewCallback(acceleratorKeyPressedQueryInterface),
	AddRef:         windows.NewCallback(acceleratorKeyPressedAddRef),
	Release:        windows.NewCallback(acceleratorKeyPressedRelease),
	Invoke:         windows.NewCallback(acceleratorKeyPressedInvoke),
}

func NewICoreWebView2AcceleratorKeyPressedEventHandler(impl ICoreWebView2AcceleratorKeyPressedEventHandlerImpl) *ICoreWebView2AcceleratorKeyPressedEventHandler {
	return &ICoreWebView2AcceleratorKeyPressedEventHandler{Vtbl: &acceleratorKeyPressedVTable, impl: impl}
}

func acceleratorKeyPressedQueryInterface(this unsafe.Pointer, riid *windows.GUID, output *uintptr) uintptr {
	return callbackQueryInterface(this, riid, output)
}

func acceleratorKeyPressedAddRef(this unsafe.Pointer) uintptr {
	handler := (*ICoreWebView2AcceleratorKeyPressedEventHandler)(this)
	if handler == nil || handler.impl == nil {
		return 1
	}
	return handler.impl.AddRef()
}

func acceleratorKeyPressedRelease(this unsafe.Pointer) uintptr {
	handler := (*ICoreWebView2AcceleratorKeyPressedEventHandler)(this)
	if handler == nil || handler.impl == nil {
		return 1
	}
	return handler.impl.Release()
}

func acceleratorKeyPressedInvoke(this unsafe.Pointer, sender *ICoreWebView2Controller, args *ICoreWebView2AcceleratorKeyPressedEventArgs) uintptr {
	handler := (*ICoreWebView2AcceleratorKeyPressedEventHandler)(this)
	if handler == nil || handler.impl == nil {
		return eFail
	}
	return handler.impl.AcceleratorKeyPressed(sender, args)
}

var iidCoreWebView2Settings4 = windows.GUID{
	Data1: 0xcb56846c,
	Data2: 0x4168,
	Data3: 0x4d53,
	Data4: [8]byte{0xb0, 0x4f, 0x03, 0xb6, 0xd6, 0x79, 0x6f, 0xf2},
}
