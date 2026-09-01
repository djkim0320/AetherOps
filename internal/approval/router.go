package approval

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/codex"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
	"github.com/djkim0320/AetherOps/internal/toolstudio"
)

type Client interface {
	Events() <-chan codex.Event
	RespondApproval(context.Context, codex.Event, string) error
}

type pendingApproval struct {
	event                      codex.Event
	prior                      core.RunStatus
	runID                      string
	routerOwnsExternalBoundary bool
}

// responseAttemptedError means the App Server response boundary was crossed,
// but its outcome was not observed. The router must never answer the same
// request with the opposite decision after seeing this error.
type responseAttemptedError struct {
	decision string
	err      error
}

func (err *responseAttemptedError) Error() string {
	return fmt.Sprintf("Codex approval %s response outcome is unknown: %v", err.decision, err.err)
}

func (err *responseAttemptedError) Unwrap() error { return err.err }

func attemptedResponse(decision string, err error) error {
	if err == nil {
		return nil
	}
	return &responseAttemptedError{decision: decision, err: err}
}

type Router struct {
	DB                 *store.DB
	CAS                *cas.Store
	Client             Client
	AllowedUploadRoots []string

	mu      sync.Mutex
	pending map[string]pendingApproval
}

func (router *Router) Run(ctx context.Context) error {
	if router.DB == nil || router.Client == nil {
		return errors.New("approval router database and Codex client are required")
	}
	router.mu.Lock()
	if router.pending == nil {
		router.pending = make(map[string]pendingApproval)
	}
	router.mu.Unlock()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case event, ok := <-router.Client.Events():
			if !ok {
				return errors.New("Codex approval event stream closed")
			}
			if !event.IsApprovalRequest() {
				continue
			}
			if err := router.handle(ctx, event); err != nil {
				var attempted *responseAttemptedError
				if errors.As(err, &attempted) {
					return err
				}
				if responseErr := router.Client.RespondApproval(ctx, event, "decline"); responseErr != nil {
					return attemptedResponse("decline", errors.Join(err, responseErr))
				}
				continue
			}
		}
	}
}

func (router *Router) handle(ctx context.Context, event codex.Event) error {
	request, err := decodeRequest(event)
	if err != nil {
		return err
	}
	if isChromeUpload(request) {
		if err := router.validateUploadArguments(request.Arguments); err != nil {
			return err
		}
	}
	attempt, err := router.DB.ActiveStageAttemptByThread(ctx, request.ThreadID)
	if err != nil {
		return fmt.Errorf("resolve approval stage: %w", err)
	}
	if attempt.Stage == core.StageCollect && attempt.Ordinal == core.EngineeringVerificationOrdinal {
		if err := validateEngineeringVerificationApproval(event.Method, request, attempt); err != nil {
			return err
		}
	}
	if attempt.Stage == core.StageCollect && strings.Contains(event.Method, "commandExecution") &&
		isNetworkDownloadShellCommand(request.Command) {
		return errors.New("research COLLECT rejects network download shell commands; use the app-owned evidence capture path")
	}
	argumentsJSON := ""
	argumentsSHA256 := ""
	if request.Arguments != nil {
		normalizedArguments := request.Arguments
		if text, ok := request.Arguments.(string); ok && json.Valid([]byte(text)) {
			if decodeErr := json.Unmarshal([]byte(text), &normalizedArguments); decodeErr != nil {
				return fmt.Errorf("decode approval arguments: %w", decodeErr)
			}
		}
		encoded, encodeErr := json.Marshal(normalizedArguments)
		if encodeErr != nil {
			return fmt.Errorf("encode approval arguments: %w", encodeErr)
		}
		argumentsJSON = string(encoded)
		digest := sha256.Sum256(encoded)
		argumentsSHA256 = hex.EncodeToString(digest[:])
	}
	if isEngineeringSolverApproval(event.Method, request) && argumentsSHA256 != "" {
		readbackOnly, readbackErr := router.DB.EngineeringReceiptReadbackOnly(ctx, attempt.RunID, attempt.ID)
		if readbackErr != nil {
			return fmt.Errorf("resolve engineering receipt-readback scope: %w", readbackErr)
		}
		if readbackOnly {
			// REVIEW remediation can authorize immutable receipt readback, never a
			// solver side effect. Decline in-protocol without creating a pending UI
			// approval or marking the run uncertain.
			if err := router.Client.RespondApproval(ctx, event, "decline"); err != nil {
				return attemptedResponse("decline", err)
			}
			return nil
		}
		tool := strings.ToLower(strings.TrimSpace(request.Tool))
		_, replay, lookupErr := router.DB.SucceededEngineeringJobForApprovalScope(
			ctx, attempt.RunID, attempt.ID, tool, argumentsSHA256,
		)
		if lookupErr != nil {
			return fmt.Errorf("resolve completed engineering replay: %w", lookupErr)
		}
		if replay {
			// No authorization row is created here. The service can only read the
			// exact runtime-bound completed spec; if that stronger identity does
			// not match, BeginEngineeringJob has no approval with which to execute.
			if err := router.Client.RespondApproval(ctx, event, "accept"); err != nil {
				return attemptedResponse("accept", err)
			}
			return nil
		}
		if strings.EqualFold(strings.TrimSpace(request.Tool), "xfoil_polar") &&
			router.CAS != nil && router.approvedPlanAuthorizesXFOILScreening(ctx, attempt, []byte(argumentsJSON)) {
			// Materialize the exact per-cell authorization before acknowledging
			// the App Server request. The solver service requires this hash row and
			// owns the external-side-effect boundary atomically with its job.
			planned, err := router.DB.CreateApproval(ctx, core.Approval{
				RunID: attempt.RunID, StageAttemptID: attempt.ID,
				ThreadID: request.ThreadID, TurnID: request.TurnID, ItemID: request.ItemID,
				Kind: canonicalApprovalKind(event.Method), Summary: request.Summary,
				Server: request.Server, Tool: request.Tool,
				ArgumentsJSON: argumentsJSON, ArgumentsSHA256: argumentsSHA256,
				Risk: "external_side_effect", ExternalSideEffect: true,
			})
			if err != nil {
				return err
			}
			if _, err := router.DB.DecideApproval(ctx, planned.ID, "approved"); err != nil {
				return err
			}
			if err := router.Client.RespondApproval(ctx, event, "accept"); err != nil {
				responseErr := err
				if markErr := router.markUncertain(ctx, attempt.RunID, err); markErr != nil {
					responseErr = errors.Join(responseErr, fmt.Errorf("record uncertain planned XFOIL response: %w", markErr))
				}
				return attemptedResponse("accept", responseErr)
			}
			return nil
		}
	}
	portableGrant, err := router.approvedPortableToolRun(ctx, event.Method, request, attempt, argumentsJSON)
	if err != nil {
		return err
	}
	if portableGrant {
		if err := router.DB.MarkActiveStageExternalSideEffects(ctx, attempt.ID); err != nil {
			return err
		}
		if err := router.Client.RespondApproval(ctx, event, "accept"); err != nil {
			responseErr := err
			if markErr := router.markUncertain(ctx, attempt.RunID, err); markErr != nil {
				responseErr = errors.Join(responseErr, fmt.Errorf("record uncertain portable tool approval outcome: %w", markErr))
			}
			return attemptedResponse("accept", responseErr)
		}
		return nil
	}
	allowed, externalSideEffect := automaticPolicy(event.Method, request)
	if allowed {
		if externalSideEffect {
			if err := router.DB.MarkActiveStageExternalSideEffects(ctx, attempt.ID); err != nil {
				return err
			}
		}
		if err := router.Client.RespondApproval(ctx, event, "accept"); err != nil {
			responseErr := err
			if externalSideEffect {
				if markErr := router.markUncertain(ctx, attempt.RunID, err); markErr != nil {
					responseErr = errors.Join(responseErr, fmt.Errorf("record uncertain approval outcome: %w", markErr))
				}
			}
			return attemptedResponse("accept", responseErr)
		}
		return nil
	}
	if isEngineeringSolverApproval(event.Method, request) {
		retried, err := router.deniedEngineeringRetry(ctx, attempt, canonicalApprovalKind(event.Method), request.Server, request.Tool)
		if err != nil {
			return err
		}
		if retried {
			// One denial is a complete user decision for this stage/tool. A model
			// may not evade it by changing an unplanned numerical cell and asking
			// again. Close the collector before acknowledging the second request.
			cause := "engineering approval was denied and the collector requested the same solver again"
			if _, err := router.DB.FailCollectStageAndQuiesceRun(ctx, attempt.ID, "", cause); err != nil {
				return err
			}
			if err := router.Client.RespondApproval(ctx, event, "decline"); err != nil {
				return attemptedResponse("decline", err)
			}
			if interrupter, ok := router.Client.(interface {
				InterruptTurn(context.Context, string, string) error
			}); ok {
				cleanupContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
				defer cancel()
				_ = interrupter.InterruptTurn(cleanupContext, request.ThreadID, request.TurnID)
			}
			return nil
		}
	}
	run, err := router.DB.Run(ctx, attempt.RunID)
	if err != nil {
		return err
	}
	prior := run.Status
	if run.Status == core.RunWaitingApproval {
		var found bool
		router.mu.Lock()
		for _, pending := range router.pending {
			if pending.runID == run.ID {
				prior = pending.prior
				found = true
				break
			}
		}
		router.mu.Unlock()
		if !found {
			return errors.New("run is waiting on an approval that is not active in this Codex session")
		}
	}
	risk := "read_only"
	if externalSideEffect {
		risk = "external_side_effect"
	}
	approval, err := router.DB.CreateApproval(ctx, core.Approval{
		RunID: run.ID, StageAttemptID: attempt.ID,
		ThreadID: request.ThreadID, TurnID: request.TurnID, ItemID: request.ItemID,
		Kind: canonicalApprovalKind(event.Method), Summary: request.Summary, Server: request.Server,
		Tool: request.Tool, Command: request.Command, ArgumentsJSON: argumentsJSON,
		ArgumentsSHA256: argumentsSHA256, Risk: risk,
		ExternalSideEffect: externalSideEffect,
	})
	if err != nil {
		return err
	}
	if run.Status != core.RunWaitingApproval {
		if !core.CanTransition(run.Status, core.RunWaitingApproval) {
			return fmt.Errorf("run %s cannot wait for approval from %s", run.ID, run.Status)
		}
		if _, err := router.DB.TransitionRun(ctx, run.ID, run.Revision, core.RunWaitingApproval, ""); err != nil {
			return err
		}
	}
	router.mu.Lock()
	router.pending[approval.ID] = pendingApproval{
		event: event, prior: prior, runID: run.ID,
		routerOwnsExternalBoundary: externalSideEffect &&
			!store.EngineeringServiceOwnsExternalBoundary(approval),
	}
	router.mu.Unlock()
	return nil
}

func (router *Router) deniedEngineeringRetry(
	ctx context.Context,
	attempt core.StageAttempt,
	kind, server, tool string,
) (bool, error) {
	if attempt.Stage != core.StageCollect {
		return false, nil
	}
	var count int
	err := router.DB.SQL().QueryRowContext(ctx, `
SELECT COUNT(*) FROM approvals
WHERE run_id=? AND stage_attempt_id=? AND status='denied'
  AND kind=? AND lower(server)=lower(?) AND lower(tool)=lower(?)`,
		attempt.RunID, attempt.ID, kind, strings.TrimSpace(server), strings.TrimSpace(tool),
	).Scan(&count)
	return count > 0, err
}

type plannedXFOILApprovalArguments struct {
	RunID                 string  `json:"run_id"`
	StageAttemptID        string  `json:"stage_attempt_id"`
	NACA                  string  `json:"naca"`
	Reynolds              float64 `json:"reynolds"`
	Mach                  float64 `json:"mach"`
	AlphaStartDeg         float64 `json:"alpha_start_deg"`
	AlphaEndDeg           float64 `json:"alpha_end_deg"`
	AlphaStepDeg          float64 `json:"alpha_step_deg"`
	FlapChordRatio        float64 `json:"flap_chord_ratio"`
	FlapHingeXOverC       float64 `json:"flap_hinge_x_over_c"`
	FlapHingeYOverC       float64 `json:"flap_hinge_y_over_c"`
	FlapDeflectionDeg     float64 `json:"flap_deflection_deg"`
	NCrit                 float64 `json:"ncrit"`
	Iterations            int     `json:"iterations"`
	PanelCount            int     `json:"panel_count"`
	ExecutionPurpose      string  `json:"execution_purpose"`
	VerificationOfJobID   string  `json:"verification_of_job_id"`
	OptimizationObjective string  `json:"optimization_objective"`
	TargetCL              float64 `json:"target_cl"`
	MinimumCM             float64 `json:"minimum_cm"`
}

func xfoilCallAuthorizedByPlan(plan core.ResearchPlan, raw []byte, runID, attemptID string) bool {
	if plan.XFOILScreening == nil || plan.Validate() != nil {
		return false
	}
	var call plannedXFOILApprovalArguments
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&call) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return false
	}
	screen := plan.XFOILScreening
	if call.RunID != runID || call.StageAttemptID != attemptID || call.NACA != screen.NACA ||
		call.ExecutionPurpose != "screening" || strings.TrimSpace(call.VerificationOfJobID) != "" ||
		call.OptimizationObjective != screen.OptimizationObjective || call.AlphaStartDeg != screen.AlphaStartDeg ||
		call.AlphaEndDeg != screen.AlphaEndDeg || call.AlphaStepDeg != screen.AlphaStepDeg ||
		call.FlapChordRatio != screen.FlapChordRatio || call.FlapHingeXOverC != screen.FlapHingeXOverC ||
		call.FlapHingeYOverC != screen.FlapHingeYOverC || call.Iterations != screen.Iterations ||
		call.PanelCount != screen.PanelCount {
		return false
	}
	deflectionAllowed := false
	for _, candidate := range screen.CandidateDeflectionsDeg {
		if call.FlapDeflectionDeg == candidate {
			deflectionAllowed = true
			break
		}
	}
	if !deflectionAllowed {
		return false
	}
	for _, point := range screen.EffectiveOperatingPoints() {
		if call.Reynolds == point.Reynolds && call.Mach == point.Mach && call.NCrit == point.NCrit &&
			call.TargetCL == point.TargetCL && call.MinimumCM == point.MinimumCM {
			return true
		}
	}
	return false
}

func (router *Router) approvedPlanAuthorizesXFOILScreening(
	ctx context.Context, attempt core.StageAttempt, raw []byte,
) bool {
	rows, err := router.DB.SQL().QueryContext(ctx, `
SELECT arguments_json FROM approvals
WHERE run_id=? AND stage_attempt_id=? AND tool='xfoil_polar' AND status='approved'`,
		attempt.RunID, attempt.ID)
	if err != nil {
		return false
	}
	defer rows.Close()
	priorApproved := false
	for rows.Next() {
		var encoded string
		if rows.Scan(&encoded) != nil {
			return false
		}
		var prior plannedXFOILApprovalArguments
		if json.Unmarshal([]byte(encoded), &prior) == nil && prior.ExecutionPurpose == "screening" {
			priorApproved = true
		}
	}
	if rows.Err() != nil || !priorApproved {
		return false
	}
	artifacts, err := router.DB.ListArtifacts(ctx, attempt.RunID)
	if err != nil {
		return false
	}
	for _, artifact := range artifacts {
		if artifact.Kind != "research.plan" {
			continue
		}
		encoded, err := router.CAS.ReadVerified(artifact.BlobHash)
		if err != nil {
			return false
		}
		var plan core.ResearchPlan
		if json.Unmarshal(encoded, &plan) == nil && xfoilCallAuthorizedByPlan(plan, raw, attempt.RunID, attempt.ID) {
			return true
		}
	}
	return false
}

func validateEngineeringVerificationApproval(method string, request approvalRequest, attempt core.StageAttempt) error {
	if !isMCPApprovalMethod(method) || !serverIs(strings.ToLower(strings.TrimSpace(request.Server)), "aetherops_engineering", "aetherops-engineering") {
		return errors.New("engineering verification rejects browser, command, file, and external MCP approvals")
	}
	tool := strings.ToLower(strings.TrimSpace(request.Tool))
	if tool != "engineering_get" && tool != "xfoil_polar" {
		return errors.New("engineering verification permits only engineering_get and xfoil_polar")
	}
	encoded, err := json.Marshal(request.Arguments)
	if err != nil {
		return errors.New("engineering verification tool arguments are invalid")
	}
	if text, ok := request.Arguments.(string); ok && json.Valid([]byte(text)) {
		encoded = []byte(text)
	}
	var identity struct {
		RunID               string `json:"run_id"`
		StageAttemptID      string `json:"stage_attempt_id"`
		ExecutionPurpose    string `json:"execution_purpose"`
		VerificationOfJobID string `json:"verification_of_job_id"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(encoded)))
	if err := decoder.Decode(&identity); err != nil || identity.RunID != attempt.RunID || identity.StageAttemptID != attempt.ID {
		return errors.New("engineering verification tool arguments do not match the reserved stage capability")
	}
	if tool == "xfoil_polar" && (identity.ExecutionPurpose != "independent_verification" || strings.TrimSpace(identity.VerificationOfJobID) == "") {
		return errors.New("engineering verification XFOIL approval lacks its independent source binding")
	}
	return nil
}

func (router *Router) Decide(ctx context.Context, approvalID, decision string) (core.Approval, error) {
	if decision != "approved" && decision != "denied" {
		return core.Approval{}, errors.New("approval decision must be approved or denied")
	}
	router.mu.Lock()
	pending, ok := router.pending[approvalID]
	router.mu.Unlock()
	if !ok {
		return core.Approval{}, errors.New("approval request is not active in this Codex session")
	}
	approval, err := router.DB.DecideActiveApproval(ctx, approvalID, decision)
	if err != nil {
		if errors.Is(err, store.ErrApprovalNotActive) {
			router.forget(approvalID)
			return approval, err
		}
		if decision == "approved" && pending.routerOwnsExternalBoundary {
			if markErr := router.markUncertain(ctx, pending.runID, err); markErr != nil {
				err = errors.Join(err, fmt.Errorf("record uncertain approval decision: %w", markErr))
			}
		}
		return core.Approval{}, err
	}
	codexDecision := "decline"
	if decision == "approved" {
		codexDecision = "accept"
	}
	// Restore the owning stage before acknowledging the decision to Codex. The
	// response can immediately unblock and complete the turn; doing this in the
	// opposite order lets CompleteStage win the race and makes
	// ResumeRunAfterApproval reject the now-completed attempt, permanently
	// stranding the run in waiting_approval.
	if _, err := router.DB.ResumeRunAfterApproval(ctx, approval.RunID, pending.prior); err != nil {
		router.forget(approvalID)
		if decision == "approved" && pending.routerOwnsExternalBoundary {
			if markErr := router.markUncertain(ctx, approval.RunID, err); markErr != nil {
				err = errors.Join(err, fmt.Errorf("record uncertain approval resume: %w", markErr))
			}
		}
		return approval, fmt.Errorf("restore run before Codex approval response: %w", err)
	}
	if err := router.Client.RespondApproval(ctx, pending.event, codexDecision); err != nil {
		router.forget(approvalID)
		responseErr := err
		if pending.routerOwnsExternalBoundary {
			if markErr := router.markUncertain(ctx, approval.RunID, err); markErr != nil {
				responseErr = errors.Join(responseErr, fmt.Errorf("record uncertain approval outcome: %w", markErr))
			}
		}
		return approval, attemptedResponse(codexDecision, responseErr)
	}
	router.forget(approvalID)
	return approval, nil
}

func (router *Router) forget(approvalID string) {
	router.mu.Lock()
	delete(router.pending, approvalID)
	router.mu.Unlock()
}

func (router *Router) markUncertain(ctx context.Context, runID string, cause error) error {
	durableContext := context.WithoutCancel(ctx)
	return markUncertainCAS(durableContext, runID, cause, router.DB.Run, router.DB.TransitionRun)
}

func markUncertainCAS(
	ctx context.Context,
	runID string,
	cause error,
	load func(context.Context, string) (core.Run, error),
	transition func(context.Context, string, int64, core.RunStatus, string) (core.Run, error),
) error {
	if cause == nil {
		cause = errors.New("approval response outcome is unknown")
	}
	current, err := load(ctx, runID)
	if err != nil {
		return err
	}
	for range 8 {
		// A terminal state that won the race is authoritative. Uncertain is
		// idempotent; interrupted cannot be silently reclassified here.
		if core.IsTerminal(current.Status) || current.Status == core.RunUncertain || current.Status == core.RunInterrupted {
			return nil
		}
		if !core.CanTransition(current.Status, core.RunUncertain) {
			return fmt.Errorf("run %s cannot become uncertain from %s", current.ID, current.Status)
		}
		_, transitionErr := transition(
			ctx, current.ID, current.Revision, core.RunUncertain, cause.Error(),
		)
		if transitionErr == nil {
			return nil
		}
		latest, reloadErr := load(ctx, current.ID)
		if reloadErr != nil {
			return errors.Join(
				fmt.Errorf("mark run uncertain: %w", transitionErr),
				fmt.Errorf("reload run after uncertainty race: %w", reloadErr),
			)
		}
		if core.IsTerminal(latest.Status) || latest.Status == core.RunUncertain || latest.Status == core.RunInterrupted {
			return nil
		}
		if latest.Revision == current.Revision {
			return fmt.Errorf("mark run uncertain: %w", transitionErr)
		}
		current = latest
	}
	return errors.New("mark run uncertain exceeded retry limit")
}

type approvalRequest struct {
	ThreadID  string
	TurnID    string
	ItemID    string
	Summary   string
	Command   string
	Server    string
	Tool      string
	Arguments any
}

func decodeRequest(event codex.Event) (approvalRequest, error) {
	var values map[string]any
	if err := json.Unmarshal(event.Params, &values); err != nil {
		return approvalRequest{}, errors.New("invalid Codex approval parameters")
	}
	request := approvalRequest{
		ThreadID:  stringValue(values, "threadId"),
		TurnID:    stringValue(values, "turnId"),
		ItemID:    stringValue(values, "itemId"),
		Summary:   firstString(values, "reason", "summary", "message"),
		Command:   commandValue(values["command"]),
		Server:    firstString(values, "server", "serverName", "mcpServer"),
		Tool:      firstString(values, "tool", "toolName"),
		Arguments: firstValue(values, "arguments", "toolArguments", "args"),
	}
	if request.ThreadID == "" || request.TurnID == "" {
		return approvalRequest{}, errors.New("Codex approval is missing threadId or turnId")
	}
	if request.Summary == "" {
		request.Summary = event.Method
	}
	return request, nil
}

func firstValue(values map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, exists := values[key]; exists {
			return value
		}
	}
	return nil
}

func stringValue(values map[string]any, key string) string {
	value, _ := values[key].(string)
	return value
}

func firstString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := stringValue(values, key); value != "" {
			return value
		}
	}
	return ""
}

func commandValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			text, ok := item.(string)
			if !ok {
				return ""
			}
			parts = append(parts, text)
		}
		return strings.Join(parts, " ")
	default:
		return ""
	}
}

func automaticPolicy(method string, request approvalRequest) (allowed bool, externalSideEffect bool) {
	if strings.Contains(method, "fileChange") {
		return false, true
	}
	if strings.Contains(method, "commandExecution") {
		if isStrictReadOnlyCommand(request.Command) {
			return true, false
		}
		return false, true
	}
	if isMCPApprovalMethod(method) {
		server := strings.ToLower(strings.TrimSpace(request.Server))
		tool := strings.ToLower(request.Tool)
		if serverIs(server, "chrome_devtools", "chrome-devtools-mcp") {
			return true, true
		}
		if serverIs(server, "aetherops_internal", "aetherops-internal") {
			switch tool {
			case "memory_search", "memory_get", "knowledge_sparql", "knowledge_get", "scholarly_search", "tool_package_propose", "tool_catalog", "tool_get",
				"evidence_capture", "artifact_publish_plan",
				"artifact_publish_evidence", "artifact_publish_report", "artifact_publish_review":
				return true, false
			}
		}
		if serverIs(server, "aetherops_engineering", "aetherops-engineering") &&
			(tool == "engineering_capabilities" || tool == "engineering_get") {
			return true, false
		}
		return false, true
	}
	return false, true
}

// approvedPortableToolRun recognizes the exact stage-scoped grant created by
// a prior user-approved tool_package_install call. It never grants another
// package, project, run, or attempt, and a changed manifest invalidates the
// approval hash before App Server receives an automatic accept response.
func (router *Router) approvedPortableToolRun(ctx context.Context, method string, request approvalRequest, attempt core.StageAttempt, argumentsJSON string) (bool, error) {
	if !isMCPApprovalMethod(method) ||
		!serverIs(strings.ToLower(strings.TrimSpace(request.Server)), "aetherops_internal", "aetherops-internal") ||
		!strings.EqualFold(strings.TrimSpace(request.Tool), "tool_run") {
		return false, nil
	}
	var arguments struct {
		RunID          string `json:"run_id"`
		StageAttemptID string `json:"stage_attempt_id"`
		PackageID      string `json:"package_id"`
	}
	if argumentsJSON == "" || json.Unmarshal([]byte(argumentsJSON), &arguments) != nil {
		return false, nil
	}
	if arguments.RunID != attempt.RunID || arguments.StageAttemptID != attempt.ID || arguments.PackageID == "" {
		return false, nil
	}
	run, err := router.DB.Run(ctx, attempt.RunID)
	if err != nil {
		return false, err
	}
	pkg, err := router.DB.ActiveToolPackageByID(ctx, arguments.PackageID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	if pkg.ProjectID != run.ProjectID || pkg.Installation == nil || pkg.Installation.State != "ready" {
		return false, nil
	}
	approval, err := toolstudio.ExpectedInstallApproval(pkg)
	if err != nil {
		return false, nil
	}
	granted, err := router.DB.HasExactToolStageGrant(ctx, run.ProjectID, attempt.RunID, attempt.ID,
		pkg.ID, pkg.Installation.ID, pkg.PackageSHA256, approval.ApprovalSHA256)
	if err != nil {
		return false, err
	}
	return granted, nil
}

func isEngineeringSolverApproval(method string, request approvalRequest) bool {
	if !isMCPApprovalMethod(method) || strings.TrimSpace(request.Server) != "aetherops_engineering" {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(request.Tool)) {
	case "openvsp_wing_aero", "openvsp_modify_wing", "gmsh_wing_mesh", "xfoil_polar", "su2_naca0012":
		return true
	default:
		return false
	}
}

func isMCPApprovalMethod(method string) bool {
	return strings.Contains(method, "mcpToolCall") || method == "mcpServer/elicitation/request"
}

// Keep durable engineering authorization independent of the App Server wire
// spelling. Codex 0.146.1 represents stable MCP approval as an elicitation;
// earlier schemas represented the same exact scope as an item approval.
func canonicalApprovalKind(method string) string {
	if isMCPApprovalMethod(method) {
		return "item/mcpToolCall/requestApproval"
	}
	return method
}

func isChromeUpload(request approvalRequest) bool {
	server := strings.ToLower(strings.TrimSpace(request.Server))
	tool := strings.ToLower(request.Tool)
	return serverIs(server, "chrome_devtools", "chrome-devtools-mcp") && strings.Contains(tool, "upload")
}

func serverIs(server string, allowed ...string) bool {
	for _, candidate := range allowed {
		if server == candidate {
			return true
		}
	}
	return false
}

func (router *Router) validateUploadArguments(arguments any) error {
	paths := collectUploadPaths(arguments, "")
	if len(paths) == 0 {
		return errors.New("browser upload was blocked because no file path could be verified")
	}
	if len(router.AllowedUploadRoots) == 0 {
		return errors.New("browser upload was blocked because no upload roots are configured")
	}
	for _, rawPath := range paths {
		resolved, err := filepath.Abs(rawPath)
		if err != nil {
			return fmt.Errorf("resolve browser upload path: %w", err)
		}
		resolved, err = filepath.EvalSymlinks(resolved)
		if err != nil {
			return fmt.Errorf("browser upload path is unavailable: %w", err)
		}
		info, err := os.Lstat(resolved)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("browser upload path must be a regular file")
		}
		allowed := false
		for _, rawRoot := range router.AllowedUploadRoots {
			root, err := filepath.Abs(rawRoot)
			if err != nil {
				continue
			}
			if evaluated, err := filepath.EvalSymlinks(root); err == nil {
				root = evaluated
			}
			relative, err := filepath.Rel(root, resolved)
			if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative) {
				allowed = true
				break
			}
		}
		if !allowed {
			return fmt.Errorf("browser upload path is outside the project and CAS roots: %s", resolved)
		}
	}
	return nil
}

func collectUploadPaths(value any, key string) []string {
	key = strings.ToLower(key)
	pathKey := strings.Contains(key, "path") || strings.Contains(key, "file")
	switch typed := value.(type) {
	case string:
		if pathKey && strings.TrimSpace(typed) != "" {
			return []string{typed}
		}
	case []any:
		var paths []string
		for _, item := range typed {
			paths = append(paths, collectUploadPaths(item, key)...)
		}
		return paths
	case map[string]any:
		var paths []string
		for childKey, item := range typed {
			paths = append(paths, collectUploadPaths(item, childKey)...)
		}
		return paths
	}
	return nil
}

func isStrictReadOnlyCommand(command string) bool {
	command = strings.TrimSpace(command)
	if command == "" || strings.ContainsAny(command, ";|><&`\n\r") || strings.Contains(command, "$(") {
		return false
	}
	fields := strings.Fields(command)
	if len(fields) == 0 {
		return false
	}
	executable := strings.ToLower(strings.TrimSuffix(filepath.Base(fields[0]), ".exe"))
	switch executable {
	case "rg":
		for _, field := range fields[1:] {
			if strings.EqualFold(field, "--pre") || strings.HasPrefix(strings.ToLower(field), "--pre=") {
				return false
			}
		}
		return true
	case "where", "whoami", "hostname":
		return true
	case "git":
		if len(fields) < 2 {
			return false
		}
		switch strings.ToLower(fields[1]) {
		case "status", "diff", "log", "show", "rev-parse", "ls-files":
			return true
		}
	case "powershell", "pwsh":
		return false
	}
	return false
}

func isNetworkDownloadShellCommand(command string) bool {
	tokens := shellCommandTokens(command)
	if len(tokens) == 0 {
		return false
	}
	contains := func(wanted ...string) bool {
		for _, token := range tokens {
			for _, candidate := range wanted {
				if token == candidate {
					return true
				}
			}
		}
		return false
	}
	lowerCommand := strings.ToLower(command)
	if (strings.Contains(lowerCommand, "https://") || strings.Contains(lowerCommand, "http://")) &&
		contains(
			"powershell", "powershell.exe", "pwsh", "pwsh.exe", "cmd", "cmd.exe",
			"bash", "bash.exe", "sh", "sh.exe", "python", "python.exe", "py",
			"node", "node.exe", "ruby", "ruby.exe", "perl", "perl.exe",
		) {
		return true
	}
	if contains(
		"curl", "curl.exe", "wget", "wget.exe", "aria2c", "aria2c.exe",
		"ftp", "ftp.exe", "tftp", "tftp.exe", "bitsadmin", "bitsadmin.exe",
		"invoke-webrequest", "invoke-restmethod",
		"iwr", "irm", "start-bitstransfer", "system.net.webclient",
		"net.webclient", "system.net.http.httpclient", "downloadfile", "downloadstring",
		"downloaddata", "openread", "urllib.request", "urlretrieve", "requests.get",
		"requests.request", "httpx.get", "httpx.stream", "aiohttp", "fetch",
		"http.get", "https.get", "axios.get",
	) {
		return true
	}
	if contains("certutil", "certutil.exe") && contains("-urlcache", "urlcache") {
		return true
	}
	if contains("git", "git.exe") && contains("clone", "fetch", "pull") {
		return true
	}
	return false
}

func shellCommandTokens(command string) []string {
	return strings.FieldsFunc(strings.ToLower(command), func(character rune) bool {
		return !((character >= 'a' && character <= 'z') ||
			(character >= '0' && character <= '9') || character == '-' ||
			character == '_' || character == '.')
	})
}
