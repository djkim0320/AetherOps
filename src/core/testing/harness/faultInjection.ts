import { z } from "zod";
import { HarnessError } from "./errors.js";

const StableIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export const FaultOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("success") }).strict(),
  z.object({ kind: z.literal("transient_failure"), code: StableIdSchema }).strict(),
  z.object({ kind: z.literal("permanent_failure"), code: StableIdSchema }).strict(),
  z
    .object({
      kind: z.literal("partial_result"),
      outputArtifactIds: z.array(StableIdSchema).max(128),
      outputBytes: z.number().int().nonnegative()
    })
    .strict(),
  z.object({ kind: z.literal("side_effect_response_lost"), receiptId: StableIdSchema }).strict()
]);

export const FaultProgramSchema = z
  .object({
    target: StableIdSchema,
    occurrence: z.number().int().positive(),
    latencyMs: z.number().int().nonnegative().max(3_600_000),
    outcome: FaultOutcomeSchema
  })
  .strict();

export type FaultOutcome = z.infer<typeof FaultOutcomeSchema>;
export type FaultProgram = z.infer<typeof FaultProgramSchema>;
export interface FaultExecutionReceipt {
  target: string;
  occurrence: number;
  outcome: FaultOutcome["kind"];
}

export class DeterministicFaultInjector {
  private readonly programs: FaultProgram[];
  private readonly invocationCounts = new Map<string, number>();
  private readonly consumed = new Set<string>();

  constructor(programs: readonly FaultProgram[] = []) {
    this.programs = programs.map((program) => FaultProgramSchema.parse(program));
    const keys = this.programs.map(programKey);
    if (new Set(keys).size !== keys.length) throw new HarnessError("TOOL_INVOCATION_INVALID", "Fault programs must have unique target/occurrence pairs.");
  }

  consume(target: string): FaultProgram | undefined {
    const occurrence = (this.invocationCounts.get(target) ?? 0) + 1;
    this.invocationCounts.set(target, occurrence);
    const program = this.programs.find((candidate) => candidate.target === target && candidate.occurrence === occurrence);
    if (program) this.consumed.add(programKey(program));
    return program;
  }

  invocationCount(target: string): number {
    return this.invocationCounts.get(target) ?? 0;
  }

  plannedReceipts(): FaultExecutionReceipt[] {
    return this.programs.map((program) => ({ target: program.target, occurrence: program.occurrence, outcome: program.outcome.kind }));
  }

  triggeredReceipts(): FaultExecutionReceipt[] {
    return this.programs
      .filter((program) => this.consumed.has(programKey(program)))
      .map((program) => ({ target: program.target, occurrence: program.occurrence, outcome: program.outcome.kind }));
  }

  assertFullyConsumed(): void {
    const pending = this.programs.filter((program) => !this.consumed.has(programKey(program)));
    if (pending.length) {
      throw new HarnessError("UNCONSUMED_FAULT", `Deterministic fault programs were not consumed: ${pending.map((program) => programKey(program)).join(", ")}`);
    }
  }
}

function programKey(program: FaultProgram): string {
  return `${program.target}#${program.occurrence}`;
}
