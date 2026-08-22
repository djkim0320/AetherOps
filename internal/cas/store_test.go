package cas

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestPutAndReadVerified(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.PutBytes([]byte("aetherops"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.PutBytes([]byte("aetherops"))
	if err != nil {
		t.Fatal(err)
	}
	if first.Hash != second.Hash || first.Path != second.Path {
		t.Fatal("identical bytes must resolve to one CAS object")
	}
	data, err := store.ReadVerified(first.Hash)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "aetherops" {
		t.Fatalf("unexpected data %q", data)
	}
}

func TestCorruptionFailsClosed(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := store.PutBytes([]byte("original"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(receipt.Path, []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReadVerified(receipt.Hash); err == nil {
		t.Fatal("expected readback verification failure")
	}
}

func TestReconcileRemovesOnlyUnregisteredAndTemporaryFiles(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	registered, err := store.PutBytes([]byte("registered"))
	if err != nil {
		t.Fatal(err)
	}
	orphaned, err := store.PutBytes([]byte("orphaned after committed deletion"))
	if err != nil {
		t.Fatal(err)
	}
	temporary := filepath.Join(store.Root(), "tmp", "blob-interrupted")
	if err := os.WriteFile(temporary, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := store.Reconcile(context.Background(), map[string]struct{}{registered.Hash: {}})
	if err != nil {
		t.Fatal(err)
	}
	if result.OrphanedObjectsRemoved != 1 || result.TemporaryFilesRemoved != 1 {
		t.Fatalf("reconcile result = %+v", result)
	}
	if _, err := store.ReadVerified(registered.Hash); err != nil {
		t.Fatalf("registered CAS object was changed: %v", err)
	}
	if _, err := store.Path(orphaned.Hash); !os.IsNotExist(err) {
		t.Fatalf("unregistered CAS object survived: %v", err)
	}
	if _, err := os.Stat(temporary); !os.IsNotExist(err) {
		t.Fatalf("temporary CAS file survived: %v", err)
	}
	if err := store.Delete(orphaned.Hash); err != nil {
		t.Fatalf("already removed CAS deletion is not idempotent: %v", err)
	}
}

func TestReconcileFailsClosedForUnexpectedLayout(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	orphaned, err := store.PutBytes([]byte("must survive refused reconciliation"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(store.Root(), "sha256", "ZZ"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reconcile(context.Background(), map[string]struct{}{}); err == nil {
		t.Fatal("unexpected CAS layout was accepted")
	}
	if _, err := store.ReadVerified(orphaned.Hash); err != nil {
		t.Fatalf("fail-closed reconciliation changed a CAS object: %v", err)
	}
}

func TestOpenReadOnlyPermitsVerifiedReadsAndRejectsMutation(t *testing.T) {
	root := t.TempDir()
	writable, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := writable.PutBytes([]byte("immutable release evidence"))
	if err != nil {
		t.Fatal(err)
	}
	readOnly, err := OpenReadOnly(root)
	if err != nil {
		t.Fatal(err)
	}
	if data, err := readOnly.ReadVerified(receipt.Hash); err != nil || string(data) != "immutable release evidence" {
		t.Fatalf("read-only verified read = %q, %v", data, err)
	}
	if _, err := readOnly.PutBytes([]byte("forbidden")); err == nil {
		t.Fatal("read-only CAS accepted a write")
	}
	if err := readOnly.Delete(receipt.Hash); err == nil {
		t.Fatal("read-only CAS accepted deletion")
	}
	if _, err := readOnly.Reconcile(context.Background(), map[string]struct{}{receipt.Hash: {}}); err == nil {
		t.Fatal("read-only CAS accepted reconciliation")
	}
	if _, err := OpenReadOnly(filepath.Join(t.TempDir(), "missing")); !os.IsNotExist(err) {
		t.Fatalf("missing read-only CAS error = %v", err)
	}
}
