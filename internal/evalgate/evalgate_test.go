package evalgate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/knowledge"
	"github.com/djkim0320/Aether-claw/internal/rag"
	"github.com/djkim0320/Aether-claw/internal/store"
)

func TestVersionedResearchDataset(t *testing.T) {
	dataset, err := LoadDataset(filepath.Join("..", "..", "evals", "research-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(dataset.Cases) != 12 || len(dataset.SHA256) != 64 {
		t.Fatalf("dataset cases/hash = %d/%q", len(dataset.Cases), dataset.SHA256)
	}
	for _, item := range dataset.Cases {
		prompt := item.Prompt()
		if !strings.Contains(prompt, item.Question) || !strings.Contains(prompt, item.Requirements[0]) {
			t.Fatalf("case %s prompt does not retain its versioned contract", item.ID)
		}
	}
}

func TestVerifierUsesDurableSQLiteAndCASOutputs(t *testing.T) {
	ctx := context.Background()
	database, objects := openEvaluationStore(t)
	dataset := testDataset()
	preparedAt := time.Date(2026, 8, 8, 1, 2, 3, 0, time.UTC)
	manifest, err := PrepareExecutionManifest(dataset, preparedAt, testProductBuildBinding())
	if err != nil {
		t.Fatal(err)
	}
	for index, item := range dataset.Cases {
		run := createPassingEvaluationRun(t, ctx, database, objects, item)
		manifest.Cases[index].RunID = run.ID
	}
	executionPath := filepath.Join(t.TempDir(), "execution.json")
	if err := WriteJSONNew(executionPath, manifest); err != nil {
		t.Fatal(err)
	}
	manifest, err = LoadExecutionManifest(executionPath, dataset)
	if err != nil {
		t.Fatal(err)
	}

	verifiedAt := time.Date(2026, 8, 9, 1, 2, 3, 0, time.UTC)
	receipt, err := (Verifier{DB: database, CAS: objects, Oxigraph: startEvaluationOxigraph(t), Now: func() time.Time { return verifiedAt }}).VerifyExecution(
		ctx, dataset, manifest,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !receipt.Passed || receipt.ObservedPasses != 12 || len(receipt.Results) != 12 || len(receipt.ExecutionManifestSHA256) != 64 ||
		receipt.ProductBuild != manifest.ProductBuild {
		t.Fatalf("unexpected receipt: %+v", receipt)
	}
	result := receipt.Results[0]
	if !result.Passed || result.AverageScore != 4 || result.ReportSHA256 == "" || result.ReviewSHA256 == "" {
		t.Fatalf("unexpected case result: %+v", result)
	}
}

func startEvaluationOxigraph(t *testing.T) *knowledge.Sidecar {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is unavailable for the real Oxigraph release verifier test")
	}
	repositoryRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	entrypoint := filepath.Join(repositoryRoot, "tools", "knowledge-sidecar", "index.cjs")
	moduleDirectory := filepath.Join(repositoryRoot, "tools", "knowledge-sidecar", "node_modules", "oxigraph")
	if _, err := os.Stat(filepath.Join(moduleDirectory, "package.json")); err != nil {
		t.Skip("pinned Oxigraph package is unavailable for the real release verifier test")
	}
	sidecar, err := knowledge.StartSidecar(context.Background(), knowledge.SidecarConfig{
		Command: node, Args: []string{entrypoint}, Dir: filepath.Dir(entrypoint),
		Env: append(os.Environ(), "AETHEROPS_OXIGRAPH_MODULE="+moduleDirectory),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sidecar.Close() })
	return sidecar
}

func TestExecutionManifestRejectsDriftAndOutputOverwrite(t *testing.T) {
	dataset := testDataset()
	manifest, err := PrepareExecutionManifest(dataset, time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC), testProductBuildBinding())
	if err != nil {
		t.Fatal(err)
	}
	for index := range manifest.Cases {
		manifest.Cases[index].RunID = fmt.Sprintf("run_%02d", index)
	}
	path := filepath.Join(t.TempDir(), "execution.json")
	if err := WriteJSONNew(path, manifest); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSONNew(path, manifest); err == nil {
		t.Fatal("audit output overwrite was accepted")
	}
	loaded, err := LoadExecutionManifest(path, dataset)
	if err != nil || len(loaded.SHA256) != 64 {
		t.Fatalf("load execution manifest = %+v, %v", loaded, err)
	}
	loaded.Cases[0].Prompt += " drift"
	if err := loaded.Validate(dataset, true); err == nil {
		t.Fatal("execution prompt drift was accepted")
	}
}

func TestVerifierRejectsRunsCreatedByAnotherProductBuild(t *testing.T) {
	ctx := context.Background()
	buildA := testProductBuildBinding()
	buildB := buildA
	buildB.ExecutableSHA256 = strings.Repeat("d", 64)
	database, objects := openEvaluationStoreWithBuild(t, buildB)
	dataset := testDataset()
	manifest, err := PrepareExecutionManifest(dataset, time.Now().Add(-time.Minute), buildA)
	if err != nil {
		t.Fatal(err)
	}
	project, err := database.CreateProject(ctx, "different build")
	if err != nil {
		t.Fatal(err)
	}
	activateEvaluationTestKnowledge(t, ctx, database, objects, project.ID)
	if err := database.SetProjectMainThread(ctx, project.ID, "main-thread-different-build"); err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", manifest.Cases[0].Prompt, "main-thread-different-build")
	if err != nil {
		t.Fatal(err)
	}
	manifest.Cases[0].RunID = run.ID
	for index := 1; index < len(manifest.Cases); index++ {
		manifest.Cases[index].RunID = fmt.Sprintf("run_other_build_%02d", index)
	}
	manifest.SHA256 = strings.Repeat("f", 64)
	if _, err := (Verifier{DB: database, CAS: objects, Oxigraph: &knowledge.Sidecar{}}).VerifyExecution(ctx, dataset, manifest); err == nil || !strings.Contains(err.Error(), "different product build") {
		t.Fatalf("run from build B was accepted by build A manifest: %v", err)
	}
}

func TestVerifierRejectsQuestionDriftAndCorruptCAS(t *testing.T) {
	ctx := context.Background()
	database, objects := openEvaluationStore(t)
	dataset := testDataset()
	drifted := dataset.Cases[0]
	run := createPassingEvaluationRun(t, ctx, database, objects, drifted)
	drifted.Question = "changed question"
	result := (Verifier{DB: database, CAS: objects}).verifyCase(ctx, drifted, run.ID)
	if result.Passed || !strings.Contains(result.Failure, "does not match") {
		t.Fatalf("question drift was not rejected: %+v", result)
	}

	attempts, err := database.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, attempt := range attempts {
		if attempt.Stage == core.StageReview {
			path, err := objects.Path(attempt.OutputArtifactHash)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("corrupt"), 0o600); err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	result = (Verifier{DB: database, CAS: objects}).verifyCase(ctx, dataset.Cases[0], run.ID)
	if result.Passed || !strings.Contains(result.Failure, "CAS") {
		t.Fatalf("corrupt review CAS was not rejected: %+v", result)
	}
}

func TestVerifierRequiresReservedEngineeringRecomputationAndRejectsFakeOrOverflowCollectors(t *testing.T) {
	ctx := context.Background()
	item := testDataset().Cases[0]

	t.Run("missing verification", func(t *testing.T) {
		database, objects := openEvaluationStore(t)
		run := createPassingEvaluationRun(t, ctx, database, objects, item)
		attempt := evaluationCollectorAttempt(t, ctx, database, run.ID, 0)
		insertEvaluationScreeningXFOIL(t, ctx, database, run, attempt, "eng_screen_1", 0)
		insertEvaluationScreeningXFOIL(t, ctx, database, run, attempt, "eng_screen_2", 5)
		result := (Verifier{DB: database, CAS: objects}).verifyCase(ctx, item, run.ID)
		if result.Passed || !strings.Contains(result.Failure, "require the reserved independent verification collector") {
			t.Fatalf("screening set without recomputation was accepted: %+v", result)
		}
	})

	for _, test := range []struct {
		name    string
		ordinal int
	}{
		{"fake reserved collector", core.EngineeringVerificationOrdinal},
		{"collector ordinal overflow", core.EngineeringVerificationOrdinal + 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			database, objects := openEvaluationStore(t)
			run := createPassingEvaluationRun(t, ctx, database, objects, item)
			addEvaluationCollectorAttempt(t, ctx, database, objects, run, test.ordinal)
			result := (Verifier{DB: database, CAS: objects}).verifyCase(ctx, item, run.ID)
			if result.Passed {
				t.Fatalf("invalid collector ordinal %d was accepted", test.ordinal)
			}
		})
	}
}

func evaluationCollectorAttempt(t *testing.T, ctx context.Context, database *store.DB, runID string, ordinal int) core.StageAttempt {
	t.Helper()
	attempts, err := database.ListStageAttempts(ctx, runID)
	if err != nil {
		t.Fatal(err)
	}
	for _, attempt := range attempts {
		if attempt.Stage == core.StageCollect && attempt.Ordinal == ordinal {
			return attempt
		}
	}
	t.Fatalf("collector ordinal %d is absent", ordinal)
	return core.StageAttempt{}
}

func insertEvaluationScreeningXFOIL(
	t *testing.T,
	ctx context.Context,
	database *store.DB,
	run core.Run,
	attempt core.StageAttempt,
	jobID string,
	flapDeflection float64,
) {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	approvalID := "apr_" + jobID
	if _, err := database.SQL().ExecContext(ctx, `
INSERT INTO approvals(id,run_id,thread_id,turn_id,item_id,kind,summary,status,created_at,updated_at,
 stage_attempt_id,server,tool,arguments_json,arguments_sha256,risk,external_side_effect)
VALUES(?,?,?,?,?,'item/mcpToolCall/requestApproval','evaluation screening','approved',?,?,?,
 'aetherops_engineering','xfoil_polar','{}',?,'external_side_effect',1)`,
		approvalID, run.ID, attempt.CodexThreadID, attempt.CodexTurnID, "item_"+jobID,
		now, now, attempt.ID, strings.Repeat("c", 64)); err != nil {
		t.Fatal(err)
	}
	arguments := map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID, "naca": "0015",
		"reynolds": 1000000.0, "mach": 0.1, "alpha_start_deg": -6.0,
		"alpha_end_deg": 18.0, "alpha_step_deg": 0.25,
		"execution_purpose": "screening", "optimization_objective": "minimize_cd_at_target_cl",
		"target_cl": 0.8, "minimum_cm": -0.2,
		"flap_chord_ratio": 0.3, "flap_hinge_x_over_c": 0.7, "flap_hinge_y_over_c": 0.0,
		"flap_deflection_deg": flapDeflection,
	}
	specBytes, err := json.Marshal(map[string]any{
		"arguments": arguments, "operation": "xfoil_polar", "runtime_bundle_hash": strings.Repeat("a", 64),
		"tool_component": "xfoil", "tool_version": "6.99",
	})
	if err != nil {
		t.Fatal(err)
	}
	specDigest := sha256.Sum256(specBytes)
	if _, err := database.SQL().ExecContext(ctx, `
INSERT INTO engineering_jobs(id,project_id,run_id,stage_attempt_id,operation,spec_json,spec_sha256,
 tool_component,tool_version,approval_id,approval_scope_hash,status,error,created_at,started_at,completed_at,updated_at)
VALUES(?,?,?,?, 'xfoil_polar',?,?, 'xfoil','6.99',?,?, 'succeeded','',?,?,?,?)`,
		jobID, run.ProjectID, run.ID, attempt.ID, string(specBytes), fmt.Sprintf("%x", specDigest),
		approvalID, strings.Repeat("b", 64), now, now, now, now); err != nil {
		t.Fatal(err)
	}
}

func addEvaluationCollectorAttempt(
	t *testing.T,
	ctx context.Context,
	database *store.DB,
	objects *cas.Store,
	run core.Run,
	ordinal int,
) {
	t.Helper()
	inputReceipt, err := objects.PutBytes([]byte(fmt.Sprintf("extra-input-%d", ordinal)))
	if err != nil {
		t.Fatal(err)
	}
	threadID := fmt.Sprintf("extra-collector-%d", ordinal)
	attempt, err := database.BeginStage(ctx, run.ID, core.StageCollect, ordinal, threadID, inputReceipt.Hash)
	if err != nil {
		t.Fatal(err)
	}
	turnID := fmt.Sprintf("extra-turn-%d", ordinal)
	if err := database.SetStageTurn(ctx, attempt.ID, threadID, turnID); err != nil {
		t.Fatal(err)
	}
	outputReceipt, err := objects.PutBytes([]byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	kind := "research.evidence"
	if ordinal == core.EngineeringVerificationOrdinal {
		kind = "research.evidence.verification"
	}
	artifact, err := database.PublishArtifact(ctx, run.ID, attempt.ID, kind, "application/json", outputReceipt)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL().ExecContext(ctx, "UPDATE artifacts SET adopted=1 WHERE id=?", artifact.ID); err != nil {
		t.Fatal(err)
	}
	if err := database.CompleteStageWithExecution(ctx, attempt.ID, outputReceipt.Hash, store.StageExecutionReceipt{
		StageAttemptID: attempt.ID, RunID: run.ID, ResearchProfileVersion: run.ResearchProfileVersion,
		Model: core.CollectorModel, ReasoningEffort: core.CollectorEffort, ServiceTier: core.ServiceTierDefault,
		CodexThreadID: threadID, CodexTurnID: turnID, InputSHA256: inputReceipt.Hash,
		OutputSHA256: outputReceipt.Hash, ExecutionContractSHA256: core.StageExecutionContractSHA256,
		ProductBuild: run.ProductBuild,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestVerifierRejectsRetiredMaterializationWithoutLineageRetention(t *testing.T) {
	ctx := context.Background()
	database, objects := openEvaluationStore(t)
	item := testDataset().Cases[0]
	run := createPassingEvaluationRun(t, ctx, database, objects, item)

	dropped, err := database.CreateKnowledgeGeneration(
		ctx, run.ProjectID, store.CoreOntologyID, store.CoreOntologyContractSHA256,
	)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, tripleCount, err := database.KnowledgeNQuads(ctx, run.ProjectID, dropped.ID, store.CoreOntologyID)
	if err != nil {
		t.Fatal(err)
	}
	snapshotReceipt, err := objects.PutBytes(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, snapshotReceipt, "application/n-quads"); err != nil {
		t.Fatal(err)
	}
	if err := database.AppendKnowledgeProjection(ctx, run.ProjectID, dropped.ID, store.KnowledgeProjection{
		Snapshots: []store.KnowledgeRDFSnapshotRecord{{
			ID: "krdf_" + snapshotReceipt.Hash[:32], Format: "n-quads", BlobHash: snapshotReceipt.Hash,
			DatasetSHA256: snapshotReceipt.Hash, TripleCount: tripleCount,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionKnowledgeGeneration(
		ctx, run.ProjectID, dropped.ID, store.KnowledgeBuilding, store.KnowledgeValidating, "",
	); err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionKnowledgeGeneration(
		ctx, run.ProjectID, dropped.ID, store.KnowledgeValidating, store.KnowledgeReady, "",
	); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ActivateKnowledgeGeneration(ctx, run.ProjectID, dropped.ID); err != nil {
		t.Fatal(err)
	}

	result := (Verifier{DB: database, CAS: objects, Oxigraph: startEvaluationOxigraph(t)}).verifyCase(ctx, item, run.ID)
	if result.Passed || !strings.Contains(result.Failure, "lineage retention") {
		t.Fatalf("retired materialization without retained projection was accepted: %+v", result)
	}
}

func openEvaluationStore(t *testing.T) (*store.DB, *cas.Store) {
	return openEvaluationStoreWithBuild(t, testProductBuildBinding())
}

func openEvaluationStoreWithBuild(t *testing.T, binding ProductBuildBinding) (*store.DB, *cas.Store) {
	t.Helper()
	root := t.TempDir()
	database, err := store.Open(context.Background(), filepath.Join(root, "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetProductBuildBinding(binding); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	objects, err := cas.Open(filepath.Join(root, "cas"))
	if err != nil {
		t.Fatal(err)
	}
	return database, objects
}

func testDataset() Dataset {
	dataset := Dataset{
		Schema: DatasetSchemaV1, Name: "test-release-eval", SHA256: strings.Repeat("a", 64),
		ReleaseGate: ReleaseGate{RequiredCases: 12, RequiredPasses: 12, QualityPolicy: QualityPolicy{
			CitationIntegrityPercent: 100, MaxCriticalErrors: 0, MinimumAverageScore: 4, MinimumAxisScore: 3,
		}},
	}
	for index := 1; index <= 6; index++ {
		dataset.Cases = append(dataset.Cases, Case{ID: "general-0" + string(rune('0'+index)), Mode: "general",
			Question: "test question general " + string(rune('0'+index)), Requirements: []string{"test requirement"}})
	}
	for index := 1; index <= 6; index++ {
		dataset.Cases = append(dataset.Cases, Case{ID: "engineering-0" + string(rune('0'+index)), Mode: "engineering",
			Question: "test question engineering " + string(rune('0'+index)), Requirements: []string{"test requirement"}})
	}
	return dataset
}

func createPassingEvaluationRun(t *testing.T, ctx context.Context, database *store.DB, objects *cas.Store, item Case) core.Run {
	t.Helper()
	project, err := database.CreateProject(ctx, "release evaluation")
	if err != nil {
		t.Fatal(err)
	}
	activateEvaluationTestKnowledge(t, ctx, database, objects, project.ID)
	mainThreadID := "main-thread-" + item.ID
	if err := database.SetProjectMainThread(ctx, project.ID, mainThreadID); err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRunConfigured(ctx, project.ID, "", item.Prompt(), mainThreadID, core.RunConfiguration{
		Model: core.PlannerModel, ReasoningEffort: core.PlannerEffort, ServiceTier: core.ServiceTierDefault,
	})
	if err != nil {
		t.Fatal(err)
	}
	transition := func(status core.RunStatus) {
		t.Helper()
		run, err = database.TransitionRun(ctx, run.ID, run.Revision, status, "")
		if err != nil {
			t.Fatal(err)
		}
	}
	publish := func(stage core.Stage, ordinal int, kind string, value any) core.StageAttempt {
		t.Helper()
		threadID := mainThreadID
		if stage == core.StageCollect || stage == core.StageReview {
			threadID = string(stage) + "-thread-" + item.ID
		}
		inputReceipt, err := objects.PutBytes([]byte(fmt.Sprintf("input:%s:%d", stage, ordinal)))
		if err != nil {
			t.Fatal(err)
		}
		attempt, err := database.BeginStage(ctx, run.ID, stage, ordinal, threadID, inputReceipt.Hash)
		if err != nil {
			t.Fatal(err)
		}
		turnID := fmt.Sprintf("turn-%s-%d", stage, ordinal)
		if err := database.SetStageTurn(ctx, attempt.ID, threadID, turnID); err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		receipt, err := objects.PutBytes(raw)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := database.PublishArtifact(ctx, run.ID, attempt.ID, kind, "application/json", receipt); err != nil {
			t.Fatal(err)
		}
		model, effort, serviceTier, err := expectedStageProfile(stage)
		if err != nil {
			t.Fatal(err)
		}
		if err := database.CompleteStageWithExecution(ctx, attempt.ID, receipt.Hash, store.StageExecutionReceipt{
			StageAttemptID: attempt.ID, RunID: run.ID, ResearchProfileVersion: run.ResearchProfileVersion,
			Model: model, ReasoningEffort: effort, ServiceTier: serviceTier,
			CodexThreadID: threadID, CodexTurnID: turnID,
			InputSHA256: inputReceipt.Hash, OutputSHA256: receipt.Hash,
			ExecutionContractSHA256: core.StageExecutionContractSHA256,
			ProductBuild:            run.ProductBuild,
		}); err != nil {
			t.Fatal(err)
		}
		attempt.OutputArtifactHash = receipt.Hash
		attempt.Status = "completed"
		return attempt
	}

	transition(core.RunPlanning)
	publish(core.StagePlan, 0, "research.plan", core.ResearchPlan{
		Question: item.Prompt(), Mode: item.Mode,
		Workstreams:        []core.Workstream{{ID: "ws-1", Question: "collect evidence", PreferredSourceKinds: []string{"official"}, RequiredEvidence: []string{"source"}}},
		SourceRequirements: []string{"official"}, AcceptanceCriteria: []string{"supported"},
	})
	transition(core.RunCollecting)
	sourceBytes := []byte("durable public source evidence content")
	sourceReceipt, err := objects.PutBytes(sourceBytes)
	if err != nil {
		t.Fatal(err)
	}
	collectInput, err := objects.PutBytes([]byte("collector input"))
	if err != nil {
		t.Fatal(err)
	}
	collectAttempt, err := database.BeginStage(ctx, run.ID, core.StageCollect, 0, "collector-thread-"+item.ID, collectInput.Hash)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetStageTurn(ctx, collectAttempt.ID, "collector-thread-"+item.ID, "collector-turn-"+item.ID); err != nil {
		t.Fatal(err)
	}
	captured, err := database.CaptureEvidence(ctx, run.ID, collectAttempt.ID,
		"https://example.com/source", "Source", "Publisher", "text/plain", sourceReceipt)
	if err != nil {
		t.Fatal(err)
	}
	bundle := core.EvidenceBundle{
		WorkstreamID: "ws-1", Summary: "evidence summary",
		Claims:      []core.EvidenceClaim{{ID: "claim-1", Statement: "supported claim", SourceIDs: []string{"source-1"}, Counterevidence: "none found"}},
		Sources:     []core.EvidenceSource{{ID: "source-1", URL: "https://example.com/source", Title: "Source", Publisher: "Publisher", CapturedAt: captured.CapturedAt, BlobHash: sourceReceipt.Hash}},
		Limitations: []string{"test limitation"},
	}
	bundleBytes, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	bundleReceipt, err := objects.PutBytes(bundleBytes)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.PublishArtifact(ctx, run.ID, collectAttempt.ID, "research.evidence", "application/json", bundleReceipt); err != nil {
		t.Fatal(err)
	}
	if err := database.CompleteStageWithExecution(ctx, collectAttempt.ID, bundleReceipt.Hash, store.StageExecutionReceipt{
		StageAttemptID: collectAttempt.ID, RunID: run.ID, ResearchProfileVersion: run.ResearchProfileVersion,
		Model: core.CollectorModel, ReasoningEffort: core.CollectorEffort, ServiceTier: core.ServiceTierDefault,
		CodexThreadID: "collector-thread-" + item.ID, CodexTurnID: "collector-turn-" + item.ID,
		InputSHA256: collectInput.Hash, OutputSHA256: bundleReceipt.Hash,
		ExecutionContractSHA256: core.StageExecutionContractSHA256,
		ProductBuild:            run.ProductBuild,
	}); err != nil {
		t.Fatal(err)
	}

	transition(core.RunSynthesizing)
	report := core.ReportManifest{
		Title: "passing report", AnswerMarkdown: "supported answer [1]",
		Citations:   []core.Citation{{Marker: "[1]", SourceIDs: []string{"source-1"}, ClaimIDs: []string{"claim-1"}}},
		EvidenceIDs: []string{"ws-1"}, ArtifactHashes: []string{}, Uncertainties: []string{"test uncertainty"},
		KnowledgePatch: core.KnowledgePatch{SchemaVersion: core.KnowledgePatchSchemaV1,
			UnitRegistryVersion: core.CurrentUnitRegistryVersion, Entities: []core.KnowledgeEntity{}, Assertions: []core.KnowledgeAssertion{}},
	}
	publish(core.StageSynthesize, 0, "research.report", report)
	transition(core.RunReviewing)
	verdict := core.ReviewVerdict{
		CitationIntegrityPercent: 100,
		KnowledgeIntegrity:       &core.KnowledgeIntegrity{EvidenceIntegrityPercent: 100, UnsupportedAssertions: 0},
		CriticalErrors:           []string{},
		Scores: core.ReviewScores{TaskFulfillment: 4, ClaimSupport: 4, SourceQuality: 4,
			Completeness: 4, ReasoningAndUncertainty: 4, ClarityAndReproducibility: 4},
		RevisionRequests: []string{}, Summary: "passes",
	}
	publish(core.StageReview, 0, "research.review", verdict)
	run, err = database.SucceedRun(ctx, run.ID, run.Revision)
	if err != nil {
		t.Fatal(err)
	}
	indexFixtureMaterials(t, ctx, database, objects, run.ID)
	materializeFixtureKnowledge(t, ctx, database, objects, run, report)
	return run
}

func indexFixtureMaterials(t *testing.T, ctx context.Context, database *store.DB, objects *cas.Store, runID string) {
	t.Helper()
	materials, err := database.AdoptedMemoryMaterials(ctx, runID)
	if err != nil {
		t.Fatal(err)
	}
	for _, material := range materials {
		raw, err := objects.ReadVerified(material.BlobHash)
		if err != nil {
			t.Fatal(err)
		}
		text := string(raw)
		if material.ArtifactID != "" {
			var report core.ReportManifest
			if err := json.Unmarshal(raw, &report); err != nil {
				t.Fatal(err)
			}
			text = report.AnswerMarkdown
		}
		chunks := rag.ChunkText(text, rag.DefaultChunkRunes, rag.DefaultOverlapRunes)
		vectors := make([][]float32, len(chunks))
		for index := range vectors {
			vectors[index] = make([]float32, rag.EmbeddingDimensions)
			vectors[index][index%rag.EmbeddingDimensions] = 1
		}
		if _, err := database.IndexDocument(ctx, store.Document{
			ProjectID: material.ProjectID, ArtifactID: material.ArtifactID,
			Title: material.Title, BlobHash: material.BlobHash,
			EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
		}, chunks, vectors); err != nil {
			t.Fatal(err)
		}
	}
}

func materializeFixtureKnowledge(
	t *testing.T,
	ctx context.Context,
	database *store.DB,
	objects *cas.Store,
	run core.Run,
	report core.ReportManifest,
) {
	t.Helper()
	patchBytes, err := json.Marshal(report.KnowledgePatch)
	if err != nil {
		t.Fatal(err)
	}
	patchReceipt, err := objects.PutBytes(patchBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, patchReceipt, "application/json"); err != nil {
		t.Fatal(err)
	}
	initialHead, err := database.ActiveKnowledgeGeneration(ctx, run.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	ontologyReceipt, err := database.KnowledgeGenerationOntologyReceipt(ctx, run.ProjectID, initialHead.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	contract, err := knowledge.RunKnowledgeMaterializationContractSHA256(ontologyReceipt.CanonicalSHA256, patchReceipt.Hash)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := database.CreateKnowledgeGeneration(ctx, run.ProjectID, ontologyReceipt.OntologyID, contract)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL().ExecContext(ctx, `
UPDATE documents SET graph_adopt=1,updated_at=?
WHERE project_id=? AND status='ready'`, time.Now().UTC().Format(time.RFC3339Nano), run.ProjectID); err != nil {
		t.Fatal(err)
	}
	rows, err := database.SQL().QueryContext(ctx, `
SELECT c.id,d.blob_hash,c.text_hash,
       CASE WHEN COALESCE(d.artifact_id,'')='' THEN 'evidence' ELSE 'report' END
FROM documents d JOIN chunks c ON c.document_id=d.id
WHERE d.project_id=? AND d.status='ready'
ORDER BY d.id,c.ordinal,c.id`, run.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	projection := store.KnowledgeProjection{}
	for rows.Next() {
		var source store.KnowledgeSourceRecord
		if err := rows.Scan(&source.ChunkID, &source.BlobHash, &source.TextHash, &source.SourceKind); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		source.SourceLocator, err = json.Marshal(map[string]any{"run_id": run.ID})
		if err != nil {
			rows.Close()
			t.Fatal(err)
		}
		projection.Sources = append(projection.Sources, source)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	if len(projection.Sources) == 0 {
		t.Fatal("fixture materialization has no deterministic run sources")
	}
	if err := database.AppendKnowledgeProjection(ctx, run.ProjectID, candidate.ID, projection); err != nil {
		t.Fatal(err)
	}
	batch, err := database.CreateKnowledgeExtractionBatch(ctx, store.KnowledgeExtractionBatch{
		ProjectID: run.ProjectID, GenerationID: candidate.ID, ID: "kext_" + run.ID,
		RunID: run.ID, ArtifactID: run.ReportArtifactID, SourceKind: "report",
		ExtractorContractSHA256: knowledge.RunKnowledgeExtractorContractSHA256(), InputSHA256: reportArtifactHash(t, ctx, database, run),
	})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := database.SQL().ExecContext(ctx, `
UPDATE knowledge_extraction_batches
SET status='applied',output_sha256=?,patch_blob_hash=?,updated_at=?,completed_at=?
WHERE project_id=? AND generation_id=? AND id=? AND status='queued'`,
		patchReceipt.Hash, patchReceipt.Hash, now, now, run.ProjectID, candidate.ID, batch.ID); err != nil {
		t.Fatal(err)
	}
	snapshot, tripleCount, err := database.KnowledgeNQuads(ctx, run.ProjectID, candidate.ID, ontologyReceipt.OntologyID)
	if err != nil {
		t.Fatal(err)
	}
	snapshotReceipt, err := objects.PutBytes(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, snapshotReceipt, "application/n-quads"); err != nil {
		t.Fatal(err)
	}
	if err := database.AppendKnowledgeProjection(ctx, run.ProjectID, candidate.ID, store.KnowledgeProjection{
		Snapshots: []store.KnowledgeRDFSnapshotRecord{{
			ID: "krdf_" + snapshotReceipt.Hash[:32], Format: "n-quads", BlobHash: snapshotReceipt.Hash,
			DatasetSHA256: snapshotReceipt.Hash, TripleCount: tripleCount,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionKnowledgeGeneration(ctx, run.ProjectID, candidate.ID,
		store.KnowledgeBuilding, store.KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionKnowledgeGeneration(ctx, run.ProjectID, candidate.ID,
		store.KnowledgeValidating, store.KnowledgeReady, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ActivateKnowledgeGeneration(ctx, run.ProjectID, candidate.ID); err != nil {
		t.Fatal(err)
	}
}

func activateEvaluationTestKnowledge(t *testing.T, ctx context.Context, database *store.DB, objects *cas.Store, projectID string) {
	t.Helper()
	candidate, err := database.CreateKnowledgeGeneration(ctx, projectID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, tripleCount, err := database.KnowledgeNQuads(ctx, projectID, candidate.ID, store.CoreOntologyID)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, receipt, "application/n-quads"); err != nil {
		t.Fatal(err)
	}
	if err := database.AppendKnowledgeProjection(ctx, projectID, candidate.ID, store.KnowledgeProjection{
		Snapshots: []store.KnowledgeRDFSnapshotRecord{{
			ID: "krdf_" + receipt.Hash[:32], Format: "n-quads", BlobHash: receipt.Hash,
			DatasetSHA256: receipt.Hash, TripleCount: tripleCount,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionKnowledgeGeneration(ctx, projectID, candidate.ID, store.KnowledgeBuilding, store.KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionKnowledgeGeneration(ctx, projectID, candidate.ID, store.KnowledgeValidating, store.KnowledgeReady, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ActivateKnowledgeGeneration(ctx, projectID, candidate.ID); err != nil {
		t.Fatal(err)
	}
}

func reportArtifactHash(t *testing.T, ctx context.Context, database *store.DB, run core.Run) string {
	t.Helper()
	artifact, err := database.Artifact(ctx, run.ReportArtifactID)
	if err != nil {
		t.Fatal(err)
	}
	return artifact.BlobHash
}

func testProductBuildBinding() ProductBuildBinding {
	return ProductBuildBinding{
		Version: buildinfo.ReleaseProductVersion, ExecutableSHA256: strings.Repeat("a", 64),
		RuntimeManifestSHA256: strings.Repeat("b", 64), KnowledgeSidecarTreeSHA256: strings.Repeat("c", 64),
	}
}
