package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/djkim0320/AetherOps/internal/core"
)

// ErrXFOILScreeningOwner is returned when a normal collector other than the
// fixed screening owner attempts to authorize or execute an optimization
// screening job. It is deliberately distinct from duplicate-scope rejection:
// a different candidate is still forbidden in the wrong collector attempt.
var ErrXFOILScreeningOwner = errors.New("XFOIL screening is restricted to the deterministic collector owner")

func requireXFOILScreeningApprovalOwner(approval core.Approval, logicalOrdinal int) error {
	if approval.Kind != "item/mcpToolCall/requestApproval" ||
		approval.Server != "aetherops_engineering" || approval.Tool != "xfoil_polar" ||
		!approval.ExternalSideEffect || approval.ArgumentsJSON == "" {
		return nil
	}
	var arguments struct {
		RunID            string `json:"run_id"`
		StageAttemptID   string `json:"stage_attempt_id"`
		ExecutionPurpose string `json:"execution_purpose"`
	}
	if err := json.Unmarshal([]byte(approval.ArgumentsJSON), &arguments); err != nil {
		return errors.New("decode XFOIL screening owner approval arguments")
	}
	if arguments.ExecutionPurpose != "screening" {
		return nil
	}
	if arguments.RunID != approval.RunID || arguments.StageAttemptID != approval.StageAttemptID {
		return errors.New("XFOIL screening approval capability does not match its run or stage attempt")
	}
	if logicalOrdinal != core.EngineeringScreeningOwnerOrdinal {
		return fmt.Errorf("%w: collector ordinal %d, owner ordinal %d",
			ErrXFOILScreeningOwner, logicalOrdinal, core.EngineeringScreeningOwnerOrdinal)
	}
	return nil
}

// requireXFOILScreeningJobOwner repeats the owner check at the process-launch
// boundary. Approval routing alone is not a sufficient trust boundary because
// a stale or corrupted approval row must never authorize a non-owner process.
func requireXFOILScreeningJobOwner(
	ctx context.Context,
	transaction *sql.Tx,
	job EngineeringJob,
) error {
	if job.Operation != "xfoil_polar" || job.SpecJSON == "" {
		return nil
	}
	var envelope struct {
		Arguments struct {
			RunID            string `json:"run_id"`
			StageAttemptID   string `json:"stage_attempt_id"`
			ExecutionPurpose string `json:"execution_purpose"`
		} `json:"arguments"`
	}
	if err := json.Unmarshal([]byte(job.SpecJSON), &envelope); err != nil {
		return errors.New("decode XFOIL screening owner job specification")
	}
	if envelope.Arguments.ExecutionPurpose != "screening" {
		return nil
	}
	if envelope.Arguments.RunID != job.RunID || envelope.Arguments.StageAttemptID != job.StageAttemptID {
		return errors.New("XFOIL screening job capability does not match its run or stage attempt")
	}
	var stage string
	var logicalOrdinal int
	if err := transaction.QueryRowContext(ctx, `
SELECT stage, logical_ordinal
FROM stage_attempts
WHERE id=? AND run_id=?`, job.StageAttemptID, job.RunID).Scan(&stage, &logicalOrdinal); err != nil {
		return err
	}
	if stage != string(core.StageCollect) || logicalOrdinal != core.EngineeringScreeningOwnerOrdinal {
		return fmt.Errorf("%w: stage %s collector ordinal %d, owner ordinal %d",
			ErrXFOILScreeningOwner, stage, logicalOrdinal, core.EngineeringScreeningOwnerOrdinal)
	}
	return nil
}
