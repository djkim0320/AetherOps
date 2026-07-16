import { describe, expect, it } from "vitest";
import type { StorageOutputPromotion } from "./jobAtomicTypes.js";
import { storageTerminalCasPromotionReceipts } from "./terminalCasPromotionReceipts.js";

describe("terminal CAS promotion receipts", () => {
  it("deduplicates an exact claim replay but rejects reuse by another output owner", () => {
    const promotion = claimedPromotion("artifact-owner");

    expect(storageTerminalCasPromotionReceipts([promotion, { ...promotion, link: { ...promotion.link } }]).claims).toHaveLength(1);
    expect(() => storageTerminalCasPromotionReceipts([promotion, { ...promotion, link: { ...promotion.link, outputId: "artifact-conflict" } }])).toThrow(
      /reused across different objects or owners/i
    );
  });
});

function claimedPromotion(outputId: string): StorageOutputPromotion {
  const casHash = "a".repeat(64);
  const artifact = { casLocator: `terminal-cas/sha256/aa/${casHash}`, sha256: casHash, byteLength: 17 };
  return {
    link: {
      id: "output-link-owner",
      projectId: "project-owner",
      jobId: "job-owner",
      attemptId: "attempt-owner",
      outputKind: "artifact",
      outputId,
      promoted: true,
      createdAt: "2026-07-16T00:00:00.000Z",
      promotedAt: "2026-07-16T00:00:01.000Z"
    },
    engineering: { artifact } as NonNullable<StorageOutputPromotion["engineering"]>,
    pendingCasObject: {
      casLocator: artifact.casLocator,
      casHash,
      byteLength: artifact.byteLength,
      pendingClaimId: "12345678-1234-4123-8123-123456789abc"
    }
  };
}
