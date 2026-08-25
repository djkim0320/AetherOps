package liveembeddingsevidence

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/djkim0320/AetherOps/internal/rag"
	"github.com/djkim0320/AetherOps/internal/store"
)

type journalWriter struct {
	file      *os.File
	journalID string
	sequence  int
	previous  string
}

func createJournal(path string) (*journalWriter, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("journal path is required")
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		file.Close()
		return nil, err
	}
	return &journalWriter{file: file, journalID: hex.EncodeToString(random)}, nil
}

func (writer *journalWriter) append(record JournalRecord) error {
	if writer == nil || writer.file == nil {
		return errors.New("journal is closed")
	}
	record.Schema = JournalSchemaV1
	record.JournalID = writer.journalID
	record.Sequence = writer.sequence + 1
	record.PreviousRecordSHA256 = writer.previous
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	if _, err := writer.file.Write(raw); err != nil {
		return err
	}
	if err := writer.file.Sync(); err != nil {
		return err
	}
	digest := sha256.Sum256(raw)
	writer.previous = hex.EncodeToString(digest[:])
	writer.sequence++
	return nil
}

func (writer *journalWriter) close() error {
	if writer == nil || writer.file == nil {
		return nil
	}
	err := writer.file.Close()
	writer.file = nil
	return err
}

func loadCompleteJournal(path string) (LiveObservation, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Size() > 4<<20 {
		return LiveObservation{}, errors.New("live journal must be a bounded regular non-symlink file")
	}
	file, err := os.Open(path)
	if err != nil {
		return LiveObservation{}, err
	}
	defer file.Close()
	hash := sha256.New()
	reader := bufio.NewReader(io.TeeReader(io.LimitReader(file, (4<<20)+1), hash))
	var records []JournalRecord
	previous := ""
	journalID := ""
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > 0 {
			if line[len(line)-1] != '\n' {
				return LiveObservation{}, errors.New("live journal has a torn final record")
			}
			var record JournalRecord
			decoder := json.NewDecoder(bytes.NewReader(line))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&record); err != nil {
				return LiveObservation{}, fmt.Errorf("decode live journal record: %w", err)
			}
			var trailing any
			if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
				return LiveObservation{}, errors.New("live journal record has trailing JSON")
			}
			if record.Schema != JournalSchemaV1 || record.Sequence != len(records)+1 || record.PreviousRecordSHA256 != previous ||
				record.WrittenAt.IsZero() || strings.TrimSpace(record.JournalID) == "" {
				return LiveObservation{}, errors.New("live journal sequence or hash chain is invalid")
			}
			if journalID == "" {
				journalID = record.JournalID
			} else if record.JournalID != journalID {
				return LiveObservation{}, errors.New("live journal id changed")
			}
			digest := sha256.Sum256(line)
			previous = hex.EncodeToString(digest[:])
			record.RecordSHA256 = previous
			records = append(records, record)
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return LiveObservation{}, readErr
		}
	}
	if len(records) != 5 {
		return LiveObservation{}, errors.New("live journal is incomplete or oversized")
	}
	wantStates := []JournalState{StatePrepared, StateReindexSubmitting, StateReindexObserved, StateSearchSubmitting, StateLiveComplete}
	for index, want := range wantStates {
		if records[index].State != want {
			return LiveObservation{}, fmt.Errorf("live journal state %d is %s, want %s", index+1, records[index].State, want)
		}
	}
	if !preparedRecordShape(records[0]) || !emptyRecordShape(records[1]) || !observedRecordShape(records[2]) ||
		!emptyRecordShape(records[3]) || !completeRecordShape(records[4]) {
		return LiveObservation{}, errors.New("live journal record fields do not match their fixed states")
	}
	prepared, observed, complete := records[0], records[2], records[4]
	if prepared.Binding == nil || prepared.Documents == nil || prepared.Before == nil || observed.Index == nil || observed.After == nil || complete.Search == nil {
		return LiveObservation{}, errors.New("live journal is missing a required observation")
	}
	if err := validateLiveTransition(*prepared.Binding, *prepared.Documents, *prepared.Before, *observed.Index, *observed.After, *complete.Search); err != nil {
		return LiveObservation{}, err
	}
	if prepared.WrittenAt.Before(prepared.Binding.LedgerPreparedAt) || prepared.WrittenAt.Before(prepared.Binding.RunnerTerminalAt) ||
		observed.WrittenAt.Before(prepared.WrittenAt) || complete.WrittenAt.Before(observed.WrittenAt) {
		return LiveObservation{}, errors.New("live journal observation times are not monotonic after prepared evidence")
	}
	return LiveObservation{
		Binding: *prepared.Binding, Documents: *prepared.Documents, Before: *prepared.Before,
		Index: *observed.Index, After: *observed.After, Search: *complete.Search,
		JournalSHA256: hex.EncodeToString(hash.Sum(nil)), LiveStartedAt: prepared.WrittenAt, LiveFinishedAt: complete.WrittenAt,
	}, nil
}

func preparedRecordShape(record JournalRecord) bool {
	return record.Binding != nil && record.Documents != nil && record.Before != nil && record.Index == nil && record.After == nil &&
		record.Search == nil && record.FailureCode == ""
}

func emptyRecordShape(record JournalRecord) bool {
	return record.Binding == nil && record.Documents == nil && record.Before == nil && record.Index == nil && record.After == nil &&
		record.Search == nil && record.FailureCode == ""
}

func observedRecordShape(record JournalRecord) bool {
	return record.Binding == nil && record.Documents == nil && record.Before == nil && record.Index != nil && record.After != nil &&
		record.Search == nil && record.FailureCode == ""
}

func completeRecordShape(record JournalRecord) bool {
	return record.Binding == nil && record.Documents == nil && record.Before == nil && record.Index == nil && record.After == nil &&
		record.Search != nil && record.FailureCode == ""
}

func validateLiveTransition(binding Binding, documents DocumentObservation, before store.ProjectMemoryHead, index store.EmbeddingIndex, after store.ProjectMemoryHead, search SearchObservation) error {
	if err := binding.ProductBuild.Validate(); err != nil || !validateDigest(binding.ReleaseCandidateID) ||
		!validateDigest(binding.PreparedLedgerSHA256) || binding.PreparedLedgerRevision < 1 || binding.LedgerPreparedAt.IsZero() ||
		!validateDigest(binding.RunnerReceiptSHA256) || strings.TrimSpace(binding.EvalRunSetID) == "" || strings.TrimSpace(binding.ProjectID) == "" ||
		!validateDigest(binding.EndpointSHA256) || !validateDigest(binding.QuerySHA256) || binding.SessionStartedAt.IsZero() || binding.RunnerTerminalAt.IsZero() {
		return errors.New("live journal binding is invalid")
	}
	if documents.Count < 1 || !validateDigest(documents.SetSHA256) || before.ProjectID != binding.ProjectID || before.State != "ready" ||
		before.ActiveIndex == nil || before.ActiveIndexID == "" || before.ShadowIndexID != "" || before.ActiveIndex.State != "active" ||
		before.ActiveIndex.Model != rag.EmbeddingModel || before.ActiveIndex.Dimensions != rag.EmbeddingDimensions {
		return errors.New("live journal pre-reindex memory state is invalid")
	}
	if index.ProjectID != binding.ProjectID || index.ID == before.ActiveIndexID || index.State != "active" || index.Model != rag.EmbeddingModel ||
		index.Dimensions != rag.EmbeddingDimensions || after.ProjectID != binding.ProjectID || after.ActiveIndexID != index.ID ||
		after.MemoryRevision != before.MemoryRevision+1 || after.State != "ready" || after.ShadowIndexID != "" || after.ActiveIndex == nil || after.ActiveIndex.ID != index.ID {
		return errors.New("live journal did not observe an exact non-noop ready shadow transition")
	}
	return validateSearch(search, binding.ProjectID, binding.QuerySHA256, index.ID, after.MemoryRevision)
}
