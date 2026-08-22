package browser

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestEgressProxyRejectsHTTPAndCONNECTBeforePrivateUpstreamReceivesBytes(t *testing.T) {
	upstream, accepted := privateUpstreamListener(t)
	proxy, err := StartEgressProxy(Policy{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = proxy.Close(ctx)
	})
	proxyURL, _ := url.Parse("http://" + proxy.Address())
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}, Timeout: 3 * time.Second}
	response, err := client.Get("http://" + upstream.Addr().String() + "/blocked")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("private absolute HTTP status=%d, want 403", response.StatusCode)
	}

	connection, err := net.DialTimeout("tcp", proxy.Address(), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_, err = fmt.Fprintf(connection, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", upstream.Addr(), upstream.Addr())
	if err != nil {
		_ = connection.Close()
		t.Fatal(err)
	}
	status, err := bufio.NewReader(connection).ReadString('\n')
	_ = connection.Close()
	if err != nil || !strings.Contains(status, " 403 ") {
		t.Fatalf("private CONNECT status=%q err=%v", status, err)
	}
	assertNoUpstreamConnection(t, accepted)
}

func TestEgressProxyReResolvesAndBlocksDNSRebindingBeforeDial(t *testing.T) {
	upstream, accepted := privateUpstreamListener(t)
	resolver, queryCount := rebindingResolver(t)
	proxy, err := StartEgressProxy(Policy{Resolver: resolver}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = proxy.Close(ctx)
	})
	proxyURL, _ := url.Parse("http://" + proxy.Address())
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}, Timeout: 3 * time.Second}
	_, port, err := net.SplitHostPort(upstream.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Get("http://rebind.aetherops.test:" + port + "/blocked")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("DNS-rebinding response status=%d, want 502", response.StatusCode)
	}
	if queryCount.Load() < 2 {
		t.Fatalf("proxy did not re-resolve before dial: A queries=%d", queryCount.Load())
	}
	assertNoUpstreamConnection(t, accepted)
}

func TestGate0NetworkDiagnosticTraversesLiveProxyAndSockets(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	report := ProbeGate0NetworkBoundary(ctx)
	if !report.Passed || !report.Executed || len(report.Failures) != 0 {
		t.Fatalf("actual Gate 0 network diagnostic failed: %+v", report)
	}
	if !report.PrivateHTTPBlocked || !report.PrivateCONNECTBlocked || !report.PrivateUpstreamUntouched ||
		!report.LinkLocalMetadataBlocked || !report.DNSRebindingBlocked || report.DNSRebindingQueries < 2 ||
		!report.RebindingUpstreamUntouched {
		t.Fatalf("Gate 0 network diagnostic omitted a required observation: %+v", report)
	}
}

func privateUpstreamListener(t *testing.T) (net.Listener, <-chan struct{}) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	accepted := make(chan struct{}, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		accepted <- struct{}{}
		_ = connection.Close()
	}()
	return listener, accepted
}

func assertNoUpstreamConnection(t *testing.T, accepted <-chan struct{}) {
	t.Helper()
	select {
	case <-accepted:
		t.Fatal("blocked upstream accepted a connection")
	case <-time.After(150 * time.Millisecond):
	}
}

func rebindingResolver(t *testing.T) (*net.Resolver, *atomic.Int32) {
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
			response, isA := dnsResponse(request, aQueries.Load() == 0)
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

func dnsResponse(request []byte, firstPublic bool) ([]byte, bool) {
	if len(request) < 17 {
		return nil, false
	}
	end := 12
	for end < len(request) && request[end] != 0 {
		label := int(request[end])
		end += 1 + label
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
