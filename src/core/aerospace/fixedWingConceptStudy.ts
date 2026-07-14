import { defineFlightCondition, isaTroposphere, type EngineeringCalculationReceipt, type FlightCondition } from "./flightCondition.js";
import { createConceptEquationRegistry, executeConceptEquation, sourceQuantity, type EquationExecutionEvidence } from "./fixedWingConceptEquations.js";
import { validateFixedWingConceptInput, type FixedWingConceptInput } from "./fixedWingConceptInput.js";
import { assessModelUse, type ModelUseAssessment } from "./modelCard.js";
import type { EngineeringQuantity } from "./quantity.js";
import { analyzeTraceability, type EngineeringRequirement, type EvidenceClaim, type TraceabilityAnalysis } from "./traceability.js";
import { localSensitivity, type SensitivityReceipt, type UncertaintyBudget } from "./uncertainty.js";

export type { FixedWingConceptInput } from "./fixedWingConceptInput.js";

export interface FixedWingConceptDossier {
  studyContractId: string;
  configurationBaselineId: string;
  status: "research_complete_with_gaps";
  certificationStatus: "not_assessed";
  flightCondition: FlightCondition;
  outputs: Readonly<{
    weight: EngineeringQuantity;
    wingLoading: EngineeringQuantity;
    cruiseLiftCoefficient: EngineeringQuantity;
    inducedDragFactor: EngineeringQuantity;
    cruiseDragCoefficient: EngineeringQuantity;
    cruiseDrag: EngineeringQuantity;
    cruiseShaftPower: EngineeringQuantity;
    cruiseEnergyWithReserve: EngineeringQuantity;
    staticMargin: EngineeringQuantity;
  }>;
  equationEvidence: readonly EquationExecutionEvidence[];
  modelUseAssessment: ModelUseAssessment;
  uncertaintyBudget: UncertaintyBudget;
  sensitivity: SensitivityReceipt;
  requirements: readonly EngineeringRequirement[];
  claims: readonly EvidenceClaim[];
  traceability: TraceabilityAnalysis;
  assumptions: readonly string[];
  unresolvedGaps: readonly string[];
  decisionRecord: Readonly<{ decision: string; rationale: string; prohibitedUses: readonly string[] }>;
  reproducibilityManifest: Readonly<{
    inputHash: string;
    outputHash: string;
    baselineId: string;
    sourceHashes: readonly string[];
    equationVersions: readonly string[];
    calculationReceiptIds: readonly string[];
  }>;
}

export function runFixedWingConceptStudy(input: FixedWingConceptInput): FixedWingConceptDossier {
  validateFixedWingConceptInput(input);
  const primarySourceId = input.sources[0]?.id as string;
  const atmosphere = isaTroposphere(input.mission.cruiseAltitude, primarySourceId, input.hasher);
  const flightCondition = defineFlightCondition({
    id: "flight-condition:cruise",
    frameId: input.studyContract.physicalConventions.requiredFrames[0] as string,
    trueAirspeed: input.mission.cruiseSpeed,
    referenceLength: input.design.meanAerodynamicChord,
    dynamicViscosity: input.dynamicViscosity,
    atmosphere,
    hasher: input.hasher
  });
  const registry = createConceptEquationRegistry(primarySourceId);
  const evidence: EquationExecutionEvidence[] = [];
  const calculate = (equationId: string, variables: Readonly<Record<string, EngineeringQuantity>>, unit: string) => {
    const result = executeConceptEquation({ registry, equationId, variables, unit, hasher: input.hasher });
    evidence.push(result.evidence);
    return result.quantity;
  };
  const gravity = sourceQuantity(9.80665, "m/s^2", primarySourceId);
  const pi = sourceQuantity(Math.PI, "1", "mathematical-constant:pi");
  const one = sourceQuantity(1, "1", "mathematical-constant:one");
  const weight = calculate("weight", { mass: input.design.takeoffMass, gravity }, "N");
  const wingLoading = calculate("wing-loading", { weight, area: input.design.wingArea }, "Pa");
  const cruiseLiftCoefficient = calculate(
    "lift-coefficient",
    { weight, dynamicPressure: flightCondition.dynamicPressure, area: input.design.wingArea },
    "coef"
  );
  const inducedDragFactor = calculate(
    "induced-drag-factor",
    { one, pi, aspectRatio: input.design.aspectRatio, oswaldEfficiency: input.design.oswaldEfficiency },
    "coef"
  );
  const cruiseDragCoefficient = calculate(
    "drag-polar",
    { zeroLiftDragCoefficient: input.design.zeroLiftDragCoefficient, inducedDragFactor, liftCoefficient: cruiseLiftCoefficient },
    "coef"
  );
  const cruiseDrag = calculate(
    "drag-force",
    { dynamicPressure: flightCondition.dynamicPressure, area: input.design.wingArea, dragCoefficient: cruiseDragCoefficient },
    "N"
  );
  const cruiseShaftPower = calculate("shaft-power", { drag: cruiseDrag, speed: input.mission.cruiseSpeed, efficiency: input.design.propulsiveEfficiency }, "W");
  const cruiseTime = calculate("mission-time", { range: input.mission.targetRange, speed: input.mission.cruiseSpeed }, "s");
  const reserveMultiplier = calculate("reserve-multiplier", { one, reserveFraction: input.mission.reserveFraction }, "coef");
  const cruiseEnergyWithReserve = calculate("mission-energy", { power: cruiseShaftPower, time: cruiseTime, reserveMultiplier }, "J");
  const staticMargin = calculate(
    "static-margin",
    { neutralPoint: input.design.neutralPointFromLeadingEdge, cg: input.design.cgFromLeadingEdge, chord: input.design.meanAerodynamicChord },
    "coef"
  );
  const outputs = Object.freeze({
    weight,
    wingLoading,
    cruiseLiftCoefficient,
    inducedDragFactor,
    cruiseDragCoefficient,
    cruiseDrag,
    cruiseShaftPower,
    cruiseEnergyWithReserve,
    staticMargin
  });
  const modelUseAssessment = assessModelUse({
    card: input.modelCard,
    proposedUse: "subsonic fixed-wing conceptual design trade study",
    configurationBaselineId: input.configurationBaseline.id,
    variables: {
      mach: flightCondition.mach,
      reynoldsNumber: flightCondition.reynoldsNumber,
      liftCoefficient: cruiseLiftCoefficient
    }
  });
  const uncertaintyBudget = conceptUncertaintyBudget(input);
  const sensitivity = conceptSensitivity(input, atmosphere.density.valueSI);
  const requirements = conceptRequirements(input, outputs, evidence);
  const claims = conceptClaims(input, requirements, outputs, evidence, modelUseAssessment);
  const traceability = analyzeTraceability({ requirements, claims, sources: input.sources });
  const assumptions = Object.freeze([
    "Steady, level, subsonic cruise is used for the point-performance calculation.",
    "The parabolic drag polar is a conceptual model and excludes high-lift, compressibility, interference, and Reynolds-dependent drag increments.",
    "Propulsive efficiency is constant at the user-supplied design-point value.",
    "The static-margin result is a rough neutral-point/CG separation, not a handling-qualities or certification finding."
  ]);
  const unresolvedGaps = Object.freeze([
    "Field-length performance has no propulsion map or high-lift model.",
    "Structural load cases, aeroelasticity, flutter, fatigue, and damage tolerance remain unassessed.",
    "Mass breakdown, fuel-volume feasibility, CG travel, and control authority require higher-fidelity analyses.",
    "No certification basis, means of compliance, or compliance finding has been established.",
    "The aerodynamic and propulsion models require configuration-specific validation before design decisions.",
    ...(staticMargin.valueSI <= 0 ? ["The pinned CG is not forward of the neutral point; the rough static-margin criterion is not met."] : [])
  ]);
  const inputHash = input.hasher.sha256Canonical({
    studyContract: input.studyContract,
    baseline: input.configurationBaseline,
    mission: input.mission,
    design: input.design,
    dynamicViscosity: input.dynamicViscosity,
    modelCard: input.modelCard,
    sourceHashes: input.sources.map((source) => source.contentHash)
  });
  const outputHash = input.hasher.sha256Canonical({
    outputs,
    modelUseAssessment,
    uncertaintyBudget,
    sensitivity,
    requirements,
    claims,
    assumptions,
    unresolvedGaps
  });
  return Object.freeze({
    studyContractId: input.studyContract.id,
    configurationBaselineId: input.configurationBaseline.id,
    status: "research_complete_with_gaps",
    certificationStatus: "not_assessed",
    flightCondition,
    outputs,
    equationEvidence: Object.freeze(evidence),
    modelUseAssessment,
    uncertaintyBudget,
    sensitivity,
    requirements: Object.freeze(requirements),
    claims: Object.freeze(claims),
    traceability,
    assumptions,
    unresolvedGaps,
    decisionRecord: Object.freeze({
      decision: "Retain the baseline only as a research trade-study candidate.",
      rationale: "The point calculation is traceable and reproducible, but the recorded gaps preclude design approval or certification use.",
      prohibitedUses: Object.freeze(["certification finding", "flight release", "direct hardware control", "unreviewed safety decision"])
    }),
    reproducibilityManifest: Object.freeze({
      inputHash,
      outputHash,
      baselineId: input.configurationBaseline.id,
      sourceHashes: Object.freeze(input.sources.map((source) => source.contentHash).sort()),
      equationVersions: Object.freeze(evidence.map((item) => `${item.equationId}@1.0.0`).sort()),
      calculationReceiptIds: Object.freeze([atmosphere.receipt.id, flightCondition.receipt.id, ...evidence.map((item) => item.id)].sort())
    })
  });
}

function conceptUncertaintyBudget(input: FixedWingConceptInput): UncertaintyBudget {
  const budget: UncertaintyBudget = {
    id: "uncertainty:fixed-wing-concept-v1",
    analysisCaseId: "analysis:fixed-wing-concept-v1",
    items: Object.freeze([
      {
        id: "uq:mass",
        variableId: "takeoffMass",
        type: "epistemic",
        characterization: { kind: "bounded_interval", minimum: input.design.takeoffMass.valueSI * 0.95, maximum: input.design.takeoffMass.valueSI * 1.05 },
        parameterProvenanceId: input.design.takeoffMass.provenance.sourceId,
        correlatedWithIds: [],
        propagationMethod: "interval",
        reducible: true,
        recommendedMitigation: "Replace conceptual mass with a configuration-controlled mass breakdown."
      },
      {
        id: "uq:cd0",
        variableId: "zeroLiftDragCoefficient",
        type: "model_form",
        characterization: {
          kind: "bounded_interval",
          minimum: input.design.zeroLiftDragCoefficient.valueSI * 0.85,
          maximum: input.design.zeroLiftDragCoefficient.valueSI * 1.15
        },
        parameterProvenanceId: input.design.zeroLiftDragCoefficient.provenance.sourceId,
        correlatedWithIds: [],
        propagationMethod: "interval",
        reducible: true,
        recommendedMitigation: "Validate drag build-up with geometry-specific analysis and test data."
      }
    ]),
    omittedSourceDescriptions: Object.freeze(["Propulsion-map uncertainty", "Atmosphere variability", "Manufacturing and surface-condition variability"])
  };
  return Object.freeze(budget);
}

function conceptSensitivity(input: FixedWingConceptInput, density: number): SensitivityReceipt {
  const baseline = { mass: input.design.takeoffMass.valueSI, wingArea: input.design.wingArea.valueSI, cd0: input.design.zeroLiftDragCoefficient.valueSI };
  const speed = input.mission.cruiseSpeed.valueSI;
  const aspectRatio = input.design.aspectRatio.valueSI;
  const efficiency = input.design.oswaldEfficiency.valueSI;
  return localSensitivity({
    baseline,
    steps: { mass: baseline.mass * 0.001, wingArea: baseline.wingArea * 0.001, cd0: baseline.cd0 * 0.001 },
    evaluate: ({ mass, wingArea, cd0 }) => {
      const q = 0.5 * density * speed ** 2;
      const cl = (mass * 9.80665) / (q * wingArea);
      return q * wingArea * (cd0 + cl ** 2 / (Math.PI * aspectRatio * efficiency));
    }
  });
}

function conceptRequirements(
  input: FixedWingConceptInput,
  outputs: FixedWingConceptDossier["outputs"],
  evidence: readonly EquationExecutionEvidence[]
): EngineeringRequirement[] {
  const requirement = (id: string, text: string, criterion: string, evidenceId: string): EngineeringRequirement => ({
    id,
    projectId: input.studyContract.projectId,
    revision: 1,
    text,
    type: "performance",
    sourceIds: [],
    rationale: "Derived from the user-pinned mission and configuration baseline.",
    parentRequirementIds: [],
    configurationBaselineId: input.configurationBaseline.id,
    verificationMethod: "analysis",
    verificationLevel: "conceptual research",
    acceptanceCriteria: criterion,
    safetyRelevant: false,
    status: "evidence_available",
    evidenceIds: [evidenceId]
  });
  return [
    requirement(
      "req:range",
      `Evaluate the baseline at a target range of ${input.mission.targetRange.valueSI} m.`,
      "A traceable cruise-energy result with reserve is produced.",
      evidence.find((item) => item.equationId === "mission-energy")?.id as string
    ),
    requirement(
      "req:cruise",
      `Evaluate steady cruise at ${input.mission.cruiseSpeed.valueSI} m/s.`,
      "Lift and drag coefficients have calculation receipts.",
      evidence.find((item) => item.equationId === "drag-polar")?.id as string
    ),
    requirement(
      "req:stability",
      "Estimate positive static margin for the pinned CG and neutral point.",
      `Static margin is positive; observed ${outputs.staticMargin.valueSI}.`,
      evidence.find((item) => item.equationId === "static-margin")?.id as string
    )
  ];
}

function conceptClaims(
  input: FixedWingConceptInput,
  requirements: readonly EngineeringRequirement[],
  outputs: FixedWingConceptDossier["outputs"],
  evidence: readonly EquationExecutionEvidence[],
  modelUse: ModelUseAssessment
): EvidenceClaim[] {
  const claim = (id: string, text: string, requirementId: string, evidenceId: string): EvidenceClaim => ({
    id,
    projectId: input.studyContract.projectId,
    text,
    claimType: "computed_concept_result",
    sourceEvidenceIds: [],
    computedEvidenceIds: [evidenceId],
    supportingClaimIds: [],
    contradictoryClaimIds: [],
    assumptionIds: ["assumption:steady-level-cruise"],
    requirementIds: [requirementId],
    status: modelUse.status === "accepted_use" || modelUse.status === "accepted_with_limits" ? "conditionally_supported" : "unverifiable",
    confidence: "medium",
    applicability: `Configuration ${input.configurationBaseline.id}; research-only conceptual point analysis.`
  });
  return [
    claim(
      "claim:energy",
      `Cruise energy with reserve is ${outputs.cruiseEnergyWithReserve.valueSI} J.`,
      requirements[0]?.id as string,
      evidence.find((item) => item.equationId === "mission-energy")?.id as string
    ),
    claim(
      "claim:drag",
      `Cruise drag coefficient is ${outputs.cruiseDragCoefficient.valueSI}.`,
      requirements[1]?.id as string,
      evidence.find((item) => item.equationId === "drag-polar")?.id as string
    ),
    claim(
      "claim:static-margin",
      `The rough static margin is ${outputs.staticMargin.valueSI}.`,
      requirements[2]?.id as string,
      evidence.find((item) => item.equationId === "static-margin")?.id as string
    )
  ];
}

export function calculationReceipts(dossier: FixedWingConceptDossier): readonly EngineeringCalculationReceipt[] {
  return Object.freeze([dossier.flightCondition.atmosphere.receipt, dossier.flightCondition.receipt]);
}
