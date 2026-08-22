package rag

import (
	"encoding/binary"
	"errors"
	"math"
	"runtime"
	"sort"
	"sync"
)

const EmbeddingDimensions = 1536

type VectorRecord struct {
	ID     string
	Vector []float32
}

type Ranked struct {
	ID    string  `json:"id"`
	Score float64 `json:"score"`
}

type WeightedRanking struct {
	Weight float64
	Items  []Ranked
}

func DecodeVector(data []byte, dimensions int) ([]float32, error) {
	if len(data) != dimensions*4 {
		return nil, errors.New("embedding byte length does not match dimensions")
	}
	vector := make([]float32, dimensions)
	var norm float64
	for index := range vector {
		value := math.Float32frombits(binary.LittleEndian.Uint32(data[index*4:]))
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return nil, errors.New("embedding contains a non-finite value")
		}
		vector[index] = value
		norm += float64(value) * float64(value)
	}
	if norm == 0 {
		return nil, errors.New("embedding has zero norm")
	}
	return vector, nil
}

func EncodeVector(vector []float32) ([]byte, error) {
	if len(vector) != EmbeddingDimensions {
		return nil, errors.New("embedding dimension mismatch")
	}
	data := make([]byte, len(vector)*4)
	var norm float64
	for index, value := range vector {
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return nil, errors.New("embedding contains a non-finite value")
		}
		binary.LittleEndian.PutUint32(data[index*4:], math.Float32bits(value))
		norm += float64(value) * float64(value)
	}
	if norm == 0 {
		return nil, errors.New("embedding has zero norm")
	}
	return data, nil
}

func ExactTopK(query []float32, records []VectorRecord, limit int) ([]Ranked, error) {
	if len(query) != EmbeddingDimensions {
		return nil, errors.New("query dimension mismatch")
	}
	if limit <= 0 || len(records) == 0 {
		return nil, nil
	}
	workers := runtime.NumCPU()
	if workers < 1 {
		workers = 1
	}
	if workers > len(records) {
		workers = len(records)
	}

	jobs := make(chan VectorRecord)
	results := make(chan Ranked, len(records))
	var wait sync.WaitGroup
	wait.Add(workers)
	for worker := 0; worker < workers; worker++ {
		go func() {
			defer wait.Done()
			for record := range jobs {
				if len(record.Vector) != len(query) {
					results <- Ranked{ID: record.ID, Score: math.Inf(-1)}
					continue
				}
				var dot float64
				for index, value := range query {
					dot += float64(value) * float64(record.Vector[index])
				}
				results <- Ranked{ID: record.ID, Score: dot}
			}
		}()
	}
	go func() {
		for _, record := range records {
			jobs <- record
		}
		close(jobs)
		wait.Wait()
		close(results)
	}()

	ranked := make([]Ranked, 0, len(records))
	for result := range results {
		if math.IsInf(result.Score, -1) {
			return nil, errors.New("stored embedding dimension mismatch")
		}
		ranked = append(ranked, result)
	}
	sort.Slice(ranked, func(left, right int) bool {
		if ranked[left].Score == ranked[right].Score {
			return ranked[left].ID < ranked[right].ID
		}
		return ranked[left].Score > ranked[right].Score
	})
	if len(ranked) > limit {
		ranked = ranked[:limit]
	}
	return ranked, nil
}

func ReciprocalRankFusion(lexical, semantic []Ranked, limit int) []Ranked {
	return WeightedReciprocalRankFusion([]WeightedRanking{{Weight: 1, Items: lexical}, {Weight: 1, Items: semantic}}, limit)
}

// WeightedReciprocalRankFusion combines independently ranked result sets
// without treating model confidence as truth. Invalid or non-positive weights
// are ignored, and stable ID ordering breaks equal scores deterministically.
func WeightedReciprocalRankFusion(rankings []WeightedRanking, limit int) []Ranked {
	const rankConstant = 60.0
	scores := make(map[string]float64)
	for _, ranking := range rankings {
		if ranking.Weight <= 0 || math.IsNaN(ranking.Weight) || math.IsInf(ranking.Weight, 0) {
			continue
		}
		for index, item := range ranking.Items {
			if item.ID == "" {
				continue
			}
			scores[item.ID] += ranking.Weight / (rankConstant + float64(index+1))
		}
	}
	result := make([]Ranked, 0, len(scores))
	for id, score := range scores {
		result = append(result, Ranked{ID: id, Score: score})
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].Score == result[right].Score {
			return result[left].ID < result[right].ID
		}
		return result[left].Score > result[right].Score
	})
	if limit > 0 && len(result) > limit {
		result = result[:limit]
	}
	return result
}
