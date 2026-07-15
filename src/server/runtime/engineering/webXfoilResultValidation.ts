import type { XfoilPolarRow } from "../../../core/tools/engineeringProgramTypes.js";

export interface WebXfoilResultValidationInput {
  alphaStart: number;
  alphaEnd: number;
  alphaStep: number;
  rows: XfoilPolarRow[];
  convergence: {
    hasNaN: boolean;
    hasFortranError: boolean;
    hasConvergenceFail: boolean;
  };
}

export function assertValidWebXfoilResult(input: WebXfoilResultValidationInput): void {
  const failures = Object.entries(input.convergence)
    .filter(([, failed]) => failed)
    .map(([name]) => name);
  if (failures.length) throw new Error(`WebXFOIL reported an invalid solver terminal state: ${failures.join(", ")}.`);

  const expected = expectedAlphaSequence(input.alphaStart, input.alphaEnd, input.alphaStep);
  if (input.rows.length !== expected.length) {
    throw new Error(`WebXFOIL polar is incomplete: expected ${expected.length} alpha rows but received ${input.rows.length}.`);
  }
  const tolerance = Math.max(1e-6, input.alphaStep * 1e-4);
  const observed = new Set<string>();
  for (const [index, row] of input.rows.entries()) {
    if (![row.alpha, row.cl, row.cd].every(Number.isFinite)) throw new Error(`WebXFOIL polar row ${index + 1} contains a non-finite value.`);
    if (row.cd < 0) throw new Error(`WebXFOIL polar row ${index + 1} contains negative drag.`);
    const key = row.alpha.toFixed(8);
    if (observed.has(key)) throw new Error(`WebXFOIL polar contains duplicate alpha=${row.alpha}.`);
    observed.add(key);
    const expectedAlpha = expected[index] as number;
    if (Math.abs(row.alpha - expectedAlpha) > tolerance) {
      throw new Error(`WebXFOIL polar alpha sequence mismatch at row ${index + 1}: expected ${expectedAlpha}, received ${row.alpha}.`);
    }
  }
}

function expectedAlphaSequence(start: number, end: number, step: number): number[] {
  const count = Math.floor((end - start) / step + 1e-9) + 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000) throw new Error("WebXFOIL alpha sequence is outside the validated execution bound.");
  return Array.from({ length: count }, (_, index) => start + index * step);
}
