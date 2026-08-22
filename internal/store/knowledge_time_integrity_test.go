package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestKnowledgeProjectionPersistsFixedWidthUTCValidity(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "canonical knowledge time")
	if err != nil {
		t.Fatal(err)
	}
	generation, err := db.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	from, err := time.Parse(time.RFC3339Nano, "2026-08-09T12:34:56.1+09:00")
	if err != nil {
		t.Fatal(err)
	}
	to, err := time.Parse(time.RFC3339Nano, "2026-08-10T12:34:56+09:00")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AppendKnowledgeProjection(ctx, project.ID, generation.ID, KnowledgeProjection{
		Entities: []KnowledgeEntityRecord{
			{ID: "left", ClassKey: "concept", CanonicalName: "Left", NormalizedName: "left"},
			{ID: "right", ClassKey: "concept", CanonicalName: "Right", NormalizedName: "right"},
		},
		Assertions: []KnowledgeAssertionRecord{{
			ID: "relation", SubjectEntityID: "left", PredicateKey: "related_to", ObjectEntityID: "right",
			Qualifiers: json.RawMessage(`{}`), Polarity: "affirmed", Status: "accepted", Confidence: 1,
			ValidFrom: &from, ValidTo: &to, AssertionKey: strings.Repeat("a", 64),
		}},
	}); err != nil {
		t.Fatal(err)
	}
	var storedFrom, storedTo string
	if err := db.SQL().QueryRowContext(ctx, `SELECT valid_from,valid_to FROM knowledge_assertions WHERE project_id=? AND generation_id=? AND id='relation'`, project.ID, generation.ID).Scan(&storedFrom, &storedTo); err != nil {
		t.Fatal(err)
	}
	if storedFrom != "2026-08-09T03:34:56.100000000Z" || storedTo != "2026-08-10T03:34:56.000000000Z" {
		t.Fatalf("stored validity = %s/%s", storedFrom, storedTo)
	}
}

func TestKnowledgeReadyTransitionRejectsInvalidSemanticValidity(t *testing.T) {
	for name, interval := range map[string][2]string{
		"invalid RFC3339":  {"not-rfc3339", ""},
		"reversed offsets": {"2026-08-09T12:00:00-10:00", "2026-08-09T13:00:00+10:00"},
	} {
		t.Run(name, func(t *testing.T) {
			db, _ := openTestDB(t)
			ctx := context.Background()
			project, err := db.CreateProject(ctx, name)
			if err != nil {
				t.Fatal(err)
			}
			generation, err := db.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
			if err != nil {
				t.Fatal(err)
			}
			if err := db.AppendKnowledgeProjection(ctx, project.ID, generation.ID, KnowledgeProjection{
				Entities: []KnowledgeEntityRecord{
					{ID: "left", ClassKey: "concept", CanonicalName: "Left", NormalizedName: "left"},
					{ID: "right", ClassKey: "concept", CanonicalName: "Right", NormalizedName: "right"},
				},
				Assertions: []KnowledgeAssertionRecord{{
					ID: "relation", SubjectEntityID: "left", PredicateKey: "related_to", ObjectEntityID: "right",
					Qualifiers: json.RawMessage(`{}`), Polarity: "affirmed", Status: "accepted", Confidence: 1,
					AssertionKey: strings.Repeat("b", 64),
				}},
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := db.SQL().ExecContext(ctx, `UPDATE knowledge_assertions SET valid_from=NULLIF(?,''),valid_to=NULLIF(?,'') WHERE project_id=? AND generation_id=? AND id='relation'`, interval[0], interval[1], project.ID, generation.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID, KnowledgeBuilding, KnowledgeValidating, ""); err != nil {
				t.Fatal(err)
			}
			if _, err := db.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID, KnowledgeValidating, KnowledgeReady, ""); err == nil || !strings.Contains(err.Error(), "invalid validity interval") {
				t.Fatalf("invalid interval reached ready: %v", err)
			}
		})
	}
}

func TestKnowledgeRetentionAcceptsCanonicalizedDescendantValidity(t *testing.T) {
	db, _ := openTestDB(t)
	ctx := context.Background()
	project, err := db.CreateProject(ctx, "temporal retention")
	if err != nil {
		t.Fatal(err)
	}
	ancestor, err := db.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	descendant, err := db.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	projection := func(key string) KnowledgeProjection {
		return KnowledgeProjection{
			Entities: []KnowledgeEntityRecord{
				{ID: "left", ClassKey: "concept", CanonicalName: "Left", NormalizedName: "left"},
				{ID: "right", ClassKey: "concept", CanonicalName: "Right", NormalizedName: "right"},
			},
			Assertions: []KnowledgeAssertionRecord{{
				ID: "relation", SubjectEntityID: "left", PredicateKey: "related_to", ObjectEntityID: "right",
				Qualifiers: json.RawMessage(`{}`), Polarity: "affirmed", Status: "accepted", Confidence: 1,
				AssertionKey: key,
			}},
		}
	}
	if err := db.AppendKnowledgeProjection(ctx, project.ID, ancestor.ID, projection(strings.Repeat("d", 64))); err != nil {
		t.Fatal(err)
	}
	if err := db.AppendKnowledgeProjection(ctx, project.ID, descendant.ID, projection(strings.Repeat("e", 64))); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `UPDATE knowledge_assertions SET valid_from=?,valid_to=? WHERE project_id=? AND generation_id=?`,
		"2026-08-09T12:34:56.1+09:00", "2026-08-10T12:34:56+09:00", project.ID, ancestor.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `UPDATE knowledge_assertions SET valid_from=?,valid_to=? WHERE project_id=? AND generation_id=?`,
		"2026-08-09T03:34:56.100000000Z", "2026-08-10T03:34:56.000000000Z", project.ID, descendant.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.VerifyKnowledgeGenerationRetention(ctx, project.ID, ancestor.ID, descendant.ID); err != nil {
		t.Fatalf("canonicalized descendant failed semantic retention: %v", err)
	}
}
