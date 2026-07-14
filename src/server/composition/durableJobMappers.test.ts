import { describe, expect, it } from "vitest";
import type { StorageJob } from "../runtime/storage/v2/types.js";
import { toDurableJobRecord } from "./durableJobMappers.js";

const NOW = "2026-07-14T00:00:00.000Z";

describe("durable job canonical initialization mapping", () => {
  it("reads the initialization anchor only from the persisted root request payload", () => {
    const anchor = { schemaVersion: 1, contentHash: "a".repeat(64) };
    const record = toDurableJobRecord(
      job({
        kind: "research_loop",
        projectRevision: 7,
        request: { action: "start", canonicalInitializationAnchor: anchor }
      })
    );

    expect(record.canonicalInitializationAnchor).toEqual(anchor);
    expect(record.projectRevision).toBe(7);
  });

  it("does not treat an unrelated payload field as the root initialization anchor", () => {
    const record = toDurableJobRecord(job({ canonicalInitializationAnchor: { forged: true }, request: { action: "start" } }));

    expect(record.canonicalInitializationAnchor).toBeUndefined();
  });
});

function job(payload: unknown): StorageJob {
  return {
    id: "job-root",
    projectId: "project-1",
    operation: "research_loop",
    status: "queued",
    priority: 0,
    attempt: 0,
    leaseGeneration: 0,
    payload,
    queuedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  };
}
