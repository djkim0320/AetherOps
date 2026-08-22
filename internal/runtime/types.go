// Package runtime manages the small, pinned set of external runtimes used by
// AetherOps. It intentionally has no PATH lookup or system-runtime fallback:
// only an explicitly verified active runtime may be launched.
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"time"
)

const (
	// Pinned versions are the versions in the checked-in runtime manifest. The
	// manifest remains the update policy; these constants make the current
	// baseline visible to callers and tests without guessing a PATH version.
	PinnedCodexVersion             = "0.146.1"
	PinnedNodeVersion              = "24.19.0"
	PinnedChromeDevtoolsMCPVersion = "1.6.0"
	PinnedOxigraphVersion          = "0.5.9"
	PinnedOpenVSPVersion           = "3.50.4"
	PinnedGmshVersion              = "4.14.1"
	PinnedXFOILVersion             = "6.99"
	PinnedSU2Version               = "8.5.0"

	stateSchema = 1
)

var (
	ErrNoActiveRuntime       = errors.New("no verified managed runtime is active")
	ErrSignatureVerifier     = errors.New("runtime signature verifier is required")
	ErrCompatibilityProbe    = errors.New("runtime compatibility probe is required")
	ErrPendingCandidate      = errors.New("runtime candidate is not pending activation")
	ErrCandidateQuarantined  = errors.New("runtime candidate is quarantined")
	ErrActiveVersionMismatch = errors.New("active runtime does not match the stable manifest")
)

// Component identifies one managed runtime. The values below are a
// single compatibility set and are always staged together.
type Component string

const (
	ComponentNode              Component = "node"
	ComponentCodex             Component = "codex"
	ComponentChromeDevtoolsMCP Component = "chrome-devtools-mcp"
	ComponentOxigraph          Component = "oxigraph"
	ComponentOpenVSP           Component = "openvsp"
	ComponentGmsh              Component = "gmsh"
	ComponentXFOIL             Component = "xfoil"
	ComponentSU2               Component = "su2"
)

func managedComponents() []Component {
	return []Component{
		ComponentNode,
		ComponentCodex,
		ComponentChromeDevtoolsMCP,
		ComponentOxigraph,
		ComponentOpenVSP,
		ComponentGmsh,
		ComponentXFOIL,
		ComponentSU2,
	}
}

// CandidateStatus is monotonic during normal operation. Activation recovery
// may restore the previous active audit from superseded to active while it
// quarantines the interrupted target. A quarantined candidate is terminal.
type CandidateStatus string

const (
	CandidateDownloading CandidateStatus = "downloading"
	CandidateVerifying   CandidateStatus = "verifying"
	CandidatePending     CandidateStatus = "pending"
	CandidateActive      CandidateStatus = "active"
	CandidateSuperseded  CandidateStatus = "superseded"
	CandidateQuarantined CandidateStatus = "quarantined"
)

// ArchiveFormat describes the verified artifact container. There is no
// implicit archive format or extraction fallback.
type ArchiveFormat string

const (
	ArchiveFile  ArchiveFormat = "file"
	ArchiveZIP   ArchiveFormat = "zip"
	ArchiveTarGZ ArchiveFormat = "tar.gz"
)

// Artifact supplies the trust metadata for one runtime download. URL, SHA256,
// and signature verification are all mandatory. npm packages also require
// NPMIntegrity, the registry's SRI digest.
type Artifact struct {
	Component Component
	Version   string

	URL       string
	SHA256    string
	Signature json.RawMessage

	// NPMPackage and NPMIntegrity are required for Codex, Chrome DevTools MCP,
	// and Oxigraph because they are installed from npm package artifacts.
	NPMPackage   string
	NPMIntegrity string

	Archive         ArchiveFormat
	StripComponents int
	// Entrypoint is the relative path after extraction. For file artifacts it
	// is also the destination filename inside the installed runtime directory.
	Entrypoint string

	// MaxBytes and MaxExtractBytes bound untrusted network and archive input.
	// Zero uses a conservative package default; negative values are invalid.
	MaxBytes        int64
	MaxExtractBytes int64
}

// Release is an all-or-nothing stable compatibility set. A partial update is
// rejected before any download begins.
type Release struct {
	ID        string
	Channel   string
	Artifacts []Artifact
}

// SignatureInput is passed to the caller-provided trust-root verifier after
// the payload has been durably written and its hashes have been checked.
// ArtifactPath is an absolute path to the verified candidate payload.
type SignatureInput struct {
	CandidateID  string
	Artifact     Artifact
	ArtifactPath string
	SHA256       string
}

// SignatureVerifier must verify an artifact against the product's configured
// trust root. A nil verifier, or any returned error, prevents pending or
// active state. The manager never treats a checksum as a substitute for a
// signature.
type SignatureVerifier func(context.Context, SignatureInput) error

// Command is an executable path plus argv. It is safe to pass directly to
// exec.Command without a shell.
type Command struct {
	Path string
	Args []string
}

// ProcessPaths contains only paths from the verified active version set.
// Codex, the browser MCP, and the Oxigraph knowledge sidecar run through the
// pinned Node executable. Native engineering tools are resolved directly from
// their independently hashed component trees; no field is populated from PATH.
type ProcessPaths struct {
	NodeExecutable              string
	CodexEntrypoint             string
	ChromeDevtoolsMCPEntrypoint string
	OxigraphPackageEntrypoint   string
	OxigraphModuleDirectory     string
	OpenVSPScriptExecutable     string
	VSPAEROExecutable           string
	VSPAEROOptExecutable        string
	GmshExecutable              string
	XFOILExecutable             string
	SU2CFDExecutable            string
	SU2SOLExecutable            string
	CodexAppServer              Command
	ChromeDevtoolsMCP           Command
}

// ProbeEvidence records an actually executed compatibility check. Both checks
// must be marked Executed and Compatible, and include a non-empty observation.
// This type deliberately does not claim that a unit-test callback is a product
// release certification; production must supply a probe connected to the live
// App Server and browser environment.
type ProbeEvidence struct {
	Executed    bool      `json:"executed"`
	Compatible  bool      `json:"compatible"`
	Observation string    `json:"observation"`
	ObservedAt  time.Time `json:"observedAt"`
}

// ProbeReport is persisted with a pending candidate as the evidence required
// for activation on the following application restart.
type ProbeReport struct {
	AppServer ProbeEvidence `json:"appServer"`
	Browser   ProbeEvidence `json:"browser"`
}

// CompatibilityProbe must exercise both the candidate App Server and the
// actual browser/MCP compatibility path. It is intentionally required rather
// than defaulting to a mock or a version-string check.
type CompatibilityProbe interface {
	Probe(context.Context, ProcessPaths) (ProbeReport, error)
}

// ProbeFunc adapts a function for integration code. It is useful for wiring a
// real WebView2/CDP probe; tests using it exercise state transitions only and
// must not be represented as end-to-end release validation.
type ProbeFunc func(context.Context, ProcessPaths) (ProbeReport, error)

func (f ProbeFunc) Probe(ctx context.Context, paths ProcessPaths) (ProbeReport, error) {
	return f(ctx, paths)
}

// Layout names all persisted runtime state. Root is normally the parent of
// appdata.Paths.ManagedRuntimes and appdata.Paths.RuntimeCandidates.
type Layout struct {
	Root       string
	Candidates string
	Versions   string
	Active     string
	Activation string
	Checks     string
	Warnings   string
}

// NewLayout creates a layout rooted at root. It does not create directories;
// Open does that after validating the manifest.
func NewLayout(root string) (Layout, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return Layout{}, err
	}
	return Layout{
		Root:       absolute,
		Candidates: filepath.Join(absolute, "candidates"),
		Versions:   filepath.Join(absolute, "versions"),
		Active:     filepath.Join(absolute, "active.json"),
		Activation: filepath.Join(absolute, "activation.json"),
		Checks:     filepath.Join(absolute, "checks.json"),
		Warnings:   filepath.Join(absolute, "warnings.json"),
	}, nil
}

// Options controls the externally supplied trust and compatibility checks.
// None of the security-critical fields has a permissive default.
type Options struct {
	HTTPClient         *http.Client
	SignatureVerifier  SignatureVerifier
	CompatibilityProbe CompatibilityProbe
	Now                func() time.Time
}

// Candidate is the durable state for one release set. Path is local state and
// is not persisted, so it can be updated when a failed candidate is moved into
// quarantine.
type Candidate struct {
	Schema     int                              `json:"schema"`
	ID         string                           `json:"id"`
	Channel    string                           `json:"channel"`
	Status     CandidateStatus                  `json:"status"`
	CreatedAt  time.Time                        `json:"createdAt"`
	UpdatedAt  time.Time                        `json:"updatedAt"`
	Components map[Component]CandidateComponent `json:"components"`
	Probe      *ProbeReport                     `json:"probe,omitempty"`
	Failure    string                           `json:"failure,omitempty"`

	Path string `json:"-"`
}

// CandidateComponent holds only non-secret durable verification metadata.
// The source URL is intentionally not persisted, because query strings may
// contain short-lived credentials.
type CandidateComponent struct {
	Component       Component       `json:"component"`
	Version         string          `json:"version"`
	SHA256          string          `json:"sha256"`
	Signature       json.RawMessage `json:"signature"`
	NPMIntegrity    string          `json:"npmIntegrity,omitempty"`
	NPMPackage      string          `json:"npmPackage,omitempty"`
	Archive         ArchiveFormat   `json:"archive"`
	StripComponents int             `json:"stripComponents,omitempty"`
	Entrypoint      string          `json:"entrypoint"`
	MaxBytes        int64           `json:"maxBytes"`
	MaxExtractBytes int64           `json:"maxExtractBytes"`
	TreeSHA256      string          `json:"treeSha256,omitempty"`
}

// VersionMetadata is immutable once a version directory is committed. The
// content hash prevents a modified installed tree from being launched later.
type VersionMetadata struct {
	Schema        int       `json:"schema"`
	Component     Component `json:"component"`
	Version       string    `json:"version"`
	PayloadSHA256 string    `json:"payloadSha256"`
	TreeSHA256    string    `json:"treeSha256"`
	Entrypoint    string    `json:"entrypoint"`
	InstalledAt   time.Time `json:"installedAt"`
}

// ActiveState is the sole launch pointer. Replacing active.json is the atomic
// activation operation; moving version directories alone never changes what
// AetherOps launches.
type ActiveState struct {
	Schema         int                  `json:"schema"`
	CandidateID    string               `json:"candidateId"`
	Channel        string               `json:"channel"`
	Versions       map[Component]string `json:"versions"`
	LastVerified   map[Component]string `json:"lastVerified"`
	ComponentRoots map[Component]string `json:"componentRoots,omitempty"`
	ActivatedAt    time.Time            `json:"activatedAt"`
}

// Warning is durable and survives restart until an explicit caller action
// removes it. It names the last known-good runtime rather than hiding a failed
// update behind a fallback.
type Warning struct {
	ID           string               `json:"id"`
	Code         string               `json:"code"`
	CandidateID  string               `json:"candidateId"`
	Message      string               `json:"message"`
	LastVerified map[Component]string `json:"lastVerified"`
	RaisedAt     time.Time            `json:"raisedAt"`
}

type warningState struct {
	Schema   int       `json:"schema"`
	Warnings []Warning `json:"warnings"`
}

type checkState struct {
	Schema        int       `json:"schema"`
	Channel       string    `json:"channel"`
	LastCheckedAt time.Time `json:"lastCheckedAt"`
}

// Status is a read-only snapshot for diagnostics/UI. Warnings are never
// inferred from a fallback; they are read from durable warning state.
type Status struct {
	Active        *ActiveState `json:"active,omitempty"`
	Candidates    []Candidate  `json:"candidates"`
	Warnings      []Warning    `json:"warnings"`
	LastCheckedAt *time.Time   `json:"last_checked_at,omitempty"`
}
