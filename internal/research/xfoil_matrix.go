package research

import (
	"context"
	"errors"
	"fmt"

	"github.com/djkim0320/AetherOps/internal/core"
)

// executePlannedXFOILScreening materializes the PLAN Cartesian product once,
// obtains one bounded user authorization, and executes every exact cell in
// deterministic project FIFO order. The collector model never owns this loop.
func (engine *Engine) executePlannedXFOILScreening(
	ctx context.Context,
	run core.Run,
	attempt core.StageAttempt,
	plan core.XFOILScreeningPlan,
) error {
	if engine.xfoilRunner == nil || engine.xfoilAuthorizer == nil {
		return errors.New("planned XFOIL screening requires the app-owned runner and authorizer")
	}
	if err := plan.Validate(); err != nil {
		return err
	}
	// A prior attempt that crossed the solver boundary cannot be replayed after
	// interruption. The user's explicit resume decision is not authorization to
	// resend an external numerical job.
	records, err := engine.plannedXFOILScreeningRecords(ctx, run.ID, false)
	if err != nil {
		return err
	}
	if len(records) != 0 {
		return fmt.Errorf("%w: planned XFOIL screening already has %d job records from another execution boundary", ErrUnsafeResume, len(records))
	}

	type cell struct {
		point      core.XFOILOperatingPoint
		deflection float64
		arguments  []byte
	}
	points := plan.EffectiveOperatingPoints()
	cells := make([]cell, 0, len(points)*len(plan.CandidateDeflectionsDeg))
	approvalArguments := make([][]byte, 0, cap(cells))
	for _, point := range points {
		for _, deflection := range plan.CandidateDeflectionsDeg {
			arguments, err := engine.xfoilRunner.CanonicalXFOILScreeningArguments(
				run.ID, attempt.ID, plan, point, deflection,
			)
			if err != nil {
				return fmt.Errorf("materialize XFOIL cell %s/%g: %w", point.ID, deflection, err)
			}
			cells = append(cells, cell{point: point, deflection: deflection, arguments: arguments})
			approvalArguments = append(approvalArguments, arguments)
		}
	}
	if err := engine.xfoilAuthorizer.AuthorizeXFOILScreening(ctx, run, attempt, approvalArguments); err != nil {
		return err
	}
	for index, item := range cells {
		receiptID, err := engine.xfoilRunner.RunXFOILScreeningCell(
			ctx, run.ID, attempt.ID, plan, item.point, item.deflection,
		)
		if err != nil {
			return fmt.Errorf("execute planned XFOIL cell %d/%d (%s/%g): %w",
				index+1, len(cells), item.point.ID, item.deflection, err)
		}
		if receiptID == "" {
			return fmt.Errorf("planned XFOIL cell %d/%d completed without a receipt", index+1, len(cells))
		}
	}
	return nil
}
