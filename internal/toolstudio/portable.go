package toolstudio

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/processutil"
	"github.com/djkim0320/AetherOps/internal/store"
)

const (
	portableDownloadTimeout     = 10 * time.Minute
	portableResponseHeaderBytes = 64 << 10
	portableMaxArchiveFiles     = 256
	portableMaxExtractBytes     = int64(1 << 30)
	portableMaxCompressionRatio = uint64(200)
	portableProbeTimeout        = 30 * time.Second
	portableProbeOutputBytes    = int64(1 << 20)
	portableStderrBytes         = int64(512 << 10)
)

type portableMaterialization struct {
	Payload     cas.Receipt
	TreeSHA256  string
	InstallPath string
	ProbeOutput string
}

type portableRunResult struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
}

// InstallForStage is called only after Codex App Server has obtained the
// user's approval for tool_package_install. The approval names every immutable
// source and adapter hash, and the resulting grant is scoped to this exact
// in-progress research attempt.
func (service *Service) InstallForStage(ctx context.Context, runID, stageAttemptID string, actual InstallApproval) (core.ToolPackage, error) {
	if service == nil || service.DB == nil {
		return core.ToolPackage{}, errors.New("tool studio storage is unavailable")
	}
	projectID, err := service.DB.ValidateStageCapability(ctx, runID, stageAttemptID)
	if err != nil {
		return core.ToolPackage{}, err
	}
	pkg, err := service.DB.ToolPackage(ctx, projectID, actual.PackageID, true)
	if err != nil {
		return core.ToolPackage{}, err
	}
	expected, err := ExpectedInstallApproval(pkg)
	if err != nil {
		return core.ToolPackage{}, err
	}
	if err := ValidateInstallApproval(expected, actual); err != nil {
		return core.ToolPackage{}, err
	}
	manifest, _, err := ParseManifest(pkg.ManifestJSON)
	if err != nil {
		return core.ToolPackage{}, err
	}
	return service.installPortable(ctx, pkg, manifest, expected, runID, stageAttemptID)
}

func (service *Service) installPortable(ctx context.Context, pkg core.ToolPackage, manifest Manifest, approval InstallApproval, runID, stageAttemptID string) (result core.ToolPackage, returnErr error) {
	if err := service.requirePortableRuntime(); err != nil {
		return core.ToolPackage{}, err
	}
	if !IsPortableManifest(manifest) || manifest.Distribution == nil {
		return core.ToolPackage{}, errors.New("tool package is not a portable CLI")
	}
	installation, start, err := service.DB.BeginToolInstallation(ctx, core.ToolInstallation{
		PackageID: pkg.ID, ProjectID: pkg.ProjectID, PackageSHA256: pkg.PackageSHA256,
		ApprovalSHA256: approval.ApprovalSHA256, ExpectedPayloadSHA256: manifest.Distribution.SHA256,
	})
	if err != nil {
		return core.ToolPackage{}, err
	}
	if start {
		defer func() {
			if returnErr == nil {
				return
			}
			_, _ = service.DB.FailToolInstallation(context.WithoutCancel(ctx), installation.ID, returnErr)
		}()
		payload, err := service.fetchPortablePayload(ctx, *manifest.Distribution)
		if err != nil {
			return core.ToolPackage{}, err
		}
		size := payload.Size
		installation, err = service.DB.UpdateToolInstallation(ctx, installation.ID, "downloading", store.ToolInstallationUpdate{
			State: "verifying", PayloadBlobHash: payload.Hash, PayloadSizeBytes: &size,
			DetailJSON: `{"payload_verified":true}`,
		})
		if err != nil {
			return core.ToolPackage{}, err
		}
		installation, err = service.DB.UpdateToolInstallation(ctx, installation.ID, "verifying", store.ToolInstallationUpdate{
			State: "installing", DetailJSON: `{"materialization_started":true}`,
		})
		if err != nil {
			return core.ToolPackage{}, err
		}
		materialized, err := service.materializePortable(ctx, pkg, manifest, payload)
		if err != nil {
			return core.ToolPackage{}, err
		}
		var probeHash string
		if materialized.ProbeOutput != "" {
			probeReceipt, err := service.CAS.PutBytes([]byte(materialized.ProbeOutput))
			if err != nil {
				return core.ToolPackage{}, err
			}
			if _, err := service.CAS.ReadVerified(probeReceipt.Hash); err != nil {
				return core.ToolPackage{}, err
			}
			if err := service.DB.RegisterBlob(ctx, probeReceipt, "text/plain; charset=utf-8"); err != nil {
				return core.ToolPackage{}, err
			}
			probeHash = probeReceipt.Hash
		}
		installation, err = service.DB.UpdateToolInstallation(ctx, installation.ID, "installing", store.ToolInstallationUpdate{
			State: "probing", InstalledTreeSHA256: materialized.TreeSHA256,
			Entrypoint: manifest.Distribution.Entrypoint, ProbeOutputBlobHash: probeHash,
			DetailJSON: `{"probe_succeeded":true}`,
		})
		if err != nil {
			return core.ToolPackage{}, err
		}
		installation, err = service.DB.CompleteToolInstallation(ctx, installation.ID, materialized.TreeSHA256, manifest.Distribution.Entrypoint, probeHash)
		if err != nil {
			return core.ToolPackage{}, err
		}
	} else if installation.State != "ready" {
		return core.ToolPackage{}, fmt.Errorf("portable tool installation is already %s", installation.State)
	}
	activated, err := service.DB.ActivateToolPackage(ctx, pkg.ProjectID, pkg.ID)
	if err != nil {
		if pkg.State != "active" {
			return core.ToolPackage{}, err
		}
		activated = pkg
	}
	if runID != "" || stageAttemptID != "" {
		if runID == "" || stageAttemptID == "" {
			return core.ToolPackage{}, errors.New("portable tool stage grant identity is incomplete")
		}
		if _, err := service.DB.CreateToolStageGrant(ctx, core.ToolStageGrant{
			ProjectID: pkg.ProjectID, RunID: runID, StageAttemptID: stageAttemptID,
			PackageID: pkg.ID, InstallationID: installation.ID,
			PackageSHA256: pkg.PackageSHA256, ApprovalSHA256: approval.ApprovalSHA256,
		}); err != nil {
			return core.ToolPackage{}, err
		}
	}
	activated.Installation = &installation
	return activated, nil
}

func (service *Service) RunPortableForStage(ctx context.Context, runID, stageAttemptID, packageID, toolName string, input map[string]any) (any, error) {
	if err := service.requirePortableRuntime(); err != nil {
		return nil, err
	}
	projectID, err := service.DB.ValidateStageCapability(ctx, runID, stageAttemptID)
	if err != nil {
		return nil, err
	}
	pkg, err := service.DB.ActiveToolPackageByID(ctx, packageID)
	if err != nil {
		return nil, err
	}
	if pkg.ProjectID != projectID || pkg.Installation == nil || pkg.Installation.State != "ready" {
		return nil, errors.New("portable tool is not installed and ready for this project")
	}
	if err := VerifyPackage(pkg); err != nil {
		return nil, err
	}
	manifest, _, err := ParseManifest(pkg.ManifestJSON)
	if err != nil || !IsPortableManifest(manifest) || manifest.Distribution == nil {
		return nil, errors.New("active package is not a valid portable CLI")
	}
	approval, err := ExpectedInstallApproval(pkg)
	if err != nil {
		return nil, err
	}
	installation := *pkg.Installation
	if installation.PackageSHA256 != pkg.PackageSHA256 || installation.ApprovalSHA256 != approval.ApprovalSHA256 ||
		installation.ExpectedPayloadSHA256 != manifest.Distribution.SHA256 || installation.PayloadBlobHash != manifest.Distribution.SHA256 {
		return nil, errors.New("portable tool installation identity no longer matches its approved package")
	}
	grant, err := service.DB.ToolStageGrant(ctx, projectID, runID, stageAttemptID, pkg.ID, installation.ID, pkg.PackageSHA256, approval.ApprovalSHA256)
	if err != nil {
		return nil, errors.New("portable tool use was not granted by this stage's install approval")
	}
	tool, err := selectPortableTool(manifest, strings.ToLower(strings.TrimSpace(toolName)))
	if err != nil {
		return nil, err
	}
	arguments, stdin, err := buildPortableArguments(tool, input)
	if err != nil {
		return nil, err
	}
	_, requestHash, err := canonicalPortableRequest(pkg.ID, tool.Name, input)
	if err != nil {
		return nil, err
	}
	adapterBytes, err := json.Marshal(tool)
	if err != nil {
		return nil, err
	}
	adapterDigest := sha256.Sum256(adapterBytes)
	adapterHash := hex.EncodeToString(adapterDigest[:])
	invocation, start, err := service.DB.ReserveToolInvocation(ctx, core.ToolInvocation{
		IdempotencyKey: requestHash, ProjectID: projectID, RunID: runID,
		StageAttemptID: stageAttemptID, PackageID: pkg.ID, InstallationID: installation.ID,
		StageGrantID: grant.ID, ToolName: tool.Name, ArgumentsSHA256: requestHash, AdapterSHA256: adapterHash,
	})
	if err != nil {
		return nil, err
	}
	if !start {
		if invocation.State != "succeeded" || invocation.StdoutBlobHash == "" {
			return nil, fmt.Errorf("portable tool invocation is already %s and will not be replayed", invocation.State)
		}
		stdout, err := service.CAS.ReadVerified(invocation.StdoutBlobHash)
		if err != nil {
			return nil, err
		}
		value, err := parsePortableOutput(tool.Action.Output.Format, stdout)
		if err != nil {
			return nil, err
		}
		return portableInvocationResponse(pkg, invocation, value, true), nil
	}
	failed := true
	defer func() {
		if failed {
			// The specific failure is recorded at each return site below. This
			// fallback covers an unexpected early exit without replaying the CLI.
		}
	}()
	installPath := filepath.Join(service.InstallRoot, pkg.ProjectID, pkg.ID, pkg.PackageSHA256)
	computedTree, err := hashPortableTree(installPath)
	if err != nil || computedTree != installation.InstalledTreeSHA256 {
		cause := errors.New("portable tool installed tree failed hash verification")
		_, _ = service.DB.FailToolInvocation(context.WithoutCancel(ctx), invocation.ID, cause)
		return nil, cause
	}
	entrypoint, err := safeToolJoin(installPath, manifest.Distribution.Entrypoint)
	if err != nil {
		_, _ = service.DB.FailToolInvocation(context.WithoutCancel(ctx), invocation.ID, err)
		return nil, err
	}
	scratchRoot := filepath.Join(service.InstallRoot, ".scratch")
	if err := ensureManagedDirectory(scratchRoot); err != nil {
		_, _ = service.DB.FailToolInvocation(context.WithoutCancel(ctx), invocation.ID, err)
		return nil, err
	}
	scratch, err := os.MkdirTemp(scratchRoot, invocation.ID+"-*")
	if err != nil {
		_, _ = service.DB.FailToolInvocation(context.WithoutCancel(ctx), invocation.ID, err)
		return nil, err
	}
	defer os.RemoveAll(scratch)
	processResult, err := service.runPortableProcess(ctx, entrypoint, arguments, stdin, scratch,
		time.Duration(tool.Action.TimeoutSeconds)*time.Second, tool.Action.Output.MaxBytes)
	if err != nil {
		_, _ = service.DB.FailToolInvocation(context.WithoutCancel(ctx), invocation.ID, err)
		return nil, err
	}
	value, err := parsePortableOutput(tool.Action.Output.Format, processResult.Stdout)
	if err != nil {
		_, _ = service.DB.FailToolInvocation(context.WithoutCancel(ctx), invocation.ID, err)
		return nil, err
	}
	stdoutReceipt, err := service.CAS.PutBytes(processResult.Stdout)
	if err != nil {
		_, _ = service.DB.FailToolInvocation(context.WithoutCancel(ctx), invocation.ID, err)
		return nil, err
	}
	stderrReceipt, err := service.CAS.PutBytes(processResult.Stderr)
	if err != nil {
		_, _ = service.DB.FailToolInvocation(context.WithoutCancel(ctx), invocation.ID, err)
		return nil, err
	}
	for _, receipt := range []cas.Receipt{stdoutReceipt, stderrReceipt} {
		if _, err := service.CAS.ReadVerified(receipt.Hash); err != nil {
			_, _ = service.DB.FailToolInvocation(context.WithoutCancel(ctx), invocation.ID, err)
			return nil, err
		}
		if err := service.DB.RegisterBlob(ctx, receipt, "application/vnd.aetherops.tool-output"); err != nil {
			_, _ = service.DB.FailToolInvocation(context.WithoutCancel(ctx), invocation.ID, err)
			return nil, err
		}
	}
	invocation, err = service.DB.CompleteToolInvocation(ctx, invocation.ID, stdoutReceipt.Hash, stderrReceipt.Hash, processResult.ExitCode)
	if err != nil {
		return nil, err
	}
	failed = false
	return portableInvocationResponse(pkg, invocation, value, false), nil
}

func portableInvocationResponse(pkg core.ToolPackage, invocation core.ToolInvocation, value any, cached bool) map[string]any {
	return map[string]any{
		"package_id": pkg.ID, "package_sha256": pkg.PackageSHA256,
		"tool": invocation.ToolName, "invocation_id": invocation.ID,
		"cached": cached, "stdout_blob_hash": invocation.StdoutBlobHash,
		"data": value, "native_code_executed": true,
		"evidence_required": true,
	}
}

func (service *Service) requirePortableRuntime() error {
	if service == nil || service.DB == nil || service.CAS == nil {
		return errors.New("portable tool storage and CAS are required")
	}
	for label, root := range map[string]string{
		"install":    service.InstallRoot,
		"quarantine": service.QuarantineRoot,
	} {
		if err := ensureManagedDirectory(root); err != nil {
			return fmt.Errorf("%s tool root: %w", label, err)
		}
	}
	if service.AssignProcess == nil {
		return errors.New("portable tool Job Object assignment is required")
	}
	return nil
}

func ensureManagedDirectory(root string) error {
	absolute, err := filepath.Abs(strings.TrimSpace(root))
	if err != nil || strings.TrimSpace(root) == "" {
		return errors.New("managed directory is required")
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("managed directory must be a real directory")
	}
	return nil
}

func (service *Service) fetchPortablePayload(ctx context.Context, distribution PortableDistribution) (cas.Receipt, error) {
	if err := service.requirePortableRuntime(); err != nil {
		return cas.Receipt{}, err
	}
	if err := service.Policy.ValidateURL(ctx, distribution.URL); err != nil {
		return cas.Receipt{}, fmt.Errorf("portable tool URL is blocked: %w", err)
	}
	fetchCtx, cancel := context.WithTimeout(ctx, portableDownloadTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, distribution.URL, nil)
	if err != nil {
		return cas.Receipt{}, errors.New("construct portable tool download request")
	}
	request.Header.Set("Accept", "application/octet-stream, application/zip;q=0.9, */*;q=0.1")
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", "AetherOps/0.1 portable-tool-installer")
	approvedRedirects := map[string]bool{}
	for _, host := range distribution.AllowedRedirectHosts {
		approvedRedirects[strings.ToLower(host)] = true
	}
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            service.Policy.DialContext,
		ForceAttemptHTTP2:      true,
		DisableKeepAlives:      true,
		MaxConnsPerHost:        1,
		TLSHandshakeTimeout:    20 * time.Second,
		ResponseHeaderTimeout:  30 * time.Second,
		ExpectContinueTimeout:  time.Second,
		MaxResponseHeaderBytes: portableResponseHeaderBytes,
		TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(next *http.Request, via []*http.Request) error {
			if len(via) >= 4 {
				return errors.New("portable tool redirect limit exceeded")
			}
			if next.URL.Scheme != "https" || !approvedRedirects[strings.ToLower(next.URL.Hostname())] {
				return errors.New("portable tool redirect host was not included in the approved manifest")
			}
			if err := service.Policy.ValidateURL(next.Context(), next.URL.String()); err != nil {
				return fmt.Errorf("portable tool redirect is blocked: %w", err)
			}
			next.Header.Del("Authorization")
			next.Header.Del("Cookie")
			next.Header.Set("Accept-Encoding", "identity")
			return nil
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return cas.Receipt{}, fmt.Errorf("download portable tool: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return cas.Receipt{}, fmt.Errorf("portable tool source returned HTTP status %d", response.StatusCode)
	}
	if encoding := strings.TrimSpace(response.Header.Get("Content-Encoding")); encoding != "" && !strings.EqualFold(encoding, "identity") {
		return cas.Receipt{}, fmt.Errorf("portable tool source used unsupported content encoding %q", encoding)
	}
	if response.ContentLength >= 0 && response.ContentLength != distribution.SizeBytes {
		return cas.Receipt{}, errors.New("portable tool Content-Length differs from approved size_bytes")
	}
	receipt, err := service.CAS.PutReader(io.LimitReader(response.Body, distribution.SizeBytes+1))
	if err != nil {
		return cas.Receipt{}, fmt.Errorf("commit portable tool payload to CAS: %w", err)
	}
	if receipt.Size != distribution.SizeBytes {
		return cas.Receipt{}, errors.New("portable tool payload size differs from approved size_bytes")
	}
	if receipt.Hash != distribution.SHA256 {
		return cas.Receipt{}, errors.New("portable tool payload SHA-256 differs from the approved hash")
	}
	readback, err := service.CAS.ReadVerified(receipt.Hash)
	if err != nil {
		return cas.Receipt{}, fmt.Errorf("verify portable tool CAS readback: %w", err)
	}
	if int64(len(readback)) != receipt.Size {
		return cas.Receipt{}, errors.New("portable tool CAS readback size mismatch")
	}
	if err := service.DB.RegisterBlob(ctx, receipt, "application/vnd.aetherops.portable-tool"); err != nil {
		return cas.Receipt{}, fmt.Errorf("register portable tool payload: %w", err)
	}
	return receipt, nil
}

func (service *Service) materializePortable(ctx context.Context, pkg core.ToolPackage, manifest Manifest, payload cas.Receipt) (portableMaterialization, error) {
	if manifest.Distribution == nil {
		return portableMaterialization{}, errors.New("portable distribution is absent")
	}
	if err := service.requirePortableRuntime(); err != nil {
		return portableMaterialization{}, err
	}
	for _, segment := range []string{pkg.ProjectID, pkg.ID, pkg.PackageSHA256} {
		if err := validatePathSegment(segment); err != nil {
			return portableMaterialization{}, err
		}
	}
	parent := filepath.Join(service.InstallRoot, pkg.ProjectID, pkg.ID)
	if err := ensureManagedDirectory(parent); err != nil {
		return portableMaterialization{}, err
	}
	finalPath := filepath.Join(parent, pkg.PackageSHA256)
	if info, err := os.Lstat(finalPath); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return portableMaterialization{}, errors.New("portable tool target is not a real directory")
		}
		if err := quarantineCandidate(finalPath, service.QuarantineRoot, pkg.ID+"-stale"); err != nil {
			return portableMaterialization{}, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return portableMaterialization{}, err
	}
	stagingRoot := filepath.Join(service.InstallRoot, ".staging")
	if err := ensureManagedDirectory(stagingRoot); err != nil {
		return portableMaterialization{}, err
	}
	staging, err := os.MkdirTemp(stagingRoot, pkg.ID+"-*")
	if err != nil {
		return portableMaterialization{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = quarantineCandidate(staging, service.QuarantineRoot, pkg.ID)
		}
	}()
	payloadPath, err := service.CAS.Path(payload.Hash)
	if err != nil {
		return portableMaterialization{}, err
	}
	switch manifest.Distribution.Type {
	case "portable_exe":
		destination, err := safeToolJoin(staging, manifest.Distribution.Entrypoint)
		if err != nil {
			return portableMaterialization{}, err
		}
		if err := copyPortableFile(payloadPath, destination, payload.Size); err != nil {
			return portableMaterialization{}, err
		}
	case "portable_zip":
		if err := extractPortableZIP(payloadPath, staging); err != nil {
			return portableMaterialization{}, err
		}
	default:
		return portableMaterialization{}, errors.New("unsupported portable distribution type")
	}
	entrypoint, err := safeToolJoin(staging, manifest.Distribution.Entrypoint)
	if err != nil {
		return portableMaterialization{}, err
	}
	if info, err := os.Lstat(entrypoint); err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return portableMaterialization{}, errors.New("portable tool entrypoint is not a regular file")
	}
	tree, err := hashPortableTree(staging)
	if err != nil {
		return portableMaterialization{}, err
	}
	scratch, err := os.MkdirTemp(stagingRoot, ".probe-*")
	if err != nil {
		return portableMaterialization{}, err
	}
	probe, probeErr := service.runPortableProcess(ctx, entrypoint, manifest.Distribution.Probe.Argv, nil, scratch, portableProbeTimeout, portableProbeOutputBytes)
	_ = os.RemoveAll(scratch)
	if probeErr != nil {
		return portableMaterialization{}, fmt.Errorf("portable tool probe failed: %w", probeErr)
	}
	if marker := manifest.Distribution.Probe.StdoutContains; marker != "" && !strings.Contains(string(probe.Stdout), marker) {
		return portableMaterialization{}, errors.New("portable tool probe output did not contain the approved marker")
	}
	if err := os.Rename(staging, finalPath); err != nil {
		return portableMaterialization{}, fmt.Errorf("atomically publish portable tool: %w", err)
	}
	committed = true
	return portableMaterialization{Payload: payload, TreeSHA256: tree, InstallPath: finalPath, ProbeOutput: boundedText(probe.Stdout, 1024)}, nil
}

func validatePathSegment(value string) error {
	if value == "" || value == "." || value == ".." || strings.ContainsAny(value, `\/:`) || strings.ContainsRune(value, 0) {
		return errors.New("portable tool identity contains an invalid path segment")
	}
	return nil
}

func safeToolJoin(root, relative string) (string, error) {
	relative, err := safeRelativePath(relative)
	if err != nil {
		return "", err
	}
	joined := filepath.Join(root, filepath.FromSlash(relative))
	contained, err := filepath.Rel(root, joined)
	if err != nil || contained == ".." || strings.HasPrefix(contained, ".."+string(filepath.Separator)) {
		return "", errors.New("portable tool path escapes its managed root")
	}
	return joined, nil
}

func copyPortableFile(source, destination string, exact int64) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".portable-*.tmp")
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
	written, err := io.Copy(temporary, io.LimitReader(input, exact+1))
	if err != nil || written != exact {
		return errors.New("portable tool file size changed while copying")
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		return err
	}
	committed = true
	return nil
}

func extractPortableZIP(path, destination string) error {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return errors.New("portable ZIP is invalid")
	}
	defer archive.Close()
	if len(archive.File) == 0 || len(archive.File) > portableMaxArchiveFiles {
		return errors.New("portable ZIP file count is outside the allowed range")
	}
	seen := map[string]bool{}
	var extracted int64
	for _, entry := range archive.File {
		name := strings.ReplaceAll(entry.Name, "\\", "/")
		if strings.HasSuffix(name, "/") {
			continue
		}
		clean, err := safeRelativePath(name)
		if err != nil || hasWindowsReservedPath(clean) {
			return errors.New("portable ZIP contains an unsafe path")
		}
		key := strings.ToLower(clean)
		if seen[key] {
			return errors.New("portable ZIP contains a duplicate or case-colliding path")
		}
		seen[key] = true
		mode := entry.Mode()
		if mode&os.ModeSymlink != 0 || (!mode.IsRegular() && mode.Perm() != 0) {
			return errors.New("portable ZIP contains a link or non-regular entry")
		}
		uncompressed := int64(entry.UncompressedSize64)
		if uncompressed < 0 || uncompressed > portableMaxExtractBytes-extracted {
			return errors.New("portable ZIP exceeds the extraction size limit")
		}
		if entry.CompressedSize64 > 0 && entry.UncompressedSize64/entry.CompressedSize64 > portableMaxCompressionRatio {
			return errors.New("portable ZIP entry exceeds the compression-ratio limit")
		}
		extracted += uncompressed
		target, err := safeToolJoin(destination, clean)
		if err != nil {
			return err
		}
		reader, err := entry.Open()
		if err != nil {
			return err
		}
		err = writePortableEntry(reader, target, uncompressed)
		closeErr := reader.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if len(seen) == 0 {
		return errors.New("portable ZIP contains no files")
	}
	return nil
}

func writePortableEntry(reader io.Reader, target string, exact int64) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	remove := true
	defer func() {
		_ = file.Close()
		if remove {
			_ = os.Remove(target)
		}
	}()
	written, err := io.Copy(file, io.LimitReader(reader, exact+1))
	if err != nil || written != exact {
		return errors.New("portable ZIP entry size differs from its metadata")
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	remove = false
	return nil
}

func hasWindowsReservedPath(relative string) bool {
	for _, part := range strings.Split(relative, "/") {
		trimmed := strings.TrimRight(part, " .")
		if trimmed != part || strings.Contains(part, ":") {
			return true
		}
		base := strings.ToUpper(strings.TrimSuffix(trimmed, filepath.Ext(trimmed)))
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
			(len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '1' && base[3] <= '9') {
			return true
		}
	}
	return false
}

type portableTreeHash struct {
	path string
	hash [sha256.Size]byte
	size int64
}

func hashPortableTree(root string) (string, error) {
	var files []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("portable tool tree contains a symlink")
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return errors.New("portable tool tree contains a non-regular file")
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files = append(files, relative)
		return nil
	})
	if err != nil || len(files) == 0 {
		if err == nil {
			err = errors.New("portable tool tree is empty")
		}
		return "", err
	}
	sort.Strings(files)
	workers := runtime.NumCPU()
	if workers < 1 {
		workers = 1
	}
	if workers > len(files) {
		workers = len(files)
	}
	jobs := make(chan string, len(files))
	results := make(chan struct {
		value portableTreeHash
		err   error
	}, len(files))
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
				path := filepath.Join(root, relative)
				data, err := os.ReadFile(path)
				if err != nil {
					results <- struct {
						value portableTreeHash
						err   error
					}{err: err}
					continue
				}
				results <- struct {
					value portableTreeHash
					err   error
				}{value: portableTreeHash{path: filepath.ToSlash(relative), hash: sha256.Sum256(data), size: int64(len(data))}}
			}
		}()
	}
	group.Wait()
	close(results)
	hashes := make([]portableTreeHash, 0, len(files))
	for result := range results {
		if result.err != nil {
			return "", result.err
		}
		hashes = append(hashes, result.value)
	}
	sort.Slice(hashes, func(i, j int) bool { return hashes[i].path < hashes[j].path })
	hasher := sha256.New()
	for _, file := range hashes {
		_, _ = io.WriteString(hasher, file.path)
		_, _ = hasher.Write([]byte{0})
		_, _ = hasher.Write(file.hash[:])
		_, _ = io.WriteString(hasher, "\x00"+strconv.FormatInt(file.size, 10)+"\x00")
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

type cappedBuffer struct {
	limit  int64
	buffer bytes.Buffer
}

func (writer *cappedBuffer) Write(data []byte) (int, error) {
	remaining := writer.limit - int64(writer.buffer.Len())
	if remaining <= 0 {
		return 0, errors.New("portable tool output exceeds its approved limit")
	}
	if int64(len(data)) > remaining {
		_, _ = writer.buffer.Write(data[:remaining])
		return int(remaining), errors.New("portable tool output exceeds its approved limit")
	}
	return writer.buffer.Write(data)
}

func (service *Service) runPortableProcess(ctx context.Context, executable string, args []string, stdin []byte, directory string, timeout time.Duration, outputLimit int64) (portableRunResult, error) {
	if timeout <= 0 || timeout > 10*time.Minute || outputLimit <= 0 || outputLimit > 8<<20 {
		return portableRunResult{}, errors.New("portable tool execution limits are invalid")
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(runCtx, executable, args...)
	processutil.ConfigureNoWindow(command)
	command.Dir = directory
	command.Env = portableEnvironment(directory)
	if len(stdin) != 0 {
		command.Stdin = bytes.NewReader(stdin)
	}
	stdout := &cappedBuffer{limit: outputLimit}
	stderr := &cappedBuffer{limit: portableStderrBytes}
	command.Stdout = stdout
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		return portableRunResult{}, err
	}
	if err := service.AssignProcess(command.Process.Pid); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		return portableRunResult{}, fmt.Errorf("assign portable tool to Job Object: %w", err)
	}
	err := command.Wait()
	exitCode := 0
	if command.ProcessState != nil {
		exitCode = command.ProcessState.ExitCode()
	}
	result := portableRunResult{Stdout: append([]byte(nil), stdout.buffer.Bytes()...), Stderr: append([]byte(nil), stderr.buffer.Bytes()...), ExitCode: exitCode}
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		return result, errors.New("portable tool exceeded its approved timeout")
	}
	if err != nil {
		return result, fmt.Errorf("portable tool exited with code %d: %s", exitCode, boundedText(result.Stderr, 2048))
	}
	if exitCode != 0 {
		return result, fmt.Errorf("portable tool exited with code %d", exitCode)
	}
	return result, nil
}

func portableEnvironment(scratch string) []string {
	values := []string{"TEMP=" + scratch, "TMP=" + scratch}
	for _, name := range []string{"SystemRoot", "WINDIR"} {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			values = append(values, name+"="+value)
		}
	}
	return values
}

func quarantineCandidate(path, root, packageID string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	if err := ensureManagedDirectory(root); err != nil {
		return err
	}
	name := packageID + "-" + time.Now().UTC().Format("20060102T150405.000000000Z")
	target := filepath.Join(root, name)
	if err := os.Rename(path, target); err != nil {
		return fmt.Errorf("quarantine portable tool candidate: %w", err)
	}
	return nil
}

func boundedText(data []byte, maximum int) string {
	if len(data) <= maximum {
		return strings.TrimSpace(string(data))
	}
	return strings.TrimSpace(string(data[:maximum])) + "…"
}

func buildPortableArguments(tool ManagedTool, input map[string]any) ([]string, []byte, error) {
	properties, _ := tool.InputSchema["properties"].(map[string]any)
	allowed := map[string]bool{}
	for key := range properties {
		allowed[key] = true
	}
	for key := range input {
		if !allowed[key] {
			return nil, nil, fmt.Errorf("unknown portable tool input %q", key)
		}
	}
	for _, required := range stringListValue(tool.InputSchema["required"]) {
		if _, ok := input[required]; !ok {
			return nil, nil, fmt.Errorf("required portable tool input %q is missing", required)
		}
	}
	arguments := make([]string, 0, len(tool.Action.Argv))
	for _, token := range tool.Action.Argv {
		if token.Literal != "" {
			arguments = append(arguments, token.Literal)
			continue
		}
		value, ok := input[token.Input]
		if !ok {
			return nil, nil, fmt.Errorf("portable tool argv input %q is missing", token.Input)
		}
		encoded, err := scalarArgument(value)
		if err != nil {
			return nil, nil, fmt.Errorf("portable tool argv input %q: %w", token.Input, err)
		}
		arguments = append(arguments, encoded)
	}
	if tool.Action.Stdin.Mode == "json" {
		encoded, err := json.Marshal(input)
		if err != nil {
			return nil, nil, err
		}
		return arguments, encoded, nil
	}
	return arguments, nil, nil
}

func scalarArgument(value any) (string, error) {
	switch typed := value.(type) {
	case string:
		if strings.ContainsRune(typed, 0) || len(typed) > 4096 {
			return "", errors.New("string value is invalid")
		}
		return typed, nil
	case json.Number:
		if _, err := typed.Float64(); err != nil {
			return "", errors.New("number is invalid")
		}
		return typed.String(), nil
	case float64:
		return strconv.FormatFloat(typed, 'g', -1, 64), nil
	case bool:
		return strconv.FormatBool(typed), nil
	default:
		return "", errors.New("value must be a string, number, integer, or boolean")
	}
}

func stringListValue(value any) []string {
	var result []string
	switch values := value.(type) {
	case []any:
		for _, item := range values {
			if text, ok := item.(string); ok {
				result = append(result, text)
			}
		}
	case []string:
		result = append(result, values...)
	}
	return result
}

func selectPortableTool(manifest Manifest, name string) (ManagedTool, error) {
	for _, tool := range manifest.Tools {
		if tool.Name == name && tool.Action.Type == "portable_cli" {
			return tool, nil
		}
	}
	return ManagedTool{}, fmt.Errorf("portable tool %q is not available", name)
}

func canonicalPortableRequest(packageID, toolName string, input map[string]any) ([]byte, string, error) {
	value := struct {
		Contract  string         `json:"contract"`
		PackageID string         `json:"package_id"`
		Tool      string         `json:"tool"`
		Input     map[string]any `json:"input"`
	}{Contract: "aetherops_portable_invocation_v1", PackageID: packageID, Tool: toolName, Input: input}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(encoded)
	return encoded, hex.EncodeToString(digest[:]), nil
}

func parsePortableOutput(format string, raw []byte) (any, error) {
	if format == "text" {
		return string(raw), nil
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, errors.New("portable tool stdout is not valid JSON")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("portable tool stdout contains multiple JSON values")
	}
	return value, nil
}

func canonicalDownloadURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Hostname() == "" || parsed.Fragment != "" {
		return "", errors.New("portable tool URL is invalid")
	}
	return parsed.String(), nil
}
