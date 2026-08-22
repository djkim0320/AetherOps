//go:build windows && amd64

// Package liveauthevidence produces candidate-bound evidence for the real
// authenticated ChatGPT account and exact Codex model catalog exposed by a
// protected AetherOps release-evaluation session.
package liveauthevidence

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"time"
	"unsafe"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/codex"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/evalrunner"
	"github.com/djkim0320/Aether-claw/internal/releasegate"
	"github.com/djkim0320/Aether-claw/internal/securepath"
	"golang.org/x/sys/windows"
)

const (
	GateID                  = "live_auth_exact_models"
	maxDescriptorBytes      = 64 << 10
	maxLiveAPIResponseBytes = 512 << 10
	liveAPIRequestTimeout   = 15 * time.Second
)

// Config contains paths only. The endpoint, token, API paths, HTTP method,
// required models, efforts, speed, producer status, and time are fixed by the
// production implementation and cannot be supplied by an operator.
type Config struct {
	LedgerPath                 string
	OutputPath                 string
	SessionDescriptorPath      string
	AetherOpsExecutablePath    string
	RuntimeManifestPath        string
	KnowledgeSidecarEntrypoint string
}

type statusWire struct {
	Ready                   bool                                        `json:"ready"`
	Version                 string                                      `json:"version"`
	Platform                string                                      `json:"platform"`
	ProductBuild            buildinfo.ProductBuildBinding               `json:"product_build"`
	ModelOptions            []core.ModelOption                          `json:"model_options"`
	DefaultRunConfiguration releasegate.LiveAuthDefaultRunConfiguration `json:"default_run_configuration"`
	RuntimeUpdate           json.RawMessage                             `json:"runtime_update,omitempty"`
	RuntimeWarnings         json.RawMessage                             `json:"runtime_warnings,omitempty"`
	Warnings                json.RawMessage                             `json:"warnings,omitempty"`
	Browser                 json.RawMessage                             `json:"browser,omitempty"`
}

func Generate(ctx context.Context, config Config) (releasegate.EvidenceReceipt, error) {
	if ctx == nil {
		return releasegate.EvidenceReceipt{}, errors.New("context is required")
	}
	if err := ctx.Err(); err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	ledgerPath, outputPath, detailsPath, descriptorPath, executablePath, manifestPath, sidecarPath, err := absolutePaths(config)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	candidateBefore, err := buildinfo.BindProductBuild(executablePath, manifestPath, sidecarPath)
	if err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("bind exact packaged candidate before live auth observation: %w", err)
	}
	ledgerBefore, ledgerSHA256, err := releasegate.LoadLedgerChain(ledgerPath)
	if err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("load complete prepared ledger chain: %w", err)
	}
	if ledgerBefore.ProductBuild != candidateBefore || !gateRowEmpty(ledgerBefore) {
		return releasegate.EvidenceReceipt{}, errors.New("prepared ledger candidate differs or live auth gate row is not empty")
	}
	candidateID, err := releasegate.CandidateID(candidateBefore)
	if err != nil || candidateID != ledgerBefore.ReleaseCandidateID {
		return releasegate.EvidenceReceipt{}, errors.New("prepared ledger candidate id does not match the exact packaged build")
	}
	environment := currentEnvironment()
	if windows.RtlGetVersion().BuildNumber < 22000 || environment.Architecture != "amd64" {
		return releasegate.EvidenceReceipt{}, errors.New("live auth exact-model evidence requires Windows 11 x64")
	}
	observationStartedAt := time.Now().UTC()
	if observationStartedAt.Before(ledgerBefore.PreparedAt) {
		return releasegate.EvidenceReceipt{}, errors.New("live auth observation predates the prepared ledger")
	}

	descriptor, descriptorRaw, descriptorSHA256, err := readDescriptorSnapshot(descriptorPath)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	if descriptor.ProductBuild != candidateBefore {
		return releasegate.EvidenceReceipt{}, errors.New("release session descriptor belongs to a different packaged candidate")
	}
	if err := validateProtectedSessionFiles(descriptorPath, descriptor); err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	loadedDescriptor, token, err := evalrunner.LoadSessionDescriptor(descriptorPath, candidateBefore)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	defer evalrunner.ZeroToken(token)
	if loadedDescriptor != descriptor || bytes.Contains(descriptorRaw, token) {
		return releasegate.EvidenceReceipt{}, errors.New("release session descriptor changed or contains secret token material")
	}
	if descriptor.StartedAt.After(observationStartedAt) {
		return releasegate.EvidenceReceipt{}, errors.New("release session descriptor start time is after its observation")
	}

	accountRaw, accountObservation, err := authenticatedGET(ctx, descriptor.Endpoint, token, "/api/v1/auth/codex/status")
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	var account codex.AccountStatus
	if err := decodeStrict(accountRaw, &account); err != nil {
		return releasegate.EvidenceReceipt{}, errors.New("authenticated Codex account response is not the stable non-secret schema")
	}
	accountObservation.ParsedSHA256, err = canonicalSHA256(account)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}

	statusRaw, statusObservation, err := authenticatedGET(ctx, descriptor.Endpoint, token, "/api/v1/status")
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	var rawStatus statusWire
	if err := decodeStrict(statusRaw, &rawStatus); err != nil {
		return releasegate.EvidenceReceipt{}, errors.New("authenticated product status response is not the stable schema")
	}
	status := releasegate.LiveAuthProductStatus{
		Ready: rawStatus.Ready, Version: rawStatus.Version, Platform: rawStatus.Platform,
		ProductBuild: rawStatus.ProductBuild, ModelOptions: rawStatus.ModelOptions,
		DefaultRunConfiguration: rawStatus.DefaultRunConfiguration,
	}
	statusObservation.ParsedSHA256, err = canonicalSHA256(status)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	if bytes.Contains(accountRaw, token) || bytes.Contains(statusRaw, token) {
		return releasegate.EvidenceReceipt{}, errors.New("authenticated API response unexpectedly contains bearer token material")
	}

	candidateAfter, err := buildinfo.BindProductBuild(executablePath, manifestPath, sidecarPath)
	if err != nil || candidateAfter != candidateBefore {
		return releasegate.EvidenceReceipt{}, errors.New("packaged product identity changed during live auth observation")
	}
	ledgerAfter, ledgerAfterSHA256, err := releasegate.LoadLedgerChain(ledgerPath)
	if err != nil || ledgerAfterSHA256 != ledgerSHA256 || !reflect.DeepEqual(ledgerAfter, ledgerBefore) || !gateRowEmpty(ledgerAfter) {
		return releasegate.EvidenceReceipt{}, errors.New("prepared ledger chain or current revision changed during live auth observation")
	}
	if err := reauthenticateSession(descriptorPath, descriptor, descriptorSHA256, token, candidateBefore); err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	observationFinishedAt := time.Now().UTC()
	environmentIdentity, err := releasegate.LiveAuthEnvironmentIdentity(
		environment, descriptor.Endpoint, descriptor.PID, candidateBefore.ExecutableSHA256,
	)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	details := releasegate.LiveAuthExactModelsDetails{
		Schema: releasegate.LiveAuthExactModelsDetailsSchemaV1, GateID: GateID,
		ReleaseCandidateID: candidateID, LedgerSHA256: ledgerSHA256, LedgerRevision: ledgerBefore.Revision,
		LedgerPreparedAt: ledgerBefore.PreparedAt, ObservationStartedAt: observationStartedAt,
		ObservationFinishedAt: observationFinishedAt, CandidateExecutable: executablePath,
		CandidateBefore: candidateBefore, CandidateAfter: candidateAfter,
		SessionEndpoint: descriptor.Endpoint, SessionPID: descriptor.PID, SessionStartedAt: descriptor.StartedAt,
		SessionDescriptorSHA256: descriptorSHA256, SessionFilesProtected: true, SessionReauthenticated: true,
		LedgerReauthenticated: true, ProcessExecutableSHA256: candidateBefore.ExecutableSHA256,
		Environment: environment, AccountRequest: accountObservation, StatusRequest: statusObservation,
		Account: account, Status: status, RequiredSelections: releasegate.LiveAuthRequiredSelections(),
		EvidenceScope: releasegate.LiveAuthEvidenceScope(), ExcludedReleaseClaims: releasegate.LiveAuthExcludedClaims(),
	}
	detailsRaw, err := marshalJSON(details)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	detailsSHA256 := hashBytes(detailsRaw)
	subjects := map[string]string{
		"aetherops.exe":                  candidateBefore.ExecutableSHA256,
		"runtime-manifest.json":          candidateBefore.RuntimeManifestSHA256,
		"knowledge-sidecar-tree":         candidateBefore.KnowledgeSidecarTreeSHA256,
		"prepared-ledger":                ledgerSHA256,
		"live-auth-exact-models-details": detailsSHA256,
		"release-session-descriptor":     descriptorSHA256,
		"auth-codex-status-response":     accountObservation.ResponseSHA256,
		"product-status-response":        statusObservation.ResponseSHA256,
	}
	receipt := releasegate.EvidenceReceipt{
		Schema: releasegate.EvidenceSchemaV1, GateID: GateID, EvidenceKind: releasegate.EvidenceLiveService,
		ReleaseCandidateID: candidateID, ProductBuild: candidateBefore,
		Producer: releasegate.Producer{
			Name: releasegate.LiveAuthExactModelsProducerName, Version: releasegate.LiveAuthExactModelsProducerVersion,
		},
		Environment: releasegate.Environment{
			Class: string(releasegate.EvidenceLiveService), OS: "windows-11", Architecture: "amd64",
			IdentitySHA256: environmentIdentity,
		},
		ObservedAt: observationFinishedAt, Status: "passed", SubjectHashes: subjectHashList(subjects),
		DetailsPath: filepath.Base(detailsPath), DetailsSHA256: detailsSHA256,
	}
	if err := releasegate.ValidateLiveAuthExactModelsEvidenceForLedger(
		detailsRaw, receipt, ledgerBefore.Revision, ledgerBefore.PreparedAt,
	); err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("validate live auth evidence: %w", err)
	}
	// Reauthenticate every mutable external input immediately before creating
	// the first output. The token is compared in constant time and then zeroed;
	// neither it nor a token hash is persisted.
	finalCandidate, err := buildinfo.BindProductBuild(executablePath, manifestPath, sidecarPath)
	if err != nil || finalCandidate != candidateBefore {
		return releasegate.EvidenceReceipt{}, errors.New("packaged candidate changed before live auth evidence commit")
	}
	finalLedger, finalLedgerSHA256, err := releasegate.LoadLedgerChain(ledgerPath)
	if err != nil || finalLedgerSHA256 != ledgerSHA256 || !reflect.DeepEqual(finalLedger, ledgerBefore) || !gateRowEmpty(finalLedger) {
		return releasegate.EvidenceReceipt{}, errors.New("prepared ledger chain changed before live auth evidence commit")
	}
	if err := reauthenticateSession(descriptorPath, descriptor, descriptorSHA256, token, candidateBefore); err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	receiptRaw, err := marshalJSON(receipt)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	if bytes.Contains(detailsRaw, token) || bytes.Contains(receiptRaw, token) {
		return releasegate.EvidenceReceipt{}, errors.New("refusing to persist bearer token material")
	}
	if err := writeNewPair(detailsPath, detailsRaw, outputPath, receiptRaw); err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	return receipt, nil
}

func absolutePaths(config Config) (ledger, output, details, descriptor, executable, manifest, sidecar string, err error) {
	values := []*string{&ledger, &output, &descriptor, &executable, &manifest, &sidecar}
	inputs := []string{
		config.LedgerPath, config.OutputPath, config.SessionDescriptorPath, config.AetherOpsExecutablePath,
		config.RuntimeManifestPath, config.KnowledgeSidecarEntrypoint,
	}
	for index, input := range inputs {
		if strings.TrimSpace(input) == "" {
			return "", "", "", "", "", "", "", errors.New("ledger, output, descriptor, executable, runtime manifest, and sidecar paths are required")
		}
		absolute, absoluteErr := filepath.Abs(input)
		if absoluteErr != nil {
			return "", "", "", "", "", "", "", absoluteErr
		}
		*values[index] = filepath.Clean(absolute)
	}
	if !strings.EqualFold(filepath.Base(executable), "aetherops.exe") ||
		!strings.EqualFold(manifest, filepath.Join(filepath.Dir(executable), "runtime-manifest.json")) ||
		!strings.EqualFold(sidecar, filepath.Join(filepath.Dir(executable), "knowledge-sidecar", "index.cjs")) {
		return "", "", "", "", "", "", "", errors.New("live auth candidate files must use one exact packaged layout")
	}
	if !strings.EqualFold(filepath.Dir(output), filepath.Dir(ledger)) {
		return "", "", "", "", "", "", "", errors.New("live auth receipt must be a direct sibling of the current ledger")
	}
	if _, siblingErr := securepath.SiblingName(filepath.Base(output)); siblingErr != nil {
		return "", "", "", "", "", "", "", siblingErr
	}
	extension := filepath.Ext(output)
	if extension == "" {
		details = output + ".details.json"
	} else {
		details = strings.TrimSuffix(output, extension) + ".details.json"
	}
	if _, siblingErr := securepath.SiblingName(filepath.Base(details)); siblingErr != nil {
		return "", "", "", "", "", "", "", siblingErr
	}
	paths := []string{ledger, output, details, descriptor, executable, manifest, sidecar}
	for left := range paths {
		for right := left + 1; right < len(paths); right++ {
			if strings.EqualFold(paths[left], paths[right]) {
				return "", "", "", "", "", "", "", errors.New("live auth evidence input and output paths must be distinct")
			}
		}
	}
	return ledger, output, details, descriptor, executable, manifest, sidecar, nil
}

func gateRowEmpty(ledger releasegate.Ledger) bool {
	for _, reference := range ledger.Evidence {
		if reference.GateID == GateID {
			return reference.ReceiptPath == "" && reference.ReceiptSHA256 == ""
		}
	}
	return false
}

func readDescriptorSnapshot(path string) (evalrunner.SessionDescriptor, []byte, string, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 || info.Size() > maxDescriptorBytes {
		return evalrunner.SessionDescriptor{}, nil, "", errors.New("release session descriptor is not a small regular non-symlink file")
	}
	file, err := os.Open(path)
	if err != nil {
		return evalrunner.SessionDescriptor{}, nil, "", errors.New("release session descriptor cannot be read")
	}
	raw, readErr := io.ReadAll(io.LimitReader(file, maxDescriptorBytes+1))
	closeErr := file.Close()
	after, statErr := os.Lstat(path)
	if readErr != nil || closeErr != nil || statErr != nil || int64(len(raw)) != info.Size() ||
		after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) || !os.SameFile(info, after) {
		return evalrunner.SessionDescriptor{}, nil, "", errors.New("release session descriptor changed while reading")
	}
	var descriptor evalrunner.SessionDescriptor
	if err := decodeStrict(raw, &descriptor); err != nil {
		return evalrunner.SessionDescriptor{}, nil, "", errors.New("release session descriptor JSON is invalid")
	}
	return descriptor, raw, hashBytes(raw), nil
}

func validateProtectedSessionFiles(descriptorPath string, descriptor evalrunner.SessionDescriptor) error {
	if descriptor.TokenFile != filepath.Base(descriptorPath)+".token" || filepath.Base(descriptor.TokenFile) != descriptor.TokenFile {
		return errors.New("release session token is not the fixed descriptor sibling")
	}
	for _, path := range []string{descriptorPath, filepath.Join(filepath.Dir(descriptorPath), descriptor.TokenFile)} {
		if err := validateProtectedCurrentUserFile(path); err != nil {
			return fmt.Errorf("protected release session file %s: %w", filepath.Base(path), err)
		}
	}
	return nil
}

func validateProtectedCurrentUserFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("file is not a regular non-reparse file")
	}
	pointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	attributes, err := windows.GetFileAttributes(pointer)
	if err != nil || attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("file is a reparse point or attributes are unavailable")
	}
	security, err := windows.GetNamedSecurityInfo(
		path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		return errors.New("security descriptor is unavailable")
	}
	control, _, err := security.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return errors.New("DACL is not protected")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return errors.New("current user SID is unavailable")
	}
	owner, defaulted, err := security.Owner()
	if err != nil || owner == nil || defaulted || !windows.EqualSid(owner, user.User.Sid) {
		return errors.New("owner is not the explicit current user")
	}
	dacl, defaulted, err := security.DACL()
	if err != nil || dacl == nil || defaulted || dacl.AceCount != 1 {
		return errors.New("DACL is not one explicit current-user ACE")
	}
	var ace *windows.ACCESS_ALLOWED_ACE
	const mappedFileAllAccess windows.ACCESS_MASK = 0x001f01ff
	if err := windows.GetAce(dacl, 0, &ace); err != nil || ace == nil ||
		ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Header.AceFlags&windows.INHERITED_ACE != 0 ||
		(ace.Mask != windows.ACCESS_MASK(windows.GENERIC_ALL) && ace.Mask != mappedFileAllAccess) {
		return errors.New("DACL ACE is not explicit current-user generic-all access")
	}
	aceSID := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
	if !windows.EqualSid(aceSID, user.User.Sid) {
		return errors.New("DACL ACE belongs to another principal")
	}
	return nil
}

func reauthenticateSession(
	descriptorPath string, expected evalrunner.SessionDescriptor, expectedSHA256 string, token []byte,
	build buildinfo.ProductBuildBinding,
) error {
	descriptor, _, digest, err := readDescriptorSnapshot(descriptorPath)
	if err != nil || descriptor != expected || digest != expectedSHA256 {
		return errors.New("protected release session descriptor changed during observation")
	}
	if err := validateProtectedSessionFiles(descriptorPath, descriptor); err != nil {
		return err
	}
	loaded, currentToken, err := evalrunner.LoadSessionDescriptor(descriptorPath, build)
	if err != nil {
		return err
	}
	defer evalrunner.ZeroToken(currentToken)
	if loaded != expected || subtle.ConstantTimeCompare(token, currentToken) != 1 {
		return errors.New("protected release session process or token changed during observation")
	}
	return nil
}

func authenticatedGET(
	ctx context.Context, endpoint string, token []byte, path string,
) ([]byte, releasegate.LiveAuthAPIObservation, error) {
	startedAt := time.Now().UTC()
	requestContext, cancel := context.WithTimeout(ctx, liveAPIRequestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodGet, endpoint+path, nil)
	if err != nil {
		return nil, releasegate.LiveAuthAPIObservation{}, errors.New("construct authenticated loopback GET")
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("Authorization", "Bearer "+string(token))
	request.Header.Set("Origin", endpoint)
	transport := &http.Transport{
		Proxy: nil, DisableCompression: true, DisableKeepAlives: true,
		DialContext: (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: -1}).DialContext,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport, Timeout: liveAPIRequestTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.Do(request)
	request.Header.Del("Authorization")
	if err != nil {
		return nil, releasegate.LiveAuthAPIObservation{}, fmt.Errorf("authenticated loopback GET %s failed", path)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxLiveAPIResponseBytes+1))
	if err != nil || len(raw) > maxLiveAPIResponseBytes {
		return nil, releasegate.LiveAuthAPIObservation{}, fmt.Errorf("authenticated loopback GET %s response is unavailable or oversized", path)
	}
	mediaType, _, mediaErr := mime.ParseMediaType(response.Header.Get("Content-Type"))
	observation := releasegate.LiveAuthAPIObservation{
		Method: http.MethodGet, Path: path, StartedAt: startedAt, FinishedAt: time.Now().UTC(),
		HTTPStatus: response.StatusCode, MediaType: mediaType, ResponseBytes: int64(len(raw)), ResponseSHA256: hashBytes(raw),
	}
	if response.StatusCode != http.StatusOK || mediaErr != nil || mediaType != "application/json" || len(raw) == 0 {
		return nil, observation, fmt.Errorf("authenticated loopback GET %s returned an invalid HTTP response", path)
	}
	return raw, observation, nil
}

func currentEnvironment() releasegate.LiveAuthEnvironment {
	version := windows.RtlGetVersion()
	return releasegate.LiveAuthEnvironment{
		OS: "windows", Architecture: runtime.GOARCH,
		WindowsVersion:    fmt.Sprintf("%d.%d.%d", version.MajorVersion, version.MinorVersion, version.BuildNumber),
		LogicalProcessors: runtime.NumCPU(),
	}
}

func subjectHashList(subjects map[string]string) []releasegate.SubjectHash {
	names := make([]string, 0, len(subjects))
	for name := range subjects {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]releasegate.SubjectHash, 0, len(names))
	for _, name := range names {
		result = append(result, releasegate.SubjectHash{Name: name, SHA256: subjects[name]})
	}
	return result
}

func marshalJSON(value any) ([]byte, error) {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(raw, '\n'), nil
}

func decodeStrict(raw []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("JSON contains trailing values")
	}
	return nil
}

func canonicalSHA256(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return hashBytes(raw), nil
}

func hashBytes(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func writeNewPair(detailsPath string, details []byte, receiptPath string, receipt []byte) (returnErr error) {
	detailsFile, err := os.OpenFile(detailsPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("reserve live auth details: %w", err)
	}
	receiptFile, err := os.OpenFile(receiptPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		_ = detailsFile.Close()
		_ = os.Remove(detailsPath)
		return fmt.Errorf("reserve live auth receipt: %w", err)
	}
	committed := false
	defer func() {
		_ = detailsFile.Close()
		_ = receiptFile.Close()
		if !committed {
			if removeErr := os.Remove(detailsPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				returnErr = errors.Join(returnErr, removeErr)
			}
			if removeErr := os.Remove(receiptPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				returnErr = errors.Join(returnErr, removeErr)
			}
		}
	}()
	if written, err := detailsFile.Write(details); err != nil {
		return err
	} else if written != len(details) {
		return io.ErrShortWrite
	}
	if err := detailsFile.Sync(); err != nil {
		return err
	}
	if written, err := receiptFile.Write(receipt); err != nil {
		return err
	} else if written != len(receipt) {
		return io.ErrShortWrite
	}
	if err := receiptFile.Sync(); err != nil {
		return err
	}
	if err := errors.Join(detailsFile.Close(), receiptFile.Close()); err != nil {
		return err
	}
	committed = true
	return nil
}
