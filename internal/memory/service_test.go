package memory

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/rag"
	"github.com/djkim0320/Aether-claw/internal/store"
	"github.com/razvandimescu/gopdf/pdf"
)

type embeddingProtocolFixture struct{}

func (embeddingProtocolFixture) Embed(_ context.Context, inputs []string) ([][]float32, error) {
	vectors := make([][]float32, len(inputs))
	for index := range inputs {
		vectors[index] = make([]float32, rag.EmbeddingDimensions)
		vectors[index][index%rag.EmbeddingDimensions] = 1
	}
	return vectors, nil
}

func TestIndexesOnlyAtomicallyAdoptedReportAndEvidence(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := store.Open(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	project, err := db.CreateProject(ctx, "memory")
	if err != nil {
		t.Fatal(err)
	}
	run, err := db.CreateRun(ctx, project.ID, "", "question", "main-thread")
	if err != nil {
		t.Fatal(err)
	}
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	collect, err := db.BeginStage(ctx, run.ID, core.StageCollect, 0, "collector", "input")
	if err != nil {
		t.Fatal(err)
	}
	source, err := objects.PutBytes([]byte("한국어 and English adopted evidence"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CaptureEvidence(ctx, run.ID, collect.ID, "https://example.com/source",
		"source", "publisher", "text/plain; charset=utf-8", source); err != nil {
		t.Fatal(err)
	}
	bundle, err := objects.PutBytes([]byte(`{"workstream_id":"w1"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.PublishArtifact(ctx, run.ID, collect.ID, "research.evidence", "application/json", bundle); err != nil {
		t.Fatal(err)
	}
	if err := db.CompleteStage(ctx, collect.ID, bundle.Hash, ""); err != nil {
		t.Fatal(err)
	}
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunSynthesizing, "")
	if err != nil {
		t.Fatal(err)
	}
	synthesize, err := db.BeginStage(ctx, run.ID, core.StageSynthesize, 0, "main-thread", "input")
	if err != nil {
		t.Fatal(err)
	}
	reportJSON, err := json.Marshal(core.ReportManifest{Title: "report", AnswerMarkdown: "final answer [1]"})
	if err != nil {
		t.Fatal(err)
	}
	report, err := objects.PutBytes(reportJSON)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.PublishArtifact(ctx, run.ID, synthesize.ID, "research.report", "application/json", report); err != nil {
		t.Fatal(err)
	}
	if err := db.CompleteStage(ctx, synthesize.ID, report.Hash, ""); err != nil {
		t.Fatal(err)
	}
	run, err = db.TransitionRun(ctx, run.ID, run.Revision, core.RunReviewing, "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = db.SucceedRun(ctx, run.ID, run.Revision)
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{DB: db, CAS: objects, Embedder: embeddingProtocolFixture{}}
	if err := service.IndexRun(ctx, run.ID); err != nil {
		t.Fatal(err)
	}
	var ready int
	if err := db.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM documents WHERE status = 'ready'").Scan(&ready); err != nil {
		t.Fatal(err)
	}
	if ready != 2 {
		t.Fatalf("ready memory documents = %d, want report and source evidence", ready)
	}
}

func TestMaterialTextExtractsPDFEvidenceDeterministically(t *testing.T) {
	creator := pdf.NewCreator()
	first := creator.NewPage(612, 792)
	first.DrawText(72, 720, "NASA NACA 0012 transonic evidence")
	second := creator.NewPage(612, 792)
	second.DrawText(72, 720, "Mach 0.8 alpha 1.25 degrees")
	data, err := creator.Build()
	if err != nil {
		t.Fatal(err)
	}
	material := store.MemoryMaterial{MediaType: "application/pdf"}
	firstText, supported, err := materialText(material, data)
	if err != nil || !supported {
		t.Fatalf("extract PDF evidence: supported=%v err=%v", supported, err)
	}
	secondText, supported, err := materialText(material, data)
	if err != nil || !supported {
		t.Fatalf("repeat PDF evidence extraction: supported=%v err=%v", supported, err)
	}
	if firstText != secondText || !strings.Contains(firstText, "NASA NACA 0012") ||
		!strings.Contains(firstText, "Mach 0.8") {
		t.Fatalf("PDF extraction was incomplete or non-deterministic: %q / %q", firstText, secondText)
	}
}

func TestMaterialTextRejectsInvalidAndEmptyPDFEvidence(t *testing.T) {
	material := store.MemoryMaterial{MediaType: "application/pdf"}
	if _, supported, err := materialText(material, []byte("not a PDF")); err == nil || supported {
		t.Fatalf("invalid PDF did not fail closed: supported=%v err=%v", supported, err)
	}
	creator := pdf.NewCreator()
	creator.NewPage(612, 792)
	empty, err := creator.Build()
	if err != nil {
		t.Fatal(err)
	}
	if _, supported, err := materialText(material, empty); err == nil || supported ||
		!strings.Contains(err.Error(), "no extractable text") {
		t.Fatalf("empty PDF did not fail closed: supported=%v err=%v", supported, err)
	}
}

func TestCountInvalidUTF8Bytes(t *testing.T) {
	value := "valid" + string([]byte{0xff, 0xfe}) + "\ud55c\uae00"
	if got := countInvalidUTF8Bytes(value); got != 2 {
		t.Fatalf("invalid UTF-8 byte count = %d, want 2", got)
	}
	if got := countInvalidUTF8Bytes(strings.ToValidUTF8(value, "\uFFFD")); got != 0 {
		t.Fatalf("sanitized text still has %d invalid UTF-8 bytes", got)
	}
}

func TestReindexProjectBuildsAndActivatesCompleteShadow(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := store.Open(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	project, err := db.CreateProject(ctx, "shadow service")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte("deterministic shadow material"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	if _, err := db.IndexDocument(ctx, store.Document{
		ProjectID: project.ID, Title: "source", BlobHash: receipt.Hash, Pinned: true,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
	}, []rag.Chunk{{Ordinal: 0, Text: "deterministic shadow material"}}, [][]float32{vector}); err != nil {
		t.Fatal(err)
	}
	before, err := db.ActiveEmbeddingIndex(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{DB: db, CAS: objects, Embedder: embeddingProtocolFixture{}}
	beforeStatus, err := service.MemoryStatus(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	after, err := service.ReindexProject(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.ID == before.ID || after.State != "active" {
		t.Fatalf("shadow was not activated: before=%+v after=%+v", before, after)
	}
	afterStatus, err := service.MemoryStatus(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if afterStatus.ActiveIndexID != after.ID || afterStatus.State != "ready" ||
		afterStatus.MemoryRevision != beforeStatus.MemoryRevision+1 {
		t.Fatalf("memory status was not advanced by reindex: before=%+v after=%+v", beforeStatus, afterStatus)
	}
}

func TestSearchProjectUsesRealActiveVectorPath(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := store.Open(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	project, err := db.CreateProject(ctx, "search readback")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes([]byte("exact shadow search phrase"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterBlob(ctx, receipt, "text/plain"); err != nil {
		t.Fatal(err)
	}
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = 1
	if _, err := db.IndexDocument(ctx, store.Document{
		ProjectID: project.ID, Title: "source", BlobHash: receipt.Hash, Pinned: true,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
	}, []rag.Chunk{{Ordinal: 0, Text: "exact shadow search phrase"}}, [][]float32{vector}); err != nil {
		t.Fatal(err)
	}
	service := &Service{DB: db, CAS: objects, Embedder: embeddingProtocolFixture{}}
	results, err := service.SearchProject(ctx, project.ID, "shadow search", 12)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Text != "exact shadow search phrase" {
		t.Fatalf("unexpected search readback: %+v", results)
	}
	head, err := db.ActiveKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.MarkKnowledgeHeadFailedForGeneration(ctx, project.ID, head.GenerationID, errors.New("snapshot verification failed")); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SearchProject(ctx, project.ID, "shadow search", 12); !errors.Is(err, store.ErrKnowledgeGraphUnavailable) {
		t.Fatalf("memory search did not return the fail-closed graph error: %v", err)
	}
}
