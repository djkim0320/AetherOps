package knowledge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/rag"
	"github.com/djkim0320/AetherOps/internal/store"
)

func TestKnowledgeEvidenceReadbackIsChunkRelativeAndProjectScoped(t *testing.T) {
	ctx := context.Background()
	database, objects := openKnowledgeServiceTestStorage(t)
	project, err := database.CreateProject(ctx, "evidence owner")
	if err != nil {
		t.Fatal(err)
	}
	otherProject, err := database.CreateProject(ctx, "other project")
	if err != nil {
		t.Fatal(err)
	}

	// The CAS document deliberately differs from the extracted chunk. Evidence
	// byte offsets are defined against the immutable chunk text, while the CAS
	// object is still independently verified as the source object.
	const documentBytes = "source document wrapper whose extracted chunk is stored separately"
	const chunkText = "앞 SU2 uses Gmsh 뒤"
	const excerpt = "SU2 uses Gmsh"
	receipt, err := objects.PutBytes([]byte(documentBytes))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, receipt, "text/plain; charset=utf-8"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	document, err := database.IndexDocument(ctx, store.Document{
		ProjectID: project.ID, Title: "solver evidence", BlobHash: receipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
		Pinned: true,
	}, []rag.Chunk{{Ordinal: 0, Text: chunkText}}, [][]float32{vector})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SetDocumentGraphAdopt(ctx, project.ID, document.ID, true); err != nil {
		t.Fatal(err)
	}
	var chunkID, chunkHash string
	if err := database.SQL().QueryRowContext(ctx, "SELECT id,text_hash FROM chunks WHERE document_id=?", document.ID).Scan(&chunkID, &chunkHash); err != nil {
		t.Fatal(err)
	}

	generation, err := database.CreateKnowledgeGeneration(ctx, project.ID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(chunkText, excerpt)
	end := start + len(excerpt)
	su2Start := strings.Index(chunkText, "SU2")
	gmshStart := strings.Index(chunkText, "Gmsh")
	evidenceHash := knowledgeTestSHA(excerpt)
	validFrom := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	validTo := time.Date(2027, time.January, 1, 0, 0, 0, 0, time.UTC)
	projection := store.KnowledgeProjection{
		Sources: []store.KnowledgeSourceRecord{{
			ChunkID: chunkID, BlobHash: receipt.Hash, SourceKind: "pinned",
			SourceLocator: json.RawMessage(`{"document":"solver evidence"}`), TextHash: chunkHash,
		}},
		Entities: []store.KnowledgeEntityRecord{
			{ID: "ent_su2", ClassKey: "software", CanonicalName: "SU2", NormalizedName: "su2"},
			{ID: "ent_gmsh", ClassKey: "software", CanonicalName: "Gmsh", NormalizedName: "gmsh"},
		},
		Mentions: []store.KnowledgeMentionRecord{
			{ID: "men_su2", EntityID: "ent_su2", ChunkID: chunkID, StartByte: su2Start, EndByte: su2Start + len("SU2"), ExcerptSHA256: knowledgeTestSHA("SU2")},
			{ID: "men_gmsh", EntityID: "ent_gmsh", ChunkID: chunkID, StartByte: gmshStart, EndByte: gmshStart + len("Gmsh"), ExcerptSHA256: knowledgeTestSHA("Gmsh")},
		},
		Assertions: []store.KnowledgeAssertionRecord{{
			ID: "ast_uses", SubjectEntityID: "ent_su2", PredicateKey: "uses", ObjectEntityID: "ent_gmsh",
			Qualifiers: json.RawMessage(`{}`), Polarity: "affirmed", Status: "disputed", Confidence: 1,
			ValidFrom: &validFrom, ValidTo: &validTo,
			AssertionKey: knowledgeTestSHA("ent_su2|uses|ent_gmsh"),
		}},
		Evidence: []store.KnowledgeAssertionEvidenceRecord{{
			AssertionID: "ast_uses", EvidenceKind: "text_span", BlobHash: receipt.Hash,
			ChunkID: chunkID, StartByte: &start, EndByte: &end, Locator: json.RawMessage(`{}`),
			EvidenceSHA256: evidenceHash,
		}},
	}
	if err := database.AppendKnowledgeProjection(ctx, project.ID, generation.ID, projection); err != nil {
		t.Fatal(err)
	}
	appendKnowledgeServiceTestSnapshot(t, database, objects, project.ID, generation.ID, store.CoreOntologyID)
	if _, err := database.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID, store.KnowledgeBuilding, store.KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID, store.KnowledgeValidating, store.KnowledgeReady, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ActivateKnowledgeGeneration(ctx, project.ID, generation.ID); err != nil {
		t.Fatal(err)
	}

	service := &Service{DB: database, CAS: objects}
	entityValue, err := service.Entity(ctx, project.ID, "ent_su2")
	if err != nil {
		t.Fatal(err)
	}
	if entity := entityValue.(EntityView); entity.Pinned {
		t.Fatalf("entity was unexpectedly pinned without a curation event: %+v", entity)
	}
	subgraphValue, err := service.Subgraph(ctx, project.ID, "instance", "", "", "ent_su2", 10, 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, node := range subgraphValue.(Subgraph).Nodes {
		if node["id"] == "ent_su2" && node["pinned"] != false {
			t.Fatalf("subgraph reported an unexpected pinned state: %#v", node)
		}
		if node["id"] == "ent_su2" && node["conflict"] != true {
			t.Fatalf("subgraph omitted connected conflict state: %#v", node)
		}
	}
	edges := subgraphValue.(Subgraph).Edges
	if len(edges) != 1 || edges[0]["status"] != "disputed" || edges[0]["conflict"] != true ||
		edges[0]["valid_from"] != core.CanonicalKnowledgeTime(validFrom) ||
		edges[0]["valid_to"] != core.CanonicalKnowledgeTime(validTo) {
		t.Fatalf("subgraph omitted temporal/conflict edge metadata: %#v", edges)
	}
	value, err := service.Evidence(ctx, project.ID, evidenceHash)
	if err != nil {
		t.Fatal(err)
	}
	items := value.(map[string]any)["evidence"].([]EvidenceView)
	if len(items) != 1 || items[0].Excerpt != excerpt || items[0].StartByte == nil ||
		*items[0].StartByte != start || items[0].EndByte == nil || *items[0].EndByte != end {
		t.Fatalf("unexpected exact evidence readback: %+v", items)
	}
	assertionValue, err := service.Assertion(ctx, project.ID, "ast_uses")
	if err != nil {
		t.Fatal(err)
	}
	assertion := assertionValue.(AssertionView)
	if len(assertion.Evidence) != 1 || assertion.Evidence[0].Excerpt != excerpt {
		t.Fatalf("knowledge_get assertion did not perform evidence readback: %+v", assertion.Evidence)
	}
	statusValue, err := service.Status(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if status := statusValue.(Status); status.ActiveOntologyVersionID != store.CoreOntologyID || status.EntityCount != 2 || status.AssertionCount != 1 {
		t.Fatalf("status omitted active ontology version: %+v", status)
	}

	for name, lookup := range map[string]func() (any, error){
		"entity":    func() (any, error) { return service.Entity(ctx, otherProject.ID, "ent_su2") },
		"assertion": func() (any, error) { return service.Assertion(ctx, otherProject.ID, "ast_uses") },
		"evidence":  func() (any, error) { return service.Evidence(ctx, otherProject.ID, evidenceHash) },
		"subgraph": func() (any, error) {
			return service.Subgraph(ctx, otherProject.ID, "instance", "", "", "ent_su2", 10, 10)
		},
	} {
		if leaked, err := lookup(); !errors.Is(err, store.ErrNotFound) || leaked != nil {
			t.Fatalf("%s cross-project lookup leaked data=%#v err=%v", name, leaked, err)
		}
	}
	if _, err := service.Status(ctx, "project-does-not-exist"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing project exposed a storage error: %v", err)
	}

	// A post-validation chunk mutation must be detected before any excerpt is
	// returned, even if the requested span itself could still hash correctly.
	if _, err := database.SQL().ExecContext(ctx, "UPDATE chunks SET text=? WHERE id=?", chunkText+" altered", chunkID); err != nil {
		t.Fatal(err)
	}
	if leaked, err := service.Evidence(ctx, project.ID, evidenceHash); err == nil || leaked != nil || !strings.Contains(err.Error(), "chunk hash mismatch") {
		t.Fatalf("mutated evidence chunk was not rejected: data=%#v err=%v", leaked, err)
	}

	// Appending a curation event and marking the active head stale are one
	// transaction. No read may expose the old graph as if the edit were already
	// projected.
	if _, err := database.AppendKnowledgeCuration(ctx, project.ID, generation.ID,
		"pin_entity", "user", json.RawMessage(`{"entity_id":"ent_su2","pinned":true}`)); err != nil {
		t.Fatal(err)
	}
	head, err := database.ActiveKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != store.KnowledgeHeadStale {
		t.Fatalf("curation append left graph head %s instead of stale", head.Status)
	}
	if leaked, err := service.Entity(ctx, project.ID, "ent_su2"); err == nil || leaked != nil || !strings.Contains(err.Error(), "knowledge graph is not ready") {
		t.Fatalf("stale graph was exposed after curation: data=%#v err=%v", leaked, err)
	}
}

func openKnowledgeServiceTestStorage(t *testing.T) (*store.DB, *cas.Store) {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	database, err := store.Open(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	return database, objects
}

func appendKnowledgeServiceTestSnapshot(t *testing.T, database *store.DB, objects *cas.Store, projectID, generationID, ontologyID string) {
	t.Helper()
	ctx := context.Background()
	data, tripleCount, err := database.KnowledgeNQuads(ctx, projectID, generationID, ontologyID)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes(data)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, receipt, "application/n-quads"); err != nil {
		t.Fatal(err)
	}
	if err := database.AppendKnowledgeProjection(ctx, projectID, generationID, store.KnowledgeProjection{Snapshots: []store.KnowledgeRDFSnapshotRecord{{
		ID: "krdf_" + receipt.Hash[:24], Format: "n-quads", BlobHash: receipt.Hash,
		DatasetSHA256: receipt.Hash, TripleCount: tripleCount,
	}}}); err != nil {
		t.Fatal(err)
	}
}

func knowledgeTestSHA(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
