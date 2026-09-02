package research

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
)

type storedSU2CFDCase struct {
	Operation string                    `json:"operation"`
	Arguments storedSU2CFDCaseArguments `json:"arguments"`
}

type storedSU2CFDCaseArguments struct {
	RunID           string            `json:"run_id"`
	StageAttemptID  string            `json:"stage_attempt_id"`
	CaseID          string            `json:"case_id"`
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

func (arguments storedSU2CFDCaseArguments) planCase() core.SU2CasePlan {
	return core.SU2CasePlan{
		ID:         arguments.CaseID,
		MeshSource: arguments.MeshSource, MeshID: arguments.MeshID, MeshSHA256: arguments.MeshSHA256,
		ConfigSource: arguments.ConfigSource, ConfigID: arguments.ConfigID, ConfigSHA256: arguments.ConfigSHA256,
		Solver: arguments.Solver, TurbulenceModel: arguments.TurbulenceModel,
		ConfigOverrides: arguments.ConfigOverrides, OutputFiles: arguments.OutputFiles,
		TimeoutSeconds: arguments.TimeoutSeconds,
	}
}

func (engine *Engine) reusableGeneralSU2Cases(
	ctx context.Context,
	runID string,
	cycle int,
) (*core.SU2CaseSetPlan, []store.EngineeringResult, error) {
	results, err := engine.db.RemediationEngineeringResults(ctx, runID, "su2_cfd", cycle)
	if err != nil {
		return nil, nil, err
	}
	if len(results) == 0 {
		return nil, nil, nil
	}
	plan, err := generalSU2CaseSetForRemediation(runID, results)
	if err != nil {
		return nil, nil, err
	}
	return plan, results, nil
}

func generalSU2CaseSetForRemediation(runID string, results []store.EngineeringResult) (*core.SU2CaseSetPlan, error) {
	if runID == "" || len(results) == 0 {
		return nil, errors.New("general SU2 remediation receipts are required")
	}
	plan := &core.SU2CaseSetPlan{
		Objective: "Revalidate the exact verified SU2 cases from the prior research cycle without solver re-execution.",
		Cases:     make([]core.SU2CasePlan, 0, len(results)),
	}
	seen := make(map[string]struct{}, len(results))
	for _, result := range results {
		job := result.Job
		if job.RunID != runID || job.Operation != "su2_cfd" || job.Status != "succeeded" || job.ReceiptArtifactID == "" {
			return nil, fmt.Errorf("remediation SU2 job %q is not a succeeded immutable receipt", job.ID)
		}
		var stored storedSU2CFDCase
		if err := decodeJSONOne([]byte(job.SpecJSON), &stored); err != nil {
			return nil, fmt.Errorf("decode remediation SU2 job %s: %w", job.ID, err)
		}
		if stored.Operation != "su2_cfd" {
			return nil, fmt.Errorf("remediation SU2 job %s has operation %q", job.ID, stored.Operation)
		}
		if stored.Arguments.RunID != runID || stored.Arguments.StageAttemptID != job.StageAttemptID {
			return nil, fmt.Errorf("remediation SU2 job %s has inconsistent run or attempt identity", job.ID)
		}
		casePlan := stored.Arguments.planCase()
		if err := casePlan.Validate(); err != nil {
			return nil, fmt.Errorf("remediation SU2 job %s case contract: %w", job.ID, err)
		}
		if _, duplicate := seen[casePlan.ID]; duplicate {
			return nil, fmt.Errorf("remediation SU2 case %q is duplicated", casePlan.ID)
		}
		seen[casePlan.ID] = struct{}{}
		plan.Cases = append(plan.Cases, casePlan)
	}
	if err := plan.Validate(); err != nil {
		return nil, err
	}
	return plan, nil
}

// verifyPlannedSU2Cases proves that the general adapter executed exactly the
// immutable plan matrix once in the deterministic owner attempt and that every
// succeeded receipt is present in that attempt's evidence bundle.
func (engine *Engine) verifyPlannedSU2Cases(
	ctx context.Context,
	runID string,
	plan core.ResearchPlan,
	ownerBundle core.EvidenceBundle,
) error {
	jobs, err := engine.db.ListRunEngineeringJobs(ctx, runID, "su2_cfd")
	if err != nil {
		return err
	}
	reused := false
	if len(jobs) == 0 && plan.SU2Cases != nil {
		remediation, remediationErr := engine.db.LatestResearchRemediation(ctx, runID)
		if remediationErr == nil {
			input := &researchRemediationInput{Action: remediation.Action, Tasks: remediation.Tasks}
			if !remediationNeedsNewSolverExecution(input) {
				reusablePlan, results, reusableErr := engine.reusableGeneralSU2Cases(ctx, runID, remediation.Cycle)
				if reusableErr != nil {
					return reusableErr
				}
				expectedJSON, _ := json.Marshal(plan.SU2Cases)
				actualJSON, _ := json.Marshal(reusablePlan)
				if reusablePlan != nil && bytes.Equal(expectedJSON, actualJSON) {
					jobs = make([]store.EngineeringJob, 0, len(results))
					for _, result := range results {
						jobs = append(jobs, result.Job)
					}
					reused = true
				}
			}
		} else if !errors.Is(remediationErr, sql.ErrNoRows) {
			return remediationErr
		}
	}
	if plan.SU2Cases == nil {
		if len(jobs) != 0 {
			return errors.New("su2_cfd executed without an immutable su2_cases plan contract")
		}
		return nil
	}
	if err := plan.SU2Cases.Validate(); err != nil {
		return err
	}
	expected := make(map[string]core.SU2CasePlan, len(plan.SU2Cases.Cases))
	for _, item := range plan.SU2Cases.Cases {
		expected[item.ID] = item
	}
	cited := make(map[string]struct{}, len(ownerBundle.Sources))
	for _, source := range ownerBundle.Sources {
		if artifactID, ok := core.EngineeringReceiptArtifactID(source); ok {
			cited[artifactID] = struct{}{}
		}
	}
	observed := make(map[string]string, len(jobs))
	ownerAttemptID := ""
	for _, job := range jobs {
		attempt, err := engine.db.StageAttempt(ctx, runID, job.StageAttemptID)
		if err != nil {
			return err
		}
		if reused {
			if attempt.Stage != core.StageCollect || attempt.Status != "superseded" {
				return fmt.Errorf("reused SU2 job %s is outside the sealed remediation cycle", job.ID)
			}
		} else {
			if attempt.Stage != core.StageCollect || attempt.Ordinal != core.EngineeringScreeningOwnerOrdinal ||
				(attempt.Status != "in_progress" && attempt.Status != "completed") {
				return fmt.Errorf("SU2 job %s is outside the active deterministic owner attempt", job.ID)
			}
			if ownerAttemptID == "" {
				ownerAttemptID = attempt.ID
			} else if ownerAttemptID != attempt.ID {
				return fmt.Errorf("SU2 jobs span owner attempts %s and %s", ownerAttemptID, attempt.ID)
			}
		}
		var stored storedSU2CFDCase
		if err := decodeJSONOne([]byte(job.SpecJSON), &stored); err != nil || stored.Operation != "su2_cfd" {
			return fmt.Errorf("SU2 job %s has an invalid general-case specification", job.ID)
		}
		if stored.Arguments.RunID != runID || stored.Arguments.StageAttemptID != attempt.ID {
			return fmt.Errorf("SU2 job %s does not belong to its run and owner attempt", job.ID)
		}
		actualCase := stored.Arguments.planCase()
		planned, exists := expected[actualCase.ID]
		if !exists {
			return fmt.Errorf("SU2 job %s adds unplanned case %q", job.ID, actualCase.ID)
		}
		plannedJSON, _ := json.Marshal(planned)
		actualJSON, _ := json.Marshal(actualCase)
		if !bytes.Equal(plannedJSON, actualJSON) {
			return fmt.Errorf("SU2 job %s differs from planned case %q", job.ID, planned.ID)
		}
		if prior, duplicate := observed[planned.ID]; duplicate {
			return fmt.Errorf("SU2 jobs %s and %s duplicate planned case %q", prior, job.ID, planned.ID)
		}
		observed[planned.ID] = job.ID
		if job.Status != "succeeded" || job.ReceiptArtifactID == "" {
			return fmt.Errorf("SU2 job %s is %s or receipt-less", job.ID, job.Status)
		}
		if _, ok := cited[job.ReceiptArtifactID]; !ok {
			return fmt.Errorf("SU2 owner bundle omits receipt %s for job %s", job.ReceiptArtifactID, job.ID)
		}
	}
	for id := range expected {
		if _, exists := observed[id]; !exists {
			return fmt.Errorf("SU2 workflow omits planned case %q", id)
		}
	}
	if len(jobs) != len(expected) {
		return fmt.Errorf("SU2 workflow has %d jobs, want exactly %d", len(jobs), len(expected))
	}
	return nil
}
