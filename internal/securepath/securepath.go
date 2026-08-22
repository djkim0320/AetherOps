// Package securepath provides handle-checked reads for release evidence. It
// rejects symlinks and Windows reparse points in every path component and
// confirms the opened file remains below the intended directory.
package securepath

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func RelativeName(value string) (string, error) {
	if strings.TrimSpace(value) == "" || value != strings.TrimSpace(value) ||
		filepath.IsAbs(value) || filepath.VolumeName(value) != "" || strings.ContainsRune(value, ':') {
		return "", errors.New("path must be a canonical relative name")
	}
	clean := filepath.Clean(value)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("relative path escapes its base")
	}
	return clean, nil
}

func SiblingName(value string) (string, error) {
	clean, err := RelativeName(value)
	if err != nil {
		return "", err
	}
	if filepath.Base(clean) != clean || strings.ContainsAny(clean, `/\`) {
		return "", errors.New("path must name a direct sibling file")
	}
	return clean, nil
}

func RegularPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return RegularPathWithin(filepath.Dir(absolute), filepath.Base(absolute))
}

func RegularPathWithin(baseDirectory, relative string) (string, error) {
	base, err := filepath.Abs(baseDirectory)
	if err != nil {
		return "", err
	}
	clean, err := RelativeName(relative)
	if err != nil {
		return "", err
	}
	candidate, err := filepath.Abs(filepath.Join(base, clean))
	if err != nil {
		return "", err
	}
	if !contained(base, candidate) {
		return "", errors.New("path escapes its base directory")
	}
	if err := rejectRedirectedComponents(base); err != nil {
		return "", fmt.Errorf("validate base directory: %w", err)
	}
	if err := rejectRedirectedComponents(candidate); err != nil {
		return "", fmt.Errorf("validate candidate path: %w", err)
	}
	baseInfo, err := os.Lstat(base)
	if err != nil || !baseInfo.IsDir() || baseInfo.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("base is not a regular directory")
	}
	info, err := os.Lstat(candidate)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("candidate is not a regular non-symlink file")
	}
	file, err := os.Open(candidate)
	if err != nil {
		return "", err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) {
		return "", errors.New("candidate changed while opening")
	}
	finalCandidate, err := finalPath(file)
	if err != nil {
		return "", err
	}
	finalBase, err := openedDirectoryPath(base)
	if err != nil {
		return "", err
	}
	if !contained(finalBase, finalCandidate) {
		return "", errors.New("opened file escaped its base through a redirected path")
	}
	return candidate, nil
}

func ReadRegular(path string, maxBytes int64) ([]byte, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	return ReadRegularWithin(filepath.Dir(absolute), filepath.Base(absolute), maxBytes)
}

func ReadRegularWithin(baseDirectory, relative string, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		return nil, errors.New("positive read limit is required")
	}
	path, err := RegularPathWithin(baseDirectory, relative)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil || !before.Mode().IsRegular() || before.Size() < 0 || before.Size() > maxBytes {
		return nil, errors.New("regular file exceeds its read contract")
	}
	finalCandidate, err := finalPath(file)
	if err != nil {
		return nil, err
	}
	finalBase, err := openedDirectoryPath(baseDirectory)
	if err != nil || !contained(finalBase, finalCandidate) {
		return nil, errors.New("opened file escaped its base through a redirected path")
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, err
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) || after.Size() != before.Size() ||
		!after.ModTime().Equal(before.ModTime()) || int64(len(raw)) != before.Size() {
		return nil, errors.New("regular file changed while reading")
	}
	return raw, nil
}

func openedDirectoryPath(path string) (string, error) {
	directory, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer directory.Close()
	return finalPath(directory)
}

func contained(base, candidate string) bool {
	base = filepath.Clean(base)
	candidate = filepath.Clean(candidate)
	if strings.EqualFold(base, candidate) {
		return false
	}
	prefix := strings.TrimRight(base, `\/`) + string(filepath.Separator)
	return strings.HasPrefix(strings.ToLower(candidate), strings.ToLower(prefix))
}
