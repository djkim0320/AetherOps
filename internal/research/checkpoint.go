package research

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/store"
)

// workflowCheckpoint is reconstructed exclusively from completed structured
// output artifacts. It deliberately has no representation for prompts,
// internal reasoning, or partial model output.
type workflowCheckpoint struct {
	hasAttempts     bool
	plan            *core.ResearchPlan
	evidence        map[string]core.EvidenceBundle
	collectOrdinals map[string]int
	reports         map[int]core.ReportManifest // 0=synthesis; 1..3=revisions
	reviews         map[int]core.ReviewVerdict  // 0=initial; 1..3=post-revision
}

func newWorkflowCheckpoint() workflowCheckpoint {
	return workflowCheckpoint{
		evidence:        map[string]core.EvidenceBundle{},
		collectOrdinals: map[string]int{},
		reports:         map[int]core.ReportManifest{},
		reviews:         map[int]core.ReviewVerdict{},
	}
}

func (engine *Engine) loadCheckpoint(ctx context.Context, run core.Run) (workflowCheckpoint, error) {
	checkpoint := newWorkflowCheckpoint()
	attempts, err := engine.db.ListStageAttempts(ctx, run.ID)
	if err != nil {
		return checkpoint, err
	}
	artifacts, err := engine.db.ListArtifacts(ctx, run.ID)
	if err != nil {
		return checkpoint, err
	}
	artifactsByAttempt := make(map[string][]store.Artifact, len(artifacts))
	for _, artifact := range artifacts {
		artifactsByAttempt[artifact.StageAttemptID] = append(artifactsByAttempt[artifact.StageAttemptID], artifact)
	}

	for _, attempt := range attempts {
		if attempt.Status == "superseded" {
			continue
		}
		checkpoint.hasAttempts = true
		if attempt.Status != "completed" {
			return checkpoint, fmt.Errorf("%w: stage %s/%d is %s", ErrUnsafeResume, attempt.Stage, attempt.Ordinal, attempt.Status)
		}
		if strings.TrimSpace(attempt.CodexThreadID) == "" || strings.TrimSpace(attempt.CodexTurnID) == "" {
			return checkpoint, fmt.Errorf("%w: completed stage %s/%d lacks thread or turn identity", ErrUnsafeResume, attempt.Stage, attempt.Ordinal)
		}
		if strings.TrimSpace(attempt.OutputArtifactHash) == "" {
			return checkpoint, fmt.Errorf("%w: completed stage %s/%d lacks an output hash", ErrUnsafeResume, attempt.Stage, attempt.Ordinal)
		}
		if !hasPublishedOutput(artifactsByAttempt[attempt.ID], attempt.OutputArtifactHash) {
			return checkpoint, fmt.Errorf("%w: completed stage %s/%d has no matching published artifact", ErrUnsafeResume, attempt.Stage, attempt.Ordinal)
		}
		if attempt.ExternalSideEffects {
			receipt, err := engine.db.StageExecutionReceipt(ctx, attempt.ID)
			if err != nil {
				return checkpoint, fmt.Errorf("%w: side-effect stage %s/%d lacks a durable execution receipt: %v", ErrUnsafeResume, attempt.Stage, attempt.Ordinal, err)
			}
			expectedProfile, err := profileForStage(run.ResearchProfileVersion, attempt.Stage)
			if err != nil {
				return checkpoint, fmt.Errorf("%w: side-effect stage %s/%d profile is invalid: %v", ErrUnsafeResume, attempt.Stage, attempt.Ordinal, err)
			}
			if receipt.StageAttemptID != attempt.ID || receipt.RunID != run.ID ||
				receipt.ResearchProfileVersion != run.ResearchProfileVersion ||
				receipt.Model != expectedProfile.Model ||
				receipt.ReasoningEffort != expectedProfile.ReasoningEffort ||
				receipt.ServiceTier != expectedProfile.ServiceTier ||
				receipt.CodexThreadID != attempt.CodexThreadID || receipt.CodexTurnID != attempt.CodexTurnID ||
				receipt.InputSHA256 != attempt.InputArtifactHash || receipt.OutputSHA256 != attempt.OutputArtifactHash ||
				receipt.ExecutionContractSHA256 != core.StageExecutionContractSHA256 ||
				receipt.ProductBuild != run.ProductBuild {
				return checkpoint, fmt.Errorf("%w: side-effect stage %s/%d execution receipt is inconsistent", ErrUnsafeResume, attempt.Stage, attempt.Ordinal)
			}
		}
		output, err := engine.cas.ReadVerified(attempt.OutputArtifactHash)
		if err != nil {
			return checkpoint, fmt.Errorf("%w: verify %s/%d output: %v", ErrUnsafeResume, attempt.Stage, attempt.Ordinal, err)
		}
		if err := checkpoint.accept(attempt, output, run.Question); err != nil {
			return checkpoint, fmt.Errorf("%w: %v", ErrUnsafeResume, err)
		}
	}

	if checkpoint.plan == nil {
		return checkpoint, nil
	}
	if err := validateResearchPlan(*checkpoint.plan); err != nil {
		return checkpoint, fmt.Errorf("%w: invalid plan checkpoint: %v", ErrUnsafeResume, err)
	}
	if checkpoint.plan.Question != run.Question {
		return checkpoint, fmt.Errorf("%w: plan checkpoint question does not match run", ErrUnsafeResume)
	}
	workstreamOrdinals := make(map[string]int, len(checkpoint.plan.Workstreams))
	for ordinal, workstream := range checkpoint.plan.Workstreams {
		workstreamOrdinals[workstream.ID] = ordinal
	}
	for workstreamID, bundle := range checkpoint.evidence {
		if workstreamID == engineeringVerificationWorkstreamID {
			if checkpoint.collectOrdinals[workstreamID] != core.EngineeringVerificationOrdinal {
				return checkpoint, fmt.Errorf("%w: engineering verification checkpoint ordinal is inconsistent", ErrUnsafeResume)
			}
			if err := validateEvidenceBundle(bundle, engineeringVerificationWorkstreamID); err != nil {
				return checkpoint, fmt.Errorf("%w: invalid engineering verification checkpoint: %v", ErrUnsafeResume, err)
			}
			if err := engine.verifyEvidenceSources(ctx, run.ID, core.EngineeringVerificationOrdinal, bundle); err != nil {
				return checkpoint, fmt.Errorf("%w: %v", ErrUnsafeResume, err)
			}
			screeningJobIDs, screeningCandidates, err := engine.xfoilScreeningJobIDs(ctx, run.ID)
			if err != nil {
				return checkpoint, fmt.Errorf("%w: load screening jobs: %v", ErrUnsafeResume, err)
			}
			if screeningCandidates < 2 || len(screeningJobIDs) < 2 {
				return checkpoint, fmt.Errorf("%w: engineering verification has an incomplete screening set", ErrUnsafeResume)
			}
			if err := engine.validateEngineeringVerificationBundle(ctx, run.ID, bundle, screeningJobIDs); err != nil {
				return checkpoint, fmt.Errorf("%w: %v", ErrUnsafeResume, err)
			}
			continue
		}
		expectedOrdinal, exists := workstreamOrdinals[workstreamID]
		if !exists {
			return checkpoint, fmt.Errorf("%w: evidence checkpoint references unknown workstream %q", ErrUnsafeResume, workstreamID)
		}
		if checkpoint.collectOrdinals[workstreamID] != expectedOrdinal {
			return checkpoint, fmt.Errorf("%w: evidence checkpoint ordinal is inconsistent for %q", ErrUnsafeResume, workstreamID)
		}
		if err := validateEvidenceBundle(bundle, workstreamID); err != nil {
			return checkpoint, fmt.Errorf("%w: invalid evidence checkpoint: %v", ErrUnsafeResume, err)
		}
		if err := engine.verifyEvidenceSources(ctx, run.ID, expectedOrdinal, bundle); err != nil {
			return checkpoint, fmt.Errorf("%w: %v", ErrUnsafeResume, err)
		}
	}
	if len(checkpoint.plan.Workstreams) > 0 {
		ownerWorkstreamID := checkpoint.plan.Workstreams[core.EngineeringScreeningOwnerOrdinal].ID
		if owner, ok := checkpoint.evidence[ownerWorkstreamID]; ok {
			if err := engine.verifyPlannedXFOILScreeningCoverage(ctx, run.ID, *checkpoint.plan, owner); err != nil {
				return checkpoint, fmt.Errorf("%w: planned XFOIL screening checkpoint is invalid: %v", ErrUnsafeResume, err)
			}
		}
	}
	ordered, err := orderedEvidence(*checkpoint.plan, checkpoint.evidence)
	if err != nil && len(checkpoint.evidence) == len(checkpoint.plan.Workstreams) {
		return checkpoint, fmt.Errorf("%w: %v", ErrUnsafeResume, err)
	}
	if err == nil {
		for _, report := range checkpoint.reports {
			if err := report.Validate(ordered); err != nil {
				return checkpoint, fmt.Errorf("%w: invalid report checkpoint: %v", ErrUnsafeResume, err)
			}
			if err := engine.verifyReportArtifacts(ctx, run.ID, report); err != nil {
				return checkpoint, fmt.Errorf("%w: %v", ErrUnsafeResume, err)
			}
			if err := engine.verifyKnowledgePatchEvidence(ctx, run.ID, report); err != nil {
				return checkpoint, fmt.Errorf("%w: %v", ErrUnsafeResume, err)
			}
		}
		for cycle, verdict := range checkpoint.reviews {
			report, exists := checkpoint.reports[cycle]
			if !exists {
				return checkpoint, fmt.Errorf("%w: review %d has no matching report checkpoint", ErrUnsafeResume, cycle)
			}
			if err := validateReviewVerdictForReport(verdict, report); err != nil {
				return checkpoint, fmt.Errorf("%w: invalid review checkpoint: %v", ErrUnsafeResume, err)
			}
		}
	}
	return checkpoint, nil
}

func hasPublishedOutput(artifacts []store.Artifact, outputHash string) bool {
	for _, artifact := range artifacts {
		if artifact.BlobHash == outputHash {
			return true
		}
	}
	return false
}

func (checkpoint *workflowCheckpoint) accept(attempt core.StageAttempt, output []byte, question string) error {
	switch attempt.Stage {
	case core.StagePlan:
		if attempt.Ordinal != 0 || checkpoint.plan != nil {
			return errors.New("duplicate or invalid plan checkpoint")
		}
		plan, err := decodeStrict[core.ResearchPlan](json.RawMessage(output))
		if err != nil {
			return fmt.Errorf("decode plan checkpoint: %w", err)
		}
		if err := validateResearchPlan(plan); err != nil {
			return fmt.Errorf("validate plan checkpoint: %w", err)
		}
		if plan.Question != question {
			return errors.New("plan checkpoint question does not match run question")
		}
		checkpoint.plan = &plan
		return nil
	case core.StageCollect:
		if attempt.Ordinal < 0 || attempt.Ordinal > core.EngineeringVerificationOrdinal {
			return errors.New("invalid collector checkpoint ordinal")
		}
		bundle, err := decodeStrict[core.EvidenceBundle](json.RawMessage(output))
		if err != nil {
			return fmt.Errorf("decode evidence checkpoint: %w", err)
		}
		if err := validateEvidenceBundle(bundle, ""); err != nil {
			return fmt.Errorf("validate evidence checkpoint: %w", err)
		}
		if attempt.Ordinal == core.EngineeringVerificationOrdinal && bundle.WorkstreamID != engineeringVerificationWorkstreamID {
			return errors.New("reserved engineering verification ordinal contains a normal collector bundle")
		}
		if attempt.Ordinal < core.EngineeringVerificationOrdinal && bundle.WorkstreamID == engineeringVerificationWorkstreamID {
			return errors.New("engineering verification bundle is not in the reserved collector ordinal")
		}
		if _, exists := checkpoint.evidence[bundle.WorkstreamID]; exists {
			return fmt.Errorf("duplicate evidence checkpoint for workstream %q", bundle.WorkstreamID)
		}
		checkpoint.evidence[bundle.WorkstreamID] = bundle
		checkpoint.collectOrdinals[bundle.WorkstreamID] = attempt.Ordinal
		return nil
	case core.StageSynthesize:
		if attempt.Ordinal != 0 {
			return errors.New("invalid synthesis checkpoint ordinal")
		}
		return checkpoint.acceptReport(0, output)
	case core.StageRevise:
		if attempt.Ordinal < 1 || attempt.Ordinal > core.MaxRevisions {
			return errors.New("invalid revision checkpoint ordinal")
		}
		return checkpoint.acceptReport(attempt.Ordinal, output)
	case core.StageReview:
		if attempt.Ordinal < 0 || attempt.Ordinal > core.MaxRevisions {
			return errors.New("invalid review checkpoint ordinal")
		}
		if _, exists := checkpoint.reviews[attempt.Ordinal]; exists {
			return errors.New("duplicate review checkpoint")
		}
		verdict, err := decodeStrict[core.ReviewVerdict](json.RawMessage(output))
		if err != nil {
			return fmt.Errorf("decode review checkpoint: %w", err)
		}
		if err := validateReviewVerdict(verdict); err != nil {
			return fmt.Errorf("validate review checkpoint: %w", err)
		}
		checkpoint.reviews[attempt.Ordinal] = verdict
		return nil
	default:
		return fmt.Errorf("unsupported stage checkpoint %q", attempt.Stage)
	}
}

func (checkpoint *workflowCheckpoint) acceptReport(ordinal int, output []byte) error {
	if _, exists := checkpoint.reports[ordinal]; exists {
		return errors.New("duplicate report checkpoint")
	}
	report, err := decodeStrict[core.ReportManifest](json.RawMessage(output))
	if err != nil {
		return fmt.Errorf("decode report checkpoint: %w", err)
	}
	if err := validateReportManifest(report); err != nil {
		return fmt.Errorf("validate report checkpoint: %w", err)
	}
	checkpoint.reports[ordinal] = report
	return nil
}

type resumeAction string

const (
	resumeSynthesize    resumeAction = "synthesize"
	resumeReview        resumeAction = "review"
	resumeRevise        resumeAction = "revise"
	resumeSucceed       resumeAction = "succeed"
	resumeQualityFailed resumeAction = "quality_failed"
)

type checkpointResumePoint struct {
	action resumeAction
	report core.ReportManifest
	cycle  int
}

func (checkpoint workflowCheckpoint) resumePoint() (checkpointResumePoint, error) {
	if checkpoint.plan == nil {
		return checkpointResumePoint{}, fmt.Errorf("%w: plan checkpoint is absent", ErrUnsafeResume)
	}
	if _, exists := checkpoint.reports[0]; !exists {
		if len(checkpoint.reports) != 0 || len(checkpoint.reviews) != 0 {
			return checkpointResumePoint{}, fmt.Errorf("%w: later checkpoints exist without synthesis", ErrUnsafeResume)
		}
		return checkpointResumePoint{action: resumeSynthesize}, nil
	}

	report := checkpoint.reports[0]
	cycle := 0
	for {
		verdict, reviewed := checkpoint.reviews[cycle]
		if !reviewed {
			if hasCheckpointBeyond(checkpoint.reports, cycle) || hasCheckpointBeyond(checkpoint.reviews, cycle) {
				return checkpointResumePoint{}, fmt.Errorf("%w: later checkpoints exist before review %d", ErrUnsafeResume, cycle)
			}
			return checkpointResumePoint{action: resumeReview, report: report, cycle: cycle}, nil
		}

		passes, err := verdict.PassesForReport(report)
		if err != nil {
			return checkpointResumePoint{}, fmt.Errorf("%w: invalid review %d: %v", ErrUnsafeResume, cycle, err)
		}
		if passes {
			if hasCheckpointBeyond(checkpoint.reports, cycle) || hasCheckpointBeyond(checkpoint.reviews, cycle) {
				return checkpointResumePoint{}, fmt.Errorf("%w: checkpoints follow a passing review", ErrUnsafeResume)
			}
			return checkpointResumePoint{action: resumeSucceed, report: report, cycle: cycle}, nil
		}
		if cycle == core.MaxRevisions {
			if hasCheckpointBeyond(checkpoint.reports, cycle) || hasCheckpointBeyond(checkpoint.reviews, cycle) {
				return checkpointResumePoint{}, fmt.Errorf("%w: checkpoints exceed maximum revisions", ErrUnsafeResume)
			}
			return checkpointResumePoint{action: resumeQualityFailed, report: report, cycle: cycle}, nil
		}

		nextCycle := cycle + 1
		revised, revisedExists := checkpoint.reports[nextCycle]
		if !revisedExists {
			if hasCheckpointBeyond(checkpoint.reports, cycle) || hasCheckpointBeyond(checkpoint.reviews, cycle) {
				return checkpointResumePoint{}, fmt.Errorf("%w: later checkpoints exist before revision %d", ErrUnsafeResume, nextCycle)
			}
			return checkpointResumePoint{action: resumeRevise, report: report, cycle: cycle}, nil
		}
		report = revised
		cycle = nextCycle
	}
}

func hasCheckpointBeyond[T any](items map[int]T, ordinal int) bool {
	for key := range items {
		if key > ordinal {
			return true
		}
	}
	return false
}
