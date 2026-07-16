import { describe, expect, it, vi } from "vitest";
import { CanonicalRunRuntimeError } from "../../composition/canonicalRunTypes.js";
import { DurableResumeValidationError } from "../../composition/durableResumeValidator.js";
import { DurableRuntimeAdmissionError } from "../../composition/durableRuntimeAdmission.js";
import { defaultSettings } from "../../runtime/storage/settingsStore.js";
import { IDEMPOTENCY_CONFLICT_PUBLIC_MESSAGE, IdempotencyConflictError } from "../../runtime/storage/v2/jobErrors.js";
import { StorageImmutableConflictError, StorageOwnershipConflictError, StorageRevisionConflictError } from "../../runtime/storage/v2/runStateErrors.js";
import type { RpcHandlerContext } from "./context.js";
import { handleRpcV2, RpcV2Error, RpcValidationError } from "./rpcRouter.js";
import { job, researchEnqueueContext } from "./rpcRouterTestSupport.js";

describe("RPC v2 error mapping", () => {
  it.each([
    new Error("token=secret-provider-response at C:\\private\\file.txt"),
    "password=secret-string",
    new Error("outer provider failure", { cause: new Error("api_key=secret-cause") })
  ])("does not expose an unexpected failure: %s", async (failure) => {
    const context = contextWithSettingsFailure(failure);

    const error = await handleRpcV2({ requestId: "request-safe-1", method: "settings.get", params: {} }, context).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RpcV2Error);
    expect(error).toMatchObject({
      status: 500,
      requestId: "request-safe-1",
      code: "INTERNAL_ERROR",
      message: "The request could not be completed."
    });
    expect(JSON.stringify(error)).not.toMatch(/secret-provider|secret-string|secret-cause|private/);
  });

  it("preserves useful known validation errors", async () => {
    const context = contextWithSettingsFailure(new RpcValidationError("The selected value is invalid.", { field: "model" }));

    const error = await handleRpcV2({ requestId: "request-known-1", method: "settings.get", params: {} }, context).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "The selected value is invalid.",
      details: { field: "model" }
    });
  });

  it.each([
    { failure: new StorageRevisionConflictError(1, 2), status: 409, code: "CONFLICT" },
    { failure: new StorageImmutableConflictError(), status: 409, code: "CONFLICT" },
    { failure: new StorageOwnershipConflictError(), status: 404, code: "NOT_FOUND" }
  ])("maps $failure.name to the public $code response", async ({ failure, status, code }) => {
    const context = contextWithSettingsFailure(failure);

    const error = await handleRpcV2({ requestId: `request-${failure.name}`, method: "settings.get", params: {} }, context).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status, code });
    if (failure instanceof StorageOwnershipConflictError) {
      expect(error).toMatchObject({ message: "The requested resource was not found." });
    }
  });

  it("maps a draining durable runtime to an explicit NOT_READY response", async () => {
    const context = researchEnqueueContext(vi.fn().mockRejectedValue(new DurableRuntimeAdmissionError("draining")));

    const error = await handleRpcV2(
      {
        requestId: "request-runtime-draining",
        method: "chat.enqueue",
        params: {
          projectId: "project-1",
          sessionId: "session-1",
          content: "continue",
          clientMutationId: "mutation-runtime-draining",
          idempotencyKey: "runtime-draining"
        }
      },
      context
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 503, code: "NOT_READY", details: { runtimeState: "draining" } });
  });

  it.each([
    { canonicalCode: "INVALID_CANONICAL_RUN_INPUT" as const, status: 400, rpcCode: "VALIDATION_ERROR" },
    { canonicalCode: "CANONICAL_RESUME_CONFLICT" as const, status: 409, rpcCode: "CONFLICT" },
    { canonicalCode: "CANONICAL_RUN_NOT_READY" as const, status: 503, rpcCode: "NOT_READY" }
  ])("maps canonical runtime $canonicalCode to an explicit $rpcCode response", async ({ canonicalCode, status, rpcCode }) => {
    const context = contextWithSettingsFailure(new CanonicalRunRuntimeError(canonicalCode, "Canonical request cannot proceed."));

    const error = await handleRpcV2({ requestId: `request-${canonicalCode}`, method: "settings.get", params: {} }, context).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status, code: rpcCode, message: "Canonical request cannot proceed.", details: { canonicalCode } });
  });

  it.each([
    { resumeCode: "VALIDATION_ERROR" as const, status: 400 },
    { resumeCode: "CONFLICT" as const, status: 409 },
    { resumeCode: "NOT_READY" as const, status: 503 }
  ])("maps loop.resume durable validation $resumeCode without collapsing it to INTERNAL_ERROR", async ({ resumeCode, status }) => {
    const enqueue = vi.fn().mockRejectedValue(new DurableResumeValidationError(resumeCode, "The durable resume source cannot be used."));
    const context = researchEnqueueContext(enqueue);

    const error = await handleRpcV2(
      {
        requestId: `request-resume-${resumeCode}`,
        method: "loop.resume",
        params: {
          projectId: "project-1",
          interruptedJobId: "job-interrupted",
          checkpointId: "checkpoint-1",
          expectedProjectRevision: 1,
          idempotencyKey: `resume-${resumeCode}`,
          requestedCapabilities: { agent: true, engineering: false, search: false },
          toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } }
        }
      },
      context
    ).catch((caught: unknown) => caught);

    expect(enqueue).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ status, code: resumeCode, message: "The durable resume source cannot be used.", details: { resumeCode } });
  });

  it("rejects a resume whose expected project revision is stale", async () => {
    const enqueue = vi.fn();
    const context = researchEnqueueContext(enqueue);
    context.jobs.getProjectRevision = vi.fn().mockResolvedValue(2);

    const error = await handleRpcV2(
      {
        requestId: "request-resume-stale-project",
        method: "loop.resume",
        params: {
          projectId: "project-1",
          interruptedJobId: "job-interrupted",
          checkpointId: "checkpoint-1",
          expectedProjectRevision: 1,
          idempotencyKey: "resume-stale-project",
          requestedCapabilities: { agent: true, engineering: false, search: false },
          toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } }
        }
      },
      context
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 409, code: "CONFLICT" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("passes the project projection and job-bound capability audits into one atomic durable enqueue", async () => {
    const enqueue = vi.fn().mockResolvedValue({
      jobId: "job-start",
      projectId: "project-1",
      kind: "research_loop",
      status: "queued",
      acceptedAt: "2026-07-14T00:00:00.000Z",
      projectRevision: 1
    });
    const context = researchEnqueueContext(enqueue);
    context.jobs.getProjectRevision = vi.fn().mockResolvedValue(7);

    await handleRpcV2(
      {
        requestId: "request-project-owner",
        method: "loop.start",
        params: {
          projectId: "project-1",
          idempotencyKey: "project-owner",
          requestedCapabilities: { agent: true, engineering: false, search: false },
          toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } }
        }
      },
      context
    );

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: expect.any(String),
        projectId: "project-1",
        projectRevision: 7,
        project: expect.objectContaining({ id: "project-1" }),
        payload: expect.objectContaining({ engineeringBaseline: null }),
        capabilityAudits: expect.arrayContaining([
          expect.objectContaining({ projectId: "project-1", jobId: expect.any(String), capability: "agent" }),
          expect.objectContaining({ projectId: "project-1", jobId: expect.any(String), capability: "engineering" }),
          expect.objectContaining({ projectId: "project-1", jobId: expect.any(String), capability: "search" })
        ])
      })
    );
    const queued = enqueue.mock.calls[0]![0] as { jobId: string; capabilityAudits: Array<{ jobId?: string }> };
    expect(queued.capabilityAudits.every((audit) => audit.jobId === queued.jobId)).toBe(true);
    expect(context.jobs.recordCapabilityAudits).not.toHaveBeenCalled();
  });

  it("freezes the active engineering baseline identity and hash into a research enqueue", async () => {
    const enqueue = vi.fn().mockResolvedValue({
      jobId: "job-baseline-bound",
      projectId: "project-1",
      kind: "research_loop",
      status: "queued",
      acceptedAt: "2026-07-14T00:00:00.000Z",
      projectRevision: 1
    });
    const context = researchEnqueueContext(enqueue);
    vi.mocked(context.jobs.engineering.activeBaseline).mockResolvedValue({
      id: "baseline-active",
      projectId: "project-1",
      revision: 7,
      status: "active",
      unitConventionId: "si-v1",
      coordinateConventionId: "body-axis-v1",
      solverVersions: {},
      materialRevisionIds: [],
      sourceRevisionIds: ["source-1"],
      equationVersionIds: [],
      contentHash: "a".repeat(64),
      createdAt: "2026-07-14T00:00:00.000Z",
      createdBy: "test",
      provenance: [{ id: "source-1" }]
    });

    await handleRpcV2(
      {
        requestId: "request-baseline-bound",
        method: "loop.start",
        params: {
          projectId: "project-1",
          idempotencyKey: "baseline-bound",
          requestedCapabilities: { agent: true, engineering: false, search: false },
          toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } }
        }
      },
      context
    );

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          engineeringBaseline: { id: "baseline-active", revision: 7, contentHash: "a".repeat(64) }
        })
      })
    );
  });

  it("records a first-request denial with the project projection and preserves CAPABILITY_DENIED", async () => {
    const context = researchEnqueueContext(vi.fn());
    context.settingsStore.getRuntimeSettings = vi.fn().mockResolvedValue({ ...defaultSettings, allowAgent: false });

    const error = await handleRpcV2(
      {
        requestId: "request-first-denial",
        method: "loop.start",
        params: {
          projectId: "project-1",
          idempotencyKey: "first-denial",
          requestedCapabilities: { agent: true, engineering: false, search: false },
          toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } }
        }
      },
      context
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 403, code: "CAPABILITY_DENIED" });
    expect(context.jobs.recordCapabilityAudits).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ capability: "agent", allowed: false }),
        expect.objectContaining({ capability: "engineering" }),
        expect.objectContaining({ capability: "search" })
      ]),
      expect.objectContaining({ id: "project-1", projectRoot: ".tmp/projects/project-1" })
    );
  });

  it("maps a durable idempotency hash mismatch to a safe CONFLICT response", async () => {
    const enqueue = vi.fn();
    const findIdempotentReceipt = vi.fn().mockRejectedValue(new IdempotencyConflictError());
    const context = {
      orchestrator: {
        getSnapshot: vi.fn().mockResolvedValue({
          project: {
            id: "project-1",
            currentStep: "PLAN_RESEARCH",
            autonomyPolicy: { allowAgent: true, allowCodeExecution: false, allowExternalSearch: false }
          },
          iterations: []
        })
      },
      settingsStore: { getRuntimeSettings: vi.fn().mockResolvedValue(defaultSettings) },
      jobs: { enqueue, findIdempotentReceipt }
    } as unknown as RpcHandlerContext;

    const error = await handleRpcV2(
      {
        requestId: "request-idempotency-conflict",
        method: "chat.enqueue",
        params: {
          projectId: "project-1",
          sessionId: "session-1",
          content: "Do not expose this request body.",
          clientMutationId: "mutation-1",
          idempotencyKey: "private-idempotency-key"
        }
      },
      context
    ).catch((caught: unknown) => caught);

    expect(findIdempotentReceipt).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
    expect(error).toMatchObject({ status: 409, code: "CONFLICT", message: IDEMPOTENCY_CONFLICT_PUBLIC_MESSAGE });
    expect(JSON.stringify(error)).not.toMatch(/private-idempotency-key|Do not expose/);
  });

  it("returns the original receipt before changed revision and capability state are re-evaluated", async () => {
    const receipt = {
      jobId: "job-original",
      projectId: "project-1",
      kind: "research_loop" as const,
      status: "queued" as const,
      queuePosition: 1,
      acceptedAt: "2026-07-14T00:00:00.000Z",
      projectRevision: 1
    };
    let storedHash: string | undefined;
    const findIdempotentReceipt = vi.fn(async (_projectId: string, _key: string, requestHash: string) => {
      if (!storedHash) return undefined;
      if (storedHash !== requestHash) throw new IdempotencyConflictError();
      return receipt;
    });
    const enqueue = vi.fn(async (input: { requestHash: string }) => {
      storedHash = input.requestHash;
      return receipt;
    });
    const context = researchEnqueueContext(enqueue, findIdempotentReceipt);
    const getSnapshot = vi.mocked(context.orchestrator.getSnapshot);
    const getRuntimeSettings = vi.mocked(context.settingsStore.getRuntimeSettings);
    const request = {
      requestId: "request-first",
      method: "loop.start" as const,
      params: {
        projectId: "project-1",
        idempotencyKey: "stable-start",
        requestedCapabilities: { agent: true, engineering: false, search: false },
        toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" as const } }
      }
    };

    const first = await handleRpcV2(request, context);
    const changedSnapshot = await getSnapshot.mock.results[0]!.value;
    getSnapshot.mockResolvedValue({
      ...changedSnapshot,
      project: {
        ...changedSnapshot.project,
        updatedAt: "2026-07-14T00:01:00.000Z",
        autonomyPolicy: { ...changedSnapshot.project.autonomyPolicy, allowAgent: false }
      }
    });
    getRuntimeSettings.mockResolvedValue({ ...defaultSettings, allowAgent: false });

    const retry = await handleRpcV2({ ...request, requestId: "request-after-response-loss" }, context);
    const mismatch = await handleRpcV2(
      {
        ...request,
        requestId: "request-different",
        params: { ...request.params, requestedCapabilities: { agent: true, engineering: true, search: false } }
      },
      context
    ).catch((caught: unknown) => caught);

    expect(retry.result).toEqual(first.result);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(getSnapshot).toHaveBeenCalledOnce();
    expect(getRuntimeSettings).toHaveBeenCalledOnce();
    expect(context.jobs.getProjectRevision).toHaveBeenCalledOnce();
    expect(findIdempotentReceipt).toHaveBeenCalledTimes(3);
    expect(mismatch).toMatchObject({ status: 409, code: "CONFLICT", message: IDEMPOTENCY_CONFLICT_PUBLIC_MESSAGE });
  });

  it("rejects cross-project and stale-revision controls before changing durable state", async () => {
    const requestPause = vi.fn();
    const pause = vi.fn();
    const context = {
      jobs: {
        get: vi.fn().mockResolvedValue(job("project-other", 4)),
        getProjectRevision: vi.fn().mockResolvedValue(4),
        requestPause
      },
      orchestrator: { pause }
    } as unknown as RpcHandlerContext;
    const crossProject = await handleRpcV2(
      { requestId: "request-control-project", method: "loop.pause", params: { projectId: "project-1", jobId: "job-1", expectedProjectRevision: 4 } },
      context
    ).catch((error: unknown) => error);
    expect(crossProject).toMatchObject({ code: "NOT_FOUND" });
    expect(requestPause).not.toHaveBeenCalled();

    context.jobs.get = vi.fn().mockResolvedValue(job("project-1", 4));
    context.jobs.getProjectRevision = vi.fn().mockResolvedValue(5);
    const stale = await handleRpcV2(
      { requestId: "request-control-revision", method: "loop.pause", params: { projectId: "project-1", jobId: "job-1", expectedProjectRevision: 4 } },
      context
    ).catch((error: unknown) => error);
    expect(stale).toMatchObject({ code: "CONFLICT" });
    expect(requestPause).not.toHaveBeenCalled();
  });

  it("commits the durable control request before invoking the orchestrator", async () => {
    const requestPause = vi.fn().mockResolvedValue({ ...job("project-1", 4), status: "pause_requested" });
    const pause = vi.fn().mockResolvedValue(undefined);
    const context = {
      jobs: { get: vi.fn().mockResolvedValue(job("project-1", 4)), getProjectRevision: vi.fn().mockResolvedValue(4), requestPause },
      orchestrator: { pause }
    } as unknown as RpcHandlerContext;

    await handleRpcV2(
      { requestId: "request-control-order", method: "loop.pause", params: { projectId: "project-1", jobId: "job-1", expectedProjectRevision: 4 } },
      context
    );

    expect(requestPause).toHaveBeenCalledWith("job-1", 4);
    expect(requestPause.mock.invocationCallOrder[0]).toBeLessThan(pause.mock.invocationCallOrder[0] as number);
  });

  it("preserves the durable jobs list cursor in the RPC response", async () => {
    const context = {
      jobs: {
        list: vi.fn().mockResolvedValue({ jobs: [job("project-1", 4)], nextCursor: "job-next" })
      }
    } as unknown as RpcHandlerContext;

    const response = await handleRpcV2({ requestId: "request-list-cursor", method: "jobs.list", params: { projectId: "project-1", limit: 1 } }, context);

    expect(response).toMatchObject({ result: { nextCursor: "job-next", jobs: [{ id: "job-1" }] } });
  });

  it("projects the exact latest research execution without scanning a bounded jobs page", async () => {
    const list = vi.fn();
    const latestProjectExecution = vi.fn().mockResolvedValue({
      job: { ...job("project-1", 17), id: "job-newest", status: "paused", currentStep: "EXECUTE_TOOLS" },
      checkpoint: { id: "checkpoint-newest", step: "EXECUTE_TOOLS" }
    });
    const context = researchEnqueueContext(vi.fn());
    context.jobs = { latestProjectExecution, list, getProjectRevision: vi.fn().mockResolvedValue(23) } as unknown as RpcHandlerContext["jobs"];
    vi.mocked(context.projectMutations.readSnapshot).mockImplementation(async (projectId) => ({
      snapshot: await context.orchestrator.getSnapshot(projectId),
      projectRevision: 23
    }));

    const response = await handleRpcV2({ requestId: "request-latest-snapshot", method: "snapshots.get", params: { projectId: "project-1" } }, context);

    expect(response).toMatchObject({
      result: {
        projectId: "project-1",
        revision: 23,
        execution: {
          status: "paused",
          activeJobId: "job-newest",
          lastCheckpointId: "checkpoint-newest",
          currentStep: "EXECUTE_TOOLS",
          revision: 23
        }
      }
    });
    expect(latestProjectExecution).toHaveBeenCalledWith("project-1", "research_loop");
    expect(list).not.toHaveBeenCalled();
  });

  it("passes an optional bounded trace page through jobs.get", async () => {
    const getDetail = vi.fn().mockResolvedValue(undefined);
    const context = { jobs: { getDetail } } as unknown as RpcHandlerContext;
    const tracePage = { category: "outputs" as const, cursor: "stable_cursor", limit: 20 };

    const error = await handleRpcV2(
      { requestId: "request-job-trace-page", method: "jobs.get", params: { projectId: "project-1", jobId: "job-1", tracePage } },
      context
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "NOT_FOUND" });
    expect(getDetail).toHaveBeenCalledWith("job-1", tracePage);
  });

  it("adds the durable reliability snapshot to tool diagnostics", async () => {
    const reliability = reliabilityDiagnostics();
    const operationalDiagnostics = vi.fn().mockResolvedValue(reliability);
    const context = {
      settingsStore: { getRuntimeSettings: vi.fn().mockResolvedValue(defaultSettings) },
      jobs: { operationalDiagnostics }
    } as unknown as RpcHandlerContext;

    const response = await handleRpcV2({ requestId: "request-reliability", method: "tools.diagnostics", params: {} }, context);

    expect(operationalDiagnostics).toHaveBeenCalledOnce();
    expect(response).toMatchObject({ result: { reliability } });
  });

  it("maps a semantically invalid opaque trace cursor to VALIDATION_ERROR", async () => {
    const failure = new Error("Invalid trace pagination cursor.");
    failure.name = "InvalidTraceCursorError";
    const context = { jobs: { getDetail: vi.fn().mockRejectedValue(failure) } } as unknown as RpcHandlerContext;

    const error = await handleRpcV2(
      {
        requestId: "request-invalid-trace-cursor",
        method: "jobs.get",
        params: { projectId: "project-1", jobId: "job-1", tracePage: { category: "outputs", cursor: "syntactically_valid" } }
      },
      context
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 400, code: "VALIDATION_ERROR", message: "The trace page cursor is invalid." });
  });
});

function contextWithSettingsFailure(failure: unknown): RpcHandlerContext {
  return {
    settingsStore: { getRuntimeSettings: vi.fn().mockRejectedValue(failure) }
  } as unknown as RpcHandlerContext;
}

function reliabilityDiagnostics() {
  return {
    generatedAt: "2026-07-14T00:00:00.000Z",
    countersSince: "2026-07-14T00:00:00.000Z",
    runtime: {
      activeProjectCount: 0,
      activeJobCount: 0,
      leaseRenewalSuccessCount: 0,
      leaseRenewalFailureCount: 0,
      leaseLostCount: 0,
      staleWriteRejectionCount: 0,
      recoveryScannedProjectCount: 0
    },
    sse: {
      activeConnectionCount: 0,
      bufferedEventCount: 0,
      bufferedBytes: 0,
      peakBufferedEventCount: 0,
      peakBufferedBytes: 0,
      slowConsumerDisconnectCount: 0,
      replayCount: 0,
      replayedEventCount: 0,
      replayTotalDurationMs: 0,
      replayMaxDurationMs: 0,
      replayLastDurationMs: 0
    },
    traceQueries: { queryCount: 0, totalDurationMs: 0, maxDurationMs: 0, lastDurationMs: 0, totalRows: 0, maxRows: 0, lastRows: 0 },
    storageTransactions: { transactionCount: 0, totalDurationMs: 0, maxDurationMs: 0, lastDurationMs: 0 },
    queue: { projects: [], totalDepth: 0, totalProjects: 0, truncated: false }
  };
}
