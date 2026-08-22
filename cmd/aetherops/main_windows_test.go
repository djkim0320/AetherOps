//go:build windows && amd64

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	managedruntime "github.com/djkim0320/Aether-claw/internal/runtime"
)

func TestNativeCodexAppServerCommandUsesVerifiedWindowsPackage(t *testing.T) {
	root := t.TempDir()
	entrypoint := filepath.Join(root, "node_modules", "@openai", "codex", "bin", "codex.js")
	native := filepath.Join(root, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe")
	for path, data := range map[string][]byte{entrypoint: []byte("entrypoint"), native: []byte("native")} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	command, err := nativeCodexAppServerCommand(managedruntime.ProcessPaths{CodexEntrypoint: entrypoint})
	if err != nil {
		t.Fatal(err)
	}
	if command.Path != native || len(command.Args) != 1 || command.Args[0] != "app-server" {
		t.Fatalf("unexpected native Codex command: %#v", command)
	}
}

func TestChromeMCPRejectsUnmanagedEndpoint(t *testing.T) {
	if err := runChromeMCP(context.Background(), []string{"--browser-url=http://192.168.1.5:9222", "--no-usage-statistics"}); err == nil {
		t.Fatal("chrome-mcp accepted a non-loopback browser endpoint")
	}
}

func TestEmbeddedRuntimeTrustDiagnosticUsesOnlyLinkerValuesAndRedactsSecrets(t *testing.T) {
	previousFeed, previousKeyID, previousPublicKey, previousMode := runtimeUpdateFeedURL, runtimeUpdateKeyID, runtimeUpdatePublicKeyBase64, buildMode
	t.Cleanup(func() {
		runtimeUpdateFeedURL, runtimeUpdateKeyID, runtimeUpdatePublicKeyBase64 = previousFeed, previousKeyID, previousPublicKey
		buildMode = previousMode
	})
	feedURL := "https://updates.example.test/aetherops/stable.json"
	publicKeyBytes := bytes.Repeat([]byte{0x2a}, 32)
	publicKey := base64.StdEncoding.EncodeToString(publicKeyBytes)
	runtimeUpdateFeedURL, runtimeUpdateKeyID, runtimeUpdatePublicKeyBase64 = feedURL, "release-key-2026", publicKey
	buildMode = "release"
	t.Setenv("AETHEROPS_DEV", "1")
	t.Setenv("AETHEROPS_RUNTIME_FEED_URL", "https://attacker.invalid/feed.json")
	t.Setenv("AETHEROPS_RUNTIME_KEY_ID", "attacker-key")
	t.Setenv("AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x7f}, 32)))

	diagnostic, err := embeddedRuntimeTrustDiagnostic()
	if err != nil {
		t.Fatal(err)
	}
	feedDigest := sha256.Sum256([]byte(feedURL))
	keyDigest := sha256.Sum256(publicKeyBytes)
	if !diagnostic.Configured || diagnostic.BuildMode != "release" || diagnostic.Schema != "aetherops_runtime_update_trust_v2" ||
		diagnostic.KeyID != "release-key-2026" ||
		diagnostic.FeedURLSHA256 != hex.EncodeToString(feedDigest[:]) ||
		diagnostic.PublicKeySHA256 != hex.EncodeToString(keyDigest[:]) {
		t.Fatalf("unexpected embedded trust diagnostic: %+v", diagnostic)
	}
	var output bytes.Buffer
	if err := writeEmbeddedRuntimeTrustDiagnostic(&output); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), feedURL) || strings.Contains(output.String(), publicKey) ||
		strings.Contains(output.String(), "attacker.invalid") {
		t.Fatalf("runtime trust diagnostic exposed raw trust material: %s", output.String())
	}
}

func TestWorkingDirectoryFallbacksRemainDisabledUnderHostileEnvironment(t *testing.T) {
	working := t.TempDir()
	if err := os.WriteFile(filepath.Join(working, "runtime-manifest.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	sidecar := filepath.Join(working, "tools", "knowledge-sidecar", "index.cjs")
	if err := os.MkdirAll(filepath.Dir(sidecar), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sidecar, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(working); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previous) })
	t.Setenv("AETHEROPS_DEV", "1")
	if path, err := findRuntimeManifest(); err == nil || strings.HasPrefix(strings.ToLower(path), strings.ToLower(working)) {
		t.Fatalf("working-directory runtime manifest fallback remained active: path=%q err=%v", path, err)
	}
	if path, err := findKnowledgeSidecarEntrypoint(); err == nil || strings.HasPrefix(strings.ToLower(path), strings.ToLower(working)) {
		t.Fatalf("working-directory sidecar fallback remained active: path=%q err=%v", path, err)
	}
}

func TestEmbeddedRuntimeTrustDiagnosticRejectsPartialLinkerConfiguration(t *testing.T) {
	previousFeed, previousKeyID, previousPublicKey := runtimeUpdateFeedURL, runtimeUpdateKeyID, runtimeUpdatePublicKeyBase64
	t.Cleanup(func() {
		runtimeUpdateFeedURL, runtimeUpdateKeyID, runtimeUpdatePublicKeyBase64 = previousFeed, previousKeyID, previousPublicKey
	})
	runtimeUpdateFeedURL, runtimeUpdateKeyID, runtimeUpdatePublicKeyBase64 = "https://updates.example.test/feed.json", "", ""
	if _, err := embeddedRuntimeTrustDiagnostic(); err == nil {
		t.Fatal("partial embedded runtime trust was accepted")
	}
	runtimeUpdateFeedURL, runtimeUpdateKeyID, runtimeUpdatePublicKeyBase64 = "", "", ""
	diagnostic, err := embeddedRuntimeTrustDiagnostic()
	if err != nil || diagnostic.Configured {
		t.Fatalf("unconfigured diagnostic = %+v, %v", diagnostic, err)
	}
}

func TestEmbeddedRuntimeTrustDiagnosticRejectsInvalidLinkerValues(t *testing.T) {
	previousFeed, previousKeyID, previousPublicKey := runtimeUpdateFeedURL, runtimeUpdateKeyID, runtimeUpdatePublicKeyBase64
	t.Cleanup(func() {
		runtimeUpdateFeedURL, runtimeUpdateKeyID, runtimeUpdatePublicKeyBase64 = previousFeed, previousKeyID, previousPublicKey
	})
	validKey := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x2a}, 32))
	tests := []struct {
		name      string
		feedURL   string
		keyID     string
		publicKey string
	}{
		{name: "feed whitespace", feedURL: " https://updates.example.test/feed.json", keyID: "release-key", publicKey: validKey},
		{name: "unsafe feed", feedURL: "http://updates.example.test/feed.json", keyID: "release-key", publicKey: validKey},
		{name: "invalid key id", feedURL: "https://updates.example.test/feed.json", keyID: "release key", publicKey: validKey},
		{name: "invalid key bytes", feedURL: "https://updates.example.test/feed.json", keyID: "release-key", publicKey: base64.StdEncoding.EncodeToString([]byte("short"))},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			runtimeUpdateFeedURL, runtimeUpdateKeyID, runtimeUpdatePublicKeyBase64 = test.feedURL, test.keyID, test.publicKey
			if _, err := embeddedRuntimeTrustDiagnostic(); err == nil {
				t.Fatal("invalid embedded runtime trust was accepted")
			}
		})
	}
}
