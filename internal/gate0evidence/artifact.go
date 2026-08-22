// Package gate0evidence validates the fixed Windows Gate 0 artifact that is
// admitted into release evidence. It is platform-neutral so the producer and
// the release gate cannot drift onto different interpretations of success.
package gate0evidence

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

const OperationalSchema = "aetherops.gate0.windows.operational.v1"

var requiredOperationalChecks = [...]string{
	"devtools_mcp_control",
	"multi_tab",
	"korean_ime_input",
	"per_monitor_v2_dpi",
	"tray_restore",
	"profile_persistence",
	"emergency_stop",
	"manual_resume_reobservation",
	"private_network_block",
	"dns_rebinding_block",
}

// RequiredOperationalCheckIDs returns a copy of the fixed operational
// contract so the Windows harness and release validator share one source.
func RequiredOperationalCheckIDs() []string {
	return append([]string(nil), requiredOperationalChecks[:]...)
}

type Environment struct {
	UserDataDir                 string `json:"userDataDir"`
	UserDataDirExists           bool   `json:"userDataDirExists"`
	CDPPort                     int    `json:"cdpPort,omitempty"`
	CDPDisabledByConfiguration  bool   `json:"cdpDisabledByConfiguration"`
	CDPLoopbackConfigured       bool   `json:"cdpLoopbackConfigured"`
	CDPEndpointLive             bool   `json:"cdpEndpointLive"`
	DownloadDir                 string `json:"downloadDir,omitempty"`
	DownloadDirExists           bool   `json:"downloadDirExists"`
	DownloadIsolationConfigured bool   `json:"downloadIsolationConfigured"`
}

type Security struct {
	WebMessagesDisabled              bool `json:"webMessagesDisabled"`
	HostObjectsDisabled              bool `json:"hostObjectsDisabled"`
	DevToolsUIDisabled               bool `json:"devToolsUIDisabled"`
	PasswordAutosaveDisabled         bool `json:"passwordAutosaveDisabled"`
	GeneralAutofillDisabled          bool `json:"generalAutofillDisabled"`
	PermissionDenyHandlerInstalled   bool `json:"permissionDenyHandlerInstalled"`
	NativeBridgeAbsentByConstruction bool `json:"nativeBridgeAbsentByConstruction"`
	NativeBridgeRuntimeEnumerable    bool `json:"nativeBridgeRuntimeEnumerable"`
}

type OperationalCheck struct {
	ID         string    `json:"id"`
	Executed   bool      `json:"executed"`
	Passed     bool      `json:"passed"`
	ObservedAt time.Time `json:"observedAt,omitempty"`
	Evidence   string    `json:"evidence,omitempty"`
	Blocker    string    `json:"blocker,omitempty"`
}

type OperationalReport struct {
	Schema    string             `json:"schema"`
	Checks    []OperationalCheck `json:"checks"`
	Blockers  []string           `json:"blockers,omitempty"`
	Compliant bool               `json:"compliant"`
}

type Artifact struct {
	RuntimeVersion string            `json:"runtimeVersion"`
	Shell          Environment       `json:"shell"`
	Internet       Environment       `json:"internet"`
	Security       Security          `json:"security"`
	Operational    OperationalReport `json:"operational"`
	Limitations    []string          `json:"limitations,omitempty"`
	Failures       []string          `json:"failures,omitempty"`
	Compliant      bool              `json:"compliant"`
}

// Validate accepts only a complete artifact observed inside the command
// window. Zero window bounds are rejected because untimed behavior is not
// admissible release evidence.
func Validate(raw []byte, observationStartedAt, observationFinishedAt time.Time) error {
	if observationStartedAt.IsZero() || observationFinishedAt.IsZero() || observationFinishedAt.Before(observationStartedAt) {
		return errors.New("Gate 0 observation window is invalid")
	}
	var report Artifact
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&report); err != nil {
		return fmt.Errorf("decode Gate 0 artifact: %w", err)
	}
	if err := requireJSONEOF(decoder); err != nil {
		return err
	}
	if !report.Compliant || len(report.Failures) != 0 || strings.TrimSpace(report.RuntimeVersion) == "" {
		return errors.New("Gate 0 artifact does not declare one complete successful runtime observation")
	}
	if strings.TrimSpace(report.Shell.UserDataDir) == "" || strings.TrimSpace(report.Internet.UserDataDir) == "" ||
		equalWindowsPath(report.Shell.UserDataDir, report.Internet.UserDataDir) {
		return errors.New("Gate 0 shell and internet environments are not distinct")
	}
	baseChecks := []bool{
		report.Shell.UserDataDirExists, report.Shell.CDPDisabledByConfiguration,
		report.Internet.UserDataDirExists, report.Internet.CDPPort > 0, report.Internet.CDPPort <= 65535,
		report.Internet.CDPLoopbackConfigured, report.Internet.CDPEndpointLive,
		report.Internet.DownloadDirExists, report.Internet.DownloadIsolationConfigured,
		report.Security.WebMessagesDisabled, report.Security.HostObjectsDisabled,
		report.Security.DevToolsUIDisabled, report.Security.PasswordAutosaveDisabled,
		report.Security.GeneralAutofillDisabled, report.Security.PermissionDenyHandlerInstalled,
		report.Security.NativeBridgeAbsentByConstruction,
	}
	for _, passed := range baseChecks {
		if !passed {
			return errors.New("Gate 0 artifact omits a required environment or security observation")
		}
	}
	if report.Operational.Schema != OperationalSchema || !report.Operational.Compliant || len(report.Operational.Blockers) != 0 {
		return errors.New("Gate 0 operational report is absent, blocked, or uses an unsupported schema")
	}
	if len(report.Operational.Checks) != len(requiredOperationalChecks) {
		return fmt.Errorf("Gate 0 operational report has %d checks; want %d", len(report.Operational.Checks), len(requiredOperationalChecks))
	}
	required := make(map[string]struct{}, len(requiredOperationalChecks))
	for _, id := range requiredOperationalChecks {
		required[id] = struct{}{}
	}
	seen := make(map[string]struct{}, len(requiredOperationalChecks))
	for _, check := range report.Operational.Checks {
		if _, ok := required[check.ID]; !ok {
			return fmt.Errorf("Gate 0 operational report contains unknown check %q", check.ID)
		}
		if _, duplicate := seen[check.ID]; duplicate {
			return fmt.Errorf("Gate 0 operational report duplicates check %q", check.ID)
		}
		seen[check.ID] = struct{}{}
		if !check.Executed || !check.Passed || strings.TrimSpace(check.Evidence) == "" || strings.TrimSpace(check.Blocker) != "" {
			return fmt.Errorf("Gate 0 operational check %q is not a complete passed observation", check.ID)
		}
		if check.ObservedAt.IsZero() || check.ObservedAt.Before(observationStartedAt) || check.ObservedAt.After(observationFinishedAt) {
			return fmt.Errorf("Gate 0 operational check %q is outside the observation window", check.ID)
		}
	}
	return nil
}

func equalWindowsPath(left, right string) bool {
	normalize := func(value string) string {
		value = strings.TrimSpace(strings.ReplaceAll(value, "/", `\`))
		for strings.HasSuffix(value, `\`) && len(value) > 3 {
			value = strings.TrimSuffix(value, `\`)
		}
		return value
	}
	return strings.EqualFold(normalize(left), normalize(right))
}

func requireJSONEOF(decoder *json.Decoder) error {
	var trailing any
	err := decoder.Decode(&trailing)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("decode trailing Gate 0 artifact data: %w", err)
	}
	return errors.New("Gate 0 artifact contains trailing JSON values")
}
