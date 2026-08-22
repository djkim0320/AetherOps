package store

import (
	"encoding/json"
	"time"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
)

type Event struct {
	Sequence  int64           `json:"sequence"`
	RunID     string          `json:"run_id"`
	Kind      string          `json:"kind"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"created_at"`
}

type Artifact struct {
	ID             string    `json:"id"`
	RunID          string    `json:"run_id"`
	StageAttemptID string    `json:"stage_attempt_id"`
	Kind           string    `json:"kind"`
	BlobHash       string    `json:"blob_hash"`
	Adopted        bool      `json:"adopted"`
	CreatedAt      time.Time `json:"created_at"`
}

type Evidence struct {
	ID             string    `json:"id"`
	RunID          string    `json:"run_id"`
	StageAttemptID string    `json:"stage_attempt_id"`
	SourceURL      string    `json:"source_url"`
	Title          string    `json:"title"`
	Publisher      string    `json:"publisher,omitempty"`
	BlobHash       string    `json:"blob_hash"`
	CapturedAt     time.Time `json:"captured_at"`
	Adopted        bool      `json:"adopted"`
}

type StageExecutionReceipt struct {
	StageAttemptID          string                        `json:"stage_attempt_id"`
	RunID                   string                        `json:"run_id"`
	ResearchProfileVersion  string                        `json:"research_profile_version"`
	Model                   string                        `json:"model"`
	ReasoningEffort         string                        `json:"reasoning_effort"`
	ServiceTier             string                        `json:"service_tier"`
	CodexThreadID           string                        `json:"codex_thread_id"`
	CodexTurnID             string                        `json:"codex_turn_id"`
	InputSHA256             string                        `json:"input_sha256"`
	OutputSHA256            string                        `json:"output_sha256"`
	ExecutionContractSHA256 string                        `json:"execution_contract_sha256"`
	ProductBuild            buildinfo.ProductBuildBinding `json:"product_build"`
	CompletedAt             time.Time                     `json:"completed_at"`
}

type Document struct {
	ID                  string    `json:"id"`
	ProjectID           string    `json:"project_id"`
	ArtifactID          string    `json:"artifact_id,omitempty"`
	Title               string    `json:"title"`
	BlobHash            string    `json:"blob_hash"`
	Status              string    `json:"status"`
	EmbeddingModel      string    `json:"embedding_model"`
	EmbeddingDimensions int       `json:"embedding_dimensions"`
	Pinned              bool      `json:"pinned"`
	GraphAdopt          bool      `json:"graph_adopt"`
	CreatedAt           time.Time `json:"created_at"`
	UpdatedAt           time.Time `json:"updated_at"`
}

type BlobMetadata struct {
	Hash      string    `json:"hash"`
	Size      int64     `json:"size"`
	MediaType string    `json:"media_type"`
	CreatedAt time.Time `json:"created_at"`
}

type EmbeddingIndex struct {
	ID          string     `json:"id"`
	ProjectID   string     `json:"project_id"`
	Model       string     `json:"model"`
	Dimensions  int        `json:"dimensions"`
	State       string     `json:"state"`
	Error       string     `json:"error,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
}

type ProjectMemoryHead struct {
	ProjectID      string          `json:"project_id"`
	ActiveIndexID  string          `json:"active_index_id,omitempty"`
	ShadowIndexID  string          `json:"shadow_index_id,omitempty"`
	MemoryRevision int64           `json:"memory_revision"`
	State          string          `json:"state"`
	Error          string          `json:"error,omitempty"`
	UpdatedAt      time.Time       `json:"updated_at"`
	ActiveIndex    *EmbeddingIndex `json:"active_index,omitempty"`
	ShadowIndex    *EmbeddingIndex `json:"shadow_index,omitempty"`
}

type ShadowChunk struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}
