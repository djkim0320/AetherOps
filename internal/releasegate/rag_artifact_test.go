package releasegate

import (
	"encoding/json"
	"testing"
	"time"
)

func TestRAG50KArtifactValidatesFullRecordedContract(t *testing.T) {
	preparedAt := time.Unix(1_800_000_000, 0).UTC()
	artifact := validRAG50KArtifact(preparedAt)
	if err := validateRAGArtifactDetails(mustJSON(t, artifact), preparedAt); err != nil {
		t.Fatalf("valid 50k artifact rejected: %v", err)
	}
}

func TestRAG50KArtifactRejectsUnknownAndTamperedContractFields(t *testing.T) {
	preparedAt := time.Unix(1_800_000_000, 0).UTC()

	var withUnknown map[string]any
	if err := json.Unmarshal(mustJSON(t, validRAG50KArtifact(preparedAt)), &withUnknown); err != nil {
		t.Fatal(err)
	}
	withUnknown["fabricated"] = true
	if err := validateRAGArtifactDetails(mustJSON(t, withUnknown), preparedAt); err == nil {
		t.Fatal("unknown 50k artifact field was accepted")
	}

	tests := []struct {
		name   string
		mutate func(*rag50KArtifact)
	}{
		{"missing failures field", func(value *rag50KArtifact) { value.Failures = nil }},
		{"not passed", func(value *rag50KArtifact) { value.Passed = boolPointer(false) }},
		{"single processor", func(value *rag50KArtifact) { value.Machine.LogicalProcessors = 1 }},
		{"wrong Go version", func(value *rag50KArtifact) { value.Machine.GoVersion = "go1.26.4" }},
		{"SQLite not WAL", func(value *rag50KArtifact) { value.SQLite.JournalMode = "delete" }},
		{"SQLite not FULL", func(value *rag50KArtifact) { value.SQLite.Synchronous = 1 }},
		{"SQLite foreign keys off", func(value *rag50KArtifact) { value.SQLite.ForeignKeys = 0 }},
		{"wrong chunk count", func(value *rag50KArtifact) { value.Dataset.ChunkCount = 49_999 }},
		{"wrong embedding model", func(value *rag50KArtifact) { value.Dataset.EmbeddingModel = "other" }},
		{"wrong embedding dimensions", func(value *rag50KArtifact) { value.Dataset.EmbeddingDimension = 768 }},
		{"wrong lexical candidates", func(value *rag50KArtifact) { value.Contract.LexicalCandidates = 49 }},
		{"wrong vector candidates", func(value *rag50KArtifact) { value.Contract.VectorCandidates = 49 }},
		{"wrong baseline candidates", func(value *rag50KArtifact) { value.Contract.BaselineCandidates = 19 }},
		{"wrong seed count", func(value *rag50KArtifact) { value.Contract.SeedEntities = 7 }},
		{"wrong assertion count", func(value *rag50KArtifact) { value.Contract.ExpandedAssertions = 31 }},
		{"too many graph evidence candidates", func(value *rag50KArtifact) { value.Contract.GraphEvidenceCandidates = 25 }},
		{"not final 12", func(value *rag50KArtifact) { value.Contract.FinalResults = 11 }},
		{"too many graph-only results", func(value *rag50KArtifact) { value.Contract.GraphOnlyResults = 5 }},
		{"too many results per artifact", func(value *rag50KArtifact) { value.Contract.MaximumPerArtifact = 3 }},
		{"wrong RRF weight", func(value *rag50KArtifact) { value.Contract.GraphWeight = .6 }},
		{"wrong graph-only threshold", func(value *rag50KArtifact) { value.Thresholds.MaximumGraphOnlyResults = 5 }},
		{"reported p95 mismatches samples", func(value *rag50KArtifact) { value.TimingMS.GraphExpansionP95 = 21 }},
		{"warm graph p95 exceeds 75ms", func(value *rag50KArtifact) {
			value.TimingMS.GraphExpansionSamples = repeatedFloat(80, rag50KGraphTimingSamples)
			value.TimingMS.GraphExpansionP95 = 80
		}},
		{"hybrid increase exceeds 25 percent", func(value *rag50KArtifact) {
			value.TimingMS.HybridGraphV1Samples = repeatedFloat(13, rag50KTimingSamples)
			value.TimingMS.HybridGraphV1P95 = 13
			value.TimingMS.HybridP95IncreasePercent = floatPointer(30)
		}},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			artifact := validRAG50KArtifact(preparedAt)
			testCase.mutate(&artifact)
			if err := validateRAGArtifactDetails(mustJSON(t, artifact), preparedAt); err == nil {
				t.Fatal("tampered 50k artifact was accepted")
			}
		})
	}
}

func TestRAG50KArtifactRequiresEveryCorrectnessProof(t *testing.T) {
	preparedAt := time.Unix(1_800_000_000, 0).UTC()
	tests := []struct {
		name   string
		mutate func(*rag50KCorrectness)
	}{
		{"fts", func(value *rag50KCorrectness) { value.FTS50 = false }},
		{"exact vector", func(value *rag50KCorrectness) { value.ExactVector50 = false }},
		{"final 12", func(value *rag50KCorrectness) { value.WeightedRRFFinal12 = false }},
		{"nonempty graph", func(value *rag50KCorrectness) { value.NonEmptyGraph = false }},
		{"one hop", func(value *rag50KCorrectness) { value.ExpandableOneHop = false }},
		{"assertion cap", func(value *rag50KCorrectness) { value.AssertionLimit32 = false }},
		{"dispute pair", func(value *rag50KCorrectness) { value.DisputePairsWhole = false }},
		{"graph-only reachable", func(value *rag50KCorrectness) { value.GraphOnlyReachable = false }},
		{"graph-only cap", func(value *rag50KCorrectness) { value.GraphOnlyLimit4 = false }},
		{"source cap", func(value *rag50KCorrectness) { value.SourceArtifactLimit2 = false }},
		{"mixed language", func(value *rag50KCorrectness) { value.MixedKoreanEnglish = false }},
		{"float32 blob", func(value *rag50KCorrectness) { value.Float32BLOB1536 = false }},
		{"multicore", func(value *rag50KCorrectness) { value.MulticoreExactSearch = false }},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			artifact := validRAG50KArtifact(preparedAt)
			testCase.mutate(&artifact.Correctness)
			if err := validateRAGArtifactDetails(mustJSON(t, artifact), preparedAt); err == nil {
				t.Fatal("missing correctness proof was accepted")
			}
		})
	}
}

func validRAG50KArtifact(preparedAt time.Time) rag50KArtifact {
	return rag50KArtifact{
		SchemaVersion: rag50KSchema,
		GeneratedAt:   preparedAt.Add(time.Minute).Format(time.RFC3339Nano),
		Command:       "AETHEROPS_RUN_50K_RETRIEVAL_GATE=1 go test TestHybridGraphV1FiftyThousandChunkReleaseGate",
		Machine: rag50KMachine{
			OS: "windows", Architecture: "amd64", GoVersion: "go1.26.5", LogicalProcessors: 8,
			ProcessorIdentifier: "test-cpu",
		},
		SQLite: rag50KSQLite{JournalMode: "wal", Synchronous: 2, ForeignKeys: 1, DatabaseB: 300 << 20},
		Dataset: rag50KDataset{
			ChunkCount: rag50KChunkCount, DocumentCount: rag50KDocumentCount, ArtifactCount: rag50KArtifactCount,
			EmbeddingModel: rag50KEmbeddingModel, EmbeddingDimension: rag50KEmbeddingDimensions,
			VectorEncoding: "little-endian float32 BLOB", Languages: []string{"ko", "en"},
			GenerationState: "ready", GenerationID: "kgen_release_fixture",
		},
		Contract: rag50KContract{
			LexicalCandidates: 50, VectorCandidates: 50, BaselineCandidates: 20, SeedEntities: 8,
			ExpandedAssertions: 32, GraphEvidenceCandidates: 24, FinalResults: 12,
			GraphDerivedResults: 4, GraphOnlyResults: 2, MaximumPerArtifact: 2, DisputePairsWhole: true,
			LexicalWeight: 1, VectorWeight: 1, GraphWeight: .5,
		},
		Correctness: rag50KCorrectness{
			FTS50: true, ExactVector50: true, WeightedRRFFinal12: true, NonEmptyGraph: true,
			ExpandableOneHop: true, AssertionLimit32: true, DisputePairsWhole: true,
			GraphOnlyReachable: true, GraphOnlyLimit4: true, SourceArtifactLimit2: true,
			MixedKoreanEnglish: true, Float32BLOB1536: true, MulticoreExactSearch: true,
		},
		TimingMS: rag50KTiming{
			WarmupPairs: 3, MeasuredPairs: rag50KTimingSamples,
			HybridV1Samples:       repeatedFloat(10, rag50KTimingSamples),
			HybridGraphV1Samples:  repeatedFloat(12, rag50KTimingSamples),
			GraphExpansionSamples: repeatedFloat(20, rag50KGraphTimingSamples),
			HybridV1P95:           10, HybridGraphV1P95: 12, GraphExpansionP95: 20,
			HybridP95IncreasePercent: floatPointer(20), DatasetBuildMilliseconds: 1000,
		},
		Thresholds: rag50KThresholds{
			MaximumGraphExpansionP95MS: 75, MaximumHybridP95IncreasePercent: 25,
			MaximumGraphOnlyResults: 4, MaximumResultsPerSourceArtifact: 2, MaximumExpandedAssertions: 32,
		},
		Failures: []string{}, Passed: boolPointer(true),
	}
}

func repeatedFloat(value float64, count int) []float64 {
	result := make([]float64, count)
	for index := range result {
		result[index] = value
	}
	return result
}

func boolPointer(value bool) *bool {
	return &value
}

func floatPointer(value float64) *float64 {
	return &value
}
