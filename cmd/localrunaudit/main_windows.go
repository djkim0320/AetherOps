//go:build windows && amd64

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/desktop"
	"github.com/djkim0320/Aether-claw/internal/engineering"
	"github.com/djkim0320/Aether-claw/internal/evalgate"
	"github.com/djkim0320/Aether-claw/internal/rag"
	managedruntime "github.com/djkim0320/Aether-claw/internal/runtime"
	"github.com/djkim0320/Aether-claw/internal/store"
)

const localRunAuditSchemaV1 = "aetherops_local_run_audit_v1"

type auditOptions struct {
	DataRoot  string
	ProjectID string
	RunID     string
}

type stageSummary struct {
	Total        int `json:"total"`
	Plan         int `json:"plan"`
	Collectors   int `json:"collectors"`
	Verification int `json:"verification_collectors"`
	Synthesize   int `json:"synthesize"`
	Review       int `json:"review"`
	Revise       int `json:"revise"`
}

type artifactSummary struct {
	Count            int    `json:"count"`
	ReportArtifactID string `json:"report_artifact_id"`
	ReportSHA256     string `json:"report_sha256"`
}

type casSummary struct {
	VerifiedObjects int   `json:"verified_objects"`
	VerifiedBytes   int64 `json:"verified_bytes"`
	WorkerCount     int   `json:"worker_count"`
}

type xfoilSummary struct {
	Objective                     string                    `json:"objective"`
	TargetCL                      float64                   `json:"target_cl"`
	MinimumCM                     float64                   `json:"minimum_cm"`
	RuntimeBundleSHA256           string                    `json:"runtime_bundle_sha256"`
	SweepIdentitySHA256           string                    `json:"sweep_identity_sha256"`
	ScreeningAttempts             int                       `json:"screening_attempts"`
	ScreeningCandidates           int                       `json:"screening_candidates"`
	SucceededScreeningAttempts    int                       `json:"succeeded_screening_attempts"`
	FailedScreeningAttempts       int                       `json:"failed_screening_attempts"`
	ScreeningDeflectionsDeg       []float64                 `json:"screening_deflections_deg"`
	WinnerJobID                   string                    `json:"winner_job_id"`
	WinnerReceiptArtifactID       string                    `json:"winner_receipt_artifact_id"`
	WinnerSpecSHA256              string                    `json:"winner_spec_sha256"`
	WinnerTarget                  evalgate.XFOILTargetProof `json:"winner_target"`
	VerificationJobID             string                    `json:"verification_job_id"`
	VerificationReceiptArtifactID string                    `json:"verification_receipt_artifact_id"`
	VerificationSpecSHA256        string                    `json:"verification_spec_sha256"`
	VerificationTarget            evalgate.XFOILTargetProof `json:"verification_target"`
}

type memorySummary struct {
	State                string `json:"state"`
	MemoryRevision       int64  `json:"memory_revision"`
	ActiveIndexID        string `json:"active_index_id"`
	EmbeddingModel       string `json:"embedding_model"`
	EmbeddingDimensions  int    `json:"embedding_dimensions"`
	DocumentCount        int    `json:"document_count"`
	AdoptedMaterialCount int    `json:"adopted_material_count"`
}

type knowledgeSummary struct {
	PinnedGenerationID           string                         `json:"pinned_generation_id"`
	PinnedSnapshotSHA256         string                         `json:"pinned_snapshot_sha256"`
	PinnedSnapshotTriples        int                            `json:"pinned_snapshot_triples"`
	MaterializedGenerationID     string                         `json:"materialized_generation_id"`
	MaterializedGenerationState  store.KnowledgeGenerationState `json:"materialized_generation_state"`
	MaterializedGenerationActive bool                           `json:"materialized_generation_active"`
	HeadGenerationID             string                         `json:"head_generation_id"`
	HeadStatus                   store.KnowledgeHeadStatus      `json:"head_status"`
	SourceCount                  int                            `json:"source_count"`
	EntityCount                  int                            `json:"entity_count"`
	AssertionCount               int                            `json:"assertion_count"`
	RunSourceCount               int                            `json:"run_source_count"`
	ExtractionBatchCount         int                            `json:"extraction_batch_count"`
	ExtractorContractSHA256      string                         `json:"extractor_contract_sha256"`
	PatchSHA256                  string                         `json:"patch_sha256"`
	SnapshotSHA256               string                         `json:"snapshot_sha256"`
	SnapshotTriples              int                            `json:"snapshot_triples"`
}

type runSummary struct {
	Status                 core.RunStatus                `json:"status"`
	ResearchProfileVersion string                        `json:"research_profile_version"`
	RetrievalProfile       string                        `json:"retrieval_profile"`
	RevisionCycle          int                           `json:"revision_cycle"`
	ProductBuild           buildinfo.ProductBuildBinding `json:"product_build"`
}

type auditSummary struct {
	Schema     string              `json:"schema"`
	Passed     bool                `json:"passed"`
	VerifiedAt time.Time           `json:"verified_at"`
	ProjectID  string              `json:"project_id"`
	RunID      string              `json:"run_id"`
	Run        runSummary          `json:"run"`
	Stages     stageSummary        `json:"stages"`
	Artifacts  artifactSummary     `json:"artifacts"`
	CAS        casSummary          `json:"cas"`
	XFOIL      xfoilSummary        `json:"xfoil"`
	Memory     memorySummary       `json:"memory"`
	Knowledge  knowledgeSummary    `json:"knowledge"`
	Quality    evalgate.CaseResult `json:"quality"`
}

type failureSummary struct {
	Schema    string `json:"schema"`
	Passed    bool   `json:"passed"`
	ProjectID string `json:"project_id,omitempty"`
	RunID     string `json:"run_id,omitempty"`
	Error     string `json:"error"`
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	options, err := parseOptions(os.Args[1:], os.Stderr)
	if err != nil {
		writeFailure(os.Stdout, auditOptions{}, err)
		os.Exit(2)
	}
	summary, err := auditLocalRun(ctx, options)
	if err != nil {
		writeFailure(os.Stdout, options, err)
		os.Exit(1)
	}
	if err := writeJSON(os.Stdout, summary); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "encode local run audit:", err)
		os.Exit(1)
	}
}

func parseOptions(args []string, output io.Writer) (auditOptions, error) {
	flags := flag.NewFlagSet("localrunaudit", flag.ContinueOnError)
	flags.SetOutput(output)
	var options auditOptions
	flags.StringVar(&options.DataRoot, "data-root", "", "existing AetherOps v2 data root")
	flags.StringVar(&options.ProjectID, "project-id", "", "project id that owns the run")
	flags.StringVar(&options.RunID, "run-id", "", "succeeded engineering research run id")
	if err := flags.Parse(args); err != nil {
		return auditOptions{}, err
	}
	if flags.NArg() != 0 {
		return auditOptions{}, errors.New("unexpected positional arguments")
	}
	options.DataRoot = strings.TrimSpace(options.DataRoot)
	options.ProjectID = strings.TrimSpace(options.ProjectID)
	options.RunID = strings.TrimSpace(options.RunID)
	if options.DataRoot == "" || options.ProjectID == "" || options.RunID == "" {
		return auditOptions{}, errors.New("-data-root, -project-id, and -run-id are required")
	}
	return options, nil
}

func auditLocalRun(ctx context.Context, options auditOptions) (summary auditSummary, returnErr error) {
	root, err := resolveExistingDataRoot(options.DataRoot)
	if err != nil {
		return summary, err
	}
	lease, primary, err := desktop.AcquireInstanceLease("AetherOps.v2")
	if err != nil {
		return summary, fmt.Errorf("acquire offline audit lease: %w", err)
	}
	if !primary {
		return summary, errors.New("AetherOps is running; close it before auditing immutable SQLite and CAS evidence")
	}
	defer func() { returnErr = errors.Join(returnErr, lease.Close()) }()

	database, err := store.OpenReadOnly(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		return summary, fmt.Errorf("open AetherOps database read-only: %w", err)
	}
	defer func() { returnErr = errors.Join(returnErr, database.Close()) }()
	objects, err := cas.OpenReadOnly(filepath.Join(root, "objects"))
	if err != nil {
		return summary, fmt.Errorf("open AetherOps CAS read-only: %w", err)
	}

	run, err := database.Run(ctx, options.RunID)
	if err != nil {
		return summary, fmt.Errorf("load run: %w", err)
	}
	if run.ProjectID != options.ProjectID {
		return summary, errors.New("run does not belong to the requested project")
	}
	if err := run.ProductBuild.Validate(); err != nil {
		return summary, fmt.Errorf("validate run product build: %w", err)
	}

	quality, err := (evalgate.Verifier{DB: database, CAS: objects}).VerifyLocalRun(
		ctx, options.ProjectID, options.RunID,
	)
	if err != nil {
		return summary, fmt.Errorf("verify run contract: %w", err)
	}

	attempts, err := database.ListStageAttempts(ctx, run.ID)
	if err != nil {
		return summary, fmt.Errorf("load stage attempts: %w", err)
	}
	stages := summarizeStages(attempts)
	artifacts, err := database.ListArtifacts(ctx, run.ID)
	if err != nil {
		return summary, fmt.Errorf("load artifacts: %w", err)
	}
	reportArtifact, err := database.Artifact(ctx, run.ReportArtifactID)
	if err != nil {
		return summary, fmt.Errorf("load adopted report artifact: %w", err)
	}

	optimization, err := evalgate.VerifyXFOILOptimization(ctx, database, objects, run.ID)
	if err != nil {
		return summary, fmt.Errorf("verify XFOIL optimization: %w", err)
	}
	xfoil, jobs, err := verifyRequiredXFOILCampaign(ctx, database, run, optimization)
	if err != nil {
		return summary, err
	}

	memory, materials, err := verifyMemoryHead(ctx, database, run.ProjectID, run.ID)
	if err != nil {
		return summary, err
	}
	knowledge, applied, snapshots, err := verifyKnowledgeState(ctx, database, objects, run)
	if err != nil {
		return summary, err
	}

	hashes, err := referencedRunHashes(ctx, database, run, attempts, artifacts, jobs, materials, applied, snapshots)
	if err != nil {
		return summary, err
	}
	verifiedCAS, err := verifyCASObjects(ctx, database, objects, hashes)
	if err != nil {
		return summary, err
	}

	summary = auditSummary{
		Schema: localRunAuditSchemaV1, Passed: true, VerifiedAt: time.Now().UTC(),
		ProjectID: run.ProjectID, RunID: run.ID,
		Run: runSummary{
			Status: run.Status, ResearchProfileVersion: run.ResearchProfileVersion,
			RetrievalProfile: run.RetrievalProfile, RevisionCycle: run.RevisionCycle,
			ProductBuild: run.ProductBuild,
		},
		Stages: stages,
		Artifacts: artifactSummary{
			Count: len(artifacts), ReportArtifactID: reportArtifact.ID, ReportSHA256: reportArtifact.BlobHash,
		},
		CAS: verifiedCAS, XFOIL: xfoil, Memory: memory, Knowledge: knowledge, Quality: quality,
	}
	return summary, nil
}

func resolveExistingDataRoot(value string) (string, error) {
	absolute, err := filepath.Abs(strings.TrimSpace(value))
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return "", fmt.Errorf("inspect data root: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("data root must be an existing non-link directory")
	}
	return filepath.Clean(absolute), nil
}

func summarizeStages(attempts []core.StageAttempt) stageSummary {
	summary := stageSummary{Total: len(attempts)}
	for _, attempt := range attempts {
		switch attempt.Stage {
		case core.StagePlan:
			summary.Plan++
		case core.StageCollect:
			if attempt.Ordinal == core.EngineeringVerificationOrdinal {
				summary.Verification++
			} else {
				summary.Collectors++
			}
		case core.StageSynthesize:
			summary.Synthesize++
		case core.StageReview:
			summary.Review++
		case core.StageRevise:
			summary.Revise++
		}
	}
	return summary
}

type xfoilEnvelope struct {
	Arguments json.RawMessage `json:"arguments"`
	Operation string          `json:"operation"`
	Runtime   string          `json:"runtime_bundle_hash"`
	Component string          `json:"tool_component"`
	Version   string          `json:"tool_version"`
}

func verifyRequiredXFOILCampaign(
	ctx context.Context,
	database *store.DB,
	run core.Run,
	proof evalgate.XFOILOptimizationProof,
) (xfoilSummary, []store.EngineeringJob, error) {
	if !proof.Required || proof.Objective != engineering.XFOILObjectiveMinimizeCDAtTargetCL ||
		!closeFloat(proof.TargetCL, 0.8) || !closeFloat(proof.MinimumCM, -0.2) ||
		proof.ScreeningAttemptCount != 7 || proof.ScreeningCandidateCount != 7 ||
		proof.SucceededScreeningAttemptCount != 7 || proof.FailedScreeningAttemptCount != 0 ||
		proof.WinnerJobID == "" || proof.WinnerStageAttemptID == "" || proof.WinnerReceiptArtifactID == "" ||
		proof.WinnerSpecSHA256 == "" || proof.VerificationJobID == "" ||
		proof.VerificationStageAttemptID == "" || proof.VerificationReceiptArtifactID == "" ||
		proof.VerificationSpecSHA256 == "" {
		return xfoilSummary{}, nil, errors.New("XFOIL proof does not establish the required 7+1 target-CL optimization campaign")
	}
	jobs, err := database.ListRunEngineeringJobs(ctx, run.ID, "xfoil_polar")
	if err != nil {
		return xfoilSummary{}, nil, fmt.Errorf("load XFOIL jobs: %w", err)
	}
	if len(jobs) != 8 {
		return xfoilSummary{}, nil, fmt.Errorf("XFOIL campaign has %d jobs, want exactly 8", len(jobs))
	}
	expectedDeflections := []float64{0, 5, 10, 15, 20, 25, 30}
	deflections := make([]float64, 0, len(expectedDeflections))
	verificationCount := 0
	for _, job := range jobs {
		if job.ProjectID != run.ProjectID || job.RunID != run.ID || job.Status != "succeeded" ||
			job.Operation != "xfoil_polar" || job.ToolComponent != "xfoil" ||
			job.ToolVersion != managedruntime.PinnedXFOILVersion || job.ReceiptArtifactID == "" {
			return xfoilSummary{}, nil, fmt.Errorf("XFOIL job %s violates pinned successful job identity", job.ID)
		}
		specSum := sha256.Sum256([]byte(job.SpecJSON))
		if hex.EncodeToString(specSum[:]) != job.SpecSHA256 {
			return xfoilSummary{}, nil, fmt.Errorf("XFOIL job %s specification hash mismatch", job.ID)
		}
		var envelope xfoilEnvelope
		if err := decodeStrict([]byte(job.SpecJSON), &envelope); err != nil {
			return xfoilSummary{}, nil, fmt.Errorf("decode XFOIL job %s envelope: %w", job.ID, err)
		}
		if envelope.Operation != job.Operation || envelope.Component != job.ToolComponent ||
			envelope.Version != job.ToolVersion || envelope.Runtime != proof.RuntimeBundleSHA256 {
			return xfoilSummary{}, nil, fmt.Errorf("XFOIL job %s envelope does not match its runtime-bound row", job.ID)
		}
		var spec engineering.XFOILSpec
		if err := decodeStrict(envelope.Arguments, &spec); err != nil {
			return xfoilSummary{}, nil, fmt.Errorf("decode XFOIL job %s arguments: %w", job.ID, err)
		}
		if err := verifyOptimizationTopic(run, job, spec); err != nil {
			return xfoilSummary{}, nil, err
		}
		switch spec.ExecutionPurpose {
		case engineering.XFOILPurposeScreening:
			if spec.VerificationOfJobID != "" {
				return xfoilSummary{}, nil, fmt.Errorf("screening XFOIL job %s cites a verification source", job.ID)
			}
			deflections = append(deflections, *spec.FlapDeflectionDeg)
		case engineering.XFOILPurposeIndependentVerification:
			verificationCount++
			if job.ID != proof.VerificationJobID || spec.VerificationOfJobID != proof.WinnerJobID {
				return xfoilSummary{}, nil, errors.New("independent XFOIL job is not bound to the deterministic winner")
			}
		default:
			return xfoilSummary{}, nil, fmt.Errorf("XFOIL job %s has unsupported execution purpose %q", job.ID, spec.ExecutionPurpose)
		}
		links, err := database.EngineeringJobArtifacts(ctx, job.ID)
		if err != nil {
			return xfoilSummary{}, nil, fmt.Errorf("load XFOIL job %s artifacts: %w", job.ID, err)
		}
		if err := verifyXFOILArtifactRoles(job, links); err != nil {
			return xfoilSummary{}, nil, err
		}
	}
	sort.Float64s(deflections)
	if verificationCount != 1 || len(deflections) != len(expectedDeflections) {
		return xfoilSummary{}, nil, errors.New("XFOIL campaign does not contain seven screenings and one independent verification")
	}
	for index := range expectedDeflections {
		if !closeFloat(deflections[index], expectedDeflections[index]) {
			return xfoilSummary{}, nil, fmt.Errorf("XFOIL screening deflections are %v, want %v", deflections, expectedDeflections)
		}
	}
	return xfoilSummary{
		Objective: proof.Objective, TargetCL: proof.TargetCL, MinimumCM: proof.MinimumCM,
		RuntimeBundleSHA256: proof.RuntimeBundleSHA256, SweepIdentitySHA256: proof.SweepIdentitySHA256,
		ScreeningAttempts: proof.ScreeningAttemptCount, ScreeningCandidates: proof.ScreeningCandidateCount,
		SucceededScreeningAttempts: proof.SucceededScreeningAttemptCount,
		FailedScreeningAttempts:    proof.FailedScreeningAttemptCount,
		ScreeningDeflectionsDeg:    deflections,
		WinnerJobID:                proof.WinnerJobID, WinnerReceiptArtifactID: proof.WinnerReceiptArtifactID,
		WinnerSpecSHA256: proof.WinnerSpecSHA256, WinnerTarget: proof.WinnerTarget,
		VerificationJobID:             proof.VerificationJobID,
		VerificationReceiptArtifactID: proof.VerificationReceiptArtifactID,
		VerificationSpecSHA256:        proof.VerificationSpecSHA256, VerificationTarget: proof.VerificationTarget,
	}, jobs, nil
}

func verifyOptimizationTopic(run core.Run, job store.EngineeringJob, spec engineering.XFOILSpec) error {
	if spec.RunID != run.ID || spec.StageAttemptID != job.StageAttemptID || spec.NACA != "0015" ||
		!closeFloat(spec.Reynolds, 1_000_000) || !closeFloat(spec.Mach, 0.1) ||
		!closeFloat(spec.AlphaStartDeg, -6) || !closeFloat(spec.AlphaEndDeg, 18) ||
		!closeFloat(spec.AlphaStepDeg, 0.25) ||
		spec.OptimizationObjective != engineering.XFOILObjectiveMinimizeCDAtTargetCL ||
		spec.TargetCL == nil || !closeFloat(*spec.TargetCL, 0.8) ||
		spec.MinimumCM == nil || !closeFloat(*spec.MinimumCM, -0.2) ||
		spec.FlapChordRatio == nil || !closeFloat(*spec.FlapChordRatio, 0.3) ||
		spec.FlapHingeXOverC == nil || !closeFloat(*spec.FlapHingeXOverC, 0.7) ||
		spec.FlapHingeYOverC == nil || !closeFloat(*spec.FlapHingeYOverC, 0) ||
		spec.FlapDeflectionDeg == nil {
		return fmt.Errorf("XFOIL job %s does not match the fixed NACA0015 optimization topic", job.ID)
	}
	return nil
}

func verifyXFOILArtifactRoles(job store.EngineeringJob, links []store.EngineeringJobArtifact) error {
	expected := map[string]bool{
		"input": false, "geometry": false, "polar": false,
		"normalized": false, "log": false, "receipt": false,
	}
	if len(links) != len(expected) {
		return fmt.Errorf("XFOIL job %s has %d artifact links, want 6", job.ID, len(links))
	}
	for _, link := range links {
		seen, exists := expected[link.Role]
		if !exists || seen {
			return fmt.Errorf("XFOIL job %s has unsupported or duplicate artifact role %q", job.ID, link.Role)
		}
		expected[link.Role] = true
		if link.Role == "receipt" && link.ArtifactID != job.ReceiptArtifactID {
			return fmt.Errorf("XFOIL job %s receipt role is not its receipt artifact", job.ID)
		}
	}
	return nil
}

func verifyMemoryHead(
	ctx context.Context,
	database *store.DB,
	projectID, runID string,
) (memorySummary, []store.MemoryMaterial, error) {
	head, err := database.ProjectMemoryStatus(ctx, projectID)
	if err != nil {
		return memorySummary{}, nil, fmt.Errorf("load project memory head: %w", err)
	}
	if head.State != "ready" || head.Error != "" || head.ActiveIndexID == "" ||
		head.ShadowIndexID != "" || head.ShadowIndex != nil || head.ActiveIndex == nil ||
		head.ActiveIndex.ID != head.ActiveIndexID || head.ActiveIndex.ProjectID != projectID ||
		head.ActiveIndex.State != "active" || head.ActiveIndex.Error != "" ||
		head.ActiveIndex.Model != rag.EmbeddingModel || head.ActiveIndex.Dimensions != rag.EmbeddingDimensions {
		return memorySummary{}, nil, errors.New("project memory head is not a clean ready active embedding index")
	}
	documents, err := database.MemoryDocuments(ctx, projectID)
	if err != nil {
		return memorySummary{}, nil, fmt.Errorf("load memory documents: %w", err)
	}
	materials, err := database.AdoptedMemoryMaterials(ctx, runID)
	if err != nil {
		return memorySummary{}, nil, fmt.Errorf("load adopted memory materials: %w", err)
	}
	return memorySummary{
		State: head.State, MemoryRevision: head.MemoryRevision, ActiveIndexID: head.ActiveIndexID,
		EmbeddingModel: head.ActiveIndex.Model, EmbeddingDimensions: head.ActiveIndex.Dimensions,
		DocumentCount: len(documents), AdoptedMaterialCount: len(materials),
	}, materials, nil
}

func verifyKnowledgeState(
	ctx context.Context,
	database *store.DB,
	objects *cas.Store,
	run core.Run,
) (knowledgeSummary, store.AppliedRunKnowledge, []store.KnowledgeSnapshotReceipt, error) {
	pinned, err := database.KnowledgeGeneration(ctx, run.ProjectID, run.KnowledgeGenerationID)
	if err != nil {
		return knowledgeSummary{}, store.AppliedRunKnowledge{}, nil, fmt.Errorf("load pinned knowledge generation: %w", err)
	}
	if err := database.VerifyKnowledgeSnapshot(ctx, run.ProjectID, pinned.ID, objects); err != nil {
		return knowledgeSummary{}, store.AppliedRunKnowledge{}, nil, fmt.Errorf("verify pinned knowledge snapshot: %w", err)
	}
	pinnedSnapshot, err := database.KnowledgeSnapshotReceipt(ctx, run.ProjectID, pinned.ID)
	if err != nil {
		return knowledgeSummary{}, store.AppliedRunKnowledge{}, nil, fmt.Errorf("load pinned knowledge snapshot receipt: %w", err)
	}
	applied, err := database.AppliedKnowledgeForRun(ctx, run.ProjectID, run.ID)
	if err != nil {
		return knowledgeSummary{}, store.AppliedRunKnowledge{}, nil, fmt.Errorf("load applied run knowledge: %w", err)
	}
	generation, err := database.KnowledgeGeneration(ctx, run.ProjectID, applied.GenerationID)
	if err != nil {
		return knowledgeSummary{}, store.AppliedRunKnowledge{}, nil, fmt.Errorf("load materialized knowledge generation: %w", err)
	}
	if err := database.VerifyKnowledgeSnapshot(ctx, run.ProjectID, generation.ID, objects); err != nil {
		return knowledgeSummary{}, store.AppliedRunKnowledge{}, nil, fmt.Errorf("verify materialized knowledge snapshot: %w", err)
	}
	snapshot, err := database.KnowledgeSnapshotReceipt(ctx, run.ProjectID, generation.ID)
	if err != nil {
		return knowledgeSummary{}, store.AppliedRunKnowledge{}, nil, fmt.Errorf("load materialized knowledge snapshot receipt: %w", err)
	}
	head, err := database.ActiveKnowledgeGeneration(ctx, run.ProjectID)
	if err != nil {
		return knowledgeSummary{}, store.AppliedRunKnowledge{}, nil, fmt.Errorf("load active knowledge head: %w", err)
	}
	if head.Status != store.KnowledgeHeadReady || head.Generation.State != store.KnowledgeReady || head.Error != "" {
		return knowledgeSummary{}, store.AppliedRunKnowledge{}, nil, errors.New("active knowledge head is not clean and ready")
	}
	snapshots := []store.KnowledgeSnapshotReceipt{pinnedSnapshot, snapshot}
	if head.GenerationID != generation.ID {
		if err := database.VerifyKnowledgeSnapshot(ctx, run.ProjectID, head.GenerationID, objects); err != nil {
			return knowledgeSummary{}, store.AppliedRunKnowledge{}, nil, fmt.Errorf("verify active descendant knowledge snapshot: %w", err)
		}
		headSnapshot, err := database.KnowledgeSnapshotReceipt(ctx, run.ProjectID, head.GenerationID)
		if err != nil {
			return knowledgeSummary{}, store.AppliedRunKnowledge{}, nil, fmt.Errorf("load active descendant snapshot receipt: %w", err)
		}
		snapshots = append(snapshots, headSnapshot)
	}
	runSources, err := database.RunKnowledgeSourceCount(ctx, run.ProjectID, generation.ID, run.ID)
	if err != nil || runSources < 1 {
		return knowledgeSummary{}, store.AppliedRunKnowledge{}, nil, fmt.Errorf("materialized generation has no run sources: %w", err)
	}
	var batchCount, appliedCount, unfinishedCount int
	if err := database.SQL().QueryRowContext(ctx, `
SELECT COUNT(*),
       COALESCE(SUM(CASE WHEN status='applied' THEN 1 ELSE 0 END),0),
       COALESCE(SUM(CASE WHEN status IN('queued','extracting','reviewing','validated','interrupted') THEN 1 ELSE 0 END),0)
FROM knowledge_extraction_batches
WHERE project_id=? AND run_id=? AND source_kind='report'`, run.ProjectID, run.ID).Scan(
		&batchCount, &appliedCount, &unfinishedCount,
	); err != nil {
		return knowledgeSummary{}, store.AppliedRunKnowledge{}, nil, fmt.Errorf("audit report extraction batches: %w", err)
	}
	if appliedCount != 1 || unfinishedCount != 0 {
		return knowledgeSummary{}, store.AppliedRunKnowledge{}, nil,
			fmt.Errorf("report extraction receipts are applied=%d unfinished=%d, want 1/0", appliedCount, unfinishedCount)
	}
	return knowledgeSummary{
		PinnedGenerationID: pinned.ID, PinnedSnapshotSHA256: pinnedSnapshot.BlobHash,
		PinnedSnapshotTriples:    pinnedSnapshot.TripleCount,
		MaterializedGenerationID: generation.ID, MaterializedGenerationState: generation.State,
		MaterializedGenerationActive: applied.Active, HeadGenerationID: head.GenerationID, HeadStatus: head.Status,
		SourceCount: generation.SourceCount, EntityCount: generation.EntityCount,
		AssertionCount: generation.AssertionCount, RunSourceCount: runSources,
		ExtractionBatchCount: batchCount, ExtractorContractSHA256: applied.ExtractorContractSHA256,
		PatchSHA256: applied.PatchBlobHash, SnapshotSHA256: snapshot.BlobHash,
		SnapshotTriples: snapshot.TripleCount,
	}, applied, snapshots, nil
}

func referencedRunHashes(
	ctx context.Context,
	database *store.DB,
	run core.Run,
	attempts []core.StageAttempt,
	artifacts []store.Artifact,
	jobs []store.EngineeringJob,
	materials []store.MemoryMaterial,
	applied store.AppliedRunKnowledge,
	snapshots []store.KnowledgeSnapshotReceipt,
) (map[string]struct{}, error) {
	hashes := make(map[string]struct{})
	add := func(hash string) {
		if hash != "" {
			hashes[hash] = struct{}{}
		}
	}
	for _, attempt := range attempts {
		add(attempt.InputArtifactHash)
		add(attempt.OutputArtifactHash)
	}
	for _, artifact := range artifacts {
		add(artifact.BlobHash)
	}
	for _, material := range materials {
		add(material.BlobHash)
	}
	add(applied.PatchBlobHash)
	for _, snapshot := range snapshots {
		add(snapshot.BlobHash)
	}
	for _, job := range jobs {
		links, err := database.EngineeringJobArtifacts(ctx, job.ID)
		if err != nil {
			return nil, fmt.Errorf("load engineering artifacts for CAS audit: %w", err)
		}
		for _, link := range links {
			add(link.BlobHash)
		}
	}
	if err := appendHashQuery(ctx, database, hashes,
		"SELECT blob_hash FROM evidence WHERE run_id=?", run.ID); err != nil {
		return nil, fmt.Errorf("collect evidence CAS hashes: %w", err)
	}
	generations := map[string]struct{}{
		run.KnowledgeGenerationID: {},
		applied.GenerationID:      {},
	}
	head, err := database.ActiveKnowledgeGeneration(ctx, run.ProjectID)
	if err != nil {
		return nil, fmt.Errorf("load knowledge head for CAS audit: %w", err)
	}
	generations[head.GenerationID] = struct{}{}
	for generationID := range generations {
		if err := appendHashQuery(ctx, database, hashes, `
SELECT blob_hash FROM knowledge_sources WHERE project_id=? AND generation_id=?
UNION
SELECT blob_hash FROM knowledge_assertion_evidence WHERE project_id=? AND generation_id=?`,
			run.ProjectID, generationID, run.ProjectID, generationID); err != nil {
			return nil, fmt.Errorf("collect knowledge CAS hashes: %w", err)
		}
		var source, canonical sql.NullString
		if err := database.SQL().QueryRowContext(ctx, `
SELECT o.source_blob_hash,o.canonical_blob_hash
FROM knowledge_generations g JOIN ontology_versions o ON o.id=g.ontology_id
WHERE g.project_id=? AND g.id=?`, run.ProjectID, generationID).Scan(&source, &canonical); err != nil {
			return nil, fmt.Errorf("collect ontology CAS hashes: %w", err)
		}
		if source.Valid {
			add(source.String)
		}
		if canonical.Valid {
			add(canonical.String)
		}
	}
	if len(hashes) == 0 {
		return nil, errors.New("run audit resolved no CAS objects")
	}
	return hashes, nil
}

func appendHashQuery(
	ctx context.Context,
	database *store.DB,
	destination map[string]struct{},
	query string,
	arguments ...any,
) error {
	rows, err := database.SQL().QueryContext(ctx, query, arguments...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var hash string
		if err := rows.Scan(&hash); err != nil {
			return err
		}
		if strings.TrimSpace(hash) == "" {
			return errors.New("database contains an empty CAS hash")
		}
		destination[hash] = struct{}{}
	}
	return rows.Err()
}

func verifyCASObjects(
	ctx context.Context,
	database *store.DB,
	objects *cas.Store,
	hashes map[string]struct{},
) (casSummary, error) {
	workerCount := runtime.NumCPU()
	if workerCount < 1 {
		workerCount = 1
	}
	if workerCount > 16 {
		workerCount = 16
	}
	if workerCount > len(hashes) {
		workerCount = len(hashes)
	}
	type result struct {
		size int64
		err  error
	}
	jobs := make(chan string)
	results := make(chan result, len(hashes))
	var workers sync.WaitGroup
	for index := 0; index < workerCount; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for hash := range jobs {
				if err := ctx.Err(); err != nil {
					results <- result{err: err}
					continue
				}
				metadata, err := database.BlobMetadata(ctx, hash)
				if err != nil {
					results <- result{err: fmt.Errorf("load blob metadata %s: %w", hash, err)}
					continue
				}
				data, err := objects.ReadVerified(hash)
				if err != nil {
					results <- result{err: fmt.Errorf("CAS readback %s: %w", hash, err)}
					continue
				}
				if metadata.Hash != hash || metadata.Size != int64(len(data)) {
					results <- result{err: fmt.Errorf("CAS metadata mismatch for %s", hash)}
					continue
				}
				results <- result{size: metadata.Size}
			}
		}()
	}
	go func() {
		for hash := range hashes {
			jobs <- hash
		}
		close(jobs)
		workers.Wait()
		close(results)
	}()
	summary := casSummary{WorkerCount: workerCount}
	var verifyErr error
	for item := range results {
		if item.err != nil {
			verifyErr = errors.Join(verifyErr, item.err)
			continue
		}
		summary.VerifiedObjects++
		summary.VerifiedBytes += item.size
	}
	if verifyErr != nil {
		return casSummary{}, fmt.Errorf("verify referenced CAS objects: %w", verifyErr)
	}
	if summary.VerifiedObjects != len(hashes) {
		return casSummary{}, errors.New("CAS verification did not account for every referenced object")
	}
	return summary, nil
}

func decodeStrict(raw []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains multiple values")
		}
		return err
	}
	return nil
}

func closeFloat(left, right float64) bool {
	return !math.IsNaN(left) && !math.IsInf(left, 0) && math.Abs(left-right) <= 1e-12
}

func writeFailure(output io.Writer, options auditOptions, err error) {
	if encodeErr := writeJSON(output, failureSummary{
		Schema: localRunAuditSchemaV1, Passed: false,
		ProjectID: options.ProjectID, RunID: options.RunID, Error: err.Error(),
	}); encodeErr != nil {
		_, _ = fmt.Fprintln(os.Stderr, "encode local run audit failure:", encodeErr)
	}
}

func writeJSON(output io.Writer, value any) error {
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}
