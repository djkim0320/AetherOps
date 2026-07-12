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
      { authenticated: true, cliAvailable: true, catalog: "supported", access: "available" }
    );
    const codex = response.tools.find((tool) => tool.name === "CodexCliTool");
    expect(codex).toMatchObject({ status: "ready", category: "agent" });
    expect(codex?.reason).toContain("NOT_READY");
    expect(codex?.reason).toContain("no fallback");
  });

  it("reports Codex CLI as unavailable when the bundled runtime cannot be resolved", () => {
    const response = toToolDiagnosticsResponse(
      { ...defaultSettings, allowAgent: true, allowCodeExecution: true },
      { authenticated: true, cliAvailable: false, catalog: "supported", access: "not_checked", message: "Bundled CLI resolution failed." }
    );
    expect(response.tools.find((tool) => tool.name === "CodexCliTool")).toMatchObject({
      status: "unavailable",
      reason: "Bundled CLI resolution failed."
    });
  });
});

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
  });
});
