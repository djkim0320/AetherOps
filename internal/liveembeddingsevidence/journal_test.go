package liveembeddingsevidence

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAmbiguousJournalIsTerminalAndCannotBeRecreated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "live.journal.jsonl")
	journal, err := createJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := journal.append(JournalRecord{State: StatePrepared, WrittenAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := journal.append(JournalRecord{State: StateReindexSubmitting, WrittenAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := journal.append(JournalRecord{State: StateReindexAmbiguous, WrittenAt: now, FailureCode: "REINDEX_OUTCOME_AMBIGUOUS"}); err != nil {
		t.Fatal(err)
	}
	if err := journal.close(); err != nil {
		t.Fatal(err)
	}
	if _, err := loadCompleteJournal(path); err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("ambiguous fixture journal was accepted: %v", err)
	}
	if _, err := createJournal(path); err == nil {
		t.Fatal("existing ambiguous journal was recreated and could permit a POST retry")
	}
}

func TestJournalHashChainRejectsTampering(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tampered.journal.jsonl")
	journal, err := createJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for _, state := range []JournalState{StatePrepared, StateReindexSubmitting, StateReindexObserved, StateSearchSubmitting, StateLiveComplete} {
		if err := journal.append(JournalRecord{State: state, WrittenAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	if err := journal.close(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	tampered := strings.Replace(string(raw), "REINDEX_SUBMITTING", "REINDEX_SUBMITTINO", 1)
	if err := os.WriteFile(path, []byte(tampered), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadCompleteJournal(path); err == nil || !strings.Contains(err.Error(), "hash chain") {
		t.Fatalf("tampered journal was accepted: %v", err)
	}
}

type failingDoer struct{ calls int }

func (doer *failingDoer) Do(*http.Request) (*http.Response, error) {
	doer.calls++
	return nil, errors.New("ambiguous transport failure")
}

func TestStateChangingRequestPrimitiveNeverRetriesTransportFailure(t *testing.T) {
	doer := &failingDoer{}
	api := liveAPI{endpoint: "http://127.0.0.1:1", token: []byte(strings.Repeat("a", 32)), client: doer}
	var destination struct{}
	err := api.request(context.Background(), http.MethodPost, "/api/v1/projects/prj/memory/reindex", []byte{}, &destination)
	if err == nil || doer.calls != 1 {
		t.Fatalf("state-changing request calls=%d err=%v; want one ambiguous attempt", doer.calls, err)
	}
}
