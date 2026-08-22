package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	managedruntime "github.com/djkim0320/Aether-claw/internal/runtime"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	mode := flag.String("mode", "verify", "verify, seal, or package-layout")
	root := flag.String("root", "", "managed runtime root")
	out := flag.String("out", "", "compact packaged runtime output root")
	manifestPath := flag.String("manifest", "", "runtime manifest path")
	candidate := flag.String("candidate", "bundled-v0.1.0-alpha.1", "bundle candidate id")
	nodePayload := flag.String("node-payload-sha256", "", "verified Node payload SHA-256")
	codexPayload := flag.String("codex-payload-sha256", "", "verified Codex install receipt SHA-256")
	mcpPayload := flag.String("mcp-payload-sha256", "", "verified Chrome DevTools MCP install receipt SHA-256")
	oxigraphPayload := flag.String("oxigraph-payload-sha256", "", "verified Oxigraph install receipt SHA-256")
	openVSPPayload := flag.String("openvsp-payload-sha256", "", "verified OpenVSP archive SHA-256")
	gmshPayload := flag.String("gmsh-payload-sha256", "", "verified Gmsh archive SHA-256")
	xfoilPayload := flag.String("xfoil-payload-sha256", "", "verified XFOIL archive SHA-256")
	su2Payload := flag.String("su2-payload-sha256", "", "verified SU2 archive SHA-256")
	flag.Parse()
	if *root == "" || *manifestPath == "" {
		return fmt.Errorf("-root and -manifest are required")
	}
	manifest, err := managedruntime.LoadManifest(*manifestPath)
	if err != nil {
		return err
	}
	switch *mode {
	case "verify":
		manager, err := managedruntime.Open(*root, manifest, managedruntime.Options{})
		if err != nil {
			return err
		}
		paths, err := manager.ProcessPaths()
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(paths)
	case "package-layout":
		if *out == "" {
			return fmt.Errorf("-out is required for package-layout mode")
		}
		active, err := managedruntime.MaterializePackagedBundle(*root, *out, manifest)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(active)
	case "seal":
		hashes := map[managedruntime.Component]string{
			managedruntime.ComponentNode:              *nodePayload,
			managedruntime.ComponentCodex:             *codexPayload,
			managedruntime.ComponentChromeDevtoolsMCP: *mcpPayload,
			managedruntime.ComponentOxigraph:          *oxigraphPayload,
			managedruntime.ComponentOpenVSP:           *openVSPPayload,
			managedruntime.ComponentGmsh:              *gmshPayload,
			managedruntime.ComponentXFOIL:             *xfoilPayload,
			managedruntime.ComponentSU2:               *su2Payload,
		}
		active, err := managedruntime.SealBundle(*root, manifest, *candidate, time.Now().UTC(), bundleSpecs(manifest, hashes))
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(active)
	default:
		return fmt.Errorf("unsupported mode %q", *mode)
	}
}

func bundleSpecs(manifest managedruntime.Manifest, hashes map[managedruntime.Component]string) []managedruntime.BundleComponentSpec {
	return []managedruntime.BundleComponentSpec{
		{Component: managedruntime.ComponentNode, Version: manifest.Components.Node.Version, PayloadSHA256: hashes[managedruntime.ComponentNode], Entrypoint: "node.exe"},
		{Component: managedruntime.ComponentCodex, Version: manifest.Components.Codex.Version, PayloadSHA256: hashes[managedruntime.ComponentCodex], Entrypoint: "node_modules/@openai/codex/bin/codex.js"},
		{Component: managedruntime.ComponentChromeDevtoolsMCP, Version: manifest.Components.ChromeDevtoolsMCP.Version, PayloadSHA256: hashes[managedruntime.ComponentChromeDevtoolsMCP], Entrypoint: "node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js"},
		{Component: managedruntime.ComponentOxigraph, Version: manifest.Components.Oxigraph.Version, PayloadSHA256: hashes[managedruntime.ComponentOxigraph], Entrypoint: "node_modules/oxigraph/package.json"},
		{Component: managedruntime.ComponentOpenVSP, Version: manifest.Components.OpenVSP.Version, PayloadSHA256: hashes[managedruntime.ComponentOpenVSP], Entrypoint: "vspscript.exe"},
		{Component: managedruntime.ComponentGmsh, Version: manifest.Components.Gmsh.Version, PayloadSHA256: hashes[managedruntime.ComponentGmsh], Entrypoint: "gmsh.exe"},
		{Component: managedruntime.ComponentXFOIL, Version: manifest.Components.XFOIL.Version, PayloadSHA256: hashes[managedruntime.ComponentXFOIL], Entrypoint: "xfoil.exe"},
		{Component: managedruntime.ComponentSU2, Version: manifest.Components.SU2.Version, PayloadSHA256: hashes[managedruntime.ComponentSU2], Entrypoint: "SU2_CFD.exe"},
	}
}
