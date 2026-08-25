// Package toolstudio owns the narrow, auditable extension surface used when a
// research agent needs a reusable capability. It deliberately supports no
// arbitrary executable payloads, package installation, or shell commands.
package toolstudio

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/djkim0320/AetherOps/internal/browser"
	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
)

const (
	SchemaV1        = "aetherops_tool_package_v1"
	SchemaV2        = "aetherops_tool_package_v2"
	maxFiles        = 32
	maxFileBytes    = 512 << 10
	maxPackageBytes = 2 << 20
)

var namePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}[a-z0-9]$|^[a-z]$`)
var versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$`)
var queryNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)
var sha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var licensePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$`)

type Proposal struct {
	Kind        string         `json:"kind"`
	Name        string         `json:"name"`
	DisplayName string         `json:"display_name"`
	Description string         `json:"description"`
	Version     string         `json:"version"`
	Files       []ProposalFile `json:"files"`
}
type ProposalFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type Manifest struct {
	Schema       string                `json:"schema"`
	Name         string                `json:"name"`
	Description  string                `json:"description"`
	Distribution *PortableDistribution `json:"distribution,omitempty"`
	Permissions  *NativePermissions    `json:"permissions,omitempty"`
	Tools        []ManagedTool         `json:"tools"`
}
type ManagedTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"input_schema"`
	Action      ManagedAction  `json:"action"`
}

// PortableDistribution is an immutable, approval-visible native payload. V1
// deliberately accepts only a single Windows x64 executable or a ZIP archive;
// it never runs installers, package managers, scripts, services, or listeners.
type PortableDistribution struct {
	Type                 string        `json:"type"`
	URL                  string        `json:"url"`
	AllowedRedirectHosts []string      `json:"allowed_redirect_hosts,omitempty"`
	SHA256               string        `json:"sha256"`
	SizeBytes            int64         `json:"size_bytes"`
	Publisher            string        `json:"publisher"`
	SourceURL            string        `json:"source_url"`
	LicenseSPDX          string        `json:"license_spdx"`
	Entrypoint           string        `json:"entrypoint"`
	Probe                PortableProbe `json:"probe"`
}

// NativePermissions is intentionally candid: a Job Object bounds lifetime,
// not OS access. Until an AppContainer launcher exists, every portable CLI
// approval must explicitly acknowledge same-user native-code privileges.
type NativePermissions struct {
	NativeCode            bool `json:"native_code"`
	SameWindowsUser       bool `json:"same_windows_user"`
	OSNetworkSandboxed    bool `json:"os_network_sandboxed"`
	OSFilesystemSandboxed bool `json:"os_filesystem_sandboxed"`
}

type PortableProbe struct {
	Argv           []string `json:"argv"`
	StdoutContains string   `json:"stdout_contains,omitempty"`
}

type ManagedAction struct {
	Type     string            `json:"type"`
	BaseURL  string            `json:"base_url,omitempty"`
	QueryMap map[string]string `json:"query_map,omitempty"`

	Executable     string          `json:"executable,omitempty"`
	Argv           []ArgumentToken `json:"argv,omitempty"`
	Stdin          PortableStdin   `json:"stdin,omitempty"`
	Output         PortableOutput  `json:"output,omitempty"`
	TimeoutSeconds int             `json:"timeout_seconds,omitempty"`
}

// HTTPJSONAction remains an alias so existing callers compile while the
// discriminated action contract gains portable_cli.
type HTTPJSONAction = ManagedAction

type ArgumentToken struct {
	Literal string `json:"literal,omitempty"`
	Input   string `json:"input,omitempty"`
}

type PortableStdin struct {
	Mode string `json:"mode,omitempty"`
}

type PortableOutput struct {
	Format   string `json:"format,omitempty"`
	MaxBytes int64  `json:"max_bytes,omitempty"`
}

type InstallApproval struct {
	PackageID                string `json:"package_id"`
	PackageSHA256            string `json:"package_sha256"`
	ApprovalSHA256           string `json:"approval_sha256"`
	SourceURL                string `json:"source_url"`
	PayloadSHA256            string `json:"payload_sha256"`
	Publisher                string `json:"publisher"`
	AcceptSameUserNativeCode bool   `json:"accept_same_user_native_code"`
}

type Service struct {
	DB             *store.DB
	CAS            *cas.Store
	InstallRoot    string
	QuarantineRoot string
	Policy         browser.Policy
	AssignProcess  func(int) error
}

func (service *Service) ProposeForStage(ctx context.Context, runID, stageAttemptID string, proposal Proposal) (core.ToolPackage, error) {
	if service == nil || service.DB == nil {
		return core.ToolPackage{}, errors.New("tool studio storage is unavailable")
	}
	projectID, err := service.DB.ValidateStageCapability(ctx, runID, stageAttemptID)
	if err != nil {
		return core.ToolPackage{}, err
	}
	return service.Propose(ctx, projectID, runID, stageAttemptID, proposal)
}

func (service *Service) Propose(ctx context.Context, projectID, runID, stageAttemptID string, proposal Proposal) (core.ToolPackage, error) {
	pkg, err := ValidateProposal(projectID, runID, stageAttemptID, proposal)
	if err != nil {
		return core.ToolPackage{}, err
	}
	return service.DB.CreateToolPackage(ctx, pkg)
}
func (service *Service) List(ctx context.Context, projectID string) ([]core.ToolPackage, error) {
	return service.DB.ListToolPackages(ctx, projectID)
}
func (service *Service) Get(ctx context.Context, projectID, packageID string) (core.ToolPackage, error) {
	return service.DB.ToolPackage(ctx, projectID, packageID, true)
}
func (service *Service) Activate(ctx context.Context, projectID, packageID string) (core.ToolPackage, error) {
	pkg, err := service.DB.ToolPackage(ctx, projectID, packageID, true)
	if err != nil {
		return core.ToolPackage{}, err
	}
	if pkg.Kind != "mcp" {
		return service.DB.ActivateToolPackage(ctx, projectID, packageID)
	}
	manifest, _, err := ParseManifest(pkg.ManifestJSON)
	if err != nil {
		return core.ToolPackage{}, err
	}
	if !IsPortableManifest(manifest) {
		return service.DB.ActivateToolPackage(ctx, projectID, packageID)
	}
	approval, err := ExpectedInstallApproval(pkg)
	if err != nil {
		return core.ToolPackage{}, err
	}
	return service.installPortable(ctx, pkg, manifest, approval, "", "")
}
func (service *Service) Disable(ctx context.Context, projectID, packageID string) (core.ToolPackage, error) {
	return service.DB.DisableToolPackage(ctx, projectID, packageID)
}

func ValidateProposal(projectID, runID, stageAttemptID string, proposal Proposal) (core.ToolPackage, error) {
	proposal.Kind = strings.ToLower(strings.TrimSpace(proposal.Kind))
	proposal.Name = strings.ToLower(strings.TrimSpace(proposal.Name))
	proposal.DisplayName = strings.TrimSpace(proposal.DisplayName)
	proposal.Description = strings.TrimSpace(proposal.Description)
	proposal.Version = strings.ToLower(strings.TrimSpace(proposal.Version))
	if projectID == "" {
		return core.ToolPackage{}, errors.New("project id is required")
	}
	if proposal.Kind != "skill" && proposal.Kind != "mcp" {
		return core.ToolPackage{}, errors.New("tool package kind must be skill or mcp")
	}
	if !namePattern.MatchString(proposal.Name) {
		return core.ToolPackage{}, errors.New("tool package name must be a lowercase kebab-case identifier")
	}
	if proposal.DisplayName == "" || utf8.RuneCountInString(proposal.DisplayName) > 80 {
		return core.ToolPackage{}, errors.New("display name must contain 1 to 80 characters")
	}
	if proposal.Description == "" || utf8.RuneCountInString(proposal.Description) > 500 {
		return core.ToolPackage{}, errors.New("description must contain 1 to 500 characters")
	}
	if !versionPattern.MatchString(proposal.Version) {
		return core.ToolPackage{}, errors.New("version must be a semantic version such as 1.0.0")
	}
	if len(proposal.Files) == 0 || len(proposal.Files) > maxFiles {
		return core.ToolPackage{}, fmt.Errorf("tool package must contain 1 to %d files", maxFiles)
	}
	seen := map[string]bool{}
	files := make([]core.ToolPackageFile, 0, len(proposal.Files))
	total := 0
	for _, input := range proposal.Files {
		path, err := safeRelativePath(input.Path)
		if err != nil {
			return core.ToolPackage{}, err
		}
		if seen[path] {
			return core.ToolPackage{}, fmt.Errorf("duplicate tool package path %q", path)
		}
		seen[path] = true
		if !utf8.ValidString(input.Content) {
			return core.ToolPackage{}, fmt.Errorf("tool package file %q is not UTF-8", path)
		}
		size := len([]byte(input.Content))
		if size == 0 || size > maxFileBytes {
			return core.ToolPackage{}, fmt.Errorf("tool package file %q has an invalid size", path)
		}
		total += size
		if total > maxPackageBytes {
			return core.ToolPackage{}, errors.New("tool package exceeds the 2 MiB limit")
		}
		digest := sha256.Sum256([]byte(input.Content))
		files = append(files, core.ToolPackageFile{Path: path, Content: input.Content, ContentSHA256: hex.EncodeToString(digest[:]), Size: int64(size)})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	manifestJSON := "{}"
	if proposal.Kind == "skill" {
		if !seen["SKILL.md"] {
			return core.ToolPackage{}, errors.New("a skill package must contain SKILL.md")
		}
		skill := fileContent(files, "SKILL.md")
		if err := validateSkillDocument(skill, proposal.Name); err != nil {
			return core.ToolPackage{}, err
		}
	}
	if proposal.Kind == "mcp" {
		if !seen["mcp.json"] {
			return core.ToolPackage{}, errors.New("an MCP package must contain mcp.json")
		}
		manifest, canonical, err := ParseManifest(fileContent(files, "mcp.json"))
		if err != nil {
			return core.ToolPackage{}, err
		}
		if manifest.Name != proposal.Name {
			return core.ToolPackage{}, errors.New("mcp.json name must match the package name")
		}
		manifestJSON = canonical
	}
	h := sha256.New()
	for _, file := range files {
		h.Write([]byte(file.Path))
		h.Write([]byte{0})
		h.Write([]byte(file.ContentSHA256))
		h.Write([]byte{0})
	}
	h.Write([]byte(proposal.Kind))
	h.Write([]byte{0})
	h.Write([]byte(proposal.Name))
	h.Write([]byte{0})
	h.Write([]byte(proposal.Version))
	return core.ToolPackage{ProjectID: projectID, Kind: proposal.Kind, Name: proposal.Name, DisplayName: proposal.DisplayName, Description: proposal.Description, Version: proposal.Version, ManifestJSON: manifestJSON, PackageSHA256: hex.EncodeToString(h.Sum(nil)), SourceRunID: runID, SourceStageAttemptID: stageAttemptID, Files: files}, nil
}

func validateSkillDocument(raw, expectedName string) error {
	normalized := strings.ReplaceAll(raw, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	lines := strings.Split(normalized, "\n")
	if len(lines) < 4 || lines[0] != "---" {
		return errors.New("SKILL.md must begin with a standalone YAML front matter delimiter")
	}
	closing := -1
	for index := 1; index < len(lines); index++ {
		if lines[index] == "---" {
			closing = index
			break
		}
	}
	if closing < 2 || closing == len(lines)-1 {
		return errors.New("SKILL.md must close its YAML front matter and contain instructions")
	}
	name, description := "", ""
	for _, line := range lines[1:closing] {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		key, value, ok := strings.Cut(trimmed, ":")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "name":
			if name != "" {
				return errors.New("SKILL.md front matter repeats name")
			}
			name = strings.Trim(strings.TrimSpace(value), `"'`)
		case "description":
			if description != "" {
				return errors.New("SKILL.md front matter repeats description")
			}
			description = strings.Trim(strings.TrimSpace(value), `"'`)
		}
	}
	if name != expectedName {
		return errors.New("SKILL.md front matter name must exactly match the package name")
	}
	if description == "" {
		return errors.New("SKILL.md front matter description is required")
	}
	if strings.TrimSpace(strings.Join(lines[closing+1:], "\n")) == "" {
		return errors.New("SKILL.md instructions are empty")
	}
	return nil
}

func ParseManifest(raw string) (Manifest, string, error) {
	var manifest Manifest
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, "", fmt.Errorf("decode mcp.json: %w", err)
	}
	if tailErr := decoder.Decode(&struct{}{}); !errors.Is(tailErr, io.EOF) {
		return Manifest{}, "", errors.New("mcp.json contains multiple JSON values")
	}
	if (manifest.Schema != SchemaV1 && manifest.Schema != SchemaV2) ||
		!namePattern.MatchString(manifest.Name) || strings.TrimSpace(manifest.Description) == "" {
		return Manifest{}, "", errors.New("mcp.json identity is invalid")
	}
	if manifest.Schema == SchemaV1 {
		if manifest.Distribution != nil || manifest.Permissions != nil {
			return Manifest{}, "", errors.New("v1 mcp.json cannot contain a portable distribution")
		}
	} else if err := validatePortableDistribution(manifest.Distribution, manifest.Permissions); err != nil {
		return Manifest{}, "", err
	}
	if len(manifest.Tools) == 0 || len(manifest.Tools) > 16 {
		return Manifest{}, "", errors.New("mcp.json must define 1 to 16 tools")
	}
	seen := map[string]bool{}
	for index := range manifest.Tools {
		tool := &manifest.Tools[index]
		tool.Name = strings.ToLower(strings.TrimSpace(tool.Name))
		if !namePattern.MatchString(tool.Name) || seen[tool.Name] {
			return Manifest{}, "", errors.New("mcp.json tool names must be unique lowercase kebab-case identifiers")
		}
		seen[tool.Name] = true
		if strings.TrimSpace(tool.Description) == "" || len(tool.Description) > 500 {
			return Manifest{}, "", errors.New("each MCP tool needs a bounded description")
		}
		if err := validateInputSchema(tool.InputSchema); err != nil {
			return Manifest{}, "", fmt.Errorf("tool %s input schema: %w", tool.Name, err)
		}
		if err := validateManagedAction(manifest.Schema, manifest.Distribution, tool.Action, tool.InputSchema); err != nil {
			return Manifest{}, "", fmt.Errorf("tool %s action: %w", tool.Name, err)
		}
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return Manifest{}, "", err
	}
	return manifest, string(encoded), nil
}

func IsPortableManifest(manifest Manifest) bool {
	return manifest.Schema == SchemaV2 && manifest.Distribution != nil
}

// ExpectedInstallApproval returns the complete immutable identity shown in the
// Codex approval request. Changing package bytes, adapter fields, payload URL,
// payload hash, publisher, or native-code permissions necessarily changes the
// approval hash and requires a new user decision.
func ExpectedInstallApproval(pkg core.ToolPackage) (InstallApproval, error) {
	if pkg.Kind != "mcp" {
		return InstallApproval{}, errors.New("only MCP packages can contain a portable CLI")
	}
	if err := VerifyPackage(pkg); err != nil {
		return InstallApproval{}, err
	}
	manifest, canonical, err := ParseManifest(pkg.ManifestJSON)
	if err != nil {
		return InstallApproval{}, err
	}
	if !IsPortableManifest(manifest) {
		return InstallApproval{}, errors.New("tool package has no portable distribution")
	}
	manifestHash := sha256.Sum256([]byte(canonical))
	identity := struct {
		Contract       string               `json:"contract"`
		PackageSHA256  string               `json:"package_sha256"`
		ManifestSHA256 string               `json:"manifest_sha256"`
		Distribution   PortableDistribution `json:"distribution"`
		Permissions    NativePermissions    `json:"permissions"`
	}{
		Contract:       "aetherops_portable_install_approval_v1",
		PackageSHA256:  pkg.PackageSHA256,
		ManifestSHA256: hex.EncodeToString(manifestHash[:]),
		Distribution:   *manifest.Distribution,
		Permissions:    *manifest.Permissions,
	}
	encoded, err := json.Marshal(identity)
	if err != nil {
		return InstallApproval{}, err
	}
	digest := sha256.Sum256(encoded)
	return InstallApproval{
		PackageID: pkg.ID, PackageSHA256: pkg.PackageSHA256,
		ApprovalSHA256: hex.EncodeToString(digest[:]),
		SourceURL:      manifest.Distribution.URL, PayloadSHA256: manifest.Distribution.SHA256,
		Publisher: manifest.Distribution.Publisher, AcceptSameUserNativeCode: true,
	}, nil
}

func ValidateInstallApproval(expected, actual InstallApproval) error {
	if expected.PackageID != actual.PackageID || expected.PackageSHA256 != actual.PackageSHA256 ||
		expected.ApprovalSHA256 != actual.ApprovalSHA256 || expected.SourceURL != actual.SourceURL ||
		expected.PayloadSHA256 != actual.PayloadSHA256 || expected.Publisher != actual.Publisher ||
		!actual.AcceptSameUserNativeCode {
		return errors.New("portable tool install approval does not match the immutable package identity")
	}
	return nil
}

func validatePortableDistribution(distribution *PortableDistribution, permissions *NativePermissions) error {
	if distribution == nil || permissions == nil {
		return errors.New("v2 mcp.json requires distribution and native permissions")
	}
	if distribution.Type != "portable_exe" && distribution.Type != "portable_zip" {
		return errors.New("portable distribution type must be portable_exe or portable_zip")
	}
	if err := validatePublicHTTPSURL(distribution.URL, true); err != nil {
		return fmt.Errorf("distribution url: %w", err)
	}
	if err := validatePublicHTTPSURL(distribution.SourceURL, false); err != nil {
		return fmt.Errorf("distribution source_url: %w", err)
	}
	if !sha256Pattern.MatchString(distribution.SHA256) {
		return errors.New("distribution sha256 must be 64 lowercase hexadecimal characters")
	}
	if distribution.SizeBytes <= 0 || distribution.SizeBytes > 512<<20 {
		return errors.New("distribution size_bytes must be between 1 byte and 512 MiB")
	}
	if strings.TrimSpace(distribution.Publisher) == "" || utf8.RuneCountInString(distribution.Publisher) > 120 {
		return errors.New("distribution publisher must contain 1 to 120 characters")
	}
	if !licensePattern.MatchString(strings.TrimSpace(distribution.LicenseSPDX)) {
		return errors.New("distribution license_spdx is invalid")
	}
	entrypoint, err := safeRelativePath(distribution.Entrypoint)
	if err != nil || !strings.EqualFold(filepath.Ext(entrypoint), ".exe") {
		return errors.New("distribution entrypoint must be a package-relative .exe path")
	}
	distribution.Entrypoint = entrypoint
	if distribution.Type == "portable_exe" && strings.Contains(entrypoint, "/") {
		return errors.New("portable_exe entrypoint must be a single file name")
	}
	if len(distribution.AllowedRedirectHosts) > 4 {
		return errors.New("at most four redirect hosts may be approved")
	}
	redirects := map[string]bool{}
	for index, host := range distribution.AllowedRedirectHosts {
		host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
		if host == "" || strings.ContainsAny(host, "/:@[]") || redirects[host] {
			return errors.New("allowed_redirect_hosts must contain unique host names")
		}
		redirects[host] = true
		distribution.AllowedRedirectHosts[index] = host
	}
	sort.Strings(distribution.AllowedRedirectHosts)
	if len(distribution.Probe.Argv) == 0 || len(distribution.Probe.Argv) > 16 {
		return errors.New("portable distribution probe must contain 1 to 16 literal arguments")
	}
	for _, argument := range distribution.Probe.Argv {
		if argument == "" || len(argument) > 512 || strings.ContainsRune(argument, 0) {
			return errors.New("portable distribution probe arguments are invalid")
		}
	}
	if len(distribution.Probe.StdoutContains) > 256 || strings.ContainsRune(distribution.Probe.StdoutContains, 0) {
		return errors.New("portable distribution probe stdout marker is invalid")
	}
	if !permissions.NativeCode || !permissions.SameWindowsUser ||
		permissions.OSNetworkSandboxed || permissions.OSFilesystemSandboxed {
		return errors.New("portable native code must explicitly declare same-user execution without an OS network or filesystem sandbox")
	}
	return nil
}

func validatePublicHTTPSURL(raw string, allowRedirectSource bool) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Hostname() == "" || parsed.Fragment != "" {
		return errors.New("must be an absolute public HTTPS URL without credentials or fragment")
	}
	if !allowRedirectSource && parsed.RawQuery != "" {
		return errors.New("must not contain a query")
	}
	return nil
}

func validateInputSchema(schema map[string]any) error {
	if schema == nil || schema["type"] != "object" {
		return errors.New("type must be object")
	}
	if additional, ok := schema["additionalProperties"]; ok && additional != false {
		return errors.New("additionalProperties must be false")
	}
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		return errors.New("properties object is required")
	}
	if len(properties) > 24 {
		return errors.New("at most 24 input properties are supported")
	}
	for name := range properties {
		if !queryNamePattern.MatchString(name) {
			return errors.New("input property name is invalid")
		}
	}
	return nil
}
func validateManagedAction(schemaVersion string, distribution *PortableDistribution, action ManagedAction, schema map[string]any) error {
	switch action.Type {
	case "http_json_get":
		if schemaVersion != SchemaV1 {
			return errors.New("v2 portable packages may contain only portable_cli actions")
		}
		return validateHTTPAction(action, schema)
	case "portable_cli":
		if schemaVersion != SchemaV2 || distribution == nil {
			return errors.New("portable_cli requires a v2 portable distribution")
		}
		return validatePortableAction(distribution, action, schema)
	default:
		return errors.New("action type must be http_json_get or portable_cli")
	}
}

func validateHTTPAction(action ManagedAction, schema map[string]any) error {
	parsed, err := url.Parse(action.BaseURL)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Hostname() == "" || parsed.Fragment != "" {
		return errors.New("base_url must be an absolute public HTTPS URL without credentials or fragment")
	}
	if parsed.RawQuery != "" {
		return errors.New("base_url must not contain a query; use query_map")
	}
	properties := schema["properties"].(map[string]any)
	for input, param := range action.QueryMap {
		if _, ok := properties[input]; !ok {
			return fmt.Errorf("query_map input %q is not declared", input)
		}
		if !queryNamePattern.MatchString(param) {
			return fmt.Errorf("query parameter %q is invalid", param)
		}
	}
	return nil
}

func validatePortableAction(distribution *PortableDistribution, action ManagedAction, schema map[string]any) error {
	executable, err := safeRelativePath(action.Executable)
	if err != nil || executable != distribution.Entrypoint {
		return errors.New("portable_cli executable must exactly match the approved distribution entrypoint")
	}
	if action.BaseURL != "" || len(action.QueryMap) != 0 {
		return errors.New("portable_cli cannot contain HTTP action fields")
	}
	if len(action.Argv) > 32 {
		return errors.New("portable_cli supports at most 32 argv tokens")
	}
	properties := schema["properties"].(map[string]any)
	for _, token := range action.Argv {
		literal := strings.TrimSpace(token.Literal)
		input := strings.TrimSpace(token.Input)
		if (literal == "") == (input == "") {
			return errors.New("each argv token must contain exactly one of literal or input")
		}
		if literal != "" && (len(token.Literal) > 512 || strings.ContainsRune(token.Literal, 0)) {
			return errors.New("portable_cli literal argv token is invalid")
		}
		if input != "" {
			property, ok := properties[input].(map[string]any)
			if !ok {
				return fmt.Errorf("argv input %q is not declared", input)
			}
			switch property["type"] {
			case "string", "integer", "number", "boolean":
			default:
				return fmt.Errorf("argv input %q must be a scalar", input)
			}
		}
	}
	if action.Stdin.Mode == "" {
		action.Stdin.Mode = "none"
	}
	if action.Stdin.Mode != "none" && action.Stdin.Mode != "json" {
		return errors.New("portable_cli stdin mode must be none or json")
	}
	if action.Output.Format != "json" && action.Output.Format != "text" {
		return errors.New("portable_cli output format must be json or text")
	}
	if action.Output.MaxBytes < 1 || action.Output.MaxBytes > 8<<20 {
		return errors.New("portable_cli output max_bytes must be between 1 byte and 8 MiB")
	}
	if action.TimeoutSeconds < 1 || action.TimeoutSeconds > 600 {
		return errors.New("portable_cli timeout_seconds must be between 1 and 600")
	}
	return nil
}

func safeRelativePath(raw string) (string, error) {
	raw = strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
	clean := filepath.ToSlash(filepath.Clean(raw))
	if raw == "" || filepath.IsAbs(raw) || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(clean, ":") {
		return "", errors.New("tool package file path must stay inside the package")
	}
	for _, part := range strings.Split(clean, "/") {
		if part == "" || part == "." || part == ".." {
			return "", errors.New("tool package file path is invalid")
		}
	}
	return clean, nil
}
func fileContent(files []core.ToolPackageFile, path string) string {
	for _, file := range files {
		if file.Path == path {
			return file.Content
		}
	}
	return ""
}

func VerifyPackage(pkg core.ToolPackage) error {
	proposal := Proposal{Kind: pkg.Kind, Name: pkg.Name, DisplayName: pkg.DisplayName, Description: pkg.Description, Version: pkg.Version}
	for _, f := range pkg.Files {
		proposal.Files = append(proposal.Files, ProposalFile{Path: f.Path, Content: f.Content})
	}
	rebuilt, err := ValidateProposal(pkg.ProjectID, pkg.SourceRunID, pkg.SourceStageAttemptID, proposal)
	if err != nil {
		return err
	}
	if rebuilt.PackageSHA256 != pkg.PackageSHA256 {
		return errors.New("tool package hash verification failed")
	}
	return nil
}
