import { describe, expect, it } from "vitest";
import {
  AETHERBENCH_A0727F2_FIXTURE_SUBJECT,
  EvalExecutionCaseSchema,
  ORACLE_ONLY_FIELD_NAMES,
  assembleEvalCase,
  createDefaultEvalCases,
  createEvalExecutionCase,
  createEvalOracle,
  runDeterministicAetherBench,
  type HarnessSubject,
  type RunDeterministicAetherBenchOptions
} from "./public.js";

describe("execution and evaluator oracle boundary", () => {
  it("passes an oracle-free strict execution payload and reconstructs the evaluator case separately", () => {
    const evalCase = createDefaultEvalCases()[0]!;
    const execution = createEvalExecutionCase(evalCase);
    const oracle = createEvalOracle(evalCase);

    expect(EvalExecutionCaseSchema.parse(execution)).toEqual(execution);
    expect(ORACLE_ONLY_FIELD_NAMES.every((field) => !(field in execution))).toBe(true);
    expect(assembleEvalCase(execution, oracle)).toEqual(evalCase);
    expect(EvalExecutionCaseSchema.safeParse({ ...execution, expectedOutcome: "passed" }).success).toBe(false);
  });

  it("requires explicit valid subject provenance at the JavaScript boundary", async () => {
    await expect(runDeterministicAetherBench(undefined as unknown as RunDeterministicAetherBenchOptions)).rejects.toMatchObject({
      code: "TOOL_INVOCATION_INVALID"
    });
    await expect(
      runDeterministicAetherBench({ subject: { ...AETHERBENCH_A0727F2_FIXTURE_SUBJECT, headSha: "not-a-sha" } as HarnessSubject })
    ).rejects.toMatchObject({ code: "TOOL_INVOCATION_INVALID" });
  });
});
