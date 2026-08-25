package liveembeddingsevidence

import (
	"errors"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"github.com/djkim0320/AetherOps/internal/releasegate"
	"github.com/djkim0320/AetherOps/internal/store"
)

const (
	JournalSchemaV1 = "aetherops_live_embeddings_shadow_journal_v1"
	DetailsSchemaV1 = "aetherops_live_embeddings_shadow_details_v1"
	ProducerName    = "cmd/liveembeddingsevidence:offline-finalize"
	ProducerVersion = "1"
)

type JournalState string

const (
	StatePrepared          JournalState = "PREPARED"
	StateReindexSubmitting JournalState = "REINDEX_SUBMITTING"
	StateReindexAmbiguous  JournalState = "REINDEX_AMBIGUOUS"
	StateReindexFailed     JournalState = "REINDEX_FAILED"
	StateReindexObserved   JournalState = "REINDEX_OBSERVED"
	StateSearchSubmitting  JournalState = "SEARCH_SUBMITTING"
	StateSearchAmbiguous   JournalState = "SEARCH_AMBIGUOUS"
	StateSearchFailed      JournalState = "SEARCH_FAILED"
	StateLiveComplete      JournalState = "LIVE_COMPLETE"
)

type Binding struct {
	ProductBuild           buildinfo.ProductBuildBinding `json:"product_build"`
	ReleaseCandidateID     string                        `json:"release_candidate_id"`
	PreparedLedgerSHA256   string                        `json:"prepared_ledger_sha256"`
	PreparedLedgerRevision int                           `json:"prepared_ledger_revision"`
	LedgerPreparedAt       time.Time                     `json:"ledger_prepared_at"`
	RunnerReceiptSHA256    string                        `json:"runner_receipt_sha256"`
	EvalRunSetID           string                        `json:"eval_run_set_id"`
	ProjectID              string                        `json:"project_id"`
	EndpointSHA256         string                        `json:"endpoint_sha256"`
	QuerySHA256            string                        `json:"query_sha256"`
	SessionStartedAt       time.Time                     `json:"session_started_at"`
	RunnerTerminalAt       time.Time                     `json:"runner_terminal_at"`
}

type DocumentObservation struct {
	Count     int    `json:"count"`
	SetSHA256 string `json:"set_sha256"`
}

type SearchResultObservation struct {
	ChunkID    string  `json:"chunk_id"`
	DocumentID string  `json:"document_id"`
	TextSHA256 string  `json:"text_sha256"`
	Score      float64 `json:"score"`
}

type SearchObservation struct {
	QuerySHA256 string                    `json:"query_sha256"`
	Memory      store.ProjectMemoryHead   `json:"memory"`
	Results     []SearchResultObservation `json:"results"`
	SetSHA256   string                    `json:"set_sha256"`
}

type JournalRecord struct {
	Schema               string                   `json:"schema"`
	JournalID            string                   `json:"journal_id"`
	Sequence             int                      `json:"sequence"`
	PreviousRecordSHA256 string                   `json:"previous_record_sha256,omitempty"`
	State                JournalState             `json:"state"`
	WrittenAt            time.Time                `json:"written_at"`
	Binding              *Binding                 `json:"binding,omitempty"`
	Documents            *DocumentObservation     `json:"documents,omitempty"`
	Before               *store.ProjectMemoryHead `json:"before,omitempty"`
	Index                *store.EmbeddingIndex    `json:"index,omitempty"`
	After                *store.ProjectMemoryHead `json:"after,omitempty"`
	Search               *SearchObservation       `json:"search,omitempty"`
	FailureCode          string                   `json:"failure_code,omitempty"`
	RecordSHA256         string                   `json:"-"`
}

type LiveObservation struct {
	Binding        Binding
	Documents      DocumentObservation
	Before         store.ProjectMemoryHead
	Index          store.EmbeddingIndex
	After          store.ProjectMemoryHead
	Search         SearchObservation
	JournalSHA256  string
	LiveStartedAt  time.Time
	LiveFinishedAt time.Time
}

type Details struct {
	Schema                 string                         `json:"schema"`
	ReleaseCandidateID     string                         `json:"release_candidate_id"`
	PreparedLedgerSHA256   string                         `json:"prepared_ledger_sha256"`
	PreparedLedgerRevision int                            `json:"prepared_ledger_revision"`
	LedgerPreparedAt       time.Time                      `json:"ledger_prepared_at"`
	RunnerReceiptSHA256    string                         `json:"runner_receipt_sha256"`
	EvalRunSetID           string                         `json:"eval_run_set_id"`
	ProjectID              string                         `json:"project_id"`
	EndpointSHA256         string                         `json:"endpoint_sha256"`
	QuerySHA256            string                         `json:"query_sha256"`
	LiveJournalSHA256      string                         `json:"live_journal_sha256"`
	LiveStartedAt          time.Time                      `json:"live_started_at"`
	LiveFinishedAt         time.Time                      `json:"live_finished_at"`
	OfflineVerifiedAt      time.Time                      `json:"offline_verified_at"`
	Documents              DocumentObservation            `json:"documents"`
	Before                 store.ProjectMemoryHead        `json:"before"`
	ObservedIndex          store.EmbeddingIndex           `json:"observed_index"`
	After                  store.ProjectMemoryHead        `json:"after"`
	Search                 SearchObservation              `json:"search"`
	DurableProof           store.MemoryShadowReleaseProof `json:"durable_proof"`
	CASSourceSetSHA256     string                         `json:"cas_source_set_sha256"`
	CASObjectsVerified     int                            `json:"cas_objects_verified"`
	DeterministicDocuments int                            `json:"deterministic_documents_verified"`
	SearchResultsReadBack  int                            `json:"search_results_read_back"`
	FixtureRole            string                         `json:"fixture_role"`
	ReleaseGateEligible    bool                           `json:"release_gate_eligible"`
	NoAmbiguousPOSTRetried bool                           `json:"no_ambiguous_post_retried"`
}

type FinalizeResult struct {
	Details       Details
	Receipt       releasegate.EvidenceReceipt
	SubjectHashes map[string]string
}

var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func validateDigest(value string) bool { return digestPattern.MatchString(value) }

func validateSearch(observation SearchObservation, projectID, querySHA, activeIndexID string, revision int64) error {
	if observation.QuerySHA256 != querySHA || !validateDigest(observation.SetSHA256) || len(observation.Results) < 1 || len(observation.Results) > 12 ||
		observation.Memory.ProjectID != projectID || observation.Memory.ActiveIndexID != activeIndexID || observation.Memory.MemoryRevision != revision ||
		observation.Memory.State != "ready" || observation.Memory.ShadowIndexID != "" {
		return errors.New("search observation is not bound to the exact active memory revision")
	}
	seen := make(map[string]struct{}, len(observation.Results))
	for _, result := range observation.Results {
		if strings.TrimSpace(result.ChunkID) == "" || strings.TrimSpace(result.DocumentID) == "" ||
			!validateDigest(result.TextSHA256) || math.IsNaN(result.Score) || math.IsInf(result.Score, 0) {
			return errors.New("search observation result is invalid")
		}
		if _, duplicate := seen[result.ChunkID]; duplicate {
			return errors.New("search observation duplicates a chunk")
		}
		seen[result.ChunkID] = struct{}{}
	}
	return nil
}
