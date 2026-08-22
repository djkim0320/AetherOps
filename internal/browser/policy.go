package browser

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"strings"
)

type Policy struct {
	AllowedLocalHosts map[string]bool
	Resolver          *net.Resolver
}

func (policy Policy) ValidateURL(ctx context.Context, rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	switch parsed.Scheme {
	case "http", "https":
	default:
		return fmt.Errorf("blocked URL scheme %q", parsed.Scheme)
	}
	if parsed.User != nil {
		return errors.New("URLs containing credentials are blocked")
	}
	return policy.ValidateHost(ctx, parsed.Hostname())
}

func (policy Policy) ValidateHost(ctx context.Context, host string) error {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if host == "" {
		return errors.New("host is empty")
	}
	if policy.AllowedLocalHosts[host] {
		return nil
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return errors.New("loopback hosts are blocked")
	}
	if address, err := netip.ParseAddr(host); err == nil {
		return validatePublicAddress(address.Unmap())
	}
	resolver := policy.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	addresses, err := resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return fmt.Errorf("resolve host: %w", err)
	}
	if len(addresses) == 0 {
		return errors.New("host resolved to no addresses")
	}
	for _, address := range addresses {
		if err := validatePublicAddress(address.Unmap()); err != nil {
			return fmt.Errorf("blocked resolved address for %s: %w", host, err)
		}
	}
	return nil
}

func validatePublicAddress(address netip.Addr) error {
	if !address.IsValid() || address.IsUnspecified() || address.IsLoopback() ||
		address.IsPrivate() || address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() ||
		address.IsMulticast() {
		return fmt.Errorf("%s is not public", address)
	}
	blocked := []netip.Prefix{
		netip.MustParsePrefix("0.0.0.0/8"),
		netip.MustParsePrefix("100.64.0.0/10"),
		netip.MustParsePrefix("192.0.0.0/24"),
		netip.MustParsePrefix("198.18.0.0/15"),
		netip.MustParsePrefix("224.0.0.0/4"),
		netip.MustParsePrefix("240.0.0.0/4"),
		netip.MustParsePrefix("2001:db8::/32"),
	}
	for _, prefix := range blocked {
		if prefix.Contains(address) {
			return fmt.Errorf("%s is in blocked range %s", address, prefix)
		}
	}
	return nil
}

func (policy Policy) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	if err := policy.ValidateHost(ctx, host); err != nil {
		return nil, err
	}
	normalizedHost := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if policy.AllowedLocalHosts[normalizedHost] {
		var dialer net.Dialer
		return dialer.DialContext(ctx, network, net.JoinHostPort(host, port))
	}
	resolver := policy.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	if literal, parseErr := netip.ParseAddr(host); parseErr == nil {
		var dialer net.Dialer
		return dialer.DialContext(ctx, network, net.JoinHostPort(literal.String(), port))
	}
	addresses, err := resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	var dialer net.Dialer
	var lastErr error
	for _, candidate := range addresses {
		candidate = candidate.Unmap()
		if err := validatePublicAddress(candidate); err != nil {
			return nil, err
		}
		connection, err := dialer.DialContext(ctx, network, net.JoinHostPort(candidate.String(), port))
		if err == nil {
			return connection, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("no public address available")
	}
	return nil, lastErr
}
