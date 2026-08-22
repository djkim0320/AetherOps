//go:build windows

package secret

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestWindowsCredentialRoundTrip(t *testing.T) {
	store := NewStore()
	target := fmt.Sprintf("AetherOps/v2/test/%d/%d", os.Getpid(), time.Now().UnixNano())
	value := []byte("temporary-test-secret")
	if err := store.Set(target, value); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Delete(target) })
	got, err := store.Get(target)
	if err != nil {
		t.Fatal(err)
	}
	defer zero(got)
	if !bytes.Equal(got, value) {
		t.Fatal("credential round trip changed the value")
	}
	if err := store.Delete(target); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(target); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete = %v, want ErrNotFound", err)
	}
}
