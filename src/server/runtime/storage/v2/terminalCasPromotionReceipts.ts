import type { StorageOutputPromotion } from "./jobAtomicTypes.js";
import { deduplicateStorageTerminalCasClaims, type StorageTerminalCasClaim, type StorageTerminalCasObject } from "./terminalCasStore.js";

export interface StorageTerminalCasPromotionReceipts {
  claims: StorageTerminalCasClaim[];
  legacy: StorageTerminalCasObject[];
}

export function storageTerminalCasPromotionReceipts(promotions: readonly StorageOutputPromotion[] | undefined): StorageTerminalCasPromotionReceipts {
  const claims: StorageTerminalCasClaim[] = [];
  const legacy: StorageTerminalCasObject[] = [];
  for (const promotion of promotions ?? []) {
    if (promotion.pendingCasObject) {
      if (!promotion.engineering || !matchesPromotionCas(promotion.pendingCasObject, promotion.engineering.artifact)) {
        throw new Error("Engineering pending CAS claim does not match its terminal promotion.");
      }
      claims.push({
        object: promotion.pendingCasObject,
        owner: {
          projectId: promotion.link.projectId,
          jobId: promotion.link.jobId,
          attemptId: promotion.link.attemptId,
          outputKind: requiredClaimOutputKind(promotion.link.outputKind),
          outputId: promotion.link.outputId
        }
      });
      continue;
    }
    if (promotion.engineering) {
      legacy.push({
        casLocator: promotion.engineering.artifact.casLocator,
        casHash: promotion.engineering.artifact.sha256,
        byteLength: promotion.engineering.artifact.byteLength
      });
    }
  }
  return {
    claims: deduplicateStorageTerminalCasClaims(claims),
    legacy: [...new Map(legacy.map((object) => [object.casLocator, object])).values()]
  };
}

function matchesPromotionCas(object: StorageTerminalCasObject, artifact: { casLocator: string; sha256: string; byteLength: number }): boolean {
  return (
    Boolean(object.pendingClaimId) &&
    object.casLocator === artifact.casLocator &&
    object.casHash === artifact.sha256 &&
    object.byteLength === artifact.byteLength
  );
}

function requiredClaimOutputKind(value: string): "artifact" | "evidence" {
  if (value !== "artifact" && value !== "evidence") throw new Error("Engineering pending CAS claim output kind is invalid.");
  return value;
}
