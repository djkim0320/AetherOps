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
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/knowledge"
	"github.com/djkim0320/AetherOps/internal/rag"
	"github.com/djkim0320/AetherOps/internal/research"
	"github.com/djkim0320/AetherOps/internal/store"
)

const ReceiptSchemaV3 = "aetherops_release_evaluation_v3"

const engineeringVerificationWorkstreamID = "aetherops_engineering_verification"

type RunMapping struct {
	CaseID string `json:"case_id"`
	RunID  string `json:"run_id"`
}

type CaseResult struct {
	CaseID                            string            `json:"case_id"`
	RunID                             string            `json:"run_id"`
	Status                            core.RunStatus    `json:"status"`
	ResearchProfileVersion            string            `json:"research_profile_version"`
	RetrievalProfile                  string            `json:"retrieval_profile"`
	KnowledgeGenerationID             string            `json:"knowledge_generation_id"`
	MaterializedGenerationID          string            `json:"materialized_generation_id,omitempty"`
	ReportSHA256                      string            `json:"report_sha256,omitempty"`
	ReviewSHA256                      string            `json:"review_sha256,omitempty"`
	CitationIntegrityPercent          int               `json:"citation_integrity_percent"`
	KnowledgeEvidenceIntegrityPercent int               `json:"knowledge_evidence_integrity_percent"`
	UnsupportedAssertions             int               `json:"unsupported_assertions"`
	CriticalErrorCount                int               `json:"critical_error_count"`
	Scores                            core.ReviewScores `json:"scores"`
	AverageScore                      float64           `json:"average_score"`
	Passed                            bool              `json:"passed"`
	Failure                           string            `json:"failure,omitempty"`
}

type Receipt struct {
	Schema                  string              `json:"schema"`
	ExecutionSource         string              `json:"execution_source,omitempty"`
	EvalRunSetID            string              `json:"eval_run_set_id,omitempty"`
	RunnerReceiptSHA256     string              `json:"runner_receipt_sha256,omitempty"`
	DatasetName             string              `json:"dataset_name"`
	DatasetSHA256           string              `json:"dataset_sha256"`
	ExecutionManifestSHA256 string              `json:"execution_manifest_sha256,omitempty"`
	ProductBuild            ProductBuildBinding `json:"product_build"`
	RequiredCases           int                 `json:"required_cases"`
	RequiredPasses          int                 `json:"required_passes"`
	ObservedPasses          int                 `json:"observed_passes"`
	Passed                  bool                `json:"passed"`
	VerifiedAt              time.Time           `json:"verified_at"`
	Results                 []CaseResult        `json:"results"`
}

type Verifier struct {
	DB       *store.DB
	CAS      *cas.Store
	Oxigraph interface {
		LoadSnapshot(context.Context, string, string, []byte, string, int) error
	}
	Now func() time.Time
}

func (verifier Verifier) Verify(ctx context.Context, dataset Dataset, mappings []RunMapping) (Receipt, error) {
	if verifier.DB == nil || verifier.CAS == nil {
		return Receipt{}, errors.New("release evaluator requires the product SQLite store and CAS")
	}
	if err := dataset.Validate(); err != nil {
		return Receipt{}, err
	}
	if len(mappings) != len(dataset.Cases) {
		return Receipt{}, fmt.Errorf("release evaluation requires %d run mappings, got %d", len(dataset.Cases), len(mappings))
	}
	byCase := make(map[string]string, len(mappings))
	runIDs := make(map[string]struct{}, len(mappings))
	for _, mapping := range mappings {
		if strings.TrimSpace(mapping.CaseID) == "" || strings.TrimSpace(mapping.RunID) == "" {
			return Receipt{}, errors.New("release evaluation mappings require case and run ids")
		}
		if _, duplicate := byCase[mapping.CaseID]; duplicate {
			return Receipt{}, fmt.Errorf("release evaluation case %q is mapped more than once", mapping.CaseID)
		}
		if _, duplicate := runIDs[mapping.RunID]; duplicate {
			return Receipt{}, fmt.Errorf("release evaluation run %q is reused by multiple cases", mapping.RunID)
		}
		byCase[mapping.CaseID] = mapping.RunID
		runIDs[mapping.RunID] = struct{}{}
	}

	receipt := Receipt{
		Schema: ReceiptSchemaV3, DatasetName: dataset.Name, DatasetSHA256: dataset.SHA256,
		RequiredCases: dataset.ReleaseGate.RequiredCases, RequiredPasses: dataset.ReleaseGate.RequiredPasses,
		Results: make([]CaseResult, 0, len(dataset.Cases)),
	}
	for _, item := range dataset.Cases {
		runID, exists := byCase[item.ID]
		if !exists {
			return Receipt{}, fmt.Errorf("evaluation case %q has no run mapping", item.ID)
		}
		result := verifier.verifyCase(ctx, item, runID)
		receipt.Results = append(receipt.Results, result)
		if result.Passed {
			receipt.ObservedPasses++
		}
	}
	now := time.Now().UTC()
	if verifier.Now != nil {
		now = verifier.Now().UTC()
	}
	receipt.VerifiedAt = now
	receipt.Passed = len(receipt.Results) == receipt.RequiredCases && receipt.ObservedPasses == receipt.RequiredPasses
	return receipt, nil
}

func (verifier Verifier) VerifyExecution(
	ctx context.Context,
	dataset Dataset,
	manifest ExecutionManifest,
) (Receipt, error) {
	if verifier.Oxigraph == nil {
		return Receipt{}, errors.New("release execution verification requires the real Oxigraph sidecar")
	}
	if err := manifest.Validate(dataset, true); err != nil {
		return Receipt{}, err
	}
	manifestDigest, digestErr := hex.DecodeString(manifest.SHA256)
	if digestErr != nil || len(manifestDigest) != sha256.Size {
		return Receipt{}, errors.New("release execution manifest has no source file SHA-256")
	}
	for _, mapping := range manifest.Mappings() {
		run, err := verifier.DB.Run(ctx, mapping.RunID)
		if err != nil {
			return Receipt{}, fmt.Errorf("load execution run %s: %w", mapping.RunID, err)
		}
		if run.CreatedAt.Before(manifest.PreparedAt) {
			return Receipt{}, fmt.Errorf("evaluation run %s predates its execution manifest", mapping.RunID)
		}
		if run.ProductBuild != manifest.ProductBuild {
			return Receipt{}, fmt.Errorf("evaluation run %s was created by a different product build", mapping.RunID)
		}
	}
	receipt, err := verifier.Verify(ctx, dataset, manifest.Mappings())
	if err != nil {
		return Receipt{}, err
	}
	receipt.ExecutionManifestSHA256 = manifest.SHA256
	receipt.ProductBuild = manifest.ProductBuild
	return receipt, nil
}

func (verifier Verifier) verifyCase(ctx context.Context, item Case, runID string) CaseResult {
	return verifier.verifyRun(ctx, item.ID, item.Prompt(), item.Mode, runID, true)
}

func (verifier Verifier) verifyRun(
	ctx context.Context,
	caseID, expectedQuestion, expectedMode, runID string,
	requireOxigraph bool,
) (result CaseResult) {
	result.CaseID, result.RunID = caseID, runID
	fail := func(format string, arguments ...any) CaseResult {
		result.Passed = false
		result.Failure = fmt.Sprintf(format, arguments...)
		return result
	}
	run, err := verifier.DB.Run(ctx, runID)
	if err != nil {
		return fail("load run: %v", err)
	}
	result.Status = run.Status
	result.ResearchProfileVersion = run.ResearchProfileVersion
	result.RetrievalProfile = run.RetrievalProfile
	result.KnowledgeGenerationID = run.KnowledgeGenerationID
	if run.Question != expectedQuestion {
		return fail("run question does not match the versioned evaluation prompt")
	}
	if run.Status != core.RunSucceeded {
		return fail("run status is %s, want succeeded", run.Status)
	}
	if run.ResearchProfileVersion != core.CurrentResearchProfileVersion {
		return fail("research profile is %q, want %q", run.ResearchProfileVersion, core.CurrentResearchProfileVersion)
	}
	if run.RetrievalProfile != store.DefaultRetrievalProfile || strings.TrimSpace(run.KnowledgeGenerationID) == "" {
		return fail("run did not use a pinned %s knowledge generation", store.DefaultRetrievalProfile)
	}
	pinnedGeneration, err := verifier.DB.KnowledgeGeneration(ctx, run.ProjectID, run.KnowledgeGenerationID)
	if err != nil {
		return fail("load run-pinned knowledge generation: %v", err)
	}
	if pinnedGeneration.State != store.KnowledgeReady && pinnedGeneration.State != store.KnowledgeRetired {
		return fail("run-pinned knowledge generation is %s", pinnedGeneration.State)
	}
	if err := verifier.DB.VerifyKnowledgeSnapshot(ctx, run.ProjectID, run.KnowledgeGenerationID, verifier.CAS); err != nil {
		return fail("verify run-pinned knowledge snapshot: %v", err)
	}

	attempts, err := verifier.DB.ListStageAttempts(ctx, runID)
	if err != nil {
		return fail("load stage attempts: %v", err)
	}
	artifacts, err := verifier.DB.ListArtifacts(ctx, runID)
	if err != nil {
		return fail("load run artifacts: %v", err)
	}
	for _, artifact := range artifacts {
		if _, err := verifier.DB.BlobMetadata(ctx, artifact.BlobHash); err != nil {
			return fail("verify run artifact metadata %s: %v", artifact.ID, err)
		}
		if _, err := verifier.CAS.ReadVerified(artifact.BlobHash); err != nil {
			return fail("verify run artifact CAS %s: %v", artifact.ID, err)
		}
	}
	if err := verifyArtifactBindings(run, attempts, artifacts); err != nil {
		return fail("verify durable artifact bindings: %v", err)
	}

	var planAttempt *core.StageAttempt
	collectAttempts := make(map[int]*core.StageAttempt)
	reportAttempts := make(map[int]*core.StageAttempt)
	reviewAttempts := make(map[int]*core.StageAttempt)
	isolatedThreads := make(map[string]core.Stage)
	for index := range attempts {
		attempt := &attempts[index]
		if attempt.Status != "completed" {
			return fail("stage %s/%d is %s", attempt.Stage, attempt.Ordinal, attempt.Status)
		}
		if strings.TrimSpace(attempt.CodexThreadID) == "" || strings.TrimSpace(attempt.CodexTurnID) == "" {
			return fail("stage %s/%d is missing durable Codex thread or turn id", attempt.Stage, attempt.Ordinal)
		}
		execution, err := verifier.DB.StageExecutionReceipt(ctx, attempt.ID)
		if err != nil {
			return fail("load stage %s/%d execution receipt: %v", attempt.Stage, attempt.Ordinal, err)
		}
		expectedModel, expectedEffort, expectedTier, profileErr := expectedStageProfile(attempt.Stage)
		if profileErr != nil {
			return fail("validate stage %s/%d execution profile: %v", attempt.Stage, attempt.Ordinal, profileErr)
		}
		if execution.StageAttemptID != attempt.ID || execution.RunID != run.ID ||
			execution.ResearchProfileVersion != run.ResearchProfileVersion ||
			execution.ProductBuild != run.ProductBuild ||
			execution.Model != expectedModel || execution.ReasoningEffort != expectedEffort || execution.ServiceTier != expectedTier ||
			execution.CodexThreadID != attempt.CodexThreadID || execution.CodexTurnID != attempt.CodexTurnID ||
			execution.InputSHA256 != attempt.InputArtifactHash || execution.OutputSHA256 != attempt.OutputArtifactHash ||
			execution.ExecutionContractSHA256 != core.StageExecutionContractSHA256 || execution.CompletedAt.Before(run.CreatedAt) {
			return fail("stage %s/%d execution receipt does not match the fixed research contract", attempt.Stage, attempt.Ordinal)
		}
		if _, err := verifier.CAS.ReadVerified(attempt.InputArtifactHash); err != nil {
			return fail("verify stage %s/%d input CAS: %v", attempt.Stage, attempt.Ordinal, err)
		}
		switch attempt.Stage {
		case core.StagePlan:
			if attempt.Ordinal != 0 || planAttempt != nil || attempt.CodexThreadID != run.MainThreadID {
				return fail("plan stage is duplicated, misnumbered, or not on the main thread")
			}
			planAttempt = attempt
		case core.StageCollect:
			if attempt.Ordinal < 0 || attempt.Ordinal > core.EngineeringVerificationOrdinal || collectAttempts[attempt.Ordinal] != nil ||
				attempt.CodexThreadID == run.MainThreadID {
				return fail("collector stage %d violates ordinal or isolation rules", attempt.Ordinal)
			}
			if prior, reused := isolatedThreads[attempt.CodexThreadID]; reused {
				return fail("collector thread is reused from %s", prior)
			}
			isolatedThreads[attempt.CodexThreadID] = core.StageCollect
			collectAttempts[attempt.Ordinal] = attempt
		case core.StageSynthesize:
			if attempt.Ordinal != 0 || reportAttempts[0] != nil || attempt.CodexThreadID != run.MainThreadID {
				return fail("synthesis stage is duplicated, misnumbered, or not on the main thread")
			}
			reportAttempts[0] = attempt
		case core.StageRevise:
			if attempt.Ordinal < 1 || attempt.Ordinal > core.MaxRevisions || reportAttempts[attempt.Ordinal] != nil ||
				attempt.CodexThreadID != run.MainThreadID {
				return fail("revision stage %d violates ordinal or main-thread rules", attempt.Ordinal)
			}
			reportAttempts[attempt.Ordinal] = attempt
		case core.StageReview:
			if attempt.Ordinal < 0 || attempt.Ordinal > core.MaxRevisions || reviewAttempts[attempt.Ordinal] != nil ||
				attempt.CodexThreadID == run.MainThreadID {
				return fail("review stage %d violates ordinal or isolation rules", attempt.Ordinal)
			}
			if prior, reused := isolatedThreads[attempt.CodexThreadID]; reused {
				return fail("review thread is reused from %s", prior)
			}
			isolatedThreads[attempt.CodexThreadID] = core.StageReview
			reviewAttempts[attempt.Ordinal] = attempt
		default:
			return fail("unsupported stage %q is present", attempt.Stage)
		}
	}
	if planAttempt == nil {
		return fail("research plan stage is absent")
	}

	var plan core.ResearchPlan
	if err := verifier.readStrict(planAttempt.OutputArtifactHash, &plan); err != nil {
		return fail("verify plan CAS: %v", err)
	}
	if plan.Workstreams == nil || plan.SourceRequirements == nil || plan.AcceptanceCriteria == nil {
		return fail("research plan omits a required array")
	}
	if err := plan.Validate(); err != nil || plan.Question != run.Question || plan.Mode != expectedMode {
		return fail("validate evaluation plan: %v", err)
	}
	regularCollectorCount := len(collectAttempts)
	verificationAttempt := collectAttempts[core.EngineeringVerificationOrdinal]
	if verificationAttempt != nil {
		regularCollectorCount--
	}
	if regularCollectorCount != len(plan.Workstreams) {
		return fail("regular collector count %d does not match %d planned workstreams", regularCollectorCount, len(plan.Workstreams))
	}

	evidence := make([]core.EvidenceBundle, 0, len(plan.Workstreams)+1)
	for ordinal, workstream := range plan.Workstreams {
		attempt := collectAttempts[ordinal]
		if attempt == nil {
			return fail("collector ordinal %d is absent", ordinal)
		}
		var bundle core.EvidenceBundle
		if err := verifier.readStrict(attempt.OutputArtifactHash, &bundle); err != nil {
			return fail("verify collect output %d: %v", ordinal, err)
		}
		if bundle.Claims == nil || bundle.Sources == nil || bundle.Limitations == nil {
			return fail("collector %d omits a required array", ordinal)
		}
		if err := bundle.Validate(workstream.ID); err != nil {
			return fail("validate collector %d: %v", ordinal, err)
		}
		if err := verifier.DB.VerifyEvidenceSourcesForAttempt(ctx, runID, attempt.ID, bundle.Sources); err != nil {
			return fail("verify captured evidence %d: %v", ordinal, err)
		}
		for _, source := range bundle.Sources {
			data, err := verifier.CAS.ReadVerified(source.BlobHash)
			if err != nil {
				return fail("verify cited evidence CAS %s: %v", source.ID, err)
			}
			if err := core.ValidateEvidenceSourceContent(source, data); err != nil {
				return fail("verify cited evidence content %s: %v", source.ID, err)
			}
		}
		evidence = append(evidence, bundle)
	}
	verificationBundle, err := verifier.verifyEngineeringVerification(
		ctx, runID, verificationAttempt, collectAttempts,
	)
	if err != nil {
		return fail("verify independent engineering recomputation: %v", err)
	}
	if verificationBundle != nil {
		evidence = append(evidence, *verificationBundle)
	}

	if len(reportAttempts) != run.RevisionCycle+1 || len(reviewAttempts) != run.RevisionCycle+1 {
		return fail("review cycle contract mismatch: reports=%d reviews=%d cycle=%d", len(reportAttempts), len(reviewAttempts), run.RevisionCycle)
	}
	var report core.ReportManifest
	var verdict core.ReviewVerdict
	var reportAttempt, reviewAttempt *core.StageAttempt
	for cycle := 0; cycle <= run.RevisionCycle; cycle++ {
		reportAttempt = reportAttempts[cycle]
		reviewAttempt = reviewAttempts[cycle]
		if reportAttempt == nil || reviewAttempt == nil {
			return fail("review cycle %d is incomplete", cycle)
		}
		var candidate core.ReportManifest
		if err := verifier.readStrict(reportAttempt.OutputArtifactHash, &candidate); err != nil {
			return fail("verify report cycle %d CAS: %v", cycle, err)
		}
		if err := candidate.Validate(evidence); err != nil {
			return fail("validate report cycle %d: %v", cycle, err)
		}
		if err := verifier.DB.VerifyRunArtifactHashes(ctx, runID, candidate.ArtifactHashes); err != nil {
			return fail("verify report cycle %d artifact ownership: %v", cycle, err)
		}
		for _, hash := range candidate.ArtifactHashes {
			if _, err := verifier.DB.BlobMetadata(ctx, hash); err != nil {
				return fail("verify report artifact metadata %s: %v", hash, err)
			}
			if _, err := verifier.CAS.ReadVerified(hash); err != nil {
				return fail("verify report artifact CAS %s: %v", hash, err)
			}
		}
		if err := research.VerifyKnowledgePatchEvidence(ctx, verifier.DB, verifier.CAS, runID, candidate); err != nil {
			return fail("verify report cycle %d knowledge evidence: %v", cycle, err)
		}
		var candidateVerdict core.ReviewVerdict
		if err := verifier.readStrict(reviewAttempt.OutputArtifactHash, &candidateVerdict); err != nil {
			return fail("verify review cycle %d CAS: %v", cycle, err)
		}
		passes, err := candidateVerdict.PassesForReport(candidate)
		if err != nil {
			return fail("validate review cycle %d: %v", cycle, err)
		}
		if candidateVerdict.KnowledgeIntegrity.UnsupportedAssertions > len(candidate.KnowledgePatch.Assertions) {
			return fail("review cycle %d reports impossible unsupported assertion count", cycle)
		}
		if cycle < run.RevisionCycle && passes {
			return fail("review cycle %d passed but later revisions exist", cycle)
		}
		if cycle == run.RevisionCycle && !passes {
			return fail("final review does not pass the automatic quality gate")
		}
		report, verdict = candidate, candidateVerdict
	}

	result.ReportSHA256 = reportAttempt.OutputArtifactHash
	result.ReviewSHA256 = reviewAttempt.OutputArtifactHash
	result.CitationIntegrityPercent = verdict.CitationIntegrityPercent
	result.KnowledgeEvidenceIntegrityPercent = verdict.KnowledgeIntegrity.EvidenceIntegrityPercent
	result.UnsupportedAssertions = verdict.KnowledgeIntegrity.UnsupportedAssertions
	result.CriticalErrorCount = len(verdict.CriticalErrors)
	result.Scores = verdict.Scores
	values := verdict.Scores.Values()
	for _, value := range values {
		result.AverageScore += float64(value)
	}
	result.AverageScore = math.Round(result.AverageScore/float64(len(values))*1000) / 1000

	applied, err := verifier.DB.AppliedKnowledgeForRun(ctx, run.ProjectID, run.ID)
	if err != nil {
		return fail("load successful run knowledge materialization: %v", err)
	}
	result.MaterializedGenerationID = applied.GenerationID
	if applied.ArtifactID != run.ReportArtifactID || applied.InputSHA256 != reportAttempt.OutputArtifactHash {
		return fail("knowledge materialization is not bound to the adopted final report")
	}
	patchBytes, err := json.Marshal(report.KnowledgePatch)
	if err != nil {
		return fail("encode final knowledge patch: %v", err)
	}
	patchSum := sha256.Sum256(patchBytes)
	if applied.PatchBlobHash != hex.EncodeToString(patchSum[:]) {
		return fail("knowledge materialization patch hash does not match the final report")
	}
	if applied.ExtractorContractSHA256 != knowledge.RunKnowledgeExtractorContractSHA256() ||
		applied.OutputSHA256 != applied.PatchBlobHash {
		return fail("knowledge materialization extraction receipt does not match the deterministic adapter contract")
	}
	storedPatch, err := verifier.CAS.ReadVerified(applied.PatchBlobHash)
	if err != nil || !bytes.Equal(storedPatch, patchBytes) {
		return fail("knowledge materialization patch CAS readback failed: %v", err)
	}
	materializedGeneration, err := verifier.DB.KnowledgeGeneration(ctx, run.ProjectID, applied.GenerationID)
	if err != nil {
		return fail("load materialized knowledge generation: %v", err)
	}
	ontologyReceipt, err := verifier.DB.KnowledgeGenerationOntologyReceipt(ctx, run.ProjectID, applied.GenerationID)
	if err != nil {
		return fail("load materialized knowledge ontology receipt: %v", err)
	}
	expectedContract, err := knowledge.RunKnowledgeMaterializationContractSHA256(
		ontologyReceipt.CanonicalSHA256, applied.PatchBlobHash,
	)
	if err != nil || materializedGeneration.ContractSHA256 != expectedContract {
		return fail("materialized generation contract is not bound to its ontology and final patch: %v", err)
	}
	runSourceCount, err := verifier.DB.RunKnowledgeSourceCount(ctx, run.ProjectID, applied.GenerationID, run.ID)
	if err != nil || runSourceCount == 0 {
		return fail("materialized generation has no deterministic source rows for the evaluated run: %v", err)
	}
	if err := verifier.verifyKnowledgeSnapshot(ctx, run.ProjectID, applied.GenerationID, requireOxigraph); err != nil {
		return fail("verify materialized knowledge snapshot: %v", err)
	}
	head, err := verifier.DB.ActiveKnowledgeGeneration(ctx, run.ProjectID)
	if err != nil {
		return fail("load active knowledge head after materialization: %v", err)
	}
	switch applied.State {
	case store.KnowledgeReady:
		if !applied.Active || head.GenerationID != applied.GenerationID ||
			head.Status != store.KnowledgeHeadReady || head.Generation.State != store.KnowledgeReady {
			return fail("ready materialized generation is not the active ready project head")
		}
	case store.KnowledgeRetired:
		if applied.Active || head.GenerationID == applied.GenerationID ||
			head.Status != store.KnowledgeHeadReady || head.Generation.State != store.KnowledgeReady {
			return fail("retired materialized generation has no later active ready project head")
		}
		if err := verifier.verifyKnowledgeSnapshot(ctx, run.ProjectID, head.GenerationID, requireOxigraph); err != nil {
			return fail("verify descendant knowledge snapshot: %v", err)
		}
		if err := verifier.DB.VerifyKnowledgeGenerationRetention(ctx, run.ProjectID, applied.GenerationID, head.GenerationID); err != nil {
			return fail("verify retired materialization lineage retention: %v", err)
		}
	default:
		return fail("materialized generation state %s is not immutable", applied.State)
	}

	materials, err := verifier.DB.AdoptedMemoryMaterials(ctx, run.ID)
	if err != nil {
		return fail("load adopted memory materials: %v", err)
	}
	reportMaterialFound := false
	for _, material := range materials {
		raw, err := verifier.CAS.ReadVerified(material.BlobHash)
		if err != nil {
			return fail("read adopted memory material %s: %v", material.BlobHash, err)
		}
		text, err := releaseMemoryMaterialText(material, raw)
		if err != nil {
			return fail("derive adopted memory material %s: %v", material.BlobHash, err)
		}
		expected := rag.ChunkText(text, rag.DefaultChunkRunes, rag.DefaultOverlapRunes)
		if err := verifier.DB.VerifyDocumentIndex(ctx, run.ProjectID, material.ArtifactID, material.BlobHash, expected); err != nil {
			return fail("adopted memory material %s index integrity failed: %v", material.BlobHash, err)
		}
		if material.ArtifactID == run.ReportArtifactID && material.BlobHash == reportAttempt.OutputArtifactHash {
			reportMaterialFound = true
		}
	}
	if !reportMaterialFound {
		return fail("adopted final report is absent from long-term memory")
	}
	result.Passed = true
	return result
}

// verifyEngineeringVerification independently replays the research engine's
// reserved collector contract at release-evaluation time. Ordinary runs have
// no ordinal-3 attempt. Two or more explicit screening XFOIL jobs make one
// isolated, receipt-backed recomputation mandatory; no other use of ordinal 3
// is admissible.
func (verifier Verifier) verifyEngineeringVerification(
	ctx context.Context,
	runID string,
	verificationAttempt *core.StageAttempt,
	collectAttempts map[int]*core.StageAttempt,
) (*core.EvidenceBundle, error) {
	optimization, err := VerifyXFOILOptimization(ctx, verifier.DB, verifier.CAS, runID)
	if err != nil {
		return nil, err
	}
	if !optimization.Required {
		if verificationAttempt != nil {
			return nil, errors.New("reserved verification collector exists without an explicit optimization sweep")
		}
		return nil, nil
	}
	if verificationAttempt == nil || optimization.VerificationStageAttemptID != verificationAttempt.ID {
		return nil, errors.New("multiple screening XFOIL jobs require the reserved independent verification collector")
	}
	attemptOrdinals := make(map[string]int, len(collectAttempts))
	for ordinal, attempt := range collectAttempts {
		attemptOrdinals[attempt.ID] = ordinal
	}
	if ordinal, ok := attemptOrdinals[optimization.WinnerStageAttemptID]; !ok || ordinal < 0 || ordinal >= core.MaxCollectors {
		return nil, errors.New("deterministic XFOIL winner is outside the completed regular collector set")
	}
	var jobsInAttempt int
	if err := verifier.DB.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM engineering_jobs WHERE run_id=? AND stage_attempt_id=?",
		runID, verificationAttempt.ID,
	).Scan(&jobsInAttempt); err != nil {
		return nil, err
	}
	if jobsInAttempt != 1 {
		return nil, fmt.Errorf("reserved verification collector contains %d engineering jobs", jobsInAttempt)
	}
	var bundle core.EvidenceBundle
	if err := verifier.readStrict(verificationAttempt.OutputArtifactHash, &bundle); err != nil {
		return nil, fmt.Errorf("read reserved verification bundle: %w", err)
	}
	if bundle.Claims == nil || bundle.Sources == nil || bundle.Limitations == nil {
		return nil, errors.New("reserved verification bundle omits a required array")
	}
	if err := bundle.Validate(engineeringVerificationWorkstreamID); err != nil {
		return nil, err
	}
	if err := verifier.DB.VerifyEvidenceSourcesForAttempt(ctx, runID, verificationAttempt.ID, bundle.Sources); err != nil {
		return nil, err
	}
	containsReceipt := false
	for _, evidenceSource := range bundle.Sources {
		artifactID, receiptSource := core.EngineeringReceiptArtifactID(evidenceSource)
		if receiptSource && artifactID == optimization.VerificationReceiptArtifactID {
			if evidenceSource.BlobHash != optimization.VerificationReceiptBlobSHA256 {
				return nil, errors.New("reserved verification bundle cites the right receipt id with the wrong CAS provenance")
			}
			containsReceipt = true
		}
		data, err := verifier.CAS.ReadVerified(evidenceSource.BlobHash)
		if err != nil {
			return nil, fmt.Errorf("verify independent recomputation CAS %s: %w", evidenceSource.ID, err)
		}
		if err := core.ValidateEvidenceSourceContent(evidenceSource, data); err != nil {
			return nil, fmt.Errorf("verify independent recomputation content %s: %w", evidenceSource.ID, err)
		}
	}
	if !containsReceipt {
		return nil, errors.New("reserved verification bundle does not cite its new execution receipt")
	}
	return &bundle, nil
}

func (verifier Verifier) verifyRequiredOxigraphSnapshot(ctx context.Context, projectID, generationID string) error {
	if verifier.Oxigraph == nil {
		return errors.New("real Oxigraph sidecar is required")
	}
	receipt, err := verifier.DB.KnowledgeSnapshotReceipt(ctx, projectID, generationID)
	if err != nil {
		return err
	}
	if err := verifier.DB.VerifyKnowledgeSnapshot(ctx, projectID, generationID, verifier.CAS); err != nil {
		return err
	}
	snapshot, err := verifier.CAS.ReadVerified(receipt.BlobHash)
	if err != nil {
		return err
	}
	if err := verifier.Oxigraph.LoadSnapshot(
		ctx, projectID, generationID, snapshot, receipt.DatasetSHA256, receipt.TripleCount,
	); err != nil {
		return fmt.Errorf("load canonical snapshot into Oxigraph: %w", err)
	}
	return nil
}

func releaseMemoryMaterialText(material store.MemoryMaterial, raw []byte) (string, error) {
	if material.ArtifactID != "" {
		var report core.ReportManifest
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&report); err != nil {
			return "", fmt.Errorf("decode adopted report: %w", err)
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			return "", errors.New("adopted report contains multiple JSON values")
		}
		text := strings.TrimSpace(report.AnswerMarkdown)
		if text == "" {
			return "", errors.New("adopted report has no indexable answer")
		}
		return text, nil
	}
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(material.MediaType, ";")[0]))
	if !strings.HasPrefix(mediaType, "text/") && mediaType != "application/json" && mediaType != "application/xml" {
		return "", fmt.Errorf("unsupported adopted evidence media type %q", material.MediaType)
	}
	if !utf8.Valid(raw) {
		return "", errors.New("adopted evidence is not valid UTF-8")
	}
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return "", errors.New("adopted evidence has no indexable text")
	}
	return text, nil
}

func (verifier Verifier) readStrict(hash string, destination any) error {
	if strings.TrimSpace(hash) == "" {
		return errors.New("stage output hash is empty")
	}
	raw, err := verifier.CAS.ReadVerified(hash)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("CAS artifact contains multiple JSON values")
		}
		return err
	}
	return nil
}

func verifyArtifactBindings(run core.Run, attempts []core.StageAttempt, artifacts []store.Artifact) error {
	byAttempt := make(map[string][]store.Artifact)
	for _, artifact := range artifacts {
		byAttempt[artifact.StageAttemptID] = append(byAttempt[artifact.StageAttemptID], artifact)
	}
	expectedKinds := map[core.Stage]string{
		core.StagePlan: "research.plan", core.StageCollect: "research.evidence",
		core.StageSynthesize: "research.report", core.StageReview: "research.review",
		core.StageRevise: "research.report.revision",
	}
	finalReportFound := false
	seenArtifacts := 0
	for _, attempt := range attempts {
		items := byAttempt[attempt.ID]
		seenArtifacts += len(items)
		kind, known := expectedKinds[attempt.Stage]
		if attempt.Stage == core.StageCollect && attempt.Ordinal == core.EngineeringVerificationOrdinal {
			kind = "research.evidence.verification"
		}
		if !known {
			return fmt.Errorf("stage %s/%d has no artifact contract", attempt.Stage, attempt.Ordinal)
		}
		var canonical *store.Artifact
		for index := range items {
			artifact := &items[index]
			if artifact.Kind == kind && artifact.BlobHash == attempt.OutputArtifactHash {
				if canonical != nil {
					return fmt.Errorf("stage %s/%d repeats its canonical %s artifact", attempt.Stage, attempt.Ordinal, kind)
				}
				canonical = artifact
				continue
			}
			if !allowedSupplementalArtifact(attempt.Stage, artifact.Kind) {
				return fmt.Errorf("stage %s/%d contains unsupported supplemental artifact kind %q", attempt.Stage, attempt.Ordinal, artifact.Kind)
			}
		}
		if canonical == nil {
			return fmt.Errorf("stage %s/%d has no matching %s artifact", attempt.Stage, attempt.Ordinal, kind)
		}
		isFinalReport := (attempt.Stage == core.StageSynthesize && run.RevisionCycle == 0 && attempt.Ordinal == 0) ||
			(attempt.Stage == core.StageRevise && run.RevisionCycle > 0 && attempt.Ordinal == run.RevisionCycle)
		for _, artifact := range items {
			shouldAdopt := attempt.Stage == core.StageCollect || (artifact.ID == canonical.ID && isFinalReport)
			if artifact.Adopted != shouldAdopt {
				return fmt.Errorf("stage %s/%d artifact %s adopted=%t, want %t", attempt.Stage, attempt.Ordinal, artifact.Kind, artifact.Adopted, shouldAdopt)
			}
		}
		if isFinalReport {
			if canonical.ID != run.ReportArtifactID {
				return errors.New("final report artifact is not the adopted run report")
			}
			finalReportFound = true
		}
	}
	if !finalReportFound {
		return errors.New("final report artifact is absent")
	}
	if seenArtifacts != len(artifacts) {
		return errors.New("run contains an artifact bound to an unknown stage attempt")
	}
	return nil
}

func allowedSupplementalArtifact(stage core.Stage, kind string) bool {
	switch stage {
	case core.StagePlan:
		return kind == "plan"
	case core.StageCollect:
		return kind == "evidence" || strings.HasPrefix(kind, "engineering.")
	case core.StageSynthesize, core.StageRevise:
		return kind == "report"
	case core.StageReview:
		return kind == "review"
	default:
		return false
	}
}

func expectedStageProfile(stage core.Stage) (model, effort, serviceTier string, err error) {
	switch stage {
	case core.StagePlan, core.StageSynthesize, core.StageRevise:
		return core.PlannerModel, core.PlannerEffort, core.ServiceTierDefault, nil
	case core.StageCollect:
		return core.CollectorModel, core.CollectorEffort, core.ServiceTierDefault, nil
	case core.StageReview:
		return core.ReviewerModel, core.ReviewerEffort, core.ServiceTierDefault, nil
	default:
		return "", "", "", fmt.Errorf("unsupported research stage %q", stage)
	}
}

func SortMappings(mappings []RunMapping) {
	sort.Slice(mappings, func(left, right int) bool { return mappings[left].CaseID < mappings[right].CaseID })
}
