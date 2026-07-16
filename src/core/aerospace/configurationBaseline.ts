import { AREA, LENGTH, MASS } from "./dimensions.js";
import type { FramedVector, Matrix3 } from "./frames.js";
import { assertQuantityDimension, type EngineeringQuantity } from "./quantity.js";

export const BASELINE_ASPECTS = [
  "geometry",
  "airfoil_geometry",
  "aerodynamic_reference",
  "mass_properties",
  "atmosphere",
  "propulsion",
  "unit_convention",
  "coordinate_convention",
  "solver",
  "material",
  "source_revision",
  "equation"
] as const;

export type BaselineAspect = (typeof BASELINE_ASPECTS)[number];

export type ConfigurationBaselineStatus = "draft" | "active" | "superseded" | "archived";

export interface AerodynamicReferenceDefinition {
  area: EngineeringQuantity;
  chord?: EngineeringQuantity;
  span?: EngineeringQuantity;
  momentReferencePointId?: string;
  axisConventionId: string;
  dynamicPressureDefinition: string;
}

export interface EngineeringInertiaTensor {
  componentsSI: Matrix3;
  frameId: string;
  referencePointId: string;
  unit: "kg*m^2";
}

export interface EngineeringMassProperties {
  mass: EngineeringQuantity;
  centerOfGravity: FramedVector;
  inertiaTensor?: EngineeringInertiaTensor;
}

export interface BaselineProvenanceReference {
  id: string;
  contentHash?: string;
}

export interface ConfigurationBaseline {
  id: string;
  projectId: string;
  revision: number;
  status: ConfigurationBaselineStatus;
  geometryHash?: string;
  airfoilGeometryHash?: string;
  aerodynamicReference?: AerodynamicReferenceDefinition;
  massProperties?: EngineeringMassProperties;
  massPropertiesHash?: string;
  atmosphereModelId?: string;
  propulsionModelId?: string;
  unitConventionId: string;
  coordinateConventionId: string;
  solverVersions: Readonly<Record<string, string>>;
  materialRevisionIds: readonly string[];
  sourceRevisionIds: readonly string[];
  equationVersionIds: readonly string[];
  contentHash: string;
  createdAt: string;
  createdBy: string;
  provenance: readonly BaselineProvenanceReference[];
}

export interface ArtifactDependency {
  artifactId: string;
  baselineId: string;
  aspects: readonly BaselineAspect[];
}

export interface BaselineChangeImpact {
  changedAspects: readonly BaselineAspect[];
  staleArtifactIds: readonly string[];
  reasons: readonly { aspect: BaselineAspect; artifactId: string; message: string }[];
}

export function validateConfigurationBaseline(value: ConfigurationBaseline): void {
  if (!value.id || !value.projectId || !value.createdBy || !value.unitConventionId || !value.coordinateConventionId) {
    throw new Error("Configuration baseline identifiers and conventions are required.");
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Configuration baseline revision must be positive.");
  if (!["draft", "active", "superseded", "archived"].includes(value.status)) throw new Error("Configuration baseline status is invalid.");
  if (!/^[a-f0-9]{64}$/i.test(value.contentHash)) throw new Error("content baseline hash must be SHA-256.");
  for (const [label, hash] of [
    ["geometry", value.geometryHash],
    ["airfoil geometry", value.airfoilGeometryHash],
    ["mass properties", value.massPropertiesHash]
  ] as const) {
    if (hash !== undefined && !/^[a-f0-9]{64}$/i.test(hash)) throw new Error(`${label} baseline hash must be SHA-256.`);
  }
  validateAerodynamicReference(value.aerodynamicReference);
  validateMassProperties(value.massProperties);
  validateStringRecord(value.solverVersions, "solver version");
  for (const [label, values] of [
    ["material revision", value.materialRevisionIds],
    ["source revision", value.sourceRevisionIds],
    ["equation version", value.equationVersionIds]
  ] as const) {
    if (values.some((item) => !item.trim()) || new Set(values).size !== values.length) {
      throw new Error(`Configuration baseline ${label} identifiers must be non-empty and unique.`);
    }
  }
  if (
    !value.provenance.length ||
    new Set(value.provenance.map((item) => item.id)).size !== value.provenance.length ||
    value.provenance.some((item) => !item.id.trim() || (item.contentHash && !/^[a-f0-9]{64}$/i.test(item.contentHash)))
  ) {
    throw new Error("Configuration baseline provenance is required and must be hash-valid.");
  }
  if (!Number.isFinite(Date.parse(value.createdAt))) throw new Error("Configuration baseline timestamp is invalid.");
}

export function analyzeBaselineChange(
  previous: ConfigurationBaseline,
  next: ConfigurationBaseline,
  dependencies: readonly ArtifactDependency[]
): BaselineChangeImpact {
  validateConfigurationBaseline(previous);
  validateConfigurationBaseline(next);
  if (previous.projectId !== next.projectId || previous.id === next.id || next.revision !== previous.revision + 1) {
    throw new Error("Configuration baseline change must remain in one project and advance to a new ID/revision.");
  }
  const changed = changedAspects(previous, next);
  const reasons = dependencies
    .filter((item) => item.baselineId === previous.id)
    .flatMap((item) =>
      item.aspects
        .filter((aspect) => changed.includes(aspect))
        .map((aspect) => ({ aspect, artifactId: item.artifactId, message: `${aspect} changed from baseline ${previous.id} to ${next.id}.` }))
    );
  return Object.freeze({
    changedAspects: Object.freeze(changed),
    staleArtifactIds: Object.freeze([...new Set(reasons.map((item) => item.artifactId))].sort()),
    reasons: Object.freeze(reasons.sort((left, right) => left.artifactId.localeCompare(right.artifactId) || left.aspect.localeCompare(right.aspect)))
  });
}

function changedAspects(previous: ConfigurationBaseline, next: ConfigurationBaseline): BaselineAspect[] {
  const changes: BaselineAspect[] = [];
  if (previous.geometryHash !== next.geometryHash) changes.push("geometry");
  if (previous.airfoilGeometryHash !== next.airfoilGeometryHash) changes.push("airfoil_geometry");
  if (!valueEqual(previous.aerodynamicReference, next.aerodynamicReference)) changes.push("aerodynamic_reference");
  if (previous.massPropertiesHash !== next.massPropertiesHash || !valueEqual(previous.massProperties, next.massProperties)) changes.push("mass_properties");
  if (previous.atmosphereModelId !== next.atmosphereModelId) changes.push("atmosphere");
  if (previous.propulsionModelId !== next.propulsionModelId) changes.push("propulsion");
  if (previous.unitConventionId !== next.unitConventionId) changes.push("unit_convention");
  if (previous.coordinateConventionId !== next.coordinateConventionId) changes.push("coordinate_convention");
  if (!recordEqual(previous.solverVersions, next.solverVersions)) changes.push("solver");
  if (!arrayEqual(previous.materialRevisionIds, next.materialRevisionIds)) changes.push("material");
  if (!arrayEqual(previous.sourceRevisionIds, next.sourceRevisionIds) || !valueEqual(sortedProvenance(previous), sortedProvenance(next))) {
    changes.push("source_revision");
  }
  if (!arrayEqual(previous.equationVersionIds, next.equationVersionIds)) changes.push("equation");
  return changes;
}

function recordEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  return JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
}

function arrayEqual(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function sortedProvenance(value: ConfigurationBaseline): BaselineProvenanceReference[] {
  return [...value.provenance].sort((left, right) => left.id.localeCompare(right.id) || (left.contentHash ?? "").localeCompare(right.contentHash ?? ""));
}

function validateAerodynamicReference(value: AerodynamicReferenceDefinition | undefined): void {
  if (!value) return;
  assertQuantityDimension(value.area, AREA, "Aerodynamic reference area");
  if (!(value.area.valueSI > 0)) throw new Error("Aerodynamic reference area must be positive.");
  for (const [label, quantity] of [
    ["chord", value.chord],
    ["span", value.span]
  ] as const) {
    if (!quantity) continue;
    assertQuantityDimension(quantity, LENGTH, `Aerodynamic reference ${label}`);
    if (!(quantity.valueSI > 0)) throw new Error(`Aerodynamic reference ${label} must be positive.`);
  }
  if (!value.axisConventionId.trim() || !value.dynamicPressureDefinition.trim()) {
    throw new Error("Aerodynamic reference requires axis and dynamic-pressure conventions.");
  }
}

function validateMassProperties(value: EngineeringMassProperties | undefined): void {
  if (!value) return;
  assertQuantityDimension(value.mass, MASS, "Baseline mass");
  if (!(value.mass.valueSI > 0)) throw new Error("Baseline mass must be positive.");
  if (value.centerOfGravity.quantityKind !== "position" || value.centerOfGravity.components.some((item) => !Number.isFinite(item))) {
    throw new Error("Baseline center of gravity must be a finite framed position.");
  }
  if (value.inertiaTensor && value.inertiaTensor.componentsSI.flat().some((item) => !Number.isFinite(item))) {
    throw new Error("Baseline inertia tensor must contain finite SI values.");
  }
}

function validateStringRecord(value: Readonly<Record<string, string>>, label: string): void {
  if (Object.entries(value).some(([key, item]) => !key.trim() || !item.trim())) throw new Error(`Configuration baseline ${label} entries must be non-empty.`);
}

function valueEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
