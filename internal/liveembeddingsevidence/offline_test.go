package liveembeddingsevidence

import (
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/releasegate"
	"github.com/djkim0320/Aether-claw/internal/store"
)

func TestIsolatedReceiptRejectsFixtureOrMissingSubjects(t *testing.T) {
	digest := strings.Repeat("1", 64)
	build := buildinfo.ProductBuildBinding{
		Version: buildinfo.ReleaseProductVersion, ExecutableSHA256: digest,
		RuntimeManifestSHA256: strings.Repeat("2", 64), KnowledgeSidecarTreeSHA256: strings.Repeat("3", 64),
	}
	candidateID, err := releasegate.CandidateID(build)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	details := Details{
		Schema: DetailsSchemaV1, ReleaseCandidateID: candidateID, PreparedLedgerSHA256: strings.Repeat("4", 64),
		RunnerReceiptSHA256: strings.Repeat("5", 64), LiveJournalSHA256: strings.Repeat("6", 64),
		OfflineVerifiedAt: now, CASObjectsVerified: 1, DeterministicDocuments: 1, SearchResultsReadBack: 1,
		FixtureRole: "protocol_fixture_non_release", ReleaseGateEligible: true, NoAmbiguousPOSTRetried: true,
		Before: store.ProjectMemoryHead{ActiveIndexID: "idx_old"}, ObservedIndex: store.EmbeddingIndex{ID: "idx_new"},
		DurableProof: store.MemoryShadowReleaseProof{PreviousIndexID: "idx_old", ActiveIndexID: "idx_new", VectorSetSHA256: strings.Repeat("7", 64)},
	}
	receipt := releasegate.EvidenceReceipt{
		Schema: releasegate.EvidenceSchemaV1, GateID: "live_embeddings_shadow", EvidenceKind: releasegate.EvidenceLiveService,
		ReleaseCandidateID: candidateID, ProductBuild: build, Producer: releasegate.Producer{Name: ProducerName, Version: ProducerVersion},
		Environment: releasegate.Environment{Class: string(releasegate.EvidenceLiveService), OS: "windows-11", Architecture: "amd64", IdentitySHA256: digest},
		ObservedAt:  now, Status: "passed", DetailsSHA256: strings.Repeat("8", 64),
	}
	if err := ValidateIsolatedReceipt(receipt, details); err == nil || !strings.Contains(err.Error(), "contract") {
		t.Fatalf("fixture was accepted as release evidence: %v", err)
	}
	details.FixtureRole = "none"
	if err := ValidateIsolatedReceipt(receipt, details); err == nil {
		t.Fatalf("missing subjects were accepted: %v", err)
	}
}
