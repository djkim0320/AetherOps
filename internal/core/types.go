package core

import (
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
)

const (
	PlannerModel   = "gpt-5.6-sol"
	CollectorModel = "gpt-5.6-terra"
	ReviewerModel  = "gpt-5.6-sol"

	PlannerEffort   = "xhigh"
	CollectorEffort = "high"
	ReviewerEffort  = "xhigh"

	MaxCollectors                  = 3
	EngineeringVerificationOrdinal = MaxCollectors
	MaxRevisions                   = 3
	MaxResearchRemediations        = 3

	ServiceTierDefault = "default"
	ServiceTierFast    = "fast"

	ContextProfileDefault = "default"
	ContextProfileLong1M  = "long_1m"
	LongContextTokens     = 1_000_000
	LongContextCompactAt  = 900_000

	// ResearchProfileVersionV2 is the first profile that separates immutable
	// research-stage execution settings from the model controls used by chat
	// and interactive planning. The database stores this literal on every run.
	ResearchProfileVersionV2      = "research_v2"
	ResearchProfileV2             = ResearchProfileVersionV2
	CurrentResearchProfileVersion = ResearchProfileVersionV2
	// V9 makes engineering receipt identity unambiguous at the model boundary:
	// only the exact art_<32 lowercase hex> database artifact id is accepted,
	// so a 64-character CAS hash cannot be mistaken for a receipt handle.
	// Older completed stage receipts must not resume under these stronger rules.
	// V8 keeps the V7 claim namespace and permits only a 5e-6 degree endpoint
	// quantization margin around the independent XFOIL target-alpha window.
	// Verification prompts require at least eight fractional digits and outward
	// rounding so model serialization cannot accidentally narrow the interval.
	// Older completed stage receipts must not resume under these stronger rules.
	// V7 keeps the V6 evidence shapes and moves every COLLECT claim into a
	// deterministic workstream-scoped namespace before its canonical artifact
	// is persisted. A global fail-closed identity check now runs after all
	// collectors and the optional engineering verification bundle complete.
	// Older completed stage receipts must not resume under these stronger rules.
	// V6 keeps the V5 COLLECT receipt rules and makes SYNTHESIZE engineering
	// knowledge evidence model-safe: each evidence item has one discriminated
	// wire shape, and engineering_get supplies CAS-derived value handles that
	// the model copies instead of inventing hashes or mixing provenance fields.
	// Older completed stage receipts must not resume under these stronger rules.
	// V5 made COLLECT engineering evidence model-safe: the model emits only a
	// receipt artifact id and the core rehydrates immutable receipt metadata.
	// It also deterministically completes an owner's truncated receipt-id list
	// from the exact same-run/same-attempt planned XFOIL sweep, while preserving
	// every model claim and adding separate receipt-specific audit claims.
	// Older completed stage receipts must not resume under these stronger rules.
	// V10 adds an immutable SU2 mesh-study contract and a core-authored
	// engineering acceptance assessment. Older stage checkpoints must not be
	// resumed because their plan could authorize solver work only through prose.
	// V11 makes a failed REVIEW executable: the verdict must describe missing
	// work, the prior cycle is superseded, and a fresh PLAN/COLLECT/SYNTHESIZE/REVIEW
	// cycle runs before quality can be reconsidered.
	StageExecutionContractV11    = "aetherops-stage-execution-v11"
	StageExecutionContractSHA256 = "a361ade9786215b112c97650ee01fb51de0a43cc2643acf134c164332933e1a2"

	KnowledgePatchSchemaV1       = "knowledge_patch_v1"
	KnowledgeEvidenceText        = "text"
	KnowledgeEvidenceEngineering = "engineering"
)

var ErrProjectResearchActive = errors.New("project has queued or active research")

// RunConfiguration is the chat selection captured when a user starts a run.
// It remains durable for UI/audit compatibility, but the research executor
// must never use it to choose a research-stage model, effort, or speed.
type RunConfiguration struct {
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoning_effort"`
	ServiceTier     string `json:"service_tier"`
	ContextProfile  string `json:"context_profile"`
}

func (configuration RunConfiguration) Validate() error {
	if strings.TrimSpace(configuration.Model) == "" {
		return errors.New("run model is required")
	}
	if strings.TrimSpace(configuration.ReasoningEffort) == "" {
		return errors.New("run reasoning effort is required")
	}
	if configuration.ServiceTier != ServiceTierDefault && configuration.ServiceTier != ServiceTierFast {
		return fmt.Errorf("unsupported run service tier %q", configuration.ServiceTier)
	}
	switch configuration.ContextProfile {
	case "", ContextProfileDefault:
	case ContextProfileLong1M:
		if configuration.Model != PlannerModel {
			return fmt.Errorf("context profile %q is available only for %s", ContextProfileLong1M, PlannerModel)
		}
	default:
		return fmt.Errorf("unsupported context profile %q", configuration.ContextProfile)
	}
	return nil
}

func (configuration RunConfiguration) NormalizedContextProfile() string {
	if configuration.ContextProfile == "" {
		return ContextProfileDefault
	}
	return configuration.ContextProfile
}

// ModelOption is the validated subset of model/list exposed to the shell UI.
// Array order is retained exactly as advertised by Codex App Server.
type ModelOption struct {
	ID                        string   `json:"id"`
	DisplayName               string   `json:"display_name"`
	DefaultReasoningEffort    string   `json:"default_reasoning_effort"`
	SupportedReasoningEfforts []string `json:"supported_reasoning_efforts"`
	SupportedSpeeds           []string `json:"supported_speeds"`
}

// ContextWindowUsage is the small, read-only telemetry surface shown beside
// the composer model selector. CurrentTokens comes from the last active Codex
// request; cumulative token totals are intentionally excluded.
type ContextWindowUsage struct {
	Available             bool      `json:"available"`
	ThreadID              string    `json:"thread_id,omitempty"`
	TurnID                string    `json:"turn_id,omitempty"`
	CurrentTokens         int64     `json:"current_tokens,omitempty"`
	ContextWindow         int64     `json:"context_window,omitempty"`
	InputTokens           int64     `json:"input_tokens,omitempty"`
	CachedInputTokens     int64     `json:"cached_input_tokens,omitempty"`
	OutputTokens          int64     `json:"output_tokens,omitempty"`
	ReasoningOutputTokens int64     `json:"reasoning_output_tokens,omitempty"`
	UsedPercent           float64   `json:"used_percent,omitempty"`
	UpdatedAt             time.Time `json:"updated_at,omitempty"`
}

type RunStatus string

const (
	RunQueued          RunStatus = "queued"
	RunPlanning        RunStatus = "planning"
	RunCollecting      RunStatus = "collecting"
	RunSynthesizing    RunStatus = "synthesizing"
	RunReviewing       RunStatus = "reviewing"
	RunRevising        RunStatus = "revising"
	RunWaitingApproval RunStatus = "waiting_approval"
	RunSucceeded       RunStatus = "succeeded"
	RunQualityFailed   RunStatus = "quality_failed"
	RunFailed          RunStatus = "failed"
	RunCancelled       RunStatus = "cancelled"
	RunInterrupted     RunStatus = "interrupted"
	RunUncertain       RunStatus = "uncertain"
)

type Stage string

const (
	StagePlan       Stage = "plan"
	StageCollect    Stage = "collect"
	StageSynthesize Stage = "synthesize"
	StageReview     Stage = "review"
	StageRevise     Stage = "revise"
)

type Project struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	MainThreadID string    `json:"main_thread_id,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// ToolPackage is a project-scoped, immutable proposal for a Codex skill or a
// declarative MCP adapter. Skills are instruction bundles and MCP packages are
// interpreted by AetherOps' fixed managed-tool server. A schema-v2 MCP package
// may reference one explicitly approved portable native payload; its adapter
// remains declarative and the exact installation is attached below.
type ToolPackage struct {
	ID                   string            `json:"id"`
	ProjectID            string            `json:"project_id"`
	Kind                 string            `json:"kind"`
	Name                 string            `json:"name"`
	DisplayName          string            `json:"display_name"`
	Description          string            `json:"description"`
	Version              string            `json:"version"`
	State                string            `json:"state"`
	ManifestJSON         string            `json:"manifest_json,omitempty"`
	PackageSHA256        string            `json:"package_sha256"`
	SourceRunID          string            `json:"source_run_id,omitempty"`
	SourceStageAttemptID string            `json:"source_stage_attempt_id,omitempty"`
	RequiresRestart      bool              `json:"requires_restart"`
	Error                string            `json:"error,omitempty"`
	Files                []ToolPackageFile `json:"files,omitempty"`
	Installation         *ToolInstallation `json:"installation,omitempty"`
	CreatedAt            time.Time         `json:"created_at"`
	UpdatedAt            time.Time         `json:"updated_at"`
	ActivatedAt          *time.Time        `json:"activated_at,omitempty"`
}

type ToolPackageFile struct {
	Path          string `json:"path"`
	Content       string `json:"content,omitempty"`
	ContentSHA256 string `json:"content_sha256"`
	Size          int64  `json:"size"`
}

// ToolInstallation is one immutable attempt to materialize an explicitly
// approved portable payload. The installation directory is derived from ID;
// absolute host paths are deliberately not persisted or exposed over JSON.
type ToolInstallation struct {
	ID                    string     `json:"id"`
	PackageID             string     `json:"package_id"`
	ProjectID             string     `json:"project_id"`
	PackageSHA256         string     `json:"package_sha256"`
	ApprovalSHA256        string     `json:"approval_sha256"`
	ExpectedPayloadSHA256 string     `json:"expected_payload_sha256"`
	PayloadBlobHash       string     `json:"payload_blob_hash,omitempty"`
	PayloadSizeBytes      int64      `json:"payload_size_bytes"`
	InstalledTreeSHA256   string     `json:"installed_tree_sha256,omitempty"`
	Entrypoint            string     `json:"entrypoint,omitempty"`
	ProbeOutputBlobHash   string     `json:"probe_output_blob_hash,omitempty"`
	State                 string     `json:"state"`
	Error                 string     `json:"error,omitempty"`
	CreatedAt             time.Time  `json:"created_at"`
	UpdatedAt             time.Time  `json:"updated_at"`
	CompletedAt           *time.Time `json:"completed_at,omitempty"`
}

// ToolStageGrant binds an installed package and its exact approval identity to
// one durable research stage. Grants never authorize another run or attempt.
type ToolStageGrant struct {
	ID             string    `json:"id"`
	ProjectID      string    `json:"project_id"`
	RunID          string    `json:"run_id"`
	StageAttemptID string    `json:"stage_attempt_id"`
	PackageID      string    `json:"package_id"`
	InstallationID string    `json:"installation_id"`
	PackageSHA256  string    `json:"package_sha256"`
	ApprovalSHA256 string    `json:"approval_sha256"`
	CreatedAt      time.Time `json:"created_at"`
}

// ToolInvocation is the durable at-most-once boundary for one portable CLI
// call. A running invocation found at startup becomes uncertain and is never
// silently replayed.
type ToolInvocation struct {
	ID              string     `json:"id"`
	IdempotencyKey  string     `json:"idempotency_key"`
	ProjectID       string     `json:"project_id"`
	RunID           string     `json:"run_id"`
	StageAttemptID  string     `json:"stage_attempt_id"`
	PackageID       string     `json:"package_id"`
	InstallationID  string     `json:"installation_id"`
	StageGrantID    string     `json:"stage_grant_id"`
	ToolName        string     `json:"tool_name"`
	ArgumentsSHA256 string     `json:"arguments_sha256"`
	AdapterSHA256   string     `json:"adapter_sha256"`
	State           string     `json:"state"`
	StdoutBlobHash  string     `json:"stdout_blob_hash,omitempty"`
	StderrBlobHash  string     `json:"stderr_blob_hash,omitempty"`
	ExitCode        *int       `json:"exit_code,omitempty"`
	Error           string     `json:"error,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
	StartedAt       *time.Time `json:"started_at,omitempty"`
	CompletedAt     *time.Time `json:"completed_at,omitempty"`
}

// ConversationSession is the AetherOps-owned identity for one durable Codex
// conversation inside a project. Codex remains the owner of the transcript;
// the application stores only the thread reference and last-used settings.
type ConversationSession struct {
	ID              string    `json:"id"`
	ProjectID       string    `json:"project_id"`
	Title           string    `json:"title"`
	CodexThreadID   string    `json:"codex_thread_id,omitempty"`
	Status          string    `json:"status"`
	Revision        int64     `json:"revision"`
	Model           string    `json:"model,omitempty"`
	ReasoningEffort string    `json:"reasoning_effort,omitempty"`
	ServiceTier     string    `json:"service_tier,omitempty"`
	ContextProfile  string    `json:"context_profile"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type ChatMode string

const (
	ChatModeConversation ChatMode = "chat"
	ChatModePlan         ChatMode = "plan"
)

func (mode ChatMode) Validate() error {
	if mode != ChatModeConversation && mode != ChatModePlan {
		return fmt.Errorf("unsupported chat mode %q", mode)
	}
	return nil
}

// ChatAttachment is a bounded, validated user-provided input for one chat turn.
// Content is decoded UTF-8 for text, a data URL for images, and base64 for
// documents that are materialized only for the duration of the Codex turn.
type ChatAttachment struct {
	Name      string `json:"name"`
	MediaType string `json:"media_type"`
	Kind      string `json:"kind"`
	Content   string `json:"content"`
}

// ChatReply contains the completed turn reference, visible assistant text, and
// an optional bounded planning prompt. Codex remains the durable owner of the
// full conversation transcript.
type ChatReply struct {
	ProjectID             string         `json:"project_id"`
	ConversationSessionID string         `json:"conversation_session_id"`
	ThreadID              string         `json:"thread_id"`
	TurnID                string         `json:"turn_id"`
	Mode                  ChatMode       `json:"mode"`
	Text                  string         `json:"text"`
	PlanReady             bool           `json:"plan_ready,omitempty"`
	PlanQuestions         []PlanQuestion `json:"plan_questions,omitempty"`
	PlanCycleID           string         `json:"plan_cycle_id,omitempty"`
	Model                 string         `json:"model"`
	ReasoningEffort       string         `json:"reasoning_effort"`
	ServiceTier           string         `json:"service_tier"`
}

// ChatHistory is a display projection read from Codex App Server on demand.
// It is never persisted in the AetherOps database.
type ChatHistory struct {
	ConversationSessionID string               `json:"conversation_session_id"`
	ThreadID              string               `json:"thread_id"`
	Messages              []ChatHistoryMessage `json:"messages"`
}

type ChatHistoryMessage struct {
	ID            string         `json:"id"`
	TurnID        string         `json:"turn_id"`
	Role          string         `json:"role"`
	Text          string         `json:"text"`
	Mode          ChatMode       `json:"mode"`
	CreatedAt     time.Time      `json:"created_at"`
	PlanReady     bool           `json:"plan_ready,omitempty"`
	PlanQuestions []PlanQuestion `json:"plan_questions,omitempty"`
	PlanCycleID   string         `json:"plan_cycle_id,omitempty"`
}

type ConversationPlanCycle struct {
	ID                    string     `json:"id"`
	ConversationSessionID string     `json:"conversation_session_id"`
	Objective             string     `json:"objective"`
	Status                string     `json:"status"`
	FinalPlan             string     `json:"final_plan,omitempty"`
	RunID                 string     `json:"run_id,omitempty"`
	CreatedAt             time.Time  `json:"created_at"`
	UpdatedAt             time.Time  `json:"updated_at"`
	ReadyAt               *time.Time `json:"ready_at,omitempty"`
	ConsumedAt            *time.Time `json:"consumed_at,omitempty"`
	SupersededAt          *time.Time `json:"superseded_at,omitempty"`
}

type PlanOption struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
	Recommended bool   `json:"recommended"`
}

type PlanQuestion struct {
	ID       string       `json:"id"`
	Header   string       `json:"header"`
	Question string       `json:"question"`
	Options  []PlanOption `json:"options"`
}

type PlanDialogue struct {
	Status    string         `json:"status"`
	Message   string         `json:"message"`
	Questions []PlanQuestion `json:"questions"`
	Plan      string         `json:"plan"`
}

func (dialogue PlanDialogue) Validate() error {
	if strings.TrimSpace(dialogue.Message) == "" {
		return errors.New("plan dialogue message is required")
	}
	switch dialogue.Status {
	case "needs_input":
		if len(dialogue.Questions) < 1 || len(dialogue.Questions) > 3 {
			return errors.New("plan dialogue must ask 1-3 questions")
		}
		if strings.TrimSpace(dialogue.Plan) != "" {
			return errors.New("plan dialogue cannot include a final plan while awaiting input")
		}
	case "ready":
		if len(dialogue.Questions) != 0 {
			return errors.New("ready plan dialogue cannot include questions")
		}
		if strings.TrimSpace(dialogue.Plan) == "" {
			return errors.New("ready plan dialogue requires a final plan")
		}
		return nil
	default:
		return fmt.Errorf("unsupported plan dialogue status %q", dialogue.Status)
	}
	questionIDs := make(map[string]bool, len(dialogue.Questions))
	for _, question := range dialogue.Questions {
		if strings.TrimSpace(question.ID) == "" || strings.TrimSpace(question.Header) == "" || strings.TrimSpace(question.Question) == "" {
			return errors.New("plan questions require id, header, and question")
		}
		if questionIDs[question.ID] {
			return fmt.Errorf("duplicate plan question id %q", question.ID)
		}
		questionIDs[question.ID] = true
		if len(question.Options) < 2 || len(question.Options) > 3 {
			return fmt.Errorf("plan question %q must contain 2-3 options", question.ID)
		}
		optionIDs := make(map[string]bool, len(question.Options))
		for index, option := range question.Options {
			if strings.TrimSpace(option.ID) == "" || strings.TrimSpace(option.Label) == "" || strings.TrimSpace(option.Description) == "" {
				return fmt.Errorf("plan question %q has an incomplete option", question.ID)
			}
			if optionIDs[option.ID] {
				return fmt.Errorf("plan question %q repeats option %q", question.ID, option.ID)
			}
			optionIDs[option.ID] = true
			if option.Recommended != (index == 0) {
				return fmt.Errorf("plan question %q must recommend only its first option", question.ID)
			}
		}
	}
	return nil
}

type Run struct {
	ID                     string                        `json:"id"`
	ProjectID              string                        `json:"project_id"`
	ConversationSessionID  string                        `json:"conversation_session_id"`
	ScheduleID             string                        `json:"schedule_id,omitempty"`
	Question               string                        `json:"question"`
	Status                 RunStatus                     `json:"status"`
	Revision               int64                         `json:"revision"`
	RevisionCycle          int                           `json:"revision_cycle"`
	MainThreadID           string                        `json:"main_thread_id,omitempty"`
	ResearchProfileVersion string                        `json:"research_profile_version"`
	RetrievalProfile       string                        `json:"retrieval_profile"`
	KnowledgeGenerationID  string                        `json:"knowledge_generation_id"`
	Model                  string                        `json:"model,omitempty"`
	ReasoningEffort        string                        `json:"reasoning_effort,omitempty"`
	ServiceTier            string                        `json:"service_tier,omitempty"`
	ProductBuild           buildinfo.ProductBuildBinding `json:"product_build"`
	ReportArtifactID       string                        `json:"report_artifact_id,omitempty"`
	Error                  string                        `json:"error,omitempty"`
	CreatedAt              time.Time                     `json:"created_at"`
	UpdatedAt              time.Time                     `json:"updated_at"`
}

type StageAttempt struct {
	ID                  string    `json:"id"`
	RunID               string    `json:"run_id"`
	Stage               Stage     `json:"stage"`
	Ordinal             int       `json:"ordinal"`
	Status              string    `json:"status"`
	CodexThreadID       string    `json:"codex_thread_id,omitempty"`
	CodexTurnID         string    `json:"codex_turn_id,omitempty"`
	InputArtifactHash   string    `json:"input_artifact_hash,omitempty"`
	OutputArtifactHash  string    `json:"output_artifact_hash,omitempty"`
	ExternalSideEffects bool      `json:"external_side_effects"`
	Error               string    `json:"error,omitempty"`
	CreatedAt           time.Time `json:"created_at"`
	UpdatedAt           time.Time `json:"updated_at"`
}

type Workstream struct {
	ID                   string   `json:"id"`
	Question             string   `json:"question"`
	PreferredSourceKinds []string `json:"preferred_source_kinds"`
	RequiredEvidence     []string `json:"required_evidence"`
}

type ResearchPlan struct {
	Question           string              `json:"question"`
	Mode               string              `json:"mode"`
	Workstreams        []Workstream        `json:"workstreams"`
	SourceRequirements []string            `json:"source_requirements"`
	AcceptanceCriteria []string            `json:"acceptance_criteria"`
	XFOILScreening     *XFOILScreeningPlan `json:"xfoil_screening"`
	SU2Cases           *SU2CaseSetPlan     `json:"su2_cases"`
	// SU2MeshStudy is retained only so an older checkpoint fails with an
	// explicit migration error instead of being misread as a general case set.
	// It is never accepted as a current execution contract.
	SU2MeshStudy *SU2MeshStudyPlan `json:"su2_mesh_study,omitempty"`
}

const (
	SU2InputArtifact = "artifact"
	SU2InputMaterial = "material"
)

// SU2CaseSetPlan is the exact case matrix for the general SU2_CFD adapter.
// Every case binds immutable project-owned mesh/config bytes by SHA-256; the
// collector may not substitute a built-in geometry or silently shrink the set.
type SU2CaseSetPlan struct {
	Objective string        `json:"objective"`
	Cases     []SU2CasePlan `json:"cases"`
}

type SU2CasePlan struct {
	ID              string            `json:"case_id"`
	MeshSource      string            `json:"mesh_source"`
	MeshID          string            `json:"mesh_id"`
	MeshSHA256      string            `json:"mesh_sha256"`
	ConfigSource    string            `json:"config_source"`
	ConfigID        string            `json:"config_id"`
	ConfigSHA256    string            `json:"config_sha256"`
	Solver          string            `json:"solver"`
	TurbulenceModel string            `json:"turbulence_model"`
	ConfigOverrides map[string]string `json:"config_overrides"`
	OutputFiles     []string          `json:"output_files"`
	TimeoutSeconds  int               `json:"timeout_seconds"`
}

func (plan SU2CaseSetPlan) Validate() error {
	if strings.TrimSpace(plan.Objective) == "" || len(plan.Cases) < 1 || len(plan.Cases) > 16 {
		return errors.New("SU2 case set requires an objective and 1-16 exact cases")
	}
	ids := make(map[string]struct{}, len(plan.Cases))
	for _, item := range plan.Cases {
		if err := item.Validate(); err != nil {
			return fmt.Errorf("SU2 case %q: %w", item.ID, err)
		}
		if _, duplicate := ids[item.ID]; duplicate {
			return fmt.Errorf("duplicate SU2 case id %q", item.ID)
		}
		ids[item.ID] = struct{}{}
	}
	return nil
}

func (plan SU2CasePlan) Validate() error {
	if !regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`).MatchString(plan.ID) ||
		(plan.MeshSource != SU2InputArtifact && plan.MeshSource != SU2InputMaterial) ||
		strings.TrimSpace(plan.MeshID) == "" || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(plan.MeshSHA256) {
		return errors.New("case id and immutable project-owned mesh identity are required")
	}
	if plan.ConfigSource == "" {
		if plan.ConfigID != "" || plan.ConfigSHA256 != "" || len(plan.ConfigOverrides) == 0 {
			return errors.New("an omitted config source requires empty config identity and non-empty overrides")
		}
	} else if (plan.ConfigSource != SU2InputArtifact && plan.ConfigSource != SU2InputMaterial) ||
		strings.TrimSpace(plan.ConfigID) == "" || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(plan.ConfigSHA256) {
		return errors.New("config source must bind an immutable project artifact or material")
	}
	allowedSolvers := map[string]bool{
		"EULER": true, "NAVIER_STOKES": true, "RANS": true,
		"INC_EULER": true, "INC_NAVIER_STOKES": true, "INC_RANS": true,
	}
	if !allowedSolvers[plan.Solver] {
		return errors.New("solver must be a supported direct single-zone SU2_CFD solver")
	}
	switch plan.Solver {
	case "RANS", "INC_RANS":
		if plan.TurbulenceModel != "SA" && plan.TurbulenceModel != "SST" {
			return errors.New("RANS requires the SA or SST turbulence model")
		}
	default:
		if plan.TurbulenceModel != "NONE" {
			return errors.New("Euler and laminar Navier-Stokes cases require turbulence_model=NONE")
		}
	}
	if len(plan.ConfigOverrides) > 256 {
		return errors.New("SU2 case has more than 256 configuration overrides")
	}
	if len(plan.OutputFiles) < 1 || len(plan.OutputFiles) > 3 {
		return errors.New("SU2 case requires 1-3 managed output formats")
	}
	allowedOutputs := map[string]bool{
		"surface_csv": true, "volume_paraview_ascii": true, "restart_ascii": true,
	}
	seenOutputs := make(map[string]struct{}, len(plan.OutputFiles))
	for _, output := range plan.OutputFiles {
		if !allowedOutputs[output] {
			return fmt.Errorf("unsupported managed SU2 output %q", output)
		}
		if _, duplicate := seenOutputs[output]; duplicate {
			return fmt.Errorf("duplicate managed SU2 output %q", output)
		}
		seenOutputs[output] = struct{}{}
	}
	if plan.TimeoutSeconds < 60 || plan.TimeoutSeconds > 7200 {
		return errors.New("SU2 timeout must be between 60 and 7200 seconds")
	}
	return nil
}

const (
	SU2MeshStudyProfileV1 = "su2_naca0012_grid_sensitivity/v1"
	SU2FixedDomainV1      = "rect_xm10_xp15_ym10_yp10/v1"
	SU2ObjectiveGridStudy = "assess_grid_sensitivity"
	SU2ExecutionExecute   = "execute"
	SU2ExecutionReadback  = "readback_existing"
)

// SU2MeshStudyPlan is the immutable capability contract for the bundled
// NACA0012 solver workflow. The fixed domain is deliberately explicit: a
// model cannot promise a 20c or C-grid study and then silently execute the
// smaller bundled rectangular domain.
type SU2MeshStudyPlan struct {
	ExecutionMode       string    `json:"execution_mode"`
	Profile             string    `json:"profile"`
	NACA                string    `json:"naca"`
	Mach                float64   `json:"mach"`
	AlphaDeg            float64   `json:"alpha_deg"`
	Iterations          int       `json:"iterations"`
	MeshSizesM          []float64 `json:"mesh_sizes_m"`
	DomainProfile       string    `json:"domain_profile"`
	Objective           string    `json:"objective"`
	ReferenceComparison string    `json:"reference_comparison"`
}

func (plan SU2MeshStudyPlan) Validate() error {
	if plan.ExecutionMode != SU2ExecutionExecute && plan.ExecutionMode != SU2ExecutionReadback {
		return errors.New("SU2 mesh study requires an explicit execute or readback_existing mode")
	}
	if plan.Profile != SU2MeshStudyProfileV1 || plan.NACA != "0012" ||
		plan.DomainProfile != SU2FixedDomainV1 || plan.Objective != SU2ObjectiveGridStudy ||
		plan.ReferenceComparison != "qualitative_context" {
		return errors.New("SU2 mesh study requests an unsupported profile, domain, objective, or reference comparison")
	}
	if math.IsNaN(plan.Mach) || math.IsInf(plan.Mach, 0) ||
		math.IsNaN(plan.AlphaDeg) || math.IsInf(plan.AlphaDeg, 0) ||
		plan.Mach < .01 || plan.Mach > 2 || plan.AlphaDeg < -20 || plan.AlphaDeg > 20 ||
		plan.Iterations < 20 || plan.Iterations > 1000 {
		return errors.New("SU2 mesh study operating point is outside the supported envelope")
	}
	if len(plan.MeshSizesM) < 3 || len(plan.MeshSizesM) > 8 {
		return errors.New("SU2 mesh study requires 3-8 mesh sizes")
	}
	for index, size := range plan.MeshSizesM {
		if math.IsNaN(size) || math.IsInf(size, 0) || size < .01 || size > .2 {
			return errors.New("SU2 mesh size is outside the supported envelope")
		}
		if index > 0 && size >= plan.MeshSizesM[index-1] {
			return errors.New("SU2 mesh sizes must be unique and ordered coarse to fine")
		}
	}
	return nil
}

// XFOILScreeningPlan is the immutable, model-declared numerical sweep
// contract. The collector may choose prose and public-source work freely, but
// it may not silently shrink, expand, or otherwise alter this candidate set.
// A nil contract means the plan does not authorize an XFOIL optimization
// screening sweep.
type XFOILScreeningPlan struct {
	NACA                    string                `json:"naca"`
	Reynolds                float64               `json:"reynolds"`
	Mach                    float64               `json:"mach"`
	AlphaStartDeg           float64               `json:"alpha_start_deg"`
	AlphaEndDeg             float64               `json:"alpha_end_deg"`
	AlphaStepDeg            float64               `json:"alpha_step_deg"`
	FlapChordRatio          float64               `json:"flap_chord_ratio"`
	FlapHingeXOverC         float64               `json:"flap_hinge_x_over_c"`
	FlapHingeYOverC         float64               `json:"flap_hinge_y_over_c"`
	CandidateDeflectionsDeg []float64             `json:"candidate_flap_deflections_deg"`
	NCrit                   float64               `json:"ncrit"`
	Iterations              int                   `json:"iterations"`
	PanelCount              int                   `json:"panel_count"`
	OptimizationObjective   string                `json:"optimization_objective"`
	TargetCL                float64               `json:"target_cl"`
	MinimumCM               float64               `json:"minimum_cm"`
	OperatingPoints         []XFOILOperatingPoint `json:"operating_points,omitempty"`
}

// XFOILOperatingPoint is one bounded condition in an app-owned declarative
// screening workflow. When OperatingPoints is empty, the legacy scalar
// Reynolds/Mach/NCrit/TargetCL/MinimumCM fields form the single operating
// point. A matrix lets PLAN compose the existing typed xfoil_polar tool
// without inventing code, commands, or a new executable surface.
type XFOILOperatingPoint struct {
	ID        string  `json:"id"`
	Reynolds  float64 `json:"reynolds"`
	Mach      float64 `json:"mach"`
	NCrit     float64 `json:"ncrit"`
	TargetCL  float64 `json:"target_cl"`
	MinimumCM float64 `json:"minimum_cm"`
}

func (plan XFOILScreeningPlan) EffectiveOperatingPoints() []XFOILOperatingPoint {
	if len(plan.OperatingPoints) > 0 {
		return append([]XFOILOperatingPoint(nil), plan.OperatingPoints...)
	}
	return []XFOILOperatingPoint{{
		ID: "primary", Reynolds: plan.Reynolds, Mach: plan.Mach, NCrit: plan.NCrit,
		TargetCL: plan.TargetCL, MinimumCM: plan.MinimumCM,
	}}
}

func (plan XFOILScreeningPlan) Validate() error {
	finite := func(values ...float64) bool {
		for _, value := range values {
			if math.IsNaN(value) || math.IsInf(value, 0) {
				return false
			}
		}
		return true
	}
	if !regexp.MustCompile(`^[0-9]{4}$`).MatchString(plan.NACA) ||
		!finite(plan.Reynolds, plan.Mach, plan.AlphaStartDeg, plan.AlphaEndDeg,
			plan.AlphaStepDeg, plan.FlapChordRatio, plan.FlapHingeXOverC,
			plan.FlapHingeYOverC, plan.NCrit, plan.TargetCL, plan.MinimumCM) {
		return errors.New("XFOIL screening plan has invalid identifiers or non-finite values")
	}
	if plan.Reynolds < 5e4 || plan.Reynolds > 5e7 || plan.Mach < 0 || plan.Mach > .7 ||
		plan.AlphaStartDeg < -15 || plan.AlphaEndDeg > 20 || plan.AlphaEndDeg <= plan.AlphaStartDeg ||
		plan.AlphaStepDeg < .01 || plan.AlphaStepDeg > 5 {
		return errors.New("XFOIL screening plan is outside the supported polar envelope")
	}
	steps := (plan.AlphaEndDeg - plan.AlphaStartDeg) / plan.AlphaStepDeg
	if rounded := math.Round(steps); math.Abs(steps-rounded) > 1e-8*math.Max(1, math.Abs(steps)) || rounded < 1 || rounded+1 > 201 {
		return errors.New("XFOIL screening plan alpha grid is invalid")
	}
	if plan.FlapChordRatio <= 0 || plan.FlapChordRatio >= .5 ||
		plan.FlapHingeXOverC <= .5 || plan.FlapHingeXOverC >= 1 ||
		math.Abs((1-plan.FlapHingeXOverC)-plan.FlapChordRatio) > 1e-8 ||
		plan.FlapHingeYOverC < -.5 || plan.FlapHingeYOverC > .5 {
		return errors.New("XFOIL screening plan flap geometry is invalid")
	}
	if len(plan.CandidateDeflectionsDeg) == 0 || len(plan.CandidateDeflectionsDeg) > 64 {
		return errors.New("XFOIL screening plan requires 1-64 candidate deflections")
	}
	seen := make(map[uint64]struct{}, len(plan.CandidateDeflectionsDeg))
	for _, deflection := range plan.CandidateDeflectionsDeg {
		if !finite(deflection) || deflection < -40 || deflection > 40 {
			return errors.New("XFOIL screening candidate deflection is invalid")
		}
		if deflection == 0 {
			deflection = 0
		}
		key := math.Float64bits(deflection)
		if _, duplicate := seen[key]; duplicate {
			return errors.New("XFOIL screening plan has duplicate candidate deflections")
		}
		seen[key] = struct{}{}
	}
	if plan.NCrit < 1 || plan.NCrit > 14 || plan.Iterations < 50 || plan.Iterations > 500 ||
		plan.PanelCount < 80 || plan.PanelCount > 300 {
		return errors.New("XFOIL screening solver controls are invalid")
	}
	if plan.OptimizationObjective != "minimize_cd_at_target_cl" ||
		plan.TargetCL < -5 || plan.TargetCL > 5 || plan.MinimumCM < -5 || plan.MinimumCM > 5 {
		return errors.New("XFOIL screening optimization contract is invalid")
	}
	if len(plan.OperatingPoints) > 16 {
		return errors.New("XFOIL screening workflow supports at most 16 operating points")
	}
	if len(plan.EffectiveOperatingPoints())*len(plan.CandidateDeflectionsDeg) > 64 {
		return errors.New("XFOIL screening workflow supports at most 64 bounded solver calls")
	}
	pointIDs := make(map[string]struct{}, len(plan.OperatingPoints))
	type operatingCondition struct {
		reynolds, mach, ncrit, targetCL, minimumCM uint64
	}
	conditionBits := func(value float64) uint64 {
		if value == 0 {
			value = 0
		}
		return math.Float64bits(value)
	}
	pointConditions := make(map[operatingCondition]struct{}, len(plan.OperatingPoints))
	pointIDPattern := regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	for _, point := range plan.OperatingPoints {
		if !pointIDPattern.MatchString(point.ID) {
			return errors.New("XFOIL operating point id is invalid")
		}
		if _, duplicate := pointIDs[point.ID]; duplicate {
			return errors.New("XFOIL operating point ids must be unique")
		}
		pointIDs[point.ID] = struct{}{}
		if !finite(point.Reynolds, point.Mach, point.NCrit, point.TargetCL, point.MinimumCM) ||
			point.Reynolds < 5e4 || point.Reynolds > 5e7 || point.Mach < 0 || point.Mach > .7 ||
			point.NCrit < 1 || point.NCrit > 14 || point.TargetCL < -5 || point.TargetCL > 5 ||
			point.MinimumCM < -5 || point.MinimumCM > 5 {
			return errors.New("XFOIL operating point is outside the supported envelope")
		}
		condition := operatingCondition{
			reynolds: conditionBits(point.Reynolds), mach: conditionBits(point.Mach),
			ncrit: conditionBits(point.NCrit), targetCL: conditionBits(point.TargetCL),
			minimumCM: conditionBits(point.MinimumCM),
		}
		if _, duplicate := pointConditions[condition]; duplicate {
			return errors.New("XFOIL operating points must have unique numerical conditions")
		}
		pointConditions[condition] = struct{}{}
	}
	return nil
}

func (plan ResearchPlan) Validate() error {
	if plan.Question == "" {
		return errors.New("research plan question is empty")
	}
	if plan.Mode != "general" && plan.Mode != "engineering" {
		return fmt.Errorf("unsupported research mode %q", plan.Mode)
	}
	if plan.XFOILScreening != nil {
		if plan.Mode != "engineering" {
			return errors.New("XFOIL screening requires engineering research mode")
		}
		if err := plan.XFOILScreening.Validate(); err != nil {
			return err
		}
	} else if plan.referencesXFOIL() {
		return errors.New("XFOIL research requires the immutable supported xfoil_screening contract; arbitrary airfoil-coordinate comparisons are not supported")
	}
	if plan.SU2MeshStudy != nil {
		return errors.New("legacy SU2 preset plans are not executable; create an exact su2_cases contract")
	}
	if plan.SU2Cases != nil {
		if plan.Mode != "engineering" {
			return errors.New("SU2 cases require engineering research mode")
		}
		if err := plan.SU2Cases.Validate(); err != nil {
			return err
		}
	}
	if len(plan.Workstreams) < 1 || len(plan.Workstreams) > MaxCollectors {
		return fmt.Errorf("research plan must contain 1-%d workstreams", MaxCollectors)
	}
	ids := make([]string, 0, len(plan.Workstreams))
	for _, workstream := range plan.Workstreams {
		if workstream.ID == "" || workstream.Question == "" {
			return errors.New("workstream id and question are required")
		}
		if slices.Contains(ids, workstream.ID) {
			return fmt.Errorf("duplicate workstream id %q", workstream.ID)
		}
		ids = append(ids, workstream.ID)
	}
	return nil
}

// referencesXFOIL closes the capability gap between model-authored prose and
// the typed engineering boundary. An XFOIL task may only reach COLLECT when
// PLAN has declared the exact screening sweep that the core can verify.
//
// Plan prose also records explicit exclusions. Treating an excluded tool name
// as executable intent makes a valid SU2-only plan impossible to validate, so
// inspect each sentence-like clause and ignore unambiguous negative scope.
func (plan ResearchPlan) referencesXFOIL() bool {
	contains := containsExecutableXFOILReference
	if contains(plan.Question) {
		return true
	}
	for _, value := range plan.SourceRequirements {
		if contains(value) {
			return true
		}
	}
	for _, value := range plan.AcceptanceCriteria {
		if contains(value) {
			return true
		}
	}
	for _, workstream := range plan.Workstreams {
		if contains(workstream.Question) {
			return true
		}
		for _, value := range workstream.PreferredSourceKinds {
			if contains(value) {
				return true
			}
		}
		for _, value := range workstream.RequiredEvidence {
			if contains(value) {
				return true
			}
		}
	}
	return false
}

func containsExecutableXFOILReference(value string) bool {
	value = stripExcludedPlanSections(value)
	clauses := strings.FieldsFunc(value, func(r rune) bool {
		switch r {
		case '\n', '\r', '.', '!', '?', ';', '。', '！', '？':
			return true
		default:
			return false
		}
	})
	for _, clause := range clauses {
		lower := strings.ToLower(strings.TrimSpace(clause))
		if !strings.Contains(lower, "xfoil") {
			continue
		}
		if !isExcludedXFOILClause(lower) {
			return true
		}
	}
	return false
}

// stripExcludedPlanSections removes Markdown/plain-text exclusion sections
// before executable-intent detection. Models commonly put a bare "XFOIL
// comparison" bullet under a Korean or English exclusion heading; the bullet
// itself has no negative verb, so clause-only classification is insufficient.
func stripExcludedPlanSections(value string) string {
	lines := strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n")
	kept := make([]string, 0, len(lines))
	excluded := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		heading := strings.TrimSpace(strings.TrimLeft(trimmed, "#* "))
		heading = strings.TrimSpace(strings.TrimRight(heading, ":\uFF1A* "))
		lowerHeading := strings.ToLower(heading)
		if lowerHeading == "exclusions" || lowerHeading == "excluded scope" ||
			lowerHeading == "out of scope" || heading == "\uC81C\uC678" ||
			heading == "\uC81C\uC678 \uBC94\uC704" {
			excluded = true
			continue
		}
		if strings.HasPrefix(trimmed, "#") {
			excluded = false
		}
		if !excluded {
			kept = append(kept, line)
		}
	}
	return strings.Join(kept, "\n")
}

func isExcludedXFOILClause(lower string) bool {
	for _, prefix := range []string{
		"\uC81C\uC678:", "\uC81C\uC678\uFF1A", "\uC81C\uC678 \uBC94\uC704",
	} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	for _, phrase := range []string{
		"xfoil \uC81C\uC678", "xfoil\uC740 \uC81C\uC678", "xfoil\uC744 \uC81C\uC678", "xfoil\uB97C \uC81C\uC678",
		"xfoil \uBBF8\uC0AC\uC6A9", "xfoil \uBE44\uC0AC\uC6A9", "xfoil\uC744 \uC0AC\uC6A9\uD558\uC9C0 \uC54A", "xfoil \uC0AC\uC6A9 \uC548",
	} {
		if strings.Contains(lower, phrase) {
			return true
		}
	}
	for _, prefix := range []string{
		"exclude:", "excluded:", "exclusions:", "out of scope:", "제외:", "제외：", "제외 범위",
	} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	for _, phrase := range []string{
		"exclude xfoil", "excluding xfoil", "excluded xfoil", "without xfoil",
		"do not use xfoil", "don't use xfoil", "not use xfoil", "no xfoil",
		"xfoil is excluded", "xfoil excluded", "xfoil is out of scope", "xfoil out of scope",
		"xfoil is unsupported", "xfoil unsupported", "xfoil is not used", "xfoil not used",
		"xfoil 제외", "xfoil은 제외", "xfoil을 제외", "xfoil를 제외",
		"xfoil 미사용", "xfoil 비사용", "xfoil을 사용하지", "xfoil를 사용하지",
		"xfoil 사용하지", "xfoil 사용 안", "xfoil 대신",
	} {
		if strings.Contains(lower, phrase) {
			return true
		}
	}
	return false
}

type EvidenceSource struct {
	ID         string    `json:"id"`
	URL        string    `json:"url"`
	Title      string    `json:"title"`
	Publisher  string    `json:"publisher,omitempty"`
	CapturedAt time.Time `json:"captured_at"`
	BlobHash   string    `json:"blob_hash"`
}

const engineeringReceiptURNPrefix = "urn:aetherops:engineering-receipt:"

var engineeringReceiptArtifactIDPattern = regexp.MustCompile(`^art_[a-f0-9]{32}$`)

// IsEngineeringReceiptArtifactID validates the opaque artifact handle used by
// the COLLECT response contract. Models return only this handle; trusted
// receipt metadata is rehydrated from the run-owned store before persistence.
func IsEngineeringReceiptArtifactID(artifactID string) bool {
	return engineeringReceiptArtifactIDPattern.MatchString(artifactID)
}

// EngineeringReceiptEvidenceSource turns one run-owned execution receipt into
// the same immutable provenance shape used by public source captures. The URN
// namespace is closed: callers cannot use it for arbitrary files or URLs.
func EngineeringReceiptEvidenceSource(
	artifactID, operation, blobHash string,
	capturedAt time.Time,
) (EvidenceSource, error) {
	if !engineeringReceiptArtifactIDPattern.MatchString(artifactID) || strings.TrimSpace(operation) == "" ||
		!sha256Pattern.MatchString(blobHash) || blobHash == strings.Repeat("0", 64) ||
		capturedAt.Before(minimumEvidenceCaptureTime) {
		return EvidenceSource{}, errors.New("engineering receipt evidence metadata is invalid")
	}
	return EvidenceSource{
		ID:         artifactID,
		URL:        engineeringReceiptURNPrefix + artifactID,
		Title:      "AetherOps engineering receipt: " + operation,
		Publisher:  "AetherOps engineering runtime",
		CapturedAt: capturedAt.UTC(),
		BlobHash:   blobHash,
	}, nil
}

// EngineeringReceiptArtifactID recognizes only the exact closed receipt URN
// syntax emitted by EngineeringReceiptEvidenceSource.
func EngineeringReceiptArtifactID(source EvidenceSource) (string, bool) {
	artifactID, ok := strings.CutPrefix(source.URL, engineeringReceiptURNPrefix)
	if !ok || source.ID != artifactID || !IsEngineeringReceiptArtifactID(artifactID) {
		return "", false
	}
	return artifactID, true
}

// Validate checks the complete, canonical source shape that may cross the
// durable evidence boundary. A transient collector receipt reference is not a
// complete EvidenceSource and must first be rehydrated by the store.
func (source EvidenceSource) Validate() error {
	parsed, err := url.Parse(source.URL)
	_, receiptSource := EngineeringReceiptArtifactID(source)
	publicSource := err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Hostname() != ""
	if source.ID == "" || source.Title == "" || (!receiptSource && !publicSource) {
		return errors.New("evidence source id, title, and public URL are required")
	}
	if !sha256Pattern.MatchString(source.BlobHash) || source.BlobHash == strings.Repeat("0", 64) {
		return fmt.Errorf("evidence source %q has an invalid blob hash", source.ID)
	}
	// CapturedAt is the time AetherOps committed the exact source bytes,
	// not the publication date. Year-one and Unix-epoch values are model
	// placeholders produced after a failed tool call and must never cross
	// the durable evidence boundary.
	if source.CapturedAt.Before(minimumEvidenceCaptureTime) {
		return fmt.Errorf("evidence source %q has an invalid capture time", source.ID)
	}
	return nil
}

type EvidenceClaim struct {
	ID              string   `json:"id"`
	Statement       string   `json:"statement"`
	SourceIDs       []string `json:"source_ids"`
	Counterevidence string   `json:"counterevidence,omitempty"`
}

type EvidenceBundle struct {
	WorkstreamID string           `json:"workstream_id"`
	Summary      string           `json:"summary"`
	Claims       []EvidenceClaim  `json:"claims"`
	Sources      []EvidenceSource `json:"sources"`
	Limitations  []string         `json:"limitations"`
}

var sha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

var minimumEvidenceCaptureTime = time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC)

func (bundle EvidenceBundle) Validate(expectedWorkstreamID string) error {
	if bundle.WorkstreamID == "" || (expectedWorkstreamID != "" && bundle.WorkstreamID != expectedWorkstreamID) {
		return errors.New("evidence bundle workstream does not match the plan")
	}
	if strings.TrimSpace(bundle.Summary) == "" || len(bundle.Claims) == 0 || len(bundle.Sources) == 0 {
		return errors.New("evidence bundle requires a summary, claims, and sources")
	}
	sourceIDs := make(map[string]bool, len(bundle.Sources))
	for _, source := range bundle.Sources {
		if err := source.Validate(); err != nil {
			return err
		}
		if sourceIDs[source.ID] {
			return fmt.Errorf("duplicate evidence source id %q", source.ID)
		}
		sourceIDs[source.ID] = true
	}
	claimIDs := make(map[string]bool, len(bundle.Claims))
	for _, claim := range bundle.Claims {
		if claim.ID == "" || strings.TrimSpace(claim.Statement) == "" || len(claim.SourceIDs) == 0 {
			return errors.New("evidence claims require id, statement, and sources")
		}
		if claimIDs[claim.ID] {
			return fmt.Errorf("duplicate evidence claim id %q", claim.ID)
		}
		claimIDs[claim.ID] = true
		for _, sourceID := range claim.SourceIDs {
			if !sourceIDs[sourceID] {
				return fmt.Errorf("claim %q references unknown source %q", claim.ID, sourceID)
			}
		}
	}
	return nil
}

type Citation struct {
	Marker    string   `json:"marker"`
	SourceIDs []string `json:"source_ids"`
	ClaimIDs  []string `json:"claim_ids"`
}

// KnowledgeAlias retains the spelling emitted by a source. Language is a
// BCP-47 tag when known and the empty string when the source does not identify
// one; language/cross-script equivalence is never inferred from this value.
type KnowledgeAlias struct {
	Value    string `json:"value"`
	Language string `json:"language"`
}

// KnowledgeTypedLiteral preserves the source lexical form. Unit-bearing
// values also carry the deterministic SI projection; both are strings so a
// JSON number round-trip cannot change precision or spelling.
type KnowledgeTypedLiteral struct {
	LexicalForm string `json:"lexical_form"`
	Datatype    string `json:"datatype"`
	Language    string `json:"language"`
	Unit        string `json:"unit"`
	SIValue     string `json:"si_value"`
	SIUnit      string `json:"si_unit"`
}

func (literal KnowledgeTypedLiteral) Validate() error {
	return literal.ValidateWithUnitRegistry(CurrentUnitRegistryVersion)
}

func (literal KnowledgeTypedLiteral) ValidateWithUnitRegistry(version string) error {
	if strings.TrimSpace(literal.LexicalForm) == "" || strings.TrimSpace(literal.Datatype) == "" {
		return errors.New("knowledge literal lexical form and datatype are required")
	}
	return validateKnowledgeUnitProjection(literal, version)
}

func isNonFiniteLiteral(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "nan", "+nan", "-nan", "inf", "+inf", "-inf", "infinity", "+infinity", "-infinity":
		return true
	default:
		return false
	}
}

// KnowledgeTimeRange is an optional closed/open interval. Empty Start or End
// represents an open boundary; a present boundary must be RFC3339 with an
// explicit offset so materialization is timezone-independent.
type KnowledgeTimeRange struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

func (interval KnowledgeTimeRange) Validate() error {
	if interval.Start == "" && interval.End == "" {
		return errors.New("knowledge time range cannot have two open boundaries")
	}
	var start, end time.Time
	var err error
	if interval.Start != "" {
		start, err = time.Parse(time.RFC3339Nano, interval.Start)
		if err != nil {
			return errors.New("knowledge time range start must be RFC3339")
		}
	}
	if interval.End != "" {
		end, err = time.Parse(time.RFC3339Nano, interval.End)
		if err != nil {
			return errors.New("knowledge time range end must be RFC3339")
		}
	}
	if !start.IsZero() && !end.IsZero() && start.After(end) {
		return errors.New("knowledge time range starts after it ends")
	}
	return nil
}

// KnowledgeEvidenceRef is a discriminated evidence handle. Text evidence uses
// SourceID/ClaimID plus a UTF-8 byte span in BlobHash. Engineering evidence
// uses a run-owned ArtifactHash and exactly one JSON Pointer or one-based CSV
// record number. Unused fields must be their zero value.
type KnowledgeEvidenceRef struct {
	Kind         string `json:"kind"`
	SourceID     string `json:"source_id"`
	ClaimID      string `json:"claim_id"`
	BlobHash     string `json:"blob_hash"`
	ByteStart    int64  `json:"byte_start"`
	ByteEnd      int64  `json:"byte_end"`
	SpanHash     string `json:"span_hash"`
	ArtifactHash string `json:"artifact_hash"`
	JSONPointer  string `json:"json_pointer"`
	CSVRow       int64  `json:"csv_row"`
	ValueHash    string `json:"value_hash"`
}

func (reference KnowledgeEvidenceRef) Validate() error {
	switch reference.Kind {
	case KnowledgeEvidenceText:
		if strings.TrimSpace(reference.SourceID) == "" || strings.TrimSpace(reference.ClaimID) == "" {
			return errors.New("text knowledge evidence requires source and claim ids")
		}
		if !sha256Pattern.MatchString(reference.BlobHash) || !sha256Pattern.MatchString(reference.SpanHash) {
			return errors.New("text knowledge evidence requires valid blob and span hashes")
		}
		if reference.ByteStart < 0 || reference.ByteEnd <= reference.ByteStart {
			return errors.New("text knowledge evidence requires a non-empty byte span")
		}
		if reference.ArtifactHash != "" || reference.JSONPointer != "" || reference.CSVRow != 0 || reference.ValueHash != "" {
			return errors.New("text knowledge evidence contains engineering fields")
		}
	case KnowledgeEvidenceEngineering:
		if reference.SourceID != "" || reference.ClaimID != "" || reference.BlobHash != "" ||
			reference.ByteStart != 0 || reference.ByteEnd != 0 || reference.SpanHash != "" {
			return errors.New("engineering knowledge evidence contains text fields")
		}
		if !sha256Pattern.MatchString(reference.ArtifactHash) || !sha256Pattern.MatchString(reference.ValueHash) {
			return errors.New("engineering knowledge evidence requires valid artifact and value hashes")
		}
		usesPointer := reference.JSONPointer != ""
		usesCSVRow := reference.CSVRow > 0
		if usesPointer == usesCSVRow || reference.CSVRow < 0 {
			return errors.New("engineering knowledge evidence requires exactly one JSON pointer or CSV row")
		}
		if usesPointer && !strings.HasPrefix(reference.JSONPointer, "/") {
			return errors.New("engineering evidence JSON pointer must start with a slash")
		}
	default:
		return fmt.Errorf("unsupported knowledge evidence kind %q", reference.Kind)
	}
	return nil
}

type KnowledgeQualifier struct {
	Predicate string                 `json:"predicate"`
	EntityID  string                 `json:"entity_id"`
	Literal   *KnowledgeTypedLiteral `json:"literal"`
}

type KnowledgeEntity struct {
	ID            string           `json:"id"`
	Type          string           `json:"type"`
	CanonicalName string           `json:"canonical_name"`
	Aliases       []KnowledgeAlias `json:"aliases"`
}

type KnowledgeAssertion struct {
	ID              string                 `json:"id"`
	SubjectEntityID string                 `json:"subject_entity_id"`
	Predicate       string                 `json:"predicate"`
	ObjectEntityID  string                 `json:"object_entity_id"`
	ObjectLiteral   *KnowledgeTypedLiteral `json:"object_literal"`
	Qualifiers      []KnowledgeQualifier   `json:"qualifiers"`
	ValidTime       *KnowledgeTimeRange    `json:"valid_time"`
	Evidence        []KnowledgeEvidenceRef `json:"evidence"`
}

type KnowledgePatch struct {
	SchemaVersion       string               `json:"schema_version"`
	UnitRegistryVersion string               `json:"unit_registry_version"`
	Entities            []KnowledgeEntity    `json:"entities"`
	Assertions          []KnowledgeAssertion `json:"assertions"`
}

func (patch KnowledgePatch) ValidateStructure() error {
	if patch.SchemaVersion != KnowledgePatchSchemaV1 {
		return fmt.Errorf("unsupported knowledge patch schema %q", patch.SchemaVersion)
	}
	if patch.UnitRegistryVersion != CurrentUnitRegistryVersion {
		return fmt.Errorf("unsupported knowledge unit registry %q", patch.UnitRegistryVersion)
	}
	if patch.Entities == nil || patch.Assertions == nil {
		return errors.New("knowledge patch omits a required array field")
	}
	entityIDs := make(map[string]struct{}, len(patch.Entities))
	for _, entity := range patch.Entities {
		if strings.TrimSpace(entity.ID) == "" || strings.TrimSpace(entity.Type) == "" || strings.TrimSpace(entity.CanonicalName) == "" {
			return errors.New("knowledge entities require id, type, and canonical name")
		}
		if entity.Aliases == nil {
			return fmt.Errorf("knowledge entity %q omits aliases", entity.ID)
		}
		if _, duplicate := entityIDs[entity.ID]; duplicate {
			return fmt.Errorf("duplicate knowledge entity id %q", entity.ID)
		}
		entityIDs[entity.ID] = struct{}{}
		aliases := make(map[string]struct{}, len(entity.Aliases))
		for _, alias := range entity.Aliases {
			if strings.TrimSpace(alias.Value) == "" {
				return fmt.Errorf("knowledge entity %q has an empty alias", entity.ID)
			}
			key := strings.ToLower(strings.TrimSpace(alias.Language)) + "\x00" + alias.Value
			if _, duplicate := aliases[key]; duplicate {
				return fmt.Errorf("knowledge entity %q repeats alias %q", entity.ID, alias.Value)
			}
			aliases[key] = struct{}{}
		}
	}

	assertionIDs := make(map[string]struct{}, len(patch.Assertions))
	for _, assertion := range patch.Assertions {
		if strings.TrimSpace(assertion.ID) == "" || strings.TrimSpace(assertion.SubjectEntityID) == "" || strings.TrimSpace(assertion.Predicate) == "" {
			return errors.New("knowledge assertions require id, subject, and predicate")
		}
		if _, duplicate := assertionIDs[assertion.ID]; duplicate {
			return fmt.Errorf("duplicate knowledge assertion id %q", assertion.ID)
		}
		assertionIDs[assertion.ID] = struct{}{}
		if _, exists := entityIDs[assertion.SubjectEntityID]; !exists {
			return fmt.Errorf("knowledge assertion %q references unknown subject %q", assertion.ID, assertion.SubjectEntityID)
		}
		if err := validateKnowledgeValue(assertion.ObjectEntityID, assertion.ObjectLiteral, entityIDs, patch.UnitRegistryVersion); err != nil {
			return fmt.Errorf("knowledge assertion %q object: %w", assertion.ID, err)
		}
		if assertion.Qualifiers == nil || assertion.Evidence == nil {
			return fmt.Errorf("knowledge assertion %q omits qualifiers or evidence", assertion.ID)
		}
		for _, qualifier := range assertion.Qualifiers {
			if strings.TrimSpace(qualifier.Predicate) == "" {
				return fmt.Errorf("knowledge assertion %q has an empty qualifier predicate", assertion.ID)
			}
			if err := validateKnowledgeValue(qualifier.EntityID, qualifier.Literal, entityIDs, patch.UnitRegistryVersion); err != nil {
				return fmt.Errorf("knowledge assertion %q qualifier %q: %w", assertion.ID, qualifier.Predicate, err)
			}
		}
		if assertion.ValidTime != nil {
			if err := assertion.ValidTime.Validate(); err != nil {
				return fmt.Errorf("knowledge assertion %q: %w", assertion.ID, err)
			}
		}
		if len(assertion.Evidence) == 0 {
			return fmt.Errorf("knowledge assertion %q has no evidence", assertion.ID)
		}
		for _, reference := range assertion.Evidence {
			if err := reference.Validate(); err != nil {
				return fmt.Errorf("knowledge assertion %q: %w", assertion.ID, err)
			}
		}
	}
	return nil
}

func validateKnowledgeValue(entityID string, literal *KnowledgeTypedLiteral, entityIDs map[string]struct{}, unitRegistryVersion string) error {
	hasEntity := strings.TrimSpace(entityID) != ""
	hasLiteral := literal != nil
	if hasEntity == hasLiteral {
		return errors.New("exactly one entity or typed literal is required")
	}
	if hasEntity {
		if _, exists := entityIDs[entityID]; !exists {
			return fmt.Errorf("unknown entity %q", entityID)
		}
		return nil
	}
	return literal.ValidateWithUnitRegistry(unitRegistryVersion)
}

// Validate binds every text handle to the collected claim/source lineage and
// every engineering handle to an artifact explicitly included by the report.
// Byte/value hash readback is performed by the research engine against CAS.
func (patch KnowledgePatch) Validate(evidence []EvidenceBundle, artifactHashes []string) error {
	if err := patch.ValidateStructure(); err != nil {
		return err
	}
	type sourceLineage struct {
		blobHash string
	}
	sources := make(map[string]sourceLineage)
	claimSources := make(map[string]map[string]struct{})
	for _, bundle := range evidence {
		for _, source := range bundle.Sources {
			if _, duplicate := sources[source.ID]; duplicate {
				return fmt.Errorf("knowledge evidence source id %q is ambiguous", source.ID)
			}
			sources[source.ID] = sourceLineage{blobHash: source.BlobHash}
		}
		for _, claim := range bundle.Claims {
			if _, duplicate := claimSources[claim.ID]; duplicate {
				return fmt.Errorf("knowledge evidence claim id %q is ambiguous", claim.ID)
			}
			claimSources[claim.ID] = make(map[string]struct{}, len(claim.SourceIDs))
			for _, sourceID := range claim.SourceIDs {
				claimSources[claim.ID][sourceID] = struct{}{}
			}
		}
	}
	artifacts := make(map[string]struct{}, len(artifactHashes))
	for _, hash := range artifactHashes {
		artifacts[hash] = struct{}{}
	}
	for _, assertion := range patch.Assertions {
		for _, reference := range assertion.Evidence {
			switch reference.Kind {
			case KnowledgeEvidenceText:
				source, exists := sources[reference.SourceID]
				if !exists || source.blobHash != reference.BlobHash {
					return fmt.Errorf("knowledge assertion %q has an unknown or mismatched text source %q", assertion.ID, reference.SourceID)
				}
				claim, exists := claimSources[reference.ClaimID]
				if !exists {
					return fmt.Errorf("knowledge assertion %q references unknown claim %q", assertion.ID, reference.ClaimID)
				}
				if _, supports := claim[reference.SourceID]; !supports {
					return fmt.Errorf("knowledge assertion %q claim %q is not supported by source %q", assertion.ID, reference.ClaimID, reference.SourceID)
				}
			case KnowledgeEvidenceEngineering:
				if _, exists := artifacts[reference.ArtifactHash]; !exists {
					return fmt.Errorf("knowledge assertion %q references an engineering artifact absent from the report", assertion.ID)
				}
			}
		}
	}
	return nil
}

// EngineeringCompleteness is app-assembled, deterministic report metadata.
// Models never author this structure; the research core derives it from
// verified solver artifacts immediately before REVIEW.
type EngineeringCompleteness struct {
	Profile                  string                          `json:"profile"`
	EvidencePackArtifactHash string                          `json:"evidence_pack_artifact_hash"`
	InterpolationTrace       EngineeringInterpolationTrace   `json:"interpolation_trace"`
	Figures                  []EngineeringFigureReference    `json:"figures"`
	IndependentVerification  EngineeringVerificationEvidence `json:"independent_verification"`
}

type EngineeringInterpolationTrace struct {
	TargetCL       float64 `json:"target_cl"`
	CandidateCount int     `json:"candidate_count"`
	ArtifactHash   string  `json:"artifact_hash"`
	ReportTableID  string  `json:"report_table_id"`
}

type EngineeringFigureReference struct {
	Kind               string `json:"kind"`
	DataArtifactHash   string `json:"data_artifact_hash"`
	RenderArtifactHash string `json:"render_artifact_hash"`
	ReportFigureID     string `json:"report_figure_id"`
}

type EngineeringVerificationEvidence struct {
	ProvenanceArtifactHash string `json:"provenance_artifact_hash"`
	ScreeningJobID         string `json:"screening_job_id"`
	VerificationJobID      string `json:"verification_job_id"`
	ScreeningPanelCount    int    `json:"screening_panel_count"`
	VerificationPanelCount int    `json:"verification_panel_count"`
	ReportSectionID        string `json:"report_section_id"`
}

const (
	EngineeringOutcomeConfirmed    = "confirmed"
	EngineeringOutcomeInconclusive = "inconclusive"
	EngineeringGateHard            = "hard"
	EngineeringGateConclusion      = "conclusion"
)

// EngineeringAcceptanceCheck is one deterministic app-owned gate. Hard gates
// protect execution and artifact integrity before SYNTHESIZE. Conclusion
// gates qualify what the completed calculations are scientifically able to
// establish without turning an honest inconclusive result into a process
// failure.
type EngineeringAcceptanceCheck struct {
	ID             string   `json:"id"`
	Class          string   `json:"class"`
	Passed         bool     `json:"passed"`
	Detail         string   `json:"detail"`
	EvidenceHashes []string `json:"evidence_hashes"`
}

type SU2CaseEvidence struct {
	JobID                   string   `json:"job_id"`
	ReceiptArtifactID       string   `json:"receipt_artifact_id"`
	ReceiptSHA256           string   `json:"receipt_sha256"`
	MeshSizeM               float64  `json:"mesh_size_m"`
	MeshNodes               int      `json:"mesh_nodes"`
	MeshVolumeElements      int      `json:"mesh_volume_elements"`
	AirfoilBoundaryElements int      `json:"airfoil_boundary_elements"`
	CL                      float64  `json:"cl"`
	CD                      float64  `json:"cd"`
	ResidualDropOrders      float64  `json:"residual_drop_orders"`
	CLLateStddev            float64  `json:"cl_late_stddev"`
	CDLateStddev            float64  `json:"cd_late_stddev"`
	OrthogonalityAvailable  bool     `json:"orthogonality_available"`
	UpperShockXOverC        float64  `json:"upper_shock_x_over_c"`
	ArtifactHashes          []string `json:"artifact_hashes"`
}

// EngineeringAssessment is generated from immutable solver receipts and CAS
// readback. Models may interpret it but never author or alter it.
type EngineeringAssessment struct {
	Profile       string                       `json:"profile"`
	Outcome       string                       `json:"outcome"`
	OutcomeReason string                       `json:"outcome_reason"`
	Checks        []EngineeringAcceptanceCheck `json:"checks"`
	SU2Cases      []SU2CaseEvidence            `json:"su2_cases"`
}

func (assessment EngineeringAssessment) Validate() error {
	if assessment.Profile != SU2MeshStudyProfileV1 ||
		(assessment.Outcome != EngineeringOutcomeConfirmed && assessment.Outcome != EngineeringOutcomeInconclusive) ||
		strings.TrimSpace(assessment.OutcomeReason) == "" || len(assessment.Checks) == 0 || len(assessment.SU2Cases) < 3 {
		return errors.New("engineering assessment is incomplete")
	}
	caseReceipts := make(map[string]struct{}, len(assessment.SU2Cases))
	caseJobs := make(map[string]struct{}, len(assessment.SU2Cases))
	for index, item := range assessment.SU2Cases {
		if strings.TrimSpace(item.JobID) == "" || !IsEngineeringReceiptArtifactID(item.ReceiptArtifactID) ||
			!sha256Pattern.MatchString(item.ReceiptSHA256) || item.MeshSizeM <= 0 ||
			item.MeshNodes <= 0 || item.MeshVolumeElements <= 0 || item.AirfoilBoundaryElements <= 0 ||
			math.IsNaN(item.CL) || math.IsInf(item.CL, 0) || math.IsNaN(item.CD) || math.IsInf(item.CD, 0) ||
			len(item.ArtifactHashes) == 0 || !slices.Contains(item.ArtifactHashes, item.ReceiptSHA256) {
			return errors.New("engineering SU2 case evidence is invalid")
		}
		if index > 0 && item.MeshSizeM >= assessment.SU2Cases[index-1].MeshSizeM {
			return errors.New("engineering SU2 cases are not ordered coarse to fine")
		}
		if _, duplicate := caseJobs[item.JobID]; duplicate {
			return fmt.Errorf("duplicate engineering SU2 job %q", item.JobID)
		}
		if _, duplicate := caseReceipts[item.ReceiptSHA256]; duplicate {
			return fmt.Errorf("duplicate engineering SU2 receipt %q", item.ReceiptSHA256)
		}
		caseJobs[item.JobID] = struct{}{}
		caseReceipts[item.ReceiptSHA256] = struct{}{}
		artifactHashes := make(map[string]struct{}, len(item.ArtifactHashes))
		for _, hash := range item.ArtifactHashes {
			if !sha256Pattern.MatchString(hash) {
				return errors.New("engineering SU2 case contains an invalid artifact hash")
			}
			if _, duplicate := artifactHashes[hash]; duplicate {
				return errors.New("engineering SU2 case repeats an artifact hash")
			}
			artifactHashes[hash] = struct{}{}
		}
	}
	checkIDs := make(map[string]struct{}, len(assessment.Checks))
	failedConclusion := false
	for _, check := range assessment.Checks {
		if strings.TrimSpace(check.ID) == "" || strings.TrimSpace(check.Detail) == "" ||
			(check.Class != EngineeringGateHard && check.Class != EngineeringGateConclusion) {
			return errors.New("engineering acceptance check is incomplete")
		}
		if _, duplicate := checkIDs[check.ID]; duplicate {
			return fmt.Errorf("duplicate engineering acceptance check %q", check.ID)
		}
		checkIDs[check.ID] = struct{}{}
		if check.Class == EngineeringGateHard && !check.Passed {
			return fmt.Errorf("hard engineering acceptance check %q did not pass", check.ID)
		}
		if check.Class == EngineeringGateConclusion && !check.Passed {
			failedConclusion = true
		}
		for _, hash := range check.EvidenceHashes {
			if !sha256Pattern.MatchString(hash) {
				return fmt.Errorf("engineering acceptance check %q has an invalid evidence hash", check.ID)
			}
			if _, exists := caseReceipts[hash]; !exists {
				return fmt.Errorf("engineering acceptance check %q references a non-case receipt", check.ID)
			}
		}
	}
	if (assessment.Outcome == EngineeringOutcomeConfirmed && failedConclusion) ||
		(assessment.Outcome == EngineeringOutcomeInconclusive && !failedConclusion) {
		return errors.New("engineering outcome does not match its conclusion gates")
	}
	return nil
}

type ReportManifest struct {
	Title                   string                   `json:"title"`
	AnswerMarkdown          string                   `json:"answer_markdown"`
	Citations               []Citation               `json:"citations"`
	EvidenceIDs             []string                 `json:"evidence_ids"`
	ArtifactHashes          []string                 `json:"artifact_hashes"`
	Uncertainties           []string                 `json:"uncertainties"`
	KnowledgePatch          KnowledgePatch           `json:"knowledge_patch"`
	EngineeringCompleteness *EngineeringCompleteness `json:"engineering_completeness,omitempty"`
	EngineeringAssessment   *EngineeringAssessment   `json:"engineering_assessment,omitempty"`
}

func (report ReportManifest) Validate(evidence []EvidenceBundle) error {
	if strings.TrimSpace(report.Title) == "" || strings.TrimSpace(report.AnswerMarkdown) == "" {
		return errors.New("report title and answer are required")
	}
	sourceIDs := make(map[string]bool)
	claimIDs := make(map[string]bool)
	claimSources := make(map[string]map[string]bool)
	evidenceIDs := make(map[string]bool)
	for _, bundle := range evidence {
		if evidenceIDs[bundle.WorkstreamID] {
			return fmt.Errorf("duplicate evidence workstream id %q", bundle.WorkstreamID)
		}
		evidenceIDs[bundle.WorkstreamID] = true
		for _, source := range bundle.Sources {
			if sourceIDs[source.ID] {
				return fmt.Errorf("duplicate evidence source id %q across workstreams", source.ID)
			}
			sourceIDs[source.ID] = true
		}
		for _, claim := range bundle.Claims {
			if claimIDs[claim.ID] {
				return fmt.Errorf("duplicate evidence claim id %q across workstreams", claim.ID)
			}
			claimIDs[claim.ID] = true
			claimSources[claim.ID] = make(map[string]bool, len(claim.SourceIDs))
			for _, sourceID := range claim.SourceIDs {
				claimSources[claim.ID][sourceID] = true
			}
		}
	}
	if len(report.EvidenceIDs) == 0 {
		return errors.New("report has no evidence bundle references")
	}
	if len(report.EvidenceIDs) != len(evidenceIDs) {
		return errors.New("report does not reference every collected evidence bundle")
	}
	referencedEvidence := make(map[string]bool, len(report.EvidenceIDs))
	for _, evidenceID := range report.EvidenceIDs {
		if !evidenceIDs[evidenceID] {
			return fmt.Errorf("report references unknown evidence bundle %q", evidenceID)
		}
		if referencedEvidence[evidenceID] {
			return fmt.Errorf("report repeats evidence bundle %q", evidenceID)
		}
		referencedEvidence[evidenceID] = true
	}
	if len(report.Citations) == 0 {
		return errors.New("report has no citations")
	}
	markers := make(map[string]bool, len(report.Citations))
	for _, citation := range report.Citations {
		if citation.Marker == "" || len(citation.SourceIDs) == 0 || len(citation.ClaimIDs) == 0 {
			return errors.New("each report citation requires marker, sources, and claims")
		}
		if markers[citation.Marker] {
			return fmt.Errorf("duplicate citation marker %q", citation.Marker)
		}
		if !strings.Contains(report.AnswerMarkdown, citation.Marker) {
			return fmt.Errorf("citation marker %q does not appear in the report answer", citation.Marker)
		}
		markers[citation.Marker] = true
		for _, sourceID := range citation.SourceIDs {
			if !sourceIDs[sourceID] {
				return fmt.Errorf("citation %q references unknown source %q", citation.Marker, sourceID)
			}
		}
		for _, claimID := range citation.ClaimIDs {
			if !claimIDs[claimID] {
				return fmt.Errorf("citation %q references unknown claim %q", citation.Marker, claimID)
			}
			supported := false
			for _, sourceID := range citation.SourceIDs {
				if claimSources[claimID][sourceID] {
					supported = true
					break
				}
			}
			if !supported {
				return fmt.Errorf("citation %q does not include a source supporting claim %q", citation.Marker, claimID)
			}
		}
	}
	for _, hash := range report.ArtifactHashes {
		if !sha256Pattern.MatchString(hash) {
			return errors.New("report contains an invalid artifact hash")
		}
	}
	if err := report.KnowledgePatch.Validate(evidence, report.ArtifactHashes); err != nil {
		return fmt.Errorf("validate report knowledge patch: %w", err)
	}
	if report.EngineeringAssessment != nil {
		if err := report.EngineeringAssessment.Validate(); err != nil {
			return fmt.Errorf("validate engineering assessment: %w", err)
		}
	}
	return nil
}

type ReviewScores struct {
	TaskFulfillment           int `json:"task_fulfillment"`
	ClaimSupport              int `json:"claim_support"`
	SourceQuality             int `json:"source_quality"`
	Completeness              int `json:"completeness"`
	ReasoningAndUncertainty   int `json:"reasoning_and_uncertainty"`
	ClarityAndReproducibility int `json:"clarity_and_reproducibility"`
}

func (scores ReviewScores) Values() []int {
	return []int{
		scores.TaskFulfillment,
		scores.ClaimSupport,
		scores.SourceQuality,
		scores.Completeness,
		scores.ReasoningAndUncertainty,
		scores.ClarityAndReproducibility,
	}
}

type ReviewVerdict struct {
	CitationIntegrityPercent int                     `json:"citation_integrity_percent"`
	KnowledgeIntegrity       *KnowledgeIntegrity     `json:"knowledge_integrity"`
	CriticalErrors           []string                `json:"critical_errors"`
	Scores                   ReviewScores            `json:"scores"`
	RevisionRequests         []string                `json:"revision_requests"`
	RemediationAction        ReviewRemediationAction `json:"remediation_action"`
	RemediationTasks         []ReviewRemediationTask `json:"remediation_tasks"`
	Summary                  string                  `json:"summary"`
}

type ReviewRemediationAction string

const (
	ReviewRemediationNone               ReviewRemediationAction = "none"
	ReviewRemediationReportRevision     ReviewRemediationAction = "report_revision"
	ReviewRemediationAdditionalResearch ReviewRemediationAction = "additional_research"
	ReviewRemediationReplan             ReviewRemediationAction = "replan"
)

// ReviewRemediationTask describes missing evidence or computation. REVIEW may
// identify the gap, but only a fresh PLAN is allowed to turn it into an
// executable tool contract.
type ReviewRemediationTask struct {
	Objective                  string   `json:"objective"`
	RequiredEvidence           []string `json:"required_evidence"`
	RequiresEngineering        bool     `json:"requires_engineering"`
	RequiresNewSolverExecution bool     `json:"requires_new_solver_execution"`
}

// EffectiveRemediationAction keeps completed pre-remediation review artifacts
// resumable. New REVIEW responses are schema-required to set the field; an old
// empty value receives only the former report-revision behavior.
func (verdict ReviewVerdict) EffectiveRemediationAction() ReviewRemediationAction {
	if verdict.RemediationAction == "" {
		return ReviewRemediationReportRevision
	}
	return verdict.RemediationAction
}

func (action ReviewRemediationAction) RestartsResearch() bool {
	return action == ReviewRemediationAdditionalResearch || action == ReviewRemediationReplan
}

type KnowledgeIntegrity struct {
	EvidenceIntegrityPercent int `json:"evidence_integrity_percent"`
	UnsupportedAssertions    int `json:"unsupported_assertions"`
}

func (verdict ReviewVerdict) Passes() (bool, error) {
	if verdict.CitationIntegrityPercent < 0 || verdict.CitationIntegrityPercent > 100 {
		return false, errors.New("citation integrity must be between 0 and 100")
	}
	if verdict.KnowledgeIntegrity == nil {
		return false, errors.New("knowledge integrity verdict is required")
	}
	if verdict.KnowledgeIntegrity.EvidenceIntegrityPercent < 0 || verdict.KnowledgeIntegrity.EvidenceIntegrityPercent > 100 {
		return false, errors.New("knowledge evidence integrity must be between 0 and 100")
	}
	if verdict.KnowledgeIntegrity.UnsupportedAssertions < 0 {
		return false, errors.New("unsupported knowledge assertions cannot be negative")
	}
	values := verdict.Scores.Values()
	total := 0
	for _, score := range values {
		if score < 1 || score > 5 {
			return false, errors.New("review scores must be between 1 and 5")
		}
		if score < 3 {
			return false, nil
		}
		total += score
	}
	average := float64(total) / float64(len(values))
	return verdict.CitationIntegrityPercent == 100 &&
		verdict.KnowledgeIntegrity.EvidenceIntegrityPercent == 100 &&
		verdict.KnowledgeIntegrity.UnsupportedAssertions == 0 &&
		len(verdict.CriticalErrors) == 0 && average >= 4, nil
}

// PassesForReport applies the ordinary evidence gate and the stronger minimum
// required for an app-qualified engineering report. An inconclusive scientific
// outcome may pass when it is complete and reproducible; low task fulfillment
// or completeness may not be hidden by higher scores on other axes.
func (verdict ReviewVerdict) PassesForReport(report ReportManifest) (bool, error) {
	passes, err := verdict.Passes()
	if err != nil || !passes || report.EngineeringAssessment == nil {
		return passes, err
	}
	return verdict.Scores.TaskFulfillment >= 4 &&
		verdict.Scores.Completeness >= 4 &&
		verdict.Scores.ClarityAndReproducibility >= 4, nil
}

type Schedule struct {
	ID                    string     `json:"id"`
	ProjectID             string     `json:"project_id"`
	ConversationSessionID string     `json:"conversation_session_id"`
	Question              string     `json:"question"`
	Kind                  string     `json:"kind"`
	Expression            string     `json:"expression"`
	Timezone              string     `json:"timezone"`
	Enabled               bool       `json:"enabled"`
	NextRunAt             *time.Time `json:"next_run_at,omitempty"`
	LastRunAt             *time.Time `json:"last_run_at,omitempty"`
	MainThreadID          string     `json:"main_thread_id"`
	CreatedAt             time.Time  `json:"created_at"`
	UpdatedAt             time.Time  `json:"updated_at"`
}

type Approval struct {
	ID                 string    `json:"id"`
	RunID              string    `json:"run_id"`
	StageAttemptID     string    `json:"stage_attempt_id"`
	ThreadID           string    `json:"thread_id"`
	TurnID             string    `json:"turn_id"`
	ItemID             string    `json:"item_id"`
	Kind               string    `json:"kind"`
	Summary            string    `json:"summary"`
	Server             string    `json:"server,omitempty"`
	Tool               string    `json:"tool,omitempty"`
	Command            string    `json:"command,omitempty"`
	ArgumentsJSON      string    `json:"arguments_json,omitempty"`
	ArgumentsSHA256    string    `json:"arguments_sha256,omitempty"`
	Risk               string    `json:"risk"`
	ExternalSideEffect bool      `json:"external_side_effect"`
	Status             string    `json:"status"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}
