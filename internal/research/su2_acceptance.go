package research

import (
	"bufio"
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

type su2HistoryPoint struct {
	Iteration int
	RMSRho    float64
	CL        float64
	CD        float64
}

type su2CaseTrace struct {
	JobID        string
	MeshSizeM    float64
	SpecSHA256   string
	ToolVersion  string
	StartedAt    string
	CompletedAt  string
	HistoryHash  string
	ReceiptHash  string
	HistoryPoint []su2HistoryPoint
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
	SpecSHA256       string `json:"spec_sha256"`
	StartedAt        string `json:"started_at"`
	CompletedAt      string `json:"completed_at"`
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

// reusableSU2StudyPlan reconstructs the exact immutable SU2 contract from
// succeeded run-owned jobs for a REVIEW-directed readback cycle. It never
// creates a solver job and fails closed if the prior executions disagree on
// their operating point or receipt set.
func (engine *Engine) reusableSU2StudyPlan(
	ctx context.Context,
	runID string,
) (*core.SU2MeshStudyPlan, []store.EngineeringResult, error) {
	jobs, err := engine.db.ListRunEngineeringJobs(ctx, runID, "su2_naca0012")
	if err != nil {
		return nil, nil, err
	}
	if len(jobs) == 0 {
		return nil, nil, nil
	}
	allResults, err := engine.db.ListRunEngineeringResults(ctx, runID)
	if err != nil {
		return nil, nil, err
	}
	resultByJob := make(map[string]store.EngineeringResult, len(allResults))
	for _, result := range allResults {
		resultByJob[result.Job.ID] = result
	}
	type reusableCase struct {
		meshSize float64
		result   store.EngineeringResult
	}
	cases := make([]reusableCase, 0, len(jobs))
	var mach, alpha float64
	var iterations int
	for index, job := range jobs {
		if job.Status != "succeeded" || job.ReceiptArtifactID == "" {
			return nil, nil, fmt.Errorf("SU2 job %s is not a reusable succeeded receipt", job.ID)
		}
		var spec su2StoredSpec
		if err := decodeJSONOne([]byte(job.SpecJSON), &spec); err != nil {
			return nil, nil, fmt.Errorf("decode reusable SU2 job %s: %w", job.ID, err)
		}
		arguments := spec.Arguments
		if spec.Operation != "su2_naca0012" || arguments.RunID != runID ||
			arguments.StageAttemptID != job.StageAttemptID {
			return nil, nil, fmt.Errorf("SU2 job %s has inconsistent immutable identity", job.ID)
		}
		if index == 0 {
			mach, alpha, iterations = arguments.Mach, arguments.AlphaDeg, arguments.Iterations
		} else if !sameSU2Float(arguments.Mach, mach) || !sameSU2Float(arguments.AlphaDeg, alpha) ||
			arguments.Iterations != iterations {
			return nil, nil, errors.New("reusable SU2 jobs do not share one operating point and iteration contract")
		}
		result, exists := resultByJob[job.ID]
		if !exists {
			return nil, nil, fmt.Errorf("SU2 job %s has no reusable artifact set", job.ID)
		}
		cases = append(cases, reusableCase{meshSize: arguments.MeshSizeM, result: result})
	}
	sort.Slice(cases, func(left, right int) bool { return cases[left].meshSize > cases[right].meshSize })
	plan := &core.SU2MeshStudyPlan{
		ExecutionMode:       core.SU2ExecutionReadback,
		Profile:             core.SU2MeshStudyProfileV1,
		NACA:                "0012",
		Mach:                mach,
		AlphaDeg:            alpha,
		Iterations:          iterations,
		DomainProfile:       core.SU2FixedDomainV1,
		Objective:           core.SU2ObjectiveGridStudy,
		ReferenceComparison: "qualitative_context",
	}
	results := make([]store.EngineeringResult, len(cases))
	for index, item := range cases {
		plan.MeshSizesM = append(plan.MeshSizesM, item.meshSize)
		results[index] = item.result
	}
	if err := plan.Validate(); err != nil {
		return nil, nil, fmt.Errorf("validate reusable SU2 contract: %w", err)
	}
	if _, err := engine.loadSU2AcceptancePackage(ctx, runID, core.ResearchPlan{SU2MeshStudy: plan}); err != nil {
		return nil, nil, fmt.Errorf("verify reusable SU2 receipt package: %w", err)
	}
	return plan, results, nil
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
	traces := make([]su2CaseTrace, 0, len(plan.SU2MeshStudy.MeshSizesM))
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
		trace, err := engine.readSU2CaseTrace(ctx, result, caseEvidence)
		if err != nil {
			return nil, err
		}
		cases = append(cases, caseEvidence)
		traces = append(traces, trace)
		allHashes = append(allHashes, caseEvidence.ArtifactHashes...)
	}
	allHashes = uniqueSortedStrings(allHashes)
	assessment := assessSU2Cases(cases)
	if err := assessment.Validate(); err != nil {
		return nil, fmt.Errorf("validate deterministic SU2 assessment: %w", err)
	}
	return &su2AcceptancePackage{
		assessment: assessment,
		appendix:   buildSU2AcceptanceAppendix(*plan.SU2MeshStudy, assessment, traces),
		hashes:     allHashes,
	}, nil
}

func (engine *Engine) readSU2CaseTrace(
	ctx context.Context,
	result store.EngineeringResult,
	item core.SU2CaseEvidence,
) (su2CaseTrace, error) {
	roles := make(map[string]store.EngineeringJobArtifact, len(result.Artifacts))
	for _, artifact := range result.Artifacts {
		roles[artifact.Role] = artifact
	}
	historyArtifact, hasHistory := roles["history"]
	receiptArtifact, hasReceipt := roles["receipt"]
	if !hasHistory || !hasReceipt {
		return su2CaseTrace{}, fmt.Errorf("SU2 job %s omits history or receipt trace data", result.Job.ID)
	}
	historyBytes, err := engine.cas.ReadVerified(historyArtifact.BlobHash)
	if err != nil {
		return su2CaseTrace{}, fmt.Errorf("read SU2 job %s history trace: %w", result.Job.ID, err)
	}
	points, err := parseSU2HistoryTrace(historyBytes)
	if err != nil {
		return su2CaseTrace{}, fmt.Errorf("parse SU2 job %s history trace: %w", result.Job.ID, err)
	}
	receiptBytes, err := engine.cas.ReadVerified(receiptArtifact.BlobHash)
	if err != nil {
		return su2CaseTrace{}, fmt.Errorf("read SU2 job %s receipt trace: %w", result.Job.ID, err)
	}
	var receipt su2StoredReceipt
	if err := decodeJSONOne(receiptBytes, &receipt); err != nil {
		return su2CaseTrace{}, fmt.Errorf("decode SU2 job %s receipt trace: %w", result.Job.ID, err)
	}
	last := points[len(points)-1]
	if len(points) != receipt.Metrics.Iterations || last.Iteration+1 != receipt.Metrics.Iterations ||
		!sameSU2Float(last.CL, item.CL) || !sameSU2Float(last.CD, item.CD) ||
		receipt.SpecSHA256 != result.Job.SpecSHA256 || strings.TrimSpace(receipt.StartedAt) == "" ||
		strings.TrimSpace(receipt.CompletedAt) == "" {
		return su2CaseTrace{}, fmt.Errorf("SU2 job %s history and receipt trace do not agree", result.Job.ID)
	}
	return su2CaseTrace{
		JobID: result.Job.ID, MeshSizeM: item.MeshSizeM, SpecSHA256: result.Job.SpecSHA256,
		ToolVersion: result.Job.ToolVersion, StartedAt: receipt.StartedAt, CompletedAt: receipt.CompletedAt,
		HistoryHash: historyArtifact.BlobHash, ReceiptHash: receiptArtifact.BlobHash,
		HistoryPoint: points,
	}, nil
}

func parseSU2HistoryTrace(data []byte) ([]su2HistoryPoint, error) {
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	rows := make([][]string, 0, 256)
	expectedFields := 0
	for lineNumber := 1; scanner.Scan(); lineNumber++ {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fields := strings.Split(line, ",")
		for index := range fields {
			fields[index] = strings.Trim(strings.TrimSpace(fields[index]), `"`)
		}
		if expectedFields == 0 {
			expectedFields = len(fields)
		}
		if len(fields) != expectedFields {
			return nil, fmt.Errorf("history line %d has %d fields, want %d", lineNumber, len(fields), expectedFields)
		}
		rows = append(rows, fields)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(rows) < 3 {
		return nil, errors.New("history contains too few convergence rows")
	}
	header := rows[0]
	columns := make(map[string]int, len(header))
	for index, value := range header {
		columns[strings.TrimSpace(value)] = index
	}
	required := []string{"Inner_Iter", "rms[Rho]", "CL", "CD"}
	for _, name := range required {
		if _, exists := columns[name]; !exists {
			return nil, fmt.Errorf("history omits %s", name)
		}
	}
	points := make([]su2HistoryPoint, 0, len(rows)-1)
	for rowIndex, row := range rows[1:] {
		readFloat := func(name string) (float64, error) {
			index := columns[name]
			if index >= len(row) {
				return 0, fmt.Errorf("history row %d omits %s", rowIndex+2, name)
			}
			return strconv.ParseFloat(strings.TrimSpace(row[index]), 64)
		}
		iterationValue, parseErr := readFloat("Inner_Iter")
		if parseErr != nil || iterationValue != math.Trunc(iterationValue) || iterationValue < 0 {
			return nil, fmt.Errorf("history row %d has an invalid iteration", rowIndex+2)
		}
		residual, residualErr := readFloat("rms[Rho]")
		cl, clErr := readFloat("CL")
		cd, cdErr := readFloat("CD")
		if residualErr != nil || clErr != nil || cdErr != nil || !finiteSU2Metrics(residual, cl, cd) {
			return nil, fmt.Errorf("history row %d has invalid convergence values", rowIndex+2)
		}
		iteration := int(iterationValue)
		if iteration != len(points) {
			return nil, fmt.Errorf("history iteration %d is not the expected contiguous value %d", iteration, len(points))
		}
		points = append(points, su2HistoryPoint{Iteration: iteration, RMSRho: residual, CL: cl, CD: cd})
	}
	return points, nil
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
	volumeElements := make([]int, len(cases))
	cl := make([]float64, len(cases))
	cd := make([]float64, len(cases))
	for index, item := range cases {
		volumeElements[index], cl[index], cd[index] = item.MeshVolumeElements, item.CL, item.CD
	}
	ratioConsistent := consistentVolumeRefinementRatios(volumeElements)
	trend := asymptoticMonotonicTrend(cl) && asymptoticMonotonicTrend(cd)
	checks = append(checks,
		core.EngineeringAcceptanceCheck{ID: "refinement_ratio_consistency", Class: core.EngineeringGateConclusion, Passed: ratioConsistent, Detail: "realized 2D cell-count refinement ratios remain above one and within 25 percent", EvidenceHashes: hashes},
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

func consistentVolumeRefinementRatios(volumeElements []int) bool {
	characteristicSizes := make([]float64, len(volumeElements))
	for index, elements := range volumeElements {
		if elements <= 0 {
			return false
		}
		// Every bundled case uses the same two-dimensional farfield domain, so
		// h is proportional to 1/sqrt(N). Requested mesh_size_m is only a
		// generator target and cannot prove that the volume mesh refined.
		characteristicSizes[index] = 1 / math.Sqrt(float64(elements))
	}
	return consistentRefinementRatios(characteristicSizes)
}

func buildSU2AcceptanceAppendix(plan core.SU2MeshStudyPlan, assessment core.EngineeringAssessment, traces []su2CaseTrace) string {
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
	if len(traces) == len(assessment.SU2Cases) {
		out.WriteString("\n### Execution audit and exact reproduction\n\n")
		out.WriteString("| mesh (m) | job | spec SHA-256 | SU2 | start (UTC) | complete (UTC) | iterations | history SHA-256 | receipt SHA-256 |\n")
		out.WriteString("|---:|---|---|---|---|---|---:|---|---|\n")
		for _, trace := range traces {
			fmt.Fprintf(&out, "| %s | `%s` | `%s` | %s | %s | %s | %d | `%s` | `%s` |\n",
				formatReportFloat(trace.MeshSizeM), trace.JobID, trace.SpecSHA256, trace.ToolVersion,
				trace.StartedAt, trace.CompletedAt, len(trace.HistoryPoint), trace.HistoryHash, trace.ReceiptHash)
		}
		fmt.Fprintf(&out, "\nReproduction contract: invoke the bundled `su2_naca0012` tool in the listed coarse-to-fine order with `mach=%s`, `alpha_deg=%s`, `iterations=%d`, and `mesh_size_m` values `%s`; use the fixed closed-trailing-edge NACA 0012 geometry, EULER/JST, and `x/c=[-10,15]`, `y/c=[-10,10]`. Each case is executed exactly once with no retry or result selection. Verify the spec, history, and receipt hashes above before recomputing any value.\n",
			formatReportFloat(plan.Mach), formatReportFloat(plan.AlphaDeg), plan.Iterations,
			joinSU2MeshSizes(plan.MeshSizesM))

		out.WriteString("\n### Deterministic convergence figures\n\n")
		out.WriteString("Every polyline below uses every contiguous row from its CAS-verified `history.csv`; no interpolation, smoothing, or row removal is applied.\n\n")
		out.WriteString(buildSU2HistorySVG("aetherops-su2-rms-rho", "Density residual convergence", "iteration", "log10 RMS density residual", traces, func(point su2HistoryPoint) float64 { return point.RMSRho }))
		out.WriteString("\n")
		out.WriteString(buildSU2HistorySVG("aetherops-su2-cl-history", "CL convergence", "iteration", "CL", traces, func(point su2HistoryPoint) float64 { return point.CL }))
		out.WriteString("\n")
		out.WriteString(buildSU2HistorySVG("aetherops-su2-cd-history", "CD convergence", "iteration", "CD", traces, func(point su2HistoryPoint) float64 { return point.CD }))

		out.WriteString("\n### Deterministic grid-sensitivity figures\n\n")
		out.WriteString("The horizontal coordinate is the realized two-dimensional characteristic size `h=1/sqrt(N_volume)`, not the requested nominal mesh size.\n\n")
		out.WriteString(buildSU2GridSVG("aetherops-su2-cl-grid", "CL versus realized characteristic size", "1/sqrt(N_volume)", "CL", assessment.SU2Cases, func(item core.SU2CaseEvidence) float64 { return item.CL }))
		out.WriteString("\n")
		out.WriteString(buildSU2GridSVG("aetherops-su2-cd-grid", "CD versus realized characteristic size", "1/sqrt(N_volume)", "CD", assessment.SU2Cases, func(item core.SU2CaseEvidence) float64 { return item.CD }))
	}
	out.WriteString(su2AppendixEnd)
	return out.String()
}

func joinSU2MeshSizes(values []float64) string {
	formatted := make([]string, len(values))
	for index, value := range values {
		formatted[index] = formatReportFloat(value)
	}
	return strings.Join(formatted, ", ")
}

type su2PlotSeries struct {
	label string
	hash  string
	point [][2]float64
}

func buildSU2HistorySVG(id, title, xLabel, yLabel string, traces []su2CaseTrace, value func(su2HistoryPoint) float64) string {
	series := make([]su2PlotSeries, 0, len(traces))
	for _, trace := range traces {
		points := make([][2]float64, 0, len(trace.HistoryPoint))
		for _, item := range trace.HistoryPoint {
			points = append(points, [2]float64{float64(item.Iteration), value(item)})
		}
		series = append(series, su2PlotSeries{label: "mesh " + formatReportFloat(trace.MeshSizeM) + " m", hash: trace.HistoryHash, point: points})
	}
	return buildSU2InlineSVG(id, title, xLabel, yLabel, series)
}

func buildSU2GridSVG(id, title, xLabel, yLabel string, cases []core.SU2CaseEvidence, value func(core.SU2CaseEvidence) float64) string {
	points := make([][2]float64, 0, len(cases))
	for _, item := range cases {
		points = append(points, [2]float64{1 / math.Sqrt(float64(item.MeshVolumeElements)), value(item)})
	}
	return buildSU2InlineSVG(id, title, xLabel, yLabel, []su2PlotSeries{{label: title, point: points}})
}

func buildSU2InlineSVG(id, title, xLabel, yLabel string, series []su2PlotSeries) string {
	const width, height = 820.0, 430.0
	const left, right, top, bottom = 82.0, 190.0, 54.0, 62.0
	minX, maxX, minY, maxY := math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)
	for _, item := range series {
		for _, point := range item.point {
			if finiteSU2Metrics(point[0], point[1]) {
				minX, maxX = math.Min(minX, point[0]), math.Max(maxX, point[0])
				minY, maxY = math.Min(minY, point[1]), math.Max(maxY, point[1])
			}
		}
	}
	if !finiteSU2Metrics(minX, maxX, minY, maxY) {
		return ""
	}
	if minX == maxX {
		minX, maxX = minX-0.5, maxX+0.5
	}
	if minY == maxY {
		minY, maxY = minY-0.5, maxY+0.5
	}
	paddingY := (maxY - minY) * 0.04
	minY, maxY = minY-paddingY, maxY+paddingY
	plotWidth, plotHeight := width-left-right, height-top-bottom
	scaleX := func(value float64) float64 { return left + (value-minX)/(maxX-minX)*plotWidth }
	scaleY := func(value float64) float64 { return top + (maxY-value)/(maxY-minY)*plotHeight }
	colors := []string{"#38bdf8", "#34d399", "#fbbf24", "#fb7185"}
	var out strings.Builder
	fmt.Fprintf(&out, "<figure id=\"%s\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"820\" height=\"430\" viewBox=\"0 0 820 430\" role=\"img\" aria-label=\"%s\"><rect width=\"820\" height=\"430\" fill=\"#0b1220\"/><path d=\"M82 54V368H630\" fill=\"none\" stroke=\"#64748b\"/><g fill=\"#e2e8f0\" font-family=\"Segoe UI,Arial,sans-serif\"><text x=\"82\" y=\"31\" font-size=\"20\">%s</text><text x=\"325\" y=\"416\" font-size=\"13\">%s</text><text x=\"17\" y=\"235\" font-size=\"13\" transform=\"rotate(-90 17 235)\">%s</text><text x=\"82\" y=\"388\" font-size=\"11\">%.6g</text><text x=\"590\" y=\"388\" font-size=\"11\">%.6g</text><text x=\"30\" y=\"368\" font-size=\"11\">%.6g</text><text x=\"30\" y=\"64\" font-size=\"11\">%.6g</text></g>", id, title, title, xLabel, yLabel, minX, maxX, minY, maxY)
	for index, item := range series {
		color := colors[index%len(colors)]
		fmt.Fprintf(&out, "<polyline fill=\"none\" stroke=\"%s\" stroke-width=\"1.6\" data-source-sha256=\"%s\" points=\"", color, item.hash)
		for _, point := range item.point {
			if finiteSU2Metrics(point[0], point[1]) {
				fmt.Fprintf(&out, "%.2f,%.2f ", scaleX(point[0]), scaleY(point[1]))
			}
		}
		fmt.Fprintf(&out, "\"/><g fill=\"%s\" font-family=\"Segoe UI,Arial,sans-serif\" font-size=\"11\"><rect x=\"650\" y=\"%d\" width=\"13\" height=\"3\"/><text x=\"672\" y=\"%d\">%s</text></g>", color, 76+index*23, 81+index*23, item.label)
	}
	out.WriteString("</svg><figcaption>Deterministic CAS-derived figure; source identities are bound in the execution audit table.</figcaption></figure>\n")
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
