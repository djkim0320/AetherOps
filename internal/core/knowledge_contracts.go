package core

import (
	"encoding/json"
	"time"
)

// KnowledgeGeneration is the transport contract for an immutable shadow
// projection. Persistence-specific transition checks remain in store.
type KnowledgeGeneration struct {
	ProjectID      string     `json:"project_id"`
	ID             string     `json:"id"`
	OntologyID     string     `json:"ontology_id"`
	ContractSHA256 string     `json:"contract_sha256"`
	ManifestSHA256 string     `json:"manifest_sha256,omitempty"`
	State          string     `json:"state"`
	SourceCount    int        `json:"source_count"`
	EntityCount    int        `json:"entity_count"`
	AssertionCount int        `json:"assertion_count"`
	Error          string     `json:"error,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	ValidatingAt   *time.Time `json:"validating_at,omitempty"`
	ReadyAt        *time.Time `json:"ready_at,omitempty"`
	RetiredAt      *time.Time `json:"retired_at,omitempty"`
	FailedAt       *time.Time `json:"failed_at,omitempty"`
}

type OntologyVersion struct {
	ID              string     `json:"id"`
	ProjectID       string     `json:"project_id,omitempty"`
	SemanticVersion string     `json:"semantic_version"`
	SourceBlobHash  string     `json:"source_blob_hash,omitempty"`
	CanonicalHash   string     `json:"canonical_sha256"`
	TripleCount     int        `json:"triple_count"`
	State           string     `json:"state"`
	CreatedAt       time.Time  `json:"created_at"`
	ActivatedAt     *time.Time `json:"activated_at,omitempty"`
	RetiredAt       *time.Time `json:"retired_at,omitempty"`
}

type OntologyTerm struct {
	OntologyID  string `json:"ontology_id"`
	Key         string `json:"key"`
	IRI         string `json:"iri"`
	Kind        string `json:"kind"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	DomainKey   string `json:"domain_key,omitempty"`
	RangeKey    string `json:"range_key,omitempty"`
	ValueKind   string `json:"value_kind,omitempty"`
	Functional  bool   `json:"functional"`
	Temporal    bool   `json:"temporal"`
	Expandable  bool   `json:"expandable"`
}

// CurationEvent is append-only and hash-chained. Payload is the submitted
// KnowledgeEditPatch after memo text has been replaced by its CAS handle.
type CurationEvent struct {
	Sequence            int64           `json:"sequence"`
	ID                  string          `json:"id"`
	ProjectID           string          `json:"project_id"`
	GenerationID        string          `json:"generation_id"`
	Kind                string          `json:"kind"`
	Actor               string          `json:"actor"`
	Payload             json.RawMessage `json:"payload"`
	PayloadSHA256       string          `json:"payload_sha256"`
	PreviousEventSHA256 string          `json:"previous_event_sha256,omitempty"`
	EventSHA256         string          `json:"event_sha256"`
	CreatedAt           time.Time       `json:"created_at"`
}

type KnowledgeSubgraph struct {
	Nodes      []map[string]any `json:"nodes"`
	Edges      []map[string]any `json:"edges"`
	TotalNodes int              `json:"total_nodes"`
	TotalEdges int              `json:"total_edges"`
	Truncated  bool             `json:"truncated"`
}

type SPARQLRequest struct {
	ProjectID string `json:"project_id"`
	Query     string `json:"query"`
	MaxRows   int    `json:"max_rows"`
}

// SPARQLResult keeps the complete local sidecar result without pretending
// every allowed query form (SELECT/ASK/CONSTRUCT/DESCRIBE) has one row shape.
type SPARQLResult struct {
	QueryForm string          `json:"query_form"`
	Complete  bool            `json:"complete"`
	Result    json.RawMessage `json:"result"`
}
