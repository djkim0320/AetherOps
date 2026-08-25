package releasegate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/rag"
	"github.com/djkim0320/AetherOps/internal/store"
)

func TestLiveEmbeddingsTypedVerifierBindsImmediatePredecessorAndExactSubjects(t *testing.T) {
	details, receipt := validLiveEmbeddingsFixture(t)
	raw := mustJSON(t, details)
	if err := ValidateLiveEmbeddingsShadowEvidenceForLedger(raw, receipt, details.PreparedLedgerRevision, details.LedgerPreparedAt); err != nil {
		t.Fatalf("valid live embeddings fixture was rejected: %v", err)
	}

	t.Run("predecessor revision", func(t *testing.T) {
		if err := ValidateLiveEmbeddingsShadowEvidenceForLedger(raw, receipt, details.PreparedLedgerRevision+1, details.LedgerPreparedAt); err == nil {
			t.Fatal("wrong immediate predecessor revision was accepted")
		}
	})
	t.Run("extra subject", func(t *testing.T) {
		mutated := receipt
		mutated.SubjectHashes = append(append([]SubjectHash(nil), receipt.SubjectHashes...), SubjectHash{Name: "unreviewed", SHA256: strings.Repeat("f", 64)})
		if err := ValidateLiveEmbeddingsShadowEvidenceForLedger(raw, mutated, details.PreparedLedgerRevision, details.LedgerPreparedAt); err == nil {
			t.Fatal("extra subject was accepted")
		}
	})
	t.Run("search set mutation", func(t *testing.T) {
		mutated := details
		mutated.Search.SetSHA256 = strings.Repeat("f", 64)
		mutatedRaw := mustJSON(t, mutated)
		mutatedReceipt := receipt
		mutatedReceipt.SubjectHashes = append([]SubjectHash(nil), receipt.SubjectHashes...)
		mutatedReceipt.DetailsSHA256 = testDigest(mutatedRaw)
		setTestSubject(&mutatedReceipt, "live-embeddings-shadow-details", mutatedReceipt.DetailsSHA256)
		if err := ValidateLiveEmbeddingsShadowEvidenceForLedger(mutatedRaw, mutatedReceipt, details.PreparedLedgerRevision, details.LedgerPreparedAt); err == nil {
			t.Fatal("mutated search result-set hash was accepted")
		}
	})
}

func TestLiveEmbeddingsTypedVerifierRejectsUnknownDetailsField(t *testing.T) {
	details, receipt := validLiveEmbeddingsFixture(t)
	raw := mustJSON(t, details)
	raw = append(raw[:len(raw)-1], []byte(`,"fallback":true}`)...)
	receipt.DetailsSHA256 = testDigest(raw)
	setTestSubject(&receipt, "live-embeddings-shadow-details", receipt.DetailsSHA256)
	if err := ValidateLiveEmbeddingsShadowEvidenceForLedger(raw, receipt, details.PreparedLedgerRevision, details.LedgerPreparedAt); err == nil {
		t.Fatal("unknown live embeddings details field was accepted")
	}
}

func validLiveEmbeddingsFixture(t *testing.T) (liveEmbeddingsDetails, EvidenceReceipt) {
	t.Helper()
	build := testBuild("7")
	candidateID, err := CandidateID(build)
	if err != nil {
		t.Fatal(err)
	}
	preparedAt := time.Unix(1_700_000_000, 0).UTC()
	completedOld := preparedAt.Add(-time.Hour)
	completedNew := preparedAt.Add(3 * time.Minute)
	oldIndex := store.EmbeddingIndex{
		ID: "index-old", ProjectID: "project-release", Model: rag.EmbeddingModel, Dimensions: rag.EmbeddingDimensions,
		State: "active", CreatedAt: preparedAt.Add(-2 * time.Hour), CompletedAt: &completedOld,
	}
	newIndex := store.EmbeddingIndex{
		ID: "index-new", ProjectID: "project-release", Model: rag.EmbeddingModel, Dimensions: rag.EmbeddingDimensions,
		State: "active", CreatedAt: preparedAt.Add(time.Minute), CompletedAt: &completedNew,
	}
	before := store.ProjectMemoryHead{
		ProjectID: "project-release", ActiveIndexID: oldIndex.ID, MemoryRevision: 4, State: "ready",
		UpdatedAt: completedOld, ActiveIndex: &oldIndex,
	}
	after := store.ProjectMemoryHead{
		ProjectID: "project-release", ActiveIndexID: newIndex.ID, MemoryRevision: 5, State: "ready",
		UpdatedAt: completedNew, ActiveIndex: &newIndex,
	}
	results := []liveEmbeddingSearchResult{{
		ChunkID: "chunk-1", DocumentID: "document-1", TextSHA256: strings.Repeat("1", 64), Score: 0.75,
	}}
	resultRaw, _ := json.Marshal(results)
	resultDigest := sha256.Sum256(resultRaw)
	details := liveEmbeddingsDetails{
		Schema: liveEmbeddingsDetailsSchemaV1, ReleaseCandidateID: candidateID,
		PreparedLedgerSHA256: strings.Repeat("2", 64), PreparedLedgerRevision: 2, LedgerPreparedAt: preparedAt,
		RunnerReceiptSHA256: strings.Repeat("3", 64), EvalRunSetID: "eval-set-release", ProjectID: before.ProjectID,
		EndpointSHA256: strings.Repeat("4", 64), QuerySHA256: strings.Repeat("5", 64), LiveJournalSHA256: strings.Repeat("6", 64),
		LiveStartedAt: preparedAt.Add(time.Minute), LiveFinishedAt: preparedAt.Add(4 * time.Minute), OfflineVerifiedAt: preparedAt.Add(5 * time.Minute),
		Documents: liveEmbeddingDocumentObservation{Count: 1, SetSHA256: strings.Repeat("7", 64)},
		Before:    before, ObservedIndex: newIndex, After: after,
		Search: liveEmbeddingSearchObservation{
			QuerySHA256: strings.Repeat("5", 64), Memory: after, Results: results, SetSHA256: hex.EncodeToString(resultDigest[:]),
		},
		DurableProof: store.MemoryShadowReleaseProof{
			ProjectID: before.ProjectID, PreviousIndexID: oldIndex.ID, ActiveIndexID: newIndex.ID, MemoryRevision: 5,
			DocumentCount: 1, ChunkCount: 1, VectorCount: 1, SourceSetSHA256: strings.Repeat("8", 64), VectorSetSHA256: strings.Repeat("9", 64),
		},
		CASSourceSetSHA256: strings.Repeat("a", 64), CASObjectsVerified: 1, DeterministicDocuments: 1, SearchResultsReadBack: 1,
		FixtureRole: "none", ReleaseGateEligible: true, NoAmbiguousPOSTRetried: true,
	}
	raw := mustJSON(t, details)
	detailsSHA := testDigest(raw)
	environmentDigest := sha256.Sum256([]byte(liveEmbeddingsEnvironmentV1 + details.EndpointSHA256 + details.ProjectID))
	receipt := EvidenceReceipt{
		Schema: EvidenceSchemaV1, GateID: "live_embeddings_shadow", EvidenceKind: EvidenceLiveService,
		ReleaseCandidateID: candidateID, ProductBuild: build,
		Producer:    Producer{Name: liveEmbeddingsProducerName, Version: liveEmbeddingsProducerVersion},
		Environment: Environment{Class: string(EvidenceLiveService), OS: "windows-11", Architecture: "amd64", IdentitySHA256: hex.EncodeToString(environmentDigest[:])},
		ObservedAt:  details.OfflineVerifiedAt, Status: "passed", DetailsPath: "live-embeddings.details.json", DetailsSHA256: detailsSHA,
	}
	receipt.SubjectHashes = liveEmbeddingsFixtureSubjects(t, details, receipt)
	return details, receipt
}

func liveEmbeddingsFixtureSubjects(t *testing.T, details liveEmbeddingsDetails, receipt EvidenceReceipt) []SubjectHash {
	t.Helper()
	active := sha256.Sum256([]byte("aetherops-active-memory-index-v1\x00" + details.DurableProof.ActiveIndexID))
	previous := sha256.Sum256([]byte("aetherops-previous-memory-index-v1\x00" + details.DurableProof.PreviousIndexID))
	query := sha256.Sum256([]byte("aetherops-memory-query-v1\x00" + details.QuerySHA256))
	search := sha256.Sum256([]byte("aetherops-memory-search-readback-v1\x00" + details.Search.SetSHA256))
	proofRaw := mustJSON(t, details.DurableProof)
	proof := sha256.Sum256(proofRaw)
	values := map[string]string{
		"aetherops.exe":               receipt.ProductBuild.ExecutableSHA256,
		"runtime-manifest.json":       receipt.ProductBuild.RuntimeManifestSHA256,
		"knowledge-sidecar-tree":      receipt.ProductBuild.KnowledgeSidecarTreeSHA256,
		"prepared-ledger":             details.PreparedLedgerSHA256,
		"release-eval-runner-receipt": details.RunnerReceiptSHA256,
		"live-embedding-journal":      details.LiveJournalSHA256,
		"active-memory-index":         hex.EncodeToString(active[:]), "previous-memory-index": hex.EncodeToString(previous[:]),
		"memory-query": hex.EncodeToString(query[:]), "search-readback": hex.EncodeToString(search[:]),
		"cas-source-set": details.CASSourceSetSHA256, "vector-set": details.DurableProof.VectorSetSHA256,
		"durable-memory-proof": hex.EncodeToString(proof[:]), "live-embeddings-shadow-details": receipt.DetailsSHA256,
	}
	subjects := make([]SubjectHash, 0, len(values))
	for name, digest := range values {
		subjects = append(subjects, SubjectHash{Name: name, SHA256: digest})
	}
	return subjects
}
