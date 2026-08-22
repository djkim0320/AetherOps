// Package research coordinates the durable, fail-closed research workflow.
//
// It deliberately depends on a small Protocol interface rather than on an
// implementation-specific Codex package. The eventual adapter owns transport,
// authentication, and conversation APIs; this package owns only orchestration
// and durable state transitions.
package research

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/store"
)

// researchTurnTimeout is deliberately fixed in the core rather than sourced
// from the environment. A long research turn may legitimately spend many
// minutes collecting or analysing evidence, but it must never hold a durable
// stage in_progress forever when an App Server tool call stops responding.
// The Codex client observes this context deadline, interrupts the matching
// turn through the protocol, and returns its thread/turn checkpoint so the
// existing fail-closed stage and run transitions can persist the failure.
const (
	researchTurnTimeout                 = 2 * time.Hour
	maxPlanCapabilityRecoveryAttempts   = 3
	engineeringVerificationWorkflowKind = "engineering_verification"
	engineeringVerificationWorkstreamID = "aetherops_engineering_verification"
	collectEngineeringPolicy            = "When this workstream requires modeling or aerodynamic analysis, use only typed aetherops_engineering tools with the supplied run and attempt IDs; never construct raw solver commands or scripts. " +
		"The aetherops_engineering server is a bundled first-party capability and is intentionally absent from aetherops_internal.tool_catalog, which lists only user-approved project extensions. Never treat an empty project tool catalog as evidence that a matching bundled engineering tool is unavailable, and never require a Skill or declarative adapter when a typed bundled tool already covers the requested operation. Call matching bundled tools directly. " +
		"Every successful engineering call is already persisted in run-owned SQLite/CAS and is injected into SYNTHESIZE and REVIEW separately. For each computed claim, copy only the result's top-level receipt_artifact_id into engineering_receipt_artifact_ids and cite that same opaque artifact id in source_ids. A receipt artifact id is exactly art_ followed by 32 lowercase hexadecimal characters. Never use a 64-character cas_blob_sha256 or evidence_handles artifact_hash as an artifact id, put engineering provenance in sources, transcribe a receipt hash or timestamp, repackage a receipt with evidence_capture, or invent an engineering source URL. AetherOps verifies run/attempt ownership and deterministically rehydrates the complete EvidenceSource from immutable receipt metadata. " +
		"After every successful solver call, retain only its job_id, receipt_artifact_id, and a compact derived comparison in working context; never aggregate complete tool results or print an entire raw sample array. If the result is needed again, call aetherops_engineering.engineering_get with that job_id. Never call an engineering solver again with an already-successful exact argument set because encoding, summarization, evidence capture, or other post-processing failed. " +
		"For su2_naca0012, submit exactly these six JSON keys and no aliases: alpha_deg, iterations, mach, mesh_size_m, run_id, stage_attempt_id. The correct names are alpha_deg and iterations; never use aoa_deg, angle_of_attack, max_iterations, iteration_limit, or any other synonym. Keep run_id and stage_attempt_id exactly as supplied to this workstream. " +
		"For a plan with xfoil_screening, AetherOps Go core has already materialized, authorized, and executed every candidate at every operating point, meaning every Cartesian screening cell exactly once, before this collector turn starts. This immutable core execution overrides any workstream prose that asks to skip or shrink cells. Never call xfoil_polar with execution_purpose=screening and never repeat, shrink, replace, or extend that matrix. Return public-source analysis when useful; the core deterministically rehydrates every run-owned XFOIL receipt and its audit claim into this bundle after your output. Do not invent or guess receipt ids. For one scalar point AetherOps starts a separate verification attempt with execution_purpose=independent_verification after collection; for a non-empty matrix the exact cell receipts are the bounded workflow proof and no single cell may be presented as verification of the whole matrix."
	engineeringVerificationContractPolicy = "The automatic winner-only independent verification deliberately uses panel_count=240 and alpha_step_deg=0.05 over a one-degree local alpha window centered on the screening interpolation for target_cl (approximately target_alpha-0.5 through target_alpha+0.5, with safe outward endpoint quantization). It preserves the physical and optimization conditions but does not repeat the full screening alpha_start_deg/alpha_end_deg range. This local target-window contract is the required independent verification, not a defect or an incomplete full polar sweep. Never require or request a second full-range verification run."
	engineeringPlanningPolicy             = "AetherOps exposes bundled first-party typed engineering tools through aetherops_engineering. They are intentionally not returned by aetherops_internal.tool_catalog, which contains only user-approved project extensions. Plan directly against a matching bundled tool and never add a Tool Studio capability gate, Skill requirement, or declarative adapter requirement for an operation already covered by aetherops_engineering. Put one dedicated engineering execution workstream at COLLECT ordinal 0 whenever any solver execution is required; that owner must execute every requested solver case in the complete plan, and all other collectors perform public-source research without repeating solver calls. The bundled su2_naca0012 tool generates its own fixed closed-trailing-edge NACA0012 Gmsh mesh on x/c=[-10,15], y/c=[-10,10] and runs steady Euler SU2_CFD with JST. Every NACA0012 mesh-sensitivity plan must populate su2_mesh_study with profile=su2_naca0012_grid_sensitivity/v1, domain_profile=rect_xm10_xp15_ym10_yp10/v1, objective=assess_grid_sensitivity, reference_comparison=qualitative_context, and the exact coarse-to-fine mesh_sizes_m list. The owner must execute every requested mesh_size_m case exactly once. Never promise a 20c domain, C-grid topology, or quantitative reference overlay because the bundled workflow does not implement them. Every su2_naca0012 call must keep iterations between 20 and 1000 inclusive and mesh_size_m between 0.01 and 0.2 inclusive; choose 1000 iterations when the study asks for the strongest available convergence attempt. The receipt exposes deterministic mesh counts and quality bounds, a common final-50-iteration CL/CD stability window, reconstructed surface spacing, and an objective maximum-interior-Cp-gradient shock locator; require the final report to compare those values and to attach each case's verified mesh, history, surface, config, log, and receipt artifacts. " +
		"When xfoil_screening is present, plan at least one COLLECT workstream that executes every listed screening candidate at every declared operating point through the typed xfoil_polar tool. Compose repeated uses of an existing typed tool with the bounded operating_points matrix instead of declaring a capability gap merely because several Reynolds, Mach, ncrit, target_cl, or minimum_cm conditions are required. Keep the Cartesian product at 64 calls or fewer. Never silently shrink the user's condition set. For an empty operating_points array (one scalar point), never declare requested winner-only independent verification unsupported: after all screening receipts are verified, AetherOps itself selects the winner and starts the isolated verification defined below. For a non-empty matrix, do not claim a single cell is a globally verified winner; require complete matrix receipts, cross-condition ranking, and explicit uncertainty instead. The PLAN describes the applicable backend step in its acceptance criteria but must not assign it to a collector. " + engineeringVerificationContractPolicy
)

var (
	// ErrMainThreadMissing means a project cannot safely run a main-thread stage.
	ErrMainThreadMissing = errors.New("research project main thread is missing")
	// ErrMainThreadMismatch means the immutable run checkpoint no longer agrees
	// with the project's configured main thread.
	ErrMainThreadMismatch = errors.New("research run main thread does not match project")
	// ErrRunNotRunnable means Execute was called for a status other than queued
	// or an explicitly resumed interrupted run.
	ErrRunNotRunnable = errors.New("research run is not runnable")
	// ErrUncertainResume is intentionally terminal for automatic orchestration:
	// a run with uncertain side effects must be resolved by a user.
	ErrUncertainResume = errors.New("uncertain research run must not be resumed automatically")
	// ErrUnsafeResume means no fully durable, structured checkpoint exists from
	// which an interrupted run can continue without replaying a turn.
	ErrUnsafeResume = errors.New("interrupted research run has no safe checkpoint")
	// ErrTurnInterrupted is returned by a live protocol adapter after an
	// explicit browser handoff or emergency stop interrupts the App Server turn.
	ErrTurnInterrupted = errors.New("research turn was interrupted")
	// ErrNoActiveTurn means a steering message arrived outside the short window
	// in which the selected run has an in-flight Codex turn.
	ErrNoActiveTurn = errors.New("research run has no active Codex turn")
	// ErrUnsupportedResearchProfile prevents an unversioned or unknown run from
	// silently inheriting whatever model settings happen to be current.
	ErrUnsupportedResearchProfile = errors.New("unsupported research profile version")
	// ErrRunStateChanged means another writer changed more than the temporary
	// waiting-for-approval state while this engine owned a stage. Approval
	// round-trips are reconciled explicitly; every other optimistic-concurrency
	// conflict remains fail-closed.
	ErrRunStateChanged = errors.New("research run state changed concurrently")
)

// ModelProfile is the exact model configuration required for a workflow stage.
// Names are compared literally; aliases and silent effort changes are rejected.
type ModelProfile struct {
	Model           string
	ReasoningEffort string
	ServiceTier     string
}

func profileForStage(version string, stage core.Stage) (ModelProfile, error) {
	if version != core.CurrentResearchProfileVersion {
		return ModelProfile{}, fmt.Errorf("%w %q", ErrUnsupportedResearchProfile, version)
	}
	switch stage {
	case core.StagePlan, core.StageSynthesize, core.StageRevise:
		return ModelProfile{Model: core.PlannerModel, ReasoningEffort: core.PlannerEffort, ServiceTier: core.ServiceTierDefault}, nil
	case core.StageCollect:
		return ModelProfile{Model: core.CollectorModel, ReasoningEffort: core.CollectorEffort, ServiceTier: core.ServiceTierDefault}, nil
	case core.StageReview:
		return ModelProfile{Model: core.ReviewerModel, ReasoningEffort: core.ReviewerEffort, ServiceTier: core.ServiceTierDefault}, nil
	default:
		return ModelProfile{}, fmt.Errorf("research profile %q does not define stage %q", version, stage)
	}
}

func validateResearchProfileVersion(version string) error {
	for _, stage := range []core.Stage{core.StagePlan, core.StageCollect, core.StageSynthesize, core.StageReview, core.StageRevise} {
		if _, err := profileForStage(version, stage); err != nil {
			return err
		}
	}
	return nil
}

// TurnOptions is the complete model-facing contract for one structured turn.
// Schema is always a fixed schema from core, never a model-supplied schema.
type TurnOptions struct {
	Model           string
	ReasoningEffort string
	ServiceTier     string
	Schema          json.RawMessage
	Prompt          string
}

// TurnResult is the protocol adapter's final structured result. Output must be
// one JSON object conforming to the schema supplied in TurnOptions.
type TurnResult struct {
	ThreadID        string
	TurnID          string
	Model           string
	ReasoningEffort string
	ServiceTier     string
	Output          json.RawMessage
}

// Protocol is the intentionally small boundary to a Codex/App Server adapter.
// ValidateModel must verify that the exact named model and reasoning effort are
// currently selectable before a thread is created or a turn is submitted.
type Protocol interface {
	ValidateModel(ctx context.Context, model, reasoningEffort, serviceTier string) error
	CreateThread(ctx context.Context, profile ModelProfile) (string, error)
	Turn(ctx context.Context, threadID string, options TurnOptions) (TurnResult, error)
	Steer(ctx context.Context, threadID, message string) error
}

// XFOILMatrixRunner is the app-owned numerical boundary for a planned XFOIL
// screening matrix. The research core supplies only the immutable PLAN values;
// the implementation owns typed solver validation, at-most-once execution,
// and CAS receipts.
type XFOILMatrixRunner interface {
	CanonicalXFOILScreeningArguments(runID, attemptID string, plan core.XFOILScreeningPlan, point core.XFOILOperatingPoint, deflection float64) ([]byte, error)
	RunXFOILScreeningCell(context.Context, string, string, core.XFOILScreeningPlan, core.XFOILOperatingPoint, float64) (string, error)
}

// XFOILMatrixAuthorizer presents one user decision for the complete bounded
// matrix and durably expands an approval into exact per-cell scopes. A denied
// matrix is terminal for the owning stage; it is never handed back to the
// model as an invitation to try altered cells.
type XFOILMatrixAuthorizer interface {
	AuthorizeXFOILScreening(context.Context, core.Run, core.StageAttempt, [][]byte) error
}

// Config provides the durable dependencies of an Engine.
type Config struct {
	DB              *store.DB
	CAS             *cas.Store
	Protocol        Protocol
	ProductBuild    buildinfo.ProductBuildBinding
	XFOILRunner     XFOILMatrixRunner
	XFOILAuthorizer XFOILMatrixAuthorizer
}

// Engine owns workflow state. It is safe to use one Engine for independent
// runs; store.DB provides the optimistic concurrency boundary between callers.
type Engine struct {
	db              *store.DB
	cas             *cas.Store
	protocol        Protocol
	productBuild    buildinfo.ProductBuildBinding
	xfoilRunner     XFOILMatrixRunner
	xfoilAuthorizer XFOILMatrixAuthorizer
	// turnTimeout is initialized from the fixed production contract above. It
	// remains private so release execution cannot override it; package tests use
	// a short duration to exercise the real deadline and durability path.
	turnTimeout time.Duration

	activeMu      sync.Mutex
	activeThreads map[string]map[string]struct{}
}

// New validates durable dependencies. No fallback protocol or in-memory store
// is constructed: an unavailable dependency is an error.
func New(config Config) (*Engine, error) {
	if config.DB == nil {
		return nil, errors.New("research database is required")
	}
	if config.CAS == nil {
		return nil, errors.New("research CAS is required")
	}
	if config.Protocol == nil {
		return nil, errors.New("research protocol is required")
	}
	if err := config.ProductBuild.Validate(); err != nil {
		return nil, fmt.Errorf("research product build is required: %w", err)
	}
	return &Engine{
		db: config.DB, cas: config.CAS, protocol: config.Protocol, productBuild: config.ProductBuild,
		xfoilRunner: config.XFOILRunner, xfoilAuthorizer: config.XFOILAuthorizer,
		turnTimeout:   researchTurnTimeout,
		activeThreads: make(map[string]map[string]struct{}),
	}, nil
}

// Steer appends a message to every in-flight turn owned by runID. Most stages
// have one active turn; COLLECT may have up to three independent turns, so the
// same correction is delivered to each collector concurrently.
func (engine *Engine) Steer(ctx context.Context, runID, message string) error {
	if ctx == nil {
		return errors.New("research context is required")
	}
	runID = strings.TrimSpace(runID)
	message = strings.TrimSpace(message)
	if runID == "" || message == "" {
		return errors.New("research run id and steering message are required")
	}
	if _, err := engine.db.Run(ctx, runID); err != nil {
		return err
	}
	threads := engine.activeThreadSnapshot(runID)
	if len(threads) == 0 {
		return ErrNoActiveTurn
	}

	var wait sync.WaitGroup
	errorsByThread := make(chan error, len(threads))
	accepted := make(chan struct{}, len(threads))
	for _, threadID := range threads {
		threadID := threadID
		wait.Add(1)
		go func() {
			defer wait.Done()
			if err := engine.protocol.Steer(ctx, threadID, message); err != nil {
				errorsByThread <- fmt.Errorf("steer thread %s: %w", threadID, err)
				return
			}
			accepted <- struct{}{}
		}()
	}
	wait.Wait()
	close(errorsByThread)
	close(accepted)
	if len(accepted) > 0 {
		return nil
	}
	var steerErrors []error
	for err := range errorsByThread {
		steerErrors = append(steerErrors, err)
	}
	return errors.Join(steerErrors...)
}

func (engine *Engine) activateThread(runID, threadID string) func() {
	engine.activeMu.Lock()
	if engine.activeThreads[runID] == nil {
		engine.activeThreads[runID] = make(map[string]struct{})
	}
	engine.activeThreads[runID][threadID] = struct{}{}
	engine.activeMu.Unlock()
	return func() {
		engine.activeMu.Lock()
		delete(engine.activeThreads[runID], threadID)
		if len(engine.activeThreads[runID]) == 0 {
			delete(engine.activeThreads, runID)
		}
		engine.activeMu.Unlock()
	}
}

func (engine *Engine) activeThreadSnapshot(runID string) []string {
	engine.activeMu.Lock()
	defer engine.activeMu.Unlock()
	threads := make([]string, 0, len(engine.activeThreads[runID]))
	for threadID := range engine.activeThreads[runID] {
		threads = append(threads, threadID)
	}
	return threads
}

// Execute runs a queued research run or explicitly continues a safe,
// interrupted run. An uncertain run is never resumed here.
func (engine *Engine) Execute(ctx context.Context, runID string) (core.Run, error) {
	if ctx == nil {
		return core.Run{}, errors.New("research context is required")
	}
	if strings.TrimSpace(runID) == "" {
		return core.Run{}, errors.New("research run id is required")
	}
	run, err := engine.db.Run(ctx, runID)
	if err != nil {
		return core.Run{}, err
	}
	if run.Status == core.RunQueued || run.Status == core.RunInterrupted {
		if run.ProductBuild != engine.productBuild {
			return run, fmt.Errorf("%w: run %s belongs to a different product build", ErrUnsafeResume, run.ID)
		}
		if err := engine.db.VerifyKnowledgeSnapshot(ctx, run.ProjectID, run.KnowledgeGenerationID, engine.cas); err != nil {
			markErr := engine.db.MarkKnowledgeHeadFailedForGeneration(context.WithoutCancel(ctx), run.ProjectID, run.KnowledgeGenerationID, err)
			if markErr != nil {
				err = errors.Join(err, fmt.Errorf("mark corrupt knowledge head failed: %w", markErr))
			}
			return engine.abort(ctx, run, fmt.Errorf("verify run-pinned knowledge generation: %w", err))
		}
	}

	switch run.Status {
	case core.RunQueued:
		return engine.executeQueued(ctx, run)
	case core.RunInterrupted:
		return engine.resumeInterrupted(ctx, run)
	case core.RunUncertain:
		return run, fmt.Errorf("%w: %s", ErrUncertainResume, run.ID)
	default:
		return run, fmt.Errorf("%w: %s is %s", ErrRunNotRunnable, run.ID, run.Status)
	}
}

func (engine *Engine) executeQueued(ctx context.Context, run core.Run) (core.Run, error) {
	if err := ctx.Err(); err != nil {
		return engine.abort(ctx, run, err)
	}
	var err error
	run, err = engine.transition(ctx, run, core.RunPlanning)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			return engine.abort(ctx, run, err)
		}
		return run, err
	}
	if err := validateResearchProfileVersion(run.ResearchProfileVersion); err != nil {
		return engine.abort(ctx, run, err)
	}
	if err := engine.requireMainThread(ctx, run); err != nil {
		return engine.abort(ctx, run, err)
	}

	plan, err := engine.plan(ctx, run)
	if err != nil {
		return engine.abort(ctx, run, err)
	}
	return engine.continueAfterPlan(ctx, run, plan, nil)
}

// resumeInterrupted uses only completed, published structured outputs as
// checkpoints. It never resends an in-flight turn. Callers should invoke this
// path only after an explicit user decision to resume the interrupted run.
func (engine *Engine) resumeInterrupted(ctx context.Context, run core.Run) (core.Run, error) {
	if err := ctx.Err(); err != nil {
		return engine.abort(ctx, run, err)
	}
	if err := validateResearchProfileVersion(run.ResearchProfileVersion); err != nil {
		return run, err
	}
	if err := engine.requireMainThread(ctx, run); err != nil {
		return run, err
	}
	checkpoint, err := engine.loadCheckpoint(ctx, run)
	if err != nil {
		return run, err
	}

	if checkpoint.plan == nil {
		if checkpoint.hasAttempts {
			return run, fmt.Errorf("%w: stages exist without a plan checkpoint", ErrUnsafeResume)
		}
		run, err = engine.transitionFromInterrupted(ctx, run, core.RunPlanning)
		if err != nil {
			return run, err
		}
		plan, err := engine.plan(ctx, run)
		if err != nil {
			return engine.abort(ctx, run, err)
		}
		return engine.continueAfterPlan(ctx, run, plan, nil)
	}

	plan := *checkpoint.plan
	if missing := missingWorkstreams(plan, checkpoint.evidence); len(missing) > 0 {
		if len(checkpoint.reports) != 0 || len(checkpoint.reviews) != 0 {
			return run, fmt.Errorf("%w: later checkpoints exist while collectors are missing", ErrUnsafeResume)
		}
		run, err = engine.transitionFromInterrupted(ctx, run, core.RunCollecting)
		if err != nil {
			return run, err
		}
		return engine.continueCollection(ctx, run, plan, checkpoint.evidence)
	}
	screeningJobIDs, screeningCandidates, err := engine.xfoilScreeningJobIDs(ctx, run.ID)
	if err != nil {
		return run, err
	}
	if screeningCandidates >= 2 {
		if len(screeningJobIDs) < 2 {
			return run, fmt.Errorf("%w: multi-candidate XFOIL sweep has fewer than two successful screening receipts", ErrUnsafeResume)
		}
		if _, verified := checkpoint.evidence[engineeringVerificationWorkstreamID]; !verified {
			if len(checkpoint.reports) != 0 || len(checkpoint.reviews) != 0 {
				return run, fmt.Errorf("%w: later checkpoints exist without engineering verification", ErrUnsafeResume)
			}
			run, err = engine.transitionFromInterrupted(ctx, run, core.RunCollecting)
			if err != nil {
				return run, err
			}
			return engine.continueCollection(ctx, run, plan, checkpoint.evidence)
		}
	}

	point, err := checkpoint.resumePoint()
	if err != nil {
		return run, err
	}
	if err := validateResumeCycle(run, point); err != nil {
		return run, fmt.Errorf("%w: %v", ErrUnsafeResume, err)
	}
	evidence, err := orderedEvidence(plan, checkpoint.evidence)
	if err != nil {
		return run, fmt.Errorf("%w: %v", ErrUnsafeResume, err)
	}
	switch point.action {
	case resumeSynthesize:
		run, err = engine.transitionFromInterrupted(ctx, run, core.RunSynthesizing)
		if err != nil {
			return run, err
		}
		report, err := engine.synthesize(ctx, run, plan, evidence)
		if err != nil {
			return engine.abort(ctx, run, err)
		}
		run, err = engine.transitionFromInterrupted(ctx, run, core.RunReviewing)
		if err != nil {
			return engine.abort(ctx, run, err)
		}
		return engine.runReviewCycles(ctx, run, plan, evidence, report, 0, map[int]core.ReviewVerdict{}, map[int]core.ReportManifest{})
	case resumeReview:
		run, err = engine.transition(ctx, run, core.RunReviewing)
		if err != nil {
			return run, err
		}
		return engine.runReviewCycles(ctx, run, plan, evidence, point.report, point.cycle, checkpoint.reviews, checkpoint.reports)
	case resumeRevise:
		run, err = engine.transitionFromInterrupted(ctx, run, core.RunRevising)
		if err != nil {
			return run, err
		}
		return engine.runReviewCycles(ctx, run, plan, evidence, point.report, point.cycle, checkpoint.reviews, checkpoint.reports)
	case resumeSucceed:
		run, err = engine.transitionFromInterrupted(ctx, run, core.RunReviewing)
		if err != nil {
			return run, err
		}
		completed, err := engine.succeed(ctx, run)
		if err != nil {
			return engine.abort(ctx, run, err)
		}
		return completed, nil
	case resumeQualityFailed:
		run, err = engine.transitionFromInterrupted(ctx, run, core.RunReviewing)
		if err != nil {
			return run, err
		}
		completed, err := engine.transition(ctx, run, core.RunQualityFailed)
		if err != nil {
			return engine.abort(ctx, run, err)
		}
		return completed, nil
	default:
		return run, fmt.Errorf("%w: unknown checkpoint continuation", ErrUnsafeResume)
	}
}

func validateResumeCycle(run core.Run, point checkpointResumePoint) error {
	switch point.action {
	case resumeSynthesize:
		if run.RevisionCycle != 0 {
			return errors.New("synthesis checkpoint has a nonzero revision cycle")
		}
	case resumeReview, resumeSucceed, resumeQualityFailed:
		if run.RevisionCycle != point.cycle {
			return fmt.Errorf("run revision cycle is %d, want %d", run.RevisionCycle, point.cycle)
		}
	case resumeRevise:
		if run.RevisionCycle != point.cycle && run.RevisionCycle != point.cycle+1 {
			return fmt.Errorf("run revision cycle is %d, want %d or %d", run.RevisionCycle, point.cycle, point.cycle+1)
		}
	default:
		return errors.New("unknown checkpoint continuation")
	}
	return nil
}

func (engine *Engine) continueAfterPlan(
	ctx context.Context,
	run core.Run,
	plan core.ResearchPlan,
	existing map[string]core.EvidenceBundle,
) (core.Run, error) {
	var err error
	if run.Status != core.RunCollecting {
		run, err = engine.transition(ctx, run, core.RunCollecting)
		if err != nil {
			return engine.abort(ctx, run, err)
		}
	}
	return engine.continueCollection(ctx, run, plan, existing)
}

func (engine *Engine) continueCollection(
	ctx context.Context,
	run core.Run,
	plan core.ResearchPlan,
	existing map[string]core.EvidenceBundle,
) (core.Run, error) {
	evidence, err := engine.collect(ctx, run, plan, existing)
	if err != nil {
		return engine.abort(ctx, run, err)
	}
	evidence, err = engine.ensureEngineeringVerification(ctx, run, plan, evidence, existing)
	if err != nil {
		return engine.abort(ctx, run, err)
	}
	if err := validateGlobalEvidenceIdentity(evidence); err != nil {
		return engine.abort(ctx, run, fmt.Errorf("validate collected evidence identity: %w", err))
	}
	run, err = engine.transition(ctx, run, core.RunSynthesizing)
	if err != nil {
		return engine.abort(ctx, run, err)
	}
	report, err := engine.synthesize(ctx, run, plan, evidence)
	if err != nil {
		return engine.abort(ctx, run, err)
	}
	run, err = engine.transition(ctx, run, core.RunReviewing)
	if err != nil {
		return engine.abort(ctx, run, err)
	}
	return engine.runReviewCycles(ctx, run, plan, evidence, report, 0, map[int]core.ReviewVerdict{}, map[int]core.ReportManifest{})
}

func (engine *Engine) plan(ctx context.Context, run core.Run) (core.ResearchPlan, error) {
	var plan core.ResearchPlan
	profile, err := profileForStage(run.ResearchProfileVersion, core.StagePlan)
	if err != nil {
		return plan, err
	}
	recoveryFeedback := ""
	for recoveryAttempt := 1; recoveryAttempt <= maxPlanCapabilityRecoveryAttempts; recoveryAttempt++ {
		plan = core.ResearchPlan{}
		err = engine.runStage(
			ctx, run, core.StagePlan, 0, run.MainThreadID, profile,
			core.PlanSchema(), planInput{
				Question: run.Question, EngineeringPolicy: engineeringPlanningPolicy,
				CapabilityRecoveryFeedback: recoveryFeedback,
			}, "research.plan",
			func(output json.RawMessage) error {
				candidate, err := decodeStrict[core.ResearchPlan](output)
				if err != nil {
					return err
				}
				// The run owns the immutable research question. The model plans the
				// workstreams and acceptance contract; it must not be trusted to echo a
				// potentially large, multilingual question byte-for-byte.
				candidate.Question = run.Question
				candidate, err = stripStageCapabilityIdentity(candidate)
				if err != nil {
					return err
				}
				if err := validateResearchPlan(candidate); err != nil {
					return err
				}
				plan = candidate
				return nil
			},
			func(json.RawMessage) (json.RawMessage, error) {
				return json.Marshal(plan)
			},
		)
		if err == nil || recoveryAttempt == maxPlanCapabilityRecoveryAttempts || !isRecoverablePlanContractError(err) {
			return plan, err
		}
		failedAttempt, checkpointErr := engine.db.LatestStageAttempt(context.WithoutCancel(ctx), run.ID)
		if checkpointErr != nil {
			return plan, errors.Join(err, fmt.Errorf("load failed PLAN recovery checkpoint: %w", checkpointErr))
		}
		if failedAttempt.Stage != core.StagePlan || failedAttempt.Status != "failed" {
			return plan, errors.Join(err, errors.New("latest PLAN recovery checkpoint is not a failed PLAN attempt"))
		}
		if checkpointErr := engine.db.PreparePlanContractRetry(
			context.WithoutCancel(ctx), run.ID, failedAttempt.ID,
		); checkpointErr != nil {
			return plan, errors.Join(err, fmt.Errorf("prepare PLAN contract retry: %w", checkpointErr))
		}
		activated, activationErr := engine.activatePlanRecoverySkills(context.WithoutCancel(ctx), run)
		if activationErr != nil {
			return plan, errors.Join(err, fmt.Errorf("activate bounded PLAN recovery skills: %w", activationErr))
		}
		recoveryFeedback = fmt.Sprintf(
			"PLAN attempt %d was rejected by the deterministic Go contract: %v. Do not repeat the same unsupported plan and do not silently narrow the user's scope. Re-read tool_catalog and the typed engineering capability descriptions. Compose bounded repeated uses of an existing typed tool through schema-supported declarative fields such as operating_points. If a reusable instruction capability is genuinely missing, propose a project Skill; same-run hash-validated Skill proposals may be activated before this retry. External HTTPS adapters, new executables, arbitrary commands, and write-capable tools still require user approval. Newly activated same-run skills: %s.",
			recoveryAttempt, err, strings.Join(activated, ", "),
		)
	}
	return plan, err
}

func isRecoverablePlanContractError(err error) bool {
	if err == nil || !strings.Contains(err.Error(), "validate plan JSON:") {
		return false
	}
	message := strings.ToLower(err.Error())
	for _, marker := range []string{
		"xfoil_screening", "xfoil screening", "tool package", "capability contract",
		"typed tool", "bounded workflow",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

func (engine *Engine) activatePlanRecoverySkills(ctx context.Context, run core.Run) ([]string, error) {
	packages, err := engine.db.ListToolPackages(ctx, run.ProjectID)
	if err != nil {
		return nil, err
	}
	activated := make([]string, 0)
	for _, pkg := range packages {
		if pkg.State != "pending_approval" || pkg.Kind != "skill" || pkg.SourceRunID != run.ID ||
			strings.TrimSpace(pkg.SourceStageAttemptID) == "" {
			continue
		}
		current, err := engine.db.ActivateToolPackage(ctx, run.ProjectID, pkg.ID)
		if err != nil {
			return nil, err
		}
		activated = append(activated, current.Name+"@"+current.Version)
	}
	return activated, nil
}

func (engine *Engine) collect(
	ctx context.Context,
	run core.Run,
	plan core.ResearchPlan,
	existing map[string]core.EvidenceBundle,
) ([]core.EvidenceBundle, error) {
	if err := plan.Validate(); err != nil {
		return nil, err
	}
	if existing == nil {
		existing = map[string]core.EvidenceBundle{}
	}
	bundles := make([]core.EvidenceBundle, len(plan.Workstreams))
	missing := missingWorkstreams(plan, existing)
	for index, workstream := range plan.Workstreams {
		if bundle, ok := existing[workstream.ID]; ok {
			if err := validateEvidenceBundle(bundle, workstream.ID); err != nil {
				return nil, fmt.Errorf("checkpoint workstream %q: %w", workstream.ID, err)
			}
			bundles[index] = bundle
		}
	}
	if len(missing) == 0 {
		return bundles, nil
	}

	workerContext, cancel := context.WithCancel(ctx)
	defer cancel()
	jobs := make(chan int, len(missing))
	results := make(chan collectOutcome, len(missing))
	for _, index := range missing {
		jobs <- index
	}
	close(jobs)

	workers := collectionWorkerCount(len(missing))
	var group sync.WaitGroup
	var quiesceOnce sync.Once
	var quiesceErr error
	group.Add(workers)
	for range workers {
		go func() {
			defer group.Done()
			for index := range jobs {
				if err := workerContext.Err(); err != nil {
					results <- collectOutcome{index: index, err: err}
					continue
				}
				bundle, err := engine.collectWorkstream(workerContext, run, plan, index)
				if err != nil {
					// A real collector failure makes the whole collection unusable.
					// Close the durable run (and therefore every pending approval)
					// before cancelling or waiting for sibling workers. Context
					// cancellation propagated from that first failure is not a
					// second terminal cause.
					if isSubstantiveCollectFailure(err) {
						quiesceOnce.Do(func() {
							quiesced, abortErr := engine.abort(context.WithoutCancel(ctx), run, err)
							if !core.IsTerminal(quiesced.Status) && quiesced.Status != core.RunUncertain {
								quiesceErr = fmt.Errorf("quiesce collection after first worker failure: %w", abortErr)
							}
						})
						if quiesceErr != nil {
							err = errors.Join(err, quiesceErr)
						}
					}
					cancel()
				}
				results <- collectOutcome{index: index, bundle: bundle, err: err}
			}
		}()
	}

	outcomes := make(map[int]collectOutcome, len(missing))
	for range missing {
		outcome := <-results
		outcomes[outcome.index] = outcome
	}
	group.Wait()

	var first error
	for _, index := range missing {
		outcome := outcomes[index]
		if outcome.err == nil {
			bundles[index] = outcome.bundle
			continue
		}
		if first == nil || (errors.Is(first, context.Canceled) && !errors.Is(outcome.err, context.Canceled)) {
			first = outcome.err
		}
	}
	if first != nil {
		return nil, first
	}
	return bundles, nil
}

type collectOutcome struct {
	index  int
	bundle core.EvidenceBundle
	err    error
}

func collectionWorkerCount(workstreams int) int {
	workers := runtime.NumCPU()
	if workers < 1 {
		workers = 1
	}
	if workers > core.MaxCollectors {
		workers = core.MaxCollectors
	}
	if workers > workstreams {
		workers = workstreams
	}
	return workers
}

func (engine *Engine) collectWorkstream(
	ctx context.Context,
	run core.Run,
	plan core.ResearchPlan,
	index int,
) (core.EvidenceBundle, error) {
	if index < 0 || index >= len(plan.Workstreams) {
		return core.EvidenceBundle{}, errors.New("collector workstream index is outside plan")
	}
	workstream := plan.Workstreams[index]
	var bundle core.EvidenceBundle
	profile, err := profileForStage(run.ResearchProfileVersion, core.StageCollect)
	if err != nil {
		return bundle, err
	}
	engineeringPolicy, screeningRole := engineeringPolicyForCollector(index)
	var beforeTurn func(context.Context, core.StageAttempt) error
	if index == core.EngineeringScreeningOwnerOrdinal && plan.XFOILScreening != nil {
		beforeTurn = func(stageContext context.Context, attempt core.StageAttempt) error {
			return engine.executePlannedXFOILScreening(stageContext, run, attempt, *plan.XFOILScreening)
		}
	}
	err = engine.runStageWithBeforeTurn(
		ctx, run, core.StageCollect, index, "", profile,
		core.EvidenceSchema(), collectInput{
			Question:           run.Question,
			Plan:               plan,
			Workstream:         workstream,
			SourceRequirements: plan.SourceRequirements,
			EngineeringPolicy:  engineeringPolicy,
			ScreeningRole:      screeningRole,
		}, "research.evidence", beforeTurn,
		func(output json.RawMessage) error {
			candidate, err := engine.prepareCollectorEvidence(ctx, run.ID, index, workstream.ID, &plan, output)
			if err != nil {
				return err
			}
			if index == core.EngineeringScreeningOwnerOrdinal {
				if err := engine.verifyPlannedXFOILScreeningCoverage(ctx, run.ID, plan, candidate); err != nil {
					return fmt.Errorf("verify planned XFOIL screening sweep: %w", err)
				}
			}
			bundle = candidate
			return nil
		},
		canonicalEvidenceOutput(&bundle),
	)
	return bundle, err
}

func (engine *Engine) ensureEngineeringVerification(
	ctx context.Context,
	run core.Run,
	plan core.ResearchPlan,
	evidence []core.EvidenceBundle,
	existing map[string]core.EvidenceBundle,
) ([]core.EvidenceBundle, error) {
	if len(evidence) == 0 {
		return nil, errors.New("engineering verification requires the owner collector evidence")
	}
	if err := engine.verifyPlannedXFOILScreeningCoverage(
		ctx, run.ID, plan, evidence[core.EngineeringScreeningOwnerOrdinal],
	); err != nil {
		return nil, fmt.Errorf("revalidate planned XFOIL screening sweep: %w", err)
	}
	// The legacy independent-verification adapter proves one homogeneous
	// operating point. A heterogeneous matrix is instead protected by exact
	// Cartesian coverage and receipt readback for every cell. Pretending that
	// one cell verifies the whole matrix would be a silent capability fallback.
	if plan.XFOILScreening != nil && len(plan.XFOILScreening.OperatingPoints) > 0 {
		return evidence, nil
	}
	screeningJobIDs, screeningCandidates, err := engine.xfoilScreeningJobIDs(ctx, run.ID)
	if err != nil {
		return nil, err
	}
	if screeningCandidates < 2 {
		return evidence, nil
	}
	if len(screeningJobIDs) < 2 {
		return nil, errors.New("multi-candidate XFOIL sweep has fewer than two successful screening receipts")
	}
	if existing != nil {
		if bundle, ok := existing[engineeringVerificationWorkstreamID]; ok {
			if err := engine.validateEngineeringVerificationBundle(ctx, run.ID, bundle, screeningJobIDs); err != nil {
				return nil, err
			}
			return append(evidence, bundle), nil
		}
	}
	bundle, err := engine.collectEngineeringVerification(ctx, run, plan, evidence, screeningJobIDs)
	if err != nil {
		return nil, err
	}
	return append(evidence, bundle), nil
}

func (engine *Engine) xfoilScreeningJobIDs(ctx context.Context, runID string) ([]string, int, error) {
	rows, err := engine.db.SQL().QueryContext(ctx, `
SELECT id,status,spec_json
FROM engineering_jobs
WHERE run_id=? AND operation='xfoil_polar'
ORDER BY created_at,id`, runID)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	screeningCandidates := 0
	legacyJobs := 0
	for rows.Next() {
		var jobID, status, specJSON string
		if err := rows.Scan(&jobID, &status, &specJSON); err != nil {
			return nil, 0, err
		}
		var envelope struct {
			Arguments struct {
				ExecutionPurpose string `json:"execution_purpose"`
			} `json:"arguments"`
		}
		if err := json.Unmarshal([]byte(specJSON), &envelope); err != nil {
			return nil, 0, fmt.Errorf("decode screening job %s: %w", jobID, err)
		}
		switch envelope.Arguments.ExecutionPurpose {
		case "screening":
			screeningCandidates++
			if status == "succeeded" {
				ids = append(ids, jobID)
			}
		case "independent_verification":
			// The reserved attempt is checked separately below and must not be
			// mistaken for another optimization candidate on checkpoint resume.
		case "":
			legacyJobs++
		default:
			return nil, 0, fmt.Errorf("XFOIL job %s has an unsupported execution purpose", jobID)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if screeningCandidates+legacyJobs >= 2 && legacyJobs != 0 {
		return nil, 0, errors.New("multi-candidate XFOIL research requires every candidate to use execution_purpose=screening")
	}
	return ids, screeningCandidates, nil
}

func (engine *Engine) collectEngineeringVerification(
	ctx context.Context,
	run core.Run,
	plan core.ResearchPlan,
	evidence []core.EvidenceBundle,
	screeningJobIDs []string,
) (core.EvidenceBundle, error) {
	var bundle core.EvidenceBundle
	profile, err := profileForStage(run.ResearchProfileVersion, core.StageCollect)
	if err != nil {
		return bundle, err
	}
	err = engine.runStage(
		ctx, run, core.StageCollect, core.EngineeringVerificationOrdinal, "", profile,
		core.EvidenceSchema(), engineeringVerificationInput{
			WorkflowKind: engineeringVerificationWorkflowKind,
			Question:     run.Question, Plan: plan, Evidence: evidence,
			ScreeningJobIDs: screeningJobIDs,
			Policy:          "Read every screening job with aetherops_engineering.engineering_get and select the deterministic winner. Preserve its aerodynamic subject, flap geometry/deflection, transition/iteration settings, objective, target, and constraint. For a genuinely independent numerical check, set panel_count to the required 50%-higher multiple of ten with a 240-panel floor (maximum 300), and recompute at least winner target alpha +/-0.5 degrees with alpha_step_deg no larger than min(screening step,0.05). Serialize both alpha_start_deg and alpha_end_deg with at least 8 digits after the decimal point; never round the start upward or the end downward, because inward rounding can exclude the required target-local boundary. A wider range is allowed only to recover a target-CL bracket when that local range is inadequate. Call xfoil_polar exactly once with the current run/stage IDs, execution_purpose=independent_verification, and verification_of_job_id set to the selected screening job.",
		}, "research.evidence.verification",
		func(output json.RawMessage) error {
			candidate, err := engine.prepareCollectorEvidence(
				ctx, run.ID, core.EngineeringVerificationOrdinal,
				engineeringVerificationWorkstreamID, nil, output,
			)
			if err != nil {
				return err
			}
			if err := engine.validateEngineeringVerificationBundle(ctx, run.ID, candidate, screeningJobIDs); err != nil {
				return err
			}
			bundle = candidate
			return nil
		},
		canonicalEvidenceOutput(&bundle),
	)
	return bundle, err
}

func (engine *Engine) validateEngineeringVerificationBundle(
	ctx context.Context,
	runID string,
	bundle core.EvidenceBundle,
	screeningJobIDs []string,
) error {
	if bundle.WorkstreamID != engineeringVerificationWorkstreamID {
		return errors.New("engineering verification bundle has the wrong workstream id")
	}
	allowedSources := make(map[string]struct{}, len(screeningJobIDs))
	for _, jobID := range screeningJobIDs {
		allowedSources[jobID] = struct{}{}
	}
	rows, err := engine.db.SQL().QueryContext(ctx, `
SELECT j.id,j.operation,j.status,j.spec_json,j.receipt_artifact_id
FROM engineering_jobs j
JOIN stage_attempts s ON s.id=j.stage_attempt_id AND s.run_id=j.run_id
WHERE j.run_id=? AND s.stage='collect' AND s.logical_ordinal=?
	`,
		runID, core.EngineeringVerificationOrdinal,
	)
	if err != nil {
		return err
	}
	defer rows.Close()
	type verificationJob struct{ id, sourceJobID, receiptArtifactID string }
	var jobs []verificationJob
	for rows.Next() {
		var jobID, operation, status, specJSON, receiptArtifactID string
		if err := rows.Scan(&jobID, &operation, &status, &specJSON, &receiptArtifactID); err != nil {
			return err
		}
		if operation != "xfoil_polar" || status != "succeeded" || receiptArtifactID == "" {
			return errors.New("verification attempt contains a non-XFOIL, failed, or receipt-less engineering job")
		}
		var envelope struct {
			Arguments struct {
				ExecutionPurpose    string `json:"execution_purpose"`
				VerificationOfJobID string `json:"verification_of_job_id"`
			} `json:"arguments"`
		}
		if err := json.Unmarshal([]byte(specJSON), &envelope); err != nil {
			return err
		}
		if envelope.Arguments.ExecutionPurpose != "independent_verification" {
			return errors.New("verification attempt contains a non-verification XFOIL job")
		}
		if _, ok := allowedSources[envelope.Arguments.VerificationOfJobID]; !ok {
			return errors.New("verification job references an unapproved screening set")
		}
		jobs = append(jobs, verificationJob{jobID, envelope.Arguments.VerificationOfJobID, receiptArtifactID})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(jobs) != 1 {
		return fmt.Errorf("engineering verification requires exactly one engineering job, got %d", len(jobs))
	}
	var capturedEvidence int
	if err := engine.db.SQL().QueryRowContext(ctx, `
SELECT COUNT(*)
FROM evidence e
JOIN stage_attempts s ON s.id=e.stage_attempt_id AND s.run_id=e.run_id
WHERE e.run_id=? AND s.stage='collect' AND s.logical_ordinal=?`,
		runID, core.EngineeringVerificationOrdinal,
	).Scan(&capturedEvidence); err != nil {
		return err
	}
	if capturedEvidence != 0 {
		return errors.New("engineering verification attempt must not capture unrelated public evidence")
	}
	containsReceipt := false
	for _, source := range bundle.Sources {
		if artifactID, ok := core.EngineeringReceiptArtifactID(source); ok && artifactID == jobs[0].receiptArtifactID {
			containsReceipt = true
		}
	}
	if !containsReceipt {
		return errors.New("engineering verification bundle does not cite its new execution receipt")
	}
	return nil
}

func (engine *Engine) synthesize(
	ctx context.Context,
	run core.Run,
	plan core.ResearchPlan,
	evidence []core.EvidenceBundle,
) (core.ReportManifest, error) {
	var report core.ReportManifest
	if err := validateGlobalEvidenceIdentity(evidence); err != nil {
		return report, fmt.Errorf("validate synthesis evidence identity: %w", err)
	}
	profile, err := profileForStage(run.ResearchProfileVersion, core.StageSynthesize)
	if err != nil {
		return report, err
	}
	engineeringResults, err := engine.db.ListRunEngineeringResults(ctx, run.ID)
	if err != nil {
		return report, fmt.Errorf("load engineering results: %w", err)
	}
	su2Pack, err := engine.loadSU2AcceptancePackage(ctx, run.ID, plan)
	if err != nil {
		return report, fmt.Errorf("verify pre-synthesis engineering acceptance: %w", err)
	}
	var engineeringAssessment *core.EngineeringAssessment
	if su2Pack != nil {
		copy := su2Pack.assessment
		engineeringAssessment = &copy
	}
	ontologyContract, err := loadRunOntologyPatchContract(ctx, engine.db, run.ID)
	if err != nil {
		return report, fmt.Errorf("load synthesis ontology contract: %w", err)
	}
	reportSchema, err := reportSchemaForEvidenceAndOntology(evidence, ontologyContract)
	if err != nil {
		return report, fmt.Errorf("build synthesis report schema: %w", err)
	}
	err = engine.runStage(
		ctx, run, core.StageSynthesize, 0, run.MainThreadID, profile,
		reportSchema, synthesizeInput{
			Question: run.Question, Plan: plan, Evidence: evidence, EngineeringResults: engineeringResults,
			ReportEvidencePolicy: reportEvidencePolicy, KnowledgePatchPolicy: knowledgePatchPolicy,
			OntologyPolicy:          ontologyPatchPolicy(ontologyContract),
			EngineeringReportPolicy: engineeringReportPolicy,
			EngineeringAssessment:   engineeringAssessment,
		}, "research.report",
		func(output json.RawMessage) error {
			candidate, err := decodeStrict[core.ReportManifest](output)
			if err != nil {
				return err
			}
			if err := candidate.KnowledgePatch.CanonicalizeUnitProjections(); err != nil {
				return fmt.Errorf("canonicalize report knowledge units: %w", err)
			}
			if err := engine.assembleEngineeringReportPackage(ctx, run.ID, plan, &candidate); err != nil {
				return err
			}
			if err := validateReportManifest(candidate); err != nil {
				return err
			}
			if err := validateKnowledgePatchOntologyContract(candidate.KnowledgePatch, ontologyContract); err != nil {
				return fmt.Errorf("validate report ontology contract: %w", err)
			}
			if err := candidate.Validate(evidence); err != nil {
				return err
			}
			if err := engine.verifyReportArtifacts(ctx, run.ID, candidate); err != nil {
				return err
			}
			if err := engine.verifyEngineeringReportPackage(ctx, run.ID, plan, candidate); err != nil {
				return err
			}
			if err := engine.verifyKnowledgePatchEvidence(ctx, run.ID, candidate); err != nil {
				return err
			}
			report = candidate
			return nil
		},
		canonicalReportOutput(&report),
	)
	return report, err
}

func (engine *Engine) review(
	ctx context.Context,
	run core.Run,
	plan core.ResearchPlan,
	evidence []core.EvidenceBundle,
	report core.ReportManifest,
	ordinal int,
) (core.ReviewVerdict, error) {
	var verdict core.ReviewVerdict
	profile, err := profileForStage(run.ResearchProfileVersion, core.StageReview)
	if err != nil {
		return verdict, err
	}
	engineeringResults, err := engine.db.ListRunEngineeringResults(ctx, run.ID)
	if err != nil {
		return verdict, fmt.Errorf("load engineering results: %w", err)
	}
	if err := engine.verifyEngineeringReportPackage(ctx, run.ID, plan, report); err != nil {
		return verdict, err
	}
	err = engine.runStage(
		ctx, run, core.StageReview, ordinal, "", profile,
		core.ReviewSchema(), reviewInput{
			Question: run.Question, Plan: plan, Evidence: evidence, EngineeringResults: engineeringResults,
			Report: report, KnowledgeReviewPolicy: knowledgeReviewPolicy,
			ReviewScoringPolicy: reviewScoringPolicy, EngineeringReportPolicy: engineeringReportPolicy,
		}, "research.review",
		func(output json.RawMessage) error {
			candidate, err := decodeStrict[core.ReviewVerdict](output)
			if err != nil {
				return err
			}
			if err := validateReviewVerdictForReport(candidate, report); err != nil {
				return err
			}
			verdict = candidate
			return nil
		},
	)
	return verdict, err
}

func (engine *Engine) revise(
	ctx context.Context,
	run core.Run,
	plan core.ResearchPlan,
	evidence []core.EvidenceBundle,
	report core.ReportManifest,
	verdict core.ReviewVerdict,
	ordinal int,
) (core.ReportManifest, error) {
	var revised core.ReportManifest
	profile, err := profileForStage(run.ResearchProfileVersion, core.StageRevise)
	if err != nil {
		return revised, err
	}
	engineeringResults, err := engine.db.ListRunEngineeringResults(ctx, run.ID)
	if err != nil {
		return revised, fmt.Errorf("load engineering results: %w", err)
	}
	su2Pack, err := engine.loadSU2AcceptancePackage(ctx, run.ID, plan)
	if err != nil {
		return revised, fmt.Errorf("verify revision engineering acceptance: %w", err)
	}
	var engineeringAssessment *core.EngineeringAssessment
	if su2Pack != nil {
		copy := su2Pack.assessment
		engineeringAssessment = &copy
	}
	ontologyContract, err := loadRunOntologyPatchContract(ctx, engine.db, run.ID)
	if err != nil {
		return revised, fmt.Errorf("load revision ontology contract: %w", err)
	}
	reportSchema, err := reportSchemaForEvidenceAndOntology(evidence, ontologyContract)
	if err != nil {
		return revised, fmt.Errorf("build revision report schema: %w", err)
	}
	err = engine.runStage(
		ctx, run, core.StageRevise, ordinal, run.MainThreadID, profile,
		reportSchema, reviseInput{
			Question:                run.Question,
			Plan:                    plan,
			Evidence:                evidence,
			EngineeringResults:      engineeringResults,
			Report:                  report,
			Review:                  verdict,
			ReportEvidencePolicy:    reportEvidencePolicy,
			KnowledgePatchPolicy:    knowledgePatchPolicy,
			OntologyPolicy:          ontologyPatchPolicy(ontologyContract),
			EngineeringReportPolicy: engineeringReportPolicy,
			EngineeringAssessment:   engineeringAssessment,
		}, "research.report.revision",
		func(output json.RawMessage) error {
			candidate, err := decodeStrict[core.ReportManifest](output)
			if err != nil {
				return err
			}
			candidate = repairRevisedReportStructure(report, candidate)
			if err := candidate.KnowledgePatch.CanonicalizeUnitProjections(); err != nil {
				return fmt.Errorf("canonicalize revised report knowledge units: %w", err)
			}
			if err := engine.assembleEngineeringReportPackage(ctx, run.ID, plan, &candidate); err != nil {
				return err
			}
			if err := validateReportManifest(candidate); err != nil {
				return err
			}
			if err := validateKnowledgePatchOntologyContract(candidate.KnowledgePatch, ontologyContract); err != nil {
				return fmt.Errorf("validate revised report ontology contract: %w", err)
			}
			if err := candidate.Validate(evidence); err != nil {
				return err
			}
			if err := engine.verifyReportArtifacts(ctx, run.ID, candidate); err != nil {
				return err
			}
			if err := engine.verifyEngineeringReportPackage(ctx, run.ID, plan, candidate); err != nil {
				return err
			}
			if err := engine.verifyKnowledgePatchEvidence(ctx, run.ID, candidate); err != nil {
				return err
			}
			revised = candidate
			return nil
		},
		canonicalReportOutput(&revised),
	)
	return revised, err
}

func (engine *Engine) runReviewCycles(
	ctx context.Context,
	run core.Run,
	plan core.ResearchPlan,
	evidence []core.EvidenceBundle,
	report core.ReportManifest,
	cycle int,
	reviews map[int]core.ReviewVerdict,
	revisions map[int]core.ReportManifest,
) (core.Run, error) {
	if reviews == nil {
		reviews = map[int]core.ReviewVerdict{}
	}
	if revisions == nil {
		revisions = map[int]core.ReportManifest{}
	}
	if cycle < 0 || cycle > core.MaxRevisions {
		return engine.abort(ctx, run, errors.New("review cycle outside allowed range"))
	}
	if cycle > 0 && run.RevisionCycle < cycle {
		return engine.abort(ctx, run, errors.New("run revision cycle does not cover review checkpoint"))
	}
	// A stored model verdict is never sufficient to establish source quality.
	// Re-read every collector-owned CAS object before invoking REVIEW or honoring
	// a passing review checkpoint so legacy/truncated captures cannot succeed.
	if err := engine.verifyReviewEvidenceIntegrity(ctx, run.ID, plan, evidence); err != nil {
		return engine.abort(ctx, run, fmt.Errorf("verify review evidence integrity: %w", err))
	}
	if err := engine.verifyKnowledgePatchOntology(ctx, run.ID, report.KnowledgePatch); err != nil {
		return engine.abort(ctx, run, fmt.Errorf("verify report ontology contract: %w", err))
	}

	for {
		verdict, known := reviews[cycle]
		if !known {
			var err error
			if err := report.Validate(evidence); err != nil {
				return engine.abort(ctx, run, err)
			}
			if err := engine.verifyReportArtifacts(ctx, run.ID, report); err != nil {
				return engine.abort(ctx, run, err)
			}
			if err := engine.verifyKnowledgePatchEvidence(ctx, run.ID, report); err != nil {
				return engine.abort(ctx, run, err)
			}
			run, err = engine.ensureReviewing(ctx, run)
			if err != nil {
				return engine.abort(ctx, run, err)
			}
			verdict, err = engine.review(ctx, run, plan, evidence, report, cycle)
			if err != nil {
				return engine.abort(ctx, run, err)
			}
			reviews[cycle] = verdict
		}

		passes, err := verdict.PassesForReport(report)
		if err != nil {
			return engine.abort(ctx, run, err)
		}
		if passes {
			run, err = engine.ensureReviewing(ctx, run)
			if err != nil {
				return engine.abort(ctx, run, err)
			}
			completed, err := engine.succeed(ctx, run)
			if err != nil {
				return engine.abort(ctx, run, err)
			}
			return completed, nil
		}
		if cycle == core.MaxRevisions {
			run, err = engine.ensureReviewing(ctx, run)
			if err != nil {
				return engine.abort(ctx, run, err)
			}
			completed, err := engine.transition(ctx, run, core.RunQualityFailed)
			if err != nil {
				return engine.abort(ctx, run, err)
			}
			return completed, nil
		}

		nextCycle := cycle + 1
		revised, known := revisions[nextCycle]
		if !known {
			run, err = engine.ensureRevising(ctx, run)
			if err != nil {
				return engine.abort(ctx, run, err)
			}
			if run.RevisionCycle > nextCycle {
				return engine.abort(ctx, run, errors.New("run revision cycle exceeds next revision"))
			}
			if run.RevisionCycle < nextCycle {
				run, err = engine.setRunCycle(ctx, run, nextCycle)
				if err != nil {
					return engine.abort(ctx, run, err)
				}
			}
			revised, err = engine.revise(ctx, run, plan, evidence, report, verdict, nextCycle)
			if err != nil {
				return engine.abort(ctx, run, err)
			}
			revisions[nextCycle] = revised
		} else if run.RevisionCycle != nextCycle {
			return engine.abort(ctx, run, errors.New("revision checkpoint does not match run revision cycle"))
		}

		run, err = engine.ensureReviewing(ctx, run)
		if err != nil {
			return engine.abort(ctx, run, err)
		}
		report = revised
		cycle = nextCycle
	}
}

func (engine *Engine) ensureReviewing(ctx context.Context, run core.Run) (core.Run, error) {
	switch run.Status {
	case core.RunReviewing:
		return run, nil
	case core.RunRevising:
		return engine.transition(ctx, run, core.RunReviewing)
	default:
		return run, fmt.Errorf("run is %s, not reviewing or revising", run.Status)
	}
}

func (engine *Engine) ensureRevising(ctx context.Context, run core.Run) (core.Run, error) {
	switch run.Status {
	case core.RunRevising:
		return run, nil
	case core.RunReviewing:
		return engine.transition(ctx, run, core.RunRevising)
	default:
		return run, fmt.Errorf("run is %s, not reviewing or revising", run.Status)
	}
}

func (engine *Engine) requireMainThread(ctx context.Context, run core.Run) error {
	session, err := engine.db.ConversationSession(ctx, run.ConversationSessionID)
	if err != nil {
		return err
	}
	if session.ProjectID != run.ProjectID {
		return ErrMainThreadMismatch
	}
	if strings.TrimSpace(session.CodexThreadID) == "" || strings.TrimSpace(run.MainThreadID) == "" {
		return ErrMainThreadMissing
	}
	if session.CodexThreadID != run.MainThreadID {
		return ErrMainThreadMismatch
	}
	return nil
}

func (engine *Engine) transition(ctx context.Context, run core.Run, next core.RunStatus) (core.Run, error) {
	if err := ctx.Err(); err != nil {
		return run, err
	}
	current, err := engine.reloadRunForWrite(ctx, run)
	if err != nil {
		return run, err
	}
	updated, err := engine.db.TransitionRun(ctx, current.ID, current.Revision, next, "")
	if err != nil {
		return current, err
	}
	return updated, nil
}

func (engine *Engine) succeed(ctx context.Context, run core.Run) (core.Run, error) {
	if err := ctx.Err(); err != nil {
		return run, err
	}
	current, err := engine.reloadRunForWrite(ctx, run)
	if err != nil {
		return run, err
	}
	updated, err := engine.db.SucceedRun(ctx, current.ID, current.Revision)
	if err != nil {
		return current, err
	}
	return updated, nil
}

func (engine *Engine) setRunCycle(ctx context.Context, run core.Run, cycle int) (core.Run, error) {
	if err := ctx.Err(); err != nil {
		return run, err
	}
	current, err := engine.reloadRunForWrite(ctx, run)
	if err != nil {
		return run, err
	}
	updated, err := engine.db.SetRunCycle(ctx, current.ID, current.Revision, cycle)
	if err != nil {
		return current, err
	}
	return updated, nil
}

// reloadRunForWrite refreshes the optimistic-concurrency token after a model
// turn. The approval router temporarily owns the run while the turn is blocked:
// each completed approval wait advances the revision twice and restores the
// same stage status. That narrow, audited sequence is the only stale snapshot
// accepted here. A changed stage, revision cycle, run contract, or unexplained
// revision still fails instead of being retried with a freshly loaded token.
func (engine *Engine) reloadRunForWrite(ctx context.Context, snapshot core.Run) (core.Run, error) {
	current, err := engine.db.Run(ctx, snapshot.ID)
	if err != nil {
		return snapshot, fmt.Errorf("reload authoritative research run: %w", err)
	}
	if !sameRunWriteContract(snapshot, current) {
		return snapshot, fmt.Errorf("%w: run %s durable contract diverged at revision %d", ErrRunStateChanged, snapshot.ID, current.Revision)
	}
	if current.Status != snapshot.Status {
		return snapshot, fmt.Errorf("%w: run %s is %s at revision %d, expected %s", ErrRunStateChanged, snapshot.ID, current.Status, current.Revision, snapshot.Status)
	}
	if current.Revision < snapshot.Revision {
		return snapshot, fmt.Errorf("%w: run %s revision moved backward from %d to %d", ErrRunStateChanged, snapshot.ID, snapshot.Revision, current.Revision)
	}
	if current.Revision == snapshot.Revision {
		return current, nil
	}
	if err := engine.verifyApprovalRevisionAdvance(ctx, snapshot, current); err != nil {
		return snapshot, fmt.Errorf("%w: %v", ErrRunStateChanged, err)
	}
	return current, nil
}

func sameRunWriteContract(snapshot, current core.Run) bool {
	return snapshot.ID == current.ID &&
		snapshot.ProjectID == current.ProjectID &&
		snapshot.ConversationSessionID == current.ConversationSessionID &&
		snapshot.ScheduleID == current.ScheduleID &&
		snapshot.Question == current.Question &&
		snapshot.RevisionCycle == current.RevisionCycle &&
		snapshot.MainThreadID == current.MainThreadID &&
		snapshot.ResearchProfileVersion == current.ResearchProfileVersion &&
		snapshot.RetrievalProfile == current.RetrievalProfile &&
		snapshot.KnowledgeGenerationID == current.KnowledgeGenerationID &&
		snapshot.Model == current.Model &&
		snapshot.ReasoningEffort == current.ReasoningEffort &&
		snapshot.ServiceTier == current.ServiceTier &&
		snapshot.ProductBuild == current.ProductBuild &&
		snapshot.ReportArtifactID == current.ReportArtifactID &&
		snapshot.Error == current.Error &&
		snapshot.CreatedAt.Equal(current.CreatedAt)
}

func (engine *Engine) verifyApprovalRevisionAdvance(ctx context.Context, snapshot, current core.Run) error {
	if !core.CanTransition(snapshot.Status, core.RunWaitingApproval) ||
		!core.CanTransition(core.RunWaitingApproval, snapshot.Status) {
		return fmt.Errorf("run %s revision changed from %d to %d outside an approval-capable stage", snapshot.ID, snapshot.Revision, current.Revision)
	}
	rows, err := engine.db.SQL().QueryContext(ctx, `
SELECT payload_json
FROM run_events
WHERE run_id=? AND kind='run.transition'
ORDER BY sequence`, snapshot.ID)
	if err != nil {
		return fmt.Errorf("read run transition audit: %w", err)
	}
	defer rows.Close()
	type transitionEvent struct {
		From     core.RunStatus `json:"from"`
		To       core.RunStatus `json:"to"`
		Revision int64          `json:"revision"`
		Error    string         `json:"error"`
	}
	expectedRevision := snapshot.Revision
	expectedStatus := snapshot.Status
	for rows.Next() {
		var payload []byte
		if err := rows.Scan(&payload); err != nil {
			return fmt.Errorf("scan run transition audit: %w", err)
		}
		var event transitionEvent
		if err := json.Unmarshal(payload, &event); err != nil {
			return fmt.Errorf("decode run transition audit: %w", err)
		}
		if event.Revision <= snapshot.Revision || event.Revision > current.Revision {
			continue
		}
		if event.Revision != expectedRevision+1 || event.From != expectedStatus || event.Error != "" {
			return fmt.Errorf("run %s revision %d is not a contiguous approval transition", snapshot.ID, event.Revision)
		}
		switch expectedStatus {
		case snapshot.Status:
			if event.To != core.RunWaitingApproval {
				return fmt.Errorf("run %s revision %d changed %s to %s instead of waiting for approval", snapshot.ID, event.Revision, event.From, event.To)
			}
			expectedStatus = core.RunWaitingApproval
		case core.RunWaitingApproval:
			if event.To != snapshot.Status {
				return fmt.Errorf("run %s revision %d resumed approval to %s instead of %s", snapshot.ID, event.Revision, event.To, snapshot.Status)
			}
			expectedStatus = snapshot.Status
		default:
			return fmt.Errorf("run %s approval transition audit reached unexpected status %s", snapshot.ID, expectedStatus)
		}
		expectedRevision = event.Revision
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read run transition audit: %w", err)
	}
	if expectedRevision != current.Revision || expectedStatus != snapshot.Status {
		return fmt.Errorf("run %s revisions %d..%d are not complete approval round-trips", snapshot.ID, snapshot.Revision, current.Revision)
	}
	return nil
}

func (engine *Engine) transitionFromInterrupted(ctx context.Context, run core.Run, next core.RunStatus) (core.Run, error) {
	updated, err := engine.transition(ctx, run, next)
	if err == nil {
		return updated, nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
		return engine.abort(ctx, updated, err)
	}
	return updated, err
}

func (engine *Engine) abort(ctx context.Context, run core.Run, cause error) (core.Run, error) {
	if cause == nil {
		cause = errors.New("research run aborted")
	}
	next := core.RunFailed
	if errors.Is(cause, ErrTurnInterrupted) {
		next = core.RunInterrupted
	} else if errors.Is(cause, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
		next = core.RunCancelled
	}
	durableContext := context.WithoutCancel(ctx)
	current, err := engine.db.Run(durableContext, run.ID)
	if err != nil {
		return run, errors.Join(cause, fmt.Errorf("reload research state before abort: %w", err))
	}
	for range 8 {
		// A substantive collector failure can atomically quiesce the run as
		// uncertain before the sibling workers return. The outer execution path
		// will then call abort again with its stale run snapshot. Treat that
		// already-durable uncertainty as an idempotent terminal recording: keep
		// the first stored error and return the original cause without attempting
		// the invalid uncertain -> uncertain transition.
		if core.IsTerminal(current.Status) || current.Status == core.RunUncertain || current.Status == next {
			return current, cause
		}
		terminalStatus := next
		// Once an approved external action crossed its durable boundary, a
		// failed or cancelled in-flight stage has an unknown external outcome.
		// It must never be labelled as an ordinary retryable failure.
		attempts, attemptsErr := engine.db.ListStageAttempts(durableContext, current.ID)
		if attemptsErr != nil {
			return current, errors.Join(cause, fmt.Errorf("inspect stage side effects before abort: %w", attemptsErr))
		}
		for _, attempt := range attempts {
			if attempt.ExternalSideEffects && attempt.Status != "completed" {
				terminalStatus = core.RunUncertain
				break
			}
		}
		updated, transitionErr := engine.db.TransitionRun(
			durableContext, current.ID, current.Revision, terminalStatus, cause.Error(),
		)
		if transitionErr == nil {
			return updated, cause
		}
		latest, reloadErr := engine.db.Run(durableContext, current.ID)
		if reloadErr != nil {
			return current, errors.Join(cause,
				fmt.Errorf("record terminal research state: %w", transitionErr),
				fmt.Errorf("reload state after transition race: %w", reloadErr))
		}
		if latest.Revision == current.Revision {
			return current, errors.Join(cause, fmt.Errorf("record terminal research state: %w", transitionErr))
		}
		current = latest
	}
	return current, errors.Join(cause, errors.New("record terminal research state exceeded retry limit"))
}

func (engine *Engine) runStage(
	ctx context.Context,
	run core.Run,
	stage core.Stage,
	ordinal int,
	initialThreadID string,
	profile ModelProfile,
	schema json.RawMessage,
	input any,
	artifactKind string,
	validate func(json.RawMessage) error,
	normalize ...func(json.RawMessage) (json.RawMessage, error),
) error {
	return engine.runStageWithBeforeTurn(ctx, run, stage, ordinal, initialThreadID, profile, schema, input, artifactKind, nil, validate, normalize...)
}

func (engine *Engine) runStageWithBeforeTurn(
	ctx context.Context,
	run core.Run,
	stage core.Stage,
	ordinal int,
	initialThreadID string,
	profile ModelProfile,
	schema json.RawMessage,
	input any,
	artifactKind string,
	beforeTurn func(context.Context, core.StageAttempt) error,
	validate func(json.RawMessage) error,
	normalize ...func(json.RawMessage) (json.RawMessage, error),
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	inputBytes, inputHash, err := structuredInput(input)
	if err != nil {
		return fmt.Errorf("encode %s input: %w", stage, err)
	}
	attempt, err := engine.db.BeginStage(ctx, run.ID, stage, ordinal, initialThreadID, inputHash)
	if err != nil {
		return fmt.Errorf("begin %s stage: %w", stage, err)
	}
	if err := engine.persistInput(ctx, inputBytes, inputHash); err != nil {
		return engine.failStage(ctx, attempt, "", err)
	}
	if err := ctx.Err(); err != nil {
		return engine.failStage(ctx, attempt, "", err)
	}
	if beforeTurn != nil {
		if err := beforeTurn(ctx, attempt); err != nil {
			return engine.failStage(ctx, attempt, "", fmt.Errorf("prepare %s stage: %w", stage, err))
		}
	}
	if err := engine.protocol.ValidateModel(ctx, profile.Model, profile.ReasoningEffort, profile.ServiceTier); err != nil {
		return engine.failStage(ctx, attempt, "", fmt.Errorf("validate %s model: %w", stage, err))
	}

	threadID := initialThreadID
	if threadID == "" {
		threadID, err = engine.protocol.CreateThread(ctx, profile)
		if err != nil {
			return engine.failStage(ctx, attempt, "", fmt.Errorf("create %s thread: %w", stage, err))
		}
		if strings.TrimSpace(threadID) == "" {
			return engine.failStage(ctx, attempt, "", fmt.Errorf("create %s thread: empty thread id", stage))
		}
		if err := engine.db.SetStageTurn(context.WithoutCancel(ctx), attempt.ID, threadID, ""); err != nil {
			return engine.failStage(ctx, attempt, "", fmt.Errorf("record %s thread: %w", stage, err))
		}
	}

	if engine.turnTimeout <= 0 {
		return engine.failStage(ctx, attempt, "", errors.New("research turn timeout is not configured"))
	}
	deactivate := engine.activateThread(run.ID, threadID)
	turnContext, cancelTurn := context.WithTimeout(ctx, engine.turnTimeout)
	result, turnErr := engine.protocol.Turn(turnContext, threadID, TurnOptions{
		Model:           profile.Model,
		ReasoningEffort: profile.ReasoningEffort,
		ServiceTier:     profile.ServiceTier,
		Schema:          append(json.RawMessage(nil), schema...),
		Prompt:          stagePrompt(stage, run.ID, attempt.ID, inputBytes),
	})
	turnContextErr := turnContext.Err()
	cancelTurn()
	deactivate()
	if result.ThreadID != "" || result.TurnID != "" {
		recordedThreadID := result.ThreadID
		if recordedThreadID == "" {
			recordedThreadID = threadID
		}
		if err := engine.db.SetStageTurn(context.WithoutCancel(ctx), attempt.ID, recordedThreadID, result.TurnID); err != nil {
			return engine.failStage(ctx, attempt, "", fmt.Errorf("record %s turn: %w", stage, err))
		}
	}
	if turnErr != nil {
		if errors.Is(turnContextErr, context.DeadlineExceeded) {
			return engine.failStage(ctx, attempt, "", fmt.Errorf("run %s turn exceeded %s deadline: %w", stage, engine.turnTimeout, turnErr))
		}
		return engine.failStage(ctx, attempt, "", fmt.Errorf("run %s turn: %w", stage, turnErr))
	}
	// A protocol adapter may race the deadline and return a successful-looking
	// result at the same instant. The deadline wins so late output can never be
	// published as a completed durable stage.
	if turnContextErr != nil {
		return engine.failStage(ctx, attempt, "", fmt.Errorf("run %s turn exceeded %s deadline: %w", stage, engine.turnTimeout, turnContextErr))
	}
	if err := ctx.Err(); err != nil {
		return engine.failStage(ctx, attempt, "", err)
	}
	if err := validateTurnResult(result, threadID, profile); err != nil {
		return engine.failStage(ctx, attempt, "", fmt.Errorf("validate %s turn result: %w", stage, err))
	}
	if err := validate(result.Output); err != nil {
		return engine.failStage(ctx, attempt, "", fmt.Errorf("validate %s JSON: %w", stage, err))
	}

	output := append(json.RawMessage(nil), result.Output...)
	if len(normalize) > 1 {
		return engine.failStage(ctx, attempt, "", fmt.Errorf("normalize %s output: multiple normalizers", stage))
	}
	if len(normalize) == 1 {
		output, err = normalize[0](output)
		if err != nil {
			return engine.failStage(ctx, attempt, "", fmt.Errorf("normalize %s output: %w", stage, err))
		}
	}
	receipt, err := engine.persistOutput(ctx, output)
	if err != nil {
		return engine.failStage(ctx, attempt, "", err)
	}
	if err := ctx.Err(); err != nil {
		return engine.failStage(ctx, attempt, receipt.Hash, err)
	}
	if _, err := engine.db.PublishArtifact(ctx, run.ID, attempt.ID, artifactKind, "application/json", receipt); err != nil {
		return engine.failStage(ctx, attempt, receipt.Hash, fmt.Errorf("publish %s artifact: %w", stage, err))
	}
	if err := ctx.Err(); err != nil {
		return engine.failStage(ctx, attempt, receipt.Hash, err)
	}
	executionReceipt := store.StageExecutionReceipt{
		StageAttemptID: attempt.ID, RunID: run.ID,
		ResearchProfileVersion: run.ResearchProfileVersion,
		Model:                  profile.Model, ReasoningEffort: profile.ReasoningEffort, ServiceTier: profile.ServiceTier,
		CodexThreadID: result.ThreadID, CodexTurnID: result.TurnID,
		InputSHA256: inputHash, OutputSHA256: receipt.Hash,
		ExecutionContractSHA256: core.StageExecutionContractSHA256,
		ProductBuild:            run.ProductBuild,
	}
	if err := engine.db.CompleteStageWithExecution(ctx, attempt.ID, receipt.Hash, executionReceipt); err != nil {
		return engine.failStage(ctx, attempt, receipt.Hash, fmt.Errorf("complete %s stage: %w", stage, err))
	}
	return nil
}

func (engine *Engine) failStage(ctx context.Context, attempt core.StageAttempt, outputHash string, cause error) error {
	if cause == nil {
		cause = errors.New("research stage failed")
	}
	durableContext := context.WithoutCancel(ctx)
	if attempt.Stage == core.StageCollect && isSubstantiveCollectFailure(cause) {
		if _, err := engine.db.FailCollectStageAndQuiesceRun(durableContext, attempt.ID, outputHash, cause.Error()); err != nil {
			return errors.Join(cause, fmt.Errorf("record failed %s stage and quiesce run: %w", attempt.Stage, err))
		}
		return cause
	}
	if err := engine.db.CompleteStage(durableContext, attempt.ID, outputHash, cause.Error()); err != nil {
		return errors.Join(cause, fmt.Errorf("record failed %s stage: %w", attempt.Stage, err))
	}
	return cause
}

func isSubstantiveCollectFailure(cause error) bool {
	return !errors.Is(cause, context.Canceled) && !errors.Is(cause, ErrTurnInterrupted)
}

func (engine *Engine) persistInput(ctx context.Context, data []byte, expectedHash string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	receipt, err := engine.cas.PutBytes(data)
	if err != nil {
		return fmt.Errorf("write stage input to CAS: %w", err)
	}
	if receipt.Hash != expectedHash {
		return errors.New("CAS input receipt does not match encoded input")
	}
	verified, err := engine.cas.ReadVerified(receipt.Hash)
	if err != nil {
		return fmt.Errorf("verify stage input CAS object: %w", err)
	}
	if !bytes.Equal(verified, data) {
		return errors.New("verified stage input differs from encoded input")
	}
	return nil
}

func (engine *Engine) persistOutput(ctx context.Context, data []byte) (cas.Receipt, error) {
	if err := ctx.Err(); err != nil {
		return cas.Receipt{}, err
	}
	receipt, err := engine.cas.PutBytes(data)
	if err != nil {
		return cas.Receipt{}, fmt.Errorf("write stage output to CAS: %w", err)
	}
	verified, err := engine.cas.ReadVerified(receipt.Hash)
	if err != nil {
		return cas.Receipt{}, fmt.Errorf("verify stage output CAS object: %w", err)
	}
	if !bytes.Equal(verified, data) {
		return cas.Receipt{}, errors.New("verified stage output differs from protocol output")
	}
	return receipt, nil
}

func structuredInput(input any) ([]byte, string, error) {
	encoded, err := json.Marshal(input)
	if err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(encoded)
	return encoded, hex.EncodeToString(sum[:]), nil
}

func stagePrompt(stage core.Stage, runID, attemptID string, input []byte) string {
	envelope := struct {
		RunID          string          `json:"run_id"`
		StageAttemptID string          `json:"stage_attempt_id"`
		Task           json.RawMessage `json:"task"`
	}{RunID: runID, StageAttemptID: attemptID, Task: append(json.RawMessage(nil), input...)}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		panic("fixed research stage envelope could not be encoded: " + err.Error())
	}
	instructions := "Return only a JSON object that conforms exactly to the supplied response schema. Use run_id and stage_attempt_id for every AetherOps internal MCP call. Bundled aetherops_engineering tools are first-party capabilities and are intentionally absent from aetherops_internal.tool_catalog; call a matching bundled engineering tool directly and never use an empty project tool catalog to declare that bundled capability unavailable. Use aetherops_internal.tool_catalog only to discover optional user-approved project extensions. Read an approved Skill with tool_get and invoke an approved declarative MCP adapter with tool_run only when the bundled tools do not cover the operation. If a genuinely reusable capability is missing, you may call tool_package_propose. A proposal is not approved merely because it was submitted: do not claim installation or call it until tool_catalog confirms activation. Never retry through arbitrary code; continue with bundled or approved tools or state the limitation while the user reviews it in Tool Studio.\n"
	if stage == core.StagePlan {
		instructions += "PLAN XFOIL SCREENING contract: the typed XFOIL capability supports one NACA four-digit baseline with a sealed plain-flap candidate set and a bounded declarative operating-point matrix. Arbitrary coordinate input, non-NACA-four-digit airfoils, and comparisons across different airfoil families remain unsupported. For one condition, use the required scalar reynolds, mach, ncrit, target_cl, and minimum_cm fields and return operating_points as an empty array. For several conditions, populate operating_points with every exact condition; the scalar fields identify the primary/default point and must remain valid. The backend authorizes the Cartesian product of operating_points and candidate_flap_deflections_deg, capped at 64 calls. Use this composition to solve multi-Reynolds or multi-target-CL work instead of stopping or shrinking scope. Set xfoil_screening to the exact immutable numerical contract, including candidates, every operating point, solver controls, geometry, objective, and constraints. If the task truly cannot be represented even by this bounded matrix, state the unsupported capability so validation fails before COLLECT. If no XFOIL work is required, set xfoil_screening to null. COLLECT is fail-closed: owner ordinal 0 must execute exactly the authorized matrix, and missing, duplicate, additional, failed, or condition-changed jobs invalidate it.\n"
	}
	if stage == core.StageCollect {
		var marker struct {
			WorkflowKind string `json:"workflow_kind"`
		}
		_ = json.Unmarshal(input, &marker)
		if marker.WorkflowKind == engineeringVerificationWorkflowKind {
			instructions += "ENGINEERING VERIFICATION contract: this is a new isolated collector attempt after screening. Read each supplied job with aetherops_engineering.engineering_get. Select exactly one candidate by the stated objective, hard constraints, convergence quality, and counterevidence. Preserve the selected result's NACA, Reynolds, Mach, sealed-flap geometry/deflection, Ncrit, iterations, optimization objective, target CL, and minimum CM; replace run_id and stage_attempt_id with the current values. Do not reuse the screening numerical resolution: set panel_count to ceil(screening panel_count*1.5/10)*10 with a 240 floor and 300 ceiling, which must be greater than screening; use alpha_step_deg no larger than min(screening alpha_step_deg,0.05); and make the alpha interval contain the screening winner's target-alpha +/-0.5 degrees. Serialize alpha_start_deg and alpha_end_deg with at least 8 digits after the decimal point. Never round alpha_start_deg upward or alpha_end_deg downward; preserve full precision or round outward so the interval cannot exclude either target-local boundary. You may expand that interval when the local range is inadequate to bracket target CL. Set execution_purpose=independent_verification and verification_of_job_id to the selected screening job, then call xfoil_polar exactly once. The server deterministically rejects changed invariant inputs, reused screening resolution, and insufficient target-local coverage. A cached screening result is not verification. Agreement requires both runs to satisfy minimum CM, CD difference no greater than max(0.0005,5% of screening CD), and CM difference no greater than 0.01. Return workstream_id=aetherops_engineering_verification. Put only the new call's top-level receipt_artifact_id in engineering_receipt_artifact_ids and cite that same id from every computed claim. It must be art_ followed by exactly 32 lowercase hexadecimal characters; never use cas_blob_sha256 or evidence_handles artifact_hash. Leave sources empty unless this attempt also captured a public source. Do not transcribe engineering URL, title, publisher, captured_at, or blob_hash; AetherOps rehydrates them from the exact attempt-owned receipt. Do not cite screening receipts from another attempt in this bundle, do not call evidence_capture, and do not run any other solver. State whether the fresh result agrees, but do not hide failed points or numerical discontinuities.\n"
		} else {
			instructions += "COLLECT evidence contract: for paper-oriented work, begin discovery with aetherops_internal.scholarly_search. Its Crossref, arXiv, and Europe PMC metadata is discovery-only and is never evidence. Open a candidate url or full_text_url, then call aetherops_internal.evidence_capture on the actual public source before citing it. Before returning, call evidence_capture for every public source in the bundle. Pass only URL metadata: run_id, stage_attempt_id, source_url, title, and optional publisher. AetherOps fetches and commits the response bytes itself. Never request commandExecution or use PowerShell, curl, wget, a script, or another shell download path to retrieve public evidence; COLLECT rejects those commands. Trust only a successful evidence_capture result: copy its id into sources.id, its canonical final source_url into sources.url, and its title, publisher, blob_hash, and captured_at exactly. A redirect input URL is not the captured provenance. One-byte/trivial payloads and shell tool wrapper metadata such as Exit code, Wall time, Chunk ID, or Process exited with code are not source evidence and fail CAS readback. For a computed engineering claim, do not call evidence_capture and do not copy engineering metadata into sources. Copy only the successful typed engineering result's top-level receipt_artifact_id into engineering_receipt_artifact_ids and cite that same artifact id in source_ids. It must be art_ followed by exactly 32 lowercase hexadecimal characters. A 64-character cas_blob_sha256 or evidence_handles artifact_hash is CAS provenance, never a source id. Never transcribe an engineering receipt URL, title, publisher, captured_at, or blob_hash: AetherOps verifies the id belongs to this exact run and collector attempt, then rehydrates the complete immutable source from SQLite/CAS. Every EvidenceBundle must contain at least one source-supported claim; a limitations-only result with an empty claims array is invalid even if a source was captured. Every EvidenceBundle claim must contain one or more source_ids referring to a captured public source or an engineering receipt artifact id. Never return an uncaptured public source, an empty or all-zero public blob_hash, an invented public capture time, a denied/failed engineering call, or a receipt from another attempt. In particular, never emit year-1, Unix-epoch, placeholder, or failed-tool-call source rows. If no source or engineering receipt can be verified successfully, fail the stage instead of fabricating a schema-valid EvidenceBundle. Return at least one verified public source or engineering receipt artifact id.\n"
		}
	}
	if stage == core.StageSynthesize || stage == core.StageReview || stage == core.StageRevise {
		instructions += "ENGINEERING READBACK contract: engineering_results contains ownership and artifact metadata, not trusted numerical values. Before using a computed result, call aetherops_engineering.engineering_get with the listed job_id and the current run_id/stage_attempt_id, then cross-check the CAS-verified receipt metrics, top-level receipt_artifact_id, and evidence_handles. Distinguish reused_result from a fresh independent verification and do not treat artifact metadata alone as numerical evidence.\n"
	}
	return instructions + "Structured task input:\n" + string(encoded)
}

func (engine *Engine) verifyEvidenceSources(ctx context.Context, runID string, ordinal int, bundle core.EvidenceBundle) error {
	if err := engine.db.VerifyEvidenceSourcesForCollector(ctx, runID, ordinal, bundle.Sources); err != nil {
		return fmt.Errorf("verify captured evidence: %w", err)
	}
	if err := engine.verifyXFOILScreeningCoverage(ctx, runID, ordinal, bundle); err != nil {
		return fmt.Errorf("verify XFOIL screening ownership: %w", err)
	}
	for _, source := range bundle.Sources {
		data, err := engine.cas.ReadVerified(source.BlobHash)
		if err != nil {
			return fmt.Errorf("verify evidence CAS object %s: %w", source.ID, err)
		}
		if err := core.ValidateEvidenceSourceContent(source, data); err != nil {
			return fmt.Errorf("verify evidence CAS content %s: %w", source.ID, err)
		}
	}
	return nil
}

func (engine *Engine) verifyReviewEvidenceIntegrity(
	ctx context.Context,
	runID string,
	plan core.ResearchPlan,
	evidence []core.EvidenceBundle,
) error {
	ordinals := make(map[string]int, len(plan.Workstreams)+1)
	for ordinal, workstream := range plan.Workstreams {
		if _, duplicate := ordinals[workstream.ID]; duplicate {
			return fmt.Errorf("duplicate planned evidence workstream %q", workstream.ID)
		}
		ordinals[workstream.ID] = ordinal
	}
	ordinals[engineeringVerificationWorkstreamID] = core.EngineeringVerificationOrdinal
	seen := make(map[string]struct{}, len(evidence))
	var ownerBundle *core.EvidenceBundle
	for _, bundle := range evidence {
		ordinal, exists := ordinals[bundle.WorkstreamID]
		if !exists {
			return fmt.Errorf("review evidence references unknown workstream %q", bundle.WorkstreamID)
		}
		if _, duplicate := seen[bundle.WorkstreamID]; duplicate {
			return fmt.Errorf("review evidence duplicates workstream %q", bundle.WorkstreamID)
		}
		seen[bundle.WorkstreamID] = struct{}{}
		if len(plan.Workstreams) > 0 && bundle.WorkstreamID == plan.Workstreams[core.EngineeringScreeningOwnerOrdinal].ID {
			copy := bundle
			ownerBundle = &copy
		}
		if err := validateEvidenceBundle(bundle, bundle.WorkstreamID); err != nil {
			return err
		}
		if err := engine.verifyEvidenceSources(ctx, runID, ordinal, bundle); err != nil {
			return err
		}
	}
	for _, workstream := range plan.Workstreams {
		if _, exists := seen[workstream.ID]; !exists {
			return fmt.Errorf("review evidence omits planned workstream %q", workstream.ID)
		}
	}
	if ownerBundle == nil {
		return errors.New("review evidence omits the deterministic screening owner workstream")
	}
	if err := engine.verifyPlannedXFOILScreeningCoverage(ctx, runID, plan, *ownerBundle); err != nil {
		return fmt.Errorf("review planned XFOIL screening sweep: %w", err)
	}
	return nil
}

func (engine *Engine) verifyReportArtifacts(ctx context.Context, runID string, report core.ReportManifest) error {
	if err := engine.db.VerifyRunArtifactHashes(ctx, runID, report.ArtifactHashes); err != nil {
		return err
	}
	for _, hash := range report.ArtifactHashes {
		if _, err := engine.db.BlobMetadata(ctx, hash); err != nil {
			return fmt.Errorf("report artifact %s is not registered: %w", hash, err)
		}
		if _, err := engine.cas.ReadVerified(hash); err != nil {
			return fmt.Errorf("verify report artifact %s: %w", hash, err)
		}
	}
	return nil
}

func validateTurnResult(result TurnResult, expectedThreadID string, expected ModelProfile) error {
	if strings.TrimSpace(result.ThreadID) == "" || strings.TrimSpace(result.TurnID) == "" {
		return errors.New("turn result is missing thread or turn id")
	}
	if result.ThreadID != expectedThreadID {
		return fmt.Errorf("turn result thread %q does not match expected thread %q", result.ThreadID, expectedThreadID)
	}
	if result.Model != expected.Model || result.ReasoningEffort != expected.ReasoningEffort || result.ServiceTier != expected.ServiceTier {
		return fmt.Errorf("turn result model is %s/%s/%s, want %s/%s/%s", result.Model, result.ReasoningEffort, result.ServiceTier, expected.Model, expected.ReasoningEffort, expected.ServiceTier)
	}
	if len(bytes.TrimSpace(result.Output)) == 0 {
		return errors.New("turn result is missing structured JSON")
	}
	return nil
}

func missingWorkstreams(plan core.ResearchPlan, evidence map[string]core.EvidenceBundle) []int {
	var missing []int
	for index, workstream := range plan.Workstreams {
		if _, ok := evidence[workstream.ID]; !ok {
			missing = append(missing, index)
		}
	}
	return missing
}

func orderedEvidence(plan core.ResearchPlan, evidence map[string]core.EvidenceBundle) ([]core.EvidenceBundle, error) {
	ordered := make([]core.EvidenceBundle, len(plan.Workstreams), len(plan.Workstreams)+1)
	for index, workstream := range plan.Workstreams {
		bundle, ok := evidence[workstream.ID]
		if !ok {
			return nil, fmt.Errorf("missing evidence checkpoint for workstream %q", workstream.ID)
		}
		if err := validateEvidenceBundle(bundle, workstream.ID); err != nil {
			return nil, err
		}
		ordered[index] = bundle
	}
	if verification, ok := evidence[engineeringVerificationWorkstreamID]; ok {
		if err := validateEvidenceBundle(verification, engineeringVerificationWorkstreamID); err != nil {
			return nil, err
		}
		ordered = append(ordered, verification)
	}
	if err := validateGlobalEvidenceIdentity(ordered); err != nil {
		return nil, err
	}
	return ordered, nil
}

type planInput struct {
	Question                   string `json:"question"`
	EngineeringPolicy          string `json:"engineering_policy"`
	CapabilityRecoveryFeedback string `json:"capability_recovery_feedback,omitempty"`
}

type collectInput struct {
	Question           string            `json:"question"`
	Plan               core.ResearchPlan `json:"plan"`
	Workstream         core.Workstream   `json:"workstream"`
	SourceRequirements []string          `json:"source_requirements"`
	EngineeringPolicy  string            `json:"engineering_policy"`
	ScreeningRole      string            `json:"engineering_screening_role"`
}

type engineeringVerificationInput struct {
	WorkflowKind    string                `json:"workflow_kind"`
	Question        string                `json:"question"`
	Plan            core.ResearchPlan     `json:"plan"`
	Evidence        []core.EvidenceBundle `json:"evidence"`
	ScreeningJobIDs []string              `json:"screening_job_ids"`
	Policy          string                `json:"policy"`
}

const knowledgePatchPolicy = "Produce knowledge_patch together with the report using the schema and unit registry versions required by the response schema. Evidence is a strict mutually exclusive union and every assertion must carry at least one exact handle. For captured public/CAS text, emit exactly kind=text, source_id, claim_id, blob_hash, byte_start, byte_end, and span_hash; do not add any engineering field. For an engineering input, result, condition, or provenance value, call engineering_get and copy one complete entry from its evidence_handles array verbatim: exactly kind=engineering, artifact_hash, json_pointer, and value_hash; do not add source_id, claim_id, blob_hash, byte_start, byte_end, span_hash, or csv_row. For example, an analyzed NACA input is supported by the supplied /spec/arguments/naca handle, never by a fabricated text span. A CSV locator is legal only when a tool supplies a complete kind=engineering, artifact_hash, csv_row, value_hash handle. Never calculate, guess, leave empty, or invent an evidence hash or locator. If no returned handle exactly supports an assertion, omit that assertion. Raw SPARQL rows are not evidence and require knowledge_get or memory_get readback. Preserve typed literal lexical forms and include the registry-exact SI projection for every unit-bearing value. Leave every entity aliases array empty: aliases, abbreviations, translations, and alternate spellings can only be added by an evidence-backed user curation event. Automatic identity matching is byte-exact and case- and whitespace-sensitive."

const reportEvidencePolicy = "Set evidence_ids to every evidence[].workstream_id exactly once. Never put citation source_ids, artifact IDs, receipt IDs, claim IDs, or CAS hashes in evidence_ids. Citations continue to use their exact source_ids and claim_ids separately."

const knowledgeReviewPolicy = "Review the report and knowledge_patch together. Set knowledge_integrity.evidence_integrity_percent to 100 only when every handle reads back exactly, and unsupported_assertions to the exact count of assertions not supported by that evidence. Raw SPARQL results alone never support a report claim. " + engineeringVerificationContractPolicy

const reviewScoringPolicy = "Score every axis on an ordinal quality scale where 1 is worst and 5 is best; never treat 1 as first place or highest quality. Passing requires citation integrity 100%, knowledge evidence integrity 100%, zero unsupported assertions, zero critical errors, an arithmetic mean of at least 4.0, and every axis at least 3. When report.engineering_assessment is present, task_fulfillment, completeness, and clarity_and_reproducibility must each be at least 4; an inconclusive scientific outcome may pass only when the report accurately explains the failed conclusion gates. If any condition fails, include at least one concrete, actionable revision_request that explains what must change. If the report is fully supported and your summary says it is complete and consistent, use correspondingly high scores rather than 1s."

const engineeringReportPolicy = "For XFOIL optimization only, AetherOps deterministically assembles the interpolation lineage table, three comparison figures, independent-execution provenance, engineering_completeness metadata, and deterministic appendix after your structured report is returned. Interpret verified XFOIL results and state limitations, but do not invent or transcribe raw polar rows, graph hashes, execution counts, workspace identities, or retry history. For a planned su2_mesh_study, AetherOps supplies a core-authored engineering_assessment before SYNTHESIZE and appends the identical deterministic assessment and case table after your structured report is returned. Treat assessment.outcome=inconclusive as a successful calculation that does not establish grid independence; never rename it confirmed, omit failed conclusion checks, or let prose override it. Use the receipt's deterministic mesh/quality, final-window stability, surface-spacing, Cp-shock, solver, convergence, and exact-domain metrics. AetherOps attaches every required SU2 config, history, log, mesh, mesh input, surface, and receipt CAS object itself. Distinguish residual-threshold convergence from coefficient stability, and state that shock_x_over_c is the maximum interior |delta Cp/delta x| locator rather than an externally validated shock position. " + engineeringVerificationContractPolicy

type synthesizeInput struct {
	Question                string                      `json:"question"`
	Plan                    core.ResearchPlan           `json:"plan"`
	Evidence                []core.EvidenceBundle       `json:"evidence"`
	EngineeringResults      []store.EngineeringResult   `json:"engineering_results,omitempty"`
	ReportEvidencePolicy    string                      `json:"report_evidence_policy"`
	KnowledgePatchPolicy    string                      `json:"knowledge_patch_policy"`
	OntologyPolicy          string                      `json:"ontology_policy"`
	EngineeringReportPolicy string                      `json:"engineering_report_policy,omitempty"`
	EngineeringAssessment   *core.EngineeringAssessment `json:"engineering_assessment,omitempty"`
}

type reviewInput struct {
	Question                string                    `json:"question"`
	Plan                    core.ResearchPlan         `json:"plan"`
	Evidence                []core.EvidenceBundle     `json:"evidence"`
	EngineeringResults      []store.EngineeringResult `json:"engineering_results,omitempty"`
	Report                  core.ReportManifest       `json:"report"`
	KnowledgeReviewPolicy   string                    `json:"knowledge_review_policy"`
	ReviewScoringPolicy     string                    `json:"review_scoring_policy"`
	EngineeringReportPolicy string                    `json:"engineering_report_policy,omitempty"`
}

type reviseInput struct {
	Question                string                      `json:"question"`
	Plan                    core.ResearchPlan           `json:"plan"`
	Evidence                []core.EvidenceBundle       `json:"evidence"`
	EngineeringResults      []store.EngineeringResult   `json:"engineering_results,omitempty"`
	Report                  core.ReportManifest         `json:"report"`
	Review                  core.ReviewVerdict          `json:"review"`
	ReportEvidencePolicy    string                      `json:"report_evidence_policy"`
	KnowledgePatchPolicy    string                      `json:"knowledge_patch_policy"`
	OntologyPolicy          string                      `json:"ontology_policy"`
	EngineeringReportPolicy string                      `json:"engineering_report_policy,omitempty"`
	EngineeringAssessment   *core.EngineeringAssessment `json:"engineering_assessment,omitempty"`
}

func reportSchemaForEvidence(evidence []core.EvidenceBundle) (json.RawMessage, error) {
	ids := make([]string, len(evidence))
	sourceIDs := make([]any, 0)
	claimIDs := make([]any, 0)
	for index, bundle := range evidence {
		ids[index] = bundle.WorkstreamID
		for _, source := range bundle.Sources {
			sourceIDs = append(sourceIDs, source.ID)
		}
		for _, claim := range bundle.Claims {
			claimIDs = append(claimIDs, claim.ID)
		}
	}
	schema, err := core.ReportSchemaForEvidenceIDs(ids)
	if err != nil {
		return nil, err
	}
	var root map[string]any
	if err := json.Unmarshal(schema, &root); err != nil {
		return nil, err
	}
	properties, ok := root["properties"].(map[string]any)
	if !ok {
		return nil, errors.New("report schema has no properties")
	}
	citations, ok := properties["citations"].(map[string]any)
	if !ok {
		return nil, errors.New("report schema has no citations")
	}
	citationItems, ok := citations["items"].(map[string]any)
	if !ok {
		return nil, errors.New("report citation schema has no items")
	}
	citationProperties, ok := citationItems["properties"].(map[string]any)
	if !ok {
		return nil, errors.New("report citation schema has no properties")
	}
	for name, values := range map[string][]any{"source_ids": sourceIDs, "claim_ids": claimIDs} {
		arraySchema, ok := citationProperties[name].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("report citation schema has no %s", name)
		}
		itemSchema, ok := arraySchema["items"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("report citation %s schema has no items", name)
		}
		itemSchema["enum"] = values
	}
	return json.Marshal(root)
}

// repairRevisedReportStructure preserves an exact citation binding when a
// revision keeps the same marker but accidentally drops one of its id arrays.
// It never guesses a source for a new marker and never changes prose. The
// ordinary report/evidence validators still prove the restored relationship.
func repairRevisedReportStructure(previous, revised core.ReportManifest) core.ReportManifest {
	prior := make(map[string]core.Citation, len(previous.Citations))
	for _, citation := range previous.Citations {
		if citation.Marker != "" && len(citation.SourceIDs) != 0 && len(citation.ClaimIDs) != 0 {
			prior[citation.Marker] = citation
		}
	}
	for index := range revised.Citations {
		citation := &revised.Citations[index]
		stable, ok := prior[citation.Marker]
		if !ok {
			continue
		}
		if len(citation.SourceIDs) == 0 {
			citation.SourceIDs = append([]string(nil), stable.SourceIDs...)
		}
		if len(citation.ClaimIDs) == 0 {
			citation.ClaimIDs = append([]string(nil), stable.ClaimIDs...)
		}
	}
	if len(revised.EvidenceIDs) == 0 && len(previous.EvidenceIDs) != 0 {
		revised.EvidenceIDs = append([]string(nil), previous.EvidenceIDs...)
	}
	return revised
}

func reportSchemaForEvidenceAndOntology(evidence []core.EvidenceBundle, contract ontologyPatchContract) (json.RawMessage, error) {
	schema, err := reportSchemaForEvidence(evidence)
	if err != nil {
		return nil, err
	}
	var root map[string]any
	if err := json.Unmarshal(schema, &root); err != nil {
		return nil, err
	}
	properties, ok := root["properties"].(map[string]any)
	if !ok {
		return nil, errors.New("report schema has no properties")
	}
	patch, ok := properties["knowledge_patch"].(map[string]any)
	if !ok {
		return nil, errors.New("report schema has no knowledge patch")
	}
	patchProperties, ok := patch["properties"].(map[string]any)
	if !ok {
		return nil, errors.New("knowledge patch schema has no properties")
	}
	classes := make([]any, len(contract.Classes))
	for index, term := range contract.Classes {
		classes[index] = term.Key
	}
	propertyKeys := make([]any, len(contract.Properties))
	for index, term := range contract.Properties {
		propertyKeys[index] = term.Key
	}
	entities, ok := patchProperties["entities"].(map[string]any)
	if !ok {
		return nil, errors.New("knowledge patch schema has no entities")
	}
	entityItems, ok := entities["items"].(map[string]any)
	if !ok {
		return nil, errors.New("knowledge entity schema has no items")
	}
	entityProperties, ok := entityItems["properties"].(map[string]any)
	if !ok {
		return nil, errors.New("knowledge entity schema has no properties")
	}
	entityType, ok := entityProperties["type"].(map[string]any)
	if !ok {
		return nil, errors.New("knowledge entity schema has no type")
	}
	entityType["enum"] = classes
	assertions, ok := patchProperties["assertions"].(map[string]any)
	if !ok {
		return nil, errors.New("knowledge patch schema has no assertions")
	}
	assertionItems := assertions["items"].(map[string]any)
	assertionProperties := assertionItems["properties"].(map[string]any)
	assertionProperties["predicate"].(map[string]any)["enum"] = propertyKeys
	qualifiers := assertionProperties["qualifiers"].(map[string]any)
	qualifierItems := qualifiers["items"].(map[string]any)
	qualifierProperties := qualifierItems["properties"].(map[string]any)
	qualifierProperties["predicate"].(map[string]any)["enum"] = propertyKeys
	return json.Marshal(root)
}

func ontologyPatchPolicy(contract ontologyPatchContract) string {
	encoded, err := json.Marshal(contract)
	if err != nil {
		panic(err)
	}
	return "Use only the exact ontology term_key values in this active local contract; do not add prefixes, invent a class or property, or propose a new ontology term. object_property accepts only object_entity_id/entity_id values and datatype_property accepts only object_literal/literal values. Model engineering runs as experiment, their scalar results as measurement entities with has_value, and connect them using the listed object properties. Active contract: " + string(encoded)
}
