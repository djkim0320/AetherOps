package research

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/djkim0320/Aether-claw/internal/core"
)

// prepareCollectorEvidence resolves every opaque engineering receipt artifact
// id through the exact run and logical collector attempt. Only the resulting
// canonical bundle is allowed to reach validation, CAS persistence, checkpoint
// recovery, synthesis, and review.
func (engine *Engine) prepareCollectorEvidence(
	ctx context.Context,
	runID string,
	ordinal int,
	expectedWorkstreamID string,
	plan *core.ResearchPlan,
	raw json.RawMessage,
) (core.EvidenceBundle, error) {
	output, err := decodeStrict[collectorEvidenceOutput](raw)
	if err != nil {
		return core.EvidenceBundle{}, err
	}

	plannedOwner := ordinal == core.EngineeringScreeningOwnerOrdinal && plan != nil && plan.XFOILScreening != nil
	var bundle core.EvidenceBundle
	if plannedOwner {
		bundle, err = screeningOwnerPublicEvidence(output, expectedWorkstreamID)
		if err != nil {
			return core.EvidenceBundle{}, err
		}
		bundle, err = engine.rehydratePlannedXFOILScreeningReceipts(ctx, runID, *plan, bundle)
		if err != nil {
			return core.EvidenceBundle{}, fmt.Errorf("rehydrate planned XFOIL screening receipts: %w", err)
		}
	} else {
		if err := validateCollectorEvidenceOutput(output, expectedWorkstreamID); err != nil {
			return core.EvidenceBundle{}, err
		}
		sources := append([]core.EvidenceSource(nil), output.Sources...)
		for _, artifactID := range output.EngineeringReceiptArtifactIDs {
			source, err := engine.db.EngineeringReceiptEvidenceForCollector(ctx, runID, ordinal, artifactID)
			if err != nil {
				return core.EvidenceBundle{}, fmt.Errorf("resolve engineering receipt %q: %w", artifactID, err)
			}
			sources = append(sources, source)
		}
		bundle = output.canonicalBundle(sources)
	}
	bundle, err = canonicalizeEvidenceClaimIDs(runID, bundle)
	if err != nil {
		return core.EvidenceBundle{}, fmt.Errorf("canonicalize evidence claim ids: %w", err)
	}
	if err := validateEvidenceBundle(bundle, expectedWorkstreamID); err != nil {
		return core.EvidenceBundle{}, err
	}
	if err := bundle.Validate(expectedWorkstreamID); err != nil {
		return core.EvidenceBundle{}, err
	}
	if err := engine.verifyEvidenceSources(ctx, runID, ordinal, bundle); err != nil {
		return core.EvidenceBundle{}, err
	}
	return bundle, nil
}

// screeningOwnerPublicEvidence deliberately treats only model-authored public
// evidence as durable input. Planned engineering receipts and their claims are
// reconstructed later from the exact owner attempt in SQLite/CAS. A claim that
// mentions any non-public source is dropped whole: source ids are never
// repaired, substring-matched, or partially removed.
func screeningOwnerPublicEvidence(
	output collectorEvidenceOutput,
	expectedWorkstreamID string,
) (core.EvidenceBundle, error) {
	if strings.TrimSpace(output.WorkstreamID) == "" {
		return core.EvidenceBundle{}, fmt.Errorf("evidence workstream id is required")
	}
	if expectedWorkstreamID != "" && output.WorkstreamID != expectedWorkstreamID {
		return core.EvidenceBundle{}, fmt.Errorf("evidence workstream is %q, want %q", output.WorkstreamID, expectedWorkstreamID)
	}
	if strings.TrimSpace(output.Summary) == "" {
		return core.EvidenceBundle{}, fmt.Errorf("evidence summary is required")
	}
	if output.Claims == nil || output.Sources == nil || output.EngineeringReceiptArtifactIDs == nil || output.Limitations == nil {
		return core.EvidenceBundle{}, fmt.Errorf("collector evidence output omits a required array field")
	}

	publicIDs := make(map[string]struct{}, len(output.Sources))
	for _, source := range output.Sources {
		publicIDs[source.ID] = struct{}{}
	}
	publicClaims := make([]core.EvidenceClaim, 0, len(output.Claims))
	for _, claim := range output.Claims {
		publicOnly := len(claim.SourceIDs) > 0
		for _, sourceID := range claim.SourceIDs {
			if _, exists := publicIDs[sourceID]; !exists {
				publicOnly = false
				break
			}
		}
		if publicOnly {
			publicClaims = append(publicClaims, claim)
		}
	}

	public := output
	public.Claims = publicClaims
	public.EngineeringReceiptArtifactIDs = []string{}
	if len(public.Sources) > 0 {
		// Reuse the ordinary collector validator so public source URL, metadata,
		// claim membership, and duplicate checks remain exactly fail-closed.
		if err := validateCollectorEvidenceOutput(public, expectedWorkstreamID); err != nil {
			return core.EvidenceBundle{}, err
		}
	}
	return public.canonicalBundle(public.Sources), nil
}

func canonicalEvidenceOutput(bundle *core.EvidenceBundle) func(json.RawMessage) (json.RawMessage, error) {
	return func(json.RawMessage) (json.RawMessage, error) {
		if bundle == nil || bundle.WorkstreamID == "" {
			return nil, fmt.Errorf("canonical collector evidence is unavailable")
		}
		return json.Marshal(bundle)
	}
}
