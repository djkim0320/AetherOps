package evalrunner

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

	"github.com/djkim0320/AetherOps/internal/evalgate"
)

const maxReceiptBytes = 4 << 20

func LoadReceipt(path string, dataset evalgate.Dataset, build evalgate.ProductBuildBinding) (Receipt, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return Receipt{}, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 0 || info.Size() > maxReceiptBytes {
		return Receipt{}, errors.New("runner receipt must be a regular non-symlink JSON file within the size limit")
	}
	file, err := os.Open(path)
	if err != nil {
		return Receipt{}, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) {
		return Receipt{}, errors.New("runner receipt changed while opening")
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxReceiptBytes+1))
	if err != nil {
		return Receipt{}, err
	}
	if len(raw) > maxReceiptBytes || int64(len(raw)) != opened.Size() {
		return Receipt{}, errors.New("runner receipt changed while reading")
	}
	var receipt Receipt
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&receipt); err != nil {
		return Receipt{}, fmt.Errorf("decode runner receipt: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Receipt{}, errors.New("runner receipt contains trailing JSON data")
	}
	digest := sha256.Sum256(raw)
	receipt.SHA256 = hex.EncodeToString(digest[:])
	if err := receipt.ValidateLive(dataset, build); err != nil {
		return Receipt{}, err
	}
	return receipt, nil
}

func (receipt Receipt) ValidateLive(dataset evalgate.Dataset, build evalgate.ProductBuildBinding) error {
	if err := dataset.Validate(); err != nil {
		return err
	}
	if err := build.Validate(); err != nil {
		return err
	}
	if receipt.Schema != ReceiptSchemaV1 || receipt.RunOrigin != RunOrigin ||
		receipt.EvidenceClass != EvidenceLiveProductAPI || receipt.ReleaseGatePassed ||
		!receipt.RequiresOfflineVerification || !receipt.EligibleForOfflineVerification {
		return errors.New("runner receipt is not eligible live-product provenance")
	}
	if !safeIDPattern.MatchString(receipt.EvalRunSetID) || receipt.StartedAt.IsZero() ||
		receipt.TerminalAt.IsZero() || receipt.TerminalAt.Before(receipt.StartedAt) {
		return errors.New("runner receipt identity or time bounds are invalid")
	}
	if receipt.DatasetName != dataset.Name || receipt.DatasetSHA256 != dataset.SHA256 {
		return errors.New("runner receipt is bound to a different evaluation dataset")
	}
	if receipt.ProductBuild != build {
		return errors.New("runner receipt is bound to a different product build")
	}
	if err := receipt.Target.Validate(); err != nil {
		return err
	}
	if decoded, err := hex.DecodeString(receipt.EndpointSHA256); err != nil || len(decoded) != sha256.Size ||
		receipt.EndpointSHA256 != strings.ToLower(receipt.EndpointSHA256) {
		return errors.New("runner receipt endpoint hash is invalid")
	}
	complete := receipt.Completeness
	if complete.ExpectedCases != 12 || complete.AccountedCases != 12 || complete.RunnerTerminalCases != 12 ||
		complete.ProductTerminalCases != 12 || complete.AmbiguousCases != 0 || complete.SubmissionFailures != 0 ||
		!complete.AllProductRunsTerminal || len(receipt.Cases) != 12 {
		return errors.New("runner receipt does not contain twelve unambiguous product-terminal cases")
	}
	byCase := make(map[string]CaseReceipt, len(receipt.Cases))
	runIDs := make(map[string]struct{}, len(receipt.Cases))
	for _, item := range receipt.Cases {
		if item.RunOrigin != RunOrigin || item.EvalRunSetID != receipt.EvalRunSetID {
			return errors.New("runner case provenance differs from the run-set provenance")
		}
		if _, duplicate := byCase[item.DatasetCaseID]; duplicate {
			return fmt.Errorf("runner receipt duplicates dataset case %q", item.DatasetCaseID)
		}
		if !safeIDPattern.MatchString(item.RunID) {
			return fmt.Errorf("runner receipt case %q has an invalid run id", item.DatasetCaseID)
		}
		if _, duplicate := runIDs[item.RunID]; duplicate {
			return fmt.Errorf("runner receipt reuses run id %q", item.RunID)
		}
		if item.State != CaseTerminal || !observedTerminal(item.ProductStatus) || item.ProductRevision < 0 ||
			item.StartedAt == nil || item.TerminalAt == nil || item.TerminalAt.Before(*item.StartedAt) ||
			item.StartedAt.Before(receipt.StartedAt) || item.TerminalAt.After(receipt.TerminalAt) ||
			len(item.PendingApprovals) != 0 || item.FailureCode != "" {
			return fmt.Errorf("runner receipt case %q is not a clean terminal observation", item.DatasetCaseID)
		}
		byCase[item.DatasetCaseID] = item
		runIDs[item.RunID] = struct{}{}
	}
	for _, expected := range dataset.Cases {
		actual, ok := byCase[expected.ID]
		if !ok || actual.Mode != expected.Mode || actual.PromptSHA256 != promptSHA256(expected.Prompt()) {
			return fmt.Errorf("runner receipt case %q does not match the exact dataset prompt", expected.ID)
		}
	}
	return nil
}

func (receipt Receipt) RunnerExecution() evalgate.RunnerExecution {
	mappings := make([]evalgate.RunnerRunMapping, len(receipt.Cases))
	for index, item := range receipt.Cases {
		mappings[index] = evalgate.RunnerRunMapping{
			CaseID: item.DatasetCaseID, RunID: item.RunID, PromptSHA256: item.PromptSHA256,
			StartedAt: *item.StartedAt, TerminalAt: *item.TerminalAt, ProductStatus: item.ProductStatus,
		}
	}
	return evalgate.RunnerExecution{
		RunOrigin: receipt.RunOrigin, EvidenceClass: receipt.EvidenceClass,
		EvalRunSetID: receipt.EvalRunSetID, DatasetName: receipt.DatasetName,
		DatasetSHA256: receipt.DatasetSHA256, ProductBuild: receipt.ProductBuild,
		ProjectID: receipt.Target.ProjectID, SessionID: receipt.Target.SessionID,
		StartedAt: receipt.StartedAt, TerminalAt: receipt.TerminalAt,
		RunnerReceiptSHA256: receipt.SHA256, Mappings: mappings,
	}
}
