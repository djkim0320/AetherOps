import type { ConfigurationBaseline } from "../../core/aerospace/configurationBaseline.js";
import type { EvidenceItem, ResearchArtifact } from "../../core/shared/types.js";
import type { XfoilPolarRow } from "../../core/tools/engineeringProgramTypes.js";
import type { ResearchToolResult } from "../../core/tools/researchToolTypes.js";
import { WEBXFOIL_GEOMETRY_RECEIPT_VERSION } from "../runtime/engineering/engineeringProgramCoordinateResolver.js";
import { createWebXfoilPolarResultReceipt, WEBXFOIL_POLAR_RESULT_RECEIPT_VERSION } from "../runtime/engineering/webXfoilPolarResultReceipt.js";

export interface EngineeringPolarFacts {
  coefficientTypes: string[];
  converged: boolean;
  withinDeclaredDomain: boolean;
}

export function requiredWebXfoilPromotionReceipt(
  result: ResearchToolResult,
  output: ResearchArtifact | EvidenceItem,
  baseline: ConfigurationBaseline
): { geometryContentHash: string; facts: EngineeringPolarFacts } {
  const metadata = output.metadata;
  const geometryContentHash = hash(metadata?.geometryContentHash);
  const geometryPointCount = positiveInteger(metadata?.geometryPointCount);
  const polarResultHash = hash(metadata?.polarResultHash);
  if (
    !geometryContentHash ||
    !geometryPointCount ||
    metadata?.geometryReceiptVersion !== WEBXFOIL_GEOMETRY_RECEIPT_VERSION ||
    !polarResultHash ||
    metadata?.polarResultReceiptVersion !== WEBXFOIL_POLAR_RESULT_RECEIPT_VERSION
  ) {
    throw new Error(`Engineering output ${output.id} has no verified WebXFOIL geometry and polar result receipt.`);
  }
  matchingSummary(result, {
    geometryContentHash,
    geometryPointCount,
    polarResultHash
  });
  const artifactSummary = verifiedPairedArtifactSummary(result, {
    geometryContentHash,
    geometryPointCount,
    polarResultHash
  });
  if (baseline.airfoilGeometryHash?.toLowerCase() !== geometryContentHash) {
    throw new Error(`Engineering output ${output.id} geometry does not match the active baseline airfoil geometry.`);
  }
  return { geometryContentHash, facts: polarFacts(artifactSummary) };
}

export function polarFactsFromArtifact(artifact: ResearchArtifact): EngineeringPolarFacts {
  return polarFacts(parseArtifactContent(artifact));
}

function matchingSummary(
  result: ResearchToolResult,
  expected: { geometryContentHash: string; geometryPointCount: number; polarResultHash: string }
): Record<string, unknown> {
  const toolOutput = record(result.toolRun.output) ? result.toolRun.output : undefined;
  const outputs = Array.isArray(toolOutput?.outputs) ? toolOutput.outputs.filter(record) : [];
  const matches = outputs
    .filter((item) => item.kind === "xfoil-wasm-polar" && item.target === "xfoil-wasm" && record(item.summary))
    .map((item) => item.summary as Record<string, unknown>)
    .filter(
      (summary) =>
        hash(summary.geometryContentHash) === expected.geometryContentHash &&
        summary.geometryPointCount === expected.geometryPointCount &&
        summary.geometryReceiptVersion === WEBXFOIL_GEOMETRY_RECEIPT_VERSION &&
        hash(summary.polarResultHash) === expected.polarResultHash &&
        summary.polarResultReceiptVersion === WEBXFOIL_POLAR_RESULT_RECEIPT_VERSION
    );
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? "WebXFOIL polar result receipt is ambiguous within its tool attempt."
        : "WebXFOIL tool output does not contain the output polar result receipt."
    );
  }
  return matches[0] as Record<string, unknown>;
}

function verifiedPairedArtifactSummary(
  result: ResearchToolResult,
  expected: { geometryContentHash: string; geometryPointCount: number; polarResultHash: string }
): Record<string, unknown> {
  const artifacts = result.artifacts.filter((artifact) =>
    outputReceiptMatches(artifact, expected.geometryContentHash, expected.geometryPointCount, expected.polarResultHash)
  );
  if (artifacts.length !== 1) {
    throw new Error(
      artifacts.length ? "WebXFOIL polar result receipt has multiple paired full artifacts." : "WebXFOIL polar result receipt has no paired full artifact."
    );
  }
  const artifact = artifacts[0] as ResearchArtifact;
  const summary = parseArtifactContent(artifact);
  if (!summary || !summaryReceiptMatches(summary, expected.geometryContentHash, expected.geometryPointCount, expected.polarResultHash)) {
    throw new Error(`Engineering artifact ${artifact.id} content does not match its WebXFOIL polar result receipt.`);
  }
  const recalculated = createWebXfoilPolarResultReceipt(receiptInput(summary, expected));
  if (recalculated.contentHash !== expected.polarResultHash || recalculated.version !== WEBXFOIL_POLAR_RESULT_RECEIPT_VERSION) {
    throw new Error(`Engineering artifact ${artifact.id} WebXFOIL polar result hash does not match its full result content.`);
  }
  return summary;
}

function outputReceiptMatches(artifact: ResearchArtifact, geometryContentHash: string, geometryPointCount: number, polarResultHash: string): boolean {
  return summaryReceiptMatches(artifact.metadata, geometryContentHash, geometryPointCount, polarResultHash);
}

function summaryReceiptMatches(
  value: Record<string, unknown> | undefined,
  geometryContentHash: string,
  geometryPointCount: number,
  polarResultHash: string
): boolean {
  return Boolean(
    value &&
    hash(value.geometryContentHash) === geometryContentHash &&
    value.geometryPointCount === geometryPointCount &&
    value.geometryReceiptVersion === WEBXFOIL_GEOMETRY_RECEIPT_VERSION &&
    hash(value.polarResultHash) === polarResultHash &&
    value.polarResultReceiptVersion === WEBXFOIL_POLAR_RESULT_RECEIPT_VERSION
  );
}

function receiptInput(
  summary: Record<string, unknown>,
  expected: { geometryContentHash: string; geometryPointCount: number }
): Parameters<typeof createWebXfoilPolarResultReceipt>[0] {
  const transition = summary.transition;
  if (transition !== "free" && transition !== "forced") throw new Error("WebXFOIL polar result transition receipt is invalid.");
  const transitionLocations = transition === "forced" ? requiredTransitionLocations(summary.transitionLocations) : undefined;
  return {
    runtimeVersion: requiredText(summary.runtimeVersion, "runtime version"),
    geometry: {
      contentHash: expected.geometryContentHash,
      pointCount: expected.geometryPointCount,
      version: WEBXFOIL_GEOMETRY_RECEIPT_VERSION
    },
    request: {
      reynolds: finite(summary.reynolds, "Reynolds number"),
      mach: finite(summary.mach, "Mach number"),
      alphaStart: finite(summary.alphaStart, "alpha start"),
      alphaEnd: finite(summary.alphaEnd, "alpha end"),
      alphaStep: finite(summary.alphaStep, "alpha step"),
      transition,
      ...(transitionLocations ? { transitionLocations } : {})
    },
    rows: requiredRows(summary.rows),
    convergence: requiredConvergence(summary.convergence)
  };
}

function parseArtifactContent(artifact: ResearchArtifact): Record<string, unknown> | undefined {
  if (typeof artifact.content !== "string" || artifact.content.length > 8 * 1024 * 1024) return undefined;
  try {
    const value: unknown = JSON.parse(artifact.content);
    return record(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function polarFacts(value: Record<string, unknown> | undefined): EngineeringPolarFacts {
  if (!value) return { coefficientTypes: [], converged: false, withinDeclaredDomain: false };
  const rows = Array.isArray(value.rows) ? value.rows.filter(record) : [];
  const coefficientTypes = ["CL", "CD", ...(rows.some((row) => Number.isFinite(row.cm)) ? ["CM"] : [])];
  const convergence = record(value.convergence) ? value.convergence : undefined;
  const converged =
    rows.length > 0 &&
    rows.every((row) => Number.isFinite(row.alpha) && Number.isFinite(row.cl) && Number.isFinite(row.cd)) &&
    convergence?.hasNaN !== true &&
    convergence?.hasFortranError !== true &&
    convergence?.hasConvergenceFail !== true;
  const reynolds = Number(value.reynolds);
  const mach = Number(value.mach);
  return {
    coefficientTypes,
    converged,
    withinDeclaredDomain: converged && Number.isFinite(reynolds) && reynolds > 0 && Number.isFinite(mach) && mach >= 0 && mach <= 0.7
  };
}

function hash(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 10 ? Number(value) : undefined;
}

function requiredRows(value: unknown): XfoilPolarRow[] {
  if (!Array.isArray(value) || !value.length) throw new Error("WebXFOIL polar result rows are missing.");
  return value.map((item, index) => {
    if (!record(item)) throw new Error(`WebXFOIL polar result row ${index + 1} is invalid.`);
    return {
      alpha: finite(item.alpha, `row ${index + 1} alpha`),
      cl: finite(item.cl, `row ${index + 1} CL`),
      cd: finite(item.cd, `row ${index + 1} CD`),
      ...(item.cdp === undefined ? {} : { cdp: finite(item.cdp, `row ${index + 1} CDp`) }),
      ...(item.cm === undefined ? {} : { cm: finite(item.cm, `row ${index + 1} CM`) }),
      ...(item.topXtr === undefined ? {} : { topXtr: finite(item.topXtr, `row ${index + 1} top transition`) }),
      ...(item.botXtr === undefined ? {} : { botXtr: finite(item.botXtr, `row ${index + 1} bottom transition`) })
    };
  });
}

function requiredConvergence(value: unknown): { hasNaN: boolean; hasFortranError: boolean; hasConvergenceFail: boolean } {
  if (!record(value) || [value.hasNaN, value.hasFortranError, value.hasConvergenceFail].some((item) => typeof item !== "boolean")) {
    throw new Error("WebXFOIL polar result convergence receipt is invalid.");
  }
  return {
    hasNaN: value.hasNaN as boolean,
    hasFortranError: value.hasFortranError as boolean,
    hasConvergenceFail: value.hasConvergenceFail as boolean
  };
}

function requiredTransitionLocations(value: unknown): { upperXOverC: number; lowerXOverC: number; sourceEvidenceId: string } {
  if (!record(value)) throw new Error("WebXFOIL forced-transition receipt is missing.");
  return {
    upperXOverC: finite(value.upperXOverC, "upper transition location"),
    lowerXOverC: finite(value.lowerXOverC, "lower transition location"),
    sourceEvidenceId: requiredText(value.sourceEvidenceId, "transition source evidence")
  };
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`WebXFOIL ${label} receipt is invalid.`);
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`WebXFOIL ${label} receipt is invalid.`);
  return value.trim();
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
