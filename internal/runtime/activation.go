package runtime

import (
	"errors"
	"fmt"
	"os"
	"reflect"
	"time"
)

type activationPhase string
type activationFaultPoint string

const (
	activationPhaseActivating     activationPhase = "activating"
	activationPhasePointerSwapped activationPhase = "pointer_swapped"
	activationPhaseActive         activationPhase = "active"

	activationFaultAfterPointerSwap     activationFaultPoint = "after_pointer_swap"
	activationFaultBeforeCandidateAudit activationFaultPoint = "before_candidate_audit_save"
	activationFaultBeforeJournalRemoval activationFaultPoint = "before_journal_removal"
)

// activationJournal is the durable intent record surrounding active.json.
// Previous is nil when the first managed runtime is being activated.
type activationJournal struct {
	Schema      int             `json:"schema"`
	Phase       activationPhase `json:"phase"`
	CandidateID string          `json:"candidateId"`
	Previous    *ActiveState    `json:"previous,omitempty"`
	Target      ActiveState     `json:"target"`
	StartedAt   time.Time       `json:"startedAt"`
	UpdatedAt   time.Time       `json:"updatedAt"`
}

func (m *Manager) beginActivation(candidate Candidate, target ActiveState) (activationJournal, error) {
	if err := m.ensureNoActivationJournal(); err != nil {
		return activationJournal{}, err
	}
	if _, err := m.processPathsForActive(target); err != nil {
		return activationJournal{}, fmt.Errorf("authenticate activation target before journaling: %w", err)
	}
	var previous *ActiveState
	active, err := m.readActive()
	if err == nil {
		if _, pathErr := m.processPathsForActive(active); pathErr != nil {
			return activationJournal{}, fmt.Errorf("authenticate previous active runtime: %w", pathErr)
		}
		copy := cloneActive(active)
		previous = &copy
	} else if !errors.Is(err, os.ErrNotExist) {
		return activationJournal{}, fmt.Errorf("read previous active runtime: %w", err)
	}
	now := m.now().UTC()
	journal := activationJournal{
		Schema:      stateSchema,
		Phase:       activationPhaseActivating,
		CandidateID: candidate.ID,
		Previous:    previous,
		Target:      cloneActive(target),
		StartedAt:   now,
		UpdatedAt:   now,
	}
	if err := m.validateActivationJournal(journal); err != nil {
		return activationJournal{}, err
	}
	if err := m.writeActivationJournal(journal); err != nil {
		return activationJournal{}, fmt.Errorf("persist runtime activation intent: %w", err)
	}
	return journal, nil
}

func (m *Manager) advanceActivation(journal *activationJournal, phase activationPhase) error {
	journal.Phase = phase
	journal.UpdatedAt = m.now().UTC()
	if err := m.writeActivationJournal(*journal); err != nil {
		return fmt.Errorf("persist runtime activation phase %q: %w", phase, err)
	}
	return nil
}

func (m *Manager) writeActivationJournal(journal activationJournal) error {
	if err := m.validateActivationJournal(journal); err != nil {
		return err
	}
	return writeJSONAtomic(m.layout.Activation, journal)
}

func (m *Manager) readActivationJournal() (activationJournal, error) {
	var journal activationJournal
	if err := readJSON(m.layout.Activation, &journal); err != nil {
		return activationJournal{}, err
	}
	if err := m.validateActivationJournal(journal); err != nil {
		return activationJournal{}, err
	}
	return journal, nil
}

func (m *Manager) validateActivationJournal(journal activationJournal) error {
	if journal.Schema != stateSchema || !safeID.MatchString(journal.CandidateID) ||
		journal.CandidateID != journal.Target.CandidateID || journal.StartedAt.IsZero() ||
		journal.UpdatedAt.IsZero() || journal.UpdatedAt.Before(journal.StartedAt) {
		return errors.New("runtime activation journal is invalid")
	}
	switch journal.Phase {
	case activationPhaseActivating, activationPhasePointerSwapped, activationPhaseActive:
	default:
		return errors.New("runtime activation journal phase is invalid")
	}
	if err := m.validateActive(journal.Target); err != nil {
		return fmt.Errorf("runtime activation target is invalid: %w", err)
	}
	if journal.Previous != nil {
		if err := m.validateActive(*journal.Previous); err != nil {
			return fmt.Errorf("runtime activation previous pointer is invalid: %w", err)
		}
		if journal.Previous.CandidateID == journal.CandidateID {
			return errors.New("runtime activation target already matches previous pointer")
		}
	}
	return nil
}

func (m *Manager) ensureNoActivationJournal() error {
	_, err := os.Lstat(m.layout.Activation)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect runtime activation journal: %w", err)
	}
	return errors.New("runtime activation reconciliation is required")
}

func (m *Manager) activationFault(point activationFaultPoint) error {
	if m.activationFaultHook == nil {
		return nil
	}
	if err := m.activationFaultHook(point); err != nil {
		return fmt.Errorf("runtime activation interrupted at %s: %w", point, err)
	}
	return nil
}

// reconcileActivationLocked resolves a crash at an activation durability
// boundary. It performs no download, external request, or compatibility probe.
func (m *Manager) reconcileActivationLocked() error {
	journal, err := m.readActivationJournal()
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read runtime activation journal: %w", err)
	}

	current, currentErr := m.readActive()
	currentMissing := errors.Is(currentErr, os.ErrNotExist)
	if currentErr == nil && activeStatesEqual(current, journal.Target) {
		if err := m.commitForwardActivation(&journal); err == nil {
			return nil
		} else if rollbackErr := m.rollbackActivation(&journal); rollbackErr != nil {
			return errors.Join(fmt.Errorf("commit-forward runtime activation: %w", err), rollbackErr)
		}
		return nil
	}

	previousMatches := journal.Previous == nil && currentMissing ||
		journal.Previous != nil && currentErr == nil && activeStatesEqual(current, *journal.Previous)
	if previousMatches {
		if err := m.rollbackActivation(&journal); err != nil {
			return fmt.Errorf("rollback prepared runtime activation: %w", err)
		}
		return nil
	}

	// A pointer/candidate mismatch is recoverable only through the authenticated
	// previous pointer captured before activation began.
	if err := m.rollbackActivation(&journal); err != nil {
		if currentErr != nil && !currentMissing {
			err = errors.Join(err, fmt.Errorf("read inconsistent active runtime pointer: %w", currentErr))
		}
		return fmt.Errorf("runtime activation state is unreconcilable: %w", err)
	}
	return nil
}

func (m *Manager) commitForwardActivation(journal *activationJournal) error {
	candidate, err := m.loadCandidate(journal.CandidateID)
	if err != nil {
		return fmt.Errorf("load activation candidate: %w", err)
	}
	if candidate.Status != CandidatePending && candidate.Status != CandidateActive {
		return fmt.Errorf("activation candidate audit status %q cannot commit forward", candidate.Status)
	}
	if err := candidateMatchesActive(candidate, journal.Target); err != nil {
		return err
	}
	if _, err := m.processPathsForActive(journal.Target); err != nil {
		return fmt.Errorf("authenticate activation target runtime: %w", err)
	}
	if journal.Phase == activationPhaseActivating {
		if err := m.advanceActivation(journal, activationPhasePointerSwapped); err != nil {
			return err
		}
	}
	if err := m.normalizeCandidateAudits(journal.CandidateID); err != nil {
		return err
	}
	if journal.Phase != activationPhaseActive {
		if err := m.advanceActivation(journal, activationPhaseActive); err != nil {
			return err
		}
	}
	if err := os.Remove(m.layout.Activation); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove completed runtime activation journal: %w", err)
	}
	return nil
}

func (m *Manager) rollbackActivation(journal *activationJournal) error {
	if journal.Previous == nil {
		if err := os.Remove(m.layout.Active); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove uncommitted active runtime pointer: %w", err)
		}
	} else {
		if _, err := m.processPathsForActive(*journal.Previous); err != nil {
			return fmt.Errorf("authenticate previous runtime before rollback: %w", err)
		}
		if err := writeJSONAtomic(m.layout.Active, *journal.Previous); err != nil {
			return fmt.Errorf("restore previous active runtime pointer: %w", err)
		}
	}

	candidate, err := m.loadCandidate(journal.CandidateID)
	if err == nil {
		if quarantineErr := m.quarantineCandidate(&candidate, "interrupted-runtime-activation"); quarantineErr != nil {
			return fmt.Errorf("quarantine interrupted activation candidate: %w", quarantineErr)
		}
	} else if !errors.Is(err, os.ErrNotExist) && journal.Previous == nil {
		return fmt.Errorf("inspect interrupted activation candidate: %w", err)
	}
	if journal.Previous != nil {
		if err := m.normalizeCandidateAudits(journal.Previous.CandidateID); err != nil {
			return fmt.Errorf("restore previous runtime audit state: %w", err)
		}
	}
	if err := os.Remove(m.layout.Activation); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove rolled-back runtime activation journal: %w", err)
	}
	return nil
}

func (m *Manager) normalizeCandidateAudits(activeCandidateID string) error {
	entries, err := os.ReadDir(m.layout.Candidates)
	if err != nil {
		return err
	}
	foundActive := false
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == "quarantine" {
			continue
		}
		candidate, err := m.loadCandidate(entry.Name())
		if err != nil {
			return fmt.Errorf("load runtime candidate audit %q: %w", entry.Name(), err)
		}
		desired := candidate.Status
		if candidate.ID == activeCandidateID {
			if candidate.Status != CandidatePending && candidate.Status != CandidateActive && candidate.Status != CandidateSuperseded {
				return fmt.Errorf("active runtime candidate audit has invalid status %q", candidate.Status)
			}
			desired = CandidateActive
			foundActive = true
		} else if candidate.Status == CandidateActive {
			desired = CandidateSuperseded
		}
		if desired != candidate.Status {
			candidate.Status = desired
			candidate.UpdatedAt = m.now().UTC()
			if err := m.saveCandidate(candidate); err != nil {
				return fmt.Errorf("save runtime candidate audit %q: %w", candidate.ID, err)
			}
		}
	}
	if !foundActive {
		// Packaged runtimes have no candidate audit directory. Managed updater
		// activations always do, so only accept absence when the pointer declares
		// closed packaged component roots.
		active, err := m.readActive()
		if err != nil || len(active.ComponentRoots) == 0 || active.CandidateID != activeCandidateID {
			return errors.New("active runtime has no matching candidate audit")
		}
	}
	return nil
}

func candidateMatchesActive(candidate Candidate, active ActiveState) error {
	if candidate.ID != active.CandidateID || candidate.Channel != active.Channel {
		return errors.New("activation candidate does not match active pointer identity")
	}
	for _, component := range managedComponents() {
		metadata, ok := candidate.Components[component]
		if !ok || metadata.Version != active.Versions[component] || metadata.Version != active.LastVerified[component] {
			return fmt.Errorf("activation candidate component %q does not match active pointer", component)
		}
	}
	return nil
}

func cloneActive(active ActiveState) ActiveState {
	copy := active
	copy.Versions = cloneVersions(active.Versions)
	copy.LastVerified = cloneVersions(active.LastVerified)
	copy.ComponentRoots = cloneVersions(active.ComponentRoots)
	return copy
}

func activeStatesEqual(left, right ActiveState) bool {
	return left.Schema == right.Schema && left.CandidateID == right.CandidateID &&
		left.Channel == right.Channel && left.ActivatedAt.Equal(right.ActivatedAt) &&
		reflect.DeepEqual(left.Versions, right.Versions) &&
		reflect.DeepEqual(left.LastVerified, right.LastVerified) &&
		reflect.DeepEqual(left.ComponentRoots, right.ComponentRoots)
}
