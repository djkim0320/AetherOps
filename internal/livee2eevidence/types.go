package livee2eevidence

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"time"

	"github.com/djkim0320/AetherOps/internal/livee2econtract"
)

const (
	JournalSchemaV2 = "aetherops_live_end_to_end_journal_v2"
	ResearchPrompt  = livee2econtract.ResearchPrompt
	SPARQLQuery     = livee2econtract.SPARQLQuery
)

type JournalState string

const (
	StatePrepared         JournalState = "PREPARED"
	StateBrowserObserving JournalState = "BROWSER_OBSERVING"
	StateBrowserObserved  JournalState = "BROWSER_OBSERVED"
	StateRunSubmitting    JournalState = "RUN_SUBMITTING"
	StateRunObserved      JournalState = "RUN_OBSERVED"
	StateSPARQLSubmitting JournalState = "SPARQL_SUBMITTING"
	StateSPARQLObserved   JournalState = "SPARQL_OBSERVED"
	StateEditSubmitting   JournalState = "EDIT_SUBMITTING"
	StateLiveComplete     JournalState = "LIVE_COMPLETE"
)

type JournalRecord struct {
	Schema               string                               `json:"schema"`
	JournalID            string                               `json:"journal_id"`
	Sequence             int                                  `json:"sequence"`
	PreviousRecordSHA256 string                               `json:"previous_record_sha256,omitempty"`
	State                JournalState                         `json:"state"`
	WrittenAt            time.Time                            `json:"written_at"`
	Binding              *livee2econtract.Binding             `json:"binding,omitempty"`
	Browser              *livee2econtract.BrowserObservation  `json:"browser,omitempty"`
	Run                  *livee2econtract.RunObservation      `json:"run,omitempty"`
	SPARQL               *livee2econtract.SPARQLObservation   `json:"sparql,omitempty"`
	Curation             *livee2econtract.CurationObservation `json:"curation,omitempty"`
	RecordSHA256         string                               `json:"-"`
}

type LiveObservation struct {
	Binding       livee2econtract.Binding
	Browser       livee2econtract.BrowserObservation
	Run           livee2econtract.RunObservation
	SPARQL        livee2econtract.SPARQLObservation
	Curation      livee2econtract.CurationObservation
	JournalSHA256 string
	StartedAt     time.Time
	FinishedAt    time.Time
}

type FinalizeResult struct {
	Details       livee2econtract.Details
	SubjectHashes map[string]string
}

var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func validDigest(value string) bool { return digestPattern.MatchString(value) }

func sha256Text(domain, value string) string {
	digest := sha256.Sum256([]byte(domain + "\x00" + value))
	return hex.EncodeToString(digest[:])
}
