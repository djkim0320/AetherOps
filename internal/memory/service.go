package memory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/djkim0320/AetherOps/internal/cas"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/rag"
	"github.com/djkim0320/AetherOps/internal/store"
	"github.com/razvandimescu/gopdf/pdf"
)

const (
	embeddingBatchSize       = 64
	maxPDFMaterialBytes      = 64 << 20
	maxPDFExtractedTextBytes = 32 << 20
	maxPDFPages              = 2_000
	maxPDFInvalidUTF8Bytes   = 8_192
)

var ErrReindexUnavailable = errors.New("memory reindexer is not configured")

type Embedder interface {
	Embed(context.Context, []string) ([][]float32, error)
}

type Service struct {
	DB       *store.DB
	CAS      *cas.Store
	Embedder Embedder
}

// IndexRun indexes only materials already adopted by an atomic successful-run
// transition. Missing credentials or vector failures are returned explicitly;
// lexical-only substitution is never performed.
func (service *Service) IndexRun(ctx context.Context, runID string) error {
	if service.DB == nil || service.CAS == nil || service.Embedder == nil {
		return errors.New("memory indexer is not configured")
	}
	materials, err := service.DB.AdoptedMemoryMaterials(ctx, runID)
	if err != nil {
		return err
	}
	var failures []error
	for _, material := range materials {
		if err := service.indexMaterial(ctx, material); err != nil {
			failures = append(failures, fmt.Errorf("%s: %w", material.Title, err))
		}
	}
	return errors.Join(failures...)
}

func (service *Service) IndexAll(ctx context.Context) error {
	runIDs, err := service.DB.SucceededRuns(ctx)
	if err != nil {
		return err
	}
	var failures []error
	for _, runID := range runIDs {
		if err := service.IndexRun(ctx, runID); err != nil {
			failures = append(failures, fmt.Errorf("run %s: %w", runID, err))
		}
	}
	return errors.Join(failures...)
}

// ReindexProject rebuilds every ready document into a shadow embedding index
// and atomically activates it only after the store has verified complete
// coverage and every vector checksum. The active index is never changed on a
// partial embedding response or cancellation.
func (service *Service) ReindexProject(ctx context.Context, projectID string) (store.EmbeddingIndex, error) {
	if service.DB == nil || service.Embedder == nil {
		return store.EmbeddingIndex{}, ErrReindexUnavailable
	}
	if strings.TrimSpace(projectID) == "" {
		return store.EmbeddingIndex{}, errors.New("project id is required")
	}
	shadow, err := service.DB.BeginShadowIndex(ctx, projectID, rag.EmbeddingModel, rag.EmbeddingDimensions)
	if err != nil {
		return store.EmbeddingIndex{}, err
	}
	fail := func(cause error) (store.EmbeddingIndex, error) {
		if markErr := service.DB.FailShadowIndex(context.WithoutCancel(ctx), shadow.ID, cause.Error()); markErr != nil {
			return store.EmbeddingIndex{}, errors.Join(cause, fmt.Errorf("mark shadow index failed: %w", markErr))
		}
		return store.EmbeddingIndex{}, cause
	}
	chunks, err := service.DB.ShadowChunks(ctx, shadow.ID)
	if err != nil {
		return fail(err)
	}
	for start := 0; start < len(chunks); start += embeddingBatchSize {
		end := min(start+embeddingBatchSize, len(chunks))
		ids := make([]string, end-start)
		inputs := make([]string, end-start)
		for index := start; index < end; index++ {
			ids[index-start] = chunks[index].ID
			inputs[index-start] = chunks[index].Text
		}
		vectors, embedErr := service.Embedder.Embed(ctx, inputs)
		if embedErr != nil {
			return fail(embedErr)
		}
		if len(vectors) != len(inputs) {
			return fail(errors.New("embedding count does not match shadow chunks"))
		}
		if addErr := service.DB.AddShadowEmbeddings(ctx, shadow.ID, ids, vectors); addErr != nil {
			return fail(addErr)
		}
	}
	activated, err := service.DB.ActivateShadowIndex(ctx, shadow.ID)
	if err != nil {
		return fail(err)
	}
	return activated, nil
}

func (service *Service) MemoryStatus(ctx context.Context, projectID string) (store.ProjectMemoryHead, error) {
	if service.DB == nil {
		return store.ProjectMemoryHead{}, ErrReindexUnavailable
	}
	return service.DB.ProjectMemoryStatus(ctx, projectID)
}

// SearchProject performs the fail-closed hybrid_graph_v1 readback through the
// active vector index and active ready knowledge generation. It deliberately
// calls the configured production embedder and never substitutes hybrid_v1 or
// lexical-only results when the graph is unavailable.
func (service *Service) SearchProject(ctx context.Context, projectID, query string, limit int) ([]store.GraphMemoryResult, error) {
	if service.DB == nil || service.Embedder == nil {
		return nil, ErrReindexUnavailable
	}
	projectID = strings.TrimSpace(projectID)
	query = strings.TrimSpace(query)
	if projectID == "" || query == "" {
		return nil, errors.New("project id and search query are required")
	}
	status, err := service.DB.ProjectMemoryStatus(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if status.State != "ready" || status.ActiveIndex == nil || status.ActiveIndex.State != "active" ||
		status.ActiveIndex.Model != rag.EmbeddingModel || status.ActiveIndex.Dimensions != rag.EmbeddingDimensions {
		return nil, errors.New("project active memory index is not ready for the required embedding contract")
	}
	vectors, err := service.Embedder.Embed(ctx, []string{query})
	if err != nil {
		return nil, err
	}
	if len(vectors) != 1 {
		return nil, errors.New("query embedding count mismatch")
	}
	return service.DB.SearchMemoryWithGraph(ctx, projectID, query, vectors[0], limit)
}

// PinMaterial durably stores, embeds, and optionally marks a user-supplied
// source for graph adoption. Enabling graph adoption deliberately makes the
// current graph stale until a verified shadow generation is activated.
func (service *Service) PinMaterial(ctx context.Context, projectID, title, mediaType string, data []byte, graphAdopt bool) (store.Document, error) {
	if service.DB == nil || service.CAS == nil || service.Embedder == nil {
		return store.Document{}, errors.New("memory indexer is not configured")
	}
	if strings.TrimSpace(projectID) == "" || strings.TrimSpace(title) == "" || len(data) == 0 || len(data) > 16<<20 {
		return store.Document{}, errors.New("project, title, and material bytes up to 16 MiB are required")
	}
	if err := service.DB.ValidateMemoryMutationAllowed(ctx, projectID); err != nil {
		return store.Document{}, err
	}
	material := store.MemoryMaterial{ProjectID: projectID, Title: strings.TrimSpace(title), MediaType: strings.TrimSpace(mediaType)}
	text, supported, err := materialText(material, data)
	if err != nil {
		return store.Document{}, err
	}
	if !supported || text == "" {
		return store.Document{}, errors.New("pinned material must be UTF-8 text, JSON, XML, or an extractable PDF")
	}
	receipt, err := service.CAS.PutBytes(data)
	if err != nil {
		return store.Document{}, err
	}
	if _, err := service.CAS.ReadVerified(receipt.Hash); err != nil {
		return store.Document{}, err
	}
	if err := service.DB.RegisterBlob(ctx, receipt, mediaType); err != nil {
		return store.Document{}, err
	}
	chunks := rag.ChunkText(text, rag.DefaultChunkRunes, rag.DefaultOverlapRunes)
	if len(chunks) == 0 {
		return store.Document{}, errors.New("pinned material contains no indexable text")
	}
	vectors := make([][]float32, 0, len(chunks))
	for start := 0; start < len(chunks); start += embeddingBatchSize {
		end := min(start+embeddingBatchSize, len(chunks))
		inputs := make([]string, end-start)
		for index := start; index < end; index++ {
			inputs[index-start] = chunks[index].Text
		}
		batch, embedErr := service.Embedder.Embed(ctx, inputs)
		if embedErr != nil {
			return store.Document{}, embedErr
		}
		if len(batch) != len(inputs) {
			return store.Document{}, errors.New("embedding count does not match deterministic chunks")
		}
		vectors = append(vectors, batch...)
	}
	document, err := service.DB.IndexDocument(ctx, store.Document{ProjectID: projectID, Title: material.Title, BlobHash: receipt.Hash, EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions, Pinned: true}, chunks, vectors)
	if err != nil {
		return store.Document{}, err
	}
	if graphAdopt {
		return service.DB.UpdatePinnedMaterialGraphAdopt(ctx, projectID, document.ID, true)
	}
	return document, nil
}

func (service *Service) indexMaterial(ctx context.Context, material store.MemoryMaterial) error {
	exists, err := service.DB.MemoryDocumentExists(ctx, material.ProjectID, material.ArtifactID, material.BlobHash)
	if err != nil || exists {
		return err
	}
	data, err := service.CAS.ReadVerified(material.BlobHash)
	if err != nil {
		return err
	}
	text, supported, err := materialText(material, data)
	if err != nil || !supported {
		return err
	}
	chunks := rag.ChunkText(text, 4000, 400)
	if len(chunks) == 0 {
		return errors.New("adopted material contains no indexable text")
	}
	vectors := make([][]float32, 0, len(chunks))
	for start := 0; start < len(chunks); start += embeddingBatchSize {
		end := min(start+embeddingBatchSize, len(chunks))
		inputs := make([]string, end-start)
		for index := start; index < end; index++ {
			inputs[index-start] = chunks[index].Text
		}
		batch, err := service.Embedder.Embed(ctx, inputs)
		if err != nil {
			return err
		}
		if len(batch) != len(inputs) {
			return errors.New("embedding count does not match deterministic chunks")
		}
		vectors = append(vectors, batch...)
	}
	_, err = service.DB.IndexDocument(ctx, store.Document{
		ProjectID: material.ProjectID, ArtifactID: material.ArtifactID,
		Title: material.Title, BlobHash: material.BlobHash,
		EmbeddingModel: rag.EmbeddingModel, EmbeddingDimensions: rag.EmbeddingDimensions,
	}, chunks, vectors)
	return err
}

func materialText(material store.MemoryMaterial, data []byte) (string, bool, error) {
	if material.ArtifactID != "" {
		var report core.ReportManifest
		if err := json.Unmarshal(data, &report); err != nil {
			return "", false, fmt.Errorf("decode adopted report: %w", err)
		}
		return strings.TrimSpace(report.AnswerMarkdown), true, nil
	}
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(material.MediaType, ";")[0]))
	if mediaType == "application/pdf" {
		text, err := extractPDFText(data)
		if err != nil {
			return "", false, fmt.Errorf("extract PDF evidence: %w", err)
		}
		return text, true, nil
	}
	if !strings.HasPrefix(mediaType, "text/") && mediaType != "application/json" && mediaType != "application/xml" {
		return "", false, nil
	}
	if !utf8.Valid(data) {
		return "", false, errors.New("text evidence is not valid UTF-8")
	}
	return strings.TrimSpace(string(data)), true, nil
}

// extractPDFText converts a bounded, already hash-verified evidence blob into
// deterministic page-ordered text. The parser is pure Go and performs no
// subprocess, network, OCR, or filesystem access. Empty/scanned documents and
// parser failures are explicit errors so successful-run adoption can never
// silently omit an accepted source.
func extractPDFText(data []byte) (string, error) {
	if len(data) == 0 || len(data) > maxPDFMaterialBytes {
		return "", fmt.Errorf("PDF evidence size must be between 1 byte and %d bytes", maxPDFMaterialBytes)
	}
	document, err := pdf.OpenBytes(data)
	if err != nil {
		return "", err
	}
	pageCount := document.NumPages()
	if pageCount == 0 || pageCount > maxPDFPages {
		return "", fmt.Errorf("PDF page count %d is outside the supported range 1-%d", pageCount, maxPDFPages)
	}
	var builder strings.Builder
	totalTextBytes := 0
	invalidUTF8Bytes := 0
	for pageIndex := 0; pageIndex < pageCount; pageIndex++ {
		pageText, err := document.Page(pageIndex).Text()
		if err != nil {
			return "", fmt.Errorf("page %d: %w", pageIndex+1, err)
		}
		totalTextBytes += len(pageText)
		invalidUTF8Bytes += countInvalidUTF8Bytes(pageText)
		pageText = strings.TrimSpace(strings.ToValidUTF8(pageText, "\uFFFD"))
		if pageText == "" {
			continue
		}
		separatorBytes := 0
		if builder.Len() != 0 {
			separatorBytes = 2
		}
		if builder.Len()+separatorBytes+len(pageText) > maxPDFExtractedTextBytes {
			return "", fmt.Errorf("PDF extracted text exceeds %d bytes", maxPDFExtractedTextBytes)
		}
		if separatorBytes != 0 {
			builder.WriteString("\n\n")
		}
		builder.WriteString(pageText)
	}
	if invalidUTF8Bytes > maxPDFInvalidUTF8Bytes ||
		(totalTextBytes != 0 && invalidUTF8Bytes*100 > totalTextBytes) {
		return "", fmt.Errorf("PDF text contains too many invalid UTF-8 bytes: %d of %d", invalidUTF8Bytes, totalTextBytes)
	}
	text := strings.TrimSpace(builder.String())
	if text == "" {
		return "", errors.New("PDF contains no extractable text; OCR is not enabled")
	}
	return text, nil
}

func countInvalidUTF8Bytes(value string) int {
	count := 0
	for len(value) > 0 {
		_, size := utf8.DecodeRuneInString(value)
		if size == 1 && value[0] >= utf8.RuneSelf {
			count++
		}
		value = value[size:]
	}
	return count
}
