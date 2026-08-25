//go:build windows && amd64

package gate0windows

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/browser"
	"github.com/djkim0320/AetherOps/internal/desktop"
	managedruntime "github.com/djkim0320/AetherOps/internal/runtime"
)

// This opt-in test is the complete actual Windows harness. It is skipped in
// source-only CI because a verified packaged runtime is intentionally not
// substituted with system Node or an unpinned MCP command.
func TestActualPackagedWindowsGate0Harness(t *testing.T) {
	runtimeRoot := os.Getenv("AETHEROPS_GATE0_RUNTIME_ROOT")
	manifestPath := os.Getenv("AETHEROPS_GATE0_RUNTIME_MANIFEST")
	if runtimeRoot == "" || manifestPath == "" {
		t.Skip("set AETHEROPS_GATE0_RUNTIME_ROOT and AETHEROPS_GATE0_RUNTIME_MANIFEST to an exact packaged candidate")
	}
	manifest, err := managedruntime.LoadManifest(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	processPaths, err := managedruntime.ResolveProcessPathsReadOnly(runtimeRoot, manifest)
	if err != nil {
		t.Fatal(err)
	}
	proxy, err := browser.StartEgressProxy(browser.Policy{}, slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = proxy.Close(shutdown)
	})
	dataRoot := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	report, gateErr := Run(ctx, Options{
		Config: desktop.Config{
			ApplicationID:       "AetherOps.Gate0.ActualTest",
			WindowTitle:         "AetherOps Gate 0 Actual Test",
			ShellUserDataDir:    filepath.Join(dataRoot, "shell"),
			InternetUserDataDir: filepath.Join(dataRoot, "internet"),
			InternetProxyURL:    "http://" + proxy.Address(),
			DownloadDir:         filepath.Join(dataRoot, "downloads"),
			StartHidden:         true,
		},
		RuntimePaths: processPaths,
	})
	encoded, _ := json.MarshalIndent(report, "", "  ")
	t.Log(string(encoded))
	if gateErr != nil || !report.Compliant || !report.Operational.Compliant {
		t.Fatalf("actual packaged Windows Gate 0 failed: %v", gateErr)
	}
}
