import type { LlmJsonRequest, LlmProvider } from "../../../src/core/providers/llm.js";
import type { AppSettings, ResearchToolInput, ToolRun } from "../../../src/core/shared/types.js";
import { DeterministicLlmProvider, strictTestSettings } from "../../../src/core/testing/orchestratorTestHarness.js";
import type {
  ResearchTool,
  ResearchToolExecutionContext,
  ResearchToolResult,
  ToolExecutionJournal,
  ToolExecutionStatusEvent
} from "../../../src/core/tools/researchToolTypes.js";
import { canonicalBytes, countBenchmarkTokens, hashCanonical, type LogicalClock, type ReceiptCollector } from "./receiptRuntime.js";

export const HISTORICAL_SCENARIOS = ["official-url-bounded", "clark-y-webxfoil-remote"] as const;
export type HistoricalScenario = (typeof HISTORICAL_SCENARIOS)[number];

const expectedTools: Record<HistoricalScenario, string[]> = {
  "official-url-bounded": ["WebFetchTool", "DataAnalysisTool", "ArtifactWriterTool"],
  "clark-y-webxfoil-remote": ["WebFetchTool", "EngineeringProgramTool", "DataAnalysisTool", "ArtifactWriterTool"]
};

export function baselineSettings(): AppSettings {
  return {
    ...structuredClone(strictTestSettings),
    webSearch: { provider: "tavily", apiKeyConfigured: true },
    embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 64 },
    allowAgent: true,
    allowExternalSearch: true,
    allowCodeExecution: true,
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
}

export class ReceiptLlmProvider implements LlmProvider {
  readonly name = "deterministic-instrumented-legacy-provider";
  private readonly fallback = new DeterministicLlmProvider();
  private invocation = 0;
  private planCandidate?: { hash: string; bytes: number };

  constructor(
    private readonly scenario: HistoricalScenario,
    private readonly receipts: ReceiptCollector,
    private readonly clock: LogicalClock
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    this.invocation += 1;
    const envelope = `${request.system}\n${request.user}`;
    const completion = request.schemaName === "AetherOpsResearchPlan" ? (planFor(this.scenario) as T) : await this.fallback.completeJson<T>(request);
    const candidate = { hash: hashCanonical(completion), bytes: canonicalBytes(completion) };
    if (request.schemaName === "AetherOpsResearchPlan") this.planCandidate = candidate;
    this.clock.advance(11);
    this.receipts.add("llm_invocation", {
      scenarioId: this.scenario,
      logicalCallId: `${this.scenario}:llm:${this.invocation}`,
      schemaName: request.schemaName,
      inputHash: hashCanonical(envelope),
      inputBytes: Buffer.byteLength(envelope, "utf8"),
      benchmarkContextTokens: countBenchmarkTokens(envelope),
      tokenizerVersion: "unicode-segments-v1",
      candidateOutputHash: candidate.hash,
      candidateOutputBytes: candidate.bytes,
      retryOf: null
    });
    return completion;
  }

  recordPlanningValidation(accepted: boolean, error?: { step: string; cause?: string; message: string }): void {
    this.receipts.add("planning_validation", {
      scenarioId: this.scenario,
      logicalCallId: `${this.scenario}:plan-validation:1`,
      schemaName: "AetherOpsResearchPlan",
      candidateOutputHash: this.planCandidate?.hash ?? null,
      candidateOutputBytes: this.planCandidate?.bytes ?? 0,
      argumentValid: accepted,
      accepted,
      rejectionClass: accepted ? null : "STRICT_PLAN_REJECTED",
      rejectionHash: error ? hashCanonical(error) : null
    });
  }
}

export class DeterministicFixtureFetchTool implements ResearchTool {
  readonly name = "WebFetchTool";

  constructor(
    private readonly scenario: HistoricalScenario,
    private readonly clock: LogicalClock
  ) {}

  async run(input: ResearchToolInput, _settings: AppSettings, context?: ResearchToolExecutionContext): Promise<ResearchToolResult> {
    this.clock.advance(7);
    const startedAt = new Date(Date.now() - 7).toISOString();
    const output = {
      fixtureKind: this.scenario === "official-url-bounded" ? "pinned-official-documents" : "immutable-clark-y-coordinates",
      fetchedItems: this.scenario === "official-url-bounded" ? 2 : 1,
      networkRequests: 0
    };
    return result(input, this.name, context?.inputs ?? {}, output, "completed", startedAt);
  }
}

export class DeterministicEngineeringFailureTool implements ResearchTool {
  readonly name = "EngineeringProgramTool";

  constructor(private readonly clock: LogicalClock) {}

  async run(input: ResearchToolInput, _settings: AppSettings, context?: ResearchToolExecutionContext): Promise<ResearchToolResult> {
    this.clock.advance(13);
    const startedAt = new Date(Date.now() - 13).toISOString();
    return result(
      input,
      this.name,
      context?.inputs ?? {},
      { code: "BINDING_REQUIRED", solverRequested: "xfoil-wasm", solverExecuted: false },
      "failed",
      startedAt,
      "Validated coordinate binding was intentionally withheld by the fault injector."
    );
  }
}

interface AttemptState {
  toolName: string;
  ordinal: number;
  started: boolean;
  status: ToolExecutionStatusEvent["status"];
  inputHash: string;
  argumentValid: boolean;
  outputHash?: string;
  outputBytes: number;
  artifactKeys: string[];
}

export class ReceiptToolJournal implements ToolExecutionJournal {
  private readonly attempts = new Map<string, AttemptState>();

  constructor(
    private readonly scenario: HistoricalScenario,
    private readonly receipts: ReceiptCollector
  ) {}

  async beginExecution(): Promise<void> {}

  async record(event: ToolExecutionStatusEvent, toolResult?: ResearchToolResult): Promise<void> {
    const previous = this.attempts.get(event.attemptId);
    this.attempts.set(event.attemptId, {
      toolName: event.toolName,
      ordinal: event.ordinal,
      started: previous?.started === true || event.status === "running" || Boolean(toolResult),
      status: event.status,
      inputHash: previous?.inputHash ?? hashCanonical(event.inputs),
      argumentValid: previous?.argumentValid ?? argumentsAreValid(event.toolName, event.inputs),
      outputHash: toolResult ? hashCanonical(toolResult) : previous?.outputHash,
      outputBytes: toolResult ? canonicalBytes(toolResult) : (previous?.outputBytes ?? 0),
      artifactKeys: toolResult ? toolResult.artifacts.map((item) => hashCanonical({ relativeFile: item.relativePath })) : (previous?.artifactKeys ?? [])
    });
  }

  async completeExecution(): Promise<void> {}
  async quarantineExecution(): Promise<string> {
    return "quarantine/legacy-baseline";
  }
  async prepareQuarantine(): Promise<string> {
    return "quarantine/legacy-baseline";
  }
  async commitQuarantine(): Promise<string> {
    return "quarantine/legacy-baseline";
  }

  flush(): void {
    const ordered = [...this.attempts.values()]
      .filter((attempt) => attempt.started)
      .sort((left, right) => left.ordinal - right.ordinal || left.toolName.localeCompare(right.toolName));
    for (const [index, attempt] of ordered.entries()) {
      this.receipts.add("tool_attempt", {
        scenarioId: this.scenario,
        logicalCallId: `${this.scenario}:tool:${attempt.ordinal}:${attempt.toolName}`,
        attemptNumber: 1,
        retryOf: null,
        toolName: attempt.toolName,
        ordinal: attempt.ordinal,
        status: attempt.status,
        inputHash: attempt.inputHash,
        outputHash: attempt.outputHash ?? null,
        canonicalOutputBytes: attempt.outputBytes,
        argumentValid: attempt.argumentValid
      });
      for (const [artifactIndex, effectKey] of attempt.artifactKeys.entries()) {
        this.receipts.add("side_effect", {
          scenarioId: this.scenario,
          logicalCallId: `${this.scenario}:effect:${index}:${artifactIndex}`,
          effectKey,
          committed: attempt.status === "completed"
        });
      }
    }
  }
}

export function expectedScenarioTools(scenario: HistoricalScenario): string[] {
  return [...expectedTools[scenario]];
}

function planFor(scenario: HistoricalScenario): Record<string, unknown> {
  const artifact = {
    intentId: "write-artifact",
    toolName: "ArtifactWriterTool",
    purpose: "Write the deterministic baseline result.",
    expectedOutcome: "One hash-verifiable baseline artifact.",
    inputs: { artifacts: [{ relativePath: `artifacts/${scenario}.json`, kind: "research_report", format: "json" }] }
  };
  const analysis = {
    intentId: "analyze",
    toolName: "DataAnalysisTool",
    purpose: "Evaluate deterministic provenance and engineering fidelity.",
    expectedOutcome: "A deterministic analysis receipt.",
    inputs: { checks: ["source_scope", "engineering_fidelity", "artifact_completeness"] }
  };
  const fetch = {
    intentId: "fetch",
    toolName: "WebFetchTool",
    purpose: "Acquire the pinned fixture through the legacy acquisition phase.",
    expectedOutcome: "A fixture-backed acquisition receipt with zero network calls.",
    inputs: {
      urls:
        scenario === "official-url-bounded"
          ? ["https://www.rfc-editor.org/rfc/rfc9110.html", "https://html.spec.whatwg.org/multipage/server-sent-events.html"]
          : ["https://m-selig.ae.illinois.edu/ads/coord/clarky.dat"]
    }
  };
  const engineering = {
    intentId: "engineering",
    toolName: "EngineeringProgramTool",
    purpose: "Exercise the legacy Clark-Y binding failure without solver fallback.",
    expectedOutcome: "A failed attempt proving the missing binding is not synthesized.",
    inputs: {
      programRequests: [
        {
          kind: "xfoil-wasm-polar",
          target: "xfoil-wasm",
          reynolds: 1_000_000,
          mach: 0,
          alphaStart: -2,
          alphaEnd: 2,
          alphaStep: 2,
          reason: "Deterministic legacy binding fault"
        }
      ]
    }
  };
  return {
    objective: `Execute the ${scenario} legacy baseline scenario.`,
    targetQuestions: ["baseline-question"],
    targetHypotheses: ["baseline-hypothesis"],
    toolRequests: scenario === "official-url-bounded" ? [fetch, analysis, artifact] : [fetch, engineering, analysis, artifact],
    expectedSources: ["fixture handle"],
    expectedArtifacts: [`${scenario}.json`],
    executionSteps: ["acquire", "validate", "write"],
    stopCriteria: ["one bounded legacy iteration"],
    fetchCandidateUrls: fetch.inputs.urls
  };
}

function result(
  input: ResearchToolInput,
  toolName: string,
  toolInput: Record<string, unknown>,
  output: Record<string, unknown>,
  status: ToolRun["status"],
  startedAt: string,
  error?: string
): ResearchToolResult {
  const completedAt = new Date().toISOString();
  return {
    toolRun: {
      id: `${toolName.toLowerCase()}-${input.iteration}`,
      projectId: input.project.id,
      iteration: input.iteration,
      toolName,
      input: toolInput,
      output,
      status,
      ...(error ? { error } : {}),
      startedAt,
      completedAt
    },
    evidence: [],
    artifacts: [],
    sources: []
  };
}

function argumentsAreValid(toolName: string, inputs: Record<string, unknown>): boolean {
  if (toolName !== "EngineeringProgramTool") return true;
  const requests = Array.isArray(inputs.programRequests) ? inputs.programRequests : [];
  return requests.every((request) => request && typeof request === "object" && typeof (request as Record<string, unknown>).coordinateBindingId === "string");
}
