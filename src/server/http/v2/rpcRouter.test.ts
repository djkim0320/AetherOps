import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../runtime/storage/settingsStore.js";
import { IDEMPOTENCY_CONFLICT_PUBLIC_MESSAGE, IdempotencyConflictError } from "../../runtime/storage/v2/jobErrors.js";
import type { RpcHandlerContext } from "./context.js";
import { handleRpcV2, RpcV2Error, RpcValidationError } from "./rpcRouter.js";

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

  it("maps a durable idempotency hash mismatch to a safe CONFLICT response", async () => {
    const enqueue = vi.fn().mockRejectedValue(new IdempotencyConflictError());
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
      jobs: { enqueue }
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

    expect(enqueue).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ status: 409, code: "CONFLICT", message: IDEMPOTENCY_CONFLICT_PUBLIC_MESSAGE });
    expect(JSON.stringify(error)).not.toMatch(/private-idempotency-key|Do not expose/);
  });

  it("rejects cross-project and stale-revision controls before changing durable state", async () => {
    const requestPause = vi.fn();
    const pause = vi.fn();
    const context = {
      jobs: {
        get: vi.fn().mockResolvedValue(job("project-other", 4)),
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

    context.jobs.get = vi.fn().mockResolvedValue(job("project-1", 5));
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
      jobs: { get: vi.fn().mockResolvedValue(job("project-1", 4)), requestPause },
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

function job(projectId: string, projectRevision: number) {
  return {
    id: "job-1",
    projectId,
    kind: "research_loop" as const,
    status: "running" as const,
    projectRevision,
    currentStep: "PLAN_RESEARCH" as const,
    idempotencyKey: "job-key",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
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
