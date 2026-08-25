package releasegate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/rag"
	"github.com/djkim0320/AetherOps/internal/store"
)

const (
	liveEmbeddingsDetailsSchemaV1 = "aetherops_live_embeddings_shadow_details_v1"
	liveEmbeddingsProducerName    = "cmd/liveembeddingsevidence:offline-finalize"
	liveEmbeddingsProducerVersion = "1"
	liveEmbeddingsEnvironmentV1   = "aetherops-live-embedding-environment-v1\x00"
)

type liveEmbeddingDocumentObservation struct {
	Count     int    `json:"count"`
	SetSHA256 string `json:"set_sha256"`
}

type liveEmbeddingSearchResult struct {
	ChunkID    string  `json:"chunk_id"`
	DocumentID string  `json:"document_id"`
	TextSHA256 string  `json:"text_sha256"`
	Score      float64 `json:"score"`
}

type liveEmbeddingSearchObservation struct {
	QuerySHA256 string                      `json:"query_sha256"`
	Memory      store.ProjectMemoryHead     `json:"memory"`
	Results     []liveEmbeddingSearchResult `json:"results"`
	SetSHA256   string                      `json:"set_sha256"`
}

type liveEmbeddingsDetails struct {
	Schema                 string                           `json:"schema"`
	ReleaseCandidateID     string                           `json:"release_candidate_id"`
	PreparedLedgerSHA256   string                           `json:"prepared_ledger_sha256"`
	PreparedLedgerRevision int                              `json:"prepared_ledger_revision"`
	LedgerPreparedAt       time.Time                        `json:"ledger_prepared_at"`
	RunnerReceiptSHA256    string                           `json:"runner_receipt_sha256"`
	EvalRunSetID           string                           `json:"eval_run_set_id"`
	ProjectID              string                           `json:"project_id"`
	EndpointSHA256         string                           `json:"endpoint_sha256"`
	QuerySHA256            string                           `json:"query_sha256"`
	LiveJournalSHA256      string                           `json:"live_journal_sha256"`
	LiveStartedAt          time.Time                        `json:"live_started_at"`
	LiveFinishedAt         time.Time                        `json:"live_finished_at"`
	OfflineVerifiedAt      time.Time                        `json:"offline_verified_at"`
	Documents              liveEmbeddingDocumentObservation `json:"documents"`
	Before                 store.ProjectMemoryHead          `json:"before"`
	ObservedIndex          store.EmbeddingIndex             `json:"observed_index"`
	After                  store.ProjectMemoryHead          `json:"after"`
	Search                 liveEmbeddingSearchObservation   `json:"search"`
	DurableProof           store.MemoryShadowReleaseProof   `json:"durable_proof"`
	CASSourceSetSHA256     string                           `json:"cas_source_set_sha256"`
	CASObjectsVerified     int                              `json:"cas_objects_verified"`
	DeterministicDocuments int                              `json:"deterministic_documents_verified"`
	SearchResultsReadBack  int                              `json:"search_results_read_back"`
	FixtureRole            string                           `json:"fixture_role"`
	ReleaseGateEligible    bool                             `json:"release_gate_eligible"`
	NoAmbiguousPOSTRetried bool                             `json:"no_ambiguous_post_retried"`
}

// ValidateLiveEmbeddingsShadowEvidenceForLedger validates the separately
// produced two-phase live observation against its immediate ledger
// predecessor. It intentionally does not trust a producer-supplied verdict.
func ValidateLiveEmbeddingsShadowEvidenceForLedger(raw []byte, receipt EvidenceReceipt, preparedRevision int, preparedAt time.Time) error {
	if receipt.Schema != EvidenceSchemaV1 || receipt.GateID != "live_embeddings_shadow" ||
		receipt.EvidenceKind != EvidenceLiveService || receipt.Producer != (Producer{Name: liveEmbeddingsProducerName, Version: liveEmbeddingsProducerVersion}) ||
		receipt.Status != "passed" || receipt.ObservedAt.IsZero() {
		return errors.New("live embeddings evidence outer identity or producer is invalid")
	}
	if err := receipt.ProductBuild.Validate(); err != nil {
		return err
	}
	candidateID, err := CandidateID(receipt.ProductBuild)
	if err != nil || candidateID != receipt.ReleaseCandidateID {
		return errors.New("live embeddings candidate binding is invalid")
	}
	if _, err := secureDetailsName(receipt.DetailsPath); err != nil || !validDigest(receipt.DetailsSHA256) {
		return errors.New("live embeddings details sibling is invalid")
	}
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:]) != receipt.DetailsSHA256 {
		return errors.New("live embeddings details hash does not match its typed body")
	}
	var details liveEmbeddingsDetails
	if err := decodeStrict(raw, &details); err != nil {
		return fmt.Errorf("decode live embeddings details: %w", err)
	}
	if err := validateLiveEmbeddingsDetails(details, receipt, preparedRevision, preparedAt); err != nil {
		return err
	}
	return validateLiveEmbeddingsSubjects(details, receipt)
}

func validateLiveEmbeddingsDetails(details liveEmbeddingsDetails, receipt EvidenceReceipt, preparedRevision int, preparedAt time.Time) error {
	if details.Schema != liveEmbeddingsDetailsSchemaV1 || details.ReleaseCandidateID != receipt.ReleaseCandidateID ||
		details.PreparedLedgerRevision < 1 || strings.TrimSpace(details.EvalRunSetID) == "" || details.EvalRunSetID != strings.TrimSpace(details.EvalRunSetID) ||
		strings.TrimSpace(details.ProjectID) == "" || details.ProjectID != strings.TrimSpace(details.ProjectID) ||
		!validDigest(details.PreparedLedgerSHA256) || !validDigest(details.RunnerReceiptSHA256) || !validDigest(details.EndpointSHA256) ||
		!validDigest(details.QuerySHA256) || !validDigest(details.LiveJournalSHA256) || !validDigest(details.CASSourceSetSHA256) ||
		details.FixtureRole != "none" || !details.ReleaseGateEligible || !details.NoAmbiguousPOSTRetried {
		return errors.New("live embeddings details identity, provenance, or eligibility is invalid")
	}
	if preparedRevision > 0 && details.PreparedLedgerRevision != preparedRevision {
		return errors.New("live embeddings ledger revision does not match its immediate attachment predecessor")
	}
	if !preparedAt.IsZero() && !details.LedgerPreparedAt.Equal(preparedAt) {
		return errors.New("live embeddings ledger timestamp does not match its attachment chain")
	}
	if details.LedgerPreparedAt.IsZero() || details.LiveStartedAt.Before(details.LedgerPreparedAt) ||
		details.LiveFinishedAt.Before(details.LiveStartedAt) || details.OfflineVerifiedAt.Before(details.LiveFinishedAt) ||
		!details.OfflineVerifiedAt.Equal(receipt.ObservedAt) {
		return errors.New("live embeddings observation window is invalid")
	}
	if details.Documents.Count < 1 || !validDigest(details.Documents.SetSHA256) ||
		details.CASObjectsVerified != details.Documents.Count || details.DeterministicDocuments != details.Documents.Count ||
		details.SearchResultsReadBack != len(details.Search.Results) || details.SearchResultsReadBack < 1 {
		return errors.New("live embeddings durable source/readback counts are invalid")
	}
	if err := validateLiveEmbeddingTransition(details); err != nil {
		return err
	}
	if err := validateLiveEmbeddingSearch(details.Search, details.ProjectID, details.QuerySHA256, details.ObservedIndex.ID, details.After.MemoryRevision); err != nil {
		return err
	}
	proof := details.DurableProof
	if proof.ProjectID != details.ProjectID || proof.PreviousIndexID != details.Before.ActiveIndexID ||
		proof.ActiveIndexID != details.ObservedIndex.ID || proof.MemoryRevision != details.After.MemoryRevision ||
		proof.DocumentCount != details.Documents.Count || proof.ChunkCount < 1 || proof.VectorCount != proof.ChunkCount ||
		!validDigest(proof.SourceSetSHA256) || !validDigest(proof.VectorSetSHA256) {
		return errors.New("live embeddings durable SQLite/vector proof is invalid")
	}
	environmentDigest := sha256.Sum256([]byte(liveEmbeddingsEnvironmentV1 + details.EndpointSHA256 + details.ProjectID))
	if receipt.Environment != (Environment{
		Class: string(EvidenceLiveService), OS: "windows-11", Architecture: "amd64", IdentitySHA256: hex.EncodeToString(environmentDigest[:]),
	}) {
		return errors.New("live embeddings environment identity is invalid")
	}
	return nil
}

func validateLiveEmbeddingTransition(details liveEmbeddingsDetails) error {
	before, index, after := details.Before, details.ObservedIndex, details.After
	if before.ProjectID != details.ProjectID || before.State != "ready" || before.Error != "" || before.ActiveIndexID == "" ||
		before.ShadowIndexID != "" || before.ActiveIndex == nil || before.ActiveIndex.ID != before.ActiveIndexID ||
		before.ActiveIndex.ProjectID != details.ProjectID || before.ActiveIndex.State != "active" ||
		before.ActiveIndex.Model != rag.EmbeddingModel || before.ActiveIndex.Dimensions != rag.EmbeddingDimensions ||
		index.ProjectID != details.ProjectID || index.ID == "" || index.ID == before.ActiveIndexID || index.State != "active" || index.Error != "" ||
		index.Model != rag.EmbeddingModel || index.Dimensions != rag.EmbeddingDimensions || index.CompletedAt == nil ||
		after.ProjectID != details.ProjectID || after.ActiveIndexID != index.ID || after.MemoryRevision != before.MemoryRevision+1 ||
		after.State != "ready" || after.Error != "" || after.ShadowIndexID != "" || after.ActiveIndex == nil || !reflect.DeepEqual(*after.ActiveIndex, index) {
		return errors.New("live embeddings reindex is not one exact non-noop ready shadow transition")
	}
	return nil
}

func validateLiveEmbeddingSearch(observation liveEmbeddingSearchObservation, projectID, querySHA, activeIndexID string, revision int64) error {
	if observation.QuerySHA256 != querySHA || !validDigest(observation.SetSHA256) || len(observation.Results) < 1 || len(observation.Results) > 12 ||
		observation.Memory.ProjectID != projectID || observation.Memory.ActiveIndexID != activeIndexID || observation.Memory.MemoryRevision != revision ||
		observation.Memory.State != "ready" || observation.Memory.Error != "" || observation.Memory.ShadowIndexID != "" {
		return errors.New("live embeddings search is not bound to the exact active memory revision")
	}
	seen := make(map[string]struct{}, len(observation.Results))
	for _, result := range observation.Results {
		if strings.TrimSpace(result.ChunkID) == "" || result.ChunkID != strings.TrimSpace(result.ChunkID) ||
			strings.TrimSpace(result.DocumentID) == "" || result.DocumentID != strings.TrimSpace(result.DocumentID) ||
			!validDigest(result.TextSHA256) || math.IsNaN(result.Score) || math.IsInf(result.Score, 0) {
			return errors.New("live embeddings search result is invalid")
		}
		if _, duplicate := seen[result.ChunkID]; duplicate {
			return errors.New("live embeddings search duplicates a chunk")
		}
		seen[result.ChunkID] = struct{}{}
	}
	raw, err := json.Marshal(observation.Results)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(raw)
	if observation.SetSHA256 != hex.EncodeToString(digest[:]) {
		return errors.New("live embeddings search result-set hash is invalid")
	}
	return nil
}

func validateLiveEmbeddingsSubjects(details liveEmbeddingsDetails, receipt EvidenceReceipt) error {
	activeDigest := sha256.Sum256([]byte("aetherops-active-memory-index-v1\x00" + details.DurableProof.ActiveIndexID))
	previousDigest := sha256.Sum256([]byte("aetherops-previous-memory-index-v1\x00" + details.DurableProof.PreviousIndexID))
	queryDigest := sha256.Sum256([]byte("aetherops-memory-query-v1\x00" + details.QuerySHA256))
	searchDigest := sha256.Sum256([]byte("aetherops-memory-search-readback-v1\x00" + details.Search.SetSHA256))
	proofRaw, err := json.Marshal(details.DurableProof)
	if err != nil {
		return err
	}
	proofDigest := sha256.Sum256(proofRaw)
	want := map[string]string{
		"aetherops.exe":                  receipt.ProductBuild.ExecutableSHA256,
		"runtime-manifest.json":          receipt.ProductBuild.RuntimeManifestSHA256,
		"knowledge-sidecar-tree":         receipt.ProductBuild.KnowledgeSidecarTreeSHA256,
		"prepared-ledger":                details.PreparedLedgerSHA256,
		"release-eval-runner-receipt":    details.RunnerReceiptSHA256,
		"live-embedding-journal":         details.LiveJournalSHA256,
		"active-memory-index":            hex.EncodeToString(activeDigest[:]),
		"previous-memory-index":          hex.EncodeToString(previousDigest[:]),
		"memory-query":                   hex.EncodeToString(queryDigest[:]),
		"search-readback":                hex.EncodeToString(searchDigest[:]),
		"cas-source-set":                 details.CASSourceSetSHA256,
		"vector-set":                     details.DurableProof.VectorSetSHA256,
		"durable-memory-proof":           hex.EncodeToString(proofDigest[:]),
		"live-embeddings-shadow-details": receipt.DetailsSHA256,
	}
	subjects, err := receiptSubjectMap(receipt)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(subjects, want) {
		return errors.New("live embeddings subject set is incomplete, excessive, or mismatched")
	}
	return nil
}
