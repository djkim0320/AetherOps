package knowledge

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/memory"
	"github.com/djkim0320/AetherOps/internal/store"
)

func TestLegacySucceededReportBackfillsThroughExactModelsAndIsIdempotent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	sidecar := startRecoveryTestSidecar(t, ctx)
	defer sidecar.Close()
	fixture, database := createSuccessfulRunCrashFixture(t, ctx)
	defer database.Close()
	replaceSuccessfulReportWithLegacyManifest(t, ctx, database, &fixture)

	protocol := &extractionProtocolFixture{}
	embedder := &crashBoundaryEmbeddingProtocol{}
	service := recoveryTestService(database, fixture.objects, embedder, sidecar)
	service.Extraction = protocol
	result, err := service.RecoverSuccessfulRunAdoptions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Pending != 1 || result.Recovered != 1 || result.Failed != 0 {
		t.Fatalf("legacy recovery result=%+v", result)
	}
	if len(protocol.turns) != 2 || len(protocol.profiles) != 2 {
		t.Fatalf("legacy backfill model turns=%d profiles=%+v", len(protocol.turns), protocol.profiles)
	}
	if protocol.profiles[0].Model != core.CollectorModel || protocol.profiles[0].ReasoningEffort != core.CollectorEffort ||
		protocol.profiles[1].Model != core.ReviewerModel || protocol.profiles[1].ReasoningEffort != core.ReviewerEffort {
		t.Fatalf("legacy backfill profiles=%+v", protocol.profiles)
	}
	for _, profile := range protocol.profiles {
		if profile.ServiceTier != core.ServiceTierDefault {
			t.Fatalf("legacy backfill used non-standard tier: %+v", profile)
		}
	}

	head, err := database.ActiveKnowledgeGeneration(ctx, fixture.projectID)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != store.KnowledgeHeadReady || head.Generation.State != store.KnowledgeReady {
		t.Fatalf("legacy backfill did not activate a validated shadow: %+v", head)
	}
	rows, err := database.SQL().QueryContext(ctx, `
SELECT extractor_model,status,codex_thread_id,codex_turn_id,input_sha256,output_sha256,
       COALESCE(patch_blob_hash,''),source_locator_json
FROM knowledge_extraction_batches
WHERE project_id=? AND generation_id=? AND run_id=? AND source_kind='backfill'
ORDER BY json_extract(source_locator_json,'$.chunk_ordinal'),json_extract(source_locator_json,'$.role')`,
		fixture.projectID, head.GenerationID, fixture.runID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var model, status, threadID, turnID, inputHash, outputHash, patchHash, locator string
		if err := rows.Scan(&model, &status, &threadID, &turnID, &inputHash, &outputHash, &patchHash, &locator); err != nil {
			t.Fatal(err)
		}
		if status != "applied" || threadID == "" || turnID == "" || len(inputHash) != 64 || len(outputHash) != 64 || len(patchHash) != 64 {
			t.Fatalf("incomplete durable legacy batch: model=%s status=%s thread=%q turn=%q input=%q output=%q patch=%q",
				model, status, threadID, turnID, inputHash, outputHash, patchHash)
		}
		var binding legacyBatchLocator
		if err := json.Unmarshal([]byte(locator), &binding); err != nil || binding.Contract != legacyRunBackfillContractVersion {
			t.Fatalf("invalid legacy batch locator %q: %+v err=%v", locator, binding, err)
		}
		if _, err := fixture.objects.ReadVerified(patchHash); err != nil {
			t.Fatalf("legacy patch CAS readback: %v", err)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("legacy backfill batch count=%d, want extractor+reviewer", count)
	}

	turns := len(protocol.turns)
	if second, err := service.RecoverSuccessfulRunAdoptions(ctx); err != nil || second.Pending != 0 || second.Recovered != 0 {
		t.Fatalf("second legacy recovery result=%+v err=%v", second, err)
	}
	if len(protocol.turns) != turns {
		t.Fatalf("idempotent recovery repeated %d model turns", len(protocol.turns)-turns)
	}
}

func TestLegacyBackfillRestartAfterSnapshotReusesCASWithoutModelReplay(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	sidecar := startRecoveryTestSidecar(t, ctx)
	defer sidecar.Close()
	fixture, database := createSuccessfulRunCrashFixture(t, ctx)
	replaceSuccessfulReportWithLegacyManifest(t, ctx, database, &fixture)
	indexer := &memory.Service{DB: database, CAS: fixture.objects, Embedder: &crashBoundaryEmbeddingProtocol{}}
	if err := indexer.IndexRun(ctx, fixture.runID); err != nil {
		t.Fatal(err)
	}
	initialProtocol := &extractionProtocolFixture{}
	service := &Service{
		DB: database, CAS: fixture.objects, Memory: indexer, Sidecar: sidecar, Extraction: initialProtocol,
		durabilityTestCheckpoint: func(name string) {
			if name == "legacy_backfill_after_snapshot_publish" {
				panic("simulated process termination")
			}
		},
	}
	func() {
		defer func() {
			if recovered := recover(); recovered == nil {
				t.Fatal("legacy snapshot checkpoint did not terminate the writer")
			}
		}()
		_ = service.AdoptRun(ctx, fixture.runID)
	}()
	if len(initialProtocol.turns) != 2 {
		t.Fatalf("initial legacy backfill turns=%d", len(initialProtocol.turns))
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	database = reopenRecoveryDatabase(t, ctx, fixture.databasePath)
	defer database.Close()
	restartProtocol := &extractionProtocolFixture{}
	restartEmbedder := &crashBoundaryEmbeddingProtocol{}
	restarted := recoveryTestService(database, fixture.objects, restartEmbedder, sidecar)
	restarted.Extraction = restartProtocol
	result, err := restarted.RecoverSuccessfulRunAdoptions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Recovered != 1 || result.Failed != 0 || len(restartProtocol.turns) != 0 || restartEmbedder.calls != 0 {
		t.Fatalf("restart replayed external work: result=%+v model_turns=%d embedding_calls=%d",
			result, len(restartProtocol.turns), restartEmbedder.calls)
	}
	assertRecoveredRunKnowledge(t, ctx, database, fixture, 1)
}

func TestLegacyBackfillRestartBeforeFirstBatchRebuildsLocalShadow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	sidecar := startRecoveryTestSidecar(t, ctx)
	defer sidecar.Close()
	fixture, database := createSuccessfulRunCrashFixture(t, ctx)
	replaceSuccessfulReportWithLegacyManifest(t, ctx, database, &fixture)
	indexer := &memory.Service{DB: database, CAS: fixture.objects, Embedder: &crashBoundaryEmbeddingProtocol{}}
	if err := indexer.IndexRun(ctx, fixture.runID); err != nil {
		t.Fatal(err)
	}
	service := &Service{
		DB: database, CAS: fixture.objects, Memory: indexer, Sidecar: sidecar, Extraction: &extractionProtocolFixture{},
		durabilityTestCheckpoint: func(name string) {
			if name == "legacy_backfill_after_local_shadow_copy" {
				panic("simulated process termination")
			}
		},
	}
	func() {
		defer func() {
			if recovered := recover(); recovered == nil {
				t.Fatal("legacy local-shadow checkpoint did not terminate the writer")
			}
		}()
		_ = service.AdoptRun(ctx, fixture.runID)
	}()
	var candidateCount, batchCount int
	if err := database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_generations WHERE project_id=? AND state='building'`,
		fixture.projectID).Scan(&candidateCount); err != nil {
		t.Fatal(err)
	}
	if err := database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_extraction_batches WHERE project_id=? AND run_id=?`,
		fixture.projectID, fixture.runID).Scan(&batchCount); err != nil {
		t.Fatal(err)
	}
	if candidateCount != 1 || batchCount != 0 {
		t.Fatalf("pre-batch crash state candidates=%d batches=%d", candidateCount, batchCount)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	database = reopenRecoveryDatabase(t, ctx, fixture.databasePath)
	defer database.Close()
	protocol := &extractionProtocolFixture{}
	restarted := recoveryTestService(database, fixture.objects, &crashBoundaryEmbeddingProtocol{}, sidecar)
	restarted.Extraction = protocol
	result, err := restarted.RecoverSuccessfulRunAdoptions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Recovered != 1 || result.Failed != 0 || len(protocol.turns) != 2 {
		t.Fatalf("pre-batch restart result=%+v turns=%d", result, len(protocol.turns))
	}
	assertRecoveredRunKnowledge(t, ctx, database, fixture, 1)
}

func TestLegacyBackfillRestartAfterChunkProjectionDoesNotReplayModel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	sidecar := startRecoveryTestSidecar(t, ctx)
	defer sidecar.Close()
	fixture, database := createSuccessfulRunCrashFixture(t, ctx)
	replaceSuccessfulReportWithLegacyManifest(t, ctx, database, &fixture)
	indexer := &memory.Service{DB: database, CAS: fixture.objects, Embedder: &crashBoundaryEmbeddingProtocol{}}
	if err := indexer.IndexRun(ctx, fixture.runID); err != nil {
		t.Fatal(err)
	}
	initialProtocol := &extractionProtocolFixture{}
	service := &Service{
		DB: database, CAS: fixture.objects, Memory: indexer, Sidecar: sidecar, Extraction: initialProtocol,
		durabilityTestCheckpoint: func(name string) {
			if name == "legacy_backfill_after_chunk_projection" {
				panic("simulated process termination")
			}
		},
	}
	func() {
		defer func() {
			if recovered := recover(); recovered == nil {
				t.Fatal("legacy chunk-projection checkpoint did not terminate the writer")
			}
		}()
		_ = service.AdoptRun(ctx, fixture.runID)
	}()
	if len(initialProtocol.turns) != 2 {
		t.Fatalf("initial legacy chunk turns=%d", len(initialProtocol.turns))
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	database = reopenRecoveryDatabase(t, ctx, fixture.databasePath)
	defer database.Close()
	restartProtocol := &extractionProtocolFixture{}
	restarted := recoveryTestService(database, fixture.objects, &crashBoundaryEmbeddingProtocol{}, sidecar)
	restarted.Extraction = restartProtocol
	result, err := restarted.RecoverSuccessfulRunAdoptions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Recovered != 1 || result.Failed != 0 || len(restartProtocol.turns) != 0 {
		t.Fatalf("chunk-projection restart result=%+v replayed_turns=%d", result, len(restartProtocol.turns))
	}
	assertRecoveredRunKnowledge(t, ctx, database, fixture, 1)
}

func TestLegacyBackfillAmbiguousTurnIsNeverAutomaticallyReplayedAndBlocksFIFO(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	sidecar := startRecoveryTestSidecar(t, ctx)
	defer sidecar.Close()
	fixture, database := createSuccessfulRunCrashFixture(t, ctx)
	replaceSuccessfulReportWithLegacyManifest(t, ctx, database, &fixture)
	secondRunID := appendSuccessfulRunToCrashFixture(t, ctx, database, fixture)
	indexer := &memory.Service{DB: database, CAS: fixture.objects, Embedder: &crashBoundaryEmbeddingProtocol{}}
	if err := indexer.IndexRun(ctx, fixture.runID); err != nil {
		t.Fatal(err)
	}
	preparation := &Service{DB: database, CAS: fixture.objects, Memory: indexer, Sidecar: sidecar, Extraction: &extractionProtocolFixture{}}
	documents, err := preparation.adoptIndexedRunDocuments(ctx, mustRun(t, ctx, database, fixture.runID))
	if err != nil {
		t.Fatal(err)
	}
	var evidenceDocument adoptedRunDocument
	for _, document := range documents {
		if document.SourceKind == "evidence" {
			evidenceDocument = document
			break
		}
	}
	if evidenceDocument.ID == "" {
		t.Fatal("legacy fixture has no indexed evidence document")
	}
	ontologyID, ontologyHash, err := preparation.activeMaterializationOntology(ctx, fixture.projectID)
	if err != nil {
		t.Fatal(err)
	}
	contract, err := legacyRunMaterializationContractSHA256(fixture.runID, ontologyHash, fixture.reportBlobHash)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := database.CreateKnowledgeGeneration(ctx, fixture.projectID, ontologyID, contract)
	if err != nil {
		t.Fatal(err)
	}
	locator, _ := json.Marshal(legacyBatchLocator{Contract: legacyRunBackfillContractVersion, ChunkOrdinal: 0, Role: legacyExtractorRole})
	batch, err := database.CreateKnowledgeExtractionBatch(ctx, store.KnowledgeExtractionBatch{
		ProjectID: fixture.projectID, GenerationID: candidate.ID, ID: "kext_ambiguous_legacy",
		DocumentID: evidenceDocument.ID, RunID: fixture.runID, ArtifactID: fixture.reportArtifactID,
		SourceKind: "backfill", ExtractorModel: core.CollectorModel,
		ExtractorContractSHA256: extractionContractHash(PinnedExtractorContractVersion, core.CollectorModel,
			core.CollectorEffort, core.ServiceTierDefault, core.KnowledgePatchSchema()),
		InputSHA256: strings.Repeat("a", 64), SourceLocator: locator,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.TransitionKnowledgeExtractionBatch(ctx, fixture.projectID, candidate.ID, batch.ID,
		"queued", "extracting", store.KnowledgeExtractionBatchUpdate{CodexThreadID: "thread-created-before-crash"}); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	database = reopenRecoveryDatabase(t, ctx, fixture.databasePath)
	defer database.Close()
	protocol := &extractionProtocolFixture{}
	restarted := recoveryTestService(database, fixture.objects, &crashBoundaryEmbeddingProtocol{}, sidecar)
	restarted.Extraction = protocol
	result, err := restarted.RecoverSuccessfulRunAdoptions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Pending != 2 || result.Recovered != 0 || result.Failed != 2 || len(protocol.turns) != 0 {
		t.Fatalf("ambiguous legacy recovery result=%+v model_turns=%d", result, len(protocol.turns))
	}
	if len(result.Failures) != 2 || !strings.Contains(result.Failures[0], "explicit user retry") ||
		!strings.Contains(result.Failures[1], secondRunID) || !strings.Contains(result.Failures[1], "project FIFO stopped") {
		t.Fatalf("ambiguous FIFO failures=%+v", result.Failures)
	}
	var batchStatus, threadID, generationState string
	if err := database.SQL().QueryRowContext(ctx, `
SELECT b.status,b.codex_thread_id,g.state
FROM knowledge_extraction_batches b JOIN knowledge_generations g
 ON g.project_id=b.project_id AND g.id=b.generation_id
WHERE b.id=?`, batch.ID).Scan(&batchStatus, &threadID, &generationState); err != nil {
		t.Fatal(err)
	}
	if batchStatus != "interrupted" || threadID != "thread-created-before-crash" || generationState != string(store.KnowledgeFailed) {
		t.Fatalf("ambiguous receipt was not preserved: batch=%s thread=%q generation=%s", batchStatus, threadID, generationState)
	}
	second, err := restarted.RecoverSuccessfulRunAdoptions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if second.Recovered != 0 || len(protocol.turns) != 0 {
		t.Fatalf("second ambiguous recovery replayed a model turn: result=%+v turns=%d", second, len(protocol.turns))
	}
}

func replaceSuccessfulReportWithLegacyManifest(t *testing.T, ctx context.Context, database *store.DB, fixture *successfulRunCrashFixture) {
	t.Helper()
	legacy := map[string]any{
		"title": "Legacy SU2 dependency", "answer_markdown": "Legacy report without a knowledge patch.",
		"citations": []any{}, "evidence_ids": []any{}, "artifact_hashes": []any{}, "uncertainties": []any{},
	}
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := fixture.objects.PutBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, receipt, "application/json"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL().ExecContext(ctx, "UPDATE artifacts SET blob_hash=? WHERE id=? AND run_id=?",
		receipt.Hash, fixture.reportArtifactID, fixture.runID); err != nil {
		t.Fatal(err)
	}
	fixture.reportBlobHash = receipt.Hash
	legacyNeeded, err := (&Service{DB: database, CAS: fixture.objects}).legacyReportNeedsBackfill(ctx, fixture.runID)
	if err != nil || !legacyNeeded {
		t.Fatalf("legacy fixture was not detected: needed=%t err=%v", legacyNeeded, err)
	}
}

func mustRun(t *testing.T, ctx context.Context, database *store.DB, runID string) core.Run {
	t.Helper()
	run, err := database.Run(ctx, runID)
	if err != nil {
		t.Fatal(err)
	}
	return run
}

func TestLegacyBackfillMissingPatchPredicateRejectsPartiallyMalformedPatch(t *testing.T) {
	if !isMissingLegacyKnowledgePatch(core.KnowledgePatch{}) {
		t.Fatal("zero legacy patch was not detected")
	}
	partial := core.KnowledgePatch{SchemaVersion: core.KnowledgePatchSchemaV1}
	if isMissingLegacyKnowledgePatch(partial) {
		t.Fatal("partially malformed modern patch was accepted as legacy")
	}
	if err := partial.ValidateStructure(); err == nil || errors.Is(err, ErrLegacyBackfillAmbiguous) {
		t.Fatalf("partial patch validation err=%v", err)
	}
}
