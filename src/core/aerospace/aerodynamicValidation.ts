import type { CanonicalHasher } from "../orchestration/orchestrationSchemas.js";
import type { XfoilPolarRow } from "../tools/engineeringProgramTypes.js";
import { validateSimulationRunReceipt, type ConvergenceEvidence, type ReproducibilityManifest, type SimulationRunReceipt } from "./analysisEvidence.js";
import { ANGLE, DIMENSIONLESS } from "./dimensions.js";
import { assessModelUse, type AerospaceModelCard, type ModelUseAssessment } from "./modelCard.js";
import { createQuantity } from "./quantity.js";

export interface AerodynamicDatasetPedigree {
  id: string;
  sourceUrl: string;
  caseUrl: string;
  reportIdentifier: string;
  organization: string;
  accessDate: string;
  licenseStatus: "public";
  expectedContentSha256: string;
  computedContentSha256: string;
  reynoldsNumber: number;
  mach: number;
  transition: "tripped" | "free";
  geometryDefinition: string;
  coefficientConvention: {
    liftPositive: "upward_normal_to_freestream";
    dragPositive: "opposite_freestream";
    referenceArea: "unit_span_times_chord";
    referenceChord: number;
  };
}

export interface AerodynamicReferencePoint {
  alphaDeg: number;
  liftCoefficient: number;
  dragCoefficient: number;
}

export interface AerodynamicReferenceDataset {
  pedigree: AerodynamicDatasetPedigree;
  zones: Readonly<Record<string, readonly AerodynamicReferencePoint[]>>;
  contentHash: string;
}

export interface AerodynamicPredictionConditions {
  reynoldsNumber: number;
  mach: number;
  transition: "free" | "forced";
  coefficientConvention: AerodynamicDatasetPedigree["coefficientConvention"];
}

export interface AerodynamicValidationResult {
  id: string;
  status: "validated_with_limits" | "acceptance_failed" | "outside_domain" | "not_verified";
  datasetId: string;
  selectedZone: string;
  matchedPoints: readonly {
    alphaDeg: number;
    predictedCl: number;
    referenceCl: number;
    predictedCd: number;
    referenceCd: number;
    clError: number;
    cdError: number;
  }[];
  metrics: Readonly<{ liftRmse: number; dragRmse: number; liftMaxAbsError: number; dragMaxAbsError: number }>;
  acceptance: Readonly<{ maximumLiftRmse: number; maximumDragRmse: number; passed: boolean }>;
  experimentalUncertainty: Readonly<{
    status: "not_quantified_in_fixture";
    treatment: "reported_as_credibility_limit";
    limitation: string;
  }>;
  modelUseAssessment: ModelUseAssessment;
  simulationReceipt: SimulationRunReceipt;
  reproducibilityManifest: ReproducibilityManifest;
  validationDomain: Readonly<{ reynoldsNumber: number; mach: number; minimumAlphaDeg: number; maximumAlphaDeg: number; transition: string }>;
  placards: readonly string[];
  contentHash: string;
}

export function parseLadsonForceDataset(input: { text: string; pedigree: AerodynamicDatasetPedigree; hasher: CanonicalHasher }): AerodynamicReferenceDataset {
  validatePedigree(input.pedigree);
  if (input.pedigree.computedContentSha256 !== input.pedigree.expectedContentSha256) throw new Error("Aerodynamic reference fixture hash mismatch.");
  const zones: Record<string, AerodynamicReferencePoint[]> = {};
  let activeZone: string | undefined;
  for (const rawLine of input.text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("variables=")) continue;
    const zone = /^zone\s*,\s*t\s*=\s*"([^"]+)"$/i.exec(line);
    if (zone) {
      activeZone = zone[1]?.trim();
      if (!activeZone || zones[activeZone]) throw new Error("Aerodynamic dataset zone is empty or duplicated.");
      zones[activeZone] = [];
      continue;
    }
    if (!activeZone) throw new Error("Aerodynamic data row appears before a named zone.");
    const values = line.split(/\s+/).map(Number);
    if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) throw new Error(`Invalid aerodynamic data row: ${line}`);
    zones[activeZone]?.push({ alphaDeg: values[0] as number, liftCoefficient: values[1] as number, dragCoefficient: values[2] as number });
  }
  if (Object.keys(zones).length < 1 || Object.values(zones).some((points) => points.length < 4))
    throw new Error("Aerodynamic dataset requires populated zones.");
  for (const points of Object.values(zones)) assertStrictlyIncreasing(points);
  const canonicalZones = Object.fromEntries(
    Object.entries(zones)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, points]) => [name, Object.freeze(points.map((point) => Object.freeze({ ...point })))])
  );
  const body = { pedigree: input.pedigree, zones: canonicalZones };
  return Object.freeze({ ...body, zones: Object.freeze(canonicalZones), contentHash: input.hasher.sha256Canonical(body) });
}

export function validateAerodynamicPrediction(input: {
  dataset: AerodynamicReferenceDataset;
  selectedZone: string;
  predictionRows: readonly XfoilPolarRow[];
  predictionConditions: AerodynamicPredictionConditions;
  configurationBaselineId: string;
  modelCard: AerospaceModelCard;
  acceptance: { maximumLiftRmse: number; maximumDragRmse: number };
  run: {
    id: string;
    analysisCaseId: string;
    toolId: string;
    toolVersion: string;
    environmentHash: string;
    inputArtifactHashes: readonly string[];
    configurationHash: string;
    geometryHash: string;
    startTime: string;
    durationMs: number;
    convergenceEvidence: readonly ConvergenceEvidence[];
    warningMessages: readonly { code: string; message: string }[];
    errorMessages: readonly { code: string; message: string }[];
    outputArtifactId: string;
  };
  hasher: CanonicalHasher;
}): AerodynamicValidationResult {
  const reference = input.dataset.zones[input.selectedZone];
  if (!reference) throw new Error(`Aerodynamic reference zone is unavailable: ${input.selectedZone}.`);
  if (!input.predictionRows.length) throw new Error("Aerodynamic validation requires solver prediction rows.");
  if (input.run.errorMessages.length) throw new Error("Aerodynamic validation cannot promote a solver run with errors.");
  const conditionViolations = predictionConditionViolations(input.predictionConditions, input.dataset.pedigree);
  const modelUseAssessment = assessModelUse({
    card: input.modelCard,
    proposedUse: "NACA 0012 pre-stall force-coefficient validation",
    configurationBaselineId: input.configurationBaselineId,
    variables: {
      reynoldsNumber: createQuantity({
        value: input.predictionConditions.reynoldsNumber,
        unit: "1",
        provenance: { sourceType: "solver", sourceId: input.run.id, receiptId: input.run.outputArtifactId }
      }),
      mach: createQuantity({
        value: input.predictionConditions.mach,
        unit: "Mach",
        provenance: { sourceType: "solver", sourceId: input.run.id, receiptId: input.run.outputArtifactId }
      }),
      alpha: createQuantity({
        value: maximumAlpha(input.predictionRows),
        unit: "deg",
        provenance: { sourceType: "solver", sourceId: input.run.id, receiptId: input.run.outputArtifactId }
      })
    }
  });
  const matchedPoints = matchPredictionToReference(input.predictionRows, reference);
  if (matchedPoints.length < 4) throw new Error("Aerodynamic validation requires at least four in-domain comparison points.");
  const metrics = errorMetrics(matchedPoints);
  const acceptancePassed = metrics.liftRmse <= input.acceptance.maximumLiftRmse && metrics.dragRmse <= input.acceptance.maximumDragRmse;
  const modelAccepted = modelUseAssessment.status === "accepted_use" || modelUseAssessment.status === "accepted_with_limits";
  const status: AerodynamicValidationResult["status"] =
    !modelAccepted || conditionViolations.length ? "outside_domain" : acceptancePassed ? "validated_with_limits" : "acceptance_failed";
  const postconditions = [
    { id: "reference-alignment", passed: matchedPoints.length >= 4, detail: `${matchedPoints.length} in-domain points compared.` },
    { id: "finite-error-metrics", passed: Object.values(metrics).every(Number.isFinite), detail: JSON.stringify(metrics) },
    { id: "reference-condition-match", passed: conditionViolations.length === 0, detail: conditionViolations.join("; ") || "matched" },
    { id: "acceptance-thresholds", passed: acceptancePassed, detail: JSON.stringify(input.acceptance) }
  ];
  const simulationReceipt: SimulationRunReceipt = Object.freeze({
    runId: input.run.id,
    analysisCaseId: input.run.analysisCaseId,
    toolId: input.run.toolId,
    toolVersion: input.run.toolVersion,
    environmentHash: input.run.environmentHash,
    inputArtifactHashes: Object.freeze([...input.run.inputArtifactHashes]),
    configurationHash: input.run.configurationHash,
    geometryHash: input.run.geometryHash,
    startTime: input.run.startTime,
    durationMs: input.run.durationMs,
    exitStatus: status === "validated_with_limits" ? "completed" : "failed",
    convergenceEvidence: Object.freeze([...input.run.convergenceEvidence]),
    warningMessages: Object.freeze([...input.run.warningMessages]),
    errorMessages: Object.freeze([...input.run.errorMessages]),
    outputArtifactIds: Object.freeze(status === "validated_with_limits" ? [input.run.outputArtifactId] : []),
    postconditionResults: Object.freeze(postconditions),
    modelUseAssessment,
    reproducibilityStatus: status === "validated_with_limits" ? "reproducible_not_rerun" : "failed"
  });
  const reproducibilityManifest = validateSimulationRunReceipt(simulationReceipt);
  const alphaValues = reference.map((point) => point.alphaDeg);
  const validationDomain = Object.freeze({
    reynoldsNumber: input.dataset.pedigree.reynoldsNumber,
    mach: input.dataset.pedigree.mach,
    minimumAlphaDeg: Math.min(...alphaValues),
    maximumAlphaDeg: Math.max(...alphaValues),
    transition: input.dataset.pedigree.transition
  });
  const placards = Object.freeze([
    "Research validation only; this result is not certification evidence.",
    "Pointwise experimental uncertainty is not quantified in the immutable fixture and remains a credibility limitation.",
    "Do not extrapolate beyond the recorded Reynolds number, Mach number, transition condition, geometry, or angle range.",
    "Near-stall two-dimensional wind-tunnel data have additional facility and three-dimensionality limitations documented by NASA TMR.",
    ...conditionViolations.map((violation) => `Reference-condition mismatch: ${violation}`)
  ]);
  const body = {
    id: `aero-validation:${input.run.id}`,
    status,
    datasetId: input.dataset.pedigree.id,
    selectedZone: input.selectedZone,
    matchedPoints,
    metrics,
    acceptance: { ...input.acceptance, passed: acceptancePassed },
    experimentalUncertainty: {
      status: "not_quantified_in_fixture" as const,
      treatment: "reported_as_credibility_limit" as const,
      limitation: "No pointwise experimental uncertainty was present in the pinned force-data file; no value was inferred."
    },
    modelUseAssessment,
    simulationReceipt,
    reproducibilityManifest,
    validationDomain,
    placards
  };
  return Object.freeze({ ...body, contentHash: input.hasher.sha256Canonical(body) });
}

function predictionConditionViolations(prediction: AerodynamicPredictionConditions, reference: AerodynamicDatasetPedigree): string[] {
  const violations: string[] = [];
  if (!Number.isFinite(prediction.reynoldsNumber) || prediction.reynoldsNumber !== reference.reynoldsNumber)
    violations.push(`Reynolds number ${prediction.reynoldsNumber} does not equal ${reference.reynoldsNumber}`);
  if (!Number.isFinite(prediction.mach) || Math.abs(prediction.mach - reference.mach) > 1e-12)
    violations.push(`Mach ${prediction.mach} does not equal ${reference.mach}`);
  if (reference.transition === "tripped" && prediction.transition !== "forced") violations.push("tripped reference data require forced solver transition");
  if (JSON.stringify(prediction.coefficientConvention) !== JSON.stringify(reference.coefficientConvention))
    violations.push("lift/drag sign or reference-geometry convention differs from the dataset");
  return violations;
}

export function assessAerodynamicValidationDomain(input: {
  modelCard: AerospaceModelCard;
  configurationBaselineId: string;
  reynoldsNumber: number;
  mach: number;
  alphaDeg: number;
}): ModelUseAssessment {
  return assessModelUse({
    card: input.modelCard,
    proposedUse: "NACA 0012 pre-stall force-coefficient validation",
    configurationBaselineId: input.configurationBaselineId,
    variables: {
      reynoldsNumber: createQuantity({ value: input.reynoldsNumber, unit: "1", provenance: { sourceType: "user", sourceId: "domain-check" } }),
      mach: createQuantity({ value: input.mach, unit: "Mach", provenance: { sourceType: "user", sourceId: "domain-check" } }),
      alpha: createQuantity({ value: input.alphaDeg, unit: "deg", provenance: { sourceType: "user", sourceId: "domain-check" } })
    }
  });
}

export function generateTmrNaca0012Coordinates(pointCountPerSurface = 81): string {
  if (!Number.isSafeInteger(pointCountPerSurface) || pointCountPerSurface < 20 || pointCountPerSurface > 500)
    throw new Error("NACA 0012 coordinate generation requires 20-500 points per surface.");
  const coordinates: Array<[number, number]> = [];
  for (let index = 0; index < pointCountPerSurface; index += 1) {
    const theta = (Math.PI * index) / (pointCountPerSurface - 1);
    const x = (1 + Math.cos(theta)) / 2;
    coordinates.push([x, thickness(x)]);
  }
  for (let index = 1; index < pointCountPerSurface; index += 1) {
    const theta = (Math.PI * index) / (pointCountPerSurface - 1);
    const x = (1 - Math.cos(theta)) / 2;
    coordinates.push([x, -thickness(x)]);
  }
  return ["TMR ALTERED NACA 0012", ...coordinates.map(([x, y]) => `${x.toFixed(10)} ${y.toFixed(10)}`), ""].join("\n");
}

function validatePedigree(value: AerodynamicDatasetPedigree): void {
  if (!value.id || !value.sourceUrl || !value.caseUrl || !value.reportIdentifier || !value.organization || !value.geometryDefinition)
    throw new Error("Aerodynamic dataset pedigree is incomplete.");
  if (![value.expectedContentSha256, value.computedContentSha256].every((hash) => /^[a-f0-9]{64}$/.test(hash)))
    throw new Error("Aerodynamic dataset hashes must be lowercase SHA-256 values.");
  if (!Number.isFinite(Date.parse(value.accessDate))) throw new Error("Aerodynamic dataset access date is invalid.");
  if (value.reynoldsNumber <= 0 || value.mach < 0 || value.coefficientConvention.referenceChord <= 0)
    throw new Error("Aerodynamic dataset conditions and reference geometry must be positive.");
}

function assertStrictlyIncreasing(points: readonly AerodynamicReferencePoint[]): void {
  for (let index = 1; index < points.length; index += 1) {
    if ((points[index]?.alphaDeg as number) <= (points[index - 1]?.alphaDeg as number)) throw new Error("Aerodynamic zone angles must be strictly increasing.");
  }
}

function matchPredictionToReference(predictions: readonly XfoilPolarRow[], reference: readonly AerodynamicReferencePoint[]) {
  const minimum = reference[0]?.alphaDeg as number;
  const maximum = reference.at(-1)?.alphaDeg as number;
  return Object.freeze(
    predictions
      .filter((point) => point.alpha >= minimum && point.alpha <= maximum && [point.alpha, point.cl, point.cd].every(Number.isFinite))
      .sort((left, right) => left.alpha - right.alpha)
      .map((point) => {
        const expected = interpolate(reference, point.alpha);
        return Object.freeze({
          alphaDeg: point.alpha,
          predictedCl: point.cl,
          referenceCl: expected.liftCoefficient,
          predictedCd: point.cd,
          referenceCd: expected.dragCoefficient,
          clError: point.cl - expected.liftCoefficient,
          cdError: point.cd - expected.dragCoefficient
        });
      })
  );
}

function interpolate(points: readonly AerodynamicReferencePoint[], alphaDeg: number): AerodynamicReferencePoint {
  const upperIndex = points.findIndex((point) => point.alphaDeg >= alphaDeg);
  if (upperIndex < 0) throw new Error("Aerodynamic interpolation would extrapolate above the reference domain.");
  const upper = points[upperIndex] as AerodynamicReferencePoint;
  if (upper.alphaDeg === alphaDeg || upperIndex === 0) return upper;
  const lower = points[upperIndex - 1] as AerodynamicReferencePoint;
  const fraction = (alphaDeg - lower.alphaDeg) / (upper.alphaDeg - lower.alphaDeg);
  return {
    alphaDeg,
    liftCoefficient: lower.liftCoefficient + fraction * (upper.liftCoefficient - lower.liftCoefficient),
    dragCoefficient: lower.dragCoefficient + fraction * (upper.dragCoefficient - lower.dragCoefficient)
  };
}

function errorMetrics(points: AerodynamicValidationResult["matchedPoints"]): AerodynamicValidationResult["metrics"] {
  const liftSquared = points.map((point) => point.clError ** 2);
  const dragSquared = points.map((point) => point.cdError ** 2);
  return Object.freeze({
    liftRmse: Math.sqrt(liftSquared.reduce((sum, value) => sum + value, 0) / points.length),
    dragRmse: Math.sqrt(dragSquared.reduce((sum, value) => sum + value, 0) / points.length),
    liftMaxAbsError: Math.max(...points.map((point) => Math.abs(point.clError))),
    dragMaxAbsError: Math.max(...points.map((point) => Math.abs(point.cdError)))
  });
}

function maximumAlpha(rows: readonly XfoilPolarRow[]): number {
  return Math.max(...rows.map((row) => row.alpha));
}

function thickness(x: number): number {
  const value = 0.594689181 * (0.298222773 * Math.sqrt(x) - 0.127125232 * x - 0.357907906 * x ** 2 + 0.291984971 * x ** 3 - 0.105174606 * x ** 4);
  return Math.abs(value) < 1e-14 ? 0 : value;
}

export const AERODYNAMIC_VALIDATION_DIMENSIONS = Object.freeze({ alpha: ANGLE, coefficient: DIMENSIONLESS });
