package knowledge

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/djkim0320/AetherOps/internal/store"
)

const successfulRunRecoveryReason = "startup recovery quarantined an incomplete successful-run knowledge candidate"

var successfulRunRecoveryMu sync.Mutex

// SuccessfulRunRecoveryResult separates a safety-control failure (returned as
// error) from a recoverable projection failure. The latter is retained here
// after the project head has durably become stale, allowing the UI to open so
// credentials or storage can be repaired without presenting an old graph as
// current.
type SuccessfulRunRecoveryResult struct {
	Pending               int      `json:"pending"`
	Recovered             int      `json:"recovered"`
	Failed                int      `json:"failed"`
	QuarantinedCandidates int      `json:"quarantined_candidates"`
	Failures              []string `json:"failures,omitempty"`
}

// RecoverSuccessfulRunAdoptions repairs the crash window between SucceedRun
// and the memory/knowledge projection commits. It is intentionally synchronous
// and project-FIFO; callers must invoke it before enabling new dispatch or
// schedules. Modern reports perform no new model turn. A legacy report that
// predates KnowledgePatch is the sole exception: it uses the fixed isolated
// extractor/reviewer profiles, persists the batch before each request, and
// refuses to replay an ambiguous request after restart. It never performs
// browser actions, command execution, or external submissions. IndexRun and
// AdoptRun are durable/idempotent: a committed document is not embedded twice,
// and immutable generation lineage prevents an applied patch from being
// projected twice.
func (service *Service) RecoverSuccessfulRunAdoptions(ctx context.Context) (SuccessfulRunRecoveryResult, error) {
	var result SuccessfulRunRecoveryResult
	successfulRunRecoveryMu.Lock()
	defer successfulRunRecoveryMu.Unlock()
	if err := service.configured(); err != nil {
		return result, err
	}
	if service.Memory == nil {
		return result, errors.New("successful-run recovery memory indexer is not configured")
	}
	if service.Sidecar == nil {
		return result, errors.New("successful-run recovery Oxigraph sidecar is not configured")
	}
	pending, err := service.DB.PendingSucceededRunAdoptions(ctx)
	if err != nil {
		return result, fmt.Errorf("list pending successful-run adoptions: %w", err)
	}
	result.Pending = len(pending)
	blockedProjects := make(map[string]string)
	for _, item := range pending {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if prior, blocked := blockedProjects[item.ProjectID]; blocked {
			result.recordRecoveryFailure(item.RunID,
				fmt.Errorf("project FIFO stopped after earlier run %s failed", prior))
			continue
		}
		// This write is the fail-closed startup boundary. If it cannot be made
		// durable, the application must not expose retrieval or new work.
		if err := service.markRunKnowledgeStale(ctx, item.ProjectID,
			"successful run adoption is incomplete; startup recovery required"); err != nil {
			return result, fmt.Errorf("mark project %s stale before recovering run %s: %w", item.ProjectID, item.RunID, err)
		}
		legacy, err := service.legacyReportNeedsBackfill(ctx, item.RunID)
		if err != nil {
			result.recordRecoveryFailure(item.RunID, fmt.Errorf("inspect successful report knowledge contract: %w", err))
			blockedProjects[item.ProjectID] = item.RunID
			continue
		}
		if !legacy {
			quarantined, err := service.DB.FailIncompleteRunKnowledgeCandidates(
				ctx, item.ProjectID, item.RunID, successfulRunRecoveryReason,
			)
			if err != nil {
				result.recordRecoveryFailure(item.RunID, fmt.Errorf("quarantine incomplete knowledge candidate: %w", err))
				blockedProjects[item.ProjectID] = item.RunID
				continue
			}
			result.QuarantinedCandidates += quarantined
		}
		if err := service.Memory.IndexRun(ctx, item.RunID); err != nil {
			result.recordRecoveryFailure(item.RunID, fmt.Errorf("index adopted memory: %w", err))
			blockedProjects[item.ProjectID] = item.RunID
			continue
		}
		if err := service.AdoptRun(ctx, item.RunID); err != nil {
			result.recordRecoveryFailure(item.RunID, fmt.Errorf("adopt successful-run knowledge: %w", err))
			blockedProjects[item.ProjectID] = item.RunID
			continue
		}
		result.Recovered++
	}
	return result, nil
}

func (result *SuccessfulRunRecoveryResult) recordRecoveryFailure(runID string, err error) {
	result.Failed++
	result.Failures = append(result.Failures, fmt.Sprintf("run %s: %v", runID, err))
}

func (service *Service) markRunKnowledgeStale(ctx context.Context, projectID, reason string) error {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return errors.New("knowledge stale reason is required")
	}
	for attempt := 0; attempt < 3; attempt++ {
		head, err := service.DB.ActiveKnowledgeGeneration(ctx, projectID)
		if err != nil {
			return err
		}
		if head.Status != store.KnowledgeHeadReady {
			return nil
		}
		if _, err := service.DB.SetKnowledgeHeadStatus(
			ctx, projectID, head.KnowledgeRevision, store.KnowledgeHeadStale, reason,
		); err == nil {
			return nil
		} else if attempt == 2 {
			return err
		}
	}
	return errors.New("knowledge head stale transition did not complete")
}
