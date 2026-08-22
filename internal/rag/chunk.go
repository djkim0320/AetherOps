package rag

import "strings"

const (
	DefaultChunkRunes   = 4000
	DefaultOverlapRunes = 400
)

type Chunk struct {
	Ordinal int
	Text    string
}

func ChunkText(text string, size, overlap int) []Chunk {
	if size <= 0 {
		size = DefaultChunkRunes
	}
	if overlap < 0 || overlap >= size {
		overlap = DefaultOverlapRunes
		if overlap >= size {
			overlap = size / 10
		}
	}
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	runes := []rune(normalized)
	if len(runes) == 0 {
		return nil
	}
	step := size - overlap
	chunks := make([]Chunk, 0, (len(runes)+step-1)/step)
	for start, ordinal := 0, 0; start < len(runes); start, ordinal = start+step, ordinal+1 {
		end := start + size
		if end > len(runes) {
			end = len(runes)
		}
		part := strings.TrimSpace(string(runes[start:end]))
		if part != "" {
			chunks = append(chunks, Chunk{Ordinal: ordinal, Text: part})
		}
		if end == len(runes) {
			break
		}
	}
	return chunks
}
