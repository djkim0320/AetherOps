import { describe, expect, it } from "vitest";

import { parseAutonomyArgs } from "../../scripts/autonomy/args.mjs";
import { selectGoldenCases } from "../../scripts/autonomy/cases.mjs";
import { assertExactLiveRuntime, getAutonomyProfile, requiredLiveRuntime } from "../../scripts/autonomy/profiles.mjs";
import { sanitizeAutonomyArtifact } from "../../scripts/autonomy/sanitize.mjs";
import { scoreLiveCase } from "../../scripts/autonomy/live-score.mjs";

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
    expect(
      sanitizeAutonomyArtifact({
        apiKey: "sk-example-secret",
        promptRaw: "private instructions",
        promptHash: "sha256:abc",
        url: "https://user:pass@example.com/path?token=secret#fragment",
        authorization: "Bearer private-token"
      })
    ).toEqual({
      apiKey: "[REDACTED]",
      promptRaw: "[REDACTED]",
      promptHash: "sha256:abc",
      url: "https://example.com/path",
      authorization: "[REDACTED]"
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
