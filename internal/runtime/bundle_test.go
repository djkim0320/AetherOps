package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSealBundleCreatesVerifiedActiveRuntime(t *testing.T) {
	root := t.TempDir()
	manifest := testManifest()
	specs := []BundleComponentSpec{
		{Component: ComponentNode, Version: PinnedNodeVersion, PayloadSHA256: strings.Repeat("1", 64), Entrypoint: "node.exe"},
		{Component: ComponentCodex, Version: PinnedCodexVersion, PayloadSHA256: strings.Repeat("2", 64), Entrypoint: "bin/codex.js"},
		{Component: ComponentChromeDevtoolsMCP, Version: PinnedChromeDevtoolsMCPVersion, PayloadSHA256: strings.Repeat("3", 64), Entrypoint: "build/mcp.js"},
		{Component: ComponentOxigraph, Version: PinnedOxigraphVersion, PayloadSHA256: strings.Repeat("4", 64), Entrypoint: "node_modules/oxigraph/package.json"},
		{Component: ComponentOpenVSP, Version: PinnedOpenVSPVersion, PayloadSHA256: strings.Repeat("5", 64), Entrypoint: "vspscript.exe"},
		{Component: ComponentGmsh, Version: PinnedGmshVersion, PayloadSHA256: strings.Repeat("6", 64), Entrypoint: "gmsh.exe"},
		{Component: ComponentXFOIL, Version: PinnedXFOILVersion, PayloadSHA256: strings.Repeat("7", 64), Entrypoint: "xfoil.exe"},
		{Component: ComponentSU2, Version: PinnedSU2Version, PayloadSHA256: strings.Repeat("8", 64), Entrypoint: "SU2_CFD.exe"},
	}
	for _, spec := range specs {
		path := filepath.Join(root, "versions", string(spec.Component), spec.Version, filepath.FromSlash(spec.Entrypoint))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("verified "+string(spec.Component)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, companion := range []struct {
		component Component
		version   string
		name      string
	}{
		{component: ComponentOpenVSP, version: PinnedOpenVSPVersion, name: "vspaero.exe"},
		{component: ComponentOpenVSP, version: PinnedOpenVSPVersion, name: "vspaero_opt.exe"},
		{component: ComponentSU2, version: PinnedSU2Version, name: "SU2_SOL.exe"},
	} {
		path := filepath.Join(root, "versions", string(companion.component), companion.version, companion.name)
		if err := os.WriteFile(path, []byte("verified "+companion.name), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	installedAt := time.Date(2026, time.August, 7, 10, 30, 0, 0, time.UTC)
	active, err := SealBundle(root, manifest, "bundled-test", installedAt, specs)
	if err != nil {
		t.Fatal(err)
	}
	if active.ActivatedAt != installedAt || active.Versions[ComponentCodex] != PinnedCodexVersion {
		t.Fatalf("unexpected active state: %#v", active)
	}
	manager, err := Open(root, manifest, Options{})
	if err != nil {
		t.Fatal(err)
	}
	paths, err := manager.ProcessPaths()
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(paths.NodeExecutable) != "node.exe" || len(paths.CodexAppServer.Args) != 2 || paths.CodexAppServer.Args[1] != "app-server" {
		t.Fatalf("unexpected process paths: %#v", paths)
	}
	if filepath.Base(paths.OxigraphPackageEntrypoint) != "package.json" ||
		filepath.Base(paths.OxigraphModuleDirectory) != "oxigraph" ||
		filepath.Dir(paths.OxigraphPackageEntrypoint) != paths.OxigraphModuleDirectory {
		t.Fatalf("unexpected Oxigraph process paths: %#v", paths)
	}
	for name, path := range map[string]string{
		"vspscript":   paths.OpenVSPScriptExecutable,
		"vspaero":     paths.VSPAEROExecutable,
		"vspaero_opt": paths.VSPAEROOptExecutable,
		"gmsh":        paths.GmshExecutable,
		"xfoil":       paths.XFOILExecutable,
		"su2_cfd":     paths.SU2CFDExecutable,
		"su2_sol":     paths.SU2SOLExecutable,
	} {
		if path == "" {
			t.Fatalf("verified %s path is empty: %#v", name, paths)
		}
	}

	packagedRoot := filepath.Join(t.TempDir(), "runtime")
	packagedActive, err := MaterializePackagedBundle(root, packagedRoot, manifest)
	if err != nil {
		t.Fatal(err)
	}
	if len(packagedActive.ComponentRoots) != len(specs) || packagedActive.ComponentRoots[ComponentChromeDevtoolsMCP] != "b/d" {
		t.Fatalf("unexpected compact component roots: %#v", packagedActive.ComponentRoots)
	}
	packagedPaths, err := ResolveProcessPathsReadOnly(packagedRoot, manifest)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		packagedPaths.NodeExecutable,
		packagedPaths.CodexEntrypoint,
		packagedPaths.ChromeDevtoolsMCPEntrypoint,
		packagedPaths.OxigraphPackageEntrypoint,
		packagedPaths.OpenVSPScriptExecutable,
		packagedPaths.GmshExecutable,
		packagedPaths.XFOILExecutable,
		packagedPaths.SU2CFDExecutable,
	} {
		if !strings.HasPrefix(path, filepath.Join(packagedRoot, "b")+string(filepath.Separator)) {
			t.Fatalf("packaged process path did not use compact authenticated root: %s", path)
		}
	}
	if _, err := MaterializePackagedBundle(root, packagedRoot, manifest); err == nil || !strings.Contains(err.Error(), "must be empty") {
		t.Fatalf("non-empty packaged destination was accepted: %v", err)
	}
	if _, err := MaterializePackagedBundle(root, filepath.Join(root, "nested-package"), manifest); err == nil || !strings.Contains(err.Error(), "must not overlap") {
		t.Fatalf("overlapping packaged destination was accepted: %v", err)
	}

	packagedActive.ComponentRoots[ComponentChromeDevtoolsMCP] = "../outside"
	if err := writeJSONAtomic(filepath.Join(packagedRoot, "active.json"), packagedActive); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveProcessPathsReadOnly(packagedRoot, manifest); err == nil || !strings.Contains(err.Error(), "packaged runtime root is invalid") {
		t.Fatalf("tampered packaged component root was accepted: %v", err)
	}

	if err := os.WriteFile(paths.CodexEntrypoint, []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.ProcessPaths(); err == nil || !strings.Contains(err.Error(), "content hash mismatch") {
		t.Fatalf("tampered bundle was accepted: %v", err)
	}
}
