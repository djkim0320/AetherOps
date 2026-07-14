export interface UncertaintyItem {
  id: string;
  variableId: string;
  type: "aleatory" | "epistemic" | "numerical" | "model_form";
  characterization:
    { kind: "bounded_interval"; minimum: number; maximum: number } | { kind: "normal"; mean: number; standardDeviation: number; sourceJustification: string };
  parameterProvenanceId: string;
  correlatedWithIds: readonly string[];
  propagationMethod: "interval" | "analytical" | "monte_carlo" | "latin_hypercube" | "bootstrap" | "surrogate";
  reducible: boolean;
  recommendedMitigation?: string;
}

export interface UncertaintyBudget {
  id: string;
  analysisCaseId: string;
  items: readonly UncertaintyItem[];
  omittedSourceDescriptions: readonly string[];
  randomSeed?: number;
  sampleCount?: number;
}

export interface SensitivityReceipt {
  method: "local_central_difference" | "interval_bounds";
  baselineOutput: number;
  derivatives: Readonly<Record<string, number>>;
  normalizedSensitivities: Readonly<Record<string, number>>;
  keyDriverIds: readonly string[];
  evaluationCount: number;
}

export function validateUncertaintyBudget(value: UncertaintyBudget): void {
  if (!value.id || !value.analysisCaseId || !value.items.length) throw new Error("Uncertainty budget identity and items are required.");
  const ids = new Set(value.items.map((item) => item.id));
  if (ids.size !== value.items.length) throw new Error("Uncertainty item IDs must be unique.");
  for (const item of value.items) {
    if (!item.parameterProvenanceId) throw new Error(`Uncertainty provenance is required: ${item.id}.`);
    if (item.characterization.kind === "bounded_interval") {
      if (
        !Number.isFinite(item.characterization.minimum) ||
        !Number.isFinite(item.characterization.maximum) ||
        item.characterization.minimum > item.characterization.maximum
      ) {
        throw new Error(`Uncertainty interval is invalid: ${item.id}.`);
      }
    } else if (!item.characterization.sourceJustification.trim() || item.characterization.standardDeviation <= 0) {
      throw new Error(`Normal uncertainty requires positive deviation and source justification: ${item.id}.`);
    }
    for (const correlated of item.correlatedWithIds)
      if (!ids.has(correlated) || correlated === item.id) throw new Error(`Uncertainty correlation is invalid: ${item.id} -> ${correlated}.`);
  }
  if (["monte_carlo", "latin_hypercube"].some((method) => value.items.some((item) => item.propagationMethod === method))) {
    if (!Number.isSafeInteger(value.randomSeed) || !Number.isSafeInteger(value.sampleCount) || (value.sampleCount ?? 0) < 2) {
      throw new Error("Sampling uncertainty methods require a deterministic seed and sample count.");
    }
  }
}

export function localSensitivity(input: {
  baseline: Readonly<Record<string, number>>;
  steps: Readonly<Record<string, number>>;
  evaluate(values: Readonly<Record<string, number>>): number;
}): SensitivityReceipt {
  const baselineOutput = finite(input.evaluate(input.baseline), "Baseline sensitivity output");
  const derivatives: Record<string, number> = {};
  const normalized: Record<string, number> = {};
  let evaluations = 1;
  for (const id of Object.keys(input.baseline).sort()) {
    const step = input.steps[id];
    if (!Number.isFinite(step) || (step as number) <= 0) throw new Error(`Sensitivity step must be positive: ${id}.`);
    const plus = { ...input.baseline, [id]: (input.baseline[id] as number) + (step as number) };
    const minus = { ...input.baseline, [id]: (input.baseline[id] as number) - (step as number) };
    const derivative = (finite(input.evaluate(plus), `${id} plus output`) - finite(input.evaluate(minus), `${id} minus output`)) / (2 * (step as number));
    derivatives[id] = derivative;
    normalized[id] = baselineOutput === 0 ? 0 : (derivative * (input.baseline[id] as number)) / baselineOutput;
    evaluations += 2;
  }
  const keyDriverIds = Object.keys(normalized).sort(
    (left, right) => Math.abs(normalized[right] as number) - Math.abs(normalized[left] as number) || left.localeCompare(right)
  );
  return Object.freeze({
    method: "local_central_difference",
    baselineOutput,
    derivatives: Object.freeze(derivatives),
    normalizedSensitivities: Object.freeze(normalized),
    keyDriverIds: Object.freeze(keyDriverIds),
    evaluationCount: evaluations
  });
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}
