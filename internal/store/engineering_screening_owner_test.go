package store

import (
	"context"
	"errors"
	"testing"
)

func TestXFOILScreeningOwnerIsRecheckedAtEngineeringProcessBoundary(t *testing.T) {
	fixture := newScreeningDedupeFixture(t)
	jobFor := func(attemptID string) EngineeringJob {
		return EngineeringJob{
			RunID: fixture.run.ID, StageAttemptID: attemptID, Operation: "xfoil_polar",
			SpecJSON: `{"arguments":{"run_id":"` + fixture.run.ID + `","stage_attempt_id":"` + attemptID + `","execution_purpose":"screening"}}`,
		}
	}

	transaction, err := fixture.database.sql.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer transaction.Rollback()
	if err := requireXFOILScreeningJobOwner(context.Background(), transaction, jobFor(fixture.first.ID)); err != nil {
		t.Fatalf("owner process boundary rejected: %v", err)
	}
	if err := requireXFOILScreeningJobOwner(context.Background(), transaction, jobFor(fixture.second.ID)); !errors.Is(err, ErrXFOILScreeningOwner) {
		t.Fatalf("non-owner process boundary error = %v", err)
	}
}
