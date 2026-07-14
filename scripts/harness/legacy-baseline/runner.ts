import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AetherOpsOrchestrator } from "../../../src/core/orchestration/orchestrator.js";
import { VectorRagEngine } from "../../../src/core/retrieval/vectorRagEngine.js";
import { DeterministicCodexCliAdapter, DeterministicEmbeddingProvider, strictResearchInput } from "../../../src/core/testing/orchestratorTestHarness.js";
import { createDefaultResearchTools } from "../../../src/core/tools/toolCatalog.js";
import { ToolRunner } from "../../../src/core/tools/toolRunner.js";
import type { ToolExecutionContext } from "../../../src/core/tools/researchToolTypes.js";
import { NodeProjectStorage } from "../../../src/server/runtime/storage/projectResearchStore.js";
import { SqliteResearchStore } from "../../../src/server/runtime/storage/sqliteStore.js";
import {
  DeterministicEngineeringFailureTool,
  DeterministicFixtureFetchTool,
  HISTORICAL_SCENARIOS,
  ReceiptLlmProvider,
  ReceiptToolJournal,
  baselineSettings,
  expectedScenarioTools,
  type HistoricalScenario
} from "./adapters.js";
import { runDurableRestartProbe } from "./durableProbe.js";
import { LogicalClock, ReceiptCollector, canonicalJson, hashCanonical } from "./receiptRuntime.js";

const outputRoot = resolve(requiredEnv("AETHEROPS_BASELINE_OUTPUT_ROOT"));
const runtimeRoot = resolve(requiredEnv("AETHEROPS_BASELINE_RUNTIME_ROOT"));
mkdirSync(outputRoot, { recursive: true });
mkdirSync(runtimeRoot, { recursive: true });

const receipts = new ReceiptCollector();
receipts.add("capture_environment", {
  baseCommit: requiredEnv("AETHEROPS_BASELINE_BASE_COMMIT"),
  baseTree: requiredEnv("AETHEROPS_BASELINE_BASE_TREE"),
  packageLockSha256: requiredEnv("AETHEROPS_BASELINE_LOCK_SHA256"),
  nodeVersion: process.version,
  nodeExecutableSha256: await sha256File(process.execPath),
  nodeDistributionSha256: requiredEnv("AETHEROPS_BASELINE_NODE_DISTRIBUTION_SHA256"),
  npmVersion: requiredEnv("AETHEROPS_BASELINE_NPM_VERSION"),
  runnerBundleSha256: requiredEnv("AETHEROPS_BASELINE_RUNNER_SHA256"),
  networkMode: "blocked",
  providerMode: "deterministic"
});
receipts.add("adapter_descriptor", {
  adapterKind: "model",
  adapterVersion: "legacy-deterministic-model-v1",
  liveProviderCalled: false
});
receipts.add("adapter_descriptor", {
  adapterKind: "tool",
  adapterVersion: "legacy-deterministic-tools-v1",
  liveProviderCalled: false
});
receipts.add("fault_injection", {
  scenarioId: "clark-y-webxfoil-remote",
  faultId: "missing-coordinate-binding-v1",
  targetStage: "ResearchPlanner.strictValidation",
  expectedTerminalStatus: "rejected"
});

const clock = new LogicalClock();
clock.install();
receipts.add("fake_clock", {
  clockVersion: "logical-clock-v1",
  epoch: "2026-07-14T00:00:00.000Z",
  monotonic: true
});
try {
  for (const scenario of HISTORICAL_SCENARIOS) await runScenario(scenario, clock, receipts);
} finally {
  clock.restore();
}

await runDurableRestartProbe(runtimeRoot, receipts);
receipts.add("network_observation", { observedRequestCount: 0, guardMode: "node-offline-import-guard" });

const rows = receipts.all();
writeFileSync(join(outputRoot, "receipts.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
writeFileSync(
  join(outputRoot, "capture-run.json"),
  `${JSON.stringify(
    {
      schemaVersion: 2,
      evidenceClass: "deterministic_instrumented_legacy_runtime",
      productVerdict: "NOT_EVALUATED",
      productionSuccessEligible: false,
      scenarioCount: HISTORICAL_SCENARIOS.length,
      receiptCount: rows.length,
      captureStatus: "completed"
    },
    null,
    2
  )}\n`,
  "utf8"
);

async function runScenario(scenario: HistoricalScenario, clock: LogicalClock, collector: ReceiptCollector): Promise<void> {
  const scenarioRoot = join(runtimeRoot, scenario);
  mkdirSync(scenarioRoot, { recursive: true });
  const databaseFile = join(scenarioRoot, "legacy-research.sqlite");
  let store = new SqliteResearchStore(databaseFile);
  const settings = baselineSettings();
  const embedding = new DeterministicEmbeddingProvider(64);
  const journal = new ReceiptToolJournal(scenario, collector);
  const tools = [...createDefaultResearchTools(), new DeterministicFixtureFetchTool(scenario, clock), new DeterministicEngineeringFailureTool(clock)];
  const toolRunner = new ToolRunner(tools, journal);
  const llm = new ReceiptLlmProvider(scenario, collector, clock);
  const orchestrator = new AetherOpsOrchestrator(
    store,
    new DeterministicCodexCliAdapter(),
    new VectorRagEngine(embedding),
    join(scenarioRoot, "projects"),
    llm,
    new NodeProjectStorage(),
    embedding,
    () => settings,
    toolRunner,
    () => diagnostics(tools.map((tool) => tool.name))
  );
  const startedAt = clock.now();
  let snapshot = await orchestrator.createProject({
    goal: `Execute the ${scenario} legacy baseline.`,
    topic: scenario,
    scope: "Use only hash-bound deterministic fixture adapters; external network and live providers are forbidden.",
    budget: "One bounded legacy iteration",
    autonomyPolicy: {
      toolApproval: "suggested",
      allowExternalSearch: true,
      allowCodeExecution: true,
      maxLoopIterations: 1
    }
  });
  snapshot = await orchestrator.inputResearchQuestionHypothesis(snapshot.project.id, strictResearchInput);
  snapshot = await orchestrator.createResearchDb(snapshot.project.id);
  snapshot = await orchestrator.buildResearchSpecification(snapshot.project.id);
  const execution: ToolExecutionContext = {
    jobId: `${scenario}-job`,
    executionId: `${scenario}-execution`,
    idempotencyKey: `${scenario}-idempotency`,
    allowCodexCli: false,
    effectiveCapabilities: { agent: true, engineering: true, search: true },
    toolPolicy: { allowCodexCli: false, sourceAccess: sourcePolicy(scenario) },
    signal: new AbortController().signal
  };
  snapshot = await orchestrator.planResearch(snapshot.project.id, 1, undefined, execution);
  const activePlan = snapshot.researchPlans.find((plan) => plan.iteration === 1);
  const planningError = snapshot.stepErrors.find((error) => error.step === "PLAN_RESEARCH");
  llm.recordPlanningValidation(Boolean(activePlan), planningError);
  if (activePlan) snapshot = await orchestrator.executeTools(snapshot.project.id, 1, execution);
  journal.flush();

  const expected = expectedScenarioTools(scenario);
  const selected = [...(snapshot.researchPlans.at(-1)?.requiredTools ?? [])];
  const attempts = collector.all().filter((row) => row.type === "tool_attempt" && row.scenarioId === scenario) as Array<Record<string, unknown>>;
  const completed = new Set(attempts.filter((row) => row.status === "completed").map((row) => String(row.toolName)));
  const passed = expected.every((tool) => completed.has(tool));
  collector.add("scenario_result", {
    scenarioId: scenario,
    expectedTools: expected,
    selectedTools: selected,
    terminalStatus: passed ? "completed" : "failed",
    passed,
    deterministicLatencyMs: clock.now() - startedAt
  });
  collector.add("human_intervention", { scenarioId: scenario, eventCount: 0 });

  const before = snapshot;
  const beforeCanonical = canonicalJson(before);
  store.close();
  store = new SqliteResearchStore(databaseFile);
  const after = await store.getSnapshot(before.project.id);
  const exactReadbackMatched = canonicalJson(after) === beforeCanonical;
  collector.add("restart_readback", {
    scenarioId: scenario,
    storageKind: "legacy-sqlite",
    exactReadbackMatched,
    semanticProjectionHash: hashCanonical(snapshotProjection(after))
  });
  store.close();
  if (!exactReadbackMatched) throw new Error(`Legacy SQLite restart readback diverged for ${scenario}.`);
}

function sourcePolicy(scenario: HistoricalScenario) {
  return {
    mode: "allowlist" as const,
    urls:
      scenario === "official-url-bounded"
        ? ["https://www.rfc-editor.org/rfc/rfc9110.html", "https://html.spec.whatwg.org/multipage/server-sent-events.html"]
        : ["https://m-selig.ae.illinois.edu/ads/coord/clarky.dat"]
  };
}

function diagnostics(executableTools: string[]) {
  return {
    executableTools,
    researchMetadata: {
      provider: "openalex" as const,
      ready: true,
      maxResults: 1,
      requiredFields: ["query"],
      optionalFields: [],
      description: "Not invoked by the deterministic legacy baseline."
    },
    engineeringPrograms: [
      {
        kind: "xfoil-wasm-polar" as const,
        target: "xfoil-wasm" as const,
        ready: true,
        requiredFields: ["kind", "target", "coordinateBindingId"],
        optionalFields: [],
        description: "Instrumented deterministic failure adapter."
      }
    ],
    engineeringArtifactCandidates: [],
    engineeringProgramRequestTemplates: [],
    blockers: [],
    generatedAt: new Date().toISOString()
  };
}

function snapshotProjection(snapshot: Awaited<ReturnType<SqliteResearchStore["getSnapshot"]>>) {
  return {
    status: snapshot.project.status,
    currentStep: snapshot.project.currentStep,
    planTools: snapshot.researchPlans.at(-1)?.requiredTools ?? [],
    toolRuns: snapshot.toolRuns.map((run) => ({ toolName: run.toolName, status: run.status })),
    counts: {
      projects: 1,
      plans: snapshot.researchPlans.length,
      toolRuns: snapshot.toolRuns.length,
      blockers: snapshot.runtimeBlockers.length,
      errors: snapshot.stepErrors.length
    }
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required baseline environment field: ${name}`);
  return value;
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(file);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}
