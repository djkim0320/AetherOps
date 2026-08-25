package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/djkim0320/AetherOps/internal/browser"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
	"github.com/djkim0320/AetherOps/internal/toolstudio"
)

const maxManagedJSONBytes = 2 << 20

func managedToolCatalog(ctx context.Context, db *store.DB, projectID string) ([]map[string]any, error) {
	packages, err := db.ListToolPackages(ctx, projectID)
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0)
	for _, pkg := range packages {
		if pkg.State != "active" {
			continue
		}
		full, err := db.ActiveToolPackageByID(ctx, pkg.ID)
		if err != nil {
			return nil, err
		}
		if err := toolstudio.VerifyPackage(full); err != nil {
			return nil, fmt.Errorf("verify managed tool package %s: %w", pkg.ID, err)
		}
		entry := map[string]any{"package_id": pkg.ID, "kind": pkg.Kind, "name": pkg.Name, "display_name": pkg.DisplayName, "description": pkg.Description, "version": pkg.Version, "package_sha256": pkg.PackageSHA256}
		if pkg.Kind == "skill" {
			files := make([]map[string]any, 0, len(full.Files))
			for _, file := range full.Files {
				files = append(files, map[string]any{"path": file.Path, "content_sha256": file.ContentSHA256, "size": file.Size})
			}
			entry["files"] = files
		} else {
			manifest, _, err := toolstudio.ParseManifest(full.ManifestJSON)
			if err != nil {
				return nil, err
			}
			tools := make([]map[string]any, 0, len(manifest.Tools))
			for _, tool := range manifest.Tools {
				tools = append(tools, map[string]any{"name": tool.Name, "description": tool.Description, "input_schema": tool.InputSchema})
			}
			entry["tools"] = tools
			if toolstudio.IsPortableManifest(manifest) && manifest.Distribution != nil && full.Installation != nil {
				entry["portable"] = map[string]any{
					"publisher":               manifest.Distribution.Publisher,
					"license_spdx":            manifest.Distribution.LicenseSPDX,
					"payload_sha256":          manifest.Distribution.SHA256,
					"installed_tree_sha256":   full.Installation.InstalledTreeSHA256,
					"installation_id":         full.Installation.ID,
					"same_windows_user":       true,
					"os_network_sandboxed":    false,
					"os_filesystem_sandboxed": false,
				}
			}
		}
		result = append(result, entry)
	}
	return result, nil
}

func getManagedSkill(ctx context.Context, db *store.DB, projectID, packageID string) (core.ToolPackage, error) {
	pkg, err := db.ActiveToolPackageByID(ctx, packageID)
	if err != nil {
		return core.ToolPackage{}, err
	}
	if pkg.ProjectID != projectID {
		return core.ToolPackage{}, errors.New("managed skill belongs to another project")
	}
	if pkg.Kind != "skill" {
		return core.ToolPackage{}, errors.New("managed package is not a skill")
	}
	if err := toolstudio.VerifyPackage(pkg); err != nil {
		return core.ToolPackage{}, err
	}
	return pkg, nil
}

type portableToolRunner interface {
	RunPortableForStage(context.Context, string, string, string, string, map[string]any) (any, error)
}

func executeManagedTool(ctx context.Context, db *store.DB, policy browser.Policy, runner portableToolRunner, packageID, name string, raw json.RawMessage) (any, error) {
	pkg, err := db.ActiveToolPackageByID(ctx, packageID)
	if err != nil {
		return nil, fmt.Errorf("load active managed tool package: %w", err)
	}
	if pkg.Kind != "mcp" {
		return nil, errors.New("managed package is not an MCP adapter")
	}
	if err := toolstudio.VerifyPackage(pkg); err != nil {
		return nil, fmt.Errorf("verify managed tool package: %w", err)
	}
	manifest, _, err := toolstudio.ParseManifest(pkg.ManifestJSON)
	if err != nil {
		return nil, err
	}
	if toolstudio.IsPortableManifest(manifest) {
		if runner == nil {
			return nil, errors.New("portable tool runner is unavailable")
		}
		var arguments map[string]any
		decoder := json.NewDecoder(strings.NewReader(string(raw)))
		decoder.UseNumber()
		if err := decoder.Decode(&arguments); err != nil {
			return nil, errors.New("invalid portable tool input")
		}
		runID, _ := arguments["run_id"].(string)
		stageID, _ := arguments["stage_attempt_id"].(string)
		delete(arguments, "run_id")
		delete(arguments, "stage_attempt_id")
		return runner.RunPortableForStage(ctx, runID, stageID, packageID, name, arguments)
	}
	return callManagedTool(ctx, db, policy, pkg, manifest, name, raw)
}

func callManagedTool(ctx context.Context, db *store.DB, policy browser.Policy, pkg core.ToolPackage, manifest toolstudio.Manifest, name string, raw json.RawMessage) (any, error) {
	var arguments map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if err := decoder.Decode(&arguments); err != nil {
		return nil, errors.New("invalid managed tool input")
	}
	runID, _ := arguments["run_id"].(string)
	stageID, _ := arguments["stage_attempt_id"].(string)
	if runID == "" || stageID == "" {
		return nil, errors.New("run_id and stage_attempt_id are required")
	}
	projectID, err := db.ValidateStageCapability(ctx, runID, stageID)
	if err != nil {
		return nil, err
	}
	if projectID != pkg.ProjectID {
		return nil, errors.New("managed tool package belongs to another project")
	}
	var selected *toolstudio.ManagedTool
	for index := range manifest.Tools {
		if manifest.Tools[index].Name == name {
			selected = &manifest.Tools[index]
			break
		}
	}
	if selected == nil {
		return nil, fmt.Errorf("managed tool %q is not available", name)
	}
	properties, _ := selected.InputSchema["properties"].(map[string]any)
	allowed := map[string]bool{"run_id": true, "stage_attempt_id": true}
	for key := range properties {
		allowed[key] = true
	}
	for key := range arguments {
		if !allowed[key] {
			return nil, fmt.Errorf("unknown managed tool input %q", key)
		}
	}
	for _, required := range stringList(selected.InputSchema["required"]) {
		if _, ok := arguments[required]; !ok {
			return nil, fmt.Errorf("required managed tool input %q is missing", required)
		}
	}
	endpoint, err := url.Parse(selected.Action.BaseURL)
	if err != nil {
		return nil, err
	}
	query := endpoint.Query()
	for input, param := range selected.Action.QueryMap {
		if value, ok := arguments[input]; ok {
			switch value.(type) {
			case string, json.Number, float64, bool:
			default:
				return nil, fmt.Errorf("query input %q must be a scalar", input)
			}
			query.Set(param, fmt.Sprint(value))
		}
	}
	endpoint.RawQuery = query.Encode()
	fetched, err := fetchPublicEvidence(ctx, policy, endpoint.String())
	if err != nil {
		return nil, err
	}
	if len(fetched.Body) > maxManagedJSONBytes {
		return nil, errors.New("managed tool JSON response exceeds 2 MiB")
	}
	finalURL, err := url.Parse(fetched.FinalURL)
	if err != nil || !strings.EqualFold(finalURL.Hostname(), endpoint.Hostname()) {
		return nil, errors.New("managed tool redirect left the approved host")
	}
	var value any
	decoder = json.NewDecoder(strings.NewReader(string(fetched.Body)))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, errors.New("managed tool endpoint did not return valid JSON")
	}
	if tailErr := decoder.Decode(&struct{}{}); !errors.Is(tailErr, io.EOF) {
		return nil, errors.New("managed tool endpoint returned multiple JSON values")
	}
	return map[string]any{"package_id": pkg.ID, "tool": name, "source_url": fetched.FinalURL, "data": value, "evidence_required": true}, nil
}

func stringList(value any) []string {
	var output []string
	switch values := value.(type) {
	case []any:
		for _, v := range values {
			if text, ok := v.(string); ok {
				output = append(output, text)
			}
		}
	case []string:
		output = append(output, values...)
	}
	return output
}
