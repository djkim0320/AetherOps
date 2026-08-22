package appdata

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveIgnoresLegacyDevelopmentOverrides(t *testing.T) {
	local := t.TempDir()
	root := filepath.Join(t.TempDir(), "isolated")
	t.Setenv("LOCALAPPDATA", local)
	t.Setenv("AETHEROPS_DEV", "1")
	t.Setenv("AETHEROPS_DATA_DIR", root)
	paths, err := Resolve()
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(local, "AetherOps", "v2")
	if paths.Root != want {
		t.Fatalf("root = %s, want %s", paths.Root, want)
	}
	if paths.CodexHome == os.Getenv("CODEX_HOME") {
		t.Fatal("AetherOps resolved the user's existing CODEX_HOME")
	}
	for _, directory := range []string{paths.CodexHome, paths.ShellProfile, paths.InternetProfile, paths.Downloads} {
		info, err := os.Stat(directory)
		if err != nil || !info.IsDir() {
			t.Fatalf("directory %s: %v", directory, err)
		}
	}
}

func TestResolveIsolatedClaimsEmptyRootAndReopensOnlyOwnedRoot(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Skip("host evidence requires a non-reparse local Windows temporary root")
	}
	t.Setenv("LOCALAPPDATA", t.TempDir())
	root := filepath.Join(t.TempDir(), "isolated")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	first, err := ResolveIsolated(root)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ResolveIsolated(root)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || first.Root != root {
		t.Fatalf("isolated layouts differ: first=%+v second=%+v", first, second)
	}
	unowned := filepath.Join(t.TempDir(), "unowned")
	if err := os.Mkdir(unowned, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(unowned, "foreign.txt"), []byte("foreign"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveIsolated(unowned); err == nil {
		t.Fatal("non-empty unowned isolated root was accepted")
	}
}

func TestResolveIsolatedRejectsProductionTree(t *testing.T) {
	local := t.TempDir()
	t.Setenv("LOCALAPPDATA", local)
	root := filepath.Join(local, "AetherOps", "v2", "nested")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveIsolated(root); err == nil {
		t.Fatal("production data tree was accepted as isolated root")
	}
}
