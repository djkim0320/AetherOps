import { describe, expect, it } from "vitest";
import { deriveResultWithLlm } from "../planning/llmPlanning.js";
import {
  completeDurableJson,
  type DurableLlmInvocationObserver,
  type LlmInvocationMetadata,
  type LlmJsonCompletion,
  type LlmJsonRequest,
  type LlmProvider
} from "../providers/llm.js";
import { createInputProject, createStrictTestOrchestrator, DeterministicLlmProvider } from "../testing/orchestratorTestHarness.js";
import type { ToolExecutionContext } from "../tools/researchToolTypes.js";

const projectInput = {
  goal: "Verify crash-safe LLM receipts.",
  topic: "Durable LLM receipt paths",
  scope: "Use deterministic test adapters without product-success claims.",
  budget: "bounded",
  autonomyPolicy: { toolApproval: "suggested" as const, allowAgent: true, allowExternalSearch: false, allowCodeExecution: false }
};

describe("durable synthesis and chat LLM paths", () => {
  it("writes running before the synthesis provider call and terminal afterward with one identity", async () => {
    const events: ReceiptEvent[] = [];
    const provider = new ReceiptAwareDeterministicProvider(events);
    const orchestrator = createStrictTestOrchestrator({ llm: provider });
    const snapshot = await createInputProject(orchestrator, projectInput);

    const result = await deriveResultWithLlm(provider, snapshot, 1, true, receiptObserver(events));

    expect(result?.answer).toBeTruthy();
    expectReceiptOrder(events, "AetherOpsEvidenceBasedResult");
  });

  it("writes running before the chat provider call and terminal afterward with one identity", async () => {
    const events: ReceiptEvent[] = [];
    const provider = new ReceiptAwareDeterministicProvider(events);
    const orchestrator = createStrictTestOrchestrator({ llm: provider });
    let snapshot = await createInputProject(orchestrator, projectInput);
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);
    snapshot = await orchestrator.createSubSessions(snapshot.project.id);
    const sessionId = snapshot.sessions[0]?.id;
    expect(sessionId).toBeDefined();

    const updated = await orchestrator.sendChatMessage(snapshot.project.id, sessionId!, "검증된 실행 영수증 상태를 알려줘.", receiptExecution(events));

    expect(updated.artifacts.some((artifact) => artifact.title.includes("LLM"))).toBe(true);
    expectReceiptOrder(events, "AetherOpsChatReply");
  });

  it("fails the synthesis when its terminal receipt write fails after the provider call", async () => {
    const events: ReceiptEvent[] = [];
    const provider = new ReceiptAwareDeterministicProvider(events);
    const orchestrator = createStrictTestOrchestrator({ llm: provider });
    const snapshot = await createInputProject(orchestrator, projectInput);
    const observer = receiptObserver(events);

    await expect(
      deriveResultWithLlm(provider, snapshot, 1, true, {
        onRunning: observer.onRunning,
        onTerminal: async (metadata) => {
          await observer.onTerminal(metadata);
          throw new Error("terminal receipt write failed");
        }
      })
    ).rejects.toThrow(/terminal receipt write failed/i);
    expectReceiptOrder(events, "AetherOpsEvidenceBasedResult");
  });

  it("does not synthesize a terminal receipt when provider preflight fails before running is committed", async () => {
    const failure = Object.assign(new Error("OAuth is unavailable"), { llmInvocationMetadata: failedMetadata("preflight-invocation") });
    const provider = failingProvider(async () => {
      throw failure;
    });
    let terminalWrites = 0;

    await expect(
      completeDurableJson(provider, request(), "preflight-invocation", {
        onRunning: () => undefined,
        onTerminal: () => {
          terminalWrites += 1;
        }
      })
    ).rejects.toBe(failure);
    expect(terminalWrites).toBe(0);
  });

  it("preserves a running-receipt write failure without attempting a terminal write", async () => {
    const runningFailure = new Error("running receipt write failed");
    const provider = failingProvider(async (request) => {
      await request.invocationReceipt?.onRunning(runningMetadata("running-write-invocation"));
      throw new Error("provider must not continue");
    });
    let terminalWrites = 0;

    await expect(
      completeDurableJson(provider, request(), "running-write-invocation", {
        onRunning: () => {
          throw runningFailure;
        },
        onTerminal: () => {
          terminalWrites += 1;
        }
      })
    ).rejects.toBe(runningFailure);
    expect(terminalWrites).toBe(0);
  });
});

type ReceiptEvent = { phase: "running" | "provider_call" | "terminal"; invocationId: string; schemaName: string };

class ReceiptAwareDeterministicProvider implements LlmProvider {
  readonly name = "receipt-aware-deterministic-test-adapter";
  private readonly delegate = new DeterministicLlmProvider();

  constructor(private readonly events: ReceiptEvent[]) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  completeJson<T>(request: LlmJsonRequest<T>): Promise<T> {
    return this.delegate.completeJson(request);
  }

  async completeJsonWithMetadata<T>(request: LlmJsonRequest<T>): Promise<LlmJsonCompletion<T>> {
    if (!request.invocationReceipt) throw new Error("Test adapter requires the durable receipt lifecycle.");
    const startedAt = "2026-07-14T00:00:00.000Z";
    await request.invocationReceipt.onRunning({
      invocationId: request.invocationReceipt.invocationId,
      provider: this.name,
      model: "deterministic-test-model",
      reasoningEffort: "none",
      schemaName: request.schemaName,
      promptVersion: request.promptVersion ?? "unspecified",
      schemaVersion: request.schemaVersion ?? request.schemaName,
      promptHash: "a".repeat(64),
      startedAt,
      status: "running"
    });
    this.events.push({ phase: "provider_call", invocationId: request.invocationReceipt.invocationId, schemaName: request.schemaName });
    const value = await this.delegate.completeJson<T>(request);
    return {
      value,
      metadata: {
        invocationId: request.invocationReceipt.invocationId,
        provider: this.name,
        model: "deterministic-test-model",
        reasoningEffort: "none",
        schemaName: request.schemaName,
        promptVersion: request.promptVersion ?? "unspecified",
        schemaVersion: request.schemaVersion ?? request.schemaName,
        promptHash: "a".repeat(64),
        responseHash: "b".repeat(64),
        startedAt,
        completedAt: "2026-07-14T00:00:01.000Z",
        durationMs: 1_000,
        inputTokenEstimate: 10,
        outputTokenEstimate: 2,
        tokenEstimator: "utf8_bytes_div_4_ceil_v1",
        monetaryCostAvailability: "unavailable",
        repairCount: 0,
        status: "completed"
      }
    };
  }
}

function receiptObserver(events: ReceiptEvent[]): DurableLlmInvocationObserver {
  return {
    onRunning: (metadata) => {
      events.push({ phase: "running", invocationId: metadata.invocationId, schemaName: metadata.schemaName });
    },
    onTerminal: (metadata) => {
      events.push({ phase: "terminal", invocationId: requiredInvocationId(metadata), schemaName: metadata.schemaName });
    }
  };
}

function receiptExecution(events: ReceiptEvent[]): ToolExecutionContext {
  const observer = receiptObserver(events);
  return { onLlmInvocationRunning: observer.onRunning, onLlmInvocation: observer.onTerminal };
}

function requiredInvocationId(metadata: LlmInvocationMetadata): string {
  if (!metadata.invocationId) throw new Error("Terminal test receipt is missing its invocation identity.");
  return metadata.invocationId;
}

function expectReceiptOrder(events: ReceiptEvent[], schemaName: string): void {
  const selected = events.filter((event) => event.schemaName === schemaName);
  expect(selected.map((event) => event.phase)).toEqual(["running", "provider_call", "terminal"]);
  expect(new Set(selected.map((event) => event.invocationId)).size).toBe(1);
}

function request(): LlmJsonRequest<Record<string, unknown>> {
  return { system: "bounded system", user: "bounded user", schemaName: "DurableFailureProbe", promptVersion: "probe-v1", schemaVersion: "probe-v1" };
}

function failingProvider(run: (request: LlmJsonRequest<Record<string, unknown>>) => Promise<LlmJsonCompletion<Record<string, unknown>>>): LlmProvider {
  return {
    name: "failing-durable-test-adapter",
    isAvailable: async () => true,
    completeJson: async () => {
      throw new Error("metadata path required");
    },
    completeJsonWithMetadata: run as LlmProvider["completeJsonWithMetadata"]
  };
}

function runningMetadata(invocationId: string) {
  return {
    invocationId,
    provider: "failing-durable-test-adapter",
    model: "deterministic-test-model",
    reasoningEffort: "none",
    schemaName: "DurableFailureProbe",
    promptVersion: "probe-v1",
    schemaVersion: "probe-v1",
    promptHash: "a".repeat(64),
    startedAt: "2026-07-14T00:00:00.000Z",
    status: "running" as const
  };
}

function failedMetadata(invocationId: string): LlmInvocationMetadata {
  return {
    ...runningMetadata(invocationId),
    completedAt: "2026-07-14T00:00:01.000Z",
    durationMs: 1_000,
    inputTokenEstimate: 0,
    outputTokenEstimate: 0,
    tokenEstimator: "utf8_bytes_div_4_ceil_v1",
    monetaryCostAvailability: "unavailable",
    repairCount: 0,
    status: "failed"
  };
}
