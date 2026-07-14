import type { CanonicalHasher } from "../orchestration/orchestrationSchemas.js";
import { AREA, DIMENSIONLESS, LENGTH, MASS, VELOCITY } from "./dimensions.js";
import { validateConfigurationBaseline, type ConfigurationBaseline } from "./configurationBaseline.js";
import type { AerospaceModelCard } from "./modelCard.js";
import { assertQuantityDimension, type EngineeringQuantity } from "./quantity.js";
import { validateStudyContract, type EngineeringStudyContract } from "./studyContract.js";
import type { SourceDocument } from "./traceability.js";

export interface FixedWingConceptInput {
  studyContract: EngineeringStudyContract;
  configurationBaseline: ConfigurationBaseline;
  sources: readonly SourceDocument[];
  mission: {
    payloadMass: EngineeringQuantity;
    targetRange: EngineeringQuantity;
    cruiseAltitude: EngineeringQuantity;
    cruiseSpeed: EngineeringQuantity;
    reserveFraction: EngineeringQuantity;
  };
  design: {
    takeoffMass: EngineeringQuantity;
    wingArea: EngineeringQuantity;
    aspectRatio: EngineeringQuantity;
    zeroLiftDragCoefficient: EngineeringQuantity;
    oswaldEfficiency: EngineeringQuantity;
    propulsiveEfficiency: EngineeringQuantity;
    meanAerodynamicChord: EngineeringQuantity;
    cgFromLeadingEdge: EngineeringQuantity;
    neutralPointFromLeadingEdge: EngineeringQuantity;
  };
  dynamicViscosity: EngineeringQuantity;
  modelCard: AerospaceModelCard;
  hasher: CanonicalHasher;
}

export function validateFixedWingConceptInput(input: FixedWingConceptInput): void {
  validateStudyContract(input.studyContract);
  validateConfigurationBaseline(input.configurationBaseline);
  if (input.studyContract.vehicleProfile.domain !== "fixed_wing") throw new Error("Concept study requires a fixed-wing study contract.");
  if (input.studyContract.projectId !== input.configurationBaseline.projectId) throw new Error("Study and configuration baseline project IDs must match.");
  if (input.studyContract.vehicleProfile.configurationBaselineId !== input.configurationBaseline.id)
    throw new Error("Study contract must pin the exact configuration baseline.");
  if (!input.sources.length || input.sources.some((source) => source.projectId !== input.studyContract.projectId))
    throw new Error("Concept study requires project-scoped source evidence.");
  assertQuantityDimension(input.mission.payloadMass, MASS, "Payload mass");
  assertQuantityDimension(input.design.takeoffMass, MASS, "Takeoff mass");
  assertQuantityDimension(input.mission.targetRange, LENGTH, "Target range");
  assertQuantityDimension(input.mission.cruiseAltitude, LENGTH, "Cruise altitude");
  assertQuantityDimension(input.mission.cruiseSpeed, VELOCITY, "Cruise speed");
  assertQuantityDimension(input.design.wingArea, AREA, "Wing area");
  for (const [label, quantity] of [
    ["Reserve fraction", input.mission.reserveFraction],
    ["Aspect ratio", input.design.aspectRatio],
    ["Zero-lift drag coefficient", input.design.zeroLiftDragCoefficient],
    ["Oswald efficiency", input.design.oswaldEfficiency],
    ["Propulsive efficiency", input.design.propulsiveEfficiency]
  ] as const) {
    assertQuantityDimension(quantity, DIMENSIONLESS, label);
  }
  for (const [label, quantity] of [
    ["Mean aerodynamic chord", input.design.meanAerodynamicChord],
    ["CG location", input.design.cgFromLeadingEdge],
    ["Neutral-point location", input.design.neutralPointFromLeadingEdge]
  ] as const) {
    assertQuantityDimension(quantity, LENGTH, label);
  }
  if (input.design.takeoffMass.valueSI <= input.mission.payloadMass.valueSI) throw new Error("Takeoff mass must exceed payload mass.");
  if (input.mission.targetRange.valueSI <= 0 || input.mission.cruiseSpeed.valueSI <= 0 || input.design.wingArea.valueSI <= 0)
    throw new Error("Range, cruise speed and wing area must be positive.");
  if (input.mission.reserveFraction.valueSI < 0 || input.mission.reserveFraction.valueSI > 1) throw new Error("Reserve fraction must be between 0 and 1.");
  if (input.design.aspectRatio.valueSI <= 1 || input.design.zeroLiftDragCoefficient.valueSI <= 0)
    throw new Error("Aspect ratio must exceed one and zero-lift drag must be positive.");
  for (const [label, efficiency] of [
    ["Oswald efficiency", input.design.oswaldEfficiency.valueSI],
    ["Propulsive efficiency", input.design.propulsiveEfficiency.valueSI]
  ] as const) {
    if (efficiency <= 0 || efficiency > 1) throw new Error(`${label} must be in (0, 1].`);
  }
  const chord = input.design.meanAerodynamicChord.valueSI;
  if (
    chord <= 0 ||
    input.design.cgFromLeadingEdge.valueSI < 0 ||
    input.design.cgFromLeadingEdge.valueSI > chord ||
    input.design.neutralPointFromLeadingEdge.valueSI < 0 ||
    input.design.neutralPointFromLeadingEdge.valueSI > chord
  ) {
    throw new Error("CG and neutral-point locations must lie on the positive mean aerodynamic chord interval.");
  }
}
