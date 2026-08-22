package research

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/store"
)

const (
	engineeringAppendixStart = "<!-- aetherops-engineering-appendix:start -->"
	engineeringAppendixEnd   = "<!-- aetherops-engineering-appendix:end -->"
	engineeringTraceTableID  = "aetherops-xfoil-interpolation-trace"
	engineeringProvenanceID  = "aetherops-xfoil-verification-provenance"
)

type engineeringReportPackage struct {
	completeness core.EngineeringCompleteness
	appendix     string
	hashes       []string
}

// canonicalReportOutput serializes the post-validation report owned by the Go
// core, not the model's raw structured output. Engineering assessments,
// deterministic appendices, normalized units, and core-added artifact hashes
// are attached while validating SYNTHESIZE/REVISE; persisting the raw model
// bytes would otherwise make REVIEW see a stronger report than the durable
// report later adopted into memory and the knowledge graph.
func canonicalReportOutput(report *core.ReportManifest) func(json.RawMessage) (json.RawMessage, error) {
	return func(json.RawMessage) (json.RawMessage, error) {
		if report == nil || strings.TrimSpace(report.Title) == "" {
			return nil, errors.New("canonical research report is unavailable")
		}
		return json.Marshal(report)
	}
}

type reportXFOILSample struct {
	Alpha             float64 `json:"alpha_deg"`
	CL                float64 `json:"cl"`
	CD                float64 `json:"cd"`
	CDPressure        float64 `json:"cd_pressure"`
	CM                float64 `json:"cm_c4"`
	TopTransitionX    float64 `json:"top_transition_x_over_c"`
	BottomTransitionX float64 `json:"bottom_transition_x_over_c"`
}

type reportXFOILTrace struct {
	Left           reportXFOILSample `json:"left"`
	Right          reportXFOILSample `json:"right"`
	LeftIndex      int               `json:"left_index"`
	RightIndex     int               `json:"right_index"`
	LeftValueHash  string            `json:"left_value_hash"`
	RightValueHash string            `json:"right_value_hash"`
	Fraction       float64           `json:"right_weight"`
}

type reportXFOILTarget struct {
	AlphaDeg          float64          `json:"alpha_deg"`
	CL                float64          `json:"cl"`
	CD                float64          `json:"cd"`
	CM                float64          `json:"cm_c4"`
	FlapDeflectionDeg float64          `json:"flap_deflection_deg"`
	Interpolation     reportXFOILTrace `json:"interpolation"`
}

type reportXFOILCandidate struct {
	JobID             string             `json:"job_id"`
	ReceiptBlobHash   string             `json:"receipt_blob_hash"`
	FlapDeflectionDeg float64            `json:"flap_deflection_deg"`
	TargetReached     bool               `json:"target_reached"`
	Target            *reportXFOILTarget `json:"target_metrics"`
}

type reportXFOILVerification struct {
	WorkspaceID             string            `json:"workspace_id"`
	ScreeningWorkspaceID    string            `json:"screening_workspace_id"`
	VerificationWorkspaceID string            `json:"verification_workspace_id"`
	WorkspacesDistinct      bool              `json:"workspaces_distinct"`
	StageAttemptID          string            `json:"stage_attempt_id"`
	VerificationOfJobID     string            `json:"verification_of_job_id"`
	AttemptCount            int               `json:"attempt_count"`
	ProcessSpawnCount       int               `json:"process_spawn_count"`
	ExecutionCount          int               `json:"execution_count"`
	RetryCount              int               `json:"retry_count"`
	IsolatedWorkspace       bool              `json:"isolated_workspace"`
	Target                  reportXFOILTarget `json:"target_metrics"`
}

type reportXFOILDossier struct {
	Schema                  string                  `json:"schema"`
	ScreeningAttemptCount   int                     `json:"screening_attempt_count"`
	ScreeningCandidateCount int                     `json:"screening_candidate_count"`
	SucceededAttemptCount   int                     `json:"succeeded_screening_attempt_count"`
	FailedAttemptCount      int                     `json:"failed_screening_attempt_count"`
	ScreeningPanelCount     int                     `json:"screening_panel_count"`
	VerificationPanelCount  int                     `json:"verification_panel_count"`
	Candidates              []reportXFOILCandidate  `json:"screening_candidates"`
	WinnerJobID             string                  `json:"winner_job_id"`
	WinnerTarget            reportXFOILTarget       `json:"winner_target_metrics"`
	Verification            reportXFOILVerification `json:"verification"`
}

type reportXFOILReceipt struct {
	Operation        string `json:"operation"`
	Executed         bool   `json:"executed"`
	NumericallyValid bool   `json:"numerically_valid"`
	Metrics          struct {
		Samples []reportXFOILSample `json:"samples"`
	} `json:"metrics"`
}

type reportXFOILGraphData struct {
	Schema string `json:"schema"`
	Series []struct {
		JobID           string              `json:"job_id"`
		ReceiptBlobHash string              `json:"receipt_blob_hash"`
		Samples         []reportXFOILSample `json:"samples"`
	} `json:"series"`
}

func (engine *Engine) assembleEngineeringReportPackage(ctx context.Context, runID string, plan core.ResearchPlan, report *core.ReportManifest) error {
	pack, err := engine.loadEngineeringReportPackage(ctx, runID)
	if err != nil {
		return err
	}
	su2Pack, err := engine.loadSU2AcceptancePackage(ctx, runID, plan)
	if err != nil {
		return err
	}
	report.AnswerMarkdown = stripEngineeringAppendix(report.AnswerMarkdown)
	report.AnswerMarkdown = stripSU2AcceptanceAppendix(report.AnswerMarkdown)
	report.EngineeringCompleteness = nil
	report.EngineeringAssessment = nil
	if pack != nil {
		report.EngineeringCompleteness = &pack.completeness
		report.AnswerMarkdown = strings.TrimSpace(report.AnswerMarkdown) + "\n\n" + pack.appendix
	}
	if su2Pack != nil {
		report.EngineeringAssessment = &su2Pack.assessment
		report.AnswerMarkdown = strings.TrimSpace(report.AnswerMarkdown) + "\n\n" + su2Pack.appendix
	}
	allHashes := make([]string, 0)
	if pack != nil {
		allHashes = append(allHashes, pack.hashes...)
	}
	if su2Pack != nil {
		allHashes = append(allHashes, su2Pack.hashes...)
	}
	allHashes = uniqueSortedStrings(allHashes)
	required := make(map[string]struct{}, len(allHashes))
	for _, hash := range allHashes {
		required[hash] = struct{}{}
	}
	report.ArtifactHashes = removeArtifactHashes(report.ArtifactHashes, required)
	for _, hash := range allHashes {
		report.ArtifactHashes = append(report.ArtifactHashes, hash)
	}
	return nil
}

func (engine *Engine) verifyEngineeringReportPackage(ctx context.Context, runID string, plan core.ResearchPlan, report core.ReportManifest) error {
	pack, err := engine.loadEngineeringReportPackage(ctx, runID)
	if err != nil {
		return err
	}
	su2Pack, err := engine.loadSU2AcceptancePackage(ctx, runID, plan)
	if err != nil {
		return err
	}
	if pack == nil {
		if report.EngineeringCompleteness != nil || strings.Contains(report.AnswerMarkdown, engineeringAppendixStart) {
			return errors.New("report contains an engineering package without an independent verification result")
		}
	} else {
		if report.EngineeringCompleteness == nil {
			return errors.New("report omits deterministic engineering completeness metadata")
		}
		expected, _ := json.Marshal(pack.completeness)
		actual, _ := json.Marshal(report.EngineeringCompleteness)
		if string(expected) != string(actual) {
			return errors.New("report engineering completeness metadata does not match verified artifacts")
		}
		if !strings.Contains(report.AnswerMarkdown, pack.appendix) {
			return errors.New("report omits the deterministic engineering appendix")
		}
		for _, hash := range pack.hashes {
			if countString(report.ArtifactHashes, hash) != 1 {
				return fmt.Errorf("report must attach engineering artifact %s exactly once", hash)
			}
		}
	}
	if su2Pack == nil {
		if report.EngineeringAssessment != nil || strings.Contains(report.AnswerMarkdown, su2AppendixStart) {
			return errors.New("report contains a SU2 assessment without a planned SU2 study")
		}
		return nil
	}
	if report.EngineeringAssessment == nil {
		return errors.New("report omits deterministic SU2 engineering assessment")
	}
	expectedAssessment, _ := json.Marshal(su2Pack.assessment)
	actualAssessment, _ := json.Marshal(report.EngineeringAssessment)
	if string(expectedAssessment) != string(actualAssessment) {
		return errors.New("report SU2 assessment does not match verified receipts")
	}
	if !strings.Contains(report.AnswerMarkdown, su2Pack.appendix) {
		return errors.New("report omits the deterministic SU2 acceptance appendix")
	}
	for _, hash := range su2Pack.hashes {
		if countString(report.ArtifactHashes, hash) != 1 {
			return fmt.Errorf("report must attach SU2 artifact %s exactly once", hash)
		}
	}
	return nil
}

func (engine *Engine) loadEngineeringReportPackage(ctx context.Context, runID string) (*engineeringReportPackage, error) {
	results, err := engine.db.ListRunEngineeringResults(ctx, runID)
	if err != nil {
		return nil, fmt.Errorf("load engineering report results: %w", err)
	}
	var verification *store.EngineeringResult
	resultByJob := make(map[string]store.EngineeringResult, len(results))
	for index := range results {
		result := results[index]
		resultByJob[result.Job.ID] = result
		if result.Job.Operation != "xfoil_polar" {
			continue
		}
		var ordinal int
		if err := engine.db.SQL().QueryRowContext(ctx,
			"SELECT logical_ordinal FROM stage_attempts WHERE id=? AND run_id=?",
			result.Job.StageAttemptID, runID).Scan(&ordinal); err != nil {
			return nil, err
		}
		if ordinal == core.EngineeringVerificationOrdinal {
			if verification != nil {
				return nil, errors.New("run has multiple successful independent XFOIL verification jobs")
			}
			copy := result
			verification = &copy
		}
	}
	if verification == nil {
		return nil, nil
	}
	roles := make(map[string]store.EngineeringJobArtifact)
	for _, artifact := range verification.Artifacts {
		if _, duplicate := roles[artifact.Role]; duplicate {
			return nil, fmt.Errorf("independent verification repeats artifact role %q", artifact.Role)
		}
		roles[artifact.Role] = artifact
	}
	requiredRoles := []string{
		"optimization_dossier", "graph_data", "graph_cl_alpha", "graph_cl_cd", "graph_cm_cl",
	}
	hashes := make([]string, 0, len(requiredRoles))
	for _, role := range requiredRoles {
		artifact, exists := roles[role]
		if !exists {
			return nil, fmt.Errorf("independent verification omits required %s artifact", role)
		}
		if _, err := engine.cas.ReadVerified(artifact.BlobHash); err != nil {
			return nil, fmt.Errorf("read independent verification %s: %w", role, err)
		}
		hashes = append(hashes, artifact.BlobHash)
	}
	dossierBytes, err := engine.cas.ReadVerified(roles["optimization_dossier"].BlobHash)
	if err != nil {
		return nil, err
	}
	var dossier reportXFOILDossier
	if err := json.Unmarshal(dossierBytes, &dossier); err != nil {
		return nil, fmt.Errorf("decode XFOIL optimization dossier: %w", err)
	}
	if err := engine.validateXFOILDossier(ctx, runID, *verification, resultByJob, dossier); err != nil {
		return nil, err
	}
	graphBytes, err := engine.cas.ReadVerified(roles["graph_data"].BlobHash)
	if err != nil {
		return nil, err
	}
	if err := engine.validateXFOILGraphData(ctx, graphBytes, dossier, verification.Job.ID, resultByJob); err != nil {
		return nil, err
	}
	for role, title := range map[string]string{
		"graph_cl_alpha": "CL-alpha", "graph_cl_cd": "CL-CD", "graph_cm_cl": "Cm-CL",
	} {
		data, err := engine.cas.ReadVerified(roles[role].BlobHash)
		if err != nil {
			return nil, err
		}
		if !strings.Contains(string(data), "<svg") || !strings.Contains(string(data), title) ||
			strings.Count(string(data), "<polyline") != len(dossier.Candidates)+1 {
			return nil, fmt.Errorf("%s graph does not match the verified series contract", role)
		}
	}
	figures := []core.EngineeringFigureReference{
		{Kind: "cl_alpha", DataArtifactHash: roles["graph_data"].BlobHash, RenderArtifactHash: roles["graph_cl_alpha"].BlobHash, ReportFigureID: "aetherops-xfoil-cl-alpha"},
		{Kind: "cl_cd", DataArtifactHash: roles["graph_data"].BlobHash, RenderArtifactHash: roles["graph_cl_cd"].BlobHash, ReportFigureID: "aetherops-xfoil-cl-cd"},
		{Kind: "cm_cl", DataArtifactHash: roles["graph_data"].BlobHash, RenderArtifactHash: roles["graph_cm_cl"].BlobHash, ReportFigureID: "aetherops-xfoil-cm-cl"},
	}
	completeness := core.EngineeringCompleteness{
		Profile:                  "xfoil_flap_screening/v1",
		EvidencePackArtifactHash: roles["optimization_dossier"].BlobHash,
		InterpolationTrace: core.EngineeringInterpolationTrace{
			TargetCL: dossier.WinnerTarget.CL, CandidateCount: len(dossier.Candidates),
			ArtifactHash: roles["optimization_dossier"].BlobHash, ReportTableID: engineeringTraceTableID,
		},
		Figures: figures,
		IndependentVerification: core.EngineeringVerificationEvidence{
			ProvenanceArtifactHash: roles["optimization_dossier"].BlobHash,
			ScreeningJobID:         dossier.WinnerJobID, VerificationJobID: verification.Job.ID,
			ScreeningPanelCount:    dossier.ScreeningPanelCount,
			VerificationPanelCount: dossier.VerificationPanelCount,
			ReportSectionID:        engineeringProvenanceID,
		},
	}
	return &engineeringReportPackage{
		completeness: completeness,
		appendix:     buildEngineeringAppendix(dossier, roles),
		hashes:       hashes,
	}, nil
}

func (engine *Engine) validateXFOILDossier(
	ctx context.Context,
	runID string,
	verification store.EngineeringResult,
	results map[string]store.EngineeringResult,
	dossier reportXFOILDossier,
) error {
	if dossier.Schema != "xfoil_optimization_dossier_v1" ||
		dossier.ScreeningCandidateCount != len(dossier.Candidates) ||
		dossier.SucceededAttemptCount != len(dossier.Candidates) ||
		dossier.FailedAttemptCount != 0 || len(dossier.Candidates) == 0 {
		return errors.New("XFOIL optimization dossier has inconsistent candidate counts")
	}
	if dossier.ScreeningPanelCount <= 0 || dossier.VerificationPanelCount <= dossier.ScreeningPanelCount {
		return errors.New("XFOIL verification panel refinement is invalid")
	}
	v := dossier.Verification
	if v.WorkspaceID != verification.Job.ID || v.VerificationWorkspaceID != verification.Job.ID ||
		v.ScreeningWorkspaceID != dossier.WinnerJobID || !v.WorkspacesDistinct ||
		dossier.WinnerJobID == verification.Job.ID || v.VerificationOfJobID != dossier.WinnerJobID ||
		v.StageAttemptID != verification.Job.StageAttemptID || v.AttemptCount != 1 ||
		v.ProcessSpawnCount != 1 || v.ExecutionCount != 1 || v.RetryCount != 0 ||
		!v.IsolatedWorkspace {
		return errors.New("XFOIL independent verification provenance is incomplete")
	}
	var jobCount int
	if err := engine.db.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM engineering_jobs WHERE run_id=? AND stage_attempt_id=? AND operation='xfoil_polar'",
		runID, verification.Job.StageAttemptID).Scan(&jobCount); err != nil {
		return err
	}
	if jobCount != 1 {
		return fmt.Errorf("independent verification execution count is %d, want 1", jobCount)
	}
	for index, candidate := range dossier.Candidates {
		if index > 0 && candidate.FlapDeflectionDeg <= dossier.Candidates[index-1].FlapDeflectionDeg {
			return errors.New("XFOIL dossier candidates are not in deterministic deflection order")
		}
		result, exists := results[candidate.JobID]
		if !exists || result.Job.ReceiptArtifactID == "" || !candidate.TargetReached || candidate.Target == nil {
			return fmt.Errorf("XFOIL dossier candidate %q has no successful target receipt", candidate.JobID)
		}
		artifact, err := engine.db.Artifact(ctx, result.Job.ReceiptArtifactID)
		if err != nil || artifact.RunID != runID || artifact.BlobHash != candidate.ReceiptBlobHash {
			return fmt.Errorf("XFOIL dossier candidate %q receipt identity mismatch", candidate.JobID)
		}
		receiptBytes, err := engine.cas.ReadVerified(candidate.ReceiptBlobHash)
		if err != nil {
			return fmt.Errorf("read XFOIL candidate %q receipt: %w", candidate.JobID, err)
		}
		samples, err := decodeReportXFOILSamples(receiptBytes)
		if err != nil {
			return err
		}
		if err := validateReportXFOILTarget(samples, *candidate.Target); err != nil {
			return fmt.Errorf("candidate %q interpolation trace: %w", candidate.JobID, err)
		}
	}
	if _, exists := results[dossier.WinnerJobID]; !exists {
		return errors.New("XFOIL dossier winner is not a successful screening job")
	}
	verificationArtifact, err := engine.db.Artifact(ctx, verification.Job.ReceiptArtifactID)
	if err != nil {
		return err
	}
	verificationBytes, err := engine.cas.ReadVerified(verificationArtifact.BlobHash)
	if err != nil {
		return err
	}
	samples, err := decodeReportXFOILSamples(verificationBytes)
	if err != nil {
		return err
	}
	return validateReportXFOILTarget(samples, dossier.Verification.Target)
}

func decodeReportXFOILSamples(data []byte) ([]reportXFOILSample, error) {
	var receipt reportXFOILReceipt
	if err := json.Unmarshal(data, &receipt); err != nil || receipt.Operation != "xfoil_polar" ||
		!receipt.Executed || !receipt.NumericallyValid || len(receipt.Metrics.Samples) < 2 {
		return nil, errors.New("XFOIL receipt is not an executed numerically valid polar")
	}
	return receipt.Metrics.Samples, nil
}

func validateReportXFOILTarget(samples []reportXFOILSample, target reportXFOILTarget) error {
	trace := target.Interpolation
	if trace.LeftIndex < 0 || trace.RightIndex < trace.LeftIndex ||
		trace.RightIndex >= len(samples) || trace.RightIndex-trace.LeftIndex > 1 {
		return errors.New("interpolation row locators are invalid")
	}
	left, right := samples[trace.LeftIndex], samples[trace.RightIndex]
	if reportXFOILSampleHash(left) != trace.LeftValueHash ||
		reportXFOILSampleHash(right) != trace.RightValueHash ||
		reportXFOILSampleHash(trace.Left) != trace.LeftValueHash ||
		reportXFOILSampleHash(trace.Right) != trace.RightValueHash {
		return errors.New("interpolation row hash does not match the receipt")
	}
	fraction := 0.0
	if trace.LeftIndex != trace.RightIndex {
		if right.CL == left.CL {
			return errors.New("interpolation endpoints have identical CL")
		}
		fraction = (target.CL - left.CL) / (right.CL - left.CL)
		if fraction < 0 || fraction > 1 {
			return errors.New("interpolation would extrapolate")
		}
	} else if !closeReportFloat(left.CL, target.CL) {
		return errors.New("exact interpolation row does not equal target CL")
	}
	if !closeReportFloat(trace.Fraction, fraction) ||
		!closeReportFloat(target.AlphaDeg, left.Alpha+fraction*(right.Alpha-left.Alpha)) ||
		!closeReportFloat(target.CD, left.CD+fraction*(right.CD-left.CD)) ||
		!closeReportFloat(target.CM, left.CM+fraction*(right.CM-left.CM)) {
		return errors.New("interpolation result does not recompute from its source rows")
	}
	return nil
}

func (engine *Engine) validateXFOILGraphData(
	ctx context.Context,
	data []byte,
	dossier reportXFOILDossier,
	verificationJobID string,
	results map[string]store.EngineeringResult,
) error {
	var graph reportXFOILGraphData
	if err := json.Unmarshal(data, &graph); err != nil || graph.Schema != "xfoil_graph_data_v1" ||
		len(graph.Series) != len(dossier.Candidates)+1 {
		return errors.New("XFOIL graph data does not cover every series")
	}
	for index, candidate := range dossier.Candidates {
		series := graph.Series[index]
		if series.JobID != candidate.JobID || series.ReceiptBlobHash != candidate.ReceiptBlobHash ||
			len(series.Samples) < 2 {
			return fmt.Errorf("XFOIL graph series %d does not match its screening receipt", index)
		}
		result, exists := results[candidate.JobID]
		if !exists {
			return fmt.Errorf("XFOIL graph series %d has no successful job", index)
		}
		artifact, err := engine.db.Artifact(ctx, result.Job.ReceiptArtifactID)
		if err != nil {
			return err
		}
		receiptBytes, err := engine.cas.ReadVerified(artifact.BlobHash)
		if err != nil {
			return err
		}
		samples, err := decodeReportXFOILSamples(receiptBytes)
		if err != nil || !equalReportXFOILSamples(series.Samples, samples) {
			return fmt.Errorf("XFOIL graph series %d values do not match its CAS receipt", index)
		}
	}
	last := graph.Series[len(graph.Series)-1]
	if last.JobID != verificationJobID || len(last.Samples) < 2 {
		return errors.New("XFOIL graph data omits independent verification")
	}
	verification, exists := results[verificationJobID]
	if !exists {
		return errors.New("XFOIL graph verification series has no successful job")
	}
	artifact, err := engine.db.Artifact(ctx, verification.Job.ReceiptArtifactID)
	if err != nil {
		return err
	}
	receiptBytes, err := engine.cas.ReadVerified(artifact.BlobHash)
	if err != nil {
		return err
	}
	samples, err := decodeReportXFOILSamples(receiptBytes)
	if err != nil || !equalReportXFOILSamples(last.Samples, samples) {
		return errors.New("XFOIL graph verification values do not match its CAS receipt")
	}
	return nil
}

func equalReportXFOILSamples(left, right []reportXFOILSample) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		leftBytes, _ := json.Marshal(left[index])
		rightBytes, _ := json.Marshal(right[index])
		if string(leftBytes) != string(rightBytes) {
			return false
		}
	}
	return true
}

func buildEngineeringAppendix(
	dossier reportXFOILDossier,
	roles map[string]store.EngineeringJobArtifact,
) string {
	var out strings.Builder
	out.WriteString(engineeringAppendixStart + "\n")
	out.WriteString("## Deterministic engineering appendix\n\n")
	out.WriteString("<a id=\"" + engineeringTraceTableID + "\"></a>\n")
	out.WriteString("### Target-CL interpolation lineage\n\n")
	out.WriteString("| flap (deg) | left row | right row | right weight | alpha | CL | CD | Cm(c/4) | receipt SHA-256 |\n")
	out.WriteString("|---:|---:|---:|---:|---:|---:|---:|---:|---|\n")
	for _, candidate := range dossier.Candidates {
		target := candidate.Target
		fmt.Fprintf(&out, "| %s | %d | %d | %s | %s | %s | %s | %s | `%s` |\n",
			formatReportFloat(candidate.FlapDeflectionDeg), target.Interpolation.LeftIndex,
			target.Interpolation.RightIndex, formatReportFloat(target.Interpolation.Fraction),
			formatReportFloat(target.AlphaDeg), formatReportFloat(target.CL),
			formatReportFloat(target.CD), formatReportFloat(target.CM), candidate.ReceiptBlobHash)
	}
	out.WriteString("\n### Deterministic comparison figures\n\n")
	for _, item := range []struct{ id, label, role string }{
		{"aetherops-xfoil-cl-alpha", "CL-alpha", "graph_cl_alpha"},
		{"aetherops-xfoil-cl-cd", "CL-CD", "graph_cl_cd"},
		{"aetherops-xfoil-cm-cl", "Cm-CL", "graph_cm_cl"},
	} {
		fmt.Fprintf(&out, "<a id=\"%s\"></a>- %s: render `%s`, canonical data `%s`\n",
			item.id, item.label, roles[item.role].BlobHash, roles["graph_data"].BlobHash)
	}
	out.WriteString("\n<a id=\"" + engineeringProvenanceID + "\"></a>\n")
	out.WriteString("### Independent verification provenance\n\n")
	v := dossier.Verification
	fmt.Fprintf(&out, "- screening workspace: `%s`\n- verification workspace: `%s`\n", v.ScreeningWorkspaceID, v.VerificationWorkspaceID)
	fmt.Fprintf(&out, "- workspaces distinct: %t; attempt/process/execution counts: %d/%d/%d; retries: %d\n",
		v.WorkspacesDistinct, v.AttemptCount, v.ProcessSpawnCount, v.ExecutionCount, v.RetryCount)
	fmt.Fprintf(&out, "- panel refinement: %d -> %d; evidence pack: `%s`\n",
		dossier.ScreeningPanelCount, dossier.VerificationPanelCount, roles["optimization_dossier"].BlobHash)
	out.WriteString(engineeringAppendixEnd)
	return out.String()
}

func stripEngineeringAppendix(markdown string) string {
	start := strings.Index(markdown, engineeringAppendixStart)
	if start < 0 {
		return strings.TrimSpace(markdown)
	}
	end := strings.Index(markdown[start:], engineeringAppendixEnd)
	if end < 0 {
		return strings.TrimSpace(markdown[:start])
	}
	end = start + end + len(engineeringAppendixEnd)
	return strings.TrimSpace(markdown[:start] + markdown[end:])
}

func reportXFOILSampleHash(sample reportXFOILSample) string {
	encoded, _ := json.Marshal(sample)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func closeReportFloat(left, right float64) bool {
	if math.IsNaN(left) || math.IsNaN(right) || math.IsInf(left, 0) || math.IsInf(right, 0) {
		return false
	}
	return math.Abs(left-right) <= 1e-9*math.Max(1, math.Max(math.Abs(left), math.Abs(right)))
}

func formatReportFloat(value float64) string {
	return strconv.FormatFloat(value, 'g', 12, 64)
}

func removeArtifactHashes(values []string, removed map[string]struct{}) []string {
	kept := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := removed[value]; !exists {
			kept = append(kept, value)
		}
	}
	return kept
}

func countString(values []string, wanted string) int {
	count := 0
	for _, value := range values {
		if value == wanted {
			count++
		}
	}
	return count
}
