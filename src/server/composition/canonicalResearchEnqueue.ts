import type { ResearchSnapshot } from "../../core/shared/evaluationTypes.js";
import type { StorageCapabilitySet, StorageJobToolPolicy } from "../runtime/storage/v2/types.js";
import { createCanonicalInitializationAnchor } from "./canonicalInitializationAnchor.js";
import { DEFAULT_CANONICAL_TASK_LIMITS } from "./durableCanonicalResearchSession.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";

interface CanonicalResearchStartPayloadInput {
  snapshot: ResearchSnapshot;
  payload: Record<string, unknown>;
  requestedCapabilities: StorageCapabilitySet;
  effectiveCapabilities: StorageCapabilitySet;
  toolPolicy: StorageJobToolPolicy;
}

export function canonicalResearchStartPayload(input: CanonicalResearchStartPayloadInput): Record<string, unknown> {
  if (input.payload.action !== "start") throw new Error("Canonical initialization anchors are created only for new research runs.");
  const canonicalInitializationAnchor = createCanonicalInitializationAnchor(
    {
      snapshot: input.snapshot,
      policy: {
        requestedCapabilities: input.requestedCapabilities,
        effectiveCapabilities: input.effectiveCapabilities,
        toolPolicy: input.toolPolicy,
        externalSideEffects: []
      },
      taskLimits: DEFAULT_CANONICAL_TASK_LIMITS
    },
    { sha256Canonical: durableJobRequestHash }
  );
  return { ...input.payload, canonicalInitializationAnchor };
}
