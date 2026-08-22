package evalgate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/djkim0320/Aether-claw/internal/core"
)

const (
	RunnerExecutionSource = "release_eval_runner"
	RunnerLiveEvidence    = "live_product_api_observation"
)

type RunnerRunMapping struct {
	CaseID        string         `json:"case_id"`
	RunID         string         `json:"run_id"`
	PromptSHA256  string         `json:"prompt_sha256"`
	StartedAt     time.Time      `json:"started_at"`
	TerminalAt    time.Time      `json:"terminal_at"`
	ProductStatus core.RunStatus `json:"product_status"`
}

type RunnerExecution struct {
	RunOrigin           string              `json:"run_origin"`
	EvidenceClass       string              `json:"evidence_class"`
	EvalRunSetID        string              `json:"eval_run_set_id"`
	DatasetName         string              `json:"dataset_name"`
	DatasetSHA256       string              `json:"dataset_sha256"`
	ProductBuild        ProductBuildBinding `json:"product_build"`
	ProjectID           string              `json:"project_id,omitempty"`
	SessionID           string              `json:"session_id,omitempty"`
	StartedAt           time.Time           `json:"started_at"`
	TerminalAt          time.Time           `json:"terminal_at"`
	RunnerReceiptSHA256 string              `json:"runner_receipt_sha256"`
	Mappings            []RunnerRunMapping  `json:"mappings"`
}

func (execution RunnerExecution) Validate(dataset Dataset) error {
	if err := dataset.Validate(); err != nil {
		return err
	}
	if execution.RunOrigin != RunnerExecutionSource || execution.EvidenceClass != RunnerLiveEvidence ||
		strings.TrimSpace(execution.EvalRunSetID) == "" {
		return errors.New("release evaluation execution lacks authenticated runner provenance")
	}
	if execution.DatasetName != dataset.Name || execution.DatasetSHA256 != dataset.SHA256 {
		return errors.New("runner execution is bound to a different dataset")
	}
	if err := execution.ProductBuild.Validate(); err != nil {
		return err
	}
	if (strings.TrimSpace(execution.ProjectID) == "") == (strings.TrimSpace(execution.SessionID) == "") {
		return errors.New("runner execution must identify exactly one project or conversation session")
	}
	if execution.StartedAt.IsZero() || execution.TerminalAt.IsZero() || execution.TerminalAt.Before(execution.StartedAt) {
		return errors.New("runner execution time bounds are invalid")
	}
	if !validRunnerDigest(execution.RunnerReceiptSHA256) {
		return errors.New("runner execution receipt SHA-256 is invalid")
	}
	if len(execution.Mappings) != len(dataset.Cases) {
		return fmt.Errorf("runner execution has %d mappings, want %d", len(execution.Mappings), len(dataset.Cases))
	}
	byCase := make(map[string]RunnerRunMapping, len(execution.Mappings))
	runIDs := make(map[string]struct{}, len(execution.Mappings))
	for _, mapping := range execution.Mappings {
		if strings.TrimSpace(mapping.CaseID) == "" || strings.TrimSpace(mapping.RunID) == "" ||
			!validRunnerDigest(mapping.PromptSHA256) || mapping.StartedAt.Before(execution.StartedAt) ||
			mapping.TerminalAt.After(execution.TerminalAt) || mapping.TerminalAt.Before(mapping.StartedAt) ||
			!runnerObservedTerminal(mapping.ProductStatus) {
			return fmt.Errorf("runner execution mapping %q is incomplete", mapping.CaseID)
		}
		if _, duplicate := byCase[mapping.CaseID]; duplicate {
			return fmt.Errorf("runner execution duplicates case %q", mapping.CaseID)
		}
		if _, duplicate := runIDs[mapping.RunID]; duplicate {
			return fmt.Errorf("runner execution reuses run id %q", mapping.RunID)
		}
		byCase[mapping.CaseID] = mapping
		runIDs[mapping.RunID] = struct{}{}
	}
	for _, item := range dataset.Cases {
		mapping, ok := byCase[item.ID]
		if !ok || mapping.PromptSHA256 != runnerPromptSHA256(item.Prompt()) {
			return fmt.Errorf("runner execution does not match exact prompt for %q", item.ID)
		}
	}
	return nil
}

func (verifier Verifier) VerifyRunnerExecution(ctx context.Context, dataset Dataset, execution RunnerExecution) (Receipt, error) {
	if verifier.Oxigraph == nil {
		return Receipt{}, errors.New("release runner verification requires the real Oxigraph sidecar")
	}
	if err := execution.Validate(dataset); err != nil {
		return Receipt{}, err
	}
	mappings := make([]RunMapping, len(execution.Mappings))
	for index, mapping := range execution.Mappings {
		run, err := verifier.DB.Run(ctx, mapping.RunID)
		if err != nil {
			return Receipt{}, fmt.Errorf("load runner execution run %s: %w", mapping.RunID, err)
		}
		if run.ProductBuild != execution.ProductBuild || run.Question != dataset.Cases[indexForCase(dataset, mapping.CaseID)].Prompt() ||
			run.Status != mapping.ProductStatus || !run.CreatedAt.Equal(mapping.StartedAt) || !run.UpdatedAt.Equal(mapping.TerminalAt) {
			return Receipt{}, fmt.Errorf("runner execution run %s differs from its API-observed provenance", mapping.RunID)
		}
		if execution.ProjectID != "" && run.ProjectID != execution.ProjectID {
			return Receipt{}, fmt.Errorf("runner execution run %s belongs to a different project", mapping.RunID)
		}
		if execution.SessionID != "" && run.ConversationSessionID != execution.SessionID {
			return Receipt{}, fmt.Errorf("runner execution run %s belongs to a different conversation session", mapping.RunID)
		}
		mappings[index] = RunMapping{CaseID: mapping.CaseID, RunID: mapping.RunID}
	}
	receipt, err := verifier.Verify(ctx, dataset, mappings)
	if err != nil {
		return Receipt{}, err
	}
	receipt.ExecutionSource = execution.RunOrigin
	receipt.EvalRunSetID = execution.EvalRunSetID
	receipt.RunnerReceiptSHA256 = execution.RunnerReceiptSHA256
	receipt.ExecutionManifestSHA256 = ""
	receipt.ProductBuild = execution.ProductBuild
	return receipt, nil
}

func indexForCase(dataset Dataset, caseID string) int {
	for index := range dataset.Cases {
		if dataset.Cases[index].ID == caseID {
			return index
		}
	}
	return 0
}

func runnerPromptSHA256(prompt string) string {
	digest := sha256.Sum256([]byte(prompt))
	return hex.EncodeToString(digest[:])
}

func validRunnerDigest(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && value == strings.ToLower(value)
}

func runnerObservedTerminal(status core.RunStatus) bool {
	switch status {
	case core.RunSucceeded, core.RunQualityFailed, core.RunFailed, core.RunCancelled,
		core.RunInterrupted, core.RunUncertain:
		return true
	default:
		return false
	}
}
