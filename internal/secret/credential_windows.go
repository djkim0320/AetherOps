//go:build windows

package secret

import (
	"errors"
	"fmt"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	credentialTypeGeneric         = 1
	credentialPersistLocalMachine = 2
	openAIKeyTarget               = "AetherOps/v2/openai-platform-api-key"
)

var (
	advapi32       = windows.NewLazySystemDLL("advapi32.dll")
	procCredWrite  = advapi32.NewProc("CredWriteW")
	procCredRead   = advapi32.NewProc("CredReadW")
	procCredDelete = advapi32.NewProc("CredDeleteW")
	procCredFree   = advapi32.NewProc("CredFree")

	ErrNotFound = errors.New("credential not found")
)

type windowsCredential struct {
	Flags              uint32
	Type               uint32
	TargetName         *uint16
	Comment            *uint16
	LastWritten        windows.Filetime
	CredentialBlobSize uint32
	CredentialBlob     *byte
	Persist            uint32
	AttributeCount     uint32
	Attributes         uintptr
	TargetAlias        *uint16
	UserName           *uint16
}

type Store struct{}

func NewStore() *Store { return &Store{} }

func (store *Store) SetOpenAIAPIKey(value []byte) error {
	return store.Set(openAIKeyTarget, value)
}

func (store *Store) OpenAIAPIKey() ([]byte, error) {
	return store.Get(openAIKeyTarget)
}

func (store *Store) DeleteOpenAIAPIKey() error {
	return store.Delete(openAIKeyTarget)
}

func (store *Store) Set(target string, value []byte) error {
	if target == "" {
		return errors.New("credential target is required")
	}
	if len(value) == 0 {
		return errors.New("credential value is empty")
	}
	if uint64(len(value)) > uint64(^uint32(0)) {
		return errors.New("credential value is too large")
	}
	targetPointer, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	userPointer, err := windows.UTF16PtrFromString("AetherOps")
	if err != nil {
		return err
	}
	secretCopy := append([]byte(nil), value...)
	defer zero(secretCopy)
	credential := windowsCredential{
		Type:               credentialTypeGeneric,
		TargetName:         targetPointer,
		CredentialBlobSize: uint32(len(secretCopy)),
		CredentialBlob:     &secretCopy[0],
		Persist:            credentialPersistLocalMachine,
		UserName:           userPointer,
	}
	result, _, callErr := procCredWrite.Call(uintptr(unsafe.Pointer(&credential)), 0)
	runtime.KeepAlive(secretCopy)
	if result == 0 {
		return fmt.Errorf("store Windows credential: %w", callErr)
	}
	return nil
}

func (store *Store) Get(target string) ([]byte, error) {
	if target == "" {
		return nil, errors.New("credential target is required")
	}
	targetPointer, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return nil, err
	}
	var credential *windowsCredential
	result, _, callErr := procCredRead.Call(
		uintptr(unsafe.Pointer(targetPointer)),
		credentialTypeGeneric,
		0,
		uintptr(unsafe.Pointer(&credential)),
	)
	if result == 0 {
		if errors.Is(callErr, windows.ERROR_NOT_FOUND) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("read Windows credential: %w", callErr)
	}
	defer procCredFree.Call(uintptr(unsafe.Pointer(credential)))
	if credential == nil || credential.CredentialBlobSize == 0 || credential.CredentialBlob == nil {
		return nil, errors.New("stored Windows credential is empty")
	}
	blob := unsafe.Slice(credential.CredentialBlob, int(credential.CredentialBlobSize))
	return append([]byte(nil), blob...), nil
}

func (store *Store) Delete(target string) error {
	if target == "" {
		return errors.New("credential target is required")
	}
	targetPointer, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	result, _, callErr := procCredDelete.Call(
		uintptr(unsafe.Pointer(targetPointer)),
		credentialTypeGeneric,
		0,
	)
	if result == 0 {
		if errors.Is(callErr, windows.ERROR_NOT_FOUND) {
			return ErrNotFound
		}
		return fmt.Errorf("delete Windows credential: %w", callErr)
	}
	return nil
}

func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
	runtime.KeepAlive(value)
}
