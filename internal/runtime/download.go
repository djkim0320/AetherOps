package runtime

import (
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
)

const (
	defaultMaxDownloadBytes = int64(2 * 1024 * 1024 * 1024)
	defaultMaxExtractBytes  = int64(4 * 1024 * 1024 * 1024)
)

type artifactReceipt struct {
	Path   string
	SHA256 string
	Size   int64
}

type downloadResult struct {
	component Component
	receipt   artifactReceipt
	err       error
}

// downloadArtifacts downloads independent artifacts with a bounded worker
// pool. Hashing each file remains local to its worker and no candidate state is
// published until every artifact has succeeded.
func (m *Manager) downloadArtifacts(ctx context.Context, candidate Candidate, artifacts []Artifact) (map[Component]artifactReceipt, error) {
	workers := runtime.NumCPU()
	if workers < 1 {
		workers = 1
	}
	if workers > len(artifacts) {
		workers = len(artifacts)
	}
	jobs := make(chan Artifact, len(artifacts))
	results := make(chan downloadResult, len(artifacts))
	for _, artifact := range artifacts {
		jobs <- artifact
	}
	close(jobs)

	var group sync.WaitGroup
	group.Add(workers)
	for range workers {
		go func() {
			defer group.Done()
			for artifact := range jobs {
				receipt, err := m.downloadArtifact(ctx, candidate.Path, artifact)
				results <- downloadResult{component: artifact.Component, receipt: receipt, err: err}
			}
		}()
	}
	group.Wait()
	close(results)

	receipts := make(map[Component]artifactReceipt, len(artifacts))
	errorsByComponent := make(map[Component]error)
	for result := range results {
		if result.err != nil {
			errorsByComponent[result.component] = result.err
			continue
		}
		receipts[result.component] = result.receipt
	}
	if len(errorsByComponent) != 0 {
		components := make([]string, 0, len(errorsByComponent))
		for component := range errorsByComponent {
			components = append(components, string(component))
		}
		sort.Strings(components)
		errs := make([]error, 0, len(components))
		for _, component := range components {
			errs = append(errs, fmt.Errorf("download %s: %w", component, errorsByComponent[Component(component)]))
		}
		return nil, errors.Join(errs...)
	}
	return receipts, nil
}

func (m *Manager) downloadArtifact(ctx context.Context, candidatePath string, artifact Artifact) (artifactReceipt, error) {
	client := m.secureHTTPClient()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, artifact.URL, nil)
	if err != nil {
		return artifactReceipt{}, errors.New("create HTTPS runtime download request")
	}
	response, err := client.Do(request)
	if err != nil {
		return artifactReceipt{}, fmt.Errorf("request HTTPS runtime download: %w", err)
	}
	defer response.Body.Close()
	if response.Request == nil || response.Request.URL == nil {
		return artifactReceipt{}, errors.New("runtime download response has no final URL")
	}
	if err := validateHTTPSURL(response.Request.URL.String()); err != nil {
		return artifactReceipt{}, err
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return artifactReceipt{}, fmt.Errorf("runtime download returned HTTP status %d", response.StatusCode)
	}
	maximum := artifact.MaxBytes
	if maximum == 0 {
		maximum = defaultMaxDownloadBytes
	}
	if response.ContentLength > maximum {
		return artifactReceipt{}, errors.New("runtime download exceeds configured size limit")
	}

	temporary, err := os.CreateTemp(candidatePath, "."+string(artifact.Component)+"-payload-*.tmp")
	if err != nil {
		return artifactReceipt{}, err
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()

	// The candidate is intentionally hashed only after Sync. This verifies the
	// bytes that reached durable local storage, not merely the stream buffer.
	written, err := io.Copy(temporary, io.LimitReader(response.Body, maximum+1))
	if err != nil {
		return artifactReceipt{}, fmt.Errorf("write runtime candidate payload: %w", err)
	}
	if written > maximum {
		return artifactReceipt{}, errors.New("runtime download exceeds configured size limit")
	}
	if err := temporary.Sync(); err != nil {
		return artifactReceipt{}, fmt.Errorf("sync runtime candidate payload: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return artifactReceipt{}, fmt.Errorf("close runtime candidate payload: %w", err)
	}

	actualSHA256, err := verifyPayloadHashes(temporaryPath, artifact.SHA256, artifact.NPMIntegrity)
	if err != nil {
		return artifactReceipt{}, err
	}
	finalPath := filepath.Join(candidatePath, string(artifact.Component)+".payload")
	if _, err := os.Lstat(finalPath); err == nil {
		return artifactReceipt{}, errors.New("runtime candidate payload already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return artifactReceipt{}, err
	}
	if err := os.Rename(temporaryPath, finalPath); err != nil {
		return artifactReceipt{}, fmt.Errorf("atomically commit runtime candidate payload: %w", err)
	}
	committed = true
	return artifactReceipt{Path: finalPath, SHA256: actualSHA256, Size: written}, nil
}

func (m *Manager) secureHTTPClient() *http.Client {
	base := m.options.HTTPClient
	if base == nil {
		base = &http.Client{}
	}
	client := *base
	priorRedirect := client.CheckRedirect
	client.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if request == nil || request.URL == nil {
			return errors.New("runtime download redirect is invalid")
		}
		if err := validateHTTPSURL(request.URL.String()); err != nil {
			return err
		}
		if priorRedirect != nil {
			return priorRedirect(request, via)
		}
		return nil
	}
	return &client
}

func validateHTTPSURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed == nil {
		return errors.New("runtime download URL is invalid")
	}
	if parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return errors.New("runtime download URL must use HTTPS without user credentials")
	}
	return nil
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func verifyPayloadHashes(path, expectedSHA256, integrity string) (string, error) {
	expectedSHA, err := hex.DecodeString(expectedSHA256)
	if err != nil || len(expectedSHA) != sha256.Size {
		return "", errors.New("runtime artifact SHA-256 is invalid")
	}
	sri, err := parseNPMIntegrity(integrity)
	if err != nil {
		return "", err
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	sha := sha256.New()
	hashes := map[string]hash.Hash{"sha256": sha}
	for algorithm := range sri {
		switch algorithm {
		case "sha384":
			hashes[algorithm] = sha512.New384()
		case "sha512":
			hashes[algorithm] = sha512.New()
		case "sha256":
			// The SHA-256 hash above is shared with the mandatory artifact
			// checksum validation.
		}
	}
	buffer := make([]byte, 128*1024)
	for {
		count, readErr := file.Read(buffer)
		if count > 0 {
			for _, hasher := range hashes {
				if _, err := hasher.Write(buffer[:count]); err != nil {
					return "", err
				}
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return "", readErr
		}
	}
	actualSHA := sha.Sum(nil)
	if subtle.ConstantTimeCompare(actualSHA, expectedSHA) != 1 {
		return "", errors.New("runtime artifact SHA-256 mismatch")
	}
	if err := verifySRI(hashes, sri); err != nil {
		return "", err
	}
	return hex.EncodeToString(actualSHA), nil
}

// sriDigest groups expected SRI digests by algorithm. The strongest algorithm
// present must match at least one registry digest; a weak SHA-256 entry cannot
// mask a failed SHA-512 integrity assertion.
type sriDigest map[string][][]byte

func validateNPMIntegrity(value string) error {
	_, err := parseNPMIntegrity(value)
	return err
}

func parseNPMIntegrity(value string) (sriDigest, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	digests := make(sriDigest)
	for _, token := range strings.Fields(value) {
		algorithm, encoded, found := strings.Cut(token, "-")
		if !found || encoded == "" {
			return nil, errors.New("npm SRI integrity token is malformed")
		}
		var length int
		switch algorithm {
		case "sha256":
			length = sha256.Size
		case "sha384":
			length = sha512.Size384
		case "sha512":
			length = sha512.Size
		default:
			return nil, fmt.Errorf("npm SRI algorithm %q is not allowed", algorithm)
		}
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(decoded) != length {
			return nil, errors.New("npm SRI digest is invalid")
		}
		digests[algorithm] = append(digests[algorithm], decoded)
	}
	if len(digests) == 0 {
		return nil, errors.New("npm SRI integrity is empty")
	}
	return digests, nil
}

func verifySRI(hashes map[string]hash.Hash, expected sriDigest) error {
	if len(expected) == 0 {
		return nil
	}
	algorithm := "sha256"
	if _, ok := expected["sha512"]; ok {
		algorithm = "sha512"
	} else if _, ok := expected["sha384"]; ok {
		algorithm = "sha384"
	}
	actual := hashes[algorithm].Sum(nil)
	for _, digest := range expected[algorithm] {
		if subtle.ConstantTimeCompare(actual, digest) == 1 {
			return nil
		}
	}
	return errors.New("npm SRI integrity mismatch")
}
