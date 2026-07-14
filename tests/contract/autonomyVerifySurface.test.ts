import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createArtifactWriter } from "../../scripts/autonomy/artifacts.mjs";
import { parseAutonomyArgs } from "../../scripts/autonomy/args.mjs";
import { selectGoldenCases } from "../../scripts/autonomy/cases.mjs";
import { assertExactLiveRuntime, getAutonomyProfile, requiredLiveRuntime } from "../../scripts/autonomy/profiles.mjs";
import { sanitizeAutonomyArtifact } from "../../scripts/autonomy/sanitize.mjs";
import { scoreLiveCase } from "../../scripts/autonomy/live-score.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("autonomy verification surface", () => {
  it("defines the four bounded profiles and all ten golden cases", () => {
    expect(getAutonomyProfile("offline")).toMatchObject({ live: false, repetitions: 1, concurrency: 1 });
    expect(getAutonomyProfile("smoke")).toMatchObject({ live: true, repetitions: 1, concurrency: 1 });
    expect(getAutonomyProfile("nightly")).toMatchObject({ live: true, repetitions: 3, concurrency: 2 });
    expect(getAutonomyProfile("release")).toMatchObject({ live: true, repetitions: 5, concurrency: 2 });
    expect(selectGoldenCases(getAutonomyProfile("release").caseIds)).toHaveLength(10);
  });

  it("requires the exact live model, effort, and timeout without fallback", () => {
    expect(requiredLiveRuntime()).toEqual({ model: "gpt-5.6-sol", reasoningEffort: "high", timeoutMs: 180_000, taskTimeoutMs: 600_000 });
    expect(() => assertExactLiveRuntime(requiredLiveRuntime())).not.toThrow();
    expect(() => assertExactLiveRuntime({ model: "gpt-5.6", reasoningEffort: "high", timeoutMs: 180_000, taskTimeoutMs: 600_000 })).toThrow("model");
    expect(() => assertExactLiveRuntime({ model: "gpt-5.6-sol", reasoningEffort: "xhigh", timeoutMs: 180_000, taskTimeoutMs: 600_000 })).toThrow(
      "reasoningEffort"
    );
  });

  it("parses explicit profiles and rejects unknown arguments", () => {
    expect(parseAutonomyArgs(["--profile", "nightly", "--timeout-ms=1000"], "D:/workspace")).toMatchObject({ profile: "nightly", timeoutMs: 1000 });
    expect(() => parseAutonomyArgs(["--profile", "unknown"])).toThrow("Unknown autonomy profile");
    expect(() => parseAutonomyArgs(["--synthetic-success"])).toThrow("Unknown autonomy verify argument");
  });

  it("redacts credentials, prompt text, and URL query material from artifacts", () => {
    const promptHash = "a".repeat(64);
    expect(
      sanitizeAutonomyArtifact({
        apiKey: "sk-example-secret",
        promptRaw: "private instructions",
        promptHash,
        url: "https://user:pass@example.com/path?token=secret#fragment",
        authorization: "Bearer private-token",
        authorizationReceipt: { requestedProjectId: "project-1", decision: "allowed", policyHash: promptHash }
      })
    ).toEqual({
      apiKey: "[REDACTED]",
      promptRaw: "[REDACTED]",
      promptHash,
      url: "https://example.com/path",
      authorization: "[REDACTED]",
      authorizationReceipt: { requestedProjectId: "project-1", decision: "allowed", policyHash: promptHash }
    });
  });

  it("redacts provider streams, reasoning, and local paths from structured and text artifacts", () => {
    const sanitized = sanitizeAutonomyArtifact({
      stdout: "provider raw output",
      stderr: "provider diagnostic",
      providerResponse: "full response",
      reasoning: "hidden reasoning",
      absolutePath: "C:\\Users\\private-user\\workspace\\artifact.json",
      summary: "read C:\\Users\\private-user\\workspace\\artifact.json",
      publicUrl: "https://example.com/tmp/reference.json"
    });
    expect(sanitized).toEqual({
      stdout: "[REDACTED]",
      stderr: "[REDACTED]",
      providerResponse: "[REDACTED]",
      reasoning: "[REDACTED]",
      absolutePath: "[REDACTED]",
      summary: "read [LOCAL_PATH]",
      publicUrl: "https://example.com/tmp/reference.json"
    });

    const root = mkdtempSync(join(tmpdir(), "aetherops-artifact-sanitizer-"));
    temporaryRoots.push(root);
    const writer = createArtifactWriter(root);
    writer.text("report.md", "credential sk-example-secret at C:\\Users\\private-user\\report.md");
    expect(readFileSync(join(root, "report.md"), "utf8")).toBe("credential [REDACTED] at [LOCAL_PATH]");
  });

  it("preserves validated telemetry metadata but rejects metadata-key and free-text bypasses", () => {
    const hash = "a".repeat(64);
    expect(
      sanitizeAutonomyArtifact({
        inputTokens: 12,
        outputTokens: 4,
        contextTokens: { value: null, unit: "tokens", unmeasuredReason: "The source trace did not measure context tokens." },
        totalToolOutputBytes: { value: 1024, unit: "bytes", sampleCount: 2 },
        reasoningEffort: "high",
        responseHash: hash,
        promptVersion: "planner-v1",
        invalidResponseHash: "raw private response"
      })
    ).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      contextTokens: { value: null, unit: "tokens", unmeasuredReason: "The source trace did not measure context tokens." },
      totalToolOutputBytes: { value: 1024, unit: "bytes", sampleCount: 2 },
      reasoningEffort: "high",
      responseHash: hash,
      promptVersion: "planner-v1",
      invalidResponseHash: "raw private response"
    });

    expect(
      sanitizeAutonomyArtifact({
        responseHash: "raw private response",
        promptVersion: "private instructions with spaces"
      })
    ).toEqual({ responseHash: "[REDACTED]", promptVersion: "[REDACTED]" });

    expect(
      sanitizeAutonomyArtifact({
        contextTokens: { value: 5129, unit: "benchmark_tokens", originReceiptIds: ["receipt-0006", "receipt-0015"] },
        totalToolOutputBytes: {
          value: 8294,
          unit: "bytes",
          originReceiptIds: ["receipt-0008", "receipt-0009", "receipt-0010"]
        }
      })
    ).toEqual({
      contextTokens: { value: 5129, unit: "benchmark_tokens", originReceiptIds: ["receipt-0006", "receipt-0015"] },
      totalToolOutputBytes: {
        value: 8294,
        unit: "bytes",
        originReceiptIds: ["receipt-0008", "receipt-0009", "receipt-0010"]
      }
    });
    expect(
      sanitizeAutonomyArtifact({
        contextTokens: { value: 5129, unit: "benchmark_tokens", originReceiptIds: ["receipt-sk-example-private-token"] }
      })
    ).toEqual({ contextTokens: "[REDACTED]" });
    expect(
      sanitizeAutonomyArtifact({
        contextTokens: { value: null, unit: "benchmark_tokens", originReceiptIds: ["receipt-0006"] }
      })
    ).toEqual({ contextTokens: "[REDACTED]" });

    const root = mkdtempSync(join(tmpdir(), "aetherops-artifact-free-text-"));
    temporaryRoots.push(root);
    const writer = createArtifactWriter(root);
    writer.text(
      "report.md",
      [
        "Authorization: Basic dXNlcjpwYXNz",
        "query https://user:pass@example.com/path?api_key=plain-secret#fragment",
        "chain-of-thought: private hidden steps",
        "reasoning: hidden private steps",
        "analysis: hidden scratchpad",
        "- Reasoning: `high`",
        "AWS_SECRET_ACCESS_KEY=abcd1234secret",
        "OPENAI_API_KEY=plainvalue123",
        "ANTHROPIC_API_KEY=anotherplainvalue",
        "GITHUB_TOKEN=githubplainvalue",
        "AZURE_CLIENT_SECRET=azureplainvalue",
        "gitlab glpat-abcdefghijklmnopqrstuvwxyz",
        "aws access AKIA1234567890ABCDEF",
        "-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----",
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature123",
        "session=private-session",
        "paths C:/Users/private/work/report.md and \\\\server\\share\\secret.txt"
      ].join("\n")
    );
    const report = readFileSync(join(root, "report.md"), "utf8");
    expect(report).not.toContain("dXNlcjpwYXNz");
    expect(report).toContain("https://example.com/path");
    expect(report).not.toContain("plain-secret");
    expect(report).not.toContain("private hidden steps");
    expect(report).not.toContain("hidden private steps");
    expect(report).not.toContain("hidden scratchpad");
    expect(report).toContain("- Reasoning: `high`");
    expect(report).not.toContain("abcd1234secret");
    expect(report).not.toContain("plainvalue123");
    expect(report).not.toContain("anotherplainvalue");
    expect(report).not.toContain("githubplainvalue");
    expect(report).not.toContain("azureplainvalue");
    expect(report).not.toContain("glpat-abcdefghijklmnopqrstuvwxyz");
    expect(report).not.toContain("AKIA1234567890ABCDEF");
    expect(report).not.toContain("private-key-material");
    expect(report).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(report).not.toContain("private-session");
    expect(report).not.toContain("C:/Users/private");
    expect(report).not.toContain("server\\share");

    writer.json("metrics.json", {
      contextTokens: { value: null, unit: "tokens", reason: "Not measured by the historical trace." },
      totalToolOutputBytes: { value: 2048, unit: "bytes" }
    });
    expect(JSON.parse(readFileSync(join(root, "metrics.json"), "utf8"))).toEqual({
      contextTokens: { value: null, unit: "tokens", reason: "Not measured by the historical trace." },
      totalToolOutputBytes: { value: 2048, unit: "bytes" }
    });
  });

  it("rejects a promoted output whose origin attempt was quarantined", () => {
    const golden = {
      id: "trace-case",
      requiredTools: ["WebFetchTool"],
      forbiddenTools: [],
      outcomeKind: "tool_success",
      allowedTools: ["WebFetchTool"],
      policy: { allowCodexCli: false, sourceAccess: { mode: "offline" } }
    };
    const score = scoreLiveCase(golden, {
      repetition: 1,
      jobId: "job-1",
      projectId: "project-1",
      events: [{ type: "tool.run.changed", data: { jobId: "job-1" } }],
      jobDetail: {
        status: "failed",
        trace: {
          toolDecisions: [{ id: "decision-1", toolName: "WebFetchTool", policyStatus: "accepted" }],
          toolAttempts: [{ id: "attempt-1", decisionId: "decision-1", status: "quarantined" }],
          outputs: [{ attemptId: "attempt-1", promoted: true }],
          networkAudits: []
        }
      }
    });
    expect(score.passed).toBe(false);
    expect(score.hardViolations).toContain("QUARANTINE_LEAK");
  });

  it("never passes a required tool that failed or left a dependent attempt queued", () => {
    const golden = {
      id: "failed-codex",
      outcomeKind: "tool_success",
      requiredTools: ["CodexCliTool"],
      allowedTools: ["CodexCliTool"],
      forbiddenTools: [],
      policy: { allowCodexCli: true, sourceAccess: { mode: "offline" } }
    };
    const timestamp = "2026-07-10T00:00:00.000Z";
    const score = scoreLiveCase(golden, {
      repetition: 1,
      jobId: "job-1",
      projectId: "project-1",
      events: [],
      jobDetail: {
        status: "failed",
        failureReason: "Codex timed out.",
        trace: {
          llmInvocations: [],
          toolDecisions: [{ id: "decision-1", toolName: "CodexCliTool", policyStatus: "accepted", actionHash: "hash" }],
          toolAttempts: [
            { id: "attempt-1", decisionId: "decision-1", status: "failed", inputHash: "hash" },
            { id: "attempt-2", decisionId: "decision-1", status: "queued", inputHash: "hash" }
          ],
          codexCliExecutions: [],
          outputs: [],
          networkAudits: []
        }
      },
      now: timestamp
    });
    expect(score.passed).toBe(false);
    expect(score.hardViolations).toEqual(expect.arrayContaining(["DANGLING_ATTEMPT", "REQUIRED_TOOL_NOT_COMPLETED", "CODEX_EXECUTION_TRACE_MISSING"]));
  });

  it("reports denial-case tool metrics as not applicable", () => {
    const score = scoreLiveCase(
      {
        id: "denied",
        outcomeKind: "enqueue_rejected",
        expectedEnqueueError: "CAPABILITY_DENIED",
        requiredTools: [],
        allowedTools: [],
        forbiddenTools: [],
        policy: { allowCodexCli: false, sourceAccess: { mode: "offline" } }
      },
      { repetition: 1, enqueueError: { code: "CAPABILITY_DENIED" } }
    );
    expect(score).toMatchObject({ passed: true, toolRecall: null, toolPrecision: null });
  });

  it("does not score an unavailable Windows sandbox as a model tool failure", () => {
    const score = scoreLiveCase(
      {
        id: "sandbox-unavailable",
        outcomeKind: "tool_success",
        requiredTools: ["CodexCliTool"],
        allowedTools: ["CodexCliTool"],
        forbiddenTools: [],
        policy: { allowCodexCli: true, sourceAccess: { mode: "offline" } }
      },
      {
        repetition: 1,
        jobDetail: {
          status: "blocked",
          blockedReason: "Codex CLI permission profile is not enforceable: elevated Windows sandbox backend is required.",
          trace: { toolDecisions: [], toolAttempts: [], outputs: [], networkAudits: [] }
        }
      }
    );
    expect(score).toMatchObject({
      passed: false,
      observedOutcome: "infrastructure_failure",
      toolRecall: null,
      toolPrecision: null,
      hardViolations: ["INFRASTRUCTURE_FAILURE"]
    });
  });

  it("passes only when a successful tool has matching inputs and a complete SSE lifecycle", () => {
    const statuses = ["queued", "running", "completed"];
    const score = scoreLiveCase(
      {
        id: "successful-tool",
        outcomeKind: "tool_success",
        requiredTools: ["WebFetchTool"],
        allowedTools: ["WebFetchTool"],
        forbiddenTools: [],
        policy: { allowCodexCli: false, sourceAccess: { mode: "offline" } }
      },
      {
        repetition: 1,
        jobId: "job-1",
        projectId: "project-1",
        events: statuses.map((status) => ({ type: "tool.run.changed", data: { jobId: "job-1", attemptId: "attempt-1", status } })),
        jobDetail: {
          status: "paused",
          trace: {
            llmInvocations: [],
            toolDecisions: [{ id: "decision-1", toolName: "WebFetchTool", policyStatus: "accepted", actionHash: "same-hash" }],
            toolAttempts: [{ id: "attempt-1", decisionId: "decision-1", status: "completed", inputHash: "same-hash" }],
            codexCliExecutions: [],
            outputs: [],
            networkAudits: []
          }
        }
      }
    );
    expect(score).toMatchObject({ passed: true, sseReplayLoss: 0 });
  });
});
