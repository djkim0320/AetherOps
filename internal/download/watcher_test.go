package download

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/store"
)

func TestStableDownloadIsHashedAndQuarantined(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := store.Open(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(root, "downloads")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "evidence.txt")
	if err := os.WriteFile(path, []byte("downloaded evidence"), 0o600); err != nil {
		t.Fatal(err)
	}
	watcher := &Watcher{Directory: directory, DB: db, CAS: objects}
	states := make(map[string]fileState)
	if err := watcher.scan(ctx, states); err != nil {
		t.Fatal(err)
	}
	if err := watcher.scan(ctx, states); err != nil {
		t.Fatal(err)
	}
	var hash, status string
	if err := db.SQL().QueryRowContext(ctx,
		"SELECT blob_hash, status FROM downloads WHERE file_name = 'evidence.txt'").Scan(&hash, &status); err != nil {
		t.Fatal(err)
	}
	if status != "quarantined" {
		t.Fatalf("download status = %q", status)
	}
	data, err := objects.ReadVerified(hash)
	if err != nil || string(data) != "downloaded evidence" {
		t.Fatalf("CAS download readback = %q, %v", data, err)
	}
}
