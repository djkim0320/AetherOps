package research

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"

	"github.com/djkim0320/AetherOps/internal/core"
)

const (
	engineeringScreeningOwnerRole  = "owner"
	engineeringScreeningReadRole   = "public_research_only"
	engineeringReceiptReadbackRole = "receipt_readback_owner"

	engineeringScreeningOwnerPolicy  = "You are the single deterministic owner of every bundled engineering solver call required anywhere in the complete research plan, even when another workstream describes part of the numerical comparison. Inspect the complete plan before the first solver call, enumerate the whole requested case set, and execute every case in this one collector attempt. This includes every requested su2_naca0012 mesh_size_m case and every XFOIL execution_purpose=screening job. No other normal collector may launch an engineering solver. Include every successful solver receipt artifact id returned in this attempt in engineering_receipt_artifact_ids and cite it from the corresponding claims; AetherOps rejects an XFOIL owner bundle that omits an executed screening receipt. Public-source work remains independent and may proceed normally."
	engineeringScreeningReadPolicy   = "You are not the engineering solver owner. Do not call su2_naca0012, xfoil_polar, gmsh_wing_mesh, openvsp_wing_aero, or openvsp_modify_wing, and do not cite or copy a solver receipt produced by another collector attempt. Continue the assigned public-source research in parallel and use evidence_capture normally. The owner collector receives the complete plan and produces the single attempt-scoped solver receipt set."
	engineeringReceiptReadbackPolicy = "This is the sole core-authorized receipt-readback workstream for a REVIEW remediation. Do not execute or request approval for su2_naca0012 or any other solver. Call engineering_get exactly once for each job in reusable_engineering_results, using the current run_id and stage_attempt_id. Require reused_result=true, cite only the returned top-level receipt_artifact_id values, and report any identity, CAS, or metric mismatch instead of substituting a new calculation."
)

func engineeringPolicyForCollector(index int) (string, string) {
	if index == core.EngineeringScreeningOwnerOrdinal {
		return collectEngineeringPolicy + " " + engineeringScreeningOwnerPolicy, engineeringScreeningOwnerRole
	}
	return collectEngineeringPolicy + " " + engineeringScreeningReadPolicy, engineeringScreeningReadRole
}

type xfoilScreeningCoverageRecord struct {
	JobID             string
	Ordinal           int
	Status            string
	ReceiptArtifactID string
}

type plannedXFOILScreeningRecord struct {
	JobID             string
	AttemptID         string
	Ordinal           int
	StageStatus       string
	Status            string
	ReceiptArtifactID string
	Arguments         plannedXFOILArguments
}

func (engine *Engine) plannedXFOILScreeningRecords(
	ctx context.Context,
	runID string,
	requirePlannedPurpose bool,
) ([]plannedXFOILScreeningRecord, error) {
	rows, err := engine.db.SQL().QueryContext(ctx, `
SELECT j.id,j.stage_attempt_id,s.logical_ordinal,s.status,j.status,
       COALESCE(j.receipt_artifact_id,''),j.spec_json
FROM engineering_jobs j
JOIN stage_attempts s ON s.id=j.stage_attempt_id AND s.run_id=j.run_id
WHERE j.run_id=? AND j.operation='xfoil_polar'
	  AND s.status<>'superseded'
-- created_at can legitimately collide when a bounded matrix is materialized in
-- one transaction. rowid preserves the durable insertion/plan order instead of
-- letting random job ids reorder the evidence bundle between runs.
ORDER BY j.created_at,j.rowid,j.id`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]plannedXFOILScreeningRecord, 0)
	for rows.Next() {
		var record plannedXFOILScreeningRecord
		var specJSON string
		if err := rows.Scan(&record.JobID, &record.AttemptID, &record.Ordinal, &record.StageStatus, &record.Status,
			&record.ReceiptArtifactID, &specJSON); err != nil {
			return nil, err
		}
		arguments, err := decodePlannedXFOILArguments(specJSON)
		if err != nil {
			return nil, fmt.Errorf("XFOIL job %s: %w", record.JobID, err)
		}
		if arguments.ExecutionPurpose == "independent_verification" {
			if record.Ordinal != core.EngineeringVerificationOrdinal {
				return nil, fmt.Errorf("independent XFOIL job %s is outside the reserved verification attempt", record.JobID)
			}
			continue
		}
		if arguments.ExecutionPurpose != "screening" {
			if requirePlannedPurpose {
				return nil, fmt.Errorf("XFOIL job %s has no plan-authorized screening purpose", record.JobID)
			}
			continue
		}
		record.Arguments = arguments
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return records, nil
}

// rehydratePlannedXFOILScreeningReceipts closes a protocol truncation gap
// without trusting the model to round-trip every receipt id. The immutable
// plan and the complete DB job set are validated before any source is added;
// each source is then resolved through the exact owner collector attempt and
// read back from CAS by the ordinary evidence verifier.
func (engine *Engine) rehydratePlannedXFOILScreeningReceipts(
	ctx context.Context,
	runID string,
	plan core.ResearchPlan,
	bundle core.EvidenceBundle,
) (core.EvidenceBundle, error) {
	records, err := engine.plannedXFOILScreeningRecords(ctx, runID, true)
	if err != nil {
		return core.EvidenceBundle{}, err
	}
	// Rehydrate the complete authoritative source set before validating
	// coverage. The model's engineering ids and claims do not participate in
	// this lookup. This rejects another attempt/ordinal, failed or receipt-less
	// jobs, and any missing, duplicate, additional, or condition-changed
	// candidate before a durable bundle can be published.
	complete := bundle
	complete.Sources = append([]core.EvidenceSource(nil), bundle.Sources...)
	type hydratedScreeningReceipt struct {
		record plannedXFOILScreeningRecord
		source core.EvidenceSource
	}
	hydrated := make([]hydratedScreeningReceipt, 0, len(records))
	existingSourceIDs := make(map[string]struct{}, len(bundle.Sources)+len(records))
	for _, source := range bundle.Sources {
		existingSourceIDs[source.ID] = struct{}{}
	}
	for _, record := range records {
		source, err := engine.db.EngineeringReceiptEvidenceForCollector(
			ctx, runID, core.EngineeringScreeningOwnerOrdinal, record.ReceiptArtifactID,
		)
		if err != nil {
			return core.EvidenceBundle{}, fmt.Errorf("resolve planned receipt %s for job %s: %w",
				record.ReceiptArtifactID, record.JobID, err)
		}
		if _, collision := existingSourceIDs[source.ID]; collision {
			return core.EvidenceBundle{}, fmt.Errorf("planned screening receipt source %q collides with another evidence source", source.ID)
		}
		existingSourceIDs[source.ID] = struct{}{}
		complete.Sources = append(complete.Sources, source)
		hydrated = append(hydrated, hydratedScreeningReceipt{record: record, source: source})
	}
	if err := validatePlannedXFOILScreeningCoverage(runID, plan.XFOILScreening, records, complete); err != nil {
		return core.EvidenceBundle{}, err
	}

	result := bundle
	result.Summary = strings.TrimSpace(bundle.Summary) + " " + plannedXFOILReconciliationStatement
	result.Sources = append([]core.EvidenceSource(nil), bundle.Sources...)
	result.Claims = append([]core.EvidenceClaim(nil), bundle.Claims...)
	result.Limitations = make([]string, len(bundle.Limitations))
	copy(result.Limitations, bundle.Limitations)
	existingClaims := make(map[string]struct{}, len(result.Claims))
	for _, claim := range result.Claims {
		existingClaims[claim.ID] = struct{}{}
	}
	for _, item := range hydrated {
		record := item.record
		result.Sources = append(result.Sources, item.source)
		claimID := fmt.Sprintf("aetherops-xfoil-screening-%s-%s",
			normalizedDeflectionLabel(*record.Arguments.FlapDeflectionDeg), record.JobID)
		if _, duplicate := existingClaims[claimID]; duplicate {
			return core.EvidenceBundle{}, fmt.Errorf("deterministic screening audit claim %q collides with model output", claimID)
		}
		result.Claims = append(result.Claims, core.EvidenceClaim{
			ID: claimID,
			Statement: fmt.Sprintf(
				"AetherOps verified planned XFOIL screening job %s at Reynolds %s, target CL %s, and flap deflection %s degrees, then rehydrated succeeded receipt %s from the same collector attempt.",
				record.JobID, normalizedDeflectionLabel(*record.Arguments.Reynolds),
				normalizedDeflectionLabel(*record.Arguments.TargetCL),
				normalizedDeflectionLabel(*record.Arguments.FlapDeflectionDeg), record.ReceiptArtifactID,
			),
			SourceIDs: []string{record.ReceiptArtifactID},
		})
		existingClaims[claimID] = struct{}{}
	}
	return result, nil
}

const plannedXFOILReconciliationStatement = "AetherOps deterministically reconciled every planned XFOIL screening receipt from the same run and collector attempt through SQLite/CAS verification; every planned succeeded receipt is present and cited."

func normalizedDeflectionLabel(value float64) string {
	if value == 0 {
		value = 0
	}
	return strconv.FormatFloat(value, 'g', -1, 64)
}

// Pointers distinguish an explicitly approved zero (Mach, hinge y, or zero
// deflection) from a model-omitted field that JSON would otherwise decode to
// the same value. Every numerical control in the plan contract is mandatory in
// each actual screening request.
type plannedXFOILArguments struct {
	RunID                 string   `json:"run_id"`
	StageAttemptID        string   `json:"stage_attempt_id"`
	NACA                  string   `json:"naca"`
	Reynolds              *float64 `json:"reynolds"`
	Mach                  *float64 `json:"mach"`
	AlphaStartDeg         *float64 `json:"alpha_start_deg"`
	AlphaEndDeg           *float64 `json:"alpha_end_deg"`
	AlphaStepDeg          *float64 `json:"alpha_step_deg"`
	ExecutionPurpose      string   `json:"execution_purpose"`
	VerificationOfJobID   string   `json:"verification_of_job_id,omitempty"`
	OptimizationObjective string   `json:"optimization_objective"`
	TargetCL              *float64 `json:"target_cl"`
	MinimumCM             *float64 `json:"minimum_cm"`
	FlapChordRatio        *float64 `json:"flap_chord_ratio"`
	FlapHingeXOverC       *float64 `json:"flap_hinge_x_over_c"`
	FlapHingeYOverC       *float64 `json:"flap_hinge_y_over_c"`
	FlapDeflectionDeg     *float64 `json:"flap_deflection_deg"`
	NCrit                 *float64 `json:"ncrit"`
	Iterations            *int     `json:"iterations"`
	PanelCount            *int     `json:"panel_count"`
}

func decodePlannedXFOILArguments(specJSON string) (plannedXFOILArguments, error) {
	var envelope struct {
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal([]byte(specJSON), &envelope); err != nil || len(envelope.Arguments) == 0 {
		return plannedXFOILArguments{}, fmt.Errorf("decode XFOIL job specification")
	}
	var arguments plannedXFOILArguments
	decoder := json.NewDecoder(bytes.NewReader(envelope.Arguments))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&arguments); err != nil {
		return plannedXFOILArguments{}, fmt.Errorf("decode XFOIL job arguments: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return plannedXFOILArguments{}, fmt.Errorf("XFOIL job arguments contain trailing JSON")
	}
	return arguments, nil
}

func (arguments plannedXFOILArguments) matchesShared(
	runID, attemptID string,
	plan core.XFOILScreeningPlan,
) bool {
	return arguments.RunID == runID && arguments.StageAttemptID == attemptID &&
		arguments.NACA == plan.NACA && arguments.ExecutionPurpose == "screening" &&
		strings.TrimSpace(arguments.VerificationOfJobID) == "" &&
		arguments.OptimizationObjective == plan.OptimizationObjective &&
		equalFloat(arguments.AlphaStartDeg, plan.AlphaStartDeg) &&
		equalFloat(arguments.AlphaEndDeg, plan.AlphaEndDeg) &&
		equalFloat(arguments.AlphaStepDeg, plan.AlphaStepDeg) &&
		equalFloat(arguments.FlapChordRatio, plan.FlapChordRatio) &&
		equalFloat(arguments.FlapHingeXOverC, plan.FlapHingeXOverC) &&
		equalFloat(arguments.FlapHingeYOverC, plan.FlapHingeYOverC) &&
		equalInt(arguments.Iterations, plan.Iterations) && equalInt(arguments.PanelCount, plan.PanelCount) &&
		arguments.FlapDeflectionDeg != nil
}

func (arguments plannedXFOILArguments) matchesPoint(point core.XFOILOperatingPoint) bool {
	return equalFloat(arguments.Reynolds, point.Reynolds) && equalFloat(arguments.Mach, point.Mach) &&
		equalFloat(arguments.NCrit, point.NCrit) && equalFloat(arguments.TargetCL, point.TargetCL) &&
		equalFloat(arguments.MinimumCM, point.MinimumCM)
}

func equalFloat(actual *float64, expected float64) bool {
	return actual != nil && *actual == expected
}

func equalInt(actual *int, expected int) bool {
	return actual != nil && *actual == expected
}

func normalizedDeflection(value float64) uint64 {
	if value == 0 {
		value = 0
	}
	return math.Float64bits(value)
}

type xfoilScreeningCell struct {
	Reynolds, Mach, NCrit, TargetCL, MinimumCM, Deflection uint64
}

func screeningCell(point core.XFOILOperatingPoint, deflection float64) xfoilScreeningCell {
	return xfoilScreeningCell{
		Reynolds: normalizedDeflection(point.Reynolds), Mach: normalizedDeflection(point.Mach),
		NCrit: normalizedDeflection(point.NCrit), TargetCL: normalizedDeflection(point.TargetCL),
		MinimumCM: normalizedDeflection(point.MinimumCM), Deflection: normalizedDeflection(deflection),
	}
}

func recordScreeningCell(arguments plannedXFOILArguments) (xfoilScreeningCell, bool) {
	if arguments.Reynolds == nil || arguments.Mach == nil || arguments.NCrit == nil ||
		arguments.TargetCL == nil || arguments.MinimumCM == nil || arguments.FlapDeflectionDeg == nil {
		return xfoilScreeningCell{}, false
	}
	return screeningCell(core.XFOILOperatingPoint{
		Reynolds: *arguments.Reynolds, Mach: *arguments.Mach, NCrit: *arguments.NCrit,
		TargetCL: *arguments.TargetCL, MinimumCM: *arguments.MinimumCM,
	}, *arguments.FlapDeflectionDeg), true
}

// verifyPlannedXFOILScreeningCoverage proves that the complete structured PLAN
// candidate set—not merely the subset the model happened to execute—has one
// and only one succeeded, receipt-backed job in the deterministic owner
// attempt. It is called both when the owner publishes COLLECT and immediately
// before independent verification.
func (engine *Engine) verifyPlannedXFOILScreeningCoverage(
	ctx context.Context,
	runID string,
	plan core.ResearchPlan,
	ownerBundle core.EvidenceBundle,
) error {
	records, err := engine.plannedXFOILScreeningRecords(ctx, runID, plan.XFOILScreening != nil)
	if err != nil {
		return err
	}
	return validatePlannedXFOILScreeningCoverage(runID, plan.XFOILScreening, records, ownerBundle)
}

func validatePlannedXFOILScreeningCoverage(
	runID string,
	plan *core.XFOILScreeningPlan,
	records []plannedXFOILScreeningRecord,
	ownerBundle core.EvidenceBundle,
) error {
	if plan == nil {
		if len(records) != 0 {
			return fmt.Errorf("XFOIL screening executed without a structured plan contract")
		}
		return nil
	}
	if err := plan.Validate(); err != nil {
		return err
	}
	type expectedCell struct {
		point      core.XFOILOperatingPoint
		deflection float64
	}
	points := plan.EffectiveOperatingPoints()
	expected := make(map[xfoilScreeningCell]expectedCell, len(points)*len(plan.CandidateDeflectionsDeg))
	for _, point := range points {
		for _, deflection := range plan.CandidateDeflectionsDeg {
			expected[screeningCell(point, deflection)] = expectedCell{point: point, deflection: deflection}
		}
	}
	cited := make(map[string]struct{}, len(ownerBundle.Sources))
	for _, source := range ownerBundle.Sources {
		if artifactID, ok := core.EngineeringReceiptArtifactID(source); ok {
			cited[artifactID] = struct{}{}
		}
	}
	observed := make(map[xfoilScreeningCell]string, len(records))
	ownerAttemptID := ""
	for _, record := range records {
		if record.Ordinal != core.EngineeringScreeningOwnerOrdinal {
			return fmt.Errorf("XFOIL screening job %s belongs to collector ordinal %d, want owner ordinal %d",
				record.JobID, record.Ordinal, core.EngineeringScreeningOwnerOrdinal)
		}
		if record.StageStatus != "in_progress" && record.StageStatus != "completed" {
			return fmt.Errorf("XFOIL screening job %s belongs to %s owner attempt", record.JobID, record.StageStatus)
		}
		if ownerAttemptID == "" {
			ownerAttemptID = record.AttemptID
		} else if record.AttemptID != ownerAttemptID {
			return fmt.Errorf("XFOIL screening jobs span owner attempts %s and %s", ownerAttemptID, record.AttemptID)
		}
		if !record.Arguments.matchesShared(runID, record.AttemptID, *plan) {
			return fmt.Errorf("XFOIL screening job %s differs from the immutable plan contract", record.JobID)
		}
		matchedPoint := false
		for _, point := range points {
			if record.Arguments.matchesPoint(point) {
				matchedPoint = true
				break
			}
		}
		if !matchedPoint {
			return fmt.Errorf("XFOIL screening job %s differs from the immutable plan contract", record.JobID)
		}
		key, complete := recordScreeningCell(record.Arguments)
		if !complete {
			return fmt.Errorf("XFOIL screening job %s omits a required operating-point field", record.JobID)
		}
		if _, allowed := expected[key]; !allowed {
			return fmt.Errorf("XFOIL screening job %s adds unplanned flap deflection %g or operating point",
				record.JobID, *record.Arguments.FlapDeflectionDeg)
		}
		if prior, duplicate := observed[key]; duplicate {
			return fmt.Errorf("XFOIL screening jobs %s and %s duplicate flap deflection %g at one operating point",
				prior, record.JobID, *record.Arguments.FlapDeflectionDeg)
		}
		observed[key] = record.JobID
		if record.Status != "succeeded" || record.ReceiptArtifactID == "" {
			return fmt.Errorf("XFOIL screening job %s is %s or receipt-less; partial sweeps are rejected",
				record.JobID, record.Status)
		}
		if _, ok := cited[record.ReceiptArtifactID]; !ok {
			return fmt.Errorf("XFOIL screening owner bundle omits receipt %s for job %s",
				record.ReceiptArtifactID, record.JobID)
		}
	}
	for key, cell := range expected {
		if _, ok := observed[key]; !ok {
			return fmt.Errorf("XFOIL screening workflow omits planned flap deflection %g at point %s (Re=%g, target_cl=%g)",
				cell.deflection, cell.point.ID, cell.point.Reynolds, cell.point.TargetCL)
		}
	}
	if len(records) != len(expected) {
		return fmt.Errorf("XFOIL screening workflow has %d jobs, want exactly %d", len(records), len(expected))
	}
	return nil
}

// verifyXFOILScreeningCoverage binds the complete numerical sweep to one
// attempt-scoped bundle. It never permits cross-attempt evidence: the ordinary
// provenance verifier still resolves every receipt through the current
// logical ordinal before this completeness check runs.
func (engine *Engine) verifyXFOILScreeningCoverage(
	ctx context.Context,
	runID string,
	ordinal int,
	bundle core.EvidenceBundle,
) error {
	rows, err := engine.db.SQL().QueryContext(ctx, `
SELECT j.id, s.logical_ordinal, j.status, COALESCE(j.receipt_artifact_id, ''), j.spec_json
FROM engineering_jobs j
JOIN stage_attempts s ON s.id=j.stage_attempt_id AND s.run_id=j.run_id
WHERE j.run_id=? AND j.operation='xfoil_polar'
  AND s.stage='collect' AND s.status<>'superseded' AND s.logical_ordinal>=0
  AND s.logical_ordinal<?
ORDER BY j.created_at,j.id`, runID, core.EngineeringVerificationOrdinal)
	if err != nil {
		return err
	}
	defer rows.Close()
	records := make([]xfoilScreeningCoverageRecord, 0)
	for rows.Next() {
		var record xfoilScreeningCoverageRecord
		var specJSON string
		if err := rows.Scan(&record.JobID, &record.Ordinal, &record.Status, &record.ReceiptArtifactID, &specJSON); err != nil {
			return err
		}
		var envelope struct {
			Arguments struct {
				ExecutionPurpose string `json:"execution_purpose"`
			} `json:"arguments"`
		}
		if err := json.Unmarshal([]byte(specJSON), &envelope); err != nil {
			return fmt.Errorf("decode XFOIL screening job %s: %w", record.JobID, err)
		}
		if envelope.Arguments.ExecutionPurpose == "screening" {
			records = append(records, record)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return validateXFOILScreeningCoverage(ordinal, records, bundle)
}

func validateXFOILScreeningCoverage(
	ordinal int,
	records []xfoilScreeningCoverageRecord,
	bundle core.EvidenceBundle,
) error {
	for _, record := range records {
		if record.Ordinal != core.EngineeringScreeningOwnerOrdinal {
			return fmt.Errorf("XFOIL screening job %s belongs to collector ordinal %d, want owner ordinal %d",
				record.JobID, record.Ordinal, core.EngineeringScreeningOwnerOrdinal)
		}
	}
	// A public-source collector may finish while the owner is still executing.
	// It only needs to prove that it did not create a screening job itself.
	if ordinal != core.EngineeringScreeningOwnerOrdinal {
		return nil
	}
	if len(records) == 0 {
		return nil
	}
	cited := make(map[string]struct{}, len(bundle.Sources))
	for _, source := range bundle.Sources {
		if artifactID, ok := core.EngineeringReceiptArtifactID(source); ok {
			cited[artifactID] = struct{}{}
		}
	}
	for _, record := range records {
		if record.Status != "succeeded" {
			return fmt.Errorf("XFOIL screening job %s is %s; the owner may not publish a partial sweep", record.JobID, record.Status)
		}
		if record.ReceiptArtifactID == "" {
			return fmt.Errorf("XFOIL screening job %s succeeded without a receipt", record.JobID)
		}
		if _, ok := cited[record.ReceiptArtifactID]; !ok {
			return fmt.Errorf("XFOIL screening owner bundle omits receipt %s for job %s",
				record.ReceiptArtifactID, record.JobID)
		}
	}
	return nil
}
