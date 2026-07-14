import { EvalCaseSchema, EvalExecutionCaseSchema, EvalOracleSchema, type EvalCase, type EvalExecutionCase, type EvalOracle } from "./evalSchemas.js";
import { HarnessError } from "./errors.js";

export const ORACLE_ONLY_FIELD_NAMES = [
  "deterministicAcceptanceCriteria",
  "acceptanceCriteriaHash",
  "expectedOutcome",
  "deterministicGrader",
  "modelGraderRubric",
  "expectedSafetyProperties",
  "heldOutOracleFixtureHash"
] as const;

export function createEvalExecutionCase(input: EvalCase): EvalExecutionCase {
  const evalCase = EvalCaseSchema.parse(input);
  return EvalExecutionCaseSchema.parse({
    schemaVersion: evalCase.schemaVersion,
    caseVersion: evalCase.caseVersion,
    id: evalCase.id,
    suite: evalCase.suite,
    objective: evalCase.objective,
    inputFixtures: evalCase.inputFixtures,
    taskContract: { id: evalCase.taskContract.id, contentHash: evalCase.taskContractHash },
    environmentCapabilities: evalCase.environmentCapabilities,
    allowedTools: evalCase.allowedTools,
    prohibitedTools: evalCase.prohibitedTools,
    budget: evalCase.budget,
    classification: evalCase.classification,
    ...(evalCase.heldOutPartition ? { heldOutExecutionFixtureHash: evalCase.heldOutPartition.executionFixtureHash } : {}),
    seed: evalCase.seed
  });
}

export function createEvalOracle(input: EvalCase): EvalOracle {
  const evalCase = EvalCaseSchema.parse(input);
  return EvalOracleSchema.parse({
    schemaVersion: 1,
    caseId: evalCase.id,
    taskContract: evalCase.taskContract,
    taskContractHash: evalCase.taskContractHash,
    deterministicAcceptanceCriteria: evalCase.deterministicAcceptanceCriteria,
    acceptanceCriteriaHash: evalCase.acceptanceCriteriaHash,
    expectedOutcome: evalCase.expectedOutcome,
    deterministicGrader: evalCase.deterministicGrader,
    ...(evalCase.modelGraderRubric ? { modelGraderRubric: evalCase.modelGraderRubric } : {}),
    expectedSafetyProperties: evalCase.expectedSafetyProperties,
    ...(evalCase.heldOutPartition ? { heldOutOracleFixtureHash: evalCase.heldOutPartition.oracleFixtureHash } : {})
  });
}

export function assembleEvalCase(executionInput: EvalExecutionCase, oracleInput: EvalOracle): EvalCase {
  const execution = EvalExecutionCaseSchema.parse(executionInput);
  const oracle = EvalOracleSchema.parse(oracleInput);
  if (execution.id !== oracle.caseId) throw new HarnessError("UNSUPPORTED_EVAL_CASE", `Execution/oracle case mismatch: ${execution.id} != ${oracle.caseId}`);
  if (execution.taskContract.id !== oracle.taskContract.id || execution.taskContract.contentHash !== oracle.taskContractHash) {
    throw new HarnessError("TRACE_INVALID", `Execution/oracle task contract mismatch: ${execution.id}`);
  }
  const heldOutPartition = execution.classification === "held_out" ? heldOutHashes(execution, oracle) : undefined;
  return EvalCaseSchema.parse({
    schemaVersion: execution.schemaVersion,
    caseVersion: execution.caseVersion,
    id: execution.id,
    suite: execution.suite,
    objective: execution.objective,
    inputFixtures: execution.inputFixtures,
    taskContract: oracle.taskContract,
    environmentCapabilities: execution.environmentCapabilities,
    allowedTools: execution.allowedTools,
    prohibitedTools: execution.prohibitedTools,
    budget: execution.budget,
    deterministicAcceptanceCriteria: oracle.deterministicAcceptanceCriteria,
    taskContractHash: oracle.taskContractHash,
    acceptanceCriteriaHash: oracle.acceptanceCriteriaHash,
    expectedOutcome: oracle.expectedOutcome,
    deterministicGrader: oracle.deterministicGrader,
    ...(oracle.modelGraderRubric ? { modelGraderRubric: oracle.modelGraderRubric } : {}),
    expectedSafetyProperties: oracle.expectedSafetyProperties,
    classification: execution.classification,
    ...(heldOutPartition ? { heldOutPartition } : {}),
    seed: execution.seed
  });
}

export function assertOracleFreeExecutionPayload(input: unknown): EvalExecutionCase {
  const execution = EvalExecutionCaseSchema.parse(input);
  const forbidden = findForbiddenKeys(execution, "");
  if (forbidden.length) throw new HarnessError("TOOL_INVOCATION_INVALID", `Execution payload contains evaluator-only fields: ${forbidden.join(", ")}`);
  return execution;
}

function heldOutHashes(execution: EvalExecutionCase, oracle: EvalOracle): { executionFixtureHash: string; oracleFixtureHash: string } {
  if (!execution.heldOutExecutionFixtureHash || !oracle.heldOutOracleFixtureHash) {
    throw new HarnessError("TRACE_INVALID", `Held-out execution/oracle hashes are required: ${execution.id}`);
  }
  return { executionFixtureHash: execution.heldOutExecutionFixtureHash, oracleFixtureHash: oracle.heldOutOracleFixtureHash };
}

function findForbiddenKeys(value: unknown, path: string): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => findForbiddenKeys(entry, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const nestedPath = path ? `${path}.${key}` : key;
    return [
      ...(ORACLE_ONLY_FIELD_NAMES.includes(key as (typeof ORACLE_ONLY_FIELD_NAMES)[number]) ? [nestedPath] : []),
      ...findForbiddenKeys(nested, nestedPath)
    ];
  });
}
