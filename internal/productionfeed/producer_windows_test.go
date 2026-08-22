//go:build windows

package productionfeed

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/netip"
	"strings"
	"testing"

	managedruntime "github.com/djkim0320/Aether-claw/internal/runtime"
)

func TestProductionRunRejectsMissingJobSupervisionBeforeInputs(t *testing.T) {
	if _, err := Run(context.Background(), Config{}); err == nil || !strings.Contains(err.Error(), "Job Object") {
		t.Fatalf("unsupervised production probe path accepted: %v", err)
	}
}

func TestProductionFeedURLRejectsFixtureAndNonPublicShapes(t *testing.T) {
	for _, raw := range []string{
		"http://updates.example.com/stable.json",
		"https://127.0.0.1/stable.json",
		"https://localhost/stable.json",
		"https://feed.local/stable.json",
		"https://updates.example.com:8443/stable.json",
		"https://user:pass@updates.example.com/stable.json",
		"https://updates.example.com/stable.json#fragment",
		"https://updates.example.com",
	} {
		if err := validateProductionFeedURL(raw); err == nil {
			t.Fatalf("non-production feed URL accepted: %s", raw)
		}
	}
	if err := validateProductionFeedURL("https://updates.example.com/aetherops/stable.json"); err != nil {
		t.Fatalf("canonical production feed URL rejected: %v", err)
	}
}

func TestProductionDialPolicyRejectsReservedAddresses(t *testing.T) {
	for _, raw := range []string{
		"127.0.0.1", "10.0.0.1", "169.254.1.1", "100.64.0.1", "192.0.2.1",
		"198.18.0.1", "198.51.100.1", "203.0.113.1", "fc00::1", "fe80::1", "2001:db8::1",
	} {
		if publicAddress(netip.MustParseAddr(raw)) {
			t.Fatalf("reserved address accepted: %s", raw)
		}
	}
	if !publicAddress(netip.MustParseAddr("1.1.1.1")) || !publicAddress(netip.MustParseAddr("2606:4700:4700::1111")) {
		t.Fatal("known public address rejected")
	}
}

func TestEmbeddedTrustMustExactlyMatchCandidateDiagnostic(t *testing.T) {
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	config := TrustConfig{
		Schema: trustConfigSchemaV1, FeedURL: "https://updates.example.com/aetherops/stable.json",
		KeyID: "release-key-2026", PublicKeyBase64: base64.StdEncoding.EncodeToString(publicKey),
	}
	root, err := managedruntime.ParseTrustRoot(config.KeyID, config.PublicKeyBase64)
	if err != nil {
		t.Fatal(err)
	}
	feedDigest := sha256.Sum256([]byte(config.FeedURL))
	keyDigest := sha256.Sum256(publicKey)
	diagnostic := runtimeTrustDiagnostic{
		Schema: "aetherops_runtime_update_trust_v2", BuildMode: "release", Configured: true, KeyID: config.KeyID,
		FeedURLSHA256: hex.EncodeToString(feedDigest[:]), PublicKeySHA256: hex.EncodeToString(keyDigest[:]),
	}
	observation, err := authenticateEmbeddedTrust(diagnostic, []byte(`{"configured":true}`), config, root)
	if err != nil || observation.KeyID != config.KeyID || observation.DiagnosticOutputSHA256 == "" {
		t.Fatalf("exact embedded trust rejected: %#v, %v", observation, err)
	}
	diagnostic.FeedURLSHA256 = strings.Repeat("0", 64)
	if _, err := authenticateEmbeddedTrust(diagnostic, []byte(`{"configured":true}`), config, root); err == nil {
		t.Fatal("mismatched embedded feed trust was accepted")
	}
}

func TestDiagnosticEnvironmentCannotUseDevelopmentTrustOverrides(t *testing.T) {
	environment := []string{
		"PATH=C:\\Windows", "AETHEROPS_DEV=1", "AETHEROPS_RUNTIME_FEED_URL=https://fixture.invalid/feed",
		"AETHEROPS_RUNTIME_KEY_ID=fixture", "AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64=fixture", "KEEP=value",
	}
	clean := sanitizedEnvironment(environment)
	joined := strings.Join(clean, "\n")
	if strings.Contains(joined, "AETHEROPS_") || !strings.Contains(joined, "PATH=") || !strings.Contains(joined, "KEEP=value") {
		t.Fatalf("sanitized diagnostic environment = %q", joined)
	}
}
