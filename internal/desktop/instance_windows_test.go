//go:build windows && amd64

package desktop

import (
	"fmt"
	"runtime"
	"testing"
	"time"
)

func TestInstanceLeaseSerializesStartupBeforeWindowCreation(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	applicationID := fmt.Sprintf("AetherOps.Instance.Test.%d", time.Now().UnixNano())
	first, primary, err := AcquireInstanceLease(applicationID)
	if err != nil || !primary || first == nil {
		t.Fatalf("first lease = %v, primary=%t, err=%v", first, primary, err)
	}
	second, primary, err := AcquireInstanceLease(applicationID)
	if err != nil || primary || second != nil {
		t.Fatalf("second lease = %v, primary=%t, err=%v", second, primary, err)
	}
	closed := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		closed <- first.Close()
	}()
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
	third, primary, err := AcquireInstanceLease(applicationID)
	if err != nil || !primary || third == nil {
		t.Fatalf("third lease = %v, primary=%t, err=%v", third, primary, err)
	}
	if err := third.Close(); err != nil {
		t.Fatal(err)
	}
}
