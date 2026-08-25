package livee2eevidence

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/engineering"
	"github.com/djkim0320/AetherOps/internal/evalgate"
	"github.com/djkim0320/AetherOps/internal/evalrunner"
	"github.com/djkim0320/AetherOps/internal/livee2econtract"
	"github.com/djkim0320/AetherOps/internal/releasegate"
	managedruntime "github.com/djkim0320/AetherOps/internal/runtime"
	"github.com/djkim0320/AetherOps/internal/store"
)

type FinalizeConfig struct {
	CandidateExecutable string
	PreparedLedger      string
	DatasetPath         string
	RunnerReceipt       string
	EvaluationReceipt   string
	JournalPath         string
	DataRoot            string
}

type engineeringExecutionReceipt struct {
	Schema           int                     `json:"schema"`
	JobID            string                  `json:"job_id"`
	RunID            string                  `json:"run_id"`
	StageAttemptID   string                  `json:"stage_attempt_id"`
	Operation        string                  `json:"operation"`
	Spec             json.RawMessage         `json:"spec"`
	SpecSHA256       string                  `json:"spec_sha256"`
	Executables      []engineeringExecutable `json:"executables"`
	Threads          int                     `json:"threads"`
	StartedAt        time.Time               `json:"started_at"`
	CompletedAt      time.Time               `json:"completed_at"`
	ExitCodes        []int                   `json:"exit_codes"`
	Executed         bool                    `json:"executed"`
	NumericallyValid bool                    `json:"numerically_valid"`
	Artifacts        []engineeringArtifact   `json:"artifacts"`
}

type engineeringExecutable struct {
	Component string   `json:"component"`
	Version   string   `json:"version"`
	SHA256    string   `json:"sha256"`
	Argv      []string `json:"argv"`
}

type engineeringArtifact struct {
	ArtifactID string `json:"artifact_id"`
	Role       string `json:"role"`
	FileName   string `json:"file_name"`
	MediaType  string `json:"media_type"`
	SHA256     string `json:"sha256"`
	Size       int64  `json:"size"`
}

func FinalizeOffline(ctx context.Context, config FinalizeConfig) (result FinalizeResult, returnErr error) {
	observation, err := LoadCompletedJournal(config.JournalPath)
	if err != nil {
		return FinalizeResult{}, err
	}
	build, evaluation, err := reauthenticateFinalizeInputs(config, observation.Binding)
	if err != nil {
		return FinalizeResult{}, err
	}
	root, err := filepath.Abs(strings.TrimSpace(config.DataRoot))
	if err != nil || strings.TrimSpace(config.DataRoot) == "" {
		return FinalizeResult{}, errors.New("explicit AetherOps data root is required")
	}
	database, err := store.OpenReadOnly(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		return FinalizeResult{}, err
	}
	defer func() { returnErr = errors.Join(returnErr, database.Close()) }()
	objects, err := cas.OpenReadOnly(filepath.Join(root, "objects"))
	if err != nil {
		return FinalizeResult{}, err
	}
	run, err := database.Run(ctx, observation.Run.RunID)
	if err != nil || run.ProjectID != observation.Binding.ProjectID || run.ProductBuild != build ||
		run.Question != ResearchPrompt || run.Status != core.RunSucceeded || run.ID != observation.Run.RunID ||
		run.ReportArtifactID != observation.Run.ReportArtifactID ||
		run.Revision != observation.Run.Revision || !run.CreatedAt.Equal(observation.Run.CreatedAt) ||
		!run.UpdatedAt.Equal(observation.Run.TerminalAt) || run.ResearchProfileVersion != core.CurrentResearchProfileVersion ||
		run.RetrievalProfile != store.DefaultRetrievalProfile {
		return FinalizeResult{}, errors.New("durable end-to-end research run differs from the live observation or fixed contract")
	}
	casHashes := map[string]bool{}
	stages, err := verifyStages(ctx, database, objects, run, casHashes)
	if err != nil {
		return FinalizeResult{}, err
	}
	mcpEvidence, err := verifyMCPEvidence(ctx, database, objects, run.ID, casHashes)
	if err != nil {
		return FinalizeResult{}, err
	}
	solver, err := verifySolver(ctx, database, objects, run.ID, casHashes)
	if err != nil {
		return FinalizeResult{}, err
	}
	if err := verifyLiveSolverStageContract(stages, solver); err != nil {
		return FinalizeResult{}, err
	}
	graph, err := verifyGraphAndCuration(ctx, database, objects, run, observation, casHashes)
	if err != nil {
		return FinalizeResult{}, err
	}
	orderedHashes := make([]string, 0, len(casHashes))
	for hash := range casHashes {
		orderedHashes = append(orderedHashes, hash)
	}
	sort.Strings(orderedHashes)
	encodedHashes, _ := json.Marshal(orderedHashes)
	casSetDigest := sha256.Sum256(encodedHashes)
	now := time.Now().UTC()
	details := livee2econtract.Details{
		Schema: livee2econtract.DetailsSchemaV2, Binding: observation.Binding,
		LiveJournalSHA256: observation.JournalSHA256, LiveStartedAt: observation.StartedAt,
		LiveFinishedAt: observation.FinishedAt, OfflineVerifiedAt: now,
		Browser: observation.Browser, Run: observation.Run, Stages: stages, MCPEvidence: mcpEvidence,
		Solver: solver, CASObjectsVerified: len(orderedHashes), CASReadbackSetSHA256: hex.EncodeToString(casSetDigest[:]),
		SPARQL: observation.SPARQL, Graph: graph, Curation: observation.Curation,
		EvaluationRequiredCases: evaluation.RequiredCases, EvaluationObservedPasses: evaluation.ObservedPasses,
		FixtureRole: "none", ReleaseGateEligible: true, NoAmbiguousWritesReplayed: true,
	}
	stageRaw, _ := json.Marshal(stages)
	stageDigest := sha256.Sum256(stageRaw)
	mcpRaw, _ := json.Marshal(mcpEvidence)
	mcpDigest := sha256.Sum256(mcpRaw)
	runDigest := sha256.Sum256([]byte("aetherops-live-e2e-run-v2\x00" + run.ID + "\x00" + run.ReportArtifactID))
	browserRaw, _ := json.Marshal(observation.Browser)
	browserDigest := sha256.Sum256(browserRaw)
	curationRaw, _ := json.Marshal(observation.Curation)
	curationDigest := sha256.Sum256(curationRaw)
	result = FinalizeResult{Details: details, SubjectHashes: map[string]string{
		"aetherops.exe": build.ExecutableSHA256, "runtime-manifest.json": build.RuntimeManifestSHA256,
		"knowledge-sidecar-tree":                  build.KnowledgeSidecarTreeSHA256,
		"prepared-ledger":                         observation.Binding.PreparedLedgerSHA256,
		"release-eval-runner-receipt":             observation.Binding.RunnerReceiptSHA256,
		"release-evaluation-details":              observation.Binding.EvaluationSHA256,
		"release-eval-runner-endpoint":            observation.Binding.RunnerEndpointSHA256,
		"live-e2e-observation-endpoint":           observation.Binding.ObservationEndpointSHA256,
		"live-e2e-observation-session-descriptor": observation.Binding.ObservationSessionDescriptorSHA256,
		"live-e2e-journal":                        observation.JournalSHA256,
		"live-e2e-run":                            hex.EncodeToString(runDigest[:]),
		"stage-receipt-set":                       hex.EncodeToString(stageDigest[:]),
		"mcp-evidence-set":                        hex.EncodeToString(mcpDigest[:]),
		"browser-devtools-observation":            hex.EncodeToString(browserDigest[:]),
		"engineering-solver-receipt":              solver.ReceiptBlobSHA256,
		"cas-readback-set":                        details.CASReadbackSetSHA256,
		"sparql-readback":                         observation.SPARQL.ResultSHA256,
		"knowledge-curation-event":                hex.EncodeToString(curationDigest[:]),
	}}
	return result, nil
}

func verifyLiveSolverStageContract(stages []livee2econtract.StageProof, solver livee2econtract.SolverProof) error {
	collectors := make(map[string]livee2econtract.StageProof, core.MaxCollectors+1)
	var verification *livee2econtract.StageProof
	for _, stage := range stages {
		if stage.Stage != string(core.StageCollect) {
			continue
		}
		collectors[stage.StageAttemptID] = stage
		if stage.Ordinal == core.EngineeringVerificationOrdinal {
			copy := stage
			verification = &copy
		}
	}
	solverStage, ok := collectors[solver.StageAttemptID]
	if !ok || !validDigest(solver.PhysicalArgumentsSHA256) {
		return errors.New("end-to-end solver is outside the verified collector set")
	}
	if verification == nil {
		if solverStage.Ordinal >= core.MaxCollectors || solver.ExecutionPurpose == "independent_verification" ||
			solver.VerificationOfJobID != "" || solver.VerificationSourceStageAttemptID != "" ||
			solver.VerificationSourceRuntimeSHA256 != "" || solver.VerificationSourceComponent != "" ||
			solver.VerificationSourceVersion != "" || solver.VerificationSourceSpecSHA256 != "" ||
			solver.VerificationSourcePhysicalSHA256 != "" || solver.VerificationSourceReceiptID != "" ||
			solver.VerificationSourceReceiptSHA256 != "" {
			return errors.New("end-to-end solver claims verification without the reserved collector")
		}
		return nil
	}
	sourceStage, ok := collectors[solver.VerificationSourceStageAttemptID]
	if solver.StageAttemptID != verification.StageAttemptID || solver.ExecutionPurpose != "independent_verification" ||
		solver.VerificationOfJobID == "" || !ok || sourceStage.Ordinal < 0 || sourceStage.Ordinal >= core.MaxCollectors ||
		solver.VerificationSourceStageAttemptID == solver.StageAttemptID ||
		!validDigest(solver.RuntimeBundleSHA256) || !validDigest(solver.VerificationSourceRuntimeSHA256) ||
		solver.VerificationSourceRuntimeSHA256 != solver.RuntimeBundleSHA256 ||
		solver.VerificationSourceComponent != solver.Component || solver.VerificationSourceVersion != solver.Version ||
		!validDigest(solver.VerificationSourceSpecSHA256) ||
		!validDigest(solver.VerificationSourcePhysicalSHA256) ||
		solver.VerificationSourcePhysicalSHA256 == solver.PhysicalArgumentsSHA256 ||
		strings.TrimSpace(solver.VerificationSourceReceiptID) == "" ||
		!validDigest(solver.VerificationSourceReceiptSHA256) {
		return errors.New("end-to-end reserved collector lacks an exact independent recomputation proof")
	}
	return nil
}

func reauthenticateFinalizeInputs(config FinalizeConfig, binding livee2econtract.Binding) (buildinfo.ProductBuildBinding, evalgate.Receipt, error) {
	build, err := AuthenticateCandidate(config.CandidateExecutable)
	if err != nil || build != binding.ProductBuild {
		return buildinfo.ProductBuildBinding{}, evalgate.Receipt{}, errors.New("offline candidate differs from live journal")
	}
	ledger, ledgerSHA, err := releasegate.LoadLedgerChain(config.PreparedLedger)
	if err != nil || ledgerSHA != binding.PreparedLedgerSHA256 || ledger.ProductBuild != build ||
		ledger.ReleaseCandidateID != binding.ReleaseCandidateID || ledger.Revision != binding.PreparedLedgerRevision ||
		!ledger.PreparedAt.Equal(binding.LedgerPreparedAt) || !gateEmpty(ledger, "live_end_to_end") {
		return buildinfo.ProductBuildBinding{}, evalgate.Receipt{}, errors.New("offline prepared ledger differs from live journal")
	}
	dataset, err := evalgate.LoadDataset(config.DatasetPath)
	if err != nil || dataset.SHA256 != binding.DatasetSHA256 {
		return buildinfo.ProductBuildBinding{}, evalgate.Receipt{}, errors.New("evaluation dataset differs from live journal")
	}
	runner, err := evalrunner.LoadReceipt(config.RunnerReceipt, dataset, build)
	if err != nil || runner.SHA256 != binding.RunnerReceiptSHA256 || runner.EvalRunSetID != binding.EvalRunSetID ||
		runner.Target.ProjectID != binding.ProjectID || runner.Target.SessionID != "" ||
		runner.EndpointSHA256 != binding.RunnerEndpointSHA256 {
		return buildinfo.ProductBuildBinding{}, evalgate.Receipt{}, errors.New("runner receipt differs from live journal")
	}
	evaluation, evaluationSHA, err := loadEvaluation(config.EvaluationReceipt)
	if err != nil || evaluationSHA != binding.EvaluationSHA256 || !evaluation.VerifiedAt.Equal(binding.EvaluationVerifiedAt) ||
		validateEvaluation(evaluation, runner, dataset, build) != nil {
		return buildinfo.ProductBuildBinding{}, evalgate.Receipt{}, errors.New("evaluation receipt differs from live journal")
	}
	return build, evaluation, nil
}

func verifyStages(ctx context.Context, database *store.DB, objects *cas.Store, run core.Run, casHashes map[string]bool) ([]livee2econtract.StageProof, error) {
	attempts, err := database.ListStageAttempts(ctx, run.ID)
	if err != nil || len(attempts) < 4 {
		return nil, errors.New("end-to-end run has no complete fixed research stage set")
	}
	counts := map[core.Stage]int{}
	proofs := make([]livee2econtract.StageProof, 0, len(attempts))
	for _, attempt := range attempts {
		if attempt.Status != "completed" || attempt.RunID != run.ID || attempt.CodexThreadID == "" || attempt.CodexTurnID == "" ||
			!validDigest(attempt.InputArtifactHash) || !validDigest(attempt.OutputArtifactHash) {
			return nil, fmt.Errorf("stage %s/%d is incomplete", attempt.Stage, attempt.Ordinal)
		}
		receipt, err := database.StageExecutionReceipt(ctx, attempt.ID)
		if err != nil {
			return nil, err
		}
		model, effort, tier, err := expectedStageProfile(attempt.Stage)
		if err != nil || receipt.StageAttemptID != attempt.ID || receipt.RunID != run.ID ||
			receipt.ResearchProfileVersion != run.ResearchProfileVersion || receipt.Model != model ||
			receipt.ReasoningEffort != effort || receipt.ServiceTier != tier || receipt.CodexThreadID != attempt.CodexThreadID ||
			receipt.CodexTurnID != attempt.CodexTurnID || receipt.InputSHA256 != attempt.InputArtifactHash ||
			receipt.OutputSHA256 != attempt.OutputArtifactHash || receipt.ExecutionContractSHA256 != core.StageExecutionContractSHA256 ||
			receipt.ProductBuild != run.ProductBuild || receipt.CompletedAt.Before(attempt.CreatedAt) {
			return nil, fmt.Errorf("stage %s/%d execution receipt is not the fixed live model contract", attempt.Stage, attempt.Ordinal)
		}
		for _, hash := range []string{attempt.InputArtifactHash, attempt.OutputArtifactHash} {
			if _, err := objects.ReadVerified(hash); err != nil {
				return nil, fmt.Errorf("read stage CAS %s: %w", hash, err)
			}
			casHashes[hash] = true
		}
		workstreamID := ""
		if attempt.Stage == core.StageCollect {
			raw, err := objects.ReadVerified(attempt.OutputArtifactHash)
			if err != nil {
				return nil, fmt.Errorf("read collector output CAS: %w", err)
			}
			var bundle core.EvidenceBundle
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&bundle); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
				return nil, fmt.Errorf("collector %d output is not one strict evidence bundle", attempt.Ordinal)
			}
			if bundle.Claims == nil || bundle.Sources == nil || bundle.Limitations == nil {
				return nil, fmt.Errorf("collector %d omits a required evidence array", attempt.Ordinal)
			}
			if err := bundle.Validate(""); err != nil {
				return nil, fmt.Errorf("validate collector %d output: %w", attempt.Ordinal, err)
			}
			if err := database.VerifyEvidenceSourcesForAttempt(ctx, run.ID, attempt.ID, bundle.Sources); err != nil {
				return nil, fmt.Errorf("verify collector %d provenance: %w", attempt.Ordinal, err)
			}
			for _, source := range bundle.Sources {
				data, err := objects.ReadVerified(source.BlobHash)
				if err != nil {
					return nil, fmt.Errorf("verify collector %d cited CAS: %w", attempt.Ordinal, err)
				}
				if err := core.ValidateEvidenceSourceContent(source, data); err != nil {
					return nil, fmt.Errorf("verify collector %d cited content: %w", attempt.Ordinal, err)
				}
				casHashes[source.BlobHash] = true
			}
			workstreamID = bundle.WorkstreamID
		}
		counts[attempt.Stage]++
		proofs = append(proofs, livee2econtract.StageProof{StageAttemptID: attempt.ID, Stage: string(attempt.Stage), Ordinal: attempt.Ordinal,
			WorkstreamID: workstreamID,
			Model:        receipt.Model, ReasoningEffort: receipt.ReasoningEffort, ServiceTier: receipt.ServiceTier,
			CodexThreadID: receipt.CodexThreadID, CodexTurnID: receipt.CodexTurnID,
			InputSHA256: receipt.InputSHA256, OutputSHA256: receipt.OutputSHA256,
			ExecutionContractSHA256: receipt.ExecutionContractSHA256, CompletedAt: receipt.CompletedAt})
	}
	if counts[core.StagePlan] != 1 || counts[core.StageCollect] < 1 || counts[core.StageCollect] > core.MaxCollectors+1 ||
		counts[core.StageSynthesize] != 1 || counts[core.StageReview] < 1 || counts[core.StageReview] > core.MaxRevisions+1 ||
		counts[core.StageRevise] > core.MaxRevisions {
		return nil, errors.New("end-to-end run stage cardinality is outside the fixed state machine")
	}
	if err := validateLiveCollectorProofs(proofs); err != nil {
		return nil, err
	}
	return proofs, nil
}

func validateLiveCollectorProofs(proofs []livee2econtract.StageProof) error {
	regularCollectors, verificationCollectors := 0, 0
	regularOrdinals := make(map[int]bool, core.MaxCollectors)
	for _, proof := range proofs {
		if proof.Stage != string(core.StageCollect) {
			continue
		}
		if proof.Ordinal == core.EngineeringVerificationOrdinal {
			verificationCollectors++
			if proof.WorkstreamID != "aetherops_engineering_verification" {
				return errors.New("reserved verification collector has the wrong evidence workstream")
			}
			continue
		}
		if proof.Ordinal < 0 || proof.Ordinal >= core.MaxCollectors || proof.WorkstreamID == "" ||
			proof.WorkstreamID == "aetherops_engineering_verification" || regularOrdinals[proof.Ordinal] {
			return errors.New("regular collector has an invalid, duplicate, or reserved ordinal/workstream")
		}
		regularCollectors++
		regularOrdinals[proof.Ordinal] = true
	}
	if regularCollectors < 1 || regularCollectors > core.MaxCollectors || verificationCollectors > 1 {
		return errors.New("end-to-end collector set violates the reserved verification contract")
	}
	for ordinal := 0; ordinal < regularCollectors; ordinal++ {
		if !regularOrdinals[ordinal] {
			return errors.New("end-to-end regular collector ordinals are not contiguous")
		}
	}
	return nil
}

func expectedStageProfile(stage core.Stage) (string, string, string, error) {
	switch stage {
	case core.StagePlan, core.StageSynthesize, core.StageRevise:
		return core.PlannerModel, core.PlannerEffort, core.ServiceTierDefault, nil
	case core.StageCollect:
		return core.CollectorModel, core.CollectorEffort, core.ServiceTierDefault, nil
	case core.StageReview:
		return core.ReviewerModel, core.ReviewerEffort, core.ServiceTierDefault, nil
	default:
		return "", "", "", fmt.Errorf("unsupported stage %q", stage)
	}
}

func verifyMCPEvidence(ctx context.Context, database *store.DB, objects *cas.Store, runID string, casHashes map[string]bool) ([]livee2econtract.MCPEvidenceProof, error) {
	rows, err := database.SQL().QueryContext(ctx, `
SELECT e.id,e.stage_attempt_id,e.blob_hash,b.size,e.captured_at,
 EXISTS(SELECT 1 FROM run_events re WHERE re.run_id=e.run_id AND re.kind='evidence.captured'
   AND json_extract(re.payload_json,'$.evidence_id')=e.id AND json_extract(re.payload_json,'$.attempt_id')=e.stage_attempt_id
   AND json_extract(re.payload_json,'$.blob_hash')=e.blob_hash AND json_extract(re.payload_json,'$.origin')='internal_mcp')
FROM evidence e JOIN blobs b ON b.hash=e.blob_hash
JOIN stage_attempts s ON s.id=e.stage_attempt_id AND s.run_id=e.run_id AND s.stage='collect'
WHERE e.run_id=? ORDER BY e.id`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	proofs := []livee2econtract.MCPEvidenceProof{}
	for rows.Next() {
		var proof livee2econtract.MCPEvidenceProof
		var captured string
		if err := rows.Scan(&proof.EvidenceID, &proof.StageAttemptID, &proof.BlobSHA256, &proof.Size, &captured, &proof.InternalMCP); err != nil {
			return nil, err
		}
		proof.CapturedAt, err = time.Parse(time.RFC3339Nano, captured)
		if err != nil || !proof.InternalMCP || !validDigest(proof.BlobSHA256) || proof.Size < 1 {
			return nil, errors.New("captured evidence lacks atomic internal MCP provenance")
		}
		data, err := objects.ReadVerified(proof.BlobSHA256)
		if err != nil || int64(len(data)) != proof.Size {
			return nil, errors.New("internal MCP evidence CAS readback failed")
		}
		casHashes[proof.BlobSHA256] = true
		proofs = append(proofs, proof)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(proofs) == 0 {
		return nil, errors.New("end-to-end run contains no evidence_capture committed by the internal MCP server")
	}
	return proofs, nil
}

type verifiedLiveXFOIL struct {
	proof             livee2econtract.SolverProof
	stageOrdinal      int
	runtimeBundleHash string
	spec              engineering.XFOILSpec
}

func verifySolver(ctx context.Context, database *store.DB, objects *cas.Store, runID string, casHashes map[string]bool) (livee2econtract.SolverProof, error) {
	optimization, err := evalgate.VerifyXFOILOptimization(ctx, database, objects, runID)
	if err != nil {
		return livee2econtract.SolverProof{}, fmt.Errorf("independently verify XFOIL optimization: %w", err)
	}
	results, err := database.ListRunEngineeringResults(ctx, runID)
	if err != nil {
		return livee2econtract.SolverProof{}, err
	}
	verified := make([]verifiedLiveXFOIL, 0, len(results))
	for index := range results {
		if results[index].Job.Operation != "xfoil_polar" {
			continue
		}
		candidate, err := verifyLiveXFOILJob(ctx, database, objects, runID, results[index], casHashes)
		if err != nil {
			return livee2econtract.SolverProof{}, err
		}
		verified = append(verified, candidate)
	}
	if len(verified) == 0 {
		return livee2econtract.SolverProof{}, errors.New("end-to-end run has no successful pinned XFOIL solver receipt")
	}
	if len(verified) == 1 {
		candidate := verified[0]
		if optimization.Required || candidate.stageOrdinal < 0 || candidate.stageOrdinal >= core.MaxCollectors ||
			candidate.proof.ExecutionPurpose == "independent_verification" ||
			candidate.proof.VerificationOfJobID != "" {
			return livee2econtract.SolverProof{}, errors.New("single end-to-end XFOIL job falsely claims independent verification")
		}
		return candidate.proof, nil
	}

	screening := make(map[string]verifiedLiveXFOIL)
	verification := make([]verifiedLiveXFOIL, 0, 1)
	for _, candidate := range verified {
		switch candidate.proof.ExecutionPurpose {
		case "screening":
			if candidate.stageOrdinal < 0 || candidate.stageOrdinal >= core.MaxCollectors || candidate.proof.VerificationOfJobID != "" {
				return livee2econtract.SolverProof{}, errors.New("live XFOIL screening job is outside a regular collector")
			}
			screening[candidate.proof.JobID] = candidate
		case "independent_verification":
			if candidate.stageOrdinal != core.EngineeringVerificationOrdinal || candidate.proof.VerificationOfJobID == "" {
				return livee2econtract.SolverProof{}, errors.New("live XFOIL verification job is outside the reserved collector")
			}
			verification = append(verification, candidate)
		default:
			return livee2econtract.SolverProof{}, errors.New("multiple live XFOIL jobs require explicit screening and verification purposes")
		}
	}
	if len(screening) < 2 || len(verification) != 1 {
		return livee2econtract.SolverProof{}, errors.New("multiple live XFOIL screenings require exactly one independent recomputation")
	}
	selected := verification[0]
	if !optimization.Required || optimization.WinnerJobID != selected.proof.VerificationOfJobID ||
		optimization.VerificationJobID != selected.proof.JobID ||
		optimization.VerificationReceiptArtifactID != selected.proof.ReceiptArtifactID ||
		optimization.WinnerPhysicalArgumentsSHA256 != sourcePhysicalHash(screening, selected.proof.VerificationOfJobID) ||
		optimization.VerificationPhysicalSHA256 != selected.proof.PhysicalArgumentsSHA256 {
		return livee2econtract.SolverProof{}, errors.New("live XFOIL proof differs from independently recomputed optimization winner")
	}
	source, ok := screening[selected.proof.VerificationOfJobID]
	if !ok || source.proof.StageAttemptID == selected.proof.StageAttemptID ||
		source.proof.Component != selected.proof.Component || source.proof.Version != selected.proof.Version ||
		source.runtimeBundleHash != selected.runtimeBundleHash {
		return livee2econtract.SolverProof{}, errors.New("live XFOIL verification does not match a succeeded screening receipt")
	}
	if err := engineering.ValidateIndependentXFOILContract(source.spec, selected.spec, optimization.WinnerTarget.AlphaDeg); err != nil {
		return livee2econtract.SolverProof{}, fmt.Errorf("live XFOIL independent resolution contract: %w", err)
	}
	selected.proof.VerificationSourceStageAttemptID = source.proof.StageAttemptID
	selected.proof.VerificationSourceRuntimeSHA256 = source.runtimeBundleHash
	selected.proof.VerificationSourceComponent = source.proof.Component
	selected.proof.VerificationSourceVersion = source.proof.Version
	selected.proof.VerificationSourceSpecSHA256 = source.proof.SpecSHA256
	selected.proof.VerificationSourcePhysicalSHA256 = source.proof.PhysicalArgumentsSHA256
	selected.proof.VerificationSourceReceiptID = source.proof.ReceiptArtifactID
	selected.proof.VerificationSourceReceiptSHA256 = source.proof.ReceiptBlobSHA256
	return selected.proof, nil
}

func verifyLiveXFOILJob(
	ctx context.Context,
	database *store.DB,
	objects *cas.Store,
	runID string,
	selected store.EngineeringResult,
	casHashes map[string]bool,
) (verifiedLiveXFOIL, error) {
	if selected.Job.Status != "succeeded" || selected.Job.ToolComponent != "xfoil" ||
		selected.Job.ToolVersion != managedruntime.PinnedXFOILVersion || selected.Job.CompletedAt == nil ||
		selected.Job.ReceiptArtifactID == "" {
		return verifiedLiveXFOIL{}, errors.New("end-to-end XFOIL job is not a successful pinned solver receipt")
	}
	var stage string
	var stageOrdinal int
	if err := database.SQL().QueryRowContext(ctx,
		"SELECT stage,logical_ordinal FROM stage_attempts WHERE id=? AND run_id=?",
		selected.Job.StageAttemptID, runID,
	).Scan(&stage, &stageOrdinal); err != nil || stage != string(core.StageCollect) {
		return verifiedLiveXFOIL{}, errors.New("end-to-end XFOIL job is outside a collect attempt")
	}
	var receiptLink store.EngineeringJobArtifact
	artifactHashes := make([]string, 0, len(selected.Artifacts))
	for _, artifact := range selected.Artifacts {
		data, err := objects.ReadVerified(artifact.BlobHash)
		if err != nil || len(data) == 0 {
			return verifiedLiveXFOIL{}, errors.New("engineering artifact CAS readback failed")
		}
		casHashes[artifact.BlobHash] = true
		artifactHashes = append(artifactHashes, artifact.BlobHash)
		if artifact.ArtifactID == selected.Job.ReceiptArtifactID && artifact.Role == "receipt" {
			receiptLink = artifact
		}
	}
	if receiptLink.ArtifactID == "" {
		return verifiedLiveXFOIL{}, errors.New("engineering job receipt artifact is missing")
	}
	receiptBytes, err := objects.ReadVerified(receiptLink.BlobHash)
	if err != nil {
		return verifiedLiveXFOIL{}, err
	}
	var receipt engineeringExecutionReceipt
	if err := json.Unmarshal(receiptBytes, &receipt); err != nil || receipt.Schema != 1 || receipt.JobID != selected.Job.ID ||
		receipt.RunID != runID || receipt.StageAttemptID != selected.Job.StageAttemptID || receipt.Operation != "xfoil_polar" ||
		receipt.SpecSHA256 != selected.Job.SpecSHA256 || string(receipt.Spec) != selected.Job.SpecJSON ||
		!receipt.Executed || !receipt.NumericallyValid || receipt.Threads < 1 ||
		receipt.CompletedAt.Before(receipt.StartedAt) || len(receipt.Executables) != 1 ||
		receipt.Executables[0].Component != "xfoil" || receipt.Executables[0].Version != managedruntime.PinnedXFOILVersion ||
		!validDigest(receipt.Executables[0].SHA256) || len(receipt.ExitCodes) != 1 || receipt.ExitCodes[0] != 0 {
		return verifiedLiveXFOIL{}, errors.New("XFOIL execution receipt is not an actual successful pinned solver run")
	}
	specDigest := sha256.Sum256(receipt.Spec)
	if hex.EncodeToString(specDigest[:]) != receipt.SpecSHA256 {
		return verifiedLiveXFOIL{}, errors.New("XFOIL normalized specification hash is invalid")
	}
	var spec struct {
		Arguments engineering.XFOILSpec `json:"arguments"`
		Operation string                `json:"operation"`
		Runtime   string                `json:"runtime_bundle_hash"`
		Component string                `json:"tool_component"`
		Version   string                `json:"tool_version"`
	}
	if err := json.Unmarshal(receipt.Spec, &spec); err != nil || spec.Operation != "xfoil_polar" ||
		spec.Component != "xfoil" || spec.Version != managedruntime.PinnedXFOILVersion ||
		!validDigest(spec.Runtime) ||
		spec.Arguments.RunID != runID || spec.Arguments.StageAttemptID != selected.Job.StageAttemptID {
		return verifiedLiveXFOIL{}, errors.New("XFOIL receipt does not match the fixed end-to-end solver specification")
	}
	if spec.Arguments.ExecutionPurpose == "" &&
		(spec.Arguments.NACA != "0012" || spec.Arguments.Reynolds != 1000000 || spec.Arguments.Mach != .10 ||
			spec.Arguments.AlphaStartDeg != -2 || spec.Arguments.AlphaEndDeg != 4 || spec.Arguments.AlphaStepDeg != 2) {
		return verifiedLiveXFOIL{}, errors.New("legacy XFOIL receipt does not match the fixed end-to-end solver specification")
	}
	var envelope struct {
		Arguments map[string]json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(receipt.Spec, &envelope); err != nil || envelope.Arguments == nil {
		return verifiedLiveXFOIL{}, errors.New("XFOIL receipt has no normalized physical arguments")
	}
	for _, dynamic := range []string{"run_id", "stage_attempt_id", "execution_purpose", "verification_of_job_id"} {
		delete(envelope.Arguments, dynamic)
	}
	physical, err := json.Marshal(envelope.Arguments)
	if err != nil {
		return verifiedLiveXFOIL{}, err
	}
	physicalDigest := sha256.Sum256(physical)
	sort.Strings(artifactHashes)
	artifactRaw, _ := json.Marshal(artifactHashes)
	artifactDigest := sha256.Sum256(artifactRaw)
	proof := livee2econtract.SolverProof{
		JobID: selected.Job.ID, StageAttemptID: selected.Job.StageAttemptID,
		Operation: selected.Job.Operation, Component: selected.Job.ToolComponent, Version: selected.Job.ToolVersion,
		SpecSHA256: selected.Job.SpecSHA256, RuntimeBundleSHA256: spec.Runtime,
		PhysicalArgumentsSHA256: hex.EncodeToString(physicalDigest[:]),
		ExecutionPurpose:        spec.Arguments.ExecutionPurpose,
		VerificationOfJobID:     spec.Arguments.VerificationOfJobID,
		ReceiptArtifactID:       selected.Job.ReceiptArtifactID, ReceiptBlobSHA256: receiptLink.BlobHash,
		ArtifactSetSHA256: hex.EncodeToString(artifactDigest[:]), Threads: receipt.Threads,
		Executed: true, NumericallyValid: true, CompletedAt: *selected.Job.CompletedAt,
	}
	return verifiedLiveXFOIL{
		proof: proof, stageOrdinal: stageOrdinal, runtimeBundleHash: spec.Runtime,
		spec: spec.Arguments,
	}, nil
}

func sourcePhysicalHash(screening map[string]verifiedLiveXFOIL, jobID string) string {
	if source, ok := screening[jobID]; ok {
		return source.proof.PhysicalArgumentsSHA256
	}
	return ""
}

func verifyGraphAndCuration(ctx context.Context, database *store.DB, objects *cas.Store, run core.Run, observation LiveObservation, casHashes map[string]bool) (livee2econtract.GraphProof, error) {
	applied, err := database.AppliedKnowledgeForRun(ctx, run.ProjectID, run.ID)
	if err != nil || applied.GenerationID != observation.SPARQL.GenerationID || !applied.Active {
		return livee2econtract.GraphProof{}, errors.New("successful run was not deterministically materialized into the live SPARQL generation")
	}
	if err := database.VerifyKnowledgeSnapshot(ctx, run.ProjectID, applied.GenerationID, objects); err != nil {
		return livee2econtract.GraphProof{}, err
	}
	snapshot, err := database.KnowledgeSnapshotReceipt(ctx, run.ProjectID, applied.GenerationID)
	if err != nil || snapshot.TripleCount < 1 {
		return livee2econtract.GraphProof{}, errors.New("live SPARQL generation has no verified RDF snapshot")
	}
	if _, err := objects.ReadVerified(snapshot.BlobHash); err != nil {
		return livee2econtract.GraphProof{}, err
	}
	casHashes[snapshot.BlobHash] = true
	var event store.KnowledgeCurationEvent
	var created string
	err = database.SQL().QueryRowContext(ctx, `
SELECT sequence,id,project_id,generation_id,kind,actor,payload_json,payload_sha256,previous_event_sha256,event_sha256,created_at
FROM knowledge_curation_events WHERE project_id=? AND generation_id=? AND id=?`,
		run.ProjectID, applied.GenerationID, observation.Curation.EventID).Scan(
		&event.Sequence, &event.ID, &event.ProjectID, &event.GenerationID, &event.Kind, &event.Actor,
		&event.Payload, &event.PayloadSHA256, &event.PreviousEventSHA256, &event.EventSHA256, &created)
	if err != nil {
		return livee2econtract.GraphProof{}, err
	}
	event.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
	if err != nil || event.Sequence != observation.Curation.Sequence || event.Kind != "pin_entity" || event.Actor != "user" ||
		event.PayloadSHA256 != observation.Curation.PayloadSHA256 || event.EventSHA256 != observation.Curation.EventSHA256 {
		return livee2econtract.GraphProof{}, errors.New("durable Knowledge editor curation differs from live API readback")
	}
	var payload struct {
		EntityID       string `json:"entity_id"`
		MemoBlobHash   string `json:"memo_blob_hash"`
		MemoDocumentID string `json:"memo_document_id"`
		MemoStartByte  int    `json:"memo_start_byte"`
		MemoEndByte    int    `json:"memo_end_byte"`
		MemoSpanSHA256 string `json:"memo_span_sha256"`
	}
	if err := json.Unmarshal(event.Payload, &payload); err != nil || payload.EntityID != observation.Curation.EntityID ||
		payload.MemoBlobHash != observation.Curation.MemoBlobSHA256 || payload.MemoDocumentID == "" ||
		payload.MemoStartByte != 0 || payload.MemoEndByte <= 0 || !validDigest(payload.MemoSpanSHA256) {
		return livee2econtract.GraphProof{}, errors.New("safe pin event lacks server-verified CAS memo evidence")
	}
	memo, err := objects.ReadVerified(payload.MemoBlobHash)
	if err != nil || len(memo) != payload.MemoEndByte {
		return livee2econtract.GraphProof{}, errors.New("curation memo CAS readback failed")
	}
	spanDigest := sha256.Sum256(memo)
	if hex.EncodeToString(spanDigest[:]) != payload.MemoSpanSHA256 {
		return livee2econtract.GraphProof{}, errors.New("curation memo span hash differs")
	}
	casHashes[payload.MemoBlobHash] = true
	var entityCount int
	if err := database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_entities WHERE project_id=? AND generation_id=? AND id=?`,
		run.ProjectID, applied.GenerationID, payload.EntityID).Scan(&entityCount); err != nil || entityCount != 1 {
		return livee2econtract.GraphProof{}, errors.New("safe pin event targets no unique project-scoped entity")
	}
	queryDigest := sha256.Sum256([]byte(SPARQLQuery))
	if observation.SPARQL.QuerySHA256 != hex.EncodeToString(queryDigest[:]) || observation.SPARQL.ResultSHA256 == "" {
		return livee2econtract.GraphProof{}, errors.New("live SPARQL result is not the fixed project-scoped query readback")
	}
	return livee2econtract.GraphProof{GenerationID: applied.GenerationID, SnapshotSHA256: snapshot.BlobHash,
		CanonicalSHA256: snapshot.DatasetSHA256, TripleCount: snapshot.TripleCount,
		SPARQLResultSHA256: observation.SPARQL.ResultSHA256}, nil
}

func BuildReceipt(result FinalizeResult, build buildinfo.ProductBuildBinding, detailsPath, detailsSHA256 string) (releasegate.EvidenceReceipt, error) {
	if !validDigest(detailsSHA256) || !strings.HasSuffix(strings.ToLower(filepath.Base(detailsPath)), ".details.json") {
		return releasegate.EvidenceReceipt{}, errors.New("details path or SHA-256 is invalid")
	}
	subjects := make(map[string]string, len(result.SubjectHashes)+1)
	for name, hash := range result.SubjectHashes {
		if strings.TrimSpace(name) == "" || !validDigest(hash) {
			return releasegate.EvidenceReceipt{}, errors.New("live end-to-end subject is invalid")
		}
		subjects[name] = hash
	}
	subjects["live-end-to-end-details"] = detailsSHA256
	names := make([]string, 0, len(subjects))
	for name := range subjects {
		names = append(names, name)
	}
	sort.Strings(names)
	list := make([]releasegate.SubjectHash, 0, len(names))
	for _, name := range names {
		list = append(list, releasegate.SubjectHash{Name: name, SHA256: subjects[name]})
	}
	environmentDigest := sha256.Sum256([]byte("aetherops-live-e2e-environment-v2\x00" + result.Details.Binding.ObservationEndpointSHA256 + "\x00" + result.Details.Binding.ProjectID + "\x00" + result.Details.Binding.ObservationSessionDescriptorSHA256))
	receipt := releasegate.EvidenceReceipt{
		Schema: releasegate.EvidenceSchemaV1, GateID: "live_end_to_end", EvidenceKind: releasegate.EvidenceLiveService,
		ReleaseCandidateID: result.Details.Binding.ReleaseCandidateID, ProductBuild: build,
		Producer:    releasegate.Producer{Name: livee2econtract.ProducerName, Version: livee2econtract.ProducerVersion},
		Environment: releasegate.Environment{Class: string(releasegate.EvidenceLiveService), OS: "windows-11", Architecture: "amd64", IdentitySHA256: hex.EncodeToString(environmentDigest[:])},
		ObservedAt:  result.Details.OfflineVerifiedAt, Status: "passed", SubjectHashes: list,
		DetailsPath: filepath.Base(detailsPath), DetailsSHA256: detailsSHA256,
	}
	return receipt, nil
}

func ReauthenticateFinalized(config FinalizeConfig, result FinalizeResult, build buildinfo.ProductBuildBinding) error {
	journal, err := LoadCompletedJournal(config.JournalPath)
	if err != nil || journal.JournalSHA256 != result.Details.LiveJournalSHA256 || build != result.Details.Binding.ProductBuild {
		return errors.New("live journal or product build changed after offline verification")
	}
	actual, _, err := reauthenticateFinalizeInputs(config, result.Details.Binding)
	if err != nil || actual != build {
		return errors.New("release evidence inputs changed before receipt publication")
	}
	return nil
}
