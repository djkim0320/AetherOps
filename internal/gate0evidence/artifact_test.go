package gate0evidence

import (
	"encoding/json"
	"testing"
	"time"
)

func TestValidateRequiresEveryOperationalObservation(t *testing.T) {
	started := time.Unix(1_800_000_000, 0).UTC()
	finished := started.Add(time.Minute)
	valid := validArtifact(started.Add(time.Second))
	if err := Validate(mustJSON(t, valid), started, finished); err != nil {
		t.Fatalf("valid artifact rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*Artifact)
	}{
		{"missing_operational", func(value *Artifact) { value.Operational = OperationalReport{} }},
		{"wrong_schema", func(value *Artifact) { value.Operational.Schema = "retired" }},
		{"missing_check", func(value *Artifact) { value.Operational.Checks = value.Operational.Checks[1:] }},
		{"duplicate_check", func(value *Artifact) { value.Operational.Checks[1] = value.Operational.Checks[0] }},
		{"unknown_check", func(value *Artifact) { value.Operational.Checks[0].ID = "fabricated" }},
		{"not_executed", func(value *Artifact) { value.Operational.Checks[0].Executed = false }},
		{"failed", func(value *Artifact) { value.Operational.Checks[0].Passed = false }},
		{"empty_evidence", func(value *Artifact) { value.Operational.Checks[0].Evidence = " " }},
		{"check_blocker", func(value *Artifact) { value.Operational.Checks[0].Blocker = "blocked" }},
		{"report_blocker", func(value *Artifact) { value.Operational.Blockers = []string{"blocked"} }},
		{"zero_time", func(value *Artifact) { value.Operational.Checks[0].ObservedAt = time.Time{} }},
		{"time_before_window", func(value *Artifact) { value.Operational.Checks[0].ObservedAt = started.Add(-time.Nanosecond) }},
		{"same_profile", func(value *Artifact) { value.Internet.UserDataDir = value.Shell.UserDataDir }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var mutated Artifact
			if err := json.Unmarshal(mustJSON(t, valid), &mutated); err != nil {
				t.Fatal(err)
			}
			test.mutate(&mutated)
			if err := Validate(mustJSON(t, mutated), started, finished); err == nil {
				t.Fatal("mutated Gate 0 artifact was accepted")
			}
		})
	}
}

func TestValidateRejectsUnknownAndTrailingJSON(t *testing.T) {
	started := time.Unix(1_800_000_000, 0).UTC()
	valid := mustJSON(t, validArtifact(started.Add(time.Second)))
	withUnknown := append(valid[:len(valid)-1], []byte(`,"fabricated":true}`)...)
	if err := Validate(withUnknown, started, started.Add(time.Minute)); err == nil {
		t.Fatal("unknown field was accepted")
	}
	if err := Validate(append(valid, []byte(` {}`)...), started, started.Add(time.Minute)); err == nil {
		t.Fatal("trailing JSON value was accepted")
	}
}

func validArtifact(observedAt time.Time) Artifact {
	value := Artifact{RuntimeVersion: "151.0.4129.72", Compliant: true}
	value.Shell = Environment{UserDataDir: `C:\\gate0\\shell`, UserDataDirExists: true, CDPDisabledByConfiguration: true}
	value.Internet = Environment{
		UserDataDir: `C:\\gate0\\internet`, UserDataDirExists: true, CDPPort: 12345,
		CDPLoopbackConfigured: true, CDPEndpointLive: true, DownloadDir: `C:\\gate0\\downloads`,
		DownloadDirExists: true, DownloadIsolationConfigured: true,
	}
	value.Security = Security{
		WebMessagesDisabled: true, HostObjectsDisabled: true, DevToolsUIDisabled: true,
		PasswordAutosaveDisabled: true, GeneralAutofillDisabled: true,
		PermissionDenyHandlerInstalled: true, NativeBridgeAbsentByConstruction: true,
	}
	value.Operational = OperationalReport{Schema: OperationalSchema, Compliant: true}
	for _, id := range requiredOperationalChecks {
		value.Operational.Checks = append(value.Operational.Checks, OperationalCheck{
			ID: id, Executed: true, Passed: true, ObservedAt: observedAt, Evidence: "actual observation",
		})
	}
	return value
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
