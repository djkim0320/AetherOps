package research

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/reportdocx"
	"github.com/djkim0320/AetherOps/internal/store"
)

// These deterministic protocol fixtures exercise only orchestration state,
// error handling, and persistence order. They do not represent an integrated
// Codex execution path or a release-quality research result.

func TestResearchProfileV2DefinesEveryStageAndRejectsUnknownVersions(t *testing.T) {
	wants := map[core.Stage]ModelProfile{
		core.StagePlan:       {Model: core.PlannerModel, ReasoningEffort: core.PlannerEffort, ServiceTier: core.ServiceTierDefault},
		core.StageCollect:    {Model: core.CollectorModel, ReasoningEffort: core.CollectorEffort, ServiceTier: core.ServiceTierDefault},
		core.StageSynthesize: {Model: core.PlannerModel, ReasoningEffort: core.PlannerEffort, ServiceTier: core.ServiceTierDefault},
		core.StageReview:     {Model: core.ReviewerModel, ReasoningEffort: core.ReviewerEffort, ServiceTier: core.ServiceTierDefault},
		core.StageRevise:     {Model: core.PlannerModel, ReasoningEffort: core.PlannerEffort, ServiceTier: core.ServiceTierDefault},
	}
	for stage, want := range wants {
		got, err := profileForStage(core.ResearchProfileVersionV2, stage)
		if err != nil || got != want {
			t.Fatalf("profile %s = %+v, err=%v, want %+v", stage, got, err, want)
		}
	}
	if _, err := profileForStage("", core.StagePlan); !errors.Is(err, ErrUnsupportedResearchProfile) {
		t.Fatalf("empty profile error = %v", err)
	}
	if _, err := profileForStage("research_future", core.StagePlan); !errors.Is(err, ErrUnsupportedResearchProfile) {
		t.Fatalf("future profile error = %v", err)
	}
}

func TestExecuteFailsClosedBeforeModelTurnWhenPinnedKnowledgeSnapshotIsMissing(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, standardResponder(false))
	engine, database, objects, initialRun := openResearchTest(t, fixture)
	candidate, err := database.CreateKnowledgeGeneration(ctx, initialRun.ProjectID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, tripleCount, err := database.KnowledgeNQuads(ctx, initialRun.ProjectID, candidate.ID, store.CoreOntologyID)
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
	if err := database.AppendKnowledgeProjection(ctx, initialRun.ProjectID, candidate.ID, store.KnowledgeProjection{
		Snapshots: []store.KnowledgeRDFSnapshotRecord{{
			ID: "krdf_" + receipt.Hash[:24], Format: "n-quads", BlobHash: receipt.Hash,
			DatasetSHA256: receipt.Hash, TripleCount: tripleCount,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionKnowledgeGeneration(ctx, initialRun.ProjectID, candidate.ID, store.KnowledgeBuilding, store.KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionKnowledgeGeneration(ctx, initialRun.ProjectID, candidate.ID, store.KnowledgeValidating, store.KnowledgeReady, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ActivateKnowledgeGeneration(ctx, initialRun.ProjectID, candidate.ID); err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, initialRun.ProjectID, "", "corrupt graph must not execute", "main-thread")
	if err != nil {
		t.Fatal(err)
	}
	if run.KnowledgeGenerationID != candidate.ID {
		t.Fatalf("run pinned generation = %s, want %s", run.KnowledgeGenerationID, candidate.ID)
	}
	if err := objects.Delete(receipt.Hash); err != nil {
		t.Fatal(err)
	}

	completed, err := engine.Execute(ctx, run.ID)
	if err == nil || !strings.Contains(err.Error(), "verify run-pinned knowledge generation") {
		t.Fatalf("missing snapshot did not fail closed: run=%+v err=%v", completed, err)
	}
	if completed.Status != core.RunFailed {
		t.Fatalf("corrupt graph run status = %s, want failed", completed.Status)
	}
	if calls := fixture.callsSnapshot(); len(calls) != 0 {
		t.Fatalf("model was called before graph verification: %+v", calls)
	}
	head, err := database.ActiveKnowledgeGeneration(ctx, initialRun.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != store.KnowledgeHeadFailed {
		t.Fatalf("corrupt active graph head status = %s, want failed", head.Status)
	}
}

func TestProtocolFixtureWorkflowStateAndArtifacts(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, standardResponder(false))
	engine, db, objects, run := openResearchTest(t, fixture)

	completed, err := engine.Execute(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != core.RunSucceeded {
		t.Fatalf("run status = %s, want %s", completed.Status, core.RunSucceeded)
	}
	if completed.ReportArtifactID == "" {
		t.Fatal("successful run did not adopt a final report artifact")
	}

	attempts, err := db.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 5 { // plan + two collectors + synthesize + review
		t.Fatalf("stage attempts = %d, want 5", len(attempts))
	}
	for _, attempt := range attempts {
		if attempt.Status != "completed" || attempt.OutputArtifactHash == "" {
			t.Fatalf("unexpected attempt: %+v", attempt)
		}
		if attempt.CodexThreadID == "" || attempt.CodexTurnID == "" {
			t.Fatalf("stage identity was not recorded: %+v", attempt)
		}
	}
	artifacts, err := db.ListArtifacts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(artifacts) != len(attempts)+1 {
		t.Fatalf("artifacts = %d, want %d stage outputs plus one Word report", len(artifacts), len(attempts))
	}
	var reportDocumentCount int
	for _, artifact := range artifacts {
		if _, err := objects.ReadVerified(artifact.BlobHash); err != nil {
			t.Fatalf("artifact %s is not a verified CAS object: %v", artifact.ID, err)
		}
		if artifact.Kind == reportdocx.ArtifactKind {
			reportDocumentCount++
			metadata, err := db.BlobMetadata(ctx, artifact.BlobHash)
			if err != nil {
				t.Fatal(err)
			}
			if metadata.MediaType != reportdocx.MediaType {
				t.Fatalf("Word report media type = %q", metadata.MediaType)
			}
		}
		shouldAdopt := artifact.ID == completed.ReportArtifactID || artifact.Kind == "research.evidence" || artifact.Kind == reportdocx.ArtifactKind
		if artifact.Adopted != shouldAdopt {
			t.Fatalf("artifact %s (%s) adopted=%v, want %v", artifact.ID, artifact.Kind, artifact.Adopted, shouldAdopt)
		}
	}
	if reportDocumentCount != 1 {
		t.Fatalf("Word report artifacts = %d, want 1", reportDocumentCount)
	}
	canonical, err := db.Artifact(ctx, completed.ReportArtifactID)
	if err != nil {
		t.Fatal(err)
	}
	if canonical.Kind != "research.report" {
		t.Fatalf("canonical report kind = %q, want structured research.report", canonical.Kind)
	}

	calls := fixture.callsSnapshot()
	if len(calls) != 5 {
		t.Fatalf("turn calls = %d, want 5", len(calls))
	}
	var collectThreads []string
	for _, call := range calls {
		switch schemaKind(call.Options.Schema) {
		case "plan", "report":
			if call.ThreadID != run.MainThreadID {
				t.Fatalf("main-thread stage used %q, want %q", call.ThreadID, run.MainThreadID)
			}
		case "evidence":
			if call.ThreadID == run.MainThreadID {
				t.Fatal("collector reused the project main thread")
			}
			collectThreads = append(collectThreads, call.ThreadID)
		case "review":
			if call.ThreadID == run.MainThreadID {
				t.Fatal("review reused the project main thread")
			}
		default:
			t.Fatalf("unexpected schema in turn options: %s", string(call.Options.Schema))
		}
		if err := fixedSchemaForCall(call.Options); err != nil {
			t.Fatal(err)
		}
	}
	sort.Strings(collectThreads)
	if len(collectThreads) != 2 || collectThreads[0] == collectThreads[1] {
		t.Fatalf("collector threads = %v, want two distinct worker threads", collectThreads)
	}
	created := fixture.threadCreatesSnapshot()
	if len(created) != 3 {
		t.Fatalf("isolated thread creates = %d, want two collectors plus one reviewer", len(created))
	}
	profileCounts := make(map[ModelProfile]int)
	stageCounts := make(map[core.Stage]int)
	for _, call := range created {
		profileCounts[call.Profile]++
		stageCounts[call.Stage]++
	}
	collectorProfile := ModelProfile{
		Model: core.CollectorModel, ReasoningEffort: core.CollectorEffort, ServiceTier: core.ServiceTierDefault,
	}
	reviewerProfile := ModelProfile{
		Model: core.ReviewerModel, ReasoningEffort: core.ReviewerEffort, ServiceTier: core.ServiceTierDefault,
	}
	if profileCounts[collectorProfile] != 2 || profileCounts[reviewerProfile] != 1 || len(profileCounts) != 2 {
		t.Fatalf("isolated thread profiles = %v, want collector x2 and reviewer x1", profileCounts)
	}
	if stageCounts[core.StageCollect] != 2 || stageCounts[core.StageReview] != 1 || len(stageCounts) != 2 {
		t.Fatalf("isolated thread roles = %v, want COLLECT x2 and REVIEW x1", stageCounts)
	}
}

func TestReviewFailsClosedWhenProtocolReusesAResearchThread(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, responderForPlan(1, false))
	fixture.threadIDForCreate = func(core.Stage, int) string { return "fixture-reused-worker-thread" }
	engine, database, _, run := openResearchTest(t, fixture)

	completed, err := engine.Execute(ctx, run.ID)
	if err == nil || !strings.Contains(err.Error(), "reviewer thread was already used by collect attempt") {
		t.Fatalf("reused reviewer thread result = status %s, error %v", completed.Status, err)
	}
	if completed.Status != core.RunFailed {
		t.Fatalf("reused reviewer thread status = %s, want failed", completed.Status)
	}
	for _, call := range fixture.callsSnapshot() {
		if call.Options.Stage == core.StageReview {
			t.Fatal("review turn started after its supposedly fresh session reused a research thread")
		}
	}
	attempts, listErr := database.ListStageAttempts(ctx, run.ID)
	if listErr != nil {
		t.Fatal(listErr)
	}
	if len(attempts) == 0 || attempts[len(attempts)-1].Stage != core.StageReview || attempts[len(attempts)-1].Status != "failed" {
		t.Fatalf("reused reviewer audit = %+v", attempts)
	}
}

func TestFailedReviewReplansCollectsAndMergesBeforeReviewingAgain(t *testing.T) {
	ctx := context.Background()
	planCalls := 0
	reviewCalls := 0
	base := responderForPlan(2, false)
	fixture := newProtocolFixture(t, func(ctx context.Context, threadID string, options TurnOptions) (json.RawMessage, error) {
		switch schemaKind(options.Schema) {
		case "plan":
			planCalls++
			var input planInput
			if err := json.Unmarshal(promptInput(options.Prompt), &input); err != nil {
				return nil, err
			}
			if planCalls == 1 && input.ResearchRemediation != nil {
				return nil, errors.New("initial PLAN unexpectedly received remediation")
			}
			if planCalls == 2 {
				if input.ResearchRemediation == nil ||
					input.ResearchRemediation.Action != core.ReviewRemediationAdditionalResearch ||
					len(input.ResearchRemediation.Tasks) != 1 ||
					!input.ResearchRemediation.Tasks[0].RequiresEngineering {
					return nil, fmt.Errorf("remediation PLAN input = %+v", input.ResearchRemediation)
				}
			}
			if planCalls == 3 && (input.ResearchRemediation == nil ||
				input.ResearchRemediation.Action != core.ReviewRemediationReplan ||
				input.ResearchRemediation.Cycle != 2) {
				return nil, fmt.Errorf("second remediation PLAN input = %+v", input.ResearchRemediation)
			}
			return mustJSONValue(testPlan("question", 2))
		case "review":
			reviewCalls++
			if reviewCalls <= 2 {
				verdict := testVerdict(false)
				verdict.RemediationAction = core.ReviewRemediationAdditionalResearch
				if reviewCalls == 2 {
					verdict.RemediationAction = core.ReviewRemediationReplan
				}
				verdict.RemediationTasks = []core.ReviewRemediationTask{{
					Objective:           "rerun the missing sensitivity analysis",
					RequiredEvidence:    []string{"fresh solver receipt", "parameter sensitivity"},
					RequiresEngineering: true,
				}}
				return mustJSONValue(verdict)
			}
			return mustJSONValue(testVerdict(true))
		default:
			return base(ctx, threadID, options)
		}
	})
	engine, database, _, run := openResearchTest(t, fixture)

	completed, err := engine.Execute(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != core.RunSucceeded || planCalls != 3 || reviewCalls != 3 {
		t.Fatalf("completed=%s plan/review=%d/%d", completed.Status, planCalls, reviewCalls)
	}
	reviewerThreads := map[string]struct{}{}
	for _, call := range fixture.callsSnapshot() {
		if call.Options.Stage != core.StageReview {
			continue
		}
		if call.ThreadID == run.MainThreadID {
			t.Fatal("remediation reviewer reused the project research thread")
		}
		reviewerThreads[call.ThreadID] = struct{}{}
	}
	if len(reviewerThreads) != 3 {
		t.Fatalf("reviewer sessions = %v, want one fresh session for each of three reviews", reviewerThreads)
	}
	remediation, err := database.LatestResearchRemediation(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if remediation.Cycle != 2 || remediation.Action != core.ReviewRemediationReplan || len(remediation.Tasks) != 1 {
		t.Fatalf("remediation = %+v", remediation)
	}
	attempts, err := database.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var superseded, activeCompleted, revisions int
	for _, attempt := range attempts {
		switch attempt.Status {
		case "superseded":
			superseded++
		case "completed":
			activeCompleted++
		default:
			t.Fatalf("unexpected stage after remediation: %+v", attempt)
		}
		if attempt.Stage == core.StageRevise {
			revisions++
		}
	}
	if superseded != 10 || activeCompleted != 5 || revisions != 0 {
		t.Fatalf("stage history superseded/active/revise = %d/%d/%d", superseded, activeCompleted, revisions)
	}
}

func TestResearchRemediationStopsAfterBoundedFreshCycles(t *testing.T) {
	ctx := context.Background()
	base := responderForPlan(1, false)
	planCalls := 0
	reviewCalls := 0
	fixture := newProtocolFixture(t, func(ctx context.Context, threadID string, options TurnOptions) (json.RawMessage, error) {
		switch schemaKind(options.Schema) {
		case "plan":
			planCalls++
			return mustJSONValue(testPlan("question", 1))
		case "review":
			reviewCalls++
			verdict := testVerdict(false)
			verdict.RemediationAction = core.ReviewRemediationAdditionalResearch
			verdict.RemediationTasks = []core.ReviewRemediationTask{{
				Objective:        "collect a genuinely missing source",
				RequiredEvidence: []string{"new primary evidence"},
			}}
			return mustJSONValue(verdict)
		default:
			return base(ctx, threadID, options)
		}
	})
	engine, database, _, run := openResearchTest(t, fixture)
	completed, err := engine.Execute(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != core.RunQualityFailed {
		t.Fatalf("run status = %s, want quality_failed", completed.Status)
	}
	if planCalls != core.MaxResearchRemediations+1 || reviewCalls != core.MaxResearchRemediations+1 {
		t.Fatalf("plan/review calls = %d/%d", planCalls, reviewCalls)
	}
	count, err := database.ResearchRemediationCount(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if count != core.MaxResearchRemediations {
		t.Fatalf("remediation cycles = %d, want %d", count, core.MaxResearchRemediations)
	}
}

func TestPlanCapabilityRecoveryRetriesDeterministicContractFailure(t *testing.T) {
	ctx := context.Background()
	base := standardResponder(false)
	planCalls := 0
	fixture := newProtocolFixture(t, func(ctx context.Context, threadID string, options TurnOptions) (json.RawMessage, error) {
		if schemaKind(options.Schema) != "plan" {
			return base(ctx, threadID, options)
		}
		planCalls++
		if planCalls == 1 {
			invalid := testPlan("XFOIL comparison", 1)
			invalid.Workstreams[0].Question = "run XFOIL without a structured contract"
			return mustJSONValue(invalid)
		}
		var input planInput
		if err := json.Unmarshal(promptInput(options.Prompt), &input); err != nil {
			return nil, err
		}
		if !strings.Contains(input.CapabilityRecoveryFeedback, "deterministic Go contract") ||
			!strings.Contains(input.CapabilityRecoveryFeedback, "Do not repeat") {
			return nil, errors.New("PLAN retry omitted capability recovery feedback")
		}
		return mustJSONValue(testPlan("question", 1))
	})
	engine, db, _, run := openResearchTest(t, fixture)

	completed, err := engine.Execute(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != core.RunSucceeded || planCalls != 2 {
		t.Fatalf("capability recovery result: status=%s plan_calls=%d", completed.Status, planCalls)
	}
	attempts, err := db.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	planAttempts := make([]core.StageAttempt, 0, 2)
	for _, attempt := range attempts {
		if attempt.Stage == core.StagePlan {
			planAttempts = append(planAttempts, attempt)
		}
	}
	if len(planAttempts) != 2 || planAttempts[0].Status != "superseded" || planAttempts[1].Status != "completed" {
		t.Fatalf("PLAN recovery attempts = %+v", planAttempts)
	}
}

func TestEngineeringPoliciesAssignScreeningAndIndependentVerificationToCorrectStages(t *testing.T) {
	for _, required := range []string{"bundled first-party typed engineering tools", "intentionally not returned by aetherops_internal.tool_catalog", "COLLECT ordinal 0", "su2_cfd", "engineering_inputs", "su2_cases", "no built-in geometry", "every listed screening candidate", "panel_count=240", "alpha_step_deg=0.05", "AetherOps itself", "one-degree local alpha window", "does not repeat the full screening"} {
		if !strings.Contains(engineeringPlanningPolicy, required) {
			t.Fatalf("planning policy omits %q", required)
		}
	}
	for _, required := range []string{"exactly once", "every candidate", "overrides any workstream prose", "separate verification attempt", "plan.su2_cases", "engineering_inputs", "Every input and physics choice must be explicit"} {
		if !strings.Contains(collectEngineeringPolicy, required) {
			t.Fatalf("collection policy omits %q", required)
		}
	}
	for _, required := range []string{"su2_cases", "engineering_inputs", "no predefined case", "never authorizes implicit geometry"} {
		if !strings.Contains(su2ExecutionModePolicy, required) {
			t.Fatalf("SU2 execution-mode policy omits %q", required)
		}
	}
}

func TestEngineCanonicalizesSameRawClaimIDAcrossCollectorsBeforeSynthesisAndReview(t *testing.T) {
	ctx := context.Background()
	var synthesisClaimIDs []string
	var reviewClaimIDs []string
	responder := func(_ context.Context, _ string, options TurnOptions) (json.RawMessage, error) {
		switch schemaKind(options.Schema) {
		case "plan":
			return mustJSONValue(testPlan("question", 2))
		case "evidence":
			var input collectInput
			if err := json.Unmarshal(promptInput(options.Prompt), &input); err != nil {
				return nil, err
			}
			bundle := testEvidence(input.Workstream.ID)
			bundle.Claims[0].ID = "shared-model-claim"
			return mustJSONValue(collectorOutputForBundle(bundle))
		case "report":
			var input synthesizeInput
			if err := json.Unmarshal(promptInput(options.Prompt), &input); err != nil {
				return nil, err
			}
			for _, bundle := range input.Evidence {
				if len(bundle.Claims) != 1 || !canonicalEvidenceClaimIDPattern.MatchString(bundle.Claims[0].ID) {
					return nil, fmt.Errorf("synthesis received non-canonical claims: %+v", input.Evidence)
				}
				synthesisClaimIDs = append(synthesisClaimIDs, bundle.Claims[0].ID)
			}
			if len(synthesisClaimIDs) != 2 || synthesisClaimIDs[0] == synthesisClaimIDs[1] {
				return nil, fmt.Errorf("synthesis claim identities are ambiguous: %v", synthesisClaimIDs)
			}
			return mustJSONValue(testReportForEvidence(input.Evidence))
		case "review":
			var input reviewInput
			if err := json.Unmarshal(promptInput(options.Prompt), &input); err != nil {
				return nil, err
			}
			for _, bundle := range input.Evidence {
				reviewClaimIDs = append(reviewClaimIDs, bundle.Claims[0].ID)
			}
			return mustJSONValue(testVerdict(true))
		default:
			return nil, fmt.Errorf("unexpected response schema %s", string(options.Schema))
		}
	}
	fixture := newProtocolFixture(t, responder)
	engine, database, objects, run := openResearchTest(t, fixture)
	completed, err := engine.Execute(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != core.RunSucceeded {
		t.Fatalf("run status = %s, want succeeded", completed.Status)
	}
	if !slices.Equal(reviewClaimIDs, synthesisClaimIDs) {
		t.Fatalf("review claims = %v, want synthesis identities %v", reviewClaimIDs, synthesisClaimIDs)
	}
	attempts, err := database.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var durableClaimIDs []string
	for _, attempt := range attempts {
		if attempt.Stage != core.StageCollect {
			continue
		}
		output, err := objects.ReadVerified(attempt.OutputArtifactHash)
		if err != nil {
			t.Fatal(err)
		}
		bundle, err := decodeStrict[core.EvidenceBundle](output)
		if err != nil {
			t.Fatal(err)
		}
		durableClaimIDs = append(durableClaimIDs, bundle.Claims[0].ID)
	}
	slices.Sort(durableClaimIDs)
	wantDurable := append([]string(nil), synthesisClaimIDs...)
	slices.Sort(wantDurable)
	if !slices.Equal(durableClaimIDs, wantDurable) {
		t.Fatalf("durable collector claims = %v, want canonical synthesis identities %v", durableClaimIDs, wantDurable)
	}
	checkpoint, err := engine.loadCheckpoint(ctx, completed)
	if err != nil {
		t.Fatalf("canonical checkpoint failed restart readback: %v", err)
	}
	if len(checkpoint.evidence) != 2 {
		t.Fatalf("restart checkpoint evidence = %d, want 2", len(checkpoint.evidence))
	}
}

func TestExecuteReconcilesMultipleApprovalRevisionRoundTripsBeforeSynthesis(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, responderForPlan(1, false))
	engine, database, _, initialRun := openResearchTest(t, fixture)
	originalBeforeTurn := fixture.beforeTurn
	var approvalOnce sync.Once
	var approvalErr error
	fixture.beforeTurn = func(turnContext context.Context, options TurnOptions) error {
		if err := originalBeforeTurn(turnContext, options); err != nil {
			return err
		}
		if schemaKind(options.Schema) != "evidence" {
			return nil
		}
		envelope, err := decodeFixturePrompt(options.Prompt)
		if err != nil {
			return err
		}
		approvalOnce.Do(func() {
			attempt, err := database.StageAttempt(turnContext, envelope.RunID, envelope.StageAttemptID)
			if err != nil {
				approvalErr = err
				return
			}
			for index := range 2 {
				approval, err := database.CreateApproval(turnContext, core.Approval{
					RunID: envelope.RunID, StageAttemptID: envelope.StageAttemptID,
					ThreadID: attempt.CodexThreadID, TurnID: fmt.Sprintf("approval-turn-%d", index),
					ItemID: fmt.Sprintf("approval-item-%d", index), Kind: "item/commandExecution/requestApproval",
					Summary: "deterministic approval revision round-trip", Risk: "read_only",
				})
				if err != nil {
					approvalErr = err
					return
				}
				current, err := database.Run(turnContext, envelope.RunID)
				if err != nil {
					approvalErr = err
					return
				}
				if current.Status != core.RunCollecting {
					approvalErr = fmt.Errorf("approval round-trip started from %s", current.Status)
					return
				}
				if _, err := database.TransitionRun(
					turnContext, current.ID, current.Revision, core.RunWaitingApproval, "",
				); err != nil {
					approvalErr = err
					return
				}
				if _, err := database.DecideActiveApproval(turnContext, approval.ID, "approved"); err != nil {
					approvalErr = err
					return
				}
				resumed, err := database.ResumeRunAfterApproval(turnContext, current.ID, core.RunCollecting)
				if err != nil {
					approvalErr = err
					return
				}
				if resumed.Status != core.RunCollecting {
					approvalErr = fmt.Errorf("approval round-trip resumed to %s", resumed.Status)
					return
				}
			}
		})
		return approvalErr
	}

	completed, err := engine.Execute(ctx, initialRun.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != core.RunSucceeded {
		t.Fatalf("run status = %s, want succeeded", completed.Status)
	}
	// queued->planning->collecting, two waiting/resume pairs, then
	// synthesizing->reviewing->succeeded.
	if completed.Revision != 9 {
		t.Fatalf("run revision = %d, want 9", completed.Revision)
	}
	var synthesisCalls int
	for _, call := range fixture.callsSnapshot() {
		if schemaKind(call.Options.Schema) == "report" {
			synthesisCalls++
		}
	}
	if synthesisCalls != 1 {
		t.Fatalf("synthesis calls = %d, want 1", synthesisCalls)
	}
}

func TestExecuteRejectsNonApprovalRevisionAdvanceBeforeSynthesis(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, responderForPlan(1, false))
	engine, database, _, initialRun := openResearchTest(t, fixture)
	originalBeforeTurn := fixture.beforeTurn
	var mutateOnce sync.Once
	var mutationErr error
	fixture.beforeTurn = func(turnContext context.Context, options TurnOptions) error {
		if err := originalBeforeTurn(turnContext, options); err != nil {
			return err
		}
		if schemaKind(options.Schema) != "evidence" {
			return nil
		}
		envelope, err := decodeFixturePrompt(options.Prompt)
		if err != nil {
			return err
		}
		mutateOnce.Do(func() {
			current, err := database.Run(turnContext, envelope.RunID)
			if err != nil {
				mutationErr = err
				return
			}
			_, mutationErr = database.SetRunCycle(turnContext, current.ID, current.Revision, 1)
		})
		return mutationErr
	}

	completed, err := engine.Execute(ctx, initialRun.ID)
	if !errors.Is(err, ErrRunStateChanged) {
		t.Fatalf("non-approval revision error = %v, want %v", err, ErrRunStateChanged)
	}
	if completed.Status != core.RunFailed {
		t.Fatalf("run status = %s, want failed", completed.Status)
	}
	if completed.ID != initialRun.ID || strings.Contains(err.Error(), "sql: no rows") {
		t.Fatalf("conflict lost the authoritative run identity: run=%q err=%v", completed.ID, err)
	}
	for _, call := range fixture.callsSnapshot() {
		if schemaKind(call.Options.Schema) == "report" {
			t.Fatal("unexplained revision advance incorrectly reached synthesis")
		}
	}
}

func TestExecuteRejectsUnexplainedSameContractRevisionAdvanceBeforeSynthesis(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, responderForPlan(1, false))
	engine, database, _, initialRun := openResearchTest(t, fixture)
	originalBeforeTurn := fixture.beforeTurn
	var mutateOnce sync.Once
	var mutationErr error
	fixture.beforeTurn = func(turnContext context.Context, options TurnOptions) error {
		if err := originalBeforeTurn(turnContext, options); err != nil {
			return err
		}
		if schemaKind(options.Schema) != "evidence" {
			return nil
		}
		envelope, err := decodeFixturePrompt(options.Prompt)
		if err != nil {
			return err
		}
		mutateOnce.Do(func() {
			current, err := database.Run(turnContext, envelope.RunID)
			if err != nil {
				mutationErr = err
				return
			}
			// Preserve every durable contract field while advancing only the
			// optimistic-concurrency token. There is deliberately no matching
			// approval transition audit pair, so the engine must fail closed.
			_, mutationErr = database.SetRunCycle(
				turnContext, current.ID, current.Revision, current.RevisionCycle,
			)
		})
		return mutationErr
	}

	completed, err := engine.Execute(ctx, initialRun.ID)
	if !errors.Is(err, ErrRunStateChanged) {
		t.Fatalf("unexplained same-contract revision error = %v, want %v", err, ErrRunStateChanged)
	}
	if completed.Status != core.RunFailed || completed.ID != initialRun.ID {
		t.Fatalf("unexplained revision result = id %q status %s", completed.ID, completed.Status)
	}
	if strings.Contains(err.Error(), "sql: no rows") {
		t.Fatalf("unexplained revision lost the authoritative run identity: %v", err)
	}
}

func TestSetRunCycleReconcilesRevisingApprovalRoundTrip(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, responderForPlan(1, false))
	engine, database, _, run := openResearchTest(t, fixture)
	var err error
	for _, status := range []core.RunStatus{
		core.RunPlanning, core.RunCollecting, core.RunSynthesizing, core.RunReviewing, core.RunRevising,
	} {
		run, err = database.TransitionRun(ctx, run.ID, run.Revision, status, "")
		if err != nil {
			t.Fatal(err)
		}
	}
	attempt, err := database.BeginStage(ctx, run.ID, core.StageRevise, 1, run.MainThreadID, "")
	if err != nil {
		t.Fatal(err)
	}
	snapshot := run
	approval, err := database.CreateApproval(ctx, core.Approval{
		RunID: run.ID, StageAttemptID: attempt.ID, ThreadID: attempt.CodexThreadID,
		TurnID: "revise-approval-turn", ItemID: "revise-approval-item",
		Kind: "item/commandExecution/requestApproval", Summary: "revise approval", Risk: "read_only",
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunWaitingApproval, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.DecideActiveApproval(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	run, err = database.ResumeRunAfterApproval(ctx, run.ID, core.RunRevising)
	if err != nil {
		t.Fatal(err)
	}
	updated, err := engine.setRunCycle(ctx, snapshot, 1)
	if err != nil {
		t.Fatal(err)
	}
	if updated.RevisionCycle != 1 || updated.Revision != run.Revision+1 {
		t.Fatalf("cycle update = cycle %d revision %d, want cycle 1 revision %d", updated.RevisionCycle, updated.Revision, run.Revision+1)
	}
}

func TestAbortPreservesAlreadyInterruptedRun(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, standardResponder(false))
	engine, database, _, run := openResearchTest(t, fixture)
	var err error
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunInterrupted, "turn interrupted")
	if err != nil {
		t.Fatal(err)
	}

	completed, abortErr := engine.abort(ctx, run, ErrTurnInterrupted)
	if !errors.Is(abortErr, ErrTurnInterrupted) {
		t.Fatalf("abort error = %v, want %v", abortErr, ErrTurnInterrupted)
	}
	if completed.Status != core.RunInterrupted || completed.Revision != run.Revision {
		t.Fatalf("idempotent abort changed interrupted run to %s revision %d", completed.Status, completed.Revision)
	}
}

func TestPlannerQuestionEchoIsReplacedByImmutableRunQuestion(t *testing.T) {
	ctx := context.Background()
	base := standardResponder(false)
	fixture := newProtocolFixture(t, func(ctx context.Context, threadID string, options TurnOptions) (json.RawMessage, error) {
		if schemaKind(options.Schema) == "plan" {
			return mustJSONValue(testPlan("summarized instead of echoed", 2))
		}
		return base(ctx, threadID, options)
	})
	engine, db, objects, run := openResearchTest(t, fixture)

	completed, err := engine.Execute(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != core.RunSucceeded {
		t.Fatalf("run status = %s, want succeeded", completed.Status)
	}
	attempts, err := db.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var planAttempt *core.StageAttempt
	for index := range attempts {
		if attempts[index].Stage == core.StagePlan {
			planAttempt = &attempts[index]
			break
		}
	}
	if planAttempt == nil {
		t.Fatal("completed run has no plan attempt")
	}
	encoded, err := objects.ReadVerified(planAttempt.OutputArtifactHash)
	if err != nil {
		t.Fatal(err)
	}
	var plan core.ResearchPlan
	if err := json.Unmarshal(encoded, &plan); err != nil {
		t.Fatal(err)
	}
	if plan.Question != run.Question {
		t.Fatalf("stored plan question = %q, want immutable run question %q", plan.Question, run.Question)
	}
}

func TestRunChatConfigurationIsDurableButIgnoredByResearchStages(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, standardResponder(false))
	configuration := core.RunConfiguration{
		Model: "chat-only-model", ReasoningEffort: "low", ServiceTier: core.ServiceTierFast,
	}
	engine, db, _, run := openResearchTestConfigured(t, fixture, configuration)

	completed, err := engine.Execute(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != core.RunSucceeded {
		t.Fatalf("run status = %s, want %s", completed.Status, core.RunSucceeded)
	}
	stored, err := db.Run(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Model != configuration.Model || stored.ReasoningEffort != configuration.ReasoningEffort || stored.ServiceTier != configuration.ServiceTier {
		t.Fatalf("stored run configuration = %s/%s/%s", stored.Model, stored.ReasoningEffort, stored.ServiceTier)
	}
	if stored.ResearchProfileVersion != core.CurrentResearchProfileVersion {
		t.Fatalf("stored research profile = %q, want %q", stored.ResearchProfileVersion, core.CurrentResearchProfileVersion)
	}
	for _, call := range fixture.callsSnapshot() {
		if err := fixedSchemaForCall(call.Options); err != nil {
			t.Fatal(err)
		}
		if call.Options.ServiceTier != core.ServiceTierDefault {
			t.Fatalf("research stage used UI speed %q instead of standard", call.Options.ServiceTier)
		}
	}
}

func TestProtocolFixtureFailedReviewsStopAfterThreeRevisions(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, standardResponder(true))
	engine, db, _, run := openResearchTest(t, fixture)

	completed, err := engine.Execute(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != core.RunQualityFailed {
		t.Fatalf("run status = %s, want %s", completed.Status, core.RunQualityFailed)
	}
	if completed.RevisionCycle != core.MaxRevisions {
		t.Fatalf("revision cycle = %d, want %d", completed.RevisionCycle, core.MaxRevisions)
	}
	attempts, err := db.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var reviews, revisions int
	reviewThreads := map[string]struct{}{}
	for _, attempt := range attempts {
		switch attempt.Stage {
		case core.StageReview:
			reviews++
			reviewThreads[attempt.CodexThreadID] = struct{}{}
		case core.StageRevise:
			revisions++
			if attempt.CodexThreadID != run.MainThreadID {
				t.Fatalf("revision %d did not resume main thread", attempt.Ordinal)
			}
		}
	}
	if reviews != core.MaxRevisions+1 || revisions != core.MaxRevisions {
		t.Fatalf("reviews/revisions = %d/%d, want %d/%d", reviews, revisions, core.MaxRevisions+1, core.MaxRevisions)
	}
	if len(reviewThreads) != reviews {
		t.Fatalf("review threads = %d, want one isolated thread per review", len(reviewThreads))
	}
	artifacts, err := db.ListArtifacts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, artifact := range artifacts {
		if artifact.Kind == reportdocx.ArtifactKind {
			t.Fatalf("quality-failed run published a Word report through artifact %s", artifact.ID)
		}
		if (artifact.Kind == "research.report" || artifact.Kind == "research.report.revision") && artifact.Adopted {
			t.Fatalf("quality-failed knowledge patch was adopted through artifact %s", artifact.ID)
		}
	}
}

func TestProtocolFixtureInvalidJSONFailsStageAndRun(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, func(_ context.Context, _ string, options TurnOptions) (json.RawMessage, error) {
		if schemaKind(options.Schema) != "plan" {
			return nil, fmt.Errorf("unexpected stage after invalid plan: %s", schemaKind(options.Schema))
		}
		return json.RawMessage(`{"question":"question","mode":"general","workstreams":[],"source_requirements":[],"acceptance_criteria":[]}`), nil
	})
	engine, db, _, run := openResearchTest(t, fixture)

	completed, err := engine.Execute(ctx, run.ID)
	if err == nil {
		t.Fatal("invalid JSON response unexpectedly completed")
	}
	if completed.Status != core.RunFailed {
		t.Fatalf("run status = %s, want failed", completed.Status)
	}
	attempts, err := db.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 1 || attempts[0].Status != "failed" || attempts[0].OutputArtifactHash != "" {
		t.Fatalf("unexpected failed stage record: %+v", attempts)
	}
	artifacts, err := db.ListArtifacts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(artifacts) != 0 {
		t.Fatalf("invalid output published %d artifacts", len(artifacts))
	}
}

func TestKnowledgePatchSpanHashMismatchFailsBeforeReview(t *testing.T) {
	ctx := context.Background()
	base := standardResponder(false)
	fixture := newProtocolFixture(t, func(ctx context.Context, threadID string, options TurnOptions) (json.RawMessage, error) {
		if schemaKind(options.Schema) != "report" {
			return base(ctx, threadID, options)
		}
		var input synthesizeInput
		if err := json.Unmarshal(promptInput(options.Prompt), &input); err != nil {
			return nil, err
		}
		report := testReportForEvidence(input.Evidence)
		report.KnowledgePatch.Assertions[0].Evidence[0].SpanHash = strings.Repeat("f", 64)
		return mustJSONValue(report)
	})
	engine, db, _, run := openResearchTest(t, fixture)

	completed, err := engine.Execute(ctx, run.ID)
	if err == nil || !strings.Contains(err.Error(), "span hash") {
		t.Fatalf("span mismatch error = %v", err)
	}
	if completed.Status != core.RunFailed {
		t.Fatalf("run status = %s, want failed", completed.Status)
	}
	attempts, err := db.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, attempt := range attempts {
		if attempt.Stage == core.StageReview {
			t.Fatal("cryptographically invalid knowledge patch reached REVIEW")
		}
	}
}

func TestLegacyReportWithoutKnowledgePatchFailsClosed(t *testing.T) {
	ctx := context.Background()
	base := standardResponder(false)
	fixture := newProtocolFixture(t, func(ctx context.Context, threadID string, options TurnOptions) (json.RawMessage, error) {
		if schemaKind(options.Schema) != "report" {
			return base(ctx, threadID, options)
		}
		var input synthesizeInput
		if err := json.Unmarshal(promptInput(options.Prompt), &input); err != nil {
			return nil, err
		}
		report := testReportForEvidence(input.Evidence)
		report.KnowledgePatch = core.KnowledgePatch{}
		return mustJSONValue(report)
	})
	engine, _, _, run := openResearchTest(t, fixture)
	completed, err := engine.Execute(ctx, run.ID)
	if err == nil || completed.Status != core.RunFailed {
		t.Fatalf("legacy manifest completed=%s err=%v", completed.Status, err)
	}
	for _, call := range fixture.callsSnapshot() {
		if schemaKind(call.Options.Schema) == "review" {
			t.Fatal("manifest without knowledge_patch reached REVIEW")
		}
	}
}

func TestLegacyReviewWithoutKnowledgeIntegrityFailsClosed(t *testing.T) {
	ctx := context.Background()
	base := standardResponder(false)
	fixture := newProtocolFixture(t, func(ctx context.Context, threadID string, options TurnOptions) (json.RawMessage, error) {
		if schemaKind(options.Schema) != "review" {
			return base(ctx, threadID, options)
		}
		verdict := testVerdict(true)
		verdict.KnowledgeIntegrity = nil
		return mustJSONValue(verdict)
	})
	engine, _, _, run := openResearchTest(t, fixture)
	completed, err := engine.Execute(ctx, run.ID)
	if err == nil || completed.Status != core.RunFailed {
		t.Fatalf("legacy review completed=%s err=%v", completed.Status, err)
	}
	for _, call := range fixture.callsSnapshot() {
		if schemaKind(call.Options.Schema) == "report" && strings.Contains(call.Options.Prompt, `"review"`) {
			t.Fatal("review without knowledge_integrity triggered a revision turn")
		}
	}
}

func TestProtocolFixtureWorkerCreationFailureFailsRunWithoutSynthesis(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, responderForPlan(1, false))
	fixture.createErr = errors.New("fixture worker creation failed")
	engine, db, _, run := openResearchTest(t, fixture)

	completed, err := engine.Execute(ctx, run.ID)
	if err == nil {
		t.Fatal("worker creation failure unexpectedly completed")
	}
	if completed.Status != core.RunFailed {
		t.Fatalf("run status = %s, want failed", completed.Status)
	}
	attempts, err := db.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 2 || attempts[0].Status != "completed" || attempts[1].Status != "failed" {
		t.Fatalf("unexpected plan/collector state after worker failure: %+v", attempts)
	}
	for _, call := range fixture.callsSnapshot() {
		if schemaKind(call.Options.Schema) == "report" || schemaKind(call.Options.Schema) == "review" {
			t.Fatalf("worker failure incorrectly advanced to %s", schemaKind(call.Options.Schema))
		}
	}
}

func TestCollectorValidationFailureRetiresConcurrentPendingApproval(t *testing.T) {
	ctx := context.Background()
	var database *store.DB
	pendingReady := make(chan struct{})
	slowWorkerCancelled := make(chan struct{})
	releaseSlowWorker := make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(releaseSlowWorker) }) })
	var approvalID string
	fixture := newProtocolFixture(t, func(turnContext context.Context, threadID string, options TurnOptions) (json.RawMessage, error) {
		switch schemaKind(options.Schema) {
		case "plan":
			return mustJSONValue(testPlan("question", 2))
		case "evidence":
			envelope, err := decodeFixturePrompt(options.Prompt)
			if err != nil {
				return nil, err
			}
			var input collectInput
			if err := json.Unmarshal(envelope.Task, &input); err != nil {
				return nil, err
			}
			if input.Workstream.ID == "workstream-0" {
				approval, err := database.CreateApproval(turnContext, core.Approval{
					RunID: envelope.RunID, StageAttemptID: envelope.StageAttemptID,
					ThreadID: threadID, TurnID: "fixture-pending-turn", ItemID: "fixture-command",
					Kind: "item/commandExecution/requestApproval", Summary: "download source bytes",
					Command: "powershell Invoke-WebRequest https://example.test/source",
					Risk:    "external_side_effect", ExternalSideEffect: true,
				})
				if err != nil {
					return nil, err
				}
				run, err := database.Run(turnContext, envelope.RunID)
				if err != nil {
					return nil, err
				}
				if _, err := database.TransitionRun(turnContext, run.ID, run.Revision, core.RunWaitingApproval, ""); err != nil {
					return nil, err
				}
				approvalID = approval.ID
				close(pendingReady)
				<-turnContext.Done()
				close(slowWorkerCancelled)
				<-releaseSlowWorker
				return nil, turnContext.Err()
			}
			select {
			case <-pendingReady:
			case <-turnContext.Done():
				return nil, turnContext.Err()
			}
			invalid := testEvidence(input.Workstream.ID)
			invalid.Sources[0].CapturedAt = time.Time{}
			return mustJSONValue(collectorOutputForBundle(invalid))
		default:
			return nil, fmt.Errorf("unexpected stage after collector failure: %s", schemaKind(options.Schema))
		}
	})
	engine, db, _, run := openResearchTest(t, fixture)
	database = db

	type executionOutcome struct {
		run core.Run
		err error
	}
	executionDone := make(chan executionOutcome, 1)
	go func() {
		completed, err := engine.Execute(ctx, run.ID)
		executionDone <- executionOutcome{run: completed, err: err}
	}()

	select {
	case <-slowWorkerCancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("collector failure did not cancel the sibling worker")
	}
	// The first non-context failure must have committed the terminal run and
	// approval retirement before cancellation becomes visible to its sibling.
	quiesced, err := db.Run(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if quiesced.Status != core.RunFailed {
		t.Fatalf("run status while sibling is still returning = %s, want failed", quiesced.Status)
	}
	if _, err := db.DecideActiveApproval(ctx, approvalID, "approved"); !errors.Is(err, store.ErrApprovalNotActive) {
		t.Fatalf("late approval decision error = %v, want %v", err, store.ErrApprovalNotActive)
	}
	attempts, err := db.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, attempt := range attempts {
		if attempt.Stage == core.StageCollect && attempt.ExternalSideEffects {
			t.Fatalf("late approval marked an external side effect: %+v", attempt)
		}
	}
	select {
	case outcome := <-executionDone:
		t.Fatalf("engine returned before the cancelled sibling: run=%s err=%v", outcome.run.Status, outcome.err)
	default:
	}
	releaseOnce.Do(func() { close(releaseSlowWorker) })

	var outcome executionOutcome
	select {
	case outcome = <-executionDone:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for failed collection to finish")
	}
	completed, err := outcome.run, outcome.err
	if err == nil || !strings.Contains(err.Error(), "invalid capture time") {
		t.Fatalf("collector failure error = %v", err)
	}
	if completed.Status != core.RunFailed {
		t.Fatalf("run status = %s, want failed", completed.Status)
	}
	if completed.Error == "" {
		t.Fatal("terminal collector failure omitted durable error")
	}
	pending, err := db.ListPendingApprovals(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("collector failure left orphan approvals: %+v", pending)
	}
	attempts, err = db.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var failedCollectors int
	for _, attempt := range attempts {
		if attempt.Stage == core.StageCollect {
			failedCollectors++
			if attempt.Status != "failed" {
				t.Fatalf("collector attempt remained %s: %+v", attempt.Status, attempt)
			}
		}
	}
	if failedCollectors != 2 {
		t.Fatalf("failed collector count = %d, want 2", failedCollectors)
	}
	for _, call := range fixture.callsSnapshot() {
		if schemaKind(call.Options.Schema) == "report" || schemaKind(call.Options.Schema) == "review" {
			t.Fatalf("failed collection advanced to %s", schemaKind(call.Options.Schema))
		}
	}
	events, err := db.EventsAfter(ctx, 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	var retired bool
	var failedTransitions int
	failedSeen := false
	for _, event := range events {
		if event.RunID != run.ID {
			continue
		}
		if event.Kind == "approval.retired" {
			retired = true
		}
		if event.Kind == "run.transition" {
			var transition struct {
				To core.RunStatus `json:"to"`
			}
			if err := json.Unmarshal(event.Payload, &transition); err != nil {
				t.Fatal(err)
			}
			if failedSeen {
				t.Fatalf("run transitioned again after collector failure: %s", transition.To)
			}
			if transition.To == core.RunFailed {
				failedTransitions++
				failedSeen = true
			}
		}
	}
	if !retired {
		t.Fatal("collector failure did not audit approval retirement")
	}
	if failedTransitions != 1 {
		t.Fatalf("failed transitions = %d, want exactly one", failedTransitions)
	}
}

func TestAbortIsIdempotentWhenCollectorAlreadyQuiescedUncertain(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, responderForPlan(1, false))
	engine, db, objects, queued := openResearchTest(t, fixture)

	run, err := db.TransitionRun(ctx, queued.ID, queued.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	input, err := objects.PutBytes([]byte(`{"collector":"uncertain"}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, input, "application/json"); err != nil {
		t.Fatal(err)
	}
	attempt, err := db.BeginStage(ctx, run.ID, core.StageCollect, 0, "collector-thread", input.Hash)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.MarkStageExternalSideEffects(ctx, attempt.ID); err != nil {
		t.Fatal(err)
	}

	cause := errors.New("original collector execution failure")
	quiesced, err := db.FailCollectStageAndQuiesceRun(ctx, attempt.ID, "", cause.Error())
	if err != nil {
		t.Fatal(err)
	}
	if quiesced.Status != core.RunUncertain || quiesced.Error != cause.Error() {
		t.Fatalf("quiesced run = %s/%q, want uncertain/%q", quiesced.Status, quiesced.Error, cause)
	}

	completed, abortErr := engine.abort(ctx, run, cause)
	if abortErr != cause {
		t.Fatalf("abort error = %v, want original cause identity", abortErr)
	}
	if completed.Status != core.RunUncertain || completed.Revision != quiesced.Revision || completed.Error != cause.Error() {
		t.Fatalf("idempotent abort changed uncertain run: before=%+v after=%+v", quiesced, completed)
	}

	events, err := db.EventsAfter(ctx, 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	var uncertainTransitions int
	for _, event := range events {
		if event.RunID != run.ID || event.Kind != "run.transition" {
			continue
		}
		var transition struct {
			To core.RunStatus `json:"to"`
		}
		if err := json.Unmarshal(event.Payload, &transition); err != nil {
			t.Fatal(err)
		}
		if transition.To == core.RunUncertain {
			uncertainTransitions++
		}
	}
	if uncertainTransitions != 1 {
		t.Fatalf("uncertain transitions = %d, want exactly one", uncertainTransitions)
	}
}

func TestAbortTreatsCancellationAfterApprovedExternalSideEffectAsUncertain(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, responderForPlan(1, false))
	engine, database, _, queued := openResearchTest(t, fixture)
	run, err := database.TransitionRun(ctx, queued.ID, queued.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(ctx, run.ID, core.StagePlan, 0, run.MainThreadID, "approved-external-input")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MarkStageExternalSideEffects(ctx, attempt.ID); err != nil {
		t.Fatal(err)
	}
	if err := database.CompleteStage(ctx, attempt.ID, "", context.Canceled.Error()); err != nil {
		t.Fatal(err)
	}

	completed, err := engine.abort(ctx, run, context.Canceled)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("abort error = %v, want context cancellation", err)
	}
	if completed.Status != core.RunUncertain {
		t.Fatalf("approved external cancellation status = %s, want uncertain", completed.Status)
	}
}

func TestConcurrentCollectorUncertaintyPreservesFirstCauseWithoutRetransition(t *testing.T) {
	ctx := context.Background()
	var database *store.DB
	slowStarted := make(chan struct{})
	slowCancelled := make(chan struct{})
	releaseSlow := make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(releaseSlow) }) })
	collectorFailure := errors.New("fixture external collector failure")

	fixture := newProtocolFixture(t, func(turnContext context.Context, _ string, options TurnOptions) (json.RawMessage, error) {
		switch schemaKind(options.Schema) {
		case "plan":
			return mustJSONValue(testPlan("question", 2))
		case "evidence":
			envelope, err := decodeFixturePrompt(options.Prompt)
			if err != nil {
				return nil, err
			}
			var input collectInput
			if err := json.Unmarshal(envelope.Task, &input); err != nil {
				return nil, err
			}
			if input.Workstream.ID == "workstream-0" {
				close(slowStarted)
				<-turnContext.Done()
				close(slowCancelled)
				<-releaseSlow
				return nil, turnContext.Err()
			}
			select {
			case <-slowStarted:
			case <-turnContext.Done():
				return nil, turnContext.Err()
			}
			if err := database.MarkStageExternalSideEffects(turnContext, envelope.StageAttemptID); err != nil {
				return nil, err
			}
			return nil, collectorFailure
		default:
			return nil, fmt.Errorf("unexpected stage after collector failure: %s", schemaKind(options.Schema))
		}
	})
	engine, db, _, run := openResearchTest(t, fixture)
	database = db

	type executionOutcome struct {
		run core.Run
		err error
	}
	executionDone := make(chan executionOutcome, 1)
	go func() {
		completed, err := engine.Execute(ctx, run.ID)
		executionDone <- executionOutcome{run: completed, err: err}
	}()

	select {
	case <-slowCancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("collector failure did not cancel the sibling worker")
	}
	quiesced, err := db.Run(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if quiesced.Status != core.RunUncertain || !strings.Contains(quiesced.Error, collectorFailure.Error()) {
		t.Fatalf("quiesced run = %s/%q, want uncertain with original cause", quiesced.Status, quiesced.Error)
	}
	select {
	case outcome := <-executionDone:
		t.Fatalf("engine returned before cancelled sibling quiesced: run=%s err=%v", outcome.run.Status, outcome.err)
	default:
	}
	releaseOnce.Do(func() { close(releaseSlow) })

	var outcome executionOutcome
	select {
	case outcome = <-executionDone:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for uncertain collection to finish")
	}
	if !errors.Is(outcome.err, collectorFailure) {
		t.Fatalf("collector error = %v, want original failure", outcome.err)
	}
	if strings.Contains(outcome.err.Error(), "invalid run transition uncertain -> uncertain") ||
		strings.Contains(outcome.err.Error(), "record terminal research state") {
		t.Fatalf("collector error was polluted by a duplicate terminal transition: %v", outcome.err)
	}
	if outcome.run.Status != core.RunUncertain || outcome.run.Revision != quiesced.Revision || outcome.run.Error != quiesced.Error {
		t.Fatalf("outer abort changed quiesced run: before=%+v after=%+v", quiesced, outcome.run)
	}

	attempts, err := db.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var collectors, externalCollectors int
	for _, attempt := range attempts {
		if attempt.Stage != core.StageCollect {
			continue
		}
		collectors++
		if attempt.Status != "failed" {
			t.Fatalf("collector attempt remained %s: %+v", attempt.Status, attempt)
		}
		if attempt.ExternalSideEffects {
			externalCollectors++
		}
	}
	if collectors != 2 || externalCollectors != 1 {
		t.Fatalf("collector attempts/external attempts = %d/%d, want 2/1", collectors, externalCollectors)
	}

	events, err := db.EventsAfter(ctx, 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	var uncertainTransitions int
	for _, event := range events {
		if event.RunID != run.ID || event.Kind != "run.transition" {
			continue
		}
		var transition struct {
			To core.RunStatus `json:"to"`
		}
		if err := json.Unmarshal(event.Payload, &transition); err != nil {
			t.Fatal(err)
		}
		if transition.To == core.RunUncertain {
			uncertainTransitions++
		}
	}
	if uncertainTransitions != 1 {
		t.Fatalf("uncertain transitions = %d, want exactly one", uncertainTransitions)
	}
}

func TestProtocolFixtureModelMetadataMismatchFailsClosed(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, standardResponder(false))
	fixture.transformResult = func(result TurnResult) TurnResult {
		result.Model = "unexpected-model"
		return result
	}
	engine, db, _, run := openResearchTest(t, fixture)

	completed, err := engine.Execute(ctx, run.ID)
	if err == nil {
		t.Fatal("model metadata mismatch unexpectedly completed")
	}
	if completed.Status != core.RunFailed {
		t.Fatalf("run status = %s, want failed", completed.Status)
	}
	attempts, err := db.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 1 || attempts[0].Status != "failed" {
		t.Fatalf("unexpected stage state after model mismatch: %+v", attempts)
	}
}

func TestResearchUsesConversationSessionThreadWhenLegacyProjectMirrorIsEmpty(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, standardResponder(false))
	engine, db, _, legacyRun := openResearchTest(t, fixture)
	if err := db.SetProjectMainThread(ctx, legacyRun.ProjectID, ""); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateConversationSession(ctx, legacyRun.ProjectID, "second", core.RunConfiguration{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.MarkConversationSessionProvisioning(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetConversationSessionThreadIfEmpty(ctx, session.ID, "thread-second"); err != nil {
		t.Fatal(err)
	}
	run, err := db.CreateConversationRunConfigured(ctx, session.ID, "", "question", "thread-second", core.RunConfiguration{})
	if err != nil {
		t.Fatal(err)
	}

	completed, err := engine.Execute(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != core.RunSucceeded {
		t.Fatalf("run status = %s, want succeeded", completed.Status)
	}
	if len(fixture.callsSnapshot()) == 0 {
		t.Fatal("conversation-scoped main thread did not submit a protocol turn")
	}
	project, err := db.Project(ctx, run.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	if project.MainThreadID != "" {
		t.Fatalf("research rewrote legacy project mirror to %q", project.MainThreadID)
	}
}

func TestConversationSessionMainThreadPreflightRejectsMissingAndMismatch(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, standardResponder(false))
	engine, db, _, run := openResearchTest(t, fixture)

	unprovisioned, err := db.CreateConversationSession(ctx, run.ProjectID, "unprovisioned", core.RunConfiguration{})
	if err != nil {
		t.Fatal(err)
	}
	missing := run
	missing.ConversationSessionID = unprovisioned.ID
	if err := engine.requireMainThread(ctx, missing); !errors.Is(err, ErrMainThreadMissing) {
		t.Fatalf("missing thread error = %v, want %v", err, ErrMainThreadMissing)
	}

	if _, err := db.MarkConversationSessionProvisioning(ctx, unprovisioned.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetConversationSessionThreadIfEmpty(ctx, unprovisioned.ID, "thread-other"); err != nil {
		t.Fatal(err)
	}
	mismatch := run
	mismatch.ConversationSessionID = unprovisioned.ID
	if err := engine.requireMainThread(ctx, mismatch); !errors.Is(err, ErrMainThreadMismatch) {
		t.Fatalf("mismatched thread error = %v, want %v", err, ErrMainThreadMismatch)
	}
}

func TestProtocolFixtureCancellationWinsOverSuccessfulLookingTurn(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, func(_ context.Context, _ string, options TurnOptions) (json.RawMessage, error) {
		if schemaKind(options.Schema) != "plan" {
			return nil, fmt.Errorf("unexpected stage: %s", schemaKind(options.Schema))
		}
		return mustJSON(t, testPlan("question", 1)), context.Canceled
	})
	engine, db, _, run := openResearchTest(t, fixture)

	completed, err := engine.Execute(ctx, run.ID)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context cancellation", err)
	}
	if completed.Status != core.RunCancelled {
		t.Fatalf("run status = %s, want cancelled", completed.Status)
	}
	attempts, err := db.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 1 || attempts[0].Status != "failed" {
		t.Fatalf("cancelled turn was not recorded as a failed attempt: %+v", attempts)
	}
}

func TestCollectorTurnDeadlineFailsStageAndRunDurably(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, func(ctx context.Context, _ string, options TurnOptions) (json.RawMessage, error) {
		switch schemaKind(options.Schema) {
		case "plan":
			return mustJSON(t, testPlan("question", 1)), nil
		case "evidence":
			<-ctx.Done()
			return nil, ctx.Err()
		default:
			return nil, fmt.Errorf("unexpected stage: %s", schemaKind(options.Schema))
		}
	})
	engine, db, _, run := openResearchTest(t, fixture)
	engine.turnTimeout = 25 * time.Millisecond

	completed, err := engine.Execute(ctx, run.ID)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want context deadline exceeded", err)
	}
	if completed.Status != core.RunFailed {
		t.Fatalf("run status = %s, want failed", completed.Status)
	}
	if !strings.Contains(completed.Error, "collect turn exceeded 25ms deadline") {
		t.Fatalf("run error = %q, want explicit turn deadline", completed.Error)
	}

	attempts, listErr := db.ListStageAttempts(ctx, run.ID)
	if listErr != nil {
		t.Fatal(listErr)
	}
	if len(attempts) != 2 {
		t.Fatalf("stage attempt count = %d, want plan plus collector", len(attempts))
	}
	if attempts[0].Stage != core.StagePlan || attempts[0].Status != "completed" {
		t.Fatalf("plan checkpoint = %+v, want completed", attempts[0])
	}
	attempt := attempts[1]
	if attempt.Stage != core.StageCollect || attempt.Status != "failed" || !strings.Contains(attempt.Error, "collect turn exceeded 25ms deadline") {
		t.Fatalf("deadline was not durably recorded on failed stage: %+v", attempt)
	}
	if attempt.CodexThreadID == "" || attempt.CodexThreadID == run.MainThreadID || attempt.CodexTurnID != "fixture-turn-2" {
		t.Fatalf("deadline collector checkpoint = %s/%s, want isolated thread/fixture-turn-2", attempt.CodexThreadID, attempt.CodexTurnID)
	}
	if attempt.OutputArtifactHash != "" {
		t.Fatalf("deadline stage published output %q", attempt.OutputArtifactHash)
	}
}

func TestInterruptedResumeUsesPublishedCheckpointWithoutReplayingPlan(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, standardResponder(false))
	engine, db, objects, run := openResearchTest(t, fixture)

	var err error
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	plan := testPlan(run.Question, 2)
	addCheckpointStage(t, db, objects, run, core.StagePlan, 0, run.MainThreadID, plan)
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunInterrupted, "")
	if err != nil {
		t.Fatal(err)
	}

	completed, err := engine.Execute(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != core.RunSucceeded {
		t.Fatalf("resumed status = %s, want succeeded", completed.Status)
	}
	for _, call := range fixture.callsSnapshot() {
		if schemaKind(call.Options.Schema) == "plan" {
			t.Fatal("interrupted resume replayed a completed plan turn")
		}
	}
}

func TestCompletedSideEffectCheckpointResumesWithoutReplayingTurn(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, standardResponder(false))
	engine, db, objects, run := openResearchTest(t, fixture)
	var err error
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	plan := testPlan(run.Question, 2)
	addCheckpointStageWithExternalSideEffect(t, db, objects, run, core.StagePlan, 0, run.MainThreadID, plan, true)
	if recovered, err := db.RecoverInFlight(ctx); err != nil || recovered != 1 {
		t.Fatalf("recover completed side-effect boundary: count=%d err=%v", recovered, err)
	}
	recoveredRun, err := db.Run(ctx, run.ID)
	if err != nil || recoveredRun.Status != core.RunInterrupted {
		t.Fatalf("completed side-effect checkpoint recovered as %s err=%v", recoveredRun.Status, err)
	}
	completed, err := engine.Execute(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != core.RunSucceeded {
		t.Fatalf("completed side-effect resume status=%s", completed.Status)
	}
	for _, call := range fixture.callsSnapshot() {
		if schemaKind(call.Options.Schema) == "plan" {
			t.Fatal("completed side-effect checkpoint replayed its plan turn")
		}
	}
}

func TestCompletedSideEffectCheckpointRejectsWrongStageProfile(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*store.StageExecutionReceipt)
	}{
		{name: "model", mutate: func(receipt *store.StageExecutionReceipt) { receipt.Model = core.CollectorModel }},
		{name: "reasoning", mutate: func(receipt *store.StageExecutionReceipt) { receipt.ReasoningEffort = core.CollectorEffort }},
		{name: "service tier", mutate: func(receipt *store.StageExecutionReceipt) { receipt.ServiceTier = core.ServiceTierFast }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			fixture := newProtocolFixture(t, standardResponder(false))
			engine, db, objects, run := openResearchTest(t, fixture)
			var err error
			run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
			if err != nil {
				t.Fatal(err)
			}
			addCheckpointStageWithReceiptMutation(t, db, objects, run, core.StagePlan, 0,
				run.MainThreadID, testPlan(run.Question, 2), true, test.mutate)
			if recovered, err := db.RecoverInFlight(ctx); err != nil || recovered != 1 {
				t.Fatalf("recover malformed side-effect checkpoint: count=%d err=%v", recovered, err)
			}
			completed, err := engine.Execute(ctx, run.ID)
			if !errors.Is(err, ErrUnsafeResume) {
				t.Fatalf("malformed %s receipt resume error=%v, want unsafe resume", test.name, err)
			}
			if completed.Status != core.RunInterrupted {
				t.Fatalf("malformed %s receipt changed run to %s", test.name, completed.Status)
			}
			if len(fixture.callsSnapshot()) != 0 {
				t.Fatalf("malformed %s receipt submitted a protocol turn", test.name)
			}
		})
	}
}

func TestInterruptedResumeAfterCycleAdvanceDoesNotDuplicateReview(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, responderForPlan(1, false))
	engine, db, objects, run := openResearchTest(t, fixture)

	var err error
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	plan := testPlan(run.Question, 1)
	addCheckpointStage(t, db, objects, run, core.StagePlan, 0, run.MainThreadID, plan)
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	collected := testEvidence("workstream-0")
	addCheckpointStage(t, db, objects, run, core.StageCollect, 0, "collector-thread", collected)
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunSynthesizing, "")
	if err != nil {
		t.Fatal(err)
	}
	canonicalCollected, err := canonicalizeEvidenceClaimIDs(run.ID, collected)
	if err != nil {
		t.Fatal(err)
	}
	addCheckpointStage(t, db, objects, run, core.StageSynthesize, 0, run.MainThreadID, testReportForEvidence([]core.EvidenceBundle{canonicalCollected}))
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunReviewing, "")
	if err != nil {
		t.Fatal(err)
	}
	addCheckpointStage(t, db, objects, run, core.StageReview, 0, "review-thread", testVerdict(false))
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunRevising, "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = db.SetRunCycle(ctx, run.ID, run.Revision, 1)
	if err != nil {
		t.Fatal(err)
	}
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunInterrupted, "")
	if err != nil {
		t.Fatal(err)
	}

	completed, err := engine.Execute(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != core.RunSucceeded || completed.RevisionCycle != 1 {
		t.Fatalf("resumed run = status %s cycle %d", completed.Status, completed.RevisionCycle)
	}
	var reviews, revisions int
	for _, call := range fixture.callsSnapshot() {
		switch schemaKind(call.Options.Schema) {
		case "review":
			reviews++
		case "report":
			if strings.Contains(call.Options.Prompt, `"review"`) {
				revisions++
			}
		}
	}
	if reviews != 1 || revisions != 1 {
		t.Fatalf("resumed protocol reviews/revisions = %d/%d, want 1/1", reviews, revisions)
	}
}

func TestInterruptedInFlightStageIsRejectedWithoutReplay(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, standardResponder(false))
	engine, db, objects, run := openResearchTest(t, fixture)

	var err error
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	input, err := objects.PutBytes([]byte(`{"checkpoint":"in-flight"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.BeginStage(ctx, run.ID, core.StagePlan, 0, run.MainThreadID, input.Hash); err != nil {
		t.Fatal(err)
	}
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunInterrupted, "")
	if err != nil {
		t.Fatal(err)
	}

	completed, err := engine.Execute(ctx, run.ID)
	if !errors.Is(err, ErrUnsafeResume) {
		t.Fatalf("error = %v, want unsafe resume", err)
	}
	if completed.Status != core.RunInterrupted {
		t.Fatalf("in-flight resume changed status to %s", completed.Status)
	}
	if len(fixture.callsSnapshot()) != 0 {
		t.Fatal("in-flight turn was replayed")
	}
	if err := db.PrepareInterruptedRunForResume(ctx, run.ID); err != nil {
		t.Fatal(err)
	}
	completed, err = engine.Execute(ctx, run.ID)
	if err != nil {
		t.Fatalf("explicitly authorized retry failed: %v", err)
	}
	if completed.Status != core.RunSucceeded {
		t.Fatalf("explicit retry completed as %s", completed.Status)
	}
	attempts, err := db.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) < 2 || attempts[0].Status != "superseded" || attempts[0].Ordinal != 0 {
		t.Fatalf("explicit retry did not preserve interrupted audit attempt: %+v", attempts)
	}
}

func TestUncertainRunIsNeverAutomaticallyResumed(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, standardResponder(false))
	engine, db, _, run := openResearchTest(t, fixture)

	var err error
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunUncertain, "")
	if err != nil {
		t.Fatal(err)
	}
	completed, err := engine.Execute(ctx, run.ID)
	if !errors.Is(err, ErrUncertainResume) {
		t.Fatalf("error = %v, want uncertain resume refusal", err)
	}
	if completed.Status != core.RunUncertain {
		t.Fatalf("uncertain status changed to %s", completed.Status)
	}
	if len(fixture.callsSnapshot()) != 0 {
		t.Fatal("uncertain run submitted a protocol turn")
	}
}

func TestSteerTargetsTheActiveRunTurn(t *testing.T) {
	fixture := newProtocolFixture(t, standardResponder(false))
	engine, _, _, run := openResearchTest(t, fixture)
	started := make(chan struct{})
	release := make(chan struct{})
	originalBeforeTurn := fixture.beforeTurn
	fixture.beforeTurn = func(ctx context.Context, options TurnOptions) error {
		if schemaKind(options.Schema) == "plan" {
			close(started)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-release:
			}
		}
		return originalBeforeTurn(ctx, options)
	}

	executionDone := make(chan error, 1)
	go func() {
		_, err := engine.Execute(context.Background(), run.ID)
		executionDone <- err
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for the planning turn")
	}
	if err := engine.Steer(context.Background(), run.ID, "include recent counter-evidence"); err != nil {
		t.Fatal(err)
	}
	steers := fixture.steersSnapshot()
	if len(steers) != 1 || steers[0].ThreadID != "main-thread" || steers[0].Message != "include recent counter-evidence" {
		t.Fatalf("steering calls = %#v", steers)
	}
	close(release)
	select {
	case err := <-executionDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for research completion")
	}
}

func TestIndependentReviewCannotBeSteered(t *testing.T) {
	fixture := newProtocolFixture(t, responderForPlan(1, false))
	engine, _, _, run := openResearchTest(t, fixture)
	started := make(chan struct{})
	release := make(chan struct{})
	originalBeforeTurn := fixture.beforeTurn
	fixture.beforeTurn = func(ctx context.Context, options TurnOptions) error {
		if options.Stage == core.StageReview {
			close(started)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-release:
			}
		}
		return originalBeforeTurn(ctx, options)
	}

	executionDone := make(chan error, 1)
	go func() {
		_, err := engine.Execute(context.Background(), run.ID)
		executionDone <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the independent review turn")
	}
	if err := engine.Steer(context.Background(), run.ID, "raise the score"); !errors.Is(err, ErrNoActiveTurn) {
		t.Fatalf("review steering error = %v, want ErrNoActiveTurn", err)
	}
	if steers := fixture.steersSnapshot(); len(steers) != 0 {
		t.Fatalf("independent reviewer received steering: %#v", steers)
	}
	close(release)
	select {
	case err := <-executionDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for research completion")
	}
}

func openResearchTest(t *testing.T, fixture *protocolFixture) (*Engine, *store.DB, *cas.Store, core.Run) {
	return openResearchTestConfigured(t, fixture, core.RunConfiguration{})
}

func openResearchTestConfigured(t *testing.T, fixture *protocolFixture, configuration core.RunConfiguration) (*Engine, *store.DB, *cas.Store, core.Run) {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	db, err := store.Open(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	productBuild := buildinfo.ProductBuildBinding{
		Version:          buildinfo.ReleaseProductVersion,
		ExecutableSHA256: strings.Repeat("1", 64), RuntimeManifestSHA256: strings.Repeat("2", 64),
		KnowledgeSidecarTreeSHA256: strings.Repeat("3", 64),
	}
	if err := db.SetProductBuildBinding(productBuild); err != nil {
		t.Fatal(err)
	}
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	fixture.beforeTurn = func(ctx context.Context, options TurnOptions) error {
		if schemaKind(options.Schema) != "evidence" {
			return nil
		}
		envelope, err := decodeFixturePrompt(options.Prompt)
		if err != nil {
			return err
		}
		var input collectInput
		if err := json.Unmarshal(envelope.Task, &input); err != nil {
			return err
		}
		evidence := testEvidence(input.Workstream.ID)
		data := fixtureSource(input.Workstream.ID)
		receipt, err := objects.PutBytes(data)
		if err != nil {
			return err
		}
		if receipt.Hash != evidence.Sources[0].BlobHash {
			return errors.New("fixture evidence hash mismatch")
		}
		_, err = db.CaptureEvidence(ctx, envelope.RunID, envelope.StageAttemptID,
			evidence.Sources[0].URL, evidence.Sources[0].Title, evidence.Sources[0].Publisher,
			"text/plain; charset=utf-8", receipt)
		return err
	}
	project, err := db.CreateProject(ctx, "research test")
	if err != nil {
		t.Fatal(err)
	}
	activateResearchTestKnowledge(t, ctx, db, objects, project.ID)
	const mainThreadID = "main-thread"
	if err := db.SetProjectMainThread(ctx, project.ID, mainThreadID); err != nil {
		t.Fatal(err)
	}
	run, err := db.CreateRunConfigured(ctx, project.ID, "", "question", mainThreadID, configuration)
	if err != nil {
		t.Fatal(err)
	}
	engine, err := New(Config{DB: db, CAS: objects, Protocol: fixture, ProductBuild: productBuild})
	if err != nil {
		t.Fatal(err)
	}
	return engine, db, objects, run
}

func activateResearchTestKnowledge(t *testing.T, ctx context.Context, db *store.DB, objects *cas.Store, projectID string) {
	t.Helper()
	candidate, err := db.CreateKnowledgeGeneration(ctx, projectID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, tripleCount, err := db.KnowledgeNQuads(ctx, projectID, candidate.ID, store.CoreOntologyID)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "application/n-quads"); err != nil {
		t.Fatal(err)
	}
	if err := db.AppendKnowledgeProjection(ctx, projectID, candidate.ID, store.KnowledgeProjection{
		Snapshots: []store.KnowledgeRDFSnapshotRecord{{
			ID: "krdf_" + receipt.Hash[:32], Format: "n-quads", BlobHash: receipt.Hash,
			DatasetSHA256: receipt.Hash, TripleCount: tripleCount,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.TransitionKnowledgeGeneration(ctx, projectID, candidate.ID, store.KnowledgeBuilding, store.KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := db.TransitionKnowledgeGeneration(ctx, projectID, candidate.ID, store.KnowledgeValidating, store.KnowledgeReady, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ActivateKnowledgeGeneration(ctx, projectID, candidate.ID); err != nil {
		t.Fatal(err)
	}
}

func addCheckpointStage(
	t *testing.T,
	db *store.DB,
	objects *cas.Store,
	run core.Run,
	stage core.Stage,
	ordinal int,
	threadID string,
	output any,
) {
	addCheckpointStageWithExternalSideEffect(t, db, objects, run, stage, ordinal, threadID, output, false)
}

func addCheckpointStageWithExternalSideEffect(
	t *testing.T,
	db *store.DB,
	objects *cas.Store,
	run core.Run,
	stage core.Stage,
	ordinal int,
	threadID string,
	output any,
	externalSideEffect bool,
) {
	addCheckpointStageWithReceiptMutation(t, db, objects, run, stage, ordinal, threadID, output, externalSideEffect, nil)
}

func addCheckpointStageWithReceiptMutation(
	t *testing.T,
	db *store.DB,
	objects *cas.Store,
	run core.Run,
	stage core.Stage,
	ordinal int,
	threadID string,
	output any,
	externalSideEffect bool,
	mutateReceipt func(*store.StageExecutionReceipt),
) {
	t.Helper()
	ctx := context.Background()
	input, err := objects.PutBytes([]byte(`{"checkpoint":true}`))
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := db.BeginStage(ctx, run.ID, stage, ordinal, threadID, input.Hash)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetStageTurn(ctx, attempt.ID, threadID, "checkpoint-turn"); err != nil {
		t.Fatal(err)
	}
	if bundle, ok := output.(core.EvidenceBundle); ok {
		if stage == core.StageCollect {
			bundle, err = canonicalizeEvidenceClaimIDs(run.ID, bundle)
			if err != nil {
				t.Fatal(err)
			}
			output = bundle
		}
		for _, source := range bundle.Sources {
			data := fixtureSource(bundle.WorkstreamID)
			receipt, err := objects.PutBytes(data)
			if err != nil {
				t.Fatal(err)
			}
			if receipt.Hash != source.BlobHash {
				t.Fatal("checkpoint evidence hash mismatch")
			}
			if _, err := db.CaptureEvidence(ctx, run.ID, attempt.ID, source.URL, source.Title,
				source.Publisher, "text/plain; charset=utf-8", receipt); err != nil {
				t.Fatal(err)
			}
		}
	}
	encoded := mustJSON(t, output)
	receipt, err := objects.PutBytes(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := objects.ReadVerified(receipt.Hash); err != nil {
		t.Fatal(err)
	}
	if _, err := db.PublishArtifact(ctx, run.ID, attempt.ID, "research.checkpoint", "application/json", receipt); err != nil {
		t.Fatal(err)
	}
	if externalSideEffect {
		if err := db.MarkStageExternalSideEffects(ctx, attempt.ID); err != nil {
			t.Fatal(err)
		}
	}
	profile, err := profileForStage(run.ResearchProfileVersion, stage)
	if err != nil {
		t.Fatal(err)
	}
	executionReceipt := store.StageExecutionReceipt{
		StageAttemptID: attempt.ID, RunID: run.ID, ResearchProfileVersion: run.ResearchProfileVersion,
		Model: profile.Model, ReasoningEffort: profile.ReasoningEffort, ServiceTier: profile.ServiceTier,
		CodexThreadID: threadID, CodexTurnID: "checkpoint-turn", InputSHA256: input.Hash,
		OutputSHA256: receipt.Hash, ExecutionContractSHA256: core.StageExecutionContractSHA256,
		ProductBuild: run.ProductBuild,
	}
	if mutateReceipt != nil {
		mutateReceipt(&executionReceipt)
	}
	if err := db.CompleteStageWithExecution(ctx, attempt.ID, receipt.Hash, executionReceipt); err != nil {
		t.Fatal(err)
	}
}

type protocolCall struct {
	ThreadID string
	Options  TurnOptions
}

type threadCreateCall struct {
	Stage   core.Stage
	Profile ModelProfile
}

type steerCall struct {
	ThreadID string
	Message  string
}

type protocolFixture struct {
	t         *testing.T
	responder func(context.Context, string, TurnOptions) (json.RawMessage, error)

	mu                sync.Mutex
	threadSequence    int
	turnSequence      int
	calls             []protocolCall
	threadCreates     []threadCreateCall
	steers            []steerCall
	createErr         error
	threadIDForCreate func(core.Stage, int) string
	transformResult   func(TurnResult) TurnResult
	beforeTurn        func(context.Context, TurnOptions) error
}

func newProtocolFixture(
	t *testing.T,
	responder func(context.Context, string, TurnOptions) (json.RawMessage, error),
) *protocolFixture {
	t.Helper()
	return &protocolFixture{t: t, responder: responder}
}

func (fixture *protocolFixture) ValidateModel(_ context.Context, model, effort, serviceTier string) error {
	if serviceTier != core.ServiceTierDefault && serviceTier != core.ServiceTierFast {
		return fmt.Errorf("unsupported fixture service tier %s", serviceTier)
	}
	if (model == core.PlannerModel && effort == core.PlannerEffort) ||
		(model == core.CollectorModel && effort == core.CollectorEffort) ||
		(model == core.ReviewerModel && effort == core.ReviewerEffort) {
		return nil
	}
	return fmt.Errorf("unsupported fixture model %s/%s", model, effort)
}

func (fixture *protocolFixture) CreateStageThread(_ context.Context, stage core.Stage, profile ModelProfile) (string, error) {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if fixture.createErr != nil {
		return "", fixture.createErr
	}
	fixture.threadCreates = append(fixture.threadCreates, threadCreateCall{Stage: stage, Profile: profile})
	fixture.threadSequence++
	if fixture.threadIDForCreate != nil {
		return fixture.threadIDForCreate(stage, fixture.threadSequence), nil
	}
	return fmt.Sprintf("fixture-thread-%d", fixture.threadSequence), nil
}

func (fixture *protocolFixture) Steer(_ context.Context, threadID, message string) error {
	fixture.mu.Lock()
	fixture.steers = append(fixture.steers, steerCall{ThreadID: threadID, Message: message})
	fixture.mu.Unlock()
	return nil
}

func (fixture *protocolFixture) Turn(ctx context.Context, threadID string, options TurnOptions) (TurnResult, error) {
	fixture.mu.Lock()
	fixture.turnSequence++
	turnID := fmt.Sprintf("fixture-turn-%d", fixture.turnSequence)
	fixture.calls = append(fixture.calls, protocolCall{
		ThreadID: threadID,
		Options: TurnOptions{
			Stage:           options.Stage,
			Model:           options.Model,
			ReasoningEffort: options.ReasoningEffort,
			ServiceTier:     options.ServiceTier,
			Schema:          append(json.RawMessage(nil), options.Schema...),
			Prompt:          options.Prompt,
		},
	})
	fixture.mu.Unlock()
	if fixture.beforeTurn != nil {
		if err := fixture.beforeTurn(ctx, options); err != nil {
			return TurnResult{ThreadID: threadID, TurnID: turnID}, err
		}
	}

	output, err := fixture.responder(ctx, threadID, options)
	result := TurnResult{
		ThreadID:        threadID,
		TurnID:          turnID,
		Model:           options.Model,
		ReasoningEffort: options.ReasoningEffort,
		ServiceTier:     options.ServiceTier,
		Output:          output,
	}
	if fixture.transformResult != nil {
		result = fixture.transformResult(result)
	}
	return result, err
}

func (fixture *protocolFixture) callsSnapshot() []protocolCall {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	return append([]protocolCall(nil), fixture.calls...)
}

func (fixture *protocolFixture) threadCreatesSnapshot() []threadCreateCall {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	return append([]threadCreateCall(nil), fixture.threadCreates...)
}

func (fixture *protocolFixture) steersSnapshot() []steerCall {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	return append([]steerCall(nil), fixture.steers...)
}

func standardResponder(failReviews bool) func(context.Context, string, TurnOptions) (json.RawMessage, error) {
	return responderForPlan(2, failReviews)
}

func responderForPlan(workstreams int, failReviews bool) func(context.Context, string, TurnOptions) (json.RawMessage, error) {
	return func(_ context.Context, _ string, options TurnOptions) (json.RawMessage, error) {
		switch schemaKind(options.Schema) {
		case "plan":
			return mustJSONValue(testPlan("question", workstreams))
		case "evidence":
			var input collectInput
			if err := json.Unmarshal(promptInput(options.Prompt), &input); err != nil {
				return nil, err
			}
			return mustJSONValue(collectorOutputForBundle(testEvidence(input.Workstream.ID)))
		case "report":
			var input synthesizeInput
			if err := json.Unmarshal(promptInput(options.Prompt), &input); err != nil {
				return nil, err
			}
			return mustJSONValue(testReportForEvidence(input.Evidence))
		case "review":
			return mustJSONValue(testVerdict(!failReviews))
		default:
			return nil, fmt.Errorf("unknown response schema %s", string(options.Schema))
		}
	}
}

func schemaKind(schema json.RawMessage) string {
	switch {
	case bytes.Equal(schema, core.PlanSchema()):
		return "plan"
	case bytes.Equal(schema, core.EvidenceSchema()):
		return "evidence"
	case bytes.Equal(schema, core.ReportSchema()):
		return "report"
	case bytes.Equal(schema, core.ReviewSchema()):
		return "review"
	}
	// Report schemas may be constrained at runtime to the exact collected
	// EvidenceBundle workstream IDs. Identify that strict specialization by
	// shape rather than requiring byte equality with the static base schema.
	var value map[string]any
	if err := json.Unmarshal(schema, &value); err == nil {
		if properties, ok := value["properties"].(map[string]any); ok {
			_, hasEvidenceIDs := properties["evidence_ids"]
			_, hasKnowledgePatch := properties["knowledge_patch"]
			_, hasAnswer := properties["answer_markdown"]
			if hasEvidenceIDs && hasKnowledgePatch && hasAnswer {
				return "report"
			}
		}
	}
	return "unknown"
}

func fixedSchemaForCall(options TurnOptions) error {
	if options.ServiceTier != core.ServiceTierDefault {
		return fmt.Errorf("research stage service tier = %s, want standard/default", options.ServiceTier)
	}
	switch schemaKind(options.Schema) {
	case "plan":
		if options.Stage != core.StagePlan {
			return fmt.Errorf("plan turn stage = %s", options.Stage)
		}
		if options.Model != core.PlannerModel || options.ReasoningEffort != core.PlannerEffort {
			return fmt.Errorf("plan profile = %s/%s", options.Model, options.ReasoningEffort)
		}
		var input planInput
		if err := json.Unmarshal(promptInput(options.Prompt), &input); err != nil {
			return err
		}
		if input.MemoryPolicy != planningMemoryPolicy {
			return errors.New("plan prompt omitted the long-term memory exploration policy")
		}
	case "evidence":
		if options.Stage != core.StageCollect {
			return fmt.Errorf("collector turn stage = %s", options.Stage)
		}
		if options.Model != core.CollectorModel || options.ReasoningEffort != core.CollectorEffort {
			return fmt.Errorf("collector profile = %s/%s", options.Model, options.ReasoningEffort)
		}
	case "report":
		if options.Stage != core.StageSynthesize && options.Stage != core.StageRevise {
			return fmt.Errorf("report turn stage = %s", options.Stage)
		}
		if options.Model != core.PlannerModel || options.ReasoningEffort != core.PlannerEffort {
			return fmt.Errorf("report profile = %s/%s", options.Model, options.ReasoningEffort)
		}
		var input synthesizeInput
		if err := json.Unmarshal(promptInput(options.Prompt), &input); err != nil {
			return err
		}
		if input.KnowledgePatchPolicy == "" {
			return errors.New("report prompt omitted the knowledge patch policy")
		}
	case "review":
		if options.Stage != core.StageReview {
			return fmt.Errorf("review turn stage = %s", options.Stage)
		}
		if options.Model != core.ReviewerModel || options.ReasoningEffort != core.ReviewerEffort {
			return fmt.Errorf("review profile = %s/%s", options.Model, options.ReasoningEffort)
		}
		var input reviewInput
		if err := json.Unmarshal(promptInput(options.Prompt), &input); err != nil {
			return err
		}
		if input.KnowledgeReviewPolicy == "" || input.ReviewScoringPolicy == "" ||
			!strings.Contains(input.ReviewScoringPolicy, "1 is worst and 5 is best") ||
			input.Report.KnowledgePatch.SchemaVersion != core.KnowledgePatchSchemaV1 {
			return errors.New("review prompt did not include the report knowledge patch and integrity policy")
		}
	default:
		return errors.New("turn option did not contain a fixed core schema")
	}
	return nil
}

func TestReviewPromptDefinesFreshIndependentEvaluator(t *testing.T) {
	prompt := stagePrompt(core.StageReview, "run-review", "attempt-review", []byte(`{"report":{"title":"candidate"}}`))
	for _, required := range []string{
		"independent reviewer in a fresh reviewer-only Codex session",
		"no project research-conversation history",
		"no previous reviewer conversation",
		"judge only the structured plan, evidence bundles, report",
		"read-only AetherOps MCP readback",
		"Do not continue the research",
		"execute a solver",
		"additional_research or replan",
		"fresh PLAN and COLLECT cycle",
	} {
		if !strings.Contains(prompt, required) {
			t.Fatalf("independent review prompt omits %q", required)
		}
	}
	for _, forbidden := range []string{"tool_package_propose", "successful install result", "call a matching bundled engineering tool directly"} {
		if strings.Contains(prompt, forbidden) {
			t.Fatalf("independent review prompt retained research capability instruction %q", forbidden)
		}
	}
}

func TestMainThreadStagePromptRejectsPriorRunScopeLeakage(t *testing.T) {
	for _, stage := range []core.Stage{core.StagePlan, core.StageSynthesize, core.StageRevise} {
		prompt := stagePrompt(stage, "run-current", "attempt-current", []byte(`{"question":"current task only"}`))
		for _, required := range []string{
			"CURRENT RUN SCOPE contract",
			"sole authority for this run's explicit user objective",
			"main Codex thread is deliberately reused",
			"non-authoritative historical context",
			"Never import an older objective, numerical condition, solver requirement",
			"Never call an earlier run's scope the current task's original goal",
		} {
			if !strings.Contains(prompt, required) {
				t.Fatalf("%s prompt omits scope-isolation rule %q", stage, required)
			}
		}
	}
}

func promptInput(prompt string) []byte {
	envelope, err := decodeFixturePrompt(prompt)
	if err != nil {
		return nil
	}
	return envelope.Task
}

type fixturePromptEnvelope struct {
	RunID          string          `json:"run_id"`
	StageAttemptID string          `json:"stage_attempt_id"`
	Task           json.RawMessage `json:"task"`
}

func decodeFixturePrompt(prompt string) (fixturePromptEnvelope, error) {
	const marker = "Structured task input:\n"
	var envelope fixturePromptEnvelope
	markerIndex := strings.Index(prompt, marker)
	if markerIndex < 0 {
		return envelope, errors.New("fixture prompt omits structured task marker")
	}
	err := json.Unmarshal([]byte(prompt[markerIndex+len(marker):]), &envelope)
	if err == nil && (envelope.RunID == "" || envelope.StageAttemptID == "" || len(envelope.Task) == 0) {
		err = errors.New("fixture prompt capability envelope is incomplete")
	}
	return envelope, err
}

func TestCollectStagePromptRequiresInternalEvidenceCapture(t *testing.T) {
	prompt := stagePrompt(core.StageCollect, "run-test", "attempt-test", []byte(`{"workstream_id":"ws"}`))
	for _, required := range []string{
		"Bundled aetherops_engineering tools are first-party capabilities",
		"intentionally absent from aetherops_internal.tool_catalog",
		"empty project tool catalog",
		"aetherops_internal.scholarly_search",
		"discovery-only and is never evidence",
		"candidate url or full_text_url",
		"aetherops_internal.evidence_capture",
		"Pass only URL metadata",
		"Never request commandExecution",
		"PowerShell, curl, wget",
		"canonical final source_url",
		"One-byte/trivial payloads and shell tool wrapper metadata",
		"top-level receipt_artifact_id",
		"art_ followed by exactly 32 lowercase hexadecimal characters",
		"cas_blob_sha256 or evidence_handles artifact_hash",
		"engineering_receipt_artifact_ids",
		"rehydrates the complete immutable source",
		"Every EvidenceBundle claim must contain one or more source_ids",
		"at least one source-supported claim",
		"Never return an uncaptured public source",
		"never emit year-1",
		"fail the stage instead of fabricating",
	} {
		if !strings.Contains(prompt, required) {
			t.Fatalf("collect prompt omits %q", required)
		}
	}
	for _, forbidden := range []string{"content_utf8", "content_base64", "btoa", "TextEncoder"} {
		if strings.Contains(prompt, forbidden) {
			t.Fatalf("collect prompt retained caller-content instruction %q", forbidden)
		}
	}
	if _, err := decodeFixturePrompt(prompt); err != nil {
		t.Fatalf("decode collect prompt: %v", err)
	}
}

func TestCollectEngineeringPolicyPreventsSolverReplayAndRequiresVerification(t *testing.T) {
	input := collectInput{
		Question: "question",
		Workstream: core.Workstream{
			ID: "engineering", Question: "optimize", RequiredEvidence: []string{"receipt"},
		},
		SourceRequirements: []string{"primary source"},
		EngineeringPolicy:  collectEngineeringPolicy,
	}
	encoded, _, err := structuredInput(input)
	if err != nil {
		t.Fatal(err)
	}
	prompt := stagePrompt(core.StageCollect, "run", "attempt", encoded)
	for _, required := range []string{
		"already persisted in run-owned SQLite/CAS",
		"retain only its job_id, receipt_artifact_id",
		"never aggregate complete tool results",
		"64-character cas_blob_sha256",
		"aetherops_engineering.engineering_get",
		"already-successful exact argument set",
		"execution_purpose=screening",
		"execution_purpose=independent_verification",
	} {
		if !strings.Contains(prompt, required) {
			t.Fatalf("collect engineering policy omits %q", required)
		}
	}
	for _, forbidden := range []string{"provenance.id", "receipt/artifact hashes"} {
		if strings.Contains(prompt, forbidden) {
			t.Fatalf("collect engineering policy retains ambiguous field %q", forbidden)
		}
	}
}

func TestExecuteRejectsQueuedRunFromDifferentProductBuild(t *testing.T) {
	fixture := newProtocolFixture(t, standardResponder(false))
	engine, db, _, run := openResearchTest(t, fixture)
	current := db.ProductBuildBinding()
	if current.IsZero() {
		t.Fatal("test database has no current product build binding")
	}
	differentBuild := current
	differentBuild.ExecutableSHA256 = strings.Repeat("f", 64)
	differentEngine, err := New(Config{
		DB: db, CAS: engine.cas, Protocol: fixture, ProductBuild: differentBuild,
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	beforeTurns := fixture.turnSequence
	fixture.mu.Unlock()
	result, err := differentEngine.Execute(context.Background(), run.ID)
	if err == nil || !errors.Is(err, ErrUnsafeResume) || !strings.Contains(err.Error(), "different product build") {
		t.Fatalf("cross-build queued execute result=%+v error=%v", result, err)
	}
	fixture.mu.Lock()
	afterTurns := fixture.turnSequence
	fixture.mu.Unlock()
	if afterTurns != beforeTurns {
		t.Fatalf("cross-build queued run started %d model turns", afterTurns-beforeTurns)
	}
	stored, loadErr := db.Run(context.Background(), run.ID)
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if stored.Status != core.RunQueued || stored.Revision != run.Revision {
		t.Fatalf("cross-build rejection mutated run: before=%+v after=%+v", run, stored)
	}
}

func TestKnowledgePatchPolicyRequiresCopyOnlyExclusiveEvidenceHandles(t *testing.T) {
	for _, required := range []string{
		"strict mutually exclusive union",
		"exactly kind=text, source_id, claim_id, blob_hash, byte_start, byte_end, and span_hash",
		"copy one complete entry from its evidence_handles array verbatim",
		"exactly kind=engineering, artifact_hash, json_pointer, and value_hash",
		"/spec/arguments handle",
		"Never calculate, guess, leave empty, or invent",
		"If no returned handle exactly supports an assertion, omit that assertion",
	} {
		if !strings.Contains(knowledgePatchPolicy, required) {
			t.Fatalf("knowledge patch policy omits %q", required)
		}
	}
}

func TestPlanPromptRequiresExactStructuredXFOILCandidateSet(t *testing.T) {
	prompt := stagePrompt(core.StagePlan, "run-plan", "attempt-plan", []byte(`{"question":"optimize seven flap candidates"}`))
	for _, required := range []string{
		"PLAN XFOIL SCREENING contract", "xfoil_screening", "candidate_flap_deflections_deg",
		"exact immutable numerical contract", "non-NACA-four-digit airfoils",
		"missing, duplicate, additional, failed, or condition-changed jobs",
	} {
		if !strings.Contains(prompt, required) {
			t.Fatalf("plan prompt omits %q", required)
		}
	}
}

func TestPlanPromptAllowsRunPinnedLongTermMemoryExploration(t *testing.T) {
	prompt := stagePrompt(core.StagePlan, "run-plan", "attempt-plan", []byte(`{"question":"compare the new study with prior constraints"}`))
	for _, required := range []string{
		"PLAN LONG-TERM MEMORY contract",
		"aetherops_internal.memory_search",
		"aetherops_internal.memory_get",
		"run-pinned project memory",
		"planning context, not as current report evidence",
		"verification to COLLECT",
	} {
		if !strings.Contains(prompt, required) {
			t.Fatalf("plan memory prompt omits %q", required)
		}
	}
	for _, required := range []string{
		"retrieval candidate",
		"aetherops_internal.knowledge_get",
		"not a substitute for current external evidence",
		"An empty memory result is legitimate",
	} {
		if !strings.Contains(planningMemoryPolicy, required) {
			t.Fatalf("plan memory policy omits %q", required)
		}
	}
}

func TestRemediationPromptsUseAuthorizedReceiptReadbackWithoutSolverExecution(t *testing.T) {
	remediation := &researchRemediationInput{
		Cycle: 1, Action: core.ReviewRemediationReplan, Summary: "reconcile receipt analysis",
		RevisionRequests: []string{"re-read existing receipts"},
		Tasks:            []core.ReviewRemediationTask{{Objective: "revalidate", RequiresEngineering: true}},
	}
	reusablePlan := &core.SU2CaseSetPlan{
		Objective: "revalidate prior generic CFD",
		Cases: []core.SU2CasePlan{{
			ID: "case_a", MeshSource: core.SU2InputMaterial, MeshID: "doc_mesh",
			MeshSHA256: strings.Repeat("a", 64), Solver: "EULER", TurbulenceModel: "NONE",
			ConfigOverrides: map[string]string{"ITER": "100"}, OutputFiles: []string{"surface_csv"}, TimeoutSeconds: 300,
		}},
	}
	result := store.EngineeringResult{Job: store.EngineeringJob{
		ID: "eng_existing", RunID: "run-readback", StageAttemptID: "stg_prior",
		Operation: "su2_cfd", Status: "succeeded",
		ReceiptArtifactID: "art_0123456789abcdef0123456789abcdef",
	}}
	planTask, err := json.Marshal(planInput{
		Question: "current task", ResearchRemediation: remediation,
		ReusableSU2Cases: reusablePlan, ReusableEngineeringResults: []store.EngineeringResult{result},
	})
	if err != nil {
		t.Fatal(err)
	}
	planPrompt := stagePrompt(core.StagePlan, "run-readback", "stg-plan", planTask)
	for _, required := range []string{
		"REMEDIATION PLAN contract", "reusable_su2_cases", "exact generic case set",
		"revalidate every immutable receipt with engineering_get", "do not execute a solver",
	} {
		if !strings.Contains(planPrompt, required) {
			t.Fatalf("remediation PLAN prompt omits %q", required)
		}
	}
	collectTask, err := json.Marshal(collectInput{
		Question: "current task", Plan: core.ResearchPlan{SU2Cases: reusablePlan},
		Workstream:         core.Workstream{ID: "receipt_readback", Question: "read receipts"},
		EngineeringResults: []store.EngineeringResult{result},
	})
	if err != nil {
		t.Fatal(err)
	}
	collectPrompt := stagePrompt(core.StageCollect, "run-readback", "stg-readback", collectTask)
	for _, required := range []string{
		"REMEDIATION ENGINEERING READBACK contract", "engineering_get once for each listed job.id",
		"reused_result=true", "Do not call any solver", "cannot request execution approval",
	} {
		if !strings.Contains(collectPrompt, required) {
			t.Fatalf("receipt-readback COLLECT prompt omits %q", required)
		}
	}
	if remediationNeedsNewSolverExecution(remediation) {
		t.Fatal("engineering readback remediation was classified as new solver work")
	}
	remediation.Tasks[0].RequiresNewSolverExecution = true
	if !remediationNeedsNewSolverExecution(remediation) {
		t.Fatal("fresh solver remediation lost its execution requirement")
	}
	if !strings.Contains(reviewScoringPolicy, "requires_new_solver_execution=true") ||
		!strings.Contains(reviewScoringPolicy, "plotting") ||
		!strings.Contains(reviewScoringPolicy, "reuse immutable receipts") {
		t.Fatal("review policy does not distinguish post-processing from a new solver execution")
	}
}

func TestReviewRejectsNewSolverExecutionWithoutEngineeringRequirement(t *testing.T) {
	verdict := testVerdict(false)
	verdict.RemediationAction = core.ReviewRemediationAdditionalResearch
	verdict.RemediationTasks = []core.ReviewRemediationTask{{
		Objective:                  "run a missing solver case",
		RequiredEvidence:           []string{"fresh receipt"},
		RequiresNewSolverExecution: true,
	}}
	if err := validateReviewVerdict(verdict); err == nil ||
		!strings.Contains(err.Error(), "without engineering work") {
		t.Fatalf("invalid solver remediation error = %v", err)
	}
}

func TestEngineeringVerificationPromptIsIsolatedAndExact(t *testing.T) {
	input := engineeringVerificationInput{
		WorkflowKind: engineeringVerificationWorkflowKind,
		Question:     "choose and independently verify the best flap setting",
		Plan:         testPlan("choose and independently verify the best flap setting", 1),
		Evidence:     []core.EvidenceBundle{testEvidence("workstream-0")},
		ScreeningJobIDs: []string{
			"eng_screening_a",
			"eng_screening_b",
		},
		Policy: "select one candidate and verify it",
	}
	encoded, _, err := structuredInput(input)
	if err != nil {
		t.Fatal(err)
	}
	prompt := stagePrompt(core.StageCollect, "run-verification", "attempt-verification", encoded)
	for _, required := range []string{
		"ENGINEERING VERIFICATION contract",
		"new isolated collector attempt after screening",
		"aetherops_engineering.engineering_get",
		"Select exactly one candidate",
		"Preserve the selected result's NACA, Reynolds, Mach",
		"Do not reuse the screening numerical resolution",
		"ceil(screening panel_count*1.5/10)*10",
		"240 floor and 300 ceiling",
		"min(screening alpha_step_deg,0.05)",
		"target-alpha +/-0.5 degrees",
		"at least 8 digits after the decimal point",
		"Never round alpha_start_deg upward or alpha_end_deg downward",
		"expand that interval",
		"call xfoil_polar exactly once",
		"execution_purpose=independent_verification",
		"verification_of_job_id",
		"replace run_id and stage_attempt_id with the current values",
		"max(0.0005,5% of screening CD)",
		"CM difference no greater than 0.01",
		"A cached screening result is not verification",
		"workstream_id=aetherops_engineering_verification",
		"top-level receipt_artifact_id",
		"never use cas_blob_sha256 or evidence_handles artifact_hash",
		"engineering_receipt_artifact_ids",
		"Do not transcribe engineering URL",
		"do not call evidence_capture",
		"do not run any other solver",
	} {
		if !strings.Contains(prompt, required) {
			t.Fatalf("engineering verification prompt omits %q", required)
		}
	}
	envelope, err := decodeFixturePrompt(prompt)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.RunID != "run-verification" || envelope.StageAttemptID != "attempt-verification" {
		t.Fatalf("verification capability envelope = %+v", envelope)
	}
	var decoded engineeringVerificationInput
	if err := json.Unmarshal(envelope.Task, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.WorkflowKind != engineeringVerificationWorkflowKind ||
		len(decoded.ScreeningJobIDs) != 2 || decoded.ScreeningJobIDs[0] != "eng_screening_a" {
		t.Fatalf("verification structured input changed: %+v", decoded)
	}
}

func TestCheckpointAcceptReservesCollectorOrdinalForEngineeringVerification(t *testing.T) {
	verification := testEngineeringVerificationEvidence(t, mustEngineeringSource(t,
		"art_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", strings.Repeat("a", 64), time.Date(2026, 8, 10, 0, 0, 0, 0, time.UTC),
	))
	encodedVerification := mustJSON(t, verification)
	normal := testEvidence("workstream-0")
	encodedNormal := mustJSON(t, normal)

	t.Run("verification accepted only at reserved ordinal", func(t *testing.T) {
		checkpoint := newWorkflowCheckpoint()
		attempt := core.StageAttempt{Stage: core.StageCollect, Ordinal: core.EngineeringVerificationOrdinal}
		if err := checkpoint.accept(attempt, encodedVerification, "question"); err != nil {
			t.Fatalf("reserved verification checkpoint was rejected: %v", err)
		}
		if checkpoint.collectOrdinals[engineeringVerificationWorkstreamID] != core.EngineeringVerificationOrdinal {
			t.Fatalf("verification ordinal = %d", checkpoint.collectOrdinals[engineeringVerificationWorkstreamID])
		}
	})

	t.Run("normal collector rejected at reserved ordinal", func(t *testing.T) {
		checkpoint := newWorkflowCheckpoint()
		attempt := core.StageAttempt{Stage: core.StageCollect, Ordinal: core.EngineeringVerificationOrdinal}
		if err := checkpoint.accept(attempt, encodedNormal, "question"); err == nil ||
			!strings.Contains(err.Error(), "reserved engineering verification ordinal") {
			t.Fatalf("normal bundle at reserved ordinal error = %v", err)
		}
	})

	t.Run("verification rejected at normal ordinal", func(t *testing.T) {
		checkpoint := newWorkflowCheckpoint()
		attempt := core.StageAttempt{Stage: core.StageCollect, Ordinal: 0}
		if err := checkpoint.accept(attempt, encodedVerification, "question"); err == nil ||
			!strings.Contains(err.Error(), "not in the reserved collector ordinal") {
			t.Fatalf("verification bundle at normal ordinal error = %v", err)
		}
	})
}

func TestInterruptedResumeUsesIndependentVerificationCheckpointWithoutSolverReplay(t *testing.T) {
	ctx := context.Background()
	responder := func(_ context.Context, _ string, options TurnOptions) (json.RawMessage, error) {
		switch schemaKind(options.Schema) {
		case "evidence":
			return nil, errors.New("completed collector or verification checkpoint was replayed")
		case "report":
			var input synthesizeInput
			if err := json.Unmarshal(promptInput(options.Prompt), &input); err != nil {
				return nil, err
			}
			if len(input.Evidence) != 2 || input.Evidence[1].WorkstreamID != engineeringVerificationWorkstreamID {
				return nil, fmt.Errorf("synthesis evidence order = %+v", input.Evidence)
			}
			if len(input.EngineeringResults) != 3 {
				return nil, fmt.Errorf("synthesis engineering results = %d, want 3", len(input.EngineeringResults))
			}
			report := testReportForEvidence(input.Evidence)
			return mustJSONValue(report)
		case "review":
			return mustJSONValue(testVerdict(true))
		default:
			return nil, fmt.Errorf("unexpected resumed stage %s", schemaKind(options.Schema))
		}
	}
	fixture := newProtocolFixture(t, responder)
	engine, db, objects, run := openResearchTest(t, fixture)
	fixture.beforeTurn = func(_ context.Context, options TurnOptions) error {
		if schemaKind(options.Schema) == "evidence" {
			return errors.New("checkpoint resume attempted another solver collector turn")
		}
		return nil
	}

	var err error
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	plan := testPlan(run.Question, 1)
	plan.Mode = "engineering"
	plan.XFOILScreening = testXFOILScreeningPlan(10, 15)
	addCheckpointStage(t, db, objects, run, core.StagePlan, 0, run.MainThreadID, plan)
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}

	screeningAttempt := beginResearchCheckpointAttempt(t, db, objects, run, core.StageCollect, 0, "screening-thread")
	screeningEvidence := testEvidence("workstream-0")
	captureCheckpointPublicEvidence(t, db, objects, run, screeningAttempt, screeningEvidence)
	screeningA, screeningSourceA := persistCheckpointXFOILJob(t, db, objects, run, screeningAttempt, "screening", "", 10)
	screeningB, screeningSourceB := persistCheckpointXFOILJob(t, db, objects, run, screeningAttempt, "screening", "", 15)
	screeningEvidence.Sources = append(screeningEvidence.Sources, screeningSourceA, screeningSourceB)
	screeningEvidence.Claims[0].SourceIDs = append(
		screeningEvidence.Claims[0].SourceIDs, screeningSourceA.ID, screeningSourceB.ID,
	)
	finishResearchCheckpointAttempt(t, db, objects, run, screeningAttempt, screeningEvidence, true)

	verificationAttempt := beginResearchCheckpointAttempt(t, db, objects, run, core.StageCollect,
		core.EngineeringVerificationOrdinal, "verification-thread")
	verificationJob, verificationSource := persistCheckpointXFOILJob(
		t, db, objects, run, verificationAttempt, "independent_verification", screeningB.ID, 15,
	)
	verificationEvidence := testEngineeringVerificationEvidence(t, verificationSource)
	finishResearchCheckpointAttempt(t, db, objects, run, verificationAttempt, verificationEvidence, true)
	if screeningA.StageAttemptID == verificationJob.StageAttemptID || screeningB.StageAttemptID == verificationJob.StageAttemptID {
		t.Fatal("independent verification reused the screening attempt")
	}
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunInterrupted, "")
	if err != nil {
		t.Fatal(err)
	}

	checkpoint, err := engine.loadCheckpoint(ctx, run)
	if err != nil {
		t.Fatalf("load verification checkpoint: %v", err)
	}
	if checkpoint.collectOrdinals[engineeringVerificationWorkstreamID] != core.EngineeringVerificationOrdinal {
		t.Fatalf("loaded verification ordinal = %d", checkpoint.collectOrdinals[engineeringVerificationWorkstreamID])
	}
	point, err := checkpoint.resumePoint()
	if err != nil || point.action != resumeSynthesize {
		t.Fatalf("verification checkpoint resume point = %+v, err=%v", point, err)
	}

	completed, err := engine.Execute(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != core.RunSucceeded {
		t.Fatalf("resumed verification run status = %s", completed.Status)
	}
	results, err := db.ListRunEngineeringResults(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 3 {
		t.Fatalf("solver receipts after resume = %d, want unchanged 3", len(results))
	}
	verificationCount := 0
	for _, result := range results {
		if result.Job.ID == verificationJob.ID {
			verificationCount++
		}
	}
	if verificationCount != 1 {
		t.Fatalf("fresh verification receipt count = %d, want 1", verificationCount)
	}
	for _, call := range fixture.callsSnapshot() {
		if schemaKind(call.Options.Schema) == "evidence" {
			t.Fatal("checkpoint resume replayed a completed solver collector")
		}
	}
	attempts, err := db.ListStageAttempts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	collectOrdinals := map[int]int{}
	for _, attempt := range attempts {
		if attempt.Stage == core.StageCollect {
			collectOrdinals[attempt.Ordinal]++
		}
	}
	if collectOrdinals[0] != 1 || collectOrdinals[core.EngineeringVerificationOrdinal] != 1 || len(collectOrdinals) != 2 {
		t.Fatalf("collector checkpoints after resume = %+v", collectOrdinals)
	}
}

func TestPrepareCollectorEvidenceRehydratesActualXFOILReceiptAndPersistsCanonicalSource(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, standardResponder(false))
	engine, db, objects, run := openResearchTest(t, fixture)
	var err error
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt := beginResearchCheckpointAttempt(t, db, objects, run, core.StageCollect, 0, "collector-thread")
	_, source := persistCheckpointXFOILJob(t, db, objects, run, attempt, "screening", "", 10)
	receiptArtifactID := source.ID

	output := collectorEvidenceOutput{
		WorkstreamID: "screening",
		Summary:      "10 degree XFOIL receipt",
		Claims: []core.EvidenceClaim{{
			ID: "claim-10deg", Statement: "10 degree flap result", SourceIDs: []string{receiptArtifactID},
		}},
		Sources:                       []core.EvidenceSource{},
		EngineeringReceiptArtifactIDs: []string{receiptArtifactID},
		Limitations:                   []string{},
	}
	bundle, err := engine.prepareCollectorEvidence(ctx, run.ID, 0, "screening", nil, mustJSON(t, output))
	if err != nil {
		t.Fatalf("prepare exact receipt reference: %v", err)
	}
	if len(bundle.Sources) != 1 || bundle.Sources[0].ID != receiptArtifactID ||
		bundle.Sources[0].BlobHash != source.BlobHash || bundle.Sources[0].CapturedAt != source.CapturedAt {
		t.Fatalf("canonical receipt was not deterministically rehydrated: %+v", bundle.Sources)
	}
	canonical, err := canonicalEvidenceOutput(&bundle)(mustJSON(t, output))
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeStrict[core.EvidenceBundle](canonical)
	if err != nil || len(decoded.Sources) != 1 || decoded.Sources[0] != bundle.Sources[0] {
		t.Fatalf("canonical persisted output = %+v err=%v", decoded, err)
	}
}

func TestPrepareOwnerEvidenceDeterministicallyCompletesPlannedScreeningReceipts(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, standardResponder(false))
	engine, db, objects, run := openResearchTest(t, fixture)
	var err error
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	plan := testPlan(run.Question, 1)
	plan.Mode = "engineering"
	plan.XFOILScreening = testXFOILScreeningPlan(10, 15)
	attempt := beginResearchCheckpointAttempt(t, db, objects, run, core.StageCollect,
		core.EngineeringScreeningOwnerOrdinal, "screening-owner-thread")
	firstJob, first := persistCheckpointXFOILJob(t, db, objects, run, attempt, "screening", "", 10)
	secondJob, second := persistCheckpointXFOILJob(t, db, objects, run, attempt, "screening", "", 15)
	modelClaim := core.EvidenceClaim{
		ID: "model-screening-claim", Statement: "The model reported the 10 degree screening result.",
		SourceIDs: []string{first.ID}, Counterevidence: "The other receipt ids were truncated.",
	}
	output := collectorEvidenceOutput{
		WorkstreamID: "workstream-0", Summary: "partial model receipt list",
		Claims: []core.EvidenceClaim{modelClaim}, Sources: []core.EvidenceSource{},
		EngineeringReceiptArtifactIDs: []string{first.ID}, Limitations: []string{"tool output truncated"},
	}
	bundle, err := engine.prepareCollectorEvidence(
		ctx, run.ID, core.EngineeringScreeningOwnerOrdinal, "workstream-0", &plan, mustJSON(t, output),
	)
	if err != nil {
		t.Fatalf("complete planned owner receipts: %v", err)
	}
	if len(bundle.Sources) != 2 || bundle.Sources[0] != first || bundle.Sources[1] != second {
		t.Fatalf("deterministic canonical sources = %+v", bundle.Sources)
	}
	if len(bundle.Claims) != 2 {
		t.Fatalf("deterministic receipt claims = %+v", bundle.Claims)
	}
	firstAuditID := canonicalEvidenceClaimID(run.ID, "workstream-0",
		"aetherops-xfoil-screening-10-"+firstJob.ID)
	if bundle.Claims[0].ID != firstAuditID || len(bundle.Claims[0].SourceIDs) != 1 ||
		bundle.Claims[0].SourceIDs[0] != first.ID || bundle.Claims[0].Statement == modelClaim.Statement {
		t.Fatalf("model engineering claim was adopted instead of deterministic claim: %+v", bundle.Claims[0])
	}
	audit := bundle.Claims[1]
	wantAuditID := canonicalEvidenceClaimID(run.ID, "workstream-0", "aetherops-xfoil-screening-15-"+secondJob.ID)
	if audit.ID != wantAuditID || len(audit.SourceIDs) != 1 || audit.SourceIDs[0] != second.ID ||
		!strings.Contains(audit.Statement, secondJob.ID) ||
		!strings.Contains(audit.Statement, "15 degrees") ||
		!strings.Contains(audit.Statement, second.ID) {
		t.Fatalf("deterministic audit claim = %+v", audit)
	}
	cited := map[string]bool{}
	for _, claim := range bundle.Claims {
		for _, sourceID := range claim.SourceIDs {
			cited[sourceID] = true
		}
	}
	for _, source := range bundle.Sources {
		if !cited[source.ID] {
			t.Fatalf("canonical source %s is not cited", source.ID)
		}
	}
	if len(bundle.Limitations) != 1 || bundle.Limitations[0] != "tool output truncated" {
		t.Fatalf("model limitation was not preserved: %+v", bundle.Limitations)
	}
	if !strings.Contains(bundle.Summary, plannedXFOILReconciliationStatement) {
		t.Fatalf("canonical reconciliation statement is missing: %q", bundle.Summary)
	}

	// A receipt that survived the model's id list but was omitted from every
	// model claim still needs the same deterministic audit citation.
	uncitedOutput := output
	uncitedOutput.EngineeringReceiptArtifactIDs = []string{first.ID, second.ID}
	uncitedBundle, err := engine.prepareCollectorEvidence(
		ctx, run.ID, core.EngineeringScreeningOwnerOrdinal, "workstream-0", &plan, mustJSON(t, uncitedOutput),
	)
	if err != nil {
		t.Fatalf("cite model-listed planned owner receipt: %v", err)
	}
	if len(uncitedBundle.Claims) != 2 || uncitedBundle.Claims[1].ID != wantAuditID ||
		len(uncitedBundle.Claims[1].SourceIDs) != 1 || uncitedBundle.Claims[1].SourceIDs[0] != second.ID {
		t.Fatalf("model-listed but uncited receipt lacks deterministic audit claim: %+v", uncitedBundle.Claims)
	}
}

func TestPrepareOwnerEvidenceIgnoresForgedCASHashSliceAndRehydratesSevenReceipts(t *testing.T) {
	ctx := context.Background()
	fixture := newProtocolFixture(t, standardResponder(false))
	engine, db, objects, run := openResearchTest(t, fixture)
	var err error
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	deflections := []int{0, 5, 10, 15, 20, 25, 30}
	plan := testPlan(run.Question, 1)
	plan.Mode = "engineering"
	plan.XFOILScreening = testXFOILScreeningPlan(0, 5, 10, 15, 20, 25, 30)
	attempt := beginResearchCheckpointAttempt(t, db, objects, run, core.StageCollect,
		core.EngineeringScreeningOwnerOrdinal, "screening-owner-thread")
	wantSources := make([]core.EvidenceSource, 0, len(deflections))
	for _, deflection := range deflections {
		_, source := persistCheckpointXFOILJob(t, db, objects, run, attempt, "screening", "", deflection)
		wantSources = append(wantSources, source)
	}
	forged := "art_" + wantSources[0].BlobHash[:32]
	for _, source := range wantSources {
		if forged == source.ID {
			t.Fatal("CAS hash slice unexpectedly matched a real artifact id")
		}
	}
	output := collectorEvidenceOutput{
		WorkstreamID: "workstream-0", Summary: "simplified seven-candidate screening output",
		Claims: []core.EvidenceClaim{{
			ID: "forged-model-claim", Statement: "model claim backed by a sliced CAS hash",
			SourceIDs: []string{forged},
		}},
		Sources: []core.EvidenceSource{}, EngineeringReceiptArtifactIDs: []string{forged}, Limitations: []string{},
	}
	bundle, err := engine.prepareCollectorEvidence(ctx, run.ID, core.EngineeringScreeningOwnerOrdinal,
		"workstream-0", &plan, mustJSON(t, output))
	if err != nil {
		t.Fatalf("DB-authoritative owner evidence rejected forged model handle: %v", err)
	}
	if len(bundle.Sources) != len(wantSources) || len(bundle.Claims) != len(wantSources) {
		t.Fatalf("rehydrated owner evidence sources=%d claims=%d, want %d each",
			len(bundle.Sources), len(bundle.Claims), len(wantSources))
	}
	for index, source := range bundle.Sources {
		if source != wantSources[index] {
			t.Fatalf("rehydrated source %d = %+v, want %+v", index, source, wantSources[index])
		}
		claim := bundle.Claims[index]
		if len(claim.SourceIDs) != 1 || claim.SourceIDs[0] != source.ID ||
			claim.Statement == output.Claims[0].Statement || claim.SourceIDs[0] == forged {
			t.Fatalf("receipt %d lacks a deterministic DB claim: %+v", index, claim)
		}
	}
}

func TestPrepareOwnerEvidenceFailsClosedAndIgnoresOtherOperations(t *testing.T) {
	type ownerFixture struct {
		engine  *Engine
		db      *store.DB
		run     core.Run
		plan    core.ResearchPlan
		attempt core.StageAttempt
		jobs    []store.EngineeringJob
		sources []core.EvidenceSource
	}
	setup := func(t *testing.T, planDeflections []float64, jobDeflections ...int) ownerFixture {
		t.Helper()
		ctx := context.Background()
		protocol := newProtocolFixture(t, standardResponder(false))
		engine, db, objects, run := openResearchTest(t, protocol)
		var err error
		run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
		if err != nil {
			t.Fatal(err)
		}
		run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
		if err != nil {
			t.Fatal(err)
		}
		plan := testPlan(run.Question, 2)
		plan.Mode = "engineering"
		plan.XFOILScreening = testXFOILScreeningPlan(planDeflections...)
		attempt := beginResearchCheckpointAttempt(t, db, objects, run, core.StageCollect,
			core.EngineeringScreeningOwnerOrdinal, "screening-owner-thread")
		fixture := ownerFixture{engine: engine, db: db, run: run, plan: plan, attempt: attempt}
		for _, deflection := range jobDeflections {
			job, source := persistCheckpointXFOILJob(t, db, objects, run, attempt, "screening", "", deflection)
			fixture.jobs = append(fixture.jobs, job)
			fixture.sources = append(fixture.sources, source)
		}
		return fixture
	}
	output := func(source core.EvidenceSource) json.RawMessage {
		return mustJSON(t, collectorEvidenceOutput{
			WorkstreamID: "workstream-0", Summary: "model returned one receipt",
			Claims:  []core.EvidenceClaim{{ID: "model-claim", Statement: "model statement", SourceIDs: []string{source.ID}}},
			Sources: []core.EvidenceSource{}, EngineeringReceiptArtifactIDs: []string{source.ID}, Limitations: []string{},
		})
	}

	t.Run("receipt-less succeeded planned job", func(t *testing.T) {
		fixture := setup(t, []float64{10, 15}, 10, 15)
		if _, err := fixture.db.SQL().ExecContext(context.Background(),
			"UPDATE engineering_jobs SET receipt_artifact_id=NULL WHERE id=?", fixture.jobs[1].ID); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.engine.prepareCollectorEvidence(context.Background(), fixture.run.ID, 0,
			"workstream-0", &fixture.plan, output(fixture.sources[0])); err == nil ||
			!strings.Contains(err.Error(), "engineering receipt artifact id is invalid") {
			t.Fatalf("receipt-less planned job error = %v", err)
		}
	})

	t.Run("failed planned job", func(t *testing.T) {
		fixture := setup(t, []float64{10, 15}, 10, 15)
		if _, err := fixture.db.SQL().ExecContext(context.Background(),
			"UPDATE engineering_jobs SET status='failed' WHERE id=?", fixture.jobs[1].ID); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.engine.prepareCollectorEvidence(context.Background(), fixture.run.ID, 0,
			"workstream-0", &fixture.plan, output(fixture.sources[0])); err == nil ||
			!strings.Contains(err.Error(), "not a succeeded run-owned collect receipt") {
			t.Fatalf("failed planned job error = %v", err)
		}
	})

	t.Run("different collector attempt", func(t *testing.T) {
		fixture := setup(t, []float64{10, 15}, 10, 15)
		other := beginResearchCheckpointAttempt(t, fixture.db, fixture.engine.cas, fixture.run,
			core.StageCollect, 1, "other-collector-thread")
		if _, err := fixture.db.SQL().ExecContext(context.Background(),
			"UPDATE engineering_jobs SET stage_attempt_id=? WHERE id=?", other.ID, fixture.jobs[1].ID); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.engine.prepareCollectorEvidence(context.Background(), fixture.run.ID, 0,
			"workstream-0", &fixture.plan, output(fixture.sources[0])); err == nil ||
			!strings.Contains(err.Error(), "not a succeeded run-owned collect receipt") {
			t.Fatalf("cross-attempt planned job error = %v", err)
		}
	})

	t.Run("different operation is never auto-included", func(t *testing.T) {
		fixture := setup(t, []float64{10}, 10, 15)
		if _, err := fixture.db.SQL().ExecContext(context.Background(),
			"UPDATE engineering_jobs SET operation='su2_naca0012' WHERE id=?", fixture.jobs[1].ID); err != nil {
			t.Fatal(err)
		}
		bundle, err := fixture.engine.prepareCollectorEvidence(context.Background(), fixture.run.ID, 0,
			"workstream-0", &fixture.plan, output(fixture.sources[0]))
		if err != nil {
			t.Fatalf("other operation changed planned XFOIL completion: %v", err)
		}
		if len(bundle.Sources) != 1 || bundle.Sources[0].ID != fixture.sources[0].ID {
			t.Fatalf("different operation was auto-included: %+v", bundle.Sources)
		}
	})
}

func mustEngineeringSource(t *testing.T, artifactID, blobHash string, capturedAt time.Time) core.EvidenceSource {
	t.Helper()
	source, err := core.EngineeringReceiptEvidenceSource(artifactID, "xfoil_polar", blobHash, capturedAt)
	if err != nil {
		t.Fatal(err)
	}
	return source
}

func testEngineeringVerificationEvidence(t *testing.T, source core.EvidenceSource) core.EvidenceBundle {
	t.Helper()
	return core.EvidenceBundle{
		WorkstreamID: engineeringVerificationWorkstreamID,
		Summary:      "fresh independent XFOIL verification",
		Claims: []core.EvidenceClaim{{
			ID: "claim-engineering-verification", Statement: "the fresh result agrees with the selected screening candidate",
			SourceIDs: []string{source.ID},
		}},
		Sources:     []core.EvidenceSource{source},
		Limitations: []string{"single-point independent recomputation"},
	}
}

func beginResearchCheckpointAttempt(
	t *testing.T,
	db *store.DB,
	objects *cas.Store,
	run core.Run,
	stage core.Stage,
	ordinal int,
	threadID string,
) core.StageAttempt {
	t.Helper()
	input, err := objects.PutBytes([]byte(`{"checkpoint":true}`))
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := db.BeginStage(context.Background(), run.ID, stage, ordinal, threadID, input.Hash)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetStageTurn(context.Background(), attempt.ID, threadID, "checkpoint-turn"); err != nil {
		t.Fatal(err)
	}
	return attempt
}

func captureCheckpointPublicEvidence(
	t *testing.T,
	db *store.DB,
	objects *cas.Store,
	run core.Run,
	attempt core.StageAttempt,
	bundle core.EvidenceBundle,
) {
	t.Helper()
	for _, source := range bundle.Sources {
		data := fixtureSource(bundle.WorkstreamID)
		receipt, err := objects.PutBytes(data)
		if err != nil {
			t.Fatal(err)
		}
		if receipt.Hash != source.BlobHash {
			t.Fatal("checkpoint evidence hash mismatch")
		}
		if _, err := db.CaptureEvidence(context.Background(), run.ID, attempt.ID, source.URL, source.Title,
			source.Publisher, "text/plain; charset=utf-8", receipt); err != nil {
			t.Fatal(err)
		}
	}
}

type checkpointXFOILSample struct {
	Alpha             float64 `json:"alpha_deg"`
	CL                float64 `json:"cl"`
	CD                float64 `json:"cd"`
	CDPressure        float64 `json:"cd_pressure"`
	CM                float64 `json:"cm_c4"`
	TopTransitionX    float64 `json:"top_transition_x_over_c"`
	BottomTransitionX float64 `json:"bottom_transition_x_over_c"`
}

type checkpointXFOILTrace struct {
	Left           checkpointXFOILSample `json:"left"`
	Right          checkpointXFOILSample `json:"right"`
	LeftIndex      int                   `json:"left_index"`
	RightIndex     int                   `json:"right_index"`
	LeftValueHash  string                `json:"left_value_hash"`
	RightValueHash string                `json:"right_value_hash"`
	Fraction       float64               `json:"right_weight"`
}

type checkpointXFOILTarget struct {
	AlphaDeg            float64              `json:"alpha_deg"`
	CL                  float64              `json:"cl"`
	CD                  float64              `json:"cd"`
	CM                  float64              `json:"cm_c4"`
	FlapDeflectionDeg   float64              `json:"flap_deflection_deg"`
	ConstraintSatisfied bool                 `json:"constraint_satisfied"`
	Interpolation       checkpointXFOILTrace `json:"interpolation"`
}

func checkpointXFOILSamples(deflection int) []checkpointXFOILSample {
	baseCD := 0.009 + math.Abs(float64(deflection-15))*0.0001
	return []checkpointXFOILSample{
		{Alpha: 0, CL: 0.7, CD: baseCD, CDPressure: baseCD / 2, CM: -0.15, TopTransitionX: 0.5, BottomTransitionX: 0.6},
		{Alpha: 1, CL: 0.9, CD: baseCD + 0.001, CDPressure: (baseCD + 0.001) / 2, CM: -0.17, TopTransitionX: 0.45, BottomTransitionX: 0.55},
	}
}

func makeCheckpointXFOILTarget(samples []checkpointXFOILSample, deflection float64) checkpointXFOILTarget {
	left, right := samples[0], samples[1]
	fraction := (0.8 - left.CL) / (right.CL - left.CL)
	return checkpointXFOILTarget{
		AlphaDeg: left.Alpha + fraction*(right.Alpha-left.Alpha),
		CL:       0.8, CD: left.CD + fraction*(right.CD-left.CD),
		CM:                left.CM + fraction*(right.CM-left.CM),
		FlapDeflectionDeg: deflection, ConstraintSatisfied: true,
		Interpolation: checkpointXFOILTrace{
			Left: left, Right: right, LeftIndex: 0, RightIndex: 1,
			LeftValueHash:  checkpointXFOILSampleHash(left),
			RightValueHash: checkpointXFOILSampleHash(right), Fraction: fraction,
		},
	}
}

func checkpointXFOILSampleHash(sample checkpointXFOILSample) string {
	encoded, _ := json.Marshal(sample)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func publishCheckpointXFOILPackage(
	t *testing.T,
	db *store.DB,
	objects *cas.Store,
	run core.Run,
	attempt core.StageAttempt,
	verificationJob store.EngineeringJob,
	winnerJobID string,
	verificationSamples []checkpointXFOILSample,
	verificationTarget checkpointXFOILTarget,
) []store.EngineeringJobArtifact {
	t.Helper()
	ctx := context.Background()
	results, err := db.ListRunEngineeringResults(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	type candidate struct {
		JobID             string                  `json:"job_id"`
		StageAttemptID    string                  `json:"stage_attempt_id"`
		ReceiptArtifactID string                  `json:"receipt_artifact_id"`
		ReceiptBlobHash   string                  `json:"receipt_blob_hash"`
		FlapDeflectionDeg float64                 `json:"flap_deflection_deg"`
		TargetReached     bool                    `json:"target_reached"`
		Target            checkpointXFOILTarget   `json:"target_metrics"`
		Samples           []checkpointXFOILSample `json:"-"`
	}
	candidates := make([]candidate, 0, len(results))
	series := make([]map[string]any, 0, len(results)+1)
	var winnerTarget checkpointXFOILTarget
	for _, result := range results {
		if result.Job.Operation != "xfoil_polar" {
			continue
		}
		var envelope struct {
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal([]byte(result.Job.SpecJSON), &envelope); err != nil {
			t.Fatal(err)
		}
		var arguments struct {
			FlapDeflectionDeg float64 `json:"flap_deflection_deg"`
		}
		if err := json.Unmarshal(envelope.Arguments, &arguments); err != nil {
			t.Fatal(err)
		}
		receiptArtifact, err := db.Artifact(ctx, result.Job.ReceiptArtifactID)
		if err != nil {
			t.Fatal(err)
		}
		receiptBytes, err := objects.ReadVerified(receiptArtifact.BlobHash)
		if err != nil {
			t.Fatal(err)
		}
		var receipt struct {
			Metrics struct {
				Samples []checkpointXFOILSample `json:"samples"`
			} `json:"metrics"`
		}
		if err := json.Unmarshal(receiptBytes, &receipt); err != nil {
			t.Fatal(err)
		}
		target := makeCheckpointXFOILTarget(receipt.Metrics.Samples, arguments.FlapDeflectionDeg)
		item := candidate{
			JobID: result.Job.ID, StageAttemptID: result.Job.StageAttemptID,
			ReceiptArtifactID: result.Job.ReceiptArtifactID, ReceiptBlobHash: receiptArtifact.BlobHash,
			FlapDeflectionDeg: arguments.FlapDeflectionDeg, TargetReached: true,
			Target: target, Samples: receipt.Metrics.Samples,
		}
		candidates = append(candidates, item)
		if result.Job.ID == winnerJobID {
			winnerTarget = target
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].FlapDeflectionDeg < candidates[j].FlapDeflectionDeg
	})
	if winnerTarget.CL != 0.8 || len(candidates) == 0 {
		t.Fatal("checkpoint XFOIL package has no deterministic screening winner")
	}
	for _, item := range candidates {
		series = append(series, map[string]any{
			"label":  fmt.Sprintf("%.6g deg", item.FlapDeflectionDeg),
			"job_id": item.JobID, "receipt_blob_hash": item.ReceiptBlobHash,
			"samples": item.Samples,
		})
	}
	series = append(series, map[string]any{
		"label": "verification", "job_id": verificationJob.ID, "samples": verificationSamples,
	})
	dossier := map[string]any{
		"schema":                            "xfoil_optimization_dossier_v1",
		"screening_attempt_count":           len(candidates),
		"screening_candidate_count":         len(candidates),
		"succeeded_screening_attempt_count": len(candidates),
		"failed_screening_attempt_count":    0,
		"screening_panel_count":             160, "verification_panel_count": 240,
		"screening_candidates": candidates,
		"winner_job_id":        winnerJobID, "winner_target_metrics": winnerTarget,
		"figures": []map[string]string{
			{"kind": "cl_alpha", "data_file": "optimization-graph-data.json", "render_file": "comparison-cl-alpha.svg"},
			{"kind": "cl_cd", "data_file": "optimization-graph-data.json", "render_file": "comparison-cl-cd.svg"},
			{"kind": "cm_cl", "data_file": "optimization-graph-data.json", "render_file": "comparison-cm-cl.svg"},
		},
		"verification": map[string]any{
			"workspace_id":              verificationJob.ID,
			"screening_workspace_id":    winnerJobID,
			"verification_workspace_id": verificationJob.ID,
			"workspaces_distinct":       winnerJobID != verificationJob.ID,
			"stage_attempt_id":          attempt.ID, "verification_of_job_id": winnerJobID,
			"attempt_count": 1, "process_spawn_count": 1,
			"execution_count": 1, "retry_count": 0, "isolated_workspace": true,
			"target_metrics": verificationTarget,
		},
	}
	publish := func(role, name, mediaType string, data []byte) store.EngineeringJobArtifact {
		receipt, err := objects.PutBytes(data)
		if err != nil {
			t.Fatal(err)
		}
		artifact, err := db.PublishArtifact(ctx, run.ID, attempt.ID,
			"engineering.xfoil_polar."+role, mediaType, receipt)
		if err != nil {
			t.Fatal(err)
		}
		return store.EngineeringJobArtifact{
			ArtifactID: artifact.ID, Role: role, FileName: name,
			MediaType: mediaType, BlobHash: receipt.Hash,
		}
	}
	links := []store.EngineeringJobArtifact{
		publish("optimization_dossier", "optimization-dossier.json", "application/json", mustJSON(t, dossier)),
		publish("graph_data", "optimization-graph-data.json", "application/json",
			mustJSON(t, map[string]any{"schema": "xfoil_graph_data_v1", "series": series})),
	}
	for _, graph := range []struct{ role, name, title string }{
		{"graph_cl_alpha", "comparison-cl-alpha.svg", "CL-alpha"},
		{"graph_cl_cd", "comparison-cl-cd.svg", "CL-CD"},
		{"graph_cm_cl", "comparison-cm-cl.svg", "Cm-CL"},
	} {
		var svg strings.Builder
		fmt.Fprintf(&svg, "<svg><title>%s</title>", graph.title)
		for range series {
			svg.WriteString("<polyline/>")
		}
		svg.WriteString("</svg>")
		links = append(links, publish(graph.role, graph.name, "image/svg+xml", []byte(svg.String())))
	}
	return links
}

func persistCheckpointXFOILJob(
	t *testing.T,
	db *store.DB,
	objects *cas.Store,
	run core.Run,
	attempt core.StageAttempt,
	purpose string,
	verificationOfJobID string,
	flapDeflection int,
) (store.EngineeringJob, core.EvidenceSource) {
	t.Helper()
	ctx := context.Background()
	arguments := map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID,
		"naca": "0015", "reynolds": 1_000_000, "mach": 0.1,
		"alpha_start_deg": -6, "alpha_end_deg": 18, "alpha_step_deg": 0.25,
		"flap_chord_ratio": 0.3, "flap_hinge_x_over_c": 0.7,
		"flap_hinge_y_over_c": 0.0, "flap_deflection_deg": flapDeflection,
		"ncrit": 9, "iterations": 200, "panel_count": 160,
		"optimization_objective": "minimize_cd_at_target_cl", "target_cl": 0.8,
		"minimum_cm": -0.2, "execution_purpose": purpose,
	}
	if purpose == "independent_verification" {
		arguments["panel_count"] = 240
		arguments["alpha_start_deg"] = 0.0
		arguments["alpha_end_deg"] = 1.0
		arguments["alpha_step_deg"] = 0.05
	}
	if verificationOfJobID != "" {
		arguments["verification_of_job_id"] = verificationOfJobID
	}
	argumentsBytes := mustJSON(t, arguments)
	argumentsJSON := string(argumentsBytes)
	argumentsDigest := sha256.Sum256(argumentsBytes)
	argumentsHash := hex.EncodeToString(argumentsDigest[:])
	approval, err := db.CreateApproval(ctx, core.Approval{
		RunID: run.ID, StageAttemptID: attempt.ID, ThreadID: attempt.CodexThreadID,
		TurnID: "checkpoint-turn", ItemID: fmt.Sprintf("xfoil-%s-%d", purpose, flapDeflection),
		Kind: "item/mcpToolCall/requestApproval", Summary: "checkpoint XFOIL receipt",
		Server: "aetherops_engineering", Tool: "xfoil_polar",
		ArgumentsJSON: argumentsJSON, ArgumentsSHA256: argumentsHash,
		Risk: "external_side_effect", ExternalSideEffect: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.DecideApproval(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	spec := struct {
		Arguments         json.RawMessage `json:"arguments"`
		Operation         string          `json:"operation"`
		RuntimeBundleHash string          `json:"runtime_bundle_hash"`
		ToolComponent     string          `json:"tool_component"`
		ToolVersion       string          `json:"tool_version"`
	}{
		Arguments: argumentsBytes, Operation: "xfoil_polar",
		RuntimeBundleHash: strings.Repeat("b", 64), ToolComponent: "xfoil", ToolVersion: "6.99",
	}
	specBytes := mustJSON(t, spec)
	specDigest := sha256.Sum256(specBytes)
	specHash := hex.EncodeToString(specDigest[:])
	job, execute, err := db.BeginEngineeringJob(ctx, store.EngineeringJob{
		ProjectID: run.ProjectID, RunID: run.ID, StageAttemptID: attempt.ID,
		Operation: "xfoil_polar", SpecJSON: string(specBytes), SpecSHA256: specHash,
		ToolComponent: "xfoil", ToolVersion: "6.99", ApprovalScopeHash: argumentsHash,
	})
	if err != nil || !execute {
		t.Fatalf("begin checkpoint XFOIL job: execute=%v err=%v", execute, err)
	}
	samples := checkpointXFOILSamples(flapDeflection)
	target := makeCheckpointXFOILTarget(samples, float64(flapDeflection))
	now := time.Now().UTC()
	receiptBytes := mustJSON(t, map[string]any{
		"schema": 1, "job_id": job.ID, "run_id": run.ID, "stage_attempt_id": attempt.ID,
		"operation": job.Operation, "spec": json.RawMessage(specBytes), "spec_sha256": specHash,
		"executables": []any{}, "threads": 1,
		"started_at": now.Add(-time.Second), "completed_at": now,
		"exit_codes": []int{0}, "executed": true, "numerically_valid": true,
		"metrics": map[string]any{
			"sample_count": 97, "requested_point_count": 97,
			"nonconverged_point_count": 0, "missing_point_count": 0,
			"samples": samples,
			"optimization": map[string]any{
				"objective": "minimize_cd_at_target_cl", "target_cl": 0.8,
				"minimum_cm": -0.2, "target_reached": true, "target_metrics": target,
			},
		},
		"artifacts": []any{},
	})
	receipt, err := objects.PutBytes(receiptBytes)
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := db.PublishArtifact(ctx, run.ID, attempt.ID,
		"engineering.xfoil_polar.receipt", "application/json", receipt)
	if err != nil {
		t.Fatal(err)
	}
	links := []store.EngineeringJobArtifact{{
		ArtifactID: artifact.ID, Role: "receipt", FileName: "execution-receipt.json",
		MediaType: "application/json", BlobHash: receipt.Hash,
	}}
	if purpose == "independent_verification" {
		derived := publishCheckpointXFOILPackage(t, db, objects, run, attempt, job, verificationOfJobID, samples, target)
		links = append(links, derived...)
	}
	if _, err := db.CompleteEngineeringJob(ctx, job.ID, artifact.ID, links); err != nil {
		t.Fatal(err)
	}
	if err := db.MarkStageExternalSideEffects(ctx, attempt.ID); err != nil {
		t.Fatal(err)
	}
	storedJob, err := db.EngineeringJob(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	return storedJob, mustEngineeringSource(t, artifact.ID, receipt.Hash, artifact.CreatedAt)
}

func finishResearchCheckpointAttempt(
	t *testing.T,
	db *store.DB,
	objects *cas.Store,
	run core.Run,
	attempt core.StageAttempt,
	output any,
	externalSideEffect bool,
) {
	t.Helper()
	ctx := context.Background()
	if bundle, ok := output.(core.EvidenceBundle); ok {
		bundle, err := canonicalizeEvidenceClaimIDs(run.ID, bundle)
		if err != nil {
			t.Fatal(err)
		}
		output = bundle
	}
	encoded := mustJSON(t, output)
	receipt, err := objects.PutBytes(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.PublishArtifact(ctx, run.ID, attempt.ID, "research.checkpoint", "application/json", receipt); err != nil {
		t.Fatal(err)
	}
	if externalSideEffect {
		if err := db.MarkStageExternalSideEffects(ctx, attempt.ID); err != nil {
			t.Fatal(err)
		}
	}
	profile, err := profileForStage(run.ResearchProfileVersion, attempt.Stage)
	if err != nil {
		t.Fatal(err)
	}
	executionReceipt := store.StageExecutionReceipt{
		StageAttemptID: attempt.ID, RunID: run.ID, ResearchProfileVersion: run.ResearchProfileVersion,
		Model: profile.Model, ReasoningEffort: profile.ReasoningEffort, ServiceTier: profile.ServiceTier,
		CodexThreadID: attempt.CodexThreadID, CodexTurnID: "checkpoint-turn",
		InputSHA256: attempt.InputArtifactHash, OutputSHA256: receipt.Hash,
		ExecutionContractSHA256: core.StageExecutionContractSHA256, ProductBuild: run.ProductBuild,
	}
	if err := db.CompleteStageWithExecution(ctx, attempt.ID, receipt.Hash, executionReceipt); err != nil {
		t.Fatal(err)
	}
}

func testPlan(question string, workstreams int) core.ResearchPlan {
	plan := core.ResearchPlan{
		Question:           question,
		Mode:               "general",
		SourceRequirements: []string{"primary source"},
		AcceptanceCriteria: []string{"cited answer"},
	}
	for index := range workstreams {
		plan.Workstreams = append(plan.Workstreams, core.Workstream{
			ID:                   fmt.Sprintf("workstream-%d", index),
			Question:             fmt.Sprintf("subquestion-%d", index),
			PreferredSourceKinds: []string{"primary"},
			RequiredEvidence:     []string{"source"},
		})
	}
	return plan
}

func testXFOILScreeningPlan(deflections ...float64) *core.XFOILScreeningPlan {
	return &core.XFOILScreeningPlan{
		NACA: "0015", Reynolds: 1_000_000, Mach: 0.1,
		AlphaStartDeg: -6, AlphaEndDeg: 18, AlphaStepDeg: 0.25,
		FlapChordRatio: 0.3, FlapHingeXOverC: 0.7, FlapHingeYOverC: 0,
		CandidateDeflectionsDeg: append([]float64(nil), deflections...),
		NCrit:                   9, Iterations: 200, PanelCount: 160,
		OptimizationObjective: "minimize_cd_at_target_cl", TargetCL: 0.8, MinimumCM: -0.2,
	}
}

func testEvidence(workstreamID string) core.EvidenceBundle {
	sourceID := "source-" + workstreamID
	claimID := "claim-" + workstreamID
	return core.EvidenceBundle{
		WorkstreamID: workstreamID,
		Summary:      "structured evidence",
		Claims: []core.EvidenceClaim{{
			ID:        claimID,
			Statement: "supported claim",
			SourceIDs: []string{sourceID},
		}},
		Sources: []core.EvidenceSource{{
			ID:         sourceID,
			URL:        "https://example.test/" + workstreamID,
			Title:      "source title",
			CapturedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
			BlobHash:   fixtureSourceHash(workstreamID),
		}},
		Limitations: []string{"fixture limitation"},
	}
}

func canonicalEvidenceClaimID(runID, workstreamID, rawClaimID string) string {
	digest := sha256.Sum256([]byte(runID + "\x00" + workstreamID + "\x00" + rawClaimID))
	return "ecl_" + hex.EncodeToString(digest[:])
}

func collectorOutputForBundle(bundle core.EvidenceBundle) collectorEvidenceOutput {
	output := collectorEvidenceOutput{
		WorkstreamID:                  bundle.WorkstreamID,
		Summary:                       bundle.Summary,
		Claims:                        append([]core.EvidenceClaim(nil), bundle.Claims...),
		Sources:                       []core.EvidenceSource{},
		EngineeringReceiptArtifactIDs: []string{},
		Limitations:                   append([]string(nil), bundle.Limitations...),
	}
	for _, source := range bundle.Sources {
		if artifactID, ok := core.EngineeringReceiptArtifactID(source); ok {
			output.EngineeringReceiptArtifactIDs = append(output.EngineeringReceiptArtifactIDs, artifactID)
			continue
		}
		output.Sources = append(output.Sources, source)
	}
	return output
}

func testReport(workstreamCounts ...int) core.ReportManifest {
	workstreams := 1
	if len(workstreamCounts) > 0 {
		workstreams = workstreamCounts[0]
	}
	evidenceIDs := make([]string, 0, workstreams)
	for index := range workstreams {
		evidenceIDs = append(evidenceIDs, fmt.Sprintf("workstream-%d", index))
	}
	evidenceBytes := fixtureSource("workstream-0")
	return core.ReportManifest{
		Title:          "report",
		AnswerMarkdown: "answer [1]",
		Citations: []core.Citation{{
			Marker:    "[1]",
			SourceIDs: []string{"source-workstream-0"},
			ClaimIDs:  []string{"claim-workstream-0"},
		}},
		EvidenceIDs:    evidenceIDs,
		ArtifactHashes: []string{},
		Uncertainties:  []string{"fixture uncertainty"},
		KnowledgePatch: core.KnowledgePatch{
			SchemaVersion: core.KnowledgePatchSchemaV1, UnitRegistryVersion: core.CurrentUnitRegistryVersion,
			Entities: []core.KnowledgeEntity{{
				ID: "entity-0", Type: "measurement", CanonicalName: "fixture entity", Aliases: []core.KnowledgeAlias{},
			}},
			Assertions: []core.KnowledgeAssertion{{
				ID: "assertion-0", SubjectEntityID: "entity-0", Predicate: "has_unit",
				ObjectLiteral: &core.KnowledgeTypedLiteral{
					LexicalForm: "supported claim", Datatype: "http://www.w3.org/2001/XMLSchema#string",
				},
				Qualifiers: []core.KnowledgeQualifier{},
				Evidence: []core.KnowledgeEvidenceRef{{
					Kind: core.KnowledgeEvidenceText, SourceID: "source-workstream-0", ClaimID: "claim-workstream-0",
					BlobHash: fixtureSourceHash("workstream-0"), ByteStart: 0, ByteEnd: int64(len(evidenceBytes)),
					SpanHash: fixtureSourceHash("workstream-0"),
				}},
			}},
		},
	}
}

func testReportForEvidence(evidence []core.EvidenceBundle) core.ReportManifest {
	report := testReport(len(evidence))
	report.EvidenceIDs = report.EvidenceIDs[:0]
	for _, bundle := range evidence {
		report.EvidenceIDs = append(report.EvidenceIDs, bundle.WorkstreamID)
	}
	if len(evidence) != 0 && len(evidence[0].Claims) != 0 {
		report.Citations[0].ClaimIDs[0] = evidence[0].Claims[0].ID
		report.KnowledgePatch.Assertions[0].Evidence[0].ClaimID = evidence[0].Claims[0].ID
	}
	return report
}

func fixtureSource(workstreamID string) []byte {
	return []byte("deterministic protocol evidence for " + workstreamID)
}

func fixtureSourceHash(workstreamID string) string {
	sum := sha256.Sum256(fixtureSource(workstreamID))
	return hex.EncodeToString(sum[:])
}

func testVerdict(passes bool) core.ReviewVerdict {
	unsupportedAssertions := 0
	if !passes {
		unsupportedAssertions = 1
	}
	verdict := core.ReviewVerdict{
		CitationIntegrityPercent: 100,
		KnowledgeIntegrity: &core.KnowledgeIntegrity{
			EvidenceIntegrityPercent: 100,
			UnsupportedAssertions:    unsupportedAssertions,
		},
		CriticalErrors: []string{},
		Scores: core.ReviewScores{
			TaskFulfillment:           4,
			ClaimSupport:              4,
			SourceQuality:             4,
			Completeness:              4,
			ReasoningAndUncertainty:   4,
			ClarityAndReproducibility: 4,
		},
		RevisionRequests:  []string{"improve citation"},
		RemediationAction: core.ReviewRemediationNone,
		RemediationTasks:  []core.ReviewRemediationTask{},
		Summary:           "review",
	}
	if !passes {
		verdict.RemediationAction = core.ReviewRemediationReportRevision
	}
	return verdict
}

func mustJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := mustJSONValue(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func mustJSONValue(value any) (json.RawMessage, error) {
	encoded, err := json.Marshal(value)
	return json.RawMessage(encoded), err
}
