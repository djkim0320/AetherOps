package livee2eevidence

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
	"time"
)

const maxJournalBytes = 8 << 20

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
		_ = file.Close()
		return nil, err
	}
	return &journalWriter{file: file, journalID: hex.EncodeToString(random)}, nil
}

func (writer *journalWriter) append(record JournalRecord) error {
	if writer == nil || writer.file == nil {
		return errors.New("journal is closed")
	}
	record.Schema, record.JournalID = JournalSchemaV2, writer.journalID
	record.Sequence, record.PreviousRecordSHA256 = writer.sequence+1, writer.previous
	if record.WrittenAt.IsZero() {
		record.WrittenAt = time.Now().UTC()
	}
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

func LoadCompletedJournal(path string) (LiveObservation, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Size() > maxJournalBytes {
		return LiveObservation{}, errors.New("live end-to-end journal must be a bounded regular non-symlink file")
	}
	file, err := os.Open(path)
	if err != nil {
		return LiveObservation{}, err
	}
	defer file.Close()
	digest := sha256.New()
	reader := bufio.NewReader(io.TeeReader(io.LimitReader(file, maxJournalBytes+1), digest))
	records := make([]JournalRecord, 0, 9)
	previous, journalID := "", ""
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(line) != 0 {
			if line[len(line)-1] != '\n' {
				return LiveObservation{}, errors.New("live end-to-end journal has a torn final record")
			}
			var record JournalRecord
			decoder := json.NewDecoder(bytes.NewReader(line))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&record); err != nil {
				return LiveObservation{}, fmt.Errorf("decode journal record: %w", err)
			}
			var trailing any
			if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
				return LiveObservation{}, errors.New("journal record contains trailing JSON")
			}
			if record.Schema != JournalSchemaV2 || record.Sequence != len(records)+1 ||
				record.PreviousRecordSHA256 != previous || record.WrittenAt.IsZero() || record.JournalID == "" {
				return LiveObservation{}, errors.New("journal sequence or hash chain is invalid")
			}
			if journalID == "" {
				journalID = record.JournalID
			} else if record.JournalID != journalID {
				return LiveObservation{}, errors.New("journal id changed")
			}
			sum := sha256.Sum256(line)
			previous = hex.EncodeToString(sum[:])
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
	states := []JournalState{StatePrepared, StateBrowserObserving, StateBrowserObserved, StateRunSubmitting,
		StateRunObserved, StateSPARQLSubmitting, StateSPARQLObserved, StateEditSubmitting, StateLiveComplete}
	if len(records) != len(states) {
		return LiveObservation{}, errors.New("live end-to-end journal is incomplete or contains an unexpected state")
	}
	for index, state := range states {
		if records[index].State != state || (index != 0 && records[index].WrittenAt.Before(records[index-1].WrittenAt)) {
			return LiveObservation{}, fmt.Errorf("journal state %d is invalid", index+1)
		}
	}
	if records[0].Binding == nil || records[2].Browser == nil || records[4].Run == nil || records[6].SPARQL == nil || records[8].Curation == nil {
		return LiveObservation{}, errors.New("journal omits a required live observation")
	}
	for index, record := range records {
		wantPayload := index == 0 || index == 2 || index == 4 || index == 6 || index == 8
		payloads := 0
		for _, present := range []bool{record.Binding != nil, record.Browser != nil, record.Run != nil, record.SPARQL != nil, record.Curation != nil} {
			if present {
				payloads++
			}
		}
		if (wantPayload && payloads != 1) || (!wantPayload && payloads != 0) {
			return LiveObservation{}, errors.New("journal state contains fields outside its fixed shape")
		}
	}
	result := LiveObservation{
		Binding: *records[0].Binding, Browser: *records[2].Browser, Run: *records[4].Run,
		SPARQL: *records[6].SPARQL, Curation: *records[8].Curation,
		JournalSHA256: hex.EncodeToString(digest.Sum(nil)), StartedAt: records[0].WrittenAt, FinishedAt: records[8].WrittenAt,
	}
	if err := validateLiveObservation(result); err != nil {
		return LiveObservation{}, err
	}
	return result, nil
}

func validateLiveObservation(value LiveObservation) error {
	binding := value.Binding
	if err := binding.ProductBuild.Validate(); err != nil || !validDigest(binding.ReleaseCandidateID) ||
		!validDigest(binding.PreparedLedgerSHA256) || binding.PreparedLedgerRevision < 1 || binding.LedgerPreparedAt.IsZero() ||
		!validDigest(binding.RunnerReceiptSHA256) || !validDigest(binding.EvaluationSHA256) || binding.EvalRunSetID == "" ||
		!validDigest(binding.DatasetSHA256) || !validDigest(binding.RunnerEndpointSHA256) || binding.EvaluationVerifiedAt.IsZero() ||
		!validDigest(binding.ObservationSessionDescriptorSHA256) || !validDigest(binding.ObservationEndpointSHA256) ||
		binding.ObservationSessionStartedAt.IsZero() || binding.ObservationSessionStartedAt.Before(binding.EvaluationVerifiedAt) ||
		binding.ProjectID == "" || !validDigest(binding.PromptSHA256) {
		return errors.New("journal binding is invalid")
	}
	if value.StartedAt.Before(binding.LedgerPreparedAt) || value.StartedAt.Before(binding.ObservationSessionStartedAt) ||
		value.FinishedAt.Before(value.StartedAt) || !value.Browser.Executed || !value.Browser.Compatible ||
		strings.TrimSpace(value.Browser.Observation) == "" || value.Browser.ObservedAt.Before(value.StartedAt) ||
		value.Browser.ObservedAt.After(value.FinishedAt) {
		return errors.New("live observation timing or browser proof is invalid")
	}
	if value.Run.RunID == "" || value.Run.ProjectID != binding.ProjectID || value.Run.ReportArtifactID == "" || value.Run.Status != "succeeded" ||
		value.Run.CreatedAt.Before(value.StartedAt) || value.Run.TerminalAt.Before(value.Run.CreatedAt) ||
		value.Run.TerminalAt.After(value.FinishedAt) {
		return errors.New("live run observation is invalid")
	}
	if value.SPARQL.GenerationID == "" || !validDigest(value.SPARQL.QuerySHA256) || !validDigest(value.SPARQL.ResultSHA256) ||
		value.SPARQL.QueryForm != "SELECT" || !value.SPARQL.Complete || value.SPARQL.ResponseBytes < 2 {
		return errors.New("live SPARQL observation is invalid")
	}
	if value.Curation.EventID == "" || value.Curation.Sequence < 1 || value.Curation.GenerationID != value.SPARQL.GenerationID ||
		value.Curation.Kind != "pin_entity" || !validDigest(value.Curation.PayloadSHA256) || !validDigest(value.Curation.EventSHA256) ||
		!validDigest(value.Curation.MemoBlobSHA256) || value.Curation.EntityID == "" {
		return errors.New("live curation observation is invalid")
	}
	return nil
}
