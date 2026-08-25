package releasegate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/livee2econtract"
	managedruntime "github.com/djkim0320/AetherOps/internal/runtime"
)

func validateLiveEndToEndDetailsForLedger(raw []byte, receipt EvidenceReceipt, preparedRevision int, preparedAt time.Time) error {
	var details livee2econtract.Details
	if err := decodeStrict(raw, &details); err != nil {
		return fmt.Errorf("decode live end-to-end details: %w", err)
	}
	if details.Schema != livee2econtract.DetailsSchemaV2 || details.FixtureRole != "none" ||
		!details.ReleaseGateEligible || !details.NoAmbiguousWritesReplayed || details.EvaluationRequiredCases != 12 ||
		details.EvaluationObservedPasses != 12 || details.Binding.ProductBuild != receipt.ProductBuild ||
		details.Binding.ReleaseCandidateID != receipt.ReleaseCandidateID || details.Binding.PreparedLedgerRevision != preparedRevision ||
		details.Binding.PreparedLedgerSHA256 != preparedLedgerSubject(receipt) || !details.Binding.LedgerPreparedAt.Equal(preparedAt) ||
		!receipt.ObservedAt.Equal(details.OfflineVerifiedAt) || details.LiveStartedAt.Before(preparedAt) ||
		details.Binding.EvaluationVerifiedAt.Before(preparedAt) ||
		details.Binding.ObservationSessionStartedAt.Before(details.Binding.EvaluationVerifiedAt) ||
		details.LiveStartedAt.Before(details.Binding.ObservationSessionStartedAt) ||
		details.LiveFinishedAt.Before(details.LiveStartedAt) ||
		details.OfflineVerifiedAt.Before(details.LiveFinishedAt) {
		return errors.New("live end-to-end identity, ledger, pass count, or time contract is invalid")
	}
	for _, digest := range []string{details.Binding.PreparedLedgerSHA256, details.Binding.RunnerReceiptSHA256,
		details.Binding.EvaluationSHA256, details.Binding.DatasetSHA256, details.Binding.RunnerEndpointSHA256,
		details.Binding.ObservationSessionDescriptorSHA256, details.Binding.ObservationEndpointSHA256,
		details.Binding.PromptSHA256, details.LiveJournalSHA256,
		details.CASReadbackSetSHA256} {
		if !validDigest(digest) {
			return errors.New("live end-to-end provenance contains an invalid SHA-256")
		}
	}
	promptDigest := sha256.Sum256([]byte(livee2econtract.ResearchPrompt))
	queryDigest := sha256.Sum256([]byte(livee2econtract.SPARQLQuery))
	if details.Binding.PromptSHA256 != hex.EncodeToString(promptDigest[:]) ||
		details.SPARQL.QuerySHA256 != hex.EncodeToString(queryDigest[:]) {
		return errors.New("live end-to-end prompt or SPARQL query is not the fixed contract")
	}
	if !details.Browser.Executed || !details.Browser.Compatible || details.Browser.ObservedAt.Before(details.LiveStartedAt) ||
		details.Browser.ObservedAt.After(details.LiveFinishedAt) ||
		!strings.Contains(details.Browser.Observation, "Chrome DevTools MCP") ||
		!strings.Contains(details.Browser.Observation, "list_pages") || !strings.Contains(details.Browser.Observation, "take_snapshot") {
		return errors.New("live end-to-end browser proof is not an actual DevTools MCP page observation")
	}
	if details.Run.RunID == "" || details.Run.ProjectID != details.Binding.ProjectID || details.Run.ReportArtifactID == "" ||
		details.Run.Status != string(core.RunSucceeded) || details.Run.CreatedAt.Before(details.LiveStartedAt) ||
		details.Run.TerminalAt.Before(details.Run.CreatedAt) || details.Run.TerminalAt.After(details.LiveFinishedAt) {
		return errors.New("live end-to-end research run is invalid")
	}
	if err := validateLiveEndToEndStages(details.Stages, details.Run.CreatedAt, details.Run.TerminalAt); err != nil {
		return err
	}
	collectAttempts := make(map[string]livee2econtract.StageProof, core.MaxCollectors+1)
	var verificationAttempt *livee2econtract.StageProof
	for _, stage := range details.Stages {
		if stage.Stage == string(core.StageCollect) {
			collectAttempts[stage.StageAttemptID] = stage
			if stage.Ordinal == core.EngineeringVerificationOrdinal {
				copy := stage
				verificationAttempt = &copy
			}
		}
	}
	if len(details.MCPEvidence) < 1 {
		return errors.New("live end-to-end proof contains no internal MCP evidence capture")
	}
	seenEvidence := map[string]bool{}
	for _, evidence := range details.MCPEvidence {
		if evidence.EvidenceID == "" || evidence.StageAttemptID == "" || !validDigest(evidence.BlobSHA256) ||
			evidence.Size < 1 || evidence.CapturedAt.Before(details.Run.CreatedAt) ||
			evidence.CapturedAt.After(details.Run.TerminalAt) || !evidence.InternalMCP ||
			collectAttempts[evidence.StageAttemptID].StageAttemptID == "" || seenEvidence[evidence.EvidenceID] {
			return errors.New("live end-to-end MCP evidence proof is invalid")
		}
		seenEvidence[evidence.EvidenceID] = true
	}
	solver := details.Solver
	solverStage, solverStageExists := collectAttempts[solver.StageAttemptID]
	if solver.JobID == "" || !solverStageExists || solver.Operation != "xfoil_polar" || solver.Component != "xfoil" ||
		solver.Version != managedruntime.PinnedXFOILVersion || !validDigest(solver.SpecSHA256) || !validDigest(solver.RuntimeBundleSHA256) ||
		!validDigest(solver.PhysicalArgumentsSHA256) ||
		solver.ReceiptArtifactID == "" || !validDigest(solver.ReceiptBlobSHA256) || !validDigest(solver.ArtifactSetSHA256) ||
		solver.Threads < 1 || !solver.Executed || !solver.NumericallyValid || solver.CompletedAt.Before(details.Run.CreatedAt) ||
		solver.CompletedAt.After(details.Run.TerminalAt) {
		return errors.New("live end-to-end deterministic XFOIL solver proof is invalid")
	}
	if verificationAttempt != nil {
		sourceStage, sourceExists := collectAttempts[solver.VerificationSourceStageAttemptID]
		if solver.StageAttemptID != verificationAttempt.StageAttemptID ||
			solver.ExecutionPurpose != "independent_verification" || solver.VerificationOfJobID == "" ||
			!sourceExists || sourceStage.Ordinal < 0 || sourceStage.Ordinal >= core.MaxCollectors ||
			solver.VerificationSourceStageAttemptID == solver.StageAttemptID ||
			!validDigest(solver.VerificationSourceRuntimeSHA256) ||
			solver.VerificationSourceRuntimeSHA256 != solver.RuntimeBundleSHA256 ||
			solver.VerificationSourceComponent != solver.Component ||
			solver.VerificationSourceVersion != solver.Version ||
			!validDigest(solver.VerificationSourceSpecSHA256) ||
			!validDigest(solver.VerificationSourcePhysicalSHA256) ||
			solver.VerificationSourcePhysicalSHA256 == solver.PhysicalArgumentsSHA256 ||
			strings.TrimSpace(solver.VerificationSourceReceiptID) == "" ||
			!validDigest(solver.VerificationSourceReceiptSHA256) {
			return errors.New("live end-to-end independent XFOIL verification proof is invalid")
		}
	} else if solverStage.Ordinal >= core.MaxCollectors || solver.ExecutionPurpose == "independent_verification" ||
		solver.VerificationOfJobID != "" || solver.VerificationSourceStageAttemptID != "" ||
		solver.VerificationSourceRuntimeSHA256 != "" || solver.VerificationSourceComponent != "" ||
		solver.VerificationSourceVersion != "" || solver.VerificationSourceSpecSHA256 != "" ||
		solver.VerificationSourcePhysicalSHA256 != "" || solver.VerificationSourceReceiptID != "" ||
		solver.VerificationSourceReceiptSHA256 != "" {
		return errors.New("live end-to-end solver claims verification without the reserved collector")
	}
	if details.CASObjectsVerified < 8 || !validDigest(details.CASReadbackSetSHA256) {
		return errors.New("live end-to-end CAS readback proof is incomplete")
	}
	if details.SPARQL.GenerationID == "" || details.SPARQL.QueryForm != "SELECT" || !details.SPARQL.Complete ||
		!validDigest(details.SPARQL.ResultSHA256) || details.SPARQL.ResponseBytes < 2 ||
		details.Graph.GenerationID != details.SPARQL.GenerationID || details.Graph.TripleCount < 1 ||
		!validDigest(details.Graph.SnapshotSHA256) || details.Graph.CanonicalSHA256 != details.Graph.SnapshotSHA256 ||
		details.Graph.SPARQLResultSHA256 != details.SPARQL.ResultSHA256 {
		return errors.New("live end-to-end project-scoped SPARQL/RDF proof is invalid")
	}
	curation := details.Curation
	if curation.EventID == "" || curation.Sequence < 1 || curation.GenerationID != details.Graph.GenerationID ||
		curation.Kind != "pin_entity" || !validDigest(curation.PayloadSHA256) || !validDigest(curation.EventSHA256) ||
		!validDigest(curation.MemoBlobSHA256) || curation.EntityID == "" {
		return errors.New("live end-to-end Knowledge editor mutation/readback is invalid")
	}
	if receipt.Environment.Class != string(EvidenceLiveService) || receipt.Environment.OS != "windows-11" ||
		receipt.Environment.Architecture != "amd64" || receipt.Producer != (Producer{Name: livee2econtract.ProducerName, Version: livee2econtract.ProducerVersion}) {
		return errors.New("live end-to-end producer or Windows environment is invalid")
	}
	environmentDigest := sha256.Sum256([]byte("aetherops-live-e2e-environment-v2\x00" + details.Binding.ObservationEndpointSHA256 + "\x00" + details.Binding.ProjectID + "\x00" + details.Binding.ObservationSessionDescriptorSHA256))
	if receipt.Environment.IdentitySHA256 != hex.EncodeToString(environmentDigest[:]) {
		return errors.New("live end-to-end environment identity differs from the protected session")
	}
	return validateLiveEndToEndSubjects(details, receipt)
}

func validateLiveEndToEndStages(stages []livee2econtract.StageProof, runCreatedAt, runTerminalAt time.Time) error {
	maximumStages := 4 + core.MaxCollectors + 2*core.MaxRevisions
	if len(stages) < 4 || len(stages) > maximumStages {
		return errors.New("live end-to-end fixed stage set has invalid cardinality")
	}
	counts := map[string]int{}
	ordinals := map[string]map[int]bool{}
	seenAttempts, seenTurns := map[string]bool{}, map[string]bool{}
	isolatedThreads := map[string]string{}
	mainThread := ""
	for _, stage := range stages {
		if stage.Stage != string(core.StagePlan) {
			continue
		}
		if mainThread != "" {
			return errors.New("live end-to-end stage state-machine has more than one planning stage")
		}
		mainThread = stage.CodexThreadID
	}
	if mainThread == "" {
		return errors.New("live end-to-end stage state-machine omits the planning stage")
	}
	for _, stage := range stages {
		if stage.StageAttemptID == "" || seenAttempts[stage.StageAttemptID] || stage.CodexThreadID == "" || stage.CodexTurnID == "" ||
			seenTurns[stage.CodexTurnID] || !validDigest(stage.InputSHA256) || !validDigest(stage.OutputSHA256) ||
			stage.Ordinal < 0 || stage.ExecutionContractSHA256 != core.StageExecutionContractSHA256 || stage.CompletedAt.Before(runCreatedAt) ||
			stage.CompletedAt.After(runTerminalAt) {
			return errors.New("live end-to-end stage receipt identity is invalid")
		}
		seenAttempts[stage.StageAttemptID], seenTurns[stage.CodexTurnID] = true, true
		if ordinals[stage.Stage] == nil {
			ordinals[stage.Stage] = map[int]bool{}
		}
		if ordinals[stage.Stage][stage.Ordinal] {
			return errors.New("live end-to-end stage receipt repeats a stage ordinal")
		}
		ordinals[stage.Stage][stage.Ordinal] = true
		model, effort := "", ""
		switch stage.Stage {
		case string(core.StagePlan), string(core.StageSynthesize), string(core.StageRevise):
			if stage.WorkstreamID != "" {
				return errors.New("non-collector stage carries an evidence workstream")
			}
			model, effort = core.PlannerModel, core.PlannerEffort
			if stage.CodexThreadID != mainThread {
				return errors.New("planner/synthesizer/reviser did not reuse the main project thread")
			}
		case string(core.StageCollect):
			model, effort = core.CollectorModel, core.CollectorEffort
			if stage.Ordinal == core.EngineeringVerificationOrdinal {
				if stage.WorkstreamID != "aetherops_engineering_verification" {
					return errors.New("reserved verification collector has the wrong workstream")
				}
			} else if stage.Ordinal >= core.MaxCollectors || stage.WorkstreamID == "" ||
				stage.WorkstreamID == "aetherops_engineering_verification" {
				return errors.New("regular collector has an invalid ordinal or reserved workstream")
			}
			if stage.CodexThreadID == mainThread {
				return errors.New("collector was not isolated from the main project thread")
			}
			if isolatedThreads[stage.CodexThreadID] != "" {
				return errors.New("collector/reviewer threads are not independently isolated")
			}
			isolatedThreads[stage.CodexThreadID] = stage.Stage
		case string(core.StageReview):
			if stage.WorkstreamID != "" {
				return errors.New("non-collector stage carries an evidence workstream")
			}
			model, effort = core.ReviewerModel, core.ReviewerEffort
			if stage.CodexThreadID == mainThread {
				return errors.New("reviewer was not isolated from the main project thread")
			}
			if isolatedThreads[stage.CodexThreadID] != "" {
				return errors.New("collector/reviewer threads are not independently isolated")
			}
			isolatedThreads[stage.CodexThreadID] = stage.Stage
		default:
			return errors.New("live end-to-end stage receipt has an unsupported stage")
		}
		if stage.Model != model || stage.ReasoningEffort != effort || stage.ServiceTier != core.ServiceTierDefault {
			return errors.New("live end-to-end stage receipt differs from the fixed model/effort/tier contract")
		}
		counts[stage.Stage]++
	}
	if counts[string(core.StagePlan)] != 1 || counts[string(core.StageCollect)] < 1 || counts[string(core.StageCollect)] > core.MaxCollectors+1 ||
		counts[string(core.StageSynthesize)] != 1 || counts[string(core.StageReview)] < 1 || counts[string(core.StageReview)] > core.MaxRevisions+1 ||
		counts[string(core.StageRevise)] > core.MaxRevisions ||
		counts[string(core.StageReview)] != counts[string(core.StageRevise)]+1 {
		return errors.New("live end-to-end stage state-machine cardinality is invalid")
	}
	for stage, firstOrdinal := range map[string]int{
		string(core.StagePlan):       0,
		string(core.StageSynthesize): 0,
		string(core.StageReview):     0,
		string(core.StageRevise):     1,
	} {
		for ordinal := firstOrdinal; ordinal < firstOrdinal+counts[stage]; ordinal++ {
			if !ordinals[stage][ordinal] {
				return errors.New("live end-to-end stage ordinals do not match the fixed state machine")
			}
		}
	}
	regularCollectors := counts[string(core.StageCollect)]
	if ordinals[string(core.StageCollect)][core.EngineeringVerificationOrdinal] {
		regularCollectors--
	}
	if regularCollectors < 1 || regularCollectors > core.MaxCollectors {
		return errors.New("live end-to-end regular collector cardinality is invalid")
	}
	for ordinal := 0; ordinal < regularCollectors; ordinal++ {
		if !ordinals[string(core.StageCollect)][ordinal] {
			return errors.New("live end-to-end regular collector ordinals are not contiguous")
		}
	}
	return nil
}

func validateLiveEndToEndSubjects(details livee2econtract.Details, receipt EvidenceReceipt) error {
	expected := liveEndToEndExpectedSubjects(details, receipt)
	if len(receipt.SubjectHashes) != len(expected) {
		return errors.New("live end-to-end subject set is not exact")
	}
	seen := map[string]bool{}
	for _, subject := range receipt.SubjectHashes {
		want, ok := expected[subject.Name]
		if !ok || seen[subject.Name] || subject.SHA256 != want {
			return errors.New("live end-to-end subject differs from typed details")
		}
		seen[subject.Name] = true
	}
	return nil
}

func liveEndToEndExpectedSubjects(details livee2econtract.Details, receipt EvidenceReceipt) map[string]string {
	stageRaw, _ := json.Marshal(details.Stages)
	stageDigest := sha256.Sum256(stageRaw)
	mcpRaw, _ := json.Marshal(details.MCPEvidence)
	mcpDigest := sha256.Sum256(mcpRaw)
	runDigest := sha256.Sum256([]byte("aetherops-live-e2e-run-v2\x00" + details.Run.RunID + "\x00" + details.Run.ReportArtifactID))
	browserRaw, _ := json.Marshal(details.Browser)
	browserDigest := sha256.Sum256(browserRaw)
	curationRaw, _ := json.Marshal(details.Curation)
	curationDigest := sha256.Sum256(curationRaw)
	return map[string]string{
		"aetherops.exe":                           receipt.ProductBuild.ExecutableSHA256,
		"runtime-manifest.json":                   receipt.ProductBuild.RuntimeManifestSHA256,
		"knowledge-sidecar-tree":                  receipt.ProductBuild.KnowledgeSidecarTreeSHA256,
		"prepared-ledger":                         details.Binding.PreparedLedgerSHA256,
		"release-eval-runner-receipt":             details.Binding.RunnerReceiptSHA256,
		"release-evaluation-details":              details.Binding.EvaluationSHA256,
		"release-eval-runner-endpoint":            details.Binding.RunnerEndpointSHA256,
		"live-e2e-observation-endpoint":           details.Binding.ObservationEndpointSHA256,
		"live-e2e-observation-session-descriptor": details.Binding.ObservationSessionDescriptorSHA256,
		"live-e2e-journal":                        details.LiveJournalSHA256,
		"live-e2e-run":                            hex.EncodeToString(runDigest[:]),
		"stage-receipt-set":                       hex.EncodeToString(stageDigest[:]),
		"mcp-evidence-set":                        hex.EncodeToString(mcpDigest[:]),
		"browser-devtools-observation":            hex.EncodeToString(browserDigest[:]),
		"engineering-solver-receipt":              details.Solver.ReceiptBlobSHA256,
		"cas-readback-set":                        details.CASReadbackSetSHA256,
		"sparql-readback":                         details.SPARQL.ResultSHA256,
		"knowledge-curation-event":                hex.EncodeToString(curationDigest[:]),
		"live-end-to-end-details":                 receipt.DetailsSHA256,
	}
}
