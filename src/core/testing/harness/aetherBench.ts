import { hashCanonical, serializeTraceCanonical } from "./canonical.js";
import { aggregateRuns } from "./aggregate.js";
import { createDefaultEvalCases } from "./defaultCases.js";
import { createDefaultCasePlans, createDefaultTestTools } from "./defaultPlans.js";
import { DeterministicHarnessRuntime, HarnessSubjectSchema, type HarnessSubject } from "./deterministicRuntime.js";
import {
  EvalCaseSchema,
  EvalExecutionCaseSchema,
  EvalOracleSchema,
  HarnessCapabilitySchema,
  type EvalCase,
  type EvalExecutionCase,
  type EvalOracle,
  type HarnessCapability
} from "./evalSchemas.js";
import { HarnessError } from "./errors.js";
import { assembleEvalCase, createEvalExecutionCase, createEvalOracle } from "./executionBoundary.js";
import { DETERMINISTIC_GRADER_DESCRIPTOR } from "./graders.js";
import { AetherBenchReportSchema, type AetherBenchReport } from "./reportSchemas.js";
import { DeterministicCasePlanSchema, TestToolDefinitionSchema, type DeterministicCasePlan } from "./testProviders.js";

export interface RunDeterministicAetherBenchOptions {
  subject: HarnessSubject;
  cases?: readonly unknown[];
  executionCases?: readonly unknown[];
  oracles?: readonly unknown[];
  plans?: readonly unknown[];
  tools?: readonly unknown[];
  capabilities?: readonly HarnessCapability[];
  harnessVersion?: string;
  evaluatorVersion?: string;
  providerAdapter?: string;
  modelIdentifier?: string;
  concurrency?: number;
}

const DEFAULT_CAPABILITIES: HarnessCapability[] = [...HarnessCapabilitySchema.options];
export const AETHERBENCH_A0727F2_FIXTURE_SUBJECT: HarnessSubject = {
  baseSha: "a0727f2d5846b53717847ff908c411c24ab29d80",
  headSha: "a0727f2d5846b53717847ff908c411c24ab29d80",
  dirtyDiffHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
};

export async function runDeterministicAetherBench(options: RunDeterministicAetherBenchOptions): Promise<AetherBenchReport> {
  if (!options) throw new HarnessError("TOOL_INVOCATION_INVALID", "AetherBench requires explicit options and subject provenance.");
  const subjectResult = HarnessSubjectSchema.safeParse(options.subject);
  if (!subjectResult.success) throw new HarnessError("TOOL_INVOCATION_INVALID", "AetherBench requires explicit valid subject provenance.");
  const partitions = resolveCasePartitions(options);
  const cases = partitions.cases;
  assertUnique(
    cases.map((evalCase) => evalCase.id),
    "eval case"
  );
  if (!cases.length) throw new HarnessError("UNSUPPORTED_EVAL_CASE", "AetherBench requires at least one eval case.");
  const plans = selectPlans(cases, options.plans);
  const tools = (options.tools ?? createDefaultTestTools()).map((tool) => TestToolDefinitionSchema.parse(tool));
  const capabilities = (options.capabilities ?? DEFAULT_CAPABILITIES).map((capability) => HarnessCapabilitySchema.parse(capability));
  const concurrency = validateConcurrency(options.concurrency ?? Math.min(4, cases.length), cases);
  const harnessVersion = options.harnessVersion ?? "aetherbench-m0-v1";
  const evaluatorVersion = options.evaluatorVersion ?? DETERMINISTIC_GRADER_DESCRIPTOR.version;
  const subject = subjectResult.data;
  const executions = await mapBounded(cases, concurrency, async (evalCase) => {
    const plan = plans.get(evalCase.id);
    if (!plan) throw new HarnessError("UNSUPPORTED_EVAL_CASE", `Missing deterministic plan for case: ${evalCase.id}`);
    const execution = partitions.executions.get(evalCase.id);
    const oracle = partitions.oracles.get(evalCase.id);
    if (!execution || !oracle) throw new HarnessError("UNSUPPORTED_EVAL_CASE", `Missing execution/oracle partition for case: ${evalCase.id}`);
    return new DeterministicHarnessRuntime({
      plan,
      tools,
      capabilities,
      harnessVersion,
      evaluatorVersion,
      providerAdapter: options.providerAdapter ?? "deterministic-test-provider",
      modelIdentifier: options.modelIdentifier ?? "deterministic-script-v1",
      subject
    }).run(execution, oracle);
  });
  const runs = executions.map((execution) => execution.run);
  const traces = executions.map((execution) => ({
    runId: execution.run.id,
    caseId: execution.run.caseId,
    events: execution.events,
    canonicalJsonl: serializeTraceCanonical(execution.events),
    rootHash: execution.run.trace.rootHash,
    canonicalTraceHash: execution.run.trace.canonicalTraceHash
  }));
  const aggregate = aggregateRuns(cases, runs);
  const body = {
    schemaVersion: 1 as const,
    evidenceClass: "deterministic_test_runtime" as const,
    productionSuccessEligible: false as const,
    productOutcome: "not_evaluated" as const,
    harnessVersion,
    evaluatorVersion,
    runs,
    traces,
    aggregate
  };
  return AetherBenchReportSchema.parse({ ...body, canonicalReportHash: await hashCanonical(body) });
}

function resolveCasePartitions(options: RunDeterministicAetherBenchOptions): {
  cases: EvalCase[];
  executions: Map<string, EvalExecutionCase>;
  oracles: Map<string, EvalOracle>;
} {
  const usesSplit = options.executionCases !== undefined || options.oracles !== undefined;
  if (usesSplit && options.cases !== undefined)
    throw new HarnessError("TOOL_INVOCATION_INVALID", "Use either full eval cases or split execution/oracle inputs, not both.");
  if (usesSplit) {
    if (!options.executionCases || !options.oracles)
      throw new HarnessError("TOOL_INVOCATION_INVALID", "Split evaluation requires both executionCases and oracles.");
    const executions = options.executionCases.map((input) => EvalExecutionCaseSchema.parse(input));
    const oracles = options.oracles.map((input) => EvalOracleSchema.parse(input));
    assertUnique(
      executions.map((input) => input.id),
      "execution case"
    );
    assertUnique(
      oracles.map((input) => input.caseId),
      "eval oracle"
    );
    const executionMap = new Map(executions.map((input) => [input.id, input]));
    const oracleMap = new Map(oracles.map((input) => [input.caseId, input]));
    const ids = new Set([...executionMap.keys(), ...oracleMap.keys()]);
    const cases = [...ids].map((id) => {
      const execution = executionMap.get(id);
      const oracle = oracleMap.get(id);
      if (!execution || !oracle) throw new HarnessError("UNSUPPORTED_EVAL_CASE", `Execution/oracle partition is unmatched: ${id}`);
      return assembleEvalCase(execution, oracle);
    });
    return { cases, executions: executionMap, oracles: oracleMap };
  }
  const cases = (options.cases ?? createDefaultEvalCases()).map((evalCase) => EvalCaseSchema.parse(evalCase));
  if (cases.some((evalCase) => evalCase.classification === "held_out")) {
    throw new HarnessError("TOOL_INVOCATION_INVALID", "Held-out cases must use physically separate executionCases and oracles inputs.");
  }
  return {
    cases,
    executions: new Map(cases.map((evalCase) => [evalCase.id, createEvalExecutionCase(evalCase)])),
    oracles: new Map(cases.map((evalCase) => [evalCase.id, createEvalOracle(evalCase)]))
  };
}

function selectPlans(cases: EvalCase[], supplied: readonly unknown[] | undefined): Map<string, DeterministicCasePlan> {
  const candidates = (supplied ?? createDefaultCasePlans()).map((plan) => DeterministicCasePlanSchema.parse(plan));
  assertUnique(
    candidates.map((plan) => plan.caseId),
    "case plan"
  );
  const requested = new Set(cases.map((evalCase) => evalCase.id));
  if (supplied) {
    const extra = candidates.filter((plan) => !requested.has(plan.caseId));
    if (extra.length) throw new HarnessError("UNCONSUMED_PLAN", `Supplied plans do not map to requested cases: ${extra.map((plan) => plan.caseId).join(", ")}`);
  }
  return new Map(candidates.filter((plan) => requested.has(plan.caseId)).map((plan) => [plan.caseId, plan]));
}

function validateConcurrency(concurrency: number, cases: EvalCase[]): number {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new HarnessError("TOOL_INVOCATION_INVALID", "Harness concurrency must be an integer from 1 to 16.");
  const smallestBudget = Math.min(...cases.map((evalCase) => evalCase.budget.maxConcurrency));
  if (concurrency > smallestBudget)
    throw new HarnessError("TOOL_INVOCATION_INVALID", `Harness concurrency ${concurrency} exceeds case budget ${smallestBudget}.`);
  return concurrency;
}

async function mapBounded<T, R>(values: readonly T[], concurrency: number, worker: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(values[index]!);
      }
    })
  );
  return results;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new HarnessError("UNSUPPORTED_EVAL_CASE", `Duplicate ${label} identifiers are forbidden.`);
}
