import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStorageV2Repositories } from "./repositories.js";
import { storageCanonicalHasher } from "./runStatePayloadValidator.js";
import { migrateStorageV2Schema } from "./schema.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  migrateStorageV2Schema(db);
});

afterEach(() => db.close());

describe("job tool policy storage boundary", () => {
  it.each(["https://user:credential@example.com/source", "https://example.com/source?token=credential", "https://example.com/source#credential"])(
    "rejects a non-persistable allowlist URL before inserting the job",
    (url) => {
      const jobs = createStorageV2Repositories({ appDb: db }).jobs;

      expect(() => jobs.enqueue(jobInput(url))).toThrow("unsafe for operational storage");
      expect(db.prepare("select count(*) as count from jobs").get()).toEqual({ count: 0 });
    }
  );

  it("persists a canonical secret-free allowlist URL", () => {
    const jobs = createStorageV2Repositories({ appDb: db }).jobs;

    expect(jobs.enqueue(jobInput("https://example.com/source"))).toMatchObject({
      toolPolicy: { sourceAccess: { mode: "allowlist", urls: ["https://example.com/source"] } }
    });
  });

  it.each([
    null,
    false,
    { allowCodexCli: false, sourceAccess: { mode: "offline" }, token: "credential" },
    { allowCodexCli: false, sourceAccess: { mode: "unknown", token: "credential" } },
    { allowCodexCli: false, sourceAccess: { mode: "allowlist", urls: ["https://example.com/source"], token: "credential" } },
    { allowCodexCli: false, sourceAccess: { mode: "discovery", allowedDomains: ["Example.COM"] } }
  ])("rejects unknown, non-canonical, or extra runtime fields before inserting the job", (toolPolicy) => {
    const jobs = createStorageV2Repositories({ appDb: db }).jobs;

    expect(() => jobs.enqueue({ ...jobInput("https://example.com/source"), toolPolicy: toolPolicy as never })).toThrow("unsafe for operational storage");
    expect(db.prepare("select count(*) as count from jobs").get()).toEqual({ count: 0 });
  });

  it.each([
    {
      action: "resume",
      toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "allowlist", urls: ["https://example.com/source?token=credential"] } }
    },
    { action: "resume", toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } } },
    {
      action: "start",
      toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "allowlist", urls: ["https://example.com/source"] } },
      canonicalInitializationAnchor: { token: "credential" }
    }
  ])("rejects an unsafe, mismatched, or malformed duplicate research policy", (request) => {
    const jobs = createStorageV2Repositories({ appDb: db }).jobs;

    expect(() => jobs.enqueue({ ...jobInput("https://example.com/source"), payload: { request } })).toThrow("unsafe for operational storage");
    expect(db.prepare("select count(*) as count from jobs").get()).toEqual({ count: 0 });
  });

  it("accepts a hash-bound canonical initialization policy matching the dedicated columns", () => {
    const jobs = createStorageV2Repositories({ appDb: db }).jobs;
    const input = canonicalStartJobInput();

    expect(jobs.enqueue(input)).toMatchObject({ id: input.id, toolPolicy: input.toolPolicy });
  });
});

function jobInput(url: string) {
  return {
    id: `job-${randomUUID()}`,
    projectId: "project-policy-boundary",
    operation: "research_loop",
    toolPolicy: {
      allowCodexCli: false,
      sourceAccess: { mode: "allowlist" as const, urls: [url] }
    }
  };
}

function canonicalStartJobInput() {
  const base = jobInput("https://example.com/source");
  const requestedCapabilities = { agent: true, engineering: false, search: true };
  const effectiveCapabilities = { agent: true, engineering: false, search: true };
  const immutablePolicy = { requestedCapabilities, effectiveCapabilities, toolPolicy: base.toolPolicy };
  const body = { schemaVersion: 1, projectId: base.projectId, taskSource: {}, immutablePolicy, taskLimits: {} };
  return {
    ...base,
    requestedCapabilities,
    effectiveCapabilities,
    payload: {
      request: {
        action: "start",
        toolPolicy: base.toolPolicy,
        canonicalInitializationAnchor: { ...body, contentHash: storageCanonicalHasher.sha256Canonical(body) }
      }
    }
  };
}
