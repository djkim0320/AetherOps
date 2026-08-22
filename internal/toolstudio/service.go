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

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/store"
)

const (
	SchemaV1        = "aetherops_tool_package_v1"
	maxFiles        = 32
	maxFileBytes    = 512 << 10
	maxPackageBytes = 2 << 20
)

var namePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}[a-z0-9]$|^[a-z]$`)
var versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$`)
var queryNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)

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
	Schema      string        `json:"schema"`
	Name        string        `json:"name"`
	Description string        `json:"description"`
	Tools       []ManagedTool `json:"tools"`
}
type ManagedTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"input_schema"`
	Action      HTTPJSONAction `json:"action"`
}
type HTTPJSONAction struct {
	Type     string            `json:"type"`
	BaseURL  string            `json:"base_url"`
	QueryMap map[string]string `json:"query_map,omitempty"`
}

type Service struct{ DB *store.DB }

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
	return service.DB.ActivateToolPackage(ctx, projectID, packageID)
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
	if manifest.Schema != SchemaV1 || !namePattern.MatchString(manifest.Name) || strings.TrimSpace(manifest.Description) == "" {
		return Manifest{}, "", errors.New("mcp.json identity is invalid")
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
		if err := validateHTTPAction(tool.Action, tool.InputSchema); err != nil {
			return Manifest{}, "", fmt.Errorf("tool %s action: %w", tool.Name, err)
		}
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return Manifest{}, "", err
	}
	return manifest, string(encoded), nil
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
func validateHTTPAction(action HTTPJSONAction, schema map[string]any) error {
	if action.Type != "http_json_get" {
		return errors.New("only http_json_get is supported")
	}
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
