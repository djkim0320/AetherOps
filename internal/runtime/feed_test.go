package runtime

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSignedStableFeedAndArtifactAttestation(t *testing.T) {
	now := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root, err := ParseTrustRoot("release-key-1", base64.StdEncoding.EncodeToString(publicKey))
	if err != nil {
		t.Fatal(err)
	}
	contents := testContents()
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/stable.json" {
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write(signedTestFeed(t, privateKey, root.KeyID, server.URL, contents, now, now.Add(24*time.Hour)))
			return
		}
		writeArtifact(t, writer, contents[strings.TrimPrefix(request.URL.Path, "/")])
	}))
	defer server.Close()
	feed := &FeedClient{URL: server.URL + "/stable.json", TrustRoot: root, HTTPClient: server.Client(), Now: func() time.Time { return now }}
	release, observation, err := feed.FetchObserved(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if release.ID != "stable-20260808" || len(release.Artifacts) != len(managedComponents()) {
		t.Fatalf("signed release = %#v", release)
	}
	if observation.Schema != FeedObservationSchemaV1 ||
		observation.ReleaseID != release.ID || observation.KeyID != root.KeyID ||
		!validSHA256(observation.EnvelopeSHA256) || !validSHA256(observation.SignedPayloadSHA256) ||
		!validSHA256(observation.FeedURLSHA256) || !validSHA256(observation.LeafCertificateSHA256) ||
		observation.TLSVersion == 0 || observation.TLSCipherSuite == 0 {
		t.Fatalf("signed feed observation = %#v", observation)
	}
	artifact := release.Artifacts[0]
	if err := root.SignatureVerifier()(context.Background(), SignatureInput{Artifact: artifact, SHA256: artifact.SHA256}); err != nil {
		t.Fatalf("verify retained artifact attestation: %v", err)
	}
	artifact.SHA256 = strings.Repeat("0", 64)
	if err := root.SignatureVerifier()(context.Background(), SignatureInput{Artifact: artifact, SHA256: artifact.SHA256}); err == nil {
		t.Fatal("artifact attestation accepted mutated durable metadata")
	}
}

func TestSignedStableFeedRejectsExpiredPayload(t *testing.T) {
	now := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root, err := ParseTrustRoot("release-key-1", base64.StdEncoding.EncodeToString(publicKey))
	if err != nil {
		t.Fatal(err)
	}
	contents := testContents()
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = writer.Write(signedTestFeed(t, privateKey, root.KeyID, server.URL, contents, now.Add(-2*time.Hour), now.Add(-time.Hour)))
	}))
	defer server.Close()
	feed := &FeedClient{URL: server.URL, TrustRoot: root, HTTPClient: server.Client(), Now: func() time.Time { return now }}
	if _, err := feed.Fetch(context.Background()); err == nil {
		t.Fatal("expired signed stable feed was accepted")
	}
}

func TestUpdaterStagesThenActivatesOnlyOnNextStartup(t *testing.T) {
	now := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root, err := ParseTrustRoot("release-key-1", base64.StdEncoding.EncodeToString(publicKey))
	if err != nil {
		t.Fatal(err)
	}
	contents := testContents()
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/stable.json" {
			_, _ = writer.Write(signedTestFeed(t, privateKey, root.KeyID, server.URL, contents, now, now.Add(24*time.Hour)))
			return
		}
		writeArtifact(t, writer, contents[strings.TrimPrefix(request.URL.Path, "/")])
	}))
	defer server.Close()
	manager, err := Open(t.TempDir(), testManifest(), Options{
		HTTPClient: server.Client(), SignatureVerifier: root.SignatureVerifier(),
		CompatibilityProbe: testLifecycleProbe(now), Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	feed := &FeedClient{URL: server.URL + "/stable.json", TrustRoot: root, HTTPClient: server.Client(), Now: func() time.Time { return now }}
	updater := &Updater{Manager: manager, Feed: feed, Idle: func(context.Context) (bool, error) { return true, nil }}
	if err := updater.CheckIfDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	status, err := manager.Status()
	if err != nil {
		t.Fatal(err)
	}
	if status.Active != nil || len(status.Candidates) != 1 || status.Candidates[0].Status != CandidatePending {
		t.Fatalf("staged runtime state = %#v", status)
	}
	if updater.Snapshot().PendingRestartID != "stable-20260808" {
		t.Fatalf("updater snapshot = %#v", updater.Snapshot())
	}
	durablePending := (&Updater{Manager: manager, Feed: feed, Idle: updater.Idle}).Snapshot()
	if durablePending.PendingRestartID != "stable-20260808" {
		t.Fatalf("durable pending runtime was not restored in a fresh updater snapshot: %#v", durablePending)
	}
	restarted := &Updater{Manager: manager, Feed: feed, Idle: updater.Idle}
	if err := restarted.ActivateOnStartup(context.Background()); err != nil {
		t.Fatal(err)
	}
	active, err := manager.Active()
	if err != nil {
		t.Fatal(err)
	}
	if active.CandidateID != "stable-20260808" || restarted.Snapshot().ActivatedID != active.CandidateID {
		t.Fatalf("activated runtime = %#v snapshot=%#v", active, restarted.Snapshot())
	}
	durableActive := (&Updater{Manager: manager, Feed: feed, Idle: updater.Idle}).Snapshot()
	if durableActive.ActivatedID != active.CandidateID {
		t.Fatalf("durable active runtime was not restored in a fresh updater snapshot: %#v", durableActive)
	}
	if _, err := manager.ProcessPaths(); err != nil {
		t.Fatalf("resolve activated runtime: %v", err)
	}
}

func TestUpdaterStartupQuarantinesInterruptedCandidateWithoutRetry(t *testing.T) {
	manager := newTestManager(t, nil, acceptTestSignature, testLifecycleProbe(time.Now()))
	candidate, err := manager.createCandidate(Release{ID: "interrupted-download", Channel: "stable"})
	if err != nil {
		t.Fatal(err)
	}
	if candidate.Status != CandidateDownloading {
		t.Fatalf("candidate status = %s", candidate.Status)
	}
	updater := &Updater{Manager: manager, Feed: &FeedClient{}}
	if err := updater.ActivateOnStartup(context.Background()); err != nil {
		t.Fatal(err)
	}
	status, err := manager.Status()
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Candidates) != 0 || len(status.Warnings) != 1 || status.Warnings[0].Code != "interrupted-runtime-candidate" {
		t.Fatalf("recovered runtime state = %#v", status)
	}
	if _, err := manager.Active(); err == nil {
		t.Fatal("interrupted download was activated")
	}
}

func TestUpdaterActivationFailurePersistsWarningAndRefusesQuarantinedReleaseRetry(t *testing.T) {
	now := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root, err := ParseTrustRoot("release-key-1", base64.StdEncoding.EncodeToString(publicKey))
	if err != nil {
		t.Fatal(err)
	}
	contents := testContents()
	var artifactRequests atomic.Int64
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/stable.json" {
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write(signedTestFeed(t, privateKey, root.KeyID, server.URL, contents, now, now.Add(7*24*time.Hour)))
			return
		}
		artifactRequests.Add(1)
		writeArtifact(t, writer, contents[strings.TrimPrefix(request.URL.Path, "/")])
	}))
	defer server.Close()
	manager, err := Open(t.TempDir(), testManifest(), Options{
		HTTPClient: server.Client(), SignatureVerifier: root.SignatureVerifier(),
		CompatibilityProbe: testLifecycleProbe(now), Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	feed := &FeedClient{URL: server.URL + "/stable.json", TrustRoot: root, HTTPClient: server.Client(), Now: func() time.Time { return now }}
	updater := &Updater{Manager: manager, Feed: feed, Idle: func(context.Context) (bool, error) { return true, nil }}
	if err := updater.CheckIfDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	stagedRequests := artifactRequests.Load()
	if stagedRequests != int64(len(managedComponents())) {
		t.Fatalf("artifact requests while staging = %d, want %d", stagedRequests, len(managedComponents()))
	}
	status, err := manager.Status()
	if err != nil || len(status.Candidates) != 1 {
		t.Fatalf("staged candidate status = %#v, %v", status, err)
	}
	payload := filepath.Join(manager.Layout().Candidates, status.Candidates[0].ID, "node.payload")
	if err := os.WriteFile(payload, []byte("corrupted after compatibility probe"), 0o600); err != nil {
		t.Fatal(err)
	}
	restarted := &Updater{Manager: manager, Feed: feed, Idle: updater.Idle}
	if err := restarted.ActivateOnStartup(context.Background()); err == nil {
		t.Fatal("corrupted pending runtime activated")
	}
	warnings, err := manager.Warnings()
	if err != nil {
		t.Fatal(err)
	}
	foundActivationWarning := false
	for _, warning := range warnings {
		if warning.Code == "pending-runtime-activation-failed" {
			foundActivationWarning = true
			break
		}
	}
	if !foundActivationWarning {
		t.Fatalf("startup activation failure was not persisted: %#v", warnings)
	}

	now = now.Add(24 * time.Hour)
	if err := restarted.CheckIfDue(context.Background()); err == nil || !strings.Contains(err.Error(), "automatic resubmission refused") {
		t.Fatalf("quarantined stable release retry = %v", err)
	}
	if got := artifactRequests.Load(); got != stagedRequests {
		t.Fatalf("quarantined release caused external artifact requests: before=%d after=%d", stagedRequests, got)
	}
}

func signedTestFeed(t *testing.T, privateKey ed25519.PrivateKey, keyID, baseURL string, contents map[string][]byte, issuedAt, expiresAt time.Time) []byte {
	t.Helper()
	release := testRelease("stable-20260808", baseURL, contents)
	feedArtifacts := make([]feedArtifact, 0, len(release.Artifacts))
	for index := range release.Artifacts {
		artifact := &release.Artifacts[index]
		artifact.MaxBytes = 16 << 20
		artifact.MaxExtractBytes = 32 << 20
		attestation := ArtifactAttestation{
			Schema: feedSchema, Component: artifact.Component, Version: artifact.Version, SHA256: artifact.SHA256,
			NPMPackage: artifact.NPMPackage, NPMIntegrity: artifact.NPMIntegrity, Archive: artifact.Archive,
			StripComponents: artifact.StripComponents, Entrypoint: artifact.Entrypoint,
			MaxBytes: artifact.MaxBytes, MaxExtractBytes: artifact.MaxExtractBytes,
		}
		artifact.Signature = signTestEnvelope(t, privateKey, keyID, attestation)
		feedArtifacts = append(feedArtifacts, feedArtifact{
			Component: artifact.Component, Version: artifact.Version, URL: artifact.URL, SHA256: artifact.SHA256,
			Attestation: artifact.Signature, NPMPackage: artifact.NPMPackage, NPMIntegrity: artifact.NPMIntegrity,
			Archive: artifact.Archive, StripComponents: artifact.StripComponents, Entrypoint: artifact.Entrypoint,
			MaxBytes: artifact.MaxBytes, MaxExtractBytes: artifact.MaxExtractBytes,
		})
	}
	payload := feedPayload{
		Schema: feedSchema, Channel: "stable", IssuedAt: issuedAt, ExpiresAt: expiresAt,
		Release: feedRelease{ID: release.ID, Channel: release.Channel, Artifacts: feedArtifacts},
	}
	return signTestEnvelope(t, privateKey, keyID, payload)
}

func signTestEnvelope(t *testing.T, privateKey ed25519.PrivateKey, keyID string, payload any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := json.Marshal(signedEnvelope{
		Schema: feedSchema, KeyID: keyID, Payload: base64.StdEncoding.EncodeToString(encoded),
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, encoded)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return envelope
}
