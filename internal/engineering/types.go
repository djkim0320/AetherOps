package engineering

import (
	"encoding/json"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
)

const receiptSchema = 1

type Capability struct {
	Name       string `json:"name"`
	Version    string `json:"version"`
	Executable string `json:"executable"`
	SHA256     string `json:"sha256"`
	Ready      bool   `json:"ready"`
	Detail     string `json:"detail,omitempty"`
}

type ArtifactResult struct {
	ArtifactID string `json:"artifact_id"`
	Role       string `json:"role"`
	FileName   string `json:"file_name"`
	MediaType  string `json:"media_type"`
	SHA256     string `json:"cas_blob_sha256"`
	Size       int64  `json:"size"`
}

// EvidenceHandle is a complete, copy-only locator for one exact value in the
// immutable execution-receipt CAS object. The value hash is calculated by the
// core with the same JSON-number preservation used by knowledge validation;
// models must never calculate or synthesize it.
type EvidenceHandle struct {
	Kind         string `json:"kind"`
	ArtifactHash string `json:"artifact_hash"`
	JSONPointer  string `json:"json_pointer"`
	ValueHash    string `json:"value_hash"`
}

type JobResult struct {
	JobID             string `json:"job_id"`
	Operation         string `json:"operation"`
	SpecSHA256        string `json:"spec_sha256"`
	ReceiptArtifactID string `json:"receipt_artifact_id"`
	// Arguments is the exact canonical JSON object that was approved and used
	// for the job. Readback exposes it so an isolated verification attempt can
	// reproduce the physical inputs without relying on model memory.
	Arguments        json.RawMessage `json:"arguments"`
	Status           string          `json:"status"`
	Executed         bool            `json:"executed"`
	ReusedResult     bool            `json:"reused_result"`
	NumericallyValid bool            `json:"numerically_valid"`
	// Metrics is the complete CAS-verified internal receipt value used by
	// deterministic validators. It is intentionally excluded from MCP JSON
	// because solver series can exceed a model response window.
	Metrics map[string]any `json:"-"`
	// SummaryMetrics contains only the operation's versioned scalar allowlist.
	SummaryMetrics map[string]any   `json:"summary_metrics"`
	Artifacts      []ArtifactResult `json:"artifacts"`
	// Provenance is retained for trusted in-process validation. Model-facing
	// JSON uses ReceiptArtifactID plus CAS-derived evidence handles instead.
	Provenance      core.EvidenceSource `json:"-"`
	EvidenceHandles []EvidenceHandle    `json:"evidence_handles"`
}

const (
	XFOILPurposeScreening               = "screening"
	XFOILPurposeIndependentVerification = "independent_verification"
	XFOILObjectiveMinimizeCDAtTargetCL  = "minimize_cd_at_target_cl"
)

type executableReceipt struct {
	Component string   `json:"component"`
	Version   string   `json:"version"`
	SHA256    string   `json:"sha256"`
	Argv      []string `json:"argv"`
}

type executionReceipt struct {
	Schema           int                 `json:"schema"`
	JobID            string              `json:"job_id"`
	RunID            string              `json:"run_id"`
	StageAttemptID   string              `json:"stage_attempt_id"`
	Operation        string              `json:"operation"`
	Spec             json.RawMessage     `json:"spec"`
	SpecSHA256       string              `json:"spec_sha256"`
	Executables      []executableReceipt `json:"executables"`
	Threads          int                 `json:"threads"`
	StartedAt        time.Time           `json:"started_at"`
	CompletedAt      time.Time           `json:"completed_at"`
	ExitCodes        []int               `json:"exit_codes"`
	Executed         bool                `json:"executed"`
	NumericallyValid bool                `json:"numerically_valid"`
	Metrics          map[string]any      `json:"metrics"`
	Artifacts        []ArtifactResult    `json:"artifacts"`
}

type WingSpec struct {
	RunID          string  `json:"run_id"`
	StageAttemptID string  `json:"stage_attempt_id"`
	SemiSpanM      float64 `json:"semi_span_m"`
	RootChordM     float64 `json:"root_chord_m"`
	TaperRatio     float64 `json:"taper_ratio"`
	SweepDeg       float64 `json:"sweep_deg"`
	Mach           float64 `json:"mach"`
	AlphaStartDeg  float64 `json:"alpha_start_deg"`
	AlphaEndDeg    float64 `json:"alpha_end_deg"`
	AlphaPoints    int     `json:"alpha_points"`
}

type ModifyWingSpec struct {
	RunID            string  `json:"run_id"`
	StageAttemptID   string  `json:"stage_attempt_id"`
	SourceArtifactID string  `json:"source_artifact_id"`
	NewSweepDeg      float64 `json:"new_sweep_deg"`
}

type MeshSpec struct {
	RunID          string  `json:"run_id"`
	StageAttemptID string  `json:"stage_attempt_id"`
	SemiSpanM      float64 `json:"semi_span_m"`
	RootChordM     float64 `json:"root_chord_m"`
	TaperRatio     float64 `json:"taper_ratio"`
	SweepDeg       float64 `json:"sweep_deg"`
	MeshSizeM      float64 `json:"mesh_size_m"`
}

type XFOILSpec struct {
	RunID                 string   `json:"run_id"`
	StageAttemptID        string   `json:"stage_attempt_id"`
	NACA                  string   `json:"naca"`
	Reynolds              float64  `json:"reynolds"`
	Mach                  float64  `json:"mach"`
	AlphaStartDeg         float64  `json:"alpha_start_deg"`
	AlphaEndDeg           float64  `json:"alpha_end_deg"`
	AlphaStepDeg          float64  `json:"alpha_step_deg"`
	ExecutionPurpose      string   `json:"execution_purpose,omitempty"`
	VerificationOfJobID   string   `json:"verification_of_job_id,omitempty"`
	OptimizationObjective string   `json:"optimization_objective,omitempty"`
	TargetCL              *float64 `json:"target_cl,omitempty"`
	MinimumCM             *float64 `json:"minimum_cm,omitempty"`

	// The flap fields are an all-or-none sealed plain-flap contract. Pointers
	// preserve the exact MCP approval scope: an omitted optional value must not
	// be silently added to the arguments that the user approved. A non-nil zero
	// deflection represents the explicit zero-degree member of a flap sweep.
	FlapChordRatio    *float64 `json:"flap_chord_ratio,omitempty"`
	FlapHingeXOverC   *float64 `json:"flap_hinge_x_over_c,omitempty"`
	FlapHingeYOverC   *float64 `json:"flap_hinge_y_over_c,omitempty"`
	FlapDeflectionDeg *float64 `json:"flap_deflection_deg,omitempty"`
	NCrit             *float64 `json:"ncrit,omitempty"`
	Iterations        *int     `json:"iterations,omitempty"`
	PanelCount        *int     `json:"panel_count,omitempty"`
}

type SU2Spec struct {
	RunID          string  `json:"run_id"`
	StageAttemptID string  `json:"stage_attempt_id"`
	Mach           float64 `json:"mach"`
	AlphaDeg       float64 `json:"alpha_deg"`
	Iterations     int     `json:"iterations"`
	MeshSizeM      float64 `json:"mesh_size_m"`
}
