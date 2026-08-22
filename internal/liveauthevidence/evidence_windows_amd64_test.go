//go:build windows && amd64

package liveauthevidence

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
	"unsafe"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/evalrunner"
	"github.com/djkim0320/Aether-claw/internal/releasegate"
	"golang.org/x/sys/windows"
)

func TestProtectedSessionFileRequiresCurrentUserOnlyDACL(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Skip("release-session DACL evidence requires the interactive product user account")
	}
	root := t.TempDir()
	protected := filepath.Join(root, "protected.json")
	if err := createProtectedTestFile(protected, []byte("{}\n")); err != nil {
		t.Fatal(err)
	}
	if err := validateProtectedCurrentUserFile(protected); err != nil {
		t.Fatalf("product-compatible protected file was rejected: %v", err)
	}
	ordinary := filepath.Join(root, "ordinary.json")
	if err := os.WriteFile(ordinary, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateProtectedCurrentUserFile(ordinary); err == nil {
		t.Fatal("ordinary inherited-DACL file was accepted as a protected release session secret")
	}
}

func TestGenerateRejectsUnprotectedDescriptorWithoutLeakingTokenOrWritingOutput(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "aetherops.exe")
	currentExecutable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := copyTestFile(currentExecutable, executable); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(root, "runtime-manifest.json")
	if err := os.WriteFile(manifest, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sidecarDirectory := filepath.Join(root, "knowledge-sidecar")
	if err := os.MkdirAll(sidecarDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"index.cjs", "protocol.cjs", "worker.cjs"} {
		if err := os.WriteFile(filepath.Join(sidecarDirectory, name), []byte("module.exports = {};\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	build, err := buildinfo.BindProductBuild(executable, manifest, filepath.Join(sidecarDirectory, "index.cjs"))
	if err != nil {
		t.Fatal(err)
	}
	ledger, err := releasegate.PrepareLedger(build, time.Now().UTC().Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	ledgerPath := filepath.Join(root, "ledger-r1.json")
	writeTestJSON(t, ledgerPath, ledger)
	descriptorPath := filepath.Join(root, "release-session.json")
	tokenPath := descriptorPath + ".token"
	secret := "live_auth_token_abcdefghijklmnopqrstuvwxyz0123456789"
	if err := os.WriteFile(tokenPath, []byte(secret+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	descriptor := evalrunner.SessionDescriptor{
		Schema: evalrunner.SessionDescriptorSchemaV2, Endpoint: "http://127.0.0.1:9",
		TokenFile: filepath.Base(tokenPath), PID: os.Getpid(), ProductBuild: build, StartedAt: time.Now().UTC().Add(-time.Second),
		Mode: "normal", BuildMode: "release", RuntimeReady: true, CodexReady: true, OxigraphReady: true, APIReady: true,
	}
	writeTestJSON(t, descriptorPath, descriptor)
	output := filepath.Join(root, "live-auth.receipt.json")
	_, err = Generate(context.Background(), Config{
		LedgerPath: ledgerPath, OutputPath: output, SessionDescriptorPath: descriptorPath,
		AetherOpsExecutablePath: executable, RuntimeManifestPath: manifest,
		KnowledgeSidecarEntrypoint: filepath.Join(sidecarDirectory, "index.cjs"),
	})
	if err == nil {
		t.Fatal("unprotected descriptor fixture produced live auth evidence")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatal("producer error leaked the bearer token")
	}
	for _, path := range []string{output, filepath.Join(root, "live-auth.receipt.details.json")} {
		if _, statErr := os.Lstat(path); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatalf("rejected descriptor created output %s: %v", path, statErr)
		}
	}
}

func TestConfigHasNoEndpointTokenModelOrResultInjectionSurface(t *testing.T) {
	typeOf := reflect.TypeOf(Config{})
	want := []string{
		"LedgerPath", "OutputPath", "SessionDescriptorPath", "AetherOpsExecutablePath",
		"RuntimeManifestPath", "KnowledgeSidecarEntrypoint",
	}
	if typeOf.NumField() != len(want) {
		t.Fatalf("live auth producer config gained an injection surface: %+v", typeOf)
	}
	for index, name := range want {
		if typeOf.Field(index).Name != name || typeOf.Field(index).Type.Kind() != reflect.String {
			t.Fatalf("unexpected live auth producer config field %d: %+v", index, typeOf.Field(index))
		}
	}
}

func createProtectedTestFile(path string, content []byte) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;;GA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return err
	}
	security := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: descriptor}
	pointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(
		pointer, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, security,
		windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0,
	)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(handle), path)
	if file == nil {
		_ = windows.CloseHandle(handle)
		return errors.New("wrap protected test file")
	}
	if _, err := file.Write(content); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func copyTestFile(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	return errors.Join(copyErr, output.Close())
}

func writeTestJSON(t *testing.T, path string, value any) {
	t.Helper()
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}
