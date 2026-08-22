package runtime

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	// FeedObservationSchemaV1 identifies the non-secret cryptographic/TLS
	// evidence returned after one verified signed-feed fetch.
	FeedObservationSchemaV1 = "aetherops_runtime_feed_observation_v1"
	feedSchema              = 1
	maxFeedBytes            = 4 << 20
	maxFeedValidity         = 7 * 24 * time.Hour
	maximumClockSkew        = 5 * time.Minute
)

// TrustRoot is the product-pinned Ed25519 key used for both the release feed
// and the per-artifact attestations retained with a pending candidate.
type TrustRoot struct {
	KeyID     string
	PublicKey ed25519.PublicKey
}

func ParseTrustRoot(keyID, publicKeyBase64 string) (TrustRoot, error) {
	if !safeID.MatchString(strings.TrimSpace(keyID)) {
		return TrustRoot{}, errors.New("runtime update trust-root key id is invalid")
	}
	key, err := base64.StdEncoding.Strict().DecodeString(strings.TrimSpace(publicKeyBase64))
	if err != nil || len(key) != ed25519.PublicKeySize {
		return TrustRoot{}, errors.New("runtime update trust-root public key is invalid")
	}
	return TrustRoot{KeyID: strings.TrimSpace(keyID), PublicKey: ed25519.PublicKey(append([]byte(nil), key...))}, nil
}

type signedEnvelope struct {
	Schema    int    `json:"schema"`
	KeyID     string `json:"key_id"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

type feedPayload struct {
	Schema    int         `json:"schema"`
	Channel   string      `json:"channel"`
	IssuedAt  time.Time   `json:"issued_at"`
	ExpiresAt time.Time   `json:"expires_at"`
	Release   feedRelease `json:"release"`
}

type feedRelease struct {
	ID        string         `json:"id"`
	Channel   string         `json:"channel"`
	Artifacts []feedArtifact `json:"artifacts"`
}

type feedArtifact struct {
	Component       Component       `json:"component"`
	Version         string          `json:"version"`
	URL             string          `json:"url"`
	SHA256          string          `json:"sha256"`
	Attestation     json.RawMessage `json:"attestation"`
	NPMPackage      string          `json:"npm_package,omitempty"`
	NPMIntegrity    string          `json:"npm_integrity,omitempty"`
	Archive         ArchiveFormat   `json:"archive"`
	StripComponents int             `json:"strip_components,omitempty"`
	Entrypoint      string          `json:"entrypoint"`
	MaxBytes        int64           `json:"max_bytes"`
	MaxExtractBytes int64           `json:"max_extract_bytes"`
}

// ArtifactAttestation deliberately excludes the download URL. URLs may carry
// short-lived credentials and are never persisted, while every field that can
// affect installation or execution remains covered by the signature.
type ArtifactAttestation struct {
	Schema          int           `json:"schema"`
	Component       Component     `json:"component"`
	Version         string        `json:"version"`
	SHA256          string        `json:"sha256"`
	NPMPackage      string        `json:"npm_package,omitempty"`
	NPMIntegrity    string        `json:"npm_integrity,omitempty"`
	Archive         ArchiveFormat `json:"archive"`
	StripComponents int           `json:"strip_components,omitempty"`
	Entrypoint      string        `json:"entrypoint"`
	MaxBytes        int64         `json:"max_bytes"`
	MaxExtractBytes int64         `json:"max_extract_bytes"`
}

// FeedClient reads a single signed stable-channel document. It accepts HTTPS
// only, caps the response before decoding, and refuses cross-origin redirects.
type FeedClient struct {
	URL        string
	TrustRoot  TrustRoot
	HTTPClient *http.Client
	Now        func() time.Time
}

// FeedObservation binds a successful fetch to the exact signed bytes and the
// authenticated TLS peer. It intentionally contains no URL query or other
// credential-bearing value. Production release evidence can retain this
// record without retaining the feed response itself.
type FeedObservation struct {
	Schema                string    `json:"schema"`
	EnvelopeSHA256        string    `json:"envelope_sha256"`
	SignedPayloadSHA256   string    `json:"signed_payload_sha256"`
	FeedURLSHA256         string    `json:"feed_url_sha256"`
	KeyID                 string    `json:"key_id"`
	IssuedAt              time.Time `json:"issued_at"`
	ExpiresAt             time.Time `json:"expires_at"`
	ReleaseID             string    `json:"release_id"`
	TLSVersion            uint16    `json:"tls_version"`
	TLSCipherSuite        uint16    `json:"tls_cipher_suite"`
	LeafCertificateSHA256 string    `json:"leaf_certificate_sha256"`
}

func (client *FeedClient) Fetch(ctx context.Context) (Release, error) {
	release, _, err := client.FetchObserved(ctx)
	return release, err
}

// FetchObserved performs the same fail-closed signed-feed operation as Fetch
// and additionally returns non-secret cryptographic evidence. A successful
// observation always came from a completed TLS handshake and verified
// Ed25519 envelope; callers cannot synthesize one through an alternate path.
func (client *FeedClient) FetchObserved(ctx context.Context) (Release, FeedObservation, error) {
	if client == nil {
		return Release{}, FeedObservation{}, errors.New("runtime update feed client is nil")
	}
	feedURL, err := url.Parse(strings.TrimSpace(client.URL))
	if err != nil || feedURL.Scheme != "https" || feedURL.Host == "" || feedURL.User != nil || feedURL.Fragment != "" {
		return Release{}, FeedObservation{}, errors.New("runtime update feed URL must be an HTTPS URL without credentials or fragment")
	}
	if len(client.TrustRoot.PublicKey) != ed25519.PublicKeySize || !safeID.MatchString(client.TrustRoot.KeyID) {
		return Release{}, FeedObservation{}, errors.New("runtime update trust root is not configured")
	}
	httpClient := &http.Client{Timeout: 45 * time.Second}
	if client.HTTPClient != nil {
		clone := *client.HTTPClient
		httpClient = &clone
		if httpClient.Timeout <= 0 {
			httpClient.Timeout = 45 * time.Second
		}
	}
	previousRedirectPolicy := httpClient.CheckRedirect
	httpClient.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("runtime update feed exceeded the redirect limit")
		}
		if request.URL.Scheme != "https" || !strings.EqualFold(request.URL.Host, feedURL.Host) || request.URL.User != nil {
			return errors.New("runtime update feed refused a cross-origin redirect")
		}
		if previousRedirectPolicy != nil {
			return previousRedirectPolicy(request, via)
		}
		return nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, feedURL.String(), nil)
	if err != nil {
		return Release{}, FeedObservation{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "AetherOps/v2 runtime-updater")
	response, err := httpClient.Do(request)
	if err != nil {
		return Release{}, FeedObservation{}, fmt.Errorf("fetch runtime update feed: %w", err)
	}
	defer response.Body.Close()
	if response.TLS == nil || !response.TLS.HandshakeComplete || len(response.TLS.PeerCertificates) == 0 {
		return Release{}, FeedObservation{}, errors.New("runtime update feed did not provide an authenticated TLS peer")
	}
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return Release{}, FeedObservation{}, fmt.Errorf("runtime update feed returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxFeedBytes+1))
	if err != nil {
		return Release{}, FeedObservation{}, fmt.Errorf("read runtime update feed: %w", err)
	}
	if len(data) == 0 || len(data) > maxFeedBytes {
		return Release{}, FeedObservation{}, errors.New("runtime update feed size is invalid")
	}
	payloadBytes, err := verifyEnvelope(data, client.TrustRoot)
	if err != nil {
		return Release{}, FeedObservation{}, fmt.Errorf("verify runtime update feed: %w", err)
	}
	var payload feedPayload
	if err := decodeStrictJSON(payloadBytes, &payload); err != nil {
		return Release{}, FeedObservation{}, fmt.Errorf("decode signed runtime update payload: %w", err)
	}
	now := time.Now().UTC()
	if client.Now != nil {
		now = client.Now().UTC()
	}
	if payload.Schema != feedSchema || payload.Channel != "stable" || payload.Release.Channel != "stable" {
		return Release{}, FeedObservation{}, errors.New("runtime update feed is not a supported stable-channel payload")
	}
	if payload.IssuedAt.IsZero() || payload.ExpiresAt.IsZero() || payload.ExpiresAt.Before(now) || payload.IssuedAt.After(now.Add(maximumClockSkew)) || !payload.ExpiresAt.After(payload.IssuedAt) || payload.ExpiresAt.Sub(payload.IssuedAt) > maxFeedValidity {
		return Release{}, FeedObservation{}, errors.New("runtime update feed validity window is invalid")
	}
	release := Release{ID: payload.Release.ID, Channel: payload.Release.Channel, Artifacts: make([]Artifact, 0, len(payload.Release.Artifacts))}
	for _, item := range payload.Release.Artifacts {
		if item.MaxBytes <= 0 || item.MaxExtractBytes <= 0 {
			return Release{}, FeedObservation{}, fmt.Errorf("runtime artifact %q must declare positive size limits", item.Component)
		}
		artifact := Artifact{
			Component: item.Component, Version: item.Version, URL: item.URL, SHA256: item.SHA256,
			Signature: append(json.RawMessage(nil), item.Attestation...), NPMPackage: item.NPMPackage,
			NPMIntegrity: item.NPMIntegrity, Archive: item.Archive, StripComponents: item.StripComponents,
			Entrypoint: item.Entrypoint, MaxBytes: item.MaxBytes, MaxExtractBytes: item.MaxExtractBytes,
		}
		if err := client.TrustRoot.verifyArtifact(artifact); err != nil {
			return Release{}, FeedObservation{}, fmt.Errorf("verify runtime artifact %q attestation: %w", item.Component, err)
		}
		release.Artifacts = append(release.Artifacts, artifact)
	}
	envelopeDigest := sha256.Sum256(data)
	payloadDigest := sha256.Sum256(payloadBytes)
	urlDigest := sha256.Sum256([]byte(feedURL.String()))
	certificateDigest := sha256.Sum256(response.TLS.PeerCertificates[0].Raw)
	observation := FeedObservation{
		Schema:         FeedObservationSchemaV1,
		EnvelopeSHA256: hex.EncodeToString(envelopeDigest[:]), SignedPayloadSHA256: hex.EncodeToString(payloadDigest[:]),
		FeedURLSHA256: hex.EncodeToString(urlDigest[:]), KeyID: client.TrustRoot.KeyID,
		IssuedAt: payload.IssuedAt.UTC(), ExpiresAt: payload.ExpiresAt.UTC(), ReleaseID: release.ID,
		TLSVersion: response.TLS.Version, TLSCipherSuite: response.TLS.CipherSuite,
		LeafCertificateSHA256: hex.EncodeToString(certificateDigest[:]),
	}
	return release, observation, nil
}

// SignatureVerifier returns the verifier passed to Manager. It checks the
// retained attestation against the exact durable metadata on both staging and
// next-restart activation.
func (root TrustRoot) SignatureVerifier() SignatureVerifier {
	return func(_ context.Context, input SignatureInput) error {
		if input.SHA256 != input.Artifact.SHA256 {
			return errors.New("runtime artifact receipt does not match signed SHA-256")
		}
		return root.verifyArtifact(input.Artifact)
	}
}

func (root TrustRoot) verifyArtifact(artifact Artifact) error {
	payload, err := verifyEnvelope(artifact.Signature, root)
	if err != nil {
		return err
	}
	var attestation ArtifactAttestation
	if err := decodeStrictJSON(payload, &attestation); err != nil {
		return err
	}
	want := ArtifactAttestation{
		Schema: feedSchema, Component: artifact.Component, Version: artifact.Version, SHA256: artifact.SHA256,
		NPMPackage: artifact.NPMPackage, NPMIntegrity: artifact.NPMIntegrity, Archive: artifact.Archive,
		StripComponents: artifact.StripComponents, Entrypoint: artifact.Entrypoint,
		MaxBytes: artifact.MaxBytes, MaxExtractBytes: artifact.MaxExtractBytes,
	}
	actual, err := json.Marshal(attestation)
	if err != nil {
		return err
	}
	expected, err := json.Marshal(want)
	if err != nil {
		return err
	}
	if !bytes.Equal(actual, expected) {
		return errors.New("runtime artifact attestation does not match durable artifact metadata")
	}
	return nil
}

func verifyEnvelope(data []byte, root TrustRoot) ([]byte, error) {
	var envelope signedEnvelope
	if err := decodeStrictJSON(data, &envelope); err != nil {
		return nil, err
	}
	if envelope.Schema != feedSchema || envelope.KeyID != root.KeyID {
		return nil, errors.New("signed runtime envelope uses an unknown schema or key")
	}
	payload, err := base64.StdEncoding.Strict().DecodeString(envelope.Payload)
	if err != nil || len(payload) == 0 || len(payload) > maxFeedBytes {
		return nil, errors.New("signed runtime envelope payload is invalid")
	}
	signature, err := base64.StdEncoding.Strict().DecodeString(envelope.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(root.PublicKey, payload, signature) {
		return nil, errors.New("signed runtime envelope signature is invalid")
	}
	return payload, nil
}

func decodeStrictJSON(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains multiple values")
		}
		return err
	}
	return nil
}
