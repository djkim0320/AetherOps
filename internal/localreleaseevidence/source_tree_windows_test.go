//go:build windows

package localreleaseevidence

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSourceTreeSealBindsReleaseSourcesAndIgnoresOutputs(t *testing.T) {
	root := completeSourceSealRoot(t)
	writeSourceSealFile(t, root, "internal/core/value.go", "package core\nconst value = 1\n")
	writeSourceSealFile(t, root, "frontend/src/main.tsx", "export const value = 1;\n")
	writeSourceSealFile(t, root, "tools/dev.ps1", "Write-Host test\n")
	writeSourceSealFile(t, root, "build/ignored.txt", "first\n")
	writeSourceSealFile(t, root, "frontend/node_modules/ignored/index.js", "first\n")

	before, err := sealSourceTree(root)
	if err != nil {
		t.Fatal(err)
	}
	if before.FileCount != len(sourceRootFiles)+3 || len(before.SHA256) != 64 {
		t.Fatalf("unexpected source seal: %+v", before)
	}
	writeSourceSealFile(t, root, "build/ignored.txt", "second\n")
	writeSourceSealFile(t, root, "frontend/node_modules/ignored/index.js", "second\n")
	afterIgnored, err := sealSourceTree(root)
	if err != nil {
		t.Fatal(err)
	}
	if afterIgnored != before {
		t.Fatalf("excluded output changed source seal: before=%+v after=%+v", before, afterIgnored)
	}
	writeSourceSealFile(t, root, "internal/core/value.go", "package core\nconst value = 2\n")
	afterSource, err := sealSourceTree(root)
	if err != nil {
		t.Fatal(err)
	}
	if afterSource.SHA256 == before.SHA256 || afterSource.FileCount != before.FileCount {
		t.Fatalf("source mutation was not sealed: before=%+v after=%+v", before, afterSource)
	}
}

func TestSourceTreeSealRejectsOversizedReleaseSource(t *testing.T) {
	root := completeSourceSealRoot(t)
	path := filepath.Join(root, "internal", "oversized.go")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maximumSourceFileBytes + 1); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := sealSourceTree(root); err == nil {
		t.Fatal("oversized release source was accepted")
	}
}

func TestSourceTreeSealRequiresCompleteReleaseRoot(t *testing.T) {
	root := completeSourceSealRoot(t)
	if err := os.Remove(filepath.Join(root, "THIRD_PARTY_NOTICES.md")); err != nil {
		t.Fatal(err)
	}
	if _, err := sealSourceTree(root); err == nil {
		t.Fatal("incomplete release source root was accepted")
	}
}

func completeSourceSealRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for name := range sourceRootFiles {
		value := name + "\n"
		if name == "go.mod" {
			value = "module github.com/djkim0320/AetherOps\n"
		}
		writeSourceSealFile(t, root, name, value)
	}
	for name := range sourceRootDirectories {
		if err := os.MkdirAll(filepath.Join(root, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func writeSourceSealFile(t *testing.T, root, relative, value string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
		t.Fatal(err)
	}
}
