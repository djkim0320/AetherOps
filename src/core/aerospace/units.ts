import {
  ANGLE,
  DIMENSIONLESS,
  ENERGY,
  FORCE,
  LENGTH,
  MASS,
  PRESSURE,
  POWER,
  TEMPERATURE,
  TIME,
  dimension,
  divideDimensions,
  multiplyDimensions,
  powDimension,
  type DimensionVector
} from "./dimensions.js";

export type UnitSemantic =
  "generic" | "absolute_temperature" | "temperature_difference" | "absolute_pressure" | "gauge_pressure" | "angle" | "mach" | "coefficient";

export interface RationalFactor {
  numerator: number;
  denominator: number;
}

export interface UnitDefinition {
  symbol: string;
  dimension: DimensionVector;
  scaleToSI: number;
  offsetToSI: number;
  semantic: UnitSemantic;
  exactScale?: RationalFactor;
}

const units = new Map<string, UnitDefinition>();

register("1", DIMENSIONLESS, rational(1), "generic");
register("Mach", DIMENSIONLESS, rational(1), "mach");
register("coef", DIMENSIONLESS, rational(1), "coefficient");
register("kg", MASS, rational(1));
register("g", MASS, rational(1, 1000));
register("lbm", MASS, rational(45_359_237, 100_000_000));
register("slug", MASS, 4.4482216152605 / 0.3048);
register("m", LENGTH, rational(1));
register("ft", LENGTH, rational(381, 1250));
register("nmi", LENGTH, rational(1852));
register("mi", LENGTH, rational(201_168, 125));
register("s", TIME, rational(1));
register("min", TIME, rational(60));
register("h", TIME, rational(3600));
register("N", FORCE, rational(1));
register("lbf", FORCE, 4.4482216152605);
register("J", ENERGY, rational(1));
register("W", POWER, rational(1));
register("Pa", PRESSURE, rational(1));
register("kPa", PRESSURE, rational(1000));
register("psi", PRESSURE, 6894.757293168, "generic");
register("psia", PRESSURE, 6894.757293168, "absolute_pressure");
register("psig", PRESSURE, 6894.757293168, "gauge_pressure");
register("K", TEMPERATURE, rational(1), "absolute_temperature");
register("degC", TEMPERATURE, rational(1), "absolute_temperature", 273.15);
register("delta_degC", TEMPERATURE, rational(1), "temperature_difference");
register("degF", TEMPERATURE, rational(5, 9), "absolute_temperature", 255.3722222222222);
register("delta_degF", TEMPERATURE, rational(5, 9), "temperature_difference");
register("rad", ANGLE, rational(1), "angle");
register("deg", ANGLE, Math.PI / 180, "angle");
register("knot", divideDimensions(LENGTH, TIME), rational(463, 900));

export function resolveUnit(unit: string): UnitDefinition {
  const normalized = unit.trim().replaceAll("·", "*").replaceAll("²", "^2").replaceAll("³", "^3");
  if (!normalized) throw new Error("A physical quantity requires an explicit unit.");
  const direct = units.get(normalized);
  if (direct) return direct;
  return parseCompoundUnit(normalized);
}

export function compatibleUnits(left: UnitDefinition, right: UnitDefinition): boolean {
  return left.semantic === right.semantic || (left.semantic === "generic" && right.semantic === "generic");
}

function parseCompoundUnit(expression: string): UnitDefinition {
  const tokens = expression.match(/[*/]|[^*/]+/g);
  if (!tokens?.length || tokens.length % 2 === 0) throw new Error(`Invalid compound unit: ${expression}`);
  let dimensionValue = DIMENSIONLESS;
  let scale = 1;
  let exact: RationalFactor | undefined = rational(1);
  let divide = false;
  for (const token of tokens) {
    if (token === "*" || token === "/") {
      divide = token === "/";
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*|1)(?:\^(-?\d+))?$/.exec(token.trim());
    if (!match) throw new Error(`Invalid unit term: ${token}`);
    const base = units.get(match[1] as string);
    if (!base) throw new Error(`Unsupported unit: ${match[1]}`);
    if (base.offsetToSI !== 0 || base.semantic !== "generic") throw new Error(`Affine or semantic unit cannot be compounded: ${base.symbol}`);
    const signedExponent = Number(match[2] ?? 1) * (divide ? -1 : 1);
    dimensionValue = multiplyDimensions(dimensionValue, powDimension(base.dimension, signedExponent));
    scale *= base.scaleToSI ** signedExponent;
    exact = combineExact(exact, base.exactScale, signedExponent);
  }
  return Object.freeze({
    symbol: expression,
    dimension: dimensionValue,
    scaleToSI: scale,
    offsetToSI: 0,
    semantic: "generic",
    ...(exact ? { exactScale: exact } : {})
  });
}

function register(symbol: string, dimensionValue: DimensionVector, scale: number | RationalFactor, semantic: UnitSemantic = "generic", offsetToSI = 0): void {
  const exactScale = typeof scale === "number" ? undefined : scale;
  const scaleToSI = typeof scale === "number" ? scale : scale.numerator / scale.denominator;
  units.set(symbol, Object.freeze({ symbol, dimension: dimensionValue, scaleToSI, offsetToSI, semantic, ...(exactScale ? { exactScale } : {}) }));
}

function rational(numerator: number, denominator = 1): RationalFactor {
  return { numerator, denominator };
}

function combineExact(current: RationalFactor | undefined, factor: RationalFactor | undefined, exponent: number): RationalFactor | undefined {
  if (!current || !factor || !Number.isInteger(exponent)) return undefined;
  const positive = Math.abs(exponent);
  const numeratorFactor = factor.numerator ** positive;
  const denominatorFactor = factor.denominator ** positive;
  return exponent >= 0
    ? { numerator: current.numerator * numeratorFactor, denominator: current.denominator * denominatorFactor }
    : { numerator: current.numerator * denominatorFactor, denominator: current.denominator * numeratorFactor };
}

export const UNIT_TEST_DIMENSIONS = Object.freeze({ velocity: divideDimensions(LENGTH, TIME), area: dimension({ length: 2 }) });
