package knowledge

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
)

func TestServiceSPARQLDefaultOntologyUsesRealOxigraph(t *testing.T) {
	node, sidecarDir := realSidecarPaths(t)
	ctx := context.Background()
	sidecar, err := StartSidecar(ctx, SidecarConfig{
		Command: node,
		Args:    []string{filepath.Join(sidecarDir, "index.cjs")},
		Dir:     sidecarDir,
		Env:     replaceTestEnv("AETHEROPS_OXIGRAPH_MODULE", filepath.Join(sidecarDir, "node_modules", "oxigraph")),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := sidecar.Close(); err != nil {
			t.Errorf("close real Oxigraph sidecar: %v", err)
		}
	})

	root := t.TempDir()
	database, err := store.Open(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	project, err := database.CreateProject(ctx, "empty graph")
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{DB: database, CAS: objects, Sidecar: sidecar}
	legacyHead, err := database.ActiveKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.InitializeProject(ctx, project.ID); err != nil {
		t.Fatal(err)
	}
	readyHead, err := database.ActiveKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if readyHead.GenerationID == legacyHead.GenerationID || readyHead.Status != store.KnowledgeHeadReady {
		t.Fatalf("legacy empty head was not replaced by a verified shadow generation: before=%+v after=%+v", legacyHead, readyHead)
	}
	if err := service.InitializeProject(ctx, project.ID); err != nil {
		t.Fatalf("idempotent project graph initialization: %v", err)
	}
	idempotentHead, err := database.ActiveKnowledgeGeneration(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if idempotentHead.GenerationID != readyHead.GenerationID {
		t.Fatalf("idempotent initialization replaced a valid generation: before=%s after=%s", readyHead.GenerationID, idempotentHead.GenerationID)
	}

	result, err := service.SPARQL(
		ctx, project.ID, "ASK { <urn:aetherops:core:Thing> a <http://www.w3.org/2002/07/owl#Class> }", 10,
	)
	if err != nil {
		t.Fatal(err)
	}
	envelope, ok := result.(core.SPARQLResult)
	if !ok {
		t.Fatalf("SPARQL result type = %T, want core.SPARQLResult", result)
	}
	if envelope.QueryForm != "ASK" || !envelope.Complete {
		t.Fatalf("SPARQL envelope = %+v", envelope)
	}
	raw := envelope.Result
	var decoded struct {
		Type    string `json:"type"`
		Boolean bool   `json:"boolean"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Type != "ask" || !decoded.Boolean {
		t.Fatalf("default ontology was absent from the real Oxigraph dataset: %s", raw)
	}
	receipt, err := database.KnowledgeSnapshotReceipt(ctx, project.ID, readyHead.GenerationID)
	if err != nil || receipt.TripleCount <= 0 {
		t.Fatalf("ontology-bearing snapshot receipt is missing: receipt=%+v err=%v", receipt, err)
	}
	selected, err := service.SPARQL(ctx, project.ID, `
SELECT ?class WHERE { ?class a <http://www.w3.org/2002/07/owl#Class> } ORDER BY ?class`, 100)
	if err != nil {
		t.Fatal(err)
	}
	selectedEnvelope := selected.(core.SPARQLResult)
	if selectedEnvelope.QueryForm != "SELECT" || !selectedEnvelope.Complete {
		t.Fatalf("SELECT envelope = %+v", selectedEnvelope)
	}
	selectedRaw := selectedEnvelope.Result
	var selectedResult struct {
		Type string `json:"type"`
		Rows []map[string]struct {
			Value string `json:"value"`
		} `json:"rows"`
	}
	if err := json.Unmarshal(selectedRaw, &selectedResult); err != nil {
		t.Fatal(err)
	}
	var classCount int
	if err := database.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM ontology_terms WHERE ontology_id=? AND kind='class'", store.CoreOntologyID,
	).Scan(&classCount); err != nil {
		t.Fatal(err)
	}
	if selectedResult.Type != "select" || len(selectedResult.Rows) != classCount || classCount == 0 {
		t.Fatalf("ontology SELECT mismatch: classes=%d result=%s", classCount, selectedRaw)
	}
	foundThing := false
	for _, row := range selectedResult.Rows {
		foundThing = foundThing || row["class"].Value == "urn:aetherops:core:Thing"
	}
	if !foundThing {
		t.Fatalf("ontology SELECT omitted core Thing: %s", selectedRaw)
	}

	atomicProject, err := service.CreateProject(ctx, "atomic ontology graph")
	if err != nil {
		t.Fatal(err)
	}
	atomicHead, err := database.ActiveKnowledgeGeneration(ctx, atomicProject.ID)
	if err != nil {
		t.Fatal(err)
	}
	var generationCount int
	if err := database.SQL().QueryRowContext(ctx,
		"SELECT COUNT(*) FROM knowledge_generations WHERE project_id=?", atomicProject.ID,
	).Scan(&generationCount); err != nil {
		t.Fatal(err)
	}
	if generationCount != 1 {
		t.Fatalf("atomic project creation left placeholder generations: %d", generationCount)
	}
	if err := database.VerifyKnowledgeSnapshot(ctx, atomicProject.ID, atomicHead.GenerationID, objects); err != nil {
		t.Fatalf("atomic project snapshot verification: %v", err)
	}

	crashProject, err := database.CreateProject(ctx, "schema crash recovery")
	if err != nil {
		t.Fatal(err)
	}
	crashLegacyHead, err := database.ActiveKnowledgeGeneration(ctx, crashProject.ID)
	if err != nil {
		t.Fatal(err)
	}
	ontology, err := database.KnowledgeGenerationOntologyReceipt(ctx, crashProject.ID, crashLegacyHead.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	crashCandidate, err := database.CreateKnowledgeGeneration(
		ctx, crashProject.ID, ontology.OntologyID, schemaOnlyContract(ontology.CanonicalSHA256),
	)
	if err != nil {
		t.Fatal(err)
	}
	crashSnapshot, crashTriples, err := database.KnowledgeNQuads(ctx, crashProject.ID, crashCandidate.ID, ontology.OntologyID)
	if err != nil {
		t.Fatal(err)
	}
	crashReceipt, err := objects.PutBytes(crashSnapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, crashReceipt, "application/n-quads"); err != nil {
		t.Fatal(err)
	}
	if err := database.AppendKnowledgeProjection(ctx, crashProject.ID, crashCandidate.ID, store.KnowledgeProjection{
		Snapshots: []store.KnowledgeRDFSnapshotRecord{{
			ID: "krdf_" + crashReceipt.Hash[:32], Format: "n-quads", BlobHash: crashReceipt.Hash,
			DatasetSHA256: crashReceipt.Hash, TripleCount: crashTriples,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionKnowledgeGeneration(
		ctx, crashProject.ID, crashCandidate.ID, store.KnowledgeBuilding, store.KnowledgeValidating, "",
	); err != nil {
		t.Fatal(err)
	}
	if err := service.InitializeProject(ctx, crashProject.ID); err != nil {
		t.Fatalf("resume snapshot-complete schema candidate: %v", err)
	}
	crashRecoveredHead, err := database.ActiveKnowledgeGeneration(ctx, crashProject.ID)
	if err != nil {
		t.Fatal(err)
	}
	if crashRecoveredHead.GenerationID != crashCandidate.ID || crashRecoveredHead.Status != store.KnowledgeHeadReady {
		t.Fatalf("snapshot-complete candidate was not resumed without replacement: candidate=%s head=%+v", crashCandidate.ID, crashRecoveredHead)
	}
}

func TestRealOxigraphSidecarDoesNotLeakAcrossProjectGenerationKeys(t *testing.T) {
	node, sidecarDir := realSidecarPaths(t)
	ctx := context.Background()
	sidecar, err := StartSidecar(ctx, SidecarConfig{
		Command: node, Args: []string{filepath.Join(sidecarDir, "index.cjs")}, Dir: sidecarDir,
		Env: replaceTestEnv("AETHEROPS_OXIGRAPH_MODULE", filepath.Join(sidecarDir, "node_modules", "oxigraph")),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer sidecar.Close()
	projectASnapshot := []byte("<urn:project-a:secret> <urn:predicate> <urn:value> .\n")
	projectAHash := sha256.Sum256(projectASnapshot)
	emptyHash := sha256.Sum256(nil)
	if err := sidecar.LoadSnapshot(ctx, "project-a", "generation-a", projectASnapshot,
		hex.EncodeToString(projectAHash[:]), 1); err != nil {
		t.Fatal(err)
	}
	if err := sidecar.LoadSnapshot(ctx, "project-b", "generation-b", nil,
		hex.EncodeToString(emptyHash[:]), 0); err != nil {
		t.Fatal(err)
	}
	query := "ASK { <urn:project-a:secret> <urn:predicate> <urn:value> }"
	projectAResult, err := sidecar.Query(ctx, "project-a", "generation-a", query, 10)
	if err != nil {
		t.Fatal(err)
	}
	projectBResult, err := sidecar.Query(ctx, "project-b", "generation-b", query, 10)
	if err != nil {
		t.Fatal(err)
	}
	decodeBoolean := func(raw json.RawMessage) bool {
		t.Helper()
		var value struct {
			Boolean bool `json:"boolean"`
		}
		if err := json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		return value.Boolean
	}
	if !decodeBoolean(projectAResult) || decodeBoolean(projectBResult) {
		t.Fatalf("cross-project SPARQL isolation failed: project-a=%s project-b=%s", projectAResult, projectBResult)
	}
	if _, err := sidecar.Query(ctx, "project-b", "generation-a", query, 10); err == nil || !strings.Contains(err.Error(), "snapshot_not_loaded") {
		t.Fatalf("project B reused project A generation key: %v", err)
	}
}

func TestSidecarCrashReturnsNoPartialResultAndInvalidatesStream(t *testing.T) {
	ctx := context.Background()
	sidecar, err := StartSidecar(ctx, SidecarConfig{
		Command: os.Args[0],
		Args:    []string{"-test.run=^TestSidecarCrashFixture$"},
		Env:     []string{"AETHEROPS_OXIGRAPH_MODULE=" + filepath.Join(t.TempDir(), "unused")},
	})
	if err != nil {
		t.Fatal(err)
	}
	emptyHash := sha256.Sum256(nil)
	if err := sidecar.LoadSnapshot(ctx, "project", "generation", nil, hex.EncodeToString(emptyHash[:]), 0); err == nil {
		t.Fatal("crashed sidecar returned a successful or partial load result")
	}
	if _, err := sidecar.Query(ctx, "project", "generation", "ASK { ?s ?p ?o }", 10); err == nil || !strings.Contains(err.Error(), "not running") {
		t.Fatalf("invalidated sidecar was reused: %v", err)
	}
	if err := sidecar.Close(); err != nil {
		t.Fatalf("close invalidated sidecar: %v", err)
	}
}

func TestSidecarProtocolMismatchFailsBeforeSnapshotLoad(t *testing.T) {
	ctx := context.Background()
	sidecar, err := StartSidecar(ctx, SidecarConfig{
		Command: os.Args[0],
		Args:    []string{"-test.run=^TestSidecarProtocolMismatchFixture$"},
		Env:     []string{"AETHEROPS_OXIGRAPH_MODULE=" + filepath.Join(t.TempDir(), "unused")},
	})
	if sidecar != nil {
		_ = sidecar.Close()
		t.Fatal("protocol-mismatched sidecar was returned to the caller")
	}
	if err == nil || !strings.Contains(err.Error(), "contract mismatch") {
		t.Fatalf("protocol mismatch error=%v", err)
	}
}

// TestSidecarCrashFixture is an error-path protocol fixture, not a successful
// SPARQL implementation. It emits an incomplete JSON value and exits so the Go
// client proves that bytes from a crashed process are never surfaced as data.
func TestSidecarCrashFixture(t *testing.T) {
	if !hasExactTestRunArgument("^TestSidecarCrashFixture$") {
		return
	}
	reader := bufio.NewReader(os.Stdin)
	helloLine, _ := reader.ReadString('\n')
	var hello struct {
		ID uint64 `json:"id"`
	}
	_ = json.Unmarshal([]byte(helloLine), &hello)
	_, _ = os.Stdout.WriteString(`{"id":` + fmt.Sprint(hello.ID) + `,"ok":true,"result":{"protocol":"` + sidecarProtocolV1 + `","oxigraph_version":"` + oxigraphContractV1 + `"}}` + "\n")
	_ = os.Stdout.Sync()
	_, _ = reader.ReadString('\n')
	_, _ = os.Stdout.WriteString(`{"id":1,"ok":true,"result":{"partial":true`)
	_ = os.Stdout.Sync()
	os.Exit(23)
}

func TestSidecarProtocolMismatchFixture(t *testing.T) {
	if !hasExactTestRunArgument("^TestSidecarProtocolMismatchFixture$") {
		return
	}
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	var hello struct {
		ID uint64 `json:"id"`
	}
	_ = json.Unmarshal([]byte(line), &hello)
	_, _ = fmt.Fprintf(os.Stdout, `{"id":%d,"ok":true,"result":{"protocol":"future-protocol","oxigraph_version":"99.0.0"}}`+"\n", hello.ID)
	_ = os.Stdout.Sync()
}

func hasExactTestRunArgument(expected string) bool {
	for _, argument := range os.Args {
		if argument == "-test.run="+expected || argument == "--test.run="+expected {
			return true
		}
	}
	return false
}

func realSidecarPaths(t *testing.T) (string, string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatalf("real Node.js is required for the Oxigraph contract test: %v", err)
	}
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate knowledge sidecar test source")
	}
	directory := filepath.Clean(filepath.Join(filepath.Dir(source), "..", "..", "tools", "knowledge-sidecar"))
	for _, required := range []string{"index.cjs", filepath.Join("node_modules", "oxigraph", "package.json")} {
		if _, err := os.Stat(filepath.Join(directory, required)); err != nil {
			t.Fatalf("real Oxigraph sidecar dependency is required (%s): %v", required, err)
		}
	}
	return node, directory
}

func replaceTestEnv(name, value string) []string {
	prefix := strings.ToUpper(name) + "="
	environment := make([]string, 0, len(os.Environ())+1)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(entry), prefix) {
			environment = append(environment, entry)
		}
	}
	return append(environment, name+"="+value)
}
