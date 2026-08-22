//go:build windows && amd64

package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"golang.org/x/sys/windows"
)

const releaseEvalSessionDescriptorSchema = "aetherops_release_eval_api_session_v2"

type releaseEvalSessionOptions struct {
	DescriptorPath string
	DataRoot       string
}

type releaseEvalSessionDescriptor struct {
	Schema        string                        `json:"schema"`
	Endpoint      string                        `json:"endpoint"`
	TokenFile     string                        `json:"token_file"`
	PID           int                           `json:"pid"`
	ProductBuild  buildinfo.ProductBuildBinding `json:"product_build"`
	StartedAt     time.Time                     `json:"started_at"`
	Mode          string                        `json:"mode"`
	BuildMode     string                        `json:"build_mode"`
	RuntimeReady  bool                          `json:"runtime_set_ready"`
	CodexReady    bool                          `json:"codex_initialize_model_list_ready"`
	OxigraphReady bool                          `json:"oxigraph_handshake_ready"`
	APIReady      bool                          `json:"api_ready"`
}

func parseReleaseEvalSessionArgs(args []string) (releaseEvalSessionOptions, error) {
	flags := flag.NewFlagSet("release-eval-session", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	descriptor := flags.String("descriptor", "", "new local release-evaluation API session descriptor")
	dataRoot := flags.String("data-root", "", "explicit isolated release-evaluation data root")
	if err := flags.Parse(args); err != nil {
		return releaseEvalSessionOptions{}, err
	}
	if flags.NArg() != 0 || strings.TrimSpace(*descriptor) == "" || strings.TrimSpace(*dataRoot) == "" {
		return releaseEvalSessionOptions{}, errors.New("release-eval-session requires exactly --descriptor <new-file> --data-root <isolated-directory>")
	}
	return releaseEvalSessionOptions{DescriptorPath: strings.TrimSpace(*descriptor), DataRoot: strings.TrimSpace(*dataRoot)}, nil
}

func parseGate0Args(args []string) (string, error) {
	flags := flag.NewFlagSet("gate0", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	dataRoot := flags.String("data-root", "", "explicit isolated Gate 0 data root")
	if err := flags.Parse(args); err != nil {
		return "", err
	}
	if flags.NArg() != 0 || strings.TrimSpace(*dataRoot) == "" {
		return "", errors.New("gate0 requires exactly --data-root <empty-or-owned-isolated-directory>")
	}
	return strings.TrimSpace(*dataRoot), nil
}

func parseOptionalDataRootArgs(command string, args []string) (string, error) {
	if len(args) == 0 {
		return "", nil
	}
	if len(args) != 2 || args[0] != "--data-root" || strings.TrimSpace(args[1]) == "" {
		return "", fmt.Errorf("%s accepts only an explicit --data-root <owned-release-evaluation-directory>", command)
	}
	return strings.TrimSpace(args[1]), nil
}

func publishReleaseEvalSessionDescriptor(
	descriptorPath, endpoint, token string,
	productBuild buildinfo.ProductBuildBinding,
) (func() error, error) {
	if err := productBuild.Validate(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(token) == "" || strings.ContainsAny(token, "\r\n") {
		return nil, errors.New("release evaluation API token is invalid")
	}
	descriptor, err := validateNewLocalDescriptorPath(descriptorPath)
	if err != nil {
		return nil, err
	}
	tokenPath := descriptor + ".token"
	for _, path := range []string{descriptor, tokenPath} {
		if _, err := os.Lstat(path); err == nil {
			return nil, fmt.Errorf("release evaluation session output already exists: %s", filepath.Base(path))
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	if err := secureCreateExclusive(tokenPath, append([]byte(token), '\n')); err != nil {
		return nil, fmt.Errorf("create release evaluation token file: %w", err)
	}
	removeToken := true
	defer func() {
		if removeToken {
			_ = os.Remove(tokenPath)
		}
	}()
	description := releaseEvalSessionDescriptor{
		Schema: releaseEvalSessionDescriptorSchema, Endpoint: endpoint,
		TokenFile: filepath.Base(tokenPath), PID: os.Getpid(), ProductBuild: productBuild,
		StartedAt: time.Now().UTC(), Mode: "normal", BuildMode: normalizedBuildMode(),
		RuntimeReady: true, CodexReady: true, OxigraphReady: true, APIReady: true,
	}
	raw, err := json.MarshalIndent(description, "", "  ")
	if err != nil {
		return nil, err
	}
	raw = append(raw, '\n')
	temporary, err := descriptorTemporaryPath(descriptor)
	if err != nil {
		return nil, err
	}
	if err := secureCreateExclusive(temporary, raw); err != nil {
		return nil, fmt.Errorf("create release evaluation descriptor temporary file: %w", err)
	}
	removeTemporary := true
	defer func() {
		if removeTemporary {
			_ = os.Remove(temporary)
		}
	}()
	if err := os.Rename(temporary, descriptor); err != nil {
		return nil, fmt.Errorf("publish release evaluation descriptor atomically: %w", err)
	}
	removeTemporary = false
	removeToken = false
	cleanup := func() error {
		var cleanupErrors []error
		for _, path := range []string{descriptor, tokenPath} {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				cleanupErrors = append(cleanupErrors, err)
			}
		}
		return errors.Join(cleanupErrors...)
	}
	return cleanup, nil
}

func validateNewLocalDescriptorPath(path string) (string, error) {
	absolute, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(absolute, `\\`) || filepath.VolumeName(absolute) == "" {
		return "", errors.New("release evaluation descriptor must use a local absolute drive path")
	}
	remainder := strings.TrimPrefix(absolute, filepath.VolumeName(absolute))
	if strings.Contains(remainder, ":") {
		return "", errors.New("release evaluation descriptor cannot use an alternate data stream")
	}
	parent := filepath.Dir(absolute)
	info, err := os.Lstat(parent)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("release evaluation descriptor parent must be an existing regular local directory")
	}
	parentPointer, err := windows.UTF16PtrFromString(parent)
	if err != nil {
		return "", err
	}
	attributes, err := windows.GetFileAttributes(parentPointer)
	if err != nil || attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return "", errors.New("release evaluation descriptor parent cannot be a reparse point")
	}
	return absolute, nil
}

func descriptorTemporaryPath(descriptor string) (string, error) {
	random := make([]byte, 12)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return descriptor + ".tmp-" + hex.EncodeToString(random), nil
}

func secureCreateExclusive(path string, content []byte) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;;GA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return err
	}
	security := &windows.SecurityAttributes{
		Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: descriptor,
	}
	pointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(
		pointer, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, security,
		windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0,
	)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(handle), path)
	if file == nil {
		_ = windows.CloseHandle(handle)
		return errors.New("wrap secure release evaluation session file")
	}
	committed := false
	defer func() {
		_ = file.Close()
		if !committed {
			_ = os.Remove(path)
		}
	}()
	if _, err := file.Write(content); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	committed = true
	return nil
}
