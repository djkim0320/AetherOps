package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/rag"
)

const (
	fiftyKGateEnvironment = "AETHEROPS_RUN_50K_RETRIEVAL_GATE"
	fiftyKReceiptPathEnv  = "AETHEROPS_RETRIEVAL_RECEIPT"
	fiftyKChunkCount      = 50_000
	fiftyKDocumentCount   = 250
	fiftyKTargetCount     = 50
	fiftyKGraphChunkCount = 28
	fiftyKTimingSamples   = 20
	fiftyKGraphSamples    = 30
)

type fiftyKDataset struct {
	ProjectID         string
	GenerationID      string
	Query             string
	QueryVector       []float32
	TargetChunkIDs    []string
	GraphChunkIDs     []string
	RelevantChunkText map[string]string
	ChunkArtifact     map[string]string
}

type fiftyKPerformanceReceipt struct {
	SchemaVersion string                 `json:"schema_version"`
	GeneratedAt   string                 `json:"generated_at"`
	Command       string                 `json:"command"`
	Machine       fiftyKMachineReceipt   `json:"machine"`
	SQLite        fiftyKSQLiteReceipt    `json:"sqlite"`
	Dataset       fiftyKDatasetReceipt   `json:"dataset"`
	Contract      fiftyKContractReceipt  `json:"retrieval_contract"`
	Correctness   fiftyKCorrectness      `json:"correctness"`
	TimingMS      fiftyKTimingReceipt    `json:"timing_ms"`
	Thresholds    fiftyKThresholdReceipt `json:"thresholds"`
	Failures      []string               `json:"failures"`
	Passed        bool                   `json:"passed"`
}

type fiftyKMachineReceipt struct {
	OS                  string `json:"os"`
	Architecture        string `json:"architecture"`
	GoVersion           string `json:"go_version"`
	LogicalProcessors   int    `json:"logical_processors"`
	ProcessorIdentifier string `json:"processor_identifier,omitempty"`
}

type fiftyKSQLiteReceipt struct {
	JournalMode string `json:"journal_mode"`
	Synchronous int    `json:"synchronous"`
	ForeignKeys int    `json:"foreign_keys"`
	DatabaseB   int64  `json:"database_bytes"`
}

type fiftyKDatasetReceipt struct {
	ChunkCount         int      `json:"chunk_count"`
	DocumentCount      int      `json:"document_count"`
	ArtifactCount      int      `json:"artifact_count"`
	EmbeddingModel     string   `json:"embedding_model"`
	EmbeddingDimension int      `json:"embedding_dimensions"`
	VectorEncoding     string   `json:"vector_encoding"`
	Languages          []string `json:"languages"`
	GenerationState    string   `json:"generation_state"`
	GenerationID       string   `json:"generation_id"`
}

type fiftyKContractReceipt struct {
	LexicalCandidates       int     `json:"lexical_candidates"`
	VectorCandidates        int     `json:"vector_candidates"`
	BaselineCandidates      int     `json:"baseline_candidates"`
	SeedEntities            int     `json:"seed_entities"`
	ExpandedAssertions      int     `json:"expanded_assertions"`
	GraphEvidenceCandidates int     `json:"graph_evidence_candidates"`
	FinalResults            int     `json:"final_results"`
	GraphDerivedResults     int     `json:"graph_derived_results"`
	GraphOnlyResults        int     `json:"graph_only_results"`
	MaximumPerArtifact      int     `json:"maximum_results_per_artifact"`
	DisputePairsWhole       bool    `json:"dispute_pairs_whole"`
	LexicalWeight           float64 `json:"lexical_weight"`
	VectorWeight            float64 `json:"vector_weight"`
	GraphWeight             float64 `json:"graph_weight"`
}

type fiftyKCorrectness struct {
	FTS50                bool `json:"fts_50"`
	ExactVector50        bool `json:"exact_vector_50"`
	WeightedRRFFinal12   bool `json:"weighted_rrf_final_12"`
	NonEmptyGraph        bool `json:"non_empty_graph"`
	ExpandableOneHop     bool `json:"expandable_one_hop"`
	AssertionLimit32     bool `json:"assertion_limit_32"`
	DisputePairsWhole    bool `json:"dispute_pairs_whole"`
	GraphOnlyReachable   bool `json:"graph_only_reachable"`
	GraphOnlyLimit4      bool `json:"graph_only_limit_4"`
	SourceArtifactLimit2 bool `json:"source_artifact_limit_2"`
	MixedKoreanEnglish   bool `json:"mixed_korean_english"`
	Float32BLOB1536      bool `json:"float32_blob_1536"`
	MulticoreExactSearch bool `json:"multicore_exact_search"`
}

type fiftyKTimingReceipt struct {
	WarmupPairs              int       `json:"warmup_pairs"`
	MeasuredPairs            int       `json:"measured_pairs"`
	HybridV1Samples          []float64 `json:"hybrid_v1_samples"`
	HybridGraphV1Samples     []float64 `json:"hybrid_graph_v1_samples"`
	GraphExpansionSamples    []float64 `json:"graph_expansion_samples"`
	HybridV1P95              float64   `json:"hybrid_v1_p95"`
	HybridGraphV1P95         float64   `json:"hybrid_graph_v1_p95"`
	GraphExpansionP95        float64   `json:"graph_expansion_p95"`
	HybridP95IncreasePercent float64   `json:"hybrid_p95_increase_percent"`
	DatasetBuildMilliseconds float64   `json:"dataset_build_milliseconds"`
}

type fiftyKThresholdReceipt struct {
	MaximumGraphExpansionP95MS      float64 `json:"maximum_graph_expansion_p95_ms"`
	MaximumHybridP95IncreasePercent float64 `json:"maximum_hybrid_p95_increase_percent"`
	MaximumGraphOnlyResults         int     `json:"maximum_graph_only_results"`
	MaximumResultsPerSourceArtifact int     `json:"maximum_results_per_source_artifact"`
	MaximumExpandedAssertions       int     `json:"maximum_expanded_assertions"`
}

// TestHybridGraphV1FiftyThousandChunkReleaseGate exercises the real store
// retrieval path over 50,000 persisted 1536-dimensional float32 embeddings.
// It is intentionally opt-in because the WAL database is roughly 300 MiB and
// each exact-vector sample scans every embedding with rag.ExactTopK.
func TestHybridGraphV1FiftyThousandChunkReleaseGate(t *testing.T) {
	if os.Getenv(fiftyKGateEnvironment) != "1" {
		t.Skip("set " + fiftyKGateEnvironment + "=1 to run the 50,000-chunk release gate")
	}
	ctx := context.Background()
	root := t.TempDir()
	databasePath := filepath.Join(root, "hybrid-graph-v1-50k.db")
	database, err := Open(ctx, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}

	buildStarted := time.Now()
	dataset, err := seedFiftyKHybridGraphDataset(ctx, database, objects)
	if err != nil {
		t.Fatalf("seed real 50,000-chunk SQLite dataset: %v", err)
	}
	buildDuration := time.Since(buildStarted)

	lexical, err := database.lexicalCandidates(ctx, dataset.ProjectID, dataset.Query)
	if err != nil {
		t.Fatal(err)
	}
	semantic, err := database.semanticCandidates(ctx, dataset.ProjectID, dataset.QueryVector)
	if err != nil {
		t.Fatal(err)
	}
	baseline := rag.ReciprocalRankFusion(lexical, semantic, graphBaselineLimit)
	seeds, err := database.seedKnowledgeEntities(ctx, dataset.ProjectID, dataset.GenerationID, baseline)
	if err != nil {
		t.Fatal(err)
	}
	assertions, err := database.expandKnowledgeAssertions(ctx, dataset.ProjectID, dataset.GenerationID, CoreOntologyID, seeds)
	if err != nil {
		t.Fatal(err)
	}
	graphChunks, chunkAssertions, err := database.graphEvidenceChunks(ctx, dataset.ProjectID, dataset.GenerationID, assertions)
	if err != nil {
		t.Fatal(err)
	}
	results, err := database.SearchMemoryWithGraph(ctx, dataset.ProjectID, dataset.Query, dataset.QueryVector, memoryResultLimit)
	if err != nil {
		t.Fatal(err)
	}

	baselineIDs := rankedIDSet(lexical, semantic)
	graphOnly, graphDerived, maximumPerArtifact := 0, 0, 0
	artifactCounts := map[string]int{}
	for _, result := range results {
		if result.GraphDerived {
			graphDerived++
			if !baselineIDs[result.ChunkID] {
				graphOnly++
			}
		}
		artifact := result.ArtifactID
		if artifact == "" {
			artifact = "document:" + result.DocumentID
		}
		artifactCounts[artifact]++
		maximumPerArtifact = max(maximumPerArtifact, artifactCounts[artifact])
	}
	disputesWhole, err := expandedDisputesAreWhole(ctx, database, dataset.ProjectID, dataset.GenerationID, assertions)
	if err != nil {
		t.Fatal(err)
	}
	evidenceDisputesWhole, err := evidenceDisputesAreWhole(ctx, database, dataset.ProjectID, dataset.GenerationID, chunkAssertions)
	if err != nil {
		t.Fatal(err)
	}
	disputesWhole = disputesWhole && evidenceDisputesWhole

	// Three untimed pairs warm the SQLite page cache, Go worker pool, and GC
	// allocation profile before collecting the release numbers.
	for index := 0; index < 3; index++ {
		if _, err := database.SearchMemory(ctx, dataset.ProjectID, dataset.Query, dataset.QueryVector, memoryResultLimit); err != nil {
			t.Fatal(err)
		}
		if _, err := database.SearchMemoryWithGraph(ctx, dataset.ProjectID, dataset.Query, dataset.QueryVector, memoryResultLimit); err != nil {
			t.Fatal(err)
		}
	}

	baselineTimings := make([]time.Duration, 0, fiftyKTimingSamples)
	graphTimings := make([]time.Duration, 0, fiftyKTimingSamples)
	for index := 0; index < fiftyKTimingSamples; index++ {
		// Alternate order to prevent one profile from always receiving the
		// immediately warmer filesystem and allocation state.
		if index%2 == 0 {
			baselineTimings = append(baselineTimings, measureSearch(t, func() error {
				_, searchErr := database.SearchMemory(ctx, dataset.ProjectID, dataset.Query, dataset.QueryVector, memoryResultLimit)
				return searchErr
			}))
			graphTimings = append(graphTimings, measureSearch(t, func() error {
				_, searchErr := database.SearchMemoryWithGraph(ctx, dataset.ProjectID, dataset.Query, dataset.QueryVector, memoryResultLimit)
				return searchErr
			}))
		} else {
			graphTimings = append(graphTimings, measureSearch(t, func() error {
				_, searchErr := database.SearchMemoryWithGraph(ctx, dataset.ProjectID, dataset.Query, dataset.QueryVector, memoryResultLimit)
				return searchErr
			}))
			baselineTimings = append(baselineTimings, measureSearch(t, func() error {
				_, searchErr := database.SearchMemory(ctx, dataset.ProjectID, dataset.Query, dataset.QueryVector, memoryResultLimit)
				return searchErr
			}))
		}
	}

	expansionTimings := make([]time.Duration, 0, fiftyKGraphSamples)
	for index := 0; index < fiftyKGraphSamples; index++ {
		started := time.Now()
		measuredSeeds, expansionErr := database.seedKnowledgeEntities(ctx, dataset.ProjectID, dataset.GenerationID, baseline)
		if expansionErr == nil {
			var measuredAssertions []string
			measuredAssertions, expansionErr = database.expandKnowledgeAssertions(ctx, dataset.ProjectID, dataset.GenerationID, CoreOntologyID, measuredSeeds)
			if expansionErr == nil {
				_, _, expansionErr = database.graphEvidenceChunks(ctx, dataset.ProjectID, dataset.GenerationID, measuredAssertions)
			}
		}
		if expansionErr != nil {
			t.Fatalf("measure graph expansion: %v", expansionErr)
		}
		expansionTimings = append(expansionTimings, time.Since(started))
	}

	baselineP95 := durationP95(baselineTimings)
	graphP95 := durationP95(graphTimings)
	expansionP95 := durationP95(expansionTimings)
	increasePercent := 0.0
	if baselineP95 > 0 {
		increasePercent = (float64(graphP95-baselineP95) / float64(baselineP95)) * 100
	}

	journalMode, synchronous, foreignKeys, err := sqliteRuntimeSettings(ctx, database)
	if err != nil {
		t.Fatal(err)
	}
	databaseBytes, err := sqliteDatabaseBytes(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	float32BLOBValid, err := validateStoredEmbeddingContract(ctx, database, dataset.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	mixedLanguage := validateMixedLanguageChunks(dataset.RelevantChunkText)

	correctness := fiftyKCorrectness{
		FTS50:                len(lexical) == memoryCandidateLimit,
		ExactVector50:        len(semantic) == memoryCandidateLimit && rankedIDsEqual(semantic, dataset.TargetChunkIDs),
		WeightedRRFFinal12:   len(results) == memoryResultLimit,
		NonEmptyGraph:        len(seeds) > 0 && len(assertions) > 0 && len(graphChunks) > 0,
		ExpandableOneHop:     len(seeds) == graphSeedLimit && len(chunkAssertions) > 0,
		AssertionLimit32:     len(assertions) == graphAssertionLimit,
		DisputePairsWhole:    disputesWhole,
		GraphOnlyReachable:   graphOnly > 0,
		GraphOnlyLimit4:      graphOnly <= graphOnlyLimit,
		SourceArtifactLimit2: maximumPerArtifact <= perSourceArtifactLimit && allResultsUseArtifacts(results),
		MixedKoreanEnglish:   mixedLanguage,
		Float32BLOB1536:      float32BLOBValid,
		MulticoreExactSearch: runtime.NumCPU() > 1,
	}

	failures := correctnessFailures(correctness)
	if expansionP95 > 75*time.Millisecond {
		failures = append(failures, fmt.Sprintf("warm graph expansion p95 %.3fms exceeds 75ms", milliseconds(expansionP95)))
	}
	if increasePercent > 25 {
		failures = append(failures, fmt.Sprintf("hybrid_graph_v1 p95 increase %.3f%% exceeds 25%%", increasePercent))
	}

	receipt := fiftyKPerformanceReceipt{
		SchemaVersion: "hybrid_graph_v1_50k_performance_v1",
		GeneratedAt:   time.Now().UTC().Format(time.RFC3339Nano),
		Command:       "$env:AETHEROPS_RUN_50K_RETRIEVAL_GATE='1'; & .\\.tools\\go1.26.5\\bin\\go.exe test .\\internal\\store -run '^TestHybridGraphV1FiftyThousandChunkReleaseGate$' -count=1 -v",
		Machine: fiftyKMachineReceipt{
			OS: runtime.GOOS, Architecture: runtime.GOARCH, GoVersion: runtime.Version(),
			LogicalProcessors: runtime.NumCPU(), ProcessorIdentifier: os.Getenv("PROCESSOR_IDENTIFIER"),
		},
		SQLite: fiftyKSQLiteReceipt{JournalMode: journalMode, Synchronous: synchronous, ForeignKeys: foreignKeys, DatabaseB: databaseBytes},
		Dataset: fiftyKDatasetReceipt{
			ChunkCount: fiftyKChunkCount, DocumentCount: fiftyKDocumentCount,
			ArtifactCount: fiftyKDocumentCount / 2, EmbeddingModel: rag.EmbeddingModel,
			EmbeddingDimension: rag.EmbeddingDimensions, VectorEncoding: "little-endian float32 BLOB",
			Languages: []string{"ko", "en"}, GenerationState: "ready", GenerationID: dataset.GenerationID,
		},
		Contract: fiftyKContractReceipt{
			LexicalCandidates: len(lexical), VectorCandidates: len(semantic), BaselineCandidates: len(baseline),
			SeedEntities: len(seeds), ExpandedAssertions: len(assertions), GraphEvidenceCandidates: len(graphChunks),
			FinalResults: len(results), GraphDerivedResults: graphDerived, GraphOnlyResults: graphOnly,
			MaximumPerArtifact: maximumPerArtifact, DisputePairsWhole: disputesWhole,
			LexicalWeight: 1, VectorWeight: 1, GraphWeight: .5,
		},
		Correctness: correctness,
		TimingMS: fiftyKTimingReceipt{
			WarmupPairs: 3, MeasuredPairs: fiftyKTimingSamples,
			HybridV1Samples: durationsMilliseconds(baselineTimings), HybridGraphV1Samples: durationsMilliseconds(graphTimings),
			GraphExpansionSamples: durationsMilliseconds(expansionTimings), HybridV1P95: milliseconds(baselineP95),
			HybridGraphV1P95: milliseconds(graphP95), GraphExpansionP95: milliseconds(expansionP95),
			HybridP95IncreasePercent: roundMilliseconds(increasePercent), DatasetBuildMilliseconds: milliseconds(buildDuration),
		},
		Thresholds: fiftyKThresholdReceipt{
			MaximumGraphExpansionP95MS: 75, MaximumHybridP95IncreasePercent: 25,
			MaximumGraphOnlyResults: graphOnlyLimit, MaximumResultsPerSourceArtifact: perSourceArtifactLimit,
			MaximumExpandedAssertions: graphAssertionLimit,
		},
		Failures: failures,
		Passed:   len(failures) == 0,
	}
	receiptPath, err := writeFiftyKReceipt(receipt)
	if err != nil {
		t.Fatalf("write performance receipt: %v", err)
	}
	t.Logf("50k receipt: %s", receiptPath)
	t.Logf("hybrid_v1 p95 %.3fms; hybrid_graph_v1 p95 %.3fms; increase %.3f%%; graph expansion p95 %.3fms",
		receipt.TimingMS.HybridV1P95, receipt.TimingMS.HybridGraphV1P95,
		receipt.TimingMS.HybridP95IncreasePercent, receipt.TimingMS.GraphExpansionP95)
	if len(failures) != 0 {
		t.Fatalf("hybrid_graph_v1 50k release gate failed: %s", strings.Join(failures, "; "))
	}
}

func seedFiftyKHybridGraphDataset(ctx context.Context, database *DB, objects *cas.Store) (fiftyKDataset, error) {
	project, err := database.CreateProject(ctx, "hybrid_graph_v1 50k release gate")
	if err != nil {
		return fiftyKDataset{}, err
	}
	generation, err := database.CreateKnowledgeGeneration(ctx, project.ID, CoreOntologyID, CoreOntologyContractSHA256)
	if err != nil {
		return fiftyKDataset{}, err
	}
	queryVector := unitVector(.99)
	targetVector, err := rag.EncodeVector(unitVector(.99))
	if err != nil {
		return fiftyKDataset{}, err
	}
	graphVector, err := rag.EncodeVector(unitVector(.45))
	if err != nil {
		return fiftyKDataset{}, err
	}
	fillerVector, err := rag.EncodeVector(unitVector(.05))
	if err != nil {
		return fiftyKDataset{}, err
	}
	targetVectorHash := sha256Hex(targetVector)
	graphVectorHash := sha256Hex(graphVector)
	fillerVectorHash := sha256Hex(fillerVector)

	dataset := fiftyKDataset{
		ProjectID: project.ID, GenerationID: generation.ID, Query: "aethergraph",
		QueryVector: queryVector, RelevantChunkText: map[string]string{}, ChunkArtifact: map[string]string{},
	}
	tx, err := database.sql.BeginTx(ctx, nil)
	if err != nil {
		return fiftyKDataset{}, err
	}
	defer tx.Rollback()
	now := formatTime(time.Now().UTC())
	if _, err := tx.ExecContext(ctx, `
INSERT INTO runs(id,project_id,question,status,created_at,updated_at)
VALUES('run_perf_50k',?,'hybrid graph retrieval performance','succeeded',?,?)`, project.ID, now, now); err != nil {
		return fiftyKDataset{}, err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO stage_attempts(id,run_id,stage,ordinal,status,created_at,updated_at)
VALUES('attempt_perf_50k','run_perf_50k','review',1,'succeeded',?,?)`, now, now); err != nil {
		return fiftyKDataset{}, err
	}
	for artifactIndex := 0; artifactIndex < fiftyKDocumentCount/2; artifactIndex++ {
		artifactID := fmt.Sprintf("artifact-perf-%03d", artifactIndex)
		blobHash := sha256Hex([]byte(artifactID))
		if _, err := tx.ExecContext(ctx, `
INSERT INTO blobs(hash,size,media_type,created_at) VALUES(?,?,?,?)`, blobHash, len(artifactID), "text/plain; charset=utf-8", now); err != nil {
			return fiftyKDataset{}, err
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO artifacts(id,run_id,stage_attempt_id,kind,blob_hash,adopted,created_at)
VALUES(?,'run_perf_50k','attempt_perf_50k','retrieval.performance.source',?,1,?)`, artifactID, blobHash, now); err != nil {
			return fiftyKDataset{}, err
		}
	}
	for documentIndex := 0; documentIndex < fiftyKDocumentCount; documentIndex++ {
		documentID := fmt.Sprintf("document-perf-%03d", documentIndex)
		artifactID := fmt.Sprintf("artifact-perf-%03d", documentIndex/2)
		blobHash := sha256Hex([]byte(artifactID))
		if _, err := tx.ExecContext(ctx, `
INSERT INTO documents(id,project_id,artifact_id,title,blob_hash,status,embedding_model,
                      embedding_dimensions,pinned,created_at,updated_at,graph_adopt)
VALUES(?,?,?,?,?,'ready',?,?,1,?,?,1)`, documentID, project.ID, artifactID,
			fmt.Sprintf("50k source %03d", documentIndex), blobHash, rag.EmbeddingModel,
			rag.EmbeddingDimensions, now, now); err != nil {
			return fiftyKDataset{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO embedding_indexes(id,project_id,model,dimensions,state,created_at,completed_at,error)
VALUES('index-perf-50k',?,?,?,'active',?,?,'')`, project.ID, rag.EmbeddingModel, rag.EmbeddingDimensions, now, now); err != nil {
		return fiftyKDataset{}, err
	}
	chunkStatement, err := tx.PrepareContext(ctx, `
INSERT INTO chunks(id,document_id,ordinal,text,text_hash) VALUES(?,?,?,?,?)`)
	if err != nil {
		return fiftyKDataset{}, err
	}
	defer chunkStatement.Close()
	embeddingStatement, err := tx.PrepareContext(ctx, `
INSERT INTO embeddings(chunk_id,index_id,model,dimensions,vector,vector_hash,created_at)
VALUES(?,'index-perf-50k',?,?,?,?,?)`)
	if err != nil {
		return fiftyKDataset{}, err
	}
	defer embeddingStatement.Close()

	for chunkIndex := 0; chunkIndex < fiftyKChunkCount; chunkIndex++ {
		chunkID, text, vector, vectorHash, documentIndex := fiftyKChunkFixture(chunkIndex, targetVector, targetVectorHash, graphVector, graphVectorHash, fillerVector, fillerVectorHash)
		documentID := fmt.Sprintf("document-perf-%03d", documentIndex)
		artifactID := fmt.Sprintf("artifact-perf-%03d", documentIndex/2)
		if _, err := chunkStatement.ExecContext(ctx, chunkID, documentID, chunkIndex/fiftyKDocumentCount, text, sha256Hex([]byte(text))); err != nil {
			return fiftyKDataset{}, fmt.Errorf("insert chunk %d: %w", chunkIndex, err)
		}
		if _, err := embeddingStatement.ExecContext(ctx, chunkID, rag.EmbeddingModel, rag.EmbeddingDimensions, vector, vectorHash, now); err != nil {
			return fiftyKDataset{}, fmt.Errorf("insert embedding %d: %w", chunkIndex, err)
		}
		dataset.ChunkArtifact[chunkID] = artifactID
		switch {
		case chunkIndex < fiftyKTargetCount:
			dataset.TargetChunkIDs = append(dataset.TargetChunkIDs, chunkID)
			dataset.RelevantChunkText[chunkID] = text
		case chunkIndex < fiftyKTargetCount+fiftyKGraphChunkCount:
			dataset.GraphChunkIDs = append(dataset.GraphChunkIDs, chunkID)
			dataset.RelevantChunkText[chunkID] = text
		}
	}
	if err := chunkStatement.Close(); err != nil {
		return fiftyKDataset{}, err
	}
	if err := embeddingStatement.Close(); err != nil {
		return fiftyKDataset{}, err
	}
	if err := tx.Commit(); err != nil {
		return fiftyKDataset{}, err
	}

	projection, err := fiftyKKnowledgeProjection(dataset)
	if err != nil {
		return fiftyKDataset{}, err
	}
	if err := database.AppendKnowledgeProjection(ctx, project.ID, generation.ID, projection); err != nil {
		return fiftyKDataset{}, err
	}
	snapshot, tripleCount, err := database.KnowledgeNQuads(ctx, project.ID, generation.ID, generation.OntologyID)
	if err != nil {
		return fiftyKDataset{}, err
	}
	snapshotReceipt, err := objects.PutBytes(snapshot)
	if err != nil {
		return fiftyKDataset{}, err
	}
	if err := database.RegisterBlob(ctx, snapshotReceipt, "application/n-quads"); err != nil {
		return fiftyKDataset{}, err
	}
	if err := database.AppendKnowledgeProjection(ctx, project.ID, generation.ID, KnowledgeProjection{Snapshots: []KnowledgeRDFSnapshotRecord{{
		ID: "krdf_" + snapshotReceipt.Hash[:24], Format: "n-quads", BlobHash: snapshotReceipt.Hash,
		DatasetSHA256: snapshotReceipt.Hash, TripleCount: tripleCount,
	}}}); err != nil {
		return fiftyKDataset{}, err
	}
	if _, err := database.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID, KnowledgeBuilding, KnowledgeValidating, ""); err != nil {
		return fiftyKDataset{}, err
	}
	if _, err := database.TransitionKnowledgeGeneration(ctx, project.ID, generation.ID, KnowledgeValidating, KnowledgeReady, ""); err != nil {
		return fiftyKDataset{}, err
	}
	if _, err := database.ActivateKnowledgeGeneration(ctx, project.ID, generation.ID); err != nil {
		return fiftyKDataset{}, err
	}
	return dataset, nil
}

func fiftyKChunkFixture(index int, targetVector []byte, targetHash string, graphVector []byte, graphHash string, fillerVector []byte, fillerHash string) (string, string, []byte, string, int) {
	switch {
	case index < fiftyKTargetCount:
		return fmt.Sprintf("chunk-target-%03d", index),
			fmt.Sprintf("aethergraph 검증 자료 %03d — Korean English hybrid retrieval evidence 공력 연구", index),
			targetVector, targetHash, index
	case index < fiftyKTargetCount+fiftyKGraphChunkCount:
		graphIndex := index - fiftyKTargetCount
		return fmt.Sprintf("chunk-graph-%03d", graphIndex),
			fmt.Sprintf("그래프 근거 %03d — linked engineering observation and 반대 증거", graphIndex),
			graphVector, graphHash, fiftyKTargetCount + graphIndex
	default:
		fillerIndex := index - fiftyKTargetCount - fiftyKGraphChunkCount
		return fmt.Sprintf("chunk-filler-%05d", fillerIndex),
			fmt.Sprintf("혼합 연구 corpus %05d — deterministic Korean English engineering source", fillerIndex),
			fillerVector, fillerHash, (fiftyKTargetCount + fiftyKGraphChunkCount + fillerIndex) % fiftyKDocumentCount
	}
}

func fiftyKKnowledgeProjection(dataset fiftyKDataset) (KnowledgeProjection, error) {
	projection := KnowledgeProjection{}
	sourceSeen := map[string]bool{}
	addSource := func(chunkID string) error {
		if sourceSeen[chunkID] {
			return nil
		}
		text, ok := dataset.RelevantChunkText[chunkID]
		if !ok {
			return fmt.Errorf("missing fixture text for source %s", chunkID)
		}
		documentIndex := sourceDocumentIndex(chunkID)
		artifactID := fmt.Sprintf("artifact-perf-%03d", documentIndex/2)
		projection.Sources = append(projection.Sources, KnowledgeSourceRecord{
			ChunkID: chunkID, BlobHash: sha256Hex([]byte(artifactID)), SourceKind: "pinned",
			SourceLocator: json.RawMessage(`{"fixture":"hybrid_graph_v1_50k_performance_v1"}`), TextHash: sha256Hex([]byte(text)),
		})
		sourceSeen[chunkID] = true
		return nil
	}
	addMention := func(id, entityID, chunkID string) error {
		if err := addSource(chunkID); err != nil {
			return err
		}
		text := dataset.RelevantChunkText[chunkID]
		projection.Mentions = append(projection.Mentions, KnowledgeMentionRecord{
			ID: id, EntityID: entityID, ChunkID: chunkID, StartByte: 0, EndByte: len([]byte(text)), ExcerptSHA256: sha256Hex([]byte(text)),
		})
		return nil
	}

	for seedIndex := 0; seedIndex < graphSeedLimit; seedIndex++ {
		entityID := fmt.Sprintf("entity-seed-%02d", seedIndex)
		chunkID := dataset.TargetChunkIDs[seedIndex]
		projection.Entities = append(projection.Entities, KnowledgeEntityRecord{
			ID: entityID, ClassKey: "concept", CanonicalName: fmt.Sprintf("Seed %02d", seedIndex), NormalizedName: fmt.Sprintf("seed %02d", seedIndex),
		})
		if err := addMention(fmt.Sprintf("mention-seed-%02d", seedIndex), entityID, chunkID); err != nil {
			return KnowledgeProjection{}, err
		}
	}
	for assertionIndex := 0; assertionIndex < graphAssertionLimit; assertionIndex++ {
		objectID := fmt.Sprintf("entity-object-%02d", assertionIndex)
		projection.Entities = append(projection.Entities, KnowledgeEntityRecord{
			ID: objectID, ClassKey: "concept", CanonicalName: fmt.Sprintf("Object %02d", assertionIndex), NormalizedName: fmt.Sprintf("object %02d", assertionIndex),
		})
		// Keep object mentions outside the lexical/vector baseline so all eight
		// seed slots exercise independent seed entities rather than being
		// consumed by co-mentioned assertion objects.
		objectMentionChunk := dataset.GraphChunkIDs[assertionIndex%len(dataset.GraphChunkIDs)]
		if err := addMention(fmt.Sprintf("mention-object-%02d", assertionIndex), objectID, objectMentionChunk); err != nil {
			return KnowledgeProjection{}, err
		}
		evidenceChunk := ""
		if assertionIndex < 4 {
			evidenceChunk = dataset.TargetChunkIDs[assertionIndex]
		} else {
			evidenceChunk = dataset.GraphChunkIDs[assertionIndex-4]
		}
		if err := addSource(evidenceChunk); err != nil {
			return KnowledgeProjection{}, err
		}
		assertionID := fmt.Sprintf("assertion-%02d", assertionIndex)
		projection.Assertions = append(projection.Assertions, KnowledgeAssertionRecord{
			ID: assertionID, SubjectEntityID: fmt.Sprintf("entity-seed-%02d", assertionIndex%graphSeedLimit),
			PredicateKey: "uses", ObjectEntityID: objectID, Qualifiers: json.RawMessage(`{"condition":"50k release gate"}`),
			Polarity: "affirmed", Status: "disputed", Confidence: 1, AssertionKey: sha256Hex([]byte("assertion-key:" + assertionID)),
		})
		text := dataset.RelevantChunkText[evidenceChunk]
		start, end := 0, len([]byte(text))
		projection.Evidence = append(projection.Evidence, KnowledgeAssertionEvidenceRecord{
			AssertionID: assertionID, EvidenceKind: "text_span", BlobHash: sha256Hex([]byte(dataset.ChunkArtifact[evidenceChunk])),
			ChunkID: evidenceChunk, StartByte: &start, EndByte: &end, Locator: json.RawMessage(`{}`), EvidenceSHA256: sha256Hex([]byte(text)),
		})
	}
	for pair := 0; pair < graphAssertionLimit/2; pair++ {
		projection.Conflicts = append(projection.Conflicts, KnowledgeConflictRecord{
			ID: fmt.Sprintf("conflict-%02d", pair), LeftAssertionID: fmt.Sprintf("assertion-%02d", pair*2),
			RightAssertionID: fmt.Sprintf("assertion-%02d", pair*2+1), Reason: "qualifier-compatible release fixture dispute", Status: "open",
		})
	}
	return projection, nil
}

func sourceDocumentIndex(chunkID string) int {
	var index int
	switch {
	case strings.HasPrefix(chunkID, "chunk-target-"):
		_, _ = fmt.Sscanf(chunkID, "chunk-target-%03d", &index)
		return index
	case strings.HasPrefix(chunkID, "chunk-graph-"):
		_, _ = fmt.Sscanf(chunkID, "chunk-graph-%03d", &index)
		return fiftyKTargetCount + index
	default:
		panic("performance graph source is not a target or graph chunk: " + chunkID)
	}
}

func unitVector(first float32) []float32 {
	vector := make([]float32, rag.EmbeddingDimensions)
	vector[0] = first
	vector[1] = float32(math.Sqrt(1 - float64(first)*float64(first)))
	return vector
}

func sha256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func rankedIDSet(rankings ...[]rag.Ranked) map[string]bool {
	result := map[string]bool{}
	for _, ranking := range rankings {
		for _, item := range ranking {
			result[item.ID] = true
		}
	}
	return result
}

func rankedIDsEqual(ranking []rag.Ranked, expected []string) bool {
	if len(ranking) != len(expected) {
		return false
	}
	for index := range ranking {
		if ranking[index].ID != expected[index] {
			return false
		}
	}
	return true
}

func expandedDisputesAreWhole(ctx context.Context, database *DB, projectID, generationID string, assertions []string) (bool, error) {
	present := map[string]bool{}
	for _, assertion := range assertions {
		present[assertion] = true
	}
	rows, err := database.sql.QueryContext(ctx, `
SELECT left_assertion_id,right_assertion_id FROM knowledge_conflicts
WHERE project_id=? AND generation_id=? AND status='open' ORDER BY id`, projectID, generationID)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var left, right string
		if err := rows.Scan(&left, &right); err != nil {
			return false, err
		}
		if present[left] != present[right] {
			return false, nil
		}
	}
	return true, rows.Err()
}

func evidenceDisputesAreWhole(ctx context.Context, database *DB, projectID, generationID string, chunkAssertions map[string][]string) (bool, error) {
	present := map[string]bool{}
	for _, assertions := range chunkAssertions {
		for _, assertion := range assertions {
			present[assertion] = true
		}
	}
	rows, err := database.sql.QueryContext(ctx, `
SELECT left_assertion_id,right_assertion_id FROM knowledge_conflicts
WHERE project_id=? AND generation_id=? AND status='open' ORDER BY id`, projectID, generationID)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var left, right string
		if err := rows.Scan(&left, &right); err != nil {
			return false, err
		}
		if present[left] != present[right] {
			return false, nil
		}
	}
	return true, rows.Err()
}

func measureSearch(t *testing.T, operation func() error) time.Duration {
	t.Helper()
	started := time.Now()
	if err := operation(); err != nil {
		t.Fatal(err)
	}
	return time.Since(started)
}

func durationP95(values []time.Duration) time.Duration {
	ordered := append([]time.Duration(nil), values...)
	sort.Slice(ordered, func(left, right int) bool { return ordered[left] < ordered[right] })
	if len(ordered) == 0 {
		return 0
	}
	index := int(math.Ceil(.95*float64(len(ordered)))) - 1
	return ordered[max(0, index)]
}

func milliseconds(value time.Duration) float64 {
	return roundMilliseconds(float64(value) / float64(time.Millisecond))
}

func roundMilliseconds(value float64) float64 {
	return math.Round(value*1000) / 1000
}

func durationsMilliseconds(values []time.Duration) []float64 {
	result := make([]float64, len(values))
	for index, value := range values {
		result[index] = milliseconds(value)
	}
	return result
}

func sqliteRuntimeSettings(ctx context.Context, database *DB) (string, int, int, error) {
	var journalMode string
	var synchronous, foreignKeys int
	if err := database.sql.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journalMode); err != nil {
		return "", 0, 0, err
	}
	if err := database.sql.QueryRowContext(ctx, "PRAGMA synchronous").Scan(&synchronous); err != nil {
		return "", 0, 0, err
	}
	if err := database.sql.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&foreignKeys); err != nil {
		return "", 0, 0, err
	}
	return journalMode, synchronous, foreignKeys, nil
}

func sqliteDatabaseBytes(path string) (int64, error) {
	var total int64
	for _, candidate := range []string{path, path + "-wal", path + "-shm"} {
		info, err := os.Stat(candidate)
		switch {
		case err == nil:
			total += info.Size()
		case errors.Is(err, os.ErrNotExist):
		default:
			return 0, err
		}
	}
	return total, nil
}

func validateStoredEmbeddingContract(ctx context.Context, database *DB, projectID string) (bool, error) {
	var count, invalid int
	err := database.sql.QueryRowContext(ctx, `
SELECT COUNT(*), COALESCE(SUM(CASE WHEN e.dimensions=? AND length(e.vector)=? THEN 0 ELSE 1 END),0)
FROM embeddings e JOIN embedding_indexes i ON i.id=e.index_id
WHERE i.project_id=? AND i.state='active'`, rag.EmbeddingDimensions, rag.EmbeddingDimensions*4, projectID).Scan(&count, &invalid)
	return count == fiftyKChunkCount && invalid == 0, err
}

func validateMixedLanguageChunks(chunks map[string]string) bool {
	for _, text := range chunks {
		hasASCII, hasKorean := false, false
		for _, character := range text {
			hasASCII = hasASCII || (character >= 'A' && character <= 'z')
			hasKorean = hasKorean || (character >= '\uac00' && character <= '\ud7a3')
		}
		if !hasASCII || !hasKorean {
			return false
		}
	}
	return len(chunks) > 0
}

func allResultsUseArtifacts(results []GraphMemoryResult) bool {
	if len(results) == 0 {
		return false
	}
	for _, result := range results {
		if result.ArtifactID == "" {
			return false
		}
	}
	return true
}

func correctnessFailures(correctness fiftyKCorrectness) []string {
	checks := []struct {
		passed  bool
		message string
	}{
		{correctness.FTS50, "FTS5 did not return exactly 50 candidates"},
		{correctness.ExactVector50, "exact vector search did not return the deterministic top 50"},
		{correctness.WeightedRRFFinal12, "weighted RRF did not return exactly 12 final results"},
		{correctness.NonEmptyGraph, "graph expansion was empty"},
		{correctness.ExpandableOneHop, "expandable one-hop seed/evidence contract failed"},
		{correctness.AssertionLimit32, "assertion expansion did not exercise the 32 hard limit"},
		{correctness.DisputePairsWhole, "an open dispute pair was split in assertion or evidence selection"},
		{correctness.GraphOnlyReachable, "graph evidence did not contribute a graph-only final result"},
		{correctness.GraphOnlyLimit4, "more than four graph-only results were returned"},
		{correctness.SourceArtifactLimit2, "more than two results came from one source artifact or an artifact id was lost"},
		{correctness.MixedKoreanEnglish, "dataset is not Korean/English mixed text"},
		{correctness.Float32BLOB1536, "stored vectors are not 1536-dimensional float32 BLOBs"},
		{correctness.MulticoreExactSearch, "machine does not expose multiple logical processors to ExactTopK"},
	}
	failures := make([]string, 0)
	for _, check := range checks {
		if !check.passed {
			failures = append(failures, check.message)
		}
	}
	return failures
}

func writeFiftyKReceipt(receipt fiftyKPerformanceReceipt) (string, error) {
	path := strings.TrimSpace(os.Getenv(fiftyKReceiptPathEnv))
	if path == "" {
		path = filepath.Join("..", "..", "evals", "results", "hybrid-graph-v1-50k-performance-v1.json")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0o755); err != nil {
		return "", err
	}
	encoded, err := json.MarshalIndent(receipt, "", "  ")
	if err != nil {
		return "", err
	}
	temporary, err := os.CreateTemp(filepath.Dir(absolute), ".hybrid-graph-receipt-*.tmp")
	if err != nil {
		return "", err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if _, err := temporary.Write(append(encoded, '\n')); err != nil {
		temporary.Close()
		return "", err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return "", err
	}
	if err := temporary.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(temporaryPath, absolute); err != nil {
		return "", err
	}
	return absolute, nil
}
