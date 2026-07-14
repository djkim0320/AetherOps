import type { CanonicalHasher } from "../orchestration/orchestrationSchemas.js";
import { AREA, DIMENSIONLESS, ENERGY, FORCE, LENGTH, MASS, POWER, PRESSURE, VELOCITY, dimension } from "./dimensions.js";
import { EquationRegistry, executeEquation, type CalculationReceipt, type EquationExpression, type EquationSpec } from "./equationRegistry.js";
import { createQuantity, type EngineeringQuantity } from "./quantity.js";

export interface EquationExecutionEvidence {
  id: string;
  equationId: string;
  receipt: CalculationReceipt;
}

export function createConceptEquationRegistry(sourceEvidenceId: string): EquationRegistry {
  const registry = new EquationRegistry();
  for (const equation of conceptEquations(sourceEvidenceId)) {
    registry.register(equation);
    registry.activate(equation.id, equation.version);
  }
  return registry;
}

export function executeConceptEquation(input: {
  registry: EquationRegistry;
  equationId: string;
  variables: Readonly<Record<string, EngineeringQuantity>>;
  unit: string;
  hasher: CanonicalHasher;
}): { quantity: EngineeringQuantity; evidence: EquationExecutionEvidence } {
  const receipt = executeEquation({
    spec: input.registry.get(input.equationId, "1.0.0"),
    variables: input.variables,
    sanityChecks: input.equationId === "static-margin" ? [finiteResultCheck] : [finiteResultCheck, positiveResultCheck]
  });
  const body = { equationId: input.equationId, equationVersion: "1.0.0", receipt };
  const id = `equation-execution:${input.hasher.sha256Canonical(body)}`;
  return {
    quantity: createQuantity({
      value: receipt.valueSI,
      unit: input.unit,
      provenance: { sourceType: "calculation", sourceId: input.equationId, receiptId: id }
    }),
    evidence: Object.freeze({ id, equationId: input.equationId, receipt })
  };
}

export function sourceQuantity(value: number, unit: string, sourceId: string): EngineeringQuantity {
  return createQuantity({ value, unit, provenance: { sourceType: "source", sourceId } });
}

function conceptEquations(sourceEvidenceId: string): EquationSpec[] {
  const v = (id: string): EquationExpression => ({ type: "variable", id });
  const multiply = (left: EquationExpression, right: EquationExpression): EquationExpression => ({ type: "multiply", left, right });
  const divide = (left: EquationExpression, right: EquationExpression): EquationExpression => ({ type: "divide", left, right });
  const add = (left: EquationExpression, right: EquationExpression): EquationExpression => ({ type: "add", left, right });
  const subtract = (left: EquationExpression, right: EquationExpression): EquationExpression => ({ type: "subtract", left, right });
  const power = (value: EquationExpression, exponent: number): EquationExpression => ({ type: "power", value, exponent });
  const make = (
    id: string,
    expressionText: string,
    expression: EquationExpression,
    variables: EquationSpec["variables"],
    outputDimension: EquationSpec["output"]["dimension"]
  ): EquationSpec => ({
    id,
    version: "1.0.0",
    name: id,
    expressionText,
    expression,
    variables,
    output: { id: "result", description: id, dimension: outputDimension },
    assumptions: ["Conceptual-design point model"],
    applicability: "Research-only subsonic fixed-wing conceptual trade study.",
    excludedEffects: ["Transient, nonlinear, and configuration-specific corrections"],
    sourceEvidenceIds: [sourceEvidenceId],
    implementationTestIds: ["fixedWingConceptStudy.test.ts"],
    status: "source_verified"
  });
  const scalar = (id: string) => ({ id, description: id, dimension: DIMENSIONLESS });
  return [
    make(
      "weight",
      "W=m g",
      multiply(v("mass"), v("gravity")),
      [
        { id: "mass", description: "mass", dimension: MASS },
        { id: "gravity", description: "gravity", dimension: dimension({ length: 1, time: -2 }) }
      ],
      FORCE
    ),
    make(
      "wing-loading",
      "W/S",
      divide(v("weight"), v("area")),
      [
        { id: "weight", description: "weight", dimension: FORCE },
        { id: "area", description: "area", dimension: AREA }
      ],
      PRESSURE
    ),
    make(
      "lift-coefficient",
      "CL=W/(q S)",
      divide(v("weight"), multiply(v("dynamicPressure"), v("area"))),
      [
        { id: "weight", description: "weight", dimension: FORCE },
        { id: "dynamicPressure", description: "dynamic pressure", dimension: PRESSURE },
        { id: "area", description: "area", dimension: AREA }
      ],
      DIMENSIONLESS
    ),
    make(
      "induced-drag-factor",
      "k=1/(pi AR e)",
      divide(v("one"), multiply(multiply(v("pi"), v("aspectRatio")), v("oswaldEfficiency"))),
      [scalar("one"), scalar("pi"), scalar("aspectRatio"), scalar("oswaldEfficiency")],
      DIMENSIONLESS
    ),
    make(
      "drag-polar",
      "CD=CD0+k CL^2",
      add(v("zeroLiftDragCoefficient"), multiply(v("inducedDragFactor"), power(v("liftCoefficient"), 2))),
      [scalar("zeroLiftDragCoefficient"), scalar("inducedDragFactor"), scalar("liftCoefficient")],
      DIMENSIONLESS
    ),
    make(
      "drag-force",
      "D=q S CD",
      multiply(multiply(v("dynamicPressure"), v("area")), v("dragCoefficient")),
      [
        { id: "dynamicPressure", description: "dynamic pressure", dimension: PRESSURE },
        { id: "area", description: "area", dimension: AREA },
        scalar("dragCoefficient")
      ],
      FORCE
    ),
    make(
      "shaft-power",
      "P=D V/eta",
      divide(multiply(v("drag"), v("speed")), v("efficiency")),
      [{ id: "drag", description: "drag", dimension: FORCE }, { id: "speed", description: "speed", dimension: VELOCITY }, scalar("efficiency")],
      POWER
    ),
    make(
      "mission-time",
      "t=R/V",
      divide(v("range"), v("speed")),
      [
        { id: "range", description: "range", dimension: LENGTH },
        { id: "speed", description: "speed", dimension: VELOCITY }
      ],
      dimension({ time: 1 })
    ),
    make("reserve-multiplier", "f=1+r", add(v("one"), v("reserveFraction")), [scalar("one"), scalar("reserveFraction")], DIMENSIONLESS),
    make(
      "mission-energy",
      "E=P t f",
      multiply(multiply(v("power"), v("time")), v("reserveMultiplier")),
      [
        { id: "power", description: "power", dimension: POWER },
        { id: "time", description: "time", dimension: dimension({ time: 1 }) },
        scalar("reserveMultiplier")
      ],
      ENERGY
    ),
    make(
      "static-margin",
      "SM=(x_np-x_cg)/c",
      divide(subtract(v("neutralPoint"), v("cg")), v("chord")),
      [
        { id: "neutralPoint", description: "neutral point", dimension: LENGTH },
        { id: "cg", description: "center of gravity", dimension: LENGTH },
        { id: "chord", description: "mean aerodynamic chord", dimension: LENGTH }
      ],
      DIMENSIONLESS
    )
  ];
}

function finiteResultCheck(valueSI: number) {
  return { name: "finite", passed: Number.isFinite(valueSI), detail: `valueSI=${valueSI}` };
}

function positiveResultCheck(valueSI: number) {
  return { name: "positive", passed: valueSI > 0, detail: `valueSI=${valueSI}` };
}
