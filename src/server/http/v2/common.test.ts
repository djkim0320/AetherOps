import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { defaultSettings } from "../../runtime/storage/settingsStore.js";
import type { DurableJobDetail } from "../../composition/durableJobTypes.js";
import { toJobDetailResponse, toSettingsSaveInput, toToolDiagnosticsResponse } from "./common.js";

describe("API v2 settings projection", () => {
  it("updates the shared Codex planner and workspace task settings", () => {
    const current = defaultSettings;

    const next = toSettingsSaveInput(
      {
        codex: { model: "gpt-5.6-terra", reasoningEffort: "max", timeoutMs: 240_000, taskTimeoutMs: 600_000 },
        embedding: {
          provider: current.embedding.provider,
          model: current.embedding.model,
          baseUrl: current.embedding.baseUrl,
          dimensions: current.embedding.dimensions
        },
        search: {
          provider: current.webSearch.provider,
          endpoint: current.webSearch.endpoint,
          timeoutMs: current.webSearch.timeoutMs ?? 10_000
        },
        capabilities: { agent: false, engineering: false, search: false }
      },
      current
    );

    expect(next.codex).toEqual({
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
      timeoutMs: 240_000,
      taskTimeoutMs: 600_000
    });
    expect(next.allowAgent).toBe(false);
  });
});

describe("tool diagnostics projection", () => {
  it("explains fail-closed Codex CLI sandbox enforcement", () => {
    const response = toToolDiagnosticsResponse(
      { ...defaultSettings, allowAgent: true, allowCodeExecution: true },
      { authenticated: true, cliAvailable: true, catalog: "supported", access: "available" },
      reliabilityDiagnostics()
    );
    const codex = response.tools.find((tool) => tool.name === "CodexCliTool");
    expect(codex).toMatchObject({ status: "ready", category: "agent" });
    expect(codex?.reason).toContain("NOT_READY");
    expect(codex?.reason).toContain("no fallback");
  });

  it("reports Codex CLI as unavailable when the bundled runtime cannot be resolved", () => {
    const response = toToolDiagnosticsResponse(
      { ...defaultSettings, allowAgent: true, allowCodeExecution: true },
      { authenticated: true, cliAvailable: false, catalog: "supported", access: "not_checked", message: "Bundled CLI resolution failed." },
      reliabilityDiagnostics()
    );
    expect(response.tools.find((tool) => tool.name === "CodexCliTool")).toMatchObject({
      status: "unavailable",
      reason: "Bundled CLI resolution failed."
    });
  });
});

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

describe("job detail trace projection", () => {
  it("does not expose prompt, response, authorization, or process output fields", () => {
    const timestamp = "2026-07-10T00:00:00.000Z";
    const detail: DurableJobDetail = {
      id: "job-1",
      projectId: "project-1",
      kind: "research_loop",
      status: "running",
      projectRevision: 1,
      idempotencyKey: "key-1",
      requestHash: "request-hash",
      toolPolicy: {
        allowCodexCli: false,
        sourceAccess: { mode: "allowlist", urls: ["https://example.com/source?token=secret-policy-url"] }
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      traceAvailability: "available",
      traceSummary: {
        jobId: "job-1",
        counts: { llmInvocations: 0, toolDecisions: 1, toolAttempts: 0, codexCliExecutions: 0, outputs: 0, networkAudits: 1 },
        total: 2
      },
      tracePages: tracePages({ toolDecisions: 1, networkAudits: 1 }),
      traceBudget: { maxRecords: 300, maxSerializedBytes: 2_097_152, returned: 2, total: 2, truncated: false },
      trace: {
        llmInvocations: [],
        toolDecisions: [
          {
            id: "decision-1",
            projectId: "project-1",
            jobId: "job-1",
            toolName: "WebFetchTool",
            purpose: "Fetch source.",
            expectedOutcome: "Validated source.",
            rawSelection: {
              inputHash: "canonical-input-hash",
              inputs: {
                url: "https://example.com/source",
                authorization: "Bearer secret-token",
                nested: { prompt: "hidden", stdout: "hidden", safe: "visible" }
              }
            },
            compiledAction: { phase: "acquisition.fetch", ordinal: 0, apiKey: "sk-compiled-secret-value" },
            userPinned: false,
            policyStatus: "accepted",
            createdAt: timestamp
          }
        ],
        toolAttempts: [],
        codexCliExecutions: [],
        outputs: [],
        networkAudits: [
          {
            id: "audit-1",
            projectId: "project-1",
            jobId: "job-1",
            url: "https://user:password@example.com/source?token=secret-query&safe=yes",
            redirectChain: ["https://example.com/next?api_key=secret-redirect"],
            sourcePolicy: { mode: "allowlist", apiKey: "secret-policy" },
            policyDecision: "allowed",
            auditedAt: timestamp
          }
        ]
      }
    };
    const projected = toJobDetailResponse(detail);
    expect(projected.trace.toolDecisions[0]).not.toHaveProperty("rawSelection");
    expect(projected.trace.toolDecisions[0]).not.toHaveProperty("compiledAction");
    expect(projected.trace.toolDecisions[0]).toMatchObject({
      actionHash: "canonical-input-hash",
      actionSummary: { phase: "acquisition.fetch", ordinal: 0 }
    });
    expect(projected.trace.toolDecisions[0]?.validatedInputs).toMatchObject({
      url: "https://example.com/source",
      authorization: "[redacted]",
      nested: { prompt: "[redacted]", stdout: "[redacted]", safe: "visible" }
    });
    expect(projected.trace.networkAudits[0]?.url).not.toContain("password");
    expect(JSON.stringify(projected)).not.toMatch(/secret-token|hidden|compiled-secret|secret-query|secret-redirect|secret-policy/);

    detail.trace.toolDecisions[0]!.rawSelection = {
      inputHash: "bounded-input-hash",
      inputs: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, "x".repeat(1_000)]))
    };
    expect(toJobDetailResponse(detail).trace.toolDecisions[0]?.validatedInputs).toMatchObject({
      __traceTruncated: { reason: "serialized_byte_budget", maxBytes: 8_192 }
    });

    detail.trace.llmInvocations.push({
      id: "llm-legacy",
      projectId: "project-1",
      jobId: "job-1",
      model: "legacy-provider-model",
      reasoningEffort: "provider-effort",
      promptVersion: "legacy-v1",
      schemaVersion: "1",
      promptHash: "legacy-hash",
      repairCount: 0,
      status: "completed",
      startedAt: timestamp
    });
    detail.traceSummary.counts.llmInvocations = 1;
    detail.traceSummary.total = 3;
    detail.tracePages.llmInvocations = { order: "newest_first", total: 1, returned: 1, truncated: false };
    detail.traceBudget = { ...detail.traceBudget, returned: 3, total: 3 };
    expect(toJobDetailResponse(detail).trace.llmInvocations[0]).toMatchObject({ model: "legacy-provider-model", reasoningEffort: "provider-effort" });
  });

  it("adaptively trims an oversized page and returns an anchored continuation cursor", () => {
    const timestamp = "2026-07-10T00:00:00.000Z";
    const longUrl = `https://example.com/${"x".repeat(1_000)}`;
    const audits = Array.from({ length: 200 }, (_, index) => ({
      id: `audit-${index}`,
      projectId: "project-1",
      jobId: "job-large",
      attemptId: "a".repeat(256),
      url: longUrl,
      redirectChain: Array.from({ length: 8 }, () => longUrl),
      sourcePolicy: { mode: "allowlist" },
      policyDecision: "allowed" as const,
      reason: "r".repeat(1_000),
      auditedAt: timestamp
    }));
    const detail = {
      id: "job-large",
      projectId: "project-1",
      kind: "research_loop",
      status: "running",
      projectRevision: 1,
      idempotencyKey: "key-large",
      createdAt: timestamp,
      updatedAt: timestamp,
      traceAvailability: "available",
      traceSummary: {
        jobId: "job-large",
        counts: { llmInvocations: 0, toolDecisions: 0, toolAttempts: 0, codexCliExecutions: 0, outputs: 0, networkAudits: 200 },
        total: 200
      },
      tracePages: tracePages({ networkAudits: 200 }),
      traceContinuationCursors: traceCursors({ networkAudits: 200 }),
      traceBudget: { maxRecords: 300, maxSerializedBytes: 2_097_152, returned: 200, total: 200, truncated: false },
      trace: { llmInvocations: [], toolDecisions: [], toolAttempts: [], codexCliExecutions: [], outputs: [], networkAudits: audits }
    } satisfies DurableJobDetail;

    const response = toJobDetailResponse(detail);
    expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(2_097_152);
    expect(response.trace.networkAudits.length).toBeGreaterThan(0);
    expect(response.trace.networkAudits.length).toBeLessThan(200);
    expect(response.trace.pages.networkAudits).toMatchObject({ returned: response.trace.networkAudits.length, truncated: true });
    expect(response.trace.pages.networkAudits.nextCursor).toBe(`networkAudits-cursor-${response.trace.networkAudits.length - 1}`);
    expect(response.trace.budget).toMatchObject({ returned: response.trace.networkAudits.length, total: 200, truncated: true });
  });
});

function tracePages(counts: Partial<Record<keyof DurableJobDetail["trace"], number>>): DurableJobDetail["tracePages"] {
  const page = (returned: number) => ({ order: "newest_first" as const, total: returned, returned, truncated: false });
  return {
    llmInvocations: page(counts.llmInvocations ?? 0),
    toolDecisions: page(counts.toolDecisions ?? 0),
    toolAttempts: page(counts.toolAttempts ?? 0),
    codexCliExecutions: page(counts.codexCliExecutions ?? 0),
    outputs: page(counts.outputs ?? 0),
    networkAudits: page(counts.networkAudits ?? 0)
  };
}

function traceCursors(counts: Partial<Record<keyof DurableJobDetail["trace"], number>>): NonNullable<DurableJobDetail["traceContinuationCursors"]> {
  return Object.fromEntries(
    Object.keys(tracePages({})).map((category) => [
      category,
      Array.from({ length: counts[category as keyof DurableJobDetail["trace"]] ?? 0 }, (_, index) => `${category}-cursor-${index}`)
    ])
  ) as NonNullable<DurableJobDetail["traceContinuationCursors"]>;
}
