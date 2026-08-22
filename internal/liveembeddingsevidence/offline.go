package liveembeddingsevidence

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/evalgate"
	"github.com/djkim0320/Aether-claw/internal/evalrunner"
	"github.com/djkim0320/Aether-claw/internal/rag"
	"github.com/djkim0320/Aether-claw/internal/releasegate"
	"github.com/djkim0320/Aether-claw/internal/store"
)

type FinalizeConfig struct {
	CandidateExecutable string
	PreparedLedger      string
	DatasetPath         string
	RunnerReceipt       string
	JournalPath         string
	DataRoot            string
}

// FinalizeOffline opens only read-only product storage and verifies every
// ready source, deterministic chunk, active vector, and live search result.
func FinalizeOffline(ctx context.Context, config FinalizeConfig) (result FinalizeResult, returnErr error) {
	observation, err := loadCompleteJournal(config.JournalPath)
	if err != nil {
		return FinalizeResult{}, err
	}
	if err := reauthenticateFinalizeInputs(config, observation.Binding); err != nil {
		return FinalizeResult{}, err
	}
	root, err := filepath.Abs(strings.TrimSpace(config.DataRoot))
	if err != nil || strings.TrimSpace(config.DataRoot) == "" {
		return FinalizeResult{}, errors.New("explicit AetherOps v2 data root is required")
	}
	database, err := store.OpenReadOnly(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		return FinalizeResult{}, err
	}
	defer func() { returnErr = errors.Join(returnErr, database.Close()) }()
	objects, err := cas.OpenReadOnly(filepath.Join(root, "objects"))
	if err != nil {
		return FinalizeResult{}, err
	}
	documents, err := database.MemoryDocuments(ctx, observation.Binding.ProjectID)
	if err != nil {
		return FinalizeResult{}, err
	}
	documentObservation, err := observeDocuments(documents)
	if err != nil || documentObservation != observation.Documents {
		return FinalizeResult{}, errors.New("durable project documents differ from the live pre-reindex observation")
	}
	casHashes := make([]string, 0, len(documents))
	for _, document := range documents {
		data, err := objects.ReadVerified(document.BlobHash)
		if err != nil {
			return FinalizeResult{}, fmt.Errorf("read CAS document %s: %w", document.ID, err)
		}
		if int64(len(data)) != document.Size {
			return FinalizeResult{}, fmt.Errorf("CAS document %s size mismatch", document.ID)
		}
		text, err := documentText(document, data)
		if err != nil {
			return FinalizeResult{}, err
		}
		expected := rag.ChunkText(text, rag.DefaultChunkRunes, rag.DefaultOverlapRunes)
		if err := database.VerifyDocumentIndex(ctx, document.ProjectID, document.ArtifactID, document.BlobHash, expected); err != nil {
			return FinalizeResult{}, fmt.Errorf("verify deterministic document %s: %w", document.ID, err)
		}
		casHashes = append(casHashes, document.BlobHash)
	}
	proof, err := database.VerifyMemoryShadowRelease(ctx, store.MemoryShadowReleaseExpectation{
		ProjectID: observation.Binding.ProjectID, PreviousIndexID: observation.Before.ActiveIndexID, ActiveIndexID: observation.Index.ID,
		BeforeRevision: observation.Before.MemoryRevision, AfterRevision: observation.After.MemoryRevision, ExpectedDocuments: observation.Documents.Count,
	})
	if err != nil {
		return FinalizeResult{}, err
	}
	for _, result := range observation.Search.Results {
		readback, err := database.MemoryGet(ctx, observation.Binding.ProjectID, result.ChunkID)
		if err != nil {
			return FinalizeResult{}, fmt.Errorf("read back searched chunk %s: %w", result.ChunkID, err)
		}
		digest := sha256.Sum256([]byte(readback.Text))
		if readback.DocumentID != result.DocumentID || hex.EncodeToString(digest[:]) != result.TextSHA256 {
			return FinalizeResult{}, fmt.Errorf("searched chunk %s differs from durable readback", result.ChunkID)
		}
	}
	sort.Strings(casHashes)
	casRaw, _ := json.Marshal(casHashes)
	casDigest := sha256.Sum256(casRaw)
	proofRaw, err := json.Marshal(proof)
	if err != nil {
		return FinalizeResult{}, err
	}
	proofDigest := sha256.Sum256(proofRaw)
	now := time.Now().UTC()
	details := Details{
		Schema: DetailsSchemaV1, ReleaseCandidateID: observation.Binding.ReleaseCandidateID,
		PreparedLedgerSHA256: observation.Binding.PreparedLedgerSHA256, PreparedLedgerRevision: observation.Binding.PreparedLedgerRevision,
		LedgerPreparedAt: observation.Binding.LedgerPreparedAt, RunnerReceiptSHA256: observation.Binding.RunnerReceiptSHA256,
		EvalRunSetID: observation.Binding.EvalRunSetID, ProjectID: observation.Binding.ProjectID, EndpointSHA256: observation.Binding.EndpointSHA256,
		QuerySHA256: observation.Binding.QuerySHA256, LiveJournalSHA256: observation.JournalSHA256,
		LiveStartedAt: observation.LiveStartedAt, LiveFinishedAt: observation.LiveFinishedAt, OfflineVerifiedAt: now,
		Documents: observation.Documents, Before: observation.Before, ObservedIndex: observation.Index, After: observation.After,
		Search: observation.Search, DurableProof: proof, CASSourceSetSHA256: hex.EncodeToString(casDigest[:]),
		CASObjectsVerified: len(documents), DeterministicDocuments: len(documents),
		SearchResultsReadBack: len(observation.Search.Results), FixtureRole: "none", ReleaseGateEligible: true, NoAmbiguousPOSTRetried: true,
	}
	activeDigest := sha256.Sum256([]byte("aetherops-active-memory-index-v1\x00" + proof.ActiveIndexID))
	previousDigest := sha256.Sum256([]byte("aetherops-previous-memory-index-v1\x00" + proof.PreviousIndexID))
	queryDigest := sha256.Sum256([]byte("aetherops-memory-query-v1\x00" + observation.Binding.QuerySHA256))
	searchDigest := sha256.Sum256([]byte("aetherops-memory-search-readback-v1\x00" + observation.Search.SetSHA256))
	subjects := map[string]string{
		"aetherops.exe":               observation.Binding.ProductBuild.ExecutableSHA256,
		"runtime-manifest.json":       observation.Binding.ProductBuild.RuntimeManifestSHA256,
		"knowledge-sidecar-tree":      observation.Binding.ProductBuild.KnowledgeSidecarTreeSHA256,
		"prepared-ledger":             observation.Binding.PreparedLedgerSHA256,
		"release-eval-runner-receipt": observation.Binding.RunnerReceiptSHA256,
		"live-embedding-journal":      observation.JournalSHA256,
		"active-memory-index":         hex.EncodeToString(activeDigest[:]),
		"previous-memory-index":       hex.EncodeToString(previousDigest[:]),
		"memory-query":                hex.EncodeToString(queryDigest[:]),
		"search-readback":             hex.EncodeToString(searchDigest[:]),
		"cas-source-set":              hex.EncodeToString(casDigest[:]),
		"vector-set":                  proof.VectorSetSHA256,
		"durable-memory-proof":        hex.EncodeToString(proofDigest[:]),
	}
	return FinalizeResult{Details: details, SubjectHashes: subjects}, nil
}

func ReauthenticateFinalizeInputs(config FinalizeConfig, binding Binding) error {
	return reauthenticateFinalizeInputs(config, binding)
}

func ReauthenticateFinalized(config FinalizeConfig, result FinalizeResult, build buildinfo.ProductBuildBinding) error {
	observation, err := loadCompleteJournal(config.JournalPath)
	if err != nil || observation.JournalSHA256 != result.Details.LiveJournalSHA256 ||
		observation.Binding.ReleaseCandidateID != result.Details.ReleaseCandidateID ||
		observation.Index.ID != result.Details.ObservedIndex.ID || observation.After.MemoryRevision != result.Details.After.MemoryRevision {
		return errors.New("live journal changed after offline verification")
	}
	binding := Binding{
		ProductBuild: build, ReleaseCandidateID: result.Details.ReleaseCandidateID,
		PreparedLedgerSHA256: result.Details.PreparedLedgerSHA256, PreparedLedgerRevision: result.Details.PreparedLedgerRevision,
		LedgerPreparedAt: result.Details.LedgerPreparedAt, RunnerReceiptSHA256: result.Details.RunnerReceiptSHA256,
		EvalRunSetID: result.Details.EvalRunSetID, ProjectID: result.Details.ProjectID,
		EndpointSHA256: result.Details.EndpointSHA256, RunnerTerminalAt: result.Details.LiveStartedAt,
	}
	// The runner terminal timestamp is authenticated by reloading the exact
	// receipt below; carry it from the journal-derived details relationship.
	dataset, err := evalgate.LoadDataset(config.DatasetPath)
	if err != nil {
		return err
	}
	runner, err := evalrunner.LoadReceipt(config.RunnerReceipt, dataset, build)
	if err != nil {
		return err
	}
	binding.RunnerTerminalAt = runner.TerminalAt
	return reauthenticateFinalizeInputs(config, binding)
}

func reauthenticateFinalizeInputs(config FinalizeConfig, binding Binding) error {
	build, err := AuthenticateCandidate(config.CandidateExecutable)
	if err != nil || build != binding.ProductBuild {
		return errors.New("offline candidate differs from the live journal")
	}
	ledger, ledgerSHA, err := releasegate.LoadLedgerChain(config.PreparedLedger)
	if err != nil || ledgerSHA != binding.PreparedLedgerSHA256 || ledger.ReleaseCandidateID != binding.ReleaseCandidateID ||
		ledger.Revision != binding.PreparedLedgerRevision || ledger.ProductBuild != binding.ProductBuild || !ledger.PreparedAt.Equal(binding.LedgerPreparedAt) || !gateEmpty(ledger) {
		return errors.New("offline prepared ledger differs from the live journal")
	}
	dataset, err := evalgate.LoadDataset(config.DatasetPath)
	if err != nil {
		return err
	}
	runner, err := evalrunner.LoadReceipt(config.RunnerReceipt, dataset, build)
	if err != nil || runner.SHA256 != binding.RunnerReceiptSHA256 || runner.EvalRunSetID != binding.EvalRunSetID ||
		runner.Target.ProjectID != binding.ProjectID || runner.Target.SessionID != "" || runner.EndpointSHA256 != binding.EndpointSHA256 || !runner.TerminalAt.Equal(binding.RunnerTerminalAt) {
		return errors.New("offline runner receipt differs from the live journal")
	}
	return nil
}

func documentText(document store.MemoryDocument, data []byte) (string, error) {
	if document.ArtifactID != "" {
		var report core.ReportManifest
		if err := json.Unmarshal(data, &report); err != nil {
			return "", fmt.Errorf("decode adopted report %s: %w", document.ID, err)
		}
		text := strings.TrimSpace(report.AnswerMarkdown)
		if text == "" {
			return "", fmt.Errorf("adopted report %s contains no answer text", document.ID)
		}
		return text, nil
	}
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(document.MediaType, ";")[0]))
	if !strings.HasPrefix(mediaType, "text/") && mediaType != "application/json" && mediaType != "application/xml" {
		return "", fmt.Errorf("ready document %s has unsupported media type %q", document.ID, document.MediaType)
	}
	if !utf8.Valid(data) {
		return "", fmt.Errorf("ready document %s is not UTF-8", document.ID)
	}
	text := strings.TrimSpace(string(data))
	if text == "" {
		return "", fmt.Errorf("ready document %s contains no text", document.ID)
	}
	return text, nil
}

// BuildIsolatedReceipt intentionally does not call releasegate.Validate: the
// root release policy/dispatch is coordinated separately. This helper performs
// the complete typed contract validation for the isolated producer.
func BuildIsolatedReceipt(result FinalizeResult, build buildinfo.ProductBuildBinding, detailsPath, detailsSHA256 string) (releasegate.EvidenceReceipt, error) {
	if !strings.HasSuffix(strings.ToLower(filepath.Base(detailsPath)), ".details.json") || !validateDigest(detailsSHA256) {
		return releasegate.EvidenceReceipt{}, errors.New("details sibling name or digest is invalid")
	}
	subjects := make(map[string]string, len(result.SubjectHashes)+1)
	for name, digest := range result.SubjectHashes {
		if strings.TrimSpace(name) == "" || !validateDigest(digest) {
			return releasegate.EvidenceReceipt{}, errors.New("isolated receipt subject is invalid")
		}
		subjects[name] = digest
	}
	subjects["live-embeddings-shadow-details"] = detailsSHA256
	names := make([]string, 0, len(subjects))
	for name := range subjects {
		names = append(names, name)
	}
	sort.Strings(names)
	list := make([]releasegate.SubjectHash, 0, len(names))
	for _, name := range names {
		list = append(list, releasegate.SubjectHash{Name: name, SHA256: subjects[name]})
	}
	environmentDigest := sha256.Sum256([]byte("aetherops-live-embedding-environment-v1\x00" + result.Details.EndpointSHA256 + result.Details.ProjectID))
	receipt := releasegate.EvidenceReceipt{
		Schema: releasegate.EvidenceSchemaV1, GateID: "live_embeddings_shadow", EvidenceKind: releasegate.EvidenceLiveService,
		ReleaseCandidateID: result.Details.ReleaseCandidateID, ProductBuild: build,
		Producer:    releasegate.Producer{Name: ProducerName, Version: ProducerVersion},
		Environment: releasegate.Environment{Class: string(releasegate.EvidenceLiveService), OS: "windows-11", Architecture: "amd64", IdentitySHA256: hex.EncodeToString(environmentDigest[:])},
		ObservedAt:  result.Details.OfflineVerifiedAt, Status: "passed", SubjectHashes: list,
		DetailsPath: filepath.Base(detailsPath), DetailsSHA256: detailsSHA256,
	}
	if err := ValidateIsolatedReceipt(receipt, result.Details); err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	return receipt, nil
}

func ValidateIsolatedReceipt(receipt releasegate.EvidenceReceipt, details Details) error {
	if receipt.Schema != releasegate.EvidenceSchemaV1 || receipt.GateID != "live_embeddings_shadow" ||
		receipt.EvidenceKind != releasegate.EvidenceLiveService || receipt.Producer != (releasegate.Producer{Name: ProducerName, Version: ProducerVersion}) ||
		receipt.Status != "passed" || receipt.ReleaseCandidateID != details.ReleaseCandidateID || receipt.ObservedAt != details.OfflineVerifiedAt ||
		details.Schema != DetailsSchemaV1 || details.FixtureRole != "none" || !details.ReleaseGateEligible || !details.NoAmbiguousPOSTRetried ||
		details.CASObjectsVerified < 1 || details.CASObjectsVerified != details.DeterministicDocuments || details.SearchResultsReadBack < 1 ||
		!validateDigest(details.CASSourceSetSHA256) || details.DurableProof.ActiveIndexID != details.ObservedIndex.ID ||
		details.DurableProof.PreviousIndexID != details.Before.ActiveIndexID || details.DurableProof.DocumentCount != details.Documents.Count ||
		details.DurableProof.ChunkCount < 1 || details.DurableProof.VectorCount != details.DurableProof.ChunkCount {
		return errors.New("isolated live embeddings receipt/details contract is invalid")
	}
	if details.LedgerPreparedAt.IsZero() || details.LiveStartedAt.Before(details.LedgerPreparedAt) ||
		details.LiveFinishedAt.Before(details.LiveStartedAt) || details.OfflineVerifiedAt.Before(details.LiveFinishedAt) ||
		!validateDigest(details.PreparedLedgerSHA256) || !validateDigest(details.RunnerReceiptSHA256) ||
		!validateDigest(details.LiveJournalSHA256) || !validateDigest(details.QuerySHA256) {
		return errors.New("isolated live embeddings provenance or time bounds are invalid")
	}
	if err := validateReindexTransition(details.ProjectID, details.Before, details.ObservedIndex, details.After); err != nil {
		return err
	}
	if err := validateSearch(details.Search, details.ProjectID, details.QuerySHA256, details.ObservedIndex.ID, details.After.MemoryRevision); err != nil {
		return err
	}
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" || receipt.Environment.OS != "windows-11" || receipt.Environment.Architecture != "amd64" ||
		receipt.Environment.Class != string(releasegate.EvidenceLiveService) || !validateDigest(receipt.Environment.IdentitySHA256) {
		return errors.New("isolated live embeddings environment is invalid")
	}
	candidateID, err := releasegate.CandidateID(receipt.ProductBuild)
	if err != nil || candidateID != receipt.ReleaseCandidateID {
		return errors.New("isolated live embeddings candidate binding is invalid")
	}
	wantFixed := map[string]string{
		"aetherops.exe":                  receipt.ProductBuild.ExecutableSHA256,
		"runtime-manifest.json":          receipt.ProductBuild.RuntimeManifestSHA256,
		"knowledge-sidecar-tree":         receipt.ProductBuild.KnowledgeSidecarTreeSHA256,
		"prepared-ledger":                details.PreparedLedgerSHA256,
		"release-eval-runner-receipt":    details.RunnerReceiptSHA256,
		"live-embedding-journal":         details.LiveJournalSHA256,
		"vector-set":                     details.DurableProof.VectorSetSHA256,
		"live-embeddings-shadow-details": receipt.DetailsSHA256,
	}
	activeDigest := sha256.Sum256([]byte("aetherops-active-memory-index-v1\x00" + details.DurableProof.ActiveIndexID))
	previousDigest := sha256.Sum256([]byte("aetherops-previous-memory-index-v1\x00" + details.DurableProof.PreviousIndexID))
	queryDigest := sha256.Sum256([]byte("aetherops-memory-query-v1\x00" + details.QuerySHA256))
	searchDigest := sha256.Sum256([]byte("aetherops-memory-search-readback-v1\x00" + details.Search.SetSHA256))
	proofRaw, err := json.Marshal(details.DurableProof)
	if err != nil {
		return err
	}
	proofDigest := sha256.Sum256(proofRaw)
	wantFixed["active-memory-index"] = hex.EncodeToString(activeDigest[:])
	wantFixed["previous-memory-index"] = hex.EncodeToString(previousDigest[:])
	wantFixed["memory-query"] = hex.EncodeToString(queryDigest[:])
	wantFixed["search-readback"] = hex.EncodeToString(searchDigest[:])
	wantFixed["cas-source-set"] = details.CASSourceSetSHA256
	wantFixed["durable-memory-proof"] = hex.EncodeToString(proofDigest[:])
	required := map[string]struct{}{
		"aetherops.exe": {}, "runtime-manifest.json": {}, "knowledge-sidecar-tree": {}, "prepared-ledger": {},
		"release-eval-runner-receipt": {}, "live-embedding-journal": {}, "active-memory-index": {}, "previous-memory-index": {},
		"memory-query": {}, "search-readback": {}, "cas-source-set": {}, "vector-set": {}, "durable-memory-proof": {}, "live-embeddings-shadow-details": {},
	}
	seen := make(map[string]struct{}, len(receipt.SubjectHashes))
	for _, subject := range receipt.SubjectHashes {
		if _, ok := required[subject.Name]; !ok || !validateDigest(subject.SHA256) {
			return errors.New("isolated live embeddings subject set is invalid")
		}
		if _, duplicate := seen[subject.Name]; duplicate {
			return errors.New("isolated live embeddings subject is duplicated")
		}
		seen[subject.Name] = struct{}{}
		if want, fixed := wantFixed[subject.Name]; fixed && subject.SHA256 != want {
			return errors.New("isolated live embeddings subject differs from typed details")
		}
	}
	if len(seen) != len(required) {
		return errors.New("isolated live embeddings subject set is incomplete")
	}
	return nil
}
