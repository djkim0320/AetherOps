import type { CanonicalHasher } from "../orchestration/orchestrationSchemas.js";
import { DENSITY, DIMENSIONLESS, LENGTH, PRESSURE, TEMPERATURE, VELOCITY, dimension, dimensionsEqual } from "./dimensions.js";
import { createQuantity, type EngineeringQuantity } from "./quantity.js";

export interface EngineeringCalculationReceipt {
  id: string;
  method: string;
  sourceEvidenceIds: readonly string[];
  inputIds: readonly string[];
  constants: Readonly<Record<string, number>>;
  outputValuesSI: Readonly<Record<string, number>>;
  applicability: string;
  warnings: readonly string[];
  contentHash: string;
}

export interface AtmosphereState {
  modelId: "isa-1976-troposphere";
  altitude: EngineeringQuantity;
  temperature: EngineeringQuantity;
  pressure: EngineeringQuantity;
  density: EngineeringQuantity;
  speedOfSound: EngineeringQuantity;
  receipt: EngineeringCalculationReceipt;
}

export interface FlightCondition {
  id: string;
  frameId: string;
  trueAirspeed: EngineeringQuantity;
  mach: EngineeringQuantity;
  dynamicPressure: EngineeringQuantity;
  reynoldsNumber: EngineeringQuantity;
  referenceLength: EngineeringQuantity;
  atmosphere: AtmosphereState;
  receipt: EngineeringCalculationReceipt;
}

const DYNAMIC_VISCOSITY = dimension({ mass: 1, length: -1, time: -1 });

export function isaTroposphere(altitude: EngineeringQuantity, sourceEvidenceId: string, hasher: CanonicalHasher): AtmosphereState {
  assertDimension(altitude, LENGTH, "Geopotential altitude");
  const h = altitude.valueSI;
  if (h < 0 || h > 11_000) throw new Error("ISA troposphere implementation is valid only from 0 m through 11,000 m.");
  if (!sourceEvidenceId.trim()) throw new Error("Atmosphere calculation requires source evidence.");
  const constants = Object.freeze({
    seaLevelTemperatureK: 288.15,
    seaLevelPressurePa: 101_325,
    lapseRateKPerM: -0.0065,
    gravityMPerS2: 9.80665,
    gasConstant: 287.05287,
    gamma: 1.4
  });
  const temperatureK = constants.seaLevelTemperatureK + constants.lapseRateKPerM * h;
  const pressurePa =
    constants.seaLevelPressurePa *
    (temperatureK / constants.seaLevelTemperatureK) ** (-constants.gravityMPerS2 / (constants.lapseRateKPerM * constants.gasConstant));
  const densityKgM3 = pressurePa / (constants.gasConstant * temperatureK);
  const speedOfSoundMps = Math.sqrt(constants.gamma * constants.gasConstant * temperatureK);
  const receipt = receiptFor(
    "isa-1976-troposphere",
    [sourceEvidenceId],
    [altitude.provenance.sourceId],
    constants,
    { temperatureK, pressurePa, densityKgM3, speedOfSoundMps },
    "Geopotential altitude 0-11,000 m; dry ideal gas; constant lapse rate.",
    [],
    hasher
  );
  return Object.freeze({
    modelId: "isa-1976-troposphere",
    altitude,
    temperature: calculatedQuantity(temperatureK, "K", `${receipt.id}:temperature`, receipt.id),
    pressure: calculatedQuantity(pressurePa, "Pa", `${receipt.id}:pressure`, receipt.id),
    density: calculatedQuantity(densityKgM3, "kg/m^3", `${receipt.id}:density`, receipt.id),
    speedOfSound: calculatedQuantity(speedOfSoundMps, "m/s", `${receipt.id}:speed-of-sound`, receipt.id),
    receipt
  });
}

export function defineFlightCondition(input: {
  id: string;
  frameId: string;
  trueAirspeed: EngineeringQuantity;
  referenceLength: EngineeringQuantity;
  dynamicViscosity: EngineeringQuantity;
  atmosphere: AtmosphereState;
  hasher: CanonicalHasher;
}): FlightCondition {
  if (!input.id.trim() || !input.frameId.trim()) throw new Error("Flight condition identity and coordinate frame are required.");
  assertDimension(input.trueAirspeed, VELOCITY, "True airspeed");
  assertDimension(input.referenceLength, LENGTH, "Reference length");
  assertDimension(input.dynamicViscosity, DYNAMIC_VISCOSITY, "Dynamic viscosity");
  assertDimension(input.atmosphere.density, DENSITY, "Atmospheric density");
  assertDimension(input.atmosphere.speedOfSound, VELOCITY, "Speed of sound");
  const speed = input.trueAirspeed.valueSI;
  const density = input.atmosphere.density.valueSI;
  const mach = speed / input.atmosphere.speedOfSound.valueSI;
  const dynamicPressurePa = 0.5 * density * speed ** 2;
  const reynoldsNumber = (density * speed * input.referenceLength.valueSI) / input.dynamicViscosity.valueSI;
  const warnings = mach > 0.3 ? ["Compressibility effects may be material above Mach 0.3."] : [];
  const receipt = receiptFor(
    "flight-condition-definition-v1",
    input.atmosphere.receipt.sourceEvidenceIds,
    [input.trueAirspeed.provenance.sourceId, input.referenceLength.provenance.sourceId, input.dynamicViscosity.provenance.sourceId],
    { dynamicPressureFactor: 0.5 },
    { mach, dynamicPressurePa, reynoldsNumber },
    "Steady scalar freestream condition with explicitly framed velocity magnitude.",
    warnings,
    input.hasher
  );
  return Object.freeze({
    id: input.id,
    frameId: input.frameId,
    trueAirspeed: input.trueAirspeed,
    mach: calculatedQuantity(mach, "Mach", `${receipt.id}:mach`, receipt.id),
    dynamicPressure: calculatedQuantity(dynamicPressurePa, "Pa", `${receipt.id}:dynamic-pressure`, receipt.id),
    reynoldsNumber: calculatedQuantity(reynoldsNumber, "1", `${receipt.id}:reynolds`, receipt.id),
    referenceLength: input.referenceLength,
    atmosphere: input.atmosphere,
    receipt
  });
}

function calculatedQuantity(value: number, unit: string, sourceId: string, receiptId: string): EngineeringQuantity {
  return createQuantity({ value, unit, provenance: { sourceType: "calculation", sourceId, receiptId } });
}

function receiptFor(
  method: string,
  sourceEvidenceIds: readonly string[],
  inputIds: readonly string[],
  constants: Readonly<Record<string, number>>,
  outputValuesSI: Readonly<Record<string, number>>,
  applicability: string,
  warnings: readonly string[],
  hasher: CanonicalHasher
): EngineeringCalculationReceipt {
  const body = {
    method,
    sourceEvidenceIds: [...sourceEvidenceIds].sort(),
    inputIds: [...inputIds].sort(),
    constants,
    outputValuesSI,
    applicability,
    warnings: [...warnings]
  };
  const contentHash = hasher.sha256Canonical(body);
  return Object.freeze({ id: `calc:${contentHash}`, ...body, contentHash });
}

function assertDimension(quantity: EngineeringQuantity, expected: typeof LENGTH, label: string): void {
  if (!dimensionsEqual(quantity.dimension, expected)) throw new Error(`${label} has an incompatible dimension.`);
}

export const FLIGHT_CONDITION_DIMENSIONS = Object.freeze({
  density: DENSITY,
  dynamicPressure: PRESSURE,
  temperature: TEMPERATURE,
  mach: DIMENSIONLESS,
  viscosity: DYNAMIC_VISCOSITY
});
