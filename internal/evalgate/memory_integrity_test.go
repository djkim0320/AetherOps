package evalgate

import (
	"context"
	"strings"
	"testing"
)

func TestVerifierRejectsCorruptAdoptedMemoryIndex(t *testing.T) {
	ctx := context.Background()
	database, objects := openEvaluationStore(t)
	item := testDataset().Cases[0]
	run := createPassingEvaluationRun(t, ctx, database, objects, item)

	if _, err := database.SQL().ExecContext(ctx, `
UPDATE chunks SET text_hash=?
WHERE document_id IN (
  SELECT id FROM documents WHERE project_id=? AND status='ready'
)`, strings.Repeat("0", 64), run.ProjectID); err != nil {
		t.Fatal(err)
	}
	result := (Verifier{DB: database, CAS: objects, Oxigraph: startEvaluationOxigraph(t)}).verifyCase(ctx, item, run.ID)
	if result.Passed || !strings.Contains(result.Failure, "index integrity") {
		t.Fatalf("corrupt adopted memory index was accepted: %+v", result)
	}
}
