//go:build windows && amd64

package desktop

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"

	"golang.org/x/sys/windows"
)

// InstanceLease keeps a per-user-session named kernel object open. Existence,
// rather than mutex ownership, protects startup recovery and all later CAS
// writers without tying Close to the creating goroutine's Windows thread.
type InstanceLease struct {
	mu     sync.Mutex
	handle windows.Handle
}

func AcquireInstanceLease(applicationID string) (*InstanceLease, bool, error) {
	applicationID = strings.TrimSpace(applicationID)
	if applicationID == "" {
		return nil, false, errors.New("application id is required for the instance lease")
	}
	digest := sha256.Sum256([]byte(applicationID))
	name, err := windows.UTF16PtrFromString("Local\\AetherOps.Instance." + hex.EncodeToString(digest[:16]))
	if err != nil {
		return nil, false, err
	}
	handle, err := windows.CreateMutex(nil, false, name)
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		if handle != 0 {
			_ = windows.CloseHandle(handle)
		}
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("create AetherOps instance mutex: %w", err)
	}
	return &InstanceLease{handle: handle}, true, nil
}

func (lease *InstanceLease) Close() error {
	if lease == nil {
		return nil
	}
	lease.mu.Lock()
	defer lease.mu.Unlock()
	if lease.handle == 0 {
		return nil
	}
	handle := lease.handle
	lease.handle = 0
	return windows.CloseHandle(handle)
}
