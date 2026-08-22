package browser

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type EgressProxy struct {
	policy    Policy
	logger    *slog.Logger
	server    *http.Server
	listener  net.Listener
	transport *http.Transport
}

func StartEgressProxy(policy Policy, logger *slog.Logger) (*EgressProxy, error) {
	if logger == nil {
		logger = slog.Default()
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	proxy := &EgressProxy{policy: policy, logger: logger, listener: listener}
	proxy.transport = &http.Transport{
		Proxy:                 nil,
		DialContext:           policy.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          32,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	proxy.server = &http.Server{
		Handler:           proxy,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		if err := proxy.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("browser egress proxy stopped", "error", err)
		}
	}()
	return proxy, nil
}

func (proxy *EgressProxy) Address() string {
	return proxy.listener.Addr().String()
}

func (proxy *EgressProxy) Close(ctx context.Context) error {
	proxy.transport.CloseIdleConnections()
	return proxy.server.Shutdown(ctx)
}

func (proxy *EgressProxy) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodConnect {
		proxy.connect(writer, request)
		return
	}
	if request.URL == nil || request.URL.Hostname() == "" {
		http.Error(writer, "absolute URL required", http.StatusBadRequest)
		return
	}
	if err := proxy.policy.ValidateURL(request.Context(), request.URL.String()); err != nil {
		http.Error(writer, "destination blocked", http.StatusForbidden)
		return
	}
	outbound := request.Clone(request.Context())
	outbound.RequestURI = ""
	outbound.Header = request.Header.Clone()
	removeHopHeaders(outbound.Header)
	response, err := proxy.transport.RoundTrip(outbound)
	if err != nil {
		http.Error(writer, "upstream request failed", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	removeHopHeaders(response.Header)
	for key, values := range response.Header {
		for _, value := range values {
			writer.Header().Add(key, value)
		}
	}
	writer.WriteHeader(response.StatusCode)
	_, _ = io.Copy(writer, response.Body)
}

func (proxy *EgressProxy) connect(writer http.ResponseWriter, request *http.Request) {
	host := request.Host
	if !strings.Contains(host, ":") {
		host += ":443"
	}
	upstream, err := proxy.policy.DialContext(request.Context(), "tcp", host)
	if err != nil {
		http.Error(writer, "destination blocked", http.StatusForbidden)
		return
	}
	hijacker, ok := writer.(http.Hijacker)
	if !ok {
		_ = upstream.Close()
		http.Error(writer, "hijacking unavailable", http.StatusInternalServerError)
		return
	}
	client, buffer, err := hijacker.Hijack()
	if err != nil {
		_ = upstream.Close()
		return
	}
	if _, err := buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		_ = client.Close()
		_ = upstream.Close()
		return
	}
	if err := buffer.Flush(); err != nil {
		_ = client.Close()
		_ = upstream.Close()
		return
	}
	go tunnel(client, upstream, buffer.Reader)
}

func tunnel(client, upstream net.Conn, buffered *bufio.Reader) {
	defer client.Close()
	defer upstream.Close()
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		_, _ = io.Copy(upstream, buffered)
	}()
	go func() {
		defer wait.Done()
		_, _ = io.Copy(client, upstream)
	}()
	wait.Wait()
}

func removeHopHeaders(header http.Header) {
	for _, key := range []string{
		"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
		"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
	} {
		header.Del(key)
	}
}
