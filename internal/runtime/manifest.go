package runtime

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// Manifest is the checked-in stable-channel runtime policy. Download URLs,
// hashes, SRI, and signatures are deliberately not inferred from it; those
// arrive as a separately trusted Release.
type Manifest struct {
	Schema             int                `json:"schema"`
	Channel            string             `json:"channel"`
	CheckedAtMostEvery string             `json:"checkedAtMostEvery"`
	Components         ManifestComponents `json:"components"`
}

type ManifestComponents struct {
	Go                GoComponentManifest `json:"go"`
	Codex             ComponentManifest   `json:"codex"`
	Node              ComponentManifest   `json:"node"`
	ChromeDevtoolsMCP ComponentManifest   `json:"chromeDevtoolsMcp"`
	Oxigraph          ComponentManifest   `json:"oxigraph"`
	OpenVSP           ComponentManifest   `json:"openVsp"`
	Gmsh              ComponentManifest   `json:"gmsh"`
	XFOIL             ComponentManifest   `json:"xfoil"`
	SU2               ComponentManifest   `json:"su2"`
	WebView2          WebView2Manifest    `json:"webView2"`
}

type ComponentManifest struct {
	Version string `json:"version"`
	Command string `json:"command,omitempty"`
	Package string `json:"package,omitempty"`
}

type GoComponentManifest struct {
	Version   string `json:"version"`
	BuildOnly bool   `json:"buildOnly"`
}

type WebView2Manifest struct {
	Channel string `json:"channel"`
}

// LoadManifest reads and validates a manifest. Unknown fields are rejected so
// a misspelled policy field cannot silently weaken runtime handling.
func LoadManifest(path string) (Manifest, error) {
	file, err := os.Open(path)
	if err != nil {
		return Manifest{}, err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	var manifest Manifest
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("decode runtime manifest: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return Manifest{}, errors.New("runtime manifest contains multiple JSON values")
		}
		return Manifest{}, fmt.Errorf("decode runtime manifest tail: %w", err)
	}
	if err := manifest.Validate(); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

// Validate enforces the current stable-channel policy shape. Version values
// intentionally remain manifest-controlled so a signed future stable manifest
// can update pins without a hidden hard-coded substitute.
func (m Manifest) Validate() error {
	if m.Schema != 1 {
		return fmt.Errorf("unsupported runtime manifest schema %d", m.Schema)
	}
	if m.Channel != "stable" {
		return fmt.Errorf("runtime manifest channel %q is not stable", m.Channel)
	}
	interval, err := time.ParseDuration(m.CheckedAtMostEvery)
	if err != nil || interval != 24*time.Hour {
		return errors.New("runtime manifest check interval must be exactly 24h")
	}
	if !m.Components.Go.BuildOnly || strings.TrimSpace(m.Components.Go.Version) == "" {
		return errors.New("runtime manifest must declare build-only Go")
	}
	if !safeRuntimeVersion.MatchString(m.Components.Go.Version) {
		return errors.New("runtime manifest Go version is invalid")
	}
	if strings.TrimSpace(m.Components.Node.Version) == "" {
		return errors.New("runtime manifest node version is required")
	}
	if !safeRuntimeVersion.MatchString(m.Components.Node.Version) {
		return errors.New("runtime manifest node version is invalid")
	}
	if strings.TrimSpace(m.Components.Codex.Version) == "" || strings.TrimSpace(m.Components.Codex.Command) != "codex app-server" {
		return errors.New("runtime manifest must declare codex app-server")
	}
	if !safeRuntimeVersion.MatchString(m.Components.Codex.Version) {
		return errors.New("runtime manifest codex version is invalid")
	}
	if strings.TrimSpace(m.Components.ChromeDevtoolsMCP.Version) == "" || m.Components.ChromeDevtoolsMCP.Package != "chrome-devtools-mcp" {
		return errors.New("runtime manifest must declare chrome-devtools-mcp")
	}
	if !safeRuntimeVersion.MatchString(m.Components.ChromeDevtoolsMCP.Version) {
		return errors.New("runtime manifest chrome-devtools-mcp version is invalid")
	}
	if strings.TrimSpace(m.Components.Oxigraph.Version) == "" || m.Components.Oxigraph.Package != "oxigraph" {
		return errors.New("runtime manifest must declare oxigraph")
	}
	if !safeRuntimeVersion.MatchString(m.Components.Oxigraph.Version) {
		return errors.New("runtime manifest oxigraph version is invalid")
	}
	for _, tool := range []struct {
		name     string
		manifest ComponentManifest
		command  string
	}{
		{name: "openvsp", manifest: m.Components.OpenVSP, command: "vspscript.exe"},
		{name: "gmsh", manifest: m.Components.Gmsh, command: "gmsh.exe"},
		{name: "xfoil", manifest: m.Components.XFOIL, command: "xfoil.exe"},
		{name: "su2", manifest: m.Components.SU2, command: "SU2_CFD.exe"},
	} {
		if strings.TrimSpace(tool.manifest.Version) == "" || tool.manifest.Command != tool.command {
			return fmt.Errorf("runtime manifest must declare %s command %q", tool.name, tool.command)
		}
		if !safeRuntimeVersion.MatchString(tool.manifest.Version) {
			return fmt.Errorf("runtime manifest %s version is invalid", tool.name)
		}
		if tool.manifest.Package != "" {
			return fmt.Errorf("runtime manifest %s must be a native tool", tool.name)
		}
	}
	if m.Components.WebView2.Channel != "evergreen" {
		return errors.New("runtime manifest must declare evergreen WebView2")
	}
	return nil
}

// Version returns the stable manifest version for a managed component.
func (m Manifest) Version(component Component) (string, bool) {
	switch component {
	case ComponentNode:
		return m.Components.Node.Version, true
	case ComponentCodex:
		return m.Components.Codex.Version, true
	case ComponentChromeDevtoolsMCP:
		return m.Components.ChromeDevtoolsMCP.Version, true
	case ComponentOxigraph:
		return m.Components.Oxigraph.Version, true
	case ComponentOpenVSP:
		return m.Components.OpenVSP.Version, true
	case ComponentGmsh:
		return m.Components.Gmsh.Version, true
	case ComponentXFOIL:
		return m.Components.XFOIL.Version, true
	case ComponentSU2:
		return m.Components.SU2.Version, true
	default:
		return "", false
	}
}
