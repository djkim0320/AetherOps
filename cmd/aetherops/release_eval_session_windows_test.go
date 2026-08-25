//go:build windows && amd64

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"golang.org/x/sys/windows"
)

func TestReleaseEvalSessionPublishesProtectedDescriptorAndRemovesSecrets(t *testing.T) {
	directory := t.TempDir()
	descriptorPath := filepath.Join(directory, "release-session.json")
	token := "release_session_token_abcdefghijklmnopqrstuvwxyz0123456789"
	build := releaseSessionTestBuild()
	cleanup, err := publishReleaseEvalSessionDescriptor(
		descriptorPath, "http://127.0.0.1:43123", token, build,
	)
	if err != nil {
		t.Fatal(err)
	}
	descriptorRaw, err := os.ReadFile(descriptorPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(descriptorRaw), token) {
		t.Fatal("descriptor contains the bearer token")
	}
	var descriptor releaseEvalSessionDescriptor
	if err := json.Unmarshal(descriptorRaw, &descriptor); err != nil {
		t.Fatal(err)
	}
	if descriptor.Schema != releaseEvalSessionDescriptorSchema || descriptor.ProductBuild != build ||
		descriptor.TokenFile != filepath.Base(descriptorPath)+".token" || descriptor.Mode != "normal" ||
		!descriptor.RuntimeReady || !descriptor.CodexReady || !descriptor.OxigraphReady || !descriptor.APIReady {
		t.Fatalf("descriptor = %+v", descriptor)
	}
	tokenPath := descriptorPath + ".token"
	tokenRaw, err := os.ReadFile(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(tokenRaw)) != token {
		t.Fatal("token file does not contain the exact API token")
	}
	for _, path := range []string{descriptorPath, tokenPath} {
		security, err := windows.GetNamedSecurityInfo(
			path, windows.SE_FILE_OBJECT,
			windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION,
		)
		if err != nil {
			t.Fatal(err)
		}
		control, _, err := security.Control()
		if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
			t.Fatalf("file DACL is not protected: path=%s control=%x err=%v", path, control, err)
		}
		dacl, _, err := security.DACL()
		if err != nil || dacl == nil || dacl.AceCount != 1 {
			t.Fatalf("file DACL does not contain exactly one current-user ACE: path=%s dacl=%+v err=%v", path, dacl, err)
		}
	}
	if _, err := publishReleaseEvalSessionDescriptor(descriptorPath, "http://127.0.0.1:43123", token, build); err == nil {
		t.Fatal("existing descriptor/token pair was overwritten")
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{descriptorPath, tokenPath} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("session secret was not removed: %s err=%v", path, err)
		}
	}
}

func TestParseReleaseEvalSessionArgsRequiresDescriptorOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.json")
	dataRoot := filepath.Join(t.TempDir(), "data")
	parsed, err := parseReleaseEvalSessionArgs([]string{"--descriptor", path, "--data-root", dataRoot})
	if err != nil || parsed.DescriptorPath != path || parsed.DataRoot != dataRoot {
		t.Fatalf("parse result = %+v, %v", parsed, err)
	}
	for _, args := range [][]string{nil, {"--descriptor", path}, {"--data-root", dataRoot}, {"--descriptor", path, "--data-root", dataRoot, "extra"}, {"--unknown"}} {
		if _, err := parseReleaseEvalSessionArgs(args); err == nil {
			t.Fatalf("accepted invalid args: %v", args)
		}
	}
}

func TestParseGate0ArgsRequiresExplicitDataRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "gate0")
	parsed, err := parseGate0Args([]string{"--data-root", root})
	if err != nil || parsed != root {
		t.Fatalf("parse result = %q, %v", parsed, err)
	}
	for _, args := range [][]string{nil, {"--data-root", root, "extra"}, {"--unknown"}} {
		if _, err := parseGate0Args(args); err == nil {
			t.Fatalf("accepted invalid gate0 args: %v", args)
		}
	}
}

func TestOptionalEvaluationDataRootArgsAreExplicit(t *testing.T) {
	root := filepath.Join(t.TempDir(), "evaluation")
	if parsed, err := parseOptionalDataRootArgs("mcp", nil); err != nil || parsed != "" {
		t.Fatalf("production args = %q, %v", parsed, err)
	}
	if parsed, err := parseOptionalDataRootArgs("mcp", []string{"--data-root", root}); err != nil || parsed != root {
		t.Fatalf("evaluation args = %q, %v", parsed, err)
	}
	for _, args := range [][]string{{root}, {"--data-root"}, {"--other", root}, {"--data-root", root, "extra"}} {
		if _, err := parseOptionalDataRootArgs("mcp", args); err == nil {
			t.Fatalf("accepted ambiguous evaluation args: %v", args)
		}
	}
}

func TestReleaseEvalSessionRejectsSecondaryInstanceWithoutActivation(t *testing.T) {
	err := handleSecondaryApplicationInstance(context.Background(), filepath.Join(t.TempDir(), "session.json"))
	if err == nil || !strings.Contains(err.Error(), "new primary") {
		t.Fatalf("secondary release session error = %v", err)
	}
}

func TestReleaseEvaluationCanNeverQualifyThroughSetupMode(t *testing.T) {
	if !setupModeAllowed("") {
		t.Fatal("ordinary product launch unexpectedly lost setup recovery")
	}
	if setupModeAllowed(filepath.Join(t.TempDir(), "readiness.json")) {
		t.Fatal("release evaluation descriptor was allowed to enter setup mode")
	}
}

func releaseSessionTestBuild() buildinfo.ProductBuildBinding {
	return buildinfo.ProductBuildBinding{
		Version:          buildinfo.ReleaseProductVersion,
		ExecutableSHA256: strings.Repeat("1", 64), RuntimeManifestSHA256: strings.Repeat("2", 64),
		KnowledgeSidecarTreeSHA256: strings.Repeat("3", 64),
	}
}
