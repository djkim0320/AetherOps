import { describe, expect, it } from "vitest";
import { sanitizeLlmInvocation, sanitizeNetworkAudit, sanitizeToolAttempt, sanitizeToolDecision } from "./durableTraceSanitizer.js";

const secretFixture = "Authorization: Bearer token-secret Cookie: session=private C:\\Users\\alice\\secret.txt provider response: raw prompt";

describe("durable trace sanitizer", () => {
  it("redacts nested LLM validation data before it reaches storage", () => {
    const sanitized = sanitizeLlmInvocation({
      id: "llm-1",
      projectId: "project-1",
      jobId: "job-1",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      promptVersion: "planner-v2",
      schemaVersion: "2",
      promptHash: "hash",
      repairCount: 0,
      status: "failed",
      error: secretFixture,
      startedAt: "2026-07-14T00:00:00.000Z",
      data: { prompt: secretFixture, nested: { providerResponse: secretFixture } }
    });

    expect(JSON.stringify(sanitized)).not.toMatch(/token-secret|session=private|alice|raw prompt/);
  });

  it("redacts decision, attempt, and network trace text at the storage boundary", () => {
    const decision = sanitizeToolDecision({
      id: "decision-1",
      projectId: "project-1",
      jobId: "job-1",
      toolName: "WebFetchTool",
      purpose: secretFixture,
      expectedOutcome: secretFixture,
      rawSelection: { authorization: secretFixture, inputs: { cookie: secretFixture } },
      userPinned: false,
      policyStatus: "rejected",
      policyReason: secretFixture,
      compiledAction: { stdout: secretFixture },
      createdAt: "2026-07-14T00:00:00.000Z"
    });
    const attempt = sanitizeToolAttempt({
      id: "attempt-1",
      projectId: "project-1",
      jobId: "job-1",
      decisionId: "decision-1",
      ordinal: 0,
      status: "failed",
      inputHash: "hash",
      dependsOnAttemptIds: [],
      stagingRef: "C:\\Users\\alice\\staging",
      error: secretFixture,
      queuedAt: "2026-07-14T00:00:00.000Z"
    });
    const network = sanitizeNetworkAudit({
      id: "network-1",
      projectId: "project-1",
      jobId: "job-1",
      url: "https://example.com/?token=token-secret",
      redirectChain: ["https://example.com/?api_key=token-secret"],
      sourcePolicy: { cookie: secretFixture },
      policyDecision: "denied",
      reason: secretFixture,
      auditedAt: "2026-07-14T00:00:00.000Z"
    });

    expect(JSON.stringify({ decision, attempt, network })).not.toMatch(/token-secret|session=private|alice|raw prompt/);
  });
});
