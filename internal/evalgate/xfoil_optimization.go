package evalgate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
	"time"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/engineering"
	managedruntime "github.com/djkim0320/Aether-claw/internal/runtime"
	"github.com/djkim0320/Aether-claw/internal/store"
)

type XFOILTargetProof struct {
	AlphaDeg            float64 `json:"alpha_deg"`
	CL                  float64 `json:"cl"`
	CD                  float64 `json:"cd"`
	CM                  float64 `json:"cm_c4"`
	FlapDeflectionDeg   float64 `json:"flap_deflection_deg"`
	ConstraintSatisfied bool    `json:"constraint_satisfied"`
}

type XFOILOptimizationProof struct {
	Required                       bool
	Objective                      string
	TargetCL                       float64
	MinimumCM                      float64
	RuntimeBundleSHA256            string
	SweepIdentitySHA256            string
	ScreeningAttemptCount          int
	ScreeningCandidateCount        int
	SucceededScreeningAttemptCount int
	FailedScreeningAttemptCount    int
	WinnerJobID                    string
	WinnerStageAttemptID           string
	WinnerReceiptArtifactID        string
	WinnerReceiptBlobSHA256        string
	WinnerSpecSHA256               string
	WinnerPhysicalArgumentsSHA256  string
	WinnerTarget                   XFOILTargetProof
	VerificationJobID              string
	VerificationStageAttemptID     string
	VerificationReceiptArtifactID  string
	VerificationReceiptBlobSHA256  string
	VerificationSpecSHA256         string
	VerificationPhysicalSHA256     string
	VerificationTarget             XFOILTargetProof
}

type evaluationXFOILEnvelope struct {
	Arguments json.RawMessage `json:"arguments"`
	Operation string          `json:"operation"`
	Runtime   string          `json:"runtime_bundle_hash"`
	Component string          `json:"tool_component"`
	Version   string          `json:"tool_version"`
}

type evaluationXFOILReceipt struct {
	Schema           int                          `json:"schema"`
	JobID            string                       `json:"job_id"`
	RunID            string                       `json:"run_id"`
	StageAttemptID   string                       `json:"stage_attempt_id"`
	Operation        string                       `json:"operation"`
	Spec             json.RawMessage              `json:"spec"`
	SpecSHA256       string                       `json:"spec_sha256"`
	Executables      []evaluationXFOILExecutable  `json:"executables"`
	Threads          int                          `json:"threads"`
	StartedAt        time.Time                    `json:"started_at"`
	CompletedAt      time.Time                    `json:"completed_at"`
	ExitCodes        []int                        `json:"exit_codes"`
	Executed         bool                         `json:"executed"`
	NumericallyValid bool                         `json:"numerically_valid"`
	Metrics          map[string]any               `json:"metrics"`
	Artifacts        []engineering.ArtifactResult `json:"artifacts"`
	CASBlobSHA256    string                       `json:"-"`
}

type evaluationXFOILExecutable struct {
	Component string   `json:"component"`
	Version   string   `json:"version"`
	SHA256    string   `json:"sha256"`
	Argv      []string `json:"argv"`
}

type evaluationXFOILCandidate struct {
	job           store.EngineeringJob
	envelope      evaluationXFOILEnvelope
	spec          engineering.XFOILSpec
	sweepIdentity []byte
	physical      []byte
	target        *XFOILTargetProof
	receipt       *evaluationXFOILReceipt
}

type evaluationOptimizationMetric struct {
	Objective     string            `json:"objective"`
	TargetCL      float64           `json:"target_cl"`
	MinimumCM     float64           `json:"minimum_cm"`
	TargetReached bool              `json:"target_reached"`
	TargetMetrics *XFOILTargetProof `json:"target_metrics,omitempty"`
}

type evaluationVerificationMetric struct {
	ScreeningAttemptCount          int     `json:"screening_attempt_count"`
	ScreeningCandidateCount        int     `json:"screening_candidate_count"`
	SucceededScreeningAttemptCount int     `json:"succeeded_screening_attempt_count"`
	FailedScreeningAttemptCount    int     `json:"failed_screening_attempt_count"`
	WinnerJobID                    string  `json:"winner_job_id"`
	WinnerFlapDeflectionDeg        float64 `json:"winner_flap_deflection_deg"`
	Agreement                      string  `json:"agreement"`
}

// VerifyXFOILOptimization independently rebuilds the deterministic sweep from
// immutable job specifications and CAS receipts. It deliberately includes
// failed screening attempts so a producer cannot shrink the candidate set to
// only successful jobs. A single purpose-less XFOIL execution remains the
// legacy, non-optimization contract.
func VerifyXFOILOptimization(
	ctx context.Context, database *store.DB, objects *cas.Store, runID string,
) (XFOILOptimizationProof, error) {
	if database == nil || objects == nil || strings.TrimSpace(runID) == "" {
		return XFOILOptimizationProof{}, errors.New("XFOIL optimization verification requires SQLite, CAS, and run id")
	}
	run, err := database.Run(ctx, runID)
	if err != nil {
		return XFOILOptimizationProof{}, err
	}
	jobs, err := database.ListRunEngineeringJobs(ctx, runID, "xfoil_polar")
	if err != nil {
		return XFOILOptimizationProof{}, err
	}
	if len(jobs) == 0 {
		return XFOILOptimizationProof{}, nil
	}
	candidates := make([]evaluationXFOILCandidate, 0, len(jobs))
	explicit := false
	for _, job := range jobs {
		candidate, err := decodeEvaluationXFOILCandidate(ctx, database, run, job)
		if err != nil {
			return XFOILOptimizationProof{}, err
		}
		if candidate.spec.ExecutionPurpose != "" {
			explicit = true
		}
		candidates = append(candidates, candidate)
	}
	if !explicit {
		if len(candidates) != 1 || candidates[0].job.Status != "succeeded" ||
			candidates[0].spec.OptimizationObjective != "" || candidates[0].spec.TargetCL != nil ||
			candidates[0].spec.MinimumCM != nil || candidates[0].spec.VerificationOfJobID != "" {
			return XFOILOptimizationProof{}, errors.New("legacy XFOIL contract permits exactly one unclassified succeeded job")
		}
		if _, err := readEvaluationXFOILReceipt(ctx, database, objects, runID, candidates[0].job); err != nil {
			return XFOILOptimizationProof{}, err
		}
		return XFOILOptimizationProof{}, nil
	}

	proof := XFOILOptimizationProof{Required: true}
	var sweepIdentity []byte
	var sweepRuntime string
	byDeflection := make(map[uint64]int)
	screenings := make([]evaluationXFOILCandidate, 0, len(candidates))
	verifications := make([]evaluationXFOILCandidate, 0, 1)
	for _, candidate := range candidates {
		if err := validateEvaluationOptimizationSpec(candidate.spec); err != nil {
			return XFOILOptimizationProof{}, fmt.Errorf("XFOIL job %s optimization contract: %w", candidate.job.ID, err)
		}
		switch candidate.spec.ExecutionPurpose {
		case engineering.XFOILPurposeScreening:
			if candidate.job.Status != "succeeded" && candidate.job.Status != "failed" {
				return XFOILOptimizationProof{}, fmt.Errorf("screening XFOIL job %s is still %s", candidate.job.ID, candidate.job.Status)
			}
			if sweepIdentity == nil {
				sweepIdentity = candidate.sweepIdentity
				sweepRuntime = candidate.envelope.Runtime
			} else if !bytes.Equal(sweepIdentity, candidate.sweepIdentity) {
				return XFOILOptimizationProof{}, errors.New("XFOIL screening jobs do not form one homogeneous optimization sweep")
			} else if candidate.envelope.Runtime != sweepRuntime {
				return XFOILOptimizationProof{}, errors.New("XFOIL screening jobs do not use one homogeneous runtime bundle")
			}
			deflection := *candidate.spec.FlapDeflectionDeg
			if deflection == 0 {
				deflection = 0
			}
			byDeflection[math.Float64bits(deflection)]++
			proof.ScreeningAttemptCount++
			if candidate.job.Status == "succeeded" {
				proof.SucceededScreeningAttemptCount++
			} else {
				proof.FailedScreeningAttemptCount++
			}
			screenings = append(screenings, candidate)
		case engineering.XFOILPurposeIndependentVerification:
			if candidate.job.Status != "succeeded" {
				return XFOILOptimizationProof{}, errors.New("independent XFOIL verification did not succeed")
			}
			verifications = append(verifications, candidate)
		default:
			return XFOILOptimizationProof{}, errors.New("optimization run contains an unclassified XFOIL job")
		}
	}
	proof.ScreeningCandidateCount = len(byDeflection)
	if proof.ScreeningAttemptCount < 2 || proof.ScreeningCandidateCount < 2 || proof.SucceededScreeningAttemptCount < 2 {
		return XFOILOptimizationProof{}, errors.New("independent XFOIL verification requires at least two completed screening candidates")
	}
	if len(verifications) == 0 {
		return XFOILOptimizationProof{}, errors.New("multiple screening XFOIL jobs require the reserved independent verification collector")
	}
	if len(verifications) != 1 {
		return XFOILOptimizationProof{}, fmt.Errorf("optimization sweep requires exactly one succeeded independent verification, got %d", len(verifications))
	}
	proof.Objective = screenings[0].spec.OptimizationObjective
	proof.TargetCL, proof.MinimumCM = *screenings[0].spec.TargetCL, *screenings[0].spec.MinimumCM
	proof.RuntimeBundleSHA256 = sweepRuntime
	sweepDigest := sha256.Sum256(sweepIdentity)
	proof.SweepIdentitySHA256 = hex.EncodeToString(sweepDigest[:])

	succeededByDeflection := make(map[uint64]bool)
	var screeningExecutableSHA256 string
	winnerFound := false
	var winner evaluationXFOILCandidate
	for index := range screenings {
		candidate := &screenings[index]
		if candidate.job.Status != "succeeded" {
			continue
		}
		deflection := *candidate.spec.FlapDeflectionDeg
		if deflection == 0 {
			deflection = 0
		}
		key := math.Float64bits(deflection)
		if succeededByDeflection[key] {
			return XFOILOptimizationProof{}, errors.New("XFOIL sweep contains duplicate succeeded jobs for one flap deflection")
		}
		succeededByDeflection[key] = true
		receipt, err := readEvaluationXFOILReceipt(ctx, database, objects, runID, candidate.job)
		if err != nil {
			return XFOILOptimizationProof{}, fmt.Errorf("CAS-verify screening receipt %s: %w", candidate.job.ID, err)
		}
		if screeningExecutableSHA256 == "" {
			screeningExecutableSHA256 = receipt.Executables[0].SHA256
		} else if receipt.Executables[0].SHA256 != screeningExecutableSHA256 {
			return XFOILOptimizationProof{}, errors.New("XFOIL screening jobs do not use one homogeneous executable")
		}
		candidate.receipt = &receipt
		target, err := verifyEvaluationOptimizationMetrics(candidate.spec, receipt.Metrics)
		if err != nil {
			return XFOILOptimizationProof{}, fmt.Errorf("screening receipt %s metrics: %w", candidate.job.ID, err)
		}
		candidate.target = target
		if target == nil || !target.ConstraintSatisfied {
			continue
		}
		if !winnerFound || evaluationTargetWins(*target, candidate.job.ID, *winner.target, winner.job.ID) {
			winner = *candidate
			winnerFound = true
		}
	}
	if !winnerFound {
		return XFOILOptimizationProof{}, errors.New("XFOIL screening sweep has no feasible target-CL candidate")
	}
	proof.WinnerJobID, proof.WinnerStageAttemptID = winner.job.ID, winner.job.StageAttemptID
	proof.WinnerReceiptArtifactID, proof.WinnerSpecSHA256 = winner.job.ReceiptArtifactID, winner.job.SpecSHA256
	proof.WinnerReceiptBlobSHA256 = winner.receipt.CASBlobSHA256
	proof.WinnerPhysicalArgumentsSHA256 = evaluationSHA256(winner.physical)
	proof.WinnerTarget = *winner.target

	verification := verifications[0]
	if verification.spec.VerificationOfJobID != winner.job.ID {
		return XFOILOptimizationProof{}, fmt.Errorf("verification source %s is not deterministic feasible minimum-CD winner %s",
			verification.spec.VerificationOfJobID, winner.job.ID)
	}
	if err := engineering.ValidateIndependentXFOILContract(winner.spec, verification.spec, winner.target.AlphaDeg); err != nil {
		return XFOILOptimizationProof{}, fmt.Errorf("independent XFOIL verification contract: %w", err)
	}
	if verification.envelope.Runtime != winner.envelope.Runtime ||
		verification.job.ToolComponent != winner.job.ToolComponent || verification.job.ToolVersion != winner.job.ToolVersion {
		return XFOILOptimizationProof{}, errors.New("independent XFOIL verification differs from the winner runtime")
	}
	verificationReceipt, err := readEvaluationXFOILReceipt(ctx, database, objects, runID, verification.job)
	if err != nil {
		return XFOILOptimizationProof{}, fmt.Errorf("CAS-verify independent verification: %w", err)
	}
	if verificationReceipt.Executables[0].SHA256 != winner.receipt.Executables[0].SHA256 {
		return XFOILOptimizationProof{}, errors.New("independent XFOIL verification executable differs from the screening winner")
	}
	verificationTarget, err := verifyEvaluationOptimizationMetrics(verification.spec, verificationReceipt.Metrics)
	if err != nil || verificationTarget == nil || !verificationTarget.ConstraintSatisfied {
		return XFOILOptimizationProof{}, errors.New("independent XFOIL receipt has no feasible target metric")
	}
	if !verificationTarget.ConstraintSatisfied ||
		!evaluationClose(winner.target.FlapDeflectionDeg, verificationTarget.FlapDeflectionDeg, 1e-12) ||
		!engineering.XFOILIndependentTargetsAgree(
			winner.target.CL, winner.target.CD, winner.target.CM,
			verificationTarget.CL, verificationTarget.CD, verificationTarget.CM,
		) {
		return XFOILOptimizationProof{}, errors.New("screening winner and independent verification target metrics disagree")
	}
	if err := verifyEvaluationVerificationMetric(verificationReceipt.Metrics, proof); err != nil {
		return XFOILOptimizationProof{}, err
	}
	proof.VerificationJobID = verification.job.ID
	proof.VerificationStageAttemptID = verification.job.StageAttemptID
	proof.VerificationReceiptArtifactID = verification.job.ReceiptArtifactID
	proof.VerificationReceiptBlobSHA256 = verificationReceipt.CASBlobSHA256
	proof.VerificationSpecSHA256 = verification.job.SpecSHA256
	proof.VerificationPhysicalSHA256 = evaluationSHA256(verification.physical)
	proof.VerificationTarget = *verificationTarget
	return proof, nil
}

func decodeEvaluationXFOILCandidate(
	ctx context.Context, database *store.DB, run core.Run, job store.EngineeringJob,
) (evaluationXFOILCandidate, error) {
	if job.RunID != run.ID || job.ProjectID != run.ProjectID || job.Operation != "xfoil_polar" ||
		job.ToolComponent != "xfoil" || job.ToolVersion != managedruntime.PinnedXFOILVersion ||
		job.SpecJSON == "" || job.SpecSHA256 == "" {
		return evaluationXFOILCandidate{}, fmt.Errorf("XFOIL job %s identity is invalid", job.ID)
	}
	digest := sha256.Sum256([]byte(job.SpecJSON))
	if hex.EncodeToString(digest[:]) != job.SpecSHA256 {
		return evaluationXFOILCandidate{}, fmt.Errorf("XFOIL job %s specification hash is invalid", job.ID)
	}
	var envelope evaluationXFOILEnvelope
	if err := decodeEvaluationStrict([]byte(job.SpecJSON), &envelope); err != nil ||
		envelope.Operation != "xfoil_polar" || envelope.Component != job.ToolComponent ||
		envelope.Version != job.ToolVersion || !evaluationDigest(envelope.Runtime) {
		return evaluationXFOILCandidate{}, fmt.Errorf("XFOIL job %s normalized specification is invalid", job.ID)
	}
	var spec engineering.XFOILSpec
	if err := decodeEvaluationStrict(envelope.Arguments, &spec); err != nil ||
		spec.RunID != run.ID || spec.StageAttemptID != job.StageAttemptID {
		return evaluationXFOILCandidate{}, fmt.Errorf("XFOIL job %s arguments are not bound to its run and stage", job.ID)
	}
	var stage string
	var ordinal int
	if err := database.SQL().QueryRowContext(ctx,
		"SELECT stage,logical_ordinal FROM stage_attempts WHERE id=? AND run_id=?",
		job.StageAttemptID, run.ID,
	).Scan(&stage, &ordinal); err != nil || stage != string(core.StageCollect) {
		return evaluationXFOILCandidate{}, fmt.Errorf("XFOIL job %s is outside a collect attempt", job.ID)
	}
	if spec.ExecutionPurpose == engineering.XFOILPurposeScreening &&
		(ordinal < 0 || ordinal >= core.EngineeringVerificationOrdinal) {
		return evaluationXFOILCandidate{}, errors.New("screening XFOIL job is outside an ordinary collector")
	}
	if spec.ExecutionPurpose == engineering.XFOILPurposeIndependentVerification && ordinal != core.EngineeringVerificationOrdinal {
		return evaluationXFOILCandidate{}, errors.New("independent XFOIL job is outside the reserved collector")
	}
	sweep, err := evaluationXFOILIdentity(spec, true)
	if err != nil {
		return evaluationXFOILCandidate{}, err
	}
	physical, err := evaluationXFOILIdentity(spec, false)
	if err != nil {
		return evaluationXFOILCandidate{}, err
	}
	return evaluationXFOILCandidate{job: job, envelope: envelope, spec: spec, sweepIdentity: sweep, physical: physical}, nil
}

func validateEvaluationOptimizationSpec(spec engineering.XFOILSpec) error {
	if spec.OptimizationObjective != engineering.XFOILObjectiveMinimizeCDAtTargetCL ||
		spec.TargetCL == nil || spec.MinimumCM == nil || spec.FlapChordRatio == nil ||
		spec.FlapHingeXOverC == nil || spec.FlapHingeYOverC == nil || spec.FlapDeflectionDeg == nil {
		return errors.New("optimization objective, target_cl, minimum_cm, and sealed flap geometry are required")
	}
	if !evaluationFinite(*spec.TargetCL, *spec.MinimumCM, *spec.FlapChordRatio, *spec.FlapHingeXOverC,
		*spec.FlapHingeYOverC, *spec.FlapDeflectionDeg) || *spec.TargetCL < -5 || *spec.TargetCL > 5 ||
		*spec.MinimumCM < -5 || *spec.MinimumCM > 5 ||
		math.Abs((1-*spec.FlapHingeXOverC)-*spec.FlapChordRatio) > 1e-8 {
		return errors.New("optimization contract contains invalid target, constraint, or flap geometry")
	}
	if spec.ExecutionPurpose == engineering.XFOILPurposeScreening && spec.VerificationOfJobID != "" {
		return errors.New("screening job contains verification_of_job_id")
	}
	if spec.ExecutionPurpose == engineering.XFOILPurposeIndependentVerification && spec.VerificationOfJobID == "" {
		return errors.New("independent verification omits verification_of_job_id")
	}
	return nil
}

func evaluationXFOILIdentity(spec engineering.XFOILSpec, sweep bool) ([]byte, error) {
	if spec.NCrit == nil {
		value := 9.0
		spec.NCrit = &value
	}
	if spec.Iterations == nil {
		value := 250
		spec.Iterations = &value
	}
	if spec.PanelCount == nil {
		value := 160
		spec.PanelCount = &value
	}
	if spec.FlapDeflectionDeg != nil && *spec.FlapDeflectionDeg == 0 {
		zero := 0.0
		spec.FlapDeflectionDeg = &zero
	}
	spec.RunID, spec.StageAttemptID, spec.ExecutionPurpose, spec.VerificationOfJobID = "", "", "", ""
	if sweep {
		spec.FlapDeflectionDeg = nil
	}
	return json.Marshal(spec)
}

func readEvaluationXFOILReceipt(
	ctx context.Context, database *store.DB, objects *cas.Store, runID string, job store.EngineeringJob,
) (evaluationXFOILReceipt, error) {
	if job.Status != "succeeded" || job.ReceiptArtifactID == "" {
		return evaluationXFOILReceipt{}, errors.New("succeeded XFOIL job has no receipt artifact")
	}
	links, err := database.EngineeringJobArtifacts(ctx, job.ID)
	if err != nil {
		return evaluationXFOILReceipt{}, err
	}
	var receiptHash string
	for _, link := range links {
		data, err := objects.ReadVerified(link.BlobHash)
		if err != nil || len(data) == 0 {
			return evaluationXFOILReceipt{}, errors.New("XFOIL engineering artifact CAS readback failed")
		}
		if link.ArtifactID == job.ReceiptArtifactID && link.Role == "receipt" {
			receiptHash = link.BlobHash
		}
	}
	if receiptHash == "" {
		return evaluationXFOILReceipt{}, errors.New("XFOIL receipt link is missing")
	}
	raw, err := objects.ReadVerified(receiptHash)
	if err != nil {
		return evaluationXFOILReceipt{}, err
	}
	var receipt evaluationXFOILReceipt
	if err := decodeEvaluationStrict(raw, &receipt); err != nil || receipt.Schema != 1 || receipt.JobID != job.ID ||
		receipt.RunID != runID || receipt.StageAttemptID != job.StageAttemptID || receipt.Operation != "xfoil_polar" ||
		receipt.SpecSHA256 != job.SpecSHA256 || string(receipt.Spec) != job.SpecJSON || !receipt.Executed ||
		!receipt.NumericallyValid || receipt.Threads < 1 || len(receipt.Executables) != 1 ||
		receipt.CompletedAt.Before(receipt.StartedAt) ||
		receipt.Executables[0].Component != "xfoil" || receipt.Executables[0].Version != managedruntime.PinnedXFOILVersion ||
		!evaluationDigest(receipt.Executables[0].SHA256) || len(receipt.ExitCodes) != 1 || receipt.ExitCodes[0] != 0 {
		return evaluationXFOILReceipt{}, errors.New("XFOIL execution receipt is not a successful pinned execution")
	}
	specDigest := sha256.Sum256(receipt.Spec)
	if hex.EncodeToString(specDigest[:]) != receipt.SpecSHA256 {
		return evaluationXFOILReceipt{}, errors.New("XFOIL receipt specification hash is invalid")
	}
	receipt.CASBlobSHA256 = receiptHash
	return receipt, nil
}

func verifyEvaluationOptimizationMetrics(
	spec engineering.XFOILSpec, metrics map[string]any,
) (*XFOILTargetProof, error) {
	samplesRaw, ok := metrics["samples"]
	if !ok {
		return nil, errors.New("receipt has no polar samples")
	}
	encoded, err := json.Marshal(samplesRaw)
	if err != nil {
		return nil, err
	}
	var samples []engineering.XFOILSample
	if err := decodeEvaluationStrict(encoded, &samples); err != nil || len(samples) < 2 {
		return nil, errors.New("receipt polar samples are invalid")
	}
	target, found, err := interpolateEvaluationXFOILTarget(samples, *spec.TargetCL)
	if err != nil {
		return nil, err
	}
	if found {
		target.FlapDeflectionDeg = *spec.FlapDeflectionDeg
		target.ConstraintSatisfied = target.CM >= *spec.MinimumCM
	}
	metricRaw, ok := metrics["optimization"]
	if !ok {
		return nil, errors.New("receipt omits deterministic optimization metrics")
	}
	encoded, err = json.Marshal(metricRaw)
	if err != nil {
		return nil, err
	}
	var metric evaluationOptimizationMetric
	if err := decodeEvaluationStrict(encoded, &metric); err != nil ||
		metric.Objective != spec.OptimizationObjective || !evaluationClose(metric.TargetCL, *spec.TargetCL, 1e-12) ||
		!evaluationClose(metric.MinimumCM, *spec.MinimumCM, 1e-12) || metric.TargetReached != found {
		return nil, errors.New("receipt optimization contract differs from its immutable specification")
	}
	if !found {
		if metric.TargetMetrics != nil {
			return nil, errors.New("unreached target carries fabricated target metrics")
		}
		return nil, nil
	}
	if metric.TargetMetrics == nil || !evaluationTargetsAgree(*metric.TargetMetrics, target) {
		return nil, errors.New("receipt target metrics disagree with recomputed polar interpolation")
	}
	return &target, nil
}

func verifyEvaluationVerificationMetric(metrics map[string]any, proof XFOILOptimizationProof) error {
	raw, ok := metrics["optimization_verification"]
	if !ok {
		return errors.New("independent receipt omits optimization verification counts")
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return err
	}
	var metric evaluationVerificationMetric
	if err := decodeEvaluationStrict(encoded, &metric); err != nil ||
		metric.ScreeningAttemptCount != proof.ScreeningAttemptCount ||
		metric.ScreeningCandidateCount != proof.ScreeningCandidateCount ||
		metric.SucceededScreeningAttemptCount != proof.SucceededScreeningAttemptCount ||
		metric.FailedScreeningAttemptCount != proof.FailedScreeningAttemptCount ||
		metric.WinnerJobID != proof.WinnerJobID || metric.Agreement != "pass" ||
		!evaluationClose(metric.WinnerFlapDeflectionDeg, proof.WinnerTarget.FlapDeflectionDeg, 1e-12) {
		return errors.New("independent receipt optimization counts or deterministic winner are invalid")
	}
	return nil
}

func interpolateEvaluationXFOILTarget(
	samples []engineering.XFOILSample, targetCL float64,
) (XFOILTargetProof, bool, error) {
	if len(samples) < 2 || !evaluationFinite(targetCL) {
		return XFOILTargetProof{}, false, errors.New("target interpolation requires finite target CL and at least two samples")
	}
	for index, sample := range samples {
		if !evaluationFinite(sample.Alpha, sample.CL, sample.CD, sample.CM) || sample.CD <= 0 ||
			(index > 0 && sample.Alpha <= samples[index-1].Alpha) {
			return XFOILTargetProof{}, false, errors.New("target interpolation received invalid or unordered polar samples")
		}
	}
	const exactTolerance = 1e-12
	points := make([]XFOILTargetProof, 0, 2)
	for _, sample := range samples {
		if math.Abs(sample.CL-targetCL) <= exactTolerance {
			points = append(points, XFOILTargetProof{AlphaDeg: sample.Alpha, CL: targetCL, CD: sample.CD, CM: sample.CM})
		}
	}
	for index := 0; index+1 < len(samples); index++ {
		left, right := samples[index], samples[index+1]
		leftDelta, rightDelta := left.CL-targetCL, right.CL-targetCL
		if math.Abs(leftDelta) <= exactTolerance || math.Abs(rightDelta) <= exactTolerance || leftDelta*rightDelta >= 0 {
			continue
		}
		fraction := (targetCL - left.CL) / (right.CL - left.CL)
		point := XFOILTargetProof{
			AlphaDeg: left.Alpha + fraction*(right.Alpha-left.Alpha), CL: targetCL,
			CD: left.CD + fraction*(right.CD-left.CD), CM: left.CM + fraction*(right.CM-left.CM),
		}
		if !evaluationFinite(point.AlphaDeg, point.CD, point.CM) || point.CD <= 0 {
			return XFOILTargetProof{}, false, errors.New("target interpolation produced invalid coefficients")
		}
		points = append(points, point)
	}
	if len(points) == 0 {
		return XFOILTargetProof{}, false, nil
	}
	best := points[0]
	for _, point := range points[1:] {
		if point.CD < best.CD-exactTolerance ||
			(math.Abs(point.CD-best.CD) <= exactTolerance && point.AlphaDeg < best.AlphaDeg) {
			best = point
		}
	}
	return best, true, nil
}

func evaluationTargetWins(candidate XFOILTargetProof, candidateJobID string, incumbent XFOILTargetProof, incumbentJobID string) bool {
	if candidate.CD < incumbent.CD-1e-12 {
		return true
	}
	if math.Abs(candidate.CD-incumbent.CD) > 1e-12 {
		return false
	}
	if candidate.FlapDeflectionDeg < incumbent.FlapDeflectionDeg-1e-12 {
		return true
	}
	if math.Abs(candidate.FlapDeflectionDeg-incumbent.FlapDeflectionDeg) > 1e-12 {
		return false
	}
	return candidateJobID < incumbentJobID
}

func evaluationTargetsAgree(left, right XFOILTargetProof) bool {
	return left.ConstraintSatisfied == right.ConstraintSatisfied &&
		evaluationClose(left.AlphaDeg, right.AlphaDeg, 1e-8) &&
		evaluationClose(left.CL, right.CL, 1e-8) &&
		evaluationClose(left.CD, right.CD, 1e-8) &&
		evaluationClose(left.CM, right.CM, 1e-8) &&
		evaluationClose(left.FlapDeflectionDeg, right.FlapDeflectionDeg, 1e-8)
}

func evaluationSHA256(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func evaluationClose(left, right, scale float64) bool {
	return math.Abs(left-right) <= scale*math.Max(1, math.Max(math.Abs(left), math.Abs(right)))
}

func evaluationFinite(values ...float64) bool {
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
	}
	return true
}

func evaluationDigest(value string) bool {
	if len(value) != 64 || value == strings.Repeat("0", 64) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil && strings.ToLower(value) == value
}

func decodeEvaluationStrict(raw []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains multiple values")
		}
		return err
	}
	return nil
}
