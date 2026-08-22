package runtime

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
)

// materializeCandidateArtifact extracts only a checksum-verified payload into
// the candidate's private runtime tree. The tree is not visible as a launch
// target until ActivatePending atomically replaces active.json.
func (m *Manager) materializeCandidateArtifact(candidate Candidate, artifact Artifact, receipt artifactReceipt) (CandidateComponent, error) {
	runtimeParent := filepath.Join(candidate.Path, "runtime")
	if err := os.MkdirAll(runtimeParent, 0o700); err != nil {
		return CandidateComponent{}, err
	}
	temporary, err := os.MkdirTemp(runtimeParent, "."+string(artifact.Component)+"-*")
	if err != nil {
		return CandidateComponent{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(temporary)
		}
	}()
	if err := extractArtifact(receipt.Path, temporary, artifact); err != nil {
		return CandidateComponent{}, err
	}
	metadata := CandidateComponent{
		Component:       artifact.Component,
		Version:         artifact.Version,
		SHA256:          receipt.SHA256,
		Signature:       append([]byte(nil), artifact.Signature...),
		NPMIntegrity:    artifact.NPMIntegrity,
		NPMPackage:      artifact.NPMPackage,
		Archive:         artifact.Archive,
		StripComponents: artifact.StripComponents,
		Entrypoint:      artifact.Entrypoint,
		MaxBytes:        artifactLimit(artifact.MaxBytes, defaultMaxDownloadBytes),
		MaxExtractBytes: artifactLimit(artifact.MaxExtractBytes, defaultMaxExtractBytes),
	}
	treeHash, err := hashRuntimeTree(temporary)
	if err != nil {
		return CandidateComponent{}, err
	}
	metadata.TreeSHA256 = treeHash
	version := VersionMetadata{
		Schema:        stateSchema,
		Component:     metadata.Component,
		Version:       metadata.Version,
		PayloadSHA256: metadata.SHA256,
		TreeSHA256:    metadata.TreeSHA256,
		Entrypoint:    metadata.Entrypoint,
		InstalledAt:   m.now().UTC(),
	}
	if err := writeJSONAtomic(filepath.Join(temporary, versionFileName), version); err != nil {
		return CandidateComponent{}, err
	}
	final := filepath.Join(runtimeParent, string(artifact.Component))
	if _, err := os.Lstat(final); err == nil {
		return CandidateComponent{}, errors.New("candidate runtime directory already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return CandidateComponent{}, err
	}
	if err := os.Rename(temporary, final); err != nil {
		return CandidateComponent{}, fmt.Errorf("atomically commit candidate runtime directory: %w", err)
	}
	committed = true
	return metadata, nil
}

func artifactLimit(value, fallback int64) int64 {
	if value == 0 {
		return fallback
	}
	return value
}

func extractArtifact(payload, destination string, artifact Artifact) error {
	maximum := artifactLimit(artifact.MaxExtractBytes, defaultMaxExtractBytes)
	switch artifact.Archive {
	case ArchiveFile:
		info, err := os.Stat(payload)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() > maximum {
			return errors.New("runtime file artifact is not a permitted regular file")
		}
		target, err := safeJoin(destination, artifact.Entrypoint)
		if err != nil {
			return err
		}
		return copyFileDurable(payload, target, maximum)
	case ArchiveZIP:
		return extractZIP(payload, destination, artifact.StripComponents, maximum)
	case ArchiveTarGZ:
		return extractTarGZ(payload, destination, artifact.StripComponents, maximum)
	default:
		return errors.New("runtime artifact archive format is unsupported")
	}
}

func extractZIP(payload, destination string, stripComponents int, maximum int64) error {
	archive, err := zip.OpenReader(payload)
	if err != nil {
		return fmt.Errorf("open runtime ZIP artifact: %w", err)
	}
	defer archive.Close()
	var extracted int64
	for _, entry := range archive.File {
		relative, skip, err := archiveRelativePath(entry.Name, stripComponents)
		if err != nil {
			return err
		}
		if skip {
			continue
		}
		target, err := safeJoin(destination, relative)
		if err != nil {
			return err
		}
		mode := entry.Mode()
		if mode&os.ModeSymlink != 0 || mode&os.ModeType != 0 && !mode.IsDir() {
			return errors.New("runtime ZIP artifact contains a non-regular file")
		}
		if entry.FileInfo().IsDir() {
			if err := ensureDirectory(target); err != nil {
				return err
			}
			continue
		}
		if entry.UncompressedSize64 > uint64(maximum-extracted) {
			return errors.New("runtime ZIP artifact exceeds extraction limit")
		}
		reader, err := entry.Open()
		if err != nil {
			return err
		}
		written, writeErr := writeReaderDurable(target, reader, maximum-extracted, int64(entry.UncompressedSize64))
		closeErr := reader.Close()
		if writeErr != nil {
			return writeErr
		}
		if closeErr != nil {
			return closeErr
		}
		extracted += written
	}
	return nil
}

func extractTarGZ(payload, destination string, stripComponents int, maximum int64) error {
	file, err := os.Open(payload)
	if err != nil {
		return err
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return fmt.Errorf("open runtime tar.gz artifact: %w", err)
	}
	defer gzipReader.Close()
	reader := tar.NewReader(gzipReader)
	var extracted int64
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		relative, skip, err := archiveRelativePath(header.Name, stripComponents)
		if err != nil {
			return err
		}
		if skip {
			continue
		}
		target, err := safeJoin(destination, relative)
		if err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := ensureDirectory(target); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if header.Size < 0 || header.Size > maximum-extracted {
				return errors.New("runtime tar.gz artifact exceeds extraction limit")
			}
			written, err := writeReaderDurable(target, io.LimitReader(reader, header.Size), maximum-extracted, header.Size)
			if err != nil {
				return err
			}
			extracted += written
		default:
			return errors.New("runtime tar.gz artifact contains a non-regular file")
		}
	}
}

func archiveRelativePath(name string, stripComponents int) (string, bool, error) {
	if name == "" || strings.Contains(name, `\`) {
		return "", false, errors.New("runtime archive entry path is invalid")
	}
	clean := path.Clean(name)
	if clean == "." {
		return "", true, nil
	}
	if strings.HasPrefix(clean, "/") || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", false, errors.New("runtime archive entry escapes destination")
	}
	parts := strings.Split(clean, "/")
	if len(parts) <= stripComponents {
		return "", true, nil
	}
	relative := filepath.Join(parts[stripComponents:]...)
	if err := validateRelativePath(relative); err != nil {
		return "", false, err
	}
	if strings.EqualFold(filepath.Clean(relative), versionFileName) {
		return "", false, errors.New("runtime archive entry uses reserved metadata filename")
	}
	return relative, false, nil
}

func validateRelativePath(value string) error {
	if strings.TrimSpace(value) == "" || strings.ContainsRune(value, 0) || filepath.IsAbs(value) || filepath.VolumeName(value) != "" {
		return errors.New("path must be a non-empty relative path")
	}
	clean := filepath.Clean(value)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return errors.New("path escapes its runtime directory")
	}
	return nil
}

func safeJoin(root, relative string) (string, error) {
	if err := validateRelativePath(relative); err != nil {
		return "", err
	}
	joined := filepath.Join(root, relative)
	contained, err := filepath.Rel(root, joined)
	if err != nil || contained == ".." || strings.HasPrefix(contained, ".."+string(filepath.Separator)) {
		return "", errors.New("runtime path escapes destination")
	}
	return joined, nil
}

func ensureDirectory(path string) error {
	if info, err := os.Lstat(path); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("runtime extraction directory is not a real directory")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.MkdirAll(path, 0o700)
}

// writeReaderDurable follows the same temporary-file, Sync, and atomic-rename
// discipline as candidate downloads. It refuses duplicate archive paths.
func writeReaderDurable(destination string, reader io.Reader, maximum, exact int64) (int64, error) {
	if maximum < 0 || exact < 0 || exact > maximum {
		return 0, errors.New("runtime extraction size is invalid")
	}
	if err := ensureDirectory(filepath.Dir(destination)); err != nil {
		return 0, err
	}
	if _, err := os.Lstat(destination); err == nil {
		return 0, errors.New("runtime archive contains duplicate output path")
	} else if !errors.Is(err, os.ErrNotExist) {
		return 0, err
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".extract-*.tmp")
	if err != nil {
		return 0, err
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	written, err := io.Copy(temporary, io.LimitReader(reader, maximum+1))
	if err != nil {
		return 0, err
	}
	if written > maximum || written != exact {
		return 0, errors.New("runtime archive entry size does not match metadata")
	}
	if err := temporary.Sync(); err != nil {
		return 0, err
	}
	if err := temporary.Close(); err != nil {
		return 0, err
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		return 0, err
	}
	committed = true
	return written, nil
}

func copyFileDurable(source, destination string, maximum int64) error {
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > maximum {
		return errors.New("runtime source file is invalid")
	}
	file, err := os.Open(source)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = writeReaderDurable(destination, file, maximum, info.Size())
	return err
}

type runtimeFileHash struct {
	relative string
	digest   [sha256.Size]byte
	size     int64
}

// hashRuntimeTree is deterministic and uses a bounded CPU-derived worker pool
// for file digesting. Symlinks and device-like entries are rejected on every
// verification, including after activation.
func hashRuntimeTree(root string) (string, error) {
	files, err := runtimeFiles(root)
	if err != nil {
		return "", err
	}
	if len(files) == 0 {
		return "", errors.New("runtime tree has no executable content")
	}
	workers := runtime.NumCPU()
	if workers < 1 {
		workers = 1
	}
	if workers > len(files) {
		workers = len(files)
	}
	type result struct {
		hash runtimeFileHash
		err  error
	}
	jobs := make(chan string, len(files))
	results := make(chan result, len(files))
	for _, file := range files {
		jobs <- file
	}
	close(jobs)
	var group sync.WaitGroup
	group.Add(workers)
	for range workers {
		go func() {
			defer group.Done()
			for relative := range jobs {
				hash, err := hashRuntimeFile(root, relative)
				results <- result{hash: hash, err: err}
			}
		}()
	}
	group.Wait()
	close(results)
	hashes := make([]runtimeFileHash, 0, len(files))
	for result := range results {
		if result.err != nil {
			return "", result.err
		}
		hashes = append(hashes, result.hash)
	}
	sort.Slice(hashes, func(i, j int) bool { return hashes[i].relative < hashes[j].relative })
	outer := sha256.New()
	for _, file := range hashes {
		if _, err := io.WriteString(outer, file.relative); err != nil {
			return "", err
		}
		if _, err := outer.Write([]byte{0}); err != nil {
			return "", err
		}
		if _, err := outer.Write(file.digest[:]); err != nil {
			return "", err
		}
		if _, err := io.WriteString(outer, fmt.Sprintf("\x00%d\x00", file.size)); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(outer.Sum(nil)), nil
}

func runtimeFiles(root string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("runtime tree contains a symlink")
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return errors.New("runtime tree contains a non-regular file")
		}
		if relative == versionFileName {
			return nil
		}
		files = append(files, relative)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	return files, nil
}

func hashRuntimeFile(root, relative string) (runtimeFileHash, error) {
	path, err := safeJoin(root, relative)
	if err != nil {
		return runtimeFileHash{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return runtimeFileHash{}, err
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil || !before.Mode().IsRegular() {
		return runtimeFileHash{}, errors.New("runtime file changed before hashing")
	}
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return runtimeFileHash{}, err
	}
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		return runtimeFileHash{}, errors.New("runtime file changed while hashing")
	}
	var digest [sha256.Size]byte
	copy(digest[:], hasher.Sum(nil))
	return runtimeFileHash{relative: filepath.ToSlash(relative), digest: digest, size: before.Size()}, nil
}

func (m *Manager) verifyRuntimeRoot(root string, expected CandidateComponent) error {
	var metadata VersionMetadata
	if err := readJSON(filepath.Join(root, versionFileName), &metadata); err != nil {
		return err
	}
	if metadata.Schema != stateSchema || metadata.Component != expected.Component || metadata.Version != expected.Version ||
		metadata.PayloadSHA256 != expected.SHA256 || metadata.TreeSHA256 != expected.TreeSHA256 || metadata.Entrypoint != expected.Entrypoint {
		return errors.New("runtime version metadata does not match candidate")
	}
	if !validSHA256(metadata.TreeSHA256) {
		return errors.New("runtime version content hash is invalid")
	}
	computed, err := hashRuntimeTree(root)
	if err != nil {
		return err
	}
	if computed != metadata.TreeSHA256 {
		return errors.New("runtime version content hash mismatch")
	}
	entrypoint, err := safeJoin(root, expected.Entrypoint)
	if err != nil {
		return err
	}
	info, err := os.Lstat(entrypoint)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("runtime entrypoint is not a regular file")
	}
	return nil
}

// ActivatePending performs the only operation that changes what will launch
// after restart. All version directories are copied and verified first. A
// durable activation journal then surrounds the active pointer and candidate
// audit updates so a restart can deterministically commit forward or roll back.
func (m *Manager) ActivatePending(ctx context.Context, candidateID string) (ActiveState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.ensureNoActivationJournal(); err != nil {
		return ActiveState{}, err
	}
	candidate, err := m.loadCandidate(candidateID)
	if err != nil {
		if safeID.MatchString(candidateID) {
			_ = m.appendWarning("pending-candidate-metadata-invalid", candidateID)
		}
		return ActiveState{}, err
	}
	if candidate.Status != CandidatePending {
		return ActiveState{}, ErrPendingCandidate
	}
	if err := validateProbeReport(*candidate.Probe); err != nil {
		return ActiveState{}, m.failCandidate(&candidate, "pending-probe-evidence-invalid", err)
	}
	if m.options.SignatureVerifier == nil {
		return ActiveState{}, m.failCandidate(&candidate, "signature-verifier-required", ErrSignatureVerifier)
	}
	for _, component := range managedComponents() {
		metadata := candidate.Components[component]
		if err := m.verifyCandidatePayload(ctx, candidate, metadata); err != nil {
			return ActiveState{}, m.failCandidate(&candidate, "pending-candidate-verification-failed", err)
		}
		runtimeRoot := filepath.Join(candidate.Path, "runtime", string(component))
		if err := m.verifyRuntimeRoot(runtimeRoot, metadata); err != nil {
			return ActiveState{}, m.failCandidate(&candidate, "pending-runtime-tree-verification-failed", err)
		}
	}
	for _, component := range managedComponents() {
		if err := m.commitVersion(candidate, candidate.Components[component]); err != nil {
			return ActiveState{}, m.failCandidate(&candidate, "version-commit-failed", err)
		}
	}
	versions := make(map[Component]string, len(managedComponents()))
	for _, component := range managedComponents() {
		versions[component] = candidate.Components[component].Version
	}
	active := ActiveState{
		Schema:       stateSchema,
		CandidateID:  candidate.ID,
		Channel:      m.manifest.Channel,
		Versions:     cloneVersions(versions),
		LastVerified: cloneVersions(versions),
		ActivatedAt:  m.now().UTC(),
	}
	journal, err := m.beginActivation(candidate, active)
	if err != nil {
		return ActiveState{}, err
	}
	if err := writeJSONAtomic(m.layout.Active, active); err != nil {
		return ActiveState{}, fmt.Errorf("atomically activate verified runtime: %w", err)
	}
	if err := m.activationFault(activationFaultAfterPointerSwap); err != nil {
		return active, err
	}
	if err := m.advanceActivation(&journal, activationPhasePointerSwapped); err != nil {
		return active, err
	}
	if err := m.activationFault(activationFaultBeforeCandidateAudit); err != nil {
		return active, err
	}
	if err := m.normalizeCandidateAudits(candidate.ID); err != nil {
		return active, fmt.Errorf("update active runtime candidate audit: %w", err)
	}
	if err := m.advanceActivation(&journal, activationPhaseActive); err != nil {
		return active, err
	}
	if err := m.activationFault(activationFaultBeforeJournalRemoval); err != nil {
		return active, err
	}
	if err := os.Remove(m.layout.Activation); err != nil {
		return active, fmt.Errorf("remove completed runtime activation journal: %w", err)
	}
	return active, nil
}

func (m *Manager) verifyCandidatePayload(ctx context.Context, candidate Candidate, metadata CandidateComponent) error {
	payload := filepath.Join(candidate.Path, string(metadata.Component)+".payload")
	info, err := os.Stat(payload)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > metadata.MaxBytes {
		return errors.New("candidate payload is invalid")
	}
	actual, err := verifyPayloadHashes(payload, metadata.SHA256, metadata.NPMIntegrity)
	if err != nil {
		return err
	}
	if actual != metadata.SHA256 {
		return errors.New("candidate payload digest changed")
	}
	artifact := Artifact{
		Component:       metadata.Component,
		Version:         metadata.Version,
		SHA256:          metadata.SHA256,
		Signature:       append([]byte(nil), metadata.Signature...),
		NPMPackage:      metadata.NPMPackage,
		NPMIntegrity:    metadata.NPMIntegrity,
		Archive:         metadata.Archive,
		StripComponents: metadata.StripComponents,
		Entrypoint:      metadata.Entrypoint,
		MaxBytes:        metadata.MaxBytes,
		MaxExtractBytes: metadata.MaxExtractBytes,
	}
	return m.options.SignatureVerifier(ctx, SignatureInput{
		CandidateID:  candidate.ID,
		Artifact:     artifact,
		ArtifactPath: payload,
		SHA256:       actual,
	})
}

func (m *Manager) commitVersion(candidate Candidate, metadata CandidateComponent) error {
	source := filepath.Join(candidate.Path, "runtime", string(metadata.Component))
	targetParent := filepath.Join(m.layout.Versions, string(metadata.Component))
	if err := os.MkdirAll(targetParent, 0o700); err != nil {
		return err
	}
	target := filepath.Join(targetParent, metadata.Version)
	if _, err := os.Lstat(target); err == nil {
		return m.verifyRuntimeRoot(target, metadata)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	temporary, err := os.MkdirTemp(targetParent, "."+metadata.Version+"-*")
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(temporary)
		}
	}()
	if err := copyRuntimeTree(source, temporary); err != nil {
		return err
	}
	if err := m.verifyRuntimeRoot(temporary, metadata); err != nil {
		return err
	}
	if err := os.Rename(temporary, target); err != nil {
		return fmt.Errorf("atomically commit runtime version: %w", err)
	}
	committed = true
	return nil
}

func copyRuntimeTree(source, destination string) error {
	return filepath.WalkDir(source, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, current)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("candidate runtime tree contains a symlink")
		}
		target, err := safeJoin(destination, relative)
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return ensureDirectory(target)
		}
		if !entry.Type().IsRegular() {
			return errors.New("candidate runtime tree contains a non-regular file")
		}
		return copyFileDurable(current, target, defaultMaxExtractBytes)
	})
}

// ProcessPaths resolves executable paths from active.json only. It never
// searches PATH or attempts to launch an unverified candidate.
func (m *Manager) ProcessPaths() (ProcessPaths, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.ensureNoActivationJournal(); err != nil {
		return ProcessPaths{}, err
	}
	active, err := m.readActive()
	if errors.Is(err, os.ErrNotExist) {
		return ProcessPaths{}, ErrNoActiveRuntime
	}
	if err != nil {
		return ProcessPaths{}, err
	}
	return m.processPathsForActive(active)
}

func (m *Manager) processPathsForCandidate(candidate Candidate) (ProcessPaths, error) {
	return m.processPaths(candidate.Components, func(component Component, metadata CandidateComponent) string {
		return filepath.Join(candidate.Path, "runtime", string(component))
	})
}

func (m *Manager) processPathsForActive(active ActiveState) (ProcessPaths, error) {
	components := make(map[Component]CandidateComponent, len(managedComponents()))
	roots := make(map[Component]string, len(managedComponents()))
	for _, component := range managedComponents() {
		version := active.Versions[component]
		root, err := m.activeComponentRoot(active, component)
		if err != nil {
			return ProcessPaths{}, err
		}
		var metadata VersionMetadata
		if err := readJSON(filepath.Join(root, versionFileName), &metadata); err != nil {
			return ProcessPaths{}, err
		}
		components[component] = CandidateComponent{
			Component:  component,
			Version:    version,
			SHA256:     metadata.PayloadSHA256,
			TreeSHA256: metadata.TreeSHA256,
			Entrypoint: metadata.Entrypoint,
		}
		roots[component] = root
	}
	return m.processPaths(components, func(component Component, metadata CandidateComponent) string {
		return roots[component]
	})
}

func (m *Manager) activeComponentRoot(active ActiveState, component Component) (string, error) {
	if len(active.ComponentRoots) == 0 {
		return filepath.Join(m.layout.Versions, string(component), active.Versions[component]), nil
	}
	relative, present := active.ComponentRoots[component]
	if !present {
		return "", fmt.Errorf("active packaged runtime root is missing %q", component)
	}
	root, err := safeJoin(m.layout.Root, filepath.FromSlash(relative))
	if err != nil {
		return "", fmt.Errorf("resolve active packaged runtime root %q: %w", component, err)
	}
	return root, nil
}

func (m *Manager) processPaths(components map[Component]CandidateComponent, rootFor func(Component, CandidateComponent) string) (ProcessPaths, error) {
	resolved := make(map[Component]string, len(managedComponents()))
	roots := make(map[Component]string, len(managedComponents()))
	for _, component := range managedComponents() {
		metadata, present := components[component]
		if !present {
			return ProcessPaths{}, fmt.Errorf("runtime paths are missing %q", component)
		}
		root := rootFor(component, metadata)
		if err := m.verifyRuntimeRoot(root, metadata); err != nil {
			return ProcessPaths{}, fmt.Errorf("verify active %s runtime: %w", component, err)
		}
		entrypoint, err := safeJoin(root, metadata.Entrypoint)
		if err != nil {
			return ProcessPaths{}, err
		}
		resolved[component] = entrypoint
		roots[component] = root
	}
	node := resolved[ComponentNode]
	codex := resolved[ComponentCodex]
	mcp := resolved[ComponentChromeDevtoolsMCP]
	oxigraph := resolved[ComponentOxigraph]
	vspaero, err := verifiedRuntimeFile(roots[ComponentOpenVSP], "vspaero.exe", false)
	if err != nil {
		return ProcessPaths{}, fmt.Errorf("verify active openvsp VSPAERO executable: %w", err)
	}
	vspaeroOpt, err := verifiedRuntimeFile(roots[ComponentOpenVSP], "vspaero_opt.exe", false)
	if err != nil {
		return ProcessPaths{}, fmt.Errorf("verify active openvsp VSPAERO optimizer: %w", err)
	}
	su2sol, err := verifiedRuntimeFile(roots[ComponentSU2], "SU2_SOL.exe", true)
	if err != nil {
		return ProcessPaths{}, fmt.Errorf("verify active SU2 solution utility: %w", err)
	}
	return ProcessPaths{
		NodeExecutable:              node,
		CodexEntrypoint:             codex,
		ChromeDevtoolsMCPEntrypoint: mcp,
		OxigraphPackageEntrypoint:   oxigraph,
		OxigraphModuleDirectory:     filepath.Dir(oxigraph),
		OpenVSPScriptExecutable:     resolved[ComponentOpenVSP],
		VSPAEROExecutable:           vspaero,
		VSPAEROOptExecutable:        vspaeroOpt,
		GmshExecutable:              resolved[ComponentGmsh],
		XFOILExecutable:             resolved[ComponentXFOIL],
		SU2CFDExecutable:            resolved[ComponentSU2],
		SU2SOLExecutable:            su2sol,
		CodexAppServer:              Command{Path: node, Args: []string{codex, "app-server"}},
		ChromeDevtoolsMCP:           Command{Path: node, Args: []string{mcp}},
	}, nil
}

func verifiedRuntimeFile(root, relative string, optional bool) (string, error) {
	path, err := safeJoin(root, relative)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(path)
	if optional && errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("runtime companion entrypoint is not a regular file")
	}
	return path, nil
}

func validateProbeReport(report ProbeReport) error {
	for _, probe := range []ProbeEvidence{report.AppServer, report.Browser} {
		if !probe.Executed || !probe.Compatible || strings.TrimSpace(probe.Observation) == "" || probe.ObservedAt.IsZero() {
			return errors.New("runtime compatibility probe did not provide successful live evidence")
		}
	}
	return nil
}
