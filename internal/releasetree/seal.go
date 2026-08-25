package releasetree

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/djkim0320/AetherOps/internal/securepath"
)

const (
	identityDomain = "aetherops-release-source-tree-v1\x00"
	MaxFileBytes   = 64 << 20
)

type Seal struct {
	SHA256    string
	FileCount int
}

var rootFiles = map[string]struct{}{
	".env.example": {}, ".gitignore": {}, "AGENTS.md": {}, "README.md": {},
	"SECURITY.md": {}, "THIRD_PARTY_NOTICES.md": {}, "dependency-policy.json": {},
	"go.mod": {}, "go.sum": {}, "runtime-manifest.json": {},
}

var rootDirectories = map[string]struct{}{
	".github": {}, "cmd": {}, "docs": {}, "evals": {}, "frontend": {},
	"internal": {}, "packaging": {}, "sbom": {}, "tools": {},
}

func RootFiles() map[string]struct{}       { return cloneSet(rootFiles) }
func RootDirectories() map[string]struct{} { return cloneSet(rootDirectories) }

func cloneSet(source map[string]struct{}) map[string]struct{} {
	result := make(map[string]struct{}, len(source))
	for key := range source {
		result[key] = struct{}{}
	}
	return result
}

// Compute hashes the complete release-relevant source tree. Build outputs,
// managed runtimes, package caches, user data, Git metadata, and historical
// distributions are deliberately outside the fixed allowlist.
func Compute(sourceRoot string) (Seal, error) {
	root, err := filepath.Abs(sourceRoot)
	if err != nil {
		return Seal{}, err
	}
	if err := rejectReparse(root); err != nil {
		return Seal{}, fmt.Errorf("validate source root: %w", err)
	}
	for name := range rootFiles {
		if _, err := securepath.RegularPathWithin(root, name); err != nil {
			return Seal{}, fmt.Errorf("required release source %s: %w", name, err)
		}
	}
	for name := range rootDirectories {
		path := filepath.Join(root, name)
		if err := rejectReparse(path); err != nil {
			return Seal{}, fmt.Errorf("required release source directory %s: %w", name, err)
		}
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return Seal{}, fmt.Errorf("required release source directory %s is missing or redirected", name)
		}
	}
	var names []string
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := rejectReparse(path); err != nil {
			return fmt.Errorf("source path %s: %w", path, err)
		}
		if path == root {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		canonical := filepath.ToSlash(relative)
		parts := strings.Split(canonical, "/")
		if len(parts) == 0 {
			return errors.New("source tree produced an empty relative path")
		}
		if len(parts) == 1 {
			if entry.IsDir() {
				if _, included := rootDirectories[parts[0]]; !included {
					return fs.SkipDir
				}
				return nil
			}
			if _, included := rootFiles[parts[0]]; !included {
				return nil
			}
		} else {
			if _, included := rootDirectories[parts[0]]; !included {
				if entry.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if entry.IsDir() && strings.EqualFold(parts[len(parts)-1], "node_modules") {
				return fs.SkipDir
			}
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > MaxFileBytes {
			return fmt.Errorf("release source %s is not a bounded regular file", canonical)
		}
		names = append(names, canonical)
		return nil
	})
	if err != nil {
		return Seal{}, err
	}
	if len(names) == 0 {
		return Seal{}, errors.New("release source tree is empty")
	}
	sort.Slice(names, func(left, right int) bool { return strings.ToLower(names[left]) < strings.ToLower(names[right]) })
	digest := sha256.New()
	_, _ = digest.Write([]byte(identityDomain))
	seen := make(map[string]struct{}, len(names))
	for _, name := range names {
		key := strings.ToLower(name)
		if _, duplicate := seen[key]; duplicate {
			return Seal{}, fmt.Errorf("case-insensitive duplicate release source path %s", name)
		}
		seen[key] = struct{}{}
		raw, err := securepath.ReadRegularWithin(root, filepath.FromSlash(name), MaxFileBytes)
		if err != nil {
			return Seal{}, fmt.Errorf("read release source %s: %w", name, err)
		}
		fileDigest := sha256.Sum256(raw)
		_, _ = digest.Write([]byte(name))
		_, _ = digest.Write([]byte{0})
		_, _ = digest.Write([]byte(strconv.Itoa(len(raw))))
		_, _ = digest.Write([]byte{0})
		_, _ = digest.Write([]byte(hex.EncodeToString(fileDigest[:])))
		_, _ = digest.Write([]byte{'\n'})
	}
	return Seal{SHA256: hex.EncodeToString(digest.Sum(nil)), FileCount: len(names)}, nil
}
