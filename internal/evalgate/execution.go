package evalgate

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
)

const (
	ExecutionManifestSchemaV3 = "aetherops_release_evaluation_execution_v3"
	ReleaseProductVersion     = buildinfo.ReleaseProductVersion
)

type ProductBuildBinding = buildinfo.ProductBuildBinding

type ExecutionCase struct {
	CaseID string `json:"case_id"`
	Mode   string `json:"mode"`
	Prompt string `json:"prompt"`
	RunID  string `json:"run_id"`
}

// ExecutionManifest is a human-operated, auditable bridge between the real
// product UI and the offline release verifier. It never grants approvals or
// substitutes fixture output: the operator submits each exact prompt through
// AetherOps, handles any approval in the normal UI, and records the resulting
// durable run id here.
type ExecutionManifest struct {
	Schema        string              `json:"schema"`
	DatasetName   string              `json:"dataset_name"`
	DatasetSHA256 string              `json:"dataset_sha256"`
	ProductBuild  ProductBuildBinding `json:"product_build"`
	PreparedAt    time.Time           `json:"prepared_at"`
	Cases         []ExecutionCase     `json:"cases"`
	SHA256        string              `json:"-"`
}

func PrepareExecutionManifest(dataset Dataset, now time.Time, build ProductBuildBinding) (ExecutionManifest, error) {
	if err := dataset.Validate(); err != nil {
		return ExecutionManifest{}, err
	}
	if now.IsZero() {
		now = time.Now()
	}
	manifest := ExecutionManifest{
		Schema: ExecutionManifestSchemaV3, DatasetName: dataset.Name,
		DatasetSHA256: dataset.SHA256, ProductBuild: build, PreparedAt: now.UTC(),
		Cases: make([]ExecutionCase, len(dataset.Cases)),
	}
	for index, item := range dataset.Cases {
		manifest.Cases[index] = ExecutionCase{CaseID: item.ID, Mode: item.Mode, Prompt: item.Prompt()}
	}
	return manifest, nil
}

func LoadExecutionManifest(path string, dataset Dataset) (ExecutionManifest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ExecutionManifest{}, err
	}
	var manifest ExecutionManifest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return ExecutionManifest{}, fmt.Errorf("decode evaluation execution manifest: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return ExecutionManifest{}, errors.New("evaluation execution manifest contains multiple JSON values")
		}
		return ExecutionManifest{}, fmt.Errorf("decode evaluation execution manifest trailer: %w", err)
	}
	sum := sha256.Sum256(raw)
	manifest.SHA256 = hex.EncodeToString(sum[:])
	if err := manifest.Validate(dataset, true); err != nil {
		return ExecutionManifest{}, err
	}
	return manifest, nil
}

func (manifest ExecutionManifest) Validate(dataset Dataset, requireRuns bool) error {
	if err := dataset.Validate(); err != nil {
		return err
	}
	if manifest.Schema != ExecutionManifestSchemaV3 || manifest.DatasetName != dataset.Name ||
		manifest.DatasetSHA256 != dataset.SHA256 || manifest.PreparedAt.IsZero() {
		return errors.New("evaluation execution manifest is not bound to the selected dataset")
	}
	if err := manifest.ProductBuild.Validate(); err != nil {
		return fmt.Errorf("evaluation execution product build: %w", err)
	}
	if len(manifest.Cases) != len(dataset.Cases) {
		return fmt.Errorf("evaluation execution manifest has %d cases, want %d", len(manifest.Cases), len(dataset.Cases))
	}
	seenRuns := make(map[string]struct{}, len(manifest.Cases))
	for index, expected := range dataset.Cases {
		actual := manifest.Cases[index]
		if actual.CaseID != expected.ID || actual.Mode != expected.Mode || actual.Prompt != expected.Prompt() {
			return fmt.Errorf("evaluation execution case %d does not match dataset case %q", index+1, expected.ID)
		}
		runID := strings.TrimSpace(actual.RunID)
		if requireRuns && runID == "" {
			return fmt.Errorf("evaluation case %q has no real run id", expected.ID)
		}
		if runID != "" {
			if _, duplicate := seenRuns[runID]; duplicate {
				return fmt.Errorf("evaluation run %q is reused by multiple cases", runID)
			}
			seenRuns[runID] = struct{}{}
		}
	}
	return nil
}

// BindProductBuild hashes the exact executable, runtime manifest, and complete
// fixed sidecar file set used for live evaluation. The verify command
// recomputes the binding, so rebuilding or swapping any input invalidates it.
func BindProductBuild(executablePath, runtimeManifestPath, knowledgeSidecarPath string) (ProductBuildBinding, error) {
	return buildinfo.BindProductBuild(executablePath, runtimeManifestPath, knowledgeSidecarPath)
}

func (manifest ExecutionManifest) Mappings() []RunMapping {
	mappings := make([]RunMapping, len(manifest.Cases))
	for index, item := range manifest.Cases {
		mappings[index] = RunMapping{CaseID: item.CaseID, RunID: strings.TrimSpace(item.RunID)}
	}
	return mappings
}
