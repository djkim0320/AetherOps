package browser

import (
	"context"
	"net"
	"testing"
)

func TestPolicyBlocksPrivateDestinations(t *testing.T) {
	policy := Policy{}
	blocked := []string{
		"http://127.0.0.1/",
		"http://10.0.0.1/",
		"http://169.254.169.254/latest/meta-data/",
		"file:///C:/Windows/System32/",
	}
	for _, candidate := range blocked {
		if err := policy.ValidateURL(context.Background(), candidate); err == nil {
			t.Fatalf("expected %s to be blocked", candidate)
		}
	}
}

func TestPolicyAllowsExplicitLocalOrigin(t *testing.T) {
	policy := Policy{AllowedLocalHosts: map[string]bool{"127.0.0.1": true}}
	if err := policy.ValidateURL(context.Background(), "http://127.0.0.1:4321/"); err != nil {
		t.Fatal(err)
	}
}

func TestDialAllowsOnlyExplicitLocalHost(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	allowed := Policy{AllowedLocalHosts: map[string]bool{"127.0.0.1": true}}
	connection, err := allowed.DialContext(context.Background(), "tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	connection.Close()
	blocked := Policy{}
	if _, err := blocked.DialContext(context.Background(), "tcp", listener.Addr().String()); err == nil {
		t.Fatal("non-allowlisted loopback dial succeeded")
	}
}
