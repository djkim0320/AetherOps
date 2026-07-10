import { boundedObject, cleanString, parseJsonObject } from "./realOpenCodeCommon.js";

export interface FilesystemOptimizationValidation {
  summary: string;
  resultPath: string;
  codePath: string;
  selected: Record<string, unknown>;
  provenance: Record<string, unknown>;
}

export function validateFilesystemOptimizationArtifacts(
  artifacts: Array<{ title: string; relativePath: string; content?: string }>
): FilesystemOptimizationValidation | undefined {
  const codeArtifact = artifacts.find(
    (artifact) => /optimization/i.test(`${artifact.title}\n${artifact.relativePath}`) && /\.(py|ts|js|mjs|cjs)$/i.test(artifact.relativePath)
  );
  const resultArtifact = artifacts.find(
    (artifact) =>
      /optimization/i.test(`${artifact.title}\n${artifact.relativePath}`) &&
      /\.json$/i.test(artifact.relativePath) &&
      validateOptimizationResultJson(artifact.content)
  );
  if (!codeArtifact || !resultArtifact) return undefined;
  const parsed = parseJsonObject(resultArtifact.content);
  if (!parsed) return undefined;
  const selected = optimizationSelectedRecord(parsed);
  if (!selected) return undefined;
  const provenance = parsed.inputDataProvenance;
  if (!isRecord(provenance)) return undefined;
  return {
    summary: `OpenCode optimization files are valid: ${codeArtifact.relativePath} and ${resultArtifact.relativePath}.`,
    resultPath: resultArtifact.relativePath,
    codePath: codeArtifact.relativePath,
    selected,
    provenance
  };
}

export function validateOptimizationResultJson(content: string | undefined): boolean {
  const parsed = parseJsonObject(content);
  if (!parsed) return false;
  if (!cleanString(parsed.objective)) return false;
  if (!isCollection(parsed.variables)) return false;
  if (!isCollection(parsed.constraints)) return false;
  if (!isRecord(parsed.inputDataProvenance)) return false;
  if (!hasValidationNotes(parsed.validationNotes)) return false;
  const candidates = optimizationCandidateRows(parsed);
  if (!candidates.length) return false;
  const selected = optimizationSelectedRecord(parsed);
  if (!selected) return false;
  if (!hasFiniteNumber(selectedAlphaValue(selected)) || !hasFiniteNumber(optimizationScoreValue(parsed, selected))) return false;
  const provenanceRecord = parsed.inputDataProvenance as Record<string, unknown>;
  const provenanceTool = provenanceToolName(provenanceRecord);
  const provenanceArtifact = provenanceArtifactPath(provenanceRecord);
  return Boolean(provenanceTool || provenanceArtifact);
}

export function formatOptimizationObservation(validation: FilesystemOptimizationValidation): string {
  const selected = formatSelectedOptimum(validation.selected);
  const provenanceArtifact = provenanceArtifactPath(validation.provenance);
  const provenanceRuntime = cleanString(validation.provenance.runtime);
  const provenanceSource = cleanString(validation.provenance.sourceUrl);
  return [
    `Validated OpenCode optimization output from ${validation.resultPath}.`,
    `Selected optimum: ${selected}.`,
    provenanceArtifact ? `Input artifact: ${provenanceArtifact}.` : "",
    provenanceRuntime ? `Runtime: ${provenanceRuntime}.` : "",
    provenanceSource ? `Source URL: ${provenanceSource}.` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

export function formatSelectedOptimum(selected: Record<string, unknown>): string {
  const parts = [
    numericPart("alpha", selectedAlphaValue(selected)),
    numericPart("CL", selectedCoefficientValue(selected, "cl")),
    numericPart("CD", selectedCoefficientValue(selected, "cd")),
    numericPart("L/D", optimizationScoreValue(undefined, selected))
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : JSON.stringify(boundedObject(selected, 8, 300));
}

function optimizationCandidateRows(parsed: Record<string, unknown>): unknown[] {
  const rows = parsed.candidates ?? parsed.comparedCandidates ?? parsed.evaluatedCandidates ?? parsed.rows;
  return Array.isArray(rows) ? rows : [];
}

function optimizationSelectedRecord(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  const selected = parsed.selectedOptimum ?? parsed.optimum ?? parsed.bestCandidate ?? parsed.selected;
  return isRecord(selected) ? selected : undefined;
}

function optimizationScoreValue(parsed: Record<string, unknown> | undefined, selected: Record<string, unknown>): unknown {
  return selected.liftToDrag ?? selected.ld ?? selected.lOverD ?? selected.l_d ?? selected.score ?? selected.objectiveValue ?? parsed?.score;
}

function selectedAlphaValue(selected: Record<string, unknown>): unknown {
  if (selected.alpha !== undefined) return selected.alpha;
  const variables = selected.variables;
  return isRecord(variables) ? variables.alpha : undefined;
}

function selectedCoefficientValue(selected: Record<string, unknown>, key: "cl" | "cd"): unknown {
  if (selected[key] !== undefined) return selected[key];
  const coefficients = selected.coefficients;
  return isRecord(coefficients) ? coefficients[key] : undefined;
}

function provenanceToolName(provenance: Record<string, unknown>): string {
  return cleanString(provenance.tool) || cleanString(provenance.toolContext) || cleanString(provenance.sourceTool) || cleanString(provenance.generatedBy);
}

function provenanceArtifactPath(provenance: Record<string, unknown>): string {
  return (
    cleanString(provenance.artifact) ||
    cleanString(provenance.artifactPath) ||
    cleanString(provenance.sourceArtifact) ||
    cleanString(provenance.sourceArtifactPath) ||
    cleanString(provenance.sourceArtifactRelativePath) ||
    cleanString(provenance.engineeringArtifact) ||
    cleanString(provenance.inputArtifact) ||
    cleanString(provenance.artifactRelativePath)
  );
}

function numericPart(label: string, value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? `${label}=${value}` : undefined;
}

function hasFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function hasValidationNotes(value: unknown): boolean {
  if (typeof value === "string") return Boolean(cleanString(value));
  if (Array.isArray(value)) {
    return value.some((item) => typeof item === "string" && Boolean(cleanString(item)));
  }
  return false;
}

function isCollection(value: unknown): boolean {
  return Boolean(value) && typeof value === "object";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
