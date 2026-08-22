package appdata

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPendingInternetProfileResetRecoversWhenPriorProcessExitedAfterRemoval(t *testing.T) {
	root := t.TempDir()
	paths := Paths{
		Root:               root,
		InternetProfile:    filepath.Join(root, "webview2", "internet"),
		ProfileResetMarker: filepath.Join(root, "reset-internet-profile.pending"),
	}
	if err := os.MkdirAll(paths.InternetProfile, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := ScheduleInternetProfileReset(paths); err != nil {
		t.Fatal(err)
	}

	// This is the durable on-disk state left by a process that exits between
	// ApplyPendingInternetProfileReset's RemoveAll and MkdirAll boundaries.
	if err := os.RemoveAll(paths.InternetProfile); err != nil {
		t.Fatal(err)
	}

	applied, err := ApplyPendingInternetProfileReset(paths)
	if err != nil || !applied {
		t.Fatalf("resume interrupted profile reset = %v, %v", applied, err)
	}
	info, err := os.Lstat(paths.InternetProfile)
	if err != nil {
		t.Fatalf("recreated internet profile: %v", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("recreated internet profile is not a regular directory: %v", info.Mode())
	}
	if _, err := os.Stat(paths.ProfileResetMarker); !os.IsNotExist(err) {
		t.Fatalf("completed reset marker still exists: %v", err)
	}
}

func TestPendingInternetProfileResetRejectsDanglingProfileSymlink(t *testing.T) {
	root := t.TempDir()
	paths := Paths{
		Root:               root,
		InternetProfile:    filepath.Join(root, "webview2", "internet"),
		ProfileResetMarker: filepath.Join(root, "reset-internet-profile.pending"),
	}
	if err := os.MkdirAll(filepath.Dir(paths.InternetProfile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "missing-target"), paths.InternetProfile); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	if err := ScheduleInternetProfileReset(paths); err != nil {
		t.Fatal(err)
	}
	if applied, err := ApplyPendingInternetProfileReset(paths); err == nil || applied {
		t.Fatalf("dangling profile symlink apply = %v, %v", applied, err)
	}
	if info, err := os.Lstat(paths.InternetProfile); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("rejected dangling symlink was changed: mode=%v err=%v", info.Mode(), err)
	}
}
