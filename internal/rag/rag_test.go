package rag

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChunkTextHandlesKoreanByRunes(t *testing.T) {
	input := strings.Repeat("한글 연구 자료 ", 1000)
	chunks := ChunkText(input, 100, 10)
	if len(chunks) < 2 {
		t.Fatal("expected multiple chunks")
	}
	for _, chunk := range chunks {
		if len([]rune(chunk.Text)) > 100 {
			t.Fatal("chunk exceeded rune limit")
		}
	}
}

func TestExactTopKAndRRF(t *testing.T) {
	if _, err := EncodeVector(make([]float32, EmbeddingDimensions)); err == nil {
		t.Fatal("zero-norm embedding was accepted")
	}
	query := make([]float32, EmbeddingDimensions)
	query[0] = 1
	records := []VectorRecord{
		{ID: "a", Vector: append([]float32(nil), query...)},
		{ID: "b", Vector: make([]float32, EmbeddingDimensions)},
	}
	records[1].Vector[1] = 1
	ranked, err := ExactTopK(query, records, 2)
	if err != nil {
		t.Fatal(err)
	}
	if ranked[0].ID != "a" {
		t.Fatalf("unexpected first result: %+v", ranked)
	}
	fused := ReciprocalRankFusion([]Ranked{{ID: "b"}, {ID: "a"}}, ranked, 2)
	if len(fused) != 2 {
		t.Fatal("expected two fused results")
	}
	weighted := WeightedReciprocalRankFusion([]WeightedRanking{
		{Weight: 1, Items: []Ranked{{ID: "baseline"}, {ID: "graph"}}},
		{Weight: .5, Items: []Ranked{{ID: "graph"}}},
	}, 2)
	if len(weighted) != 2 || weighted[0].ID != "graph" {
		t.Fatalf("unexpected weighted fusion: %+v", weighted)
	}
}

func TestEmbeddingProtocolBase64(t *testing.T) {
	vector := make([]float32, EmbeddingDimensions)
	vector[0] = 1
	raw, err := EncodeVector(vector)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("missing bearer token")
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["encoding_format"] != "base64" || int(body["dimensions"].(float64)) != EmbeddingDimensions {
			t.Errorf("unexpected request: %+v", body)
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"model": EmbeddingModel,
			"data":  []map[string]any{{"index": 0, "embedding": base64.StdEncoding.EncodeToString(raw)}},
		})
	}))
	defer server.Close()
	client := EmbeddingClient{
		BaseURL:    server.URL,
		HTTPClient: server.Client(),
		APIKey:     func(_ context.Context) (string, error) { return "test-key", nil },
	}
	vectors, err := client.Embed(context.Background(), []string{"hello"})
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(float64(vectors[0][0]-1)) > 0.0001 {
		t.Fatal("unexpected vector")
	}
}
