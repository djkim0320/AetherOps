package releasegate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/livee2econtract"
	managedruntime "github.com/djkim0320/Aether-claw/internal/runtime"
)

func liveE2ETestDigest(character string) string { return strings.Repeat(character, 64) }

func bindLiveE2ETestVerificationSource(details *livee2econtract.Details) {
	details.Solver.VerificationSourceRuntimeSHA256 = details.Solver.RuntimeBundleSHA256
	details.Solver.VerificationSourceComponent = details.Solver.Component
	details.Solver.VerificationSourceVersion = details.Solver.Version
	details.Solver.VerificationSourceSpecSHA256 = liveE2ETestDigest("a")
	details.Solver.VerificationSourcePhysicalSHA256 = liveE2ETestDigest("e")
	details.Solver.VerificationSourceReceiptID = "art_screen_receipt"
	details.Solver.VerificationSourceReceiptSHA256 = liveE2ETestDigest("b")
}

func structuralLiveE2EV2Vector(t *testing.T) (livee2econtract.Details, EvidenceReceipt, int, time.Time) {
	t.Helper()
	preparedAt := time.Date(2026, 8, 9, 2, 0, 0, 0, time.UTC)
	build := buildinfo.ProductBuildBinding{
		Version: buildinfo.ReleaseProductVersion, ExecutableSHA256: liveE2ETestDigest("a"),
		RuntimeManifestSHA256: liveE2ETestDigest("b"), KnowledgeSidecarTreeSHA256: liveE2ETestDigest("c"),
	}
	candidateID, err := CandidateID(build)
	if err != nil {
		t.Fatal(err)
	}
	promptDigest := sha256.Sum256([]byte(livee2econtract.ResearchPrompt))
	queryDigest := sha256.Sum256([]byte(livee2econtract.SPARQLQuery))
	evaluationVerifiedAt := preparedAt.Add(30 * time.Second)
	observationSessionStartedAt := preparedAt.Add(45 * time.Second)
	liveStarted, liveFinished := preparedAt.Add(time.Minute), preparedAt.Add(20*time.Minute)
	runCreated, runTerminal := liveStarted.Add(time.Minute), liveFinished.Add(-time.Minute)
	details := livee2econtract.Details{
		Schema: livee2econtract.DetailsSchemaV2,
		Binding: livee2econtract.Binding{
			ProductBuild: build, ReleaseCandidateID: candidateID,
			PreparedLedgerSHA256: liveE2ETestDigest("d"), PreparedLedgerRevision: 4,
			LedgerPreparedAt: preparedAt, RunnerReceiptSHA256: liveE2ETestDigest("e"),
			EvaluationSHA256: liveE2ETestDigest("f"), EvalRunSetID: "ers_live",
			DatasetSHA256: liveE2ETestDigest("1"), RunnerEndpointSHA256: liveE2ETestDigest("2"),
			EvaluationVerifiedAt:               evaluationVerifiedAt,
			ObservationSessionDescriptorSHA256: liveE2ETestDigest("3"),
			ObservationEndpointSHA256:          liveE2ETestDigest("4"),
			ObservationSessionStartedAt:        observationSessionStartedAt,
			ProjectID:                          "prj_live", PromptSHA256: hex.EncodeToString(promptDigest[:]),
		},
		LiveJournalSHA256: liveE2ETestDigest("4"), LiveStartedAt: liveStarted,
		LiveFinishedAt: liveFinished, OfflineVerifiedAt: liveFinished.Add(time.Minute),
		Browser: livee2econtract.BrowserObservation{
			Executed: true, Compatible: true,
			Observation: "Chrome DevTools MCP executed list_pages and take_snapshot against internet WebView2",
			ObservedAt:  liveStarted.Add(10 * time.Second),
		},
		Run: livee2econtract.RunObservation{
			RunID: "run_live", ProjectID: "prj_live", ConversationSessionID: "ses_live",
			ReportArtifactID: "art_report", Status: string(core.RunSucceeded), Revision: 9,
			CreatedAt: runCreated, TerminalAt: runTerminal,
		},
		// Deliberately not sorted by stage. Verification must use identities,
		// not the serialization order of durable stage receipts.
		Stages: []livee2econtract.StageProof{
			liveE2ETestStage("review", string(core.StageReview), 0, core.ReviewerModel, core.ReviewerEffort, "thread-review", "turn-review", runTerminal.Add(-time.Minute)),
			liveE2ETestStage("collect", string(core.StageCollect), 0, core.CollectorModel, core.CollectorEffort, "thread-collect", "turn-collect", runCreated.Add(3*time.Minute)),
			liveE2ETestStage("plan", string(core.StagePlan), 0, core.PlannerModel, core.PlannerEffort, "thread-main", "turn-plan", runCreated.Add(time.Minute)),
			liveE2ETestStage("synthesize", string(core.StageSynthesize), 0, core.PlannerModel, core.PlannerEffort, "thread-main", "turn-synthesize", runCreated.Add(5*time.Minute)),
		},
		MCPEvidence: []livee2econtract.MCPEvidenceProof{{
			EvidenceID: "evd_live", StageAttemptID: "stg_collect", BlobSHA256: liveE2ETestDigest("5"),
			Size: 128, CapturedAt: runCreated.Add(2 * time.Minute), InternalMCP: true,
		}},
		Solver: livee2econtract.SolverProof{
			JobID: "eng_live", StageAttemptID: "stg_collect", Operation: "xfoil_polar", Component: "xfoil", Version: managedruntime.PinnedXFOILVersion,
			SpecSHA256: liveE2ETestDigest("6"), RuntimeBundleSHA256: liveE2ETestDigest("0"),
			PhysicalArgumentsSHA256: liveE2ETestDigest("d"), ReceiptArtifactID: "art_solver",
			ReceiptBlobSHA256: liveE2ETestDigest("7"), ArtifactSetSHA256: liveE2ETestDigest("8"),
			Threads: 2, Executed: true, NumericallyValid: true, CompletedAt: runCreated.Add(4 * time.Minute),
		},
		CASObjectsVerified: 8, CASReadbackSetSHA256: liveE2ETestDigest("9"),
		SPARQL: livee2econtract.SPARQLObservation{
			GenerationID: "kgen_live", QuerySHA256: hex.EncodeToString(queryDigest[:]),
			ResultSHA256: liveE2ETestDigest("a"), QueryForm: "SELECT", Complete: true, ResponseBytes: 80,
		},
		Graph: livee2econtract.GraphProof{
			GenerationID: "kgen_live", SnapshotSHA256: liveE2ETestDigest("b"),
			CanonicalSHA256: liveE2ETestDigest("b"), TripleCount: 42, SPARQLResultSHA256: liveE2ETestDigest("a"),
		},
		Curation: livee2econtract.CurationObservation{
			EventID: "kce_live", Sequence: 7, GenerationID: "kgen_live", Kind: "pin_entity",
			PayloadSHA256: liveE2ETestDigest("c"), EventSHA256: liveE2ETestDigest("d"),
			MemoBlobSHA256: liveE2ETestDigest("e"), EntityID: "kent_live",
		},
		EvaluationRequiredCases: 12, EvaluationObservedPasses: 12,
		FixtureRole: "none", ReleaseGateEligible: true, NoAmbiguousWritesReplayed: true,
	}
	raw, err := json.Marshal(details)
	if err != nil {
		t.Fatal(err)
	}
	detailsDigest := sha256.Sum256(raw)
	environmentDigest := sha256.Sum256([]byte("aetherops-live-e2e-environment-v2\x00" + details.Binding.ObservationEndpointSHA256 + "\x00" + details.Binding.ProjectID + "\x00" + details.Binding.ObservationSessionDescriptorSHA256))
	receipt := EvidenceReceipt{
		Schema: EvidenceSchemaV1, GateID: "live_end_to_end", EvidenceKind: EvidenceLiveService,
		ReleaseCandidateID: candidateID, ProductBuild: build,
		Producer:    Producer{Name: livee2econtract.ProducerName, Version: livee2econtract.ProducerVersion},
		Environment: Environment{Class: string(EvidenceLiveService), OS: "windows-11", Architecture: "amd64", IdentitySHA256: hex.EncodeToString(environmentDigest[:])},
		ObservedAt:  details.OfflineVerifiedAt, Status: "passed", DetailsPath: "live.details.json",
		DetailsSHA256: hex.EncodeToString(detailsDigest[:]),
	}
	expected := liveEndToEndExpectedSubjects(details, receipt)
	names := make([]string, 0, len(expected))
	for name := range expected {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		receipt.SubjectHashes = append(receipt.SubjectHashes, SubjectHash{Name: name, SHA256: expected[name]})
	}
	return details, receipt, details.Binding.PreparedLedgerRevision, preparedAt
}

func liveE2ETestStage(id, stage string, ordinal int, model, effort, thread, turn string, completedAt time.Time) livee2econtract.StageProof {
	proof := livee2econtract.StageProof{
		StageAttemptID: "stg_" + id, Stage: stage, Ordinal: ordinal, Model: model,
		ReasoningEffort: effort, ServiceTier: core.ServiceTierDefault, CodexThreadID: thread,
		CodexTurnID: turn, InputSHA256: liveE2ETestDigest("1"), OutputSHA256: liveE2ETestDigest("2"),
		ExecutionContractSHA256: core.StageExecutionContractSHA256, CompletedAt: completedAt,
	}
	if stage == string(core.StageCollect) {
		proof.WorkstreamID = fmt.Sprintf("ws-%d", ordinal)
		if ordinal == core.EngineeringVerificationOrdinal {
			proof.WorkstreamID = "aetherops_engineering_verification"
		}
	}
	return proof
}

func refreshLiveE2EReceipt(t *testing.T, details livee2econtract.Details, receipt EvidenceReceipt) EvidenceReceipt {
	t.Helper()
	raw, err := json.Marshal(details)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	receipt.DetailsSHA256 = hex.EncodeToString(digest[:])
	receipt.SubjectHashes = nil
	expected := liveEndToEndExpectedSubjects(details, receipt)
	names := make([]string, 0, len(expected))
	for name := range expected {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		receipt.SubjectHashes = append(receipt.SubjectHashes, SubjectHash{Name: name, SHA256: expected[name]})
	}
	return receipt
}

func TestLiveEndToEndV2TypedVerifierIsStructurallyReachable(t *testing.T) {
	// This in-memory vector proves that the reviewed v2 branch is reachable.
	// It does not run the producer, contact live services, publish sibling
	// files, or constitute release evidence.
	details, receipt, revision, preparedAt := structuralLiveE2EV2Vector(t)
	if details.Binding.RunnerEndpointSHA256 == details.Binding.ObservationEndpointSHA256 {
		t.Fatal("structural v2 vector did not model independent runner and observation endpoints")
	}
	raw, err := json.Marshal(details)
	if err != nil {
		t.Fatal(err)
	}
	if err := receipt.Validate(); err != nil {
		t.Fatalf("receipt policy validation failed: %v", err)
	}
	if err := validateLiveEndToEndDetailsForLedger(raw, receipt, revision, preparedAt); err != nil {
		t.Fatal(err)
	}
}

func TestValidateLiveEndToEndStagesAcceptsMaximumRevisionPath(t *testing.T) {
	started := time.Date(2026, 8, 9, 3, 0, 0, 0, time.UTC)
	finished := started.Add(time.Hour)
	stages := []livee2econtract.StageProof{
		liveE2ETestStage("plan", string(core.StagePlan), 0, core.PlannerModel, core.PlannerEffort, "thread-main", "turn-plan", started.Add(time.Minute)),
		liveE2ETestStage("synthesize", string(core.StageSynthesize), 0, core.PlannerModel, core.PlannerEffort, "thread-main", "turn-synthesize", started.Add(10*time.Minute)),
	}
	for ordinal := 0; ordinal < core.MaxCollectors; ordinal++ {
		stages = append(stages, liveE2ETestStage(
			fmt.Sprintf("collect-%d", ordinal), string(core.StageCollect), ordinal,
			core.CollectorModel, core.CollectorEffort,
			fmt.Sprintf("thread-collect-%d", ordinal), fmt.Sprintf("turn-collect-%d", ordinal),
			started.Add(time.Duration(ordinal+2)*time.Minute),
		))
	}
	for ordinal := 0; ordinal <= core.MaxRevisions; ordinal++ {
		stages = append(stages, liveE2ETestStage(
			fmt.Sprintf("review-%d", ordinal), string(core.StageReview), ordinal,
			core.ReviewerModel, core.ReviewerEffort,
			fmt.Sprintf("thread-review-%d", ordinal), fmt.Sprintf("turn-review-%d", ordinal),
			started.Add(time.Duration(20+ordinal*2)*time.Minute),
		))
		if ordinal < core.MaxRevisions {
			stages = append(stages, liveE2ETestStage(
				fmt.Sprintf("revise-%d", ordinal+1), string(core.StageRevise), ordinal+1,
				core.PlannerModel, core.PlannerEffort, "thread-main", fmt.Sprintf("turn-revise-%d", ordinal),
				started.Add(time.Duration(21+ordinal*2)*time.Minute),
			))
		}
	}
	if want := 3 + core.MaxCollectors + 2*core.MaxRevisions; len(stages) != want {
		t.Fatalf("maximum stage fixture cardinality=%d want=%d", len(stages), want)
	}
	if err := validateLiveEndToEndStages(stages, started, finished); err != nil {
		t.Fatal(err)
	}
}

func TestValidateLiveEndToEndDetailsAcceptsReservedEngineeringVerification(t *testing.T) {
	details, receipt, revision, preparedAt := structuralLiveE2EV2Vector(t)
	details.Stages = append(details.Stages,
		liveE2ETestStage("collect-1", string(core.StageCollect), 1, core.CollectorModel, core.CollectorEffort,
			"thread-collect-1", "turn-collect-1", details.Run.CreatedAt.Add(4*time.Minute)),
		liveE2ETestStage("verification", string(core.StageCollect), core.EngineeringVerificationOrdinal,
			core.CollectorModel, core.CollectorEffort, "thread-verification", "turn-verification",
			details.Run.CreatedAt.Add(5*time.Minute)),
	)
	details.Solver.StageAttemptID = "stg_verification"
	details.Solver.ExecutionPurpose = "independent_verification"
	details.Solver.VerificationOfJobID = "eng_screening"
	details.Solver.VerificationSourceStageAttemptID = "stg_collect-1"
	bindLiveE2ETestVerificationSource(&details)
	receipt = refreshLiveE2EReceipt(t, details, receipt)
	raw, err := json.Marshal(details)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateLiveEndToEndDetailsForLedger(raw, receipt, revision, preparedAt); err != nil {
		t.Fatal(err)
	}
}

func TestValidateLiveEndToEndDetailsRejectsVerificationRuntimeDrift(t *testing.T) {
	details, receipt, revision, preparedAt := structuralLiveE2EV2Vector(t)
	details.Stages = append(details.Stages,
		liveE2ETestStage("collect-1", string(core.StageCollect), 1, core.CollectorModel, core.CollectorEffort,
			"thread-collect-1", "turn-collect-1", details.Run.CreatedAt.Add(4*time.Minute)),
		liveE2ETestStage("verification", string(core.StageCollect), core.EngineeringVerificationOrdinal,
			core.CollectorModel, core.CollectorEffort, "thread-verification", "turn-verification",
			details.Run.CreatedAt.Add(5*time.Minute)),
	)
	details.Solver.StageAttemptID = "stg_verification"
	details.Solver.ExecutionPurpose = "independent_verification"
	details.Solver.VerificationOfJobID = "eng_screening"
	details.Solver.VerificationSourceStageAttemptID = "stg_collect-1"
	bindLiveE2ETestVerificationSource(&details)
	details.Solver.VerificationSourceRuntimeSHA256 = liveE2ETestDigest("f")
	receipt = refreshLiveE2EReceipt(t, details, receipt)
	raw, err := json.Marshal(details)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateLiveEndToEndDetailsForLedger(raw, receipt, revision, preparedAt); err == nil {
		t.Fatal("verification with a different runtime bundle was accepted")
	}
}

func TestValidateLiveEndToEndDetailsRejectsReusedScreeningResolutionIdentity(t *testing.T) {
	details, receipt, revision, preparedAt := structuralLiveE2EV2Vector(t)
	details.Stages = append(details.Stages,
		liveE2ETestStage("collect-1", string(core.StageCollect), 1, core.CollectorModel, core.CollectorEffort,
			"thread-collect-1", "turn-collect-1", details.Run.CreatedAt.Add(4*time.Minute)),
		liveE2ETestStage("verification", string(core.StageCollect), core.EngineeringVerificationOrdinal,
			core.CollectorModel, core.CollectorEffort, "thread-verification", "turn-verification",
			details.Run.CreatedAt.Add(5*time.Minute)),
	)
	details.Solver.StageAttemptID = "stg_verification"
	details.Solver.ExecutionPurpose = "independent_verification"
	details.Solver.VerificationOfJobID = "eng_screening"
	details.Solver.VerificationSourceStageAttemptID = "stg_collect-1"
	bindLiveE2ETestVerificationSource(&details)
	details.Solver.VerificationSourcePhysicalSHA256 = details.Solver.PhysicalArgumentsSHA256
	receipt = refreshLiveE2EReceipt(t, details, receipt)
	raw, err := json.Marshal(details)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateLiveEndToEndDetailsForLedger(raw, receipt, revision, preparedAt); err == nil {
		t.Fatal("verification that reused the screening physical-resolution identity was accepted")
	}
}

func TestValidateLiveEndToEndDetailsRejectsMissingFakeAndOverflowVerificationCollectors(t *testing.T) {
	base, receipt, revision, preparedAt := structuralLiveE2EV2Vector(t)
	tests := []struct {
		name   string
		mutate func(*livee2econtract.Details)
	}{
		{"missing reserved collector", func(value *livee2econtract.Details) {
			value.Solver.ExecutionPurpose = "independent_verification"
			value.Solver.VerificationOfJobID = "eng_screening"
			value.Solver.VerificationSourceStageAttemptID = "stg_collect"
			value.Solver.VerificationSourceRuntimeSHA256 = value.Solver.RuntimeBundleSHA256
		}},
		{"fake reserved collector", func(value *livee2econtract.Details) {
			value.Stages = append(value.Stages, liveE2ETestStage(
				"verification", string(core.StageCollect), core.EngineeringVerificationOrdinal,
				core.CollectorModel, core.CollectorEffort, "thread-verification", "turn-verification",
				value.Run.CreatedAt.Add(4*time.Minute)))
		}},
		{"collector ordinal overflow", func(value *livee2econtract.Details) {
			value.Stages = append(value.Stages, liveE2ETestStage(
				"overflow", string(core.StageCollect), core.EngineeringVerificationOrdinal+1,
				core.CollectorModel, core.CollectorEffort, "thread-overflow", "turn-overflow",
				value.Run.CreatedAt.Add(4*time.Minute)))
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := base
			value.Stages = append([]livee2econtract.StageProof(nil), base.Stages...)
			test.mutate(&value)
			localReceipt := refreshLiveE2EReceipt(t, value, receipt)
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if err := validateLiveEndToEndDetailsForLedger(raw, localReceipt, revision, preparedAt); err == nil {
				t.Fatal("invalid engineering verification stage set was accepted")
			}
		})
	}
}

func TestValidateLiveEndToEndStagesRejectsBrokenReviewCycle(t *testing.T) {
	details, _, _, _ := structuralLiveE2EV2Vector(t)
	details.Stages = append(details.Stages, liveE2ETestStage(
		"revise-1", string(core.StageRevise), 1, core.PlannerModel, core.PlannerEffort,
		"thread-main", "turn-revise-1", details.Run.TerminalAt.Add(-30*time.Second),
	))
	if err := validateLiveEndToEndStages(details.Stages, details.Run.CreatedAt, details.Run.TerminalAt); err == nil {
		t.Fatal("revision without its following review was accepted")
	}
}

func TestValidateLiveEndToEndDetailsRejectsMutationsAndFixtures(t *testing.T) {
	base, receipt, revision, preparedAt := structuralLiveE2EV2Vector(t)
	tests := []struct {
		name   string
		mutate func(*livee2econtract.Details)
	}{
		{"fixture", func(value *livee2econtract.Details) { value.FixtureRole = "protocol_fixture" }},
		{"replayed ambiguous write", func(value *livee2econtract.Details) { value.NoAmbiguousWritesReplayed = false }},
		{"observation session predates evaluation", func(value *livee2econtract.Details) {
			value.Binding.ObservationSessionStartedAt = value.Binding.EvaluationVerifiedAt.Add(-time.Nanosecond)
		}},
		{"browser not executed", func(value *livee2econtract.Details) { value.Browser.Executed = false }},
		{"wrong stage tier", func(value *livee2econtract.Details) { value.Stages[0].ServiceTier = core.ServiceTierFast }},
		{"stage outside run", func(value *livee2econtract.Details) {
			value.Stages[0].CompletedAt = value.Run.TerminalAt.Add(time.Second)
		}},
		{"reused isolated thread", func(value *livee2econtract.Details) { value.Stages[0].CodexThreadID = "thread-collect" }},
		{"mcp provenance removed", func(value *livee2econtract.Details) { value.MCPEvidence[0].InternalMCP = false }},
		{"mcp evidence outside collect", func(value *livee2econtract.Details) { value.MCPEvidence[0].StageAttemptID = "stg_plan" }},
		{"solver not executed", func(value *livee2econtract.Details) { value.Solver.Executed = false }},
		{"solver outside collect", func(value *livee2econtract.Details) { value.Solver.StageAttemptID = "stg_plan" }},
		{"sparql incomplete", func(value *livee2econtract.Details) { value.SPARQL.Complete = false }},
		{"generation mismatch", func(value *livee2econtract.Details) { value.Curation.GenerationID = "kgen_other" }},
		{"curation mutation", func(value *livee2econtract.Details) { value.Curation.Kind = "merge_entities" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := base
			value.Stages = append([]livee2econtract.StageProof(nil), base.Stages...)
			value.MCPEvidence = append([]livee2econtract.MCPEvidenceProof(nil), base.MCPEvidence...)
			test.mutate(&value)
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if err := validateLiveEndToEndDetailsForLedger(raw, receipt, revision, preparedAt); err == nil {
				t.Fatal("mutated evidence was accepted")
			}
		})
	}
}

func TestValidateLiveEndToEndRejectsRetiredV1Contracts(t *testing.T) {
	details, receipt, revision, preparedAt := structuralLiveE2EV2Vector(t)
	details.Schema = "aetherops_live_end_to_end_details_v1"
	raw, err := json.Marshal(details)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateLiveEndToEndDetailsForLedger(raw, receipt, revision, preparedAt); err == nil {
		t.Fatal("retired v1 details schema was accepted")
	}
	_, receipt, _, _ = structuralLiveE2EV2Vector(t)
	receipt.Producer.Version = "1"
	if err := receipt.Validate(); err == nil {
		t.Fatal("retired v1 trusted producer was accepted")
	}
}

func TestValidateLiveEndToEndDetailsRejectsNonExactSubjects(t *testing.T) {
	details, receipt, revision, preparedAt := structuralLiveE2EV2Vector(t)
	raw, err := json.Marshal(details)
	if err != nil {
		t.Fatal(err)
	}
	receipt.SubjectHashes = receipt.SubjectHashes[:len(receipt.SubjectHashes)-1]
	if err := validateLiveEndToEndDetailsForLedger(raw, receipt, revision, preparedAt); err == nil {
		t.Fatal("receipt with a missing subject was accepted")
	}
	_, receipt, revision, preparedAt = structuralLiveE2EV2Vector(t)
	receipt.SubjectHashes = append(receipt.SubjectHashes, SubjectHash{Name: "unexpected", SHA256: liveE2ETestDigest("f")})
	if err := validateLiveEndToEndDetailsForLedger(raw, receipt, revision, preparedAt); err == nil {
		t.Fatal("receipt with an extra subject was accepted")
	}
}

func TestValidateLiveEndToEndDetailsRejectsLedgerAndEnvironmentMismatch(t *testing.T) {
	details, receipt, revision, preparedAt := structuralLiveE2EV2Vector(t)
	raw, err := json.Marshal(details)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateLiveEndToEndDetailsForLedger(raw, receipt, revision+1, preparedAt); err == nil {
		t.Fatal("evidence from a non-immediate predecessor revision was accepted")
	}
	receipt.Environment.OS = "windows"
	if err := validateLiveEndToEndDetailsForLedger(raw, receipt, revision, preparedAt); err == nil {
		t.Fatal("non-exact live environment was accepted")
	}
	_, receipt, revision, preparedAt = structuralLiveE2EV2Vector(t)
	runnerEnvironment := sha256.Sum256([]byte("aetherops-live-e2e-environment-v2\x00" + details.Binding.RunnerEndpointSHA256 + "\x00" + details.Binding.ProjectID + "\x00" + details.Binding.ObservationSessionDescriptorSHA256))
	receipt.Environment.IdentitySHA256 = hex.EncodeToString(runnerEnvironment[:])
	if err := validateLiveEndToEndDetailsForLedger(raw, receipt, revision, preparedAt); err == nil {
		t.Fatal("environment identity bound to runner session A instead of observation session B was accepted")
	}
}
