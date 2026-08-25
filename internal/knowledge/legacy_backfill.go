package knowledge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/id"
	"github.com/djkim0320/AetherOps/internal/store"
)

const (
	legacyRunBackfillContractVersion = "legacy_run_knowledge_backfill_v1"
	legacyExtractorRole              = "extractor"
	legacyReviewerRole               = "reviewer"
)

var ErrLegacyBackfillAmbiguous = errors.New("legacy knowledge backfill has an ambiguous external model request; explicit user retry is required")

type legacyBatchLocator struct {
	Contract     string `json:"contract"`
	ChunkOrdinal int    `json:"chunk_ordinal"`
	Role         string `json:"role"`
}

type legacyBatch struct {
	ID                      string
	Status                  string
	ThreadID                string
	TurnID                  string
	InputSHA256             string
	OutputSHA256            string
	PatchBlobHash           string
	ExtractorModel          string
	ExtractorContractSHA256 string
}

func isMissingLegacyKnowledgePatch(patch core.KnowledgePatch) bool {
	return patch.SchemaVersion == "" && patch.UnitRegistryVersion == "" &&
		len(patch.Entities) == 0 && len(patch.Assertions) == 0
}

func legacyRunMaterializationContractSHA256(runID, ontologySHA256, reportSHA256 string) (string, error) {
	if strings.TrimSpace(runID) == "" || !isCanonicalSHA256(ontologySHA256) || !isCanonicalSHA256(reportSHA256) {
		return "", errors.New("legacy run backfill requires a run and canonical ontology and report SHA-256 values")
	}
	extractor := extractionContractHash(PinnedExtractorContractVersion, core.CollectorModel,
		core.CollectorEffort, core.ServiceTierDefault, core.KnowledgePatchSchema())
	reviewer := extractionContractHash(PinnedReviewerContractVersion, core.ReviewerModel,
		core.ReviewerEffort, core.ServiceTierDefault, pinnedReviewSchema())
	material := strings.Join([]string{legacyRunBackfillContractVersion, runID, ontologySHA256, reportSHA256, extractor, reviewer}, "\n")
	sum := sha256.Sum256([]byte(material))
	return hex.EncodeToString(sum[:]), nil
}

// legacyReportNeedsBackfill is deliberately read-only. Startup recovery uses
// it before quarantining deterministic report-patch candidates so a resumable
// legacy model-backed candidate is never destroyed or replayed by that path.
func (service *Service) legacyReportNeedsBackfill(ctx context.Context, runID string) (bool, error) {
	run, err := service.DB.Run(ctx, runID)
	if err != nil {
		return false, err
	}
	if run.Status != core.RunSucceeded || run.ReportArtifactID == "" {
		return false, nil
	}
	artifact, metadata, err := service.DB.RunArtifact(ctx, run.ID, run.ReportArtifactID)
	if err != nil {
		return false, err
	}
	if !artifact.Adopted || metadata.MediaType != "application/json" {
		return false, nil
	}
	raw, err := service.CAS.ReadVerified(artifact.BlobHash)
	if err != nil {
		return false, err
	}
	report, err := decodeStrictReportManifest(raw)
	if err != nil {
		return false, err
	}
	return isMissingLegacyKnowledgePatch(report.KnowledgePatch), nil
}

func (service *Service) adoptLegacyRunKnowledge(
	ctx context.Context,
	run core.Run,
	head store.KnowledgeHead,
	reportArtifact store.Artifact,
) (returnErr error) {
	if service.Extraction == nil {
		return errors.New("legacy successful-run backfill requires the isolated extraction protocol")
	}
	documents, err := service.adoptIndexedRunDocuments(ctx, run)
	if err != nil {
		return err
	}
	if err := service.rejectUnprojectedForeignDocuments(ctx, run.ProjectID, head.GenerationID, documents); err != nil {
		return err
	}
	evidenceDocuments := make([]adoptedRunDocument, 0, len(documents))
	for _, document := range documents {
		if document.SourceKind == "evidence" {
			evidenceDocuments = append(evidenceDocuments, document)
		}
	}
	if len(evidenceDocuments) == 0 {
		return errors.New("legacy successful report has no adopted evidence document for evidence-backed extraction")
	}
	ontologyID, ontologyHash, err := service.activeMaterializationOntology(ctx, run.ProjectID)
	if err != nil {
		return err
	}
	contract, err := legacyRunMaterializationContractSHA256(run.ID, ontologyHash, reportArtifact.BlobHash)
	if err != nil {
		return err
	}
	if err := service.rejectAmbiguousLegacyBackfillHistory(ctx, run.ProjectID, run.ID, contract); err != nil {
		return err
	}

	candidate, resumed, err := service.legacyBackfillCandidate(ctx, run.ProjectID, contract)
	if err != nil {
		return err
	}
	if resumed && candidate.State == store.KnowledgeBuilding {
		// A mutable generation may contain an atomically committed chunk followed
		// by only part of the local engineering/reasoning finalization. Always
		// reconstruct that local projection from a clean active-generation copy.
		// Completed model receipts remain in the failed generation and are cloned
		// by legacyChunkPatch; no model request is replayed. A generation with no
		// batch has no external history and can be deleted outright.
		var batchCount, reportReceiptCount int
		if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT COUNT(*),COALESCE(SUM(CASE WHEN source_kind='report' AND status='applied' THEN 1 ELSE 0 END),0)
FROM knowledge_extraction_batches
WHERE project_id=? AND generation_id=? AND run_id=?`,
			run.ProjectID, candidate.ID, run.ID).Scan(&batchCount, &reportReceiptCount); err != nil {
			return err
		}
		if batchCount == 0 {
			if err := service.DB.DeleteBuildingKnowledgeGeneration(ctx, run.ProjectID, candidate.ID, contract); err != nil {
				return fmt.Errorf("discard incomplete local-only legacy shadow: %w", err)
			}
			candidate, resumed = store.KnowledgeGeneration{}, false
		} else if reportReceiptCount == 0 {
			if _, err := service.DB.TransitionKnowledgeGeneration(ctx, run.ProjectID, candidate.ID,
				store.KnowledgeBuilding, store.KnowledgeFailed,
				"startup recovery is reconstructing local legacy projection from preserved successful model receipts"); err != nil {
				return fmt.Errorf("preserve partial legacy shadow for clean reconstruction: %w", err)
			}
			candidate, resumed = store.KnowledgeGeneration{}, false
		}
	}
	if !resumed {
		if head.Status != store.KnowledgeHeadStale {
			head, err = service.DB.SetKnowledgeHeadStatus(ctx, run.ProjectID, head.KnowledgeRevision,
				store.KnowledgeHeadStale, "legacy successful report is being extracted into a shadow generation")
			if err != nil {
				return err
			}
		}
		candidate, err = service.DB.CreateKnowledgeGeneration(ctx, run.ProjectID, ontologyID, contract)
		if err != nil {
			return err
		}
		if err := service.copyActiveProjection(ctx, run.ProjectID, head.Generation, candidate); err != nil {
			return err
		}
		if _, err := service.applyPendingCuration(ctx, run.ProjectID, head.GenerationID, candidate.ID); err != nil {
			return err
		}
		service.checkpointDurabilityTest("legacy_backfill_after_local_shadow_copy")
	}

	state := candidate.State
	defer func() {
		if returnErr == nil || (state != store.KnowledgeBuilding && state != store.KnowledgeValidating) {
			return
		}
		failureCtx := context.WithoutCancel(ctx)
		if state == store.KnowledgeBuilding {
			if batchErr := service.failOpenExtractionBatches(failureCtx, run.ProjectID, candidate.ID, returnErr); batchErr != nil {
				returnErr = errors.Join(returnErr, fmt.Errorf("close legacy backfill batches: %w", batchErr))
			}
		}
		if _, failErr := service.DB.TransitionKnowledgeGeneration(
			failureCtx, run.ProjectID, candidate.ID, state, store.KnowledgeFailed, returnErr.Error(),
		); failErr != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("mark legacy backfill generation failed: %w", failErr))
		}
	}()

	if state == store.KnowledgeReady {
		if err := service.loadRunSnapshot(ctx, run.ProjectID, candidate.ID); err != nil {
			return err
		}
		_, err := service.DB.ActivateKnowledgeGeneration(ctx, run.ProjectID, candidate.ID)
		return err
	}

	if state == store.KnowledgeBuilding {
		var reportReceiptCount int
		if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT COUNT(*) FROM knowledge_extraction_batches
WHERE project_id=? AND generation_id=? AND run_id=? AND source_kind='report' AND status='applied'`,
			run.ProjectID, candidate.ID, run.ID).Scan(&reportReceiptCount); err != nil {
			return err
		}
		if reportReceiptCount == 0 {
			aggregate, err := service.projectLegacyRunDocuments(ctx, run, candidate, reportArtifact, documents, evidenceDocuments)
			if err != nil {
				return err
			}
			engineeringProjection, err := service.deterministicEngineeringProjection(ctx, run)
			if err != nil {
				return err
			}
			if err := service.DB.AppendKnowledgeProjection(ctx, run.ProjectID, candidate.ID, engineeringProjection); err != nil {
				return err
			}
			if err := service.recordDeterministicEngineeringProjection(ctx, run, candidate); err != nil {
				return err
			}
			if err := service.rekeyKnowledgeAssertions(ctx, run.ProjectID, candidate.ID); err != nil {
				return err
			}
			if err := service.materializeOntologyProjection(ctx, run.ProjectID, candidate.ID); err != nil {
				return err
			}
			conflictEvents, err := service.loadLegacyConflictCuration(ctx, run.ProjectID, head.GenerationID)
			if err != nil {
				return err
			}
			for _, event := range conflictEvents {
				if err := service.applyCurationEvent(ctx, run.ProjectID, candidate.ID, event.Kind, event.Payload); err != nil {
					return err
				}
			}
			patchHash, err := service.storeKnowledgePatch(ctx, aggregate)
			if err != nil {
				return err
			}
			if err := service.recordAppliedRunPatch(ctx, run, candidate, reportArtifact, patchHash); err != nil {
				return err
			}
		}
		if err := service.publishLegacyRunSnapshot(ctx, run.ProjectID, candidate.ID, ontologyID); err != nil {
			return err
		}
		service.checkpointDurabilityTest("legacy_backfill_after_snapshot_publish")
		if _, err := service.DB.TransitionKnowledgeGeneration(ctx, run.ProjectID, candidate.ID,
			store.KnowledgeBuilding, store.KnowledgeValidating, ""); err != nil {
			return err
		}
		state = store.KnowledgeValidating
	}

	if state == store.KnowledgeValidating {
		if err := service.loadRunSnapshot(ctx, run.ProjectID, candidate.ID); err != nil {
			return err
		}
		ready, err := service.DB.TransitionKnowledgeGeneration(ctx, run.ProjectID, candidate.ID,
			store.KnowledgeValidating, store.KnowledgeReady, "")
		if err != nil {
			return err
		}
		state = store.KnowledgeReady
		candidate = ready
	}
	service.checkpointDurabilityTest("legacy_backfill_before_head_swap")
	if _, err := service.DB.ActivateKnowledgeGeneration(ctx, run.ProjectID, candidate.ID); err != nil {
		return err
	}
	service.checkpointDurabilityTest("legacy_backfill_after_head_swap")
	return nil
}

func (service *Service) projectLegacyRunDocuments(
	ctx context.Context,
	run core.Run,
	candidate store.KnowledgeGeneration,
	reportArtifact store.Artifact,
	allDocuments, evidenceDocuments []adoptedRunDocument,
) (core.KnowledgePatch, error) {
	terms, err := service.loadExtractionOntologyTerms(ctx, candidate.OntologyID)
	if err != nil {
		return core.KnowledgePatch{}, err
	}
	if len(terms) == 0 {
		return core.KnowledgePatch{}, errors.New("active ontology has no legacy extraction terms")
	}
	aggregate := core.KnowledgePatch{
		SchemaVersion: core.KnowledgePatchSchemaV1, UnitRegistryVersion: core.CurrentUnitRegistryVersion,
		Entities: []core.KnowledgeEntity{}, Assertions: []core.KnowledgeAssertion{},
	}
	for _, document := range evidenceDocuments {
		extraction, err := service.loadLegacyRunDocumentExtraction(ctx, run, document)
		if err != nil {
			return core.KnowledgePatch{}, err
		}
		for _, chunk := range extraction.Document.Chunks {
			spans := extraction.Spans[chunk.Ordinal]
			if len(spans) == 0 {
				return core.KnowledgePatch{}, fmt.Errorf("legacy evidence chunk %d has no exact CAS spans", chunk.Ordinal)
			}
			extracted, extractor, err := service.legacyChunkPatch(ctx, run, candidate, reportArtifact,
				extraction.Document, chunk, terms, spans, legacyExtractorRole, core.KnowledgePatch{})
			if err != nil {
				return core.KnowledgePatch{}, err
			}
			reviewed, reviewer, err := service.legacyChunkPatch(ctx, run, candidate, reportArtifact,
				extraction.Document, chunk, terms, spans, legacyReviewerRole, extracted)
			if err != nil {
				return core.KnowledgePatch{}, err
			}
			normalized, err := service.normalizePinnedPatch(ctx, run.ProjectID, candidate.ID, reviewed)
			if err != nil {
				return core.KnowledgePatch{}, err
			}
			if err := service.validatePatchOntology(normalized, terms); err != nil {
				return core.KnowledgePatch{}, err
			}
			if err := validatePinnedPatchEvidence(normalized, spans); err != nil {
				return core.KnowledgePatch{}, err
			}
			projection, err := service.runKnowledgeProjection(ctx, run, candidate, normalized, allDocuments)
			if err != nil {
				return core.KnowledgePatch{}, err
			}
			if err := service.DB.AppendKnowledgeProjection(ctx, run.ProjectID, candidate.ID, projection); err != nil {
				return core.KnowledgePatch{}, err
			}
			service.checkpointDurabilityTest("legacy_backfill_after_chunk_projection")
			for _, batch := range []legacyBatch{extractor, reviewer} {
				if batch.Status == "validated" {
					if err := service.DB.TransitionKnowledgeExtractionBatch(ctx, run.ProjectID, candidate.ID,
						batch.ID, "validated", "applied", store.KnowledgeExtractionBatchUpdate{}); err != nil {
						return core.KnowledgePatch{}, err
					}
				}
			}
			aggregate, err = mergeLegacyKnowledgePatch(aggregate, normalized)
			if err != nil {
				return core.KnowledgePatch{}, err
			}
		}
	}
	return aggregate, aggregate.ValidateStructure()
}

func (service *Service) legacyChunkPatch(
	ctx context.Context,
	run core.Run,
	candidate store.KnowledgeGeneration,
	reportArtifact store.Artifact,
	document adoptedRunDocument,
	chunk adoptedRunChunk,
	terms []ontologyPromptTerm,
	spans []pinnedEvidenceSpan,
	role string,
	extracted core.KnowledgePatch,
) (core.KnowledgePatch, legacyBatch, error) {
	existing, found, err := service.findLegacyBatch(ctx, run.ProjectID, candidate.ID, run.ID, document.ID, chunk.Ordinal, role)
	if err != nil {
		return core.KnowledgePatch{}, legacyBatch{}, err
	}
	identities, err := service.matchingIdentityPrompts(ctx, run.ProjectID, candidate.ID, []string{chunk.Text})
	if err != nil {
		return core.KnowledgePatch{}, legacyBatch{}, err
	}
	var prompt, inputHash, model, effort, contractVersion, serviceName, next string
	var schema json.RawMessage
	if role == legacyExtractorRole {
		input := pinnedExtractionInput{
			ContractVersion: PinnedExtractorContractVersion, ProjectID: run.ProjectID,
			DocumentID: document.ID, Title: document.Title, BlobHash: document.BlobHash,
			ChunkOrdinal: chunk.Ordinal, OntologyTerms: terms, IdentityMatches: identities, EvidenceSpans: spans,
		}
		prompt, inputHash, err = pinnedExtractionPrompt(input)
		model, effort, contractVersion = core.CollectorModel, core.CollectorEffort, PinnedExtractorContractVersion
		serviceName, next, schema = "aetherops.knowledge.legacy.extractor", "extracting", core.KnowledgePatchSchema()
	} else if role == legacyReviewerRole {
		identities, err = service.patchIdentityPrompts(ctx, run.ProjectID, candidate.ID, extracted)
		if err != nil {
			return core.KnowledgePatch{}, legacyBatch{}, err
		}
		input := pinnedReviewInput{
			ContractVersion: PinnedReviewerContractVersion, ProjectID: run.ProjectID,
			DocumentID: document.ID, Title: document.Title, ChunkOrdinal: chunk.Ordinal,
			OntologyTerms: terms, IdentityMatches: identities, EvidenceSpans: spans, ExtractedPatch: extracted,
		}
		prompt, inputHash, err = pinnedReviewPrompt(input)
		model, effort, contractVersion = core.ReviewerModel, core.ReviewerEffort, PinnedReviewerContractVersion
		serviceName, next, schema = "aetherops.knowledge.legacy.reviewer", "reviewing", pinnedReviewSchema()
	} else {
		return core.KnowledgePatch{}, legacyBatch{}, errors.New("unsupported legacy backfill role")
	}
	if err != nil {
		return core.KnowledgePatch{}, legacyBatch{}, err
	}
	expectedContract := extractionContractHash(contractVersion, model, effort, core.ServiceTierDefault, schema)
	if found {
		return service.reuseLegacyBatch(ctx, existing, inputHash, expectedContract, model, role, spans)
	}
	historical, historicalFound, err := service.findHistoricalLegacyBatch(ctx, run.ProjectID, candidate.ID,
		candidate.ContractSHA256, run.ID, document.ID, chunk.Ordinal, role)
	if err != nil {
		return core.KnowledgePatch{}, legacyBatch{}, err
	}
	locator, _ := json.Marshal(legacyBatchLocator{Contract: legacyRunBackfillContractVersion, ChunkOrdinal: chunk.Ordinal, Role: role})
	batchID, err := id.New("kext")
	if err != nil {
		return core.KnowledgePatch{}, legacyBatch{}, err
	}
	created, err := service.DB.CreateKnowledgeExtractionBatch(ctx, store.KnowledgeExtractionBatch{
		ProjectID: run.ProjectID, GenerationID: candidate.ID, ID: batchID, DocumentID: document.ID,
		RunID: run.ID, ArtifactID: reportArtifact.ID, SourceKind: "backfill", ExtractorModel: model,
		ExtractorContractSHA256: expectedContract,
		InputSHA256:             inputHash, SourceLocator: locator,
	})
	if err != nil {
		return core.KnowledgePatch{}, legacyBatch{}, err
	}
	batch := legacyBatch{
		ID: created.ID, Status: created.Status, InputSHA256: inputHash,
		ExtractorModel: model, ExtractorContractSHA256: expectedContract,
	}
	if historicalFound {
		patch, _, err := service.reuseLegacyBatch(ctx, historical, inputHash, expectedContract, model, role, spans)
		if err != nil {
			return core.KnowledgePatch{}, batch, err
		}
		if err := service.DB.TransitionKnowledgeExtractionBatch(ctx, run.ProjectID, candidate.ID, batch.ID,
			"queued", next, store.KnowledgeExtractionBatchUpdate{CodexThreadID: historical.ThreadID}); err != nil {
			return core.KnowledgePatch{}, batch, err
		}
		update := store.KnowledgeExtractionBatchUpdate{
			CodexThreadID: historical.ThreadID, CodexTurnID: historical.TurnID,
			OutputSHA256: historical.OutputSHA256, PatchBlobHash: historical.PatchBlobHash,
		}
		if err := service.DB.TransitionKnowledgeExtractionBatch(ctx, run.ProjectID, candidate.ID, batch.ID,
			next, "validated", update); err != nil {
			return core.KnowledgePatch{}, batch, err
		}
		batch.Status, batch.ThreadID, batch.TurnID = "validated", historical.ThreadID, historical.TurnID
		batch.OutputSHA256, batch.PatchBlobHash = historical.OutputSHA256, historical.PatchBlobHash
		return patch, batch, nil
	}
	fail := func(expected string, result ExtractionTurnResult, cause error) (core.KnowledgePatch, legacyBatch, error) {
		terminal := "failed"
		if errors.Is(cause, context.Canceled) || errors.Is(cause, context.DeadlineExceeded) {
			terminal = "interrupted"
		}
		update := store.KnowledgeExtractionBatchUpdate{CodexThreadID: result.ThreadID, CodexTurnID: result.TurnID, Error: cause.Error()}
		if len(result.Output) != 0 {
			update.OutputSHA256 = hashBytes(result.Output)
		}
		if transitionErr := service.DB.TransitionKnowledgeExtractionBatch(context.WithoutCancel(ctx), run.ProjectID,
			candidate.ID, batch.ID, expected, terminal, update); transitionErr != nil {
			cause = errors.Join(cause, transitionErr)
		}
		batch.Status, batch.ThreadID, batch.TurnID = terminal, result.ThreadID, result.TurnID
		return core.KnowledgePatch{}, batch, cause
	}
	if err := service.Extraction.ValidateModel(ctx, model, effort, core.ServiceTierDefault); err != nil {
		return fail("queued", ExtractionTurnResult{}, err)
	}
	threadID, err := service.Extraction.CreateExtractionThread(ctx, ExtractionThreadOptions{
		Model: model, ReasoningEffort: effort, ServiceTier: core.ServiceTierDefault, ServiceName: serviceName,
	})
	if err != nil {
		return fail("queued", ExtractionTurnResult{}, err)
	}
	if err := service.DB.TransitionKnowledgeExtractionBatch(ctx, run.ProjectID, candidate.ID, batch.ID,
		"queued", next, store.KnowledgeExtractionBatchUpdate{CodexThreadID: threadID}); err != nil {
		return core.KnowledgePatch{}, batch, err
	}
	result, turnErr := service.Extraction.ExtractionTurn(ctx, threadID, ExtractionTurnOptions{
		Model: model, ReasoningEffort: effort, ServiceTier: core.ServiceTierDefault, Schema: schema, Prompt: prompt,
	})
	if turnErr != nil {
		return fail(next, result, turnErr)
	}
	if err := validateExtractionTurnResult(result, threadID, model, effort); err != nil {
		return fail(next, result, err)
	}
	var patch core.KnowledgePatch
	if role == legacyExtractorRole {
		patch, err = decodeStrictKnowledgePatch(result.Output)
		if err == nil {
			err = validatePinnedPatchEvidence(patch, spans)
		}
	} else {
		var review pinnedReviewResult
		review, err = decodeStrictPinnedReview(result.Output)
		if err == nil {
			err = validatePinnedReview(review, extracted, spans)
			patch = review.KnowledgePatch
		}
	}
	if err != nil {
		return fail(next, result, err)
	}
	patchHash, err := service.storeKnowledgePatch(ctx, patch)
	if err != nil {
		return fail(next, result, err)
	}
	update := store.KnowledgeExtractionBatchUpdate{
		CodexThreadID: result.ThreadID, CodexTurnID: result.TurnID,
		OutputSHA256: hashBytes(result.Output), PatchBlobHash: patchHash,
	}
	if err := service.DB.TransitionKnowledgeExtractionBatch(ctx, run.ProjectID, candidate.ID,
		batch.ID, next, "validated", update); err != nil {
		return core.KnowledgePatch{}, batch, err
	}
	batch.Status, batch.ThreadID, batch.TurnID = "validated", result.ThreadID, result.TurnID
	batch.OutputSHA256, batch.PatchBlobHash = update.OutputSHA256, patchHash
	return patch, batch, nil
}

func (service *Service) findLegacyBatch(
	ctx context.Context, projectID, generationID, runID, documentID string, ordinal int, role string,
) (legacyBatch, bool, error) {
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT id,status,codex_thread_id,codex_turn_id,input_sha256,output_sha256,COALESCE(patch_blob_hash,''),
       extractor_model,extractor_contract_sha256
FROM knowledge_extraction_batches
WHERE project_id=? AND generation_id=? AND run_id=? AND document_id=? AND source_kind='backfill'
  AND json_extract(source_locator_json,'$.contract')=?
  AND json_extract(source_locator_json,'$.chunk_ordinal')=?
  AND json_extract(source_locator_json,'$.role')=?`,
		projectID, generationID, runID, documentID, legacyRunBackfillContractVersion, ordinal, role)
	if err != nil {
		return legacyBatch{}, false, err
	}
	defer rows.Close()
	var values []legacyBatch
	for rows.Next() {
		var value legacyBatch
		if err := rows.Scan(&value.ID, &value.Status, &value.ThreadID, &value.TurnID,
			&value.InputSHA256, &value.OutputSHA256, &value.PatchBlobHash,
			&value.ExtractorModel, &value.ExtractorContractSHA256); err != nil {
			return legacyBatch{}, false, err
		}
		values = append(values, value)
	}
	if err := rows.Err(); err != nil {
		return legacyBatch{}, false, err
	}
	if len(values) > 1 {
		return legacyBatch{}, false, errors.New("legacy backfill chunk role has duplicate durable receipts")
	}
	if len(values) == 0 {
		return legacyBatch{}, false, nil
	}
	return values[0], true, nil
}

func (service *Service) findHistoricalLegacyBatch(
	ctx context.Context,
	projectID, currentGenerationID, generationContract, runID, documentID string,
	ordinal int,
	role string,
) (legacyBatch, bool, error) {
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT b.id,b.status,b.codex_thread_id,b.codex_turn_id,b.input_sha256,b.output_sha256,
       COALESCE(b.patch_blob_hash,''),b.extractor_model,b.extractor_contract_sha256
FROM knowledge_extraction_batches b
JOIN knowledge_generations g ON g.project_id=b.project_id AND g.id=b.generation_id
WHERE b.project_id=? AND b.generation_id<>? AND g.contract_sha256=?
  AND b.run_id=? AND b.document_id=? AND b.source_kind='backfill'
  AND b.status IN('validated','applied')
  AND json_extract(b.source_locator_json,'$.contract')=?
  AND json_extract(b.source_locator_json,'$.chunk_ordinal')=?
  AND json_extract(b.source_locator_json,'$.role')=?
ORDER BY g.created_at,b.created_at,b.id`,
		projectID, currentGenerationID, generationContract, runID, documentID,
		legacyRunBackfillContractVersion, ordinal, role)
	if err != nil {
		return legacyBatch{}, false, err
	}
	defer rows.Close()
	var values []legacyBatch
	for rows.Next() {
		var value legacyBatch
		if err := rows.Scan(&value.ID, &value.Status, &value.ThreadID, &value.TurnID,
			&value.InputSHA256, &value.OutputSHA256, &value.PatchBlobHash,
			&value.ExtractorModel, &value.ExtractorContractSHA256); err != nil {
			return legacyBatch{}, false, err
		}
		values = append(values, value)
	}
	if err := rows.Err(); err != nil {
		return legacyBatch{}, false, err
	}
	if len(values) == 0 {
		return legacyBatch{}, false, nil
	}
	first := values[0]
	for _, value := range values[1:] {
		if value.ThreadID != first.ThreadID || value.TurnID != first.TurnID ||
			value.InputSHA256 != first.InputSHA256 || value.OutputSHA256 != first.OutputSHA256 ||
			value.PatchBlobHash != first.PatchBlobHash || value.ExtractorModel != first.ExtractorModel ||
			value.ExtractorContractSHA256 != first.ExtractorContractSHA256 {
			return legacyBatch{}, false, errors.New("historical legacy backfill receipts disagree for one chunk role")
		}
	}
	return values[len(values)-1], true, nil
}

func (service *Service) reuseLegacyBatch(
	ctx context.Context,
	batch legacyBatch,
	expectedInput, expectedContract, expectedModel, role string,
	spans []pinnedEvidenceSpan,
) (core.KnowledgePatch, legacyBatch, error) {
	if batch.Status != "validated" && batch.Status != "applied" {
		return core.KnowledgePatch{}, batch, fmt.Errorf("%w: batch %s is %s", ErrLegacyBackfillAmbiguous, batch.ID, batch.Status)
	}
	if batch.InputSHA256 != expectedInput || batch.ExtractorContractSHA256 != expectedContract ||
		batch.ExtractorModel != expectedModel {
		return core.KnowledgePatch{}, batch, errors.New("legacy backfill receipt does not match the current prompt/model contract")
	}
	if strings.TrimSpace(batch.ThreadID) == "" || strings.TrimSpace(batch.TurnID) == "" ||
		!isCanonicalSHA256(batch.OutputSHA256) || !isCanonicalSHA256(batch.PatchBlobHash) {
		return core.KnowledgePatch{}, batch, errors.New("legacy backfill receipt omits its thread, turn, output, or patch CAS hash")
	}
	patch, err := service.readLegacyPatch(ctx, batch.PatchBlobHash)
	if err != nil {
		return core.KnowledgePatch{}, batch, err
	}
	if role != legacyExtractorRole && role != legacyReviewerRole {
		return core.KnowledgePatch{}, batch, errors.New("legacy backfill receipt has an unsupported role")
	}
	if err := validatePinnedPatchEvidence(patch, spans); err != nil {
		return core.KnowledgePatch{}, batch, err
	}
	return patch, batch, nil
}

func (service *Service) readLegacyPatch(ctx context.Context, hash string) (core.KnowledgePatch, error) {
	if !isCanonicalSHA256(hash) {
		return core.KnowledgePatch{}, errors.New("legacy backfill receipt has no valid patch CAS hash")
	}
	raw, err := service.CAS.ReadVerified(hash)
	if err != nil {
		return core.KnowledgePatch{}, err
	}
	if hashBytes(raw) != hash {
		return core.KnowledgePatch{}, errors.New("legacy backfill patch CAS readback changed")
	}
	return decodeStrictKnowledgePatch(raw)
}

func (service *Service) loadLegacyRunDocumentExtraction(
	ctx context.Context, run core.Run, document adoptedRunDocument,
) (pinnedDocumentExtraction, error) {
	if document.SourceKind != "evidence" {
		return pinnedDocumentExtraction{}, errors.New("legacy model extraction accepts adopted evidence documents only")
	}
	raw, err := service.CAS.ReadVerified(document.BlobHash)
	if err != nil {
		return pinnedDocumentExtraction{}, err
	}
	var ownerCount int
	if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT COUNT(*) FROM evidence WHERE run_id=? AND blob_hash=? AND adopted=1`, run.ID, document.BlobHash).Scan(&ownerCount); err != nil {
		return pinnedDocumentExtraction{}, err
	}
	if ownerCount == 0 {
		return pinnedDocumentExtraction{}, errors.New("legacy evidence document is not adopted by the successful run")
	}
	normalized, boundaries, err := normalizedDocumentWithBoundaries(raw)
	if err != nil {
		return pinnedDocumentExtraction{}, err
	}
	windows := deterministicChunkWindows(normalized)
	byOrdinal := make(map[int]derivedChunkWindow, len(windows))
	for _, window := range windows {
		byOrdinal[window.Ordinal] = window
	}
	inverse := make(map[int]int, len(boundaries))
	for rawOffset, normalizedOffset := range boundaries {
		if prior, exists := inverse[normalizedOffset]; !exists || rawOffset < prior {
			inverse[normalizedOffset] = rawOffset
		}
	}
	spansByOrdinal := make(map[int][]pinnedEvidenceSpan, len(document.Chunks))
	for _, chunk := range document.Chunks {
		window, exists := byOrdinal[chunk.Ordinal]
		if !exists || window.Text != chunk.Text || hashBytes([]byte(window.Text)) != chunk.TextHash {
			return pinnedDocumentExtraction{}, fmt.Errorf("legacy stored chunk ordinal %d differs from CAS-derived chunking", chunk.Ordinal)
		}
		spans, err := legacyRunSpansForWindow(raw, normalized, inverse, run.ID, document, window)
		if err != nil {
			return pinnedDocumentExtraction{}, err
		}
		spansByOrdinal[chunk.Ordinal] = spans
	}
	return pinnedDocumentExtraction{Document: document, Spans: spansByOrdinal}, nil
}

func legacyRunSpansForWindow(
	raw []byte, normalized string, inverse map[int]int, runID string,
	document adoptedRunDocument, window derivedChunkWindow,
) ([]pinnedEvidenceSpan, error) {
	var spans []pinnedEvidenceSpan
	for localStart := 0; localStart <= len(window.Text); {
		localEnd := strings.IndexByte(window.Text[localStart:], '\n')
		last := localEnd < 0
		if last {
			localEnd = len(window.Text)
		} else {
			localEnd += localStart
		}
		segment := window.Text[localStart:localEnd]
		left := strings.TrimLeftFunc(segment, unicode.IsSpace)
		start := localStart + len(segment) - len(left)
		text := strings.TrimRightFunc(left, unicode.IsSpace)
		end := start + len(text)
		if text != "" {
			normalizedStart, normalizedEnd := window.StartByte+start, window.StartByte+end
			rawStart, startOK := inverse[normalizedStart]
			rawEnd, endOK := inverse[normalizedEnd]
			if !startOK || !endOK || rawStart < 0 || rawEnd <= rawStart || rawEnd > len(raw) {
				return nil, errors.New("legacy evidence cannot be mapped to exact CAS byte boundaries")
			}
			if !utf8.Valid(raw[rawStart:rawEnd]) || string(raw[rawStart:rawEnd]) != normalized[normalizedStart:normalizedEnd] {
				return nil, errors.New("legacy evidence changes during UTF-8/newline normalization")
			}
			spanHash := hashBytes(raw[rawStart:rawEnd])
			claimMaterial := strings.Join([]string{runID, document.ID, fmt.Sprint(rawStart), fmt.Sprint(rawEnd), spanHash}, "\x00")
			claimSum := sha256.Sum256([]byte(claimMaterial))
			spans = append(spans, pinnedEvidenceSpan{
				SourceID: "legacy_run:" + runID + ":" + document.ID,
				ClaimID:  "claim_" + hex.EncodeToString(claimSum[:16]), BlobHash: document.BlobHash,
				ByteStart: int64(rawStart), ByteEnd: int64(rawEnd), SpanHash: spanHash, Text: text,
			})
		}
		if last {
			break
		}
		localStart = localEnd + 1
	}
	return spans, nil
}

func (service *Service) legacyBackfillCandidate(
	ctx context.Context, projectID, contract string,
) (store.KnowledgeGeneration, bool, error) {
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT g.id
FROM knowledge_generations g
WHERE g.project_id=? AND g.contract_sha256=? AND g.state IN('building','validating','ready')
ORDER BY g.created_at,g.id`, projectID, contract)
	if err != nil {
		return store.KnowledgeGeneration{}, false, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return store.KnowledgeGeneration{}, false, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return store.KnowledgeGeneration{}, false, err
	}
	if len(ids) > 1 {
		return store.KnowledgeGeneration{}, false, errors.New("multiple resumable legacy backfill generations exist")
	}
	if len(ids) == 0 {
		return store.KnowledgeGeneration{}, false, nil
	}
	generation, err := service.DB.KnowledgeGeneration(ctx, projectID, ids[0])
	return generation, true, err
}

func (service *Service) rejectAmbiguousLegacyBackfillHistory(
	ctx context.Context, projectID, runID, contract string,
) error {
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT DISTINCT g.id,g.state
FROM knowledge_extraction_batches b
JOIN knowledge_generations g ON g.project_id=b.project_id AND g.id=b.generation_id
WHERE b.project_id=? AND b.run_id=? AND b.source_kind='backfill'
  AND g.contract_sha256=?
	  AND b.status IN('queued','extracting','reviewing','interrupted','failed')
ORDER BY g.created_at,g.id`, projectID, runID, contract)
	if err != nil {
		return err
	}
	type candidate struct {
		id    string
		state store.KnowledgeGenerationState
	}
	var candidates []candidate
	for rows.Next() {
		var value candidate
		if err := rows.Scan(&value.id, &value.state); err != nil {
			rows.Close()
			return err
		}
		candidates = append(candidates, value)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(candidates) == 0 {
		return nil
	}
	reason := fmt.Errorf("%w; the preserved batch/thread/turn receipt must be resolved by an explicit user retry", ErrLegacyBackfillAmbiguous)
	for _, value := range candidates {
		if value.state == store.KnowledgeBuilding {
			if err := service.failOpenExtractionBatches(context.WithoutCancel(ctx), projectID, value.id,
				errors.Join(context.Canceled, reason)); err != nil {
				return errors.Join(reason, err)
			}
			if _, err := service.DB.TransitionKnowledgeGeneration(context.WithoutCancel(ctx), projectID, value.id,
				store.KnowledgeBuilding, store.KnowledgeFailed, reason.Error()); err != nil {
				return errors.Join(reason, err)
			}
		}
	}
	return fmt.Errorf("%w (%d durable ambiguous generation receipts)", reason, len(candidates))
}

func (service *Service) publishLegacyRunSnapshot(ctx context.Context, projectID, generationID, ontologyID string) error {
	var existing int
	if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT COUNT(*) FROM knowledge_rdf_snapshots WHERE project_id=? AND generation_id=?`, projectID, generationID).Scan(&existing); err != nil {
		return err
	}
	if existing == 1 {
		return nil
	}
	if existing != 0 {
		return errors.New("legacy backfill generation has multiple RDF snapshots")
	}
	snapshot, triples, err := service.generationNQuads(ctx, projectID, generationID, ontologyID)
	if err != nil {
		return err
	}
	receipt, err := service.CAS.PutBytes(snapshot)
	if err != nil {
		return err
	}
	if _, err := service.CAS.ReadVerified(receipt.Hash); err != nil {
		return err
	}
	if err := service.DB.RegisterBlob(ctx, receipt, "application/n-quads"); err != nil {
		return err
	}
	return service.DB.AppendKnowledgeProjection(ctx, projectID, generationID, store.KnowledgeProjection{
		Snapshots: []store.KnowledgeRDFSnapshotRecord{{
			ID: "krdf_" + receipt.Hash[:32], Format: "n-quads", BlobHash: receipt.Hash,
			DatasetSHA256: receipt.Hash, TripleCount: triples,
		}},
	})
}

func (service *Service) loadLegacyConflictCuration(ctx context.Context, projectID, generationID string) ([]pendingKnowledgeCuration, error) {
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT kind,payload_json FROM knowledge_curation_events
WHERE project_id=? AND generation_id=? AND kind IN('resolve_conflict','dismiss_conflict')
ORDER BY sequence`, projectID, generationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []pendingKnowledgeCuration
	for rows.Next() {
		var item pendingKnowledgeCuration
		var raw string
		if err := rows.Scan(&item.Kind, &raw); err != nil {
			return nil, err
		}
		item.Payload = json.RawMessage(raw)
		result = append(result, item)
	}
	return result, rows.Err()
}

func mergeLegacyKnowledgePatch(left, right core.KnowledgePatch) (core.KnowledgePatch, error) {
	entities := make(map[string]core.KnowledgeEntity, len(left.Entities)+len(right.Entities))
	for _, entity := range append(append([]core.KnowledgeEntity{}, left.Entities...), right.Entities...) {
		if prior, exists := entities[entity.ID]; exists {
			before, _ := json.Marshal(prior)
			after, _ := json.Marshal(entity)
			if string(before) != string(after) {
				return core.KnowledgePatch{}, fmt.Errorf("legacy chunks disagree on entity %s", entity.ID)
			}
			continue
		}
		entities[entity.ID] = entity
	}
	type assertionAggregate struct {
		value    core.KnowledgeAssertion
		evidence map[string]core.KnowledgeEvidenceRef
	}
	assertions := map[string]*assertionAggregate{}
	for _, assertion := range append(append([]core.KnowledgeAssertion{}, left.Assertions...), right.Assertions...) {
		current := assertions[assertion.ID]
		withoutEvidence := assertion
		withoutEvidence.Evidence = nil
		if current == nil {
			current = &assertionAggregate{value: withoutEvidence, evidence: map[string]core.KnowledgeEvidenceRef{}}
			assertions[assertion.ID] = current
		} else {
			before, _ := json.Marshal(current.value)
			after, _ := json.Marshal(withoutEvidence)
			if string(before) != string(after) {
				return core.KnowledgePatch{}, fmt.Errorf("legacy chunks disagree on assertion %s", assertion.ID)
			}
		}
		for _, evidence := range assertion.Evidence {
			current.evidence[evidenceReferenceKey(evidence)] = evidence
		}
	}
	merged := core.KnowledgePatch{
		SchemaVersion: core.KnowledgePatchSchemaV1, UnitRegistryVersion: core.CurrentUnitRegistryVersion,
		Entities: []core.KnowledgeEntity{}, Assertions: []core.KnowledgeAssertion{},
	}
	for _, entity := range entities {
		merged.Entities = append(merged.Entities, entity)
	}
	for _, assertion := range assertions {
		for _, evidence := range assertion.evidence {
			assertion.value.Evidence = append(assertion.value.Evidence, evidence)
		}
		sort.Slice(assertion.value.Evidence, func(i, j int) bool {
			return evidenceReferenceKey(assertion.value.Evidence[i]) < evidenceReferenceKey(assertion.value.Evidence[j])
		})
		merged.Assertions = append(merged.Assertions, assertion.value)
	}
	sort.Slice(merged.Entities, func(i, j int) bool { return merged.Entities[i].ID < merged.Entities[j].ID })
	sort.Slice(merged.Assertions, func(i, j int) bool { return merged.Assertions[i].ID < merged.Assertions[j].ID })
	return merged, merged.ValidateStructure()
}
