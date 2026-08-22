package releasegate

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

const (
	rag50KSchema                  = "hybrid_graph_v1_50k_performance_v1"
	rag50KChunkCount              = 50_000
	rag50KDocumentCount           = 250
	rag50KArtifactCount           = 125
	rag50KEmbeddingModel          = "text-embedding-3-small"
	rag50KEmbeddingDimensions     = 1536
	rag50KTimingSamples           = 20
	rag50KGraphTimingSamples      = 30
	rag50KMaximumGraphP95MS       = 75.0
	rag50KMaximumHybridIncrease   = 25.0
	rag50KMaximumGraphOnlyResults = 4
	rag50KMaximumPerArtifact      = 2
	rag50KMaximumAssertions       = 32
)

type rag50KArtifact struct {
	SchemaVersion string            `json:"schema_version"`
	GeneratedAt   string            `json:"generated_at"`
	Command       string            `json:"command"`
	Machine       rag50KMachine     `json:"machine"`
	SQLite        rag50KSQLite      `json:"sqlite"`
	Dataset       rag50KDataset     `json:"dataset"`
	Contract      rag50KContract    `json:"retrieval_contract"`
	Correctness   rag50KCorrectness `json:"correctness"`
	TimingMS      rag50KTiming      `json:"timing_ms"`
	Thresholds    rag50KThresholds  `json:"thresholds"`
	Failures      []string          `json:"failures"`
	Passed        *bool             `json:"passed"`
}

type rag50KMachine struct {
	OS                  string `json:"os"`
	Architecture        string `json:"architecture"`
	GoVersion           string `json:"go_version"`
	LogicalProcessors   int    `json:"logical_processors"`
	ProcessorIdentifier string `json:"processor_identifier,omitempty"`
}

type rag50KSQLite struct {
	JournalMode string `json:"journal_mode"`
	Synchronous int    `json:"synchronous"`
	ForeignKeys int    `json:"foreign_keys"`
	DatabaseB   int64  `json:"database_bytes"`
}

type rag50KDataset struct {
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

type rag50KContract struct {
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

type rag50KCorrectness struct {
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

func (correctness rag50KCorrectness) all() bool {
	return correctness.FTS50 && correctness.ExactVector50 && correctness.WeightedRRFFinal12 &&
		correctness.NonEmptyGraph && correctness.ExpandableOneHop && correctness.AssertionLimit32 &&
		correctness.DisputePairsWhole && correctness.GraphOnlyReachable && correctness.GraphOnlyLimit4 &&
		correctness.SourceArtifactLimit2 && correctness.MixedKoreanEnglish && correctness.Float32BLOB1536 &&
		correctness.MulticoreExactSearch
}

type rag50KTiming struct {
	WarmupPairs              int       `json:"warmup_pairs"`
	MeasuredPairs            int       `json:"measured_pairs"`
	HybridV1Samples          []float64 `json:"hybrid_v1_samples"`
	HybridGraphV1Samples     []float64 `json:"hybrid_graph_v1_samples"`
	GraphExpansionSamples    []float64 `json:"graph_expansion_samples"`
	HybridV1P95              float64   `json:"hybrid_v1_p95"`
	HybridGraphV1P95         float64   `json:"hybrid_graph_v1_p95"`
	GraphExpansionP95        float64   `json:"graph_expansion_p95"`
	HybridP95IncreasePercent *float64  `json:"hybrid_p95_increase_percent"`
	DatasetBuildMilliseconds float64   `json:"dataset_build_milliseconds"`
}

type rag50KThresholds struct {
	MaximumGraphExpansionP95MS      float64 `json:"maximum_graph_expansion_p95_ms"`
	MaximumHybridP95IncreasePercent float64 `json:"maximum_hybrid_p95_increase_percent"`
	MaximumGraphOnlyResults         int     `json:"maximum_graph_only_results"`
	MaximumResultsPerSourceArtifact int     `json:"maximum_results_per_source_artifact"`
	MaximumExpandedAssertions       int     `json:"maximum_expanded_assertions"`
}

func validateRAG50KArtifact(raw []byte, preparedAt time.Time) error {
	var artifact rag50KArtifact
	if err := decodeStrict(raw, &artifact); err != nil {
		return fmt.Errorf("decode 50k artifact: %w", err)
	}
	generatedAt, err := time.Parse(time.RFC3339Nano, artifact.GeneratedAt)
	if err != nil || generatedAt.Before(preparedAt) || artifact.SchemaVersion != rag50KSchema ||
		strings.TrimSpace(artifact.Command) == "" || artifact.Failures == nil || len(artifact.Failures) != 0 ||
		!requiredBool(artifact.Passed, true) {
		return errors.New("50k artifact identity, observation window, or pass result is invalid")
	}
	if artifact.Machine.OS != "windows" || artifact.Machine.Architecture != "amd64" ||
		artifact.Machine.GoVersion != "go1.26.5" || artifact.Machine.LogicalProcessors < 2 {
		return errors.New("50k artifact does not prove the fixed multicore Windows/Go environment")
	}
	if !strings.EqualFold(artifact.SQLite.JournalMode, "wal") || artifact.SQLite.Synchronous != 2 ||
		artifact.SQLite.ForeignKeys != 1 || artifact.SQLite.DatabaseB <= 0 {
		return errors.New("50k artifact SQLite durability contract is invalid")
	}
	if artifact.Dataset.ChunkCount != rag50KChunkCount || artifact.Dataset.DocumentCount != rag50KDocumentCount ||
		artifact.Dataset.ArtifactCount != rag50KArtifactCount || artifact.Dataset.EmbeddingModel != rag50KEmbeddingModel ||
		artifact.Dataset.EmbeddingDimension != rag50KEmbeddingDimensions ||
		artifact.Dataset.VectorEncoding != "little-endian float32 BLOB" ||
		!sameStringSet(artifact.Dataset.Languages, []string{"ko", "en"}) ||
		artifact.Dataset.GenerationState != "ready" || strings.TrimSpace(artifact.Dataset.GenerationID) == "" {
		return errors.New("50k artifact dataset, embedding, or generation contract is invalid")
	}
	contract := artifact.Contract
	if contract.LexicalCandidates != 50 || contract.VectorCandidates != 50 || contract.BaselineCandidates != 20 ||
		contract.SeedEntities != 8 || contract.ExpandedAssertions != rag50KMaximumAssertions ||
		contract.GraphEvidenceCandidates < 1 || contract.GraphEvidenceCandidates > 24 ||
		contract.FinalResults != 12 || contract.GraphDerivedResults < 1 || contract.GraphDerivedResults > contract.FinalResults ||
		contract.GraphOnlyResults < 1 || contract.GraphOnlyResults > rag50KMaximumGraphOnlyResults ||
		contract.GraphOnlyResults > contract.GraphDerivedResults || contract.MaximumPerArtifact < 1 ||
		contract.MaximumPerArtifact > rag50KMaximumPerArtifact || !contract.DisputePairsWhole ||
		contract.LexicalWeight != 1 || contract.VectorWeight != 1 || contract.GraphWeight != .5 {
		return errors.New("50k artifact hybrid_graph_v1 retrieval contract is invalid")
	}
	if !artifact.Correctness.all() {
		return errors.New("50k artifact omits an FTS, exact-vector, graph, cap, language, BLOB, or multicore correctness proof")
	}
	thresholds := artifact.Thresholds
	if thresholds.MaximumGraphExpansionP95MS != rag50KMaximumGraphP95MS ||
		thresholds.MaximumHybridP95IncreasePercent != rag50KMaximumHybridIncrease ||
		thresholds.MaximumGraphOnlyResults != rag50KMaximumGraphOnlyResults ||
		thresholds.MaximumResultsPerSourceArtifact != rag50KMaximumPerArtifact ||
		thresholds.MaximumExpandedAssertions != rag50KMaximumAssertions {
		return errors.New("50k artifact thresholds differ from the fixed release thresholds")
	}
	return validateRAG50KTiming(artifact.TimingMS)
}

func validateRAG50KTiming(timing rag50KTiming) error {
	if timing.WarmupPairs != 3 || timing.MeasuredPairs != rag50KTimingSamples ||
		len(timing.HybridV1Samples) != rag50KTimingSamples ||
		len(timing.HybridGraphV1Samples) != rag50KTimingSamples ||
		len(timing.GraphExpansionSamples) != rag50KGraphTimingSamples ||
		timing.HybridP95IncreasePercent == nil || !finitePositive(timing.DatasetBuildMilliseconds) {
		return errors.New("50k artifact timing sample counts or dataset build duration are invalid")
	}
	for _, samples := range [][]float64{timing.HybridV1Samples, timing.HybridGraphV1Samples, timing.GraphExpansionSamples} {
		for _, sample := range samples {
			if !finiteNonNegative(sample) {
				return errors.New("50k artifact contains a negative, NaN, or infinite timing sample")
			}
		}
	}
	baselineP95 := floatP95(timing.HybridV1Samples)
	graphP95 := floatP95(timing.HybridGraphV1Samples)
	expansionP95 := floatP95(timing.GraphExpansionSamples)
	if baselineP95 <= 0 || graphP95 <= 0 || expansionP95 <= 0 ||
		!sameRoundedMillisecond(timing.HybridV1P95, baselineP95) ||
		!sameRoundedMillisecond(timing.HybridGraphV1P95, graphP95) ||
		!sameRoundedMillisecond(timing.GraphExpansionP95, expansionP95) {
		return errors.New("50k artifact reported p95 values do not match their recorded samples")
	}
	recordedIncrease := *timing.HybridP95IncreasePercent
	calculatedIncrease := ((graphP95 - baselineP95) / baselineP95) * 100
	if !finiteNumber(recordedIncrease) || math.Abs(recordedIncrease-calculatedIncrease) > .1 {
		return errors.New("50k artifact hybrid p95 increase does not match its recorded samples")
	}
	if expansionP95 > rag50KMaximumGraphP95MS || timing.GraphExpansionP95 > rag50KMaximumGraphP95MS ||
		calculatedIncrease > rag50KMaximumHybridIncrease || recordedIncrease > rag50KMaximumHybridIncrease {
		return errors.New("50k artifact exceeds the graph-expansion or total-hybrid p95 release threshold")
	}
	return nil
}

func floatP95(values []float64) float64 {
	ordered := append([]float64(nil), values...)
	sort.Float64s(ordered)
	index := int(math.Ceil(.95*float64(len(ordered)))) - 1
	return ordered[max(0, index)]
}

func sameRoundedMillisecond(left, right float64) bool {
	return finiteNumber(left) && finiteNumber(right) && math.Abs(left-right) <= .001
}

func finitePositive(value float64) bool {
	return value > 0 && finiteNumber(value)
}

func finiteNonNegative(value float64) bool {
	return value >= 0 && finiteNumber(value)
}

func finiteNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}
