package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleaseCandidateDiagnosticContractRejectsDevelopmentMode(t *testing.T) {
	valid := releaseCandidateDiagnostic{
		Schema: "aetherops_runtime_update_trust_v2", Configured: true, KeyID: "release-key",
		FeedURLSHA256: strings.Repeat("a", 64), PublicKeySHA256: strings.Repeat("b", 64), BuildMode: "release",
	}
	if err := validateReleaseCandidateDiagnostic(valid); err != nil {
		t.Fatalf("valid release diagnostic rejected: %v", err)
	}
	valid.BuildMode = "development"
	if err := validateReleaseCandidateDiagnostic(valid); err == nil {
		t.Fatal("development diagnostic qualified for release ledger preparation")
	}
}

func TestBindCandidateDerivesOnlySiblingProductInputs(t *testing.T) {
	root, executable := candidateFixture(t)
	binding, err := bindCandidate(executable)
	if err != nil {
		t.Fatal(err)
	}
	if binding.Executable != executable || binding.RuntimeManifest != filepath.Join(root, "runtime-manifest.json") ||
		binding.Sidecar != filepath.Join(root, "knowledge-sidecar", "index.cjs") {
		t.Fatalf("candidate inputs were not derived from the executable: %+v", binding)
	}
	if binding.Build.IsZero() {
		t.Fatal("candidate product binding is empty")
	}
}

func TestReleasegateCLIRejectsLegacyIndependentInputFlags(t *testing.T) {
	if err := run([]string{"-runtime-manifest", "elsewhere.json"}); err == nil || !strings.Contains(err.Error(), "flag provided but not defined") {
		t.Fatalf("legacy Frankenstein-build flag was accepted: %v", err)
	}
	if err := run([]string{"-knowledge-sidecar", "elsewhere.cjs"}); err == nil || !strings.Contains(err.Error(), "flag provided but not defined") {
		t.Fatalf("legacy independent sidecar flag was accepted: %v", err)
	}
}

func TestReauthenticateCandidateDetectsMutation(t *testing.T) {
	root, executable := candidateFixture(t)
	binding, err := bindCandidate(executable)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "knowledge-sidecar", "protocol.cjs"), []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := reauthenticateCandidate(binding); err == nil || !strings.Contains(err.Error(), "changed") {
		t.Fatalf("candidate mutation was accepted: %v", err)
	}
}

func TestBindCandidateRejectsRedirectedSidecarTree(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "aetherops.exe"), []byte("exe"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "runtime-manifest.json"), []byte("manifest"), 0o600); err != nil {
		t.Fatal(err)
	}
	realSidecar := filepath.Join(t.TempDir(), "sidecar")
	if err := os.MkdirAll(realSidecar, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"index.cjs", "protocol.cjs", "worker.cjs"} {
		if err := os.WriteFile(filepath.Join(realSidecar, name), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	redirect := filepath.Join(root, "knowledge-sidecar")
	if err := os.Symlink(realSidecar, redirect); err != nil {
		t.Skipf("directory symlink unavailable on this Windows host: %v", err)
	}
	if _, err := bindCandidate(filepath.Join(root, "aetherops.exe")); err == nil {
		t.Fatal("redirected knowledge-sidecar directory was accepted")
	}
}

func candidateFixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	files := map[string][]byte{
		filepath.Join(root, "aetherops.exe"):                     []byte("candidate executable"),
		filepath.Join(root, "runtime-manifest.json"):             []byte("candidate runtime manifest"),
		filepath.Join(root, "knowledge-sidecar", "index.cjs"):    []byte("index"),
		filepath.Join(root, "knowledge-sidecar", "protocol.cjs"): []byte("protocol"),
		filepath.Join(root, "knowledge-sidecar", "worker.cjs"):   []byte("worker"),
	}
	for path, data := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	executable, err := filepath.Abs(filepath.Join(root, "aetherops.exe"))
	if err != nil {
		t.Fatal(err)
	}
	return root, executable
}
