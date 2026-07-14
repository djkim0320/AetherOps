import { dimensionsEqual, formatDimension, type DimensionVector } from "./dimensions.js";
import { compatibleUnits, resolveUnit, type RationalFactor, type UnitSemantic } from "./units.js";

export interface QuantityUncertainty {
  standardUncertaintySI?: number;
  boundedIntervalSI?: readonly [number, number];
  kind: "aleatory" | "epistemic" | "numerical" | "model_form";
  sourceId: string;
}

export interface QuantityProvenance {
  sourceType: "user" | "source" | "calculation" | "solver" | "measurement";
  sourceId: string;
  receiptId?: string;
}

export interface EngineeringQuantity {
  kind: "scalar";
  valueSI: number;
  dimension: DimensionVector;
  semantic: UnitSemantic;
  originalValue: number;
  originalUnit: string;
  displayUnit: string;
  uncertainty?: QuantityUncertainty;
  provenance: QuantityProvenance;
  serializationVersion: 1;
}

export interface UnitConversionReceipt {
  fromUnit: string;
  toUnit: string;
  inputValue: number;
  outputValue: number;
  inputValueSI: number;
  dimension: string;
  semantic: UnitSemantic;
  exactScale?: RationalFactor;
}

export function createQuantity(input: {
  value: number;
  unit: string;
  displayUnit?: string;
  uncertainty?: Omit<QuantityUncertainty, "standardUncertaintySI" | "boundedIntervalSI"> & {
    standardUncertainty?: number;
    boundedInterval?: readonly [number, number];
  };
  provenance: QuantityProvenance;
}): EngineeringQuantity {
  finite(input.value, "Quantity value");
  const unit = resolveUnit(input.unit);
  const valueSI = toSI(input.value, unit.scaleToSI, unit.offsetToSI);
  const uncertainty = input.uncertainty ? uncertaintyToSI(input.uncertainty, unit.scaleToSI) : undefined;
  const display = resolveUnit(input.displayUnit ?? unit.symbol);
  assertConvertible(unit, display);
  return Object.freeze({
    kind: "scalar",
    valueSI,
    dimension: unit.dimension,
    semantic: unit.semantic,
    originalValue: input.value,
    originalUnit: unit.symbol,
    displayUnit: display.symbol,
    ...(uncertainty ? { uncertainty } : {}),
    provenance: Object.freeze({ ...input.provenance }),
    serializationVersion: 1
  });
}

export function convertQuantity(quantity: EngineeringQuantity, targetUnit: string): { quantity: EngineeringQuantity; receipt: UnitConversionReceipt } {
  const from = resolveUnit(quantity.originalUnit);
  const target = resolveUnit(targetUnit);
  assertConvertible(from, target);
  const outputValue = fromSI(quantity.valueSI, target.scaleToSI, target.offsetToSI);
  const converted = Object.freeze({ ...quantity, originalValue: outputValue, originalUnit: target.symbol, displayUnit: target.symbol });
  return {
    quantity: converted,
    receipt: Object.freeze({
      fromUnit: from.symbol,
      toUnit: target.symbol,
      inputValue: quantity.originalValue,
      outputValue,
      inputValueSI: quantity.valueSI,
      dimension: formatDimension(quantity.dimension),
      semantic: quantity.semantic,
      ...(exactRatio(from.exactScale, target.exactScale) ? { exactScale: exactRatio(from.exactScale, target.exactScale) } : {})
    })
  };
}

export function formatQuantity(quantity: EngineeringQuantity): string {
  const target = resolveUnit(quantity.displayUnit);
  const value = fromSI(quantity.valueSI, target.scaleToSI, target.offsetToSI);
  const standard = quantity.uncertainty?.standardUncertaintySI;
  if (!standard || standard <= 0) return `${value} ${target.symbol}`;
  const convertedStandard = standard / Math.abs(target.scaleToSI);
  const place = Math.floor(Math.log10(convertedStandard));
  const digits = Math.max(0, -place + (convertedStandard / 10 ** place < 3 ? 1 : 0));
  return `${value.toFixed(Math.min(digits, 12))} ± ${convertedStandard.toFixed(Math.min(digits, 12))} ${target.symbol}`;
}

export function assertQuantityDimension(quantity: EngineeringQuantity, expected: DimensionVector, label: string): void {
  if (!dimensionsEqual(quantity.dimension, expected)) {
    throw new Error(`${label} has dimension ${formatDimension(quantity.dimension)}; expected ${formatDimension(expected)}.`);
  }
}

export function absolutePressureFromGauge(gauge: EngineeringQuantity, ambientAbsolute: EngineeringQuantity): EngineeringQuantity {
  if (gauge.semantic !== "gauge_pressure" || ambientAbsolute.semantic !== "absolute_pressure") {
    throw new Error("Gauge-to-absolute conversion requires gauge pressure and an explicit absolute reference pressure.");
  }
  if (!dimensionsEqual(gauge.dimension, ambientAbsolute.dimension)) throw new Error("Pressure reference dimension mismatch.");
  return Object.freeze({
    ...gauge,
    valueSI: gauge.valueSI + ambientAbsolute.valueSI,
    semantic: "absolute_pressure",
    originalValue: gauge.valueSI + ambientAbsolute.valueSI,
    originalUnit: "Pa",
    displayUnit: "Pa",
    provenance: { sourceType: "calculation" as const, sourceId: `${gauge.provenance.sourceId}+${ambientAbsolute.provenance.sourceId}` }
  });
}

function assertConvertible(left: ReturnType<typeof resolveUnit>, right: ReturnType<typeof resolveUnit>): void {
  if (!dimensionsEqual(left.dimension, right.dimension)) throw new Error(`Unit dimension mismatch: ${left.symbol} and ${right.symbol}.`);
  if (!compatibleUnits(left, right)) {
    throw new Error(`Unit semantics are incompatible: ${left.semantic} and ${right.semantic}. Explicit engineering context is required.`);
  }
}

function uncertaintyToSI(uncertainty: NonNullable<Parameters<typeof createQuantity>[0]["uncertainty"]>, scale: number): QuantityUncertainty {
  const standard = uncertainty.standardUncertainty;
  const interval = uncertainty.boundedInterval;
  if (standard === undefined && interval === undefined) throw new Error("Uncertainty requires a standard value or bounded interval.");
  if (standard !== undefined && (!Number.isFinite(standard) || standard < 0)) throw new Error("Standard uncertainty must be finite and nonnegative.");
  if (interval && (!Number.isFinite(interval[0]) || !Number.isFinite(interval[1]) || interval[0] > interval[1])) {
    throw new Error("Uncertainty interval must be finite and ordered.");
  }
  return Object.freeze({
    kind: uncertainty.kind,
    sourceId: uncertainty.sourceId,
    ...(standard !== undefined ? { standardUncertaintySI: Math.abs(scale) * standard } : {}),
    ...(interval ? { boundedIntervalSI: [Math.abs(scale) * interval[0], Math.abs(scale) * interval[1]] as const } : {})
  });
}

function exactRatio(from: RationalFactor | undefined, to: RationalFactor | undefined): RationalFactor | undefined {
  return from && to ? { numerator: from.numerator * to.denominator, denominator: from.denominator * to.numerator } : undefined;
}

function toSI(value: number, scale: number, offset: number): number {
  return finite(value * scale + offset, "SI quantity value");
}

function fromSI(value: number, scale: number, offset: number): number {
  return finite((value - offset) / scale, "Converted quantity value");
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}
