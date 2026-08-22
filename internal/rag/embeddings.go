package rag

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const EmbeddingModel = "text-embedding-3-small"

type EmbeddingClient struct {
	BaseURL    string
	HTTPClient *http.Client
	APIKey     func(context.Context) (string, error)
}

type embeddingRequest struct {
	Model          string   `json:"model"`
	Input          []string `json:"input"`
	EncodingFormat string   `json:"encoding_format"`
	Dimensions     int      `json:"dimensions"`
}

type embeddingResponse struct {
	Data []struct {
		Index     int    `json:"index"`
		Embedding string `json:"embedding"`
	} `json:"data"`
	Model string `json:"model"`
}

func (client *EmbeddingClient) Embed(ctx context.Context, inputs []string) ([][]float32, error) {
	if len(inputs) == 0 {
		return nil, errors.New("embedding input is empty")
	}
	if client.APIKey == nil {
		return nil, errors.New("OpenAI Platform API key is not configured")
	}
	key, err := client.APIKey(ctx)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(key) == "" {
		return nil, errors.New("OpenAI Platform API key is not configured")
	}
	baseURL := strings.TrimRight(client.BaseURL, "/")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	httpClient := client.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 45 * time.Second}
	}
	body, err := json.Marshal(embeddingRequest{
		Model: EmbeddingModel, Input: inputs, EncodingFormat: "base64", Dimensions: EmbeddingDimensions,
	})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("Content-Type", "application/json")
	response, err := httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("embeddings API returned %s: %s", response.Status, string(message))
	}
	var decoded embeddingResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 32<<20)).Decode(&decoded); err != nil {
		return nil, err
	}
	if decoded.Model != EmbeddingModel || len(decoded.Data) != len(inputs) {
		return nil, errors.New("unexpected embeddings response contract")
	}
	vectors := make([][]float32, len(inputs))
	for _, item := range decoded.Data {
		if item.Index < 0 || item.Index >= len(vectors) || vectors[item.Index] != nil {
			return nil, errors.New("invalid embedding index")
		}
		raw, err := base64.StdEncoding.DecodeString(item.Embedding)
		if err != nil {
			return nil, fmt.Errorf("decode embedding %d: %w", item.Index, err)
		}
		vector, err := DecodeVector(raw, EmbeddingDimensions)
		if err != nil {
			return nil, fmt.Errorf("validate embedding %d: %w", item.Index, err)
		}
		vectors[item.Index] = vector
	}
	return vectors, nil
}
