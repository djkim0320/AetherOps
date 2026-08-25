package approval

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
)

var ErrPlannedEngineeringDenied = errors.New("planned engineering matrix was denied by the user")

type coreDecision struct {
	approval core.Approval
	err      error
}

type corePending struct {
	prior core.RunStatus
	done  chan coreDecision
}

// CoreAuthorizer owns approvals initiated by the Go research state machine
// rather than by an App Server event. One visible decision authorizes only the
// immutable, bounded list supplied here; every remaining cell receives its own
// exact approved hash row before the solver boundary can be crossed.
type CoreAuthorizer struct {
	DB *store.DB

	mu      sync.Mutex
	pending map[string]corePending
}

func (authorizer *CoreAuthorizer) AuthorizeXFOILScreening(
	ctx context.Context,
	run core.Run,
	attempt core.StageAttempt,
	arguments [][]byte,
) error {
	if authorizer.DB == nil {
		return errors.New("core engineering authorizer database is required")
	}
	if len(arguments) == 0 || len(arguments) > 64 {
		return errors.New("planned engineering approval requires 1-64 exact cells")
	}
	approvals := make([]core.Approval, len(arguments))
	for index, raw := range arguments {
		if !json.Valid(raw) {
			return fmt.Errorf("planned engineering cell %d has invalid JSON", index+1)
		}
		digest := sha256.Sum256(raw)
		approvals[index] = core.Approval{
			RunID: run.ID, StageAttemptID: attempt.ID,
			ThreadID: "aetherops-core", TurnID: "xfoil-matrix-" + attempt.ID,
			ItemID:  fmt.Sprintf("xfoil-cell-%03d", index+1),
			Kind:    "item/mcpToolCall/requestApproval",
			Summary: fmt.Sprintf("계획된 XFOIL 최적화 행렬 %d개 셀을 정확한 PLAN 범위로 실행", len(arguments)),
			Server:  "aetherops_engineering", Tool: "xfoil_polar",
			ArgumentsJSON: string(raw), ArgumentsSHA256: hex.EncodeToString(digest[:]),
			Risk: "external_side_effect", ExternalSideEffect: true,
		}
	}

	current, err := authorizer.DB.Run(ctx, run.ID)
	if err != nil {
		return err
	}
	if current.Status != core.RunCollecting {
		return fmt.Errorf("planned engineering approval cannot wait while run is %s", current.Status)
	}
	if _, err := authorizer.DB.TransitionRun(ctx, current.ID, current.Revision, core.RunWaitingApproval, ""); err != nil {
		return err
	}
	visible, err := authorizer.DB.CreateApproval(ctx, approvals[0])
	if err != nil {
		_, restoreErr := authorizer.DB.ResumeRunAfterApproval(context.WithoutCancel(ctx), run.ID, core.RunCollecting)
		return errors.Join(err, restoreErr)
	}
	pending := corePending{prior: core.RunCollecting, done: make(chan coreDecision, 1)}
	authorizer.mu.Lock()
	if authorizer.pending == nil {
		authorizer.pending = make(map[string]corePending)
	}
	authorizer.pending[visible.ID] = pending
	authorizer.mu.Unlock()

	select {
	case <-ctx.Done():
		authorizer.forget(visible.ID)
		return ctx.Err()
	case decision := <-pending.done:
		if decision.err != nil {
			return decision.err
		}
	}

	// Cell zero is the visible approval. Remaining cells are exact child scopes
	// derived from the same immutable PLAN, never from model output.
	for index := 1; index < len(approvals); index++ {
		created, err := authorizer.DB.CreateApproval(ctx, approvals[index])
		if err != nil {
			return fmt.Errorf("create planned engineering cell %d approval: %w", index+1, err)
		}
		if _, err := authorizer.DB.DecideApproval(ctx, created.ID, "approved"); err != nil {
			return fmt.Errorf("approve planned engineering cell %d scope: %w", index+1, err)
		}
	}
	return nil
}

// Decide resolves only a currently-live core approval. It never sends an App
// Server response because no model request exists for this boundary.
func (authorizer *CoreAuthorizer) Decide(ctx context.Context, approvalID, decision string) (core.Approval, error) {
	authorizer.mu.Lock()
	pending, ok := authorizer.pending[approvalID]
	authorizer.mu.Unlock()
	if !ok {
		return core.Approval{}, errors.New("core approval request is not active")
	}
	approval, err := authorizer.DB.DecideActiveApproval(ctx, approvalID, decision)
	if err != nil {
		if errors.Is(err, store.ErrApprovalNotActive) {
			authorizer.forget(approvalID)
		}
		return approval, err
	}
	if _, err := authorizer.DB.ResumeRunAfterApproval(ctx, approval.RunID, pending.prior); err != nil {
		authorizer.forget(approvalID)
		pending.done <- coreDecision{approval: approval, err: err}
		return approval, fmt.Errorf("restore run after core approval: %w", err)
	}
	authorizer.forget(approvalID)
	if decision == "denied" {
		pending.done <- coreDecision{approval: approval, err: ErrPlannedEngineeringDenied}
	} else {
		pending.done <- coreDecision{approval: approval}
	}
	return approval, nil
}

func (authorizer *CoreAuthorizer) Owns(approvalID string) bool {
	authorizer.mu.Lock()
	defer authorizer.mu.Unlock()
	_, ok := authorizer.pending[approvalID]
	return ok
}

func (authorizer *CoreAuthorizer) forget(approvalID string) {
	authorizer.mu.Lock()
	delete(authorizer.pending, approvalID)
	authorizer.mu.Unlock()
}

// CombinedController routes UI decisions to the owner of the pending request.
// Unknown ids remain fail-closed at the ordinary Codex router.
type CombinedController struct {
	Core  *CoreAuthorizer
	Codex *Router
}

func (controller CombinedController) Decide(ctx context.Context, approvalID, decision string) (core.Approval, error) {
	if controller.Core != nil && controller.Core.Owns(approvalID) {
		return controller.Core.Decide(ctx, approvalID, decision)
	}
	if controller.Codex == nil {
		return core.Approval{}, errors.New("Codex approval router is unavailable")
	}
	return controller.Codex.Decide(ctx, approvalID, decision)
}
