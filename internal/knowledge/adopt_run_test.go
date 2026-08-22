package knowledge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/rag"
	"github.com/djkim0320/Aether-claw/internal/store"
)

func TestMapTextEvidenceUsesDeterministicChunkRelativeByteSpan(t *testing.T) {
	objects, err := cas.Open(filepath.Join(t.TempDir(), "cas"))
	if err != nil {
		t.Fatal(err)
	}
	prefix := strings.Repeat("가", 3700) + "\r\n"
	needle := "SU2 공력 결과"
	raw := []byte("  " + prefix + needle + strings.Repeat("나", 500) + "  ")
	receipt, err := objects.PutBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(raw), needle)
	end := start + len(needle)
	reference := core.KnowledgeEvidenceRef{
		Kind: core.KnowledgeEvidenceText, SourceID: "source", ClaimID: "claim",
		BlobHash: receipt.Hash, ByteStart: int64(start), ByteEnd: int64(end),
		SpanHash: hashBytes([]byte(needle)),
	}
	normalized, _, err := normalizedDocumentWithBoundaries(raw)
	if err != nil {
		t.Fatal(err)
	}
	windows := deterministicChunkWindows(normalized)
	document := adoptedRunDocument{ID: "document", BlobHash: receipt.Hash}
	for _, window := range windows {
		document.Chunks = append(document.Chunks, adoptedRunChunk{
			ID: "chunk-" + string(rune('0'+window.Ordinal)), Ordinal: window.Ordinal,
			Text: window.Text, TextHash: hashBytes([]byte(window.Text)),
		})
	}
	service := &Service{CAS: objects}
	mapped, err := service.mapTextEvidence(reference, []adoptedRunDocument{document})
	if err != nil {
		t.Fatal(err)
	}
	var stored adoptedRunChunk
	for _, chunk := range document.Chunks {
		if chunk.ID == mapped.ChunkID {
			stored = chunk
		}
	}
	if got := stored.Text[mapped.StartByte:mapped.EndByte]; got != needle {
		t.Fatalf("mapped excerpt = %q, want %q", got, needle)
	}
	if hashBytes([]byte(stored.Text[mapped.StartByte:mapped.EndByte])) != reference.SpanHash {
		t.Fatal("mapped evidence did not preserve cryptographic readback")
	}
}

func TestRunKnowledgeMaterializationContractBindsOntologyAndPatch(t *testing.T) {
	ontology := strings.Repeat("a", 64)
	patch := strings.Repeat("b", 64)
	contract, err := RunKnowledgeMaterializationContractSHA256(ontology, patch)
	if err != nil {
		t.Fatal(err)
	}
	if contract == "" || contract == RunKnowledgeExtractorContractSHA256() {
		t.Fatalf("materialization and extractor contracts are not independently bound: %q", contract)
	}
	changed, err := RunKnowledgeMaterializationContractSHA256(ontology, strings.Repeat("c", 64))
	if err != nil {
		t.Fatal(err)
	}
	if changed == contract {
		t.Fatal("materialization contract ignored patch digest")
	}
	if _, err := RunKnowledgeMaterializationContractSHA256("not-a-digest", patch); err == nil {
		t.Fatal("invalid ontology digest was accepted")
	}
}

func TestNormalizeRunPatchMergesOnlyUniqueProjectScopedExactAlias(t *testing.T) {
	ctx := context.Background()
	database, objects := openKnowledgeServiceTestStorage(t)
	project, err := database.CreateProject(ctx, "run alias identity")
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := database.CreateKnowledgeGeneration(ctx, project.ID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.AppendKnowledgeProjection(ctx, project.ID, candidate.ID, store.KnowledgeProjection{
		Entities: []store.KnowledgeEntityRecord{{
			ID: "entity-existing", ClassKey: "software", CanonicalName: "Stanford University Unstructured",
			NormalizedName: normalizeKnowledgeName("Stanford University Unstructured"),
		}},
		Aliases: []store.KnowledgeAliasRecord{{
			EntityID: "entity-existing", Alias: "SU2", NormalizedAlias: normalizeKnowledgeName("SU2"), Language: "en",
		}},
	}); err != nil {
		t.Fatal(err)
	}

	service := &Service{DB: database, CAS: objects}
	patch := core.KnowledgePatch{
		SchemaVersion: core.KnowledgePatchSchemaV1, UnitRegistryVersion: core.CurrentUnitRegistryVersion,
		Entities: []core.KnowledgeEntity{
			{ID: "model-su2", Type: "software", CanonicalName: "SU2", Aliases: []core.KnowledgeAlias{}},
			{ID: "target", Type: "software", CanonicalName: "Gmsh", Aliases: []core.KnowledgeAlias{}},
		},
		Assertions: []core.KnowledgeAssertion{{
			ID: "model-assertion", SubjectEntityID: "model-su2", Predicate: "uses", ObjectEntityID: "target",
			Qualifiers: []core.KnowledgeQualifier{{Predicate: "configured_by", EntityID: "model-su2"}},
			Evidence: []core.KnowledgeEvidenceRef{{
				Kind: core.KnowledgeEvidenceEngineering, ArtifactHash: strings.Repeat("a", 64),
				CSVRow: 1, ValueHash: strings.Repeat("b", 64),
			}},
		}},
	}
	normalized, err := service.normalizeRunPatch(ctx, project.ID, candidate.ID, patch)
	if err != nil {
		t.Fatal(err)
	}
	if len(normalized.Entities) != 2 || len(normalized.Assertions) != 1 {
		t.Fatalf("normalized run patch shape = %+v", normalized)
	}
	assertion := normalized.Assertions[0]
	if assertion.SubjectEntityID != "entity-existing" || assertion.ObjectEntityID != "target" ||
		len(assertion.Qualifiers) != 1 || assertion.Qualifiers[0].EntityID != "entity-existing" {
		t.Fatalf("unique alias identity was not remapped through assertion values: %+v", assertion)
	}
	for _, entity := range normalized.Entities {
		if entity.ID == "model-su2" {
			t.Fatalf("provisional alias-matched entity survived normalization: %+v", normalized.Entities)
		}
	}

	otherProject, err := database.CreateProject(ctx, "foreign alias owner")
	if err != nil {
		t.Fatal(err)
	}
	foreignGeneration, err := database.CreateKnowledgeGeneration(ctx, otherProject.ID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.AppendKnowledgeProjection(ctx, otherProject.ID, foreignGeneration.ID, store.KnowledgeProjection{
		Entities: []store.KnowledgeEntityRecord{{ID: "foreign", ClassKey: "software", CanonicalName: "Foreign Solver", NormalizedName: normalizeKnowledgeName("Foreign Solver")}},
		Aliases:  []store.KnowledgeAliasRecord{{EntityID: "foreign", Alias: "Project Only", NormalizedAlias: normalizeKnowledgeName("Project Only")}},
	}); err != nil {
		t.Fatal(err)
	}
	isolatedPatch := core.KnowledgePatch{
		SchemaVersion: core.KnowledgePatchSchemaV1, UnitRegistryVersion: core.CurrentUnitRegistryVersion,
		Entities:   []core.KnowledgeEntity{{ID: "local", Type: "software", CanonicalName: "Project Only", Aliases: []core.KnowledgeAlias{}}},
		Assertions: []core.KnowledgeAssertion{},
	}
	isolationResult, err := service.normalizeRunPatch(ctx, project.ID, candidate.ID, isolatedPatch)
	if err != nil {
		t.Fatal(err)
	}
	if len(isolationResult.Entities) != 1 || isolationResult.Entities[0].ID != "local" {
		t.Fatalf("foreign-project alias changed local identity: %+v", isolationResult.Entities)
	}
}

func TestNormalizeRunPatchRejectsAmbiguousExactAlias(t *testing.T) {
	ctx := context.Background()
	database, objects := openKnowledgeServiceTestStorage(t)
	project, err := database.CreateProject(ctx, "ambiguous run alias")
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := database.CreateKnowledgeGeneration(ctx, project.ID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.AppendKnowledgeProjection(ctx, project.ID, candidate.ID, store.KnowledgeProjection{
		Entities: []store.KnowledgeEntityRecord{
			{ID: "left", ClassKey: "software", CanonicalName: "Left", NormalizedName: "left"},
			{ID: "right", ClassKey: "software", CanonicalName: "Right", NormalizedName: "right"},
		},
		Aliases: []store.KnowledgeAliasRecord{
			{EntityID: "left", Alias: "Shared", NormalizedAlias: "shared"},
			{EntityID: "right", Alias: "Shared", NormalizedAlias: "shared"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	patch := core.KnowledgePatch{
		SchemaVersion: core.KnowledgePatchSchemaV1, UnitRegistryVersion: core.CurrentUnitRegistryVersion,
		Entities:   []core.KnowledgeEntity{{ID: "incoming", Type: "software", CanonicalName: "Shared", Aliases: []core.KnowledgeAlias{}}},
		Assertions: []core.KnowledgeAssertion{},
	}
	service := &Service{DB: database, CAS: objects}
	if result, err := service.normalizeRunPatch(ctx, project.ID, candidate.ID, patch); err == nil || !strings.Contains(err.Error(), "ambiguous exact alias") {
		t.Fatalf("ambiguous run alias was accepted: result=%+v err=%v", result, err)
	}
}

func TestNormalizeRunPatchRejectsAliasesOnNewEntityWithoutCuration(t *testing.T) {
	ctx := context.Background()
	database, objects := openKnowledgeServiceTestStorage(t)
	project, err := database.CreateProject(ctx, "uncurated new aliases")
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := database.CreateKnowledgeGeneration(ctx, project.ID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	patch := core.KnowledgePatch{
		SchemaVersion: core.KnowledgePatchSchemaV1, UnitRegistryVersion: core.CurrentUnitRegistryVersion,
		Entities: []core.KnowledgeEntity{{
			ID: "cfd", Type: "software", CanonicalName: "Computational Fluid Dynamics",
			Aliases: []core.KnowledgeAlias{{Value: "CFD", Language: "en"}, {Value: "전산유체역학", Language: "ko"}},
		}},
		Assertions: []core.KnowledgeAssertion{},
	}
	service := &Service{DB: database, CAS: objects}
	if result, err := service.normalizeRunPatch(ctx, project.ID, candidate.ID, patch); err == nil || !strings.Contains(err.Error(), "user curation is required") {
		t.Fatalf("uncurated aliases on a new run entity were accepted: result=%+v err=%v", result, err)
	}
}

func TestNormalizeRunPatchDoesNotCaseFoldOrCollapseWhitespaceForAutomaticIdentity(t *testing.T) {
	ctx := context.Background()
	database, objects := openKnowledgeServiceTestStorage(t)
	project, err := database.CreateProject(ctx, "byte exact run identity")
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := database.CreateKnowledgeGeneration(ctx, project.ID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.AppendKnowledgeProjection(ctx, project.ID, candidate.ID, store.KnowledgeProjection{
		Entities: []store.KnowledgeEntityRecord{{
			ID: "entity-existing", ClassKey: "software", CanonicalName: "Stanford University Unstructured",
			NormalizedName: normalizeKnowledgeName("Stanford University Unstructured"),
		}},
		Aliases: []store.KnowledgeAliasRecord{{
			EntityID: "entity-existing", Alias: "SU2", NormalizedAlias: normalizeKnowledgeName("SU2"), Language: "en",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	service := &Service{DB: database, CAS: objects}
	for _, canonicalName := range []string{"su2", " SU2 "} {
		t.Run(canonicalName, func(t *testing.T) {
			patch := core.KnowledgePatch{
				SchemaVersion: core.KnowledgePatchSchemaV1, UnitRegistryVersion: core.CurrentUnitRegistryVersion,
				Entities: []core.KnowledgeEntity{{
					ID: "incoming", Type: "software", CanonicalName: canonicalName, Aliases: []core.KnowledgeAlias{},
				}},
				Assertions: []core.KnowledgeAssertion{},
			}
			normalized, err := service.normalizeRunPatch(ctx, project.ID, candidate.ID, patch)
			if err != nil {
				t.Fatal(err)
			}
			if len(normalized.Entities) != 1 || normalized.Entities[0].ID != "incoming" {
				t.Fatalf("non-exact name %q was automatically remapped: %+v", canonicalName, normalized.Entities)
			}
		})
	}
}

func TestMapTextEvidenceRejectsSpanChangedByNewlineNormalization(t *testing.T) {
	objects, err := cas.Open(filepath.Join(t.TempDir(), "cas"))
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte("first\r\nsecond")
	receipt, err := objects.PutBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	reference := core.KnowledgeEvidenceRef{
		Kind: core.KnowledgeEvidenceText, SourceID: "source", ClaimID: "claim",
		BlobHash: receipt.Hash, ByteStart: 0, ByteEnd: int64(len(raw)), SpanHash: hashBytes(raw),
	}
	normalized, _, err := normalizedDocumentWithBoundaries(raw)
	if err != nil {
		t.Fatal(err)
	}
	window := deterministicChunkWindows(normalized)[0]
	document := adoptedRunDocument{ID: "document", BlobHash: receipt.Hash, Chunks: []adoptedRunChunk{{
		ID: "chunk", Ordinal: 0, Text: window.Text, TextHash: hashBytes([]byte(window.Text)),
	}}}
	service := &Service{CAS: objects}
	if _, err := service.mapTextEvidence(reference, []adoptedRunDocument{document}); err == nil || !strings.Contains(err.Error(), "changes under deterministic chunk normalization") {
		t.Fatalf("newline-changing span was not rejected: %v", err)
	}
}

func TestAdoptRunBuildsAndLoadsVerifiedOxigraphGeneration(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is not available for the real Oxigraph sidecar test")
	}
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	sidecarEntry := filepath.Join(root, "tools", "knowledge-sidecar", "index.cjs")
	oxigraphModule := filepath.Join(root, "tools", "knowledge-sidecar", "node_modules", "oxigraph")
	if _, err := os.Stat(filepath.Join(oxigraphModule, "package.json")); err != nil {
		t.Skip("the pinned Oxigraph 0.5.9 package is not installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	objects, err := cas.Open(filepath.Join(t.TempDir(), "cas"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(ctx, filepath.Join(t.TempDir(), "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	project, err := db.CreateProject(ctx, "real Oxigraph adoption")
	if err != nil {
		t.Fatal(err)
	}
	session, err := db.DefaultConversationSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.MarkConversationSessionProvisioning(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	threadID, err := db.SetConversationSessionThreadIfEmpty(ctx, session.ID, "thread-adopt")
	if err != nil {
		t.Fatal(err)
	}
	run, err := db.CreateConversationRunConfigured(ctx, session.ID, "", "Does SU2 depend on itself?", threadID, core.RunConfiguration{})
	if err != nil {
		t.Fatal(err)
	}

	evidenceBytes := []byte("SU2 depends on SU2")
	evidenceReceipt, err := objects.PutBytes(evidenceBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, evidenceReceipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	spanSum := sha256.Sum256(evidenceBytes)
	spanHash := hex.EncodeToString(spanSum[:])
	report := core.ReportManifest{
		Title: "SU2 dependency", AnswerMarkdown: "SU2 dependency report",
		Citations: []core.Citation{}, EvidenceIDs: []string{}, ArtifactHashes: []string{}, Uncertainties: []string{},
		KnowledgePatch: core.KnowledgePatch{
			SchemaVersion: core.KnowledgePatchSchemaV1, UnitRegistryVersion: core.CurrentUnitRegistryVersion,
			Entities: []core.KnowledgeEntity{{ID: "su2", Type: "software", CanonicalName: "SU2", Aliases: []core.KnowledgeAlias{}}},
			Assertions: []core.KnowledgeAssertion{{
				ID: "su2_self_dependency", SubjectEntityID: "su2", Predicate: "depends_on", ObjectEntityID: "su2",
				Qualifiers: []core.KnowledgeQualifier{}, Evidence: []core.KnowledgeEvidenceRef{{
					Kind: core.KnowledgeEvidenceText, SourceID: "source-su2", ClaimID: "claim-su2",
					BlobHash: evidenceReceipt.Hash, ByteStart: 0, ByteEnd: int64(len(evidenceBytes)), SpanHash: spanHash,
				}},
			}},
		},
	}
	reportBytes, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	reportReceipt, err := objects.PutBytes(reportBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, reportReceipt, "application/json"); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := db.SQL().ExecContext(ctx, `
INSERT INTO stage_attempts(id,run_id,stage,ordinal,status,codex_thread_id,codex_turn_id,input_artifact_hash,output_artifact_hash,external_side_effects,error,created_at,updated_at)
VALUES('attempt-report',?,'synthesize',0,'completed','','','','',0,'',?,?)`, run.ID, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `
INSERT INTO artifacts(id,run_id,stage_attempt_id,kind,blob_hash,adopted,created_at)
VALUES('artifact-report',?,'attempt-report','research.report',?,1,?)`, run.ID, reportReceipt.Hash, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `
INSERT INTO evidence(id,run_id,stage_attempt_id,source_url,title,publisher,blob_hash,captured_at,adopted)
VALUES('evidence-source',?,'attempt-report','https://example.invalid/su2','SU2 source','',?,?,1)`, run.ID, evidenceReceipt.Hash, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `
UPDATE runs SET status='succeeded',report_artifact_id='artifact-report',updated_at=? WHERE id=?`, now, run.ID); err != nil {
		t.Fatal(err)
	}

	indexDocument := func(document store.Document, chunks []rag.Chunk) {
		t.Helper()
		vectors := make([][]float32, len(chunks))
		for index := range vectors {
			vectors[index] = make([]float32, rag.EmbeddingDimensions)
			vectors[index][0] = float32(index + 1)
		}
		if _, err := db.IndexDocument(ctx, document, chunks, vectors); err != nil {
			t.Fatal(err)
		}
	}
	indexDocument(store.Document{
		ProjectID: project.ID, ArtifactID: "artifact-report", Title: "Research report", BlobHash: reportReceipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
	}, rag.ChunkText(report.AnswerMarkdown, rag.DefaultChunkRunes, rag.DefaultOverlapRunes))
	indexDocument(store.Document{
		ProjectID: project.ID, Title: "SU2 source", BlobHash: evidenceReceipt.Hash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
	}, rag.ChunkText(string(evidenceBytes), rag.DefaultChunkRunes, rag.DefaultOverlapRunes))

	environment := append(os.Environ(), "AETHEROPS_OXIGRAPH_MODULE="+oxigraphModule)
	sidecar, err := StartSidecar(ctx, SidecarConfig{Command: node, Args: []string{sidecarEntry}, Dir: root, Env: environment})
	if err != nil {
		t.Fatal(err)
	}
	defer sidecar.Close()
	service := &Service{DB: db, CAS: objects, Sidecar: sidecar}
	if err := service.AdoptRun(ctx, run.ID); err != nil {
		t.Fatal(err)
	}
	head, err := db.ActiveKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != store.KnowledgeHeadReady || head.Generation.State != store.KnowledgeReady || head.Generation.EntityCount != 1 || head.Generation.AssertionCount != 1 {
		t.Fatalf("unexpected adopted knowledge head: %+v", head)
	}
	result, err := sidecar.Query(ctx, project.ID, head.GenerationID, "ASK { ?subject <urn:aetherops:core:dependsOn> ?object }", 10)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(result), `"boolean":true`) {
		t.Fatalf("Oxigraph did not load the activated generation: %s", result)
	}
	if err := service.AdoptRun(ctx, run.ID); err != nil {
		t.Fatalf("idempotent adoption did not reload the active snapshot: %v", err)
	}
}
