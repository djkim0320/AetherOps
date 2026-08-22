package runtime

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// BundleComponentSpec describes one already downloaded and independently
// verified component in a release staging tree. SealBundle does not download
// or trust network content; the packaging pipeline must verify official hashes
// and signatures before calling it.
type BundleComponentSpec struct {
	Component     Component
	Version       string
	PayloadSHA256 string
	Entrypoint    string
}

// packagedComponentRoot is a closed mapping used only by the immutable
// runtime shipped beside aetherops.exe. Keeping these roots short prevents
// legacy Windows ZIP extractors from crossing MAX_PATH while the component
// identity and version remain authenticated by runtime.json and active.json.
func packagedComponentRoot(component Component) (string, bool) {
	code := ""
	switch component {
	case ComponentNode:
		code = "n"
	case ComponentCodex:
		code = "c"
	case ComponentChromeDevtoolsMCP:
		code = "d"
	case ComponentOxigraph:
		code = "o"
	case ComponentOpenVSP:
		code = "v"
	case ComponentGmsh:
		code = "g"
	case ComponentXFOIL:
		code = "x"
	case ComponentSU2:
		code = "s"
	default:
		return "", false
	}
	return "b/" + code, true
}

// MaterializePackagedBundle copies an authenticated active runtime into the
// compact, immutable layout used by the portable ZIP and installer. It does
// not modify the source runtime or the updater's conventional
// versions/<component>/<version> layout. destinationRoot must be absent or an
// empty regular directory so a stale package tree can never be mixed in.
func MaterializePackagedBundle(sourceRoot, destinationRoot string, manifest Manifest) (ActiveState, error) {
	if err := manifest.Validate(); err != nil {
		return ActiveState{}, err
	}
	sourceLayout, err := NewLayout(sourceRoot)
	if err != nil {
		return ActiveState{}, err
	}
	destinationLayout, err := NewLayout(destinationRoot)
	if err != nil {
		return ActiveState{}, err
	}
	if pathsOverlap(sourceLayout.Root, destinationLayout.Root) {
		return ActiveState{}, errors.New("packaged runtime source and destination must not overlap")
	}
	if _, err := ResolveProcessPathsReadOnly(sourceLayout.Root, manifest); err != nil {
		return ActiveState{}, fmt.Errorf("authenticate source runtime: %w", err)
	}
	sourceManager := &Manager{
		layout: sourceLayout, manifest: manifest, options: Options{},
		now: func() time.Time { return time.Now().UTC() },
	}
	active, err := sourceManager.readActive()
	if err != nil {
		return ActiveState{}, err
	}

	if info, statErr := os.Lstat(destinationLayout.Root); statErr == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return ActiveState{}, errors.New("packaged runtime destination is not a regular directory")
		}
		entries, readErr := os.ReadDir(destinationLayout.Root)
		if readErr != nil {
			return ActiveState{}, readErr
		}
		if len(entries) != 0 {
			return ActiveState{}, errors.New("packaged runtime destination must be empty")
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return ActiveState{}, statErr
	}
	for _, directory := range []string{destinationLayout.Root, destinationLayout.Versions} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return ActiveState{}, err
		}
	}

	roots := make(map[Component]string, len(managedComponents()))
	for _, component := range managedComponents() {
		source, err := sourceManager.activeComponentRoot(active, component)
		if err != nil {
			return ActiveState{}, err
		}
		relative, ok := packagedComponentRoot(component)
		if !ok {
			return ActiveState{}, fmt.Errorf("packaged runtime has no closed root mapping for %q", component)
		}
		destination, err := safeJoin(destinationLayout.Root, filepath.FromSlash(relative))
		if err != nil {
			return ActiveState{}, err
		}
		if err := os.MkdirAll(destination, 0o700); err != nil {
			return ActiveState{}, err
		}
		if err := copyRuntimeTree(source, destination); err != nil {
			return ActiveState{}, fmt.Errorf("copy packaged runtime %q: %w", component, err)
		}
		roots[component] = relative
	}
	packaged := active
	packaged.Versions = cloneVersions(active.Versions)
	packaged.LastVerified = cloneVersions(active.LastVerified)
	packaged.ComponentRoots = roots
	if err := writeJSONAtomic(destinationLayout.Active, packaged); err != nil {
		return ActiveState{}, err
	}
	if _, err := ResolveProcessPathsReadOnly(destinationLayout.Root, manifest); err != nil {
		return ActiveState{}, fmt.Errorf("verify compact packaged runtime: %w", err)
	}
	return packaged, nil
}

func pathsOverlap(left, right string) bool {
	within := func(parent, child string) bool {
		relative, err := filepath.Rel(parent, child)
		if err != nil {
			return false
		}
		return relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
	}
	return within(left, right) || within(right, left)
}

// SealBundle commits immutable metadata for a packaged runtime set. The
// caller prepares root/versions/<component>/<version>, then this function
// hashes every installed file and writes active.json only after all component
// trees validate.
func SealBundle(root string, manifest Manifest, candidateID string, installedAt time.Time, specs []BundleComponentSpec) (ActiveState, error) {
	if err := manifest.Validate(); err != nil {
		return ActiveState{}, err
	}
	if !safeID.MatchString(candidateID) {
		return ActiveState{}, errors.New("bundled runtime candidate id is invalid")
	}
	if installedAt.IsZero() {
		return ActiveState{}, errors.New("bundled runtime installation time is required")
	}
	layout, err := NewLayout(root)
	if err != nil {
		return ActiveState{}, err
	}
	if err := os.MkdirAll(layout.Versions, 0o700); err != nil {
		return ActiveState{}, err
	}
	if len(specs) != len(managedComponents()) {
		return ActiveState{}, fmt.Errorf("bundled runtime must contain exactly %d managed components", len(managedComponents()))
	}

	byComponent := make(map[Component]BundleComponentSpec, len(specs))
	for _, spec := range specs {
		if _, duplicate := byComponent[spec.Component]; duplicate {
			return ActiveState{}, fmt.Errorf("bundled runtime repeats component %q", spec.Component)
		}
		expected, ok := manifest.Version(spec.Component)
		if !ok || spec.Version != expected {
			return ActiveState{}, fmt.Errorf("bundled runtime %q version %q does not match manifest", spec.Component, spec.Version)
		}
		if !validSHA256(spec.PayloadSHA256) {
			return ActiveState{}, fmt.Errorf("bundled runtime %q payload receipt hash is invalid", spec.Component)
		}
		if err := validateRelativePath(spec.Entrypoint); err != nil {
			return ActiveState{}, fmt.Errorf("bundled runtime %q entrypoint: %w", spec.Component, err)
		}
		byComponent[spec.Component] = spec
	}

	versions := make(map[Component]string, len(specs))
	for _, component := range managedComponents() {
		spec, ok := byComponent[component]
		if !ok {
			return ActiveState{}, fmt.Errorf("bundled runtime is missing %q", component)
		}
		versionRoot := filepath.Join(layout.Versions, string(component), spec.Version)
		if _, err := os.Lstat(filepath.Join(versionRoot, versionFileName)); err == nil {
			return ActiveState{}, fmt.Errorf("bundled runtime %q already contains reserved metadata", component)
		} else if !errors.Is(err, os.ErrNotExist) {
			return ActiveState{}, err
		}
		entrypoint, err := safeJoin(versionRoot, spec.Entrypoint)
		if err != nil {
			return ActiveState{}, err
		}
		info, err := os.Lstat(entrypoint)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return ActiveState{}, fmt.Errorf("bundled runtime %q entrypoint is not a regular file", component)
		}
		treeSHA256, err := hashRuntimeTree(versionRoot)
		if err != nil {
			return ActiveState{}, fmt.Errorf("hash bundled runtime %q: %w", component, err)
		}
		metadata := VersionMetadata{
			Schema:        stateSchema,
			Component:     component,
			Version:       spec.Version,
			PayloadSHA256: strings.ToLower(spec.PayloadSHA256),
			TreeSHA256:    treeSHA256,
			Entrypoint:    spec.Entrypoint,
			InstalledAt:   installedAt.UTC(),
		}
		if err := writeJSONAtomic(filepath.Join(versionRoot, versionFileName), metadata); err != nil {
			return ActiveState{}, err
		}
		versions[component] = spec.Version
	}

	active := ActiveState{
		Schema:       stateSchema,
		CandidateID:  candidateID,
		Channel:      manifest.Channel,
		Versions:     cloneVersions(versions),
		LastVerified: cloneVersions(versions),
		ActivatedAt:  installedAt.UTC(),
	}
	if err := writeJSONAtomic(layout.Active, active); err != nil {
		return ActiveState{}, err
	}
	manager, err := Open(root, manifest, Options{})
	if err != nil {
		return ActiveState{}, err
	}
	if _, err := manager.ProcessPaths(); err != nil {
		return ActiveState{}, fmt.Errorf("verify sealed bundled runtime: %w", err)
	}
	return active, nil
}
