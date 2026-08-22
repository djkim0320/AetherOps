package evalgate

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/djkim0320/Aether-claw/internal/core"
)

// VerifyLocalRun performs the same immutable run, stage, artifact, evidence,
// memory, and knowledge checks as the release evaluator for one user-selected
// run. Unlike release evaluation it does not claim an Oxigraph runtime test;
// it verifies the canonical SQLite projection, N-Quads receipt, and CAS bytes
// directly through store.VerifyKnowledgeSnapshot instead.
func (verifier Verifier) VerifyLocalRun(
	ctx context.Context,
	projectID, runID string,
) (CaseResult, error) {
	if verifier.DB == nil || verifier.CAS == nil {
		return CaseResult{}, errors.New("local run verification requires the product SQLite store and CAS")
	}
	projectID = strings.TrimSpace(projectID)
	runID = strings.TrimSpace(runID)
	if projectID == "" || runID == "" {
		return CaseResult{}, errors.New("local run verification requires project and run ids")
	}
	run, err := verifier.DB.Run(ctx, runID)
	if err != nil {
		return CaseResult{}, fmt.Errorf("load local run: %w", err)
	}
	if run.ProjectID != projectID {
		return CaseResult{}, errors.New("local run does not belong to the requested project")
	}
	if err := run.ProductBuild.Validate(); err != nil {
		return CaseResult{}, fmt.Errorf("validate local run product build: %w", err)
	}

	attempts, err := verifier.DB.ListStageAttempts(ctx, runID)
	if err != nil {
		return CaseResult{}, fmt.Errorf("load local run stage attempts: %w", err)
	}
	var planAttempt *core.StageAttempt
	for index := range attempts {
		attempt := &attempts[index]
		if attempt.Stage == core.StagePlan {
			if planAttempt != nil {
				return CaseResult{}, errors.New("local run contains multiple plan attempts")
			}
			planAttempt = attempt
		}
	}
	if planAttempt == nil {
		return CaseResult{}, errors.New("local run has no plan attempt")
	}
	var plan core.ResearchPlan
	if err := verifier.readStrict(planAttempt.OutputArtifactHash, &plan); err != nil {
		return CaseResult{}, fmt.Errorf("read local run plan: %w", err)
	}
	if err := plan.Validate(); err != nil {
		return CaseResult{}, fmt.Errorf("validate local run plan: %w", err)
	}

	result := verifier.verifyRun(ctx, "local-run", run.Question, plan.Mode, runID, false)
	if !result.Passed {
		return result, errors.New(result.Failure)
	}
	return result, nil
}

func (verifier Verifier) verifyKnowledgeSnapshot(
	ctx context.Context,
	projectID, generationID string,
	requireOxigraph bool,
) error {
	if requireOxigraph {
		return verifier.verifyRequiredOxigraphSnapshot(ctx, projectID, generationID)
	}
	return verifier.DB.VerifyKnowledgeSnapshot(ctx, projectID, generationID, verifier.CAS)
}
