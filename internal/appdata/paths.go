package appdata

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const internetProfileResetMarkerContents = "AETHEROPS_RESET_INTERNET_PROFILE_V1\n"
const isolatedDataRootMarkerContents = "AETHEROPS_RELEASE_EVAL_DATA_ROOT_V1\n"

type Paths struct {
	Root               string
	Database           string
	CAS                string
	CodexHome          string
	ShellProfile       string
	InternetProfile    string
	ProfileResetMarker string
	Downloads          string
	ManagedRuntimes    string
	RuntimeCandidates  string
}

func Resolve() (Paths, error) {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		return Paths{}, errors.New("LOCALAPPDATA is not available")
	}
	return resolveLayout(filepath.Join(localAppData, "AetherOps", "v2"))
}

// ResolveIsolated opens an explicitly selected release-evaluation data root.
// The first use must point at an empty, canonical, local directory. A durable
// ownership marker permits later evaluation sessions to reopen that exact root.
// Ordinary application startup never calls this function.
func ResolveIsolated(root string) (Paths, error) {
	absolute, err := validateIsolatedRoot(root)
	if err != nil {
		return Paths{}, err
	}
	marker := filepath.Join(absolute, ".aetherops-release-eval-root")
	entries, err := os.ReadDir(absolute)
	if err != nil {
		return Paths{}, fmt.Errorf("inspect isolated data root: %w", err)
	}
	if len(entries) == 0 {
		file, err := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return Paths{}, fmt.Errorf("claim isolated data root: %w", err)
		}
		if _, err := io.WriteString(file, isolatedDataRootMarkerContents); err != nil {
			_ = file.Close()
			_ = os.Remove(marker)
			return Paths{}, fmt.Errorf("write isolated data root marker: %w", err)
		}
		if err := file.Sync(); err != nil {
			_ = file.Close()
			_ = os.Remove(marker)
			return Paths{}, fmt.Errorf("sync isolated data root marker: %w", err)
		}
		if err := file.Close(); err != nil {
			_ = os.Remove(marker)
			return Paths{}, fmt.Errorf("close isolated data root marker: %w", err)
		}
	} else {
		contents, err := os.ReadFile(marker)
		if err != nil || !bytes.Equal(contents, []byte(isolatedDataRootMarkerContents)) {
			return Paths{}, errors.New("isolated data root is non-empty and is not owned by AetherOps release evaluation")
		}
	}
	return resolveLayout(absolute)
}

func resolveLayout(root string) (Paths, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return Paths{}, err
	}
	paths := Paths{
		Root:               absolute,
		Database:           filepath.Join(absolute, "aetherops.db"),
		CAS:                filepath.Join(absolute, "objects"),
		CodexHome:          filepath.Join(absolute, "codex-home"),
		ShellProfile:       filepath.Join(absolute, "webview2", "shell"),
		InternetProfile:    filepath.Join(absolute, "webview2", "internet"),
		ProfileResetMarker: filepath.Join(absolute, "reset-internet-profile.pending"),
		Downloads:          filepath.Join(absolute, "downloads", "quarantine"),
		ManagedRuntimes:    filepath.Join(absolute, "runtimes", "versions"),
		RuntimeCandidates:  filepath.Join(absolute, "runtimes", "candidates"),
	}
	for _, directory := range []string{
		paths.Root, paths.CAS, paths.CodexHome, paths.ShellProfile,
		paths.InternetProfile, paths.Downloads, paths.ManagedRuntimes,
		paths.RuntimeCandidates,
	} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return Paths{}, err
		}
	}
	return paths, nil
}

// ScheduleInternetProfileReset durably records an explicit request to reset
// only AetherOps' isolated internet WebView2 profile. The reset is applied on
// the next application start, after the current host has stopped every
// internet controller and before a new WebView2 environment can open it.
func ScheduleInternetProfileReset(paths Paths) error {
	if err := validateInternetProfileResetPaths(paths); err != nil {
		return err
	}
	if data, err := os.ReadFile(paths.ProfileResetMarker); err == nil {
		if bytes.Equal(data, []byte(internetProfileResetMarkerContents)) {
			return nil
		}
		return errors.New("internet profile reset marker has unexpected contents")
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect internet profile reset marker: %w", err)
	}
	file, err := os.CreateTemp(filepath.Dir(paths.ProfileResetMarker), filepath.Base(paths.ProfileResetMarker)+".tmp-*")
	if err != nil {
		return fmt.Errorf("create internet profile reset marker: %w", err)
	}
	temporary := file.Name()
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("secure internet profile reset marker: %w", err)
	}
	removeTemporary := true
	defer func() {
		_ = file.Close()
		if removeTemporary {
			_ = os.Remove(temporary)
		}
	}()
	if _, err := io.WriteString(file, internetProfileResetMarkerContents); err != nil {
		return fmt.Errorf("write internet profile reset marker: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync internet profile reset marker: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close internet profile reset marker: %w", err)
	}
	if err := os.Rename(temporary, paths.ProfileResetMarker); err != nil {
		return fmt.Errorf("publish internet profile reset marker: %w", err)
	}
	removeTemporary = false
	return nil
}

// ApplyPendingInternetProfileReset removes only the validated AetherOps
// internet profile. It deliberately preserves the shell profile, database,
// CAS, Codex home, downloads, and every path outside the v2 data root.
func ApplyPendingInternetProfileReset(paths Paths) (bool, error) {
	if err := validateInternetProfileResetPaths(paths); err != nil {
		return false, err
	}
	data, err := os.ReadFile(paths.ProfileResetMarker)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read internet profile reset marker: %w", err)
	}
	if !bytes.Equal(data, []byte(internetProfileResetMarkerContents)) {
		return false, errors.New("internet profile reset marker has unexpected contents")
	}
	if err := verifyNoProfilePathRedirection(paths); err != nil {
		return false, err
	}
	if err := os.RemoveAll(paths.InternetProfile); err != nil {
		return false, fmt.Errorf("remove isolated internet profile: %w", err)
	}
	if err := os.MkdirAll(paths.InternetProfile, 0o700); err != nil {
		return false, fmt.Errorf("recreate isolated internet profile: %w", err)
	}
	if err := os.Remove(paths.ProfileResetMarker); err != nil {
		return false, fmt.Errorf("remove applied internet profile reset marker: %w", err)
	}
	return true, nil
}

func validateInternetProfileResetPaths(paths Paths) error {
	root, err := filepath.Abs(strings.TrimSpace(paths.Root))
	if err != nil || strings.TrimSpace(paths.Root) == "" {
		return errors.New("AetherOps data root is required for profile reset")
	}
	profile, err := filepath.Abs(strings.TrimSpace(paths.InternetProfile))
	if err != nil || strings.TrimSpace(paths.InternetProfile) == "" {
		return errors.New("internet profile path is required for profile reset")
	}
	marker, err := filepath.Abs(strings.TrimSpace(paths.ProfileResetMarker))
	if err != nil || strings.TrimSpace(paths.ProfileResetMarker) == "" {
		return errors.New("internet profile reset marker path is required")
	}
	expectedProfile := filepath.Join(root, "webview2", "internet")
	expectedMarker := filepath.Join(root, "reset-internet-profile.pending")
	if !samePath(profile, expectedProfile) || !samePath(marker, expectedMarker) {
		return errors.New("internet profile reset paths are outside the fixed AetherOps v2 layout")
	}
	if samePath(profile, root) || samePath(profile, filepath.Dir(root)) {
		return errors.New("internet profile reset target is too broad")
	}
	return nil
}

func verifyNoProfilePathRedirection(paths Paths) error {
	root, err := filepath.EvalSymlinks(paths.Root)
	if err != nil {
		return fmt.Errorf("resolve AetherOps data root: %w", err)
	}
	webviewRoot, err := filepath.EvalSymlinks(filepath.Join(paths.Root, "webview2"))
	if err != nil {
		return fmt.Errorf("resolve WebView2 data root: %w", err)
	}
	if !samePath(webviewRoot, filepath.Join(root, "webview2")) {
		return errors.New("internet profile reset refused a redirected filesystem path")
	}
	profile, err := filepath.EvalSymlinks(paths.InternetProfile)
	if errors.Is(err, os.ErrNotExist) {
		// A prior reset process may have exited after RemoveAll and before
		// MkdirAll. Permit that exact missing leaf so the durable marker can
		// finish the reset on this start. A dangling symlink still fails closed.
		info, lstatErr := os.Lstat(paths.InternetProfile)
		if lstatErr == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				return errors.New("internet profile reset refused a redirected filesystem path")
			}
			return fmt.Errorf("resolve internet profile: %w", err)
		}
		if !errors.Is(lstatErr, os.ErrNotExist) {
			return fmt.Errorf("inspect missing internet profile: %w", lstatErr)
		}
		profile = filepath.Join(webviewRoot, "internet")
	} else if err != nil {
		return fmt.Errorf("resolve internet profile: %w", err)
	}
	if !samePath(profile, filepath.Join(webviewRoot, "internet")) {
		return errors.New("internet profile reset refused a redirected filesystem path")
	}
	return nil
}

func samePath(left, right string) bool {
	return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
}
