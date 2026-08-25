package evalrunner

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/evalgate"
)

func TestLoadSessionDescriptorBindsLivePIDExecutableAndSiblingToken(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(executable)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	build := evalgate.ProductBuildBinding{
		Version: evalgate.ReleaseProductVersion, ExecutableSHA256: hex.EncodeToString(hash.Sum(nil)),
		RuntimeManifestSHA256: strings.Repeat("2", 64), KnowledgeSidecarTreeSHA256: strings.Repeat("3", 64),
	}
	directory := t.TempDir()
	descriptorPath := filepath.Join(directory, "session.json")
	tokenPath := descriptorPath + ".token"
	tokenValue := "descriptor_token_abcdefghijklmnopqrstuvwxyz0123456789"
	if err := os.WriteFile(tokenPath, []byte(tokenValue+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	descriptor := SessionDescriptor{
		Schema: SessionDescriptorSchemaV2, Endpoint: "http://127.0.0.1:41234",
		TokenFile: filepath.Base(tokenPath), PID: os.Getpid(), ProductBuild: build, StartedAt: time.Now().UTC(),
		Mode: "normal", BuildMode: "release", RuntimeReady: true, CodexReady: true, OxigraphReady: true, APIReady: true,
	}
	raw, err := json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(descriptorPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, token, err := LoadSessionDescriptor(descriptorPath, build)
	if err != nil {
		t.Fatal(err)
	}
	defer ZeroToken(token)
	if loaded.Endpoint != descriptor.Endpoint || string(token) != tokenValue {
		t.Fatalf("descriptor=%+v token match=%v", loaded, string(token) == tokenValue)
	}

	descriptor.PID = 0x7ffffffe
	raw, err = json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(descriptorPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := LoadSessionDescriptor(descriptorPath, build); err == nil || !strings.Contains(err.Error(), "not running") {
		t.Fatalf("stale PID error = %v", err)
	}
}
