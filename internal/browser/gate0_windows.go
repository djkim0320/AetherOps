//go:build windows && amd64

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
	"time"
)

// Gate0NetworkDiagnostic is produced by real local sockets traversing the
// same egress proxy implementation used by the internet WebView2 environment.
type Gate0NetworkDiagnostic struct {
	Executed                   bool     `json:"executed"`
	PrivateHTTPBlocked         bool     `json:"privateHttpBlocked"`
	PrivateCONNECTBlocked      bool     `json:"privateConnectBlocked"`
	PrivateUpstreamUntouched   bool     `json:"privateUpstreamUntouched"`
	LinkLocalMetadataBlocked   bool     `json:"linkLocalMetadataBlocked"`
	DNSRebindingBlocked        bool     `json:"dnsRebindingBlocked"`
	DNSRebindingQueries        int32    `json:"dnsRebindingQueries"`
	RebindingUpstreamUntouched bool     `json:"rebindingUpstreamUntouched"`
	Failures                   []string `json:"failures,omitempty"`
	Passed                     bool     `json:"passed"`
}

// ProbeGate0NetworkBoundary opens actual listeners, sends HTTP and CONNECT
// traffic through live EgressProxy instances, and runs an actual UDP DNS
// responder that changes its answer between validation and dial. It does not
// synthesize a passing receipt from policy-unit results.
func ProbeGate0NetworkBoundary(ctx context.Context) (report Gate0NetworkDiagnostic) {
	report.Executed = true
	privateListener, privateAccepted, err := gate0PrivateListener()
	if err != nil {
		report.Failures = append(report.Failures, fmt.Sprintf("open private upstream listener: %v", err))
		return report
	}
	defer privateListener.Close()

	proxy, err := StartEgressProxy(Policy{}, nil)
	if err != nil {
		report.Failures = append(report.Failures, fmt.Sprintf("start private-network egress proxy: %v", err))
		return report
	}
	defer closeGate0Proxy(proxy)
	client := gate0ProxyClient(proxy.Address())

	status, err := gate0GET(ctx, client, "http://"+privateListener.Addr().String()+"/blocked")
	if err != nil {
		report.Failures = append(report.Failures, fmt.Sprintf("send private HTTP request: %v", err))
	} else if status != http.StatusForbidden {
		report.Failures = append(report.Failures, fmt.Sprintf("private HTTP status %d, want 403", status))
	} else {
		report.PrivateHTTPBlocked = true
	}

	connectStatus, err := gate0CONNECT(ctx, proxy.Address(), privateListener.Addr().String())
	if err != nil {
		report.Failures = append(report.Failures, fmt.Sprintf("send private CONNECT request: %v", err))
	} else if !strings.Contains(connectStatus, " 403 ") {
		report.Failures = append(report.Failures, fmt.Sprintf("private CONNECT status %q, want 403", strings.TrimSpace(connectStatus)))
	} else {
		report.PrivateCONNECTBlocked = true
	}

	status, err = gate0GET(ctx, client, "http://169.254.169.254/latest/meta-data/")
	if err != nil {
		report.Failures = append(report.Failures, fmt.Sprintf("send link-local metadata request: %v", err))
	} else if status != http.StatusForbidden {
		report.Failures = append(report.Failures, fmt.Sprintf("link-local metadata status %d, want 403", status))
	} else {
		report.LinkLocalMetadataBlocked = true
	}

	report.PrivateUpstreamUntouched = gate0NoAcceptedConnection(privateAccepted)
	if !report.PrivateUpstreamUntouched {
		report.Failures = append(report.Failures, "blocked private upstream accepted a connection")
	}

	rebindingListener, rebindingAccepted, err := gate0PrivateListener()
	if err != nil {
		report.Failures = append(report.Failures, fmt.Sprintf("open DNS-rebinding upstream listener: %v", err))
		return report
	}
	defer rebindingListener.Close()
	resolver, queryCount, closeDNS, err := gate0RebindingResolver()
	if err != nil {
		report.Failures = append(report.Failures, fmt.Sprintf("start DNS-rebinding responder: %v", err))
		return report
	}
	defer closeDNS()
	rebindingProxy, err := StartEgressProxy(Policy{Resolver: resolver}, nil)
	if err != nil {
		report.Failures = append(report.Failures, fmt.Sprintf("start DNS-rebinding egress proxy: %v", err))
		return report
	}
	defer closeGate0Proxy(rebindingProxy)
	_, port, splitErr := net.SplitHostPort(rebindingListener.Addr().String())
	if splitErr != nil {
		report.Failures = append(report.Failures, fmt.Sprintf("read DNS-rebinding upstream port: %v", splitErr))
		return report
	}
	status, err = gate0GET(ctx, gate0ProxyClient(rebindingProxy.Address()), "http://rebind.aetherops.test:"+port+"/blocked")
	report.DNSRebindingQueries = queryCount.Load()
	if err != nil {
		report.Failures = append(report.Failures, fmt.Sprintf("send DNS-rebinding request: %v", err))
	} else if status != http.StatusBadGateway {
		report.Failures = append(report.Failures, fmt.Sprintf("DNS-rebinding status %d, want 502", status))
	} else if report.DNSRebindingQueries < 2 {
		report.Failures = append(report.Failures, fmt.Sprintf("proxy resolved rebinding host %d time(s), want at least 2", report.DNSRebindingQueries))
	} else {
		report.DNSRebindingBlocked = true
	}
	report.RebindingUpstreamUntouched = gate0NoAcceptedConnection(rebindingAccepted)
	if !report.RebindingUpstreamUntouched {
		report.Failures = append(report.Failures, "DNS-rebinding upstream accepted a connection")
	}
	report.Passed = len(report.Failures) == 0 && report.PrivateHTTPBlocked && report.PrivateCONNECTBlocked &&
		report.PrivateUpstreamUntouched && report.LinkLocalMetadataBlocked && report.DNSRebindingBlocked &&
		report.RebindingUpstreamUntouched
	return report
}

func gate0ProxyClient(address string) *http.Client {
	proxyURL, _ := url.Parse("http://" + address)
	return &http.Client{
		Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)},
		Timeout:   4 * time.Second,
	}
}

func gate0GET(ctx context.Context, client *http.Client, target string) (int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return 0, err
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	return response.StatusCode, nil
}

func gate0CONNECT(ctx context.Context, proxyAddress, target string) (string, error) {
	dialer := net.Dialer{Timeout: 3 * time.Second}
	connection, err := dialer.DialContext(ctx, "tcp", proxyAddress)
	if err != nil {
		return "", err
	}
	defer connection.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	} else {
		_ = connection.SetDeadline(time.Now().Add(3 * time.Second))
	}
	if _, err := fmt.Fprintf(connection, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target); err != nil {
		return "", err
	}
	return bufio.NewReader(connection).ReadString('\n')
}

func gate0PrivateListener() (net.Listener, <-chan struct{}, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, nil, err
	}
	accepted := make(chan struct{}, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		accepted <- struct{}{}
		_ = connection.Close()
	}()
	return listener, accepted, nil
}

func gate0NoAcceptedConnection(accepted <-chan struct{}) bool {
	select {
	case <-accepted:
		return false
	case <-time.After(175 * time.Millisecond):
		return true
	}
}

func closeGate0Proxy(proxy *EgressProxy) {
	shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = proxy.Close(shutdown)
}

func gate0RebindingResolver() (*net.Resolver, *atomic.Int32, func(), error) {
	dns, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		return nil, nil, nil, err
	}
	var aQueries atomic.Int32
	go func() {
		buffer := make([]byte, 2048)
		for {
			count, peer, readErr := dns.ReadFrom(buffer)
			if readErr != nil {
				return
			}
			request := append([]byte(nil), buffer[:count]...)
			response, isA := gate0DNSResponse(request, aQueries.Load() == 0)
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
	return resolver, &aQueries, func() { _ = dns.Close() }, nil
}

func gate0DNSResponse(request []byte, firstPublic bool) ([]byte, bool) {
	if len(request) < 17 {
		return nil, false
	}
	end := 12
	for end < len(request) && request[end] != 0 {
		label := int(request[end])
		if label == 0 || end+1+label >= len(request) {
			return nil, false
		}
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
	response = append(response, []byte{0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 4}...)
	response = append(response, address...)
	return response, true
}
