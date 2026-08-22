package runtime

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestActivationJournalRecoversFaultBoundariesWithoutDuplicateActivation(t *testing.T) {
	tests := []struct {
		name      string
		point     activationFaultPoint
		wantPhase activationPhase
	}{
		{name: "after pointer swap", point: activationFaultAfterPointerSwap, wantPhase: activationPhaseActivating},
		{name: "before candidate audit save", point: activationFaultBeforeCandidateAudit, wantPhase: activationPhasePointerSwapped},
		{name: "before journal removal", point: activationFaultBeforeJournalRemoval, wantPhase: activationPhaseActive},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			now := time.Date(2026, 8, 9, 1, 2, 3, 4, time.UTC)
			contents := testContents()
			server := artifactTLSServer(t, contents)
			defer server.Close()
			options := Options{
				HTTPClient: server.Client(), SignatureVerifier: acceptTestSignature,
				CompatibilityProbe: testLifecycleProbe(now), Now: func() time.Time { return now },
			}
			manager, err := Open(root, testManifest(), options)
			if err != nil {
				t.Fatal(err)
			}
			first, err := manager.Stage(context.Background(), testRelease("activation-first", server.URL, contents))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := manager.ActivatePending(context.Background(), first.ID); err != nil {
				t.Fatal(err)
			}

			now = now.Add(time.Minute)
			second, err := manager.Stage(context.Background(), testRelease("activation-second", server.URL, contents))
			if err != nil {
				t.Fatal(err)
			}
			manager.activationFaultHook = func(point activationFaultPoint) error {
				if point == test.point {
					return errors.New("injected process termination")
				}
				return nil
			}
			if _, err := manager.ActivatePending(context.Background(), second.ID); err == nil || !strings.Contains(err.Error(), string(test.point)) {
				t.Fatalf("activation fault = %v", err)
			}
			if _, err := manager.ProcessPaths(); err == nil || !strings.Contains(err.Error(), "reconciliation is required") {
				t.Fatalf("unreconciled runtime paths = %v", err)
			}
			if _, err := ResolveProcessPathsReadOnly(root, testManifest()); err == nil || !strings.Contains(err.Error(), "reconciliation is required") {
				t.Fatalf("read-only resolver accepted unreconciled runtime paths: %v", err)
			}
			journal, err := manager.readActivationJournal()
			if err != nil {
				t.Fatal(err)
			}
			if journal.Phase != test.wantPhase {
				t.Fatalf("activation phase = %q, want %q", journal.Phase, test.wantPhase)
			}

			firstReopen, err := Open(root, testManifest(), options)
			if err != nil {
				t.Fatal(err)
			}
			assertCoherentActiveCandidate(t, firstReopen, second.ID, first.ID)
			activeOnce, err := firstReopen.Active()
			if err != nil {
				t.Fatal(err)
			}
			statusOnce, err := firstReopen.Status()
			if err != nil {
				t.Fatal(err)
			}
			secondUpdatedAt := candidateUpdatedAt(t, statusOnce, second.ID)

			secondReopen, err := Open(root, testManifest(), options)
			if err != nil {
				t.Fatal(err)
			}
			assertCoherentActiveCandidate(t, secondReopen, second.ID, first.ID)
			activeTwice, err := secondReopen.Active()
			if err != nil {
				t.Fatal(err)
			}
			statusTwice, err := secondReopen.Status()
			if err != nil {
				t.Fatal(err)
			}
			if !activeTwice.ActivatedAt.Equal(activeOnce.ActivatedAt) || candidateUpdatedAt(t, statusTwice, second.ID) != secondUpdatedAt {
				t.Fatal("second reopen repeated the completed activation")
			}
			if _, err := os.Stat(secondReopen.Layout().Activation); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("activation journal remains after recovery: %v", err)
			}
		})
	}
}

func TestActivationJournalPreparedStateRollsBackAndQuarantinesCandidate(t *testing.T) {
	manager, candidate, previousID, options := preparedActivationJournal(t)
	root := manager.Layout().Root
	reopened, err := Open(root, testManifest(), options)
	if err != nil {
		t.Fatal(err)
	}
	active, err := reopened.Active()
	if err != nil {
		t.Fatal(err)
	}
	if active.CandidateID != previousID {
		t.Fatalf("active runtime = %q, want previous %q", active.CandidateID, previousID)
	}
	quarantined, err := reopened.CandidateQuarantined(candidate.ID)
	if err != nil || !quarantined {
		t.Fatalf("prepared candidate quarantine = %v, %v", quarantined, err)
	}
	if _, err := reopened.ProcessPaths(); err != nil {
		t.Fatalf("resolve preserved runtime: %v", err)
	}
}

func TestActivationJournalPointerMismatchRollsBackOnlyToVerifiedPrevious(t *testing.T) {
	manager, candidate, previousID, options := preparedActivationJournal(t)
	unexpected, err := manager.readActive()
	if err != nil {
		t.Fatal(err)
	}
	unexpected.CandidateID = "unexpected-pointer"
	if err := writeJSONAtomic(manager.Layout().Active, unexpected); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(manager.Layout().Root, testManifest(), options)
	if err != nil {
		t.Fatal(err)
	}
	active, err := reopened.Active()
	if err != nil {
		t.Fatal(err)
	}
	if active.CandidateID != previousID {
		t.Fatalf("recovered active runtime = %q, want %q", active.CandidateID, previousID)
	}
	quarantined, err := reopened.CandidateQuarantined(candidate.ID)
	if err != nil || !quarantined {
		t.Fatalf("mismatched candidate quarantine = %v, %v", quarantined, err)
	}
}

func TestActivationJournalUnrecoverableStateFailsOpen(t *testing.T) {
	manager, _, _, options := preparedActivationJournal(t)
	active, err := manager.readActive()
	if err != nil {
		t.Fatal(err)
	}
	active.CandidateID = "unexpected-pointer"
	if err := writeJSONAtomic(manager.Layout().Active, active); err != nil {
		t.Fatal(err)
	}
	nodeRoot := filepath.Join(manager.Layout().Versions, string(ComponentNode), PinnedNodeVersion)
	if err := os.WriteFile(filepath.Join(nodeRoot, "node.exe"), []byte("corrupted previous runtime"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(manager.Layout().Root, testManifest(), options); err == nil || !strings.Contains(err.Error(), "unreconcilable") {
		t.Fatalf("open unreconcilable activation state = %v", err)
	}
}

func preparedActivationJournal(t *testing.T) (*Manager, Candidate, string, Options) {
	t.Helper()
	root := t.TempDir()
	now := time.Date(2026, 8, 9, 2, 3, 4, 5, time.UTC)
	contents := testContents()
	server := artifactTLSServer(t, contents)
	t.Cleanup(server.Close)
	options := Options{
		HTTPClient: server.Client(), SignatureVerifier: acceptTestSignature,
		CompatibilityProbe: testLifecycleProbe(now), Now: func() time.Time { return now },
	}
	manager, err := Open(root, testManifest(), options)
	if err != nil {
		t.Fatal(err)
	}
	previous, err := manager.Stage(context.Background(), testRelease("prepared-previous", server.URL, contents))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.ActivatePending(context.Background(), previous.ID); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	candidate, err := manager.Stage(context.Background(), testRelease("prepared-target", server.URL, contents))
	if err != nil {
		t.Fatal(err)
	}
	versions := make(map[Component]string, len(managedComponents()))
	for _, component := range managedComponents() {
		versions[component] = candidate.Components[component].Version
	}
	target := ActiveState{
		Schema: stateSchema, CandidateID: candidate.ID, Channel: "stable",
		Versions: cloneVersions(versions), LastVerified: cloneVersions(versions), ActivatedAt: now,
	}
	if _, err := manager.beginActivation(candidate, target); err != nil {
		t.Fatal(err)
	}
	return manager, candidate, previous.ID, options
}

func assertCoherentActiveCandidate(t *testing.T, manager *Manager, activeID, supersededID string) {
	t.Helper()
	active, err := manager.Active()
	if err != nil {
		t.Fatal(err)
	}
	if active.CandidateID != activeID {
		t.Fatalf("active candidate = %q, want %q", active.CandidateID, activeID)
	}
	if _, err := manager.ProcessPaths(); err != nil {
		t.Fatalf("resolve recovered runtime: %v", err)
	}
	status, err := manager.Status()
	if err != nil {
		t.Fatal(err)
	}
	activeAudits := 0
	for _, candidate := range status.Candidates {
		switch candidate.ID {
		case activeID:
			if candidate.Status != CandidateActive {
				t.Fatalf("active candidate audit = %q", candidate.Status)
			}
		case supersededID:
			if candidate.Status != CandidateSuperseded {
				t.Fatalf("superseded candidate audit = %q", candidate.Status)
			}
		}
		if candidate.Status == CandidateActive {
			activeAudits++
		}
		if candidate.Status == CandidatePending {
			t.Fatalf("pending candidate remains after recovery: %q", candidate.ID)
		}
	}
	if activeAudits != 1 {
		t.Fatalf("active candidate audits = %d, want 1", activeAudits)
	}
}

func candidateUpdatedAt(t *testing.T, status Status, id string) time.Time {
	t.Helper()
	for _, candidate := range status.Candidates {
		if candidate.ID == id {
			return candidate.UpdatedAt
		}
	}
	t.Fatalf("candidate %q is missing", id)
	return time.Time{}
}
