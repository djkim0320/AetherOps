// Package livee2econtract contains the cycle-free, typed contract shared by
// the live end-to-end evidence producer and release admission verifier.
package livee2econtract

import (
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
)

const (
	DetailsSchemaV2 = "aetherops_live_end_to_end_details_v2"
	ProducerName    = "cmd/livee2eevidence:offline-finalize"
	ProducerVersion = "2"
	ResearchPrompt  = "AetherOps 실제 종단 검증 연구를 수행하라. 인터넷 WebView2의 Chrome DevTools MCP로 공식 XFOIL 또는 공력 해석 관련 1차 자료를 직접 관찰하고 evidence_capture로 원문을 보존하라. COLLECT 단계에서 xfoil_polar를 NACA 0012, Reynolds 1000000, Mach 0.10, alpha -2도부터 4도까지 2도 간격으로 정확히 한 번 실행하고 그 영수증을 보고서 근거로 사용하라. 보고서와 KnowledgePatch는 실제 도구 결과와 캡처된 근거만 사용하며, 모든 불확실성을 명시하라."
	SPARQLQuery     = "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 1"
)

type Binding struct {
	ProductBuild                       buildinfo.ProductBuildBinding `json:"product_build"`
	ReleaseCandidateID                 string                        `json:"release_candidate_id"`
	PreparedLedgerSHA256               string                        `json:"prepared_ledger_sha256"`
	PreparedLedgerRevision             int                           `json:"prepared_ledger_revision"`
	LedgerPreparedAt                   time.Time                     `json:"ledger_prepared_at"`
	RunnerReceiptSHA256                string                        `json:"runner_receipt_sha256"`
	EvaluationSHA256                   string                        `json:"evaluation_sha256"`
	EvalRunSetID                       string                        `json:"eval_run_set_id"`
	DatasetSHA256                      string                        `json:"dataset_sha256"`
	RunnerEndpointSHA256               string                        `json:"runner_endpoint_sha256"`
	EvaluationVerifiedAt               time.Time                     `json:"evaluation_verified_at"`
	ObservationSessionDescriptorSHA256 string                        `json:"observation_session_descriptor_sha256"`
	ObservationEndpointSHA256          string                        `json:"observation_endpoint_sha256"`
	ObservationSessionStartedAt        time.Time                     `json:"observation_session_started_at"`
	ProjectID                          string                        `json:"project_id"`
	PromptSHA256                       string                        `json:"prompt_sha256"`
}

type BrowserObservation struct {
	Executed    bool      `json:"executed"`
	Compatible  bool      `json:"compatible"`
	Observation string    `json:"observation"`
	ObservedAt  time.Time `json:"observed_at"`
}

type RunObservation struct {
	RunID                 string    `json:"run_id"`
	ProjectID             string    `json:"project_id"`
	ConversationSessionID string    `json:"conversation_session_id"`
	ReportArtifactID      string    `json:"report_artifact_id"`
	Status                string    `json:"status"`
	Revision              int64     `json:"revision"`
	CreatedAt             time.Time `json:"created_at"`
	TerminalAt            time.Time `json:"terminal_at"`
}

type SPARQLObservation struct {
	GenerationID  string `json:"generation_id"`
	QuerySHA256   string `json:"query_sha256"`
	ResultSHA256  string `json:"result_sha256"`
	QueryForm     string `json:"query_form"`
	Complete      bool   `json:"complete"`
	ResponseBytes int    `json:"response_bytes"`
}

type CurationObservation struct {
	EventID        string `json:"event_id"`
	Sequence       int64  `json:"sequence"`
	GenerationID   string `json:"generation_id"`
	Kind           string `json:"kind"`
	PayloadSHA256  string `json:"payload_sha256"`
	EventSHA256    string `json:"event_sha256"`
	MemoBlobSHA256 string `json:"memo_blob_sha256"`
	EntityID       string `json:"entity_id"`
}

type StageProof struct {
	StageAttemptID          string    `json:"stage_attempt_id"`
	Stage                   string    `json:"stage"`
	Ordinal                 int       `json:"ordinal"`
	WorkstreamID            string    `json:"workstream_id,omitempty"`
	Model                   string    `json:"model"`
	ReasoningEffort         string    `json:"reasoning_effort"`
	ServiceTier             string    `json:"service_tier"`
	CodexThreadID           string    `json:"codex_thread_id"`
	CodexTurnID             string    `json:"codex_turn_id"`
	InputSHA256             string    `json:"input_sha256"`
	OutputSHA256            string    `json:"output_sha256"`
	ExecutionContractSHA256 string    `json:"execution_contract_sha256"`
	CompletedAt             time.Time `json:"completed_at"`
}

type MCPEvidenceProof struct {
	EvidenceID     string    `json:"evidence_id"`
	StageAttemptID string    `json:"stage_attempt_id"`
	BlobSHA256     string    `json:"blob_sha256"`
	Size           int64     `json:"size"`
	CapturedAt     time.Time `json:"captured_at"`
	InternalMCP    bool      `json:"internal_mcp"`
}

type SolverProof struct {
	JobID                            string    `json:"job_id"`
	StageAttemptID                   string    `json:"stage_attempt_id"`
	Operation                        string    `json:"operation"`
	Component                        string    `json:"component"`
	Version                          string    `json:"version"`
	SpecSHA256                       string    `json:"spec_sha256"`
	RuntimeBundleSHA256              string    `json:"runtime_bundle_sha256"`
	PhysicalArgumentsSHA256          string    `json:"physical_arguments_sha256"`
	ExecutionPurpose                 string    `json:"execution_purpose,omitempty"`
	VerificationOfJobID              string    `json:"verification_of_job_id,omitempty"`
	VerificationSourceStageAttemptID string    `json:"verification_source_stage_attempt_id,omitempty"`
	VerificationSourceRuntimeSHA256  string    `json:"verification_source_runtime_bundle_sha256,omitempty"`
	VerificationSourceComponent      string    `json:"verification_source_component,omitempty"`
	VerificationSourceVersion        string    `json:"verification_source_version,omitempty"`
	VerificationSourceSpecSHA256     string    `json:"verification_source_spec_sha256,omitempty"`
	VerificationSourcePhysicalSHA256 string    `json:"verification_source_physical_arguments_sha256,omitempty"`
	VerificationSourceReceiptID      string    `json:"verification_source_receipt_artifact_id,omitempty"`
	VerificationSourceReceiptSHA256  string    `json:"verification_source_receipt_blob_sha256,omitempty"`
	ReceiptArtifactID                string    `json:"receipt_artifact_id"`
	ReceiptBlobSHA256                string    `json:"receipt_blob_sha256"`
	ArtifactSetSHA256                string    `json:"artifact_set_sha256"`
	Threads                          int       `json:"threads"`
	Executed                         bool      `json:"executed"`
	NumericallyValid                 bool      `json:"numerically_valid"`
	CompletedAt                      time.Time `json:"completed_at"`
}

type GraphProof struct {
	GenerationID       string `json:"generation_id"`
	SnapshotSHA256     string `json:"snapshot_sha256"`
	CanonicalSHA256    string `json:"canonical_sha256"`
	TripleCount        int    `json:"triple_count"`
	SPARQLResultSHA256 string `json:"sparql_result_sha256"`
}

type Details struct {
	Schema                    string              `json:"schema"`
	Binding                   Binding             `json:"binding"`
	LiveJournalSHA256         string              `json:"live_journal_sha256"`
	LiveStartedAt             time.Time           `json:"live_started_at"`
	LiveFinishedAt            time.Time           `json:"live_finished_at"`
	OfflineVerifiedAt         time.Time           `json:"offline_verified_at"`
	Browser                   BrowserObservation  `json:"browser"`
	Run                       RunObservation      `json:"run"`
	Stages                    []StageProof        `json:"stages"`
	MCPEvidence               []MCPEvidenceProof  `json:"mcp_evidence"`
	Solver                    SolverProof         `json:"solver"`
	CASObjectsVerified        int                 `json:"cas_objects_verified"`
	CASReadbackSetSHA256      string              `json:"cas_readback_set_sha256"`
	SPARQL                    SPARQLObservation   `json:"sparql"`
	Graph                     GraphProof          `json:"graph"`
	Curation                  CurationObservation `json:"curation"`
	EvaluationRequiredCases   int                 `json:"evaluation_required_cases"`
	EvaluationObservedPasses  int                 `json:"evaluation_observed_passes"`
	FixtureRole               string              `json:"fixture_role"`
	ReleaseGateEligible       bool                `json:"release_gate_eligible"`
	NoAmbiguousWritesReplayed bool                `json:"no_ambiguous_writes_replayed"`
}
