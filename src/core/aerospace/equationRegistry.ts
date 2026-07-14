import { DIMENSIONLESS, dimensionsEqual, divideDimensions, formatDimension, multiplyDimensions, powDimension, type DimensionVector } from "./dimensions.js";
import type { EngineeringQuantity } from "./quantity.js";

export type EquationStatus =
  "candidate" | "dimension_checked" | "source_verified" | "implementation_verified" | "active" | "deprecated" | "superseded" | "quarantined";

export type EquationExpression =
  | { type: "variable"; id: string }
  | { type: "constant"; valueSI: number; dimension: DimensionVector }
  | { type: "add" | "subtract" | "multiply" | "divide"; left: EquationExpression; right: EquationExpression }
  | { type: "power"; value: EquationExpression; exponent: number };

export interface EquationSpec {
  id: string;
  version: string;
  name: string;
  expressionText: string;
  expression: EquationExpression;
  variables: readonly { id: string; description: string; dimension: DimensionVector }[];
  output: { id: string; description: string; dimension: DimensionVector };
  assumptions: readonly string[];
  applicability: string;
  excludedEffects: readonly string[];
  sourceEvidenceIds: readonly string[];
  implementationTestIds: readonly string[];
  status: EquationStatus;
}

export interface EquationCheckReceipt {
  equationId: string;
  equationVersion: string;
  computedDimension: string;
  expectedDimension: string;
  passed: boolean;
}

export interface CalculationReceipt extends EquationCheckReceipt {
  valueSI: number;
  inputIds: readonly string[];
  inputReceiptIds: readonly string[];
  sanityChecks: readonly { name: string; passed: boolean; detail: string }[];
}

export class EquationRegistry {
  private readonly equations = new Map<string, EquationSpec>();

  register(spec: EquationSpec): EquationCheckReceipt {
    validateEquationSpec(spec);
    const key = equationKey(spec.id, spec.version);
    if (this.equations.has(key)) throw new Error(`Equation already exists: ${key}.`);
    const receipt = checkEquationDimensions(spec);
    if (!receipt.passed && spec.status !== "candidate" && spec.status !== "quarantined") {
      throw new Error(`Equation dimension check failed for ${key}.`);
    }
    this.equations.set(key, deepFreezeSpec(spec));
    return receipt;
  }

  get(id: string, version: string): EquationSpec {
    const spec = this.equations.get(equationKey(id, version));
    if (!spec) throw new Error(`Equation is not registered: ${id}@${version}.`);
    return spec;
  }

  activate(id: string, version: string): void {
    const key = equationKey(id, version);
    const current = this.get(id, version);
    if (!checkEquationDimensions(current).passed || !current.sourceEvidenceIds.length || !current.implementationTestIds.length) {
      throw new Error("Equation activation requires dimension, source and implementation evidence.");
    }
    this.equations.set(key, deepFreezeSpec({ ...current, status: "active" }));
  }
}

export function checkEquationDimensions(spec: EquationSpec): EquationCheckReceipt {
  const variables = new Map(spec.variables.map((item) => [item.id, item.dimension]));
  const computed = evaluateDimension(spec.expression, variables);
  return Object.freeze({
    equationId: spec.id,
    equationVersion: spec.version,
    computedDimension: formatDimension(computed),
    expectedDimension: formatDimension(spec.output.dimension),
    passed: dimensionsEqual(computed, spec.output.dimension)
  });
}

export function executeEquation(input: {
  spec: EquationSpec;
  variables: Readonly<Record<string, EngineeringQuantity>>;
  sanityChecks?: readonly ((valueSI: number) => { name: string; passed: boolean; detail: string })[];
}): CalculationReceipt {
  if (input.spec.status !== "active") throw new Error(`Equation is not active: ${input.spec.id}@${input.spec.version}.`);
  const dimensionReceipt = checkEquationDimensions(input.spec);
  if (!dimensionReceipt.passed) throw new Error("Active equation dimension check failed.");
  const values = new Map<string, number>();
  const receiptIds: string[] = [];
  for (const variable of input.spec.variables) {
    const quantity = input.variables[variable.id];
    if (!quantity) throw new Error(`Equation input is missing: ${variable.id}.`);
    if (!dimensionsEqual(quantity.dimension, variable.dimension)) throw new Error(`Equation input dimension mismatch: ${variable.id}.`);
    if (quantity.provenance.sourceType === "calculation" || quantity.provenance.sourceType === "solver") {
      if (!quantity.provenance.receiptId) throw new Error(`Computed equation input requires a receipt: ${variable.id}.`);
      receiptIds.push(quantity.provenance.receiptId);
    }
    values.set(variable.id, quantity.valueSI);
  }
  const valueSI = evaluateValue(input.spec.expression, values);
  if (!Number.isFinite(valueSI)) throw new Error("Equation result is not finite.");
  const checks = (input.sanityChecks ?? []).map((check) => Object.freeze(check(valueSI)));
  if (checks.some((check) => !check.passed))
    throw new Error(
      `Equation sanity check failed: ${checks
        .filter((item) => !item.passed)
        .map((item) => item.name)
        .join(", ")}.`
    );
  return Object.freeze({
    ...dimensionReceipt,
    valueSI,
    inputIds: Object.freeze([...values.keys()].sort()),
    inputReceiptIds: Object.freeze([...new Set(receiptIds)].sort()),
    sanityChecks: Object.freeze(checks)
  });
}

function evaluateDimension(expression: EquationExpression, variables: ReadonlyMap<string, DimensionVector>): DimensionVector {
  if (expression.type === "variable") {
    const value = variables.get(expression.id);
    if (!value) throw new Error(`Equation expression references an undefined variable: ${expression.id}.`);
    return value;
  }
  if (expression.type === "constant") return expression.dimension;
  if (expression.type === "power") return powDimension(evaluateDimension(expression.value, variables), expression.exponent);
  const left = evaluateDimension(expression.left, variables);
  const right = evaluateDimension(expression.right, variables);
  if (expression.type === "add" || expression.type === "subtract") {
    if (!dimensionsEqual(left, right)) throw new Error(`Equation ${expression.type} operands have incompatible dimensions.`);
    return left;
  }
  return expression.type === "multiply" ? multiplyDimensions(left, right) : divideDimensions(left, right);
}

function evaluateValue(expression: EquationExpression, variables: ReadonlyMap<string, number>): number {
  if (expression.type === "variable") {
    const value = variables.get(expression.id);
    if (value === undefined) throw new Error(`Equation value is missing: ${expression.id}.`);
    return value;
  }
  if (expression.type === "constant") return expression.valueSI;
  if (expression.type === "power") return evaluateValue(expression.value, variables) ** expression.exponent;
  const left = evaluateValue(expression.left, variables);
  const right = evaluateValue(expression.right, variables);
  if (expression.type === "add") return left + right;
  if (expression.type === "subtract") return left - right;
  if (expression.type === "multiply") return left * right;
  if (right === 0) throw new Error("Equation division by zero.");
  return left / right;
}

function validateEquationSpec(spec: EquationSpec): void {
  if (!spec.id || !spec.version || !spec.name.trim() || !spec.expressionText.trim() || !spec.applicability.trim())
    throw new Error("Equation identity, expression and applicability are required.");
  if (!spec.variables.length) throw new Error("Equation requires declared variables.");
  if (new Set(spec.variables.map((item) => item.id)).size !== spec.variables.length) throw new Error("Equation variable IDs must be unique.");
}

function deepFreezeSpec(spec: EquationSpec): EquationSpec {
  return Object.freeze({
    ...spec,
    variables: Object.freeze(spec.variables.map((item) => Object.freeze({ ...item }))),
    assumptions: Object.freeze([...spec.assumptions]),
    excludedEffects: Object.freeze([...spec.excludedEffects]),
    sourceEvidenceIds: Object.freeze([...spec.sourceEvidenceIds]),
    implementationTestIds: Object.freeze([...spec.implementationTestIds])
  });
}

function equationKey(id: string, version: string): string {
  return `${id}@${version}`;
}

export const DIMENSIONLESS_CONSTANT = Object.freeze({ type: "constant", valueSI: 1, dimension: DIMENSIONLESS } satisfies EquationExpression);
