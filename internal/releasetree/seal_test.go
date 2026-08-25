package releasetree

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestComputeIsDeterministicAndBindsOnlyReleaseSources(t *testing.T) {
	root := newReleaseTreeFixture(t)
	writeReleaseTreeFile(t, root, filepath.Join("internal", "core", "contract.go"), "package core\n")
	writeReleaseTreeFile(t, root, filepath.Join("frontend", "src", "main.tsx"), "export const app = true;\n")
	writeReleaseTreeFile(t, root, filepath.Join("frontend", "node_modules", "ignored.js"), "dependency cache\n")
	writeReleaseTreeFile(t, root, filepath.Join("build", "aetherops.exe"), "build output\n")

	first, err := Compute(root)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Compute(root)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || len(first.SHA256) != 64 || first.FileCount < len(rootFiles)+2 {
		t.Fatalf("nondeterministic or incomplete source seal: first=%+v second=%+v", first, second)
	}

	writeReleaseTreeFile(t, root, filepath.Join("build", "aetherops.exe"), "different build output\n")
	writeReleaseTreeFile(t, root, filepath.Join("frontend", "node_modules", "ignored.js"), "different dependency cache\n")
	ignored, err := Compute(root)
	if err != nil {
		t.Fatal(err)
	}
	if ignored != first {
		t.Fatalf("excluded build/cache files changed source seal: before=%+v after=%+v", first, ignored)
	}

	writeReleaseTreeFile(t, root, filepath.Join("internal", "core", "contract.go"), "package core\n\nconst Version = 2\n")
	changed, err := Compute(root)
	if err != nil {
		t.Fatal(err)
	}
	if changed.SHA256 == first.SHA256 || changed.FileCount != first.FileCount {
		t.Fatalf("included source mutation was not bound correctly: before=%+v after=%+v", first, changed)
	}
}

func TestComputeRejectsMissingRequiredSourceAndOversizedFile(t *testing.T) {
	root := newReleaseTreeFixture(t)
	if err := os.Remove(filepath.Join(root, "go.mod")); err != nil {
		t.Fatal(err)
	}
	if _, err := Compute(root); err == nil || !strings.Contains(err.Error(), "required release source go.mod") {
		t.Fatalf("missing required source was accepted: %v", err)
	}

	root = newReleaseTreeFixture(t)
	oversized := filepath.Join(root, "internal", "oversized.bin")
	file, err := os.OpenFile(oversized, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(MaxFileBytes + 1); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := Compute(root); err == nil || !strings.Contains(err.Error(), "not a bounded regular file") {
		t.Fatalf("oversized release source was accepted: %v", err)
	}
}

func newReleaseTreeFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for name := range rootFiles {
		value := name + "\n"
		if name == "go.mod" {
			value = "module github.com/djkim0320/AetherOps\n"
		}
		writeReleaseTreeFile(t, root, name, value)
	}
	for name := range rootDirectories {
		if err := os.MkdirAll(filepath.Join(root, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func writeReleaseTreeFile(t *testing.T, root, name, value string) {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
		t.Fatal(err)
	}
}
