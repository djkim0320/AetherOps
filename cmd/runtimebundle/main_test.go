package main

import (
	"path/filepath"
	"strings"
	"testing"

	managedruntime "github.com/djkim0320/AetherOps/internal/runtime"
)

func TestBundleSpecsCoverPinnedManagedRuntimeSet(t *testing.T) {
	manifest, err := managedruntime.LoadManifest(filepath.Join("..", "..", "runtime-manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	hashes := map[managedruntime.Component]string{
		managedruntime.ComponentNode:              strings.Repeat("1", 64),
		managedruntime.ComponentCodex:             strings.Repeat("2", 64),
		managedruntime.ComponentChromeDevtoolsMCP: strings.Repeat("3", 64),
		managedruntime.ComponentOxigraph:          strings.Repeat("4", 64),
		managedruntime.ComponentOpenVSP:           strings.Repeat("5", 64),
		managedruntime.ComponentGmsh:              strings.Repeat("6", 64),
		managedruntime.ComponentXFOIL:             strings.Repeat("7", 64),
		managedruntime.ComponentSU2:               strings.Repeat("8", 64),
	}
	specs := bundleSpecs(manifest, hashes)
	if len(specs) != len(hashes) {
		t.Fatalf("bundle spec count = %d, want %d", len(specs), len(hashes))
	}
	wantEntrypoints := map[managedruntime.Component]string{
		managedruntime.ComponentNode:              "node.exe",
		managedruntime.ComponentCodex:             "node_modules/@openai/codex/bin/codex.js",
		managedruntime.ComponentChromeDevtoolsMCP: "node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
		managedruntime.ComponentOxigraph:          "node_modules/oxigraph/package.json",
		managedruntime.ComponentOpenVSP:           "vspscript.exe",
		managedruntime.ComponentGmsh:              "gmsh.exe",
		managedruntime.ComponentXFOIL:             "xfoil.exe",
		managedruntime.ComponentSU2:               "SU2_CFD.exe",
	}
	seen := make(map[managedruntime.Component]bool, len(specs))
	for _, spec := range specs {
		if seen[spec.Component] {
			t.Fatalf("duplicate bundle component %q", spec.Component)
		}
		seen[spec.Component] = true
		version, ok := manifest.Version(spec.Component)
		if !ok || spec.Version != version || spec.PayloadSHA256 != hashes[spec.Component] || spec.Entrypoint != wantEntrypoints[spec.Component] {
			t.Fatalf("invalid bundle spec: %#v", spec)
		}
	}
}
