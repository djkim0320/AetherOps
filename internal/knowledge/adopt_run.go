package knowledge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/id"
	"github.com/djkim0320/AetherOps/internal/store"
)

// Run knowledge materialization is deliberately a second, fail-closed commit
// after a successful research run. A storage or sidecar failure never changes
// the run result; it leaves the prior generation active and marks the graph
// stale while the shadow generation is recorded as failed.
const RunKnowledgeMaterializationContractV2 = "aetherops-run-knowledge-materialization-v2"

// RunKnowledgeMaterializationContractSHA256 binds a shadow generation to the
// exact ontology and KnowledgePatch that were deterministically projected.
// The same helper is used by both the writer and release verifier so contract
// drift cannot be hidden behind a locally chosen generation digest.
func RunKnowledgeMaterializationContractSHA256(ontologySHA256, patchSHA256 string) (string, error) {
	if !isCanonicalSHA256(ontologySHA256) || !isCanonicalSHA256(patchSHA256) {
		return "", errors.New("run knowledge materialization requires canonical ontology and patch SHA-256 values")
	}
	material := strings.Join([]string{RunKnowledgeMaterializationContractV2, ontologySHA256, patchSHA256}, "\n")
	sum := sha256.Sum256([]byte(material))
	return hex.EncodeToString(sum[:]), nil
}

// RunKnowledgeExtractorContractSHA256 is the immutable receipt contract for
// the deterministic report-patch adapter. It is separate from the generation
// contract because the latter additionally binds ontology and patch inputs.
func RunKnowledgeExtractorContractSHA256() string {
	sum := sha256.Sum256([]byte(RunKnowledgeMaterializationContractV2))
	return hex.EncodeToString(sum[:])
}

func isCanonicalSHA256(value string) bool {
	if len(value) != sha256.Size*2 || value != strings.ToLower(value) {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}

type adoptedRunChunk struct {
	ID       string
	Ordinal  int
	Text     string
	TextHash string
}

type adoptedRunDocument struct {
	ID         string
	ArtifactID string
	BlobHash   string
	Title      string
	SourceKind string
	Chunks     []adoptedRunChunk
}

type mappedTextEvidence struct {
	Reference core.KnowledgeEvidenceRef
	ChunkID   string
	StartByte int
	EndByte   int
}

type derivedChunkWindow struct {
	Ordinal   int
	StartByte int
	EndByte   int
	Text      string
}

// AdoptRun adopts the final, already quality-gated ReportManifest knowledge
// patch into a new immutable generation. It requires Memory.IndexRun to have
// completed first so every report/evidence document has deterministic chunks.
func (service *Service) AdoptRun(ctx context.Context, runID string) (returnErr error) {
	if err := service.configured(); err != nil {
		return err
	}
	if service.Sidecar == nil {
		return errors.New("Oxigraph sidecar is required to validate run knowledge")
	}
	if strings.TrimSpace(runID) == "" {
		return errors.New("run id is required")
	}
	run, err := service.DB.Run(ctx, runID)
	if err != nil {
		return err
	}
	if run.Status != core.RunSucceeded || run.ReportArtifactID == "" {
		return errors.New("only a succeeded run with a final report can be adopted")
	}

	service.rebuildMu.Lock()
	if service.rebuilding == nil {
		service.rebuilding = map[string]bool{}
	}
	if service.rebuilding[run.ProjectID] {
		service.rebuildMu.Unlock()
		return errors.New("knowledge materialization is already running for this project")
	}
	service.rebuilding[run.ProjectID] = true
	service.rebuildMu.Unlock()
	defer func() {
		service.rebuildMu.Lock()
		delete(service.rebuilding, run.ProjectID)
		service.rebuildMu.Unlock()
	}()

	head, err := service.DB.ActiveKnowledgeGeneration(ctx, run.ProjectID)
	if err != nil {
		return err
	}
	if head.Generation.State != store.KnowledgeReady || head.Status == store.KnowledgeHeadFailed {
		// A fully validated candidate can survive a crash immediately before the
		// atomic head swap. Resolve durable lineage before rejecting the old head.
		applied, appliedErr := service.DB.AppliedKnowledgeForRun(ctx, run.ProjectID, run.ID)
		if appliedErr == nil && applied.State == store.KnowledgeReady && !applied.Active {
			if err := service.loadRunSnapshot(ctx, run.ProjectID, applied.GenerationID); err != nil {
				return fmt.Errorf("load recovered run generation snapshot: %w", err)
			}
			_, err = service.DB.ActivateKnowledgeGeneration(ctx, run.ProjectID, applied.GenerationID)
			return err
		}
		if appliedErr != nil && !errors.Is(appliedErr, sql.ErrNoRows) {
			return appliedErr
		}
		return errors.New("the active knowledge generation is not a usable rebuild base")
	}
	applied, err := service.DB.AppliedKnowledgeForRun(ctx, run.ProjectID, run.ID)
	if err == nil {
		if applied.State == store.KnowledgeReady && !applied.Active && head.Status != store.KnowledgeHeadReady {
			if err := service.loadRunSnapshot(ctx, run.ProjectID, applied.GenerationID); err != nil {
				return fmt.Errorf("load recovered run generation snapshot: %w", err)
			}
			_, err = service.DB.ActivateKnowledgeGeneration(ctx, run.ProjectID, applied.GenerationID)
			return err
		}
		return service.loadActiveRunSnapshot(ctx, head)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	// From this boundary onward any error means a successful report is absent
	// from the graph projection. Preserve the old generation but block graph
	// retrieval until a later verified rebuild succeeds.
	markStale := true
	var candidate store.KnowledgeGeneration
	candidateState := store.KnowledgeBuilding
	defer func() {
		if returnErr == nil || !markStale {
			return
		}
		failureCtx := context.WithoutCancel(ctx)
		if candidate.ID != "" && (candidateState == store.KnowledgeBuilding || candidateState == store.KnowledgeValidating) {
			if _, failErr := service.DB.TransitionKnowledgeGeneration(
				failureCtx, run.ProjectID, candidate.ID, candidateState, store.KnowledgeFailed, returnErr.Error(),
			); failErr != nil {
				returnErr = errors.Join(returnErr, fmt.Errorf("mark run knowledge generation failed: %w", failErr))
			}
		}
		current, headErr := service.DB.ActiveKnowledgeGeneration(failureCtx, run.ProjectID)
		if headErr != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("load knowledge head after materialization failure: %w", headErr))
			return
		}
		if current.Status != store.KnowledgeHeadStale {
			if _, staleErr := service.DB.SetKnowledgeHeadStatus(
				failureCtx, run.ProjectID, current.KnowledgeRevision, store.KnowledgeHeadStale,
				"successful run knowledge materialization failed: "+returnErr.Error(),
			); staleErr != nil {
				returnErr = errors.Join(returnErr, fmt.Errorf("mark knowledge head stale: %w", staleErr))
			}
		}
	}()

	reportArtifact, metadata, err := service.DB.RunArtifact(ctx, run.ID, run.ReportArtifactID)
	if err != nil {
		return err
	}
	if !reportArtifact.Adopted || (reportArtifact.Kind != "research.report" && reportArtifact.Kind != "research.report.revision") {
		return errors.New("run report artifact is not the adopted final report")
	}
	if metadata.MediaType != "application/json" {
		return fmt.Errorf("final report media type %q is not application/json", metadata.MediaType)
	}
	reportBytes, err := service.CAS.ReadVerified(reportArtifact.BlobHash)
	if err != nil {
		return fmt.Errorf("read final report CAS object: %w", err)
	}
	if int64(len(reportBytes)) != metadata.Size || metadata.Hash != reportArtifact.BlobHash {
		return errors.New("final report CAS metadata does not match verified readback")
	}
	report, err := decodeStrictReportManifest(reportBytes)
	if err != nil {
		return fmt.Errorf("decode final report manifest: %w", err)
	}
	if strings.TrimSpace(report.Title) == "" || strings.TrimSpace(report.AnswerMarkdown) == "" {
		return errors.New("final report manifest omits title or answer")
	}
	if isMissingLegacyKnowledgePatch(report.KnowledgePatch) {
		return service.adoptLegacyRunKnowledge(ctx, run, head, reportArtifact)
	}
	if err := report.KnowledgePatch.ValidateStructure(); err != nil {
		return fmt.Errorf("validate final report knowledge patch: %w", err)
	}
	patchBytes, err := json.Marshal(report.KnowledgePatch)
	if err != nil {
		return err
	}
	patchReceipt, err := service.CAS.PutBytes(patchBytes)
	if err != nil {
		return err
	}
	if _, err := service.CAS.ReadVerified(patchReceipt.Hash); err != nil {
		return err
	}
	if err := service.DB.RegisterBlob(ctx, patchReceipt, "application/json"); err != nil {
		return err
	}

	documents, err := service.adoptIndexedRunDocuments(ctx, run)
	if err != nil {
		return err
	}
	if err := service.rejectUnprojectedForeignDocuments(ctx, run.ProjectID, head.GenerationID, documents); err != nil {
		return err
	}
	if head.Status != store.KnowledgeHeadStale {
		head, err = service.DB.SetKnowledgeHeadStatus(
			ctx, run.ProjectID, head.KnowledgeRevision, store.KnowledgeHeadStale,
			"successful run knowledge patch is building in a shadow generation",
		)
		if err != nil {
			return err
		}
	}

	ontologyID, ontologyHash, err := service.activeMaterializationOntology(ctx, run.ProjectID)
	if err != nil {
		return err
	}
	materializationContract, err := RunKnowledgeMaterializationContractSHA256(ontologyHash, patchReceipt.Hash)
	if err != nil {
		return err
	}
	candidate, err = service.DB.CreateKnowledgeGeneration(
		ctx, run.ProjectID, ontologyID, materializationContract,
	)
	if err != nil {
		return err
	}
	if err := service.copyActiveProjection(ctx, run.ProjectID, head.Generation, candidate); err != nil {
		return err
	}
	pendingConflictCuration, err := service.applyPendingCuration(ctx, run.ProjectID, head.GenerationID, candidate.ID)
	if err != nil {
		return err
	}
	normalizedPatch, err := service.normalizeRunPatch(ctx, run.ProjectID, candidate.ID, report.KnowledgePatch)
	if err != nil {
		return fmt.Errorf("normalize successful-run knowledge identity: %w", err)
	}
	projection, err := service.runKnowledgeProjection(ctx, run, candidate, normalizedPatch, documents)
	if err != nil {
		return err
	}
	engineeringProjection, err := service.deterministicEngineeringProjection(ctx, run)
	if err != nil {
		return err
	}
	projection.Entities = append(projection.Entities, engineeringProjection.Entities...)
	projection.Assertions = append(projection.Assertions, engineeringProjection.Assertions...)
	projection.Evidence = append(projection.Evidence, engineeringProjection.Evidence...)
	if err := service.DB.AppendKnowledgeProjection(ctx, run.ProjectID, candidate.ID, projection); err != nil {
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
	for _, event := range pendingConflictCuration {
		if err := service.applyCurationEvent(ctx, run.ProjectID, candidate.ID, event.Kind, event.Payload); err != nil {
			return fmt.Errorf("apply run conflict curation %s: %w", event.Kind, err)
		}
	}
	if err := service.recordAppliedRunPatch(ctx, run, candidate, reportArtifact, patchReceipt.Hash); err != nil {
		return err
	}

	snapshot, tripleCount, err := service.generationNQuads(ctx, run.ProjectID, candidate.ID, ontologyID)
	if err != nil {
		return err
	}
	service.checkpointDurabilityTest("run_before_snapshot_publish")
	snapshotReceipt, err := service.CAS.PutBytes(snapshot)
	if err != nil {
		return err
	}
	if _, err := service.CAS.ReadVerified(snapshotReceipt.Hash); err != nil {
		return err
	}
	if err := service.DB.RegisterBlob(ctx, snapshotReceipt, "application/n-quads"); err != nil {
		return err
	}
	snapshotID := "krdf_" + snapshotReceipt.Hash[:32]
	if err := service.DB.AppendKnowledgeProjection(ctx, run.ProjectID, candidate.ID, store.KnowledgeProjection{
		Snapshots: []store.KnowledgeRDFSnapshotRecord{{
			ID: snapshotID, Format: "n-quads", BlobHash: snapshotReceipt.Hash,
			DatasetSHA256: snapshotReceipt.Hash, TripleCount: tripleCount,
		}},
	}); err != nil {
		return err
	}
	service.checkpointDurabilityTest("run_after_snapshot_publish")
	if _, err := service.DB.TransitionKnowledgeGeneration(
		ctx, run.ProjectID, candidate.ID, store.KnowledgeBuilding, store.KnowledgeValidating, "",
	); err != nil {
		return err
	}
	candidateState = store.KnowledgeValidating
	if err := service.Sidecar.LoadSnapshot(
		ctx, run.ProjectID, candidate.ID, snapshot, snapshotReceipt.Hash, tripleCount,
	); err != nil {
		return fmt.Errorf("validate run RDF snapshot in Oxigraph: %w", err)
	}
	ready, err := service.DB.TransitionKnowledgeGeneration(
		ctx, run.ProjectID, candidate.ID, store.KnowledgeValidating, store.KnowledgeReady, "",
	)
	if err != nil {
		return err
	}
	candidateState = store.KnowledgeReady
	service.checkpointDurabilityTest("run_before_head_swap")
	if _, err := service.DB.ActivateKnowledgeGeneration(ctx, run.ProjectID, ready.ID); err != nil {
		return err
	}
	service.checkpointDurabilityTest("run_after_head_swap")
	markStale = false
	return nil
}

func decodeStrictReportManifest(data []byte) (core.ReportManifest, error) {
	var report core.ReportManifest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&report); err != nil {
		return report, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return report, errors.New("report CAS object contains multiple JSON values")
		}
		return report, err
	}
	return report, nil
}

func (service *Service) loadActiveRunSnapshot(ctx context.Context, head store.KnowledgeHead) error {
	return service.loadRunSnapshot(ctx, head.ProjectID, head.GenerationID)
}

func (service *Service) loadRunSnapshot(ctx context.Context, projectID, generationID string) error {
	var blobHash, datasetHash string
	var tripleCount int
	if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT blob_hash,dataset_sha256,triple_count FROM knowledge_rdf_snapshots
WHERE project_id=? AND generation_id=? ORDER BY created_at DESC,id DESC LIMIT 1`,
		projectID, generationID).Scan(&blobHash, &datasetHash, &tripleCount); err != nil {
		return err
	}
	data, err := service.CAS.ReadVerified(blobHash)
	if err != nil {
		return err
	}
	return service.Sidecar.LoadSnapshot(ctx, projectID, generationID, data, datasetHash, tripleCount)
}

func (service *Service) activeMaterializationOntology(ctx context.Context, projectID string) (string, string, error) {
	var ontologyID, canonicalHash string
	err := service.DB.SQL().QueryRowContext(ctx, `
SELECT id,canonical_sha256 FROM ontology_versions
WHERE project_id=? AND state='active' ORDER BY activated_at DESC,id DESC LIMIT 1`, projectID).Scan(&ontologyID, &canonicalHash)
	if errors.Is(err, sql.ErrNoRows) {
		err = service.DB.SQL().QueryRowContext(ctx, `
SELECT id,canonical_sha256 FROM ontology_versions WHERE id=? AND project_id IS NULL AND state='active'`,
			store.CoreOntologyID).Scan(&ontologyID, &canonicalHash)
	}
	return ontologyID, canonicalHash, err
}

func (service *Service) adoptIndexedRunDocuments(ctx context.Context, run core.Run) ([]adoptedRunDocument, error) {
	materials, err := service.DB.AdoptedMemoryMaterials(ctx, run.ID)
	if err != nil {
		return nil, err
	}
	if len(materials) == 0 {
		return nil, errors.New("successful run has no adopted memory documents")
	}
	byID := map[string]adoptedRunDocument{}
	for _, material := range materials {
		rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT id,COALESCE(artifact_id,''),blob_hash,title
FROM documents
WHERE project_id=? AND blob_hash=? AND COALESCE(artifact_id,'')=? AND status='ready'
ORDER BY id`, material.ProjectID, material.BlobHash, material.ArtifactID)
		if err != nil {
			return nil, err
		}
		var matches []adoptedRunDocument
		for rows.Next() {
			var document adoptedRunDocument
			if err := rows.Scan(&document.ID, &document.ArtifactID, &document.BlobHash, &document.Title); err != nil {
				rows.Close()
				return nil, err
			}
			matches = append(matches, document)
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
		if len(matches) != 1 {
			return nil, fmt.Errorf("adopted run material %s resolves to %d ready documents; run Memory.IndexRun first and remove ambiguity", material.BlobHash, len(matches))
		}
		document := matches[0]
		if material.ArtifactID != "" {
			document.SourceKind = "report"
		} else {
			document.SourceKind = "evidence"
		}
		chunkRows, err := service.DB.SQL().QueryContext(ctx, `
SELECT id,ordinal,text,text_hash FROM chunks WHERE document_id=? ORDER BY ordinal,id`, document.ID)
		if err != nil {
			return nil, err
		}
		for chunkRows.Next() {
			var chunk adoptedRunChunk
			if err := chunkRows.Scan(&chunk.ID, &chunk.Ordinal, &chunk.Text, &chunk.TextHash); err != nil {
				chunkRows.Close()
				return nil, err
			}
			sum := sha256.Sum256([]byte(chunk.Text))
			if hex.EncodeToString(sum[:]) != chunk.TextHash {
				chunkRows.Close()
				return nil, fmt.Errorf("indexed chunk %s text hash mismatch", chunk.ID)
			}
			document.Chunks = append(document.Chunks, chunk)
		}
		if err := chunkRows.Close(); err != nil {
			return nil, err
		}
		if len(document.Chunks) == 0 {
			return nil, fmt.Errorf("adopted run document %s has no deterministic chunks", document.ID)
		}
		byID[document.ID] = document
	}
	documents := make([]adoptedRunDocument, 0, len(byID))
	for _, document := range byID {
		documents = append(documents, document)
	}
	sort.Slice(documents, func(i, j int) bool { return documents[i].ID < documents[j].ID })
	tx, err := service.DB.SQL().BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	for _, document := range documents {
		result, err := tx.ExecContext(ctx, `
UPDATE documents SET graph_adopt=1,updated_at=?
WHERE id=? AND project_id=? AND status='ready'`, time.Now().UTC().Format(time.RFC3339Nano), document.ID, run.ProjectID)
		if err != nil {
			return nil, err
		}
		if count, err := result.RowsAffected(); err != nil || count != 1 {
			if err == nil {
				err = sql.ErrNoRows
			}
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return documents, nil
}

func (service *Service) rejectUnprojectedForeignDocuments(ctx context.Context, projectID, generationID string, current []adoptedRunDocument) error {
	currentIDs := make(map[string]bool, len(current))
	for _, document := range current {
		currentIDs[document.ID] = true
	}
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT d.id FROM documents d
WHERE d.project_id=? AND d.graph_adopt=1 AND NOT EXISTS(
 SELECT 1 FROM knowledge_sources ks JOIN chunks c ON c.id=ks.chunk_id
 WHERE ks.project_id=d.project_id AND ks.generation_id=? AND c.document_id=d.id
)
ORDER BY d.id`, projectID, generationID)
	if err != nil {
		return err
	}
	defer rows.Close()
	var foreign []string
	for rows.Next() {
		var documentID string
		if err := rows.Scan(&documentID); err != nil {
			return err
		}
		if !currentIDs[documentID] {
			foreign = append(foreign, documentID)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(foreign) != 0 {
		return fmt.Errorf("%d previously graph-adopted documents still require their own validated extractor/reviewer output", len(foreign))
	}
	return nil
}

func (service *Service) runKnowledgeProjection(
	ctx context.Context,
	run core.Run,
	candidate store.KnowledgeGeneration,
	patch core.KnowledgePatch,
	documents []adoptedRunDocument,
) (store.KnowledgeProjection, error) {
	projection := store.KnowledgeProjection{}
	documentsByBlob := make(map[string][]adoptedRunDocument)
	for _, document := range documents {
		documentsByBlob[document.BlobHash] = append(documentsByBlob[document.BlobHash], document)
		for _, chunk := range document.Chunks {
			var exists int
			if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT COUNT(*) FROM knowledge_sources WHERE project_id=? AND generation_id=? AND chunk_id=?`,
				run.ProjectID, candidate.ID, chunk.ID).Scan(&exists); err != nil {
				return projection, err
			}
			if exists != 0 {
				continue
			}
			locator, err := json.Marshal(map[string]any{
				"document_id": document.ID, "ordinal": chunk.Ordinal, "run_id": run.ID,
			})
			if err != nil {
				return projection, err
			}
			projection.Sources = append(projection.Sources, store.KnowledgeSourceRecord{
				ChunkID: chunk.ID, BlobHash: document.BlobHash, SourceKind: document.SourceKind,
				SourceLocator: locator, TextHash: chunk.TextHash,
			})
		}
	}

	entities := append([]core.KnowledgeEntity(nil), patch.Entities...)
	sort.Slice(entities, func(i, j int) bool { return entities[i].ID < entities[j].ID })
	entitySet := make(map[string]core.KnowledgeEntity, len(entities))
	aliasOwners := map[string]string{}
	aliasRows, err := service.DB.SQL().QueryContext(ctx, `
SELECT normalized_alias,entity_id FROM knowledge_aliases WHERE project_id=? AND generation_id=? ORDER BY normalized_alias,entity_id`,
		run.ProjectID, candidate.ID)
	if err != nil {
		return projection, err
	}
	for aliasRows.Next() {
		var alias, entityID string
		if err := aliasRows.Scan(&alias, &entityID); err != nil {
			aliasRows.Close()
			return projection, err
		}
		if owner, exists := aliasOwners[alias]; exists && owner != entityID {
			aliasRows.Close()
			return projection, fmt.Errorf("active generation contains ambiguous alias %q", alias)
		}
		aliasOwners[alias] = entityID
	}
	if err := aliasRows.Close(); err != nil {
		return projection, err
	}
	for _, entity := range entities {
		entitySet[entity.ID] = entity
		var classKey, canonicalName, normalizedName string
		err := service.DB.SQL().QueryRowContext(ctx, `
SELECT class_key,canonical_name,normalized_name FROM knowledge_entities
WHERE project_id=? AND generation_id=? AND id=?`, run.ProjectID, candidate.ID, entity.ID).Scan(&classKey, &canonicalName, &normalizedName)
		existing := err == nil
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return projection, err
		}
		normalized := normalizeKnowledgeName(entity.CanonicalName)
		if existing {
			if classKey != entity.Type || canonicalName != entity.CanonicalName || normalizedName != normalized {
				return projection, fmt.Errorf("entity id %s conflicts with the active generation", entity.ID)
			}
		} else {
			projection.Entities = append(projection.Entities, store.KnowledgeEntityRecord{
				ID: entity.ID, ClassKey: entity.Type, CanonicalName: entity.CanonicalName,
				NormalizedName: normalized,
			})
		}
		aliases := append([]core.KnowledgeAlias(nil), entity.Aliases...)
		sort.Slice(aliases, func(i, j int) bool {
			left, right := normalizeKnowledgeName(aliases[i].Value), normalizeKnowledgeName(aliases[j].Value)
			if left == right {
				return aliases[i].Language < aliases[j].Language
			}
			return left < right
		})
		for _, alias := range aliases {
			normalizedAlias := normalizeKnowledgeName(alias.Value)
			if owner, exists := aliasOwners[normalizedAlias]; exists {
				if owner != entity.ID {
					return projection, fmt.Errorf("alias %q belongs to entity %s; automatic alias-based merge is forbidden", alias.Value, owner)
				}
				continue
			}
			aliasOwners[normalizedAlias] = entity.ID
			projection.Aliases = append(projection.Aliases, store.KnowledgeAliasRecord{
				EntityID: entity.ID, Alias: alias.Value, NormalizedAlias: normalizedAlias, Language: alias.Language,
			})
		}
	}

	assertions := append([]core.KnowledgeAssertion(nil), patch.Assertions...)
	sort.Slice(assertions, func(i, j int) bool { return assertions[i].ID < assertions[j].ID })
	textByEntity := map[string][]mappedTextEvidence{}
	artifactByEntity := map[string]bool{}
	engineeringArtifacts, err := service.runEngineeringArtifacts(ctx, run.ID)
	if err != nil {
		return projection, err
	}
	engineeringReadback := map[string][]byte{}
	newAssertionKeys := map[string]string{}
	for _, assertion := range assertions {
		qualifiers, err := canonicalKnowledgeQualifiers(assertion.Qualifiers)
		if err != nil {
			return projection, fmt.Errorf("assertion %s qualifiers: %w", assertion.ID, err)
		}
		literal, err := canonicalKnowledgeLiteral(assertion.ObjectLiteral)
		if err != nil {
			return projection, err
		}
		var validFrom, validTo *time.Time
		if assertion.ValidTime != nil {
			validFrom, err = core.ParseKnowledgeTimeBoundary(assertion.ValidTime.Start)
			if err != nil {
				return projection, fmt.Errorf("assertion %s validity start: %w", assertion.ID, err)
			}
			validTo, err = core.ParseKnowledgeTimeBoundary(assertion.ValidTime.End)
			if err != nil {
				return projection, fmt.Errorf("assertion %s validity end: %w", assertion.ID, err)
			}
		}
		assertionKey, err := knowledgeAssertionKey(assertion, qualifiers, literal)
		if err != nil {
			return projection, err
		}
		if otherID, duplicate := newAssertionKeys[assertionKey]; duplicate && otherID != assertion.ID {
			return projection, fmt.Errorf("assertion %s duplicates patch assertion %s under a different id", assertion.ID, otherID)
		}
		newAssertionKeys[assertionKey] = assertion.ID
		newRecord := store.KnowledgeAssertionRecord{
			ID: assertion.ID, SubjectEntityID: assertion.SubjectEntityID, PredicateKey: assertion.Predicate,
			ObjectEntityID: assertion.ObjectEntityID, Literal: literal, Qualifiers: qualifiers,
			Polarity: "affirmed", ValidFrom: validFrom, ValidTo: validTo,
			Status: "accepted", Confidence: 1, AssertionKey: assertionKey,
		}
		existing, exists, err := service.existingAssertion(ctx, run.ProjectID, candidate.ID, assertion.ID)
		if err != nil {
			return projection, err
		}
		if exists {
			if !sameKnowledgeAssertion(existing, newRecord) {
				return projection, fmt.Errorf("assertion id %s conflicts with the active generation", assertion.ID)
			}
		} else {
			var otherID string
			err := service.DB.SQL().QueryRowContext(ctx, `
SELECT id FROM knowledge_assertions
WHERE project_id=? AND generation_id=? AND assertion_key=? AND id<>? LIMIT 1`,
				run.ProjectID, candidate.ID, assertionKey, assertion.ID).Scan(&otherID)
			if err == nil {
				return projection, fmt.Errorf("assertion %s duplicates semantic assertion %s under a different id", assertion.ID, otherID)
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return projection, err
			}
			projection.Assertions = append(projection.Assertions, newRecord)
		}

		participating := []string{assertion.SubjectEntityID, assertion.ObjectEntityID}
		for _, qualifier := range assertion.Qualifiers {
			if qualifier.EntityID != "" {
				participating = append(participating, qualifier.EntityID)
			}
		}
		references := append([]core.KnowledgeEvidenceRef(nil), assertion.Evidence...)
		sort.Slice(references, func(i, j int) bool { return evidenceReferenceKey(references[i]) < evidenceReferenceKey(references[j]) })
		for _, reference := range references {
			var record store.KnowledgeAssertionEvidenceRecord
			switch reference.Kind {
			case core.KnowledgeEvidenceText:
				ownerDocuments := documentsByBlob[reference.BlobHash]
				var ownerErr error
				if len(ownerDocuments) == 1 && ownerDocuments[0].SourceKind == "pinned" {
					ownerErr = service.verifyPinnedTextEvidenceOwner(ctx, run.ProjectID, ownerDocuments, reference)
				} else {
					ownerErr = service.verifyRunTextEvidenceOwner(ctx, run.ID, reference)
				}
				if ownerErr != nil {
					return projection, fmt.Errorf("assertion %s: %w", assertion.ID, ownerErr)
				}
				mapped, err := service.mapTextEvidence(reference, ownerDocuments)
				if err != nil {
					return projection, fmt.Errorf("assertion %s: %w", assertion.ID, err)
				}
				start, end := mapped.StartByte, mapped.EndByte
				record = store.KnowledgeAssertionEvidenceRecord{
					AssertionID: assertion.ID, EvidenceKind: "text_span", BlobHash: reference.BlobHash,
					ChunkID: mapped.ChunkID, ClaimID: reference.ClaimID, SourceID: reference.SourceID,
					StartByte: &start, EndByte: &end, Locator: json.RawMessage(`{}`),
					EvidenceSHA256: reference.SpanHash,
				}
				for _, entityID := range participating {
					if entityID != "" {
						textByEntity[entityID] = append(textByEntity[entityID], mapped)
					}
				}
			case core.KnowledgeEvidenceEngineering:
				if err := service.verifyEngineeringEvidence(reference, engineeringArtifacts, engineeringReadback); err != nil {
					return projection, fmt.Errorf("assertion %s: %w", assertion.ID, err)
				}
				locator := map[string]any{"value_hash": reference.ValueHash}
				if reference.JSONPointer != "" {
					locator["json_pointer"] = reference.JSONPointer
				} else {
					locator["csv_row"] = reference.CSVRow
				}
				locatorJSON, err := json.Marshal(locator)
				if err != nil {
					return projection, err
				}
				record = store.KnowledgeAssertionEvidenceRecord{
					AssertionID: assertion.ID, EvidenceKind: "artifact_value", BlobHash: reference.ArtifactHash,
					Locator: locatorJSON, EvidenceSHA256: reference.ValueHash,
				}
				for _, entityID := range participating {
					if entityID != "" {
						artifactByEntity[entityID] = true
					}
				}
			default:
				return projection, fmt.Errorf("unsupported evidence kind %q", reference.Kind)
			}
			already, err := service.assertionEvidenceExists(ctx, run.ProjectID, candidate.ID, record)
			if err != nil {
				return projection, err
			}
			if !already {
				projection.Evidence = append(projection.Evidence, record)
			}
		}
	}

	for _, entity := range entities {
		var mentionCount int
		if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT COUNT(*) FROM knowledge_mentions WHERE project_id=? AND generation_id=? AND entity_id=?`,
			run.ProjectID, candidate.ID, entity.ID).Scan(&mentionCount); err != nil {
			return projection, err
		}
		candidates := textByEntity[entity.ID]
		sort.Slice(candidates, func(i, j int) bool {
			left := fmt.Sprintf("%s\x00%012d\x00%012d\x00%s", candidates[i].ChunkID, candidates[i].StartByte, candidates[i].EndByte, candidates[i].Reference.SpanHash)
			right := fmt.Sprintf("%s\x00%012d\x00%012d\x00%s", candidates[j].ChunkID, candidates[j].StartByte, candidates[j].EndByte, candidates[j].Reference.SpanHash)
			return left < right
		})
		if len(candidates) != 0 {
			selected := candidates[0]
			var duplicate int
			if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT COUNT(*) FROM knowledge_mentions
WHERE project_id=? AND generation_id=? AND entity_id=? AND chunk_id=? AND start_byte=? AND end_byte=?`,
				run.ProjectID, candidate.ID, entity.ID, selected.ChunkID, selected.StartByte, selected.EndByte).Scan(&duplicate); err != nil {
				return projection, err
			}
			if duplicate == 0 {
				material := strings.Join([]string{entity.ID, selected.ChunkID, strconv.Itoa(selected.StartByte), strconv.Itoa(selected.EndByte), selected.Reference.SpanHash}, "\n")
				sum := sha256.Sum256([]byte(material))
				projection.Mentions = append(projection.Mentions, store.KnowledgeMentionRecord{
					ID: "kmen_" + hex.EncodeToString(sum[:16]), EntityID: entity.ID,
					ChunkID: selected.ChunkID, StartByte: selected.StartByte, EndByte: selected.EndByte,
					ExcerptSHA256: selected.Reference.SpanHash,
				})
			}
			continue
		}
		if mentionCount == 0 && !artifactByEntity[entity.ID] {
			return projection, fmt.Errorf("entity %s has neither text provenance nor an artifact-backed assertion", entity.ID)
		}
	}
	return projection, nil
}

// normalizeRunPatch applies the deliberately narrow automatic identity policy
// to a successful research patch. Only an exact identifier or a unique,
// byte-exact existing name/alias may merge without curation. Ambiguous matches,
// class changes, and every uncurated alias proposal fail closed.
func (service *Service) normalizeRunPatch(
	ctx context.Context,
	projectID, generationID string,
	patch core.KnowledgePatch,
) (core.KnowledgePatch, error) {
	if err := patch.ValidateStructure(); err != nil {
		return core.KnowledgePatch{}, err
	}
	existing, err := service.loadIdentityPrompts(ctx, projectID, generationID)
	if err != nil {
		return core.KnowledgePatch{}, err
	}
	byID := make(map[string]pinnedIdentityPrompt, len(existing))
	owners := map[string]map[string]bool{}
	for _, value := range existing {
		byID[value.ID] = value
		for _, name := range append([]string{value.CanonicalName}, value.Aliases...) {
			if owners[name] == nil {
				owners[name] = map[string]bool{}
			}
			owners[name][value.ID] = true
		}
	}

	remap := make(map[string]string, len(patch.Entities))
	canonicalEntities := make(map[string]core.KnowledgeEntity, len(patch.Entities))
	for _, incoming := range patch.Entities {
		if len(incoming.Aliases) != 0 {
			return core.KnowledgePatch{}, fmt.Errorf("entity %s proposes aliases; user curation is required", incoming.ID)
		}
		if current, ok := byID[incoming.ID]; ok {
			if current.ClassKey != incoming.Type || current.CanonicalName != incoming.CanonicalName {
				return core.KnowledgePatch{}, fmt.Errorf("exact entity id %s conflicts with active identity", incoming.ID)
			}
			remap[incoming.ID] = current.ID
			canonicalEntities[current.ID] = promptEntity(current)
			continue
		}

		matches := map[string]bool{}
		for owner := range owners[incoming.CanonicalName] {
			matches[owner] = true
		}
		if len(matches) > 1 {
			return core.KnowledgePatch{}, fmt.Errorf("entity %s has ambiguous exact alias matches; user approval is required", incoming.ID)
		}
		if len(matches) == 1 {
			var existingID string
			for owner := range matches {
				existingID = owner
			}
			current := byID[existingID]
			if current.ClassKey != incoming.Type {
				return core.KnowledgePatch{}, fmt.Errorf("entity %s exact alias match has class %s, not %s", incoming.ID, current.ClassKey, incoming.Type)
			}
			remap[incoming.ID] = existingID
			canonicalEntities[existingID] = promptEntity(current)
			continue
		}

		remap[incoming.ID] = incoming.ID
		canonicalEntities[incoming.ID] = incoming
	}
	return service.canonicalizeRemappedKnowledgePatch(ctx, projectID, generationID, patch, remap, canonicalEntities)
}

func (service *Service) recordAppliedRunPatch(
	ctx context.Context,
	run core.Run,
	candidate store.KnowledgeGeneration,
	reportArtifact store.Artifact,
	patchBlobHash string,
) error {
	batchID, err := id.New("kext")
	if err != nil {
		return err
	}
	batch, err := service.DB.CreateKnowledgeExtractionBatch(ctx, store.KnowledgeExtractionBatch{
		ProjectID: run.ProjectID, GenerationID: candidate.ID, ID: batchID,
		RunID: run.ID, ArtifactID: reportArtifact.ID, SourceKind: "report",
		ExtractorContractSHA256: RunKnowledgeExtractorContractSHA256(), InputSHA256: reportArtifact.BlobHash,
	})
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := service.DB.SQL().ExecContext(ctx, `
UPDATE knowledge_extraction_batches
SET status='applied',output_sha256=?,patch_blob_hash=?,updated_at=?,completed_at=?
WHERE project_id=? AND generation_id=? AND id=? AND status='queued'`,
		patchBlobHash, patchBlobHash, now, now, run.ProjectID, candidate.ID, batch.ID)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("knowledge extraction batch application lost its state transition")
		}
		return err
	}
	return nil
}

func (service *Service) runEngineeringArtifacts(ctx context.Context, runID string) (map[string]struct{}, error) {
	results, err := service.DB.ListRunEngineeringResults(ctx, runID)
	if err != nil {
		return nil, err
	}
	artifacts := map[string]struct{}{}
	for _, result := range results {
		for _, artifact := range result.Artifacts {
			artifacts[artifact.BlobHash] = struct{}{}
		}
	}
	return artifacts, nil
}

func (service *Service) verifyRunTextEvidenceOwner(ctx context.Context, runID string, reference core.KnowledgeEvidenceRef) error {
	var count int
	if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT COUNT(*) FROM evidence WHERE run_id=? AND blob_hash=? AND adopted=1`,
		runID, reference.BlobHash).Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		return errors.New("text evidence CAS object is not adopted by this run")
	}
	return nil
}

func (service *Service) mapTextEvidence(reference core.KnowledgeEvidenceRef, documents []adoptedRunDocument) (mappedTextEvidence, error) {
	if len(documents) != 1 {
		return mappedTextEvidence{}, fmt.Errorf("text evidence blob %s resolves to %d indexed run documents", reference.BlobHash, len(documents))
	}
	raw, err := service.CAS.ReadVerified(reference.BlobHash)
	if err != nil {
		return mappedTextEvidence{}, err
	}
	if reference.ByteStart < 0 || reference.ByteEnd <= reference.ByteStart || reference.ByteEnd > int64(len(raw)) {
		return mappedTextEvidence{}, errors.New("text evidence has an invalid CAS byte span")
	}
	span := raw[int(reference.ByteStart):int(reference.ByteEnd)]
	if !utf8.Valid(span) || hashBytes(span) != reference.SpanHash {
		return mappedTextEvidence{}, errors.New("text evidence span hash does not match CAS")
	}
	normalized, boundaries, err := normalizedDocumentWithBoundaries(raw)
	if err != nil {
		return mappedTextEvidence{}, err
	}
	normalizedStart, startOK := boundaries[int(reference.ByteStart)]
	normalizedEnd, endOK := boundaries[int(reference.ByteEnd)]
	if !startOK || !endOK || normalizedEnd <= normalizedStart || normalizedEnd > len(normalized) {
		return mappedTextEvidence{}, errors.New("text evidence span cannot be mapped through deterministic normalization")
	}
	if hashBytes([]byte(normalized[normalizedStart:normalizedEnd])) != reference.SpanHash {
		return mappedTextEvidence{}, errors.New("text evidence content changes under deterministic chunk normalization")
	}
	windows := deterministicChunkWindows(normalized)
	storedByOrdinal := make(map[int]adoptedRunChunk, len(documents[0].Chunks))
	for _, chunk := range documents[0].Chunks {
		storedByOrdinal[chunk.Ordinal] = chunk
	}
	for _, window := range windows {
		if normalizedStart < window.StartByte || normalizedEnd > window.EndByte {
			continue
		}
		stored, exists := storedByOrdinal[window.Ordinal]
		if !exists || stored.Text != window.Text || stored.TextHash != hashBytes([]byte(window.Text)) {
			return mappedTextEvidence{}, fmt.Errorf("indexed chunk ordinal %d differs from deterministic CAS chunking", window.Ordinal)
		}
		start := normalizedStart - window.StartByte
		end := normalizedEnd - window.StartByte
		if start < 0 || end > len(stored.Text) || hashBytes([]byte(stored.Text[start:end])) != reference.SpanHash {
			return mappedTextEvidence{}, errors.New("mapped chunk-relative evidence readback failed")
		}
		return mappedTextEvidence{Reference: reference, ChunkID: stored.ID, StartByte: start, EndByte: end}, nil
	}
	return mappedTextEvidence{}, errors.New("text evidence span crosses every deterministic chunk boundary")
}

func normalizedDocumentWithBoundaries(raw []byte) (string, map[int]int, error) {
	if !utf8.Valid(raw) {
		return "", nil, errors.New("text evidence CAS object is not valid UTF-8")
	}
	source := string(raw)
	left := strings.TrimLeftFunc(source, unicode.IsSpace)
	rawStart := len(source) - len(left)
	trimmed := strings.TrimRightFunc(left, unicode.IsSpace)
	rawEnd := rawStart + len(trimmed)
	boundaries := map[int]int{rawStart: 0}
	var output strings.Builder
	for offset := rawStart; offset < rawEnd; {
		if raw[offset] == '\r' {
			if offset+1 < rawEnd && raw[offset+1] == '\n' {
				output.WriteByte('\n')
				offset += 2
			} else {
				output.WriteByte('\n')
				offset++
			}
			boundaries[offset] = output.Len()
			continue
		}
		_, size := utf8.DecodeRune(raw[offset:rawEnd])
		if size == 0 || size == 1 && raw[offset] >= utf8.RuneSelf {
			return "", nil, errors.New("text evidence contains invalid UTF-8")
		}
		output.Write(raw[offset : offset+size])
		offset += size
		boundaries[offset] = output.Len()
	}
	return output.String(), boundaries, nil
}

func deterministicChunkWindows(normalized string) []derivedChunkWindow {
	runes := []rune(normalized)
	if len(runes) == 0 {
		return nil
	}
	byteOffsets := make([]int, len(runes)+1)
	byteOffset := 0
	for index, value := range runes {
		byteOffsets[index] = byteOffset
		byteOffset += utf8.RuneLen(value)
	}
	byteOffsets[len(runes)] = byteOffset
	const size = 4000
	const step = 3600
	var result []derivedChunkWindow
	for start, ordinal := 0, 0; start < len(runes); start, ordinal = start+step, ordinal+1 {
		end := min(start+size, len(runes))
		segmentStart := byteOffsets[start]
		segment := normalized[segmentStart:byteOffsets[end]]
		leftTrimmed := strings.TrimLeftFunc(segment, unicode.IsSpace)
		trimStart := segmentStart + len(segment) - len(leftTrimmed)
		text := strings.TrimRightFunc(leftTrimmed, unicode.IsSpace)
		if text != "" {
			result = append(result, derivedChunkWindow{
				Ordinal: ordinal, StartByte: trimStart, EndByte: trimStart + len(text), Text: text,
			})
		}
		if end == len(runes) {
			break
		}
	}
	return result
}

func canonicalKnowledgeQualifiers(qualifiers []core.KnowledgeQualifier) (json.RawMessage, error) {
	object := make(map[string]any, len(qualifiers))
	for _, qualifier := range qualifiers {
		if _, duplicate := object[qualifier.Predicate]; duplicate {
			return nil, fmt.Errorf("duplicate qualifier predicate %q", qualifier.Predicate)
		}
		if qualifier.EntityID != "" {
			object[qualifier.Predicate] = map[string]any{"entity_id": qualifier.EntityID}
		} else if qualifier.Literal != nil {
			object[qualifier.Predicate] = map[string]any{"literal": qualifier.Literal}
		} else {
			return nil, fmt.Errorf("qualifier %q has no value", qualifier.Predicate)
		}
	}
	return json.Marshal(object)
}

func canonicalKnowledgeLiteral(literal *core.KnowledgeTypedLiteral) (json.RawMessage, error) {
	if literal == nil {
		return nil, nil
	}
	return json.Marshal(literal)
}

func knowledgeAssertionKey(assertion core.KnowledgeAssertion, qualifiers, literal json.RawMessage) (string, error) {
	from, to := "", ""
	if assertion.ValidTime != nil {
		var err error
		if from, to, err = core.CanonicalKnowledgeInterval(assertion.ValidTime.Start, assertion.ValidTime.End); err != nil {
			return "", err
		}
	}
	return hashBytes([]byte(strings.Join([]string{
		assertion.SubjectEntityID, assertion.Predicate, assertion.ObjectEntityID,
		string(literal), string(qualifiers), from, to,
	}, "\x00"))), nil
}

func (service *Service) existingAssertion(ctx context.Context, projectID, generationID, assertionID string) (store.KnowledgeAssertionRecord, bool, error) {
	var record store.KnowledgeAssertionRecord
	var object sql.NullString
	var literal, qualifiers, validFrom, validTo string
	err := service.DB.SQL().QueryRowContext(ctx, `
SELECT id,subject_entity_id,predicate_key,object_entity_id,literal_json,qualifiers_json,polarity,
       COALESCE(valid_from,''),COALESCE(valid_to,''),status,confidence,assertion_key
FROM knowledge_assertions WHERE project_id=? AND generation_id=? AND id=?`,
		projectID, generationID, assertionID).Scan(
		&record.ID, &record.SubjectEntityID, &record.PredicateKey, &object, &literal, &qualifiers,
		&record.Polarity, &validFrom, &validTo, &record.Status, &record.Confidence, &record.AssertionKey,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return record, false, nil
	}
	if err != nil {
		return record, false, err
	}
	if object.Valid {
		record.ObjectEntityID = object.String
	}
	if literal != "" {
		record.Literal = json.RawMessage(literal)
	}
	record.Qualifiers = json.RawMessage(qualifiers)
	record.ValidFrom, err = core.ParseKnowledgeTimeBoundary(validFrom)
	if err != nil {
		return record, false, err
	}
	record.ValidTo, err = core.ParseKnowledgeTimeBoundary(validTo)
	if err != nil {
		return record, false, err
	}
	return record, true, nil
}

func sameKnowledgeAssertion(left, right store.KnowledgeAssertionRecord) bool {
	equalTime := func(left, right *time.Time) bool {
		if left == nil || right == nil {
			return left == nil && right == nil
		}
		return left.Equal(*right)
	}
	return left.ID == right.ID && left.SubjectEntityID == right.SubjectEntityID &&
		left.PredicateKey == right.PredicateKey && left.ObjectEntityID == right.ObjectEntityID &&
		bytes.Equal(left.Literal, right.Literal) && bytes.Equal(left.Qualifiers, right.Qualifiers) &&
		left.Polarity == right.Polarity && equalTime(left.ValidFrom, right.ValidFrom) &&
		equalTime(left.ValidTo, right.ValidTo) && left.Status == right.Status &&
		left.Confidence == right.Confidence
}

func (service *Service) assertionEvidenceExists(
	ctx context.Context,
	projectID, generationID string,
	evidence store.KnowledgeAssertionEvidenceRecord,
) (bool, error) {
	var kind, blobHash, chunkID, claimID, sourceID, locator string
	var start, end sql.NullInt64
	err := service.DB.SQL().QueryRowContext(ctx, `
SELECT evidence_kind,blob_hash,COALESCE(chunk_id,''),claim_id,source_id,start_byte,end_byte,locator_json
FROM knowledge_assertion_evidence
WHERE project_id=? AND generation_id=? AND assertion_id=? AND evidence_kind=? AND blob_hash=? AND evidence_sha256=?`,
		projectID, generationID, evidence.AssertionID, evidence.EvidenceKind,
		evidence.BlobHash, evidence.EvidenceSHA256).Scan(
		&kind, &blobHash, &chunkID, &claimID, &sourceID, &start, &end, &locator,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	expectedStart, expectedEnd := int64(-1), int64(-1)
	if evidence.StartByte != nil {
		expectedStart = int64(*evidence.StartByte)
	}
	if evidence.EndByte != nil {
		expectedEnd = int64(*evidence.EndByte)
	}
	storedStart, storedEnd := int64(-1), int64(-1)
	if start.Valid {
		storedStart = start.Int64
	}
	if end.Valid {
		storedEnd = end.Int64
	}
	if kind != evidence.EvidenceKind || blobHash != evidence.BlobHash || chunkID != evidence.ChunkID ||
		claimID != evidence.ClaimID || sourceID != evidence.SourceID ||
		storedStart != expectedStart || storedEnd != expectedEnd || locator != string(evidence.Locator) {
		return false, errors.New("evidence hash collides with a different evidence locator")
	}
	return true, nil
}

func evidenceReferenceKey(reference core.KnowledgeEvidenceRef) string {
	return strings.Join([]string{
		reference.Kind, reference.BlobHash, reference.ArtifactHash, reference.SourceID,
		reference.ClaimID, fmt.Sprintf("%020d", reference.ByteStart), fmt.Sprintf("%020d", reference.ByteEnd),
		reference.JSONPointer, fmt.Sprintf("%020d", reference.CSVRow), reference.SpanHash, reference.ValueHash,
	}, "\x00")
}

func (service *Service) verifyEngineeringEvidence(
	reference core.KnowledgeEvidenceRef,
	artifacts map[string]struct{},
	readback map[string][]byte,
) error {
	_, exists := artifacts[reference.ArtifactHash]
	if !exists {
		return errors.New("engineering evidence is not a successful artifact of this run")
	}
	data, exists := readback[reference.ArtifactHash]
	if !exists {
		var err error
		data, err = service.CAS.ReadVerified(reference.ArtifactHash)
		if err != nil {
			return fmt.Errorf("read engineering evidence CAS object: %w", err)
		}
		readback[reference.ArtifactHash] = data
	}
	var value any
	var err error
	if reference.JSONPointer != "" {
		value, err = knowledgeJSONPointerValue(data, reference.JSONPointer)
	} else {
		value, err = knowledgeCSVRowValue(data, reference.CSVRow)
	}
	if err != nil {
		return err
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if hashBytes(canonical) != reference.ValueHash {
		return errors.New("engineering evidence value hash does not match CAS readback")
	}
	return nil
}

func knowledgeJSONPointerValue(data []byte, pointer string) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("decode JSON engineering artifact: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("JSON engineering artifact contains multiple values")
		}
		return nil, err
	}
	for _, encodedToken := range strings.Split(strings.TrimPrefix(pointer, "/"), "/") {
		token, err := decodeKnowledgeJSONPointerToken(encodedToken)
		if err != nil {
			return nil, err
		}
		switch current := value.(type) {
		case map[string]any:
			var exists bool
			value, exists = current[token]
			if !exists {
				return nil, fmt.Errorf("JSON pointer member %q does not exist", token)
			}
		case []any:
			if token == "" || len(token) > 1 && token[0] == '0' {
				return nil, fmt.Errorf("JSON pointer array index %q is invalid", token)
			}
			index, err := strconv.Atoi(token)
			if err != nil || index < 0 || index >= len(current) {
				return nil, fmt.Errorf("JSON pointer array index %q is outside the artifact", token)
			}
			value = current[index]
		default:
			return nil, fmt.Errorf("JSON pointer cannot traverse %q", token)
		}
	}
	return value, nil
}

func decodeKnowledgeJSONPointerToken(token string) (string, error) {
	var decoded strings.Builder
	for index := 0; index < len(token); index++ {
		if token[index] != '~' {
			decoded.WriteByte(token[index])
			continue
		}
		if index+1 >= len(token) {
			return "", errors.New("JSON pointer contains an incomplete escape")
		}
		index++
		switch token[index] {
		case '0':
			decoded.WriteByte('~')
		case '1':
			decoded.WriteByte('/')
		default:
			return "", errors.New("JSON pointer contains an invalid escape")
		}
	}
	return decoded.String(), nil
}

func knowledgeCSVRowValue(data []byte, target int64) ([]string, error) {
	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1
	for row := int64(1); ; row++ {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("CSV row %d does not exist", target)
		}
		if err != nil {
			return nil, fmt.Errorf("parse CSV row %d: %w", row, err)
		}
		if row == target {
			return record, nil
		}
	}
}

func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
