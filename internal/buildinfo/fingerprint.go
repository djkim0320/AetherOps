package buildinfo

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	ReleaseProductVersion = "0.1.0-alpha.1"
	sidecarTreeDomain     = "aetherops-knowledge-sidecar-tree-v1\x00"
)

var knowledgeSidecarFiles = [...]string{"index.cjs", "protocol.cjs", "worker.cjs"}

// ProductBuildBinding identifies every first-party executable input that can
// affect a research run. It is persisted on the run and copied into every
// immutable stage execution receipt.
type ProductBuildBinding struct {
	Version                    string `json:"version"`
	ExecutableSHA256           string `json:"executable_sha256"`
	RuntimeManifestSHA256      string `json:"runtime_manifest_sha256"`
	KnowledgeSidecarTreeSHA256 string `json:"knowledge_sidecar_tree_sha256"`
}

func (binding ProductBuildBinding) IsZero() bool {
	return binding == ProductBuildBinding{}
}

func (binding ProductBuildBinding) Validate() error {
	if binding.Version != ReleaseProductVersion {
		return fmt.Errorf("version is %q, want %q", binding.Version, ReleaseProductVersion)
	}
	for label, digest := range map[string]string{
		"executable SHA-256":             binding.ExecutableSHA256,
		"runtime manifest SHA-256":       binding.RuntimeManifestSHA256,
		"knowledge sidecar tree SHA-256": binding.KnowledgeSidecarTreeSHA256,
	} {
		decoded, err := hex.DecodeString(digest)
		if err != nil || len(decoded) != sha256.Size || digest != strings.ToLower(digest) {
			return fmt.Errorf("%s is invalid", label)
		}
	}
	return nil
}

// BindProductBuild hashes the executable, runtime manifest, and the complete
// fixed first-party sidecar file set. The sidecar digest is path-independent
// and ordered by the reviewed filename list, so packaging location cannot
// change the binding while a missing, renamed, or replaced sibling always can.
func BindProductBuild(executablePath, runtimeManifestPath, knowledgeSidecarEntrypoint string) (ProductBuildBinding, error) {
	executableHash, err := hashRegularFile(executablePath)
	if err != nil {
		return ProductBuildBinding{}, fmt.Errorf("hash AetherOps executable: %w", err)
	}
	runtimeHash, err := hashRegularFile(runtimeManifestPath)
	if err != nil {
		return ProductBuildBinding{}, fmt.Errorf("hash runtime manifest: %w", err)
	}
	sidecarHash, err := hashKnowledgeSidecarTree(knowledgeSidecarEntrypoint)
	if err != nil {
		return ProductBuildBinding{}, fmt.Errorf("hash knowledge sidecar tree: %w", err)
	}
	binding := ProductBuildBinding{
		Version: ReleaseProductVersion, ExecutableSHA256: executableHash,
		RuntimeManifestSHA256: runtimeHash, KnowledgeSidecarTreeSHA256: sidecarHash,
	}
	return binding, binding.Validate()
}

func hashKnowledgeSidecarTree(entrypoint string) (string, error) {
	if filepath.Base(filepath.Clean(entrypoint)) != knowledgeSidecarFiles[0] {
		return "", errors.New("knowledge sidecar entrypoint must be index.cjs")
	}
	directory := filepath.Dir(entrypoint)
	hash := sha256.New()
	_, _ = io.WriteString(hash, sidecarTreeDomain)
	for _, name := range knowledgeSidecarFiles {
		path := filepath.Join(directory, name)
		info, err := os.Lstat(path)
		if err != nil {
			return "", fmt.Errorf("inspect %s: %w", name, err)
		}
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("%s is not a regular file", name)
		}
		if err := binary.Write(hash, binary.BigEndian, uint32(len(name))); err != nil {
			return "", err
		}
		_, _ = io.WriteString(hash, name)
		if err := binary.Write(hash, binary.BigEndian, uint64(info.Size())); err != nil {
			return "", err
		}
		file, err := os.Open(path)
		if err != nil {
			return "", fmt.Errorf("open %s: %w", name, err)
		}
		written, copyErr := io.Copy(hash, file)
		closeErr := file.Close()
		if copyErr != nil {
			return "", fmt.Errorf("hash %s: %w", name, copyErr)
		}
		if closeErr != nil {
			return "", fmt.Errorf("close %s: %w", name, closeErr)
		}
		if written != info.Size() {
			return "", fmt.Errorf("%s changed while hashing", name)
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func hashRegularFile(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("release input is not a regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	written, err := io.Copy(hash, file)
	if err != nil {
		return "", err
	}
	if written != info.Size() {
		return "", errors.New("release input changed while hashing")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
