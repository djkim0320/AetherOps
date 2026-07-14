export type BaselineAspect = "geometry" | "mass_properties" | "atmosphere" | "solver" | "material" | "source_revision" | "equation";

export interface ConfigurationBaseline {
  id: string;
  projectId: string;
  revision: number;
  geometryHash: string;
  massPropertiesHash: string;
  atmosphereModelId: string;
  solverVersions: Readonly<Record<string, string>>;
  materialRevisionIds: readonly string[];
  sourceRevisionIds: readonly string[];
  equationVersionIds: readonly string[];
  createdAt: string;
  provenanceId: string;
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
  if (!value.id || !value.projectId || !value.provenanceId) throw new Error("Configuration baseline identifiers are required.");
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Configuration baseline revision must be positive.");
  for (const [label, hash] of [
    ["geometry", value.geometryHash],
    ["mass properties", value.massPropertiesHash]
  ] as const) {
    if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error(`${label} baseline hash must be SHA-256.`);
  }
  if (!value.atmosphereModelId.trim()) throw new Error("Atmosphere model ID is required.");
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
  if (previous.massPropertiesHash !== next.massPropertiesHash) changes.push("mass_properties");
  if (previous.atmosphereModelId !== next.atmosphereModelId) changes.push("atmosphere");
  if (!recordEqual(previous.solverVersions, next.solverVersions)) changes.push("solver");
  if (!arrayEqual(previous.materialRevisionIds, next.materialRevisionIds)) changes.push("material");
  if (!arrayEqual(previous.sourceRevisionIds, next.sourceRevisionIds)) changes.push("source_revision");
  if (!arrayEqual(previous.equationVersionIds, next.equationVersionIds)) changes.push("equation");
  return changes;
}

function recordEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  return JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
}

function arrayEqual(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
