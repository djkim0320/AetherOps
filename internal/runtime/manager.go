package runtime

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	candidateFileName = "candidate.json"
	versionFileName   = "runtime.json"
)

var (
	safeID             = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	safeRuntimeVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[-+][A-Za-z0-9.-]+)?$`)
)

// Manager owns one runtime-state root. Its methods serialize state-changing
// operations so an update cannot race activation in the same process.
type Manager struct {
	layout              Layout
	manifest            Manifest
	options             Options
	now                 func() time.Time
	activationFaultHook func(activationFaultPoint) error

	mu sync.Mutex
}

// Open initializes storage below root. It performs no network operation and
// does not accept an active runtime merely because a system executable exists.
func Open(root string, manifest Manifest, options Options) (*Manager, error) {
	layout, err := NewLayout(root)
	if err != nil {
		return nil, err
	}
	return OpenLayout(layout, manifest, options)
}

// ResolveProcessPathsReadOnly authenticates an already sealed runtime without
// creating candidates, quarantine directories, or any other state. Release
// evaluation uses this resolver while the product database and CAS are also
// held read-only.
func ResolveProcessPathsReadOnly(root string, manifest Manifest) (ProcessPaths, error) {
	if err := manifest.Validate(); err != nil {
		return ProcessPaths{}, err
	}
	layout, err := NewLayout(root)
	if err != nil {
		return ProcessPaths{}, err
	}
	for label, path := range map[string]string{
		"runtime root":     layout.Root,
		"runtime versions": layout.Versions,
	} {
		info, err := os.Lstat(path)
		if err != nil {
			return ProcessPaths{}, fmt.Errorf("inspect %s: %w", label, err)
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return ProcessPaths{}, fmt.Errorf("%s is not a regular directory", label)
		}
	}
	activeInfo, err := os.Lstat(layout.Active)
	if err != nil {
		return ProcessPaths{}, fmt.Errorf("inspect active runtime pointer: %w", err)
	}
	if !activeInfo.Mode().IsRegular() || activeInfo.Mode()&os.ModeSymlink != 0 {
		return ProcessPaths{}, errors.New("active runtime pointer is not a regular file")
	}
	manager := &Manager{
		layout: layout, manifest: manifest, options: Options{},
		now: func() time.Time { return time.Now().UTC() },
	}
	return manager.ProcessPaths()
}

// OpenLayout is useful when an application already exposes separate candidate
// and version directories. All paths must be inside one state root created by
// NewLayout; callers should not splice an arbitrary active pointer elsewhere.
func OpenLayout(layout Layout, manifest Manifest, options Options) (*Manager, error) {
	if err := manifest.Validate(); err != nil {
		return nil, err
	}
	canonical, err := NewLayout(layout.Root)
	if err != nil {
		return nil, err
	}
	if layout.Candidates != "" && !samePath(layout.Candidates, canonical.Candidates) ||
		layout.Versions != "" && !samePath(layout.Versions, canonical.Versions) ||
		layout.Active != "" && !samePath(layout.Active, canonical.Active) ||
		layout.Activation != "" && !samePath(layout.Activation, canonical.Activation) ||
		layout.Checks != "" && !samePath(layout.Checks, canonical.Checks) ||
		layout.Warnings != "" && !samePath(layout.Warnings, canonical.Warnings) {
		return nil, errors.New("runtime layout paths must remain below one root")
	}
	for _, directory := range []string{
		canonical.Root,
		canonical.Candidates,
		filepath.Join(canonical.Candidates, "quarantine"),
		canonical.Versions,
	} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return nil, err
		}
	}
	now := options.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	manager := &Manager{layout: canonical, manifest: manifest, options: options, now: now}
	if err := manager.reconcileActivationLocked(); err != nil {
		return nil, fmt.Errorf("reconcile runtime activation: %w", err)
	}
	return manager, nil
}

func samePath(a, b string) bool {
	absA, errA := filepath.Abs(a)
	absB, errB := filepath.Abs(b)
	return errA == nil && errB == nil && strings.EqualFold(absA, absB)
}

// Layout returns a copy of the manager's fixed storage layout.
func (m *Manager) Layout() Layout { return m.layout }

// Manifest returns the validated stable policy used by this manager.
func (m *Manager) Manifest() Manifest { return m.manifest }

// Stage downloads, verifies, extracts, and probes a complete release. A
// successful return means only "pending for next restart"; activation is a
// separate, atomic operation performed by ActivatePending.
func (m *Manager) Stage(ctx context.Context, release Release) (Candidate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if err := m.validateRelease(release); err != nil {
		return Candidate{}, err
	}
	candidate, err := m.createCandidate(release)
	if err != nil {
		return Candidate{}, err
	}

	receipts, err := m.downloadArtifacts(ctx, candidate, release.Artifacts)
	if err != nil {
		return m.failedCandidateResult(&candidate, "download-or-hash-verification-failed", err)
	}
	candidate.Status = CandidateVerifying
	candidate.UpdatedAt = m.now().UTC()
	if err := m.saveCandidate(candidate); err != nil {
		return candidate, err
	}

	if m.options.SignatureVerifier == nil {
		return m.failedCandidateResult(&candidate, "signature-verifier-required", ErrSignatureVerifier)
	}
	for _, artifact := range release.Artifacts {
		receipt := receipts[artifact.Component]
		if err := m.options.SignatureVerifier(ctx, SignatureInput{
			CandidateID:  candidate.ID,
			Artifact:     cloneArtifact(artifact),
			ArtifactPath: receipt.Path,
			SHA256:       receipt.SHA256,
		}); err != nil {
			return m.failedCandidateResult(&candidate, "signature-verification-failed", fmt.Errorf("verify %s signature: %w", artifact.Component, err))
		}
	}

	for _, artifact := range release.Artifacts {
		receipt := receipts[artifact.Component]
		component, err := m.materializeCandidateArtifact(candidate, artifact, receipt)
		if err != nil {
			return m.failedCandidateResult(&candidate, "runtime-installation-failed", err)
		}
		candidate.Components[artifact.Component] = component
	}

	if m.options.CompatibilityProbe == nil {
		return m.failedCandidateResult(&candidate, "compatibility-probe-required", ErrCompatibilityProbe)
	}
	paths, err := m.processPathsForCandidate(candidate)
	if err != nil {
		return m.failedCandidateResult(&candidate, "candidate-path-verification-failed", err)
	}
	report, err := m.options.CompatibilityProbe.Probe(ctx, paths)
	if err != nil {
		return m.failedCandidateResult(&candidate, "compatibility-probe-failed", err)
	}
	if err := validateProbeReport(report); err != nil {
		return m.failedCandidateResult(&candidate, "compatibility-probe-insufficient", err)
	}
	candidate.Probe = &report
	candidate.Status = CandidatePending
	candidate.UpdatedAt = m.now().UTC()
	if err := m.saveCandidate(candidate); err != nil {
		return candidate, err
	}
	return candidate, nil
}

func (m *Manager) validateRelease(release Release) error {
	if release.Channel != m.manifest.Channel || release.Channel != "stable" {
		return fmt.Errorf("runtime release channel %q is not the stable manifest channel", release.Channel)
	}
	if release.ID != "" && !safeID.MatchString(release.ID) {
		return errors.New("runtime candidate id is invalid")
	}
	if len(release.Artifacts) != len(managedComponents()) {
		return fmt.Errorf("runtime release must contain exactly %d managed components", len(managedComponents()))
	}
	seen := make(map[Component]struct{}, len(release.Artifacts))
	for _, artifact := range release.Artifacts {
		if _, duplicate := seen[artifact.Component]; duplicate {
			return fmt.Errorf("runtime release repeats component %q", artifact.Component)
		}
		seen[artifact.Component] = struct{}{}
		expectedVersion, known := m.manifest.Version(artifact.Component)
		if !known || artifact.Version != expectedVersion {
			return fmt.Errorf("runtime artifact %q version %q does not match manifest version", artifact.Component, artifact.Version)
		}
		if err := validateArtifact(artifact, m.manifest); err != nil {
			return err
		}
	}
	for _, component := range managedComponents() {
		if _, ok := seen[component]; !ok {
			return fmt.Errorf("runtime release is missing %q", component)
		}
	}
	return nil
}

func validateArtifact(artifact Artifact, manifest Manifest) error {
	if strings.TrimSpace(artifact.URL) == "" {
		return fmt.Errorf("runtime artifact %q URL is required", artifact.Component)
	}
	if err := validateHTTPSURL(artifact.URL); err != nil {
		return fmt.Errorf("runtime artifact %q: %w", artifact.Component, err)
	}
	if !validSHA256(artifact.SHA256) {
		return fmt.Errorf("runtime artifact %q SHA-256 is invalid", artifact.Component)
	}
	if len(artifact.Signature) == 0 {
		return fmt.Errorf("runtime artifact %q signature is required", artifact.Component)
	}
	if artifact.MaxBytes < 0 || artifact.MaxExtractBytes < 0 {
		return fmt.Errorf("runtime artifact %q size limit is invalid", artifact.Component)
	}
	if artifact.Archive != ArchiveFile && artifact.Archive != ArchiveZIP && artifact.Archive != ArchiveTarGZ {
		return fmt.Errorf("runtime artifact %q archive format is invalid", artifact.Component)
	}
	if artifact.StripComponents < 0 || (artifact.Archive == ArchiveFile && artifact.StripComponents != 0) {
		return fmt.Errorf("runtime artifact %q strip-components is invalid", artifact.Component)
	}
	if err := validateRelativePath(artifact.Entrypoint); err != nil {
		return fmt.Errorf("runtime artifact %q entrypoint: %w", artifact.Component, err)
	}
	if strings.EqualFold(filepath.Clean(artifact.Entrypoint), versionFileName) {
		return fmt.Errorf("runtime artifact %q entrypoint uses reserved metadata filename", artifact.Component)
	}
	switch artifact.Component {
	case ComponentNode:
		if artifact.NPMPackage != "" || artifact.NPMIntegrity != "" {
			return errors.New("node runtime must be supplied as a direct artifact")
		}
	case ComponentCodex:
		if strings.TrimSpace(artifact.NPMPackage) == "" || strings.TrimSpace(artifact.NPMIntegrity) == "" {
			return errors.New("codex npm artifact requires package name and SRI integrity")
		}
		if err := validateNPMIntegrity(artifact.NPMIntegrity); err != nil {
			return fmt.Errorf("codex npm integrity: %w", err)
		}
	case ComponentChromeDevtoolsMCP:
		if artifact.NPMPackage != manifest.Components.ChromeDevtoolsMCP.Package || strings.TrimSpace(artifact.NPMIntegrity) == "" {
			return errors.New("chrome-devtools-mcp artifact must use the manifest npm package and SRI integrity")
		}
		if err := validateNPMIntegrity(artifact.NPMIntegrity); err != nil {
			return fmt.Errorf("chrome-devtools-mcp npm integrity: %w", err)
		}
	case ComponentOxigraph:
		if artifact.NPMPackage != manifest.Components.Oxigraph.Package || strings.TrimSpace(artifact.NPMIntegrity) == "" {
			return errors.New("oxigraph artifact must use the manifest npm package and SRI integrity")
		}
		if err := validateNPMIntegrity(artifact.NPMIntegrity); err != nil {
			return fmt.Errorf("oxigraph npm integrity: %w", err)
		}
	case ComponentOpenVSP, ComponentGmsh, ComponentXFOIL, ComponentSU2:
		if artifact.NPMPackage != "" || artifact.NPMIntegrity != "" {
			return fmt.Errorf("native runtime %q must not declare npm package metadata", artifact.Component)
		}
	default:
		return fmt.Errorf("unknown managed runtime component %q", artifact.Component)
	}
	return nil
}

func (m *Manager) createCandidate(release Release) (Candidate, error) {
	id := release.ID
	if id == "" {
		generated, err := newCandidateID(m.now().UTC())
		if err != nil {
			return Candidate{}, err
		}
		id = generated
	}
	path := filepath.Join(m.layout.Candidates, id)
	if err := os.Mkdir(path, 0o700); err != nil {
		return Candidate{}, fmt.Errorf("create runtime candidate: %w", err)
	}
	now := m.now().UTC()
	candidate := Candidate{
		Schema:     stateSchema,
		ID:         id,
		Channel:    release.Channel,
		Status:     CandidateDownloading,
		CreatedAt:  now,
		UpdatedAt:  now,
		Components: make(map[Component]CandidateComponent, len(release.Artifacts)),
		Path:       path,
	}
	if err := m.saveCandidate(candidate); err != nil {
		_ = os.RemoveAll(path)
		return Candidate{}, err
	}
	return candidate, nil
}

func newCandidateID(now time.Time) (string, error) {
	var random [10]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", fmt.Errorf("generate runtime candidate id: %w", err)
	}
	return fmt.Sprintf("%s-%s", now.UTC().Format("20060102T150405.000000000Z"), hex.EncodeToString(random[:])), nil
}

func (m *Manager) saveCandidate(candidate Candidate) error {
	if candidate.Path == "" {
		return errors.New("runtime candidate path is empty")
	}
	return writeJSONAtomic(filepath.Join(candidate.Path, candidateFileName), candidate)
}

func (m *Manager) loadCandidate(id string) (Candidate, error) {
	if !safeID.MatchString(id) {
		return Candidate{}, errors.New("runtime candidate id is invalid")
	}
	path := filepath.Join(m.layout.Candidates, id)
	var candidate Candidate
	if err := readJSON(filepath.Join(path, candidateFileName), &candidate); err != nil {
		return Candidate{}, err
	}
	if candidate.Schema != stateSchema || candidate.ID != id || candidate.Path != "" {
		return Candidate{}, errors.New("runtime candidate metadata is invalid")
	}
	candidate.Path = path
	if err := m.validateCandidateMetadata(candidate); err != nil {
		return Candidate{}, err
	}
	return candidate, nil
}

func (m *Manager) validateCandidateMetadata(candidate Candidate) error {
	if candidate.Channel != "stable" || candidate.Channel != m.manifest.Channel {
		return errors.New("runtime candidate channel does not match stable manifest")
	}
	if candidate.Status == CandidateQuarantined {
		return ErrCandidateQuarantined
	}
	if candidate.Status != CandidateDownloading && candidate.Status != CandidateVerifying && candidate.Status != CandidatePending && candidate.Status != CandidateActive && candidate.Status != CandidateSuperseded {
		return errors.New("runtime candidate status is invalid")
	}
	if len(candidate.Components) != len(managedComponents()) && candidate.Status != CandidateDownloading && candidate.Status != CandidateVerifying {
		return errors.New("runtime candidate component metadata is incomplete")
	}
	for _, component := range managedComponents() {
		metadata, present := candidate.Components[component]
		if !present {
			if candidate.Status == CandidateDownloading || candidate.Status == CandidateVerifying {
				continue
			}
			return fmt.Errorf("runtime candidate is missing component %q", component)
		}
		expected, _ := m.manifest.Version(component)
		if metadata.Component != component || metadata.Version != expected || !safeRuntimeVersion.MatchString(metadata.Version) || !validSHA256(metadata.SHA256) || metadata.TreeSHA256 != "" && !validSHA256(metadata.TreeSHA256) {
			return fmt.Errorf("runtime candidate metadata for %q is invalid", component)
		}
		if err := validateRelativePath(metadata.Entrypoint); err != nil {
			return fmt.Errorf("runtime candidate metadata entrypoint %q: %w", component, err)
		}
		if strings.EqualFold(filepath.Clean(metadata.Entrypoint), versionFileName) || len(metadata.Signature) == 0 || metadata.MaxBytes <= 0 || metadata.MaxExtractBytes <= 0 {
			return fmt.Errorf("runtime candidate metadata for %q is unsafe", component)
		}
	}
	return nil
}

func (m *Manager) failCandidate(candidate *Candidate, code string, cause error) error {
	return errors.Join(cause, m.quarantineCandidate(candidate, code))
}

func (m *Manager) quarantineCandidate(candidate *Candidate, code string) error {
	if candidate == nil || candidate.Path == "" {
		return errors.New("runtime candidate path is empty")
	}
	candidate.Status = CandidateQuarantined
	candidate.Failure = code
	candidate.UpdatedAt = m.now().UTC()
	metadataErr := m.saveCandidate(*candidate)

	quarantineRoot := filepath.Join(m.layout.Candidates, "quarantine")
	moveErr := os.MkdirAll(quarantineRoot, 0o700)
	if moveErr == nil {
		destination := filepath.Join(quarantineRoot, candidate.ID)
		if _, statErr := os.Stat(destination); statErr == nil {
			moveErr = errors.New("runtime quarantine destination already exists")
		} else if !errors.Is(statErr, os.ErrNotExist) {
			moveErr = statErr
		} else if err := os.Rename(candidate.Path, destination); err != nil {
			moveErr = err
		} else {
			candidate.Path = destination
		}
	}
	warningErr := m.appendWarning(code, candidate.ID)
	return errors.Join(metadataErr, moveErr, warningErr)
}

func (m *Manager) failedCandidateResult(candidate *Candidate, code string, cause error) (Candidate, error) {
	err := m.failCandidate(candidate, code, cause)
	return *candidate, err
}

// QuarantineInterruptedCandidates resolves only incomplete local staging
// state. It never downloads again, probes, or activates anything, which keeps
// restart recovery free of duplicated external requests.
func (m *Manager) QuarantineInterruptedCandidates() (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entries, err := os.ReadDir(m.layout.Candidates)
	if err != nil {
		return 0, err
	}
	recovered := 0
	var recoveryErr error
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == "quarantine" {
			continue
		}
		candidate, err := m.loadCandidate(entry.Name())
		if err != nil {
			recoveryErr = errors.Join(recoveryErr, fmt.Errorf("inspect runtime candidate %q: %w", entry.Name(), err))
			continue
		}
		if candidate.Status != CandidateDownloading && candidate.Status != CandidateVerifying {
			continue
		}
		if err := m.quarantineCandidate(&candidate, "interrupted-runtime-candidate"); err != nil {
			recoveryErr = errors.Join(recoveryErr, fmt.Errorf("quarantine interrupted runtime candidate %q: %w", candidate.ID, err))
			continue
		}
		recovered++
	}
	return recovered, recoveryErr
}

// CandidateQuarantined reports whether a release ID has already been moved to
// durable quarantine. The updater uses this before staging so a stable feed
// that continues to advertise a failed release cannot trigger another
// download, probe, or external request on a later daily check.
func (m *Manager) CandidateQuarantined(id string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !safeID.MatchString(id) {
		return false, errors.New("runtime candidate id is invalid")
	}
	path := filepath.Join(m.layout.Candidates, "quarantine", id, candidateFileName)
	var candidate Candidate
	if err := readJSON(path, &candidate); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("read quarantined runtime candidate %q: %w", id, err)
	}
	if candidate.Schema != stateSchema || candidate.ID != id || candidate.Path != "" ||
		candidate.Channel != "stable" || candidate.Channel != m.manifest.Channel ||
		candidate.Status != CandidateQuarantined {
		return false, fmt.Errorf("quarantined runtime candidate %q metadata is invalid", id)
	}
	return true, nil
}

func (m *Manager) appendWarning(code, candidateID string) error {
	return m.appendWarningMessage(code, candidateID,
		"Managed runtime update was quarantined; the explicitly listed last verified runtime remains active.")
}

// RecordWarning persists a product-level updater failure without pretending a
// candidate was quarantined. Duplicate warnings are coalesced by code,
// candidate, and message so a daily failed check cannot grow the file forever.
func (m *Manager) RecordWarning(code, candidateID, message string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.appendWarningMessage(code, candidateID, message)
}

func (m *Manager) appendWarningMessage(code, candidateID, message string) error {
	if !safeID.MatchString(code) {
		return errors.New("runtime warning code is invalid")
	}
	if candidateID == "" {
		candidateID = "updater"
	}
	if !safeID.MatchString(candidateID) {
		return errors.New("runtime warning candidate id is invalid")
	}
	message = strings.TrimSpace(message)
	if message == "" || len(message) > 2048 {
		return errors.New("runtime warning message is invalid")
	}
	lastVerified := make(map[Component]string)
	active, err := m.readActive()
	if err == nil {
		lastVerified = cloneVersions(active.LastVerified)
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read last verified runtime for warning: %w", err)
	}
	state, err := m.readWarnings()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if state.Schema == 0 {
		state.Schema = stateSchema
	}
	for _, warning := range state.Warnings {
		if warning.Code == code && warning.CandidateID == candidateID && warning.Message == message {
			return nil
		}
	}
	now := m.now().UTC()
	state.Warnings = append(state.Warnings, Warning{
		ID:           fmt.Sprintf("%s-%s", now.Format("20060102T150405.000000000Z"), candidateID),
		Code:         code,
		CandidateID:  candidateID,
		Message:      message,
		LastVerified: lastVerified,
		RaisedAt:     now,
	})
	return writeJSONAtomic(m.layout.Warnings, state)
}

func (m *Manager) readWarnings() (warningState, error) {
	var state warningState
	if err := readJSON(m.layout.Warnings, &state); err != nil {
		return warningState{}, err
	}
	if state.Schema != stateSchema {
		return warningState{}, errors.New("runtime warning state schema is invalid")
	}
	return state, nil
}

func (m *Manager) readActive() (ActiveState, error) {
	var active ActiveState
	if err := readJSON(m.layout.Active, &active); err != nil {
		return ActiveState{}, err
	}
	if err := m.validateActive(active); err != nil {
		return ActiveState{}, err
	}
	return active, nil
}

func (m *Manager) validateActive(active ActiveState) error {
	if active.Schema != stateSchema || active.Channel != "stable" || active.Channel != m.manifest.Channel || !safeID.MatchString(active.CandidateID) {
		return errors.New("active runtime state is invalid")
	}
	if len(active.Versions) != len(managedComponents()) || len(active.LastVerified) != len(managedComponents()) {
		return errors.New("active runtime version set is incomplete or contains unknown components")
	}
	for _, component := range managedComponents() {
		expected, _ := m.manifest.Version(component)
		if active.Versions[component] != expected || active.LastVerified[component] != expected {
			return ErrActiveVersionMismatch
		}
	}
	if len(active.ComponentRoots) != 0 {
		if len(active.ComponentRoots) != len(managedComponents()) {
			return errors.New("active packaged runtime root set is incomplete or contains unknown components")
		}
		for _, component := range managedComponents() {
			expected, ok := packagedComponentRoot(component)
			if !ok || filepath.ToSlash(filepath.Clean(active.ComponentRoots[component])) != expected {
				return errors.New("active packaged runtime root is invalid")
			}
		}
	}
	return nil
}

// Active returns the explicit active pointer. A missing active pointer is not
// converted into an untracked system runtime.
func (m *Manager) Active() (ActiveState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.ensureNoActivationJournal(); err != nil {
		return ActiveState{}, err
	}
	return m.readActive()
}

// Status reports durable active, candidate, and warning state without
// changing it. An unreadable metadata file is returned as an error rather than
// being hidden from diagnostics.
func (m *Manager) Status() (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.ensureNoActivationJournal(); err != nil {
		return Status{}, err
	}
	status := Status{}
	if active, err := m.readActive(); err == nil {
		copy := active
		copy.Versions = cloneVersions(active.Versions)
		copy.LastVerified = cloneVersions(active.LastVerified)
		copy.ComponentRoots = cloneVersions(active.ComponentRoots)
		status.Active = &copy
	} else if !errors.Is(err, os.ErrNotExist) {
		return Status{}, err
	}
	warnings, err := m.readWarnings()
	if err == nil {
		status.Warnings = cloneWarnings(warnings.Warnings)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Status{}, err
	}
	if checks, err := m.readCheckState(); err == nil {
		checkedAt := checks.LastCheckedAt
		status.LastCheckedAt = &checkedAt
	} else if !errors.Is(err, os.ErrNotExist) {
		return Status{}, err
	}
	entries, err := os.ReadDir(m.layout.Candidates)
	if err != nil {
		return Status{}, err
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == "quarantine" {
			continue
		}
		candidate, err := m.loadCandidate(entry.Name())
		if err != nil {
			return Status{}, fmt.Errorf("read runtime candidate %q: %w", entry.Name(), err)
		}
		candidate.Path = ""
		status.Candidates = append(status.Candidates, candidate)
	}
	sort.Slice(status.Candidates, func(i, j int) bool { return status.Candidates[i].CreatedAt.Before(status.Candidates[j].CreatedAt) })
	return status, nil
}

// Warnings returns durable warnings. They are only removed through the
// explicit AcknowledgeWarnings method.
func (m *Manager) Warnings() ([]Warning, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, err := m.readWarnings()
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return cloneWarnings(state.Warnings), nil
}

// AcknowledgeWarnings is intentionally explicit; successful activation never
// silently hides the warning raised by a quarantined candidate.
func (m *Manager) AcknowledgeWarnings(ids ...string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(ids) == 0 {
		return errors.New("at least one runtime warning id is required")
	}
	selected := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if id == "" {
			return errors.New("runtime warning id is empty")
		}
		selected[id] = struct{}{}
	}
	state, err := m.readWarnings()
	if err != nil {
		return err
	}
	kept := state.Warnings[:0]
	for _, warning := range state.Warnings {
		if _, remove := selected[warning.ID]; !remove {
			kept = append(kept, warning)
		}
	}
	state.Warnings = kept
	return writeJSONAtomic(m.layout.Warnings, state)
}

// CheckDue reports whether the stable-channel update check may run now. It
// never records a check while the application is busy, so an idle window is
// required and the 24-hour interval is durable across restart.
func (m *Manager) CheckDue(now time.Time, idle bool) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !idle {
		return false, nil
	}
	state, err := m.readCheckState()
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	if state.Channel != "stable" || state.Channel != m.manifest.Channel {
		return false, errors.New("runtime check state channel is invalid")
	}
	if now.Before(state.LastCheckedAt) {
		return false, nil
	}
	return now.Sub(state.LastCheckedAt) >= 24*time.Hour, nil
}

// RecordCheck persists a completed update-check attempt. Call it only after
// the caller has actually performed the check; it is intentionally separate
// from CheckDue so a skipped idle window cannot suppress future checks.
func (m *Manager) RecordCheck(now time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return writeJSONAtomic(m.layout.Checks, checkState{
		Schema:        stateSchema,
		Channel:       m.manifest.Channel,
		LastCheckedAt: now.UTC(),
	})
}

func (m *Manager) readCheckState() (checkState, error) {
	var state checkState
	if err := readJSON(m.layout.Checks, &state); err != nil {
		return checkState{}, err
	}
	if state.Schema != stateSchema {
		return checkState{}, errors.New("runtime check state schema is invalid")
	}
	return state, nil
}

func writeJSONAtomic(path string, value any) (err error) {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".state-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	encoder := json.NewEncoder(temporary)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	committed = true
	return nil
}

func readJSON(path string, value any) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("runtime state contains multiple JSON values")
		}
		return err
	}
	return nil
}

func cloneVersions(source map[Component]string) map[Component]string {
	if source == nil {
		return map[Component]string{}
	}
	copy := make(map[Component]string, len(source))
	for component, version := range source {
		copy[component] = version
	}
	return copy
}

func cloneWarnings(source []Warning) []Warning {
	copy := make([]Warning, len(source))
	for index := range source {
		copy[index] = source[index]
		copy[index].LastVerified = cloneVersions(source[index].LastVerified)
	}
	return copy
}

func cloneArtifact(source Artifact) Artifact {
	copy := source
	copy.Signature = append(json.RawMessage(nil), source.Signature...)
	return copy
}
