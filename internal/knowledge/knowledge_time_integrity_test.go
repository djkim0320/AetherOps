package knowledge

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/store"
)

func TestKnowledgePatchAndInferenceKeysCanonicalizeEquivalentTimes(t *testing.T) {
	left := core.KnowledgeAssertion{
		SubjectEntityID: "left", Predicate: "related_to", ObjectEntityID: "right",
		ValidTime: &core.KnowledgeTimeRange{Start: "2026-08-09T12:34:56.1+09:00", End: "2026-08-10T12:34:56+09:00"},
	}
	right := left
	right.ValidTime = &core.KnowledgeTimeRange{Start: "2026-08-09T03:34:56.100000000Z", End: "2026-08-10T03:34:56Z"}
	leftKey, err := knowledgeAssertionKey(left, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	rightKey, err := knowledgeAssertionKey(right, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if leftKey != rightKey {
		t.Fatalf("equivalent KnowledgePatch keys differ: %s/%s", leftKey, rightKey)
	}
	leftTime, _ := time.Parse(time.RFC3339Nano, left.ValidTime.Start)
	rightTime, _ := time.Parse(time.RFC3339Nano, right.ValidTime.Start)
	if (projectionStatement{Subject: "left", Predicate: "related_to", ObjectEntity: "right", Qualifiers: "{}", ValidFrom: &leftTime}).key() !=
		(projectionStatement{Subject: "left", Predicate: "related_to", ObjectEntity: "right", Qualifiers: "{}", ValidFrom: &rightTime}).key() {
		t.Fatal("equivalent inference statement times produced different keys")
	}
}

func TestShadowCopyCanonicalizesLegacyValidityAndAssertionKey(t *testing.T) {
	ctx := context.Background()
	database, objects := openKnowledgeServiceTestStorage(t)
	project, err := database.CreateProject(ctx, "legacy temporal shadow")
	if err != nil {
		t.Fatal(err)
	}
	source, err := database.CreateKnowledgeGeneration(ctx, project.ID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	oldKey := strings.Repeat("c", 64)
	if err := database.AppendKnowledgeProjection(ctx, project.ID, source.ID, store.KnowledgeProjection{
		Entities: []store.KnowledgeEntityRecord{
			{ID: "left", ClassKey: "concept", CanonicalName: "Left", NormalizedName: "left"},
			{ID: "right", ClassKey: "concept", CanonicalName: "Right", NormalizedName: "right"},
		},
		Assertions: []store.KnowledgeAssertionRecord{{
			ID: "relation", SubjectEntityID: "left", PredicateKey: "related_to", ObjectEntityID: "right",
			Qualifiers: json.RawMessage(`{}`), Polarity: "affirmed", Status: "accepted", Confidence: 1,
			AssertionKey: oldKey,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQL().ExecContext(ctx, `UPDATE knowledge_assertions SET valid_from=?,valid_to=? WHERE project_id=? AND generation_id=? AND id='relation'`,
		"2026-08-09T12:34:56.1+09:00", "2026-08-10T12:34:56+09:00", project.ID, source.ID); err != nil {
		t.Fatal(err)
	}
	target, err := database.CreateKnowledgeGeneration(ctx, project.ID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{DB: database, CAS: objects}
	if err := service.copyActiveProjection(ctx, project.ID, source, target); err != nil {
		t.Fatal(err)
	}
	var validFrom, validTo, assertionKey string
	if err := database.SQL().QueryRowContext(ctx, `SELECT valid_from,valid_to,assertion_key FROM knowledge_assertions WHERE project_id=? AND generation_id=? AND id='relation'`, project.ID, target.ID).Scan(&validFrom, &validTo, &assertionKey); err != nil {
		t.Fatal(err)
	}
	if validFrom != "2026-08-09T03:34:56.100000000Z" || validTo != "2026-08-10T03:34:56.000000000Z" {
		t.Fatalf("shadow validity = %s/%s", validFrom, validTo)
	}
	if assertionKey == oldKey || len(assertionKey) != 64 {
		t.Fatalf("shadow assertion key was not rebuilt: %s", assertionKey)
	}
}

func TestActiveKnowledgeValidityAuditFailsHeadClosed(t *testing.T) {
	ctx := context.Background()
	fixture := newCurationPreflightFixture(t, false)
	if _, err := fixture.database.SQL().ExecContext(ctx, `DROP TRIGGER knowledge_assertions_update_lock`); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.database.SQL().ExecContext(ctx, `UPDATE knowledge_assertions SET valid_from='not-rfc3339',valid_to=NULL WHERE project_id=? AND generation_id=? AND id='left-value'`, fixture.projectID, fixture.generationID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.database.AuditActiveKnowledgeIntervals(ctx, fixture.projectID); err == nil || !strings.Contains(err.Error(), "invalid validity interval") {
		t.Fatalf("active audit error = %v", err)
	}
	head, err := fixture.database.ActiveKnowledgeGeneration(ctx, fixture.projectID)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != store.KnowledgeHeadFailed {
		t.Fatalf("invalid active head status = %s, want failed", head.Status)
	}
}
