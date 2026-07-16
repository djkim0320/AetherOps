import type { BaselineAspect, ConfigurationBaseline } from "../../../../core/aerospace/configurationBaseline.js";
import { storageCanonicalHasher } from "./runStatePayloadValidator.js";

export function configurationBaselineContentHash(value: ConfigurationBaseline): string {
  return storageCanonicalHasher.sha256Canonical(configurationBaselineContent(value));
}

export function configurationBaselineDependencyHash(value: ConfigurationBaseline, aspects: readonly BaselineAspect[]): string {
  const selected = [...new Set(aspects)].sort();
  return storageCanonicalHasher.sha256Canonical({
    projectId: value.projectId,
    aspects: Object.fromEntries(selected.map((aspect) => [aspect, baselineAspectValue(value, aspect)]))
  });
}

export function aerodynamicReferenceHash(value: ConfigurationBaseline): string | undefined {
  return value.aerodynamicReference ? storageCanonicalHasher.sha256Canonical(value.aerodynamicReference) : undefined;
}

function configurationBaselineContent(value: ConfigurationBaseline): Record<string, unknown> {
  return {
    ...(value.geometryHash ? { geometryHash: value.geometryHash } : {}),
    ...(value.airfoilGeometryHash ? { airfoilGeometryHash: value.airfoilGeometryHash } : {}),
    ...(value.aerodynamicReference ? { aerodynamicReference: value.aerodynamicReference } : {}),
    ...(value.massProperties ? { massProperties: value.massProperties } : {}),
    ...(value.massPropertiesHash ? { massPropertiesHash: value.massPropertiesHash } : {}),
    ...(value.atmosphereModelId ? { atmosphereModelId: value.atmosphereModelId } : {}),
    ...(value.propulsionModelId ? { propulsionModelId: value.propulsionModelId } : {}),
    unitConventionId: value.unitConventionId,
    coordinateConventionId: value.coordinateConventionId,
    solverVersions: sortedRecord(value.solverVersions),
    materialRevisionIds: [...value.materialRevisionIds].sort(),
    sourceRevisionIds: [...value.sourceRevisionIds].sort(),
    equationVersionIds: [...value.equationVersionIds].sort(),
    provenance: sortedProvenance(value)
  };
}

function baselineAspectValue(value: ConfigurationBaseline, aspect: BaselineAspect): unknown {
  switch (aspect) {
    case "geometry":
      return value.geometryHash ?? null;
    case "airfoil_geometry":
      return value.airfoilGeometryHash ?? null;
    case "aerodynamic_reference":
      return value.aerodynamicReference ?? null;
    case "mass_properties":
      return { value: value.massProperties ?? null, hash: value.massPropertiesHash ?? null };
    case "atmosphere":
      return value.atmosphereModelId ?? null;
    case "propulsion":
      return value.propulsionModelId ?? null;
    case "unit_convention":
      return value.unitConventionId;
    case "coordinate_convention":
      return value.coordinateConventionId;
    case "solver":
      return sortedRecord(value.solverVersions);
    case "material":
      return [...value.materialRevisionIds].sort();
    case "source_revision":
      return { ids: [...value.sourceRevisionIds].sort(), provenance: sortedProvenance(value) };
    case "equation":
      return [...value.equationVersionIds].sort();
  }
}

function sortedRecord(value: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function sortedProvenance(value: ConfigurationBaseline): Array<{ id: string; contentHash?: string }> {
  return [...value.provenance]
    .map((entry) => ({ id: entry.id, ...(entry.contentHash ? { contentHash: entry.contentHash } : {}) }))
    .sort((left, right) => left.id.localeCompare(right.id) || (left.contentHash ?? "").localeCompare(right.contentHash ?? ""));
}
