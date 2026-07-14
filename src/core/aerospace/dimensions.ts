export const DIMENSION_KEYS = ["mass", "length", "time", "temperature", "current", "amount", "luminousIntensity", "angle"] as const;

export type DimensionKey = (typeof DIMENSION_KEYS)[number];
export type DimensionVector = Readonly<Record<DimensionKey, number>>;

export const DIMENSIONLESS = dimension();
export const MASS = dimension({ mass: 1 });
export const LENGTH = dimension({ length: 1 });
export const TIME = dimension({ time: 1 });
export const TEMPERATURE = dimension({ temperature: 1 });
export const ANGLE = dimension({ angle: 1 });
export const FORCE = dimension({ mass: 1, length: 1, time: -2 });
export const PRESSURE = dimension({ mass: 1, length: -1, time: -2 });
export const VELOCITY = dimension({ length: 1, time: -1 });
export const AREA = dimension({ length: 2 });
export const MOMENT = dimension({ mass: 1, length: 2, time: -2 });
export const ENERGY = MOMENT;
export const POWER = dimension({ mass: 1, length: 2, time: -3 });
export const DENSITY = dimension({ mass: 1, length: -3 });

export function dimension(values: Partial<Record<DimensionKey, number>> = {}): DimensionVector {
  return Object.freeze(Object.fromEntries(DIMENSION_KEYS.map((key) => [key, normalizedExponent(values[key] ?? 0)])) as Record<DimensionKey, number>);
}

export function multiplyDimensions(left: DimensionVector, right: DimensionVector): DimensionVector {
  return combineDimensions(left, right, (a, b) => a + b);
}

export function divideDimensions(left: DimensionVector, right: DimensionVector): DimensionVector {
  return combineDimensions(left, right, (a, b) => a - b);
}

export function powDimension(value: DimensionVector, exponent: number): DimensionVector {
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 16) throw new Error("Dimension exponent must be an integer between -16 and 16.");
  return dimension(Object.fromEntries(DIMENSION_KEYS.map((key) => [key, value[key] * exponent])));
}

export function dimensionsEqual(left: DimensionVector, right: DimensionVector, tolerance = 1e-12): boolean {
  return DIMENSION_KEYS.every((key) => Math.abs(left[key] - right[key]) <= tolerance);
}

export function formatDimension(value: DimensionVector): string {
  const terms = DIMENSION_KEYS.filter((key) => value[key] !== 0).map((key) => `${key}${value[key] === 1 ? "" : `^${value[key]}`}`);
  return terms.length ? terms.join(" ") : "dimensionless";
}

function combineDimensions(left: DimensionVector, right: DimensionVector, operation: (left: number, right: number) => number): DimensionVector {
  return dimension(Object.fromEntries(DIMENSION_KEYS.map((key) => [key, operation(left[key], right[key])])));
}

function normalizedExponent(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > 16) throw new Error("Dimension exponents must be finite and bounded to ±16.");
  const rounded = Math.round(value * 1e12) / 1e12;
  return Object.is(rounded, -0) ? 0 : rounded;
}
