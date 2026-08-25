package knowledge

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"runtime"
	"sort"
	"strings"
	"sync"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
)

const schemaOnlyMaterializationContract = "aetherops-schema-only-knowledge-materialization-v1"

// SchemaSnapshotRecoveryResult reports deterministic local repairs only. No
// model request, browser action, or other external side effect is retried by
// this recovery path.
type SchemaSnapshotRecoveryResult struct {
	Projects     int      `json:"projects"`
	AlreadyReady int      `json:"already_ready"`
	Materialized int      `json:"materialized"`
	Failed       int      `json:"failed"`
	Failures     []string `json:"failures,omitempty"`
}

// CreateProject publishes the core ontology snapshot to CAS first and then
// commits project, default conversation, generation, snapshot receipt, and
// active head atomically in SQLite.
func (service *Service) CreateProject(ctx context.Context, name string) (core.Project, error) {
	if err := service.configured(); err != nil {
		return core.Project{}, err
	}
	if service.Sidecar == nil {
		return core.Project{}, errors.New("Oxigraph sidecar is required to create a project graph")
	}
	var ontologySHA256 string
	if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT canonical_sha256 FROM ontology_versions
WHERE id=? AND project_id IS NULL AND state='active'`, store.CoreOntologyID).Scan(&ontologySHA256); err != nil {
		return core.Project{}, err
	}
	snapshot, tripleCount, err := service.DB.KnowledgeNQuads(
		ctx, "schema-template", "schema-template", store.CoreOntologyID,
	)
	if err != nil {
		return core.Project{}, err
	}
	if tripleCount <= 0 {
		return core.Project{}, errors.New("core ontology produced an empty RDF snapshot")
	}
	receipt, err := service.CAS.PutBytes(snapshot)
	if err != nil {
		return core.Project{}, err
	}
	if _, err := service.CAS.ReadVerified(receipt.Hash); err != nil {
		return core.Project{}, err
	}
	if err := service.DB.RegisterBlob(ctx, receipt, "application/n-quads"); err != nil {
		return core.Project{}, err
	}
	project, err := service.DB.CreateProjectWithKnowledgeSnapshot(
		ctx, name, receipt, tripleCount, schemaOnlyContract(ontologySHA256),
	)
	if err != nil {
		return core.Project{}, err
	}
	head, err := service.DB.ActiveKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		return core.Project{}, err
	}
	if err := service.DB.VerifyKnowledgeSnapshot(ctx, project.ID, head.GenerationID, service.CAS); err != nil {
		_ = service.DB.MarkKnowledgeHeadFailedForGeneration(context.WithoutCancel(ctx), project.ID, head.GenerationID, err)
		return core.Project{}, err
	}
	if err := service.Sidecar.LoadSnapshot(ctx, project.ID, head.GenerationID, snapshot, receipt.Hash, tripleCount); err != nil {
		_ = service.DB.MarkKnowledgeHeadFailedForGeneration(context.WithoutCancel(ctx), project.ID, head.GenerationID, err)
		return core.Project{}, fmt.Errorf("load new project ontology snapshot in Oxigraph: %w", err)
	}
	return project, nil
}

// InitializeProject repairs only the historical schema-only head shape that
// migration 6 and the old project creator emitted without an RDF receipt. A
// corrupt or non-empty generation is never replaced automatically.
func (service *Service) InitializeProject(ctx context.Context, projectID string) error {
	_, err := service.initializeProject(ctx, projectID)
	return err
}

func (service *Service) initializeProject(ctx context.Context, projectID string) (materialized bool, returnErr error) {
	if err := service.configured(); err != nil {
		return false, err
	}
	if service.Sidecar == nil {
		return false, errors.New("Oxigraph sidecar is required to initialize a project graph")
	}
	projectID = strings.TrimSpace(projectID)
	if projectID == "" {
		return false, errors.New("knowledge project is required")
	}
	service.rebuildMu.Lock()
	if service.rebuilding == nil {
		service.rebuilding = map[string]bool{}
	}
	if service.rebuilding[projectID] {
		service.rebuildMu.Unlock()
		return false, errors.New("knowledge materialization is already running for this project")
	}
	service.rebuilding[projectID] = true
	service.rebuildMu.Unlock()
	defer func() {
		service.rebuildMu.Lock()
		delete(service.rebuilding, projectID)
		service.rebuildMu.Unlock()
	}()

	head, err := service.DB.ActiveKnowledgeGeneration(ctx, projectID)
	if err != nil {
		return false, err
	}
	if err := service.DB.AuditActiveKnowledgeIntervals(ctx, projectID); err != nil {
		return false, err
	}
	verifyErr := service.DB.VerifyKnowledgeSnapshot(ctx, projectID, head.GenerationID, service.CAS)
	if verifyErr == nil {
		if head.Status != store.KnowledgeHeadReady {
			if err := service.loadRunSnapshot(ctx, projectID, head.GenerationID); err != nil {
				return false, err
			}
			if _, err := service.DB.ActivateKnowledgeGeneration(ctx, projectID, head.GenerationID); err != nil {
				return false, err
			}
		}
		return false, nil
	}
	var snapshotRows int
	if err := service.DB.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM knowledge_rdf_snapshots WHERE project_id=? AND generation_id=?",
		projectID, head.GenerationID,
	).Scan(&snapshotRows); err != nil {
		return false, err
	}
	if snapshotRows != 0 || head.Generation.SourceCount != 0 || head.Generation.EntityCount != 0 || head.Generation.AssertionCount != 0 {
		_ = service.DB.MarkKnowledgeHeadFailedForGeneration(context.WithoutCancel(ctx), projectID, head.GenerationID, verifyErr)
		return false, fmt.Errorf("knowledge head is corrupt and cannot use schema-only recovery: %w", verifyErr)
	}

	ontology, err := service.DB.KnowledgeGenerationOntologyReceipt(ctx, projectID, head.GenerationID)
	if err != nil {
		return false, err
	}
	contract := schemaOnlyContract(ontology.CanonicalSHA256)
	candidate, err := service.recoverableSchemaCandidate(ctx, projectID, ontology.OntologyID, contract)
	if err != nil {
		return false, err
	}
	if candidate.ID == "" {
		candidate, err = service.DB.CreateKnowledgeGeneration(ctx, projectID, ontology.OntologyID, contract)
		if err != nil {
			return false, err
		}
	}
	candidateState := candidate.State
	defer func() {
		if returnErr == nil {
			return
		}
		failureCtx := context.WithoutCancel(ctx)
		if candidateState == store.KnowledgeBuilding || candidateState == store.KnowledgeValidating {
			_, markErr := service.DB.TransitionKnowledgeGeneration(
				failureCtx, projectID, candidate.ID, candidateState, store.KnowledgeFailed, returnErr.Error(),
			)
			if markErr != nil {
				returnErr = errors.Join(returnErr, fmt.Errorf("mark schema-only candidate failed: %w", markErr))
			}
		}
		if markErr := service.DB.MarkKnowledgeHeadFailedForGeneration(
			failureCtx, projectID, head.GenerationID, returnErr,
		); markErr != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("mark snapshotless head failed: %w", markErr))
		}
	}()

	var sources, entities, assertions int
	if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT
 (SELECT COUNT(*) FROM knowledge_sources WHERE project_id=? AND generation_id=?),
 (SELECT COUNT(*) FROM knowledge_entities WHERE project_id=? AND generation_id=?),
 (SELECT COUNT(*) FROM knowledge_assertions WHERE project_id=? AND generation_id=?)`,
		projectID, candidate.ID, projectID, candidate.ID, projectID, candidate.ID,
	).Scan(&sources, &entities, &assertions); err != nil {
		return false, err
	}
	if sources != 0 || entities != 0 || assertions != 0 {
		return false, errors.New("schema-only recovery candidate contains instance projection rows")
	}
	snapshot, tripleCount, err := service.DB.KnowledgeNQuads(ctx, projectID, candidate.ID, ontology.OntologyID)
	if err != nil {
		return false, err
	}
	if tripleCount <= 0 {
		return false, errors.New("active ontology produced an empty RDF snapshot")
	}
	receipt, err := service.CAS.PutBytes(snapshot)
	if err != nil {
		return false, err
	}
	if _, err := service.CAS.ReadVerified(receipt.Hash); err != nil {
		return false, err
	}
	if err := service.DB.RegisterBlob(ctx, receipt, "application/n-quads"); err != nil {
		return false, err
	}
	var existingHash, existingDataset string
	var existingTriples int
	snapshotErr := service.DB.SQL().QueryRowContext(ctx, `
SELECT blob_hash,dataset_sha256,triple_count FROM knowledge_rdf_snapshots
WHERE project_id=? AND generation_id=? AND format='n-quads'`, projectID, candidate.ID,
	).Scan(&existingHash, &existingDataset, &existingTriples)
	switch {
	case errors.Is(snapshotErr, sql.ErrNoRows) && candidateState == store.KnowledgeBuilding:
		if err := service.DB.AppendKnowledgeProjection(ctx, projectID, candidate.ID, store.KnowledgeProjection{
			Snapshots: []store.KnowledgeRDFSnapshotRecord{{
				ID: "krdf_" + receipt.Hash[:32], Format: "n-quads", BlobHash: receipt.Hash,
				DatasetSHA256: receipt.Hash, TripleCount: tripleCount,
			}},
		}); err != nil {
			return false, err
		}
	case snapshotErr != nil:
		return false, fmt.Errorf("inspect schema-only recovery snapshot: %w", snapshotErr)
	case existingHash != receipt.Hash || existingDataset != receipt.Hash || existingTriples != tripleCount:
		return false, errors.New("schema-only recovery snapshot receipt does not match its deterministic projection")
	}
	if candidateState == store.KnowledgeBuilding {
		candidate, err = service.DB.TransitionKnowledgeGeneration(
			ctx, projectID, candidate.ID, store.KnowledgeBuilding, store.KnowledgeValidating, "",
		)
		if err != nil {
			return false, err
		}
		candidateState = candidate.State
	}
	if err := service.Sidecar.LoadSnapshot(ctx, projectID, candidate.ID, snapshot, receipt.Hash, tripleCount); err != nil {
		return false, fmt.Errorf("validate schema-only RDF snapshot in Oxigraph: %w", err)
	}
	if candidateState == store.KnowledgeValidating {
		candidate, err = service.DB.TransitionKnowledgeGeneration(
			ctx, projectID, candidate.ID, store.KnowledgeValidating, store.KnowledgeReady, "",
		)
		if err != nil {
			return false, err
		}
		candidateState = candidate.State
	}
	if candidateState != store.KnowledgeReady {
		return false, fmt.Errorf("schema-only recovery candidate is not ready: %s", candidateState)
	}
	if _, err := service.DB.ActivateKnowledgeGeneration(ctx, projectID, candidate.ID); err != nil {
		return false, err
	}
	if err := service.DB.VerifyKnowledgeSnapshot(ctx, projectID, candidate.ID, service.CAS); err != nil {
		return false, err
	}
	return true, nil
}

func (service *Service) recoverableSchemaCandidate(
	ctx context.Context, projectID, ontologyID, contract string,
) (store.KnowledgeGeneration, error) {
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT id FROM knowledge_generations
WHERE project_id=? AND ontology_id=? AND contract_sha256=? AND state IN('building','validating','ready')
ORDER BY created_at DESC,id DESC`, projectID, ontologyID, contract)
	if err != nil {
		return store.KnowledgeGeneration{}, err
	}
	defer rows.Close()
	var candidates []store.KnowledgeGeneration
	for rows.Next() {
		var generationID string
		if err := rows.Scan(&generationID); err != nil {
			return store.KnowledgeGeneration{}, err
		}
		candidate, err := service.DB.KnowledgeGeneration(ctx, projectID, generationID)
		if err != nil {
			return store.KnowledgeGeneration{}, err
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return store.KnowledgeGeneration{}, err
	}
	if len(candidates) == 0 {
		return store.KnowledgeGeneration{}, nil
	}
	selected := candidates[0]
	for _, extra := range candidates[1:] {
		if extra.State != store.KnowledgeBuilding && extra.State != store.KnowledgeValidating {
			continue
		}
		if _, err := service.DB.TransitionKnowledgeGeneration(
			ctx, projectID, extra.ID, extra.State, store.KnowledgeFailed,
			"superseded duplicate schema-only recovery candidate",
		); err != nil {
			return store.KnowledgeGeneration{}, err
		}
	}
	return selected, nil
}

// RecoverSchemaOnlyHeads upgrades every legacy active empty head before the
// dispatcher and scheduler are allowed to start. Independent projects use a
// small CPU-bound worker pool; SQLite and the stdio sidecar retain their own
// serialization guarantees.
func (service *Service) RecoverSchemaOnlyHeads(ctx context.Context) (SchemaSnapshotRecoveryResult, error) {
	projects, err := service.DB.ListProjects(ctx)
	if err != nil {
		return SchemaSnapshotRecoveryResult{}, err
	}
	result := SchemaSnapshotRecoveryResult{Projects: len(projects)}
	if len(projects) == 0 {
		return result, nil
	}
	workers := runtime.NumCPU()
	if workers < 1 {
		workers = 1
	}
	if workers > 4 {
		workers = 4
	}
	if workers > len(projects) {
		workers = len(projects)
	}
	type outcome struct {
		projectID    string
		materialized bool
		err          error
	}
	jobs := make(chan string)
	outcomes := make(chan outcome, len(projects))
	var group sync.WaitGroup
	for index := 0; index < workers; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for projectID := range jobs {
				materialized, err := service.initializeProject(ctx, projectID)
				outcomes <- outcome{projectID: projectID, materialized: materialized, err: err}
			}
		}()
	}
	for _, project := range projects {
		jobs <- project.ID
	}
	close(jobs)
	group.Wait()
	close(outcomes)
	var resultErr error
	for item := range outcomes {
		switch {
		case item.err != nil:
			result.Failed++
			message := item.projectID + ": " + item.err.Error()
			result.Failures = append(result.Failures, message)
			resultErr = errors.Join(resultErr, errors.New(message))
		case item.materialized:
			result.Materialized++
		default:
			result.AlreadyReady++
		}
	}
	sort.Strings(result.Failures)
	return result, resultErr
}

func schemaOnlyContract(ontologySHA256 string) string {
	sum := sha256.Sum256([]byte(schemaOnlyMaterializationContract + "\n" + strings.ToLower(ontologySHA256)))
	return hex.EncodeToString(sum[:])
}
