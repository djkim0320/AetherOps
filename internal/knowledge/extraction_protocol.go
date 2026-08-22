package knowledge

import (
	"context"
	"encoding/json"
)

const (
	PinnedExtractorContractVersion = "aetherops-pinned-knowledge-extractor-v2"
	PinnedReviewerContractVersion  = "aetherops-pinned-knowledge-reviewer-v2"
)

// ExtractionThreadOptions fixes the model identity at thread creation. The
// production adapter additionally enforces a read-only, offline sandbox for
// every turn. Keeping this contract in the knowledge package prevents the
// graph pipeline from depending on Codex transport implementation details.
type ExtractionThreadOptions struct {
	Model           string
	ReasoningEffort string
	ServiceTier     string
	ServiceName     string
}

type ExtractionTurnOptions struct {
	Model           string
	ReasoningEffort string
	ServiceTier     string
	Schema          json.RawMessage
	Prompt          string
}

type ExtractionTurnResult struct {
	ThreadID        string
	TurnID          string
	Model           string
	ReasoningEffort string
	ServiceTier     string
	Output          json.RawMessage
}

// ExtractionProtocol is deliberately smaller than the research protocol. It
// has no steering, resume, file-write, browser, or external-tool surface.
// Implementations must not substitute a model, effort, or service tier.
type ExtractionProtocol interface {
	ValidateModel(ctx context.Context, model, reasoningEffort, serviceTier string) error
	CreateExtractionThread(ctx context.Context, options ExtractionThreadOptions) (string, error)
	ExtractionTurn(ctx context.Context, threadID string, options ExtractionTurnOptions) (ExtractionTurnResult, error)
}
