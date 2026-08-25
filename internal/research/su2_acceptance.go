package research

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
)

const (
	su2AppendixStart = "<!-- aetherops-su2-acceptance:start -->"
	su2AppendixEnd   = "<!-- aetherops-su2-acceptance:end -->"
)

type su2AcceptancePackage struct {
	assessment core.EngineeringAssessment
	appendix   string
	hashes     []string
}

type su2StoredSpec struct {
	Operation string `json:"operation"`
	Arguments struct {
		RunID          string  `json:"run_id"`
		StageAttemptID string  `json:"stage_attempt_id"`
		Mach           float64 `json:"mach"`
		AlphaDeg       float64 `json:"alpha_deg"`
		Iterations     int     `json:"iterations"`
		MeshSizeM      float64 `json:"mesh_size_m"`
	} `json:"arguments"`
}

type su2StoredReceipt struct {
	JobID            string `json:"job_id"`
	RunID            string `json:"run_id"`
	StageAttemptID   string `json:"stage_attempt_id"`
	Operation        string `json:"operation"`
	Executed         bool   `json:"executed"`
	NumericallyValid bool   `json:"numerically_valid"`
	Metrics          struct {
		Iterations              int     `json:"iterations"`
		CL                      float64 `json:"cl"`
		CD                      float64 `json:"cd"`
		ResidualDropOrders      float64 `json:"residual_drop_orders"`
		CLLateStddev            float64 `json:"cl_late_stddev"`
		CDLateStddev            float64 `json:"cd_late_stddev"`
		MeshNodes               int     `json:"mesh_nodes"`
		MeshVolumeElements      int     `json:"mesh_volume_elements"`
		AirfoilBoundaryElements int     `json:"airfoil_boundary_elements"`
		OrthogonalityAvailable  bool    `json:"orthogonality_available"`
		UpperShockXOverC        float64 `json:"upper_shock_x_over_c"`
		Solver                  string  `json:"solver"`
		ConvNumMethodFlow       string  `json:"conv_num_method_flow"`
		FarfieldXMinChords      float64 `json:"farfield_x_min_chords"`
		FarfieldXMaxChords      float64 `json:"farfield_x_max_chords"`
		FarfieldYAbsChords      float64 `json:"farfield_y_abs_chords"`
	} `json:"metrics"`
}

func (engine *Engine) loadSU2AcceptancePackage(
	ctx context.Context,
	runID string,
	plan core.ResearchPlan,
) (*su2AcceptancePackage, error) {
	jobs, err := engine.db.ListRunEngineeringJobs(ctx, runID, "su2_naca0012")
	if err != nil {
		return nil, fmt.Errorf("load SU2 study jobs: %w", err)
	}
	if plan.SU2MeshStudy == nil {
		if len(jobs) != 0 {
			return nil, errors.New("run executed SU2 without an immutable su2_mesh_study plan contract")
		}
		return nil, nil
	}
	if len(jobs) != len(plan.SU2MeshStudy.MeshSizesM) {
		return nil, fmt.Errorf("SU2 plan requires %d cases but the run recorded %d jobs", len(plan.SU2MeshStudy.MeshSizesM), len(jobs))
	}
	results, err := engine.db.ListRunEngineeringResults(ctx, runID)
	if err != nil {
		return nil, fmt.Errorf("load SU2 study results: %w", err)
	}
	resultByJob := make(map[string]store.EngineeringResult, len(results))
	for _, result := range results {
		resultByJob[result.Job.ID] = result
	}
	jobByMesh := make(map[uint64]store.EngineeringJob, len(jobs))
	for _, job := range jobs {
		if job.Status != "succeeded" || job.ReceiptArtifactID == "" {
			return nil, fmt.Errorf("SU2 job %s is %s, not a successful receipt", job.ID, job.Status)
		}
		var ordinal int
		var stage string
		if err := engine.db.SQL().QueryRowContext(ctx,
			"SELECT logical_ordinal,stage FROM stage_attempts WHERE id=? AND run_id=?",
			job.StageAttemptID, runID).Scan(&ordinal, &stage); err != nil {
			return nil, fmt.Errorf("load SU2 job %s stage ownership: %w", job.ID, err)
		}
		if ordinal != core.EngineeringScreeningOwnerOrdinal || stage != string(core.StageCollect) {
			return nil, fmt.Errorf("SU2 job %s is outside the engineering owner collect attempt", job.ID)
		}
		var spec su2StoredSpec
		if err := decodeJSONOne([]byte(job.SpecJSON), &spec); err != nil || spec.Operation != "su2_naca0012" {
			return nil, fmt.Errorf("decode SU2 job %s contract: %w", job.ID, err)
		}
		arguments := spec.Arguments
		if arguments.RunID != runID || arguments.StageAttemptID != job.StageAttemptID ||
			!sameSU2Float(arguments.Mach, plan.SU2MeshStudy.Mach) ||
			!sameSU2Float(arguments.AlphaDeg, plan.SU2MeshStudy.AlphaDeg) ||
			arguments.Iterations != plan.SU2MeshStudy.Iterations {
			return nil, fmt.Errorf("SU2 job %s operating point differs from the plan contract", job.ID)
		}
		key := math.Float64bits(arguments.MeshSizeM)
		if _, duplicate := jobByMesh[key]; duplicate {
			return nil, fmt.Errorf("SU2 mesh size %s was executed more than once", strconv.FormatFloat(arguments.MeshSizeM, 'g', -1, 64))
		}
		jobByMesh[key] = job
	}

	cases := make([]core.SU2CaseEvidence, 0, len(plan.SU2MeshStudy.MeshSizesM))
	allHashes := make([]string, 0, len(cases)*7)
	for _, meshSize := range plan.SU2MeshStudy.MeshSizesM {
		job, exists := jobByMesh[math.Float64bits(meshSize)]
		if !exists {
			return nil, fmt.Errorf("SU2 plan mesh size %s has no exact successful job", strconv.FormatFloat(meshSize, 'g', -1, 64))
		}
		result, exists := resultByJob[job.ID]
		if !exists {
			return nil, fmt.Errorf("SU2 job %s has no successful artifact set", job.ID)
		}
		caseEvidence, err := engine.readSU2Case(ctx, runID, meshSize, result)
		if err != nil {
			return nil, err
		}
		cases = append(cases, caseEvidence)
		allHashes = append(allHashes, caseEvidence.ArtifactHashes...)
	}
	allHashes = uniqueSortedStrings(allHashes)
	assessment := assessSU2Cases(cases)
	if err := assessment.Validate(); err != nil {
		return nil, fmt.Errorf("validate deterministic SU2 assessment: %w", err)
	}
	return &su2AcceptancePackage{
		assessment: assessment,
		appendix:   buildSU2AcceptanceAppendix(assessment),
		hashes:     allHashes,
	}, nil
}

func (engine *Engine) readSU2Case(
	ctx context.Context,
	runID string,
	meshSize float64,
	result store.EngineeringResult,
) (core.SU2CaseEvidence, error) {
	requiredRoles := []string{"config", "history", "log", "mesh", "mesh_input", "receipt", "surface"}
	roles := make(map[string]store.EngineeringJobArtifact, len(result.Artifacts))
	for _, artifact := range result.Artifacts {
		if _, duplicate := roles[artifact.Role]; duplicate {
			return core.SU2CaseEvidence{}, fmt.Errorf("SU2 job %s repeats artifact role %q", result.Job.ID, artifact.Role)
		}
		roles[artifact.Role] = artifact
	}
	hashes := make([]string, 0, len(requiredRoles))
	for _, role := range requiredRoles {
		artifact, exists := roles[role]
		if !exists {
			return core.SU2CaseEvidence{}, fmt.Errorf("SU2 job %s omits required %s artifact", result.Job.ID, role)
		}
		if _, err := engine.cas.ReadVerified(artifact.BlobHash); err != nil {
			return core.SU2CaseEvidence{}, fmt.Errorf("read SU2 job %s %s artifact: %w", result.Job.ID, role, err)
		}
		hashes = append(hashes, artifact.BlobHash)
	}
	receiptArtifact := roles["receipt"]
	if receiptArtifact.ArtifactID != result.Job.ReceiptArtifactID {
		return core.SU2CaseEvidence{}, fmt.Errorf("SU2 job %s receipt role does not match its durable receipt", result.Job.ID)
	}
	receiptBytes, err := engine.cas.ReadVerified(receiptArtifact.BlobHash)
	if err != nil {
		return core.SU2CaseEvidence{}, err
	}
	var receipt su2StoredReceipt
	if err := decodeJSONOne(receiptBytes, &receipt); err != nil {
		return core.SU2CaseEvidence{}, fmt.Errorf("decode SU2 job %s receipt: %w", result.Job.ID, err)
	}
	metrics := receipt.Metrics
	if receipt.JobID != result.Job.ID || receipt.RunID != runID ||
		receipt.StageAttemptID != result.Job.StageAttemptID || receipt.Operation != "su2_naca0012" ||
		!receipt.Executed || !receipt.NumericallyValid {
		return core.SU2CaseEvidence{}, fmt.Errorf("SU2 job %s receipt identity or execution proof is invalid", result.Job.ID)
	}
	if metrics.Iterations <= 0 || metrics.MeshNodes <= 0 || metrics.MeshVolumeElements <= 0 ||
		metrics.AirfoilBoundaryElements <= 0 || !finiteSU2Metrics(metrics.CL, metrics.CD,
		metrics.ResidualDropOrders, metrics.CLLateStddev, metrics.CDLateStddev, metrics.UpperShockXOverC) ||
		metrics.Solver != "EULER" || metrics.ConvNumMethodFlow != "JST" ||
		!sameSU2Float(metrics.FarfieldXMinChords, -10) ||
		!sameSU2Float(metrics.FarfieldXMaxChords, 15) ||
		!sameSU2Float(metrics.FarfieldYAbsChords, 10) {
		return core.SU2CaseEvidence{}, fmt.Errorf("SU2 job %s omits required metrics or violates the fixed solver/domain contract", result.Job.ID)
	}
	return core.SU2CaseEvidence{
		JobID: result.Job.ID, ReceiptArtifactID: result.Job.ReceiptArtifactID,
		ReceiptSHA256: receiptArtifact.BlobHash, MeshSizeM: meshSize,
		MeshNodes: metrics.MeshNodes, MeshVolumeElements: metrics.MeshVolumeElements,
		AirfoilBoundaryElements: metrics.AirfoilBoundaryElements,
		CL:                      metrics.CL, CD: metrics.CD, ResidualDropOrders: metrics.ResidualDropOrders,
		CLLateStddev: metrics.CLLateStddev, CDLateStddev: metrics.CDLateStddev,
		OrthogonalityAvailable: metrics.OrthogonalityAvailable,
		UpperShockXOverC:       metrics.UpperShockXOverC,
		ArtifactHashes:         uniqueSortedStrings(hashes),
	}, nil
}

func assessSU2Cases(cases []core.SU2CaseEvidence) core.EngineeringAssessment {
	hashes := make([]string, 0, len(cases))
	for _, item := range cases {
		hashes = append(hashes, item.ReceiptSHA256)
	}
	hashes = uniqueSortedStrings(hashes)
	checks := []core.EngineeringAcceptanceCheck{
		{ID: "plan_case_coverage", Class: core.EngineeringGateHard, Passed: true, Detail: "every planned mesh size executed exactly once in the owner COLLECT attempt", EvidenceHashes: hashes},
		{ID: "solver_domain_contract", Class: core.EngineeringGateHard, Passed: true, Detail: "all receipts prove EULER/JST on x/c=[-10,15], y/c=+-10", EvidenceHashes: hashes},
		{ID: "artifact_cas_integrity", Class: core.EngineeringGateHard, Passed: true, Detail: "config, history, log, mesh, mesh input, surface, and receipt artifacts read back from CAS", EvidenceHashes: hashes},
	}
	residualStable, coefficientStable, orthogonality := true, true, true
	for _, item := range cases {
		residualStable = residualStable && item.ResidualDropOrders >= 6
		coefficientStable = coefficientStable && item.CLLateStddev <= 1e-4 && item.CDLateStddev <= 1e-5
		orthogonality = orthogonality && item.OrthogonalityAvailable
	}
	checks = append(checks,
		core.EngineeringAcceptanceCheck{ID: "residual_convergence", Class: core.EngineeringGateConclusion, Passed: residualStable, Detail: "every case reduces density residual by at least six orders", EvidenceHashes: hashes},
		core.EngineeringAcceptanceCheck{ID: "late_coefficient_stability", Class: core.EngineeringGateConclusion, Passed: coefficientStable, Detail: "every final window satisfies CL stddev <= 1e-4 and CD stddev <= 1e-5", EvidenceHashes: hashes},
		core.EngineeringAcceptanceCheck{ID: "mesh_quality_observability", Class: core.EngineeringGateConclusion, Passed: orthogonality, Detail: "every case reports finite orthogonality bounds", EvidenceHashes: hashes},
	)
	meshSizes := make([]float64, len(cases))
	cl := make([]float64, len(cases))
	cd := make([]float64, len(cases))
	for index, item := range cases {
		meshSizes[index], cl[index], cd[index] = item.MeshSizeM, item.CL, item.CD
	}
	ratioConsistent := consistentRefinementRatios(meshSizes)
	trend := asymptoticMonotonicTrend(cl) && asymptoticMonotonicTrend(cd)
	checks = append(checks,
		core.EngineeringAcceptanceCheck{ID: "refinement_ratio_consistency", Class: core.EngineeringGateConclusion, Passed: ratioConsistent, Detail: "successive coarse-to-fine refinement ratios remain within 25 percent", EvidenceHashes: hashes},
		core.EngineeringAcceptanceCheck{ID: "asymptotic_grid_trend", Class: core.EngineeringGateConclusion, Passed: trend, Detail: "CL and CD change monotonically with decreasing successive differences", EvidenceHashes: hashes},
	)
	outcome := core.EngineeringOutcomeConfirmed
	failed := make([]string, 0)
	for _, check := range checks {
		if check.Class == core.EngineeringGateConclusion && !check.Passed {
			failed = append(failed, check.ID)
		}
	}
	reason := "all deterministic conclusion gates passed; the receipts support a grid-sensitivity conclusion"
	if len(failed) != 0 {
		outcome = core.EngineeringOutcomeInconclusive
		reason = "the calculations completed, but these conclusion gates did not pass: " + strings.Join(failed, ", ")
	}
	return core.EngineeringAssessment{
		Profile: core.SU2MeshStudyProfileV1, Outcome: outcome, OutcomeReason: reason,
		Checks: checks, SU2Cases: append([]core.SU2CaseEvidence(nil), cases...),
	}
}

func asymptoticMonotonicTrend(values []float64) bool {
	if len(values) < 3 {
		return false
	}
	previous := values[1] - values[0]
	if previous == 0 || !finiteSU2Metrics(previous) {
		return false
	}
	for index := 2; index < len(values); index++ {
		current := values[index] - values[index-1]
		if current == 0 || !finiteSU2Metrics(current) || math.Signbit(current) != math.Signbit(previous) ||
			math.Abs(current) >= math.Abs(previous) {
			return false
		}
		previous = current
	}
	return true
}

func consistentRefinementRatios(meshSizes []float64) bool {
	if len(meshSizes) < 3 {
		return false
	}
	ratios := make([]float64, 0, len(meshSizes)-1)
	for index := 1; index < len(meshSizes); index++ {
		if meshSizes[index] <= 0 || meshSizes[index] >= meshSizes[index-1] {
			return false
		}
		ratios = append(ratios, meshSizes[index-1]/meshSizes[index])
	}
	minimum, maximum := slices.Min(ratios), slices.Max(ratios)
	return minimum > 1 && maximum/minimum <= 1.25
}

func buildSU2AcceptanceAppendix(assessment core.EngineeringAssessment) string {
	var out strings.Builder
	out.WriteString(su2AppendixStart + "\n")
	out.WriteString("## Deterministic SU2 acceptance\n\n")
	fmt.Fprintf(&out, "- outcome: **%s**\n- reason: %s\n\n", assessment.Outcome, assessment.OutcomeReason)
	out.WriteString("| mesh size (m) | nodes | volume elements | airfoil edges | CL | CD | residual drop | CL stddev | CD stddev | orthogonality | upper shock x/c | receipt SHA-256 |\n")
	out.WriteString("|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|---:|---|\n")
	for _, item := range assessment.SU2Cases {
		fmt.Fprintf(&out, "| %s | %d | %d | %d | %s | %s | %s | %s | %s | %t | %s | `%s` |\n",
			formatReportFloat(item.MeshSizeM), item.MeshNodes, item.MeshVolumeElements,
			item.AirfoilBoundaryElements, formatReportFloat(item.CL), formatReportFloat(item.CD),
			formatReportFloat(item.ResidualDropOrders), formatReportFloat(item.CLLateStddev),
			formatReportFloat(item.CDLateStddev), item.OrthogonalityAvailable,
			formatReportFloat(item.UpperShockXOverC), item.ReceiptSHA256)
	}
	out.WriteString("\n### Acceptance checks\n\n")
	for _, check := range assessment.Checks {
		status := "FAIL"
		if check.Passed {
			status = "PASS"
		}
		fmt.Fprintf(&out, "- **%s** (%s/%s): %s\n", check.ID, check.Class, status, check.Detail)
	}
	out.WriteString(su2AppendixEnd)
	return out.String()
}

func stripSU2AcceptanceAppendix(markdown string) string {
	start := strings.Index(markdown, su2AppendixStart)
	if start < 0 {
		return strings.TrimSpace(markdown)
	}
	end := strings.Index(markdown[start:], su2AppendixEnd)
	if end < 0 {
		return strings.TrimSpace(markdown[:start])
	}
	end = start + end + len(su2AppendixEnd)
	return strings.TrimSpace(markdown[:start] + markdown[end:])
}

func decodeJSONOne(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		return errors.New("JSON contains multiple values")
	} else if !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

func finiteSU2Metrics(values ...float64) bool {
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
	}
	return true
}

func sameSU2Float(left, right float64) bool {
	return finiteSU2Metrics(left, right) && math.Abs(left-right) <= 1e-12*math.Max(1, math.Max(math.Abs(left), math.Abs(right)))
}

func uniqueSortedStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
