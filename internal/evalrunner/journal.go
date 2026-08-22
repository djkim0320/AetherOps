package evalrunner

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
	"path/filepath"
	"strings"
	"time"

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/evalgate"
)

const maxJournalRecordBytes = 1 << 20

type caseRegistration struct {
	CaseID       string `json:"case_id"`
	Mode         string `json:"mode"`
	PromptSHA256 string `json:"prompt_sha256"`
}

type journalHeader struct {
	EvalRunSetID   string                       `json:"eval_run_set_id"`
	RunOrigin      string                       `json:"run_origin"`
	EvidenceClass  string                       `json:"evidence_class"`
	DatasetName    string                       `json:"dataset_name"`
	DatasetSHA256  string                       `json:"dataset_sha256"`
	ProductBuild   evalgate.ProductBuildBinding `json:"product_build"`
	EndpointSHA256 string                       `json:"endpoint_sha256"`
	Target         Target                       `json:"target"`
	StartedAt      time.Time                    `json:"started_at"`
	Cases          []caseRegistration           `json:"cases"`
}

type caseEvent struct {
	EvalRunSetID     string                `json:"eval_run_set_id"`
	CaseID           string                `json:"case_id"`
	State            CaseState             `json:"state"`
	RunID            string                `json:"run_id,omitempty"`
	ProductStatus    core.RunStatus        `json:"product_status,omitempty"`
	ProductRevision  int64                 `json:"product_revision,omitempty"`
	StartedAt        *time.Time            `json:"started_at,omitempty"`
	TerminalAt       *time.Time            `json:"terminal_at,omitempty"`
	PendingApprovals []ApprovalObservation `json:"pending_approvals,omitempty"`
	FailureCode      string                `json:"failure_code,omitempty"`
}

type journalRecord struct {
	Schema    string         `json:"schema"`
	Sequence  uint64         `json:"sequence"`
	Kind      string         `json:"kind"`
	WrittenAt time.Time      `json:"written_at"`
	Header    *journalHeader `json:"header,omitempty"`
	Event     *caseEvent     `json:"event,omitempty"`
}

type caseSnapshot struct {
	Registration caseRegistration
	Event        caseEvent
}

type journalState struct {
	Header   journalHeader
	Cases    map[string]*caseSnapshot
	Sequence uint64
}

type journal struct {
	file  *os.File
	path  string
	state journalState
}

func newRunSetID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "evalrs_" + hex.EncodeToString(raw), nil
}

func promptSHA256(prompt string) string {
	sum := sha256.Sum256([]byte(prompt))
	return hex.EncodeToString(sum[:])
}

func endpointSHA256(endpoint string) string {
	sum := sha256.Sum256([]byte(endpoint))
	return hex.EncodeToString(sum[:])
}

func createJournal(config Config, endpoint string) (*journal, error) {
	absolute, err := filepath.Abs(config.JournalPath)
	if err != nil {
		return nil, err
	}
	if err := requireExistingDirectory(filepath.Dir(absolute)); err != nil {
		return nil, fmt.Errorf("journal parent: %w", err)
	}
	runSetID := ""
	if config.NewRunSetID != nil {
		runSetID, err = config.NewRunSetID()
	} else {
		runSetID, err = newRunSetID()
	}
	if err != nil {
		return nil, fmt.Errorf("create evaluation run-set id: %w", err)
	}
	if !safeIDPattern.MatchString(runSetID) {
		return nil, errors.New("generated evaluation run-set id is invalid")
	}
	now := time.Now().UTC()
	if config.Now != nil {
		now = config.Now().UTC()
	}
	header := journalHeader{
		EvalRunSetID: runSetID, RunOrigin: RunOrigin, EvidenceClass: config.EvidenceClass,
		DatasetName: config.Dataset.Name, DatasetSHA256: config.Dataset.SHA256,
		ProductBuild: config.ProductBuild, EndpointSHA256: endpointSHA256(endpoint),
		Target: config.Target, StartedAt: now, Cases: make([]caseRegistration, len(config.Dataset.Cases)),
	}
	state := journalState{Header: header, Cases: make(map[string]*caseSnapshot, len(config.Dataset.Cases))}
	for index, item := range config.Dataset.Cases {
		registration := caseRegistration{CaseID: item.ID, Mode: item.Mode, PromptSHA256: promptSHA256(item.Prompt())}
		header.Cases[index] = registration
		state.Cases[item.ID] = &caseSnapshot{Registration: registration, Event: caseEvent{
			EvalRunSetID: runSetID, CaseID: item.ID, State: CaseNotStarted,
		}}
	}
	state.Header = header
	file, err := os.OpenFile(absolute, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return nil, errors.New("journal already exists; use resume mode instead of starting another run set")
		}
		return nil, err
	}
	result := &journal{file: file, path: absolute, state: state}
	if err := lockJournalFile(file); err != nil {
		_ = file.Close()
		return nil, err
	}
	record := journalRecord{Schema: JournalSchemaV1, Sequence: 1, Kind: "header", WrittenAt: now, Header: &header}
	result.state.Sequence = 1
	if err := result.writeRecord(record); err != nil {
		_ = result.Close()
		return nil, err
	}
	return result, nil
}

func openJournal(config Config, endpoint string) (*journal, error) {
	absolute, err := filepath.Abs(config.JournalPath)
	if err != nil {
		return nil, err
	}
	file, err := os.OpenFile(absolute, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		_ = file.Close()
		if err == nil {
			err = errors.New("journal is not a regular non-symlink file")
		}
		return nil, err
	}
	if err := lockJournalFile(file); err != nil {
		_ = file.Close()
		return nil, err
	}
	result := &journal{file: file, path: absolute}
	state, err := readJournal(file)
	if err != nil {
		_ = result.Close()
		return nil, err
	}
	result.state = state
	if err := state.matches(config, endpoint); err != nil {
		_ = result.Close()
		return nil, err
	}
	return result, nil
}

func readJournal(file *os.File) (journalState, error) {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return journalState{}, err
	}
	scanner := bufio.NewScanner(io.LimitReader(file, 64<<20))
	scanner.Buffer(make([]byte, 64*1024), maxJournalRecordBytes)
	state := journalState{Cases: make(map[string]*caseSnapshot)}
	line := 0
	for scanner.Scan() {
		line++
		var record journalRecord
		decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&record); err != nil {
			return journalState{}, fmt.Errorf("decode journal line %d: %w", line, err)
		}
		var trailing any
		if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
			return journalState{}, fmt.Errorf("journal line %d contains trailing JSON data", line)
		}
		if record.Schema != JournalSchemaV1 || record.Sequence != uint64(line) || record.WrittenAt.IsZero() {
			return journalState{}, fmt.Errorf("journal line %d has an invalid envelope", line)
		}
		switch record.Kind {
		case "header":
			if line != 1 || record.Header == nil || record.Event != nil {
				return journalState{}, errors.New("journal header must be the first and only header record")
			}
			state.Header = *record.Header
			if err := initializeJournalCases(&state); err != nil {
				return journalState{}, err
			}
		case "case_state":
			if line == 1 || record.Event == nil || record.Header != nil {
				return journalState{}, fmt.Errorf("journal line %d has an invalid case event", line)
			}
			if err := applyEvent(&state, *record.Event); err != nil {
				return journalState{}, fmt.Errorf("journal line %d: %w", line, err)
			}
		default:
			return journalState{}, fmt.Errorf("journal line %d has an unsupported record kind", line)
		}
		state.Sequence = record.Sequence
	}
	if err := scanner.Err(); err != nil {
		return journalState{}, err
	}
	if line == 0 {
		return journalState{}, errors.New("journal is empty")
	}
	return state, nil
}

func initializeJournalCases(state *journalState) error {
	header := state.Header
	if header.RunOrigin != RunOrigin || !safeIDPattern.MatchString(header.EvalRunSetID) || header.StartedAt.IsZero() ||
		len(header.Cases) != 12 || header.EndpointSHA256 == "" {
		return errors.New("journal header is incomplete")
	}
	if err := header.ProductBuild.Validate(); err != nil {
		return err
	}
	if err := header.Target.Validate(); err != nil {
		return err
	}
	for _, item := range header.Cases {
		if !safeIDPattern.MatchString(item.CaseID) || item.Mode == "" || len(item.PromptSHA256) != sha256.Size*2 {
			return errors.New("journal contains an invalid case registration")
		}
		if _, duplicate := state.Cases[item.CaseID]; duplicate {
			return fmt.Errorf("journal contains duplicate run-set/case mapping %q", item.CaseID)
		}
		state.Cases[item.CaseID] = &caseSnapshot{Registration: item, Event: caseEvent{
			EvalRunSetID: header.EvalRunSetID, CaseID: item.CaseID, State: CaseNotStarted,
		}}
	}
	return nil
}

func (state journalState) matches(config Config, endpoint string) error {
	header := state.Header
	if header.DatasetName != config.Dataset.Name || header.DatasetSHA256 != config.Dataset.SHA256 ||
		header.ProductBuild != config.ProductBuild || header.EndpointSHA256 != endpointSHA256(endpoint) ||
		header.Target != config.Target || header.EvidenceClass != config.EvidenceClass {
		return errors.New("journal does not match the selected dataset, product build, endpoint, target, or evidence class")
	}
	if len(header.Cases) != len(config.Dataset.Cases) {
		return errors.New("journal case count differs from the selected dataset")
	}
	for _, item := range config.Dataset.Cases {
		snapshot := state.Cases[item.ID]
		if snapshot == nil || snapshot.Registration.Mode != item.Mode ||
			snapshot.Registration.PromptSHA256 != promptSHA256(item.Prompt()) {
			return fmt.Errorf("journal case %q differs from the selected dataset", item.ID)
		}
	}
	return nil
}

func applyEvent(state *journalState, event caseEvent) error {
	if event.EvalRunSetID != state.Header.EvalRunSetID {
		return errors.New("case event belongs to a different run set")
	}
	snapshot := state.Cases[event.CaseID]
	if snapshot == nil {
		return errors.New("case event is not registered in the run set")
	}
	if err := validateTransition(snapshot.Event, event); err != nil {
		return err
	}
	snapshot.Event = event
	return nil
}

func validateTransition(previous, next caseEvent) error {
	allowed := false
	switch previous.State {
	case CaseNotStarted:
		allowed = next.State == CaseSubmitting
	case CaseSubmitting:
		allowed = next.State == CaseStarted || next.State == CaseTerminal || next.State == CaseAmbiguous || next.State == CaseSubmissionFailed
	case CaseStarted:
		allowed = next.State == CaseStarted || next.State == CaseTerminal
	}
	if !allowed {
		return fmt.Errorf("invalid runner case transition %s -> %s", previous.State, next.State)
	}
	if next.CaseID != previous.CaseID || next.EvalRunSetID != previous.EvalRunSetID {
		return errors.New("case transition changed immutable identity")
	}
	if next.State == CaseStarted || next.State == CaseTerminal {
		if !safeIDPattern.MatchString(next.RunID) || next.StartedAt == nil {
			return errors.New("started case event requires a valid run id and start time")
		}
	}
	if previous.RunID != "" && next.RunID != previous.RunID {
		return errors.New("case transition changed run id")
	}
	if next.ProductRevision < previous.ProductRevision {
		return errors.New("case transition moved product revision backward")
	}
	if next.State == CaseTerminal && (next.TerminalAt == nil || !observedTerminal(next.ProductStatus)) {
		return errors.New("terminal case event requires an observed terminal product status and time")
	}
	return nil
}

func (journal *journal) appendEvent(event caseEvent, now time.Time) error {
	if err := applyEvent(&journal.state, event); err != nil {
		return err
	}
	journal.state.Sequence++
	record := journalRecord{
		Schema: JournalSchemaV1, Sequence: journal.state.Sequence, Kind: "case_state",
		WrittenAt: now.UTC(), Event: &event,
	}
	if err := journal.writeRecord(record); err != nil {
		return err
	}
	return nil
}

func (journal *journal) writeRecord(record journalRecord) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if len(raw) > maxJournalRecordBytes {
		return errors.New("journal record is too large")
	}
	raw = append(raw, '\n')
	if _, err := journal.file.Seek(0, io.SeekEnd); err != nil {
		return err
	}
	if _, err := journal.file.Write(raw); err != nil {
		return err
	}
	return journal.file.Sync()
}

func (journal *journal) Close() error {
	if journal == nil || journal.file == nil {
		return nil
	}
	unlockErr := unlockJournalFile(journal.file)
	closeErr := journal.file.Close()
	journal.file = nil
	return errors.Join(unlockErr, closeErr)
}

func requireExistingDirectory(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("path is not a directory")
	}
	return nil
}

func writeJSONNew(path string, value any) error {
	absolute, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil {
		return err
	}
	if err := requireExistingDirectory(filepath.Dir(absolute)); err != nil {
		return fmt.Errorf("output parent: %w", err)
	}
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	file, err := os.OpenFile(absolute, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return errors.New("output already exists")
		}
		return err
	}
	committed := false
	defer func() {
		_ = file.Close()
		if !committed {
			_ = os.Remove(absolute)
		}
	}()
	if _, err := file.Write(raw); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	committed = true
	return nil
}
