package appdata

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPendingInternetProfileResetDeletesOnlyInternetProfile(t *testing.T) {
	root := t.TempDir()
	paths := Paths{
		Root:               root,
		ShellProfile:       filepath.Join(root, "webview2", "shell"),
		InternetProfile:    filepath.Join(root, "webview2", "internet"),
		ProfileResetMarker: filepath.Join(root, "reset-internet-profile.pending"),
	}
	for _, directory := range []string{paths.ShellProfile, paths.InternetProfile} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	shellState := filepath.Join(paths.ShellProfile, "shell-state")
	internetState := filepath.Join(paths.InternetProfile, "cookies")
	database := filepath.Join(root, "aetherops.db")
	for path, data := range map[string][]byte{
		shellState:    []byte("preserve shell"),
		internetState: []byte("remove internet"),
		database:      []byte("preserve database"),
	} {
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := ScheduleInternetProfileReset(paths); err != nil {
		t.Fatal(err)
	}
	if err := ScheduleInternetProfileReset(paths); err != nil {
		t.Fatalf("idempotent schedule failed: %v", err)
	}
	applied, err := ApplyPendingInternetProfileReset(paths)
	if err != nil || !applied {
		t.Fatalf("apply reset = %v, %v", applied, err)
	}
	if _, err := os.Stat(internetState); !os.IsNotExist(err) {
		t.Fatalf("internet profile state survived reset: %v", err)
	}
	for _, path := range []string{shellState, database} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("unrelated AetherOps data %q was changed: %v", path, err)
		}
	}
	if _, err := os.Stat(paths.InternetProfile); err != nil {
		t.Fatalf("internet profile was not recreated: %v", err)
	}
	if _, err := os.Stat(paths.ProfileResetMarker); !os.IsNotExist(err) {
		t.Fatalf("applied reset marker still exists: %v", err)
	}
}

func TestPendingInternetProfileResetFailsClosedForBroadTarget(t *testing.T) {
	root := t.TempDir()
	keep := filepath.Join(root, "keep.txt")
	if err := os.WriteFile(keep, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	paths := Paths{
		Root:               root,
		InternetProfile:    root,
		ProfileResetMarker: filepath.Join(root, "reset-internet-profile.pending"),
	}
	if err := ScheduleInternetProfileReset(paths); err == nil {
		t.Fatal("broad profile reset target was accepted")
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("broad target validation changed data: %v", err)
	}
}

func TestPendingInternetProfileResetRejectsCorruptMarker(t *testing.T) {
	root := t.TempDir()
	paths := Paths{
		Root:               root,
		InternetProfile:    filepath.Join(root, "webview2", "internet"),
		ProfileResetMarker: filepath.Join(root, "reset-internet-profile.pending"),
	}
	if err := os.MkdirAll(paths.InternetProfile, 0o700); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(paths.InternetProfile, "keep")
	if err := os.WriteFile(keep, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.ProfileResetMarker, []byte("unexpected"), 0o600); err != nil {
		t.Fatal(err)
	}
	if applied, err := ApplyPendingInternetProfileReset(paths); err == nil || applied {
		t.Fatalf("corrupt marker apply = %v, %v", applied, err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("corrupt marker changed profile: %v", err)
	}
}
