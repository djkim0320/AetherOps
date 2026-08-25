// Package localreleaseevidence runs the fixed, local-only release checks and
// emits audit details for one already prepared release candidate. It is not
// linked into the AetherOps desktop executable.
package localreleaseevidence

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
)

const (
	DetailsSchemaV2 = "aetherops_local_release_evidence_details_v2"
	ProducerName    = "cmd/localreleaseevidence"
	ProducerVersion = "2"

	GateLocalSourceTests = "local_source_tests"
	GateWindowsHost      = "gate0_windows_host"
	GateRAG50000         = "rag_50000"
	GateScheduler        = "scheduler_recovery"

	maxCapturedStreamBytes = 128 << 10
)

var ErrGateFailed = errors.New("local release evidence gate failed")

// Config contains paths only. Commands, arguments, environments, timeouts,
// and gate identifiers are deliberately not caller-configurable.
type Config struct {
	GateID                     string
	LedgerPath                 string
	OutputPath                 string
	AetherOpsExecutablePath    string
	RuntimeManifestPath        string
	KnowledgeSidecarEntrypoint string
}

type EnvironmentDetails struct {
	OS                  string `json:"os"`
	Architecture        string `json:"architecture"`
	GoVersion           string `json:"go_version"`
	LogicalProcessors   int    `json:"logical_processors"`
	ProcessorIdentifier string `json:"processor_identifier,omitempty"`
	WindowsVersion      string `json:"windows_version"`
}

type StreamObservation struct {
	Bytes         int64  `json:"bytes"`
	CapturedBytes int    `json:"captured_bytes"`
	SHA256        string `json:"sha256"`
	Truncated     bool   `json:"truncated"`
	Text          string `json:"text"`
}

type EnvironmentVariable struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type CommandObservation struct {
	ID          string                `json:"id"`
	Executable  string                `json:"executable"`
	Arguments   []string              `json:"arguments"`
	Environment []EnvironmentVariable `json:"environment,omitempty"`
	WorkingDir  string                `json:"working_directory"`
	Timeout     string                `json:"timeout"`
	StartedAt   time.Time             `json:"started_at"`
	FinishedAt  time.Time             `json:"finished_at"`
	ExitCode    int                   `json:"exit_code"`
	StartError  string                `json:"start_error,omitempty"`
	Stdout      StreamObservation     `json:"stdout"`
	Stderr      StreamObservation     `json:"stderr"`
}

type Validation struct {
	ID      string `json:"id"`
	Passed  bool   `json:"passed"`
	Failure string `json:"failure,omitempty"`
}

type Details struct {
	Schema                string                        `json:"schema"`
	GateID                string                        `json:"gate_id"`
	ReleaseCandidateID    string                        `json:"release_candidate_id"`
	LedgerSHA256          string                        `json:"ledger_sha256"`
	LedgerPreparedAt      time.Time                     `json:"ledger_prepared_at"`
	ObservationStartedAt  time.Time                     `json:"observation_started_at"`
	ObservationFinishedAt time.Time                     `json:"observation_finished_at"`
	CandidateBefore       buildinfo.ProductBuildBinding `json:"candidate_before"`
	CandidateAfter        buildinfo.ProductBuildBinding `json:"candidate_after"`
	SourceTreeSHA256      string                        `json:"source_tree_sha256,omitempty"`
	SourceFileCount       int                           `json:"source_file_count,omitempty"`
	Environment           EnvironmentDetails            `json:"environment"`
	Commands              []CommandObservation          `json:"commands"`
	Validations           []Validation                  `json:"validations"`
	GateArtifact          json.RawMessage               `json:"gate_artifact,omitempty"`
	GateArtifactSHA256    string                        `json:"gate_artifact_sha256,omitempty"`
	ReleaseEligibleRunner bool                          `json:"release_eligible_runner"`
	EvidenceScope         []string                      `json:"evidence_scope"`
	ExcludedReleaseClaims []string                      `json:"excluded_release_claims"`
}

type commandSpec struct {
	ID          string
	Executable  string
	Arguments   []string
	Environment []EnvironmentVariable
	Timeout     time.Duration
}

var schedulerContractTests = []string{
	"TestScheduleParsing",
	"TestCoalesceMissed",
	"TestCronSkipsNonexistentDSTWallClock",
	"TestCronEnumeratesBothAutumnDSTWallClockOccurrences",
	"TestServiceCoalescesDowntimeAndDoesNotDuplicate",
	"TestServiceLongDowntimeCatchUpAdvancesInBoundedRestartSafePages",
	"TestServiceBlocksScheduleWhenMainThreadIsLost",
	"TestServiceAutumnDSTOccurrencesAreDistinctAndRestartSafe",
	"TestServiceCoalescesRepeatedAutumnDSTWallClockAfterDowntime",
	"TestServiceRestartAfterClaimAdvancesWithoutDuplicate",
	"TestServiceLeavesWaitingApprovalRunAndQueuesNextOccurrenceOnce",
	"TestServiceRestartExpiresWaitingApprovalAndQueuesNextOccurrenceOnce",
	"TestServiceBlocksScheduledRunWhileKnowledgeGraphIsStale",
}
