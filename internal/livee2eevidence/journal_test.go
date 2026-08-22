package livee2eevidence

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/livee2econtract"
)

func testDigest(character string) string { return strings.Repeat(character, 64) }

func writeCompletedTestJournal(t *testing.T, path string) LiveObservation {
	t.Helper()
	base := time.Date(2026, 8, 9, 1, 0, 0, 0, time.UTC)
	binding := livee2econtract.Binding{
		ProductBuild: buildinfo.ProductBuildBinding{
			Version: buildinfo.ReleaseProductVersion, ExecutableSHA256: testDigest("a"),
			RuntimeManifestSHA256: testDigest("b"), KnowledgeSidecarTreeSHA256: testDigest("c"),
		},
		ReleaseCandidateID: testDigest("d"), PreparedLedgerSHA256: testDigest("e"),
		PreparedLedgerRevision: 3, LedgerPreparedAt: base.Add(-2 * time.Minute),
		RunnerReceiptSHA256: testDigest("f"), EvaluationSHA256: testDigest("1"),
		EvalRunSetID: "ers_live", DatasetSHA256: testDigest("2"),
		RunnerEndpointSHA256: testDigest("3"), EvaluationVerifiedAt: base.Add(-90 * time.Second),
		ObservationSessionDescriptorSHA256: testDigest("4"), ObservationEndpointSHA256: testDigest("5"),
		ObservationSessionStartedAt: base.Add(-time.Minute), ProjectID: "prj_live", PromptSHA256: testDigest("6"),
	}
	browser := livee2econtract.BrowserObservation{
		Executed: true, Compatible: true,
		Observation: "Chrome DevTools MCP list_pages and take_snapshot succeeded",
		ObservedAt:  base.Add(2 * time.Second),
	}
	run := livee2econtract.RunObservation{
		RunID: "run_live", ProjectID: binding.ProjectID, ConversationSessionID: "ses_live",
		ReportArtifactID: "art_report", Status: "succeeded", Revision: 8,
		CreatedAt: base.Add(4 * time.Second), TerminalAt: base.Add(6 * time.Second),
	}
	sparql := livee2econtract.SPARQLObservation{
		GenerationID: "kgen_live", QuerySHA256: testDigest("6"), ResultSHA256: testDigest("7"),
		QueryForm: "SELECT", Complete: true, ResponseBytes: 31,
	}
	curation := livee2econtract.CurationObservation{
		EventID: "kce_live", Sequence: 1, GenerationID: sparql.GenerationID, Kind: "pin_entity",
		PayloadSHA256: testDigest("8"), EventSHA256: testDigest("9"),
		MemoBlobSHA256: testDigest("a"), EntityID: "kent_live",
	}
	writer, err := createJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	records := []JournalRecord{
		{State: StatePrepared, WrittenAt: base, Binding: &binding},
		{State: StateBrowserObserving, WrittenAt: base.Add(time.Second)},
		{State: StateBrowserObserved, WrittenAt: base.Add(2 * time.Second), Browser: &browser},
		{State: StateRunSubmitting, WrittenAt: base.Add(3 * time.Second)},
		{State: StateRunObserved, WrittenAt: base.Add(6 * time.Second), Run: &run},
		{State: StateSPARQLSubmitting, WrittenAt: base.Add(7 * time.Second)},
		{State: StateSPARQLObserved, WrittenAt: base.Add(8 * time.Second), SPARQL: &sparql},
		{State: StateEditSubmitting, WrittenAt: base.Add(9 * time.Second)},
		{State: StateLiveComplete, WrittenAt: base.Add(10 * time.Second), Curation: &curation},
	}
	for _, record := range records {
		if err := writer.append(record); err != nil {
			_ = writer.close()
			t.Fatal(err)
		}
	}
	if err := writer.close(); err != nil {
		t.Fatal(err)
	}
	observation, err := LoadCompletedJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	return observation
}

func TestCompletedJournalRoundTripAndExclusiveCreation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "live-e2e.journal.jsonl")
	observation := writeCompletedTestJournal(t, path)
	if observation.Run.RunID != "run_live" || observation.SPARQL.GenerationID != "kgen_live" ||
		observation.Curation.EventID != "kce_live" || !validDigest(observation.JournalSHA256) {
		t.Fatalf("unexpected observation: %+v", observation)
	}
	if _, err := createJournal(path); err == nil {
		t.Fatal("existing journal was overwritten")
	}
}

func TestJournalRejectsTornAndIncompleteSideEffectBoundaries(t *testing.T) {
	root := t.TempDir()
	validPath := filepath.Join(root, "valid.jsonl")
	writeCompletedTestJournal(t, validPath)
	raw, err := os.ReadFile(validPath)
	if err != nil {
		t.Fatal(err)
	}
	tornPath := filepath.Join(root, "torn.jsonl")
	if err := os.WriteFile(tornPath, raw[:len(raw)-1], 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCompletedJournal(tornPath); err == nil {
		t.Fatal("torn final record was accepted")
	}
	lines := strings.Split(string(raw), "\n")
	incompletePath := filepath.Join(root, "ambiguous-submit.jsonl")
	// Stop immediately after RUN_SUBMITTING. The write may have reached the
	// product, so the journal is deliberately ineligible and must never be
	// replayed by the offline finalizer.
	incomplete := strings.Join(lines[:4], "\n") + "\n"
	if err := os.WriteFile(incompletePath, []byte(incomplete), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCompletedJournal(incompletePath); err == nil {
		t.Fatal("ambiguous submitting boundary was accepted as completed evidence")
	}
}

func TestJournalRejectsRetiredV1Schema(t *testing.T) {
	root := t.TempDir()
	validPath := filepath.Join(root, "valid-v2.jsonl")
	writeCompletedTestJournal(t, validPath)
	raw, err := os.ReadFile(validPath)
	if err != nil {
		t.Fatal(err)
	}
	retired := strings.Replace(string(raw), JournalSchemaV2, "aetherops_live_end_to_end_journal_v1", 1)
	retiredPath := filepath.Join(root, "retired-v1.jsonl")
	if err := os.WriteFile(retiredPath, []byte(retired), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCompletedJournal(retiredPath); err == nil {
		t.Fatal("retired v1 journal schema was accepted")
	}
}

func TestObservationSessionMustStartAfterEvaluation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "valid-v2.jsonl")
	observation := writeCompletedTestJournal(t, path)
	if observation.Binding.RunnerEndpointSHA256 == observation.Binding.ObservationEndpointSHA256 {
		t.Fatal("structural journal vector did not separate runner and observation endpoints")
	}
	observation.Binding.ObservationSessionStartedAt = observation.Binding.EvaluationVerifiedAt.Add(-time.Nanosecond)
	if err := validateLiveObservation(observation); err == nil {
		t.Fatal("observation session predating evaluation verification was accepted")
	}
}
