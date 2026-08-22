//go:build windows

package appdata

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func validateIsolatedRoot(root string) (string, error) {
	trimmed := strings.TrimSpace(root)
	if trimmed == "" || !filepath.IsAbs(trimmed) {
		return "", errors.New("isolated data root must be an absolute local path")
	}
	absolute, err := filepath.Abs(trimmed)
	if err != nil || !strings.EqualFold(filepath.Clean(trimmed), trimmed) || !samePath(trimmed, absolute) ||
		strings.HasPrefix(absolute, `\\`) || filepath.VolumeName(absolute) == "" {
		return "", errors.New("isolated data root must be a canonical absolute local drive path")
	}
	remainder := strings.TrimPrefix(absolute, filepath.VolumeName(absolute))
	if strings.Contains(remainder, ":") || filepath.Dir(absolute) == absolute {
		return "", errors.New("isolated data root is unsafe or too broad")
	}
	localAppData := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
	if localAppData == "" {
		return "", errors.New("LOCALAPPDATA is not available")
	}
	production, err := filepath.Abs(filepath.Join(localAppData, "AetherOps", "v2"))
	if err != nil {
		return "", err
	}
	productionPrefix := strings.TrimRight(filepath.Clean(production), `\/`) + string(os.PathSeparator)
	cleaned := filepath.Clean(absolute)
	if samePath(cleaned, localAppData) || samePath(cleaned, production) ||
		strings.HasPrefix(strings.ToLower(cleaned+string(os.PathSeparator)), strings.ToLower(productionPrefix)) {
		return "", errors.New("isolated data root cannot use the production AetherOps data tree")
	}
	info, err := os.Lstat(cleaned)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("isolated data root must be an existing regular directory")
	}
	pointer, err := windows.UTF16PtrFromString(cleaned)
	if err != nil {
		return "", err
	}
	attributes, err := windows.GetFileAttributes(pointer)
	if err != nil || attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return "", errors.New("isolated data root cannot be a reparse point")
	}
	resolved, err := filepath.EvalSymlinks(cleaned)
	if err != nil || !samePath(resolved, cleaned) {
		return "", errors.New("isolated data root contains redirected path components")
	}
	return cleaned, nil
}
