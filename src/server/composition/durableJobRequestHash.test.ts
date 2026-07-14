import { describe, expect, it } from "vitest";
import { durableEnqueueRequestHash, durablePublicJobRequestHash } from "./durableJobRequestHash.js";

describe("durable job request identity", () => {
  it("excludes server-derived execution projections from the non-RPC fallback hash", () => {
    const publicInput = {
      projectId: "project-1",
      kind: "research_loop",
      idempotencyKey: "start-1",
      requestedCapabilities: { agent: true, engineering: false, search: false },
      toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } },
      payload: {
        action: "start",
        requestedCapabilities: { agent: true, engineering: false, search: false },
        toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } },
        canonicalInitializationAnchor: { projectRevision: 1, currentStep: "PLAN_RESEARCH", snapshotHash: "first" }
      }
    };

    const firstInput = {
      ...publicInput,
      projectRevision: 1,
      currentStep: "PLAN_RESEARCH",
      effectiveCapabilities: { agent: true, engineering: false, search: false },
      jobId: "job-first"
    };
    const retryInput = {
      ...publicInput,
      projectRevision: 99,
      currentStep: "FINALIZE_OUTPUT",
      effectiveCapabilities: { agent: false, engineering: false, search: false },
      jobId: "job-retry",
      payload: {
        ...publicInput.payload,
        canonicalInitializationAnchor: { projectRevision: 99, currentStep: "FINALIZE_OUTPUT", snapshotHash: "retry" }
      }
    };
    const first = durableEnqueueRequestHash(firstInput);
    const retry = durableEnqueueRequestHash(retryInput);

    expect(retry).toBe(first);
  });

  it("changes when a public request field changes", () => {
    const base = {
      projectId: "project-1",
      kind: "chat_reply",
      idempotencyKey: "chat-1",
      payload: { sessionId: "session-1", content: "first", clientMutationId: "mutation-1" }
    };

    expect(durableEnqueueRequestHash({ ...base, payload: { ...base.payload, content: "second" } })).not.toBe(durableEnqueueRequestHash(base));
  });

  it.each([
    {
      method: "chat.enqueue",
      params: {
        projectId: "project-1",
        sessionId: "session-1",
        content: "Investigate the local evidence.",
        clientMutationId: "mutation-1",
        idempotencyKey: "chat-1"
      },
      changed: { content: "Investigate different evidence." }
    },
    {
      method: "loop.start",
      params: {
        projectId: "project-1",
        idempotencyKey: "start-1",
        requestedCapabilities: { agent: true, engineering: false, search: false },
        toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } }
      },
      changed: { requestedCapabilities: { agent: true, engineering: true, search: false } }
    },
    {
      method: "loop.resume",
      params: {
        projectId: "project-1",
        interruptedJobId: "job-1",
        checkpointId: "checkpoint-1",
        idempotencyKey: "resume-1",
        requestedCapabilities: { agent: true, engineering: false, search: false },
        toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } }
      },
      changed: { checkpointId: "checkpoint-2" }
    },
    {
      method: "engineering.enqueue",
      params: {
        projectId: "project-1",
        idempotencyKey: "engineering-1",
        requestedCapabilities: { agent: true, engineering: true, search: false },
        requests: [{ target: "webxfoil", input: { artifactId: "artifact-1" } }]
      },
      changed: { requests: [{ target: "webxfoil", input: { artifactId: "artifact-2" } }] }
    }
  ])("hashes only the public $method method and params", ({ method, params, changed }) => {
    const first = durablePublicJobRequestHash({ method, params });
    const retryRequest = { method, params, requestId: "request-retry" };
    const retry = durablePublicJobRequestHash(retryRequest);
    const different = durablePublicJobRequestHash({ method, params: { ...params, ...changed } });

    expect(retry).toBe(first);
    expect(different).not.toBe(first);
  });
});
