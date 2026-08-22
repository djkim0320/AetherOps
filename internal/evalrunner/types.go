package evalrunner

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/evalgate"
)

const (
	JournalSchemaV1 = "aetherops_release_eval_runner_journal_v1"
	ReceiptSchemaV1 = "aetherops_release_eval_runner_receipt_v1"
	RunOrigin       = "release_eval_runner"

	EvidenceLiveProductAPI  = "live_product_api_observation"
	EvidenceProtocolFixture = "protocol_fixture_non_release"
)

type CaseState string

const (
	CaseNotStarted       CaseState = "NOT_STARTED"
	CaseSubmitting       CaseState = "SUBMITTING"
	CaseStarted          CaseState = "STARTED"
	CaseAmbiguous        CaseState = "AMBIGUOUS"
	CaseSubmissionFailed CaseState = "SUBMISSION_FAILED"
	CaseTerminal         CaseState = "TERMINAL"
)

var safeIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

var ErrRunSetIncomplete = errors.New("release evaluation run set is not eligible for offline verification")

type Target struct {
	ProjectID string `json:"project_id,omitempty"`
	SessionID string `json:"session_id,omitempty"`
}

func (target Target) Validate() error {
	projectID := strings.TrimSpace(target.ProjectID)
	sessionID := strings.TrimSpace(target.SessionID)
	if (projectID == "") == (sessionID == "") {
		return errors.New("exactly one target project id or session id is required")
	}
	value := projectID
	if value == "" {
		value = sessionID
	}
	if !safeIDPattern.MatchString(value) {
		return errors.New("target id has an invalid format")
	}
	return nil
}

type Config struct {
	Dataset       evalgate.Dataset
	ProductBuild  evalgate.ProductBuildBinding
	Endpoint      string
	Token         []byte
	Target        Target
	JournalPath   string
	OutputPath    string
	PollInterval  time.Duration
	HTTPClient    *http.Client
	EvidenceClass string
	Now           func() time.Time
	NewRunSetID   func() (string, error)
}

func (config Config) validate() error {
	if err := config.Dataset.Validate(); err != nil {
		return err
	}
	if err := config.ProductBuild.Validate(); err != nil {
		return fmt.Errorf("evaluation product build: %w", err)
	}
	if err := config.Target.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(config.JournalPath) == "" || strings.TrimSpace(config.OutputPath) == "" {
		return errors.New("journal and output paths are required")
	}
	if config.PollInterval < 0 || config.PollInterval > time.Minute {
		return errors.New("poll interval must be between zero and one minute")
	}
	if config.EvidenceClass != EvidenceLiveProductAPI && config.EvidenceClass != EvidenceProtocolFixture {
		return errors.New("an explicit runner evidence class is required")
	}
	if len(config.Token) == 0 {
		return errors.New("API token is required")
	}
	return nil
}

type ApprovalObservation struct {
	ID                 string `json:"id"`
	Kind               string `json:"kind"`
	Summary            string `json:"summary"`
	Server             string `json:"server,omitempty"`
	Tool               string `json:"tool,omitempty"`
	Risk               string `json:"risk"`
	ExternalSideEffect bool   `json:"external_side_effect"`
	Status             string `json:"status"`
}

type CaseReceipt struct {
	RunOrigin        string                `json:"run_origin"`
	EvalRunSetID     string                `json:"eval_run_set_id"`
	DatasetCaseID    string                `json:"dataset_case_id"`
	Mode             string                `json:"mode"`
	PromptSHA256     string                `json:"prompt_sha256"`
	State            CaseState             `json:"state"`
	RunID            string                `json:"run_id,omitempty"`
	ProductStatus    core.RunStatus        `json:"product_status,omitempty"`
	ProductRevision  int64                 `json:"product_revision,omitempty"`
	StartedAt        *time.Time            `json:"started_at,omitempty"`
	TerminalAt       *time.Time            `json:"terminal_at,omitempty"`
	PendingApprovals []ApprovalObservation `json:"pending_approvals,omitempty"`
	FailureCode      string                `json:"failure_code,omitempty"`
}

type Completeness struct {
	ExpectedCases          int  `json:"expected_cases"`
	AccountedCases         int  `json:"accounted_cases"`
	RunnerTerminalCases    int  `json:"runner_terminal_cases"`
	ProductTerminalCases   int  `json:"product_terminal_cases"`
	AmbiguousCases         int  `json:"ambiguous_cases"`
	SubmissionFailures     int  `json:"submission_failures"`
	AllProductRunsTerminal bool `json:"all_product_runs_terminal"`
}

type Receipt struct {
	Schema                         string                       `json:"schema"`
	RunOrigin                      string                       `json:"run_origin"`
	EvidenceClass                  string                       `json:"evidence_class"`
	ReleaseGatePassed              bool                         `json:"release_gate_passed"`
	RequiresOfflineVerification    bool                         `json:"requires_offline_verification"`
	EligibleForOfflineVerification bool                         `json:"eligible_for_offline_verification"`
	EvalRunSetID                   string                       `json:"eval_run_set_id"`
	DatasetName                    string                       `json:"dataset_name"`
	DatasetSHA256                  string                       `json:"dataset_sha256"`
	ProductBuild                   evalgate.ProductBuildBinding `json:"product_build"`
	EndpointSHA256                 string                       `json:"endpoint_sha256"`
	Target                         Target                       `json:"target"`
	StartedAt                      time.Time                    `json:"started_at"`
	TerminalAt                     time.Time                    `json:"terminal_at"`
	Completeness                   Completeness                 `json:"completeness"`
	Cases                          []CaseReceipt                `json:"cases"`
	SHA256                         string                       `json:"-"`
}

func observedTerminal(status core.RunStatus) bool {
	switch status {
	case core.RunSucceeded, core.RunQualityFailed, core.RunFailed, core.RunCancelled,
		core.RunInterrupted, core.RunUncertain:
		return true
	default:
		return false
	}
}
