package mcpserver

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/browser"
)

type evidenceTestResponse struct {
	Body            []byte
	MediaType       string
	Status          int
	Redirect        string
	ContentLength   int64
	ContentEncoding string
}

func newEvidenceTestOrigin(t *testing.T, responses map[string]evidenceTestResponse) (string, browser.Policy) {
	t.Helper()
	origin := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		response, ok := responses[request.URL.Path]
		if !ok {
			http.NotFound(writer, request)
			return
		}
		if response.Redirect != "" {
			http.Redirect(writer, request, response.Redirect, http.StatusFound)
			return
		}
		if response.MediaType != "" {
			writer.Header().Set("Content-Type", response.MediaType)
		}
		if response.ContentEncoding != "" {
			writer.Header().Set("Content-Encoding", response.ContentEncoding)
		}
		if response.ContentLength > 0 {
			writer.Header().Set("Content-Length", strconv.FormatInt(response.ContentLength, 10))
		}
		status := response.Status
		if status == 0 {
			status = http.StatusOK
		}
		writer.WriteHeader(status)
		_, _ = writer.Write(response.Body)
	}))
	t.Cleanup(origin.Close)
	parsed, err := url.Parse(origin.URL)
	if err != nil {
		t.Fatal(err)
	}
	return origin.URL, browser.Policy{AllowedLocalHosts: map[string]bool{parsed.Hostname(): true}}
}

func TestFetchPublicEvidenceUsesExactResponseAndReturnsFinalCanonicalURL(t *testing.T) {
	body := []byte("official response\n")
	origin, policy := newEvidenceTestOrigin(t, map[string]evidenceTestResponse{
		"/start": {Redirect: "/final#discarded-fragment"},
		"/final": {Body: body, MediaType: "text/plain; charset=UTF-8"},
	})
	fetched, err := fetchPublicEvidence(context.Background(), policy, origin+"/start#client-fragment")
	if err != nil {
		t.Fatal(err)
	}
	if string(fetched.Body) != string(body) {
		t.Fatalf("fetched body = %q, want %q", fetched.Body, body)
	}
	if fetched.FinalURL != origin+"/final" {
		t.Fatalf("final canonical URL = %q, want %q", fetched.FinalURL, origin+"/final")
	}
	if fetched.MediaType != "text/plain; charset=UTF-8" && fetched.MediaType != "text/plain; charset=utf-8" {
		t.Fatalf("response media type = %q", fetched.MediaType)
	}
}

func TestFetchPublicEvidenceRejectsPrivateRedirect(t *testing.T) {
	origin, policy := newEvidenceTestOrigin(t, map[string]evidenceTestResponse{
		"/redirect": {Redirect: "http://[::1]:1/private"},
	})
	if _, err := fetchPublicEvidence(context.Background(), policy, origin+"/redirect"); err == nil {
		t.Fatal("public evidence fetch followed a redirect to a private address")
	}
	if _, err := fetchPublicEvidence(context.Background(), browser.Policy{}, "http://127.0.0.1/private"); err == nil {
		t.Fatal("public evidence fetch accepted a direct private address")
	}
}

func TestFetchPublicEvidenceBlocksDNSRebindingBeforePrivateDial(t *testing.T) {
	upstream, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = upstream.Close() })
	accepted := make(chan struct{}, 1)
	go func() {
		connection, err := upstream.Accept()
		if err != nil {
			return
		}
		accepted <- struct{}{}
		_ = connection.Close()
	}()
	resolver, queryCount := evidenceRebindingResolver(t)
	_, port, err := net.SplitHostPort(upstream.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	_, err = fetchPublicEvidence(context.Background(), browser.Policy{Resolver: resolver},
		"http://rebind.aetherops.test:"+port+"/source")
	if err == nil {
		t.Fatal("evidence fetch accepted a DNS-rebound private destination")
	}
	if queryCount.Load() < 2 {
		t.Fatalf("evidence fetch did not re-resolve before dial: A queries=%d", queryCount.Load())
	}
	select {
	case <-accepted:
		t.Fatal("DNS-rebound private evidence upstream accepted a connection")
	case <-time.After(150 * time.Millisecond):
	}
}

func TestFetchPublicEvidenceEnforcesResponseContract(t *testing.T) {
	tests := []struct {
		name     string
		response evidenceTestResponse
	}{
		{name: "non-200", response: evidenceTestResponse{Status: http.StatusPartialContent, Body: []byte("partial"), MediaType: "text/plain"}},
		{name: "declared oversized", response: evidenceTestResponse{ContentLength: maxEvidenceBytes + 1, MediaType: "text/plain"}},
		{name: "empty", response: evidenceTestResponse{MediaType: "text/plain"}},
		{name: "encoded", response: evidenceTestResponse{Body: []byte("compressed"), MediaType: "text/plain", ContentEncoding: "gzip"}},
		{name: "invalid content type", response: evidenceTestResponse{Body: []byte("body"), MediaType: "not a media type ; ="}},
		{name: "multipart", response: evidenceTestResponse{Body: []byte("body"), MediaType: "multipart/mixed; boundary=x"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			origin, policy := newEvidenceTestOrigin(t, map[string]evidenceTestResponse{"/source": test.response})
			if _, err := fetchPublicEvidence(context.Background(), policy, origin+"/source"); err == nil {
				t.Fatal("invalid evidence response unexpectedly succeeded")
			}
		})
	}
}

func TestFetchPublicEvidenceAcceptsPayloadAboveLegacyArtifactLimit(t *testing.T) {
	body := make([]byte, maxArtifactBytes+1)
	for index := range body {
		body[index] = byte('a' + index%26)
	}
	origin, policy := newEvidenceTestOrigin(t, map[string]evidenceTestResponse{
		"/large-paper.pdf": {Body: body, MediaType: "application/pdf"},
	})
	fetched, err := fetchPublicEvidence(context.Background(), policy, origin+"/large-paper.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if len(fetched.Body) != len(body) || fetched.MediaType != "application/pdf" {
		t.Fatalf("large evidence response = %d bytes, %q", len(fetched.Body), fetched.MediaType)
	}
}

func TestEvidenceAndArtifactSizeLimitsRemainSeparated(t *testing.T) {
	if maxEvidenceBytes != 80<<20 {
		t.Fatalf("evidence size limit = %d, want 80 MiB", maxEvidenceBytes)
	}
	if maxArtifactBytes != 16<<20 {
		t.Fatalf("artifact size limit = %d, want 16 MiB", maxArtifactBytes)
	}
}

func TestFetchPublicEvidenceHonorsCallerCancellation(t *testing.T) {
	started := make(chan struct{})
	origin := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		close(started)
		<-request.Context().Done()
	}))
	t.Cleanup(origin.Close)
	parsed, err := url.Parse(origin.URL)
	if err != nil {
		t.Fatal(err)
	}
	policy := browser.Policy{AllowedLocalHosts: map[string]bool{parsed.Hostname(): true}}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err = fetchPublicEvidence(ctx, policy, origin.URL+"/slow")
	if err == nil {
		t.Fatal("cancelled evidence fetch unexpectedly succeeded")
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("evidence fetch never reached the real HTTP handler")
	}
}

func evidenceTestSHA256(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func evidenceRebindingResolver(t *testing.T) (*net.Resolver, *atomic.Int32) {
	t.Helper()
	dns, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dns.Close() })
	var aQueries atomic.Int32
	go func() {
		buffer := make([]byte, 2048)
		for {
			count, peer, err := dns.ReadFrom(buffer)
			if err != nil {
				return
			}
			request := append([]byte(nil), buffer[:count]...)
			response, isA := evidenceDNSResponse(request, aQueries.Load() == 0)
			if isA {
				aQueries.Add(1)
			}
			if len(response) != 0 {
				_, _ = dns.WriteTo(response, peer)
			}
		}
	}()
	resolver := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "udp", dns.LocalAddr().String())
		},
	}
	return resolver, &aQueries
}

func evidenceDNSResponse(request []byte, firstPublic bool) ([]byte, bool) {
	if len(request) < 17 {
		return nil, false
	}
	end := 12
	for end < len(request) && request[end] != 0 {
		end += 1 + int(request[end])
	}
	if end+5 > len(request) {
		return nil, false
	}
	questionEnd := end + 5
	queryType := binary.BigEndian.Uint16(request[end+1 : end+3])
	isA := queryType == 1
	answers := uint16(0)
	if isA {
		answers = 1
	}
	response := make([]byte, 12, 12+(questionEnd-12)+16)
	copy(response[0:2], request[0:2])
	binary.BigEndian.PutUint16(response[2:4], 0x8180)
	binary.BigEndian.PutUint16(response[4:6], 1)
	binary.BigEndian.PutUint16(response[6:8], answers)
	response = append(response, request[12:questionEnd]...)
	if !isA {
		return response, false
	}
	address := []byte{127, 0, 0, 1}
	if firstPublic {
		address = []byte{93, 184, 216, 34}
	}
	answer := []byte{0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 4}
	response = append(response, answer...)
	response = append(response, address...)
	return response, true
}
