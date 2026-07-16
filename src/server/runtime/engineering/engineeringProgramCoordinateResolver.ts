import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import type { AppSettings, EngineeringProgramRequest, ResearchToolInput } from "../../../core/shared/types.js";
import { normalizeNacaSeries } from "../../../core/tools/airfoilIdentity.js";
import type { AirfoilCoordinateInput, AirfoilCoordinateResolutionPorts } from "../../../core/tools/engineeringProgramTypes.js";
import { createDefaultPublicUrlPolicy } from "./publicUrlPolicy.js";
import { resolveConfiguredModelingRoot, resolveInsideRoot } from "./engineeringProgramMeshAdapter.js";

export const WEBXFOIL_GEOMETRY_RECEIPT_VERSION = "webxfoil-paneled-airfoil-v1" as const;

interface AirfoilCoordinatePoint {
  x: number;
  y: number;
}

export interface WebXfoilGeometryReceipt {
  contentHash: string;
  pointCount: number;
  version: typeof WEBXFOIL_GEOMETRY_RECEIPT_VERSION;
}

export async function resolveWasmAirfoilInput(
  request: EngineeringProgramRequest,
  settings: AppSettings,
  input: ResearchToolInput,
  ports: Partial<AirfoilCoordinateResolutionPorts> = {}
): Promise<AirfoilCoordinateInput> {
  const bindingId = request.coordinateBindingId ?? request.cfdRunSpec?.geometry.coordinateBindingId;
  if (bindingId) {
    const binding = input.coordinateBindings?.find((candidate) => candidate.id === bindingId);
    if (!binding) throw new Error(`XFOIL WebAssembly coordinate binding does not exist: ${bindingId}`);
    const sha256 = createHash("sha256").update(binding.rawText, "utf8").digest("hex");
    if (sha256 !== binding.sha256) throw new Error(`XFOIL WebAssembly coordinate binding hash mismatch: ${bindingId}`);
    const metrics = validateAirfoilCoordinateText(binding.rawText);
    if (metrics.pointCount !== binding.pointCount) throw new Error(`XFOIL WebAssembly coordinate binding validation changed: ${bindingId}`);
    return { text: binding.rawText, label: binding.label, sourceKind: "source", sourceUrl: binding.sourceUrl };
  }
  if (request.artifactPath?.trim()) {
    const artifactRoot = resolveConfiguredModelingRoot(settings);
    const targetPath = resolveInsideRoot(artifactRoot, request.artifactPath.trim());
    if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
      throw new Error(`XFOIL WebAssembly airfoil coordinate file does not exist under configured root: ${request.artifactPath}`);
    }
    const stats = statSync(targetPath);
    if (stats.size > settings.engineeringTools.modeling.maxMeshBytes) {
      throw new Error(`XFOIL WebAssembly airfoil coordinate file exceeds maxMeshBytes (${stats.size} > ${settings.engineeringTools.modeling.maxMeshBytes}).`);
    }
    const text = readFileSync(targetPath, "utf8");
    validateAirfoilCoordinateText(text);
    return {
      text,
      label: basename(targetPath, extname(targetPath)),
      sourceKind: "artifact",
      sourceArtifactPath: request.artifactPath.trim()
    };
  }

  const sourceUrl = request.sourceUrl?.trim();
  if (sourceUrl) {
    await (ports.publicUrlPolicy ?? createDefaultPublicUrlPolicy()).assertPublicUrl(sourceUrl);
    throw new Error(`XFOIL WebAssembly sourceUrl requires a verified WebFetchTool coordinate binding: ${sourceUrl}`);
  }

  const discoveredSource = findFetchedAirfoilSource(input);
  if (discoveredSource) return discoveredSource;

  const naca = request.naca?.trim();
  if (naca) {
    const series = normalizeNacaSeries(naca);
    return {
      label: `NACA ${series}`,
      sourceKind: "naca"
    };
  }

  throw new Error("XFOIL WebAssembly polar execution requires naca, artifactPath, sourceUrl, or a fetched airfoil coordinate source.");
}

export function validateAirfoilCoordinateText(text: string): { pointCount: number; xMin: number; xMax: number; yMin: number; yMax: number } {
  const points = parseAirfoilCoordinatePoints(text);
  return validateAirfoilCoordinatePoints(points);
}

/** Hashes the canonical coordinates emitted by the same post-PANE WebXFOIL run that produced the polar. */
export function createWebXfoilGeometryReceipt(text: string): WebXfoilGeometryReceipt {
  const points = parseAirfoilCoordinatePoints(text);
  validateAirfoilCoordinatePoints(points);
  const canonical = `${WEBXFOIL_GEOMETRY_RECEIPT_VERSION}\n${points
    .map((point) => `${canonicalCoordinate(point.x)},${canonicalCoordinate(point.y)}`)
    .join("\n")}\n`;
  return {
    contentHash: createHash("sha256").update(canonical, "utf8").digest("hex"),
    pointCount: points.length,
    version: WEBXFOIL_GEOMETRY_RECEIPT_VERSION
  };
}

function parseAirfoilCoordinatePoints(text: string): AirfoilCoordinatePoint[] {
  const points: AirfoilCoordinatePoint[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/[\s,]+/);
    if (parts.length < 2) continue;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Math.abs(x) > 2 || Math.abs(y) > 2) continue;
    points.push({ x, y });
  }
  return points;
}

function validateAirfoilCoordinatePoints(points: readonly AirfoilCoordinatePoint[]): {
  pointCount: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
} {
  if (points.length < 10) {
    throw new Error(`Airfoil coordinate file must contain at least 10 finite coordinate pairs; found ${points.length}.`);
  }
  const xValues = points.map((point) => point.x);
  const yValues = points.map((point) => point.y);
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  if (xMax - xMin < 0.01) {
    throw new Error("Airfoil coordinate file does not span a usable chord length.");
  }
  if (yMax - yMin <= 0) {
    throw new Error("Airfoil coordinate file does not contain a usable thickness/camber range.");
  }
  return { pointCount: points.length, xMin, xMax, yMin, yMax };
}

function canonicalCoordinate(value: number): string {
  return (Object.is(value, -0) ? 0 : value).toExponential(16);
}

function findFetchedAirfoilSource(input: ResearchToolInput, sourceUrl?: string): AirfoilCoordinateInput | undefined {
  const requestedUrl = sourceUrl ? normalizeUrlForCompare(sourceUrl) : undefined;
  let invalidRequestedSource: string | undefined;
  const sources = input.sources ?? [];
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    const source = sources[index];
    if (!source) continue;
    const url = typeof source.url === "string" ? source.url : "";
    if (requestedUrl && normalizeUrlForCompare(url) !== requestedUrl) continue;
    const rawText = source.metadata && typeof source.metadata.rawText === "string" ? source.metadata.rawText : "";
    if (!rawText) continue;
    try {
      validateAirfoilCoordinateText(rawText);
      return {
        text: rawText,
        label: source.title || airfoilLabelFromUrl(url),
        sourceKind: "source",
        sourceUrl: url
      };
    } catch (error) {
      if (requestedUrl) invalidRequestedSource = error instanceof Error ? error.message : String(error);
    }
  }
  if (requestedUrl && invalidRequestedSource) {
    throw new Error(`Fetched source does not contain a valid airfoil coordinate file: ${sourceUrl} (${invalidRequestedSource})`);
  }
  return undefined;
}

function normalizeUrlForCompare(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

function airfoilLabelFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const file = basename(parsed.pathname) || parsed.hostname;
    return file.replace(/\.[A-Za-z0-9]+$/, "") || "airfoil";
  } catch {
    return "airfoil";
  }
}
