package mcpserver

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/djkim0320/Aether-claw/internal/browser"
)

const (
	evidenceFetchTimeout       = 45 * time.Second
	evidenceResponseHeaderSize = 64 << 10
	maxEvidenceRedirects       = 5
	maxEvidenceMediaTypeBytes  = 512
)

type fetchedEvidence struct {
	Body      []byte
	FinalURL  string
	MediaType string
}

// fetchPublicEvidence makes evidence bytes an app-owned observation. The MCP
// caller supplies only a public URL and cannot inject bytes obtained from a
// shell wrapper, a different page, or an unverified local file.
func fetchPublicEvidence(ctx context.Context, policy browser.Policy, rawURL string) (fetchedEvidence, error) {
	canonicalURL, err := canonicalEvidenceURL(rawURL)
	if err != nil {
		return fetchedEvidence{}, err
	}
	if err := policy.ValidateURL(ctx, canonicalURL); err != nil {
		return fetchedEvidence{}, fmt.Errorf("evidence source URL is blocked: %w", err)
	}

	fetchCtx, cancel := context.WithTimeout(ctx, evidenceFetchTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, canonicalURL, nil)
	if err != nil {
		return fetchedEvidence{}, errors.New("construct evidence request")
	}
	request.Header.Set("Accept", "*/*")
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", "AetherOps/0.1 evidence-capture")

	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            policy.DialContext,
		ForceAttemptHTTP2:      true,
		DisableKeepAlives:      true,
		MaxConnsPerHost:        1,
		TLSHandshakeTimeout:    15 * time.Second,
		ResponseHeaderTimeout:  20 * time.Second,
		ExpectContinueTimeout:  time.Second,
		MaxResponseHeaderBytes: evidenceResponseHeaderSize,
		TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(next *http.Request, via []*http.Request) error {
			if len(via) >= maxEvidenceRedirects {
				return errors.New("evidence redirect limit exceeded")
			}
			canonical, err := canonicalEvidenceURL(next.URL.String())
			if err != nil {
				return fmt.Errorf("invalid evidence redirect: %w", err)
			}
			if err := policy.ValidateURL(next.Context(), canonical); err != nil {
				return fmt.Errorf("blocked evidence redirect: %w", err)
			}
			if len(via) > 0 && strings.EqualFold(via[len(via)-1].URL.Scheme, "https") &&
				!strings.EqualFold(next.URL.Scheme, "https") {
				return errors.New("HTTPS evidence cannot redirect to plaintext HTTP")
			}
			parsed, err := url.Parse(canonical)
			if err != nil {
				return fmt.Errorf("parse canonical evidence redirect: %w", err)
			}
			next.URL = parsed
			next.Host = ""
			next.Header.Del("Authorization")
			next.Header.Del("Cookie")
			next.Header.Set("Accept-Encoding", "identity")
			return nil
		},
	}

	response, err := client.Do(request)
	if err != nil {
		return fetchedEvidence{}, fmt.Errorf("fetch public evidence: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fetchedEvidence{}, fmt.Errorf("evidence source returned HTTP status %d; exactly 200 is required", response.StatusCode)
	}
	if response.ContentLength > maxEvidenceBytes {
		return fetchedEvidence{}, errors.New("evidence response exceeds the 80 MiB limit")
	}
	contentEncoding := strings.TrimSpace(response.Header.Get("Content-Encoding"))
	if contentEncoding != "" && !strings.EqualFold(contentEncoding, "identity") {
		return fetchedEvidence{}, fmt.Errorf("unsupported evidence content encoding %q", contentEncoding)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxEvidenceBytes+1))
	if err != nil {
		return fetchedEvidence{}, fmt.Errorf("read evidence response: %w", err)
	}
	if len(body) == 0 {
		return fetchedEvidence{}, errors.New("evidence response is empty")
	}
	if len(body) > maxEvidenceBytes {
		return fetchedEvidence{}, errors.New("evidence response exceeds the 80 MiB limit")
	}
	mediaType, err := evidenceResponseMediaType(response.Header.Get("Content-Type"), body)
	if err != nil {
		return fetchedEvidence{}, err
	}
	finalURL, err := canonicalEvidenceURL(response.Request.URL.String())
	if err != nil {
		return fetchedEvidence{}, fmt.Errorf("canonicalize final evidence URL: %w", err)
	}
	if err := policy.ValidateURL(fetchCtx, finalURL); err != nil {
		return fetchedEvidence{}, fmt.Errorf("final evidence URL is blocked: %w", err)
	}
	return fetchedEvidence{Body: body, FinalURL: finalURL, MediaType: mediaType}, nil
}

func canonicalEvidenceURL(rawURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return "", errors.New("evidence source URL is invalid")
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("blocked URL scheme %q", parsed.Scheme)
	}
	if parsed.User != nil {
		return "", errors.New("URLs containing credentials are blocked")
	}
	hostname := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(parsed.Hostname())), ".")
	if hostname == "" {
		return "", errors.New("evidence source host is empty")
	}
	port := parsed.Port()
	if (parsed.Scheme == "http" && port == "80") || (parsed.Scheme == "https" && port == "443") {
		port = ""
	}
	if port != "" {
		parsed.Host = net.JoinHostPort(hostname, port)
	} else if strings.Contains(hostname, ":") {
		parsed.Host = "[" + hostname + "]"
	} else {
		parsed.Host = hostname
	}
	parsed.Fragment = ""
	parsed.RawFragment = ""
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	return parsed.String(), nil
}

func evidenceResponseMediaType(raw string, body []byte) (string, error) {
	raw = strings.TrimSpace(raw)
	if len(raw) > maxEvidenceMediaTypeBytes {
		return "", errors.New("evidence response Content-Type is too large")
	}
	if raw == "" {
		raw = http.DetectContentType(body)
	}
	mediaType, parameters, err := mime.ParseMediaType(raw)
	if err != nil || strings.TrimSpace(mediaType) == "" {
		return "", errors.New("evidence response Content-Type is invalid")
	}
	mediaType = strings.ToLower(mediaType)
	if strings.HasPrefix(mediaType, "multipart/") || strings.HasPrefix(mediaType, "message/") {
		return "", fmt.Errorf("unsupported evidence media type %q", mediaType)
	}
	return mime.FormatMediaType(mediaType, parameters), nil
}
